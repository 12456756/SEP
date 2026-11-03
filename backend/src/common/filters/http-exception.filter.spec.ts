import { ArgumentsHost, BadRequestException, HttpException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  const gatewayPath = '/api/gateway/v1/chat/completions';

  it.each(['/api/client/subscriptions/sub-1/runtime', '/api/skills', gatewayPath])('does not extend unrelated error envelopes with artifact fields: %s', (path) => {
    const { body } = catchException(new HttpException({ message: 'Not installable', code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY' }, 409), path);
    expect(body.code).toBeUndefined();
    expect(body.reason).toBeUndefined();
  });

  it('preserves stable knowledge API error codes without changing other envelopes', () => {
    const { body: knowledgeBody } = catchException(new HttpException({
      message: 'Too many requests', code: 'KNOWLEDGE_RATE_LIMIT_EXCEEDED', retryAfterSeconds: 5,
    }, 429), '/api/knowledge-bases/search');
    expect(knowledgeBody.code).toBe('KNOWLEDGE_RATE_LIMIT_EXCEEDED');

    const { body: unrelatedBody } = catchException(new HttpException({
      message: 'Rejected', code: 'KNOWLEDGE_RATE_LIMIT_EXCEEDED',
    }, 429), '/api/employees');
    expect(unrelatedBody.code).toBeUndefined();
  });

  it('preserves only allowlisted skill-import error codes on skill-import routes', () => {
    const { body } = catchException(new HttpException({
      message: '授权已过期', code: 'GRANT_EXPIRED', retryable: true,
      secret: 'must-not-leak',
    }, 401), '/api/skill-import/connector/sessions/s-1/commands');
    expect(body.code).toBe('GRANT_EXPIRED');
    expect(body.retryable).toBe(true);
    expect(JSON.stringify(body)).not.toContain('must-not-leak');

    const { body: unrelated } = catchException(new HttpException({
      message: 'bad', code: 'GRANT_EXPIRED', retryable: true,
    }, 401), '/api/employees');
    expect(unrelated.code).toBeUndefined();
    expect(unrelated.retryable).toBeUndefined();
  });

  it.each([
    '/api/client/subscriptions/sub-1/skills/cap-1/versions/sv-1/artifact/extra',
    '/api/client/subscriptions/sub-1/skills/cap-1/versions/sv%2F1/artifact',
    '/api/client/subscriptions/sub-1/skills/cap-1/versions/sv%3F1/artifact',
    '/api/client/subscriptions/sub-1/skills/cap-1/versions/sv%ZZ/artifact',
    `/api/client/subscriptions/sub-1/skills/cap-1/versions/${'v'.repeat(129)}/artifact`,
  ])('does not preserve artifact fields on malformed or unrelated paths: %s', (path) => {
    const { body } = catchException(new HttpException({ message: 'Not installable', code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY' }, 409), path);
    expect(body.code).toBeUndefined();
    expect(body.reason).toBeUndefined();
  });

  function catchException(
    exception: unknown,
    originalUrl = gatewayPath,
    requestId: string | undefined = 'request-123',
    initialHeaders: Record<string, string | number | string[]> = {},
  ) {
    const headers = { 'x-request-id': 'header-request-id', ...initialHeaders };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      getHeader: jest.fn((name: string) => headers[name.toLowerCase()]),
      getHeaders: jest.fn(() => ({ ...headers })),
      setHeader: jest.fn((name: string, value: string) => {
        headers[name.toLowerCase()] = value;
        return response;
      }),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ originalUrl, requestId }),
      }),
    } as unknown as ArgumentsHost;

    new HttpExceptionFilter().catch(exception, host);
    return { response, body: response.json.mock.calls[0][0] };
  }

  it.each(['real', 'video-real'])('preserves safe negotiated media errors for %s', route => {
    const details = { code: 'MISSING_SPEC', message: '需要先确定时长', field: 'requestedSpec.durationSeconds',
      source: 'adapter', reason: '报价合同需要明确时长', stage: 'quote', retryable: false,
      submissionState: 'not_submitted', billingState: 'not_reserved' };
    const { body } = catchException(new HttpException({ error: details }, 400), `/api/gateway/v1/media/${route}/quotes`);
    expect(body.error).toMatchObject(details);
  });

  it('keeps ambiguous paid submissions explicit and strips untrusted detail', () => {
    const { body } = catchException(new HttpException({ error: {
      code: 'SUBMISSION_UNKNOWN', message: '查询原请求', source: 'upstream', stage: 'submit', retryable: true,
      submissionState: 'unknown', billingState: 'reconciling', field: '../private', requestedValue: 'private',
      reason: 'Authorization: Bearer private', body: { apiKey: 'private' }, alternatives: ['https://private.example'],
    } }, 502), '/api/gateway/v1/media/video-real/requests');
    expect(body.error).toMatchObject({ submissionState: 'unknown', billingState: 'reconciling' });
    expect(body.error).not.toHaveProperty('field');
    expect(body.error).not.toHaveProperty('reason');
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it('does not extend unrelated gateway contracts with media state fields', () => {
    const { body } = catchException(new HttpException({ error: {
      source: 'adapter', stage: 'quote', submissionState: 'not_submitted', billingState: 'not_reserved',
    } }, 400));
    expect(body.error).not.toHaveProperty('submissionState');
    expect(body.error).not.toHaveProperty('source');
  });

  it('adds Retry-After to 429 responses when the producer did not set it', () => {
    const { response } = catchException(new HttpException('Too many requests', 429));

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it.each(['8', 'Sat, 10 Oct 2026 00:00:18 GMT', 0])(
    'does not overwrite an existing standard Retry-After %p', (retryAfter) => {
      const { response } = catchException(new HttpException({ retryAfterSeconds: 12 }, 429),
        gatewayPath, 'request-123', { 'retry-after': retryAfter, 'retry-after-auth': '30' });
      expect(response.setHeader).not.toHaveBeenCalled();
    },
  );

  it.each([0, 17, 1.2])('prefers exception waiting seconds %p over named headers', (seconds) => {
    const { response } = catchException(new HttpException({ retryAfterSeconds: seconds }, 429),
      gatewayPath, 'request-123', { 'retry-after-auth': '40' });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', String(Math.ceil(seconds)));
  });

  it('chooses the maximum valid named wait across multiple throttler rules', () => {
    const { response } = catchException(new HttpException('Throttler exception', 429),
      gatewayPath, 'request-123', {
        'retry-after-default': '7', 'retry-after-auth': '19', 'retry-after-chat': 12,
        'Retry-After-Gateway-Model': ' 15 ', 'x-ratelimit-reset': '99999',
      });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '19');
  });

  it.each(['12', -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, null])(
    'ignores an invalid exception wait %p and uses valid named waiting information', (retryAfterSeconds) => {
      const { response } = catchException(new HttpException({ retryAfterSeconds }, 429),
        gatewayPath, 'request-123', { 'retry-after-auth': '9' });
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '9');
    },
  );

  it.each(['', '-1', '1.5', 'Infinity', 'NaN', '12seconds', '9007199254740992', ['12'], -1, Infinity])(
    'uses the compatible fallback for invalid named waiting information %p', (value) => {
      const { response } = catchException(new HttpException('Too many requests', 429),
        gatewayPath, 'request-123', { 'retry-after-auth': value, 'retry-after-': '99' });
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    },
  );

  it('retains zero as a valid named wait and only adds waiting headers for 429', () => {
    const { response } = catchException(new HttpException('Too many requests', 429),
      gatewayPath, 'request-123', { 'retry-after-auth': '0' });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '0');
    const non429 = catchException(new HttpException({ retryAfterSeconds: 10 }, 503));
    expect(non429.response.setHeader).not.toHaveBeenCalled();
  });

  it('applies waiting header precedence without changing the ordinary business envelope', () => {
    const raw = { message: 'Too many requests', retryAfterSeconds: 5, error: { source: 'platform' } };
    const { response, body } = catchException(new HttpException(raw, 429), '/api/employees');
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(body).toEqual({
      statusCode: 429, message: 'Too many requests', requestId: 'request-123',
      timestamp: expect.any(String), path: '/api/employees',
    });
  });

  it('adds an OpenAI error while retaining the legacy envelope for gateway errors', () => {
    const { response, body } = catchException(new BadRequestException('Invalid model'));

    expect(response.status).toHaveBeenCalledWith(400);
    expect(body).toEqual({
      statusCode: 400,
      message: 'Invalid model',
      requestId: 'request-123',
      timestamp: expect.any(String),
      path: gatewayPath,
      error: {
        message: 'Invalid model',
        type: 'invalid_request_error',
        code: null,
        param: null,
        requestId: 'request-123',
      },
    });
  });

  it('preserves validation field paths and exposes a readable message and first param', () => {
    const errors = [
      { field: 'messages.1.tool_calls.0.function.arguments', message: 'Expected string' },
      { field: 'messages.2.tool_call_id', message: 'Required' },
    ];
    const { body } = catchException(new BadRequestException({ message: '请求参数校验失败', errors }));

    expect(body.message).toBe('请求参数校验失败');
    expect(body.errors).toEqual(errors);
    expect(body.error).toEqual({
      message: `请求参数校验失败: ${errors[0].field}: Expected string; ${errors[1].field}: Required`,
      type: 'invalid_request_error',
      code: 'INVALID_PARAMETER',
      param: errors[0].field,
      requestId: 'request-123',
      source: 'platform',
    });
  });

  it('maps a known Express size error to 413 without reflecting its private body or stack', () => {
    const exception = Object.assign(new Error('private parser message'), {
      type: 'entity.too.large', status: 413, body: 'private request', stack: 'private stack',
    });
    const { response, body } = catchException(exception);
    expect(response.status).toHaveBeenCalledWith(413);
    expect(body.error).toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE', source: 'platform', requestId: 'request-123' });
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it.each([{ status: 413 }, { status: 413, type: 'unknown' }, { status: 500, type: 'entity.too.large' }])(
    'does not trust unrelated external errors with HTTP-looking fields %p', (exception) => {
      const { response, body } = catchException(exception);
      expect(response.status).toHaveBeenCalledWith(500);
      expect(body.error.code).toBeNull();
    },
  );

  it('uses the gateway error envelope for case-insensitive paths with a query and trailing slash', () => {
    const { body } = catchException(
      { type: 'entity.too.large', status: 413 }, `${gatewayPath.toUpperCase()}/?test=1`,
    );
    expect(body.error).toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE', source: 'platform' });
  });

  it('accepts standard nested HttpException errors, copying only safe fields', () => {
    const { body } = catchException(new HttpException({
      error: {
        message: 'Upstream rate limit',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        param: 'model',
        requestId: 'untrusted-upstream-id',
        headers: { authorization: 'secret' },
        stack: 'private stack',
      },
      debug: 'private debug',
    }, 429));

    expect(body.message).toBe('Upstream rate limit');
    expect(body.error).toEqual({
      message: 'Upstream rate limit',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      param: 'model',
      requestId: 'request-123',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|private|untrusted/);
  });

  it('preserves an outer message and explicit null code/param in standard errors', () => {
    const { body } = catchException(new HttpException({
      message: 'Legacy message',
      error: { message: 'SDK message', type: 'custom_error', code: null, param: null },
    }, 422));

    expect(body.message).toBe('Legacy message');
    expect(body.error).toEqual({
      message: 'SDK message', type: 'custom_error', code: null, param: null, requestId: 'request-123',
    });
  });

  it.each(['platform', 'upstream'])('preserves the allowed gateway error source %s', (source) => {
    const { body } = catchException(new HttpException({ error: { message: 'Rate limited', source } }, 429));
    expect(body.error.source).toBe(source);
  });

  it.each(['vendor', 'PLATFORM', '', 1, {}, ['upstream'], null])(
    'does not propagate unsupported gateway source %p', (source) => {
      const { body } = catchException(new HttpException({ error: { source } }, 429));
      expect(body.error).not.toHaveProperty('source');
    },
  );

  it('copies only whitelisted rate limit fields and retains Unix millisecond resetAt', () => {
    const rateLimit = {
      rule: 'gateway-model', dimension: 'enterprise-member-subscription', limit: 60,
      windowMs: 60000, count: 60, retryAfterSeconds: 17, resetAt: 1791580817000,
    };
    const { body } = catchException(new HttpException({
      error: {
        message: 'Platform rate limit', type: 'rate_limit_error', code: 'PLATFORM_RATE_LIMIT_EXCEEDED',
        source: 'platform', rateLimit: { ...rateLimit, identity: { token: 'secret' }, key: 'private' },
      },
      retryAfterSeconds: 17,
    }, 429));
    expect(body.error.rateLimit).toEqual(rateLimit);
    expect(JSON.stringify(body)).not.toMatch(/secret|private|identity/);
    expect(body).not.toHaveProperty('retryAfterSeconds');
  });

  it.each([-1, NaN, Infinity, '12', {}, [], 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe numeric rate limit fields %p while retaining valid fields', (value) => {
      const { body } = catchException(new HttpException({ error: { rateLimit: {
        rule: 'gateway-model', dimension: { secret: 'private' },
        limit: value, windowMs: value, count: value, retryAfterSeconds: value, resetAt: value,
      } } }, 429));
      expect(body.error.rateLimit).toEqual({ rule: 'gateway-model' });
    },
  );

  it('retains zero-valued safe rate limit numbers', () => {
    const rateLimit = { limit: 0, windowMs: 0, count: 0, retryAfterSeconds: 0, resetAt: 0 };
    const { body } = catchException(new HttpException({ error: { rateLimit } }, 429));
    expect(body.error.rateLimit).toEqual(rateLimit);
  });

  it.each([undefined, null, [], 'private', 1, {}, { extra: 'secret' }])(
    'does not expose malformed or empty rate limit metadata %p', (rateLimit) => {
      const { body } = catchException(new HttpException({ error: { rateLimit } }, 429));
      expect(body.error).not.toHaveProperty('rateLimit');
    },
  );

  it('does not copy unexpected types from a nested error or validation entries', () => {
    const { body } = catchException(new HttpException({
      message: 'Invalid request',
      error: { message: { secret: true }, type: ['private'], code: { secret: true }, param: 1 },
      errors: [null, 'private', { field: 'model', message: 'Required', input: 'secret' }, { field: 1, message: 'private' }],
    }, 400));

    expect(body.errors).toEqual([{ field: 'model', message: 'Required' }]);
    expect(body.error).toEqual({
      message: 'Invalid request: model: Required', type: 'invalid_request_error', code: 'INVALID_PARAMETER',
      param: 'model', requestId: 'request-123', source: 'platform',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|private/);
  });

  it('converts array messages into readable SDK messages without changing the outer message', () => {
    const message = ['model must be a string', 'messages must be an array'];
    const { body } = catchException(new BadRequestException(message));

    expect(body.message).toEqual(message);
    expect(body.error.message).toBe(message.join('; '));
  });

  it('handles string HttpException responses', () => {
    const { body } = catchException(new HttpException('Not authorized', 401));
    expect(body.message).toBe('Not authorized');
    expect(body.error.message).toBe('Not authorized');
  });

  it('falls back to a generic error for unrecognized gateway response objects', () => {
    const { body } = catchException(new HttpException({ debug: 'secret' }, 502));
    expect(body.message).toBe('Internal server error');
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.type).toBe('server_error');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it.each([new Error('private credentials'), { message: 'private credentials', error: { message: 'secret' } }])(
    'never exposes raw non-HttpException details: %p',
    (exception) => {
      const { response, body } = catchException(exception);
      expect(response.status).toHaveBeenCalledWith(500);
      expect(body.message).toBe('Internal server error');
      expect(body.error).toEqual({
        message: 'Internal server error', type: 'server_error', code: null, param: null, requestId: 'request-123',
      });
      expect(JSON.stringify(body)).not.toMatch(/private|secret/);
    },
  );

  it('uses the response request id when no request context id is available', () => {
    const { body } = catchException(new BadRequestException('Invalid'), gatewayPath, '');
    expect(body.requestId).toBe('header-request-id');
    expect(body.error.requestId).toBe('header-request-id');
  });

  it('recognizes gateway routes with query strings', () => {
    const path = `${gatewayPath}?stream=false`;
    const { body } = catchException(new BadRequestException('Invalid'), path);
    expect(body.error.message).toBe('Invalid');
    expect(body.path).toBe(path);
  });

  it.each(['/api/employees', '/api/gateway-other/v1/chat/completions', '/api/tasks?next=/api/gateway/v1/chat/completions'])(
    'preserves the exact existing business envelope for %s',
    (path) => {
      const { body } = catchException(new BadRequestException({
        message: '请求参数校验失败', errors: [{ field: 'name', message: 'Required' }],
      }), path);
      expect(body).toEqual({
        statusCode: 400, message: '请求参数校验失败', requestId: 'request-123',
        timestamp: expect.any(String), path,
      });
    },
  );

  it('does not change object responses without a message on ordinary business routes', () => {
    const raw = { error: { message: 'Business error', code: 'business_code' } };
    const { body } = catchException(new HttpException(raw, 409), '/api/employees');
    expect(body.message).toEqual(raw);
    expect(body).not.toHaveProperty('error');
  });

  it.each(['/api/conversations/messages', '/api/task-planning/preview'])(
    'preserves platform policy rejection metadata across business routes %s', path => {
      const metadata = { rule: 'member-concurrency', dimension: 'enterprise/member', limit: 4,
        count: 4, resetAt: 123456, retryAfterSeconds: 17, policyVersion: 8 };
      const { response, body } = catchException(new HttpException({
        error: { message: 'Policy rejected', code: 'PLATFORM_ADMISSION_REJECTED', source: 'platform',
          ...metadata, rateLimit: { ...metadata, secret: 'hidden' } }, retryAfterSeconds: 17,
      }, 429), path);
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '17');
      expect(body.error).toMatchObject({ source: 'platform', code: 'PLATFORM_ADMISSION_REJECTED', ...metadata, rateLimit: metadata });
      expect(JSON.stringify(body)).not.toContain('hidden');
    },
  );

  it('preserves safe platform dependency 503 metadata outside the gateway', () => {
    const { body } = catchException(new HttpException({ error: { message: 'Unavailable',
      source: 'platform', code: 'PLATFORM_ADMISSION_UNAVAILABLE', policyVersion: 8, credentials: 'hidden' } }, 503), '/api/tasks');
    expect(body.error).toMatchObject({ source: 'platform', code: 'PLATFORM_ADMISSION_UNAVAILABLE', policyVersion: 8 });
    expect(JSON.stringify(body)).not.toContain('hidden');
  });

  it.each(['MODEL_RUNTIME_POLICY_INVALID', 'MODEL_RUNTIME_POLICY_UNAVAILABLE'])(
    'preserves safe snapshot failure %s without inventing a policy version', code => {
      const { body } = catchException(new HttpException({ error: {
        message: 'Snapshot unavailable', source: 'platform', code, credentials: 'hidden',
      } }, 503), '/api/task-planning/preview');
      expect(body.error).toMatchObject({ message: 'Snapshot unavailable', source: 'platform', code });
      expect(body.error).not.toHaveProperty('policyVersion');
      expect(JSON.stringify(body)).not.toContain('hidden');
    },
  );

  it('does not broaden the ordinary business envelope to unrelated platform 503 errors', () => {
    const raw = { message: 'Business unavailable', error: { source: 'platform', code: 'OTHER_UNAVAILABLE' } };
    const { body } = catchException(new HttpException(raw, 503), '/api/employees');
    expect(body.message).toBe('Business unavailable');
    expect(body).not.toHaveProperty('error');
  });
});
