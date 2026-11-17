import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MediaRealService } from './media-real.service';
import { ImageDispatchError } from './sub2api-image.adapter';
import { MediaRealQuoteRequestSchema, MediaRealQuoteRequestV3Schema, MediaRealQuoteV3Schema } from 'shared';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import type { RealRequestRecord } from './media-real.store';

const claims = { enterpriseId: 'enterprise', sub: 'user', memberId: 'member', subscriptionId: 'subscription' } as ClientEmploymentClaims;
const scope = JSON.stringify([claims.enterpriseId, claims.sub, claims.memberId, claims.subscriptionId]);
const hash = createHash('sha256').update(MEDIA_MOCK_PNG).digest('hex');
const profile = { profileId: 'image', configVersion: 'cfg_1', executionMode: 'sync-response', operations: ['generate', 'edit'],
  capabilities: { sizes: ['1024x1024'], maxOutputs: 4, supportsReferenceImage: true } };
const quoteInput = MediaRealQuoteRequestSchema.parse({ profileId: 'image', configVersion: 'cfg_1', operation: 'generate', creativeBrief: 'Draw a product' });
const request = { ...quoteInput, clientRequestId: 'request', quoteId: 'quote' };
const quoteInputV3 = MediaRealQuoteRequestV3Schema.parse({
  protocolVersion: 3, specRevision: 1, profileId: 'image', configVersion: 'cfg_1', operation: 'generate',
  referenceIds: [], creativeBrief: 'Draw a product', requestedSpec: { width: 1, height: 1, count: 1, quality: 'medium' },
  parameterSources: { width: 'model', height: 'model', count: 'model', quality: 'model' },
});

function harness() {
  let record: RealRequestRecord | null = null;
  let quote: any = null;
  const prisma = { enterpriseMember: { findFirst: jest.fn().mockResolvedValue({ departmentId: null }) },
    enterpriseModelConfig: { findUnique: jest.fn().mockResolvedValue({ mediaPolicy: { enabledProfileIds: ['image'], defaultProfileId: null } }) },
    subscription: { findFirst: jest.fn().mockResolvedValue({ id: 'subscription' }) },
    mediaModelProfile: { findUnique: jest.fn().mockResolvedValue({ ...profile, modelId: 'gpt-image-2', enabled: true, verified: true }) } };
  const config = { get: jest.fn().mockReturnValue('true') };
  const settings = { getEffectiveValue: jest.fn().mockResolvedValue('7.2') };
  const mediaConfig = { getConnection: jest.fn().mockResolvedValue({ configured: true }),
    getRuntimeMedia: jest.fn().mockResolvedValue({ executionAvailable: true, profiles: [profile] }),
    getRuntimeMediaV3: jest.fn().mockResolvedValue({ executionAvailable: true, profiles: [{
      profileId: 'image', configVersion: 'cfg_1', executionMode: 'sync-response', operations: ['generate', 'edit'], authorized: true,
      adapter: { available: true, operations: ['generate', 'edit'] },
    }] }) };
  const adapter = { pricing: jest.fn().mockResolvedValue({ amount_usd: '0.10', pricing_version: 'price1', expires_at: new Date(Date.now() + 60_000).toISOString() }),
    connectionSnapshot: jest.fn().mockResolvedValue({ connection: { base: 'https://media.example.test/v1', key: 'secret' }, fingerprint: 'a'.repeat(64) }),
    connectionFingerprint: jest.fn().mockResolvedValue('a'.repeat(64)), assertConnectionFingerprint: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue({ requestId: 'upstream', images: [MEDIA_MOCK_PNG] }),
    usage: jest.fn().mockResolvedValue({ status: 'settled', actual_cost_usd: '0.08', model: 'gpt-image-2', image_count: 1 }) };
  const cache = { put: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue(MEDIA_MOCK_PNG) };
  const billing = { quoteFunding: jest.fn().mockResolvedValue({ creditCny: '0.720000', memberWalletCny: '0.000000', personalCny: '0.000000' }),
    status: jest.fn().mockResolvedValue('RESERVED'),
    reserve: jest.fn().mockResolvedValue(undefined), release: jest.fn().mockResolvedValue(undefined), settle: jest.fn().mockResolvedValue('SETTLED'),
    settleNegotiated: jest.fn().mockResolvedValue('SETTLED') };
  const store = {
    saveQuote: jest.fn(async (_scope: string, value: any, usdToCnyRate: number, connectionFingerprint?: string) => {
      quote = { scope: _scope, value: { ...value, quoteId: 'quote' }, usdToCnyRate, connectionFingerprint }; return quote.value;
    }),
    findQuote: jest.fn(async () => quote), findReference: jest.fn(async () => ({ scope, value: { sha256: hash, byteLength: MEDIA_MOCK_PNG.length, expiresAt: new Date(Date.now() + 60_000).toISOString() } })),
    findByClientId: jest.fn(async () => record), findRequest: jest.fn(async () => record),
    pendingRequests: jest.fn(async () => ({ records: record ? [structuredClone(record)] : [], afterId: undefined })),
    claim: jest.fn(async (input: any) => {
      if (record) return { record: structuredClone(record), created: false };
      record = { ...input, id: 'receipt', receipt: { ...input.receipt, receiptId: 'receipt' }, revision: 0 };
      return { record: structuredClone(record), created: true };
    }),
    save: jest.fn(async (value: RealRequestRecord) => {
      if (record?.revision === value.revision) record = structuredClone({ ...value, revision: value.revision + 1 });
      return structuredClone(record!);
    }),
    saveReference: jest.fn(async (_scope: string, value: any) => ({ ...value, referenceId: 'reference' })),
  };
  const service = new MediaRealService(config as any, prisma as any, settings as any, mediaConfig as any, adapter as any, cache as any, billing as any, store as any);
  return { service, config, settings, mediaConfig, prisma, adapter, cache, billing, store,
    quote: () => quote, record: () => record! };
}

describe('MediaRealService', () => {
  it('rejects excessive total reference bytes before asking for a price', async () => {
    const h = harness();
    h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, modelId: 'gpt-image-2', enabled: true, verified: true,
      capabilities: { ...profile.capabilities, maxReferenceCount: 32 } });
    h.store.findReference.mockImplementation(async () => ({ scope,
      value: { sha256: hash, byteLength: 5 * 1024 * 1024, expiresAt: new Date(Date.now() + 60000).toISOString() } }));
    const edit = { ...quoteInputV3, operation: 'edit' as const, referenceIds: Array.from({ length: 21 }, (_, i) => `ref-${i}`) };
    await expect(h.service.quote(claims, edit)).rejects.toMatchObject({ status: 413, response: { error: { code: 'INVALID_REFERENCE' } } });
    expect(h.adapter.pricing).not.toHaveBeenCalled();
    expect(h.billing.reserve).not.toHaveBeenCalled();
  });

  it('enforces a changed reference limit for both quote and submit before dispatch', async () => {
    const h = harness();
    const row = { ...profile, modelId: 'gpt-image-2', enabled: true, verified: true,
      capabilities: { ...profile.capabilities, maxReferenceCount: 3 } };
    h.prisma.mediaModelProfile.findUnique.mockResolvedValue(row);
    const edit = { ...quoteInputV3, operation: 'edit' as const, referenceIds: ['a', 'b', 'c'] };
    await h.service.quote(claims, edit);
    expect(h.adapter.pricing).toHaveBeenCalledTimes(1);
    row.capabilities.maxReferenceCount = 2;
    await expect(h.service.quote(claims, edit)).rejects.toMatchObject({ status: 422, response: { error: { code: 'INVALID_REFERENCE' } } });
    await expect(h.service.submit(claims, { ...edit, quoteId: 'quote', clientRequestId: 'three-images' }))
      .rejects.toMatchObject({ status: 422 });
    expect(h.billing.reserve).not.toHaveBeenCalled();
    expect(h.adapter.execute).not.toHaveBeenCalled();
  });

  it('returns the original submission error and persists it without resubmitting', async () => {
    const h = harness();
    const original = { status: 403, body: { error: { code: 'permission_error', message: 'Image edit denied' } } };
    h.adapter.execute.mockRejectedValue(new ImageDispatchError('upstream', false, 'UPSTREAM_FAILED', original));
    await h.service.quote(claims, quoteInputV3);
    const input = { ...quoteInputV3, quoteId: 'quote', clientRequestId: 'upstream-error' };
    await expect(h.service.submit(claims, input)).rejects.toMatchObject({ status: 403, response: original.body });
    expect(h.record().receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'RECONCILING', upstreamError: original });
    await h.service.submit(claims, input);
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
    expect(h.billing.release).not.toHaveBeenCalled();
  });
  it.each(['subscription', 'policy', 'profile', 'model', 'switch'] as const)(
    'rechecks V3 execution authorization after reservation when %s changes', async change => {
      const h = harness();
      await h.service.quote(claims, quoteInputV3);
      h.billing.reserve.mockImplementationOnce(async () => {
        if (change === 'subscription') h.prisma.subscription.findFirst.mockResolvedValue(null);
        if (change === 'policy') h.mediaConfig.getRuntimeMediaV3.mockResolvedValue({ executionAvailable: false, profiles: [] });
        if (change === 'profile') h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, modelId: 'gpt-image-2', enabled: false, verified: true });
        if (change === 'model') h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, modelId: 'different-image-model', enabled: true, verified: true });
        if (change === 'switch') h.config.get.mockReturnValue('false');
      });
      const receipt = await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'revoked-during-reserve', quoteId: 'quote' });
      expect(receipt).toMatchObject({ status: 'FAILED', errorCode: 'CONFIG_CHANGED', billingStatus: 'RELEASED' });
      expect(h.adapter.execute).not.toHaveBeenCalled();
      expect(h.billing.release).toHaveBeenCalledWith('receipt');
    },
  );
  it.each(['changed', 'unavailable'] as const)('releases a reserved V3 request when its pre-dispatch connection is %s', async failure => {
    const h = harness();
    await h.service.quote(claims, quoteInputV3);
    const unchanged = { connection: { base: 'https://media.example.test/v1', key: 'secret' }, fingerprint: 'a'.repeat(64) };
    h.adapter.connectionSnapshot.mockResolvedValueOnce(unchanged);
    if (failure === 'changed') h.adapter.connectionSnapshot.mockResolvedValueOnce({ ...unchanged, fingerprint: 'b'.repeat(64) });
    else h.adapter.connectionSnapshot.mockRejectedValueOnce(new Error('connection unavailable'));
    const receipt = await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'local-failure', quoteId: 'quote' });
    expect(receipt).toMatchObject({ status: 'FAILED', errorCode: 'CONFIG_CHANGED', billingStatus: 'RELEASED', recovery: { canQuery: false } });
    expect(h.adapter.execute).not.toHaveBeenCalled();
    expect(h.billing.release).toHaveBeenCalledWith('receipt');
  });

  it('retries a local pre-dispatch failure refund without dispatching or querying usage', async () => {
    const h = harness();
    await h.service.quote(claims, quoteInputV3);
    h.adapter.connectionSnapshot.mockResolvedValueOnce({ connection: { base: 'https://media.example.test/v1', key: 'secret' }, fingerprint: 'a'.repeat(64) })
      .mockRejectedValueOnce(new Error('connection unavailable'));
    h.billing.release.mockRejectedValueOnce(new Error('billing unavailable'));
    const submitted = await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'refund-retry', quoteId: 'quote' });
    expect(submitted).toMatchObject({ status: 'FAILED', errorCode: 'CONFIG_CHANGED', billingStatus: 'RECONCILING', recovery: { canQuery: true } });
    const recovered = await h.service.receipt(claims, 'receipt');
    expect(recovered).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED' });
    expect(h.billing.release).toHaveBeenCalledTimes(2);
    expect(h.adapter.execute).not.toHaveBeenCalled(); expect(h.adapter.usage).not.toHaveBeenCalled();
  });

  it('does not release a V3 reservation when execute has started but acceptance is unknown', async () => {
    const h = harness();
    await h.service.quote(claims, quoteInputV3);
    h.adapter.execute.mockRejectedValue(new ImageDispatchError(null, false));
    const receipt = await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'ambiguous-dispatch', quoteId: 'quote' });
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'RECONCILING' });
    expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('reports a known size mismatch for heterogeneous V3 outputs without inventing a shared actual size', async () => {
    const h = harness();
    await h.service.quote(claims, quoteInputV3);
    await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'mixed-dimensions', quoteId: 'quote' });
    const record = h.record();
    record.receipt.outputs.push({ ...record.receipt.outputs[0], outputId: 'different-dimensions', width: 2, height: 2 });
    (h.service as any).applyActualSpec(record, { size: '1x1', count: 2, quality: 'medium' });
    expect(record.receipt).toMatchObject({ actualSpec: { count: 2 }, acceptance: { status: 'mismatched', mismatchedFields: ['size'], unknownFields: ['quality'] } });
    expect((record.receipt as any).actualSpec.size).toBeUndefined();
  });

  it('distinguishes a removed V3 grant from an authorized profile version change', async () => {
    const h = harness();
    h.mediaConfig.getRuntimeMediaV3.mockResolvedValue({ executionAvailable: false, profiles: [] });
    h.prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { enabledProfileIds: [], defaultProfileId: null } });
    await expect(h.service.quote(claims, quoteInputV3)).rejects.toMatchObject({ response: { error: { code: 'MEDIA_FORBIDDEN' } } });
    h.prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { enabledProfileIds: ['image'], defaultProfileId: null } });
    await expect(h.service.quote(claims, quoteInputV3)).rejects.toMatchObject({ response: { error: { code: 'CONFIG_CHANGED' } } });
  });

  it('quotes full-length V3 size and quality labels without storage contract truncation', async () => {
    const h = harness();
    const dto = { ...quoteInputV3, requestedSpec: { size: 's'.repeat(128), count: 1, quality: 'q'.repeat(128) } };
    const result = await h.service.quote(claims, dto);
    expect(MediaRealQuoteV3Schema.safeParse(result).success).toBe(true);
  });
  it('retains an upstream specification error without assuming rejection before execution or releasing funds', async () => {
    const h = harness();
    await h.service.quote(claims, quoteInputV3);
    h.adapter.execute.mockRejectedValue(new ImageDispatchError('upstream', false, 'UPSTREAM_SPEC_UNSUPPORTED'));
    const receipt = await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'unsupported-spec', quoteId: 'quote' });
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', errorCode: 'UPSTREAM_SPEC_UNSUPPORTED', billingStatus: 'RECONCILING' });
    await h.service.receipt(claims, receipt.receiptId);
    expect(h.billing.release).not.toHaveBeenCalled();
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('does not drop explicit pixel dimensions when a named size cannot express them', async () => {
    const h = harness();
    await expect(h.service.quote(claims, { ...quoteInputV3, requestedSpec: { size: 'auto', width: 1, height: 1, count: 1, quality: 'medium' } }))
      .rejects.toMatchObject({ response: { error: { code: 'ADAPTER_FIELD_UNMAPPED', field: 'requestedSpec.width' } } });
    expect(h.adapter.pricing).not.toHaveBeenCalled();
    expect(h.billing.reserve).not.toHaveBeenCalled();
  });
  it('retains and settles extra safe V3 outputs while reporting count mismatch', async () => {
    const h = harness();
    h.adapter.execute.mockResolvedValue({ requestId: 'upstream', images: [MEDIA_MOCK_PNG, MEDIA_MOCK_PNG] });
    h.adapter.usage.mockResolvedValue({ status: 'settled', actual_cost_usd: '0.08', model: 'gpt-image-2', image_count: 2 });
    await h.service.quote(claims, quoteInputV3);
    const receipt = await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'extra-outputs', quoteId: 'quote' });
    expect(receipt).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', actualSpec: { count: 2 },
      acceptance: { status: 'mismatched', mismatchedFields: ['count'] }, recovery: { canDownload: true } });
    expect(receipt.outputs).toHaveLength(2);
  });

  it('settles a negotiated unknown model with dot profile and nonlegacy config IDs', async () => {
    const h = harness();
    const dto = { ...quoteInputV3, profileId: 'future.image', configVersion: 'config:2026.10' };
    h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, ...dto, modelId: 'future-image-native', enabled: true, verified: true });
    const runtime = await h.mediaConfig.getRuntimeMediaV3();
    h.mediaConfig.getRuntimeMediaV3.mockResolvedValue({ ...runtime, profiles: runtime.profiles.map(item => ({ ...item, profileId: dto.profileId, configVersion: dto.configVersion })) });
    h.adapter.usage.mockResolvedValue({ status: 'settled', actual_cost_usd: '0.08', model: 'future-image-native', image_count: 1 });
    await h.service.quote(claims, dto);
    const receipt = await h.service.submit(claims, { ...dto, clientRequestId: 'future-request', quoteId: 'quote' });
    expect(receipt).toMatchObject({ protocolVersion: 3, profileId: 'future.image', configVersion: 'config:2026.10', status: 'SUCCEEDED', billingStatus: 'SETTLED' });
    expect(h.billing.settleNegotiated).toHaveBeenCalledWith('receipt', '0.576000', '0.080000', 'future-image-native', 'future-image-native');
  });

  it.each(['amount', 'version', 'model', 'adapter', 'connection'] as const)('does not reserve or dispatch when V3 frozen %s changes', async change => {
    const h = harness();
    await h.service.quote(claims, quoteInputV3);
    if (change === 'amount') h.adapter.pricing.mockResolvedValue({ amount_usd: '0.11', pricing_version: 'price1', expires_at: new Date(Date.now() + 60_000).toISOString() });
    if (change === 'version') h.adapter.pricing.mockResolvedValue({ amount_usd: '0.10', pricing_version: 'price2', expires_at: new Date(Date.now() + 60_000).toISOString() });
    if (change === 'model') h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, modelId: 'future-image-native', enabled: true, verified: true });
    if (change === 'adapter') h.quote().value.adapterVersion = 'old-adapter';
    if (change === 'connection') h.adapter.connectionSnapshot.mockResolvedValue({ connection: { base: 'https://changed.example/v1', key: 'secret' }, fingerprint: 'b'.repeat(64) });
    await expect(h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'request-v3', quoteId: 'quote' })).rejects.toMatchObject({ response: { error: { code: 'CONFIG_CHANGED' } } });
    expect(h.billing.reserve).not.toHaveBeenCalled();
    expect(h.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([[false, true, 'MEDIA_FORBIDDEN'], [true, false, 'ADAPTER_UNAVAILABLE']] as const)('reports V3 authorization %s and adapter availability %s precisely', async (authorized, available, code) => {
    const h = harness();
    const runtime = await h.mediaConfig.getRuntimeMediaV3();
    h.mediaConfig.getRuntimeMediaV3.mockResolvedValue({ executionAvailable: false, profiles: runtime.profiles.map(item => ({ ...item, authorized, adapter: { ...item.adapter, available } })) });
    await expect(h.service.quote(claims, quoteInputV3)).rejects.toMatchObject({ response: { error: { code, field: 'profileId' } } });
    expect(h.adapter.pricing).not.toHaveBeenCalled();
  });

  it('quotes and submits V3 without capability-hint whitelisting or silent defaults', async () => {
    const h = harness();
    const quote = await h.service.quote(claims, quoteInputV3);
    expect(quote).toMatchObject({ protocolVersion: 3, semanticHashVersion: 3,
      effectiveSpec: { size: '1x1', count: 1, quality: 'medium' } });
    expect(h.adapter.pricing).toHaveBeenCalledWith(expect.objectContaining({ requestedSpec: expect.objectContaining({ size: '1x1' }) }), 'gpt-image-2', expect.any(Object));
    const receipt = await h.service.submit(claims, { ...quoteInputV3, clientRequestId: 'request-v3', quoteId: 'quote' });
    expect(receipt).toMatchObject({ protocolVersion: 3, status: 'SUCCEEDED', actualSpec: { count: 1 },
      acceptance: { status: 'unknown', unknownFields: ['quality'] } });
    expect(h.billing.settleNegotiated).toHaveBeenCalledWith('receipt', '0.576000', '0.080000', 'gpt-image-2', 'gpt-image-2');
  });

  it('rejects missing V3 pricing dimensions before pricing or dispatch', async () => {
    const h = harness();
    const missing = MediaRealQuoteRequestV3Schema.parse({ ...quoteInputV3, requestedSpec: { count: 1 } });
    await expect(h.service.quote(claims, missing)).rejects.toMatchObject({ response: { error: { code: 'MISSING_SPEC', field: 'requestedSpec.size' } } });
    expect(h.adapter.pricing).not.toHaveBeenCalled(); expect(h.adapter.execute).not.toHaveBeenCalled();
  });
  it('returns client profiles contract and respects disabled runtime', async () => {
    const h = harness();
    expect(await h.service.profiles(claims)).toMatchObject({ mock: false, persistence: 'database', profiles: [profile] });
    h.mediaConfig.getRuntimeMedia.mockResolvedValue({ executionAvailable: false, profiles: [profile] });
    expect((await h.service.profiles(claims)).profiles).toEqual([]);
  });

  it('does not reserve or dispatch at quote and freezes the exchange rate', async () => {
    const h = harness(); const quote = await h.service.quote(claims, quoteInput);
    expect(quote.amountCny).toBe('0.720000');
    expect(h.billing.reserve).not.toHaveBeenCalled(); expect(h.adapter.execute).not.toHaveBeenCalled();
    h.settings.getEffectiveValue.mockResolvedValue('9');
    const receipt = await h.service.submit(claims, request);
    expect(receipt.billingStatus).toBe('SETTLED');
    expect(h.billing.reserve).toHaveBeenCalledWith(claims, 'receipt', '0.720000', 7.2);
    expect(h.billing.settle).toHaveBeenCalledWith('receipt', '0.576000', '0.080000', 'gpt-image-2');
    expect(h.record().configuration).not.toHaveProperty('creativeBrief');
  });

  it('projects stable field, stage, and recovery metadata for unsupported image requests', async () => {
    const h = harness();
    h.mediaConfig.getRuntimeMedia.mockResolvedValue({ executionAvailable: true, profiles: [{ ...profile, capabilities: { ...profile.capabilities, sizes: ['1536x1024'] } }] });
    await expect(h.service.quote(claims, quoteInput)).rejects.toMatchObject({ response: { error: {
      code: 'CONFIG_CHANGED', field: 'parameters.size', stage: 'image-quote', recovery: 'revise_request',
    } } });
  });

  it('freezes the selected profile model from quote through execution and billing reconciliation', async () => {
    const h = harness();
    h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, modelId: 'gpt-image-1.5', enabled: true, verified: true });
    h.adapter.usage.mockResolvedValue({ status: 'settled', actual_cost_usd: '0.08', model: 'gpt-image-1.5', image_count: 1 });
    await h.service.quote(claims, quoteInput);
    expect(h.adapter.pricing).toHaveBeenCalledWith(quoteInput, 'gpt-image-1.5');
    await h.service.submit(claims, request);
    expect(h.store.claim.mock.calls[0][0].configuration).toMatchObject({ modelId: 'gpt-image-1.5' });
    expect(h.adapter.execute).toHaveBeenCalledWith(expect.objectContaining({ ...quoteInput, ...request }), [], expect.any(Function), 'gpt-image-1.5');
    expect(h.billing.settle).toHaveBeenCalledWith('receipt', '0.576000', '0.080000', 'gpt-image-1.5');
  });

  it('concurrent identical requests dispatch only once', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    await Promise.all([h.service.submit(claims, request), h.service.submit(claims, request)]);
    expect(h.adapter.execute).toHaveBeenCalledTimes(1); expect(h.billing.reserve).toHaveBeenCalledTimes(1);
  });

  it('settles from verified usage without consulting a changed current profile', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.usage.mockResolvedValueOnce({ status: 'pending', actual_cost_usd: null, model: null, image_count: 0 } as any);
    await h.service.submit(claims, request);
    h.prisma.mediaModelProfile.findUnique.mockClear();
    h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, modelId: 'changed-model', enabled: true, verified: true });
    expect(await h.service.receipt(claims, 'receipt')).toMatchObject({ billingStatus: 'SETTLED' });
    expect(h.billing.settle).toHaveBeenCalledWith('receipt', '0.576000', '0.080000', 'gpt-image-2');
    expect(h.prisma.mediaModelProfile.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', 'other-model'])('does not settle unverified upstream model %s', async model => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.usage.mockResolvedValue({ status: 'settled', actual_cost_usd: '0.08', model, image_count: 1 } as any);
    expect(await h.service.submit(claims, request)).toMatchObject({ billingStatus: 'RECONCILING' });
    expect(h.billing.settle).not.toHaveBeenCalled();
  });

  it('rejects a changed payload under the same key', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput); await h.service.submit(claims, request);
    await expect(h.service.submit(claims, { ...request, creativeBrief: 'Different prompt' })).rejects.toMatchObject({ status: 409 });
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('recovers by original key even if edit references have expired', async () => {
    const h = harness(); const edit = { ...quoteInput, operation: 'edit' as const, referenceIds: ['reference'] };
    await h.service.quote(claims, edit); await h.service.submit(claims, { ...edit, quoteId: 'quote', clientRequestId: 'request' });
    h.store.findReference.mockRejectedValue(new Error('expired'));
    expect((await h.service.submit(claims, { ...edit, quoteId: 'quote', clientRequestId: 'request' })).status).toBe('SUCCEEDED');
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('never resubmits or releases an ambiguous upstream result', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.execute.mockRejectedValue(new ImageDispatchError('upstream', false));
    expect((await h.service.submit(claims, request)).status).toBe('SUBMISSION_UNKNOWN');
    expect((await h.service.submit(claims, request)).status).toBe('SUBMISSION_UNKNOWN');
    expect(h.adapter.execute).toHaveBeenCalledTimes(1); expect(h.billing.release).not.toHaveBeenCalled(); expect(h.billing.settle).not.toHaveBeenCalled();
  });

  it('releases the reservation only for a definite dispatch rejection', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.execute.mockRejectedValue(new ImageDispatchError(null, true));
    expect(await h.service.submit(claims, request)).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED' });
    expect(h.billing.release).toHaveBeenCalledWith('receipt');
  });

  it('marks an uncertain reservation as reconciling without dispatch or release', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.billing.reserve.mockRejectedValue(new Error('unknown commit'));
    await expect(h.service.submit(claims, request)).rejects.toThrow('unknown commit');
    expect(h.record().receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'RECONCILING' });
    expect(h.adapter.execute).not.toHaveBeenCalled(); expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('rejects insufficient funds without upstream execution', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.billing.reserve.mockRejectedValue(new HttpException({}, 402));
    await expect(h.service.submit(claims, request)).rejects.toMatchObject({ status: 402 });
    expect(h.record().receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED' });
    expect(h.adapter.execute).not.toHaveBeenCalled();
  });

  it('checks reference cache before reserving', async () => {
    const h = harness(); const edit = { ...quoteInput, operation: 'edit' as const, referenceIds: ['reference'] };
    await h.service.quote(claims, edit); h.cache.get.mockRejectedValue(new HttpException({}, 410));
    await expect(h.service.submit(claims, { ...edit, quoteId: 'quote', clientRequestId: 'request' })).rejects.toMatchObject({ status: 410 });
    expect(h.billing.reserve).not.toHaveBeenCalled(); expect(h.store.claim).not.toHaveBeenCalled();
  });

  it('recovers download and billing from a new service instance without another dispatch', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.usage.mockResolvedValueOnce({ status: 'pending', actual_cost_usd: null, model: null, image_count: 0 } as any);
    const receipt = await h.service.submit(claims, request);
    expect(receipt).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'RECONCILING' });
    const restarted = new MediaRealService(h.config as any, h.prisma as any, h.settings as any, h.mediaConfig as any, h.adapter as any, h.cache as any, h.billing as any, h.store as any);
    expect((await restarted.receipt(claims, 'receipt')).billingStatus).toBe('SETTLED');
    expect((await restarted.content(claims, 'receipt', 'receipt_0')).bytes).toEqual(MEDIA_MOCK_PNG);
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('returns partial upstream output without regenerating missing outputs', async () => {
    const h = harness(); const input = { ...quoteInput, parameters: { ...quoteInput.parameters, count: 2 } };
    await h.service.quote(claims, input);
    expect(await h.service.submit(claims, { ...input, clientRequestId: 'request', quoteId: 'quote' })).toMatchObject({ status: 'PARTIAL_SUCCEEDED', outputErrors: [{ index: 1, code: 'OUTPUT_FAILED' }] });
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('denies revoked membership and cross enterprise receipt/download access', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput); await h.service.submit(claims, request);
    const other = { ...claims, enterpriseId: 'other' };
    await expect(h.service.receipt(other, 'receipt')).rejects.toMatchObject({ status: 404 });
    await expect(h.service.content(other, 'receipt', 'receipt_0')).rejects.toMatchObject({ status: 404 });
    h.prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(h.service.content(claims, 'receipt', 'receipt_0')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects expired quotes and unverified/currently changed profiles before claim', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.quote().value.expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(h.service.submit(claims, request)).rejects.toMatchObject({ status: 409 });
    expect(h.store.claim).not.toHaveBeenCalled();
    h.prisma.mediaModelProfile.findUnique.mockResolvedValue({ ...profile, modelId: 'gpt-image-2', enabled: true, verified: false });
    await expect(h.service.quote(claims, quoteInput)).rejects.toMatchObject({ status: 409 });
  });

  it('marks expired downloads without generating or changing billing', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput); await h.service.submit(claims, request);
    h.record().receipt.outputs[0].expiresAt = new Date(Date.now() - 1).toISOString();
    expect(await h.service.receipt(claims, 'receipt')).toMatchObject({ status: 'RESULT_EXPIRED', billingStatus: 'SETTLED', recovery: { canDownload: false } });
    await expect(h.service.content(claims, 'receipt', 'receipt_0')).rejects.toMatchObject({ status: 410 });
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('persists the upstream request ID before receiving image bytes', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.execute.mockImplementationOnce(async (_input, _bytes, onRequestId) => {
      await onRequestId('early-upstream');
      expect(h.record().upstreamRequestId).toBe('early-upstream');
      expect(h.record().receipt.outputs).toEqual([]);
      throw new ImageDispatchError('early-upstream', false);
    });
    expect(await h.service.submit(claims, request)).toMatchObject({ status: 'SUBMISSION_UNKNOWN' });
    expect(h.record().upstreamRequestId).toBe('early-upstream');
  });

  it('keeps history authorized and downloadable after new execution is disabled', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput); await h.service.submit(claims, request);
    h.config.get.mockReturnValue('false');
    expect((await h.service.receipt(claims, 'receipt')).status).toBe('SUCCEEDED');
    expect((await h.service.content(claims, 'receipt', 'receipt_0')).bytes).toEqual(MEDIA_MOCK_PNG);
    await expect(h.service.quote(claims, quoteInput)).rejects.toMatchObject({ status: 503 });
    h.prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(h.service.receipt(claims, 'receipt')).rejects.toMatchObject({ status: 403 });
  });

  it('retries a definite rejection refund after a transient release failure, never dispatching again', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.execute.mockRejectedValueOnce(new ImageDispatchError(null, true));
    h.billing.release.mockRejectedValueOnce(new Error('commit unknown'));
    expect(await h.service.submit(claims, request)).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING' });
    expect(await h.service.receipt(claims, 'receipt')).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED' });
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('repairs a receipt from an already committed ledger without re-settling', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.usage.mockResolvedValueOnce({ status: 'pending', actual_cost_usd: null, model: null, image_count: 0 } as any);
    await h.service.submit(claims, request);
    h.billing.status.mockResolvedValueOnce('SETTLED');
    expect(await h.service.receipt(claims, 'receipt')).toMatchObject({ billingStatus: 'SETTLED' });
    expect(h.billing.settle).not.toHaveBeenCalled();
  });

  it('background reconciliation works without client queries or enabling new execution', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.usage.mockResolvedValueOnce({ status: 'pending', actual_cost_usd: null, model: null, image_count: 0 } as any);
    await h.service.submit(claims, request); h.config.get.mockReturnValue('false');
    await h.service.reconcilePending();
    expect(h.record().receipt.billingStatus).toBe('SETTLED');
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
    expect(h.store.pendingRequests).toHaveBeenCalledWith(20, undefined);
  });

  it('releases a confirmed reservation when reserve acknowledgement was lost before dispatch', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.billing.reserve.mockRejectedValueOnce(new Error('commit unknown'));
    await expect(h.service.submit(claims, request)).rejects.toThrow();
    expect(await h.service.receipt(claims, 'receipt')).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED' });
    expect(h.billing.release).toHaveBeenCalledWith('receipt');
    expect(h.adapter.execute).not.toHaveBeenCalled();
  });

  it('preserves late successful outputs when a timeout sweep wins the receipt CAS', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.cache.put.mockImplementationOnce(async () => {
      h.record().submissionDeadline = new Date(Date.now() - 1);
      await h.service.reconcilePending();
      expect(h.record().receipt.status).toBe('SUBMISSION_UNKNOWN');
    });
    expect(await h.service.submit(claims, request)).toMatchObject({
      status: 'SUCCEEDED', billingStatus: 'SETTLED', outputs: [{ outputId: 'receipt_0' }], errorCode: null,
    });
    expect(h.record().upstreamRequestId).toBe('upstream');
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
    expect(h.billing.settle).toHaveBeenCalledTimes(1);
  });

  it('persists an early upstream ID even when a timeout sweep wins its first CAS', async () => {
    const h = harness(); await h.service.quote(claims, quoteInput);
    h.adapter.execute.mockImplementationOnce(async (_input, _bytes, onRequestId) => {
      h.record().submissionDeadline = new Date(Date.now() - 1);
      await h.service.reconcilePending();
      await onRequestId('early-upstream');
      expect(h.record().upstreamRequestId).toBe('early-upstream');
      expect(h.record().receipt.status).toBe('SUBMISSION_UNKNOWN');
      return { requestId: 'early-upstream', images: [MEDIA_MOCK_PNG] };
    });
    expect(await h.service.submit(claims, request)).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', errorCode: null });
    expect(h.record().upstreamRequestId).toBe('early-upstream');
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
    expect(h.billing.release).not.toHaveBeenCalled();
  });
});
