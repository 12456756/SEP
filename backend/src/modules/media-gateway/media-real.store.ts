import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MediaRealQuote, MediaRealReceipt, MediaRealReference } from 'shared';
import { MediaConfigVersionV3Schema, MediaProfileIdV3Schema, MediaRealAnyQuoteSchema, MediaRealAnyReceiptSchema, MediaRealReferenceSchema } from 'shared';
import { z } from 'zod';
import { MAX_MEDIA_REFERENCE_COUNT } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';
import { ComputeMediaSnapshotSchema, type ComputeMediaSnapshot } from '../compute-integration/compute-media.service';

const asyncConfiguration = {
  asyncProtocol: z.literal('longdao-image-v2').optional(),
  dispatchState: z.enum(['NOT_DISPATCHED', 'DISPATCHING']).optional(),
  connectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  outputExpiresAt: z.string().datetime().optional(),
};
const legacyConfigurationSchema = z.object({
  ...asyncConfiguration,
  compute: ComputeMediaSnapshotSchema.optional(),
  profileId: z.string().min(1),
  configVersion: z.string().min(1),
  modelId: z.string().min(1).max(160).optional(),
  operation: z.enum(['generate', 'edit']),
  parameters: z.object({
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']),
    count: z.number().int().min(1).max(4),
    quality: z.enum(['low', 'medium', 'high']),
  }).strict(),
}).strict();
const configurationV3Schema = z.object({
  ...asyncConfiguration,
  compute: ComputeMediaSnapshotSchema.optional(),
  protocolVersion: z.literal(3), semanticHashVersion: z.literal(3), specRevision: z.number().int().positive(),
  profileId: MediaProfileIdV3Schema, configVersion: MediaConfigVersionV3Schema, modelId: z.string().min(1).max(160),
  operation: z.enum(['generate', 'edit']), requestedSpec: z.record(z.unknown()), effectiveSpec: z.object({
    size: z.string().min(1).max(128), count: z.number().int().min(1).max(4), quality: z.string().min(1).max(128),
  }).passthrough(), parameterSources: z.record(z.unknown()).optional(), connectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  adapterVersion: z.string().min(1).max(128),
}).strict();
const configurationSchema = z.union([configurationV3Schema, legacyConfigurationSchema]);

export type RealReferenceRecord = { scope: string; value: MediaRealReference };
export type RealQuoteRecord = { scope: string; value: MediaRealQuote; usdToCnyRate: number | null; connectionFingerprint?: string; compute?: ComputeMediaSnapshot };
export type RealRequestRecord = {
  id: string; enterpriseId: string; clientRequestId: string; quoteId: string; upstreamRequestId: string | null;
  scope: string; semanticSha256: string; referenceIds: string[]; referenceHashes: string[]; count: number;
  configuration: unknown; receipt: MediaRealReceipt; revision: number; submissionDeadline: Date;
};

export function realMediaStorageUnavailable(cause?: unknown): never {
  throw new HttpException({ error: { code: 'MEDIA_STORAGE_UNAVAILABLE', message: '媒体存储暂不可用，请查询原请求，不要重新生成',
    ...(cause !== undefined ? { cause: exceptionDetails(cause) } : {}) } }, 503);
}

@Injectable()
export class MediaRealStore {
  private readonly logger = new Logger(MediaRealStore.name);

  constructor(private readonly prisma: PrismaService) {}

  async saveReference(scope: string, value: Omit<MediaRealReference, 'referenceId'>) {
    return this.safe(async () => {
      MediaRealReferenceSchema.parse({ ...value, referenceId: 'pending' });
      const row = await this.prisma.mediaRealReference.create({ data: {
        scope, metadata: value, expiresAt: new Date(value.expiresAt),
      } });
      return MediaRealReferenceSchema.parse({ ...value, referenceId: row.id });
    });
  }

  async findReference(id: string): Promise<RealReferenceRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaRealReference.findUnique({ where: { id } });
      return row ? { scope: row.scope, value: MediaRealReferenceSchema.parse({
        ...(row.metadata as Prisma.JsonObject), referenceId: row.id,
      }) } : null;
    });
  }

  async saveQuote(scope: string, value: Omit<MediaRealQuote, 'quoteId'>, usdToCnyRate: number | null, connectionFingerprint?: string, compute?: ComputeMediaSnapshot) {
    return this.safe(async () => {
      MediaRealAnyQuoteSchema.parse({ ...value, quoteId: 'pending' });
      if (compute ? usdToCnyRate !== null : !Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0) realMediaStorageUnavailable();
      const row = await this.prisma.mediaRealQuote.create({ data: {
        scope, metadata: { quote: value, usdToCnyRate, ...(connectionFingerprint ? { connectionFingerprint } : {}), ...(compute ? { compute } : {}) }, expiresAt: new Date(value.expiresAt),
      } });
      return MediaRealAnyQuoteSchema.parse({ ...value, quoteId: row.id });
    });
  }

  async findQuote(id: string): Promise<RealQuoteRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaRealQuote.findUnique({ where: { id } });
      if (!row) return null;
      const metadata = row.metadata as Prisma.JsonObject;
      const compute = metadata.compute ? ComputeMediaSnapshotSchema.parse(metadata.compute) : undefined;
      if (compute ? metadata.usdToCnyRate !== null : typeof metadata.usdToCnyRate !== 'number' || !Number.isFinite(metadata.usdToCnyRate) || metadata.usdToCnyRate <= 0) realMediaStorageUnavailable();
      if (metadata.connectionFingerprint !== undefined && (typeof metadata.connectionFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.connectionFingerprint))) realMediaStorageUnavailable();
      return { scope: row.scope, usdToCnyRate: metadata.usdToCnyRate as number | null, compute,
        connectionFingerprint: metadata.connectionFingerprint as string | undefined, value: MediaRealAnyQuoteSchema.parse({
        ...(metadata.quote as Prisma.JsonObject), quoteId: row.id,
      }) };
    });
  }

  async findRequest(id: string): Promise<RealRequestRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaRealRequest.findUnique({ where: { id } });
      return row ? this.decode(row) : null;
    });
  }

  async findByClientId(enterpriseId: string, clientRequestId: string): Promise<RealRequestRecord | null> {
    return this.safe(async () => {
      const row = await this.prisma.mediaRealRequest.findUnique({
        where: { enterpriseId_clientRequestId: { enterpriseId, clientRequestId } },
      });
      return row ? this.decode(row) : null;
    });
  }

  async pendingRequests(limit: number, afterId?: string): Promise<{ records: RealRequestRecord[]; afterId?: string }> {
    return this.safe(async () => {
      const take = Math.max(1, Math.min(20, limit));
      const rows = await this.prisma.mediaRealRequest.findMany({
        where: { ...(afterId ? { id: { gt: afterId } } : {}), OR: [
          { receipt: { path: ['billingStatus'], equals: 'RESERVED' } },
          { receipt: { path: ['billingStatus'], equals: 'RECONCILING' } },
        ] },
        orderBy: { id: 'asc' }, take,
      });
      const records: RealRequestRecord[] = [];
      for (const row of rows) {
        try { records.push(this.decode(row)); }
        catch { this.logger.warn('MEDIA_PENDING_REQUEST_INVALID'); }
      }
      // Advance by raw rows even when decoding rejects an entire page.
      return { records, afterId: rows.length === take ? rows[rows.length - 1].id : undefined };
    });
  }

  async claim(input: Omit<RealRequestRecord, 'id' | 'revision'>): Promise<{ record: RealRequestRecord; created: boolean }> {
    return this.safe(async () => {
      MediaRealAnyReceiptSchema.parse(input.receipt);
      configurationSchema.parse(input.configuration);
      if (input.receipt.clientRequestId !== input.clientRequestId || input.receipt.status !== 'SUBMITTING'
        || input.receipt.profileId !== (input.configuration as z.infer<typeof configurationSchema>).profileId
        || input.receipt.configVersion !== (input.configuration as z.infer<typeof configurationSchema>).configVersion
        || input.referenceIds.length !== input.referenceHashes.length || input.referenceIds.length > MAX_MEDIA_REFERENCE_COUNT
        || input.referenceHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) realMediaStorageUnavailable();
      try {
        const row = await this.prisma.mediaRealRequest.create({ data: {
          ...input, configuration: input.configuration as Prisma.InputJsonValue,
          receipt: this.receiptWithoutId(input.receipt), status: input.receipt.status,
        } });
        return { record: this.decode(row), created: true };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const record = await this.findByClientId(input.enterpriseId, input.clientRequestId);
        if (!record) realMediaStorageUnavailable();
        return { record, created: false };
      }
    });
  }

  async save(record: RealRequestRecord, upstreamRequestId = record.upstreamRequestId): Promise<RealRequestRecord> {
    return (await this.saveGuarded(record, upstreamRequestId)).record;
  }

  async saveGuarded(record: RealRequestRecord, upstreamRequestId = record.upstreamRequestId): Promise<{ updated: boolean; record: RealRequestRecord }> {
    return this.safe(async () => {
      MediaRealAnyReceiptSchema.parse(record.receipt);
      configurationSchema.parse(record.configuration);
      if (record.receipt.receiptId !== record.id || record.receipt.clientRequestId !== record.clientRequestId
        || record.receipt.profileId !== (record.configuration as z.infer<typeof configurationSchema>).profileId
        || record.receipt.configVersion !== (record.configuration as z.infer<typeof configurationSchema>).configVersion
        || record.referenceIds.length !== record.referenceHashes.length) realMediaStorageUnavailable();
      const { receiptId: _id, ...receipt } = record.receipt;
      const result = await this.prisma.mediaRealRequest.updateMany({
        where: { id: record.id, revision: record.revision },
        data: { receipt, status: receipt.status, configuration: record.configuration as Prisma.InputJsonValue, upstreamRequestId, revision: { increment: 1 } },
      });
      const current = await this.findRequest(record.id);
      if (!current) realMediaStorageUnavailable();
      return { updated: result.count === 1, record: current };
    });
  }

  private decode(row: any): RealRequestRecord {
    const configuration = configurationSchema.parse(row.configuration);
    const receipt = MediaRealAnyReceiptSchema.parse({ ...(row.receipt as Prisma.JsonObject), receiptId: row.id, status: row.status });
    if (receipt.clientRequestId !== row.clientRequestId || receipt.profileId !== configuration.profileId ||
      receipt.configVersion !== configuration.configVersion || row.referenceIds.length !== row.referenceHashes.length ||
      ('parameters' in configuration ? configuration.parameters.count : (configuration as z.infer<typeof configurationV3Schema>).effectiveSpec.count) !== row.count || row.referenceIds.length > MAX_MEDIA_REFERENCE_COUNT ||
      row.referenceHashes.some((hash: unknown) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
      realMediaStorageUnavailable();
    }
    return { id: row.id, enterpriseId: row.enterpriseId, clientRequestId: row.clientRequestId, quoteId: row.quoteId,
      upstreamRequestId: row.upstreamRequestId, scope: row.scope, semanticSha256: row.semanticSha256,
      referenceIds: row.referenceIds, referenceHashes: row.referenceHashes, count: row.count,
      configuration: row.configuration, receipt, revision: row.revision, submissionDeadline: row.submissionDeadline };
  }

  private receiptWithoutId(receipt: MediaRealReceipt) {
    const { receiptId: _id, ...value } = receipt;
    return value as unknown as Prisma.InputJsonValue;
  }

  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      realMediaStorageUnavailable(error);
    }
  }
}
