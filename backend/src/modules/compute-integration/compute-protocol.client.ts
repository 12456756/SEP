import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants, createDecipheriv, createHash, createPrivateKey, privateDecrypt, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { fetchUpstream, readUpstreamJson } from '../../common/errors/upstream-http.exception';

export const ComputeWireId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const ComputeWireMoney = z.string().regex(/^(0|[1-9][0-9]{0,17})\.[0-9]{6}$/);
export const ComputeWireSequence = z.string().regex(/^(0|[1-9][0-9]*)$/);

function failure(code: string, message: string): never { throw new ServiceUnavailableException({ code, message }); }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export interface ComputeSignedOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  enterpriseId?: string;
  executionId?: string;
  apiKey?: string;
  idempotencyKey?: string;
  quoteId?: string;
  videoOperation?: string;
  rawBody?: Uint8Array;
  contentType?: string;
  signal?: AbortSignal;
  accept?: string;
  correlationHeaders?: Record<string, string>;
}

@Injectable()
export class ComputeProtocolClient {
  constructor(@Optional() private readonly config?: ConfigService) {}

  private value(name: string) { return this.config?.get<string>(name); }

  validateAddress(raw: string): URL {
    try {
      const url = new URL(raw);
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      const allowLocal = this.value('NODE_ENV') !== 'production' && this.value('COMPUTE_ALLOW_LOOPBACK_HTTP') === 'true';
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local && allowLocal))
        || url.username || url.password || url.search || url.hash) throw new Error();
      return url;
    } catch { return failure('COMPUTE_ADDRESS_INVALID', '算力服务地址无效；仅显式启用的非生产本机联调允许 HTTP'); }
  }

  private signingKey() {
    try {
      const file = this.value('COMPUTE_SIGNING_PRIVATE_KEY_FILE');
      if (!file) throw new Error();
      const key = createPrivateKey(readFileSync(file));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error();
      return key;
    } catch { return failure('COMPUTE_SIGNING_NOT_CONFIGURED', 'SEP Ed25519 签名私钥未配置或无效'); }
  }

  encryptionKeyId() {
    const id = this.value('COMPUTE_ENCRYPTION_KEY_ID');
    if (!ComputeWireId.safeParse(id).success || id!.length > 100) return failure('COMPUTE_ENCRYPTION_NOT_CONFIGURED', 'SEP 凭证加密版本未配置或无效');
    return id!;
  }

  isConfigured() {
    if (this.value('COMPUTE_INTEGRATION_ENABLED') !== 'true') return false;
    try {
      this.origin(); this.signingKey(); this.encryptionKeyId();
      const id = this.value('COMPUTE_SIGNING_KEY_ID');
      if (!ComputeWireId.safeParse(id).success || id!.length > 100) return false;
      this.decryptionKey(this.encryptionKeyId());
      return true;
    } catch { return false; }
  }

  origin() {
    const url = this.validateAddress(this.value('COMPUTE_API_ORIGIN') ?? '');
    if (url.pathname !== '/') return failure('COMPUTE_ADDRESS_INVALID', 'COMPUTE_API_ORIGIN 只填写服务源站，不包含 /v1 或 /api');
    return url.origin;
  }

  async request(path: string, options: ComputeSignedOptions = {}, origin = this.origin()): Promise<Response> {
    if (this.value('COMPUTE_INTEGRATION_ENABLED') !== 'true') return failure('REMOTE_NOT_CONNECTED', '算力平台集成未启用');
    const address = this.validateAddress(origin);
    const target = new URL(path, address);
    if (!path.startsWith('/') || path.startsWith('//') || target.origin !== address.origin || target.hash
      || target.pathname + target.search !== path) return failure('COMPUTE_ADDRESS_INVALID', '签名请求路径必须与实际发送路径完全一致');
    const keyId = this.value('COMPUTE_SIGNING_KEY_ID');
    if (!ComputeWireId.safeParse(keyId).success || keyId!.length > 100) return failure('COMPUTE_SIGNING_NOT_CONFIGURED', 'SEP 签名公钥版本未配置或无效');
    const headers = new Headers({ 'X-SEP-Version': '1', 'X-SEP-Key-ID': keyId!,
      'X-SEP-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-SEP-Nonce': randomUUID(), Accept: options.accept ?? 'application/json' });
    for (const [name, value] of Object.entries(options.correlationHeaders ?? {})) {
      if (!['x-client-request-id', 'x-video-pricing-version'].includes(name.toLowerCase()) || !ComputeWireId.safeParse(value).success) {
        return failure('COMPUTE_REQUEST_INVALID', '媒体请求关联编号无效');
      }
      headers.set(name, value);
    }
    for (const [header, value] of [['X-SEP-Enterprise-ID', options.enterpriseId], ['X-SEP-Execution-ID', options.executionId],
      ['Idempotency-Key', options.idempotencyKey], ['X-SEP-Quote-ID', options.quoteId]] as const) {
      if (value !== undefined) {
        if (!ComputeWireId.safeParse(value).success) return failure('COMPUTE_REQUEST_INVALID', '签名业务编号无效');
        headers.set(header, value);
      }
    }
    if (options.videoOperation) {
      if (!['text-to-video', 'image-to-video', 'video-to-video'].includes(options.videoOperation)) return failure('COMPUTE_REQUEST_INVALID', '视频操作无效');
      headers.set('X-Video-Operation', options.videoOperation);
    }
    if (options.apiKey) {
      if (/[^\x21-\x7e]/.test(options.apiKey)) return failure('COMPUTE_REQUEST_INVALID', '企业 Key 格式无效');
      headers.set('Authorization', `Bearer ${options.apiKey}`);
    }
    const method = options.method ?? 'GET';
    if (options.rawBody !== undefined && options.body !== undefined) return failure('COMPUTE_REQUEST_INVALID', '签名请求只能指定一种 Body');
    if (method === 'GET' && (options.body !== undefined || options.rawBody !== undefined)) return failure('COMPUTE_REQUEST_INVALID', 'GET 签名请求不能包含 Body');
    const bytes = options.rawBody !== undefined ? Buffer.from(options.rawBody)
      : options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    if (bytes) headers.set('Content-Type', options.contentType ?? 'application/json');
    const canonical = ['sep-v1', keyId!, headers.get('X-SEP-Timestamp')!, headers.get('X-SEP-Nonce')!, method, path,
      hash(bytes ?? new Uint8Array()), hash(headers.get('Authorization') ?? ''), headers.get('X-SEP-Enterprise-ID') ?? '',
      headers.get('X-SEP-Execution-ID') ?? '', headers.get('Idempotency-Key') ?? '', headers.get('Content-Type') ?? '',
      headers.get('X-SEP-Quote-ID') ?? '', headers.get('X-Video-Operation') ?? ''].join('\n');
    headers.set('X-SEP-Signature', sign(null, Buffer.from(canonical), this.signingKey()).toString('base64url'));
    return fetchUpstream(target, { method, headers, body: bytes, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(15000) }, [options.apiKey ?? '']);
  }

  async json<T = unknown>(path: string, options: ComputeSignedOptions = {}, origin?: string): Promise<T> {
    return readUpstreamJson<T>(await this.request(path, options, origin), [options.apiKey ?? '']);
  }

  async fetchSigned(url: string, init: RequestInit, identity: Omit<ComputeSignedOptions, 'body' | 'rawBody' | 'method'>) {
    const request = new Request(url, init);
    const target = new URL(url);
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const correlationHeaders: Record<string, string> = {};
    for (const name of ['x-client-request-id', 'x-video-pricing-version']) {
      const value = request.headers.get(name);
      if (value !== null) correlationHeaders[name] = value;
    }
    return this.request(target.pathname + target.search, { ...identity, method: request.method as 'GET' | 'POST' | 'PUT',
      idempotencyKey: request.headers.get('idempotency-key') ?? identity.idempotencyKey, correlationHeaders,
      rawBody: bytes, contentType: request.headers.get('content-type') ?? undefined,
      videoOperation: request.headers.get('x-video-operation') ?? identity.videoOperation,
      accept: request.headers.get('accept') ?? undefined, signal: request.signal }, target.origin);
  }

  private decryptionKey(id: string) {
    try {
      // A version map preserves private keys needed to replay old registrations.
      const files = JSON.parse(this.value('COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES') ?? '{}');
      if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.prototype.hasOwnProperty.call(files, id) || typeof files[id] !== 'string') throw new Error();
      const key = createPrivateKey(readFileSync(files[id]));
      if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) throw new Error();
      return key;
    } catch { return failure('COMPUTE_ENCRYPTION_NOT_CONFIGURED', 'SEP 对应版本的 RSA 解密私钥未配置或无效'); }
  }

  decryptCredential(compact: string, expectedKeyId: string): unknown {
    try {
      if (compact.length > 32768) throw new Error();
      const segments = compact.split('.');
      if (segments.length !== 5 || segments.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error();
      const [protectedHeader, encryptedKey, iv, ciphertext, tag] = segments;
      const header = z.object({ alg: z.literal('RSA-OAEP-256'), enc: z.literal('A256GCM'), kid: z.literal(expectedKeyId) }).strict()
        .parse(JSON.parse(Buffer.from(protectedHeader, 'base64url').toString('utf8')));
      const key = privateDecrypt({ key: this.decryptionKey(header.kid), oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(encryptedKey, 'base64url'));
      if (key.length !== 32 || Buffer.from(iv, 'base64url').length !== 12 || Buffer.from(tag, 'base64url').length !== 16) throw new Error();
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(protectedHeader)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
      } finally { key.fill(0); }
    } catch { return failure('COMPUTE_CREDENTIAL_DELIVERY_INVALID', '企业凭证 JWE 无法验证或解密，请核对加密版本及原开户响应'); }
  }
}
