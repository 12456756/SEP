import {
  Controller, ExecutionContext, HttpCode, INestApplication, InternalServerErrorException,
  Post, ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SessionService } from '../auth/session.service';
import { AuthEventService } from '../auth/auth-event.service';
import { GatewayAuthRateLimitService } from '../gateway/gateway-auth-rate-limit.service';
import { CsrfGuard } from '../security/guards/csrf.guard';
import { ClientEmploymentGuard } from './client-employment.guard';

const secret = 'employment-guard-test-secret';
const identity = {
  sub: 'user-1', sid: 'session-1', type: 'client-employment',
  enterpriseId: 'enterprise-1', memberId: 'member-1', subscriptionId: 'subscription-1',
};
const config = { get: (name: string) => name === 'ACCESS_JWT_SECRET' ? secret : undefined } as ConfigService;
const admission = {
  allowed: true, rule: 'gateway-auth', dimension: 'token/socket', limit: 120,
  count: 1, windowMs: 60_000, retryAfterSeconds: 60, resetAt: Date.now() + 60_000,
};

describe('ClientEmploymentGuard', () => {
  let guard: ClientEmploymentGuard;
  let jwt: JwtService;
  let sessions: { assertActiveSession: jest.Mock; assertEnterpriseActive: jest.Mock };
  let limiter: { consumeFailure: jest.Mock };
  const fixture = (authorization?: unknown) => {
    const req = {
      headers: { authorization, 'x-forwarded-for': 'attacker-controlled' },
      socket: { remoteAddress: 'socket-source' }, ip: 'untrusted-proxy-ip',
      clientEmployment: undefined as unknown,
    };
    const res = { setHeader: jest.fn() };
    const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
    return { req, res, context };
  };
  const token = (changes = {}) => jwt.sign({ ...identity, ...changes }, { expiresIn: '15m' });

  beforeEach(() => {
    jwt = new JwtService({ secret });
    jest.spyOn(jwt, 'verify');
    sessions = {
      assertActiveSession: jest.fn().mockResolvedValue(undefined),
      assertEnterpriseActive: jest.fn().mockResolvedValue(undefined),
    };
    limiter = { consumeFailure: jest.fn().mockResolvedValue(admission) };
    guard = new ClientEmploymentGuard(jwt, config, sessions as unknown as SessionService, limiter as unknown as GatewayAuthRateLimitService);
  });

  it('accepts only the verified employment identity after active session validation', async () => {
    const credential = token();
    const { req, context } = fixture(`Bearer ${credential}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwt.verify).toHaveBeenCalledWith(credential, { secret, algorithms: ['HS256'] });
    expect(sessions.assertActiveSession).toHaveBeenCalledWith('session-1', 'user-1', 'DESKTOP');
    expect(sessions.assertEnterpriseActive).toHaveBeenCalledWith('enterprise-1');
    expect(req.clientEmployment).toMatchObject(identity);
    expect(limiter.consumeFailure).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive Bearer scheme', async () => {
    await expect(guard.canActivate(fixture(`bearer ${token()}`).context)).resolves.toBe(true);
  });

  it.each([undefined, null, ['Bearer token'], '', 'Basic token', 'Bearer ', 'Bearer a b', 'Bearer a', 'Bearer a.b.', 'Bearer a.b.c!'])(
    'rejects missing or malformed header %j without verification or session lookup', async (authorization) => {
      const { req, context } = fixture(authorization);
      req.clientEmployment = identity;
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(req.clientEmployment).toBeUndefined();
      expect(jwt.verify).not.toHaveBeenCalled();
      expect(sessions.assertActiveSession).not.toHaveBeenCalled();
      expect(limiter.consumeFailure).toHaveBeenCalledWith(expect.any(String), 'socket-source');
    },
  );

  it('rejects oversized headers without hashing the input or verifying it', async () => {
    await expect(guard.canActivate(fixture(`Bearer ${'a'.repeat(4097)}.b.c`).context))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.verify).not.toHaveBeenCalled();
    expect(limiter.consumeFailure).toHaveBeenCalledWith('oversized-header', 'socket-source');
  });

  it('counts invalid tokens by digest and actual socket source, never forwarded IP', async () => {
    await expect(guard.canActivate(fixture('Bearer a.b.c').context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(limiter.consumeFailure).toHaveBeenCalledWith(createHash('sha256').update('a.b.c').digest('hex'), 'socket-source');
  });

  it.each(['sub', 'sid', 'enterpriseId', 'memberId', 'subscriptionId'])(
    'rejects missing or empty %s including legacy tokens before a session lookup', async (field) => {
      for (const value of [undefined, null, '', ' ']) {
        await expect(guard.canActivate(fixture(`Bearer ${token({ [field]: value })}`).context))
          .rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(sessions.assertActiveSession).not.toHaveBeenCalled();
      expect(limiter.consumeFailure).toHaveBeenCalledTimes(4);
    },
  );

  it('rejects expired, wrong-type, wrong-signature, wrong-algorithm and no-exp tokens', async () => {
    for (const credential of [
      jwt.sign(identity, { expiresIn: -1 }), token({ type: 'access' }),
      new JwtService({ secret: 'wrong-secret' }).sign(identity, { expiresIn: '15m' }),
      jwt.sign(identity, { algorithm: 'HS384', expiresIn: '15m' }), jwt.sign(identity),
    ]) {
      await expect(guard.canActivate(fixture(`Bearer ${credential}`).context)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(sessions.assertActiveSession).not.toHaveBeenCalled();
  });

  it('counts revoked/disabled/session ownership failures without attaching identity', async () => {
    sessions.assertActiveSession.mockRejectedValue(new UnauthorizedException());
    const { req, context } = fixture(`Bearer ${token()}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.clientEmployment).toBeUndefined();
    expect(limiter.consumeFailure).toHaveBeenCalledTimes(1);
  });

  it('does not classify database unavailability as failed authentication', async () => {
    sessions.assertActiveSession.mockRejectedValue(new ServiceUnavailableException());
    await expect(guard.canActivate(fixture(`Bearer ${token()}`).context)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(limiter.consumeFailure).not.toHaveBeenCalled();
  });

  it('reports an independent 429 but admits valid credentials from the same blocked socket', async () => {
    limiter.consumeFailure.mockResolvedValue({ ...admission, allowed: false, count: 120 });
    const { res, context } = fixture();
    const error = await guard.canActivate(context).catch((cause) => cause);
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ error: { code: 'GATEWAY_AUTH_RATE_LIMIT_EXCEEDED', rateLimit: { rule: 'gateway-auth' } } });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    await expect(guard.canActivate(fixture(`Bearer ${token()}`).context)).resolves.toBe(true);
    expect(limiter.consumeFailure).toHaveBeenCalledTimes(1);
  });

  it('returns 503 on failure-limiter outage, while valid credentials do not consult it', async () => {
    limiter.consumeFailure.mockRejectedValue(new ServiceUnavailableException());
    await expect(guard.canActivate(fixture().context)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(guard.canActivate(fixture(`Bearer ${token()}`).context)).resolves.toBe(true);
    expect(limiter.consumeFailure).toHaveBeenCalledTimes(1);
  });

  it('uses a configured byte limit and rejects invalid limit configuration', async () => {
    const limited = new ClientEmploymentGuard(jwt, { get: () => 16 } as unknown as ConfigService,
      sessions as unknown as SessionService, limiter as unknown as GatewayAuthRateLimitService);
    await expect(limited.canActivate(fixture(`Bearer ${'a'.repeat(17)}`).context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(() => new ClientEmploymentGuard(jwt, { get: () => 'invalid' } as unknown as ConfigService,
      sessions as unknown as SessionService, limiter as unknown as GatewayAuthRateLimitService)).toThrow(InternalServerErrorException);
  });
});

@Controller('gateway/v1')
class EmploymentHttpController {
  @Post('chat/completions')
  @HttpCode(200)
  @UseGuards(ClientEmploymentGuard)
  complete() { return { ok: true }; }
}

describe('Employment authentication with production CSRF over HTTP', () => {
  let app: INestApplication;
  let session: any;
  let evalMock: jest.Mock;
  const jwt = new JwtService({ secret });
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, CORS_ORIGIN: process.env.CORS_ORIGIN };
  const endpoint = '/api/gateway/v1/chat/completions';

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.example.com';
    evalMock = jest.fn();
    const prisma = {
      authSession: { findUnique: jest.fn(async () => session) },
      enterprise: { findUnique: jest.fn(async () => ({ metadata: {} })) },
    };
    const module = await Test.createTestingModule({
      controllers: [EmploymentHttpController],
      providers: [
        ClientEmploymentGuard, GatewayAuthRateLimitService, SessionService,
        { provide: AuthEventService, useValue: { record: jest.fn() } },
        { provide: JwtService, useValue: jwt }, { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { redis: { eval: evalMock } } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalGuards(new CsrfGuard(new Reflector()));
    await app.init();
  });
  beforeEach(() => {
    session = {
      userId: 'user-1', type: 'DESKTOP', revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      user: { status: 'ACTIVE', role: 'USER', memberships: [] }, deviceId: 'device-1', device: { userId: 'user-1', revokedAt: null },
    };
    evalMock.mockReset().mockResolvedValue([1, 1, 120, 1, 60_000, Date.now() + 60_000]);
  });
  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const send = (path = endpoint, changes = {}) => request(app.getHttpServer()).post(path)
    .set('Authorization', `Bearer ${jwt.sign({ ...identity, ...changes }, { expiresIn: '15m' })}`).send({});

  it('accepts valid Bearer requests without Origin on normal and trailing slash routes', async () => {
    await send().expect(200);
    await send(`${endpoint}/`).expect(200);
    await send(endpoint.toUpperCase()).expect(200);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('returns 401 rather than a CSRF 403 for missing, malformed and legacy tokens', async () => {
    await request(app.getHttpServer()).post(`${endpoint}/`).send({}).expect(401);
    await request(app.getHttpServer()).post(endpoint).set('Authorization', 'Basic invalid').send({}).expect(401);
    await send(endpoint, { sid: undefined }).expect(401);
    expect(evalMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a previously accepted JWT after logout, user disablement or device revocation', async () => {
    await send().expect(200);
    session.revokedAt = new Date();
    await send().expect(401);
    session.revokedAt = null;
    session.user.status = 'DISABLED';
    await send().expect(401);
    session.user.status = 'ACTIVE';
    session.device.revokedAt = new Date();
    await send().expect(401);
  });

  it('does not reject legitimate users when the shared socket failure bucket is saturated', async () => {
    evalMock.mockResolvedValue([0, 2, 1200, 1200, 60_000, Date.now() + 60_000]);
    const denied = await request(app.getHttpServer()).post(endpoint).send({}).expect(429);
    expect(denied.headers['retry-after']).toBe('60');
    expect(denied.body.error.rateLimit.dimension).toBe('socket');
    await send().expect(200);
    expect(evalMock).toHaveBeenCalledTimes(1);
  });
});
