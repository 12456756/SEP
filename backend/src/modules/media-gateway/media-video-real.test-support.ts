import { createHash } from 'node:crypto';
import { MediaVideoRealStore, VIDEO_REAL_ADAPTER } from './media-video-real.store';
import type { VideoRealClaim, VideoRealQuoteMetadata } from './media-video-real.store';
import { videoClaims } from './media-video-gateway.test-support';

export { videoClaims };
export const fingerprint = 'a'.repeat(64);
export const scope = JSON.stringify([videoClaims.enterpriseId, videoClaims.subscriptionId, videoClaims.memberId, videoClaims.sub]);
export const parameters = { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' as const, frameRate: 24, audio: true, outputFormat: 'video/mp4' as const };
export const input = { profileId: 'real-h3', configVersion: 'cfg-real-h3', operation: 'text-to-video' as const,
  referenceIds: [] as string[], creativeBrief: 'Private product brief', parameters };
export const policy = { enabledProfileIds: [input.profileId], defaultProfileId: input.profileId,
  allowedOperations: ['text-to-video', 'image-to-video'], maxDurationSeconds: 4,
  allowedAspectRatios: ['16:9'], maxResolution: '720p', maxConcurrentJobs: 2, periodBudget: 10 };
export const capabilities = { supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: true,
  durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24],
  maxInputBytes: 10 * 1024 * 1024, maxReferenceCount: 1, outputFormats: ['video/mp4'],
  supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 86_400 };
export const profile = { ...input, kind: 'video', displayName: 'H3', modelId: 'minimax-h3', executionMode: 'async-query',
  operations: ['text-to-video', 'image-to-video'], capabilities, enabled: true, verified: true };
export function quoteMetadata(): VideoRealQuoteMetadata {
  return {
    adapter: VIDEO_REAL_ADAPTER, consumedByClientRequestId: null,
    configuration: { adapter: VIDEO_REAL_ADAPTER, profileId: input.profileId, configVersion: input.configVersion,
      modelId: 'minimax-h3', operation: input.operation, parameters, connectionFingerprint: fingerprint,
      pricingVersion: 'pricing-1', amountCny: '1.400000', amountUsd: '0.2', usdToCnyRate: 7 },
    referenceIds: [], referenceHashes: [],
    value: { mock: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), semanticSha256: 'b'.repeat(64),
      pricingStatus: 'quoted', amountCny: '1.400000', amountUsd: '0.2', usdToCnyRate: 7,
      pricingVersion: 'pricing-1', billingStatus: 'NOT_RESERVED',
      funding: { creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' } },
  };
}

/** Serial transactions with rollback; no network or real database. */
export function videoRealPrisma() {
  const references = new Map<string, any>();
  const quotes = new Map<string, any>();
  const requests = new Map<string, any>();
  const reservations = new Map<string, any>();
  const copy = <T>(v: T): T => structuredClone(v);
  const enterprise = { mediaPolicy: { video: copy(policy) } };
  const model = copy(profile);
  let nextId = 0;
  const reference = {
    create: jest.fn(async ({ data }) => {
      const row = { ...copy(data), id: `reference-${++nextId}`, createdAt: new Date(), updatedAt: new Date() };
      references.set(row.id, row); return copy(row);
    }),
    findUnique: jest.fn(async ({ where }) => copy(references.get(where.id) ?? null)),
  };
  const quote = {
    create: jest.fn(async ({ data }) => {
      const row = { ...copy(data), id: `quote-${++nextId}`, createdAt: new Date(), updatedAt: new Date() };
      quotes.set(row.id, row); return copy(row);
    }),
    findUnique: jest.fn(async ({ where }) => copy(quotes.get(where.id) ?? null)),
    updateMany: jest.fn(async ({ where, data }) => {
      const row = quotes.get(where.id);
      if (!row || row.scope !== where.scope || row.expiresAt <= where.expiresAt.gt || JSON.stringify(row.metadata) !== JSON.stringify(where.metadata.equals)) return { count: 0 };
      quotes.set(row.id, { ...row, ...copy(data) }); return { count: 1 };
    }),
  };
  const request = {
    findUnique: jest.fn(async ({ where }) => {
      if (where.id) return copy(requests.get(where.id) ?? null);
      const key = where.enterpriseId_clientRequestId;
      return copy([...requests.values()].find(row => row.enterpriseId === key.enterpriseId && row.clientRequestId === key.clientRequestId) ?? null);
    }),
    findMany: jest.fn(async ({ where, take }) => {
      const jsonMatches = (value, filter) => filter.path.reduce((part, key) => part?.[key], value) === filter.equals;
      const match = (row, filter) => (!filter.AND || filter.AND.every(item => match(row, item))) &&
        (!filter.OR || filter.OR.some(item => match(row, item))) &&
        (!filter.id?.gt || row.id > filter.id.gt) && (!filter.status || filter.status.in.includes(row.status)) &&
        (!filter.enterpriseId || row.enterpriseId === filter.enterpriseId) &&
        (!filter.configuration || jsonMatches(row.configuration, filter.configuration)) &&
        (!filter.receipt || jsonMatches(row.receipt, filter.receipt));
      return copy([...requests.values()].filter(row => match(row, where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take ?? requests.size));
    }),
    count: jest.fn(async ({ where }) => {
      const match = (row, filter) => (!filter.enterpriseId || row.enterpriseId === filter.enterpriseId) &&
        (!filter.status || filter.status.in.includes(row.status)) &&
        (!filter.configuration || row.configuration[filter.configuration.path[0]] === filter.configuration.equals);
      return [...requests.values()].filter(row => match(row, where)).length;
    }),
    create: jest.fn(async ({ data }) => {
      const row = { ...copy(data), id: `receipt-${++nextId}`, revision: 0, createdAt: new Date(), updatedAt: new Date() };
      requests.set(row.id, row); return copy(row);
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const row = requests.get(where.id);
      if (!row || row.scope !== where.scope || row.enterpriseId !== where.enterpriseId || row.revision !== where.revision || row.configuration.adapter !== where.configuration.equals) return { count: 0 };
      requests.set(row.id, { ...row, ...copy(data), revision: row.revision + data.revision.increment, updatedAt: new Date() }); return { count: 1 };
    }),
  };
  let tail = Promise.resolve();
  const prisma = {
    enterpriseMember: { findFirst: jest.fn().mockResolvedValue({ departmentId: 'department-1' }) },
    subscription: { findFirst: jest.fn().mockResolvedValue({ id: videoClaims.subscriptionId }) },
    enterpriseModelConfig: { findUnique: jest.fn(async () => copy(enterprise)) },
    mediaModelProfile: { findUnique: jest.fn(async () => copy(model)) },
    mediaGatewayReference: reference, mediaGatewayQuote: quote, mediaGatewayRequest: request,
    mediaRealBillingReservation: { findMany: jest.fn(async ({ where }) => copy([...reservations.values()].filter(row => where.receiptId.in.includes(row.receiptId)))) },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = tail.then(async () => {
        const snapshot = copy({ references, quotes, requests });
        try { return await fn(prisma); }
        catch (error) {
          for (const [target, source] of [[references, snapshot.references], [quotes, snapshot.quotes], [requests, snapshot.requests]]) {
            target.clear(); for (const [key, value] of source) target.set(key, value);
          }
          throw error;
        }
      });
      tail = run.then(() => undefined, () => undefined); return run;
    }),
    state: { references, quotes, requests, reservations, enterprise, model },
  };
  return prisma;
}

export async function newClaim(store: MediaVideoRealStore, clientRequestId = 'client-1'): Promise<VideoRealClaim> {
  const metadata = quoteMetadata();
  const quote = await store.saveQuote(scope, metadata);
  return { enterpriseId: videoClaims.enterpriseId, clientRequestId, scope, semanticSha256: metadata.value.semanticSha256,
    referenceIds: [], referenceHashes: [], submissionDeadline: new Date(Date.now() + 180_000),
    configuration: { ...metadata.configuration, quoteId: quote.quoteId, upstreamTaskId: null, upstreamRequestId: null,
      dispatchState: 'NOT_DISPATCHED', outputExpiresAt: null },
    receipt: { mock: false, clientRequestId, profileId: input.profileId, configVersion: input.configVersion, operation: input.operation,
      status: 'SUBMITTING', pollAfterMs: 2000, outputs: [], billingStatus: 'NOT_RESERVED', errorCode: null,
      amountCny: metadata.value.amountCny, amountUsd: metadata.value.amountUsd,
      recovery: { canQuery: true, canCancel: false, canDownload: false } },
  };
}

export const videoBytes = Buffer.from('verified-video-test-bytes');
export const outputMetadata = { sha256: createHash('sha256').update(videoBytes).digest('hex'), byteLength: videoBytes.length,
  mimeType: 'video/mp4' as const, durationSeconds: 4, width: 1280, height: 720, frameRate: 24 };
