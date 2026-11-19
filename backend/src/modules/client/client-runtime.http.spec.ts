import { ExecutionContext, ForbiddenException, HttpException, INestApplication, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientController } from './client.controller';
import { ClientService } from './client.service';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { requestContextMiddleware } from '../../common/middleware/request-context.middleware';

describe('client runtime HTTP contract and source errors', () => {
  let app: INestApplication;
  const service = { getRuntime: jest.fn() };
  const path = '/api/client/subscriptions/sub-1/runtime';
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ClientController], providers: [{ provide: ClientService, useValue: service }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        if (req.headers.authorization !== 'Bearer fixture') throw new UnauthorizedException({ message: 'Fixture session expired', code: 'SESSION_EXPIRED', details: { session: 'inactive' } });
        if (req.headers['x-test-rate-limit']) throw new HttpException({ message: 'Fixture rate exceeded', code: 'FIXTURE_LIMIT', retryAfterSeconds: 12, limits: { count: 10 } }, 429);
        req.user = { id: 'user-1' }; return true;
      } }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(requestContextMiddleware);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  beforeEach(() => { service.getRuntime.mockReset(); service.getRuntime.mockResolvedValue({ manifestVersion: 1 }); });
  afterAll(async () => app.close());

  it.each(['', '?mediaProtocolVersion=3&videoProtocolVersion=3'])('uses V3 defaults and keeps the existing path handling (%s)', async query => {
    const response = await request(app.getHttpServer()).get(path + query).set('Authorization', 'Bearer fixture').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.getRuntime).toHaveBeenCalledWith('user-1', 'sub-1', 3, undefined, 3);
    await request(app.getHttpServer()).get('/api/client/subscriptions/id.with.dots/runtime').set('Authorization', 'Bearer fixture').expect(200);
    expect(service.getRuntime).toHaveBeenLastCalledWith('user-1', 'id.with.dots', 3, undefined, 3);
  });
  it.each(['mediaProtocolVersion=1', 'videoProtocolVersion=2', 'videoProtocolVersion=4', 'mediaProtocolVersion=', 'mediaProtocolVersion=3&mediaProtocolVersion=3', 'videoProtocolVersion[]=3', 'enterpriseId=other', 'userId=other'])
  ('preserves validation details and does not dispatch invalid queries: %s', async query => {
    const result = await request(app.getHttpServer()).get(`${path}?${query}`).set('Authorization', 'Bearer fixture').expect(400);
    expect(result.body.message).toBe('请求参数校验失败');
    expect(result.body.errors.length).toBeGreaterThan(0);
    expect(result.body.requestId).toBe(result.headers['x-request-id']);
    expect(result.body).not.toHaveProperty('code');
    expect(service.getRuntime).not.toHaveBeenCalled();
  });
  it('preserves guard errors before parameter validation', async () => {
    const result = await request(app.getHttpServer()).get(`${path}?videoProtocolVersion=4`).expect(401);
    expect(result.body).toMatchObject({ message: 'Fixture session expired', code: 'SESSION_EXPIRED', details: { session: 'inactive' } });
    expect(service.getRuntime).not.toHaveBeenCalled();
  });
  it('preserves rate-limit source fields and retry headers', async () => {
    const result = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer fixture').set('x-test-rate-limit', '1').expect(429);
    expect(result.body).toMatchObject({ code: 'FIXTURE_LIMIT', retryAfterSeconds: 12, limits: { count: 10 } });
    expect(result.headers['retry-after']).toBe('12');
  });
  it.each([
    new UnauthorizedException({ code: 'ENTERPRISE_SUSPENDED', message: '企业已冻结', details: { reason: 'suspended' } }),
    new ForbiddenException({ message: '无企业身份', details: { membership: 'missing' } }),
    new NotFoundException('Runtime unavailable'),
    new ServiceUnavailableException({ message: '配置读取失败', cause: { code: 'READ_UNAVAILABLE' } }),
    new HttpException({ message: ['第一条错误', '第二条错误'], error: { code: 'CONFIG_CONFLICT', field: 'parameters.width', extra: { actual: 2 } }, diagnostics: [1, 2] }, 500),
  ])('preserves each source response without remapping (%s)', async error => {
    service.getRuntime.mockRejectedValueOnce(error);
    const result = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer fixture').expect(error.getStatus());
    expect(result.body).toMatchObject(error.getResponse() as object);
    expect(result.body.requestId).toBe(result.headers['x-request-id']);
  });
  it('keeps unexpected runtime failures private and provides a correlation ID', async () => {
    service.getRuntime.mockRejectedValueOnce(Object.assign(new Error('Fixture configuration decoding failed'), { code: 'DECODE_FAILURE', issues: [{ field: 'durationSeconds', reason: 'invalid' }] }));
    const result = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer fixture').expect(500);
    expect(result.body).toMatchObject({ message: 'Internal server error', statusCode: 500 });
    expect(result.body.requestId).toBe(result.headers['x-request-id']);
    expect(result.text).not.toMatch(/Fixture configuration decoding failed|DECODE_FAILURE|durationSeconds|issues/);
  });
});
