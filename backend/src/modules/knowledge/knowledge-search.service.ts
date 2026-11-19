import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { VectorService } from './vector.service';
import { LexicalSearchService } from './lexical-search.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { KnowledgeAccessPolicy } from './knowledge-access-policy';
import { KNOWLEDGE_LIMITS, type KnowledgeMemberSearchDto, type KnowledgeSearchResponse,
  type KnowledgeSearchResult, type KnowledgeSourceResponse } from 'shared';
import { isPublishedChunk, isVectorCompatibleChunk, publicationSelect, publishedChunkWhere, vectorChunkWhere } from './knowledge-publication';
import type { EmbeddingProfile } from './embedding.service';
import { TextChunker } from './text-chunker.util';
import { exceptionDetails, localError } from '../../common/errors/error-diagnostics';

export interface SearchResult {
  content: string;
  source: string;
  score: number;
  knowledgeBaseId: string;
  chunkId: string;
  documentId?: string;
  documentName?: string;
  documentVersionId?: string;
  knowledgeBaseName?: string;
  tokenCount?: number;
  location?: {
    pageStart: number | null;
    pageEnd: number | null;
    sectionPath: string[];
    blockStart: number;
    blockEnd: number;
  };
}

export interface SearchResponse {
  count: number;
  results: SearchResult[];
  strategy: 'lexical' | 'vector' | 'hybrid';
  durationMs?: number;
}

type Readiness = { hasReady: boolean; partial: boolean };
class QueryEmbeddingUnavailable extends Error {
  constructor(readonly cause: unknown) { super('Query embedding unavailable'); }
}

type SearchStrategy = 'lexical' | 'vector' | 'hybrid' | 'auto';
type SearchCandidate = SearchResult & { vectorProfile?: EmbeddingProfile; lexicalScore?: number };

@Injectable()
export class KnowledgeSearchService {
  private readonly logger = new Logger(KnowledgeSearchService.name);

  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private vector: VectorService,
    private lexical: LexicalSearchService,
    private enterpriseContext: EnterpriseContextService,
    private policy: KnowledgeAccessPolicy,
  ) {}

  /**
   * 检索知识库内容（Phase 2 重构）
   */
  async search(
    query: string,
    userId: string,
    subscriptionId: string,
    topK: number = 5,
    scoreThreshold: number = 0.7,
    strategy: SearchStrategy = 'auto',
  ): Promise<SearchResponse> {
    const startTime = Date.now();
    this.logger.log(`Knowledge search started (strategy: ${strategy})`);

    // 1. 安全边界：获取授权 + 企业隔离
    const context = await this.policy.resolve(userId);
    const now = new Date();
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        enterpriseId: context.enterpriseId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: now } }],
        grants: {
          some: {
            OR: [
              ...(context.memberId ? [{ memberId: context.memberId }] : []),
              ...(context.departmentId ? [{ departmentId: context.departmentId }] : []),
            ],
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
          },
        },
      },
    });

    if (!subscription) {
      throw new ForbiddenException('无权检索该雇佣关系的知识库');
    }

    const enterpriseId = subscription.enterpriseId;

    // 2. 获取授权的知识库（企业前置过滤）
    const grants = await this.prisma.knowledgeGrant.findMany({
      where: {
        knowledgeBase: this.policy.readableWhere(context),
        OR: [
          {
            subscriptionId,
            OR: [
              { departmentId: null },
              ...(context.departmentId ? [{ departmentId: context.departmentId }] : []),
            ],
          },
          ...(context.departmentId
            ? [{ subscriptionId: null, departmentId: context.departmentId }]
            : []),
        ],
      },
      select: { knowledgeBaseId: true },
    });

    if (grants.length === 0) {
      this.logger.warn(`No knowledge bases granted to subscription ${subscriptionId}`);
      return { count: 0, results: [], strategy: 'lexical', durationMs: Date.now() - startTime };
    }

    const kbIds = grants.map((g) => g.knowledgeBaseId);

    // 3. 策略选择
    const actualStrategy = await this.resolveStrategy(strategy);

    // 4. 执行检索
    let results: SearchCandidate[];

    switch (actualStrategy) {
      case 'lexical':
        results = await this.searchLexical(query, enterpriseId, kbIds, topK);
        break;
      case 'vector':
        results = await this.searchVector(query, enterpriseId, kbIds, topK, scoreThreshold);
        break;
      case 'hybrid':
        results = await this.searchHybrid(query, enterpriseId, kbIds, topK, scoreThreshold);
        break;
    }

    const durationMs = Date.now() - startTime;
    this.logger.log(`Search completed in ${durationMs}ms (${results.length} results, strategy: ${actualStrategy})`);

    const resultKnowledgeBases = [...new Set(results.map((result) => result.knowledgeBaseId))];
    await Promise.all(
      (resultKnowledgeBases.length > 0 ? resultKnowledgeBases : kbIds).map((knowledgeBaseId) =>
        this.prisma.knowledgeSearchLog.create({
          data: {
            knowledgeBaseId,
            enterpriseId,
            query: '[REDACTED]',
            topK,
            hitCount: results.filter((result) => result.knowledgeBaseId === knowledgeBaseId).length,
            topScore: results.find((result) => result.knowledgeBaseId === knowledgeBaseId)?.score ?? null,
            strategy: actualStrategy,
            isTest: false,
            durationMs,
          },
        }).catch(() => {
          this.logger.warn('Failed to record knowledge search log');
        }),
      ),
    );

    results = await this.authorizedResults(userId, kbIds, results);
    return { count: results.length, results, strategy: actualStrategy, durationMs };
  }

  /** Search over explicit member access and return the client contract. */
  async searchForMember(userId: string, dto: KnowledgeMemberSearchDto): Promise<KnowledgeSearchResponse> {
    const started = Date.now();
    try {
    const viewer = await this.policy.resolve(userId);
    const bases = await this.prisma.knowledgeBase.findMany({ where: {
      ...this.policy.readableWhere(viewer), ...(dto.knowledgeBaseIds ? { id: { in: dto.knowledgeBaseIds } } : {}),
    }, select: { id: true, name: true } });
    if (dto.knowledgeBaseIds && bases.length !== dto.knowledgeBaseIds.length) this.policy.notFound();
    const kbIds = bases.map(base => base.id);
    const empty = (status: 'NO_ACCESS' | 'NOT_READY', partial = false): KnowledgeSearchResponse => ({
      searchId: `search_${randomUUID()}`,
      status, actualStrategy: null, degraded: false, degradationReason: null,
      durationMs: Date.now() - started, count: 0, partial, results: [],
    });
    if (!kbIds.length) return empty(dto.knowledgeBaseIds ? 'NOT_READY' : 'NO_ACCESS');

    const readiness = await this.getReadiness(kbIds);
    if (!readiness.hasReady) return empty('NOT_READY');

    let actualStrategy: 'HYBRID' | 'LEXICAL' = 'HYBRID';
    let degraded = false;
    let degradationReason: 'QUERY_EMBEDDING_UNAVAILABLE' | null = null;
    let diagnostic: ReturnType<typeof exceptionDetails> | undefined;
      if (!(await this.embedding.isAvailable(error => { diagnostic = exceptionDetails(error); }))) {
        actualStrategy = 'LEXICAL';
        degraded = true;
        degradationReason = 'QUERY_EMBEDDING_UNAVAILABLE';
        diagnostic ??= { message: 'Embedding availability check failed without an error reason' };
      }
      let candidates: SearchCandidate[];
      try {
        candidates = actualStrategy === 'HYBRID'
          ? await this.searchHybrid(dto.query, viewer.enterpriseId, kbIds, dto.topK, 0.7, false)
          : await this.searchLexical(dto.query, viewer.enterpriseId, kbIds, dto.topK);
      } catch (error) {
        if (!(error instanceof QueryEmbeddingUnavailable)) throw error;
        diagnostic = exceptionDetails(error.cause);
        actualStrategy = 'LEXICAL';
        degraded = true;
        degradationReason = 'QUERY_EMBEDDING_UNAVAILABLE';
        candidates = await this.searchLexical(dto.query, viewer.enterpriseId, kbIds, dto.topK);
      }
      const authorized = await this.authorizedResults(userId, kbIds, candidates);
      const results = this.applyTokenBudget(authorized);
      return {
        searchId: `search_${randomUUID()}`,
        status: results.length ? 'MATCHED' : 'NO_MATCH',
        actualStrategy, degraded, degradationReason,
        ...(diagnostic !== undefined ? { diagnostic } : {}),
        durationMs: Date.now() - started, count: results.length,
        partial: readiness.partial, results,
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
      this.logger.error('Member knowledge retrieval failed');
      throw localError(error, 503, { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE' });
    }
  }

  private async getReadiness(knowledgeBaseIds: string[]): Promise<Readiness> {
    const documents = await this.prisma.document.findMany({
      where: { knowledgeBaseId: { in: knowledgeBaseIds }, deletedAt: null },
      select: { activeVersionId: true, status: true, versions: {
        where: { published: true, status: 'READY' }, select: { id: true },
      } },
    });
    const ready = documents.filter(document => document.activeVersionId
      ? document.versions.some(version => version.id === document.activeVersionId)
      : document.status === 'READY');
    return { hasReady: ready.length > 0, partial: ready.length > 0 && ready.length < documents.length };
  }

  private async authorizedResults(userId: string, knowledgeBaseIds: string[], results: SearchCandidate[]): Promise<SearchResult[]> {
    if (!results.length) return [];
    return this.policy.readBoundary(userId, knowledgeBaseIds, results.map(result => result.chunkId), async (tx, viewer) => {
    const chunks = await tx.textChunk.findMany({ where: {
      id: { in: results.map(result => result.chunkId) }, knowledgeBaseId: { in: knowledgeBaseIds },
      ...publishedChunkWhere(this.policy.readableWhere(viewer)),
    }, select: { id: true, content: true, source: true, knowledgeBaseId: true,
      ...publicationSelect } });
    const allowed = new Map(chunks.filter(isPublishedChunk).map(chunk => [chunk.id, chunk]));
    return results.flatMap(result => {
      const chunk = allowed.get(result.chunkId);
      if (!chunk?.document) return [];
      const { vectorProfile, lexicalScore, ...publicResult } = result;
      const compatible = !vectorProfile || isVectorCompatibleChunk(chunk, vectorProfile);
      if (!compatible && lexicalScore === undefined) return [];
      return [{ ...publicResult, score: compatible ? result.score : lexicalScore!, content: chunk.content, source: chunk.source,
        knowledgeBaseId: chunk.knowledgeBaseId, documentId: chunk.document.id,
        documentName: chunk.document.originalName,
        documentVersionId: chunk.versionId ?? chunk.document.activeVersionId ?? chunk.id,
        knowledgeBaseName: chunk.knowledgeBase?.name ?? '', tokenCount: chunk.tokenCount ?? 0,
        location: { pageStart: chunk.pageStart ?? null, pageEnd: chunk.pageEnd ?? null,
          sectionPath: chunk.sectionPath ?? [], blockStart: chunk.blockStart ?? 0, blockEnd: chunk.blockEnd ?? 0 } }];
    }).sort((a, b) => b.score - a.score);
    });
  }

  private applyTokenBudget(results: SearchResult[]): KnowledgeSearchResult[] {
    let remaining = KNOWLEDGE_LIMITS.maxResultTokens;
    const output: KnowledgeSearchResult[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      if (remaining <= 0) break;
      if (seen.has(result.chunkId)) continue;
      seen.add(result.chunkId);
      const truncated = TextChunker.truncateToTokenBudget(result.content, remaining);
      if (!truncated || !truncated.content.trim()) continue;
      const { content, tokenCount } = truncated;
      remaining -= tokenCount;
      output.push({ sourceId: result.chunkId, knowledgeBaseId: result.knowledgeBaseId,
        knowledgeBaseName: result.knowledgeBaseName ?? '', documentId: result.documentId!,
        documentName: result.documentName!, versionId: result.documentVersionId!, chunkId: result.chunkId,
        content, tokenCount, truncated: content !== result.content, location: result.location! });
    }
    return output;
  }

  async getSource(userId: string, knowledgeBaseId: string, sourceId: string): Promise<KnowledgeSourceResponse> {
    try {
    return await this.policy.readBoundary(userId, [knowledgeBaseId], [sourceId], async (tx, viewer) => {
    const row = await tx.textChunk.findFirst({
      where: { id: sourceId, knowledgeBaseId, knowledgeBase: this.policy.readableWhere(viewer) },
      select: { id: true, knowledgeBaseId: true, documentId: true, versionId: true, content: true,
        pageStart: true, pageEnd: true, sectionPath: true, blockStart: true, blockEnd: true,
        knowledgeBase: { select: { deletedAt: true } },
        document: { select: { id: true, knowledgeBaseId: true, originalName: true, deletedAt: true,
          activeVersionId: true, status: true } },
        indexGeneration: true,
        version: { select: { id: true, documentId: true, generation: true,
          published: true, publishedAt: true, retiredAt: true, status: true } } },
    });
    if (!row?.document || row.knowledgeBase.deletedAt || row.document.deletedAt ||
      row.document.knowledgeBaseId !== knowledgeBaseId || row.documentId !== row.document.id ||
      (row.versionId !== null && row.version?.documentId !== row.document.id)) this.policy.notFound();

    const now = new Date();
    const isCurrent = (row.versionId !== null && row.document.activeVersionId === row.versionId) ||
      (row.versionId === null && row.document.activeVersionId === null && row.document.status === 'READY');
    const versionReadable = row.versionId === null
      ? isCurrent
      : !!row.version && row.version.status === 'READY' && row.version.generation === row.indexGeneration &&
        (isCurrent ? row.version.published : !!row.version.publishedAt) &&
        (isCurrent ? !row.version.retiredAt : !!row.version.retiredAt && row.version.retiredAt > now);
    if (!versionReadable) this.policy.notFound();

    return { sourceId: row.id, knowledgeBaseId: row.knowledgeBaseId, documentId: row.document.id,
      documentName: row.document.originalName,
      versionId: row.versionId ?? row.document.activeVersionId ?? row.id,
      chunkId: row.id, content: row.content,
      location: { pageStart: row.pageStart ?? null, pageEnd: row.pageEnd ?? null,
        sectionPath: row.sectionPath ?? [], blockStart: row.blockStart ?? 0, blockEnd: row.blockEnd ?? 0 }, isCurrent };
    });
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
      throw localError(error, 503, { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE' });
    }
  }

  /**
   * 策略解析：auto → 实际策略
   */
  private async resolveStrategy(strategy: SearchStrategy): Promise<'lexical' | 'vector' | 'hybrid'> {
    if (strategy !== 'auto') {
      return strategy;
    }

    // auto 模式：优先 hybrid，降级 lexical
    const embeddingAvailable = await this.embedding.isAvailable();
    return embeddingAvailable ? 'hybrid' : 'lexical';
  }

  /**
   * 词法检索
   */
  private async searchLexical(
    query: string,
    enterpriseId: string,
    kbIds: string[],
    topK: number,
  ): Promise<SearchCandidate[]> {
    const lexicalResults = await this.lexical.search(query, enterpriseId, kbIds, topK);

    return lexicalResults.map((r) => ({
      chunkId: r.chunkId,
      content: r.content,
      source: r.source,
      knowledgeBaseId: r.knowledgeBaseId,
      score: r.score,
    }));
  }

  /**
   * 向量检索
   */
  private async searchVector(
    query: string,
    enterpriseId: string,
    kbIds: string[],
    topK: number,
    scoreThreshold: number,
  ): Promise<SearchCandidate[]> {
    // 检查服务可用性
    let availabilityError: unknown;
    const embeddingAvailable = await this.embedding.isAvailable(error => { availabilityError = error; });
    if (!embeddingAvailable) {
      throw localError(availabilityError ?? { message: 'Embedding availability check failed without an error reason' }, 503,
        { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE' });
    }

    const profile = this.embedding.getProfile();
    const embeddingResult = await this.embedding.embed(query);
    const queryVector = embeddingResult.embedding;

    const vectorResults = await this.vector.search(
      queryVector,
      enterpriseId,
      kbIds,
      topK,
      profile,
    );

    // 过滤低分
    const filtered = vectorResults.filter((r) => r.score >= scoreThreshold);

    // 补充 chunk 内容
    const chunkIds = filtered.map((r) => r.chunkId);
    const chunks = await this.prisma.textChunk.findMany({
      where: { id: { in: chunkIds }, knowledgeBaseId: { in: kbIds }, ...vectorChunkWhere({ enterpriseId }, profile) },
      select: { id: true, content: true, source: true, knowledgeBaseId: true, ...publicationSelect },
    });

    const chunkMap = new Map(chunks.filter(chunk => isVectorCompatibleChunk(chunk, profile)).map((c) => [c.id, c]));

    return filtered
      .map((r) => {
        const chunk = chunkMap.get(r.chunkId);
        if (!chunk) return null;
        return {
          chunkId: r.chunkId,
          content: chunk.content,
          source: chunk.source,
          knowledgeBaseId: chunk.knowledgeBaseId,
          score: r.score,
          vectorProfile: profile,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  /**
   * 混合检索：Lexical + Vector + RRF Fusion
   */
  private async searchHybrid(
    query: string,
    enterpriseId: string,
    kbIds: string[],
    topK: number,
    scoreThreshold: number,
    checkAvailability = true,
  ): Promise<SearchCandidate[]> {
    const embeddingAvailable = !checkAvailability || await this.embedding.isAvailable();
    if (!embeddingAvailable) {
      this.logger.warn('Embedding service unavailable, falling back to lexical search');
      return this.searchLexical(query, enterpriseId, kbIds, topK);
    }

    // 并行执行词法和向量检索
    const profile = this.embedding.getProfile();
    const [lexicalOutcome, vectorOutcome] = await Promise.allSettled([
      this.lexical.search(query, enterpriseId, kbIds, topK * 2),
      (async () => {
        let embeddingResult: Awaited<ReturnType<EmbeddingService['embed']>>;
        try { embeddingResult = await this.embedding.embed(query); }
        catch (error) { throw new QueryEmbeddingUnavailable(error); }
        return this.vector.search(
          embeddingResult.embedding,
          enterpriseId,
          kbIds,
          topK * 2,
          profile,
        );
      })(),
    ]);
    // A failed database/lexical read must not be hidden by a simultaneous embedding outage.
    if (lexicalOutcome.status === 'rejected') throw lexicalOutcome.reason;
    if (vectorOutcome.status === 'rejected') throw vectorOutcome.reason;
    const lexicalResults = lexicalOutcome.value;
    const vectorResults = vectorOutcome.value.filter(result => result.score >= scoreThreshold);

    // Revalidate before fusion so incompatible vectors cannot affect lexical ranking.
    const chunkIds = [...new Set([...lexicalResults, ...vectorResults].map(result => result.chunkId))];
    const chunks = await this.prisma.textChunk.findMany({
      where: { id: { in: chunkIds }, knowledgeBaseId: { in: kbIds }, ...publishedChunkWhere({ enterpriseId }) },
      select: { id: true, content: true, source: true, knowledgeBaseId: true, ...publicationSelect },
    });

    const chunkMap = new Map(chunks.filter(isPublishedChunk).map((c) => [c.id, c]));
    const validLexical = lexicalResults.filter(result => chunkMap.has(result.chunkId));
    const validVector = vectorResults.filter(result => {
      const chunk = chunkMap.get(result.chunkId);
      return chunk && isVectorCompatibleChunk(chunk, profile);
    });
    const vectorIds = new Set(validVector.map(result => result.chunkId));
    const lexicalScores = new Map(this.reciprocalRankFusion(validLexical, []).map(result => [result.chunkId, result.score]));
    const topResults = this.reciprocalRankFusion(validLexical, validVector).slice(0, topK);

    return topResults
      .map((r) => {
        const chunk = chunkMap.get(r.chunkId);
        if (!chunk) return null;
        return {
          chunkId: r.chunkId,
          content: chunk.content,
          source: chunk.source,
          knowledgeBaseId: chunk.knowledgeBaseId,
          score: r.score,
          ...(vectorIds.has(r.chunkId) ? { vectorProfile: profile, lexicalScore: lexicalScores.get(r.chunkId) } : {}),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  /**
   * Reciprocal Rank Fusion (RRF)
   * 公式：score(d) = Σ 1 / (k + rank(d))
   */
  private reciprocalRankFusion(
    lexicalResults: Array<{ chunkId: string; score: number }>,
    vectorResults: Array<{ chunkId: string; score: number }>,
  ): Array<{ chunkId: string; score: number }> {
    const k = 60; // RRF 常数
    const fusedScores = new Map<string, number>();

    // Lexical 排名贡献
    lexicalResults.forEach((r, index) => {
      const rank = index + 1;
      const score = 1 / (k + rank);
      fusedScores.set(r.chunkId, (fusedScores.get(r.chunkId) || 0) + score);
    });

    // Vector 排名贡献
    vectorResults.forEach((r, index) => {
      const rank = index + 1;
      const score = 1 / (k + rank);
      fusedScores.set(r.chunkId, (fusedScores.get(r.chunkId) || 0) + score);
    });

    // 排序
    const sorted = Array.from(fusedScores.entries())
      .map(([chunkId, score]) => ({ chunkId, score }))
      .sort((a, b) => b.score - a.score);

    return sorted;
  }

  /**
   * 直接按知识库 ID 搜索（不检查授权，用于测试）
   */
  async searchByKnowledgeBase(
    query: string,
    knowledgeBaseIds: string[],
    topK: number = 5,
    scoreThreshold: number = 0.7,
    strategy: SearchStrategy = 'auto',
    userId?: string,
  ): Promise<SearchResult[]> {
    if (!userId) throw new ForbiddenException('检索必须提供有效成员身份');
    const viewer = await this.policy.resolve(userId);
    const bases = await this.prisma.knowledgeBase.findMany({
      where: { id: { in: knowledgeBaseIds }, ...this.policy.readableWhere(viewer) }, select: { id: true },
    });
    if (bases.length !== new Set(knowledgeBaseIds).size) this.policy.notFound();

    // 策略解析
    const actualStrategy = await this.resolveStrategy(strategy);

    // 执行检索
    let results: SearchCandidate[];
    switch (actualStrategy) {
      case 'lexical':
        results = await this.searchLexical(query, viewer.enterpriseId, knowledgeBaseIds, topK); break;
      case 'vector':
        results = await this.searchVector(query, viewer.enterpriseId, knowledgeBaseIds, topK, scoreThreshold); break;
      case 'hybrid':
        results = await this.searchHybrid(query, viewer.enterpriseId, knowledgeBaseIds, topK, scoreThreshold); break;
    }
    return this.authorizedResults(userId, knowledgeBaseIds, results);
  }
}
