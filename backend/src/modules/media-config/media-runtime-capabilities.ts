import {
  effectiveImageLimits, IMAGE_REFERENCE_MAX_BYTES, VIDEO_OUTPUT_FORMAT, VIDEO_REFERENCE_MAX_BYTES,
  MediaAuthorizationSchema, MediaPolicySchema, MediaVideoAuthorizationSchema, MediaVideoPolicySchema,
  MEDIA_REFERENCE_MIME_TYPES,
} from 'shared';
import type { MediaParameter, MediaParameterConstraint, MediaProfile, MediaReferenceRule, MediaVideoProfile } from 'shared';
import { InternalServerErrorException } from '@nestjs/common';

export function imageRuntimePolicy(value: unknown) {
  const result = MediaAuthorizationSchema.safeParse(value ?? {});
  if (!result.success) throw new InternalServerErrorException({ message: '企业图片授权配置无效', errors: result.error.issues });
  return MediaPolicySchema.parse(result.data);
}

export function videoRuntimePolicy(value: unknown) {
  if (value !== null && value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
    throw new InternalServerErrorException({ message: '企业多媒体授权配置必须是对象' });
  }
  const video = (value as { video?: unknown } | null | undefined)?.video;
  const result = MediaVideoAuthorizationSchema.safeParse(video ?? {});
  if (!result.success) throw new InternalServerErrorException({ message: '企业视频授权配置无效', errors: result.error.issues });
  return MediaVideoPolicySchema.parse(result.data);
}

export const MEDIA_UNAVAILABLE_MESSAGES: Record<string, string> = {
  PROFILE_DISABLED: '该配置已停用', PROFILE_UNVERIFIED: '该配置尚未通过验证',
  EXECUTION_DISABLED: '平台暂未开启此类生成服务', CONNECTION_UNAVAILABLE: '生成服务连接尚未就绪，请联系管理员',
  ADAPTER_PROTOCOL_UNSUPPORTED: '当前适配器不支持该执行方式', ADAPTER_OPERATION_UNSUPPORTED: '当前适配器不支持该操作',
  ENTERPRISE_MODEL_UNAVAILABLE: '本企业的算力 Key 没有此模型的使用权限',
  SETTLEMENT_NOT_CONNECTED: '企业算力结算尚未接通，暂不能生成',
};

function parameter(label: string, type: MediaParameter['type'], operations: MediaParameter['operations'],
  extra: Partial<MediaParameter> = {}): MediaParameter {
  return { label, type, operations, support: 'supported', required: false, valuesMode: 'unknown',
    source: 'adapter', confidence: 'unknown', observedAt: null, ...extra };
}

function suggestions(values: MediaParameter['values']): Partial<MediaParameter> {
  return values?.length ? { values: [...new Set(values)], valuesMode: 'suggested', source: 'profile-config', confidence: 'declared' } : {};
}

function dimensions(operations: MediaParameter['operations'], primary: string): MediaParameterConstraint[] {
  return [
    { type: 'requiredTogether', operations, fields: ['width', 'height'], code: 'DIMENSIONS_PAIR_REQUIRED', message: '宽度和高度必须同时填写' },
    { type: 'requireAny', operations, alternatives: [[primary], ['width', 'height']],
      code: 'DIMENSIONS_REQUIRED', message: `请填写${primary === 'size' ? '尺寸' : '分辨率'}，或同时填写宽度和高度` },
  ];
}

function references(operations: MediaParameter['operations'], maxCount: number, maxBytes: number) {
  const referenceRules: MediaReferenceRule[] = operations.map(operation => {
    const needsImage = operation === 'edit' || operation === 'image-to-video';
    return { operation, minCount: needsImage ? 1 : 0, maxCount: needsImage ? maxCount : 0,
      maxInputBytes: needsImage ? maxBytes : 0, mimeTypes: needsImage && maxCount > 0 ? [...MEDIA_REFERENCE_MIME_TYPES] : [] };
  });
  return { referenceRules, referenceSupport: {
    maxCount: Math.max(0, ...referenceRules.map(rule => rule.maxCount)),
    maxInputBytes: Math.max(0, ...referenceRules.map(rule => rule.maxInputBytes)),
    mimeTypes: [...new Set(referenceRules.flatMap(rule => rule.mimeTypes))],
  } };
}

type RuntimeCapabilities = ReturnType<typeof references> & {
  parameters: Record<string, MediaParameter>; constraints: MediaParameterConstraint[];
};

export function imageRuntimeCapabilities(profile: MediaProfile, operations: MediaParameter['operations']): RuntimeCapabilities {
  if (!operations.length) return { parameters: {}, constraints: [], ...references(operations, 0, 0) };
  const limits = effectiveImageLimits(profile.capabilities);
  const parameters: Record<string, MediaParameter> = {
    size: parameter('图片尺寸', 'string', operations, suggestions(profile.capabilities.sizes)),
    width: parameter('宽度', 'integer', operations, { minimum: 1, unit: 'pixels' }),
    height: parameter('高度', 'integer', operations, { minimum: 1, unit: 'pixels' }),
    aspectRatio: parameter('画面比例', 'string', operations),
    count: parameter('生成数量', 'integer', operations, { required: true, minimum: 1, maximum: limits.maxOutputs,
      step: 1, unit: 'images', source: 'profile-config', confidence: 'declared' }),
    quality: parameter('图片质量', 'string', operations, { required: true, ...suggestions(profile.capabilities.qualities) }),
  };
  return { parameters, constraints: dimensions(operations, 'size'),
    ...references(operations, limits.maxReferenceCount, IMAGE_REFERENCE_MAX_BYTES) };
}

export function videoRuntimeCapabilities(profile: MediaVideoProfile, operations: MediaParameter['operations']): RuntimeCapabilities {
  if (!operations.length) return { parameters: {}, constraints: [], ...references(operations, 0, 0) };
  const c = profile.capabilities;
  const parameters: Record<string, MediaParameter> = {
    durationSeconds: parameter('视频时长', 'integer', operations, { required: true, minimum: 1, unit: 'seconds',
      ...(c.durationRange ? { minimum: c.durationRange.minimum, maximum: c.durationRange.maximum, step: 1,
        source: 'profile-config' as const, confidence: 'declared' as const } : suggestions(c.durationsSeconds)) }),
    resolution: parameter('分辨率', 'string', operations, suggestions(c.resolutions)),
    width: parameter('宽度', 'integer', operations, { minimum: 1, unit: 'pixels' }),
    height: parameter('高度', 'integer', operations, { minimum: 1, unit: 'pixels' }),
    aspectRatio: parameter('画面比例', 'string', operations, suggestions(c.aspectRatios)),
    audio: parameter('生成声音', 'boolean', operations, suggestions(c.supportsAudio ? [false, true] : [false])),
    outputFormat: parameter('输出格式', 'string', operations, { valuesMode: 'allowed', values: [VIDEO_OUTPUT_FORMAT], confidence: 'verified' }),
    frameRate: parameter('帧率', 'number', operations, { support: 'unsupported', confidence: 'verified' }),
  };
  return { parameters, constraints: dimensions(operations, 'resolution'),
    ...references(operations, c.maxReferenceCount, Math.min(c.maxInputBytes, VIDEO_REFERENCE_MAX_BYTES)) };
}

export function videoReferenceCapabilities(profile: MediaVideoProfile, operations: MediaParameter['operations']) {
  const c = profile.capabilities;
  const enabled = c.supportsVideoToVideo && operations.includes('video-to-video');
  const videoReferenceRules: MediaReferenceRule[] = operations.map(operation => ({
    operation, minCount: operation === 'video-to-video' ? 1 : 0,
    maxCount: operation === 'video-to-video' && enabled ? c.maxVideoReferenceCount ?? 0 : 0,
    maxInputBytes: operation === 'video-to-video' && enabled ? c.maxVideoReferenceBytes ?? 0 : 0,
    mimeTypes: operation === 'video-to-video' && enabled ? c.videoReferenceMimeTypes ?? [] : [],
  }));
  return { videoReferenceRules, videoReferenceSupport: {
    maxCount: Math.max(0, ...videoReferenceRules.map(rule => rule.maxCount)),
    maxInputBytes: Math.max(0, ...videoReferenceRules.map(rule => rule.maxInputBytes)),
    mimeTypes: [...new Set(videoReferenceRules.flatMap(rule => rule.mimeTypes))],
  } };
}

export function mediaRuntimeStatus(profileCount: number, executionEnabled: boolean, executionAvailable: boolean) {
  return !profileCount ? 'empty' as const : !executionEnabled ? 'disabled' as const
    : executionAvailable ? 'ready' as const : 'unavailable' as const;
}
