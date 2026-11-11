import { Logger } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

const DIAGNOSTICS = Symbol('http-error-diagnostics');
type Diagnostics = { errorType?: string; errorCode?: string; errorMessage?: string; errorStack?: string[] };
type LoggedResponse = Response & { [DIAGNOSTICS]?: Diagnostics };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only short diagnostic fields are logged, never request/response bodies or headers. */
function safeText(value: string, limit = 500): string {
  return value.slice(0, 4096)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\b(?:https?:\/\/|postgres(?:ql)?:\/\/|redis(?:s)?:\/\/)[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/(\/[^\s"'<>?]+)\?[^\s"'<>]+/g, '$1?[REDACTED_QUERY]')
    .replace(/\bdata:[^\s"'<>]+/gi, '[REDACTED_DATA]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(["']?(?:password|pwd|(?:access[_-]?|refresh[_-]?)?token|secret|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b1[3-9]\d{9}\b/g, '[REDACTED_PHONE]')
    .replace(/\b\d{15,19}[Xx]?\b/g, '[REDACTED_NUMBER]')
    .slice(0, limit).trim();
}

function message(value: unknown): string | undefined {
  if (typeof value === 'string') return safeText(value) || undefined;
  if (Array.isArray(value)) {
    const parts = value.slice(0, 10).filter((item): item is string => typeof item === 'string')
      .map(item => item.slice(0, 4096));
    return parts.length ? safeText(parts.join('; ')) || undefined : undefined;
  }
  return undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

/** Attach internal diagnostics to the server response, without changing the API envelope. */
export function captureHttpException(response: Response, exception: unknown): void {
  if (!(exception instanceof Error)) return;
  const code = 'code' in exception ? identifier(exception.code) : undefined;
  (response as LoggedResponse)[DIAGNOSTICS] = {
    errorType: identifier(exception.name) ?? 'Error',
    ...(code ? { errorCode: code } : {}),
    // Prisma messages can contain generated SQL and argument values. Keep the type/code/frames.
    errorMessage: /^Prisma/.test(exception.name) ? 'Database operation failed' : safeText(exception.message),
    errorStack: exception.stack?.split('\n').filter(line => /^\s+at\s/.test(line))
      .slice(0, 6).map(line => safeText(line, 240)),
  };
}

export function httpLoggingMiddleware(request: Request, response: Response, next: NextFunction): void {
  const started = Date.now();
  let responseMessage: string | undefined;
  let responseCode: string | number | undefined;
  let written = false;
  const originalJson = response.json;
  response.json = function (body: unknown) {
    if (record(body)) {
      const error = record(body.error) ? body.error : undefined;
      responseMessage = message(error?.message) ?? message(body.message);
      const code = error?.code ?? body.code;
      responseCode = typeof code === 'number' && Number.isFinite(code) ? code : identifier(code);
    }
    return originalJson.call(this, body);
  };

  const write = (completed: boolean) => {
    if (written) return;
    written = true;
    const statusCode = response.statusCode;
    const headerId = response.getHeader('x-request-id');
    const requestId = (request as Request & { requestId?: string }).requestId ?? headerId;
    const entry = {
      event: 'http_request',
      method: request.method,
      // Query values can include login codes, tokens and private search text.
      path: safeText((request.originalUrl || request.url).split('?')[0], 512),
      statusCode,
      durationMs: Date.now() - started,
      requestId: identifier(requestId) ?? '[INVALID_REQUEST_ID]',
      completed,
      message: completed ? responseMessage ?? STATUS_CODES[statusCode] ?? 'HTTP response' : 'Connection closed before response completed',
      messageSource: !completed ? 'connection' : responseMessage ? 'response' : 'http_status',
      ...(responseCode !== undefined ? { code: responseCode } : {}),
      ...(statusCode >= 500 ? (response as LoggedResponse)[DIAGNOSTICS] : {}),
    };
    const line = JSON.stringify(entry);
    if (statusCode >= 500) Logger.error(line, undefined, 'HTTP');
    else if (statusCode >= 400 || !completed) Logger.warn(line, 'HTTP');
    else Logger.log(line, 'HTTP');
  };
  response.once('finish', () => write(true));
  response.once('close', () => write(response.writableFinished));
  next();
}
