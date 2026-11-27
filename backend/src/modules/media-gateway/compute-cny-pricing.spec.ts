import { createHash } from 'node:crypto';
import { Sub2apiImageAdapter } from './sub2api-image.adapter';
import { Sub2apiVideoAdapter } from './sub2api-video.adapter';

describe('compute CNY pricing contract', () => {
  const imageInput: any = { protocolVersion: 3, specRevision: 1, profileId: 'image', configVersion: '1',
    operation: 'generate', referenceIds: [], creativeBrief: 'test', requestedSpec: { size: '1024x1024', count: 1, quality: 'high' } };
  const videoInput: any = { protocolVersion: 3, specRevision: 1, profileId: 'video', configVersion: '1',
    operation: 'text-to-video', referenceIds: [], creativeBrief: 'test', requestedSpec: { durationSeconds: 4, resolution: '720p' } };
  const connection = { base: 'https://compute.test/v1', key: 'test-key', fingerprint: createHash('sha256').update('https://compute.test/v1\0test-key').digest('hex') };
  const price = (kind: string, extra = {}) => ({ object: `sub2api.${kind}_pricing`, schema_version: 1,
    currency: 'CNY', contract_version: 1, quote_scope: 'platform_validation', amount_cny: '0.000000',
    model: 'test-model', pricing_status: 'quoted', pricing_source: 'customer_contract',
    pricing_authority: 'sub2api_customer_billing', effective_rate_multiplier: 1, pricing_version: '',
    observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
    ...(kind === 'image' ? { operation: 'generate', size: '1024x1024', n: 1, quality: 'high', billing_mode: 'image' }
      : { operation: 'text-to-video', resolution: '720p', duration_seconds: 4, billing_mode: 'video' }), ...extra });

  afterEach(() => jest.restoreAllMocks());

  it.each(['image', 'video'])('uses signed %s validation, accepts zero CNY without USD, and never generates', async kind => {
    const protocol = { json: jest.fn().mockResolvedValue(price(kind)) };
    const settings = { getMediaConnection: jest.fn() };
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected model request'));
    const result = kind === 'image'
      ? await new Sub2apiImageAdapter(settings as never, protocol as never).pricing(imageInput, 'test-model', connection, true)
      : await new Sub2apiVideoAdapter(settings as never, protocol as never).pricing(connection, videoInput, 'test-model', true);
    expect(result).toMatchObject({ currency: 'CNY', amount_cny: '0.000000' });
    expect(protocol.json).toHaveBeenCalledWith(`/api/v1/sep/validation/${kind}/pricing`, {
      method: 'POST', body: kind === 'image'
        ? { model: 'test-model', operation: 'generate', size: '1024x1024', n: 1, quality: 'high' }
        : { model: 'test-model', operation: 'text-to-video', resolution: '720p', duration_seconds: 4 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(settings.getMediaConnection).not.toHaveBeenCalled();
  });

  it.each(['image', 'video'])('requires %s validation signing configuration', async kind => {
    const action = kind === 'image'
      ? new Sub2apiImageAdapter({} as never).pricing(imageInput, 'test-model', connection, true)
      : new Sub2apiVideoAdapter({} as never).pricing(connection, videoInput, 'test-model', true);
    await expect(action).rejects.toMatchObject({ status: 503, response: { error: { code: 'PRICE_UNAVAILABLE' } } });
  });

  it.each(['image', 'video'])('rejects USD or invalid validation evidence for %s', async kind => {
    for (const invalid of [{ currency: 'USD', amount_usd: '1' }, { amount_cny: null },
      { quote_scope: undefined }, { model: 'other' }, { amount_cny: '-1.000000' }]) {
      const protocol = { json: jest.fn().mockResolvedValue(price(kind, invalid)) };
      const action = kind === 'image'
        ? new Sub2apiImageAdapter({} as never, protocol as never).pricing(imageInput, 'test-model', connection, true)
        : new Sub2apiVideoAdapter({} as never, protocol as never).pricing(connection, videoInput, 'test-model', true);
      await expect(action).rejects.toMatchObject({ status: 503, response: { error: { code: 'PRICE_UNAVAILABLE' } } });
    }
  });

  it.each(['image', 'video'])('binds %s execution quotes to enterprise and quote ID without USD', async kind => {
    const enterpriseConnection: any = { ...connection, compute: { enterpriseId: 'enterprise-1' } };
    for (const invalid of [null, { enterprise_id: 'other' }, { quote_id: 'other' }, { currency: 'USD' }]) {
      const quote: any = price(kind, { amount_usd: 'ignored-diagnostic', quote_scope: undefined, enterprise_id: 'enterprise-1',
        quote_id: 'quote-1', pricing_version: 'quote-1', ...invalid });
      const protocol = { validateAddress: (value: string) => new URL(value),
        fetchSigned: jest.fn().mockResolvedValue(new Response(JSON.stringify(quote), {
          headers: { 'content-type': 'application/json' },
        })) };
      const action = kind === 'image'
        ? new Sub2apiImageAdapter({} as never, protocol as never).pricing(imageInput, 'test-model', enterpriseConnection)
        : new Sub2apiVideoAdapter({} as never, protocol as never).pricing(enterpriseConnection, videoInput, 'test-model');
      if (invalid) await expect(action).rejects.toMatchObject({ status: 503 });
      else await expect(action).resolves.toMatchObject({ currency: 'CNY', amount_cny: '0.000000', amount_usd: null });
    }
  });
});
