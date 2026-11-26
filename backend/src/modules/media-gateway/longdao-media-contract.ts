import { z } from 'zod';
import type { MediaExecutionEvidence, MediaJsonValue } from 'shared';
import { MediaJsonValueSchema, MediaReceiptOperationSchema, MediaSubmissionStatusSchema } from 'shared';
import { MediaUpstreamException, mediaFailure, protectMediaCredential, readMediaUpstreamError } from '../../common/errors/media-upstream.exception';
import { upstreamHeaders } from '../../common/errors/upstream-http.exception';

export const VIDEO_SUBMISSION_BUDGET_MS = 247_000;
export const IMAGE_SUBMISSION_BUDGET_MS = 60_000;
export const MEDIA_SAVE_GRACE_MS = 10_000;
// Includes relay preflight and the bounded write of the final submission record.
export const VIDEO_CREATE_TIMEOUT_MS = 300_000;
export const IMAGE_CREATE_TIMEOUT_MS = 90_000;
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
export const LongdaoReceiptMetadataFields = {
  request_id: identifier.optional(), task_id: identifier.nullable().optional(),
  operation: z.string().optional(), receipt_operation: MediaReceiptOperationSchema.optional(),
  submission_status: MediaSubmissionStatusSchema.optional(),
  status: z.enum(['queued', 'processing', 'in_progress', 'completed', 'failed', 'cancelled']).nullable().optional(),
  is_final: z.boolean().nullable().optional(), status_observed_at: z.number().int().nonnegative().nullable().optional(),
  status_source: z.enum(['upstream', 'cached']).nullable().optional(),
  billing: z.object({ status: z.enum(['pending', 'settled', 'not_charged', 'unknown', 'not_applicable']),
    actual_cost_usd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable(), error: MediaJsonValueSchema.optional() }).passthrough().optional(),
  error: MediaJsonValueSchema.optional(), operation_error: MediaJsonValueSchema.optional(),
  task_error: MediaJsonValueSchema.optional(), submission_retry: MediaJsonValueSchema.optional(),
  submission_error: MediaJsonValueSchema.optional(), submission_record_error: MediaJsonValueSchema.optional(),
  http_status: z.number().int().min(100).max(599).optional(), diagnostic_truncated: z.boolean().optional(),
};
export const LongdaoMediaContractSchema = z.object({
  ...LongdaoReceiptMetadataFields,
  schema_version: z.literal(2), request_id: identifier,
  task_id: identifier.nullable().optional(), id: identifier.nullable().optional(),
  model: z.string().optional(), object: z.string().optional(), operation: z.string().optional(),
  submission_status: MediaSubmissionStatusSchema,
  status: z.enum(['queued', 'processing', 'in_progress', 'completed', 'failed', 'cancelled']).nullable(),
  is_final: z.boolean().nullable().optional(), status_observed_at: z.number().int().nonnegative().nullable().optional(),
  status_source: z.enum(['upstream', 'cached']).nullable().optional(),
  billing: z.object({ status: z.enum(['pending', 'settled', 'not_charged', 'unknown', 'not_applicable']),
    actual_cost_usd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable(), error: MediaJsonValueSchema.optional() }).passthrough(),
  error: MediaJsonValueSchema.optional(), operation_error: MediaJsonValueSchema.optional(),
  task_error: MediaJsonValueSchema.optional(), submission_retry: MediaJsonValueSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.billing.status === 'not_charged' && !/^0(?:\.0+)?$/.test(value.billing.actual_cost_usd ?? '') ||
      value.billing.status === 'settled' && value.billing.actual_cost_usd === null ||
      ['pending', 'unknown', 'not_applicable'].includes(value.billing.status) && value.billing.actual_cost_usd !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['billing'], message: 'Inconsistent Longdao billing evidence' });
  }
  if (value.submission_status === 'unobserved' && (value.task_id != null || value.id != null || value.status !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['submission_status'], message: 'Unobserved operations cannot supply task evidence' });
  }
});
export type LongdaoMediaContract = z.infer<typeof LongdaoMediaContractSchema>;
export type LongdaoMediaResult = { contract: LongdaoMediaContract; httpStatus: number; headers: Record<string, string>; originalBody?: MediaJsonValue };

export function recoverableTaskId(failure: unknown, requestId: string): string | null {
  const body = mediaFailure(failure).body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.request_id !== requestId) return null;
  const taskId = identifier.safeParse(body.task_id);
  return taskId.success && (body.id == null || body.id === taskId.data) ? taskId.data : null;
}

export async function readLongdaoMedia(response: Response, key: string, requestId: string, taskId?: string | null, creation = false): Promise<LongdaoMediaResult> {
  const failure = protectMediaCredential(await readMediaUpstreamError(response), key);
  let body = failure.body;
  // Some pre-dispatch image errors are emitted before Longdao installs its request-ID echo.
  if (creation && response.status >= 400 && body && typeof body === 'object' && !Array.isArray(body) &&
      body.schema_version === 2 && (body.request_id == null || body.request_id === '') &&
      ['failed', 'not_submitted', 'rejected'].includes(String(body.submission_status)) && !body.task_id && !body.id) {
    body = { ...body, request_id: requestId };
  }
  const parsed = LongdaoMediaContractSchema.safeParse(body);
  // An unauthorised/missing lookup carries the current operation's correlation,
  // never evidence that can replace the original task or its financial result.
  if (parsed.success && parsed.data.submission_status === 'unobserved' && !creation) {
    return { contract: parsed.data, httpStatus: response.status, headers: upstreamHeaders(response, [key]), originalBody: failure.body };
  }
  if (!parsed.success || ['unobserved', 'not_applicable'].includes(parsed.data.submission_status) ||
      parsed.data.billing.status === 'not_applicable' || parsed.data.request_id !== requestId ||
      taskId && parsed.data.task_id !== taskId ||
      parsed.data.id && parsed.data.task_id && parsed.data.id !== parsed.data.task_id) {
    throw new MediaUpstreamException(parsed.success ? { status: 502, body: { error: {
      code: 'UPSTREAM_FAILED', message: 'Longdao media response identity does not match the original request', details: failure.body,
    } } } : failure);
  }
  return { contract: parsed.data, httpStatus: response.status, headers: upstreamHeaders(response, [key]), originalBody: failure.body };
}

export function executionEvidence(result: LongdaoMediaResult): MediaExecutionEvidence {
  const c = result.contract;
  const status = c.status === 'processing' ? 'in_progress' : c.status;
  const taskFinal = status !== null && ['completed', 'failed', 'cancelled'].includes(status);
  const operation = c.receipt_operation ?? MediaReceiptOperationSchema.safeParse(c.operation).data;
  const operationError = c.operation_error !== undefined ? c.operation_error
    : c.submission_status === 'accepted' && status === 'failed' ? undefined : c.error;
  const submissionError = c.submission_error ?? (closedSubmission({ submissionStatus: c.submission_status }) &&
    (!operation || operation === 'create') ? c.error : undefined);
  const submissionHttpStatus = c.http_status ?? (submissionError != null && (!operation || operation === 'create') ? result.httpStatus : undefined);
  return {
    requestId: c.request_id, taskId: c.task_id ?? null, submissionStatus: c.submission_status,
    generationStatus: status, isFinal: c.is_final ?? (status === null ? null : taskFinal),
    observedAt: c.status_observed_at ?? null, statusSource: c.status_source ?? null,
    billing: { status: c.billing.status, actualCostUsd: c.billing.actual_cost_usd,
      ...(c.billing.error !== undefined ? { error: c.billing.error } : {}) },
    ...(operation ? { operation } : {}),
    ...(submissionError != null ? { submissionError } : {}),
    ...(submissionHttpStatus !== undefined ? { submissionHttpStatus } : {}),
    ...(c.submission_record_error != null ? { submissionRecordError: c.submission_record_error } : {}),
    ...(c.diagnostic_truncated !== undefined ? { diagnosticTruncated: c.diagnostic_truncated } : {}),
    ...(c.submission_retry !== undefined ? { submissionRetry: c.submission_retry } : {}),
    ...(c.task_error != null ? { taskError: c.task_error } : c.task_error === undefined && status === 'failed' &&
      c.submission_status === 'accepted' && c.error != null ? { taskError: c.error } : {}),
    ...(operationError != null || result.httpStatus >= 400 || c.submission_status === 'unobserved' ? { operationError: {
      status: result.httpStatus, body: result.originalBody ?? MediaJsonValueSchema.parse(c), headers: result.headers,
    } } : {}),
  };
}

export function closedSubmission(execution: Pick<MediaExecutionEvidence, 'submissionStatus'>): boolean {
  return ['not_submitted', 'rejected', 'failed', 'protocol_error'].includes(execution.submissionStatus);
}

export function mergeExecutionEvidence(previous: MediaExecutionEvidence, observed: MediaExecutionEvidence): MediaExecutionEvidence {
  if (observed.submissionStatus === 'unobserved') {
    return { ...previous, operation: observed.operation,
      ...(observed.operationError ? { operationError: observed.operationError } : {}) };
  }
  const execution = { ...observed };
  if (previous.isFinal && (execution.generationStatus !== previous.generationStatus || execution.isFinal !== true)) {
    execution.generationStatus = previous.generationStatus; execution.isFinal = true;
    execution.observedAt = previous.observedAt; execution.statusSource = 'cached'; execution.taskError = previous.taskError;
    execution.submissionStatus = previous.submissionStatus;
  }
  if (closedSubmission(previous)) {
    execution.submissionStatus = previous.submissionStatus;
    execution.generationStatus = previous.generationStatus; execution.isFinal = previous.isFinal;
  }
  if (['settled', 'not_charged'].includes(previous.billing.status)) execution.billing = previous.billing;
  if (previous.generationStatus === execution.generationStatus) execution.taskError ??= previous.taskError;
  execution.taskId ??= previous.taskId;
  execution.submissionError ??= previous.submissionError;
  execution.submissionRecordError ??= previous.submissionRecordError;
  execution.submissionHttpStatus ??= previous.submissionHttpStatus;
  execution.submissionRetry ??= previous.submissionRetry;
  return execution;
}

export function executionFailure(execution: MediaExecutionEvidence, httpStatus: number) {
  return execution.operationError ?? (execution.submissionError != null
    ? { status: execution.submissionHttpStatus ?? httpStatus, body: { error: execution.submissionError } }
    : execution.taskError != null ? { status: httpStatus, body: { error: execution.taskError } } : undefined);
}

export function mediaClientActions(execution: MediaExecutionEvidence, fileStatus: string, billingPending: boolean) {
  const submissionFinished = !['submitting', 'unknown', 'unobserved'].includes(execution.submissionStatus);
  const generationFinished = closedSubmission(execution) || execution.isFinal === true;
  const pollPurpose = !submissionFinished ? 'submission' as const : !generationFinished ? 'generation' as const
    : fileStatus === 'download_failed' || fileStatus === 'pending' && execution.generationStatus === 'completed' ? 'delivery' as const
      : billingPending ? 'billing' as const : 'none' as const;
  return { submissionFinished, generationFinished, shouldPoll: pollPurpose !== 'none', pollPurpose,
    canStartNewRequest: generationFinished, canRetryDownload: execution.generationStatus === 'completed' && fileStatus === 'download_failed' };
}

export async function longdaoMediaFetch(connection: { base: string; key: string }, path: string, init: RequestInit, timeout: number) {
  try {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${connection.key}`);
    headers.set('Accept', 'application/json');
    return await fetch(connection.base + path, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  } catch (error) { throw new MediaUpstreamException(protectMediaCredential(mediaFailure(error), connection.key)); }
}
