import { z } from 'zod';
import { MediaJsonValueSchema, MediaUpstreamErrorSchema } from './media-reference.dto';

export const MediaSubmissionStatusSchema = z.enum([
  'not_submitted', 'submitting', 'rejected', 'accepted', 'failed', 'protocol_error', 'unobserved', 'not_applicable', 'unknown',
]);
export const MediaReceiptOperationSchema = z.enum(['create', 'query', 'cancel', 'download', 'pricing', 'usage']);
export const MediaBillingEvidenceSchema = z.object({
  status: z.enum(['pending', 'settled', 'not_charged', 'unknown', 'not_applicable']),
  actualCostCny: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable().optional(),
  /** Historical cached receipts only; never used to calculate or confirm fees. */
  actualCostUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable().optional(),
  error: MediaJsonValueSchema.optional(),
}).strict();

export const MediaExecutionEvidenceSchema = z.object({
  requestId: z.string().min(1).max(256), taskId: z.string().min(1).max(256).nullable(),
  submissionStatus: MediaSubmissionStatusSchema,
  generationStatus: z.enum(['queued', 'in_progress', 'completed', 'failed', 'cancelled']).nullable(),
  isFinal: z.boolean().nullable(), observedAt: z.number().int().nonnegative().nullable(),
  statusSource: z.enum(['upstream', 'cached']).nullable(),
  billing: MediaBillingEvidenceSchema,
  operation: MediaReceiptOperationSchema.optional(),
  submissionRetry: MediaJsonValueSchema.optional(), taskError: MediaJsonValueSchema.optional(),
  submissionError: MediaJsonValueSchema.optional(), submissionRecordError: MediaJsonValueSchema.optional(),
  submissionHttpStatus: z.number().int().min(100).max(599).optional(), diagnosticTruncated: z.boolean().optional(),
  operationError: MediaUpstreamErrorSchema.optional(),
}).strict();
export type MediaExecutionEvidence = z.infer<typeof MediaExecutionEvidenceSchema>;

export const MediaClientActionsSchema = z.object({
  submissionFinished: z.boolean(), generationFinished: z.boolean(),
  shouldPoll: z.boolean(), pollPurpose: z.enum(['submission', 'generation', 'delivery', 'billing', 'none']),
  canStartNewRequest: z.boolean(), canRetryDownload: z.boolean(),
}).strict();
export const MediaExecutionReceiptFields = {
  receiptVersion: z.literal(2).optional(),
  execution: MediaExecutionEvidenceSchema.optional(),
  clientActions: MediaClientActionsSchema.optional(),
  fileStatus: z.enum(['pending', 'available', 'download_failed', 'expired', 'unavailable']).optional(),
  billingError: MediaUpstreamErrorSchema.optional(),
};
