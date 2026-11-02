import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import type {
  UpdateEnterpriseModelConfigDto,
  DepartmentModelPolicyDto,
  EffectiveModelConfig,
  EmployeeModelPolicy,
} from '@/lib/types';

// ============================================================================
// Types
// ============================================================================

/**
 * 企业模型配置。
 *
 * 后端 GET 时若不存在会自动按系统默认值建一条，所以这里的 id/时间戳不为 null。
 */
export interface EnterpriseModelConfig {
  id: string;
  enterpriseId: string;
  defaultChatModel: string;
  allowedChatModels: string[];
  allowUserSwitchModel: boolean;
  embeddingModel: string;
  embeddingModelSource: 'platform';
  rerankModel: string | null;
  embeddingBatchSize: number;
  embeddingTimeoutMs: number;
  employeeModelPolicy: EmployeeModelPolicy;
  employeeDefaultModel: string | null;
  /** Decimal 序列化为字符串；null = 不限预算 */
  /** 编排与分析模型（工作安排 / 迭代建议 / 交付物生成共用）。null = 跟随平台默认 */
  plannerModel: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 平台可用模型。
 *
 * 除 modelId / label 外的元数据列目前大多为空（等模型同步任务补齐），
 * 所以全部按 nullable 处理，UI 需要降级展示。
 */
export interface PlatformModel {
  modelId: string;
  label: string;
  displayName: string;
  billingMultiplier: string | null;
  discountLabel: string;
  isFree: boolean;
  vendor: string | null;
  category: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  pricingInputPer1M: string | null;
  pricingOutputPer1M: string | null;
  supportedFeatures: Record<string, unknown> | null;
  description: string | null;
}

export interface DepartmentModelPolicy {
  id: string | null;
  departmentId: string;
  defaultChatModel: string | null;
  allowedChatModels: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * 获取企业模型配置。
 *
 * 企业身份由 JWT 推导，enterpriseId 仅用于 query key 隔离缓存。
 */
export function useModelConfig(enterpriseId: string) {
  return useQuery({
    queryKey: qk.modelConfig(enterpriseId),
    queryFn: () => api.get<EnterpriseModelConfig>('/enterprise/model-config'),
    enabled: !!enterpriseId,
  });
}

/** 更新企业模型配置（upsert）。仅 ENTERPRISE_ADMIN 可调用。 */
export function useUpdateModelConfig(enterpriseId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dto: UpdateEnterpriseModelConfigDto) =>
      api.put<EnterpriseModelConfig>('/enterprise/model-config', dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.modelConfig(enterpriseId) });
      queryClient.invalidateQueries({ queryKey: ['enterprise', enterpriseId, 'effective-model-config'] });
    },
  });
}

/** 平台可用模型列表（enabled=true）。 */
export function useAvailableModels(enterpriseId: string) {
  return useQuery({
    queryKey: qk.availableModels(enterpriseId),
    queryFn: () => api.get<PlatformModel[]>('/enterprise/model-config/available-models'),
    enabled: !!enterpriseId,
  });
}

/** 读取部门模型策略；未设置时后端返回空策略（id=null）。 */
export function useDepartmentPolicy(departmentId: string | null) {
  return useQuery({
    queryKey: ['enterprise', 'departments', departmentId, 'model-policy'] as const,
    queryFn: () =>
      api.get<DepartmentModelPolicy>(`/enterprise/departments/${departmentId}/model-policy`),
    enabled: !!departmentId,
  });
}

/** 设置部门级模型策略覆盖。仅 ENTERPRISE_ADMIN 可调用。 */
export function useSetDepartmentPolicy(departmentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dto: DepartmentModelPolicyDto) =>
      api.put<DepartmentModelPolicy>(
        `/enterprise/departments/${departmentId}/model-policy`,
        dto,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['enterprise', 'departments', departmentId, 'model-policy'],
      });
    },
  });
}

/**
 * 解析最终生效的模型配置。
 * 优先级：用户选择 > 雇佣关系 > 部门覆盖 > 企业配置 > 系统默认。
 *
 * 参数名必须与后端 @Query('subscriptionId') 一致 —— 收敛前叫 employeeInstanceId，
 * 名字不对不会报错，只会静默丢掉这一层优先级。
 */
export function useEffectiveModelConfig(
  enterpriseId: string,
  opts?: { departmentId?: string; subscriptionId?: string; userSelectedModel?: string },
) {
  return useQuery({
    queryKey: qk.effectiveModelConfig(enterpriseId, opts),
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.departmentId) params.set('departmentId', opts.departmentId);
      if (opts?.subscriptionId) params.set('subscriptionId', opts.subscriptionId);
      if (opts?.userSelectedModel) params.set('userSelectedModel', opts.userSelectedModel);

      const qs = params.toString();
      return api.get<EffectiveModelConfig>(
        `/enterprise/model-config/effective${qs ? `?${qs}` : ''}`,
      );
    },
    enabled: !!enterpriseId,
  });
}
