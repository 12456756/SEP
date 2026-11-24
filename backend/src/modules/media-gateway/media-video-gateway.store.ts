import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MediaGatewayRequest as RequestRow } from '@prisma/client';
import { z } from 'zod';
import { MediaVideoGatewayQuoteSchema, MediaVideoGatewayReceiptSchema, MediaVideoGatewayReferenceSchema, MediaVideoParametersSchema } from 'shared';
import type { MediaVideoGatewayQuote, MediaVideoGatewayReceipt, MediaVideoGatewayReference } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';

export const VIDEO_ADAPTER = 'static-video-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ConfigurationSchema = z.object({
  adapter: z.literal(VIDEO_ADAPTER), profileId: id,
  configVersion: id, operation: z.literal('image-to-video'),
  parameters: MediaVideoParametersSchema.refine(value => value.durationSeconds === 5 && value.aspectRatio === '9:16' &&
    value.resolution === '720p' && value.frameRate === 24 && !value.audio && value.outputFormat === 'video/mp4'),
  pricingVersion: z.literal('mock-video-v1'), amountCny: z.literal('0.000000'),
}).strict();
const ReferenceMetadataSchema = z.object({
  adapter: z.literal(VIDEO_ADAPTER), value: MediaVideoGatewayReferenceSchema.omit({ referenceId: true }),
}).strict();
const QuoteMetadataSchema = z.object({
  adapter: z.literal(VIDEO_ADAPTER), value: MediaVideoGatewayQuoteSchema.omit({ quoteId: true }),
  configuration: ConfigurationSchema, referenceIds: z.array(id).length(1), referenceHashes: z.array(hash).length(1),
}).strict();
export type VideoConfiguration = z.infer<typeof ConfigurationSchema>;
export type VideoQuoteMetadata = z.infer<typeof QuoteMetadataSchema>;
export type VideoRequestRecord = {
  enterpriseId: string; clientRequestId: string; scope: string; semanticSha256: string;
  referenceIds: string[]; referenceHashes: string[]; count: number; configuration: VideoConfiguration;
  receipt: MediaVideoGatewayReceipt; revision: number; submissionDeadline: Date;
};
export type VideoRequestClaim = Omit<VideoRequestRecord, 'revision' | 'receipt'> & {
  receipt: Omit<MediaVideoGatewayReceipt, 'receiptId'>;
};

export type VideoErrorDetails = {
  cause?: unknown;
  field?: string;
  stage?: 'video-authorization' | 'video-upload' | 'video-quote' | 'video-submit' | 'video-query' | 'video-content';
  recovery?: string;
  submissionState?: 'not_submitted';
  billingState?: 'not_reserved';
};
export function videoGatewayError(status: number, code: string, message: string, details: VideoErrorDetails = {}): never {
  throw new HttpException({ message, error: {
    code, message, type: status >= 500 ? 'server_error' : 'invalid_request_error', source: 'platform', param: null, ...details,
  } }, status);
}
export function videoStorageUnavailable(cause?: unknown): never {
  const message = '视频存储暂不可用，请查询原请求，不要重新生成';
  throw new HttpException({ message, error: {
    code: 'MEDIA_STORAGE_UNAVAILABLE', message, type: 'server_error', source: 'platform', param: null,
  } }, 503, { cause });
}
function isVideo(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'adapter' in value && value.adapter === VIDEO_ADAPTER;
}

/** Metadata only. The shared enterprise unique key is also reserved by image requests. */
@Injectable()
export class MediaVideoGatewayStore {
  constructor(private readonly prisma: PrismaService) {}

  async saveReference(scope: string, value: Omit<MediaVideoGatewayReference, 'referenceId'>): Promise<MediaVideoGatewayReference> {
    return this.safe(async () => {
      const metadata = ReferenceMetadataSchema.parse({ adapter: VIDEO_ADAPTER, value });
      const row = await this.prisma.mediaGatewayReference.create({ data: { scope, metadata, expiresAt: new Date(value.expiresAt) } });
      return MediaVideoGatewayReferenceSchema.parse({ ...value, referenceId: row.id });
    });
  }

  async findReference(scope: string, referenceId: string): Promise<MediaVideoGatewayReference | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayReference.findUnique({ where: { id: referenceId } });
      if (!row || row.scope !== scope || !isVideo(row.metadata)) return null;
      const { value } = ReferenceMetadataSchema.parse(row.metadata);
      if (row.expiresAt.getTime() !== Date.parse(value.expiresAt)) videoStorageUnavailable();
      return MediaVideoGatewayReferenceSchema.parse({ ...value, referenceId: row.id });
    });
  }

  async saveQuote(scope: string, input: VideoQuoteMetadata): Promise<MediaVideoGatewayQuote> {
    return this.safe(async () => {
      const metadata = QuoteMetadataSchema.parse(input);
      const row = await this.prisma.mediaGatewayQuote.create({ data: { scope, metadata, expiresAt: new Date(metadata.value.expiresAt) } });
      return MediaVideoGatewayQuoteSchema.parse({ ...metadata.value, quoteId: row.id });
    });
  }

  async findQuote(scope: string, quoteId: string): Promise<VideoQuoteMetadata | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayQuote.findUnique({ where: { id: quoteId } });
      if (!row || row.scope !== scope || !isVideo(row.metadata)) return null;
      const metadata = QuoteMetadataSchema.parse(row.metadata);
      if (row.expiresAt.getTime() !== Date.parse(metadata.value.expiresAt)) videoStorageUnavailable();
      return metadata;
    });
  }

  async findRequest(scope: string, receiptId: string): Promise<VideoRequestRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayRequest.findUnique({ where: { id: receiptId } });
      return row && row.scope === scope && isVideo(row.configuration) ? this.decode(row) : null;
    });
  }

  async findByClientId(enterpriseId: string, clientRequestId: string, scope: string, forReplay = false): Promise<VideoRequestRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaGatewayRequest.findUnique({ where: { enterpriseId_clientRequestId: { enterpriseId, clientRequestId } } });
      if (!row) return null;
      if (row.scope !== scope) {
        if (forReplay) videoGatewayError(404, 'MEDIA_NOT_FOUND', '当前作用域内不存在视频回执');
        return null;
      }
      if (!isVideo(row.configuration)) {
        if (forReplay) videoGatewayError(409, 'IDEMPOTENCY_CONFLICT', 'clientRequestId 已由其他媒体请求占用');
        return null;
      }
      return this.decode(row);
    });
  }

  async claim(input: VideoRequestClaim): Promise<VideoRequestRecord> {
    return this.safe(async () => {
      const configuration = ConfigurationSchema.parse(input.configuration);
      const { receiptId: _receiptId, ...receipt } = MediaVideoGatewayReceiptSchema.parse({ ...input.receipt, receiptId: 'pending' });
      hash.parse(input.semanticSha256);
      z.array(id).length(1).parse(input.referenceIds);
      z.array(hash).length(1).parse(input.referenceHashes);
      // Insert QUEUED atomically: the static mock has no external dispatch or second submission step.
      try {
        const row = await this.prisma.mediaGatewayRequest.create({ data: {
          enterpriseId: input.enterpriseId, clientRequestId: input.clientRequestId, scope: input.scope,
          semanticSha256: input.semanticSha256, referenceIds: input.referenceIds, referenceHashes: input.referenceHashes,
          count: input.count, submissionDeadline: input.submissionDeadline, configuration, receipt, status: receipt.status,
        } });
        return this.decode(row);
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const existing = await this.findByClientId(input.enterpriseId, input.clientRequestId, input.scope, true);
        if (!existing) videoStorageUnavailable();
        return existing;
      }
    });
  }

  async advance(record: VideoRequestRecord, next: MediaVideoGatewayReceipt): Promise<VideoRequestRecord> {
    return this.safe(async () => {
      const { receiptId, ...receipt } = MediaVideoGatewayReceiptSchema.parse(next);
      if (receiptId !== record.receipt.receiptId) videoStorageUnavailable();
      await this.prisma.mediaGatewayRequest.updateMany({
        where: { id: receiptId, scope: record.scope, enterpriseId: record.enterpriseId,
          revision: record.revision, status: record.receipt.status,
          configuration: { path: ['adapter'], equals: VIDEO_ADAPTER } },
        data: { receipt, status: receipt.status, revision: { increment: 1 } },
      });
      // A CAS loser reads the winning receipt, never retries advancing another state.
      const current = await this.findRequest(record.scope, receiptId);
      if (!current) videoStorageUnavailable();
      return current;
    });
  }

  private decode(row: RequestRow): VideoRequestRecord {
    const configuration = ConfigurationSchema.parse(row.configuration);
    const receipt = MediaVideoGatewayReceiptSchema.parse({ ...(row.receipt as Prisma.JsonObject), receiptId: row.id, status: row.status });
    if (receipt.clientRequestId !== row.clientRequestId || receipt.profileId !== configuration.profileId ||
        receipt.configVersion !== configuration.configVersion || receipt.operation !== configuration.operation ||
        row.count !== 1 || row.referenceIds.length !== 1 || row.referenceHashes.length !== 1 || row.revision < 0 ||
        (row.receipt as Prisma.JsonObject).status !== row.status) videoStorageUnavailable();
    hash.parse(row.semanticSha256);
    z.array(id).parse(row.referenceIds);
    z.array(hash).parse(row.referenceHashes);
    return { enterpriseId: row.enterpriseId, clientRequestId: row.clientRequestId, scope: row.scope, semanticSha256: row.semanticSha256,
      referenceIds: row.referenceIds, referenceHashes: row.referenceHashes, count: row.count, configuration, receipt,
      revision: row.revision, submissionDeadline: row.submissionDeadline };
  }

  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      videoStorageUnavailable(error);
    }
  }
}
