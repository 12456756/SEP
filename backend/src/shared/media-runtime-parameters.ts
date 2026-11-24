import { z } from 'zod';
import { MAX_MEDIA_REFERENCE_COUNT } from './media-reference.dto';

export const IMAGE_ADAPTER_MAX_OUTPUTS = 4;
export const IMAGE_REFERENCE_MAX_COUNT = MAX_MEDIA_REFERENCE_COUNT;
export const IMAGE_REFERENCE_DEFAULT_COUNT = 4;
export const IMAGE_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
export const VIDEO_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_INPUT_MAX_BYTES = 90 * 1024 * 1024;
export const VIDEO_INPUT_REQUEST_MAX_BYTES = 92 * 1024 * 1024;
export const VIDEO_INPUT_MAX_COUNT = 10;
export const VIDEO_INPUT_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const VIDEO_OUTPUT_FORMAT = 'video/mp4';

export function effectiveImageLimits(capabilities: { maxOutputs?: number; supportsReferenceImage?: boolean; maxReferenceCount?: number }) {
  return {
    maxOutputs: Math.min(capabilities.maxOutputs ?? 1, IMAGE_ADAPTER_MAX_OUTPUTS),
    maxReferenceCount: capabilities.supportsReferenceImage
      ? Math.min(capabilities.maxReferenceCount ?? IMAGE_REFERENCE_DEFAULT_COUNT, IMAGE_REFERENCE_MAX_COUNT) : 0,
  };
}

const FieldSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(80);
const ValueSchema = z.union([z.string().min(1).max(160), z.number().finite(), z.boolean()]);
export const MediaRuntimeOperationSchema = z.enum(['generate', 'edit', 'text-to-video', 'image-to-video', 'video-to-video']);
const OperationsSchema = z.array(MediaRuntimeOperationSchema).min(1).max(5);

export const MediaParameterSchema = z.object({
  label: z.string().min(1).max(80), type: z.enum(['string', 'integer', 'number', 'boolean']),
  support: z.enum(['supported', 'unsupported', 'unknown']), required: z.boolean(), operations: OperationsSchema,
  valuesMode: z.enum(['allowed', 'suggested', 'unknown']), values: z.array(ValueSchema).min(1).max(128).optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), step: z.number().finite().positive().optional(),
  default: ValueSchema.optional(), unit: z.enum(['seconds', 'pixels', 'images']).optional(),
  source: z.enum(['profile-config', 'adapter', 'platform-policy', 'provider']),
  confidence: z.enum(['verified', 'declared', 'unknown']), observedAt: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((value, ctx) => {
  const issue = (field: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
  const matchesType = (item: unknown) => value.type === 'integer' ? Number.isSafeInteger(item)
    : value.type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === value.type;
  const inRange = (item: unknown) => typeof item !== 'number' ||
    ((value.minimum === undefined || item >= value.minimum) && (value.maximum === undefined || item <= value.maximum));
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) issue('minimum', '最小值不能大于最大值');
  if (!['integer', 'number'].includes(value.type) && [value.minimum, value.maximum, value.step].some(item => item !== undefined)) issue('type', '只有数字参数可以定义数值范围');
  if (value.type === 'integer' && [value.minimum, value.maximum, value.step].some(item => item !== undefined && !Number.isSafeInteger(item))) issue('type', '整数参数的范围和步长必须为安全整数');
  if (value.valuesMode === 'allowed' && !value.values?.length) issue('values', '明确的允许值不能为空');
  if (value.valuesMode === 'unknown' && value.values !== undefined) issue('values', '未知选项不能同时声明选项列表');
  if (value.values?.some(item => !matchesType(item) || !inRange(item))) issue('values', '选项与参数类型或范围不一致');
  if (value.default !== undefined && (!matchesType(value.default) || !inRange(value.default)
    || (value.valuesMode === 'allowed' && !value.values?.includes(value.default)))) issue('default', '默认值不符合参数规则');
  const onStep = (item: unknown) => typeof item !== 'number' || value.step === undefined
    || Math.abs((item - (value.minimum ?? 0)) / value.step - Math.round((item - (value.minimum ?? 0)) / value.step)) < 1e-9;
  if (value.values?.some(item => !onStep(item)) || (value.default !== undefined && !onStep(value.default))) issue('step', '选项或默认值不符合参数步长');
  if (value.support === 'unsupported' && (value.required || value.default !== undefined)) issue('support', '不支持的参数不能必填或设置默认值');
});
export type MediaParameter = z.infer<typeof MediaParameterSchema>;

const RuleBase = { operations: OperationsSchema, code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(96), message: z.string().min(1).max(256) };
export const MediaParameterConstraintSchema = z.discriminatedUnion('type', [
  z.object({ ...RuleBase, type: z.literal('requiredTogether'), fields: z.array(FieldSchema).min(2).max(8) }).strict(),
  z.object({ ...RuleBase, type: z.literal('requireAny'), alternatives: z.array(z.array(FieldSchema).min(1).max(8)).min(2).max(8) }).strict(),
  z.object({ ...RuleBase, type: z.literal('whenAllowed'), when: z.object({ field: FieldSchema, equals: ValueSchema }).strict(),
    field: FieldSchema, values: z.array(ValueSchema).min(1).max(128) }).strict(),
]);
export type MediaParameterConstraint = z.infer<typeof MediaParameterConstraintSchema>;
export const MediaReferenceRuleSchema = z.object({
  operation: MediaRuntimeOperationSchema, minCount: z.number().int().nonnegative().safe(),
  maxCount: z.number().int().nonnegative().safe(), maxInputBytes: z.number().int().nonnegative().safe(),
  mimeTypes: z.array(z.string().min(1).max(128)).max(16),
}).strict().superRefine((value, ctx) => {
  if (value.minCount > value.maxCount || (value.maxCount > 0 && (!value.maxInputBytes || !value.mimeTypes.length))
    || (value.maxCount === 0 && (value.maxInputBytes !== 0 || value.mimeTypes.length > 0))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '参考图数量、大小和格式规则不一致' });
  }
});
export type MediaReferenceRule = z.infer<typeof MediaReferenceRuleSchema>;

export const MediaProfileParametersSchema = z.object({
  parameters: z.record(FieldSchema, MediaParameterSchema).refine(value => Object.keys(value).length <= 32, '参数过多'),
  constraints: z.array(MediaParameterConstraintSchema).max(32), referenceRules: z.array(MediaReferenceRuleSchema).max(4),
}).strict().superRefine((value, ctx) => {
  value.constraints.forEach((rule, index) => {
    const fields = rule.type === 'requiredTogether' ? rule.fields : rule.type === 'requireAny' ? rule.alternatives.flat()
      : [rule.when.field, rule.field];
    for (const field of fields) {
      const parameter = value.parameters[field];
      if (!parameter || parameter.support === 'unsupported' || rule.operations.some(op => !parameter.operations.includes(op))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['constraints', index], message: `组合规则引用了不适用的参数 ${field}` });
      }
    }
    if (rule.type === 'whenAllowed') {
      for (const [field, values] of [[rule.when.field, [rule.when.equals]], [rule.field, rule.values]] as const) {
        const parameter = value.parameters[field];
        if (parameter && (!MediaParameterSchema.safeParse({ ...parameter, valuesMode: 'allowed', values, default: undefined }).success
          || parameter.valuesMode === 'allowed' && values.some(item => !parameter.values?.includes(item)))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['constraints', index], message: '组合规则的值与参数类型或范围不一致' });
        }
      }
    }
  });
  if (new Set(value.referenceRules.map(rule => rule.operation)).size !== value.referenceRules.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceRules'], message: '同一操作的参考图规则不能重复' });
  }
});

export function validateMediaParameterConstraints(
  parameters: Record<string, unknown>, operation: z.infer<typeof MediaRuntimeOperationSchema>, rules: MediaParameterConstraint[],
): Array<{ code: string; message: string }> {
  const present = (field: string) => parameters[field] !== undefined && parameters[field] !== null && parameters[field] !== '';
  return rules.filter(rule => rule.operations.includes(operation)).filter(rule => {
    if (rule.type === 'requiredTogether') return rule.fields.some(present) && !rule.fields.every(present);
    if (rule.type === 'requireAny') return !rule.alternatives.some(fields => fields.every(present));
    return parameters[rule.when.field] === rule.when.equals && present(rule.field) && !rule.values.includes(parameters[rule.field] as z.infer<typeof ValueSchema>);
  }).map(({ code, message }) => ({ code, message }));
}
