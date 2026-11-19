import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TextChunker } from './text-chunker.util';
import { localError } from '../../common/errors/error-diagnostics';
import { fetchUpstream, readUpstreamJson } from '../../common/errors/upstream-http.exception';

export interface EmbeddingResponse {
  embedding: Float32Array;
  model: string;
}

export type EmbeddingProfile = {
  /** Use a revision-specific model ID; Ollama additionally verifies the manifest digest. */
  model: string;
  dimension: number;
  tokenizer: string;
  distance: 'cosine';
};

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private profile: EmbeddingProfile;
  private batchSize: number;
  private timeoutMs: number;
  private provider: 'sub2api' | 'ollama';
  private modelDigest: string | undefined;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const provider = this.config.get<string>('EMBEDDING_PROVIDER')?.trim() || 'sub2api';
    if (provider !== 'sub2api' && provider !== 'ollama') {
      throw new ServiceUnavailableException('EMBEDDING_PROVIDER must be sub2api or ollama');
    }
    this.provider = provider;
    if (provider === 'ollama') {
      const digest = this.config.get<string>('EMBEDDING_MODEL_DIGEST')?.trim().replace(/^sha256:/, '');
      if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new ServiceUnavailableException('EMBEDDING_MODEL_DIGEST must be the expected Ollama SHA-256 manifest digest');
      }
      this.modelDigest = digest;
    }
    const model = this.config.get<string>('EMBEDDING_MODEL')?.trim() || 'BAAI/bge-m3';
    const isBgeM3 = ['BAAI/bge-m3', 'bge-m3', 'bge-m3:latest'].includes(model);
    const tokenizer = this.config.get<string>('EMBEDDING_TOKENIZER')?.trim()
      || (isBgeM3 ? 'BAAI/bge-m3' : undefined);
    if (!tokenizer) {
      throw new ServiceUnavailableException('EMBEDDING_TOKENIZER is required for custom embedding models');
    }
    if (!isBgeM3 && this.config.get('EMBEDDING_DIMENSION') == null) {
      throw new ServiceUnavailableException('EMBEDDING_DIMENSION is required for custom embedding models');
    }
    const distance = this.config.get<string>('EMBEDDING_DISTANCE') || 'cosine';
    if (distance !== 'cosine') {
      throw new ServiceUnavailableException('Only cosine embedding distance is supported');
    }
    this.profile = {
      model,
      dimension: this.positiveInteger('EMBEDDING_DIMENSION', 1024),
      tokenizer,
      distance,
    };
    this.batchSize = this.positiveInteger('EMBEDDING_BATCH_SIZE', 32);
    this.timeoutMs = this.positiveInteger('EMBEDDING_TIMEOUT_MS', 30_000);
    TextChunker.resetTokenizer();
    const tokenizerPath = this.config.get<string>('EMBEDDING_TOKENIZER_PATH')?.trim();
    if (tokenizerPath) {
      try {
        await TextChunker.initializeTokenizer(tokenizerPath, this.profile.tokenizer);
      } catch {
        // Knowledge jobs fail closed, but an optional tokenizer must not take down the app.
        this.logger.warn('TOKENIZER_UNAVAILABLE: provision matching local tokenizer files before processing documents');
      }
    }
  }

  getProfile(): EmbeddingProfile { return { ...this.profile }; }
  getDimension(): number { return this.profile.dimension; }
  getModel(): string { return this.profile.model; }
  getBatchSize(): number { return this.batchSize; }

  async embed(text: string): Promise<EmbeddingResponse> {
    return (await this.embedBatch([text]))[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    if (texts.length === 0) return [];
    const results: EmbeddingResponse[] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      results.push(...await this.requestBatch(texts.slice(offset, offset + this.batchSize)));
    }
    return results;
  }

  async isAvailable(onError?: (error: unknown) => void): Promise<boolean> {
    try {
      await this.requestBatch(['health check']);
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }

  private positiveInteger(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key) ?? fallback;
    const value = typeof raw === 'number' ? raw : (/^\d+$/.test(raw) ? Number(raw) : NaN);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new ServiceUnavailableException(`Invalid ${key}`);
    }
    return value;
  }

  private async requestBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    if (this.provider === 'ollama') return this.requestOllamaBatch(texts);
    const baseUrl = this.config.get<string>('SUB2API_BASE_URL')?.trim();
    const apiKey = this.config.get<string>('SUB2API_API_KEY');
    if (!baseUrl || !apiKey) {
      throw new ServiceUnavailableException('SUB2API_BASE_URL and SUB2API_API_KEY are required for embeddings');
    }
    let url: URL;
    try { url = new URL(baseUrl); } catch {
      throw new ServiceUnavailableException('Invalid SUB2API_BASE_URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ServiceUnavailableException('Invalid SUB2API_BASE_URL');
    }
    const origin = baseUrl.replace(/\/+$/, '');
    const endpoint = `${origin}${origin.endsWith('/v1') ? '' : '/v1'}/embeddings`;
    try {
      const response = await fetchUpstream(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ model: this.profile.model, input: texts, encoding_format: 'float' }),
      }, [apiKey]);
      const payload: unknown = await readUpstreamJson(response, [apiKey]);
      return this.validateEmbeddings(payload, texts.length);
    } catch (error) {
      throw localError(error, 503, { origin: 'sep', stage: 'embedding' }, [apiKey]);
    }
  }

  private async requestOllamaBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    const baseUrl = this.config.get<string>('EMBEDDING_BASE_URL')?.trim();
    let url: URL;
    try { url = new URL(baseUrl || ''); } catch {
      throw new ServiceUnavailableException('Invalid or missing EMBEDDING_BASE_URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ServiceUnavailableException('Invalid EMBEDDING_BASE_URL');
    }
    // Accept the former OpenAI-compatible /v1 setting, but use the native API
    // so an oversized input fails instead of being silently truncated.
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    const origin = url.toString().replace(/\/+$/, '');
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const tags = await fetchUpstream(`${origin}/api/tags`, { redirect: 'error', signal });
      const models: unknown = await readUpstreamJson(tags);
      const match = models && typeof models === 'object' && 'models' in models && Array.isArray(models.models)
        ? models.models.find((item: unknown) => item && typeof item === 'object' &&
          'name' in item && item.name === this.profile.model)
        : undefined;
      if (!match || match.digest !== this.modelDigest) {
        throw new ServiceUnavailableException('Ollama embedding model digest mismatch');
      }
      const response = await fetchUpstream(`${origin}/api/embed`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.profile.model, input: texts, truncate: false, keep_alive: '5m' }),
      });
      const payload: unknown = await readUpstreamJson(response);
      if (!payload || typeof payload !== 'object' || !('model' in payload) || payload.model !== this.profile.model) {
        throw new ServiceUnavailableException('Invalid embedding response: model mismatch');
      }
      const embeddings = payload && typeof payload === 'object' && 'embeddings' in payload && Array.isArray(payload.embeddings)
        ? payload.embeddings : [];
      return this.validateEmbeddings({ data: embeddings.map((embedding: unknown, index: number) => ({ index, embedding })) }, texts.length);
    } catch (error) {
      throw localError(error, 503, { stage: 'ollama-embedding', origin: 'sep' });
    }
  }

  private validateEmbeddings(payload: unknown, count: number): EmbeddingResponse[] {
    const invalid = (reason: string): never => {
      throw new ServiceUnavailableException(`Invalid embedding response: ${reason}`);
    };
    if (!payload || typeof payload !== 'object' || !('data' in payload) ||
        !Array.isArray(payload.data) || payload.data.length !== count) {
      return invalid('count mismatch');
    }
    const results = new Array<EmbeddingResponse>(count);
    for (const item of payload.data) {
      if (!item || typeof item !== 'object' || !Number.isInteger(item.index) ||
          item.index < 0 || item.index >= count || results[item.index]) {
        return invalid('invalid or duplicate index');
      }
      const vector: unknown = item.embedding;
      if (!Array.isArray(vector) || vector.length !== this.profile.dimension) {
        return invalid('Embedding dimension mismatch');
      }
      if (vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        return invalid('non-finite vector');
      }
      const embedding = new Float32Array(vector);
      if (embedding.some((value) => !Number.isFinite(value))) return invalid('Float32 overflow');
      results[item.index] = { embedding, model: this.profile.model };
    }
    return results;
  }
}
