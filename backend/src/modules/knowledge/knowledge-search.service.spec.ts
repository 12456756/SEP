import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { KnowledgeSearchService } from './knowledge-search.service';
import { KnowledgeAccessPolicy } from './knowledge-access-policy';
import { TextChunker } from './text-chunker.util';

const MEMBER = { enterpriseId: 'ent-a', memberId: 'm-a', role: 'MEMBER', departmentId: 'dept-a' };
const candidate = { chunkId: 'c-a', content: 'stale cache', source: 'doc-a', knowledgeBaseId: 'kb-a', score: 0.9 };
const profile = { model: 'model', dimension: 1024, tokenizer: 'tokenizer-v1', distance: 'cosine' as const };
const adoptedProfile = { kind: 'legacy-adopted', compatibility: 'model-only' };
const versioned = (row: any) => ({ ...row, versionId: 'v-old', indexGeneration: 2,
  document: { ...row.document, activeVersionId: 'v-old', status: 'FAILED' },
  version: { id: 'v-old', documentId: 'doc-a', generation: 2, published: true, status: 'READY', profile: { ...profile } } });

describe('KnowledgeSearchService authorization and logging', () => {
  let service: KnowledgeSearchService;
  let prisma: any;
  let context: any;
  let lexical: any;
  let embedding: any;
  let vector: any;
  beforeEach(() => {
    (TextChunker as any).tokenizer = { id: 'test-only', encode: (text: string) => Array.from(text) };
    prisma = {
      subscription: { findFirst: jest.fn() },
      knowledgeGrant: { findMany: jest.fn().mockResolvedValue([{ knowledgeBaseId: 'kb-a' }]) },
      knowledgeBase: { findMany: jest.fn().mockResolvedValue([{ id: 'kb-a' }]) },
      document: { findMany: jest.fn().mockResolvedValue([{ activeVersionId: null, status: 'READY', versions: [] }]) },
      knowledgeSearchLog: { create: jest.fn().mockResolvedValue({}) },
      textChunk: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([{
        id: 'c-a', content: '退款规则', source: 'doc-a', knowledgeBaseId: 'kb-a',
        documentId: 'doc-a', versionId: null, indexGeneration: 0, version: null,
        embeddingModel: profile.model,
        knowledgeBase: { deletedAt: null },
        document: { id: 'doc-a', originalName: '政策.txt', knowledgeBaseId: 'kb-a',
          deletedAt: null, activeVersionId: null, status: 'READY' },
      }]) },
    };
    prisma.$transaction = jest.fn(async callback => callback(prisma));
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.enterpriseMember = { findUnique: jest.fn().mockResolvedValue({ id: MEMBER.memberId,
      userId: 'u-a', enterpriseId: MEMBER.enterpriseId, role: MEMBER.role, departmentId: MEMBER.departmentId }) };
    context = { resolve: jest.fn().mockResolvedValue(MEMBER) };
    lexical = { search: jest.fn().mockResolvedValue([candidate]) };
    embedding = { isAvailable: jest.fn().mockResolvedValue(false), getModel: () => 'model',
      getProfile: jest.fn().mockReturnValue(profile),
      embed: jest.fn().mockResolvedValue({ embedding: new Float32Array(1024) }) };
    vector = { search: jest.fn().mockResolvedValue([candidate]) };
    service = new KnowledgeSearchService(prisma, embedding, vector, lexical, context, new KnowledgeAccessPolicy(prisma, context));
  });
  afterEach(() => TextChunker.resetTokenizer());

  it('rejects a foreign subscription before reading legacy knowledge grants', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(service.search('退款', 'u-a', 'sub-b', 5, 0.7, 'lexical')).rejects.toThrow(ForbiddenException);
    expect(prisma.knowledgeGrant.findMany).not.toHaveBeenCalled();
  });

  it('intersects old chat subscription grants with current member-readable bases', async () => {
    prisma.subscription.findFirst.mockResolvedValue({ enterpriseId: 'ent-a' });
    const result = await service.search('退款', 'u-a', 'sub-a', 5, 0.7, 'lexical');
    expect(prisma.knowledgeGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      knowledgeBase: { enterpriseId: 'ent-a', deletedAt: null, memberGrants: { some: { memberId: 'm-a' } } },
    }) }));
    expect(result.results[0]).toMatchObject({ content: '退款规则', documentId: 'doc-a', documentName: '政策.txt' });
  });

  it('rejects the entire explicit scope if any base is ungranted or foreign', async () => {
    await expect(service.searchForMember('u-a', { query: '退款', knowledgeBaseIds: ['kb-a', 'secret'], topK: 5 }))
      .rejects.toThrow(NotFoundException);
    expect(lexical.search).not.toHaveBeenCalled();
  });

  it('searches all member-readable bases without a subscription', async () => {
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result.results[0]).toMatchObject({ documentId: 'doc-a', documentName: '政策.txt' });
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(prisma.knowledgeGrant.findMany).not.toHaveBeenCalled();
    expect(prisma.knowledgeBase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      enterpriseId: 'ent-a', deletedAt: null, memberGrants: { some: { memberId: 'm-a' } },
    } }));
  });

  it('does not return cache content after revoke or a document losing READY status', async () => {
    prisma.textChunk.findMany.mockResolvedValue([]);
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result.results).toEqual([]);
    expect(prisma.textChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      document: { deletedAt: null }, knowledgeBase: { AND: [
        { enterpriseId: 'ent-a', deletedAt: null, memberGrants: { some: { memberId: 'm-a' } } }, { deletedAt: null },
      ] },
    }) }));
  });

  it('keeps the old published active when latest processing fails, but rejects an outdated generation', async () => {
    const row = (await prisma.textChunk.findMany())[0];
    const active = versioned(row);
    prisma.textChunk.findMany.mockResolvedValue([active]);
    expect((await service.searchForMember('u-a', { query: '退款', topK: 5 })).count).toBe(1);
    prisma.textChunk.findMany.mockResolvedValue([{ ...active, indexGeneration: 1 }]);
    expect((await service.searchForMember('u-a', { query: '退款', topK: 5 })).results).toEqual([]);
  });

  it.each(['search', 'searchForMember', 'searchByKnowledgeBase'] as const)('rechecks publication for %s', async entry => {
    const row = (await prisma.textChunk.findMany())[0];
    prisma.textChunk.findMany.mockResolvedValue([{ ...row, document: { ...row.document, activeVersionId: 'v-new' } }]);
    prisma.subscription.findFirst.mockResolvedValue({ enterpriseId: 'ent-a' });
    const result = entry === 'search' ? (await service.search('退款', 'u-a', 'sub-a', 5, 0.7, 'lexical')).results
      : entry === 'searchForMember' ? (await service.searchForMember('u-a', { query: '退款', topK: 5 })).results
      : await service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, 'lexical', 'u-a');
    expect(result).toEqual([]);
  });

  it.each(['vector', 'hybrid'] as const)('%s retains authorized hydration and rejects a switch before final results', async strategy => {
    embedding.isAvailable.mockResolvedValue(true);
    const row = (await prisma.textChunk.findMany())[0];
    const active = versioned(row);
    prisma.textChunk.findMany.mockClear().mockResolvedValue([active]);
    const results = await service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, strategy, 'u-a');
    expect(results).toHaveLength(1);
    expect(embedding.getProfile).toHaveBeenCalled();
    expect(vector.search).toHaveBeenCalledWith(expect.any(Float32Array), 'ent-a', ['kb-a'],
      strategy === 'hybrid' ? 10 : 5, profile);
    expect(results[0]).not.toHaveProperty('vectorProfile');
    expect(results[0]).not.toHaveProperty('lexicalScore');
    expect(prisma.textChunk.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ knowledgeBaseId: { in: ['kb-a'] },
        knowledgeBase: { AND: [
          { enterpriseId: 'ent-a', deletedAt: null, memberGrants: { some: { memberId: 'm-a' } } }, { deletedAt: null },
        ] },
      }),
    }));
    prisma.textChunk.findMany.mockResolvedValueOnce([active]).mockResolvedValueOnce([
      { ...active, document: { ...active.document, activeVersionId: 'v-new' } },
    ]);
    await expect(service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, strategy, 'u-a')).resolves.toEqual([]);
  });

  it.each(['vector', 'hybrid'] as const)('%s preserves adopted old active vectors after latest failure and rechecks publication', async strategy => {
    embedding.isAvailable.mockResolvedValue(true);
    const base = versioned((await prisma.textChunk.findMany())[0]);
    const active = { ...base, version: { ...base.version, profile: { ...adoptedProfile } } };
    prisma.textChunk.findMany.mockClear().mockResolvedValue([active]);
    const results = await service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, strategy, 'u-a');
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(strategy === 'vector' ? candidate.score : 2 / 61);
    expect(results[0]).not.toHaveProperty('vectorProfile');
    expect(results[0]).not.toHaveProperty('lexicalScore');
    expect(prisma.textChunk.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({
      knowledgeBase: { AND: [
        { enterpriseId: 'ent-a', deletedAt: null, memberGrants: { some: { memberId: 'm-a' } } }, { deletedAt: null },
      ] },
    }) }));
    prisma.textChunk.findMany.mockResolvedValueOnce([active]).mockResolvedValueOnce([
      { ...active, indexGeneration: active.indexGeneration + 1 },
    ]);
    await expect(service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, strategy, 'u-a')).resolves.toEqual([]);
  });

  it.each(['model', 'marker'] as const)('removes adopted vector contributions after a final %s change but retains lexical', async change => {
    embedding.isAvailable.mockResolvedValue(true);
    const base = versioned((await prisma.textChunk.findMany())[0]);
    const active = { ...base, version: { ...base.version, profile: { ...adoptedProfile } } };
    const changed = change === 'model' ? { ...active, embeddingModel: 'other' }
      : { ...active, version: { ...active.version, profile: null } };
    for (const strategy of ['vector', 'hybrid'] as const) {
      prisma.textChunk.findMany.mockResolvedValueOnce([active]).mockResolvedValueOnce([changed]);
      const results = await service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, strategy, 'u-a');
      if (strategy === 'vector') expect(results).toEqual([]);
      else {
        expect(results).toHaveLength(1);
        expect(results[0].score).toBeCloseTo(1 / 61);
        expect(results[0]).not.toHaveProperty('vectorProfile');
        expect(results[0]).not.toHaveProperty('lexicalScore');
      }
    }
  });

  it.each([
    ['model', 'other-model'], ['dimension', 768], ['tokenizer', 'tokenizer-v2'], ['distance', 'dot'],
  ])('rejects vector %s mismatch while retaining lexical results without vector boost', async (field, value) => {
    embedding.isAvailable.mockResolvedValue(true);
    const active = versioned((await prisma.textChunk.findMany())[0]);
    active.version.profile = { ...profile, [field]: value };
    prisma.textChunk.findMany.mockResolvedValue([active]);
    await expect(service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, 'vector', 'u-a')).resolves.toEqual([]);
    const hybrid = await service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, 'hybrid', 'u-a');
    expect(hybrid).toHaveLength(1);
    expect(hybrid[0].score).toBeCloseTo(1 / 61);
    expect(hybrid[0]).not.toHaveProperty('vectorProfile');
    expect(hybrid[0]).not.toHaveProperty('lexicalScore');
    const lexicalResults = await service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, 'lexical', 'u-a');
    expect(lexicalResults).toHaveLength(1);
    expect(lexicalResults[0].score).toBe(candidate.score);
  });

  it.each(['vector', 'hybrid'] as const)('%s rechecks profile after hydration and removes incompatible vector contributions', async strategy => {
    embedding.isAvailable.mockResolvedValue(true);
    const active = versioned((await prisma.textChunk.findMany())[0]);
    const changed = { ...active, version: { ...active.version, profile: { ...profile, tokenizer: 'changed' } } };
    prisma.textChunk.findMany.mockResolvedValueOnce([active]).mockResolvedValueOnce([changed]);
    const results = await service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, strategy, 'u-a');
    if (strategy === 'vector') expect(results).toEqual([]);
    else {
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(1 / 61);
      expect(results[0]).not.toHaveProperty('vectorProfile');
      expect(results[0]).not.toHaveProperty('lexicalScore');
    }
  });

  it('rejects a vector-only hybrid candidate if its profile changes before final authorization', async () => {
    embedding.isAvailable.mockResolvedValue(true);
    lexical.search.mockResolvedValue([]);
    const active = versioned((await prisma.textChunk.findMany())[0]);
    prisma.textChunk.findMany.mockResolvedValueOnce([active]).mockResolvedValueOnce([
      { ...active, version: { ...active.version, profile: null } },
    ]);
    await expect(service.searchByKnowledgeBase('退款', ['kb-a'], 5, 0.7, 'hybrid', 'u-a')).resolves.toEqual([]);
  });

  it('closes the internal direct search bypass unless a current member identity is provided', async () => {
    await expect(service.searchByKnowledgeBase('q', ['kb-a'])).rejects.toThrow(ForbiddenException);
    expect(lexical.search).not.toHaveBeenCalled();
  });

  it('reports dependency failure as 503 instead of a successful empty result', async () => {
    lexical.search.mockRejectedValue(new Error('database credentials or internal error'));
    await expect(service.searchForMember('u-a', { query: '退款', topK: 5 })).rejects.toMatchObject({
      status: 503, response: { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE', message: 'database credentials or internal error',
        cause: { name: 'Error', message: 'database credentials or internal error' } },
    });
  });

  it('preserves an embedding availability error on explicit vector searches', async () => {
    embedding.isAvailable.mockImplementationOnce(async (onError: (error: unknown) => void) => {
      onError(new Error('Embedding connection refused token=embedding-secret'));
      return false;
    });
    await expect(service.searchByKnowledgeBase('query', ['kb-a'], 5, 0.7, 'vector', 'u-a')).rejects.toMatchObject({ status: 503,
      response: { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE', message: 'Embedding connection refused token=[REDACTED]' } });
  });

  it('returns the client search contract and marks lexical fallback when embeddings are unavailable', async () => {
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result).toMatchObject({ status: 'MATCHED', actualStrategy: 'LEXICAL', degraded: true,
      degradationReason: 'QUERY_EMBEDDING_UNAVAILABLE', partial: false, count: 1 });
    expect(result.searchId).toMatch(/^search_/);
    expect(result.results[0]).toMatchObject({ sourceId: 'c-a', chunkId: 'c-a', documentId: 'doc-a',
      documentName: '政策.txt', versionId: 'c-a', tokenCount: 4, truncated: false,
      location: { pageStart: null, pageEnd: null, sectionPath: [], blockStart: 0, blockEnd: 0 } });
  });

  it('includes the redacted availability failure in lexical fallback diagnostics', async () => {
    embedding.isAvailable.mockImplementationOnce(async (onError: (error: unknown) => void) => {
      onError(new Error('Embedding model unavailable at http://sep-ollama:11434 token=embedding-secret'));
      return false;
    });
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result).toMatchObject({ degraded: true, actualStrategy: 'LEXICAL', diagnostic: {
      name: 'Error', message: 'Embedding model unavailable at [REDACTED] token=[REDACTED]',
    } });
  });

  it('returns NO_ACCESS without executing retrieval when no readable base exists', async () => {
    prisma.knowledgeBase.findMany.mockResolvedValue([]);
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result).toMatchObject({ status: 'NO_ACCESS', actualStrategy: null, degraded: false, count: 0 });
    expect(lexical.search).not.toHaveBeenCalled();
  });

  it('returns NOT_READY when readable bases contain no published document', async () => {
    prisma.document.findMany.mockResolvedValue([{ activeVersionId: null, status: 'PROCESSING', versions: [] }]);
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result).toMatchObject({ status: 'NOT_READY', actualStrategy: null, degraded: false, partial: false, count: 0 });
    expect(lexical.search).not.toHaveBeenCalled();
  });

  it('marks a scope partial when some documents have no published version', async () => {
    prisma.document.findMany.mockResolvedValue([
      { activeVersionId: null, status: 'READY', versions: [] },
      { activeVersionId: null, status: 'PROCESSING', versions: [] },
    ]);
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result.partial).toBe(true);
    expect(result.status).toBe('MATCHED');
  });

  it('returns the current source after rechecking ownership and publication', async () => {
    prisma.textChunk.findFirst.mockResolvedValue({
      id: 'c-a', knowledgeBaseId: 'kb-a', documentId: 'doc-a', versionId: 'v-a', indexGeneration: 1, content: '退款规则',
      pageStart: 2, pageEnd: 2, sectionPath: ['售后'], blockStart: 4, blockEnd: 4,
      knowledgeBase: { deletedAt: null },
      document: { id: 'doc-a', knowledgeBaseId: 'kb-a', originalName: '政策.txt', deletedAt: null,
        activeVersionId: 'v-a', status: 'READY' },
      version: { id: 'v-a', documentId: 'doc-a', originalName: 'replacement-file.txt', generation: 1,
        published: true, publishedAt: new Date(), retiredAt: null, status: 'READY' },
    });
    await expect(service.getSource('u-a', 'kb-a', 'c-a')).resolves.toMatchObject({
      sourceId: 'c-a', versionId: 'v-a', isCurrent: true, content: '退款规则', documentName: '政策.txt',
      location: { pageStart: 2, sectionPath: ['售后'], blockStart: 4 },
    });
  });

  it('still searches an old active when the latest document projection is FAILED', async () => {
    prisma.document.findMany.mockResolvedValue([{ activeVersionId: 'active', status: 'FAILED', versions: [{ id: 'active' }] }]);
    expect((await service.searchForMember('u-a', { query: '退款', topK: 5 })).status).toBe('MATCHED');
  });

  it('does not treat a non-active published version as ready', async () => {
    prisma.document.findMany.mockResolvedValue([{ activeVersionId: 'active', status: 'READY', versions: [{ id: 'different' }] }]);
    expect((await service.searchForMember('u-a', { query: '退款', topK: 5 })).status).toBe('NOT_READY');
  });

  it('declares fallback if embedding fails after availability checks', async () => {
    embedding.isAvailable.mockResolvedValue(true);
    embedding.embed.mockRejectedValue(new Error('Query embedding failed token=embedding-secret'));
    expect(await service.searchForMember('u-a', { query: '退款', topK: 5 })).toMatchObject({
      status: 'MATCHED', actualStrategy: 'LEXICAL', degraded: true, degradationReason: 'QUERY_EMBEDDING_UNAVAILABLE',
      diagnostic: { message: 'Query embedding failed token=[REDACTED]' },
    });
  });

  it('treats vector database failures as 503, not query embedding degradation', async () => {
    embedding.isAvailable.mockResolvedValue(true);
    vector.search.mockRejectedValue(new Error('database gone'));
    await expect(service.searchForMember('u-a', { query: '退款', topK: 5 })).rejects.toMatchObject({ status: 503 });
  });

  it('normalizes readiness dependency failure to a safe 503', async () => {
    prisma.document.findMany.mockRejectedValue(new Error('private database path'));
    await expect(service.searchForMember('u-a', { query: '退款', topK: 5 })).rejects.toMatchObject({
      status: 503, response: { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE' },
    });
  });

  it('enforces an actual token budget instead of trusting missing or stale counts', async () => {
    const row = (await prisma.textChunk.findMany())[0];
    prisma.textChunk.findMany.mockResolvedValue([{ ...row, content: '😀'.repeat(6500), tokenCount: 0 }]);
    const result = await service.searchForMember('u-a', { query: '退款', topK: 5 });
    expect(result.results[0]).toMatchObject({ tokenCount: 6000, truncated: true, content: '😀'.repeat(6000) });
    expect(TextChunker.countTokens(result.results[0].content)).toBe(6000);
  });

  it('does not emit user queries to compatibility search logs', async () => {
    prisma.subscription.findFirst.mockResolvedValue({ enterpriseId: 'ent-a' });
    await service.search('confidential query', 'u-a', 'sub-a', 5, 0.7, 'lexical');
    expect(JSON.stringify(prisma.knowledgeSearchLog.create.mock.calls)).not.toContain('confidential query');
  });
});
