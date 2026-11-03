import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SkillArtifactBlockedReasonSchema, SkillImportErrorCodeSchema } from 'shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KNOWLEDGE_BUSINESS_CODES = new Set([
  'ENTERPRISE_MEMBERSHIP_REQUIRED', 'DOCUMENT_NOT_READY', 'DOCUMENT_NOT_RETRYABLE',
  'DOCUMENT_PROCESSING', 'DOCUMENT_VERSION_CHANGED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_KEY_REQUIRED',
  'INVALID_IF_MATCH', 'PRECONDITION_REQUIRED', 'REVISION_CONFLICT', 'UNSUPPORTED_FORMAT',
  'VALIDATION_ERROR', 'TOKENIZER_UNAVAILABLE', 'LEGACY_KNOWLEDGE_GRANTS_RETIRED', 'MEMBER_SELECTION_INVALID',
]);

function isSkillArtifactRoute(originalUrl: string): boolean {
  try {
    // Match the URL forms Express accepts; reserved separators stay encoded.
    const path = decodeURI(originalUrl.split('?')[0]);
    return /^\/api\/client\/subscriptions\/[a-zA-Z0-9_-]{1,128}\/skills\/[a-zA-Z0-9_-]{1,128}\/versions\/[a-zA-Z0-9_-]{1,128}\/artifact\/?$/i.test(path);
  } catch {
    return false;
  }
}

function isSkillImportRoute(originalUrl: string): boolean {
  try {
    const path = decodeURI(originalUrl.split('?')[0]);
    return /^\/api\/skill-import(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
}

function safeRateLimit(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string | number> = {};
  for (const field of ['rule', 'dimension']) {
    if (typeof value[field] === 'string') result[field] = value[field];
  }
  // resetAt is Unix milliseconds, not an upstream date or a seconds timestamp.
  for (const field of ['limit', 'windowMs', 'count', 'retryAfterSeconds', 'resetAt', 'policyVersion']) {
    const number = value[field];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) {
      result[field] = number;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function waitingSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const seconds = Math.ceil(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function safeMediaSpecError(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const safe: Record<string, unknown> = {};
  const enums: Record<string, string[]> = {
    source: ['request', 'authorization', 'adapter', 'pricing', 'upstream', 'output', 'platform'],
    stage: ['validation', 'quote', 'submit', 'query', 'download', 'reconciliation'],
    submissionState: ['not_submitted', 'submitted', 'unknown'],
    billingState: ['not_reserved', 'reserved', 'settled', 'released', 'reconciling', 'unknown'],
  };
  for (const [key, allowed] of Object.entries(enums)) if (allowed.includes(String(value[key]))) safe[key] = value[key];
  if (typeof value.retryable === 'boolean') safe.retryable = value.retryable;
  // Reasons are platform-authored. Raw supplier text, requested values and URLs are not forwarded.
  if (typeof value.field === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value.field)) safe.field = value.field;
  if (typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 512
    && !/[\p{Cc}\p{Cf}]|https?:\/\/|Bearer\s|api[_-]?key|authorization/iu.test(value.reason)) safe.reason = value.reason;
  return safe;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request & { requestId?: string }>();
    // Express parser errors are not Nest HttpExceptions. Only normalize its known size error.
    if (isRecord(exception) && exception.type === 'entity.too.large' && exception.status === 413) {
      exception = new PayloadTooLargeException({
        error: {
          message: '请求体超过 HTTP 解析上限', type: 'invalid_request_error',
          code: 'REQUEST_BODY_TOO_LARGE', source: 'platform', param: null,
        },
        message: '请求体超过 HTTP 解析上限',
      });
    }
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const message = typeof raw === 'object' && raw !== null && 'message' in raw ? (raw as { message: unknown }).message : raw;
    const requestId = request.requestId || response.getHeader('x-request-id');
    const rawBody = isRecord(raw) ? raw : undefined;
    const skillImportRoute = isSkillImportRoute(request.originalUrl);
    const importCode = rawBody?.code ?? (isRecord(rawBody?.error) ? rawBody.error.code : undefined);
    const parsedImportCode = skillImportRoute ? SkillImportErrorCodeSchema.safeParse(importCode) : undefined;
    const skillImportCode = parsedImportCode?.success ? parsedImportCode.data : undefined;
    const skillImportRetryable = skillImportRoute && typeof rawBody?.retryable === 'boolean'
      ? rawBody.retryable : undefined;

    if (status === HttpStatus.TOO_MANY_REQUESTS && response.getHeader('Retry-After') === undefined) {
      let retryAfterSeconds = waitingSeconds(rawBody?.retryAfterSeconds);
      if (retryAfterSeconds === undefined) {
        const namedWaits = Object.entries(response.getHeaders()).flatMap(([name, value]) => {
          if (!/^retry-after-.+$/i.test(name)) return [];
          const seconds = typeof value === 'number' ? waitingSeconds(value)
            : typeof value === 'string' && /^\d+$/.test(value.trim())
              ? waitingSeconds(Number(value)) : undefined;
          return seconds === undefined ? [] : [seconds];
        });
        retryAfterSeconds = namedWaits.length ? Math.max(...namedWaits) : undefined;
      }
      response.setHeader('Retry-After', String(retryAfterSeconds ?? 60));
    }

    const body = {
      statusCode: status,
      message,
      requestId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    };

    if (status === HttpStatus.CONFLICT && isSkillArtifactRoute(request.originalUrl) &&
      rawBody?.code === 'SKILL_ARTIFACT_BLOCKED' && SkillArtifactBlockedReasonSchema.safeParse(rawBody.reason).success) {
      response.status(status).json({ ...body, code: 'SKILL_ARTIFACT_BLOCKED', reason: rawBody.reason });
      return;
    }

    // Keep the existing business API envelope unchanged outside the gateway.
    const path = request.originalUrl.split('?')[0].toLowerCase();
    const rawError = isRecord(rawBody?.error) ? rawBody.error : undefined;
    const versionedPolicy = typeof rawError?.policyVersion === 'number' &&
      Number.isSafeInteger(rawError.policyVersion) && rawError.policyVersion >= 0;
    const unavailableSnapshot = status === 503 &&
      ['MODEL_RUNTIME_POLICY_INVALID', 'MODEL_RUNTIME_POLICY_UNAVAILABLE'].includes(String(rawError?.code));
    const platformPolicyError = rawError?.source === 'platform' && [429, 503].includes(status) &&
      (versionedPolicy || unavailableSnapshot);
    if (path !== '/api/gateway' && !path.startsWith('/api/gateway/') && !platformPolicyError) {
      const knowledgeCode = /^\/api\/(?:knowledge-bases|admin\/knowledge)(?:\/|$)/.test(path) &&
        typeof rawBody?.code === 'string' && (/^KNOWLEDGE_[A-Z0-9_]{1,96}$/.test(rawBody.code) || KNOWLEDGE_BUSINESS_CODES.has(rawBody.code))
        ? { code: rawBody.code } : {};
      response.status(status).json({
        ...body,
        ...knowledgeCode,
        ...(skillImportCode ? { code: skillImportCode } : {}),
        ...(skillImportRetryable !== undefined ? { retryable: skillImportRetryable } : {}),
      });
      return;
    }

    const rateLimit = safeRateLimit(rawError?.rateLimit);
    const mediaSpecError = /^\/api\/gateway\/v1\/media\/(?:real|video-real)(?:\/|$)/.test(path)
      ? safeMediaSpecError(rawError) : {};
    const policyMetadata = safeRateLimit(rawError);
    const errors = Array.isArray(rawBody?.errors)
      ? rawBody.errors
          .filter((error): error is { field: string; message: string } =>
            isRecord(error) && typeof error.field === 'string' && typeof error.message === 'string',
          )
          .map(({ field, message }) => ({ field, message }))
      : undefined;
    const defaultMessage = status >= 500 ? 'Internal server error' : 'Request failed';
    const outerMessage = typeof message === 'string'
      ? message
      : Array.isArray(message)
        ? message.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
    const readableMessage = (Array.isArray(outerMessage) ? outerMessage.join('; ') : outerMessage) || defaultMessage;
    const validationMessage = errors?.length
      ? `${readableMessage}: ${errors.map(({ field, message }) => field ? `${field}: ${message}` : message).join('; ')}`
      : readableMessage;
    const errorMessage = typeof rawError?.message === 'string' && rawError.message
      ? rawError.message
      : validationMessage;

    response.status(status).json({
      ...body,
      ...(skillImportCode ? { code: skillImportCode } : {}),
      ...(skillImportRetryable !== undefined ? { retryable: skillImportRetryable } : {}),
      // Never use the whole upstream response as a message: it can contain private metadata.
      message: outerMessage ?? errorMessage,
      ...(errors !== undefined ? { errors } : {}),
      error: {
        message: errorMessage,
        type: typeof rawError?.type === 'string' && rawError.type
          ? rawError.type
          : status >= 500 ? 'server_error' : 'invalid_request_error',
        code: typeof rawError?.code === 'string' ? rawError.code : errors?.length ? 'INVALID_PARAMETER' : null,
        param: typeof rawError?.param === 'string' || rawError?.param === null
          ? rawError.param
          : errors?.[0]?.field || null,
        requestId,
        ...(policyMetadata ?? {}),
        ...(rawError?.source === 'platform' || rawError?.source === 'upstream'
          ? { source: rawError.source } : errors?.length ? { source: 'platform' } : {}),
        ...mediaSpecError,
        ...(rateLimit !== undefined ? { rateLimit } : {}),
      },
    });
  }
}
