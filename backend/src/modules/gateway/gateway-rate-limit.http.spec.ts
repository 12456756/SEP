import { Controller, ForbiddenException, Get, INestApplication, Logger, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { ChatCompletionRequest } from 'shared';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { GatewayLifecycleService } from '../../common/lifecycle/gateway-lifecycle.service';
import { basicRateLimitMiddleware } from '../../common/middleware/basic-rate-limit.middleware';
import { requestContextMiddleware } from '../../common/middleware/request-context.middleware';
import { RedisService } from '../../redis/redis.service';
import { SecurityModule } from '../security/security.module';
import { SessionService } from '../auth/session.service';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { GatewayRateLimitService } from './gateway-rate-limit.service';
import { GatewayRateLimitGuard } from './gateway-rate-limit.guard';
import { GatewayExecutionService } from './gateway-execution.service';
import { GatewayAdmissionService } from './gateway-admission.service';
import { GatewayAuthRateLimitService } from './gateway-auth-rate-limit.service';
import { ModelRuntimePolicyService } from '../setting/model-runtime-policy.service';
import { policySnapshot } from './gateway-policy.test-fixtures';

@Controller()
class OrdinaryController {
  @Get('rate-limit-rest') rest() { return { ok: true }; }
  @Throttle({ auth: { ttl: 60_000, limit: 10 } })
  @Post('auth/rate-limit-login') login() { return { ok: true }; }
  @Throttle({ chat: { ttl: 60_000, limit: 60 } })
  @Post('rate-limit-chat') chat() { return { ok: true }; }
}

describe('Gateway production guard chain over HTTP', () => {
  const endpoint = '/api/gateway/v1/chat/completions';
  const secret = 'gateway-test-secret';
  const jwt = new JwtService({ secret });
  const identity = { sub: 'user-1', sid: 'auth-session-1', enterpriseId: 'enterprise-1', memberId: 'member-1', subscriptionId: 'subscription-1', type: 'client-employment' };
  const body = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hello' }] };
  const token = (changes = {}) => jwt.sign({ ...identity, ...changes }, { expiresIn: '15m' });
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let now: number;
  let app: INestApplication;
  let rpmEval: jest.Mock;
  let forward: jest.Mock;
  let authorize: jest.Mock;
  const prepare = jest.fn();
  const sessions = { assertActiveSession: jest.fn() };
  const authProtection = { consumeFailure: jest.fn() };
  const executions = {
    start: jest.fn(), saveUsage: jest.fn(), finish: jest.fn(), fail: jest.fn(), setUpstreamRequest: jest.fn(),
  };
  const releaseAdmission = jest.fn();
  const admission = { acquire: jest.fn(), reserve: jest.fn() };
  const snapshot = policySnapshot();
  const policies = { getSnapshot: jest.fn() };
  const releaseRequest = jest.fn();
  const lifecycle = { beginRequest: jest.fn() };

  beforeAll(async () => {
    rpmEval = jest.fn();
    forward = jest.fn();
    authorize = jest.fn();
    const module = await Test.createTestingModule({
      imports: [SecurityModule],
      controllers: [GatewayController, OrdinaryController],
      providers: [
        GatewayRateLimitGuard, GatewayRateLimitService,
        { provide: ModelRuntimePolicyService, useValue: policies },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: (name: string) => name === 'ACCESS_JWT_SECRET' ? secret : undefined } },
        // This Redis mock exclusively models the existing subscription RPM Lua.
        { provide: RedisService, useValue: { redis: { eval: rpmEval } } },
        { provide: SessionService, useValue: sessions },
        { provide: GatewayAuthRateLimitService, useValue: authProtection },
        { provide: GatewayExecutionService, useValue: executions },
        { provide: GatewayAdmissionService, useValue: admission },
        { provide: GatewayLifecycleService, useValue: lifecycle },
        { provide: GatewayService, useValue: {
          validateAndAuthorize: authorize, prepareRequest: prepare, forwardChatCompletion: forward,
          readCompletion: (response: Response) => response.json(),
        } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(requestContextMiddleware);
    // Every test client is deliberately seen as the same reverse proxy.
    app.use((req, _res, next) => { Object.defineProperty(req, 'ip', { value: 'shared-proxy' }); next(); });
    app.use(basicRateLimitMiddleware);
    app.useGlobalFilters(new HttpExceptionFilter());
    // Keep one listener for the high-frequency sequence instead of relistening
    // on a new ephemeral port for every supertest request.
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    now = 1_000_000;
    policies.getSnapshot.mockReset().mockResolvedValue(snapshot);
    buckets.clear();
    rpmEval.mockReset().mockImplementation(async (_script, _keys, key, _windowKey, limit, windowMs) => {
      let bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      const allowed = bucket.count < limit;
      if (allowed) bucket.count++;
      return [Number(allowed), bucket.count, bucket.resetAt - now, bucket.resetAt, windowMs];
    });
    sessions.assertActiveSession.mockReset().mockResolvedValue(undefined);
    authProtection.consumeFailure.mockReset().mockResolvedValue({
      allowed: true, rule: 'gateway-auth', dimension: 'token/socket', limit: 120, count: 1,
      windowMs: 60_000, retryAfterSeconds: 60, resetAt: 1_060_000,
    });
    authorize.mockReset().mockResolvedValue({ ...identity, employeeId: 'employee-1' });
    prepare.mockReset().mockImplementation(async (_claims, dto: ChatCompletionRequest) => {
      const prepared = { ...dto, max_tokens: dto.max_tokens ?? 4096 };
      return { request: prepared, allowedModels: [body.model, 'other-model'], inputBytes: Buffer.byteLength(JSON.stringify(prepared)) };
    });
    executions.start.mockReset().mockImplementation(async () => ({ id: randomUUID() }));
    for (const mock of [executions.saveUsage, executions.finish, executions.fail, executions.setUpstreamRequest, releaseAdmission]) {
      mock.mockReset().mockResolvedValue(undefined);
    }
    admission.acquire.mockReset().mockResolvedValue({ release: releaseAdmission });
    admission.reserve.mockReset().mockResolvedValue(undefined);
    releaseRequest.mockReset();
    lifecycle.beginRequest.mockReset().mockReturnValue(releaseRequest);
    forward.mockReset().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { headers: { 'Content-Type': 'application/json' } }));
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app?.close());
  function send(employmentToken = token(), payload = body, path = endpoint) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${employmentToken}`).send(payload);
  }

  it('admits 15 sequential agent/tool continuation requests, not just ten', async () => {
    const payload = {
      ...body,
      messages: [...body.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'a.txt' }],
    };
    for (let i = 0; i < 15; i++) await send(token(), payload).expect(200);
    expect(forward).toHaveBeenCalledTimes(15);
    expect(rpmEval).toHaveBeenCalledTimes(15);
    expect(sessions.assertActiveSession).toHaveBeenCalledTimes(15);
    expect(sessions.assertActiveSession).toHaveBeenCalledWith(identity.sid, identity.sub, 'DESKTOP');
    expect(authProtection.consumeFailure).not.toHaveBeenCalled();
    expect(executions.start).toHaveBeenCalledTimes(15);
    expect(releaseAdmission).toHaveBeenCalledTimes(15);
    expect(releaseRequest).toHaveBeenCalledTimes(15);
    expect(policies.getSnapshot).toHaveBeenCalledTimes(15);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining(identity), expect.objectContaining({ model: body.model }), snapshot);
    expect(executions.start).toHaveBeenCalledWith(expect.objectContaining(identity), 'employee-1', body.model, expect.any(String), snapshot, undefined);
    expect(admission.acquire).toHaveBeenCalledWith(expect.objectContaining(identity), snapshot);
    expect(admission.reserve).toHaveBeenCalledTimes(15);
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ model: body.model }), snapshot, expect.any(String), expect.any(AbortSignal));
  });

  it('reports the dedicated threshold and decreasing wait, without extending reset time', async () => {
    const employmentToken = token();
    for (let i = 0; i < 60; i++) await send(employmentToken).expect(200);
    const first = await send(employmentToken).set('x-request-id', 'rate-request-1').expect(429);
    expect(first.body.error).toMatchObject({
      source: 'platform', code: 'PLATFORM_RATE_LIMIT_EXCEEDED', requestId: 'rate-request-1',
      rateLimit: { rule: 'gateway-model', dimension: 'enterprise/member/subscription', limit: 60, count: 60, resetAt: 1_060_000, retryAfterSeconds: 60 },
    });
    expect(first.headers['retry-after']).toBe('60');
    expect(first.headers['x-ratelimit-remaining']).toBe('0');
    expect(executions.start).toHaveBeenCalledTimes(60);
    expect(admission.acquire).toHaveBeenCalledTimes(60);
    expect(lifecycle.beginRequest).toHaveBeenCalledTimes(60);
    now += 2300;
    const retry = await send(employmentToken).expect(429);
    expect(retry.headers['retry-after']).toBe('58');
    expect(retry.body.error.rateLimit.resetAt).toBe(1_060_000);
    expect(forward).toHaveBeenCalledTimes(60);
    now = 1_060_000;
    const restored = await send(employmentToken).expect(200);
    expect(restored.headers['x-ratelimit-remaining']).toBe('59');
  });

  it('isolates enterprise, member and subscription despite a shared proxy and 240 requests', async () => {
    for (const change of [{}, { enterpriseId: 'enterprise-2' }, { memberId: 'member-2' }, { subscriptionId: 'subscription-2' }]) {
      const employmentToken = token(change);
      for (let i = 0; i < 60; i++) await send(employmentToken).expect(200);
      await send(employmentToken).expect(429);
    }
    expect(forward).toHaveBeenCalledTimes(240);
    expect(buckets.size).toBe(4);
  });

  it('shares the identity bucket across models, sessions and trailing slash routes', async () => {
    const employmentToken = token();
    for (let i = 0; i < 60; i++) {
      await send(employmentToken, { ...body, model: i % 2 ? body.model : 'other-model' }, i % 2 ? endpoint : `${endpoint}/`)
        .set('x-sep-session-id', `session-${i}`).expect(200);
    }
    await send(employmentToken, { ...body, model: 'other-model' }).expect(429);
    expect(buckets.size).toBe(1);
  });

  it('charges the separate auth-failure bucket, not model RPM, for invalid credentials', async () => {
    const invalidTokens = [
      'forged', new JwtService({ secret: 'wrong' }).sign(identity),
      jwt.sign(identity, { expiresIn: -1 }), token({ type: 'access' }),
      ...['sub', 'sid', 'enterpriseId', 'memberId', 'subscriptionId'].flatMap((field) => [token({ [field]: '' }), token({ [field]: null })]),
      token({ sid: undefined }),
      jwt.sign(identity),
    ];
    for (const invalid of invalidTokens) await send(invalid).expect(401);
    await request(app.getHttpServer()).post(endpoint).send(body).expect(401);
    expect(authProtection.consumeFailure).toHaveBeenCalledTimes(invalidTokens.length + 1);
    expect(sessions.assertActiveSession).not.toHaveBeenCalled();
    expect(rpmEval).not.toHaveBeenCalled();
    expect(buckets.size).toBe(0);
    expect(authorize).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
    expect(policies.getSnapshot).not.toHaveBeenCalled();
  });

  it('rejects revoked sessions through auth protection before consuming model RPM', async () => {
    sessions.assertActiveSession.mockRejectedValue(new UnauthorizedException('Revoked session'));
    await send().expect(401);
    expect(sessions.assertActiveSession).toHaveBeenCalledWith(identity.sid, identity.sub, 'DESKTOP');
    expect(authProtection.consumeFailure).toHaveBeenCalledTimes(1);
    expect(rpmEval).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns the auth bucket 429 and its wait without touching subscription RPM', async () => {
    const rateLimit = {
      allowed: false, rule: 'gateway-auth', dimension: 'socket', limit: 1200, count: 1200,
      windowMs: 60000, retryAfterSeconds: 17, resetAt: 1_017_000,
    };
    authProtection.consumeFailure.mockResolvedValue(rateLimit);
    const res = await send('forged').set('x-request-id', 'auth-blocked').expect(429);
    const { allowed: _allowed, ...metadata } = rateLimit;
    expect(res.body.error).toMatchObject({
      code: 'GATEWAY_AUTH_RATE_LIMIT_EXCEEDED', source: 'platform', requestId: 'auth-blocked', rateLimit: metadata,
    });
    expect(res.headers['retry-after']).toBe('17');
    expect(authProtection.consumeFailure).toHaveBeenCalledTimes(1);
    expect(rpmEval).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed if the session store is unavailable instead of charging an auth failure', async () => {
    sessions.assertActiveSession.mockRejectedValue(new ServiceUnavailableException('Session unavailable'));
    await send().expect(503);
    expect(authProtection.consumeFailure).not.toHaveBeenCalled();
    expect(rpmEval).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed when the separate auth-failure protection is unavailable', async () => {
    authProtection.consumeFailure.mockRejectedValue(new ServiceUnavailableException({ error: {
      code: 'GATEWAY_AUTH_RATE_LIMIT_UNAVAILABLE', source: 'platform', message: 'Authentication protection unavailable',
    } }));
    const res = await send('forged').expect(503);
    expect(res.body.error).toMatchObject({ code: 'GATEWAY_AUTH_RATE_LIMIT_UNAVAILABLE', source: 'platform' });
    expect(rpmEval).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed without calling the model when Redis is unavailable', async () => {
    rpmEval.mockRejectedValue(new Error('private Redis failure'));
    const res = await send().expect(503);
    expect(res.body.error).toMatchObject({ source: 'platform', code: 'PLATFORM_RATE_LIMIT_UNAVAILABLE' });
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed on policy read failure before consuming model RPM', async () => {
    policies.getSnapshot.mockRejectedValue(new ServiceUnavailableException({ error: {
      code: 'MODEL_RUNTIME_POLICY_UNAVAILABLE', source: 'platform', message: 'Policy unavailable',
    } }));
    const res = await send().expect(503);
    expect(res.body.error.code).toBe('MODEL_RUNTIME_POLICY_UNAVAILABLE');
    expect(policies.getSnapshot).toHaveBeenCalledTimes(1);
    expect(rpmEval).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('counts authenticated invalid payloads and business authorization failures before execution', async () => {
    const employmentToken = token();
    await send(employmentToken, { ...body, messages: [{ role: 'tool', content: 'missing tool_call_id' }] }).expect(400);
    expect(authorize).not.toHaveBeenCalled();
    authorize.mockRejectedValue(new ForbiddenException('No subscription grant'));
    await send(employmentToken).expect(403);
    expect(rpmEval).toHaveBeenCalledTimes(2);
    expect([...buckets.values()]).toEqual([{ count: 2, resetAt: 1_060_000 }]);
    expect(forward).not.toHaveBeenCalled();
    expect(authProtection.consumeFailure).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
  });

  it('scopes default/auth/chat to ordinary REST, explicit login and explicit chat handlers', async () => {
    for (const [method, path, limit, retryHeader] of [
      ['get', '/api/rate-limit-rest', 100, 'retry-after'],
      ['post', '/api/auth/rate-limit-login', 10, 'retry-after-auth'],
      ['post', '/api/rate-limit-chat', 60, 'retry-after-chat'],
    ] as const) {
      for (let i = 0; i < limit; i++) await request(app.getHttpServer())[method](path).expect(method === 'post' ? 201 : 200);
      const res = await request(app.getHttpServer())[method](path).expect(429);
      expect(res.headers[retryHeader]).toBe('60');
      expect(res.headers['retry-after']).toBe('60');
      expect(res.body).not.toHaveProperty('error');
    }
    expect(rpmEval).not.toHaveBeenCalled();
    expect(authProtection.consumeFailure).not.toHaveBeenCalled();
  });
});
