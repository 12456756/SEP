import { z } from 'zod';
import { MediaVideoSpecV3Schema } from './media-spec.dto';
import {
  MediaVideoCapabilitiesSchema, MediaVideoExecutionModeSchema, MediaVideoOperationSchema,
  MediaVideoProfileSchema,
} from './media-video.dto';

// Keep this module independent of media.dto: the image policy nests this schema.
const ProfileFields = MediaVideoProfileSchema.innerType();

export const CreateMediaVideoProfileDtoSchema = ProfileFields.omit({ configVersion: true, verified: true })
  .extend({ enabled: z.boolean().default(false) }).superRefine((value, ctx) => {
    const parsed = MediaVideoProfileSchema.safeParse({ ...value, configVersion: 'pending', verified: false });
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue);
  });
export type CreateMediaVideoProfileDto = z.infer<typeof CreateMediaVideoProfileDtoSchema>;

export const UpdateMediaVideoProfileDtoSchema = ProfileFields.pick({
  displayName: true, modelId: true, operations: true, executionMode: true, enabled: true,
}).partial().extend({
  capabilities: MediaVideoCapabilitiesSchema.innerType().partial().optional(),
  expectedConfigVersion: ProfileFields.shape.configVersion,
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedConfigVersion'), '至少提供一个修改字段');
export type UpdateMediaVideoProfileDto = z.infer<typeof UpdateMediaVideoProfileDtoSchema>;

export const VerifyMediaVideoProfileDtoSchema = z.object({
  expectedConfigVersion: ProfileFields.shape.configVersion,
  verificationSpec: MediaVideoSpecV3Schema.optional(),
}).strict();
export type VerifyMediaVideoProfileDto = z.infer<typeof VerifyMediaVideoProfileDtoSchema>;
export const MediaVideoAvailableProfileSchema = ProfileFields.omit({ modelId: true });
export type MediaVideoAvailableProfile = z.infer<typeof MediaVideoAvailableProfileSchema>;
export const MediaVideoProfileVerificationSchema = z.object({
  profile: MediaVideoProfileSchema, checkedAt: z.string().datetime(),
  executionTested: z.literal(false), mock: z.boolean(),
}).strict();
export type MediaVideoProfileVerification = z.infer<typeof MediaVideoProfileVerificationSchema>;

export const DiscoverMediaVideoModelsDtoSchema = z.object({}).strict();
export const MediaVideoModelDiscoverySchema = z.object({
  checkedAt: z.string().datetime(), mock: z.boolean(), executionTested: z.literal(false),
  models: z.array(z.object({
    modelId: ProfileFields.shape.modelId, displayName: ProfileFields.shape.displayName,
    compatible: z.boolean(), reason: z.string().nullable(),
    suggested: z.object({
      operations: ProfileFields.shape.operations, executionMode: MediaVideoExecutionModeSchema,
      capabilities: MediaVideoCapabilitiesSchema,
    }).strict().nullable(),
  }).strict()).max(2000),
}).strict();
export type MediaVideoModelDiscovery = z.infer<typeof MediaVideoModelDiscoverySchema>;

export const MediaVideoPolicySchema = z.object({
  enabledProfileIds: z.array(ProfileFields.shape.profileId).max(64).default([]),
  defaultProfileId: ProfileFields.shape.profileId.nullable().default(null),
  // Retained for old clients and stored JSON. These fields no longer restrict
  // enterprise operations, generation parameters or concurrency.
  allowedOperations: z.array(MediaVideoOperationSchema).max(2).default(['image-to-video']),
  maxDurationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(5),
  allowedAspectRatios: z.array(z.string().regex(/^[1-9]\d*:[1-9]\d*$/)).max(128).default(['9:16']),
  maxResolution: z.string().trim().min(1).max(80).default('720p'),
  maxConcurrentJobs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  /** @deprecated Kept for old clients and stored policy compatibility; real execution no longer enforces it. */
  periodBudget: z.number().finite().nonnegative().max(1_000_000_000).default(0),
}).strict();
export type MediaVideoPolicy = z.infer<typeof MediaVideoPolicySchema>;
export const MediaVideoAuthorizationSchema = MediaVideoPolicySchema.pick({ enabledProfileIds: true, defaultProfileId: true }).strip();
export const UpdateMediaVideoPolicyDtoSchema = MediaVideoPolicySchema.partial().strict();
export type UpdateMediaVideoPolicyDto = z.infer<typeof UpdateMediaVideoPolicyDtoSchema>;
export const MediaVideoPolicyPreviewRequestSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  policy: MediaVideoPolicySchema,
}).strict();
export type MediaVideoPolicyPreviewRequest = z.infer<typeof MediaVideoPolicyPreviewRequestSchema>;
export const MediaVideoPolicyPreviewReasonSchema = z.enum([
  'not-authorized', 'profile-missing', 'disabled', 'unverified', 'connection-unconfigured',
  'adapter-unsupported', 'operation-filtered', 'duration-intersection-empty',
  'aspect-ratio-intersection-empty', 'resolution-intersection-empty', 'protocol-unsupported',
  'execution-disabled', 'unknown-capability', 'enterprise-model-unavailable', 'settlement-not-connected',
]);
export const MediaVideoPolicyPreviewProfileSchema = z.object({
  profileId: ProfileFields.shape.profileId,
  configVersion: ProfileFields.shape.configVersion.nullable(),
  status: z.enum(['effective', 'not-authorized', 'unavailable', 'empty-intersection']),
  effectiveProfile: z.unknown().nullable(),
  reasons: z.array(MediaVideoPolicyPreviewReasonSchema).max(12),
}).strict();
export const MediaVideoPolicyPreviewSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  executionMode: z.enum(['mock', 'real', 'disabled']),
  configured: z.boolean(),
  executionAvailable: z.boolean(),
  defaultProfileId: ProfileFields.shape.profileId.nullable(),
  defaultProfileValid: z.boolean(),
  // Admin previews may include configured profiles plus missing authorized IDs.
  profiles: z.array(MediaVideoPolicyPreviewProfileSchema).max(128),
}).strict();
export type MediaVideoPolicyPreview = z.infer<typeof MediaVideoPolicyPreviewSchema>;
export const MediaVideoEnterpriseConfigSchema = z.object({
  policy: MediaVideoPolicySchema, configured: z.boolean(), canEdit: z.boolean(),
  mock: z.boolean(), executionTested: z.literal(false),
}).strict();
export type MediaVideoEnterpriseConfig = z.infer<typeof MediaVideoEnterpriseConfigSchema>;
