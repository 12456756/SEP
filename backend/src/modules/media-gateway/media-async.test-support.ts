import { MediaRealAnyReceiptSchema } from 'shared';
import { MediaRealService } from './media-real.service';
import type { RealRequestRecord } from './media-real.store';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';
import { contractResult } from './longdao-media.test-support';
import { enterpriseMediaStub } from '../../../test/stubs/enterprise-media.stub';

export const imageClaims = { enterpriseId: 'enterprise', sub: 'user', memberId: 'member', subscriptionId: 'subscription' } as ClientEmploymentClaims;
export const imageInput = { protocolVersion: 3 as const, specRevision: 1, profileId: 'image', configVersion: 'cfg_1',
  operation: 'generate' as const, referenceIds: [], creativeBrief: 'Draw a product', requestedSpec: { size: '1x1', count: 1, quality: 'medium' } };

export function imageHarness() {
  const records = new Map<string, RealRequestRecord>();
  const quotes = new Map<string, any>();
  let nextId = 0;
  const scope = JSON.stringify([imageClaims.enterpriseId, imageClaims.sub, imageClaims.memberId, imageClaims.subscriptionId]);
  const profile = { profileId: 'image', configVersion: 'cfg_1', executionMode: 'async-query', operations: ['generate', 'edit'],
    modelId: 'gpt-image-2', enabled: true, verified: true,
    capabilities: { sizes: ['1x1'], maxOutputs: 1, supportsReferenceImage: true, maxReferenceCount: 4 } };
  const config = { get: jest.fn().mockReturnValue('true') };
  const prisma = { enterpriseMember: { findFirst: jest.fn().mockResolvedValue({ departmentId: null }) },
    subscription: { findFirst: jest.fn().mockResolvedValue({ id: 'subscription' }) },
    enterpriseModelConfig: { findUnique: jest.fn().mockResolvedValue({ mediaPolicy: { enabledProfileIds: ['image'] } }) },
    mediaModelProfile: { findUnique: jest.fn().mockResolvedValue(profile) } };
  const mediaConfig = { getConnection: jest.fn().mockResolvedValue({ configured: true }),
    getRuntimeMediaV3: jest.fn().mockResolvedValue({ executionAvailable: true, profiles: [{ ...profile, authorized: true,
      adapter: { available: true, operations: ['generate', 'edit'] } }] }) };
  const adapter = {
    pricing: jest.fn().mockResolvedValue({ amount_usd: null, amount_cny: '0.720000', quote_id: 'price1', pricing_version: 'price1', expires_at: new Date(Date.now() + 60000).toISOString() }),
    connectionSnapshot: jest.fn().mockResolvedValue({ connection: { base: 'https://media.example.test/v1', key: 'secret' }, fingerprint: 'a'.repeat(64) }),
    assertConnectionFingerprint: jest.fn().mockResolvedValue(undefined),
    submitAsync: jest.fn(async (_input, _references, _model, requestId) => contractResult(requestId, { status: 'processing' }, 202)),
    queryAsync: jest.fn(async (_connection, requestId) => contractResult(requestId, { status: 'completed', is_final: true,
      billing: { status: 'settled', actual_cost_usd: '0.08' } })),
    contentAsync: jest.fn().mockResolvedValue({ bytes: MEDIA_MOCK_PNG, metadata: { mimeType: 'image/png', width: 1, height: 1 } }),
    usage: jest.fn(async requestId => ({ request_id: requestId, status: 'settled', actual_cost_usd: '0.08', model: 'gpt-image-2', image_count: 1 })),
  };
  const cache = { put: jest.fn(), get: jest.fn().mockResolvedValue(MEDIA_MOCK_PNG) };
  const journals = new Map<string, string>();
  const billing = { quoteFunding: jest.fn().mockResolvedValue({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '0.720000' }),
    reserve: jest.fn(async (_claims, id) => { journals.set(id, 'RESERVED'); }),
    release: jest.fn(async id => { journals.set(id, 'RELEASED'); }),
    status: jest.fn(async id => journals.get(id)),
    settle: jest.fn(async id => { journals.set(id, 'SETTLED'); return 'SETTLED'; }),
    settleNegotiated: jest.fn(async id => { journals.set(id, 'SETTLED'); return 'SETTLED'; }),
  };
  const guarded = async (value: RealRequestRecord) => {
    const current = records.get(value.id)!;
    const updated = current.revision === value.revision;
    if (updated) records.set(value.id, structuredClone({ ...value, receipt: MediaRealAnyReceiptSchema.parse(value.receipt), revision: value.revision + 1 }));
    return { updated, record: structuredClone(records.get(value.id)!) };
  };
  const store = {
    saveQuote: jest.fn(async (_scope, value, usdToCnyRate, connectionFingerprint, compute) => {
      const quoteId = `quote-${++nextId}`; const result = { ...value, quoteId };
      quotes.set(quoteId, { scope: _scope, value: result, usdToCnyRate, connectionFingerprint, compute }); return result;
    }),
    findQuote: jest.fn(async id => quotes.get(id)),
    findReference: jest.fn().mockResolvedValue({ scope, value: { sha256: 'b'.repeat(64), byteLength: MEDIA_MOCK_PNG.length, expiresAt: new Date(Date.now() + 60000).toISOString() } }),
    saveReference: jest.fn(async (_scope, value) => ({ ...value, referenceId: 'reference' })),
    findByClientId: jest.fn(async (enterpriseId, clientRequestId) => structuredClone([...records.values()].find(r => r.enterpriseId === enterpriseId && r.clientRequestId === clientRequestId) ?? null)),
    findRequest: jest.fn(async id => structuredClone(records.get(id) ?? null)),
    claim: jest.fn(async value => {
      const previous = [...records.values()].find(r => r.enterpriseId === value.enterpriseId && r.clientRequestId === value.clientRequestId);
      if (previous) return { created: false, record: structuredClone(previous) };
      const id = `receipt-${++nextId}`;
      const record = { ...value, id, revision: 0, receipt: { ...value.receipt, receiptId: id } };
      records.set(id, record); return { created: true, record: structuredClone(record) };
    }),
    saveGuarded: jest.fn(guarded), save: jest.fn(async record => (await guarded(record)).record),
    pendingRequests: jest.fn(async () => ({ records: structuredClone([...records.values()]) })),
  };
  const enterprise = enterpriseMediaStub('https://media.example.test/v1', 'secret', 'a'.repeat(64), '0.576000');
  Object.assign(billing, { settleCompute: jest.fn(async id => {
    const status = enterprise.feeStatus() === 'not_charged' ? 'RELEASED' : 'SETTLED'; journals.set(id, status); return status;
  }) });
  const asyncAdapter = { ...adapter,
    submitAsync: async (...args: Parameters<typeof adapter.submitAsync>) => { const result = await adapter.submitAsync(...args); enterprise.observe(result.contract); return result; },
    queryAsync: async (...args: Parameters<typeof adapter.queryAsync>) => { const result = await adapter.queryAsync(...args); enterprise.observe(result.contract); return result; },
  };
  const service = new MediaRealService(config as never, prisma as never, { getEffectiveValue: async () => '7.2' } as never,
    mediaConfig as never, asyncAdapter as never, cache as never, billing as never, store as never, enterprise.connections as never, enterprise.media as never);
  const submit = async (clientRequestId = 'client-1', input = imageInput) => {
    const quote = await service.quote(imageClaims, input);
    const request = { ...input, clientRequestId, quoteId: quote.quoteId };
    return { receipt: await service.submit(imageClaims, request), request };
  };
  const submitFailure = async (status: number) => {
    const quote = await service.quote(imageClaims, imageInput);
    const request = { ...imageInput, clientRequestId: 'client-1', quoteId: quote.quoteId };
    await expect(service.submit(imageClaims, request)).rejects.toMatchObject({ status });
    const record = await store.findByClientId(imageClaims.enterpriseId, request.clientRequestId);
    return { receipt: MediaRealAnyReceiptSchema.parse(record.receipt), request };
  };
  return { service, prisma, config, mediaConfig, adapter, cache, billing: billing as typeof billing & { settleCompute: jest.Mock }, store, records, journals, submit, submitFailure, profile, enterprise };
}
