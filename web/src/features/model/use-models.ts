import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/** 用户端可选模型（平台已启用的）。 */
export interface AvailableModel {
  id: string;
  modelId: string;
  label: string;
  displayName: string;
  billingMultiplier: string | null;
  discountLabel: string;
  isFree: boolean;
  vendor: string | null;
  category: string | null;
  description: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  pricingInputPer1M: number | null;
  pricingOutputPer1M: number | null;
  supportedFeatures: unknown;
}

/** 管理端的平台模型记录。 */
export interface PlatformModel {
  id: string;
  modelId: string;
  label: string;
  enabled: boolean;
  sortOrder: number;
  lastSeenAt: string;
  isStale: boolean;
  /** 是否已配置真实价格。false 表示启用后按保底价计费。 */
  hasPricing: boolean;
  isFree: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SyncResult {
  upstreamTotal: number;
  added: number;
  restored: number;
  staled: number;
}

// ─── 用户端 ────────────────────────────────────────────────────────────────

/**
 * 平台已启用的模型（用户端可选范围）。
 * 用于员工表单的模型选择、会话内模型切换。
 */
export function useEnabledModels() {
  return useQuery<AvailableModel[]>({
    queryKey: ["models", "enabled"],
    queryFn: () => api.get<AvailableModel[]>("/models/enabled"),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// ─── 管理端 ────────────────────────────────────────────────────────────────

/**
 * 实时查看上游全量模型。用于系统设置页的「测试连接」——
 * 能拿到列表即说明地址和密钥有效。
 */
export function useUpstreamModels() {
  return useQuery<AvailableModel[]>({
    queryKey: ["models", "upstream"],
    queryFn: () => api.get<AvailableModel[]>("/models/upstream"),
    enabled: false, // 手动触发（点「测试连接」）
    retry: false,
  });
}

/** 平台全部模型（含禁用与失效）。 */
export function usePlatformModels(enabled = true) {
  return useQuery<PlatformModel[]>({
    queryKey: ["models", "all"],
    queryFn: () => api.get<PlatformModel[]>("/models"),
    enabled,
    // 手动同步已强制刷新目录；切换回自动查询时复用该结果，避免立刻重复拉取。
    staleTime: 30_000,
  });
}

/** 从上游同步模型到平台白名单。 */
export function useSyncModels() {
  const qc = useQueryClient();
  return useMutation<SyncResult, Error, void>({
    mutationFn: () => api.post<SyncResult>("/models/sync"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("available-models"),
      });
    },
  });
}

/** 更新模型（启用状态 / 显示名 / 排序）。 */
export function useUpdatePlatformModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      enabled?: boolean;
      isFree?: boolean;
      label?: string;
      sortOrder?: number;
    }) => api.patch<PlatformModel>(`/models/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("available-models"),
      });
    },
  });
}

/** 测试模型可用性（发送测试消息到上游）。 */
export function useTestModel() {
  return useMutation<
    { success: boolean; latency: number; response: string },
    Error,
    string
  >({
    mutationFn: (modelId: string) =>
      api.post<{ success: boolean; latency: number; response: string }>(
        `/models/${modelId}/test`
      ),
  });
}
