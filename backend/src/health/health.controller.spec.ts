import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from './health.controller';
import { GatewayLifecycleService } from '../common/lifecycle/gateway-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EmbeddingService } from '../modules/knowledge/embedding.service';
import { TaskQueueService } from '../modules/task-execution/task-queue.service';
import { KnowledgeQueueService } from '../modules/knowledge/knowledge-queue.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { SettingService } from '../modules/setting/setting.service';
import { SETTING_KEYS } from 'shared';

jest.mock('../modules/knowledge/embedding.service', () => ({ EmbeddingService: class {} }));
jest.mock('../modules/task-execution/task-queue.service', () => ({ TaskQueueService: class {} }));
jest.mock('../modules/knowledge/knowledge-queue.service', () => ({ KnowledgeQueueService: class {} }));

describe('Health HTTP lifecycle contract', () => {
  let app: INestApplication;
  const snapshot = jest.fn();
  const query = jest.fn();
  const ping = jest.fn();
  const ready = jest.fn();
  const embeddingAvailable = jest.fn();
  const configGet = jest.fn();
  const getEffectiveValue = jest.fn();
  let fetchMock: jest.SpyInstance;
  const state = (gatewayState = 'ready', activeGatewayRequests = 0) => ({
    bootId: '11111111-1111-4111-8111-111111111111', gatewayState,
    draining: gatewayState !== 'ready', activeGatewayRequests,
    requestBudgetMs: 600000, drainGraceMs: 30000, drainTimeoutMs: 630000,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: GatewayLifecycleService, useValue: { snapshot } },
        { provide: PrismaService, useValue: { $queryRaw: query } },
        { provide: RedisService, useValue: { redis: { ping } } },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: SettingService, useValue: { getEffectiveValue } },
        { provide: EmbeddingService, useValue: { isAvailable: embeddingAvailable } },
        { provide: TaskQueueService, useValue: { isReady: ready } },
        { provide: KnowledgeQueueService, useValue: { isReady: ready } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    snapshot.mockReturnValue(state());
    query.mockResolvedValue([{ '?column?': 1 }]);
    ping.mockResolvedValue('PONG');
    ready.mockReturnValue(true);
    configGet.mockImplementation((key: string) => ({
      NODE_ENV: 'test', SUB2API_BASE_URL: 'https://relay.example/v1',
    }[key]));
    getEffectiveValue.mockImplementation(async (key: string) => ({
      [SETTING_KEYS.SUB2API_BASE_URL]: 'https://settings-relay.example/v1/',
      [SETTING_KEYS.SUB2API_API_KEY]: 'settings-secret',
    }[key]));
    embeddingAvailable.mockRejectedValue(new Error('embedding unavailable'));
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }] }),
    } as Response);
  });
  afterEach(() => fetchMock.mockRestore());
  afterAll(async () => app.close());

  it('reports read-only active count in liveness and ready responses', async () => {
    snapshot.mockReturnValue(state('ready', 2));
    const live = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(live.body).toMatchObject({ status: 'ok', draining: false, activeGatewayRequests: 2 });
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', activeGatewayRequests: 2, checks: { postgres: 'ok', redis: 'ok' } });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['draining', 'stopping', 'control_error'])('preserves %s 503 fields through the real filter at zero count', async (status) => {
    snapshot.mockReturnValue(state(status));
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(response.body).toMatchObject({ status, draining: true, activeGatewayRequests: 0 });
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });

  it('checks lifecycle again after asynchronous dependency probes', async () => {
    snapshot.mockReturnValueOnce(state()).mockReturnValue(state('draining', 1));
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(response.body).toMatchObject({ status: 'draining', activeGatewayRequests: 1 });
  });

  it('preserves dependency failures without discarding lifecycle fields', async () => {
    query.mockRejectedValue(new Error('synthetic database failure'));
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(response.body).toMatchObject({ status: 'failed', checks: { postgres: 'failed' }, activeGatewayRequests: 0 });
  });

  it('has no HTTP drain mutation endpoint', async () => {
    await request(app.getHttpServer()).post('/api/health/drain').expect(404);
    await request(app.getHttpServer()).post('/api/health/ready').expect(404);
  });

  it('uses effective relay settings and authenticated model discovery without embedding inference', async () => {
    configGet.mockImplementation((key: string) => ({
      NODE_ENV: 'production', SUB2API_BASE_URL: 'https://relay.example/v1',
    }[key]));
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', checks: { sub2api: 'ok' } });
    expect(response.body.checks).not.toHaveProperty('embedding');
    expect(embeddingAvailable).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://settings-relay.example/v1/models', {
      headers: { Authorization: 'Bearer settings-secret' }, signal: expect.any(AbortSignal),
    });
    expect(getEffectiveValue).toHaveBeenCalledWith(SETTING_KEYS.SUB2API_BASE_URL);
    expect(getEffectiveValue).toHaveBeenCalledWith(SETTING_KEYS.SUB2API_API_KEY);
  });

  it.each([401, 403, 503])('rejects production relay HTTP %i', async (status) => {
    configGet.mockImplementation((key: string) => ({
      NODE_ENV: 'production', SUB2API_BASE_URL: 'https://relay.example/v1',
    }[key]));
    fetchMock.mockResolvedValue({ ok: false, status } as Response);
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(response.body).toMatchObject({ status: 'failed', checks: { sub2api: 'failed' } });
  });

  it.each([
    ['missing URL', async (key: string) => key === SETTING_KEYS.SUB2API_API_KEY ? 'secret' : undefined],
    ['missing key', async (key: string) => key === SETTING_KEYS.SUB2API_BASE_URL ? 'https://relay.example/v1' : ''],
    ['setting lookup failure', async () => { throw new Error('private setting detail'); }],
  ])('rejects production relay when configuration has %s', async (_case, lookup) => {
    configGet.mockImplementation((key: string) => key === 'NODE_ENV' ? 'production' : undefined);
    getEffectiveValue.mockImplementation(lookup);
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(response.body).toMatchObject({ status: 'failed', checks: { sub2api: 'failed' } });
    expect(JSON.stringify(response.body)).not.toContain('private setting detail');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing data', {}],
    ['non-array data', { data: 'model-a' }],
    ['malformed model entry', { data: [{ name: 'model-a' }] }],
  ])('rejects malformed upstream model response: %s', async (_case, payload) => {
    configGet.mockImplementation((key: string) => key === 'NODE_ENV' ? 'production' : undefined);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payload } as Response);
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(response.body).toMatchObject({ status: 'failed', checks: { sub2api: 'failed' } });
  });

  it('still rejects unavailable job queues', async () => {
    ready.mockReturnValue(false);
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expect(response.body).toMatchObject({ status: 'failed', checks: { taskQueue: 'failed', knowledgeQueue: 'failed' } });
  });
});
