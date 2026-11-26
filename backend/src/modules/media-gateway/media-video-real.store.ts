import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, type MediaGatewayRequest } from '@prisma/client';
import { z } from 'zod';
import { MAX_MEDIA_REFERENCE_COUNT, MediaReferenceCountSchema, MediaVideoInputReferenceSchema, MediaVideoOperationSchema, VIDEO_INPUT_MAX_COUNT } from 'shared';
import { MediaVideoParametersSchema, MediaConfigVersionV3Schema, MediaProfileIdV3Schema, MediaVideoSpecV3Schema, MediaVideoAuthorizationSchema,
  MediaVideoRealQuoteBaseSchema, MediaVideoRealQuoteV3Schema, MediaVideoRealQuoteSchema, MediaVideoRealReceiptSchema, MediaVideoRealReferenceSchema } from 'shared';
import type { MediaVideoRealQuote, MediaVideoRealReceipt, MediaVideoRealReference } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { videoGatewayError, videoStorageUnavailable } from './media-video-gateway.store';
import { ComputeMediaSnapshotSchema } from '../compute-integration/compute-media.service';

export const VIDEO_REAL_ADAPTER = 'sub2api-video-v1';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.string().regex(/^\d{1,8}\.\d{6}$/);
const LegacyFrozenSchema = z.object({
  compute: ComputeMediaSnapshotSchema.optional(),
  adapter: z.literal(VIDEO_REAL_ADAPTER), profileId: id, configVersion: id,
  modelId: z.literal('minimax-h3'), operation: z.enum(['text-to-video', 'image-to-video']),
  parameters: MediaVideoParametersSchema.refine(p => p.durationSeconds === 4 && p.resolution === '720p' &&
    p.aspectRatio === '16:9' && p.frameRate === 24 && p.audio && p.outputFormat === 'video/mp4'),
  connectionFingerprint: hash, pricingVersion: z.string().min(1).max(128),
  amountCny: money, amountUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable(), usdToCnyRate: z.number().finite().positive().nullable(),
}).strict();
const V3FrozenSchema = z.object({
  compute: ComputeMediaSnapshotSchema.optional(),
  maxReferenceCount: MediaReferenceCountSchema.optional(),
  maxVideoReferenceCount: z.number().int().min(1).max(VIDEO_INPUT_MAX_COUNT).optional(),
  videoReferences: z.array(MediaVideoInputReferenceSchema.extend({
    upstreamReferenceId: z.string().regex(/^vref_[a-f0-9]{32}$/),
  }).strict()).max(VIDEO_INPUT_MAX_COUNT).optional(),
  adapter: z.literal(VIDEO_REAL_ADAPTER), protocolVersion: z.literal(3), semanticHashVersion: z.literal(3),
  specRevision: z.number().int().positive(), profileId: MediaProfileIdV3Schema, configVersion: MediaConfigVersionV3Schema,
  modelId: z.string().trim().min(1).max(160), operation: MediaVideoOperationSchema,
  requestedSpec: MediaVideoSpecV3Schema, effectiveSpec: MediaVideoSpecV3Schema,
  parameterSources: z.record(z.string(), z.union([
    z.enum(['user', 'model', 'upstream']),
    z.object({ source: z.enum(['user', 'model', 'upstream']), decisionRef: z.string() }).strict(),
  ])).optional(),
  connectionFingerprint: hash, pricingVersion: z.string().min(1).max(128),
  amountCny: money, amountUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable(), usdToCnyRate: z.number().finite().positive().nullable(),
}).strict();
const FrozenSchema = z.union([V3FrozenSchema, LegacyFrozenSchema]);
const QuoteSchema = z.object({
  adapter: z.literal(VIDEO_REAL_ADAPTER), value: z.union([
    MediaVideoRealQuoteBaseSchema.omit({ quoteId: true }), MediaVideoRealQuoteV3Schema.omit({ quoteId: true }),
  ]),
  configuration: FrozenSchema, referenceIds: z.array(id).max(MAX_MEDIA_REFERENCE_COUNT), referenceHashes: z.array(hash).max(MAX_MEDIA_REFERENCE_COUNT),
  consumedByClientRequestId: id.nullable(),
}).strict();
const ReferenceSchema = z.object({
  adapter: z.literal(VIDEO_REAL_ADAPTER), value: MediaVideoRealReferenceSchema.omit({ referenceId: true }),
}).strict();
const VIDEO_INPUT_ADAPTER = 'sub2api-video-reference-v1';
const VideoInputMetadataSchema = z.object({
  adapter: z.literal(VIDEO_INPUT_ADAPTER), value: MediaVideoInputReferenceSchema.omit({ referenceId: true }),
  upstreamReferenceId: z.string().regex(/^vref_[a-f0-9]{32}$/), connectionFingerprint: hash,
}).strict();
export type VideoInputMetadata = z.infer<typeof VideoInputMetadataSchema>;
const DispatchSchema = z.object({
  contractVersion: z.literal(2).optional(),
  cancelSupported: z.boolean().optional(),
  quoteId: id,
  upstreamTaskId: z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/).nullable(),
  upstreamRequestId: z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/).nullable(),
  dispatchState: z.enum(['NOT_DISPATCHED', 'DISPATCHING', 'ACCEPTED', 'REJECTED']),
  outputExpiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const ConfigurationSchema = z.union([
  V3FrozenSchema.extend(DispatchSchema.shape),
  LegacyFrozenSchema.extend(DispatchSchema.shape),
]);
export type VideoRealFrozenConfiguration = z.infer<typeof FrozenSchema>;
export type VideoRealQuoteMetadata = z.infer<typeof QuoteSchema>;
export type VideoRealRecord = {
  enterpriseId: string; clientRequestId: string; scope: string; semanticSha256: string;
  referenceIds: string[]; referenceHashes: string[]; configuration: z.infer<typeof ConfigurationSchema>;
  receipt: MediaVideoRealReceipt; revision: number; submissionDeadline: Date; createdAt: Date;
};
type ReceiptWithoutId<T> = T extends unknown ? Omit<T, 'receiptId'> : never;
export type VideoRealClaim = Omit<VideoRealRecord, 'revision' | 'createdAt' | 'receipt'> & {
  receipt: ReceiptWithoutId<MediaVideoRealReceipt>;
};
const isOurs = (value: unknown): boolean => !!value && typeof value === 'object' &&
  'adapter' in value && value.adapter === VIDEO_REAL_ADAPTER;
const retryable = (e: unknown, code: string) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;

/** Shared media idempotency index; secrets, supplier URLs and prompts never enter metadata. */
@Injectable()
export class MediaVideoRealStore {
  constructor(private readonly prisma: PrismaService) {}

  async saveVideoReference(scope: string, input: Omit<VideoInputMetadata, 'adapter'>) {
    return this.safe(async () => {
      const metadata = VideoInputMetadataSchema.parse({ ...input, adapter: VIDEO_INPUT_ADAPTER });
      const row = await this.prisma.mediaGatewayReference.create({ data: { scope, metadata, expiresAt: new Date(metadata.value.expiresAt) } });
      return MediaVideoInputReferenceSchema.parse({ ...metadata.value, referenceId: row.id });
    });
  }

  async findVideoReference(scope: string, referenceId: string) {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayReference.findUnique({ where: { id: referenceId } });
      if (!row || row.scope !== scope || (row.metadata as { adapter?: string })?.adapter !== VIDEO_INPUT_ADAPTER) return null;
      const metadata = VideoInputMetadataSchema.parse(row.metadata);
      if (row.expiresAt.getTime() !== Date.parse(metadata.value.expiresAt)) videoStorageUnavailable();
      return { ...metadata, value: MediaVideoInputReferenceSchema.parse({ ...metadata.value, referenceId: row.id }) };
    });
  }

  async saveReference(scope: string, value: Omit<MediaVideoRealReference, 'referenceId'>): Promise<MediaVideoRealReference> {
    return this.safe(async () => {
      const metadata = ReferenceSchema.parse({ adapter: VIDEO_REAL_ADAPTER, value });
      const row = await this.prisma.mediaGatewayReference.create({ data: { scope, metadata, expiresAt: new Date(value.expiresAt) } });
      return MediaVideoRealReferenceSchema.parse({ ...value, referenceId: row.id });
    });
  }

  async findReference(scope: string, referenceId: string): Promise<MediaVideoRealReference | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayReference.findUnique({ where: { id: referenceId } });
      if (!row || row.scope !== scope || !isOurs(row.metadata)) return null;
      const { value } = ReferenceSchema.parse(row.metadata);
      if (row.expiresAt.getTime() !== Date.parse(value.expiresAt)) videoStorageUnavailable();
      return MediaVideoRealReferenceSchema.parse({ ...value, referenceId: row.id });
    });
  }

  async saveQuote(scope: string, input: VideoRealQuoteMetadata): Promise<MediaVideoRealQuote> {
    return this.safe(async () => {
      const metadata = this.quoteMetadata(input);
      const row = await this.prisma.mediaGatewayQuote.create({ data: { scope, metadata, expiresAt: new Date(metadata.value.expiresAt) } });
      return MediaVideoRealQuoteSchema.parse({ ...metadata.value, quoteId: row.id });
    });
  }

  async findQuote(scope: string, quoteId: string): Promise<VideoRealQuoteMetadata | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayQuote.findUnique({ where: { id: quoteId } });
      if (!row || row.scope !== scope || !isOurs(row.metadata)) return null;
      const metadata = this.quoteMetadata(row.metadata);
      if (row.expiresAt.getTime() !== Date.parse(metadata.value.expiresAt)) videoStorageUnavailable();
      return metadata;
    });
  }

  async findRequest(scope: string, receiptId: string): Promise<VideoRealRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayRequest.findUnique({ where: { id: receiptId } });
      return row && row.scope === scope && isOurs(row.configuration) ? this.decode(row) : null;
    });
  }

  async pendingRequests(limit = 20, afterId?: string): Promise<{
    records: Array<{ receiptId: string; scope: string }>; afterId?: string;
  }> {
    return this.safe(async () => {
      const take = Math.max(1, Math.min(100, limit));
      const rows = await this.prisma.mediaGatewayRequest.findMany({
        where: { ...(afterId ? { id: { gt: afterId } } : {}), AND: [
          { configuration: { path: ['adapter'], equals: VIDEO_REAL_ADAPTER } },
          { OR: [
            { status: { in: ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'QUEUED', 'RUNNING'] } },
            { receipt: { path: ['billingStatus'], equals: 'RESERVED' } },
            { receipt: { path: ['billingStatus'], equals: 'RECONCILING' } },
            { AND: [
              { receipt: { path: ['execution', 'generationStatus'], equals: 'completed' } },
              { OR: [
                { receipt: { path: ['fileStatus'], equals: 'pending' } },
                { receipt: { path: ['fileStatus'], equals: 'download_failed' } },
              ] },
            ] },
          ] },
        ] },
        orderBy: { id: 'asc' }, take, select: { id: true, scope: true },
      });
      return { records: rows.map(row => ({ receiptId: row.id, scope: row.scope })),
        afterId: rows.length === take ? rows[rows.length - 1].id : undefined };
    });
  }

  async findByClientId(enterpriseId: string, clientRequestId: string, scope: string, forReplay = false): Promise<VideoRealRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayRequest.findUnique({ where: { enterpriseId_clientRequestId: { enterpriseId, clientRequestId } } });
      if (!row) return null;
      if (row.scope !== scope) {
        if (forReplay) videoGatewayError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被占用');
        return null;
      }
      if (!isOurs(row.configuration)) {
        if (forReplay) videoGatewayError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于其他媒体请求');
        return null;
      }
      return this.decode(row);
    });
  }

  async hasUniqueUpstreamRequest(record: VideoRealRecord): Promise<boolean> {
    return this.safe(async () => {
      const requestId = record.configuration.upstreamRequestId;
      if (!requestId) return false;
      // The same gateway credential may be shared by several enterprises; never
      // let one upstream bill settle two otherwise valid local receipts.
      const rows = await this.prisma.mediaGatewayRequest.findMany({ where: { AND: [
        { configuration: { path: ['adapter'], equals: VIDEO_REAL_ADAPTER } },
        { configuration: { path: ['connectionFingerprint'], equals: record.configuration.connectionFingerprint } },
        { configuration: { path: ['upstreamRequestId'], equals: requestId } },
      ] }, take: 2, select: { id: true } });
      return rows.length === 1 && rows[0].id === record.receipt.receiptId;
    });
  }

  async claim(input: VideoRealClaim): Promise<{ created: boolean; record: VideoRealRecord }> {
    return this.safe(async () => {
      const configuration = ConfigurationSchema.parse(input.configuration);
      const { receiptId: _, ...receipt } = MediaVideoRealReceiptSchema.parse({ ...input.receipt, receiptId: 'pending' });
      if (receipt.status !== 'SUBMITTING' || receipt.billingStatus !== 'NOT_RESERVED' || configuration.dispatchState !== 'NOT_DISPATCHED' ||
        configuration.upstreamTaskId || !configuration.contractVersion && configuration.upstreamRequestId) videoStorageUnavailable();
      hash.parse(input.semanticSha256);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await this.prisma.$transaction(async tx => {
            const prior = await tx.mediaGatewayRequest.findUnique({ where: { enterpriseId_clientRequestId: {
              enterpriseId: input.enterpriseId, clientRequestId: input.clientRequestId,
            } } });
            if (prior) {
              if (prior.scope !== input.scope || !isOurs(prior.configuration)) videoGatewayError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被占用');
              return { created: false, record: this.decode(prior) };
            }
            const quote = await tx.mediaGatewayQuote.findUnique({ where: { id: configuration.quoteId } });
            if (!quote || quote.scope !== input.scope || !isOurs(quote.metadata)) videoGatewayError(404, 'MEDIA_NOT_FOUND', '视频报价不可用');
            const metadata = this.quoteMetadata(quote.metadata);
            if (quote.expiresAt.getTime() <= Date.now() || quote.expiresAt.getTime() !== Date.parse(metadata.value.expiresAt)) videoGatewayError(409, 'QUOTE_EXPIRED', '视频报价已过期');
            if (metadata.consumedByClientRequestId !== null) videoGatewayError(409, 'QUOTE_ALREADY_USED', '视频报价已消费');
            const { quoteId: _q, upstreamTaskId: _t, upstreamRequestId: _r, dispatchState: _d, outputExpiresAt: _e, contractVersion: _c, cancelSupported: _s, ...frozen } = configuration;
            if (JSON.stringify(metadata.configuration) !== JSON.stringify(frozen) || metadata.value.semanticSha256 !== input.semanticSha256 ||
              JSON.stringify(metadata.referenceIds) !== JSON.stringify(input.referenceIds) || JSON.stringify(metadata.referenceHashes) !== JSON.stringify(input.referenceHashes)) {
              videoGatewayError(409, 'IDEMPOTENCY_CONFLICT', '视频报价与请求不一致');
            }
            await this.enforcePolicy(tx, input.enterpriseId, configuration);
            const consumed = await tx.mediaGatewayQuote.updateMany({ where: { id: quote.id, scope: input.scope,
              metadata: { equals: quote.metadata as Prisma.InputJsonValue }, expiresAt: { gt: new Date() } },
              data: { metadata: { ...metadata, consumedByClientRequestId: input.clientRequestId } } });
            if (consumed.count !== 1) videoGatewayError(409, 'QUOTE_ALREADY_USED', '视频报价已消费或过期');
            const row = await tx.mediaGatewayRequest.create({ data: {
              enterpriseId: input.enterpriseId, clientRequestId: input.clientRequestId, scope: input.scope,
              semanticSha256: input.semanticSha256, referenceIds: input.referenceIds, referenceHashes: input.referenceHashes,
              count: 1, submissionDeadline: input.submissionDeadline, configuration, receipt, status: receipt.status,
            } });
            return { created: true, record: this.decode(row) };
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if (retryable(error, 'P2002')) {
            const record = await this.findByClientId(input.enterpriseId, input.clientRequestId, input.scope, true);
            if (record) return { created: false, record };
          }
          if (!retryable(error, 'P2034') || attempt === 2) throw error;
        }
      }
      return videoStorageUnavailable();
    });
  }

  /** CAS results must be checked before an external side effect. A loser never dispatches. */
  async save(record: VideoRealRecord): Promise<{ updated: boolean; record: VideoRealRecord }> {
    return this.safe(async () => {
      const configuration = ConfigurationSchema.parse(record.configuration);
      const { receiptId, ...receipt } = MediaVideoRealReceiptSchema.parse(record.receipt);
      let updated = false;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.prisma.$transaction(async tx => {
            if (configuration.upstreamRequestId) {
              const owners = await tx.mediaGatewayRequest.findMany({ where: { AND: [
                { configuration: { path: ['adapter'], equals: VIDEO_REAL_ADAPTER } },
                { configuration: { path: ['connectionFingerprint'], equals: configuration.connectionFingerprint } },
                { configuration: { path: ['upstreamRequestId'], equals: configuration.upstreamRequestId } },
              ] }, select: { id: true }, take: 2 });
              if (owners.some(owner => owner.id !== receiptId)) videoGatewayError(409, 'BILLING_PENDING', '视频账单 requestId 已由另一回执占用');
            }
            return tx.mediaGatewayRequest.updateMany({
              where: { id: receiptId, scope: record.scope, enterpriseId: record.enterpriseId, revision: record.revision,
                configuration: { path: ['adapter'], equals: VIDEO_REAL_ADAPTER } },
              data: { configuration, receipt, status: receipt.status, revision: { increment: 1 } },
            });
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          updated = result.count === 1;
          break;
        } catch (error) {
          // Retry the rolled-back transaction with the original revision: a
          // concurrent winner must remain a CAS miss, never a stale overwrite.
          if (!retryable(error, 'P2034') || attempt === 2) throw error;
        }
      }
      const current = await this.findRequest(record.scope, receiptId);
      if (!current) videoStorageUnavailable();
      return { updated, record: current };
    });
  }

  private async enforcePolicy(tx: Prisma.TransactionClient, enterpriseId: string, config: VideoRealFrozenConfiguration) {
    const row = await tx.enterpriseModelConfig.findUnique({ where: { enterpriseId } });
    const raw = row?.mediaPolicy as Record<string, unknown> | null;
    const parsed = MediaVideoAuthorizationSchema.safeParse(raw?.video ?? {});
    if (!parsed.success) videoGatewayError(403, 'MEDIA_FORBIDDEN', '企业视频授权无效');
    const policy = parsed.data;
    if (!policy.enabledProfileIds.includes(config.profileId)) {
      videoGatewayError(403, 'MEDIA_FORBIDDEN', '企业视频授权已撤销');
    }
  }

  private validReferenceCount(configuration: VideoRealFrozenConfiguration, count: number): boolean {
    if (configuration.operation === 'video-to-video') return 'protocolVersion' in configuration
      && count >= 1 && count <= (configuration.maxVideoReferenceCount ?? 0) && count === configuration.videoReferences?.length;
    if (configuration.operation !== 'image-to-video') return count === 0;
    const maximum = 'protocolVersion' in configuration ? configuration.maxReferenceCount ?? 1 : 1;
    return count >= 1 && count <= maximum;
  }

  private validVideoReferences(configuration: VideoRealFrozenConfiguration, ids: string[], hashes: string[]): boolean {
    if (!('protocolVersion' in configuration)) return true;
    const references = configuration.videoReferences ?? [];
    if (configuration.operation !== 'video-to-video') return references.length === 0;
    return new Set(ids).size === ids.length && references.every((reference, index) => reference.referenceId === ids[index]
      && reference.sha256 === hashes[index] && reference.profileId === configuration.profileId && reference.configVersion === configuration.configVersion);
  }

  private quoteMetadata(value: unknown): VideoRealQuoteMetadata {
    const meta = QuoteSchema.parse(value);
    if (meta.referenceIds.length !== meta.referenceHashes.length || !this.validReferenceCount(meta.configuration, meta.referenceIds.length) ||
      !this.validVideoReferences(meta.configuration, meta.referenceIds, meta.referenceHashes) ||
      meta.value.amountCny !== meta.configuration.amountCny || meta.value.amountUsd !== meta.configuration.amountUsd ||
      meta.value.pricingVersion !== meta.configuration.pricingVersion || meta.value.usdToCnyRate !== meta.configuration.usdToCnyRate) videoStorageUnavailable();
    return meta;
  }

  private decode(row: MediaGatewayRequest): VideoRealRecord {
    const configuration = ConfigurationSchema.parse(row.configuration);
    const receipt = MediaVideoRealReceiptSchema.parse({ ...(row.receipt as Prisma.JsonObject), receiptId: row.id });
    if (receipt.status !== row.status || receipt.clientRequestId !== row.clientRequestId || receipt.profileId !== configuration.profileId ||
      receipt.configVersion !== configuration.configVersion || receipt.operation !== configuration.operation ||
      receipt.amountCny !== configuration.amountCny || row.count !== 1 || !this.validReferenceCount(configuration, row.referenceIds.length) ||
      !this.validVideoReferences(configuration, row.referenceIds, row.referenceHashes) ||
      row.referenceHashes.length !== row.referenceIds.length || row.revision < 0) videoStorageUnavailable();
    hash.parse(row.semanticSha256); z.array(id).parse(row.referenceIds); z.array(hash).parse(row.referenceHashes);
    return { enterpriseId: row.enterpriseId, clientRequestId: row.clientRequestId, scope: row.scope,
      semanticSha256: row.semanticSha256, referenceIds: row.referenceIds, referenceHashes: row.referenceHashes,
      configuration, receipt, revision: row.revision, submissionDeadline: row.submissionDeadline, createdAt: row.createdAt };
  }

  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) {
      if (error instanceof HttpException) throw error;
      videoStorageUnavailable(error);
    }
  }
}
