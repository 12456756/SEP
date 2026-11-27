import { ModelBillingService, calculateBilledCost } from './model-billing.service';

describe('ModelBillingService compute-owned pricing', () => {
  const prisma = { platformModel: { findUnique: jest.fn() } };
  const settings = { getEffectiveValue: jest.fn() };
  const service = new ModelBillingService(prisma as never, settings as never);

  it('does not advertise local free flags or multipliers', async () => {
    expect(await service.describe([{ isFree: true }, { isFree: false }])).toEqual([
      { isFree: false, billingMultiplier: null, discountLabel: '费用由算力平台确认' },
      { isFree: false, billingMultiplier: null, discountLabel: '费用由算力平台确认' },
    ]);
    expect(prisma.platformModel.findUnique).not.toHaveBeenCalled();
    expect(settings.getEffectiveValue).not.toHaveBeenCalled();
  });

  it.each(['getSnapshot', 'getLegacySnapshot'] as const)('rejects %s instead of repricing', async method => {
    await expect(service[method]('model')).rejects.toMatchObject({
      status: 503, response: { code: 'COMPUTE_FINAL_FEE_REQUIRED' },
    });
  });

  it('cannot recompute a historical USD snapshot even when marked free', () => {
    expect(() => calculateBilledCost({ isFree: true, usdToCnyRate: 7 } as never, 100, 100))
      .toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'COMPUTE_FINAL_FEE_REQUIRED' }) }));
  });
});
