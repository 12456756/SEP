import { BadRequestException } from '@nestjs/common';
import { runInNewContext } from 'node:vm';
import { exceptionDetails, sanitizeError } from './error-diagnostics';
import { fetchUpstream, readUpstreamJson, upstreamException } from './upstream-http.exception';

describe('error diagnostic preservation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retains errors created in another runtime context', () => {
    const error = runInNewContext('Object.assign(new SyntaxError("Unexpected token"), { code: "INVALID_JSON", cause: new Error("provider returned malformed JSON") })');
    expect(exceptionDetails(error)).toMatchObject({ name: 'SyntaxError', message: 'Unexpected token', code: 'INVALID_JSON',
      cause: { name: 'Error', message: 'provider returned malformed JSON' } });
  });

  it('redacts repeated credentials and private endpoints while retaining their cause', () => {
    expect(sanitizeError({ message: 'Configuration failed opaque-key at http://10.0.0.4:11434', apiKey: 'opaque-key',
      code: 'CONFIG_READ_FAILED' })).toEqual({ message: 'Configuration failed [REDACTED] at [REDACTED]',
      apiKey: '[REDACTED]', code: 'CONFIG_READ_FAILED' });
  });

  it('preserves numeric codes and arbitrary diagnostic fields while redacting sensitive data', () => {
    expect(sanitizeError({ error: { code: 1203, message: 'Unsupported size; Bearer token-value',
      details: { allowed: ['720p'], api_key: 'raw-key' }, param: { field: 'size' },
      stage: 'video-query', recovery: 'refresh_capabilities', attempts: [{ code: 'bad_size' }] } }))
      .toEqual({ error: { code: 1203, message: 'Unsupported size; Bearer [REDACTED]',
        details: { allowed: ['720p'], api_key: '[REDACTED]' }, param: { field: 'size' },
        stage: 'video-query', recovery: 'refresh_capabilities', attempts: [{ code: 'bad_size' }] } });
  });

  it('omits internal storage keys while retaining safe failure reasons', () => {
    expect(sanitizeError({ code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY',
      storageKey: 'private/mock.zip', nested: { package_key: 'private/package.zip', message: 'Archive entry is invalid' } }))
      .toEqual({ code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY', nested: { message: 'Archive entry is invalid' } });
  });

  it('keeps causes but removes credentials, request context and stack traces', () => {
    const error = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'),
      { code: 'ECONNREFUSED', url: 'postgres://user:password@private/db' }), request: { password: 'secret' } });
    expect(exceptionDetails(error)).toMatchObject({ name: 'Error', message: 'fetch failed',
      cause: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED', url: '[REDACTED]' } });
    expect(JSON.stringify(exceptionDetails(error))).not.toMatch(/password|stack|request/);
    expect(exceptionDetails(new BadRequestException({ code: 'BUSINESS', errors: [{ field: 'size', message: 'Required' }] })))
      .toMatchObject({ code: 'BUSINESS', errors: [{ field: 'size', message: 'Required' }] });
  });

  it('preserves top-level upstream failures, original header IDs and retry hints', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'INVALID_API_KEY', message: 'Invalid API key' }),
      { status: 401, headers: { 'X-Request-ID': 'compute-id', 'Retry-After': '10' } }));
    await expect(fetchUpstream('https://example.com')).rejects.toMatchObject({ upstreamError: {
      status: 401, body: { code: 'INVALID_API_KEY', message: 'Invalid API key' } }, diagnosticHeaders: { 'x-request-id': 'compute-id', 'retry-after': '10' } });
  });

  it('retains original status and partial body when reading an error body fails', async () => {
    let count = 0;
    const response = new Response(new ReadableStream({ pull(controller) {
      if (count++ === 0) controller.enqueue(Buffer.from('quota exhausted'));
      else controller.error(new Error('socket closed'));
    } }), { status: 429 });
    const error = await upstreamException(response);
    expect(error.upstreamError).toEqual({ status: 429, body: 'quota exhausted' });
    expect(error.readDiagnostics?.readError).toMatchObject({ message: 'socket closed' });
  });

  it('retains a bounded body and explicitly records truncation', async () => {
    const error = await upstreamException(new Response('unsupported size and more', { status: 422 }), [], 16);
    expect(error.upstreamError).toEqual({ status: 422, body: 'unsupported size' });
    expect(error.readDiagnostics).toEqual({ truncated: true });
  });

  it('recognizes a 200 business failure before successful output validation', async () => {
    await expect(readUpstreamJson(new Response(JSON.stringify({ error: { code: 1203, message: 'Reference rejected' } }))))
      .rejects.toMatchObject({ status: 502, upstreamError: { status: 200, body: { error: { code: 1203, message: 'Reference rejected' } } } });
  });
});
