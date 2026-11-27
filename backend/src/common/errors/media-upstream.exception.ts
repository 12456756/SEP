import { HttpException } from '@nestjs/common';
import type { MediaJsonValue, MediaUpstreamError } from 'shared';
import { sanitizeError, exceptionDetails } from './error-diagnostics';
import { UpstreamHttpException, upstreamException } from './upstream-http.exception';

export class MediaUpstreamException extends UpstreamHttpException {
  constructor(upstreamError: MediaUpstreamError, headers: Record<string, string> = upstreamError.headers ?? {}) {
    super({ status: upstreamError.status, body: upstreamError.body, ...(Object.keys(headers).length ? { headers } : {}) }, headers);
  }
}

export function mediaOperationException(failure: MediaUpstreamError,
  receipt: { receiptId?: string; clientRequestId?: string }): MediaUpstreamException {
  return new MediaUpstreamException(failure, { ...failure.headers,
    ...(receipt.receiptId ? { 'X-SEP-Receipt-ID': receipt.receiptId } : {}),
    ...(receipt.clientRequestId ? { 'X-SEP-Client-Request-ID': receipt.clientRequestId } : {}),
  });
}

export function mediaFailure(error: unknown): MediaUpstreamError {
  if (error instanceof UpstreamHttpException) return { ...error.upstreamError, headers: error.diagnosticHeaders };
  if (error instanceof HttpException) return { status: error.getStatus(), body: exceptionDetails(error) };
  return { status: 502, body: { error: { ...asRecord(exceptionDetails(error)), origin: 'sep' } } };
}

function asRecord(value: MediaJsonValue): Record<string, MediaJsonValue> {
  if (value === undefined) return {};
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { message: value };
}

export function mediaDispatchFailure(failure: MediaUpstreamError | undefined): MediaUpstreamError | undefined {
  if (!failure) return failure;
  const body = asRecord(failure.body);
  const error = asRecord(body.error);
  return error.origin === 'sep' && error.code === undefined
    ? { ...failure, body: { ...body, error: { ...error, code: 'SUBMISSION_UNKNOWN' } } } : failure;
}

/** A billing/query outage must not replace a previously reported generation failure. */
export function retainMediaFailure(previous: MediaUpstreamError | undefined, error: unknown, stage: string): MediaUpstreamError {
  const failure = mediaFailure(error);
  if (!previous) return failure;
  return { ...previous, body: { ...asRecord(previous.body), sepDiagnostics: {
    ...asRecord(asRecord(previous.body).sepDiagnostics), [stage]: sanitizeError(failure),
  } } };
}

// Connection credentials must never enter client responses or persisted receipts.
export function protectMediaCredential(error: MediaUpstreamError, credential: string): MediaUpstreamError {
  return { status: error.status, body: sanitizeError(error.body, [credential]),
    ...(error.headers ? { headers: sanitizeError(error.headers, [credential]) as Record<string, string> } : {}) };
}

export async function readMediaUpstreamError(response: Response): Promise<MediaUpstreamError> {
  const failure = await upstreamException(response);
  return { status: response.status, ...(Object.keys(failure.diagnosticHeaders).length ? { headers: failure.diagnosticHeaders } : {}), body: failure.readDiagnostics
    ? { body: failure.upstreamError.body, ...failure.readDiagnostics } as MediaJsonValue
    : failure.upstreamError.body };
}
