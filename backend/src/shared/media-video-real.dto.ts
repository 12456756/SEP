import { z } from 'zod';
import { PaymentModeSchema } from './payment-preference.dto';
import { MediaExecutionReceiptFields } from './media-execution.dto';
import { MediaUpstreamErrorSchema, MediaReferenceMimeTypeSchema } from './media-reference.dto';
import { MediaFundingSchema, MediaMoneySchema } from './media-real.dto';
import {
  MediaVideoGatewayQuoteRequestSchema, MediaVideoGatewayQuoteRequestV3Schema,
  MediaVideoGatewayRequestSchema, MediaVideoGatewayRequestV3Schema,
  MediaVideoGatewayReferenceSchema, MediaVideoGatewayReceiptSchema,
  MediaVideoRuntimeProfileSchema,
  MediaVideoOperationSchema,
} from './media-video.dto';
import { MediaConfigVersionV3Schema, MediaProfileIdV3Schema, MediaVideoSpecV3Schema } from './media-spec.dto';
import { VIDEO_INPUT_MAX_BYTES, VIDEO_INPUT_MIME_TYPES } from './media-runtime-parameters';

export const MediaVideoReferenceUploadQuerySchema = z.object({
  profileId: MediaProfileIdV3Schema, configVersion: MediaConfigVersionV3Schema,
}).strict();
export type MediaVideoReferenceUploadQuery = z.infer<typeof MediaVideoReferenceUploadQuerySchema>;
export const MediaVideoInputReferenceSchema = z.object({
  mock: z.literal(false), kind: z.literal('video'), referenceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  ...MediaVideoReferenceUploadQuerySchema.shape,
  mimeType: z.enum(VIDEO_INPUT_MIME_TYPES), byteLength: z.number().int().positive().max(VIDEO_INPUT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type MediaVideoInputReference = z.infer<typeof MediaVideoInputReferenceSchema>;

// Keep real execution a separate strict contract; never widen the mock discriminator.
export const MediaVideoRealQuoteRequestSchema = z.union([MediaVideoGatewayQuoteRequestV3Schema, MediaVideoGatewayQuoteRequestSchema]);
export const MediaVideoRealRequestSchema = z.union([MediaVideoGatewayRequestV3Schema, MediaVideoGatewayRequestSchema]);
export type MediaVideoRealQuoteRequest = z.infer<typeof MediaVideoRealQuoteRequestSchema>;
export type MediaVideoRealRequest = z.infer<typeof MediaVideoRealRequestSchema>;

export const MediaVideoUsdSchema = z.string().regex(/^\d+(?:\.\d{1,12})?$/);
export const MediaVideoRealReferenceSchema = MediaVideoGatewayReferenceSchema.extend({
  mock: z.literal(false), mimeType: MediaReferenceMimeTypeSchema,
}).strict();
export type MediaVideoRealReference = z.infer<typeof MediaVideoRealReferenceSchema>;

export const MediaVideoRealQuoteBaseSchema = z.object({
  mock: z.literal(false),
  quoteId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expiresAt: z.string().datetime({ offset: true }),
  semanticSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  pricingStatus: z.literal('quoted'),
  amountCny: MediaMoneySchema,
  amountUsd: MediaVideoUsdSchema.nullable(),
  pricingVersion: z.string().min(1).max(128),
  usdToCnyRate: z.number().finite().positive().nullable(),
  billingStatus: z.literal('NOT_RESERVED'),
  funding: MediaFundingSchema,
}).strict();
export const MediaVideoRealQuoteV3Schema = MediaVideoRealQuoteBaseSchema.extend({
  protocolVersion: z.literal(3), semanticHashVersion: z.literal(3), specRevision: z.number().int().positive(),
  effectiveSpec: MediaVideoSpecV3Schema,
  billingDimensions: z.object({
    model: z.string().min(1).max(160), operation: MediaVideoOperationSchema,
    durationSeconds: z.number().int().positive(), resolution: z.string().min(1).max(64),
  }).strict(),
}).strict();
export const MediaVideoRealQuoteSchema = z.union([MediaVideoRealQuoteBaseSchema, MediaVideoRealQuoteV3Schema]);
export type MediaVideoRealQuote = z.infer<typeof MediaVideoRealQuoteSchema>;

export const MediaVideoRealBillingStatusSchema = z.enum(['NOT_RESERVED', 'RESERVED', 'SETTLED', 'RELEASED', 'RECONCILING']);
export const MediaVideoRealReceiptBaseSchema = MediaVideoGatewayReceiptSchema.innerType().extend({
  paymentMode: PaymentModeSchema.optional(),
  ...MediaExecutionReceiptFields,
  mock: z.literal(false),
  upstreamError: MediaUpstreamErrorSchema.optional(),
  billingStatus: MediaVideoRealBillingStatusSchema,
  amountCny: MediaMoneySchema.optional(),
  actualCostCny: MediaMoneySchema.optional(),
  amountUsd: MediaVideoUsdSchema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  const delivered = value.status === 'SUCCEEDED' || value.status === 'PARTIAL_SUCCEEDED';
  const taskTerminal = delivered || ['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(value.status);
  const billingPending = value.billingStatus === 'RESERVED' || value.billingStatus === 'RECONCILING';
  const pollingInvalid = value.clientActions
    ? (value.pollAfterMs !== null) !== value.clientActions.shouldPoll || value.recovery.canQuery !== value.clientActions.shouldPoll
    : taskTerminal ? value.pollAfterMs !== null || value.recovery.canQuery !== billingPending : !value.recovery.canQuery;
  if (new Set(value.outputs.map(output => output.outputId)).size !== value.outputs.length ||
    delivered && value.outputs.length === 0 || value.recovery.canDownload && (!delivered || value.outputs.length === 0) ||
    pollingInvalid || taskTerminal && value.recovery.canCancel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent real video receipt state.' });
  }
});
const MediaVideoV3OutputSchema = z.object({
  outputId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), kind: z.literal('video'),
  mimeType: z.string().min(1).max(128), byteLength: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), durationSeconds: z.number().finite().positive(),
  width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
  frameRate: z.number().finite().positive(), thumbnailOutputId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export const MediaVideoRealReceiptV3Schema = MediaVideoGatewayReceiptSchema.innerType().omit({ outputs: true }).extend({
  paymentMode: PaymentModeSchema.optional(),
  operation: MediaVideoOperationSchema,
  ...MediaExecutionReceiptFields,
  upstreamError: MediaUpstreamErrorSchema.optional(),
  profileId: MediaProfileIdV3Schema, configVersion: MediaConfigVersionV3Schema,
  mock: z.literal(false), billingStatus: MediaVideoRealBillingStatusSchema,
  amountCny: MediaMoneySchema.optional(), actualCostCny: MediaMoneySchema.optional(), amountUsd: MediaVideoUsdSchema.nullable().optional(),
  protocolVersion: z.literal(3), semanticHashVersion: z.literal(3), specRevision: z.number().int().positive(),
  effectiveSpec: MediaVideoSpecV3Schema, outputs: z.array(MediaVideoV3OutputSchema).max(4),
  billingDimensions: z.object({
    model: z.string().min(1).max(160), operation: MediaVideoOperationSchema,
    durationSeconds: z.number().int().positive(), resolution: z.string().min(1).max(64),
  }).strict(),
  actualSpec: z.object({
    durationSeconds: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
    frameRate: z.number().positive(), mimeType: z.string().min(1).max(128), hasAudio: z.boolean().nullable(),
    source: z.literal('measured'),
  }).strict().optional(), deliveryStatus: z.enum(['matched', 'mismatched', 'unknown']),
}).strict().superRefine((value, ctx) => {
  // A delivered/failed provider task may still need request-driven billing reconciliation.
  // In that window polling is for the billing evidence, not for the terminal provider task.
  const delivered = value.status === 'SUCCEEDED' || value.status === 'PARTIAL_SUCCEEDED';
  const taskTerminal = delivered || ['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(value.status);
  const billingPending = value.billingStatus === 'RESERVED' || value.billingStatus === 'RECONCILING';
  const terminalCanQuery = taskTerminal && billingPending;
  const pollingInvalid = value.clientActions
    ? (value.pollAfterMs !== null) !== value.clientActions.shouldPoll || value.recovery.canQuery !== value.clientActions.shouldPoll
    : taskTerminal ? value.pollAfterMs !== null || value.recovery.canQuery !== terminalCanQuery : !value.recovery.canQuery;
  if (new Set(value.outputs.map(output => output.outputId)).size !== value.outputs.length ||
    delivered && (value.outputs.length === 0 || !value.actualSpec) || value.recovery.canDownload && (!delivered || value.outputs.length === 0) ||
    pollingInvalid || taskTerminal && value.recovery.canCancel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent real video receipt state.' });
  }
});
export const MediaVideoRealReceiptSchema = z.union([MediaVideoRealReceiptBaseSchema, MediaVideoRealReceiptV3Schema]);
export type MediaVideoRealReceipt = z.infer<typeof MediaVideoRealReceiptSchema>;

export const MediaVideoRealProfilesSchema = z.object({
  mock: z.literal(false),
  protocolVersion: z.literal(1),
  persistence: z.literal('database'),
  billingStatus: z.literal('NOT_RESERVED'),
  profiles: z.array(MediaVideoRuntimeProfileSchema).min(1).max(64),
}).strict();
export type MediaVideoRealProfiles = z.infer<typeof MediaVideoRealProfilesSchema>;
