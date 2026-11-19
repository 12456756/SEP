import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { EmbeddingService } from './embedding.service';
import { TextChunker } from './text-chunker.util';

describe('EmbeddingService', () => {
  let fetchMock: jest.SpyInstance;
  const create = async (overrides: Record<string, unknown> = {}) => {
    const values = {
      SUB2API_BASE_URL: 'https://relay.example/v1', SUB2API_API_KEY: 'relay-test-key',
      EMBEDDING_DIMENSION: '2', ...overrides,
    };
    const get = jest.fn((key: string) => values[key]);
    const service = new EmbeddingService({ get } as unknown as ConfigService);
    await service.onModuleInit();
    return { service, get };
  };
  const reply = (data: unknown) => fetchMock.mockResolvedValue({ ok: true, json: async () => data });

  beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); });
  afterEach(() => jest.restoreAllMocks());

  it.each(['https://relay.example', 'https://relay.example/', 'https://relay.example/v1', 'https://relay.example/v1///'])('normalizes only the sub2api URL: %s', async (baseUrl) => {
    const { service, get } = await create({ SUB2API_BASE_URL: baseUrl, EMBEDDING_PROVIDER: 'sub2api',
      EMBEDDING_BASE_URL: 'http://forbidden-upstream', EMBEDDING_API_KEY: 'unused', OPENAI_API_KEY: 'unused' });
    reply({ data: [{ index: 0, embedding: [1, 0] }] });
    expect((await service.embed('hello')).embedding).toEqual(new Float32Array([1, 0]));
    expect(fetchMock).toHaveBeenCalledWith('https://relay.example/v1/embeddings', expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer relay-test-key' },
    }));
    expect(get.mock.calls.map(([key]) => key)).not.toEqual(expect.arrayContaining([
      'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'OPENAI_API_KEY',
    ]));
    for (const key of ['EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'OPENAI_API_KEY']) {
      expect(get).not.toHaveBeenCalledWith(key);
    }
  });

  it('returns a JSON-persistable profile and defensive copies', async () => {
    const { service } = await create({ EMBEDDING_DIMENSION: undefined });
    expect(service.getProfile()).toEqual({ model: 'BAAI/bge-m3', dimension: 1024, tokenizer: 'BAAI/bge-m3', distance: 'cosine' });
    const profile = service.getProfile();
    const persisted: Prisma.InputJsonValue = profile;
    expect(persisted).toEqual(profile);
    expect(JSON.parse(JSON.stringify(profile))).toEqual(profile);
    profile.dimension = 1;
    expect(service.getDimension()).toBe(1024);
    expect(service.getModel()).toBe('BAAI/bge-m3');
    expect(service.getBatchSize()).toBe(32);
  });

  it('requires explicit tokenizer and dimension for unknown custom models', async () => {
    await expect(create({ EMBEDDING_MODEL: 'custom-model' })).rejects.toThrow('EMBEDDING_TOKENIZER');
    await expect(create({ EMBEDDING_MODEL: 'custom-model', EMBEDDING_TOKENIZER: 'custom-tokenizer', EMBEDDING_DIMENSION: undefined }))
      .rejects.toThrow('EMBEDDING_DIMENSION');
    expect((await create({ EMBEDDING_MODEL: 'custom-model', EMBEDDING_TOKENIZER: 'custom-tokenizer' })).service.getProfile())
      .toEqual({ model: 'custom-model', tokenizer: 'custom-tokenizer', dimension: 2, distance: 'cosine' });
  });

  it('maps an explicitly configured legacy bge-m3 alias to its real tokenizer without changing the model', async () => {
    expect((await create({ EMBEDDING_MODEL: 'bge-m3:latest' })).service.getProfile()).toMatchObject({ model: 'bge-m3:latest', tokenizer: 'BAAI/bge-m3' });
  });

  it('preserves revision-pinned relay and tokenizer identifiers in the profile and request', async () => {
    const model = 'sep-bge-m3-revision-abc123';
    const tokenizer = 'BAAI/bge-m3@abc123';
    const { service } = await create({ EMBEDDING_MODEL: model, EMBEDDING_TOKENIZER: tokenizer });
    reply({ data: [{ index: 0, embedding: [1, 0] }] });
    expect(service.getProfile()).toEqual({ model, tokenizer, dimension: 2, distance: 'cosine' });
    expect((await service.embed('hello')).model).toBe(model);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(model);
  });

  it('restores index order across response batches', async () => {
    const { service } = await create({ EMBEDDING_BATCH_SIZE: '2' });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [
      { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
    ] }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [2, 2] }] }) });
    expect((await service.embedBatch(['a', 'b', 'c'])).map((result) => Array.from(result.embedding)))
      .toEqual([[1, 0], [0, 1], [2, 2]]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'BAAI/bge-m3', input: ['a', 'b'], encoding_format: 'float' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).input).toEqual(['c']);
  });

  it.each([
    [null, 'count mismatch'], [{}, 'count mismatch'], [{ data: [] }, 'count mismatch'],
    [{ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] }, 'count mismatch'],
    [{ data: [{ embedding: [1, 0] }] }, 'index'], [{ data: [{ index: -1, embedding: [1, 0] }] }, 'index'],
    [{ data: [{ index: 1, embedding: [1, 0] }] }, 'index'],
    [{ data: [{ index: 0, embedding: [1] }] }, 'dimension mismatch'],
    [{ data: [{ index: 0, embedding: [NaN, 0] }] }, 'non-finite'],
    [{ data: [{ index: 0, embedding: [Infinity, 0] }] }, 'non-finite'],
    [{ data: [{ index: 0, embedding: ['1', 0] }] }, 'non-finite'],
    [{ data: [{ index: 0, embedding: [null, 0] }] }, 'non-finite'],
    [{ data: [{ index: 0, embedding: [1e100, 0] }] }, 'overflow'],
  ])('rejects invalid vectors: %j', async (payload, message) => {
    reply(payload);
    await expect((await create()).service.embed('a')).rejects.toThrow(message);
  });

  it('rejects duplicate indexes even when response count matches', async () => {
    reply({ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] });
    await expect((await create()).service.embedBatch(['a', 'b'])).rejects.toThrow('duplicate index');
  });

  it.each(['SUB2API_BASE_URL', 'SUB2API_API_KEY'])('never falls back when %s is missing', async (key) => {
    const { service } = await create({ [key]: undefined, EMBEDDING_BASE_URL: 'http://forbidden-upstream', EMBEDDING_API_KEY: 'unused' });
    await expect(service.embed('a')).rejects.toThrow('SUB2API_BASE_URL and SUB2API_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['file:///tmp/relay', 'https://user:password@relay.example/v1', 'https://relay.example?secret=value', 'https://relay.example#v1'])('rejects unsafe relay URL: %s', async (baseUrl) => {
    await expect((await create({ SUB2API_BASE_URL: baseUrl })).service.embed('a')).rejects.toThrow('Invalid SUB2API_BASE_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains upstream response reasons and transport causes after credential redaction', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INVALID_API_KEY', message: 'Invalid credential relay-test-key' } }), { status: 401 }));
    await expect((await create()).service.embed('a')).rejects.toMatchObject({ status: 401,
      response: { error: { code: 'INVALID_API_KEY', message: 'Invalid credential [REDACTED]' } } });
    fetchMock.mockRejectedValue(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
    await expect((await create()).service.embed('a')).rejects.toMatchObject({ status: 502,
      response: { message: 'connection refused', cause: { code: 'ECONNREFUSED' } } });
  });

  it('uses the same vector validation and relay endpoint for health checks', async () => {
    reply({ data: [{ index: 0, embedding: [1, 0] }] });
    const { service } = await create();
    expect(await service.isAvailable()).toBe(true);
    reply({ data: [{ index: 0, embedding: [NaN, 0] }] });
    expect(await service.isAvailable()).toBe(false);
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://relay.example/v1/embeddings')).toBe(true);
  });

  it('returns an empty batch without accessing the gateway', async () => {
    expect(await (await create()).service.embedBatch([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { EMBEDDING_DIMENSION: '2junk' }, { EMBEDDING_BATCH_SIZE: '0' },
    { EMBEDDING_TIMEOUT_MS: '-1' }, { EMBEDDING_DIMENSION: '1.2' },
    { EMBEDDING_TIMEOUT_MS: '2147483648' }, { EMBEDDING_DISTANCE: 'dot' },
  ])('rejects invalid numeric/profile configuration: %j', async (config) => {
    await expect(create(config)).rejects.toThrow();
  });

  it('initializes a configured local tokenizer with the exact profile identifier', async () => {
    const initialize = jest.spyOn(TextChunker, 'initializeTokenizer').mockResolvedValue(undefined);
    const { service } = await create({ EMBEDDING_TOKENIZER_PATH: '/opt/sep/tokenizers/bge-m3/revision-abc',
      EMBEDDING_TOKENIZER: 'BAAI/bge-m3@revision-abc' });
    expect(initialize).toHaveBeenCalledWith('/opt/sep/tokenizers/bge-m3/revision-abc', service.getProfile().tokenizer);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not block app startup without a tokenizer path', async () => {
    const initialize = jest.spyOn(TextChunker, 'initializeTokenizer');
    await expect(create()).resolves.toBeDefined();
    expect(initialize).not.toHaveBeenCalled();
    expect(() => TextChunker.chunkByTokens('hello')).toThrow('Local embedding tokenizer is unavailable');
  });

  it('keeps optional tokenizer initialization failures out of app startup and logs no local details', async () => {
    jest.spyOn(TextChunker, 'initializeTokenizer').mockRejectedValue(new Error('sensitive filesystem details'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(create({ EMBEDDING_TOKENIZER_PATH: '/nonexistent/local/tokenizer' })).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TOKENIZER_UNAVAILABLE'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive filesystem details');
  });

  describe('independent local Ollama', () => {
    const digest = 'a'.repeat(64);
    const model = `bge-m3:sep-${digest.slice(0, 12)}`;
    const local = (overrides: Record<string, unknown> = {}) => create({
      EMBEDDING_PROVIDER: 'ollama', EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1',
      EMBEDDING_MODEL: model, EMBEDDING_MODEL_DIGEST: `sha256:${digest}`,
      EMBEDDING_TOKENIZER: 'BAAI/bge-m3@revision-abc', ...overrides,
    });
    const tags = (value: unknown = { models: [{ name: model, digest }] }) =>
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => value });
    const vectors = (embeddings: unknown = [[1, 0]]) =>
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ model, embeddings }) });

    it.each(['http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1///'])
    ('uses only the local native API with truncation disabled: %s', async (baseUrl) => {
      const { service, get } = await local({ EMBEDDING_BASE_URL: baseUrl });
      tags(); vectors();
      expect((await service.embed('hello')).embedding).toEqual(new Float32Array([1, 0]));
      expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:11434/api/tags', expect.objectContaining({ redirect: 'error' }));
      expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:11434/api/embed', expect.objectContaining({
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: ['hello'], truncate: false, keep_alive: '5m' }),
      }));
      expect(get).not.toHaveBeenCalledWith('SUB2API_API_KEY');
      expect(get).not.toHaveBeenCalledWith('SUB2API_BASE_URL');
    });

    it('works without any sub2api credentials and preserves batch order', async () => {
      tags(); vectors([[1, 0], [0, 1]]);
      const { service } = await local({ SUB2API_BASE_URL: undefined, SUB2API_API_KEY: undefined });
      expect((await service.embedBatch(['a', 'b'])).map(item => Array.from(item.embedding))).toEqual([[1, 0], [0, 1]]);
    });

    it.each([undefined, 'latest', 'sha256:bad'])('requires a real expected manifest digest: %s', async (value) => {
      await expect(local({ EMBEDDING_MODEL_DIGEST: value })).rejects.toThrow('EMBEDDING_MODEL_DIGEST');
    });

    it.each([{}, { models: [] }, { models: [{ name: model, digest: 'b'.repeat(64) }] },
      { models: [{ name: 'another-model', digest }] }])('never embeds when the model digest cannot be verified: %j', async (payload) => {
      tags(payload);
      await expect((await local()).service.embed('a')).rejects.toThrow('Ollama embedding model digest mismatch');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rechecks the digest for every batch, including health probes', async () => {
      tags(); vectors(); tags({ models: [{ name: model, digest: 'b'.repeat(64) }] });
      const { service } = await local();
      expect(await service.isAvailable()).toBe(true);
      expect(await service.isAvailable()).toBe(false);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/embed', 'http://127.0.0.1:11434/api/tags',
      ]);
    });

    it.each([undefined, 'file:///tmp/model', 'https://user:password@local.test', 'http://local.test?secret=key'])
    ('does not fall back to sub2api for a missing/unsafe local URL: %s', async (baseUrl) => {
      await expect((await local({ EMBEDDING_BASE_URL: baseUrl })).service.embed('a')).rejects.toThrow('EMBEDDING_BASE_URL');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([null, [], [[1]], [[1, NaN]], [[1, 0], [0, 1]]])('validates native response vectors: %j', async (payload) => {
      tags(); vectors(payload);
      await expect((await local()).service.embed('a')).rejects.toThrow('Invalid embedding response');
    });

    it('rejects a missing embeddings field', async () => {
      tags();
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ model }) });
      await expect((await local()).service.embed('a')).rejects.toThrow('Invalid embedding response');
    });

    it('rejects a response claiming another model', async () => {
      tags();
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ model: 'another-model', embeddings: [[1, 0]] }) });
      await expect((await local()).service.embed('a')).rejects.toThrow('Invalid embedding response');
    });

    it('does not embed or fall back when digest verification fails at the transport boundary', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Ollama model index unavailable', { status: 503 }));
      await expect((await local()).service.embed('a')).rejects.toMatchObject({ status: 503, response: 'Ollama model index unavailable' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockReset().mockRejectedValueOnce(new Error('Ollama connection refused at http://127.0.0.1:11434'));
      await expect((await local()).service.embed('a')).rejects.toMatchObject({ status: 502,
        response: { message: 'Ollama connection refused at [REDACTED]' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retains native response reasons without falling back after an outage', async () => {
      tags();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Model runner exited', detail: { code: 'RUNNER_EXITED' } }), { status: 500 }));
      await expect((await local()).service.embed('a')).rejects.toMatchObject({ status: 500,
        response: { error: 'Model runner exited', detail: { code: 'RUNNER_EXITED' } } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('preserves a native business error even when Ollama responds with HTTP 200', async () => {
      tags();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Model runner exited', code: 'RUNNER_EXITED' })));
      await expect((await local()).service.embed('a')).rejects.toMatchObject({ status: 502,
        upstreamError: { status: 200, body: { error: 'Model runner exited', code: 'RUNNER_EXITED' } } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects unsupported providers rather than ignoring a typo', async () => {
      await expect(create({ EMBEDDING_PROVIDER: 'olama' })).rejects.toThrow('EMBEDDING_PROVIDER');
    });
  });
});
