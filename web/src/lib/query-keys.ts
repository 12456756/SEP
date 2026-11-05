/** Centralized TanStack Query keys — keep invalidation consistent. */
export const qk = {
  me: ['users', 'me'] as const,
  myStats: ['users', 'me', 'stats'] as const,
  employees: (params?: Record<string, unknown>) =>
    ['digital-employees', params ?? {}] as const,
  employee: (id: string) => ['digital-employees', id] as const,
  employeePackages: (id: string) =>
    ['digital-employees', id, 'packages'] as const,
  subscriptions: ['subscriptions'] as const,
  // 拍平成员工形状的订阅列表（聊天页的员工选择器用）。必须与 subscriptions
  // 分开缓存 —— 同 key 不同形状会互相覆盖：谁先加载谁赢，另一方读到的
  // 对象缺字段（头像变 ?、id 变订阅 id 导致去重失效和路由到错员工）。
  subscribedEmployees: ['subscriptions', 'as-employees'] as const,
  // 人才市场（公开接口，与管理端 employees 分开缓存 —— 字段不同）
  marketEmployees: (search: string) => ['market', 'employees', search] as const,
  marketEmployee: (id: string) => ['market', 'employees', id] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversations', id] as const,
  adminStats: ['admin', 'stats'] as const,
  adminUsers: ['admin', 'users'] as const,
  // 企业组织
  departments: ['enterprise', 'departments'] as const,
  members: (deptId?: string, pagination?: Record<string, unknown>) =>
    pagination === undefined
      ? (deptId ? ['enterprise', 'members', deptId] : (['enterprise', 'members'] as const))
      : ['enterprise', 'members', deptId ?? '', pagination] as const,
  invitations: (status?: string, page?: number, pageSize?: number) =>
    page === undefined && pageSize === undefined
      ? (status ? (['enterprise', 'invitations', status] as const) : (['enterprise', 'invitations'] as const))
      : (status
        ? (['enterprise', 'invitations', status, page ?? 0, pageSize ?? 0] as const)
        : (['enterprise', 'invitations', page ?? 0, pageSize ?? 0] as const)),
  deptMembers: (deptId: string, params?: Record<string, unknown>) =>
    ['enterprise', 'departments', deptId, 'members', params ?? {}] as const,
  subscriptionGrants: (subscriptionId: string) =>
    ['enterprise', 'grants', subscriptionId] as const,
  memberEmployeeGrants: (memberId: string, params?: Record<string, unknown>) =>
    ['enterprise', 'member-grants', memberId, params ?? {}] as const,
  myEmployees: ['enterprise', 'my-employees'] as const,
  // Phase 1: 模型配置中心
  modelConfig: (enterpriseId: string) =>
    ['enterprise', enterpriseId, 'model-config'] as const,
  availableModels: (enterpriseId: string) =>
    ['enterprise', enterpriseId, 'available-models'] as const,
  adminMediaProfiles: ['admin', 'media', 'profiles'] as const,
  adminMediaConnection: ['admin', 'media', 'connection'] as const,
  mediaConfig: (enterpriseId: string) =>
    ['enterprise', enterpriseId, 'media-config'] as const,
  availableMediaProfiles: (enterpriseId: string) =>
    ['enterprise', enterpriseId, 'available-media-profiles'] as const,
  effectiveModelConfig: (enterpriseId?: string, opts?: Record<string, unknown>) =>
    ['enterprise', enterpriseId ?? 'unknown', 'effective-model-config', opts ?? {}] as const,
  // Subscription Requests (P0)
  subscriptionRequests: ['subscription-requests'] as const,
  mySubscriptionRequests: ['subscription-requests', 'my'] as const,
  pendingSubscriptionRequests: ['subscription-requests', 'pending'] as const,
  contributions: ['contributions'] as const,
  contributionOverview: ['contributions', 'overview'] as const,
  contributionMine: ['contributions', 'mine'] as const,
  contribution: (id: string) => ['contributions', id] as const,
  contributionRewards: ['contributions', 'rewards'] as const,
  contributionAdminQueue: (status: string, page?: number, pageSize?: number) =>
    page === undefined ? ['admin', 'contributions', status] as const : ['admin', 'contributions', status, page, pageSize ?? 20] as const,
  contributionAdmin: (id: string) => ['admin', 'contributions', id] as const,
  contributionReviewQueue: (kind: string) => ['admin', 'capability-review', kind] as const,
  // 任务中心持久化（替代原先的 localStorage）
  taskRuns: ['task-runs'] as const,
  taskRunList: (params?: Record<string, unknown>) => ['task-runs', 'list', params ?? {}] as const,
  taskRun: (id: string) => ['task-runs', id] as const,
  taskRunEvents: (id: string) => ['task-runs', id, 'events'] as const,
  taskTemplates: ['task-runs', 'templates'] as const,
  clientTaskMirrors: ['client-task-mirrors'] as const,
  clientTaskMirrorList: (params: { page: number; limit: number; scope?: 'mine' | 'enterprise'; subscriptionId?: string; userId?: string; statuses?: string; view?: 'active' | 'attention' | 'history'; taskType?: string; from?: string; to?: string; q?: string; sort?: string }) =>
    ['client-task-mirrors', 'list', params] as const,
  clientTaskMirrorFilterOptions: (params: { scope?: 'mine' | 'enterprise'; subscriptionId?: string; userId?: string; taskType?: string; from?: string; to?: string; q?: string }) =>
    ['client-task-mirrors', 'filter-options', params] as const,
  clientTaskMirror: (id: string) => ['client-task-mirrors', id] as const,
};
