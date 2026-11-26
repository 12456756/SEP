import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class ComputeBalanceSignatureGuard implements CanActivate {
  constructor(private readonly config: ConfigService, private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get('COMPUTE_BALANCE_SYNC_ENABLED') !== 'true') throw new ServiceUnavailableException({ code: 'COMPUTE_BALANCE_SYNC_DISABLED', message: '算力余额通知接收尚未启用' });
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const reject = (code: string, message: string): never => { throw new UnauthorizedException({ code, message }); };
    const keyId = req.get('X-Compute-Key-ID') ?? '', timestamp = req.get('X-Compute-Timestamp') ?? '';
    const nonce = req.get('X-Compute-Nonce') ?? '', signature = req.get('X-Compute-Signature') ?? '';
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(keyId) || !/^\d{10}$/.test(timestamp)
      || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[A-Za-z0-9_-]{86}$/.test(signature)
      || !req.rawBody || req.method !== 'POST') reject('COMPUTE_EVENT_SIGNATURE_INVALID', '算力余额通知签名字段无效');
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) reject('COMPUTE_EVENT_TIMESTAMP_INVALID', '算力余额通知已过期或时间无效');
    let key;
    try {
      const files = JSON.parse(this.config.get<string>('COMPUTE_EVENT_PUBLIC_KEY_FILES') ?? '{}');
      if (!Object.prototype.hasOwnProperty.call(files, keyId) || typeof files[keyId] !== 'string') {
        reject('COMPUTE_EVENT_KEY_UNTRUSTED', '算力余额通知签名公钥版本不可信');
      }
      key = createPublicKey(readFileSync(files[keyId]));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid algorithm');
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException({ code: 'COMPUTE_EVENT_KEY_NOT_CONFIGURED', message: '算力余额通知验签公钥未配置或无效' });
    }
    const canonical = ['compute-balance-event-v1', keyId, timestamp, nonce, 'POST', req.originalUrl,
      createHash('sha256').update(req.rawBody).digest('hex')].join('\n');
    if (!verify(null, Buffer.from(canonical), key, Buffer.from(signature, 'base64url'))) {
      reject('COMPUTE_EVENT_SIGNATURE_INVALID', '算力余额通知签名不匹配');
    }
    let claimed;
    try { claimed = await this.redis.redis.set(`compute:balance-event:nonce:${keyId}:${nonce}`, '1', 'EX', 610, 'NX'); }
    catch { throw new ServiceUnavailableException({ code: 'COMPUTE_EVENT_REPLAY_STORAGE_UNAVAILABLE', message: '余额通知防重放服务暂不可用' }); }
    if (claimed !== 'OK') reject('COMPUTE_EVENT_REPLAYED', '算力余额通知 nonce 已使用，请重新签名重试原事件');
    return true;
  }
}
