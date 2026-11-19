import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, KnowledgeProcessingJob } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentParserService } from './document-parser.service';
import { EmbeddingService } from './embedding.service';
import { VectorService } from './vector.service';
import { TextTokenizer } from './text-tokenizer.service';
import { TextChunker } from './text-chunker.util';
import { KnowledgePrivateStorage } from './knowledge-private-storage';
import { knowledgeHistoryRetentionDays } from './knowledge-retention.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
class LostLease extends Error {}
class ProcessingFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); }
}
type ClaimedJob = KnowledgeProcessingJob;

@Injectable()
export class DocumentProcessorService {
  private readonly logger = new Logger(DocumentProcessorService.name);
  private readonly storage = new KnowledgePrivateStorage();
  constructor(private prisma: PrismaService, private parser: DocumentParserService,
    private embedding: EmbeddingService, private vector: VectorService, private tokenizer: TextTokenizer,
    @Optional() private readonly config?: ConfigService) {}

  /** Only durable version jobs may process originals; never rebuild a live document in place. */
  async processDocument(_documentId: string) {
    throw new ConflictException({ code: 'VERSION_JOB_REQUIRED', message: '请通过文档版本作业处理' });
  }
  async reprocessDocument(_documentId: string) {
    throw new ConflictException({ code: 'VERSION_JOB_REQUIRED', message: '请通过版本重试接口处理' });
  }

  async processJob(jobId: string) {
    const job = await this.claim(jobId);
    if (!job) return;
    let heartbeat: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(() => this.prisma.knowledgeProcessingJob.updateMany({
        where: { id: job.id, fence: job.fence, status: 'RUNNING', leaseUntil: { gt: new Date() } },
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
      })).catch(() => undefined);
    }, LEASE_MS / 4);
    timer.unref();
    try {
      if (job.kind === 'CLEANUP') { await this.cleanup(job); return; }
      const version = await this.prisma.documentVersion.findUniqueOrThrow({ where: { id: job.versionId! } });
      const document = await this.prisma.document.findUniqueOrThrow({ where: { id: job.documentId }, include: { knowledgeBase: true } });
      let parsed: Awaited<ReturnType<DocumentParserService['parseDocument']>>;
      try { parsed = await this.parser.parseDocument(version.storagePath, version.mimeType); }
      catch { throw new ProcessingFailure('INVALID_DOCUMENT', '文件无法解析，请检查文件或上传新版本', false); }
      if (!parsed.text.trim()) throw new ProcessingFailure('EMPTY_DOCUMENT', '文件中没有可提取的文字，请上传包含文字的文件', false);
      const blocks = parsed.blocks;
      await this.guarded(job, async tx => {
        await tx.documentVersion.update({ where: { id: version.id }, data: { stage: 'CHUNKING' } });
      });
      let chunks: Array<{ content: string; tokenCount: number; pageStart: number | null; pageEnd: number | null;
        sectionPath: string[]; blockStart: number; blockEnd: number }>;
      try {
        chunks = blocks.flatMap(block => TextChunker.chunkByTokens(this.parser.cleanText(block.text), 800).map(chunk => ({
          ...chunk,
          pageStart: block.page ?? null,
          pageEnd: block.page ?? null,
          sectionPath: block.section ? [block.section] : [],
          blockStart: block.ordinal,
          blockEnd: block.ordinal,
        })));
      }
      catch { throw new ProcessingFailure('TOKENIZER_UNAVAILABLE', '分词器未就绪，请联系管理员配置后重试', true); }
      if (!chunks.length || chunks.length > 20000) throw new ProcessingFailure('DOCUMENT_LIMIT', '文件内容为空或超出处理限制，请拆分文件', false);
      const profile = this.embedding.getProfile();
      if (profile.dimension !== 1024) throw new ProcessingFailure('EMBEDDING_PROFILE_MISMATCH', '向量模型配置不兼容，请联系管理员', false);
      await this.guarded(job, async tx => {
        await tx.documentVersion.update({ where: { id: version.id }, data: { stage: 'EMBEDDING',
          totalChunks: chunks.length, processedChunks: 0, profile: { ...profile } } });
        // A recovered attempt may produce fewer blocks; replace its unpublished snapshot atomically.
        await tx.knowledgeParsedBlock.deleteMany({ where: { versionId: version.id } });
        await tx.knowledgeParsedBlock.createMany({ data: blocks.map(block => ({ versionId: version.id,
          ordinal: block.ordinal, text: block.text, page: block.page ?? null, section: block.section ?? null })) });
        await tx.textChunk.deleteMany({ where: { versionId: version.id, indexGeneration: job.generation } });
      });
      const batchSize = this.embedding.getBatchSize();
      for (let offset = 0; offset < chunks.length; offset += batchSize) {
        const batch = chunks.slice(offset, offset + batchSize);
        let vectors: Awaited<ReturnType<EmbeddingService['embedBatch']>>;
        try { vectors = await this.embedding.embedBatch(batch.map(chunk => chunk.content)); }
        catch (error) { throw new ProcessingFailure('EMBEDDING_UNAVAILABLE', JSON.stringify(exceptionDetails(error)), true); }
        if (vectors.length !== batch.length || JSON.stringify(profile) !== JSON.stringify(this.embedding.getProfile())) {
          throw new ProcessingFailure('EMBEDDING_PROFILE_MISMATCH', '向量结果或模型配置不兼容，请联系管理员', false);
        }
        await this.guarded(job, async tx => {
          for (let index = 0; index < batch.length; index++) {
            const vector = vectors[index].embedding;
            if (vector.length !== profile.dimension || Array.from(vector).some(value => !Number.isFinite(value))) {
              throw new ProcessingFailure('INVALID_EMBEDDING', '向量结果无效，请联系管理员', false);
            }
            const chunk = await tx.textChunk.create({ data: { documentId: document.id, knowledgeBaseId: document.knowledgeBaseId,
              versionId: version.id, indexGeneration: job.generation, ordinal: offset + index,
              tokenCount: batch[index].tokenCount, content: batch[index].content, source: document.originalName,
              pageStart: batch[index].pageStart, pageEnd: batch[index].pageEnd,
              sectionPath: batch[index].sectionPath, blockStart: batch[index].blockStart, blockEnd: batch[index].blockEnd,
              tags: [], createdBy: document.uploadedBy, embedding: new Uint8Array(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)),
              embeddingModel: profile.model, tokens: this.tokenizer.tokenize(batch[index].content) } });
            const literal = `[${Array.from(vector).join(',')}]`;
            await tx.$executeRaw`UPDATE text_chunks SET "embeddingVector"=${literal}::vector WHERE id=${chunk.id}`;
          }
          await tx.documentVersion.update({ where: { id: version.id }, data: { processedChunks: offset + batch.length } });
        });
      }
      await this.guarded(job, async tx => {
        await tx.documentVersion.update({ where: { id: version.id }, data: { stage: 'PUBLISHING' } });
      });
      await this.guarded(job, async tx => {
        const current = await tx.documentVersion.findUniqueOrThrow({ where: { id: version.id } });
        const count = await tx.textChunk.count({ where: { versionId: version.id, indexGeneration: job.generation,
          embeddingModel: profile.model, embedding: { not: null } } });
        const [native] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM text_chunks
          WHERE "versionId"=${version.id} AND "indexGeneration"=${job.generation} AND "embeddingVector" IS NOT NULL`;
        if (count !== chunks.length || Number(native.count) !== chunks.length || current.processedChunks !== count ||
          !this.sameProfile(current.profile, profile)) {
          throw new ProcessingFailure('INCOMPLETE_INDEX', '索引尚未完整建立，请重试', true);
        }
        await this.retirePublishedVersions(tx, document.id, version.id);
        await tx.documentVersion.update({ where: { id: version.id }, data: { status: 'READY', stage: 'DONE',
          published: true, publishedAt: new Date(), retiredAt: null, processedAt: new Date(), errorCode: null, lastError: null } });
        await tx.document.update({ where: { id: document.id }, data: { activeVersionId: version.id, status: 'READY',
          version: version.version, processedAt: new Date(), embeddingModel: profile.model, revision: { increment: 1 } } });
        await tx.knowledgeProcessingJob.update({ where: { id: job.id }, data: { status: 'DONE', leaseUntil: null } });
      });
      this.vector.invalidateCache(document.knowledgeBase.enterpriseId, document.knowledgeBaseId);
    } catch (error) {
      if (!(error instanceof LostLease)) await this.fail(job, error);
    } finally { clearInterval(timer); await heartbeat; }
  }

  private sameProfile(stored: Prisma.JsonValue, current: ReturnType<EmbeddingService['getProfile']>) {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
    return Object.entries(current).every(([key, value]) => stored[key] === value);
  }

  private async retirePublishedVersions(tx: Prisma.TransactionClient, documentId: string, nextVersionId: string) {
    const now = new Date();
    const where = { documentId, id: { not: nextVersionId }, published: true };
    // Legacy adoption predates publishedAt; preserve its historical-source eligibility on first retirement.
    await tx.documentVersion.updateMany({ where: { ...where, publishedAt: null }, data: { publishedAt: now } });
    await tx.documentVersion.updateMany({ where, data: { published: false,
      retiredAt: new Date(now.getTime() + knowledgeHistoryRetentionDays(this.config) * 24 * 60 * 60 * 1000) } });
  }

  private async claim(id: string): Promise<ClaimedJob | null> {
    const candidate = await this.prisma.knowledgeProcessingJob.findUnique({ where: { id } });
    if (!candidate) return null;
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM documents WHERE id=${candidate.documentId} FOR UPDATE`;
      const now = new Date();
      const changed = await tx.knowledgeProcessingJob.updateMany({ where: { id, attempts: { lt: MAX_ATTEMPTS },
        OR: [{ status: 'PENDING', nextRunAt: { lte: now } }, { status: 'RUNNING', leaseUntil: { lte: now } }] },
        data: { status: 'RUNNING', attempts: { increment: 1 }, fence: { increment: 1 }, leaseUntil: new Date(Date.now() + LEASE_MS) } });
      if (!changed.count) return null;
      const job = await tx.knowledgeProcessingJob.findUniqueOrThrow({ where: { id } });
      const d = await tx.document.findUniqueOrThrow({ where: { id: job.documentId }, include: { knowledgeBase: true } });
      const version = job.versionId ? await tx.documentVersion.findUnique({ where: { id: job.versionId } }) : null;
      if (job.kind !== 'CLEANUP' && (d.deletedAt || d.knowledgeBase.deletedAt || d.latestVersionId !== job.versionId ||
        version?.generation !== job.generation || version?.published)) {
        await tx.knowledgeProcessingJob.update({ where: { id }, data: { status: 'CANCELLED', leaseUntil: null } });
        return null;
      }
      if (version) await tx.documentVersion.update({ where: { id: version.id }, data: { status: 'PROCESSING', stage: 'PARSING',
        attempts: job.attempts, errorCode: null, lastError: null } });
      return job;
    });
  }

  private async guarded<T>(job: ClaimedJob, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM documents WHERE id=${job.documentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM knowledge_processing_jobs WHERE id=${job.id} FOR UPDATE`;
      const live = await tx.knowledgeProcessingJob.findUniqueOrThrow({ where: { id: job.id } });
      const d = await tx.document.findUniqueOrThrow({ where: { id: job.documentId }, include: { knowledgeBase: true } });
      if (live.fence !== job.fence || live.status !== 'RUNNING' || !live.leaseUntil || live.leaseUntil <= new Date()) throw new LostLease();
      if (job.kind !== 'CLEANUP') {
        const v = await tx.documentVersion.findUnique({ where: { id: job.versionId! } });
        if (d.deletedAt || d.knowledgeBase.deletedAt || d.latestVersionId !== job.versionId || v?.generation !== job.generation) throw new LostLease();
      } else if (!d.deletedAt) throw new LostLease();
      return operation(tx);
    }, { timeout: 30_000 });
  }

  private async cleanup(job: ClaimedJob) {
    await this.guarded(job, async tx => {
      const d = await tx.document.findUnique({ where: { id: job.documentId }, include: { versions: true } });
      if (!d?.deletedAt) throw new LostLease();
      for (const file of new Set([d.storagePath, ...d.versions.map(v => v.storagePath)].filter(Boolean))) {
        const original = await tx.document.findFirst({ where: { storagePath: file, id: { not: d.id } }, select: { id: true } });
        const shared = await tx.documentVersion.findFirst({ where: { storagePath: file, documentId: { not: d.id } }, select: { id: true } });
        if (!original && !shared) await this.storage.remove(file);
      }
      await tx.textChunk.deleteMany({ where: { documentId: d.id } });
      await tx.knowledgeParsedBlock.deleteMany({ where: { version: { documentId: d.id } } });
      await tx.documentVersion.updateMany({ where: { documentId: d.id }, data: { storagePath: '' } });
      await tx.document.update({ where: { id: d.id }, data: { storagePath: '' } });
      await tx.knowledgeProcessingJob.update({ where: { id: job.id }, data: { status: 'DONE', leaseUntil: null } });
    });
  }

  private async fail(job: ClaimedJob, error: unknown) {
    const failure = error instanceof ProcessingFailure ? error : new ProcessingFailure('PROCESSING_UNAVAILABLE', JSON.stringify(exceptionDetails(error)), true);
    try {
      await this.guarded(job, async tx => {
        const retry = failure.retryable && job.attempts < MAX_ATTEMPTS;
        await tx.knowledgeProcessingJob.update({ where: { id: job.id }, data: { status: retry ? 'PENDING' : 'FAILED',
          errorCode: failure.code, leaseUntil: null, nextRunAt: new Date(Date.now() + 2000 * 2 ** job.attempts) } });
        if (job.versionId) await tx.documentVersion.update({ where: { id: job.versionId }, data: {
          status: retry ? 'PENDING' : 'FAILED', stage: retry ? 'RETRY_WAIT' : 'FAILED',
          lastError: failure.message, errorCode: failure.code, retryable: failure.retryable } });
      });
    } catch (secondary) { if (!(secondary instanceof LostLease)) this.logger.error('Unable to persist knowledge job failure; lease recovery will retry'); }
  }
}
