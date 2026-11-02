import { z } from 'zod';

// ── 企业模型配置 ──────────────────────────────────────────────────────────

export const EnterpriseModelConfigSchema = z.object({
  id: z.string().cuid(),
  enterpriseId: z.string().cuid(),

  // 会话模型
  defaultChatModel: z.string(),
  allowedChatModels: z.array(z.string()),
  allowUserSwitchModel: z.boolean(),

  // 知识库模型
  embeddingModel: z.string(),
  embeddingModelSource: z.literal('platform'),
  rerankModel: z.string().nullable(),
  embeddingBatchSize: z.number().int().positive(),
  embeddingTimeoutMs: z.number().int().positive(),

  // 员工模型策略
  employeeModelPolicy: z.enum(['FOLLOW_TEMPLATE', 'FORCE_DEFAULT']),
  employeeDefaultModel: z.string().nullable(),

  /** 编排与分析模型（工作安排 / 迭代建议 / 交付物生成共用）。null = 跟随平台默认 */
  plannerModel: z.string().nullable(),

  createdAt: z.string(),
  updatedAt: z.string(),
});

export const UpdateEnterpriseModelConfigDtoSchema = z.object({
  defaultChatModel: z.string().optional(),
  allowedChatModels: z.array(z.string()).optional(),
  allowUserSwitchModel: z.boolean().optional(),

  rerankModel: z.string().nullable().optional(),

  employeeModelPolicy: z.enum(['FOLLOW_TEMPLATE', 'FORCE_DEFAULT']).optional(),
  employeeDefaultModel: z.string().nullable().optional(),

  /** null / 空串 = 跟随平台默认模型 */
  plannerModel: z.string().nullable().optional(),
});

export type EnterpriseModelConfig = z.infer<typeof EnterpriseModelConfigSchema>;
export type UpdateEnterpriseModelConfigDto = z.infer<typeof UpdateEnterpriseModelConfigDtoSchema>;

// ── 部门模型策略 ──────────────────────────────────────────────────────────

export const DepartmentModelPolicySchema = z.object({
  id: z.string().cuid(),
  departmentId: z.string().cuid(),
  defaultChatModel: z.string().nullable(),
  allowedChatModels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const UpdateDepartmentModelPolicyDtoSchema = z.object({
  defaultChatModel: z.string().nullable().optional(),
  allowedChatModels: z.array(z.string()).optional(),
});

export type DepartmentModelPolicy = z.infer<typeof DepartmentModelPolicySchema>;
export type UpdateDepartmentModelPolicyDto = z.infer<typeof UpdateDepartmentModelPolicyDtoSchema>;

// ── 生效配置（解析后） ──────────────────────────────────────────────────────

export const EffectiveModelConfigSchema = z.object({
  /** 最终用于本次会话的模型 id */
  chatModel: z.string(),
  /** 可切换范围。空数组 = 平台全部 enabled 模型 */
  allowedChatModels: z.array(z.string()),
  /** 成员是否可以手动切换模型（false 时前端锁定选择器） */
  allowUserSwitchModel: z.boolean(),

  embeddingModel: z.string(),
  rerankModel: z.string().nullable(),
  embeddingBatchSize: z.number().int().positive(),
  embeddingTimeoutMs: z.number().int().positive(),

  /** 该模型来自哪一层配置，便于前端解释「为什么是这个模型」 */
  source: z.enum(['USER_CHOICE', 'EMPLOYEE_INSTANCE', 'DEPARTMENT', 'ENTERPRISE', 'SYSTEM_DEFAULT']),
});

export type EffectiveModelConfig = z.infer<typeof EffectiveModelConfigSchema>;

// ── 可用模型列表 ──────────────────────────────────────────────────────────

/**
 * 平台可用模型。目录元数据允许为空；未知中转倍率返回 null，客户端不自行估算。
 */
export const AvailableModelSchema = z.object({
  modelId: z.string(),
  label: z.string(),
  displayName: z.string(),
  billingMultiplier: z.string().nullable(),
  discountLabel: z.string(),
  isFree: z.boolean(),
  vendor: z.string().nullable(),
  category: z.string().nullable(),
  contextLength: z.number().int().nullable(),
  maxOutputTokens: z.number().int().nullable(),
  pricingInputPer1M: z.string().nullable(), // Decimal as string
  pricingOutputPer1M: z.string().nullable(),
  supportedFeatures: z.record(z.unknown()).nullable(),
  description: z.string().nullable(),
});

export type AvailableModel = z.infer<typeof AvailableModelSchema>;

export const UpdatePlatformModelDtoSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  sortOrder: z.number().int().optional(),
  isFree: z.boolean().optional(),
}).strict();
export type UpdatePlatformModelDto = z.infer<typeof UpdatePlatformModelDtoSchema>;

/** 仅由服务端生成，冻结调用开始时的单价、倍率和汇率。 */
export const ModelBillingSnapshotSchema = z.object({
  modelId: z.string().min(1),
  isFree: z.boolean(),
  billingMultiplier: z.number().finite().nonnegative(),
  rate: z.number().finite().positive(),
  inputPriceUsdPerMillion: z.number().finite().nonnegative(),
  outputPriceUsdPerMillion: z.number().finite().nonnegative(),
  isFallback: z.boolean(),
}).refine(snapshot => !snapshot.isFree || (
  snapshot.billingMultiplier === 0 && snapshot.inputPriceUsdPerMillion === 0 && snapshot.outputPriceUsdPerMillion === 0
), '免费活动快照必须为零倍率、零单价');
export type ModelBillingSnapshot = z.infer<typeof ModelBillingSnapshotSchema>;
