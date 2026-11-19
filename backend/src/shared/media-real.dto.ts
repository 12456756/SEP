import { z } from 'zod';
import { MAX_MEDIA_REFERENCE_COUNT, MediaUpstreamErrorSchema, MediaReferenceMimeTypeSchema } from './media-reference.dto';
import { IMAGE_ADAPTER_MAX_OUTPUTS } from './media-runtime-parameters';
import { MediaGatewayIdSchema, MediaGatewayOutputSchema, MediaGatewayErrorCodeSchema } from './media-gateway.dto';
import { MediaConfigVersionV3Schema, MediaImageSpecV3Schema, MediaProfileIdV3Schema, MediaSpecAcceptanceSchema, MediaSpecMetadataV3Schema } from './media-spec.dto';

export const MediaRealParametersSchema = z.object({
  size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
  count: z.number().int().min(1).max(IMAGE_ADAPTER_MAX_OUTPUTS).default(1),
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
}).strict();
const request = z.object({
  profileId: MediaGatewayIdSchema, configVersion: MediaGatewayIdSchema,
  operation: z.enum(['generate', 'edit']), referenceIds: z.array(MediaGatewayIdSchema).max(4).default([]),
  creativeBrief: z.string().trim().min(1).max(4000), parameters: MediaRealParametersSchema.default({}),
}).strict();
const referencesValid = (value: z.infer<typeof request>) =>
  (value.operation !== 'edit' || value.referenceIds.length > 0) &&
  (value.operation !== 'generate' || value.referenceIds.length === 0) &&
  new Set(value.referenceIds).size === value.referenceIds.length;
export const MediaRealQuoteRequestSchema = request.refine(referencesValid, '参考图与操作不匹配');
export const MediaRealRequestSchema = request.extend({ clientRequestId: MediaGatewayIdSchema, quoteId: MediaGatewayIdSchema })
  .refine(referencesValid, '参考图与操作不匹配');
const requestV3 = MediaSpecMetadataV3Schema.extend({
  profileId: MediaProfileIdV3Schema, configVersion: MediaConfigVersionV3Schema,
  operation: z.enum(['generate', 'edit']), referenceIds: z.array(MediaGatewayIdSchema).max(MAX_MEDIA_REFERENCE_COUNT),
  creativeBrief: z.string().trim().min(1).max(4000), requestedSpec: MediaImageSpecV3Schema,
}).strict();
const referencesValidV3 = (value: z.infer<typeof requestV3>) => referencesValid({
  ...value, parameters: { size: '1024x1024', count: 1, quality: 'medium' },
});
export const MediaRealQuoteRequestV3Schema = requestV3.refine(referencesValidV3, '参考图与操作不匹配');
export const MediaRealRequestV3Schema = requestV3.extend({ clientRequestId: MediaGatewayIdSchema, quoteId: MediaGatewayIdSchema })
  .refine(referencesValidV3, '参考图与操作不匹配');
export const MediaRealAnyQuoteRequestSchema = z.union([MediaRealQuoteRequestV3Schema, MediaRealQuoteRequestSchema]);
export const MediaRealAnyRequestSchema = z.union([MediaRealRequestV3Schema, MediaRealRequestSchema]);
export type MediaRealQuoteRequest = z.infer<typeof MediaRealQuoteRequestSchema>;
export type MediaRealRequest = z.infer<typeof MediaRealRequestSchema>;
export type MediaRealQuoteRequestV3 = z.infer<typeof MediaRealQuoteRequestV3Schema>;
export type MediaRealRequestV3 = z.infer<typeof MediaRealRequestV3Schema>;
export type MediaRealAnyQuoteRequest = z.infer<typeof MediaRealAnyQuoteRequestSchema>;
export type MediaRealAnyRequest = z.infer<typeof MediaRealAnyRequestSchema>;
export const MediaMoneySchema = z.string().regex(/^\d+\.\d{6}$/);
export const MediaFundingSchema = z.object({
  creditCny: MediaMoneySchema, memberWalletCny: MediaMoneySchema, personalCny: MediaMoneySchema,
}).strict();
export const MediaRealReferenceSchema = z.object({
  mock: z.literal(false), referenceId: MediaGatewayIdSchema, expiresAt: z.string().datetime({ offset: true }),
  mimeType: MediaReferenceMimeTypeSchema, byteLength: z.number().int().positive().max(5 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
}).strict();
export type MediaRealReference = z.infer<typeof MediaRealReferenceSchema>;
export const MediaRealQuoteSchema = z.object({
  mock: z.literal(false), quoteId: MediaGatewayIdSchema, expiresAt: z.string().datetime({ offset: true }),
  semanticSha256: z.string().regex(/^[a-f0-9]{64}$/), pricingStatus: z.literal('quoted'), amountCny: MediaMoneySchema,
  pricingVersion: z.string().min(1).max(128), billingStatus: z.literal('NOT_RESERVED'), funding: MediaFundingSchema,
}).strict();
export const MediaRealQuoteV3Schema = MediaRealQuoteSchema.extend({
  protocolVersion: z.literal(3), semanticHashVersion: z.literal(3), specRevision: z.number().int().positive(),
  profileId: z.string().min(1), configVersion: z.string().min(1), modelId: z.string().min(1).max(160),
  adapterVersion: z.string().min(1).max(128), amountUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/),
  connectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), effectiveSpec: MediaImageSpecV3Schema,
  billingDimensions: z.object({ size: z.string().min(1).max(128), count: z.number().int().positive(), quality: z.string().min(1).max(128) }).strict(),
  normalizationNotes: z.array(z.string().min(1).max(240)).max(16),
}).strict();
export const MediaRealAnyQuoteSchema = z.union([MediaRealQuoteV3Schema, MediaRealQuoteSchema]);
export type MediaRealQuote = z.infer<typeof MediaRealAnyQuoteSchema>;
export const MediaRealErrorCodeSchema = z.union([MediaGatewayErrorCodeSchema, z.enum([
  'MEDIA_REAL_DISABLED', 'INSUFFICIENT_FUNDS', 'BILLING_PENDING', 'MISSING_SPEC', 'SPEC_CONFLICT',
  'ADAPTER_UNAVAILABLE', 'ADAPTER_FIELD_UNMAPPED', 'UPSTREAM_SPEC_UNSUPPORTED', 'OUTPUT_SPEC_MISMATCH', 'UPGRADE_REQUIRED',
])]);
export type MediaRealErrorCode = z.infer<typeof MediaRealErrorCodeSchema>;
export const MediaRealReceiptSchema = z.object({
  mock: z.literal(false), receiptId: MediaGatewayIdSchema, clientRequestId: MediaGatewayIdSchema,
  profileId: MediaGatewayIdSchema, configVersion: MediaGatewayIdSchema, executionMode: z.literal('sync-response'),
  status: z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']),
  pollAfterMs: z.number().int().nonnegative().nullable(), outputs: z.array(MediaGatewayOutputSchema).max(4),
  billingStatus: z.enum(['RESERVED', 'SETTLED', 'RELEASED', 'RECONCILING']), errorCode: MediaRealErrorCodeSchema.nullable(),
  upstreamError: MediaUpstreamErrorSchema.optional(),
  outputErrors: z.array(z.object({ index: z.number().int().min(0).max(3), code: MediaRealErrorCodeSchema }).strict()).max(4),
  recovery: z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict(),
}).strict();
export const MediaRealReceiptV3Schema = MediaRealReceiptSchema.extend({
  profileId: MediaProfileIdV3Schema, configVersion: MediaConfigVersionV3Schema,
  protocolVersion: z.literal(3), semanticHashVersion: z.literal(3), specRevision: z.number().int().positive(),
  effectiveSpec: MediaImageSpecV3Schema, actualSpec: MediaImageSpecV3Schema.optional(),
  acceptance: MediaSpecAcceptanceSchema,
}).strict();
export const MediaRealAnyReceiptSchema = z.union([MediaRealReceiptV3Schema, MediaRealReceiptSchema]);
export type MediaRealReceipt = z.infer<typeof MediaRealAnyReceiptSchema>;
