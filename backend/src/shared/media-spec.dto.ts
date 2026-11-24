import { z } from 'zod';
import { MediaProfileParametersSchema, MediaReferenceRuleSchema, VIDEO_INPUT_MAX_BYTES, VIDEO_INPUT_MAX_COUNT, VIDEO_INPUT_MIME_TYPES } from './media-runtime-parameters';

export const MediaProfileIdV3Schema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const MediaConfigVersionV3Schema = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const PositiveIntegerSchema = z.number().int().positive().safe();
const LabelSchema = z.string().trim().min(1).max(128).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const RatioSchema = z.string().max(64).regex(/^[1-9]\d*:[1-9]\d*$/).refine(value =>
  value.split(':').every(part => Number.isSafeInteger(Number(part))), '比例超出安全数值范围');

export const MediaSpecMetadataV3Schema = z.object({
  protocolVersion: z.literal(3),
  specRevision: PositiveIntegerSchema,
  parameterSources: z.record(z.string().min(1).max(64), z.union([
    z.enum(['user', 'model', 'upstream']),
    z.object({ source: z.enum(['user', 'model', 'upstream']), decisionRef: z.string().min(1).max(256) }).strict(),
  ])).refine(value => Object.keys(value).length <= 32, '规格来源字段过多').optional(),
}).strict();

function refineDimensions(value: {
  width?: number; height?: number; size?: string; aspectRatio?: string; resolution?: string;
}, ctx: z.RefinementCtx): void {
  const conflict = (field: string, message: string) => ctx.addIssue({
    code: z.ZodIssueCode.custom, path: [field], message, params: { code: 'SPEC_CONFLICT' },
  });
  if ((value.width === undefined) !== (value.height === undefined)) {
    conflict(value.width === undefined ? 'width' : 'height', '像素宽高必须同时提供');
  }
  let width = value.width;
  let height = value.height;
  const dimensions = value.size?.match(/^([1-9]\d*)x([1-9]\d*)$/);
  if (dimensions) {
    const sizeWidth = Number(dimensions[1]);
    const sizeHeight = Number(dimensions[2]);
    if (!Number.isSafeInteger(sizeWidth) || !Number.isSafeInteger(sizeHeight)) {
      conflict('size', '尺寸超出安全数值范围');
      return;
    }
    if (width !== undefined && (sizeWidth !== width || sizeHeight !== height)) conflict('size', 'size 与像素宽高不一致');
    width = sizeWidth;
    height = sizeHeight;
  }
  if (width !== undefined && height !== undefined && value.aspectRatio) {
    const [ratioWidth, ratioHeight] = value.aspectRatio.split(':').map(Number);
    if ([width, height, ratioWidth, ratioHeight].every(Number.isSafeInteger)
      && BigInt(width) * BigInt(ratioHeight) !== BigInt(height) * BigInt(ratioWidth)) {
      conflict('aspectRatio', '比例与像素宽高不一致');
    }
  }
  // A numeric p label denotes the short edge; named labels need an adapter contract.
  const resolution = value.resolution?.match(/^([1-9]\d*)p$/i);
  if (resolution && width !== undefined && height !== undefined && Number(resolution[1]) !== Math.min(width, height)) {
    conflict('resolution', '分辨率与像素宽高不一致');
  }
}

export const MediaImageSpecV3Schema = z.object({
  size: LabelSchema.optional(), width: PositiveIntegerSchema.optional(), height: PositiveIntegerSchema.optional(),
  aspectRatio: RatioSchema.optional(), count: PositiveIntegerSchema.optional(), quality: LabelSchema.optional(),
}).strict().superRefine(refineDimensions);
export type MediaImageSpecV3 = z.infer<typeof MediaImageSpecV3Schema>;

export const MediaVideoSpecV3Schema = z.object({
  durationSeconds: PositiveIntegerSchema.optional(), aspectRatio: RatioSchema.optional(),
  resolution: LabelSchema.optional(), width: PositiveIntegerSchema.optional(), height: PositiveIntegerSchema.optional(),
  frameRate: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  audio: z.boolean().optional(), outputFormat: LabelSchema.optional(),
}).strict().superRefine(refineDimensions);
export type MediaVideoSpecV3 = z.infer<typeof MediaVideoSpecV3Schema>;

export const MediaAdapterV3Schema = z.object({
  id: LabelSchema, version: LabelSchema, available: z.boolean(), reason: LabelSchema.optional(),
  operations: z.array(LabelSchema).max(8),
  referenceSupport: z.object({
    maxCount: z.number().int().nonnegative().safe(), maxInputBytes: z.number().int().nonnegative().safe(),
    mimeTypes: z.array(LabelSchema).max(16),
  }).strict(),
  videoReferenceSupport: z.object({
    maxCount: z.number().int().min(0).max(VIDEO_INPUT_MAX_COUNT), maxInputBytes: z.number().int().min(0).max(VIDEO_INPUT_MAX_BYTES),
    mimeTypes: z.array(z.enum(VIDEO_INPUT_MIME_TYPES)).max(2),
  }).strict().optional(),
  supportsTaskQuery: z.boolean(), supportsCancel: z.boolean(),
}).strict();
export const MediaRuntimeV3ProfileSchema = z.object({
  profileId: MediaProfileIdV3Schema, configVersion: MediaConfigVersionV3Schema, kind: z.enum(['image', 'video']),
  modelId: z.string().min(1).max(160), modelDisplayName: z.string().min(1).max(160),
  displayName: z.string().trim().min(1).max(80), operations: z.array(LabelSchema).max(8),
  executionMode: z.enum(['sync-response', 'async-query']), authorized: z.boolean(),
  adapter: MediaAdapterV3Schema,
  parameters: MediaProfileParametersSchema.innerType().shape.parameters,
  constraints: MediaProfileParametersSchema.innerType().shape.constraints,
  referenceRules: MediaProfileParametersSchema.innerType().shape.referenceRules,
  videoReferenceRules: z.array(MediaReferenceRuleSchema).max(3).optional(),
  unavailableReason: LabelSchema.nullable(), unavailableMessage: z.string().min(1).max(256).nullable(),
}).strict().superRefine((value, ctx) => {
  const rules = MediaProfileParametersSchema.safeParse({ parameters: value.parameters, constraints: value.constraints, referenceRules: value.referenceRules });
  if (!rules.success) rules.error.issues.forEach(issue => ctx.addIssue(issue));
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (Object.values(value.parameters).some(parameter => parameter.operations.some(op => !value.operations.includes(op)))
    || value.constraints.some(rule => rule.operations.some(op => !value.operations.includes(op)))) issue('parameters', '参数操作必须属于配置支持的操作');
  if (value.operations.some(op => !value.referenceRules.some(rule => rule.operation === op))
    || value.referenceRules.some(rule => !value.operations.includes(rule.operation))) issue('referenceRules', '参考图规则必须覆盖且仅覆盖配置操作');
  if (value.referenceRules.some(rule => rule.maxCount > value.adapter.referenceSupport.maxCount
    || rule.maxInputBytes > value.adapter.referenceSupport.maxInputBytes
    || rule.mimeTypes.some(mime => !value.adapter.referenceSupport.mimeTypes.includes(mime)))) issue('referenceRules', '参考图规则超出适配器上限');
  const videoSupport = value.adapter.videoReferenceSupport;
  const videoRules = value.videoReferenceRules ?? [];
  if (videoSupport || videoRules.length || value.operations.includes('video-to-video')) {
    if (value.kind !== 'video' || !videoSupport || new Set(videoRules.map(rule => rule.operation)).size !== videoRules.length
      || value.operations.some(op => !videoRules.some(rule => rule.operation === op))
      || videoRules.some(rule => !value.operations.includes(rule.operation)
        || rule.maxCount > videoSupport.maxCount || rule.maxInputBytes > videoSupport.maxInputBytes
        || rule.mimeTypes.some(mime => !(videoSupport.mimeTypes as string[]).includes(mime))
        || (rule.operation === 'video-to-video' ? rule.minCount < 1 : rule.maxCount !== 0))) {
      issue('videoReferenceRules', '参考视频规则必须覆盖配置操作且符合适配器上限');
    }
  }
  if ((value.unavailableReason === null) !== (value.unavailableMessage === null)
    || (value.adapter.available && value.unavailableReason !== null)
    || (!value.adapter.available && value.unavailableReason === null)) issue('unavailableReason', '可用状态和原因不一致');
  if (value.adapter.available && !value.operations.some(op => value.adapter.operations.includes(op)))
    issue('operations', '可用配置必须有适配器支持的操作');
});
export type MediaRuntimeV3Profile = z.infer<typeof MediaRuntimeV3ProfileSchema>;

function runtimeSchema(kind: 'image' | 'video') {
  return z.object({
    protocolVersion: z.literal(3), executionMode: z.enum(['real', 'disabled', 'mock']),
    status: z.enum(['ready', 'empty', 'disabled', 'unavailable']),
    executionAvailable: z.boolean(), defaultProfileId: MediaProfileIdV3Schema.nullable(),
    tools: z.array(LabelSchema).max(8), profiles: z.array(MediaRuntimeV3ProfileSchema).max(64),
  }).strict().superRefine((value, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (new Set(value.profiles.map(p => p.profileId)).size !== value.profiles.length) issue('profiles', 'Profile 不得重复');
    if (value.profiles.some(p => p.kind !== kind)) issue('profiles', '媒体类型不匹配');
    if (value.defaultProfileId !== null && !value.profiles.some(p => p.profileId === value.defaultProfileId)) issue('defaultProfileId', '默认路由不可用');
    const executable = value.profiles.some(p => p.authorized && p.adapter.available && !p.unavailableReason
      && p.operations.some(op => p.adapter.operations.includes(op)));
    if (value.executionAvailable !== (value.executionMode === 'real' && executable)) issue('executionAvailable', '执行状态与授权适配器不一致');
    if (!value.executionAvailable && value.tools.length) issue('tools', '不可执行时不能暴露执行工具');
    if (value.defaultProfileId !== null && !value.profiles.some(p => p.profileId === value.defaultProfileId && p.authorized && p.adapter.available && !p.unavailableReason)) issue('defaultProfileId', '默认配置必须可执行');
    const status = !value.profiles.length ? 'empty' : value.profiles.every(p => p.unavailableReason === 'EXECUTION_DISABLED')
      ? 'disabled' : value.executionAvailable ? 'ready' : 'unavailable';
    if (value.status !== status && !(value.status === 'disabled' && value.executionMode !== 'real' && !value.executionAvailable && value.profiles.length > 0)) issue('status', '配置状态不一致');
  });
}
export const MediaRuntimeV3Schema = runtimeSchema('image');
export const MediaVideoRuntimeV3Schema = runtimeSchema('video');
export type MediaRuntimeV3 = z.infer<typeof MediaRuntimeV3Schema>;
export type MediaVideoRuntimeV3 = z.infer<typeof MediaVideoRuntimeV3Schema>;

export const MediaSpecErrorCodeSchema = z.enum([
  'INVALID_PARAMETER', 'SPEC_CONFLICT', 'MISSING_SPEC', 'MEDIA_FORBIDDEN', 'ADAPTER_UNAVAILABLE',
  'ADAPTER_FIELD_UNMAPPED', 'PRICE_UNAVAILABLE', 'UPSTREAM_SPEC_UNSUPPORTED', 'SUBMISSION_UNKNOWN',
  'OUTPUT_SPEC_MISMATCH', 'UPGRADE_REQUIRED',
]);
export const MediaSpecErrorSchema = z.object({
  code: MediaSpecErrorCodeSchema, message: z.string().min(1).max(512),
  field: z.string().min(1).max(128).optional(),
  requestedValue: z.union([LabelSchema, z.number().finite(), z.boolean()]).optional(),
  reason: z.string().min(1).max(512).optional(),
  source: z.enum(['request', 'authorization', 'adapter', 'pricing', 'upstream', 'output']),
  stage: z.enum(['validation', 'quote', 'submit', 'query', 'download', 'reconciliation']),
  retryable: z.boolean(), submissionState: z.enum(['not_submitted', 'submitted', 'unknown']),
  billingState: z.enum(['not_reserved', 'reserved', 'settled', 'released', 'reconciling', 'unknown']),
  alternatives: z.array(LabelSchema).max(16).optional(),
}).strict();

export const MediaSpecAcceptanceSchema = z.object({
  status: z.enum(['matched', 'mismatched', 'unknown']),
  mismatchedFields: z.array(LabelSchema).max(32), unknownFields: z.array(LabelSchema).max(32),
}).strict();
