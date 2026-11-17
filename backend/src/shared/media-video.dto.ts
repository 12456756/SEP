import { z } from 'zod';
import { MAX_MEDIA_REFERENCE_COUNT, MediaReferenceCountSchema } from './media-reference.dto';
import { MediaConfigVersionV3Schema, MediaProfileIdV3Schema, MediaSpecMetadataV3Schema, MediaVideoSpecV3Schema } from './media-spec.dto';

const MediaVideoIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const DateTimeSchema = z.string().datetime({ offset: true });

export const MediaVideoOperationSchema = z.enum(['image-to-video', 'text-to-video']);
export type MediaVideoOperation = z.infer<typeof MediaVideoOperationSchema>;
export const MediaVideoResolutionSchema = z.enum(['480p', '720p', '1080p', '4k']);
export type MediaVideoResolution = z.infer<typeof MediaVideoResolutionSchema>;
export const VIDEO_RESOLUTION_ORDER = ['480p', '720p', '1080p', '4k'] as const;
export function isVideoResolutionWithinLimit(value: string, maxResolution: string): boolean {
  const valueRank = VIDEO_RESOLUTION_ORDER.indexOf(value as typeof VIDEO_RESOLUTION_ORDER[number]);
  const maxRank = VIDEO_RESOLUTION_ORDER.indexOf(maxResolution as typeof VIDEO_RESOLUTION_ORDER[number]);
  return valueRank >= 0 && maxRank >= 0 && valueRank <= maxRank;
}

export const MediaVideoExecutionModeSchema = z.literal('async-query');

export const MediaVideoDurationRangeSchema = z.object({
  minimum: z.number().int().positive().safe(),
  maximum: z.number().int().positive().safe(),
}).strict().refine(value => value.minimum <= value.maximum,
  { path: ['maximum'], message: '最长时长不能小于最短时长' });

export function isVideoDurationInRange(duration: number | undefined,
  range?: { minimum?: number; maximum?: number }): boolean {
  return duration === undefined || !range ||
    (range.minimum !== undefined && range.maximum !== undefined && duration >= range.minimum && duration <= range.maximum);
}

const MediaVideoCapabilitiesBaseSchema = z.object({
  supportsTextToVideo: z.boolean().default(false),
  supportsImageToVideo: z.boolean().default(false),
  supportsAudio: z.boolean().default(false),
  durationsSeconds: z.array(z.number().int().positive().safe()).min(1).max(32),
  durationRange: MediaVideoDurationRangeSchema.optional(),
  aspectRatios: z.array(z.string().regex(/^\d+:\d+$/)).min(1).max(16),
  resolutions: z.array(z.string().trim().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u)).min(1).max(8),
  frameRates: z.array(z.number().finite().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(8),
  maxInputBytes: z.number().int().positive().max(100 * 1024 * 1024),
  maxReferenceCount: MediaReferenceCountSchema,
  outputFormats: z.array(z.enum(['video/mp4', 'video/webm'])).min(1).max(4),
  supportsTaskQuery: z.literal(true),
  supportsCancel: z.boolean(),
  resultRetentionSeconds: z.number().int().positive().max(7 * 24 * 60 * 60),
}).strict();

export const MediaVideoCapabilitiesSchema = MediaVideoCapabilitiesBaseSchema.superRefine((value, ctx) => {
  if (value.supportsImageToVideo && value.maxReferenceCount < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxReferenceCount'], message: 'Image-to-video requires a reference slot.' });
  }
});
export type MediaVideoCapabilities = z.infer<typeof MediaVideoCapabilitiesSchema>;

const MediaVideoProfileBaseSchema = z.object({
  profileId: MediaVideoIdSchema,
  kind: z.literal('video'),
  displayName: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(160),
  configVersion: z.string().trim().min(1).max(80),
  operations: z.array(MediaVideoOperationSchema).min(1).max(2),
  executionMode: MediaVideoExecutionModeSchema,
  capabilities: MediaVideoCapabilitiesSchema,
  enabled: z.boolean(),
  verified: z.boolean(),
}).strict();

export const MediaVideoProfileSchema = MediaVideoProfileBaseSchema.superRefine((value, ctx) => {
  if (value.operations.includes('image-to-video') && !value.capabilities.supportsImageToVideo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'supportsImageToVideo'], message: 'Profile operation requires image-to-video capability.' });
  }
  if (value.operations.includes('text-to-video') && !value.capabilities.supportsTextToVideo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'supportsTextToVideo'], message: 'Profile operation requires text-to-video capability.' });
  }
});
export type MediaVideoProfile = z.infer<typeof MediaVideoProfileSchema>;

export const MediaVideoRuntimeProfileSchema = MediaVideoProfileBaseSchema.omit({ modelId: true, enabled: true, verified: true });
export const MediaVideoRuntimeSchema = z.object({
  protocolVersion: z.literal(1),
  executionMode: z.enum(['mock', 'real']).optional(),
  executionAvailable: z.boolean(),
  defaultProfileId: MediaVideoIdSchema.nullable(),
  tools: z.array(z.enum(['video_from_image', 'video_generate', 'video_get_job', 'video_cancel_job'])),
  profiles: z.array(MediaVideoRuntimeProfileSchema).max(64),
}).strict().superRefine((value, ctx) => {
  if (!value.executionAvailable && value.tools.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'Disabled video runtime cannot expose tools.' });
  if (value.executionAvailable && value.profiles.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Executable video runtime requires a profile.' });
  if (new Set(value.profiles.map(profile => profile.profileId)).size !== value.profiles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Duplicate video profiles.' });
  if (value.defaultProfileId !== null && !value.profiles.some(profile => profile.profileId === value.defaultProfileId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultProfileId'], message: 'Default video profile is unavailable.' });
  for (const profile of value.profiles) {
    if (profile.operations.includes('image-to-video') && !profile.capabilities.supportsImageToVideo || profile.operations.includes('text-to-video') && !profile.capabilities.supportsTextToVideo) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Video profile capability mismatch.' });
  }
  for (const tool of value.tools) {
    if (tool === 'video_from_image' && !value.profiles.some(profile => profile.operations.includes('image-to-video')) || tool === 'video_generate' && !value.profiles.some(profile => profile.operations.includes('text-to-video')) || tool === 'video_cancel_job' && !value.profiles.some(profile => profile.capabilities.supportsCancel)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'Video tool capability is unavailable.' });
  }
});
export type MediaVideoRuntime = z.infer<typeof MediaVideoRuntimeSchema>;

const MediaVideoDefaultsSchema = z.object({
  durationSeconds: z.number().int().positive(), aspectRatio: z.string().regex(/^\d+:\d+$/),
  resolution: z.enum(['480p', '720p', '1080p', '4k']), frameRate: z.number().int().positive(),
  audio: z.boolean(), outputFormat: z.enum(['video/mp4', 'video/webm']),
}).strict();

export const MediaVideoRuntimeV2ProfileSchema = MediaVideoRuntimeProfileSchema.extend({
  capabilities: MediaVideoCapabilitiesBaseSchema.extend({
    audioModes: z.array(z.boolean()).min(1).max(2),
    defaultAudio: z.boolean(),
    defaults: MediaVideoDefaultsSchema,
  }).strict(),
}).strict().superRefine((profile, ctx) => {
  const { capabilities } = profile;
  if (!capabilities.audioModes.includes(capabilities.defaultAudio) || capabilities.defaultAudio !== capabilities.defaults.audio) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'defaultAudio'], message: 'Audio default must match an available audio mode and defaults.' });
  }
  if (!capabilities.durationsSeconds.includes(capabilities.defaults.durationSeconds)
    || !capabilities.aspectRatios.includes(capabilities.defaults.aspectRatio)
    || !capabilities.resolutions.includes(capabilities.defaults.resolution)
    || !capabilities.frameRates.includes(capabilities.defaults.frameRate)
    || !capabilities.outputFormats.includes(capabilities.defaults.outputFormat)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'defaults'], message: 'Video defaults must be available in capabilities.' });
  }
  if (capabilities.supportsAudio !== capabilities.audioModes.includes(true)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'audioModes'], message: 'Audio modes must agree with supportsAudio.' });
  }
});

export const MediaVideoRuntimeV2Schema = z.object({
  protocolVersion: z.literal(2), executionMode: z.enum(['mock', 'real']).optional(), executionAvailable: z.boolean(),
  defaultProfileId: MediaVideoIdSchema.nullable(), tools: z.array(z.enum(['video_from_image', 'video_generate', 'video_get_job', 'video_cancel_job'])),
  profiles: z.array(MediaVideoRuntimeV2ProfileSchema).max(64),
}).strict().superRefine((runtime, ctx) => {
  if (!runtime.executionAvailable && runtime.tools.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'Disabled video runtime cannot expose tools.' });
  if (runtime.executionAvailable && !runtime.profiles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Executable runtime requires a profile.' });
  if (new Set(runtime.profiles.map(profile => profile.profileId)).size !== runtime.profiles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Duplicate video profiles.' });
  if (runtime.defaultProfileId !== null && !runtime.profiles.some(profile => profile.profileId === runtime.defaultProfileId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultProfileId'], message: 'Default profile must be available.' });
  }
  for (const profile of runtime.profiles) {
    const { capabilities } = profile;
    if (profile.operations.includes('image-to-video') && (!capabilities.supportsImageToVideo || capabilities.maxReferenceCount < 1)
      || profile.operations.includes('text-to-video') && !capabilities.supportsTextToVideo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Video profile operation capabilities are inconsistent.' });
    }
  }
  for (const tool of runtime.tools) {
    if (tool === 'video_from_image' && !runtime.profiles.some(profile => profile.operations.includes('image-to-video'))
      || tool === 'video_generate' && !runtime.profiles.some(profile => profile.operations.includes('text-to-video'))
      || tool === 'video_cancel_job' && !runtime.profiles.some(profile => profile.capabilities.supportsCancel)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'Video tool capability is unavailable.' });
    }
  }
});
export type MediaVideoRuntimeV2 = z.infer<typeof MediaVideoRuntimeV2Schema>;

export const MediaVideoParametersSchema = z.object({
  durationSeconds: z.number().int().positive().max(600),
  aspectRatio: z.string().regex(/^\d+:\d+$/),
  resolution: z.enum(['480p', '720p', '1080p', '4k']),
  frameRate: z.number().int().positive().max(120),
  audio: z.boolean(),
  outputFormat: z.enum(['video/mp4', 'video/webm']),
}).strict();
export type MediaVideoParameters = z.infer<typeof MediaVideoParametersSchema>;

const VideoRequestObjectSchema = z.object({
  profileId: MediaVideoIdSchema,
  configVersion: MediaVideoIdSchema,
  operation: MediaVideoOperationSchema,
  referenceIds: z.array(MediaVideoIdSchema).max(4),
  creativeBrief: z.string().trim().min(1).max(4000),
  parameters: MediaVideoParametersSchema,
}).strict();

function refineVideoRequest(value: z.infer<typeof VideoRequestObjectSchema>, ctx: z.RefinementCtx): void {
  if (value.operation === 'image-to-video' && value.referenceIds.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceIds'], message: 'Image-to-video requires exactly one reference.' });
  }
  if (value.operation === 'text-to-video' && value.referenceIds.length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceIds'], message: 'Text-to-video does not accept references in v1.' });
  }
}

export const MediaVideoGatewayQuoteRequestSchema = VideoRequestObjectSchema.superRefine(refineVideoRequest);
export type MediaVideoGatewayQuoteRequest = z.infer<typeof MediaVideoGatewayQuoteRequestSchema>;
export const MediaVideoGatewayRequestSchema = VideoRequestObjectSchema.extend({
  clientRequestId: MediaVideoIdSchema,
  quoteId: MediaVideoIdSchema,
}).superRefine(refineVideoRequest);
export type MediaVideoGatewayRequest = z.infer<typeof MediaVideoGatewayRequestSchema>;

const MediaVideoRequestV3BaseSchema = z.object({
  protocolVersion: z.literal(3),
  profileId: MediaProfileIdV3Schema,
  configVersion: MediaConfigVersionV3Schema,
  operation: MediaVideoOperationSchema,
  referenceIds: z.array(MediaVideoIdSchema).max(MAX_MEDIA_REFERENCE_COUNT),
  creativeBrief: z.string().trim().min(1).max(4000),
  specRevision: MediaSpecMetadataV3Schema.shape.specRevision,
  requestedSpec: MediaVideoSpecV3Schema,
  parameterSources: MediaSpecMetadataV3Schema.shape.parameterSources,
}).strict();

function refineVideoRequestV3(value: z.infer<typeof MediaVideoRequestV3BaseSchema>, ctx: z.RefinementCtx): void {
  if (value.operation === 'image-to-video' && value.referenceIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceIds'], message: 'Image-to-video requires at least one reference.' });
  }
  if (value.operation === 'text-to-video' && value.referenceIds.length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceIds'], message: 'Text-to-video does not accept references.' });
  }
  if (new Set(value.referenceIds).size !== value.referenceIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceIds'], message: 'Duplicate references are not allowed.' });
  }
  const spec = value.requestedSpec;
  if ((spec.width === undefined) !== (spec.height === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requestedSpec'], message: 'Width and height must be provided together.' });
  }
}

export const MediaVideoGatewayQuoteRequestV3Schema = MediaVideoRequestV3BaseSchema.superRefine(refineVideoRequestV3);
export type MediaVideoGatewayQuoteRequestV3 = z.infer<typeof MediaVideoGatewayQuoteRequestV3Schema>;
export const MediaVideoGatewayRequestV3Schema = MediaVideoRequestV3BaseSchema.extend({
  clientRequestId: MediaVideoIdSchema,
  quoteId: MediaVideoIdSchema,
}).superRefine(refineVideoRequestV3);
export type MediaVideoGatewayRequestV3 = z.infer<typeof MediaVideoGatewayRequestV3Schema>;

export const MediaVideoGatewayOutputSchema = z.object({
  outputId: MediaVideoIdSchema,
  kind: z.literal('video'),
  mimeType: z.enum(['video/mp4', 'video/webm']),
  byteLength: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  sha256: Sha256Schema,
  durationSeconds: z.number().positive().max(600),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  frameRate: z.number().positive().max(120),
  thumbnailOutputId: MediaVideoIdSchema.nullable(),
  expiresAt: DateTimeSchema.nullable(),
}).strict();
export type MediaVideoGatewayOutput = z.infer<typeof MediaVideoGatewayOutputSchema>;

export const MediaVideoGatewayReferenceSchema = z.object({
  mock: z.literal(true),
  referenceId: MediaVideoIdSchema,
  expiresAt: DateTimeSchema,
  mimeType: z.literal('image/png'),
  byteLength: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: Sha256Schema,
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
}).strict();
export type MediaVideoGatewayReference = z.infer<typeof MediaVideoGatewayReferenceSchema>;

export const MediaVideoGatewayReceiptSchema = z.object({
  mock: z.literal(true),
  receiptId: MediaVideoIdSchema,
  clientRequestId: MediaVideoIdSchema,
  profileId: MediaVideoIdSchema,
  configVersion: MediaVideoIdSchema,
  operation: MediaVideoOperationSchema,
  status: z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED', 'SUBMISSION_UNKNOWN']),
  pollAfterMs: z.number().int().nonnegative().nullable(),
  outputs: z.array(MediaVideoGatewayOutputSchema).max(4),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
  errorCode: z.string().nullable(),
  recovery: z.object({ canQuery: z.boolean(), canCancel: z.boolean(), canDownload: z.boolean() }).strict(),
}).strict().superRefine((value, ctx) => {
  const delivered = value.status === 'SUCCEEDED' || value.status === 'PARTIAL_SUCCEEDED';
  const terminal = delivered || ['FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(value.status);
  if (new Set(value.outputs.map(output => output.outputId)).size !== value.outputs.length || delivered && value.outputs.length === 0 || value.recovery.canDownload && !delivered || terminal && (value.pollAfterMs !== null || value.recovery.canQuery)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent video receipt state.' });
  }
});
export type MediaVideoGatewayReceipt = z.infer<typeof MediaVideoGatewayReceiptSchema>;

export const MediaVideoGatewayQuoteSchema = z.object({
  mock: z.literal(true),
  quoteId: MediaVideoIdSchema,
  expiresAt: DateTimeSchema,
  semanticSha256: Sha256Schema,
  pricingStatus: z.literal('quoted'),
  amountCny: z.literal('0.000000'),
  pricingVersion: z.literal('mock-video-v1'),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
}).strict();
export type MediaVideoGatewayQuote = z.infer<typeof MediaVideoGatewayQuoteSchema>;

export const MediaVideoGatewayProfilesSchema = z.object({
  mock: z.literal(true),
  protocolVersion: z.literal(1),
  persistence: z.enum(['memory', 'database']),
  billingStatus: z.literal('MOCK_NOT_CHARGED'),
  profiles: z.array(MediaVideoRuntimeProfileSchema).min(1).max(64),
}).strict();
