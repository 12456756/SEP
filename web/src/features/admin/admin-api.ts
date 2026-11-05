import { api } from '@/lib/api-client';
import type { EmployeeAvatarAsset } from '@/lib/types';

export interface EnterpriseListItem {
  id: string;
  name: string;
  description: string | null;
  logo: string | null;
  balance: number;
  memberCount: number;
  /** 雇佣关系数。收敛后即「在册硅基员工数」 */
  subscriptionCount: number;
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseListResponse {
  data: EnterpriseListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface EnterpriseDetail {
  id: string;
  name: string;
  description: string | null;
  logo: string | null;
  createdAt: string;
  updatedAt: string;
  metadata?: {
    suspended?: boolean;
    suspendReason?: string;
    suspendedAt?: string;
    suspendedBy?: string;
    resumedAt?: string;
    resumedBy?: string;
  };
  members: Array<{
    id: string;
    role: string;
    user: {
      id: string;
      email: string;
      name: string | null;
      avatar: string | null;
      role: string;
    };
    department: {
      id: string;
      name: string;
    } | null;
  }>;
  /**
   * 雇佣关系。收敛后订阅即雇佣关系，不再有中间的实例层，
   * 也不挂部门 —— 部门差异化落在授权记录上。
   */
  subscriptions: Array<{
    id: string;
    /** 企业自定义称呼，未定制时为 null，展示时回落到 employee.name */
    name: string | null;
    status: string;
    employeeId: string;
    /** 雇佣时锁定的模板版本 */
    templateVersion: string;
    createdAt: string;
    employee: {
      id: string;
      name: string;
      description: string;
    };
  }>;
  /** 钱包可用余额（元）。不是废弃的 ComputeAccount.balance */
  balance: number;
  /** 其中已划入「算力专款」的金额（元），是 balance 的子集 */
  computeReservedCNY: number;
  /** 最近 20 条钱包流水（WalletTransaction） */
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    balanceAfter: number;
    description: string | null;
    metadata: any;
    createdAt: string;
  }>;
  departments: Array<{
    id: string;
    name: string;
    parentId: string | null;
  }>;
}

export interface CreditAdjustmentRequest {
  amount: number;
  type: 'RECHARGE' | 'DEDUCT';
  note: string;
}

export interface CreditAdjustmentResponse {
  success: boolean;
  newBalance: number;
}

export interface SuspendEnterpriseRequest {
  reason: string;
}

export interface OperationResponse {
  success: boolean;
}

// Employee Management Types
export interface AvatarSource {
  id: string;
  name: string;
  description: string;
  website: string;
}

export interface ManagedAvatarStyle {
  id: string;
  name: string;
  description: string;
  category: string;
  recommended: boolean;
  source: string;
  sourceName?: string;
  sourceUrl?: string;
  license?: { name: string; url: string; attribution: string; requiresAttribution: boolean };
  delivery?: 'generated' | 'static' | 'binding';
  totalAssets?: number;
  examples: string[];
  coverage: { matched: number; total: number };
  canSetDefault: boolean;
}

export interface EmployeeAvatarSetting {
  id: string;
  name: string;
  position: string;
  avatar: string | null;
  avatarAsset?: EmployeeAvatarAsset | null;
  avatarStyle: string;
  effectiveStyleId: string;
  availableStyleIds: string[];
}

export interface AvatarStylesResponse {
  styles: ManagedAvatarStyle[];
  sources?: AvatarSource[];
  total: number;
  defaultStyleId: string;
  followersCount: number;
  overridesCount: number;
  employees: EmployeeAvatarSetting[];
}

export interface EmployeeListItem {
  id: string;
  name: string;
  description: string;
  industry: string;
  position: string;
  avatar: string | null;
  avatarAsset?: EmployeeAvatarAsset | null;
  avatarStyle?: string | null;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
  version: string;
  annualPriceCNY: number | null;
  /** 订阅赠送算力（元）。null = 未配置，订阅时取系统默认值 DEFAULT_EMPLOYEE_GIFT_CNY。 */
  includedComputeCNY: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  bindings: Array<{
    capability: {
      id: string;
      name: string;
    };
  }>;
  _count: {
    bindings: number;
  };
}

export interface EmployeeListResponse {
  data: EmployeeListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface EmployeeDetail {
  id: string;
  name: string;
  description: string;
  industry: string;
  position: string;
  avatar: string | null;
  avatarAsset?: EmployeeAvatarAsset | null;
  avatarStyle?: string | null;
  systemPrompt: string;
  modelId: string;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
  version: string;
  annualPriceCNY: number | null;
  /** 订阅赠送算力（元）。null = 未配置，订阅时取系统默认值 DEFAULT_EMPLOYEE_GIFT_CNY。 */
  includedComputeCNY: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  bindings: Array<{
    id: string;
    capability: {
      id: string;
      name: string;
      type: string;
      status: string;
    };
  }>;
  _count: {
    /** 雇佣该员工的企业数 */
    subscriptions: number;
    sessions: number;
  };
}

export interface CreateEmployeeRequest {
  name: string;
  description?: string;
  industry?: string;
  position?: string;
  avatar?: string;
  systemPrompt?: string;
  modelId?: string;
  annualPriceCNY?: number;
  /**
   * 订阅赠送算力（元）。**null 与 0 语义不同**：
   * null = 清除员工级覆盖，订阅时取系统默认值；0 = 明确不赠送。
   */
  includedComputeCNY?: number | null;
}

export interface UpdateEmployeeRequest {
  capabilityIds?: string[];
  name?: string;
  description?: string;
  industry?: string;
  position?: string;
  avatar?: string;
  systemPrompt?: string;
  modelId?: string;
  annualPriceCNY?: number;
  /**
   * 订阅赠送算力（元）。**null 与 0 语义不同**：
   * null = 清除员工级覆盖，订阅时取系统默认值；0 = 明确不赠送。
   */
  includedComputeCNY?: number | null;
}

export interface EmployeeCopyDraftRequest {
  kind: 'description' | 'systemPrompt';
  employee: {
    name: string;
    industry: string;
    position: string;
    capabilities: Array<{ name: string; description?: string }>;
  };
}

export interface EmployeeCopyDraftResponse {
  draft: string;
  modelId: string;
  modelSource: 'PLATFORM_DEFAULT';
}

export interface ComputeTransaction {
  id: string;
  type: 'RECHARGE' | 'CONSUME' | 'REFUND';
  amount: number;
  description: string | null;
  metadata: any;
  createdAt: string;
  sessionId: string | null;
  enterprise: {
    id: string;
    name: string;
  };
}

export interface ComputeTransactionsResponse {
  data: ComputeTransaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const adminApi = {
  /**
   * 获取企业列表
   */
  listEnterprises: (params?: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    suspended?: boolean;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
    if (params?.keyword) searchParams.set('keyword', params.keyword);
    if (params?.suspended !== undefined) searchParams.set('suspended', String(params.suspended));

    const query = searchParams.toString();
    return api.get<EnterpriseListResponse>(
      `/admin/enterprises${query ? `?${query}` : ''}`
    );
  },

  /**
   * 获取企业详情
   */
  getEnterpriseDetail: (id: string) => {
    return api.get<EnterpriseDetail>(`/admin/enterprises/${id}`);
  },

  /**
   * 充值或扣减算力
   */
  creditAdjustment: (id: string, data: CreditAdjustmentRequest) => {
    return api.post<CreditAdjustmentResponse>(
      `/admin/enterprises/${id}/credit`,
      data
    );
  },

  /**
   * 冻结企业
   */
  suspendEnterprise: (id: string, data: SuspendEnterpriseRequest) => {
    return api.post<OperationResponse>(
      `/admin/enterprises/${id}/suspend`,
      data
    );
  },

  /**
   * 解冻企业
   */
  resumeEnterprise: (id: string) => {
    return api.post<OperationResponse>(`/admin/enterprises/${id}/resume`);
  },

  /**
   * 获取平台级算力交易记录
   */
  getComputeTransactions: (params?: {
    type?: 'RECHARGE' | 'CONSUME' | 'REFUND';
    enterpriseId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    pageSize?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set('type', params.type);
    if (params?.enterpriseId) searchParams.set('enterpriseId', params.enterpriseId);
    if (params?.startDate) searchParams.set('startDate', params.startDate);
    if (params?.endDate) searchParams.set('endDate', params.endDate);
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));

    const query = searchParams.toString();
    return api.get<ComputeTransactionsResponse>(
      `/admin/compute/transactions${query ? `?${query}` : ''}`
    );
  },

  /**
   * 获取员工列表
   */
  listEmployees: (params?: {
    status?: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
    page?: number;
    pageSize?: number;
    keyword?: string;
    industry?: string;
    position?: string;
    capabilityKeyword?: string;
    sortBy?: 'createdAt' | 'name' | 'annualPriceCNY';
    sortOrder?: 'asc' | 'desc';
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.page) searchParams.set('page', String(params.page));
    if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
    if (params?.keyword) searchParams.set('keyword', params.keyword);
    if (params?.industry) searchParams.set('industry', params.industry);
    if (params?.position) searchParams.set('position', params.position);
    if (params?.capabilityKeyword) searchParams.set('capabilityKeyword', params.capabilityKeyword);
    if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
    if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);

    const query = searchParams.toString();
    return api.get<EmployeeListResponse>(
      `/admin/employees${query ? `?${query}` : ''}`
    );
  },

  /**
   * 获取员工详情
   */
  getEmployeeDetail: (id: string) => {
    return api.get<EmployeeDetail>(`/admin/employees/${id}`);
  },

  /**
   * 创建员工
   */
  generateEmployeeCopyDraft: (data: EmployeeCopyDraftRequest) =>
    api.post<EmployeeCopyDraftResponse>('/admin/employees/copy-draft', data),

  createEmployee: (data: CreateEmployeeRequest) => {
    return api.post<EmployeeDetail>('/admin/employees', data);
  },

  /**
   * 更新员工
   */
  updateEmployee: (id: string, data: UpdateEmployeeRequest) => {
    return api.put<EmployeeDetail>(`/admin/employees/${id}`, data);
  },

  /**
   * 发布员工
   */
  publishEmployee: (id: string) => {
    return api.post<EmployeeDetail>(`/admin/employees/${id}/publish`);
  },

  /**
   * 提交员工审核
   */
  submitEmployeeForReview: (id: string) => {
    return api.post<EmployeeDetail>(`/admin/employees/${id}/submit`);
  },

  /**
   * 下架员工
   */
  archiveEmployee: (id: string) => {
    return api.post<EmployeeDetail>(`/admin/employees/${id}/archive`);
  },

  /**
   * 删除员工
   */
  deleteEmployee: (id: string) => {
    return api.delete<OperationResponse>(`/admin/employees/${id}`);
  },

  /**
   * 审核通过员工
   */
  approveEmployee: (id: string, note?: string) => {
    return api.post<OperationResponse>(`/admin/employees/${id}/approve`, { note });
  },

  /**
   * 拒绝员工
   */
  rejectEmployee: (id: string, reason: string) => {
    return api.post<OperationResponse>(`/admin/employees/${id}/reject`, { reason });
  },

  /**
   * 获取员工绑定的能力
   */
  getEmployeeBindings: (employeeId: string) => {
    return api.get<EmployeeBindingItem[]>(`/admin/employees/${employeeId}/bindings`);
  },

  /**
   * 批量绑定能力
   */
  bindCapabilities: (employeeId: string, capabilityIds: string[]) => {
    return api.post<OperationResponse>(`/admin/employees/${employeeId}/bindings`, {
      capabilityIds,
    });
  },

  /**
   * 更新绑定配置
   */
  updateBinding: (
    bindingId: string,
    data: {
      priority?: number;
      enabled?: boolean;
      config?: any;
    }
  ) => {
    return api.patch<OperationResponse>(`/admin/bindings/${bindingId}`, data);
  },

  /**
   * 移除绑定
   */
  removeBinding: (bindingId: string) => {
    return api.delete<OperationResponse>(`/admin/bindings/${bindingId}`);
  },

  /**
   * 获取可用能力列表
   */
  /**
   * 绑定选择器用的可用能力列表。
   *
   * 两个参数都不能省：
   *   · `status=APPROVED` —— 后端会展开成「平台自有已通过 OR 市场公开已过审」，
   *     既挡住未审核能力，也挡住其他企业的私有能力（原先不传，70 个能力全都能绑）
   *   · `pageSize=200`    —— 后端默认 20，原先只有最新 20 个能力能被绑定
   */
  listApprovedCapabilities: () => {
    return api.get<{ items: CapabilityItem[]; total: number; page: number; pageSize: number }>(
      '/admin/capabilities?status=APPROVED&pageSize=200',
    );
  },

  /**
   * 创建能力
   */
  createCapability: (data: {
    name: string;
    description: string;
    type: string;
    industry: string[];
    position: string[];
    inputSchema: any;
    outputSchema: any;
    agentConfig?: {
      platform: string;
      region?: string;
      runtimeKind?: string;
      botId?: string;
      workflowId?: string;
      apiKey?: string;
    };
  }) => {
    return api.post<any>('/admin/capabilities', data);
  },

  /**
   * 创建 Coze 能力（API 接入模式：Bot ID / Workflow ID + PAT）
   */
  createCozeCapability: (data: {
    region: 'CN' | 'GLOBAL';
    runtimeKind: 'BOT_CHAT' | 'WORKFLOW';
    resourceId: string;
    apiKey?: string;
    name: string;
    description: string;
    industry: string[];
    position: string[];
  }) => {
    const payload = {
      type: 'AGENT',
      name: data.name,
      description: data.description,
      industry: data.industry,
      position: data.position,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
      agentConfig: {
        platform: 'COZE',
        region: data.region,
        runtimeKind: data.runtimeKind,
        ...(data.runtimeKind === 'BOT_CHAT'
          ? { botId: data.resourceId }
          : { workflowId: data.resourceId }
        ),
        ...(data.apiKey && { apiKey: data.apiKey }),
      },
    };
    return api.post<any>('/admin/capabilities', payload);
  },

  /**
   * 创建 Coze 能力（URL 链接模式：仅存储 webUrl，前端跳转/嵌入）
   */
  createCozeUrlCapability: (data: {
    webUrl: string;
    name: string;
    description: string;
    industry: string[];
    position: string[];
  }) => {
    const payload = {
      type: 'AGENT',
      name: data.name,
      description: data.description,
      industry: data.industry,
      position: data.position,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
      agentConfig: {
        platform: 'COZE',
        webUrl: data.webUrl,
      },
    };
    return api.post<any>('/admin/capabilities', payload);
  },

  /**
   * 提交能力审核
   */
  submitCapabilityForReview: (capabilityId: string) => {
    return api.post<OperationResponse>(`/admin/capabilities/${capabilityId}/submit`);
  },

  /**
   * 获取所有可用的头像风格列表
   */
  getAvatarStyles: () => api.get<AvatarStylesResponse>('/admin/employees/avatar-styles'),

  registerAvatarStyle: (input: { id: string; name: string; description: string; category: string }) =>
    api.post<ManagedAvatarStyle>('/admin/employees/avatar-styles', input),

  bindEmployeeAvatar: (employeeId: string, input: { styleId: string; portraitUrl: string; faceUrl?: string; version?: string }) =>
    api.post(`/admin/employees/${employeeId}/avatar-bindings`, input),

  /** 更新平台默认风格；applyToAll=true 时同步覆盖单独设置的员工。 */
  batchUpdateAvatarStyle: (styleId: string, applyToAll = false) => {
    return api.patch<{
      success: boolean;
      updated: number;
      style: string;
      appliedToAll: boolean;
    }>('/admin/employees/batch-update-avatar-style', { styleId, applyToAll });
  },

  /**
   * 更新单个员工的头像风格
   */
  updateEmployeeAvatarStyle: (employeeId: string, styleId: string) => {
    return api.patch<EmployeeDetail>(`/admin/employees/${employeeId}/avatar-style`, { styleId });
  },
};

// Binding related types
export interface EmployeeBindingItem {
  id: string;
  priority: number;
  enabled: boolean;
  config: any;
  capability: {
    id: string;
    name: string;
    description: string;
    type: string;
    status: string;
  };
}

export interface CurrentPlatformVersion {
  id: string;
  version: string;
  platformReviewedAt?: string | null;
}

export interface CapabilityItem {
  id: string;
  name: string;
  description: string;
  type: 'agent' | 'rpa' | 'skill' | 'ai-app';
  status: string;
  currentPlatformVersion: CurrentPlatformVersion | null;
}
