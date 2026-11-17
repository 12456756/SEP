import { z } from 'zod';
import { MediaVideoPolicySchema } from './media-video-config.dto';
import { MediaImageSpecV3Schema } from './media-spec.dto';
import { MediaReferenceCountSchema } from './media-reference.dto';

export const MediaKindSchema = z.enum(['image', 'video']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaOperationSchema = z.enum(['generate', 'edit']);
export type MediaOperation = z.infer<typeof MediaOperationSchema>;

export const MediaExecutionModeSchema = z.enum(['async-query', 'sync-response']);
export type MediaExecutionMode = z.infer<typeof MediaExecutionModeSchema>;

export const MediaCapabilitiesSchema = z.object({
  supportsReferenceImage: z.boolean().default(false),
  maxReferenceCount: MediaReferenceCountSchema.default(4),
  maxOutputs: z.number().int().min(1).max(8).default(1),
  sizes: z.array(z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/)).min(1).max(32),
}).strict();

export const MediaProfileSchema = z.object({
  profileId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  kind: z.literal('image'),
  displayName: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(160),
  configVersion: z.string().trim().min(1).max(80),
  operations: z.array(MediaOperationSchema).min(1).max(2),
  executionMode: MediaExecutionModeSchema,
  capabilities: MediaCapabilitiesSchema,
  enabled: z.boolean(),
  verified: z.boolean(),
}).strict();
export type MediaProfile = z.infer<typeof MediaProfileSchema>;

export const MediaAvailableProfileSchema = MediaProfileSchema.omit({ modelId: true });
export type MediaAvailableProfile = z.infer<typeof MediaAvailableProfileSchema>;

export const MediaPolicySchema = z.object({
  enabledProfileIds: z.array(MediaProfileSchema.shape.profileId).max(100).default([]),
  defaultProfileId: z.string().nullable().default(null),
  // Legacy wire/storage fields only. Enterprise authorization no longer limits
  // operations or generation parameters; the profile/adapter owns capabilities.
  allowedOperations: z.array(MediaOperationSchema).default(['generate', 'edit']),
  maxOutputs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(4),
  maxWidth: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(4096),
  maxHeight: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(4096),
  video: MediaVideoPolicySchema.optional(),
}).strict();
export type MediaPolicy = z.infer<typeof MediaPolicySchema>;

// Read grants independently so malformed retired limits cannot revoke valid
// model authorization. Unknown fields are never interpreted as permissions.
export const MediaAuthorizationSchema = MediaPolicySchema.pick({ enabledProfileIds: true, defaultProfileId: true }).strip();

export const MediaImagePolicySchema = MediaPolicySchema.omit({ video: true });
export type MediaImagePolicy = z.infer<typeof MediaImagePolicySchema>;
export const MediaPolicyPreviewRequestSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  policy: MediaImagePolicySchema,
}).strict();
export type MediaPolicyPreviewRequest = z.infer<typeof MediaPolicyPreviewRequestSchema>;
export const MediaPolicyPreviewReasonSchema = z.enum([
  'not-authorized', 'profile-missing', 'disabled', 'unverified', 'connection-unconfigured',
  'adapter-unsupported', 'operation-filtered', 'size-intersection-empty', 'protocol-unsupported',
  'execution-disabled', 'unknown-capability',
]);
export const MediaPolicyPreviewProfileSchema = z.object({
  profileId: MediaProfileSchema.shape.profileId,
  configVersion: MediaProfileSchema.shape.configVersion.nullable(),
  status: z.enum(['effective', 'not-authorized', 'unavailable', 'empty-intersection']),
  effectiveProfile: z.unknown().nullable(),
  reasons: z.array(MediaPolicyPreviewReasonSchema).max(8),
}).strict();
export const MediaPolicyPreviewSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  executionMode: z.enum(['real', 'disabled']),
  configured: z.boolean(),
  executionAvailable: z.boolean(),
  defaultProfileId: MediaProfileSchema.shape.profileId.nullable(),
  defaultProfileValid: z.boolean(),
  // Admin previews may include configured profiles plus missing authorized IDs.
  profiles: z.array(MediaPolicyPreviewProfileSchema).max(200),
}).strict();
export type MediaPolicyPreview = z.infer<typeof MediaPolicyPreviewSchema>;

export const CreateMediaProfileDtoSchema = z.object({
  profileId: MediaProfileSchema.shape.profileId,
  kind: z.literal('image'),
  displayName: MediaProfileSchema.shape.displayName,
  modelId: MediaProfileSchema.shape.modelId,
  operations: MediaProfileSchema.shape.operations,
  executionMode: MediaProfileSchema.shape.executionMode,
  capabilities: MediaCapabilitiesSchema,
  enabled: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.operations.includes('edit') && value.capabilities.supportsReferenceImage !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'supportsReferenceImage'], message: '编辑能力必须支持参考图' });
  }
  if (value.operations.includes('edit') && value.capabilities.maxReferenceCount < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'maxReferenceCount'], message: '编辑能力至少需要一张参考图' });
  }
});
export type CreateMediaProfileDto = z.infer<typeof CreateMediaProfileDtoSchema>;

export const UpdateMediaProfileDtoSchema = z.object({
  displayName: MediaProfileSchema.shape.displayName.optional(),
  modelId: MediaProfileSchema.shape.modelId.optional(),
  operations: MediaProfileSchema.shape.operations.optional(),
  executionMode: MediaProfileSchema.shape.executionMode.optional(),
  capabilities: MediaCapabilitiesSchema.partial().optional(),
  enabled: z.boolean().optional(),
  expectedConfigVersion: MediaProfileSchema.shape.configVersion,
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedConfigVersion'), '至少提供一个修改字段');
export type UpdateMediaProfileDto = z.infer<typeof UpdateMediaProfileDtoSchema>;

export const DiscoverMediaModelsDtoSchema = z.object({}).strict();
export const MediaModelDiscoverySchema = z.object({
  checkedAt: z.string().datetime(),
  models: z.array(z.object({
    modelId: MediaProfileSchema.shape.modelId,
    displayName: MediaProfileSchema.shape.displayName,
    compatible: z.boolean(),
    reason: z.string().nullable(),
    suggested: z.object({
      operations: MediaProfileSchema.shape.operations,
      executionMode: MediaExecutionModeSchema,
      capabilities: MediaCapabilitiesSchema,
    }).strict().nullable(),
  }).strict()).max(2000),
}).strict();
export type MediaModelDiscovery = z.infer<typeof MediaModelDiscoverySchema>;

export const VerifyMediaProfileDtoSchema = z.object({
  expectedConfigVersion: MediaProfileSchema.shape.configVersion,
  verificationSpec: MediaImageSpecV3Schema.optional(),
}).strict();
export type VerifyMediaProfileDto = z.infer<typeof VerifyMediaProfileDtoSchema>;
export const MediaProfileVerificationSchema = z.object({
  profile: MediaProfileSchema,
  checkedAt: z.string().datetime(),
  executionTested: z.literal(false),
}).strict();
export type MediaProfileVerification = z.infer<typeof MediaProfileVerificationSchema>;

export const UpdateMediaConnectionDtoSchema = z.object({
  baseUrl: z.string().trim().url().superRefine((value, ctx) => {
    let url: URL;
    try { url = new URL(value); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '媒体连接必须是无内嵌凭据、查询或片段的 HTTP(S) sub2api 地址' });
    }
  }),
  /** 留空表示保留现有密钥，避免表单回填时覆盖密钥。 */
  apiKey: z.string().trim().max(4096).optional(),
}).strict();
export type UpdateMediaConnectionDto = z.infer<typeof UpdateMediaConnectionDtoSchema>;

export const UpdateMediaPolicyDtoSchema = z.object({
  enabledProfileIds: MediaPolicySchema.shape.enabledProfileIds.optional(),
  defaultProfileId: z.string().nullable().optional(),
  allowedOperations: z.array(MediaOperationSchema).optional(),
  maxOutputs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  maxWidth: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  maxHeight: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type UpdateMediaPolicyDto = z.infer<typeof UpdateMediaPolicyDtoSchema>;

export const MediaRuntimeProfileSchema = MediaProfileSchema.omit({ modelId: true, enabled: true, verified: true }).extend({
  capabilities: MediaCapabilitiesSchema.omit({ maxReferenceCount: true }).extend({
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
  }),
});

export const MediaRuntimeSchema = z.object({
  protocolVersion: z.literal(1),
  executionAvailable: z.boolean(),
  defaultProfileId: z.string().nullable(),
  tools: z.array(z.string()),
  profiles: z.array(MediaRuntimeProfileSchema),
}).strict();
export type MediaRuntime = z.infer<typeof MediaRuntimeSchema>;

export const MediaRuntimeV2ProfileSchema = MediaRuntimeProfileSchema.extend({
  capabilities: MediaRuntimeProfileSchema.shape.capabilities.extend({
    qualities: z.array(z.enum(['low', 'medium', 'high'])).min(1).max(3),
    defaultQuality: z.enum(['low', 'medium', 'high']),
    defaultSize: z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/),
  }).strict(),
}).strict().superRefine((profile, ctx) => {
  if (!profile.capabilities.qualities.includes(profile.capabilities.defaultQuality)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'defaultQuality'], message: 'Default image quality must be available.' });
  }
  if (!profile.capabilities.sizes.includes(profile.capabilities.defaultSize)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', 'defaultSize'], message: 'Default image size must be available.' });
  }
});

export const MediaRuntimeV2Schema = z.object({
  protocolVersion: z.literal(2), executionAvailable: z.boolean(), defaultProfileId: z.string().nullable(),
  tools: z.array(z.enum(['image_generate', 'image_edit'])), profiles: z.array(MediaRuntimeV2ProfileSchema).max(64),
}).strict().superRefine((runtime, ctx) => {
  if (!runtime.executionAvailable && runtime.tools.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'Unavailable runtime cannot expose tools.' });
  if (runtime.executionAvailable && runtime.profiles.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Executable runtime requires a profile.' });
  if (new Set(runtime.profiles.map(profile => profile.profileId)).size !== runtime.profiles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles'], message: 'Duplicate profiles.' });
  if (runtime.defaultProfileId !== null && !runtime.profiles.some(profile => profile.profileId === runtime.defaultProfileId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultProfileId'], message: 'Default profile must be available.' });
  }
  for (const tool of runtime.tools) {
    const operation = tool === 'image_generate' ? 'generate' : 'edit';
    if (!runtime.profiles.some(profile => profile.operations.includes(operation))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'Image tool requires a matching operation.' });
    }
  }
});
export type MediaRuntimeV2 = z.infer<typeof MediaRuntimeV2Schema>;

export const MediaRuntimeQuerySchema = z.object({
  mediaProtocolVersion: z.coerce.number().int().min(1).optional(),
  videoProtocolVersion: z.coerce.number().int().min(1).optional(),
  skillArtifactProtocolVersion: z.coerce.number().int().min(1).optional(),
}).strict();
export type MediaRuntimeQuery = z.infer<typeof MediaRuntimeQuerySchema>;
