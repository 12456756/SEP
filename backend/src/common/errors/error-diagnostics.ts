import { HttpException } from '@nestjs/common';
import { types } from 'node:util';

export type ErrorJson = string | number | boolean | null | ErrorJson[] | { [key: string]: ErrorJson };
export const REDACTED = '[REDACTED]';
const secretField = /^(?:password|passwd|pwd|secret|clientsecret|apikey|accesskey|privatekey|credential|credentials|authorization|proxyauthorization|cookie|setcookie|token|accesstoken|refreshtoken|idtoken|signature|signedurl|connectionstring|databaseurl)$/i;

export function redactErrorText(value: string, secrets: readonly string[] = []): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join(REDACTED);
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\bBearer\s+[^\s"',;<>]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, `Basic ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/(["']?(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|authorization|cookie|signature)["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+[^\s"',;<>]+|"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;&]+)/gi, `$1${REDACTED}`)
    .replace(/\b(?:https?|postgres(?:ql)?|redis(?:s)?):\/\/[^\s"'<>]+/gi, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password || !/^https?:$/.test(url.protocol)) return REDACTED;
        if (/^(?:localhost$|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(url.hostname)
          || !url.hostname.includes('.') || /\.(?:internal|local)$/i.test(url.hostname)) return REDACTED;
        if (url.search) return raw.slice(0, raw.indexOf('?')) + '?[REDACTED]';
        return raw;
      } catch { return REDACTED; }
    })
    .replace(/\b[A-Z]:\\(?:[^\s"'<>]+\\)*[^\s"'<>]*/gi, REDACTED)
    .replace(/\/(?:home|Users|root|var|tmp|app|workspace)\/[^\s"'<>]+/g, REDACTED)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
    .replace(/\b1[3-9]\d{9}\b/g, REDACTED);
}

/** Preserve JSON diagnostics; only credentials, private context and unsafe object graphs are removed. */
export function sanitizeError(value: unknown, secrets: readonly string[] = []): ErrorJson {
  const knownSecrets = [...secrets];
  const scanned = new WeakSet<object>();
  function collect(input: unknown, depth: number) {
    if (!input || typeof input !== 'object' || depth > 24 || scanned.has(input)) return;
    scanned.add(input);
    for (const [key, child] of Object.entries(input)) {
      if (secretField.test(key.replace(/[-_\s]/g, '')) && typeof child === 'string' && child) knownSecrets.push(child);
      else collect(child, depth + 1);
    }
    if (types.isNativeError(input) && 'cause' in input) collect(input.cause, depth + 1);
  }
  collect(value, 0);
  const parents = new WeakSet<object>();
  function visit(input: unknown, depth: number): ErrorJson {
    if (typeof input === 'string') return redactErrorText(input, knownSecrets);
    if (input === null || input === undefined) return null;
    if (typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (typeof input === 'bigint') return String(input);
    if (typeof input !== 'object') return String(input);
    if (depth > 24) return '[DEPTH_LIMIT]';
    if (parents.has(input)) return '[CIRCULAR]';
    parents.add(input);
    try {
      if (input instanceof Date) return input.toISOString();
      if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
      const record: Record<string, unknown> = types.isNativeError(input)
        ? { ...input, name: input.name, message: input.message,
          ...('cause' in input ? { cause: input.cause } : {}),
          ...('errors' in input ? { errors: input.errors } : {}) }
        : input as Record<string, unknown>;
      const result: { [key: string]: ErrorJson } = Object.create(null);
      for (const [key, child] of Object.entries(record)) {
        if (child === undefined || typeof child === 'function' || key === '__proto__' || key === 'constructor') continue;
        const normalized = key.replace(/[-_\s]/g, '');
        if (/^(?:stack|requestbody|requestheaders|request|config)$/i.test(normalized)) continue;
        result[redactErrorText(key, knownSecrets)] = secretField.test(normalized) ? REDACTED : visit(child, depth + 1);
      }
      return result;
    } finally { parents.delete(input); }
  }
  return visit(value, 0);
}

export function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) return value.map(errorMessage).filter(Boolean).join('; ') || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  for (const candidate of [body.error, body.message, body.detail, body.reason, body.cause]) {
    if (candidate === value) continue;
    const message = errorMessage(candidate);
    if (message) return message;
  }
  return undefined;
}

export function exceptionDetails(error: unknown, secrets: readonly string[] = []): ErrorJson {
  if (error instanceof HttpException) return sanitizeError(error.getResponse(), secrets);
  return sanitizeError(error, secrets);
}

export function hasBusinessError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Boolean(body.error) || body.type === 'error' || body.type === 'response.failed' || body.type === 'response.error';
}

export function localError(error: unknown, status = 502, context: Record<string, unknown> = {}, secrets: readonly string[] = []): HttpException {
  if (error instanceof HttpException) return error;
  const details = exceptionDetails(error, secrets);
  return new HttpException(sanitizeError({ ...context, message: errorMessage(details) ?? String(error), cause: details }, secrets) as object, status);
}
