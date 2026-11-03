import { ConflictException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../../redis/redis.service';

const releaseScript = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
const commitScript = "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); return 1";
const renewScript = "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end redis.call('PEXPIRE',KEYS[1],15000); return 1";

@Injectable()
export class SkillImportStore {
  private readonly logger = new Logger('SkillImportMetrics');
  private readonly prefix: string;
  constructor(private readonly redis: RedisService, config: ConfigService) {
    this.prefix = `skill-import:v1:${config.get<string>('SKILL_IMPORT_INSTANCE_ID') || 'sep-default'}:`;
  }

  private unavailable(): never {
    this.logger.error(JSON.stringify({ metric: 'skill_import_dependency_error', dependency: 'redis' }));
    throw new ServiceUnavailableException({ code: 'IMPORT_UNAVAILABLE', message: '导入状态服务暂不可用', retryable: true });
  }

  private async bounded<T>(command: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([command, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ServiceUnavailableException({ code: 'IMPORT_UNAVAILABLE', message: '导入状态服务响应超时', retryable: true })), 1000);
        timeout.unref();
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private ttl(value: unknown, fallback = 3_600_000): number {
    const expiry = value && typeof value === 'object' && 'expiresAt' in value ? Date.parse(String(value.expiresAt)) : NaN;
    return Number.isFinite(expiry) ? Math.max(1, expiry + 5 * 60_000 - Date.now()) : fallback;
  }

  async read<T>(key: string): Promise<T | null> {
    try {
      const value = await this.bounded(this.redis.redis.get(this.prefix + key));
      return value === null ? null : JSON.parse(value) as T;
    } catch { return this.unavailable(); }
  }

  async put(key: string, value: unknown, ttlMs = 3_600_000): Promise<void> {
    try { await this.bounded(this.redis.redis.set(this.prefix + key, JSON.stringify(value), 'PX', this.ttl(value, ttlMs))); }
    catch { this.unavailable(); }
  }

  // The fencing check prevents a writer whose lock expired from committing over a newer process.
  async update<T, R>(key: string, mutate: (current: T | null) => Promise<{ state: T; result: R }>): Promise<R> {
    const lockKey = `${this.prefix}lock:${key}`;
    const token = randomBytes(24).toString('base64url');
    let acquired = false;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let leaseLost = false;
    let renewing = false;
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        let result: string | null;
        try { result = await this.bounded(this.redis.redis.set(lockKey, token, 'PX', 15_000, 'NX')); }
        catch { return this.unavailable(); }
        if (result === 'OK') { acquired = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!acquired) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '导入会话正在处理其他请求', retryable: true });
      renewal = setInterval(() => {
        if (renewing || leaseLost) return;
        renewing = true;
        this.bounded(this.redis.redis.eval(renewScript, 1, lockKey, token))
          .then((result) => { if (Number(result) !== 1) leaseLost = true; })
          .catch(() => { leaseLost = true; })
          .finally(() => { renewing = false; });
      }, 4000);
      renewal.unref();
      const current = await this.read<T>(key);
      const { state, result } = await mutate(current);
      if (leaseLost) return this.unavailable();
      let committed: unknown;
      try { committed = await this.bounded(this.redis.redis.eval(commitScript, 2, lockKey, this.prefix + key, token, JSON.stringify(state), this.ttl(state))); }
      catch { return this.unavailable(); }
      if (Number(committed) !== 1) throw new ConflictException({ code: 'OPERATION_CONFLICT', message: '导入状态已变化，请重试', retryable: true });
      return result;
    } finally {
      if (renewal) clearInterval(renewal);
      if (acquired) {
        try { await this.bounded(this.redis.redis.eval(releaseScript, 1, lockKey, token)); } catch { /* The lock has a bounded lease. */ }
      }
    }
  }

  async rate(key: string, limit: number, windowMs: number): Promise<void> {
    let count: number;
    try {
      count = Number(await this.bounded(this.redis.redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end return n", 1, `${this.prefix}rate:${key}`, windowMs)));
    } catch { return this.unavailable(); }
    if (count > limit) throw new HttpException({ code: 'RATE_LIMITED', message: '导入请求过于频繁', retryable: true, retryAfterSeconds: Math.ceil(windowMs / 1000) }, 429);
  }

  async acquireSlot(member: string, deadline: number, concurrency: number): Promise<void> {
    let admitted: unknown;
    try {
      admitted = await this.bounded(this.redis.redis.eval("redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end redis.call('ZADD',KEYS[1],ARGV[3],ARGV[4]); redis.call('PEXPIRE',KEYS[1],600000); return redis.call('ZCARD',KEYS[1])", 1, `${this.prefix}uploads`, Date.now(), concurrency, deadline, member));
    } catch { return this.unavailable(); }
    if (Number(admitted) < 1) throw new HttpException({ code: 'UPLOAD_BUSY', message: '上传处理繁忙，请稍后重试', retryable: true, retryAfterSeconds: 2 }, 429);
    this.logger.log(JSON.stringify({ metric: 'skill_import_upload_slots', occupied: Number(admitted), capacity: concurrency }));
  }

  async releaseSlot(member: string): Promise<void> {
    try {
      const occupied = await this.bounded(this.redis.redis.eval("redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[2]); return redis.call('ZCARD',KEYS[1])", 1, `${this.prefix}uploads`, member, Date.now()));
      this.logger.log(JSON.stringify({ metric: 'skill_import_upload_slots', occupied: Number(occupied) }));
    }
    catch { this.unavailable(); }
  }
}
