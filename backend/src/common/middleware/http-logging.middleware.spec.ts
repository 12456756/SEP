import {
  BadRequestException, Controller, Get, HttpException, INestApplication, Logger,
  Post, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { createJsonBodyMiddleware } from './json-body.middleware';
import { requestContextMiddleware } from './request-context.middleware';
import { captureHttpException, httpLoggingMiddleware } from './http-logging.middleware';

class RejectGuard {
  canActivate() { throw new UnauthorizedException('请先登录'); }
}

@Controller()
class LoggingTestController {
  @Get('success')
  success() { return { message: '操作成功', data: { token: 'private-response-token', text: 'private-document' } }; }

  @Get('data')
  data() { return { items: ['private-document'], messageCount: 2 }; }

  @Get('bad')
  bad() { throw new BadRequestException(['name is required', 'age must be a number']); }

  @Get('guarded')
  @UseGuards(RejectGuard)
  guarded() { return {}; }

  @Get('gateway/failure')
  gatewayFailure() {
    throw new HttpException({ message: '模型不可用', error: { message: '上游服务超时', code: 'UPSTREAM_TIMEOUT' } }, 503);
  }

  @Get('crash')
  crash() { throw new TypeError('Cannot read properties of undefined'); }

  @Get('database')
  database() {
    const error = new Error('Invalid SQL SELECT private_record; password=database-secret');
    error.name = 'PrismaClientKnownRequestError';
    Object.assign(error, { code: 'P2021', meta: { private: 'private-metadata' } });
    throw error;
  }

  @Get('sensitive')
  sensitive() {
    return { message: '拒绝访问 https://user:url-password@example.test/api?token=url-token '
      + 'Bearer bearer-secret password="two word password" api_key=api-secret '
      + 'refresh_token=refresh-secret sk-test-key '
      + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature user@example.test 13812345678\nforged-log',
    token: 'private-body-token' };
  }

  @Get('long')
  long() { return { message: 'a'.repeat(5000), private: 'do-not-log' }; }

  @Get('object-message')
  objectMessage() { return { message: { password: 'secret-object-value' } }; }

  @Get('stream')
  stream(@Res() response: Response) {
    response.setHeader('Content-Type', 'text/event-stream');
    response.write('data: {"message":"private-stream-text"}\n\n');
    response.end('data: [DONE]\n\n');
  }

  @Get('file')
  file(@Res() response: Response) { response.type('application/octet-stream').send(Buffer.from('private-file-data')); }

  @Get('empty')
  empty(@Res() response: Response) { response.status(204).end(); }

  @Post('parse')
  parse() { return { message: '解析成功' }; }
}

describe('HTTP runtime logging', () => {
  let app: INestApplication;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(async () => {
    log = jest.spyOn(Logger, 'log').mockImplementation(() => {});
    warn = jest.spyOn(Logger, 'warn').mockImplementation(() => {});
    error = jest.spyOn(Logger, 'error').mockImplementation(() => {});
    const module = await Test.createTestingModule({ controllers: [LoggingTestController] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('api');
    app.use(requestContextMiddleware, httpLoggingMiddleware);
    // An ingress rejection before parsers/controllers must also be visible.
    app.use((req, res, next) => req.path === '/api/early'
      ? res.status(429).json({ message: '请求过于频繁', code: 'RATE_LIMITED' }) : next());
    app.use(createJsonBodyMiddleware({ REQUEST_JSON_LIMIT: '128b' }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  function entries(spy?: jest.SpyInstance) {
    return (spy ? [spy] : [log, warn, error]).flatMap(s => s.mock.calls)
      .map(args => args[0]).filter((line): line is string => typeof line === 'string' && line.startsWith('{"event":"http_request"'))
      .map(line => JSON.parse(line));
  }

  it('logs successful response messages with the returned request ID without logging data or query values', async () => {
    const response = await request(app.getHttpServer()).get('/api/success?token=query-secret&query=private-search')
      .set('x-request-id', 'debug-123').set('Authorization', 'Bearer private-header-token').expect(200);
    expect(response.body.data.token).toBe('private-response-token');
    expect(entries()).toHaveLength(1);
    expect(entries(log)[0]).toEqual(expect.objectContaining({ method: 'GET', path: '/api/success', statusCode: 200,
      message: '操作成功', messageSource: 'response', requestId: response.headers['x-request-id'], completed: true,
      durationMs: expect.any(Number) }));
    expect(JSON.stringify(entries())).not.toMatch(/private-|query-secret/);
  });

  it.each([['/api/data', 200, 'OK'], ['/api/empty', 204, 'No Content'], ['/api/object-message', 200, 'OK']])(
    'uses an explicit HTTP fallback when no string message exists: %s', async (path, status, expectedMessage) => {
      await request(app.getHttpServer()).get(path).expect(status);
      expect(entries()).toHaveLength(1);
      expect(entries()[0]).toEqual(expect.objectContaining({ message: expectedMessage, messageSource: 'http_status' }));
      expect(JSON.stringify(entries())).not.toContain('secret-object-value');
    });

  it('logs validation message arrays at WARN while preserving the response array', async () => {
    const response = await request(app.getHttpServer()).get('/api/bad').expect(400);
    expect(response.body.message).toEqual(['name is required', 'age must be a number']);
    expect(entries(warn)[0].message).toBe('name is required; age must be a number');
  });

  it('logs guard failures', async () => {
    await request(app.getHttpServer()).get('/api/guarded').expect(401);
    expect(entries(warn)[0]).toEqual(expect.objectContaining({ statusCode: 401, message: '请先登录' }));
  });

  it('logs nested gateway messages and stable error codes at ERROR', async () => {
    const response = await request(app.getHttpServer()).get('/api/gateway/failure').expect(503);
    expect(entries(error)[0]).toEqual(expect.objectContaining({ message: '上游服务超时', code: 'UPSTREAM_TIMEOUT',
      requestId: response.body.requestId, errorType: 'HttpException' }));
  });

  it('keeps unhandled error diagnostics on the server without exposing them in the response', async () => {
    const response = await request(app.getHttpServer()).get('/api/crash').expect(500);
    expect(response.body.message).toBe('Internal server error');
    expect(response.body).not.toHaveProperty('errorStack');
    expect(entries(error)[0]).toEqual(expect.objectContaining({ message: 'Internal server error',
      errorType: 'TypeError', errorMessage: 'Cannot read properties of undefined', errorStack: expect.any(Array) }));
    expect(entries(error)[0].errorStack.join(' ')).toContain('LoggingTestController.crash');
  });

  it('logs Prisma type, code and stack frames without SQL, argument values or metadata', async () => {
    await request(app.getHttpServer()).get('/api/database').expect(500);
    expect(entries(error)[0]).toEqual(expect.objectContaining({ errorType: 'PrismaClientKnownRequestError',
      errorCode: 'P2021', errorMessage: 'Database operation failed' }));
    expect(JSON.stringify(entries())).not.toMatch(/SELECT|private_record|database-secret|private-metadata/);
  });

  it('redacts credentials and personal contact details and keeps each entry on one line', async () => {
    const response = await request(app.getHttpServer()).get('/api/sensitive').expect(200);
    expect(response.body.message).toContain('bearer-secret');
    const text = JSON.stringify(entries());
    expect(text).toContain('[REDACTED');
    expect(text).not.toMatch(/url-password|url-token|bearer-secret|two word password|api-secret|refresh-secret|sk-test-key|eyJhbGci|user@example|13812345678|private-body-token/);
    expect(entries()[0].message).not.toContain('\n');
  });

  it('bounds message length without truncating the actual response', async () => {
    const response = await request(app.getHttpServer()).get('/api/long').expect(200);
    expect(response.body.message).toHaveLength(5000);
    expect(entries()[0].message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(entries())).not.toContain('do-not-log');
  });

  it('logs ingress rejections even though no controller runs', async () => {
    await request(app.getHttpServer()).get('/api/early').expect(429);
    expect(entries(warn)[0]).toEqual(expect.objectContaining({ message: '请求过于频繁', code: 'RATE_LIMITED' }));
  });

  it('logs parser 413 failures registered before controller handling', async () => {
    await request(app.getHttpServer()).post('/api/parse').send({ data: 'private-input'.repeat(100) }).expect(413);
    expect(entries(warn)[0]).toEqual(expect.objectContaining({ statusCode: 413, message: '请求体超过 HTTP 解析上限' }));
    expect(JSON.stringify(entries())).not.toContain('private-input');
  });

  it('logs parser 400 and unknown route 404 failures', async () => {
    await request(app.getHttpServer()).post('/api/parse').set('Content-Type', 'application/json').send('{').expect(400);
    await request(app.getHttpServer()).get('/api/not-found?token=do-not-log').expect(404);
    expect(entries(warn).map(e => e.statusCode)).toEqual([400, 404]);
    expect(JSON.stringify(entries())).not.toContain('do-not-log');
  });

  it.each(['/api/stream', '/api/file'])('passes streamed/downloaded data through unchanged: %s', async path => {
    const response = await request(app.getHttpServer()).get(path).expect(200);
    if (path.endsWith('stream')) expect(response.text).toBe('data: {"message":"private-stream-text"}\n\ndata: [DONE]\n\n');
    else expect(response.body).toEqual(Buffer.from('private-file-data'));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].message).toBe('OK');
    expect(JSON.stringify(entries())).not.toMatch(/private-stream|private-file/);
  });

  it('records a client disconnect once without intercepting or buffering stream writes', () => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false,
      getHeader: () => 'stream-id', json: jest.fn(), write: jest.fn(), end: jest.fn() });
    const originalWrite = response.write;
    const next = jest.fn();
    httpLoggingMiddleware({ method: 'GET', originalUrl: '/api/stream' } as any, response as any, next);
    response.emit('close');
    response.emit('finish');
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.write).toBe(originalWrite);
    expect(entries(warn)).toHaveLength(1);
    expect(entries(warn)[0]).toEqual(expect.objectContaining({ completed: false,
      message: 'Connection closed before response completed' }));
  });

  it('sanitizes internal exception diagnostics as well', () => {
    const response = Object.assign(new EventEmitter(), { statusCode: 500, writableFinished: true,
      getHeader: () => 'error-id', json: jest.fn() });
    httpLoggingMiddleware({ method: 'GET', originalUrl: '/api/crash' } as any, response as any, () => {});
    captureHttpException(response as any, new Error('upstream password=private-password https://host.test/?token=private-token'));
    response.emit('finish');
    expect(entries(error)[0].errorMessage).toContain('[REDACTED');
    expect(JSON.stringify(entries())).not.toMatch(/private-password|private-token/);
  });
});
