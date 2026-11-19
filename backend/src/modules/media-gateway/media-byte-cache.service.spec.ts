import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '../../redis/redis.service';
import {
  MediaByteCacheService, OUTPUT_CACHE_TTL_SECONDS, REFERENCE_CACHE_TTL_SECONDS,
} from './media-byte-cache.service';

type Kind = 'reference' | 'output';
const START = Date.parse('2026-10-15T08:00:00.000Z');
const SCOPE = 'enterprise-private:member-private:subscription-private';
const ID = 'image_private-1';
const BYTES = Buffer.from([0, 255, 128, 10, 0, 194, 169]);
const policies = [
  { kind: 'reference' as const, ttl: 900, budget: 5 * 1024 * 1024,
    invalid: 'INVALID_REFERENCE', invalidStatus: 400, expired: 'REFERENCE_EXPIRED' },
  { kind: 'output' as const, ttl: 86400, budget: 25 * 1024 * 1024,
    invalid: 'OUTPUT_FAILED', invalidStatus: 502, expired: 'RESULT_EXPIRED' },
];

function metadata(bytes = BYTES, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, expiresAt };
}

async function expectError(action: Promise<unknown>, status: number, code: string) {
  const error = await action.then(() => { throw new Error('Expected cache failure'); }, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(status);
  expect(exception.getResponse()).toMatchObject({ error: {
    code, type: status >= 500 ? 'server_error' : 'invalid_request_error', source: 'platform', param: null,
  } });
  return exception;
}

describe('MediaByteCacheService', () => {
  let entries: Map<string, { bytes: Buffer; expiresAt: number }>;
  let client: { set: jest.Mock; getBuffer: jest.Mock };
  let service: MediaByteCacheService;

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    entries = new Map();
    client = {
      set: jest.fn(async (key: string, bytes: Buffer, _px: string, ttl: number, _nx: string) => {
        const existing = entries.get(key);
        if (existing && existing.expiresAt > Date.now()) return null;
        entries.set(key, { bytes: Buffer.from(bytes), expiresAt: Date.now() + ttl });
        return 'OK';
      }),
      getBuffer: jest.fn(async (key: string) => {
        const entry = entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
          entries.delete(key);
          return null;
        }
        return Buffer.from(entry.bytes);
      }),
    };
    service = new MediaByteCacheService({ redis: client } as unknown as RedisService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('exports the reference and output TTL contracts', () => {
    expect(REFERENCE_CACHE_TTL_SECONDS).toBe(900);
    expect(OUTPUT_CACHE_TTL_SECONDS).toBe(86400);
  });

  it('uses the real clock to send only the remaining lifetime in milliseconds', async () => {
    jest.useRealTimers();
    const expiresAtMs = Date.now() + 60_000;
    let writtenAt = 0;
    client.set.mockImplementationOnce(async () => { writtenAt = Date.now(); return 'OK'; });
    const before = Date.now();
    await service.put('reference', SCOPE, ID, BYTES, new Date(expiresAtMs).toISOString());
    const ttl = client.set.mock.calls[0][3] as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(expiresAtMs - before);
    expect(ttl).toBeGreaterThanOrEqual(expiresAtMs - writtenAt);
  });

  it('isolates scopes, IDs and kinds with hashed keys and an unambiguous tuple', async () => {
    const expected = metadata();
    const tuples: [Kind, string, string][] = [
      ['reference', SCOPE, ID], ['reference', `${SCOPE}-other`, ID],
      ['reference', SCOPE, `${ID}-other`], ['output', SCOPE, ID],
      ['reference', 'a', 'bc'], ['reference', 'ab', 'c'],
      ['reference', 'a:b', 'c'], ['reference', 'a', 'b_c'],
    ];
    for (const [kind, scope, id] of tuples) {
      await service.put(kind, scope, id, BYTES, expected.expiresAt);
    }
    const keys = client.set.mock.calls.map(([key]) => key as string);
    expect(new Set(keys).size).toBe(tuples.length);
    for (const key of keys) {
      expect(key).toMatch(/^sep:media:bytes:(reference|output):[a-f0-9]{64}$/);
      expect(key).not.toContain(SCOPE);
      expect(key).not.toContain(ID);
    }
    await expectError(service.get('reference', `${SCOPE}-missing`, ID, expected), 410, 'REFERENCE_EXPIRED');
    for (const [kind, scope, id] of tuples) {
      expect(await service.get(kind, scope, id, expected)).toEqual(BYTES);
    }
  });

  describe.each(policies)('$kind bytes', ({ kind, ttl, budget, invalid, invalidStatus, expired }) => {
    it('stores the original binary buffer with PX and NX, then reads with getBuffer', async () => {
      const expected = metadata();
      await service.put(kind, SCOPE, ID, BYTES, expected.expiresAt);
      expect(client.set).toHaveBeenCalledWith(expect.any(String), BYTES, 'PX', 60_000, 'NX');
      const result = await service.get(kind, SCOPE, ID, expected);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(BYTES);
      expect(client.getBuffer).toHaveBeenCalledWith(client.set.mock.calls[0][0]);
      expect(await service.get(kind, SCOPE, ID, { ...expected, sha256: expected.sha256.toUpperCase() })).toEqual(BYTES);
    });

    it('does not overwrite bytes or renew TTL on duplicate or concurrent puts', async () => {
      const expected = metadata();
      await service.put(kind, SCOPE, ID, BYTES, expected.expiresAt);
      jest.setSystemTime(START + 10_000);
      const replacement = Buffer.from('replacement');
      const later = new Date(Date.now() + 120_000).toISOString();
      await Promise.all([
        service.put(kind, SCOPE, ID, replacement, later),
        service.put(kind, SCOPE, ID, Buffer.from('another replacement'), later),
      ]);
      expect(entries.size).toBe(1);
      expect([...entries.values()][0]).toEqual({ bytes: BYTES, expiresAt: START + 60_000 });
      expect(await service.get(kind, SCOPE, ID, expected)).toEqual(BYTES);
      jest.setSystemTime(START + 60_000);
      await expectError(service.get(kind, SCOPE, ID, metadata(BYTES, later)), 410, expired);
      expect(entries.size).toBe(0);
    });

    it('accepts the exact TTL and rejects a deadline 1ms beyond it', async () => {
      const exact = new Date(START + ttl * 1000).toISOString();
      await service.put(kind, SCOPE, ID, BYTES, exact);
      expect(client.set.mock.calls[0][3]).toBe(ttl * 1000);
      expect(await service.get(kind, SCOPE, ID, metadata(BYTES, exact))).toEqual(BYTES);
      const tooLate = new Date(START + ttl * 1000 + 1).toISOString();
      await expectError(service.put(kind, SCOPE, ID, BYTES, tooLate), invalidStatus, invalid);
      await expectError(service.get(kind, SCOPE, ID, metadata(BYTES, tooLate)), invalidStatus, invalid);
      expect(client.set).toHaveBeenCalledTimes(1);
      expect(client.getBuffer).toHaveBeenCalledTimes(1);
    });

    it('uses the remaining TTL after elapsed time rather than the full policy TTL', async () => {
      const expiresAt = new Date(START + ttl * 1000).toISOString();
      jest.setSystemTime(START + 1234);
      await service.put(kind, SCOPE, ID, BYTES, expiresAt);
      expect(client.set.mock.calls[0][3]).toBe(ttl * 1000 - 1234);
    });

    it('accepts 1ms remaining and rejects at the exact deadline even when Redis retains bytes', async () => {
      const expected = metadata(BYTES, new Date(START + 1).toISOString());
      await service.put(kind, SCOPE, ID, BYTES, expected.expiresAt);
      expect(client.set.mock.calls[0][3]).toBe(1);
      expect(await service.get(kind, SCOPE, ID, expected)).toEqual(BYTES);
      jest.setSystemTime(START + 1);
      client.getBuffer.mockResolvedValue(BYTES);
      await expectError(service.get(kind, SCOPE, ID, expected), 410, expired);
      await expectError(service.put(kind, SCOPE, ID, BYTES, expected.expiresAt), 410, expired);
      expect(client.getBuffer).toHaveBeenCalledTimes(1);
      expect(client.set).toHaveBeenCalledTimes(1);
    });

    it('rejects a past deadline before touching Redis', async () => {
      const expected = metadata(BYTES, new Date(START - 1).toISOString());
      await expectError(service.put(kind, SCOPE, ID, BYTES, expected.expiresAt), 410, expired);
      await expectError(service.get(kind, SCOPE, ID, expected), 410, expired);
      expect(client.set).not.toHaveBeenCalled();
      expect(client.getBuffer).not.toHaveBeenCalled();
    });

    it('rejects a read that reaches the deadline while waiting for Redis', async () => {
      const expected = metadata(BYTES, new Date(START + 1).toISOString());
      client.getBuffer.mockImplementationOnce(async () => {
        jest.setSystemTime(START + 1);
        return BYTES;
      });
      await expectError(service.get(kind, SCOPE, ID, expected), 410, expired);
    });

    it('rejects a read that reaches the deadline while hashing bytes', async () => {
      const expected = metadata(BYTES, new Date(START + 1).toISOString());
      client.getBuffer.mockResolvedValueOnce(BYTES);
      jest.spyOn(Date, 'now').mockReturnValueOnce(START).mockReturnValueOnce(START).mockReturnValue(START + 1);
      await expectError(service.get(kind, SCOPE, ID, expected), 410, expired);
    });

    it('maps an absent entry to the fixed expiry error', async () => {
      await expectError(service.get(kind, SCOPE, ID, metadata()), 410, expired);
    });

    it('enforces nonempty bytes and the exact byte budget for writes and reads', async () => {
      const bytes = Buffer.alloc(budget, 0xff);
      const expected = metadata(bytes);
      await service.put(kind, SCOPE, ID, bytes, expected.expiresAt);
      expect((await service.get(kind, SCOPE, ID, expected)).length).toBe(budget);
      for (const bad of [Buffer.alloc(0), Buffer.alloc(budget + 1), 'not a buffer' as unknown as Buffer]) {
        await expectError(service.put(kind, SCOPE, ID, bad, expected.expiresAt), invalidStatus, invalid);
      }
      for (const byteLength of [0, -1, 1.5, NaN, Infinity, budget + 1]) {
        await expectError(service.get(kind, SCOPE, ID, { ...expected, byteLength }), invalidStatus, invalid);
      }
      expect(client.set).toHaveBeenCalledTimes(1);
      expect(client.getBuffer).toHaveBeenCalledTimes(1);
    });

    it.each(['same-length corruption', 'truncated bytes', 'empty bytes', 'string value'])(
      'rejects %s without returning cached content', async (damage) => {
        const expected = metadata();
        const corrupt = Buffer.from(BYTES);
        corrupt[0] ^= 0xff;
        const stored = {
          'same-length corruption': corrupt, 'truncated bytes': BYTES.subarray(1),
          'empty bytes': Buffer.alloc(0), 'string value': BYTES.toString('hex'),
        }[damage];
        client.getBuffer.mockResolvedValueOnce(stored);
        await expectError(service.get(kind, SCOPE, ID, expected), invalidStatus, invalid);
      },
    );

    it('rejects incorrect expected hashes and lengths', async () => {
      const expected = metadata();
      await service.put(kind, SCOPE, ID, BYTES, expected.expiresAt);
      await expectError(service.get(kind, SCOPE, ID, { ...expected, sha256: '0'.repeat(64) }), invalidStatus, invalid);
      await expectError(service.get(kind, SCOPE, ID, { ...expected, byteLength: BYTES.length + 1 }), invalidStatus, invalid);
      for (const sha256 of ['', '0'.repeat(63), 'z'.repeat(64)]) {
        await expectError(service.get(kind, SCOPE, ID, { ...expected, sha256 }), invalidStatus, invalid);
      }
      expect(client.getBuffer).toHaveBeenCalledTimes(2);
    });

    it.each(['', '../image', 'a:b', 'with space', 'a'.repeat(129), '图像', 'id\n'])(
      'rejects invalid ID %j before contacting Redis', async (id) => {
        const expected = metadata();
        await expectError(service.put(kind, SCOPE, id, BYTES, expected.expiresAt), invalidStatus, invalid);
        await expectError(service.get(kind, SCOPE, id, expected), invalidStatus, invalid);
        expect(client.set).not.toHaveBeenCalled();
        expect(client.getBuffer).not.toHaveBeenCalled();
      },
    );

    it('accepts IDs up to the shared 128-character limit', async () => {
      const expected = metadata();
      const id = 'a'.repeat(126) + '_-';
      await service.put(kind, SCOPE, id, BYTES, expected.expiresAt);
      expect(await service.get(kind, SCOPE, id, expected)).toEqual(BYTES);
    });

    it.each(['', '   ', null, undefined])('rejects invalid scope %j', async (scope) => {
      const expected = metadata();
      await expectError(service.put(kind, scope as string, ID, BYTES, expected.expiresAt), invalidStatus, invalid);
      await expectError(service.get(kind, scope as string, ID, expected), invalidStatus, invalid);
      expect(client.set).not.toHaveBeenCalled();
      expect(client.getBuffer).not.toHaveBeenCalled();
    });

    it.each(['', 'not-a-date', '2026-02-30T00:00:00Z', '2026-10-15', null, undefined])(
      'rejects malformed expiry %j before Redis access', async (expiresAt) => {
        await expectError(service.put(kind, SCOPE, ID, BYTES, expiresAt as string), invalidStatus, invalid);
        await expectError(service.get(kind, SCOPE, ID, { ...metadata(), expiresAt: expiresAt as string }), invalidStatus, invalid);
        expect(client.set).not.toHaveBeenCalled();
        expect(client.getBuffer).not.toHaveBeenCalled();
      },
    );

    it('accepts an ISO expiry with an explicit timezone offset', async () => {
      const expected = metadata(BYTES, '2026-10-15T16:01:00.000+08:00');
      await service.put(kind, SCOPE, ID, BYTES, expected.expiresAt);
      expect(client.set.mock.calls[0][3]).toBe(60_000);
      expect(await service.get(kind, SCOPE, ID, expected)).toEqual(BYTES);
    });

    it.each(['put', 'get'] as const)('sanitizes Redis connection failures during %s', async (operation) => {
      const secret = 'redis://user:private-password@private-host:6379/0';
      const detail = Object.assign(new Error(`WRONGPASS invalid username-password pair at ${secret}`), { code: 'WRONGPASS' });
      const logger = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const expected = metadata();
      if (operation === 'put') client.set.mockRejectedValueOnce(detail);
      else client.getBuffer.mockRejectedValueOnce(detail);
      const action = operation === 'put'
        ? service.put(kind, SCOPE, ID, BYTES, expected.expiresAt)
        : service.get(kind, SCOPE, ID, expected);
      const error = await expectError(action, 503, 'MEDIA_STORAGE_UNAVAILABLE');
      expect(error.getResponse()).toEqual({ message: '媒体存储暂不可用', error: {
        code: 'MEDIA_STORAGE_UNAVAILABLE', message: '媒体存储暂不可用',
        type: 'server_error', source: 'platform', param: null,
        cause: { name: 'Error', code: 'WRONGPASS', message: 'WRONGPASS invalid username-password pair at [REDACTED]' },
      } });
      const serialized = JSON.stringify(error) + error.stack;
      for (const privateValue of [secret, SCOPE, ID, BYTES.toString('hex'), detail.message]) {
        expect(serialized).not.toContain(privateValue);
      }
      expect(error.cause).toBeUndefined();
      expect(logger).not.toHaveBeenCalled();
    });
  });

  it('sanitizes synchronous errors while obtaining the Redis client', async () => {
    const redis = { get redis(): never { throw new Error('private redis credentials'); } };
    service = new MediaByteCacheService(redis as unknown as RedisService);
    const expected = metadata();
    await expectError(service.put('reference', SCOPE, ID, BYTES, expected.expiresAt), 503, 'MEDIA_STORAGE_UNAVAILABLE');
    await expectError(service.get('output', SCOPE, ID, expected), 503, 'MEDIA_STORAGE_UNAVAILABLE');
  });
});
