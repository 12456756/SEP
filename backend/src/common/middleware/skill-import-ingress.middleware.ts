import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type Redis from 'ioredis';

type Settings = { enabled: boolean; instanceId: string; redisTimeoutMs?: number };

// A single atomic counter is shared by all API replicas. Identity-specific limits
// are applied again after authentication; this layer runs before body parsing.
const CONSUME = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

export function createSkillImportIngressMiddleware(
  getRedis: () => Pick<Redis, 'eval'>,
  settings: Settings,
): RequestHandler {
  return async (req, res, next) => {
    const path = req.path.toLowerCase();
    if (!/^\/api\/skill-import(?:\/|$)/.test(path)) return next();
    if (req.method === 'OPTIONS') return next();
    const configRequest = req.method === 'GET' && /^\/api\/skill-import\/config\/?$/.test(path);
    const cleanupRequest = req.method === 'DELETE' && /^\/api\/skill-import\/(?:sessions|devices)\/[a-z0-9_-]{1,160}\/?$/.test(path)
      || req.method === 'POST' && /^\/api\/skill-import\/connector\/devices\/[a-z0-9_-]{1,160}\/revoke\/?$/.test(path);
    if (!settings.enabled && !configRequest && !cleanupRequest) {
      res.status(503).json({ statusCode: 503, message: '本机扫描尚未开放', code: 'IMPORT_DISABLED',
        requestId: res.getHeader('x-request-id'), timestamp: new Date().toISOString(), path: req.path });
      return;
    }
    if (configRequest) return next();

    const isEvent = req.method === 'POST' && /^\/api\/skill-import\/connector\/sessions\/[a-z0-9_-]{1,160}\/events\/?$/.test(path);
    const isPackage = req.method === 'POST' && /^\/api\/skill-import\/connector\/sessions\/[a-z0-9_-]{1,160}\/package\/?$/.test(path);
    const byteLimit = (isEvent ? 16 : isPackage ? 101 : 2) * 1024 * 1024;
    const contentLength = req.headers['content-length'];
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > byteLimit)) {
      res.status(413).json({ statusCode: 413, message: '请求体超过 HTTP 解析上限', code: 'REQUEST_BODY_TOO_LARGE',
        requestId: res.getHeader('x-request-id'), timestamp: new Date().toISOString(), path: req.path });
      return;
    }

    const group = /\/(?:pairings|challenges)\/?$/.test(path) ? 'proof'
      : /\/grants\/?$/.test(path) ? 'grants'
        : isEvent ? 'events' : /\/(?:cancel|revoke)\/?$/.test(path) || req.method === 'DELETE' ? 'cancel' : 'general';
    const limit = { proof: 20, grants: 40, events: 120, cancel: 60, general: 300 }[group];
    const ip = createHash('sha256').update(req.ip || req.socket.remoteAddress || 'unknown').digest('hex');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        getRedis().eval(CONSUME, 1, `skill-import:v1:${settings.instanceId}:ingress:${group}:${ip}`, 60_000),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Redis ingress timeout')), settings.redisTimeoutMs ?? 1000);
        }),
      ]);
      const [count, remainingMs] = result as [number, number];
      if (count > limit) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(remainingMs / 1000))));
        res.status(429).json({ statusCode: 429, message: '请求过于频繁，请稍后重试', code: 'RATE_LIMITED', retryable: true,
          requestId: res.getHeader('x-request-id'), timestamp: new Date().toISOString(), path: req.path });
        return;
      }
      next();
    } catch {
      res.status(503).json({ statusCode: 503, message: '本机扫描暂不可用', code: 'IMPORT_UNAVAILABLE', retryable: true,
        requestId: res.getHeader('x-request-id'), timestamp: new Date().toISOString(), path: req.path });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
