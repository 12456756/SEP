import { Body, Controller, INestApplication, Post, Put } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { createJsonBodyMiddleware } from './json-body.middleware';
import { requestContextMiddleware } from './request-context.middleware';

const endpoint = '/api/gateway/v1/chat/completions';

@Controller()
class BodyTestController {
  @Post(['gateway/v1/chat/completions', 'ordinary', 'capabilities', 'contributions', 'skill-import/connector/sessions/:id/events'])
  parse(@Body() body: Record<string, unknown>) {
    return { bytes: Buffer.byteLength(JSON.stringify(body), 'utf8') };
  }

  @Put('gateway/v1/chat/completions')
  put(@Body() body: Record<string, unknown>) {
    return this.parse(body);
  }
}

describe('JSON request body policies', () => {
  let app: INestApplication;

  async function start(env: NodeJS.ProcessEnv = {}) {
    const module = await Test.createTestingModule({ controllers: [BodyTestController] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('api');
    app.use(requestContextMiddleware);
    app.use(createJsonBodyMiddleware(env));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  }

  afterEach(async () => { await app?.close(); });

  it('accepts model JSON above 2 MiB without raising ordinary REST limits', async () => {
    await start();
    const body = { value: 'a'.repeat(2 * 1024 * 1024) };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    const gateway = await request(app.getHttpServer()).post(endpoint).send(body).expect(201);
    expect(gateway.body).toEqual({ bytes });
    const ordinary = await request(app.getHttpServer()).post('/api/ordinary').send(body).expect(413);
    expect(ordinary.body.message).toBe('请求体超过 HTTP 解析上限');
    expect(ordinary.body).not.toHaveProperty('error');
  });

  it('returns an actionable, correlated 413 above the model HTTP limit without exposing input', async () => {
    await start();
    const response = await request(app.getHttpServer()).post(endpoint)
      .set('x-request-id', 'body-limit-test')
      .send({ value: 'private-input'.repeat(Math.ceil(4 * 1024 * 1024 / 13)) }).expect(413);
    expect(response.headers['x-request-id']).toBe('body-limit-test');
    expect(response.body.error).toEqual({
      message: '请求体超过 HTTP 解析上限', type: 'invalid_request_error',
      code: 'REQUEST_BODY_TOO_LARGE', source: 'platform', param: null, requestId: 'body-limit-test',
    });
    expect(JSON.stringify(response.body)).not.toContain('private-input');
  });

  it('accepts the exact HTTP byte limit and rejects one byte above', async () => {
    await start({ GATEWAY_HTTP_JSON_LIMIT: '1024' });
    const overhead = Buffer.byteLength(JSON.stringify({ value: '' }));
    await request(app.getHttpServer()).post(endpoint).send({ value: 'a'.repeat(1024 - overhead) }).expect(201);
    await request(app.getHttpServer()).post(endpoint).send({ value: 'a'.repeat(1025 - overhead) }).expect(413);
  });

  it('honors independently configured policies and normalizes gateway route case, slash and query', async () => {
    await start({ GATEWAY_HTTP_JSON_LIMIT: '1kb', REQUEST_JSON_LIMIT: '512' });
    const body = { value: 'a'.repeat(600) };
    await request(app.getHttpServer()).post(`${endpoint.toUpperCase()}/?test=1`).send(body).expect(201);
    await request(app.getHttpServer()).post('/api/ordinary').send(body).expect(413);
    await request(app.getHttpServer()).put(endpoint).send(body).expect(413);
    const oversize = await request(app.getHttpServer()).post(`${endpoint.toUpperCase()}/?test=1`)
      .send({ value: 'a'.repeat(1024) }).expect(413);
    expect(oversize.body.error.code).toBe('REQUEST_BODY_TOO_LARGE');
  });

  it('retains a structured 400 for invalid JSON rather than treating it as a size error', async () => {
    await start();
    const response = await request(app.getHttpServer()).post(endpoint)
      .set('Content-Type', 'application/json').send('{').expect(400);
    expect(response.body.error.code).not.toBe('REQUEST_BODY_TOO_LARGE');
  });

  it('accepts a full skill body with JSON escaping without raising unrelated REST limits', async () => {
    await start();
    const body = { content: '\t'.repeat(2 * 1024 * 1024) };
    await request(app.getHttpServer()).post('/api/capabilities').send(body).expect(201);
    await request(app.getHttpServer()).post('/api/contributions').send(body).expect(201);
    await request(app.getHttpServer()).post('/api/ordinary').send(body).expect(413);
  });

  it('uses the skill JSON budget only for connector event posts', async () => {
    await start({ SKILL_REQUEST_JSON_LIMIT: '1mb', REQUEST_JSON_LIMIT: '512' });
    const body = { value: 'a'.repeat(700 * 1024) };
    await request(app.getHttpServer()).post('/api/skill-import/connector/sessions/s-1/events').send(body).expect(201);
    await request(app.getHttpServer()).post('/api/skill-import/connector/sessions/s-1/other').send(body).expect(413);
    const tooLarge = await request(app.getHttpServer())
      .post('/api/skill-import/connector/sessions/s-1/events')
      .send({ value: 'a'.repeat(1024 * 1024) }).expect(413);
    expect(tooLarge.body.code).toBe('REQUEST_BODY_TOO_LARGE');
    expect(tooLarge.body).not.toHaveProperty('error');
  });
});
