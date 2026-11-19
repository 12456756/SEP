import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { captureHttpException } from '../middleware/http-logging.middleware';
import { errorMessage, exceptionDetails, sanitizeError } from '../errors/error-diagnostics';
import { UpstreamHttpException } from '../errors/upstream-http.exception';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function waitingSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const seconds = Math.ceil(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function knowledgeErrorDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(knowledgeErrorDetails);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:internalhost|query|content|documentname|enterpriseid|memberid)$/i.test(key.replace(/[-_]/g, '')))
    .map(([key, child]) => [key, knowledgeErrorDetails(child)]));
}

/** Adds correlation/protocol framing without discarding the producer's diagnostic fields. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request & { requestId?: string }>();
    captureHttpException(response, exception);
    if (exception instanceof UpstreamHttpException) {
      response.setHeader('X-SEP-Error-Source', 'upstream');
      response.setHeader('X-Compute-Status', String(exception.upstreamError.status));
      for (const [name, value] of Object.entries(exception.diagnosticHeaders)) {
        response.setHeader(name === 'x-request-id' ? 'X-Compute-Request-ID' : name, value);
      }
      const body = sanitizeError(exception.upstreamError.body);
      const status = exception.getStatus();
      if (exception.readDiagnostics) {
        response.status(status).json({ body, message: errorMessage(body),
          upstreamStatus: exception.upstreamError.status, ...sanitizeError(exception.readDiagnostics) as object });
      } else if (typeof body === 'string') response.status(status).type('text/plain').send(body);
      else response.status(status).json(body);
      return;
    }
    if (record(exception) && exception.type === 'entity.too.large' && exception.status === 413) {
      exception = new PayloadTooLargeException({ message: exception instanceof Error ? exception.message : 'Request body exceeds HTTP parser limit',
        code: 'REQUEST_BODY_TOO_LARGE',
        error: { code: 'REQUEST_BODY_TOO_LARGE', source: 'platform' } });
    }
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    // Explicit HTTP exceptions carry client diagnostics; unexpected failures stay in server logs.
    const path = request.originalUrl.split('?')[0].toLowerCase();
    const diagnostic = exception instanceof HttpException ? exceptionDetails(exception) : { message: 'Internal server error' };
    // Knowledge failures must not reveal private source data or tenant identities.
    const raw = /^\/api\/knowledge-bases(?:\/|$)/.test(path) ? knowledgeErrorDetails(diagnostic) : diagnostic;
    const details: Record<string, unknown> = record(raw) ? raw : { message: raw };
    const requestId = request.requestId || response.getHeader('x-request-id');
    const message = details.message ?? errorMessage(raw) ?? 'No error reason was provided';
    if (status === 429 && response.getHeader('Retry-After') === undefined) {
      const seconds = waitingSeconds(details.retryAfterSeconds);
      const waits = Object.entries(response.getHeaders()).flatMap(([name, value]) => {
        if (!/^retry-after-.+$/i.test(name)) return [];
        const parsed = typeof value === 'number' ? waitingSeconds(value)
          : typeof value === 'string' && /^\d+$/.test(value.trim()) ? waitingSeconds(Number(value)) : undefined;
        return parsed === undefined ? [] : [parsed];
      });
      const wait = seconds ?? (waits.length ? Math.max(...waits) : undefined);
      if (wait !== undefined) response.setHeader('Retry-After', String(wait));
    }
    const body: Record<string, unknown> = { statusCode: status, message, requestId,
      timestamp: new Date().toISOString(), path: request.originalUrl.split('?')[0], ...details };
    if (details.requestId !== undefined && details.requestId !== requestId) body.sepRequestId = requestId;
    if (path === '/api/gateway' || path.startsWith('/api/gateway/')) {
      const nested = record(details.error) ? details.error : {};
      const errors = Array.isArray(details.errors) ? details.errors : [];
      const validation = errors.filter(record).map(item => String(item.field ?? '') + ': ' + (errorMessage(item) ?? '')).join('; ');
      body.error = { message: validation ? (errorMessage(message) ?? '') + ': ' + validation : errorMessage(raw),
        type: status >= 500 ? 'server_error' : 'invalid_request_error', code: errors.length ? 'INVALID_PARAMETER' : null,
        param: errors.filter(record)[0]?.field ?? null, requestId,
        ...(errors.length ? { source: 'platform' } : {}), ...nested };
      if (typeof details.error === 'string') body.errorLabel = details.error;
    }
    response.status(status).json(sanitizeError(body));
  }
}
