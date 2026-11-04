'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadForm } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { qk } from '@/lib/query-keys';
import type { GrantBatchCreateDto, GrantBatchResult } from 'shared/employee-grant.dto';
import type {
  Department,
  EnterpriseMember,
  EnterpriseInvitation,
  CreatedInvitation,
  InvitationStatus,
  OffboardResult,
  GrantRecord,
  MemberEmployeeGrantCandidatesResponse,
  MemberGrantBatchResult,
  MemberGrantStatus,
  MyEmployee,
} from '@/lib/types';

// ── 部门 ─────────────────────────────────────────────────────────────────────

export function useDepartments() {
  return useQuery({
    queryKey: qk.departments,
    queryFn: () => api.get<Department[]>('/enterprise/departments'),
  });
}

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; parentId?: string; sortOrder?: number }) =>
      api.post<Department>('/enterprise/departments', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.departments }),
  });
}

export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; parentId?: string | null; sortOrder?: number }) =>
      api.patch<Department>(`/enterprise/departments/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.departments }),
  });
}

export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/enterprise/departments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.departments }),
  });
}

// ── 成员 ─────────────────────────────────────────────────────────────────────

export function useMembers(departmentId?: string) {
  return useQuery({
    queryKey: qk.members(departmentId),
    queryFn: () =>
      api.get<EnterpriseMember[]>(
        departmentId
          ? `/enterprise/members?departmentId=${departmentId}`
          : '/enterprise/members',
      ),
  });
}

export function useCreateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      email: string;
      name?: string;
      role?: 'ENTERPRISE_ADMIN' | 'MEMBER';
      departmentId?: string;
      position?: string;
    }) => api.post<CreatedInvitation>('/enterprise/members', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.members() });
      qc.invalidateQueries({ queryKey: qk.departments });
      qc.invalidateQueries({ queryKey: qk.invitations() });
    },
  });
}

export function useUpdateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      role?: 'ENTERPRISE_ADMIN' | 'MEMBER';
      departmentId?: string | null;
      position?: string | null;
    }) => api.patch<EnterpriseMember>(`/enterprise/members/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.members() });
      qc.invalidateQueries({ queryKey: qk.departments });
    },
  });
}

/**
 * 移出成员。返回处置结果而非空响应 ——
 * 回收了几个席位、取消了几条申请、哪些部门失去负责人，
 * 都需要在 UI 上让管理员看见（尤其是无主部门，那是待补的动作）。
 */
export function useDeleteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<OffboardResult>(`/enterprise/members/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.members() });
      qc.invalidateQueries({ queryKey: qk.departments });
      // 席位被回收，「我的硅基员工」与授权列表都可能变化
      qc.invalidateQueries({ queryKey: qk.myEmployees });
    },
  });
}

// ── 邀请 ─────────────────────────────────────────────────────────────────────

/**
 * 邀请列表。仅企业管理员可读 —— 非管理员调用后端返回 403，
 * 故调用方须用 `enabled` 关掉，否则页面一进来就弹一条无意义的权限错误。
 */
export function useInvitations(
  status?: InvitationStatus,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: qk.invitations(status),
    queryFn: () =>
      api.get<EnterpriseInvitation[]>(
        status ? `/enterprise/invitations?status=${status}` : '/enterprise/invitations',
      ),
    enabled: opts?.enabled ?? true,
  });
}

/**
 * 创建邀请。响应里的 `token` 是一次性明文，**不会**再出现在列表接口里 ——
 * 调用方必须把返回值直接交给 UI 展示，不能只 invalidate 后靠重新拉取。
 */
export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      email: string;
      role?: 'ENTERPRISE_ADMIN' | 'MEMBER';
      departmentId?: string;
      position?: string;
    }) => api.post<CreatedInvitation>('/enterprise/invitations', body),
    onSuccess: () => {
      // 重复邀请同一邮箱会把旧的 PENDING 置为 REVOKED，
      // 所以不能只往列表里追加，必须整体失效
      qc.invalidateQueries({ queryKey: qk.invitations() });
    },
  });
}

export function useResendInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<CreatedInvitation>(`/enterprise/invitations/${id}/resend`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invitations() }),
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/enterprise/invitations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invitations() }),
  });
}

// ── 雇佣关系（订阅）─────────────────────────────────────────────────────────

// 雇佣关系本体的 hooks 统一住在 features/subscription/use-subscriptions.ts，
// 这里只保留挂在雇佣关系上的授权。

// ── 授权 ─────────────────────────────────────────────────────────────────────

export function useSubscriptionGrants(subscriptionId: string) {
  return useQuery({
    queryKey: qk.subscriptionGrants(subscriptionId),
    queryFn: () =>
      api.get<GrantRecord[]>(`/enterprise/subscriptions/${subscriptionId}/grants`),
    enabled: Boolean(subscriptionId),
  });
}

export function useCreateGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      subscriptionId,
      ...body
    }: {
      subscriptionId: string;
      departmentId?: string;
      memberId?: string;
      expiresAt?: string;
    }) =>
      api.post<GrantRecord>(
        `/enterprise/subscriptions/${subscriptionId}/grants`,
        body,
      ),
    onSuccess: (_, { subscriptionId }) => {
      qc.invalidateQueries({ queryKey: qk.subscriptionGrants(subscriptionId) });
      qc.invalidateQueries({ queryKey: qk.myEmployees });
    },
  });
}

export function useCreateGrants() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      subscriptionId,
      ...body
    }: GrantBatchCreateDto & { subscriptionId: string }) =>
      api.post<GrantBatchResult>(
        `/enterprise/subscriptions/${subscriptionId}/grants/batch`,
        body,
      ),
    onSuccess: (_, { subscriptionId }) => {
      qc.invalidateQueries({ queryKey: qk.subscriptionGrants(subscriptionId) });
      qc.invalidateQueries({ queryKey: qk.myEmployees });
      qc.invalidateQueries({ queryKey: qk.subscriptions });
    },
  });
}

export function useDeleteGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grantId }: { grantId: string; subscriptionId: string }) =>
      api.delete(`/enterprise/grants/${grantId}`),
    onSuccess: (_, { subscriptionId }) => {
      qc.invalidateQueries({ queryKey: qk.subscriptionGrants(subscriptionId) });
      qc.invalidateQueries({ queryKey: qk.myEmployees });
      qc.invalidateQueries({ queryKey: qk.subscriptions });
    },
  });
}

export function useMemberEmployeeGrants(
  memberId: string,
  params?: { keyword?: string; status?: MemberGrantStatus; page?: number; pageSize?: number },
) {
  const search = new URLSearchParams();
  if (params?.keyword) search.set('keyword', params.keyword);
  if (params?.status) search.set('status', params.status);
  if (params?.page) search.set('page', String(params.page));
  if (params?.pageSize) search.set('pageSize', String(params.pageSize));
  const query = search.toString();
  return useQuery({
    queryKey: qk.memberEmployeeGrants(memberId, params as Record<string, unknown>),
    queryFn: () => api.get<MemberEmployeeGrantCandidatesResponse>(
      `/enterprise/members/${memberId}/employee-grants${query ? `?${query}` : ''}`,
    ),
    enabled: Boolean(memberId),
  });
}

export function useCreateMemberEmployeeGrants() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, ...body }: {
      memberId: string;
      subscriptionIds: string[];
      expiresAt?: string;
      renewExpired?: boolean;
    }) => api.post<MemberGrantBatchResult>(
      `/enterprise/members/${memberId}/employee-grants/batch`,
      body,
    ),
    onSuccess: (_, { memberId, subscriptionIds }) => {
      qc.invalidateQueries({ queryKey: qk.memberEmployeeGrants(memberId) });
      qc.invalidateQueries({ queryKey: qk.members() });
      qc.invalidateQueries({ queryKey: qk.myEmployees });
      qc.invalidateQueries({ queryKey: qk.subscriptions });
      for (const id of subscriptionIds) {
        qc.invalidateQueries({ queryKey: qk.subscriptionGrants(id) });
      }
    },
  });
}

// ── 我的硅基员工 ─────────────────────────────────────────────────────────────────

export function useMyEmployees(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.myEmployees,
    queryFn: () => api.get<MyEmployee[]>('/enterprise/my-employees'),
    staleTime: 30_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    enabled: options?.enabled ?? true,
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface EnterpriseInfo {
  id: string;
  name: string;
  description: string | null;
  logo: string | null;
  metadata: Record<string, any> | null;
  createdAt: string;
  _count: {
    members: number;
    departments: number;
    /** 雇佣关系数。收敛后即「在册硅基员工数」 */
    subscriptions: number;
  };
}

export function useEnterpriseInfo() {
  const enterpriseId = useAuthStore((s) => s.enterprise?.id);
  return useQuery({
    queryKey: ['enterprise', 'info', enterpriseId],
    queryFn: () => api.get<EnterpriseInfo>('/enterprise/info'),
    enabled: !!enterpriseId,
  });
}

export function useUploadEnterpriseLogo() {
  const qc = useQueryClient();
  const enterpriseId = useAuthStore((s) => s.enterprise?.id);
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return uploadForm<{ logo: string }>('/enterprise/logo', form);
    },
    onSuccess: ({ logo }) => {
      qc.setQueryData<EnterpriseInfo>(['enterprise', 'info', enterpriseId], (current) =>
        current ? { ...current, logo } : current,
      );
      void qc.invalidateQueries({ queryKey: ['enterprise', 'info', enterpriseId] });
    },
  });
}

export interface DashboardStats {
  employeeCount: number;
  memberCount: number;
  monthlySpend: number;
  callCount: number;
  spendTrend: Array<{ date: string; amount: number }>;
  topEmployees: Array<{ id: string; name: string; calls: number }>;
  recentActivities: Array<{
    type: string;
    actor: string;
    target: string;
    time: string;
  }>;
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => api.get<DashboardStats>('/enterprise/dashboard-stats'),
  });
}

// ── Onboarding ────────────────────────────────────────────────────────────────

export function useMarkOnboardingCompleted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ success: boolean }>('/enterprise/onboarding/complete'),
    onSuccess: () => {
      // 刷新企业信息，使 metadata.onboardingCompleted 更新
      qc.invalidateQueries({ queryKey: ['enterprise', 'info'] });
    },
  });
}
