import { BadRequestException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatCompletionRequest, ModelRuntimePolicySnapshot } from 'shared';
import { RedisService } from '../../redis/redis.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

export const GATEWAY_ADMISSION_LEASE_MS = 720_000;
const WINDOW_MS = 60_000;

// Corrupt or persistent counters must never be reset into fresh budgets.
const COUNTER_SCRIPT = `
local function counter(key)
  local raw = redis.call('GET', key)
  if not raw then return 0, window end
  local count = tonumber(raw)
  local ttl = redis.call('PTTL', key)
  if not string.match(raw, '^%d+$') or (string.len(raw) > 1 and string.sub(raw, 1, 1) == '0') or
      not count or count < 0 or count >= 9007199254740991 or count ~= math.floor(count) or ttl < 0 then
    error('Invalid gateway admission counter')
  end
  return count, math.max(1, ttl)
end
`;

// Check every dimension before committing either RPM or the two concurrency leases.
export const GATEWAY_ADMISSION_SCRIPT = `
local window = tonumber(ARGV[5])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
${COUNTER_SCRIPT}
local counts = {}
local ttls = {}
for i = 3, 4 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZSCORE', KEYS[i], ARGV[7]) then return {-1, 0, 0, 0, 0} end
end
for i = 1, 2 do
  counts[i], ttls[i] = counter(KEYS[i])
end
for i = 1, 2 do
  if counts[i] >= tonumber(ARGV[i]) then
    return {0, i, counts[i], ttls[i], now + ttls[i]}
  end
end
for i = 3, 4 do
  counts[i] = redis.call('ZCARD', KEYS[i])
  if counts[i] >= tonumber(ARGV[i]) then
    local first = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local ttl = math.max(1, tonumber(first[2]) - now)
    return {0, i, counts[i], ttl, now + ttl}
  end
end
for i = 1, 2 do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    redis.call('SET', KEYS[i], 1, 'PX', ARGV[5])
  else
    redis.call('INCR', KEYS[i])
  end
end
for i = 3, 4 do
  redis.call('ZADD', KEYS[i], now + tonumber(ARGV[6]), ARGV[7])
  local last = redis.call('ZRANGE', KEYS[i], -1, -1, 'WITHSCORES')
  redis.call('PEXPIREAT', KEYS[i], tonumber(last[2]))
end
return {1, 0, 0, tonumber(ARGV[6]), now + tonumber(ARGV[6])}
`;

// Match both owner and deadline so late cleanup cannot remove a replacement lease.
export const GATEWAY_ADMISSION_RELEASE_SCRIPT = `
local removed = 0
for i = 1, 2 do
  local deadline = redis.call('ZSCORE', KEYS[i], ARGV[1])
  if deadline and tonumber(deadline) == tonumber(ARGV[2]) then
    removed = removed + redis.call('ZREM', KEYS[i], ARGV[1])
  end
end
return removed
`;

export const GATEWAY_RESOURCE_RESERVE_SCRIPT = `
local window = tonumber(ARGV[3])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
${COUNTER_SCRIPT}
local count, ttl = counter(KEYS[1])
local amount = tonumber(ARGV[2])
if amount > tonumber(ARGV[1]) - count then
  return {0, 5, count, ttl, now + ttl}
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], amount, 'PX', ARGV[3])
  ttl = tonumber(ARGV[3])
else
  redis.call('INCRBY', KEYS[1], amount)
end
return {1, 0, count + amount, ttl, now + ttl}
`;

export interface GatewayAdmissionIdentity {
  enterpriseId: string;
  memberId: string;
}
export interface GatewayAdmissionLease {
  release(): Promise<void>;
}

export type GatewayAdmissionRequest = ChatCompletionRequest & { requestId?: string };

// Enterprise hash tag also keeps every multi-key Lua operation in one Redis Cluster slot.
export function gatewayAdmissionKeys(identity: GatewayAdmissionIdentity) {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const base = `sep:gateway:admission:v1:{${hash(identity.enterpriseId)}}`;
  const member = hash(identity.memberId);
  return {
    admission: [`${base}:rpm:member:${member}`, `${base}:rpm:enterprise`,
      `${base}:concurrency:member:${member}`, `${base}:concurrency:enterprise`],
    reserve: `${base}:tokens:enterprise`,
  };
}

@Injectable()
export class GatewayAdmissionService {
  private readonly logger = new Logger(GatewayAdmissionService.name);
  constructor(private readonly redisService: RedisService) {}

  async acquire(identity: GatewayAdmissionIdentity, snapshot: ModelRuntimePolicySnapshot): Promise<GatewayAdmissionLease> {
    const keys = gatewayAdmissionKeys(identity).admission;
    const leaseId = randomUUID();
    const limits = [snapshot.values.GATEWAY_MEMBER_RPM, snapshot.values.GATEWAY_ENTERPRISE_RPM,
      snapshot.values.GATEWAY_MEMBER_CONCURRENCY, snapshot.values.GATEWAY_ENTERPRISE_CONCURRENCY];
    const result = await this.evaluate(GATEWAY_ADMISSION_SCRIPT, keys,
      [...limits, WINDOW_MS, GATEWAY_ADMISSION_LEASE_MS, leaseId], snapshot);
    this.assertAllowed(result, limits, snapshot);
    let release: Promise<void> | undefined;
    return {
      release: () => {
        release ??= this.release(keys.slice(2), leaseId, result[4], snapshot);
        return release;
      },
    };
  }

  async reserve(
    identity: GatewayAdmissionIdentity, snapshot: ModelRuntimePolicySnapshot,
    normalizedRequest: unknown, maxOutputTokens: number | undefined,
  ): Promise<void> {
    const limit = snapshot.values.GATEWAY_ENTERPRISE_TOKEN_BUDGET;
    if (limit === 0) return;
    if (maxOutputTokens === undefined) {
      throw new ServiceUnavailableException({ error: {
        message: '企业资源预留需要明确输出预算，请配置默认输出数量或平台输出上限',
        type: 'server_error', code: 'MODEL_RESERVATION_OUTPUT_UNKNOWN', source: 'platform',
        policyVersion: snapshot.version,
      } });
    }
    let serialized: string | undefined;
    try { serialized = JSON.stringify(normalizedRequest); } catch { /* Invalid request is rejected below. */ }
    const amount = serialized === undefined ? NaN : Buffer.byteLength(serialized, 'utf8') + maxOutputTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || !Number.isSafeInteger(amount) || amount <= 0) {
      throw new BadRequestException({ error: { message: '模型资源预留请求无效', type: 'invalid_request_error',
        code: 'INVALID_MODEL_RESERVATION', source: 'platform', policyVersion: snapshot.version } });
    }
    const result = await this.evaluate(GATEWAY_RESOURCE_RESERVE_SCRIPT,
      [gatewayAdmissionKeys(identity).reserve], [limit, amount, WINDOW_MS], snapshot);
    this.assertAllowed(result, [0, 0, 0, 0, limit], snapshot);
  }

  private async release(keys: string[], leaseId: string, deadline: number, snapshot: ModelRuntimePolicySnapshot): Promise<void> {
    try {
      const result: unknown = await this.redisService.redis.eval(GATEWAY_ADMISSION_RELEASE_SCRIPT, keys.length, ...keys, leaseId, deadline);
      if (typeof result !== 'number' || !Number.isInteger(result) || result < 0 || result > 2) {
        throw new ServiceUnavailableException();
      }
    } catch (error) {
      // Cleanup must not mask the upstream outcome; bounded leases recover after outages.
      this.logger.error(JSON.stringify({ event: 'gateway_admission_release_failed', executionId: leaseId,
        policyVersion: snapshot.version, diagnostic: exceptionDetails(error) }));
    }
  }

  private async evaluate(script: string, keys: string[], args: (number | string)[], snapshot: ModelRuntimePolicySnapshot): Promise<number[]> {
    try {
      const admission = script === GATEWAY_ADMISSION_SCRIPT;
      const limits = admission ? args.slice(0, 4) : args.slice(0, 2);
      if (!limits.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
        throw new ServiceUnavailableException('Gateway admission limits must be positive safe integers');
      }
      const result = await this.redisService.redis.eval(script, keys.length, ...keys, ...args);
      if (!Array.isArray(result) || result.length !== 5 || !result.every(Number.isSafeInteger) ||
          ![0, 1].includes(result[0]) || result[2] < 0 || result[3] <= 0 || result[4] <= result[3] ||
          (result[0] === 1 ? result[1] !== 0 || (admission
            ? result[2] !== 0 || result[3] !== GATEWAY_ADMISSION_LEASE_MS
            : result[2] < Number(args[1]) || result[2] > Number(args[0]) || result[3] > WINDOW_MS)
            : admission ? result[1] < 1 || result[1] > 4 : result[1] !== 5)) {
        throw new ServiceUnavailableException({ message: 'Gateway admission returned an invalid Redis result', details: result });
      }
      return result;
    } catch (error) { throw this.unavailable(snapshot, error); }
  }

  private assertAllowed(result: number[], limits: number[], snapshot: ModelRuntimePolicySnapshot): void {
    if (result[0] === 1) return;
    const [, index, count, ttl, resetAt] = result;
    const rules = ['member-rpm', 'enterprise-rpm', 'member-concurrency', 'enterprise-concurrency', 'enterprise-resource-budget'];
    const rule = rules[index - 1];
    const dimension = index === 1 || index === 3 ? 'enterprise/member' : 'enterprise';
    const retryAfterSeconds = Math.ceil(ttl / 1000);
    const rateLimit = { rule, dimension, limit: limits[index - 1], count, resetAt,
      retryAfterSeconds, policyVersion: snapshot.version,
      windowMs: index === 3 || index === 4 ? GATEWAY_ADMISSION_LEASE_MS : WINDOW_MS };
    this.logger.warn(JSON.stringify({ event: 'gateway_admission_rejected', ...rateLimit }));
    throw new HttpException({ error: { message: '模型请求达到平台运行策略限制', type: 'rate_limit_error',
      code: 'PLATFORM_ADMISSION_REJECTED', source: 'platform', param: null, ...rateLimit, rateLimit }, retryAfterSeconds }, 429);
  }

  private unavailable(snapshot: ModelRuntimePolicySnapshot, error?: unknown): ServiceUnavailableException {
    this.logger.error(JSON.stringify({ event: 'gateway_admission_unavailable', policyVersion: snapshot.version }));
    return new ServiceUnavailableException({ error: { message: '模型准入服务暂不可用，请稍后重试',
      type: 'server_error', code: 'PLATFORM_ADMISSION_UNAVAILABLE', source: 'platform', policyVersion: snapshot.version,
      ...(error !== undefined ? { cause: exceptionDetails(error) } : {}) } });
  }
}
