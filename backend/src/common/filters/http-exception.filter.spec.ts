import { ArgumentsHost, BadRequestException, HttpException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import { MediaUpstreamException } from '../errors/media-upstream.exception';
import { UpstreamHttpException } from '../errors/upstream-http.exception';

describe('HttpExceptionFilter diagnostic passthrough', () => {
  const gatewayPath = '/api/gateway/v1/chat/completions';
  function catchException(exception: unknown, originalUrl = gatewayPath, requestId = 'sep-request',
    initialHeaders: Record<string, string | number | string[]> = {}) {
    const headers = { 'x-request-id': 'header-id', ...initialHeaders };
    const response = {
      status: jest.fn().mockReturnThis(), json: jest.fn(), type: jest.fn().mockReturnThis(), send: jest.fn(),
      getHeader: jest.fn((name: string) => headers[name.toLowerCase()]),
      getHeaders: jest.fn(() => headers),
      setHeader: jest.fn((name: string, value: string) => { headers[name.toLowerCase()] = value; return response; }),
    };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ originalUrl, requestId }) }) } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(exception, host);
    return { response, body: response.json.mock.calls[0]?.[0] ?? response.send.mock.calls[0]?.[0] };
  }

  it.each(['/api/client/tasks', '/api/employees', '/api/knowledge-bases/search',
    '/api/skill-import/connector/sessions/s/commands', '/api/client/subscriptions/s/runtime'])(
    'preserves business codes, validation entries and recovery on %s', path => {
      const details = { code: 'REVISION_CONFLICT', message: 'The revision has changed',
        errors: [{ field: 'revision', message: 'Expected revision 3' }], retryable: true,
        recovery: 'refresh', stage: 'request-validation', extra: { expected: 3 } };
      const { body } = catchException(new HttpException(details, 409), path);
      expect(body).toMatchObject({ ...details, statusCode: 409, requestId: 'sep-request', path });
    });

  it.each(['real', 'video-real'])('preserves all media diagnostic fields for %s', route => {
    const diagnostic = { code: 'CONFIG_CHANGED', message: 'Profile revoked', stage: 'video-quote',
      field: 'profileId', recovery: 'refresh_capabilities', submissionState: 'not_submitted',
      billingState: 'not_reserved', source: 'adapter', param: { key: 'duration' } };
    const { body } = catchException(new HttpException({ error: diagnostic }, 409), '/api/gateway/v1/media/' + route + '/quotes');
    expect(body.error).toMatchObject(diagnostic);
  });

  it('redacts sensitive fields and fragments without deleting surrounding diagnostic fields', () => {
    const { body } = catchException(new HttpException({ message: 'Unsupported size; Bearer secret-token',
      error: { code: 1203, details: { allowed: ['720p'], apiKey: 'raw-key' }, source: 'vendor',
        param: ['size'], attempts: [{ message: 'signature=secret-signature expired' }] },
      credentials: 'raw-credentials', stack: 'internal stack' }, 422));
    expect(body.message).toBe('Unsupported size; Bearer [REDACTED]');
    expect(body.error).toMatchObject({ code: 1203, details: { allowed: ['720p'], apiKey: '[REDACTED]' }, source: 'vendor', param: ['size'] });
    expect(body.error.attempts[0].message).toContain('expired');
    expect(JSON.stringify(body)).not.toMatch(/secret-token|secret-signature|raw-key|raw-credentials|internal stack/);
  });

  it.each(['real', 'video-real'])('returns reference decoder messages and causes to the %s client', route => {
    const diagnostic = { code: 'INVALID_REFERENCE', message: 'Reference cannot be decoded',
      cause: { name: 'Error', message: 'Truncated WebP payload' } };
    const { response, body } = catchException(new BadRequestException({ error: diagnostic }),
      '/api/gateway/v1/media/' + route + '/references');
    expect(response.status).toHaveBeenCalledWith(400);
    expect(body).toMatchObject({ message: diagnostic.message, error: diagnostic, requestId: 'sep-request' });
  });

  it.each([gatewayPath, '/api/client/tasks', '/api/client/subscriptions/s/runtime'])(
    'preserves local failure details consistently on %s', path => {
      const error = Object.assign(new Error('fetch failed'), { code: 'NETWORK_FAILURE',
        cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) });
      const { response, body } = catchException(error, path);
      expect(response.status).toHaveBeenCalledWith(500);
      expect(body).toMatchObject({ message: 'fetch failed', name: 'Error', code: 'NETWORK_FAILURE',
        cause: { message: 'connection refused', code: 'ECONNREFUSED' } });
      expect(body.stack).toBeUndefined();
    });

  it.each([{ code: 'INVALID_API_KEY', message: 'Invalid API key' },
    { error: { message: 'Bad size', code: 1203, upstream_status: 422, details: { allowed: ['720p'] } } },
    { type: 'error', error: { message: 'Group disabled', source: 'platform' } }])(
    'passes upstream JSON through without introducing a replacement envelope', original => {
      const { response, body } = catchException(new UpstreamHttpException({ status: 403, body: original }));
      expect(response.status).toHaveBeenCalledWith(403);
      expect(body).toEqual(original);
    });

  it('preserves compute IDs and headers without overwriting the SEP request ID', () => {
    const { response, body } = catchException(new UpstreamHttpException({ status: 429, body: { code: 'QUOTA', message: 'Quota exhausted' } },
      { 'x-request-id': 'compute-id', 'x-client-request-id': 'billing-id', 'retry-after': '8' }));
    expect(response.setHeader).toHaveBeenCalledWith('X-Compute-Request-ID', 'compute-id');
    expect(response.setHeader).toHaveBeenCalledWith('x-client-request-id', 'billing-id');
    expect(response.setHeader).toHaveBeenCalledWith('retry-after', '8');
    expect(response.setHeader).not.toHaveBeenCalledWith('x-request-id', 'compute-id');
    expect(body.code).toBe('QUOTA');
  });

  it('returns upstream text as plain text after redacting credentials', () => {
    const { response, body } = catchException(new MediaUpstreamException({ status: 502, body: 'Unsupported size; api_key=private' }));
    expect(response.type).toHaveBeenCalledWith('text/plain');
    expect(body).toBe('Unsupported size; api_key=[REDACTED]');
  });

  it('preserves the received HTTP 200 when reporting a business failure as HTTP 502', () => {
    const { response, body } = catchException(new UpstreamHttpException({ status: 200, body: { error: { message: 'Rejected' } } }));
    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.setHeader).toHaveBeenCalledWith('X-Compute-Status', '200');
    expect(body).toEqual({ error: { message: 'Rejected' } });
  });

  it('keeps read failure evidence alongside the original body and status', () => {
    const { response, body } = catchException(new UpstreamHttpException({ status: 429, body: 'quota exhausted' }, {},
      { readError: { message: 'socket closed' }, truncated: true }));
    expect(response.status).toHaveBeenCalledWith(429);
    expect(body).toMatchObject({ body: 'quota exhausted', upstreamStatus: 429, readError: { message: 'socket closed' }, truncated: true });
  });

  it('does not overwrite producer request IDs with the SEP ID', () => {
    const { body } = catchException(new HttpException({ message: 'Rejected', requestId: 'original-id',
      error: { requestId: 'provider-id', message: 'Rejected' } }, 422));
    expect(body).toMatchObject({ requestId: 'original-id', sepRequestId: 'sep-request', error: { requestId: 'provider-id' } });
  });

  it('retains validation fields and adds the gateway compatibility envelope', () => {
    const errors = [{ field: 'messages.0.content', message: 'Required' }];
    const { body } = catchException(new BadRequestException({ message: 'Invalid parameters', errors }));
    expect(body.errors).toEqual(errors);
    expect(body.error).toMatchObject({ message: 'Invalid parameters: messages.0.content: Required',
      code: 'INVALID_PARAMETER', param: 'messages.0.content' });
  });

  it('preserves a string HttpException message on both ordinary and gateway routes', () => {
    expect(catchException(new HttpException('Not authorized', 401), '/api/client/tasks').body.message).toBe('Not authorized');
    expect(catchException(new HttpException('Not authorized', 401)).body.error.message).toBe('Not authorized');
  });

  it('uses the response ID if no context ID is present, and omits private query values', () => {
    const { body } = catchException(new BadRequestException('Invalid'), gatewayPath + '?token=private', '');
    expect(body.requestId).toBe('header-id');
    expect(body.path).toBe(gatewayPath);
  });

  it.each([0, 17, 1.2])('derives Retry-After from explicit wait %s', seconds => {
    const { response } = catchException(new HttpException({ retryAfterSeconds: seconds }, 429));
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', String(Math.ceil(seconds)));
  });

  it.each(['8', 'Sat, 10 Oct 2026 00:00:18 GMT', 0])('preserves existing Retry-After %s', value => {
    const { response } = catchException(new HttpException({ retryAfterSeconds: 12 }, 429), gatewayPath, 'sep',
      { 'retry-after': value });
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('uses the largest valid named wait but does not invent a default wait', () => {
    const valid = catchException(new HttpException('Limited', 429), gatewayPath, 'sep',
      { 'retry-after-a': '7', 'retry-after-b': 19 });
    expect(valid.response.setHeader).toHaveBeenCalledWith('Retry-After', '19');
    expect(catchException(new HttpException('Quota exhausted', 429)).response.setHeader).not.toHaveBeenCalled();
    expect(catchException(new HttpException({ retryAfterSeconds: 10 }, 503)).response.setHeader).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, '12', {}, null])('does not invent wait information from %p', retryAfterSeconds => {
    expect(catchException(new HttpException({ retryAfterSeconds }, 429)).response.setHeader).not.toHaveBeenCalled();
  });

  it('normalizes the known parser limit while preserving its actual message', () => {
    const { response, body } = catchException(Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large', status: 413, body: 'private submitted body' }));
    expect(response.status).toHaveBeenCalledWith(413);
    expect(body).toMatchObject({ message: 'request entity too large', error: { code: 'REQUEST_BODY_TOO_LARGE' } });
    expect(JSON.stringify(body)).not.toContain('private submitted body');
  });

  it('does not trust arbitrary non-HTTP status properties', () => {
    expect(catchException({ message: 'failure', status: 401 }).response.status).toHaveBeenCalledWith(500);
  });
});
