import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ComputeModelCatalogService } from './compute-model-catalog.service';
import { ComputeConnectionService } from './compute-connection.service';
import { ComputeIntegrationService } from './compute-integration.service';

function setup() {
  const db: any = { platformModel: { findMany: jest.fn().mockResolvedValue([]) }, mediaModelProfile: { findMany: jest.fn().mockResolvedValue([]) } };
  const connections = { enterprise: jest.fn(async (enterprise: string, kind: string) => ({ baseURL: 'https://compute.test/v1', apiKey: `${enterprise}-${kind}-secret` })) };
  const protocol = { request: jest.fn(async (path, options, origin) => {
    const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${options.apiKey}` } });
    if (!response.ok) {
      const { upstreamException } = await import('../../common/errors/upstream-http.exception');
      throw await upstreamException(response, [options.apiKey]);
    }
    return response;
  }) };
  return { db, connections, protocol, service: new ComputeModelCatalogService(db, connections as any, protocol as any) };
}
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('Enterprise key model catalog', () => {
  let fetcher: jest.SpyInstance;
  beforeEach(() => { fetcher = jest.spyOn(global, 'fetch'); });
  afterEach(() => fetcher.mockRestore());

  it('queries each enterprise/purpose key independently and exposes no key material', async () => {
    const { service, connections } = setup();
    fetcher.mockImplementation(async (_url, init) => json({ data: [{ id: (init.headers as any).Authorization.includes('first') ? 'model-a' : 'model-b' }] }));
    const [a, b, image] = await Promise.all([service.list('first', 'chat'), service.list('second', 'chat'), service.list('first', 'image')]);
    expect(a).toEqual([{ modelId: 'model-a', displayName: 'model-a' }]); expect(b[0].modelId).toBe('model-b');
    expect(image[0].modelId).toBe('model-a'); expect(connections.enterprise).toHaveBeenCalledWith('first', 'image');
    expect(fetcher.mock.calls.map(call => (call[1].headers as any).Authorization)).toEqual(['Bearer first-chat-secret', 'Bearer second-chat-secret', 'Bearer first-image-secret']);
    expect(JSON.stringify(a)).not.toContain('secret');
  });

  it('ignores retired model status/category/capabilities and excludes configured media', async () => {
    const { db, service } = setup();
    fetcher.mockResolvedValue(json({ data: [{ id: 'tenant-only', display_name: '企业模型' }, { id: 'denied' }, { id: 'media' }, { id: 'gpt-image-2' }, { id: 'embedding' }] }));
    db.platformModel.findMany.mockResolvedValue([{ modelId: 'denied', enabled: false }, { modelId: 'tenant-only', enabled: true, isStale: true, pricingInputPer1M: '99' }, { modelId: 'embedding', category: 'embedding' }]);
    db.mediaModelProfile.findMany.mockResolvedValue([{ modelId: 'media' }]);
    const models = await service.chatModels('first');
    expect(models.map(model => model.modelId)).toEqual(['denied', 'embedding', 'tenant-only']);
    expect(models[2]).toMatchObject({ modelId: 'tenant-only', displayName: '企业模型', pricingInputPer1M: null, pricingOutputPer1M: null, billingMultiplier: null, supportedFeatures: null, maxOutputTokens: null });
    expect(db.platformModel.findMany).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('empty enterprise catalog stays empty rather than returning administrator models', async () => {
    const { service, db } = setup(); fetcher.mockResolvedValue(json({ data: [] }));
    expect(await service.chatModels('first')).toEqual([]); expect(db.platformModel.findMany).not.toHaveBeenCalled();
  });

  it.each([{ data: [{ id: 'one' }], partial: true }, { data: 'invalid' }, { data: [{ id: ' invalid' }] }])('rejects partial or invalid responses %j', async body => {
    const { service } = setup(); fetcher.mockResolvedValue(json(body)); await expect(service.list('first', 'chat')).rejects.toThrow(ServiceUnavailableException);
  });

  it('rejects a degraded response header', async () => {
    const { service } = setup(); fetcher.mockResolvedValue(json({ data: [{ id: 'one' }] }, 200, { 'x-data-degraded': 'true' }));
    await expect(service.list('first', 'chat')).rejects.toThrow('不完整');
  });

  it('preserves upstream failure details while redacting the enterprise key', async () => {
    const { service } = setup(); fetcher.mockResolvedValue(json({ error: { code: 'INVALID_API_KEY', message: 'first-chat-secret rejected' } }, 401));
    try { await service.list('first', 'chat'); throw new Error('should reject'); }
    catch (error: any) { expect(error.getStatus()).toBe(401); expect(JSON.stringify(error.getResponse())).toContain('INVALID_API_KEY'); expect(JSON.stringify(error.getResponse())).not.toContain('first-chat-secret'); }
  });

  it('rejects a foreign chat choice and media profile without calling a generation endpoint', async () => {
    const { service } = setup(); fetcher.mockImplementation(async () => json({ data: [{ id: 'own' }] }));
    await expect(service.assertChatModels('first', ['foreign'])).rejects.toThrow(BadRequestException);
    const profiles = [{ profileId: 'own-profile', modelId: 'own' }, { profileId: 'other-profile', modelId: 'foreign' }];
    expect(await service.filterProfiles('first', 'video', profiles)).toEqual([profiles[0]]);
    await expect(service.assertProfiles('first', 'image', profiles, ['other-profile'])).rejects.toThrow('可用范围');
    expect(fetcher.mock.calls.every(call => String(call[0]).endsWith('/models'))).toBe(true);
  });

  it('allows removing an unavailable retained profile without depending on a working remote key', async () => {
    const { service, connections } = setup(); connections.enterprise.mockRejectedValue(new ServiceUnavailableException('key missing'));
    await service.assertProfiles('first', 'image', [], [], ['removed']);
    expect(connections.enterprise).not.toHaveBeenCalled(); expect(await service.configured('first', 'image')).toBe(false);
  });

  it('does not read an administrator key when resolving an enterprise connection', async () => {
    const settings = { getEffectiveValue: jest.fn().mockResolvedValue('https://compute.test/v1/') };
    const integrations = { selectEnterpriseCredential: jest.fn().mockResolvedValue({ apiKey: 'tenant-key', credentialId: 'key1', version: 2, remoteAccountId: 'acct1' }) };
    const connection = new ComputeConnectionService(settings as any, integrations as any);
    expect(await connection.enterprise('first', 'image')).toMatchObject({ baseURL: 'https://compute.test/v1', apiKey: 'tenant-key', source: 'enterprise' });
    expect(settings.getEffectiveValue.mock.calls).toEqual([['MEDIA_BASE_URL']]);
  });

  it('blocks enterprise-mode billable requests until settlement is connected', async () => {
    const mode = 'ENTERPRISE';
    const db: any = { enterpriseComputeBinding: { findUnique: jest.fn().mockResolvedValue({ mode }) } };
    const integration = new ComputeIntegrationService(db, new ConfigService(), { isConnected: () => false } as any);
    await expect(integration.assertEnterpriseReady('first')).rejects.toMatchObject({ response: { code: 'COMPUTE_SETTLEMENT_NOT_CONNECTED' } });
  });
});
