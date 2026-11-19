import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { createBasicRateLimitMiddleware } from '../../common/middleware/basic-rate-limit.middleware';
import { requestContextMiddleware } from '../../common/middleware/request-context.middleware';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { OAuthService } from '../auth/oauth.service';
import { InvitationService } from '../enterprise/invitation.service';
import { MemberService } from '../enterprise/member.service';
import { ClientController } from '../client/client.controller';
import { ClientService } from '../client/client.service';
import { businessTracker } from '../security/rate-limit-policy';
import { TaskPlanningController } from '../task-planning/task-planning.controller';
import { TaskPlanningService } from '../task-planning/task-planning.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

const routes = [
  { method: 'get', path: '/api/notifications', status: 200 },
  { method: 'get', path: '/api/notifications/unread-count', status: 200 },
  { method: 'post', path: '/api/notifications/own-unread/read', status: 204 },
  { method: 'post', path: '/api/notifications/read-all', status: 204 },
  { method: 'delete', path: '/api/notifications/own-read', status: 204 },
  { method: 'delete', path: '/api/notifications/clear-read', status: 204 },
] as const;

describe('Notifications HTTP with production throttling and real JWT guards', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let token: string;
  let otherToken: string;
  let now: number;
  let clock: jest.SpyInstance;
  let records: { id: string; userId: string; type: 'INFO'; read: boolean }[];
  let prisma: { notification: Record<string, jest.Mock> };
  let securityModule: typeof import('../security/security.module').SecurityModule;
  const auth = {
    getMe: jest.fn(async (id: string) => ({ id })),
    validateUser: jest.fn(async (id: string) => ['user-1', 'user-2'].includes(id) ? { id } : null),
    login: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid credentials')),
    requestRegistrationEmailCode: jest.fn().mockResolvedValue({ message: 'processed' }),
    requestPasswordReset: jest.fn().mockResolvedValue({ message: 'processed' }),
    resetPassword: jest.fn().mockResolvedValue({ message: 'processed' }),
  };

  beforeAll(async () => {
    // Import the actual global rules with E2E relaxation disabled, even when the
    // invoking shell has E2E_TEST=1. Do not duplicate or override their limits.
    const previous = process.env.E2E_TEST;
    process.env.E2E_TEST = '0';
    try {
      securityModule = (await import('../security/security.module')).SecurityModule;
    } finally {
      if (previous === undefined) delete process.env.E2E_TEST;
      else process.env.E2E_TEST = previous;
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    now = Date.now();
    // Only advance the storage clock; HTTP sockets and storage timers stay real.
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    records = [
      { id: 'own-unread', userId: 'user-1', type: 'INFO', read: false },
      { id: 'own-read', userId: 'user-1', type: 'INFO', read: true },
      { id: 'other-unread', userId: 'user-2', type: 'INFO', read: false },
    ];
    const matches = (record: typeof records[number], where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => record[key] === value);
    prisma = { notification: {
      findMany: jest.fn(async ({ where }) => records.filter(record => matches(record, where))),
      count: jest.fn(async ({ where }) => records.filter(record => matches(record, where)).length),
      updateMany: jest.fn(async ({ where, data }) => {
        const selected = records.filter(record => matches(record, where));
        selected.forEach(record => Object.assign(record, data));
        return { count: selected.length };
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const before = records.length;
        records = records.filter(record => !matches(record, where));
        return { count: before - records.length };
      }),
    } };
    const module = await Test.createTestingModule({
      imports: [securityModule, PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: 'notifications-http-test-only-secret' })],
      controllers: [NotificationsController, AuthController, ClientController, TaskPlanningController],
      providers: [NotificationsService, JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: auth },
        { provide: ConfigService, useValue: new ConfigService({
          ACCESS_JWT_SECRET: 'notifications-http-test-only-secret', NODE_ENV: 'test',
        }) },
        { provide: InvitationService, useValue: {} },
        { provide: MemberService, useValue: {} },
        { provide: OAuthService, useValue: {} },
        { provide: ClientService, useValue: {
          getProfile: jest.fn().mockResolvedValue({ id: 'user-1' }),
          login: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid credentials')),
        } },
        { provide: TaskPlanningService, useValue: { preview: jest.fn().mockResolvedValue({ id: 'preview' }) } },
      ],
    }).overrideProvider(ConfigService).useValue(new ConfigService({
      ACCESS_JWT_SECRET: 'notifications-http-test-only-secret', NODE_ENV: 'test',
    })).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(requestContextMiddleware, createBasicRateLimitMiddleware(
      businessTracker(module.get(ConfigService), module.get(JwtService)),
    ));
    app.useGlobalFilters(new HttpExceptionFilter());
    // Reuse a single listener for the high-frequency sequence.
    await app.listen(0, '127.0.0.1');
    jwt = module.get(JwtService);
    token = jwt.sign({ sub: 'user-1', sid: 'session-1', type: 'access' }, { expiresIn: '1h' });
    otherToken = jwt.sign({ sub: 'user-2', sid: 'session-2', type: 'access' }, { expiresIn: '1h' });
  });

  afterEach(async () => {
    await app?.close();
    clock?.mockRestore();
  });

  function call(route: typeof routes[number], bearer = token) {
    return request(app.getHttpServer())[route.method](route.path)
      .set('Authorization', `Bearer ${bearer}`);
  }

  it.each(routes)('keeps only the 100/60s business quota on $method $path', async route => {
    for (let i = 0; i < 100; i++) {
      const response = await call(route).expect(route.status);
      expect(response.headers['x-ratelimit-limit']).toBe('100');
      expect(response.headers['x-ratelimit-limit-auth']).toBeUndefined();
      expect(response.headers['x-ratelimit-limit-chat']).toBeUndefined();
    }
    const blocked = await call(route).expect(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.headers['retry-after-auth']).toBeUndefined();
    expect(blocked.headers['retry-after-chat']).toBeUndefined();
    expect(blocked.body).toEqual({
      statusCode: 429, message: 'ThrottlerException: Too Many Requests',
      requestId: expect.any(String), timestamp: expect.any(String), path: route.path,
    });
    expect(JSON.stringify(blocked.body)).not.toMatch(/user-1|user-2|tracker|totalHits|"key"|"stack"/);
    now += 12_345;
    const waiting = await call(route).expect(429);
    expect(waiting.headers['retry-after']).toBe('48');
    now += 47_654;
    const almostReady = await call(route).expect(429);
    expect(almostReady.headers['retry-after']).toBe('1');
    now += 1;
    await call(route).expect(route.status);
  });

  it.each(routes.filter(route => route.method === 'get'))(
    'allows more than ten reads on $path within one minute', async route => {
      for (let i = 0; i < 11; i++) {
        const response = await call(route);
        expect(response.headers['retry-after-auth']).toBeUndefined();
        expect(response.status).toBe(200);
      }
    },
  );

  it('isolates verified users behind one proxy and keeps handler buckets independent', async () => {
    for (let i = 0; i < 50; i++) await call(routes[0]).expect(200);
    // Express HEAD fallback reaches the same GET handler and shares its bucket.
    for (let i = 0; i < 50; i++) {
      await request(app.getHttpServer()).head(routes[0].path)
        .set('Authorization', `Bearer ${token}`).expect(200);
    }
    // Renewing a token or spoofing IP/query headers cannot reset this user's bucket.
    const renewed = jwt.sign({ sub: 'user-1', type: 'access', sid: 'other-session' }, { expiresIn: '1h' });
    await call(routes[0], renewed).query({ limit: 1 })
      .set('X-Forwarded-For', '203.0.113.25').expect(429);
    await call(routes[0], otherToken).expect(200);
    for (let i = 0; i < 100; i++) await call(routes[1], otherToken).expect(200);
    await call(routes[1], otherToken).expect(429);
    await request(app.getHttpServer()).post('/api/auth/login')
      .send({ email: 'member@example.com', password: 'invalid' }).expect(401);
  });

  it('applies only default to an ordinary controller without any skip decorators', async () => {
    for (let i = 0; i < 100; i++) {
      const response = await request(app.getHttpServer()).get('/api/client/profile')
        .set('Authorization', `Bearer ${token}`).expect(200);
      expect(response.headers['x-ratelimit-limit-auth']).toBeUndefined();
      expect(response.headers['x-ratelimit-limit-chat']).toBeUndefined();
    }
    await request(app.getHttpServer()).get('/api/client/profile')
      .set('Authorization', `Bearer ${token}`).expect(429);
    await request(app.getHttpServer()).get('/api/client/profile')
      .set('Authorization', `Bearer ${otherToken}`).expect(200);
  });

  it('does not aggregate authenticated business reads in the basic middleware either', async () => {
    for (const bearer of [token, otherToken]) {
      for (let i = 0; i < 100; i++) {
        await request(app.getHttpServer()).get('/api/auth/me')
          .set('Authorization', `Bearer ${bearer}`).expect(200);
      }
    }
  });

  it('retains desktop login IP protection even when signed bearer identities rotate', async () => {
    const path = '/api/client/auth/login';
    const payload = { email: 'member@example.com', password: 'invalid', fingerprint: 'test-device', platform: 'darwin' };
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer()).post(path).send(payload)
        .set('Authorization', `Bearer ${i % 2 ? token : otherToken}`).expect(401);
    }
    const blocked = await request(app.getHttpServer()).post(path).send(payload)
      .set('Authorization', `Bearer ${otherToken}`).set('X-Forwarded-For', '203.0.113.25').expect(429);
    expect(blocked.headers['retry-after-auth']).toBe('60');
    expect(blocked.headers['retry-after']).toBe('60');
    expect(app.get(ClientService).login).toHaveBeenCalledTimes(10);
  });

  it('enforces chat 60/60s on the real planner without auth quota or shared-user interference', async () => {
    const path = '/api/task-plans/preview';
    const payload = { objective: 'Create a useful plan for this test' };
    await request(app.getHttpServer()).post(path).send(payload).expect(401);
    for (let i = 0; i < 60; i++) {
      const response = await request(app.getHttpServer()).post(path).send(payload)
        .set('Authorization', `Bearer ${token}`).expect(201);
      expect(response.headers['x-ratelimit-limit-chat']).toBe('60');
      expect(response.headers['x-ratelimit-limit-auth']).toBeUndefined();
    }
    const blocked = await request(app.getHttpServer()).post(path).send(payload)
      .set('Authorization', `Bearer ${token}`).expect(429);
    expect(blocked.headers['retry-after-chat']).toBe('60');
    expect(blocked.headers['retry-after']).toBe('60');
    await request(app.getHttpServer()).post(path).send(payload)
      .set('Authorization', `Bearer ${otherToken}`).expect(201);
    now += 12_345;
    const waiting = await request(app.getHttpServer()).post(path).send(payload)
      .set('Authorization', `Bearer ${token}`).expect(429);
    expect(waiting.headers['retry-after']).toBe('48');
    now += 47_655;
    await request(app.getHttpServer()).post(path).send(payload)
      .set('Authorization', `Bearer ${token}`).expect(201);
  });

  it.each(routes)('still requires authentication on $method $path', async route => {
    for (const bearer of [undefined, 'malformed',
      jwt.sign({ sub: 'user-1', type: 'access' }, { expiresIn: -1 }),
      jwt.sign({ sub: 'user-1', type: 'refresh' }),
      jwt.sign({ sub: 'unknown-user', type: 'access' })]) {
      const req = request(app.getHttpServer())[route.method](route.path);
      if (bearer) req.set('Authorization', `Bearer ${bearer}`);
      await req.expect(401);
    }
    for (const operation of Object.values(prisma.notification)) expect(operation).not.toHaveBeenCalled();
  });

  it('isolates list and unread count by verified JWT identity', async () => {
    const list = await call(routes[0]).query({ userId: 'user-2' }).expect(200);
    expect(list.body.items.map(item => item.id)).toEqual(['own-unread', 'own-read']);
    expect(list.body.total).toBe(2);
    expect((await call(routes[1]).expect(200)).body).toEqual({ count: 1 });
    const other = await call(routes[0], otherToken).expect(200);
    expect(other.body.items.map(item => item.id)).toEqual(['other-unread']);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId: 'user-1', read: false } });
  });

  it('cannot read-mark or delete another user notification, including bulk operations', async () => {
    await request(app.getHttpServer()).post('/api/notifications/other-unread/read')
      .set('Authorization', `Bearer ${token}`).send({ userId: 'user-2' }).expect(204);
    await request(app.getHttpServer()).delete('/api/notifications/other-unread')
      .set('Authorization', `Bearer ${token}`).expect(204);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'other-unread', userId: 'user-1' }, data: { read: true },
    });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: 'other-unread', userId: 'user-1' } });
    expect(records.find(record => record.id === 'other-unread')?.read).toBe(false);
    await call(routes[3]).expect(204);
    expect(prisma.notification.updateMany).toHaveBeenLastCalledWith({
      where: { userId: 'user-1', read: false }, data: { read: true },
    });
    await call(routes[5]).expect(204);
    expect(prisma.notification.deleteMany).toHaveBeenLastCalledWith({ where: { userId: 'user-1', read: true } });
    expect(records).toEqual([{ id: 'other-unread', userId: 'user-2', type: 'INFO', read: false }]);
  });

  it.each([
    { path: 'login', limit: 10, status: 401, payload: { email: 'member@example.com', password: 'invalid' }, method: 'login' },
    { path: 'registration/email-code', limit: 5, status: 200, payload: { email: 'member@example.com' }, method: 'requestRegistrationEmailCode' },
    { path: 'password/forgot', limit: 5, status: 200, payload: { email: 'member@example.com' }, method: 'requestPasswordReset' },
    { path: 'password/reset', limit: 10, status: 200, payload: { token: 'test-reset-token', newPassword: 'test-password' }, method: 'resetPassword' },
  ])('preserves the auth quota on POST /auth/$path', async route => {
    for (let i = 0; i < route.limit; i++) {
      await request(app.getHttpServer()).post(`/api/auth/${route.path}`).send(route.payload).expect(route.status);
    }
    const blocked = await request(app.getHttpServer()).post(`/api/auth/${route.path}`).send(route.payload).expect(429);
    expect(blocked.headers['retry-after-auth']).toBe('60');
    expect(blocked.headers['retry-after']).toBe(blocked.headers['retry-after-auth']);
    expect(blocked.body.statusCode).toBe(429);
    expect(blocked.body.message).toBe('ThrottlerException: Too Many Requests');
    expect(auth[route.method]).toHaveBeenCalledTimes(route.limit);
    now += 12_345;
    const waiting = await request(app.getHttpServer()).post(`/api/auth/${route.path}`).send(route.payload).expect(429);
    expect(waiting.headers['retry-after']).toBe('48');
    expect(waiting.headers['retry-after-auth']).toBe('48');
    now += 47_655;
    await request(app.getHttpServer()).post(`/api/auth/${route.path}`).send(route.payload).expect(route.status);
  });
});
