import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { GatewayAdmissionService, gatewayAdmissionKeys, GATEWAY_ADMISSION_LEASE_MS,
  GATEWAY_ADMISSION_SCRIPT, GATEWAY_ADMISSION_RELEASE_SCRIPT, GATEWAY_RESOURCE_RESERVE_SCRIPT } from './gateway-admission.service';
import { policySnapshot } from './gateway-policy.test-fixtures';

describe('GatewayAdmissionService', () => {
  const identity = { enterpriseId: 'enterprise', memberId: 'member' };
  const evalMock = jest.fn();
  const service = new GatewayAdmissionService({ redis: { eval: evalMock } } as never);
  beforeEach(() => {
    evalMock.mockReset().mockImplementation((script: string, keyCount: number, ...args: (string | number)[]) => Promise.resolve(
      script === GATEWAY_RESOURCE_RESERVE_SCRIPT ? [1, 0, args[keyCount + 1], 60000, 1060000] : [1, 0, 0, 720000, 1720000],
    ));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('atomically acquires both RPM and concurrency dimensions with a fixed 720s lease', async () => {
    const snapshot = policySnapshot({ GATEWAY_STREAM_TOTAL_TIMEOUT_MS: 1000 });
    const lease = await service.acquire(identity, snapshot);
    const keys = gatewayAdmissionKeys(identity).admission;
    expect(evalMock).toHaveBeenCalledWith(GATEWAY_ADMISSION_SCRIPT, 4, ...keys,
      120, 600, 4, 32, 60000, GATEWAY_ADMISSION_LEASE_MS, expect.any(String));
    const leaseId = evalMock.mock.calls[0].at(-1);
    evalMock.mockResolvedValue(1);
    await Promise.all([lease.release(), lease.release()]);
    await lease.release();
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock).toHaveBeenLastCalledWith(GATEWAY_ADMISSION_RELEASE_SCRIPT, 2, ...keys.slice(2), leaseId, 1720000);
  });

  it.each([
    [1, 'member-rpm', 'enterprise/member', 120], [2, 'enterprise-rpm', 'enterprise', 600],
    [3, 'member-concurrency', 'enterprise/member', 4], [4, 'enterprise-concurrency', 'enterprise', 32],
  ])('reports structured refusal for dimension %i', async (index, rule, dimension, limit) => {
    evalMock.mockResolvedValue([0, index, limit, 1001, 1001001]);
    await expect(service.acquire(identity, policySnapshot())).rejects.toMatchObject({ status: 429, response: {
      retryAfterSeconds: 2, error: { source: 'platform', rule, dimension, limit, count: limit, resetAt: 1001001,
        policyVersion: 7, code: 'PLATFORM_ADMISSION_REJECTED' },
    } });
    expect(evalMock).toHaveBeenCalledTimes(1);
  });

  it('uses the same enterprise buckets across members and never puts identities into keys', () => {
    const a = gatewayAdmissionKeys(identity);
    const b = gatewayAdmissionKeys({ ...identity, memberId: 'other' });
    expect(a.admission[1]).toBe(b.admission[1]);
    expect(a.admission[3]).toBe(b.admission[3]);
    expect(a.reserve).toBe(b.reserve);
    expect(a.admission[0]).not.toBe(b.admission[0]);
    expect(a.admission.every(key => key.includes(a.reserve.match(/\{[^}]+\}/)![0]))).toBe(true);
    expect(a.reserve).not.toContain(identity.enterpriseId + ':');
  });

  it('does not create or inspect a budget bucket while disabled', async () => {
    await service.reserve(identity, policySnapshot(), { messages: [] }, 50);
    await service.reserve(identity, policySnapshot(), { messages: [] }, undefined);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('rejects unknown output reservations when the enterprise resource budget is enabled', async () => {
    await expect(service.reserve(identity, policySnapshot({ GATEWAY_ENTERPRISE_TOKEN_BUDGET: 1000 }), {}, undefined))
      .rejects.toMatchObject({ status: 503, response: { error: {
        code: 'MODEL_RESERVATION_OUTPUT_UNKNOWN', source: 'platform', policyVersion: 7,
      } } });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('reserves complete normalized UTF8 JSON bytes plus output, not just message text', async () => {
    const request = { system: '系统', messages: [{ content: '历史' }], tools: [{ parameters: { field: '描述' } }] };
    await service.reserve(identity, policySnapshot({ GATEWAY_ENTERPRISE_TOKEN_BUDGET: 10000 }), request, 100);
    expect(evalMock).toHaveBeenCalledWith(GATEWAY_RESOURCE_RESERVE_SCRIPT, 1, gatewayAdmissionKeys(identity).reserve,
      10000, Buffer.byteLength(JSON.stringify(request), 'utf8') + 100, 60000);
  });

  it('reports resource rejection without a refund or extra business admission', async () => {
    evalMock.mockResolvedValue([0, 5, 900, 1001, 1001001]);
    await expect(service.reserve(identity, policySnapshot({ GATEWAY_ENTERPRISE_TOKEN_BUDGET: 1000 }), {}, 1000))
      .rejects.toMatchObject({ status: 429, response: { error: {
        rule: 'enterprise-resource-budget', limit: 1000, count: 900, policyVersion: 7,
      } } });
    expect(evalMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], [1, 0, 0, 0, 0], [0, 0, 0, 100, 100], ['1', 0, 0, 1, 1]].map(result => ({ result })))(
    'fails closed for malformed Redis reply $result', async ({ result }) => {
      evalMock.mockResolvedValue(result);
      await expect(service.acquire(identity, policySnapshot())).rejects.toMatchObject({ status: 503 });
    },
  );

  it('fails closed and retains Redis causes after credential redaction', async () => {
    evalMock.mockRejectedValue(Object.assign(new Error('Redis AUTH failed password=redis-secret'), { code: 'WRONGPASS' }));
    for (const operation of [() => service.acquire(identity, policySnapshot()),
      () => service.reserve(identity, policySnapshot({ GATEWAY_ENTERPRISE_TOKEN_BUDGET: 1000 }), {}, 10)]) {
      const error = await operation().catch(error => error);
      expect(error).toMatchObject({ status: 503, response: { error: {
        source: 'platform', code: 'PLATFORM_ADMISSION_UNAVAILABLE', policyVersion: 7,
        cause: { code: 'WRONGPASS', message: 'Redis AUTH failed password=[REDACTED]' },
      } } });
      expect(JSON.stringify(error.getResponse())).not.toContain('redis-secret');
    }
  });

  it('logs a failed release without masking the upstream outcome or leaking Redis details', async () => {
    const lease = await service.acquire(identity, policySnapshot());
    evalMock.mockRejectedValueOnce(new Error('Redis AUTH failed password=redis-secret'));
    await expect(lease.release()).resolves.toBeUndefined();
    await lease.release();
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('gateway_admission_release_failed'));
    expect(JSON.stringify((Logger.prototype.error as jest.Mock).mock.calls)).not.toContain('redis-secret');
  });

  it('preserves main raw identity hashes and token bucket names across deployments', () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const prefix = `sep:gateway:admission:v1:{${hash(identity.enterpriseId)}}`;
    expect(gatewayAdmissionKeys(identity)).toEqual({
      admission: [`${prefix}:rpm:member:${hash(identity.memberId)}`, `${prefix}:rpm:enterprise`,
        `${prefix}:concurrency:member:${hash(identity.memberId)}`, `${prefix}:concurrency:enterprise`],
      reserve: `${prefix}:tokens:enterprise`,
    });
  });

  it('aggregates across users and subscriptions, but isolates enterprise identities', async () => {
    await service.acquire({ ...identity, sub: 'user', subscriptionId: 'sub' } as typeof identity, policySnapshot());
    await service.acquire({ ...identity, sub: 'other', subscriptionId: 'other' } as typeof identity, policySnapshot());
    expect(evalMock.mock.calls[0].slice(2, 6)).toEqual(evalMock.mock.calls[1].slice(2, 6));
    const other = gatewayAdmissionKeys({ ...identity, enterpriseId: 'other' });
    expect(other.admission.every((key, i) => key !== gatewayAdmissionKeys(identity).admission[i])).toBe(true);
  });

  it('uses snapshot limits but never derives lease duration from configured request timeouts', async () => {
    await service.acquire(identity, policySnapshot({ GATEWAY_MEMBER_RPM: 140, GATEWAY_ENTERPRISE_RPM: 800,
      GATEWAY_MEMBER_CONCURRENCY: 7, GATEWAY_ENTERPRISE_CONCURRENCY: 50, GATEWAY_NON_STREAM_TIMEOUT_MS: 1000 }));
    expect(evalMock.mock.calls[0].slice(6, -1)).toEqual([140, 800, 7, 50, 60000, 720000]);
  });

  it('preserves Retry-After and structured metadata through the HTTP filter', async () => {
    evalMock.mockResolvedValue([0, 1, 120, 44001, 1044001]);
    const failure = await service.acquire(identity, policySnapshot()).catch(error => error);
    expect(failure).toBeInstanceOf(HttpException);
    const response = { getHeader: jest.fn(), getHeaders: jest.fn().mockReturnValue({}), setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => response,
      getRequest: () => ({ originalUrl: '/api/gateway/v1/chat/completions', requestId: 'request-1' }) }) } as ArgumentsHost;
    new HttpExceptionFilter().catch(failure, host);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '45');
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({
      code: 'PLATFORM_ADMISSION_REJECTED', source: 'platform',
      rateLimit: expect.objectContaining({ rule: 'member-rpm', windowMs: 60000, policyVersion: 7 }),
    }) }));
  });

  it.each([null, [], [1, 0, 0, 720000], ['1', 0, 0, 720000, 1720000], [2, 0, 0, 720000, 1720000],
    [1, 0, 0, -1, 1720000], [1, 0, 0, 1, 1720000], [1, 1, 0, 720000, 1720000], [1, 0, 1, 720000, 1720000],
    [0, 0, 1, 1000, 1000000], [0, 6, 1, 1000, 1000000], [0, 1, -1, 1000, 1000000],
    [0, 1, 1, 1000, NaN], [0, 1, 1, 1000, 1], [0, 5, 0, 1000, 1000000], [-1, 0, 0, 0, 0],
  ].map(result => ({ result })))('rejects malformed acquisition responses and duplicate server IDs $result', async ({ result }) => {
    evalMock.mockResolvedValue(result);
    await expect(service.acquire(identity, policySnapshot())).rejects.toMatchObject({ status: 503 });
  });

  it.each([[0, 1, 0, 1000, 1000000], [1, 5, 10, 1000, 1000000], [1, 0, -1, 1000, 1000000],
    [1, 0, 0, 1000, 1000000], [1, 0, 1001, 1000, 1000000], [1, 0, 12, 60001, 1000000]])(
    'rejects replies from the wrong reservation operation %p', async (...result) => {
      evalMock.mockResolvedValue(result);
      await expect(service.reserve(identity, policySnapshot({ GATEWAY_ENTERPRISE_TOKEN_BUDGET: 1000 }), {}, 10))
        .rejects.toMatchObject({ status: 503 });
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid output reservations %p before Redis', async output => {
    await expect(service.reserve(identity, policySnapshot({ GATEWAY_ENTERPRISE_TOKEN_BUDGET: 1000 }), {}, output))
      .rejects.toMatchObject({ status: 400 });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('rejects unserializable reservations without exposing the body', async () => {
    const circular: Record<string, unknown> = { content: 'private prompt' };
    circular.self = circular;
    for (const body of [undefined, circular, 1n]) {
      const error = await service.reserve(identity, policySnapshot({ GATEWAY_ENTERPRISE_TOKEN_BUDGET: 1000 }), body, 10)
        .catch(error => error);
      expect(error).toMatchObject({ status: 400, response: { error: { code: 'INVALID_MODEL_RESERVATION' } } });
      expect(JSON.stringify(error.getResponse())).not.toContain('private');
    }
    expect(evalMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity])('fails closed on an invalid snapshot admission limit %p', async limit => {
    await expect(service.acquire(identity, policySnapshot({ GATEWAY_MEMBER_RPM: limit })))
      .rejects.toMatchObject({ status: 503 });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])('accepts idempotent or partially expired release counts %i', async removed => {
    const lease = await service.acquire(identity, policySnapshot());
    evalMock.mockResolvedValue(removed);
    await lease.release();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it.each([undefined, '2', -1, 3])('logs invalid release result %p without masking outcomes', async result => {
    const lease = await service.acquire(identity, policySnapshot());
    evalMock.mockResolvedValue(result);
    await expect(lease.release()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('gateway_admission_release_failed'));
  });
});
