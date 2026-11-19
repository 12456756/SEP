import { BadRequestException, Controller, Get, HttpException, INestApplication, Param } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SensitiveDataFilter } from '../../modules/security/filters/sensitive-data.filter';
import { fetchUpstream, readUpstreamJson } from '../errors/upstream-http.exception';
import { localError } from '../errors/error-diagnostics';
import { HttpExceptionFilter } from './http-exception.filter';

@Controller('diagnostics')
class DiagnosticController {
  @Get('upstream')
  async upstream() { return readUpstreamJson(await fetchUpstream('https://compute.invalid/v1/test', undefined, ['opaque-key']), ['opaque-key']); }

  @Get('validation')
  validation() {
    throw new BadRequestException({ code: 'INVALID_PARAMETER', message: 'duration is required',
      errors: [{ field: 'requestedSpec.durationSeconds', message: 'Required', received: null }],
      stage: 'quote', recovery: 'revise_request' });
  }

  @Get('local/:name')
  local(@Param('name') name: string) {
    if (name === 'business') throw new HttpException({ error: { code: 'CONFIG_CHANGED', stage: 'video-query',
      recovery: 'refresh_capabilities', message: 'Profile revision changed', requestId: 'supplier-request' } }, 409);
    if (name === 'transport') throw localError(Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    }), 502, { stage: 'transport' });
    throw Object.assign(new Error('Storage connection refused at postgres://user:password@db/private'), {
      code: 'STORAGE_UNAVAILABLE', cause: { code: 'ECONNREFUSED' } });
  }
}

describe('HTTP error diagnostic contract', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DiagnosticController], providers: [
      { provide: APP_FILTER, useClass: SensitiveDataFilter },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    app.use((req, res, next) => { req.requestId = 'sep-request'; res.setHeader('X-Request-ID', 'sep-request'); next(); });
    await app.init();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app.close(); });

  it.each([
    { code: 42201, message: 'seconds must be at least 4', details: { minimum: 4, param: 'seconds' } },
    { error: { message: 'Invalid tool opaque-key', code: 'invalid_tool', source: 'supplier',
      param: { key: 'arguments' }, attempts: [{ upstream_status: 400 }] } },
    { type: 'error', error: { type: 'authentication_error', message: 'Account expired' } },
    { error: 'Video reference 2 rejected', detail: { index: 1 } },
  ])('preserves upstream JSON fields through the registered production filters: %j', async body => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 422,
      headers: { 'X-Request-ID': 'compute-request', 'X-Upstream-Request-ID': 'supplier-request',
        'X-Client-Request-ID': 'client-request', 'Retry-After': '12', 'Set-Cookie': 'private-cookie' } }));
    const result = await request(app.getHttpServer()).get('/diagnostics/upstream').expect(422);
    expect(result.body).toEqual(JSON.parse(JSON.stringify(body).replace(/opaque-key/g, '[REDACTED]')));
    expect(result.headers).toMatchObject({ 'x-request-id': 'sep-request', 'x-compute-request-id': 'compute-request',
      'x-upstream-request-id': 'supplier-request', 'x-client-request-id': 'client-request',
      'x-sep-error-source': 'upstream', 'x-compute-status': '422', 'retry-after': '12' });
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('returns a plain text failure reason and original HTTP status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('Proxy connection refused opaque-key', { status: 503 }));
    const result = await request(app.getHttpServer()).get('/diagnostics/upstream').expect(503);
    expect(result.text).toBe('Proxy connection refused [REDACTED]');
  });

  it('reports a business failure in HTTP 200 without presenting it as successful output', async () => {
    const body = { error: { code: 'reference_rejected', message: 'Reference 2 rejected' } };
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    const result = await request(app.getHttpServer()).get('/diagnostics/upstream').expect(502);
    expect(result.headers['x-compute-status']).toBe('200');
    expect(result.body).toEqual(body);
  });

  it('preserves local validation and recovery fields', async () => {
    const result = await request(app.getHttpServer()).get('/diagnostics/validation').expect(400);
    expect(result.body).toMatchObject({ code: 'INVALID_PARAMETER', errors: [{ field: 'requestedSpec.durationSeconds',
      message: 'Required', received: null }], stage: 'quote', recovery: 'revise_request' });
  });

  it('does not expose unhandled storage failures and connection details', async () => {
    const result = await request(app.getHttpServer()).get('/diagnostics/local/storage').expect(500);
    expect(result.body).toMatchObject({ message: 'Internal server error', requestId: 'sep-request' });
    expect(result.text).not.toMatch(/password|STORAGE_UNAVAILABLE|ECONNREFUSED|Storage connection/);
  });

  it('retains explicit transport diagnostics and business recovery details', async () => {
    const transport = await request(app.getHttpServer()).get('/diagnostics/local/transport').expect(502);
    expect(transport.body).toMatchObject({ message: 'fetch failed', stage: 'transport',
      cause: { cause: { message: 'connection refused', code: 'ECONNREFUSED' } } });
    const business = await request(app.getHttpServer()).get('/diagnostics/local/business').expect(409);
    expect(business.body.error).toMatchObject({ code: 'CONFIG_CHANGED', stage: 'video-query',
      recovery: 'refresh_capabilities', message: 'Profile revision changed', requestId: 'supplier-request' });
  });
});
