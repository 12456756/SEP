import { HttpException } from '@nestjs/common';
import { errorMessage, hasBusinessError, localError, sanitizeError, type ErrorJson } from './error-diagnostics';
import { createSseErrorDiagnostics } from './sse-error-diagnostics';

export class UpstreamHttpException extends HttpException {
  constructor(readonly upstreamError: { status: number; body: ErrorJson; headers?: Record<string, string> }, readonly diagnosticHeaders: Record<string, string> = {},
    readonly readDiagnostics?: { readError?: ErrorJson; truncated?: boolean }) {
    super(upstreamError.body as string | object, upstreamError.status >= 400 ? upstreamError.status : 502);
  }
}

export function upstreamHeaders(response: Response, secrets: readonly string[] = []): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['x-request-id', 'x-client-request-id', 'x-upstream-request-id', 'retry-after', 'x-video-dispatch', 'x-data-degraded']) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = String(sanitizeError(value, secrets));
  }
  return headers;
}

export async function upstreamException(response: Response, secrets: readonly string[] = [], maxBytes = 256 * 1024, signal?: AbortSignal): Promise<UpstreamHttpException> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  let readError: ErrorJson | undefined;
  const onAbort = () => {
    readError = sanitizeError(signal.reason, secrets);
    void reader?.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const deadline = setTimeout(() => {
    readError = { name: 'TimeoutError', message: 'Upstream error body could not be read within 5 seconds' };
    void reader?.cancel().catch(() => undefined);
  }, 5000);
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = maxBytes - length;
      chunks.push(part.value.subarray(0, remaining));
      length += Math.min(remaining, part.value.length);
      if (part.value.length > remaining) { truncated = true; break; }
    }
  } catch (error) { readError = sanitizeError(error, secrets); }
  finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
    // Cancellation must not hide an already received upstream status/body.
    void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* Text and partial bodies remain diagnostic evidence. */ }
  return new UpstreamHttpException({ status: response.status, body: sanitizeError(body, secrets) }, upstreamHeaders(response, secrets),
    readError !== undefined || truncated ? { ...(readError !== undefined ? { readError } : {}), ...(truncated ? { truncated } : {}) } : undefined);
}

/** Used by direct fetch and SDK transports so their wrappers cannot discard HTTP failures. */
export async function fetchUpstream(input: string | URL | Request, init?: RequestInit, secrets: readonly string[] = []): Promise<Response> {
  let response: Response;
  try { response = await fetch(input, init); }
  catch (error) { throw localError(error, 502, { origin: 'sep', stage: 'transport' }, secrets); }
  if (!response.ok) throw await upstreamException(response, secrets, 256 * 1024, init?.signal ?? undefined);
  return response;
}

export function assertUpstreamPayload(value: unknown, response: Response, secrets: readonly string[] = []): void {
  if (hasBusinessError(value)) throw new UpstreamHttpException({ status: response.status, body: sanitizeError(value, secrets) }, upstreamHeaders(response, secrets));
}

export async function readUpstreamJson<T = unknown>(response: Response, secrets: readonly string[] = []): Promise<T> {
  let value: unknown;
  try { value = await response.json(); }
  catch (error) { throw localError(error, 502, { origin: 'sep', stage: 'response-json', upstreamStatus: response.status }, secrets); }
  assertUpstreamPayload(value, response, secrets);
  return value as T;
}

/** Preserve SDK transport failures and redact only error events in model streams. */
export async function fetchModelUpstream(input: string | URL | Request, init?: RequestInit, secrets: readonly string[] = []): Promise<Response> {
  const response = await fetchUpstream(input, init, secrets);
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    const value = await readUpstreamJson(response, secrets);
    return new Response(JSON.stringify(value), { status: response.status, headers: response.headers });
  }
  if (type !== 'text/event-stream' || !response.body) return response;
  return redactUpstreamStream(response, secrets);
}

export function redactUpstreamStream(response: Response, secrets: readonly string[] = []): Response {
  if (!response.body) return response;
  const parser = createSseErrorDiagnostics(secrets);
  const reader = response.body.getReader();
  let closed = false;
  let released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (closed) return;
          const frames = done ? parser.finish() : parser.write(value);
          for (const frame of frames) controller.enqueue(frame);
          if (done) { closed = true; release(); controller.close(); return; }
          if (frames.length) return;
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        void reader.cancel().catch(() => undefined);
        release();
        controller.error(localError(error, 502, { origin: 'sep', stage: 'upstream-stream-read' }, secrets));
      }
    },
    async cancel(reason) {
      closed = true;
      try { await reader.cancel(reason); } finally { release(); }
    },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}

/** SSE consumers keep their protocol envelope, while retaining the complete diagnostic. */
export function streamErrorDetails(error: unknown, context: Record<string, unknown> = {}): Record<string, unknown> {
  const details = error instanceof HttpException ? sanitizeError(error.getResponse()) : sanitizeError(error);
  const record = details && typeof details === 'object' && !Array.isArray(details) ? details : { message: errorMessage(details) };
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error) ? record.error : {};
  return { ...context, ...record, ...nested, message: errorMessage(details) ?? 'No error reason was provided',
    ...(error instanceof UpstreamHttpException ? { origin: 'longdao', httpStatus: error.upstreamError.status,
      body: error.upstreamError.body, diagnosticHeaders: error.diagnosticHeaders, ...error.readDiagnostics } : {}) };
}
