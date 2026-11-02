import { ServiceUnavailableException } from '@nestjs/common';
import { SETTING_KEYS } from 'shared';
import { ModelBillingService, calculateBilledCost } from './model-billing.service';

describe('ModelBillingService', () => {
  let prisma: any;
  let settings: any;
  let service: ModelBillingService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      platformModel: {
        findUnique: jest.fn().mockResolvedValue({ isFree: false }),
      },
    };
    settings = {
      getEffectiveValue: jest.fn((key: string) => {
        if (key === SETTING_KEYS.SUB2API_BASE_URL) return Promise.resolve('https://relay.test/');
        if (key === SETTING_KEYS.SUB2API_API_KEY) return Promise.resolve('relay-key');
        if (key === SETTING_KEYS.USD_TO_CNY_RATE) return Promise.resolve('7');
        if (key === SETTING_KEYS.FALLBACK_PRICE_INPUT) return Promise.resolve(undefined);
        if (key === SETTING_KEYS.FALLBACK_PRICE_OUTPUT) return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      }),
    };
    service = new ModelBillingService(prisma, settings);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns activity-free metadata without requesting upstream billing', async () => {
    const result = await service.describe([{ isFree: true }]);

    expect(result).toEqual([
      { isFree: true, billingMultiplier: '0', discountLabel: '活动免费' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the actual sub2api multiplier for normal models', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'sub2api.key_billing',
      schema_version: 1,
      billing_scope: 'token',
      effective_rate_multiplier: 2.19,
    })));

    await expect(service.describe([{ isFree: false }])).resolves.toEqual([
      { isFree: false, billingMultiplier: '2.19', discountLabel: '按中转倍率计费' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.test/sub2api/billing',
      expect.objectContaining({ headers: { Authorization: 'Bearer relay-key' } }),
    );
  });

  it('does not default an unavailable multiplier to one', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(service.describe([{ isFree: false }])).resolves.toEqual([
      { isFree: false, billingMultiplier: null, discountLabel: '中转倍率暂不可用' },
    ]);
  });

  it.each([
    {},
    { object: 'wrong', schema_version: 1, billing_scope: 'token', effective_rate_multiplier: 1 },
    { object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token', effective_rate_multiplier: -1 },
  ])('rejects malformed upstream billing response %#', async (payload) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(service.getSnapshot('model-a')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('free snapshots freeze zero multiplier and zero prices', async () => {
    prisma.platformModel.findUnique.mockResolvedValue({ isFree: true });

    const snapshot = await service.getSnapshot('gemini-3.5-flash-high');

    expect(snapshot).toMatchObject({
      modelId: 'gemini-3.5-flash-high',
      isFree: true,
      billingMultiplier: 0,
      inputPriceUsdPerMillion: 0,
      outputPriceUsdPerMillion: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('multiplies normal model prices by the actual relay multiplier', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'sub2api.key_billing',
      schema_version: 1,
      billing_scope: 'token',
      effective_rate_multiplier: 2,
    })));

    const snapshot = await service.getSnapshot('gemini-3.5-flash-high');

    expect(snapshot).toMatchObject({
      billingMultiplier: 2,
      rate: 7,
      inputPriceUsdPerMillion: 0.3,
      outputPriceUsdPerMillion: 1.2,
    });
    const cost = calculateBilledCost(snapshot, 1_000_000, 500_000);
    expect(cost.costUSD).toBeCloseTo(0.9);
    expect(cost.costCNY).toBeCloseTo(6.3);
  });
});
