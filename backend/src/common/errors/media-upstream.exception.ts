import { HttpException } from '@nestjs/common';
import type { MediaJsonValue, MediaUpstreamError } from 'shared';

export class MediaUpstreamException extends HttpException {
  constructor(readonly upstreamError: MediaUpstreamError) {
    super(upstreamError.body as string | Record<string, unknown>, upstreamError.status);
  }
}

export function mediaFailure(error: unknown): MediaUpstreamError {
  if (error instanceof MediaUpstreamException) return error.upstreamError;
  if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse() as MediaJsonValue };
  return { status: 502, body: { error: error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) } } };
}

// Connection credentials must never enter client responses or persisted receipts.
export function protectMediaCredential(error: MediaUpstreamError, credential: string): MediaUpstreamError {
  const redact = (value: MediaJsonValue): MediaJsonValue => {
    if (typeof value === 'string') return credential ? value.split(credential).join('[REDACTED]') : value;
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      credential ? key.split(credential).join('[REDACTED]') : key, redact(child),
    ]));
    return value;
  };
  return { status: error.status, body: redact(error.body) };
}

export async function readMediaUpstreamError(response: Response): Promise<MediaUpstreamError> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 64 * 1024) throw new Error('Upstream error response exceeds 64 KiB');
      chunks.push(part.value);
    }
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body: MediaJsonValue = text;
  try { body = JSON.parse(text); } catch { /* Preserve non-JSON upstream errors. */ }
  return { status: response.status, body };
}
