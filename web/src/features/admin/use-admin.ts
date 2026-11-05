'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import type { Capability, DigitalEmployee } from '@/lib/types';
import type { CurrentPlatformVersion, UpdateEmployeeRequest } from './admin-api';

/**
 * 运营端能力列表行。比公开的 `Capability` 多出投稿相关字段 ——
 * 「来源」列和「该走哪条审核路径」都靠它们判断。
 */
export interface AdminCapabilityRow extends Capability {
  currentPlatformVersion: CurrentPlatformVersion | null;
  pendingPlatformVersion: { id: string; capabilityId: string; version: string; updatedAt: string } | null;
  enterpriseId: string | null;
  visibility: 'ENTERPRISE_PRIVATE' | 'MARKET_PUBLIC';
  platformReviewStatus:
    | 'NOT_SUBMITTED'
    | 'PENDING_REVIEW'
    | 'APPROVED'
    | 'REJECTED';
  enterprise: { id: string; name: string } | null;
  contributor: { id: string; email: string; name: string | null } | null;
  /** 被几位硅基员工绑着。已通过但为 0 = 审了没人用 */
  _count: { bindings: number };
  /** 前 6 位绑定它的员工，用于列表里直接显示名字 */
  bindings: Array<{ employee: { id: string; name: string } }>;
}

// ─── Capability admin ───────────────────────────────────────────────────────

/**
 * 运营端能力列表。
 *
 * `status` 语义由后端展开，不是简单的字段相等：
 *   · PENDING  → 平台自有待审 OR 企业投稿待平台审核
 *   · APPROVED → 平台自有已通过 OR 市场公开已过审
 */
export function useAllCapabilities(
  status?: string,
  page = 1,
  pageSize = 20,
  keyword = '',
  sortBy: 'createdAt' | 'name' | 'usageCount' = 'createdAt',
  sortOrder: 'asc' | 'desc' = 'desc',
) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) params.set('status', status);
  const normalizedKeyword = keyword.trim();
  if (normalizedKeyword) params.set('keyword', normalizedKeyword);
  params.set('sortBy', sortBy);
  params.set('sortOrder', sortOrder);
  return useQuery({
    queryKey: ['capabilities', { status: status ?? 'ALL', page, pageSize, keyword: normalizedKeyword, sortBy, sortOrder }],
    queryFn: async () => {
      const response = await api.get<{
        items: AdminCapabilityRow[];
        total: number;
        page: number;
        pageSize: number;
      }>(`/admin/capabilities?${params.toString()}`);
      return { ...response, limit: response.pageSize };
    },
  });
}

/**
 * 能力审核。**必须走 `/admin/capabilities/:id/...`**，不能走 `/capabilities/:id/...`。
 *
 * 两个 approve 端点长得几乎一样，但只有 admin 那个会在投稿场景下同时推进
 * `platformReviewStatus` / `visibility` 并发放贡献积分；公开端点只改 `status`，
 * 用它审投稿会让投稿永远卡在队列里、进不了市场、贡献者拿不到积分。
 * 原「审核中心」调的正是错的那个。
 */
export function useApproveCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api.post(`/admin/capabilities/${id}/approve`, { note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['capabilities'] });
      qc.invalidateQueries({ queryKey: ['admin', 'capability-review'] });
      qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

export function useRejectCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/admin/capabilities/${id}/reject`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['capabilities'] });
      qc.invalidateQueries({ queryKey: ['admin', 'capability-review'] });
      qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

/** 删除待审核、已拒绝或已下架能力，后端校验绑定与使用记录。 */
export function useDeleteCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/capabilities/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['capabilities'] });
      qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

/** 下架已发布能力，并停用它与所有硅基员工的绑定。 */
export function useArchiveCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/capabilities/${id}/archive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['capabilities'] });
      qc.invalidateQueries({ queryKey: ['digital-employees'] });
      qc.invalidateQueries({ queryKey: ['market', 'employees'] });
      qc.invalidateQueries({ queryKey: ['capability-iteration', 'list'] });
      qc.invalidateQueries({ queryKey: ['available-capabilities'] });
      qc.invalidateQueries({ queryKey: ['admin-employees'] });
      qc.invalidateQueries({ queryKey: ['admin-employee'] });
      qc.invalidateQueries({ queryKey: ['employee-bindings'] });
      qc.invalidateQueries({ queryKey: qk.myEmployees });
      qc.invalidateQueries({ queryKey: qk.subscriptions });
    },
  });
}

export function useImportCozeBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { botId: string; name: string; description: string }) =>
      api.post<Capability>('/capabilities', {
        type: 'agent',
        name: data.name,
        description: data.description,
        industry: [],
        position: [],
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
        agentConfig: {
          platform: 'coze',
          botId: data.botId,
          // apiKey 留空,运行时回退到全局 COZE_PAT
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
  });
}

export function useCreateCozeCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      region: 'CN' | 'GLOBAL';
      runtimeKind: 'BOT_CHAT' | 'WORKFLOW';
      resourceId: string;
      apiKey?: string;
      name: string;
      description: string;
      industry: string[];
      position: string[];
    }) => adminApi.createCozeCapability(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
  });
}

export function useCreateCozeUrlCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      webUrl: string;
      name: string;
      description: string;
      industry: string[];
      position: string[];
    }) => adminApi.createCozeUrlCapability(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
  });
}

// ─── Employee admin ──────────────────────────────────────────────────────────

type CreateEmployeeData = {
  name: string;
  description: string;
  industry: string;
  position: string;
  avatar?: string;
  systemPrompt: string;
  modelId?: string;
  maxSteps?: number;
  status?: string;
};

export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateEmployeeData) =>
      api.post<DigitalEmployee>('/digital-employees', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.employees() }),
  });
}

export function useUpdateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateEmployeeData> }) =>
      api.patch<DigitalEmployee>(`/digital-employees/${id}`, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: qk.employees() });
      qc.invalidateQueries({ queryKey: qk.employee(id) });
    },
  });
}

export function useSaveAdminEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateEmployeeRequest }) => adminApi.updateEmployee(id, data),
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: ['admin-employees'] });
      qc.invalidateQueries({ queryKey: ['admin-employee', id] });
      qc.invalidateQueries({ queryKey: ['employee-bindings', id] });
      qc.invalidateQueries({ queryKey: ['digital-employees'] });
      qc.invalidateQueries({ queryKey: ['market', 'employees'] });
      qc.invalidateQueries({ queryKey: qk.myEmployees });
      qc.invalidateQueries({ queryKey: qk.subscriptions });
    },
  });
}

export function useDeleteEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/digital-employees/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.employees() }),
  });
}

export function useBindCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      capabilityId,
      order,
    }: {
      id: string;
      capabilityId: string;
      order?: number;
    }) => api.post(`/digital-employees/${id}/capabilities`, { capabilityId, order }),
    onSuccess: (_res, { id }) =>
      qc.invalidateQueries({ queryKey: qk.employee(id) }),
  });
}

export function useUnbindCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      capabilityId,
    }: {
      id: string;
      capabilityId: string;
    }) => api.delete(`/digital-employees/${id}/capabilities/${capabilityId}`),
    onSuccess: (_res, { id }) =>
      qc.invalidateQueries({ queryKey: qk.employee(id) }),
  });
}

// ─── Enterprise admin ─────────────────────────────────────────────────────────

/**
 * 全部企业。走 `/admin/enterprises`（钱包口径），而不是
 * `/enterprise/admin/all-enterprises`（返回的是废弃的 ComputeAccount.balance）。
 *
 * ⚠️ 列表项里的 `balance` 是**钱包余额**（EnterpriseWallet.balance）。
 * ComputeAccount.balance 在 schema 里已标注废弃、只有 gateway 链路还在写，
 * 运营端读它会看到一个永远不变的假余额 —— 演示租户钱包里有 ¥49,568，那个字段是 ¥0。
 *
 * pageSize 给足：这个列表同时喂「企业管理」表格和「账户管理」的充值企业选择器，
 * 分页截断会让选择器里搜不到企业。
 */
export function useAllEnterprises() {
  return useQuery({
    queryKey: ['admin', 'enterprises'],
    queryFn: async () => {
      const response = await adminApi.listEnterprises({ pageSize: 200 });
      return response.data;
    },
  });
}

/** 企业管理表格使用的分页列表。选择器继续使用 useAllEnterprises 的完整数据。 */
export function useAdminEnterpriseList(page = 1, pageSize = 20, params?: { keyword?: string; suspended?: boolean }) {
  return useQuery({
    queryKey: ['admin', 'enterprises', 'list', page, pageSize, params],
    queryFn: () => adminApi.listEnterprises({ page, pageSize, ...params }),
  });
}

// Import admin API types
import type {
  EnterpriseListResponse,
  EnterpriseDetail,
  CreditAdjustmentRequest,
  SuspendEnterpriseRequest,
} from './admin-api';
import { adminApi } from './admin-api';

export function useEnterpriseDetail(id: string) {
  return useQuery({
    queryKey: ['admin', 'enterprises', id],
    queryFn: () => adminApi.getEnterpriseDetail(id),
    enabled: !!id,
  });
}

export function useCreditAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: CreditAdjustmentRequest }) =>
      adminApi.creditAdjustment(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'enterprises', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'enterprises', 'list'] });
      // 充值改了余额和流水，企业列表与资金流水页（合计 + 列表）都要跟着刷 ——
      // 原先只失效了带 'list' 的那个 key，充完钱回列表看还是旧余额
      qc.invalidateQueries({ queryKey: ['admin', 'enterprises'] });
      qc.invalidateQueries({ queryKey: ['admin', 'compute'] });
    },
  });
}

export function useSuspendEnterprise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: SuspendEnterpriseRequest }) =>
      adminApi.suspendEnterprise(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'enterprises', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'enterprises', 'list'] });
    },
  });
}

export function useResumeEnterprise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.resumeEnterprise(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['admin', 'enterprises', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'enterprises', 'list'] });
    },
  });
}

export interface SettingView {
  key: string;
  label: string;
  category?: string;
  description?: string;
  type?: string;
  unit?: string;
  placeholder?: string;
  defaultValue?: string;
  source?: 'database' | 'environment' | 'default' | 'unconfigured' | string;
  editable?: boolean;
  restartRequired?: boolean;
  testable?: boolean;
  secret: boolean;
  value?: string;
  configured: boolean;
}

export function useSettings() {
  return useQuery<SettingView[]>({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingView[]>('/settings'),
  });
}

/**
 * 系统默认「订阅赠送算力（元）」。
 *
 * 员工表单用它做占位提示：运营留空赠送金额时，实际生效的就是这个值。
 * 不展示的话运营无从判断「留空」意味着赠送多少钱。
 */
export function useDefaultEmployeeGiftCNY() {
  const { data: settings, ...rest } = useSettings();
  const raw = settings?.find((s) => s.key === 'DEFAULT_EMPLOYEE_GIFT_CNY')?.value;
  const parsed = Number(raw);
  return {
    ...rest,
    data: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
  };
}

/**
 * 系统默认「订阅赠送算力比例（%）」。
 * 员工未单独配置固定金额且比例大于 0 时，按年费 × 比例计算。
 */
export function useDefaultEmployeeGiftPercentage() {
  const { data: settings, ...rest } = useSettings();
  const raw = settings?.find((s) => s.key === 'DEFAULT_EMPLOYEE_GIFT_PERCENTAGE')?.value;
  const parsed = Number(raw);
  return {
    ...rest,
    data: Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0,
  };
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, string>) =>
      api.put<SettingView[]>('/settings', updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['models', 'available'] });
    },
  });
}

export interface MailTestConnectionResult {
  enabled: boolean;
  verified: boolean;
  message: string;
}

export function useTestMailConnection() {
  return useMutation({
    mutationFn: () => api.post<MailTestConnectionResult>('/settings/mail/test'),
  });
}

export function useSendTestMail() {
  return useMutation({
    mutationFn: (to: string) => api.post<{ success: true }>('/settings/mail/test-delivery', { to }),
  });
}

export type OAuthProviderName = 'wechat' | 'qq' | 'dingtalk';

export interface OAuthConfigCheckResult {
  provider: OAuthProviderName;
  enabled: boolean;
  configured: boolean;
  valid: boolean;
  checks: {
    enabled: boolean;
    appId: boolean;
    secret: boolean;
    redirectUri: boolean;
  };
  message: string;
}

export function useTestOAuthProvider() {
  return useMutation({
    mutationFn: (provider: OAuthProviderName) =>
      api.post<OAuthConfigCheckResult>(`/settings/oauth/${provider}/test`),
  });
}

// ─── Compute Transactions ─────────────────────────────────────────────────────

import type { ComputeTransactionsResponse } from './admin-api';

export function useComputeTransactions(params?: {
  type?: 'RECHARGE' | 'CONSUME' | 'REFUND';
  enterpriseId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: ['admin', 'compute', 'transactions', params],
    queryFn: () => adminApi.getComputeTransactions(params),
  });
}

/**
 * 平台资金合计。
 *
 * 以前这三个数是页面自己算的：另发一次 `pageSize: 9999` 的请求把整本账搬到浏览器
 * 再 reduce。超过 9999 条后累计充值/消费会静默算错，现在由后端 groupBy 出。
 */
export function useComputeSummary() {
  return useQuery({
    queryKey: ['admin', 'compute', 'summary'],
    queryFn: () =>
      api.get<{
        totalRecharge: number;
        totalConsume: number;
        totalRefund: number;
        totalBalance: number;
        totalComputeReserved: number;
      }>('/admin/compute/summary'),
  });
}

// ─── Employee Capability Bindings ─────────────────────────────────────────────

export function useAvailableCapabilities() {
  return useQuery({
    queryKey: ['available-capabilities'],
    queryFn: async () => {
      const response = await adminApi.listApprovedCapabilities();
      // 后端返回 { items, total, page, pageSize }，提取 items 数组
      return response.items;
    },
  });
}

export function useEmployeeBindings(employeeId: string) {
  return useQuery({
    queryKey: ['employee-bindings', employeeId],
    queryFn: () => adminApi.getEmployeeBindings(employeeId),
    enabled: !!employeeId,
  });
}

export function useBindCapabilities() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      capabilityIds,
    }: {
      employeeId: string;
      capabilityIds: string[];
    }) => adminApi.bindCapabilities(employeeId, capabilityIds),
    onSuccess: (_res, { employeeId }) => {
      qc.invalidateQueries({ queryKey: ['employee-bindings', employeeId] });
      qc.invalidateQueries({ queryKey: ['admin-employee', employeeId] });
    },
  });
}

export function useUpdateBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      bindingId,
      data,
    }: {
      bindingId: string;
      data: { priority?: number; enabled?: boolean; config?: any };
    }) => adminApi.updateBinding(bindingId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee-bindings'] });
    },
  });
}

export function useRemoveBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bindingId: string) => adminApi.removeBinding(bindingId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee-bindings'] });
      qc.invalidateQueries({ queryKey: ['admin-employee'] });
    },
  });
}
