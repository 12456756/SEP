import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MediaGatewayIdSchema, MediaGatewayReferenceSchema } from 'shared';
import { RedisService } from '../../redis/redis.service';

export const REFERENCE_CACHE_TTL_SECONDS = 900;
export const OUTPUT_CACHE_TTL_SECONDS = 86400;

type CacheKind = 'reference' | 'output';
type ExpectedBytes = { sha256: string; byteLength: number; expiresAt: string };

const CACHE_POLICY = {
  reference: { ttlSeconds: REFERENCE_CACHE_TTL_SECONDS, maxBytes: 5 * 1024 * 1024 },
  output: { ttlSeconds: OUTPUT_CACHE_TTL_SECONDS, maxBytes: 25 * 1024 * 1024 },
} as const;

function fail(status: number, code: string, message: string): never {
  throw new HttpException({ message, error: {
    code, message, type: status >= 500 ? 'server_error' : 'invalid_request_error',
    source: 'platform', param: null,
  } }, status);
}

function invalid(kind: CacheKind): never {
  return kind === 'reference'
    ? fail(400, 'INVALID_REFERENCE', '参考图缓存数据无效')
    : fail(502, 'OUTPUT_FAILED', '图片结果缓存数据无效');
}

function expired(kind: CacheKind): never {
  return kind === 'reference'
    ? fail(410, 'REFERENCE_EXPIRED', '参考图已过期或不可用')
    : fail(410, 'RESULT_EXPIRED', '图片结果已过期或不可用');
}

function unavailable(): never {
  return fail(503, 'MEDIA_STORAGE_UNAVAILABLE', '媒体存储暂不可用');
}

@Injectable()
export class MediaByteCacheService {
  constructor(private readonly redis: RedisService) {}

  async put(
    kind: CacheKind, scope: string, id: string, bytes: Buffer, expiresAt: string,
  ): Promise<void> {
    const key = this.key(kind, scope, id);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > CACHE_POLICY[kind].maxBytes) {
      invalid(kind);
    }
    const deadline = this.deadline(kind, expiresAt);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) expired(kind);
    try {
      // NX also preserves the original expiry when a caller retries a write.
      await this.redis.redis.set(key, bytes, 'PX', remainingMs, 'NX');
    } catch {
      unavailable();
    }
  }

  async get(
    kind: CacheKind, scope: string, id: string, expected: ExpectedBytes,
  ): Promise<Buffer> {
    const key = this.key(kind, scope, id);
    if (!expected || !MediaGatewayReferenceSchema.shape.sha256.safeParse(expected.sha256).success ||
      !Number.isSafeInteger(expected.byteLength) || expected.byteLength <= 0 ||
      expected.byteLength > CACHE_POLICY[kind].maxBytes) {
      invalid(kind);
    }
    const deadline = this.deadline(kind, expected.expiresAt);
    let bytes: Buffer | null;
    try {
      bytes = await this.redis.redis.getBuffer(key);
    } catch {
      unavailable();
    }
    if (Date.now() >= deadline || bytes === null) expired(kind);
    if (!Buffer.isBuffer(bytes) || bytes.length !== expected.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== expected.sha256.toLowerCase()) {
      invalid(kind);
    }
    // Hashing large outputs takes time too; never return bytes past the deadline.
    if (Date.now() >= deadline) expired(kind);
    return bytes;
  }

  async remove(kind: CacheKind, scope: string, id: string): Promise<void> {
    const key = this.key(kind, scope, id);
    try { await this.redis.redis.del(key); } catch { unavailable(); }
  }

  private key(kind: CacheKind, scope: string, id: string): string {
    if ((kind !== 'reference' && kind !== 'output') || typeof scope !== 'string' ||
      !scope.trim() || !MediaGatewayIdSchema.safeParse(id).success) {
      invalid(kind);
    }
    const digest = createHash('sha256').update(JSON.stringify([scope, id])).digest('hex');
    return `sep:media:bytes:${kind}:${digest}`;
  }

  private deadline(kind: CacheKind, expiresAt: string): number {
    if (!MediaGatewayReferenceSchema.shape.expiresAt.safeParse(expiresAt).success) invalid(kind);
    const deadline = Date.parse(expiresAt);
    const remainingMs = deadline - Date.now();
    if (!Number.isFinite(deadline)) invalid(kind);
    if (remainingMs <= 0) expired(kind);
    if (remainingMs > CACHE_POLICY[kind].ttlSeconds * 1000) invalid(kind);
    return deadline;
  }
}
