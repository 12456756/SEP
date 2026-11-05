// Mirror of backend response shapes (kept minimal, only what the UI reads).
import type { EmployeeAvatarAsset } from '../../../backend/src/shared/employee-avatar';
import type { InvitationNextAction } from 'shared/invitation-routing';
export type { EmployeeAvatarAsset } from '../../../backend/src/shared/employee-avatar';

export type CapabilityType = 'AGENT' | 'RPA' | 'SKILL' | 'AI_APP';
export type EmployeeStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'TERMINATED';
export type CapabilityStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
export type CapabilityVisibility = 'ENTERPRISE_PRIVATE' | 'MARKET_PUBLIC';
export type ContributionReviewStatus = 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type ContributionPlatformStatus = 'NOT_SUBMITTED' | 'REQUESTED' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';
export type UserRole = 'USER' | 'ADMIN';
export type SkillVersionScope = 'PLATFORM' | 'ENTERPRISE' | 'PERSONAL';
export type SkillVersionStatus =
  | 'DRAFT'
  /** 个人 Skill 显式送审：待企业管理员审核。 */
  | 'PENDING_ENTERPRISE_REVIEW'
  | 'ENTERPRISE_APPROVED'
  | 'PENDING_PLATFORM_REVIEW'
  | 'PLATFORM_APPROVED'
  /** 个人 Skill 企业审核驳回。 */
  | 'ENTERPRISE_REJECTED'
  | 'PLATFORM_REJECTED'
  | 'ARCHIVED'
  /** 原有 Web 工作副本，区别于显式送审版本。 */
  | 'PERSONAL_ACTIVE';

export interface SkillVersionSummary {
  id: string;
  capabilityId: string;
  scope: SkillVersionScope;
  enterpriseId: string | null;
  parentVersionId: string | null;
  sourceVersionId: string | null;
  version: string;
  changeSummary: string | null;
  status: SkillVersionStatus;
  createdAt: string;
  updatedAt: string;
  hasPlatformSubmission?: boolean;
}

export type EnterpriseSkillReviewStatus =
  | 'PENDING_ENTERPRISE_REVIEW'
  | 'ENTERPRISE_APPROVED'
  | 'ENTERPRISE_REJECTED';

export interface EnterpriseSkillVersionReviewItem {
  id: string;
  capabilityId: string;
  parentVersionId: string | null;
  enterpriseId: string | null;
  ownerId: string | null;
  scope: 'PERSONAL';
  version: string;
  status: EnterpriseSkillReviewStatus;
  changeSummary: string | null;
  submittedAt: string | null;
  enterpriseReviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  // 关联展示字段兼容后端先旧后新的滚动部署。
  capability?: Pick<Capability, 'id' | 'name' | 'description'>;
  owner?: { id: string; name: string | null; email: string } | null;
}

export interface EnterpriseSkillVersionReviewResponse {
  total: number;
  items: EnterpriseSkillVersionReviewItem[];
  page: number;
  limit: number;
}

export interface EnterpriseSkillVersionReviewResult {
  id: string;
  status: SkillVersionStatus;
  publishedVersionId: string | null;
}

export interface SkillVersionPreview extends SkillVersionSummary {
  content: string;
  rejectionReason?: string | null;
  capability: Pick<Capability, 'id' | 'name' | 'description'>;
  /**
   * 来源企业。仅运营审核详情返回：企业投稿产生的是 scope=PLATFORM 副本、自身
   * enterpriseId 为空，后端顺 sourceVersionId 回查后填在这里。
   */
  enterprise?: { id: string; name: string } | null;
  /**
   * 该企业版本已被收录成的平台版本。sourceVersionId 是唯一索引，所以最多一条 ——
   * 有值就说明这一版投过稿或被采纳过，不该再给一个可点的采纳按钮。
   */
  promotedVersions?: SkillVersionSummary[];
}

export interface EmployeeSkillVersionItem {
  /** 企业默认，与本人实际使用的 currentVersion 分离。 */
  enterpriseVersion: SkillVersionSummary | null;
  capability: Pick<Capability, 'id' | 'name' | 'description' | 'type'>;
  currentVersion: SkillVersionSummary | null;
  versions: SkillVersionSummary[];
  upgradeAvailable: boolean;
}

export interface EmployeeSkillVersionsResponse {
  subscriptionId: string;
  canManage: boolean;
  skills: EmployeeSkillVersionItem[];
}

export interface UserProfile {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  name: string | null;
  avatar: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  type: CapabilityType;
  industry: string[];
  position: string[];
  status: CapabilityStatus;
  createdAt: string;
}

export interface ContributionCapability {
  id: string;
  name: string;
  description: string;
  type: CapabilityType;
  industry: string[];
  position: string[];
  status: CapabilityStatus;
  enterpriseId: string | null;
  visibility: CapabilityVisibility;
  enterpriseReviewStatus: ContributionReviewStatus;
  enterpriseReviewedById: string | null;
  enterpriseReviewedAt: string | null;
  enterpriseRejectionReason: string | null;
  platformReviewStatus: ContributionPlatformStatus;
  platformSubmittedById: string | null;
  platformSubmittedAt: string | null;
  platformRejectionReason: string | null;
  validationResult: Record<string, unknown> | null;
  validatedAt: string | null;
  usageCount: number;
  rating: number | null;
  createdAt: string;
  updatedAt: string;
  contributor: { id: string; name: string | null; email: string };
  enterprise: { id: string; name: string } | null;
  skillConfig: { id: string; modelId: string; temperature: number; maxTokens: number } | null;
  rpaConfig: { id: string; platform: 'SHIZAI' | 'YINGDAO'; executionMode: 'DOWNLOAD' | 'CLOUD' | 'CLIENT'; packageSha256: string | null; configDoc: string | null } | null;
  agentConfig: { id: string; platform: string; botId: string | null; workflowUrl: string | null; skillName: string | null } | null;
  _count: { skillVersions: number; bindings: number };
}

export interface ContributionOverview {
  enterpriseId: string | null;
  capabilityCount: number;
  pendingEnterpriseReview: number;
  pendingPlatformAuthorization: number;
  publicCapabilityCount: number;
  usageCount: number;
  pendingRewardPoints: number;
}

export interface ContributionCapabilityDetail extends ContributionCapability {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  rpaVersions?: Array<{
    id: string;
    version: string;
    packageFilename: string | null;
    packageFileCount: number;
    packageBytes: number;
    packageSha256: string;
    configDoc: string;
    status: string;
    validationResult?: Record<string, unknown> | null;
    validatedAt?: string | null;
    rejectionReason?: string | null;
    createdById: string;
    createdAt: string;
    updatedAt: string;
  }>;
  skillVersions: Array<{
    id: string;
    scope: SkillVersionScope;
    enterpriseId: string | null;
    parentVersionId: string | null;
    sourceVersionId: string | null;
    version: string;
    changeSummary: string | null;
    status: SkillVersionStatus;
    /** 上传的 SKILL 包。在线编写的版本这四个字段全为 null。 */
    packageKey: string | null;
    packageSha256: string | null;
    packageFileCount: number | null;
    packageFilename: string | null;
    rejectionReason: string | null;
    submittedAt?: string | null;
    validationResult?: Record<string, unknown> | null;
    validatedAt?: string | null;
    createdById: string;
    createdAt: string;
    updatedAt: string;
  }>;
  contributionRewards: Array<{
    id: string;
    eventType: string;
    points: number;
    amount: string | null;
    status: string;
    createdAt: string;
    settledAt: string | null;
  }>;
}

export interface ContributionVersionDiff {
  version: {
    id: string;
    capabilityId: string;
    capabilityName: string;
    scope: string;
    enterpriseId: string | null;
    parentVersionId: string | null;
    sourceVersionId: string | null;
    version: string;
    changeSummary: string | null;
    status: string;
    rejectionReason: string | null;
    submittedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  parent: { id: string; version: string; content: string } | null;
  current: { id: string; version: string; content: string };
  changed: boolean;
  reviews: Array<{
    id: string;
    actorType: string;
    decision: string;
    reviewerId: string;
    comment: string | null;
    createdAt: string;
    reviewer?: { id: string; name: string | null; email: string } | null;
  }>;
}

export interface ContributionRewardEvent {
  id: string;
  eventType: string;
  points: number;
  amount: string | null;
  status: string;
  dedupeKey: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  settledAt: string | null;
  capability: { id: string; name: string } | null;
}

export interface ContributionUsage {
  capability: { id: string; name: string };
  totalBindings: number;
  employees: Array<{
    employeeId: string;
    employeeName: string;
    subscriptionId: string | null;
    selectedVersion: Pick<SkillVersionSummary, 'id' | 'scope' | 'version' | 'changeSummary' | 'status' | 'createdAt' | 'updatedAt'> | null;
    effectiveVersion: Pick<SkillVersionSummary, 'id' | 'scope' | 'version' | 'changeSummary' | 'status' | 'createdAt' | 'updatedAt'> | null;
    lastUsedAt: string | null;
    usageCount: number;
  }>;
}

export interface CapabilityBinding {
  id: string;
  order: number;
  capability: Capability;
}

export interface DigitalEmployee {
  id: string;
  name: string;
  description: string;
  industry: string;
  position: string;
  functionalCategory: string;
  avatar: string | null;
  avatarAsset?: EmployeeAvatarAsset | null;
  systemPrompt?: string;
  modelId?: string;
  maxSteps?: number;
  price: number;
  version: string;
  status: EmployeeStatus;
  createdAt: string;
  bindings?: CapabilityBinding[];
  _count?: { bindings?: number; subscriptions?: number };
}

/**
 * 雇佣关系。收敛后订阅即雇佣关系，取代了原先的 EmployeeInstance ——
 * 「一企业一员工一雇佣关系」，部门差异化由授权记录的 departmentId 表达，
 * 而非开多份雇佣关系。
 */
export interface Subscription {
  id: string;
  /** 企业内自定义称呼；后端在未自定义时已回落为模板名，故非空 */
  name: string;
  status: SubscriptionStatus;
  /** 雇佣时锁定的模板版本 */
  templateVersion: string;
  /** 模板当前最新版本 */
  latestVersion: string;
  /** 提示式升级：不自动跟进，由企业主动确认 */
  upgradeAvailable: boolean;
  config: Record<string, unknown> | null;
  startDate: string;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
  employee: Pick<
    DigitalEmployee,
    'id' | 'name' | 'description' | 'avatar' | 'avatarAsset' | 'industry' | 'position' | 'functionalCategory' | 'status' | 'version'
  > & { annualPriceCNY: number | null };

  // ── 订阅赠送算力余额（人民币，Decimal 序列化为字符串）─────────────────────
  /** 订阅时按「员工级配置 > 系统默认值」生成的赠送金额快照 */
  giftGrantedCNY: string;
  giftUsedCNY: string;
  /** 剩余可用赠送金额。订阅终止（giftStatus=EXPIRED）时后端已归零 */
  giftRemainingCNY: string;
  /** ACTIVE 可用 · EXHAUSTED 已用尽 · EXPIRED 订阅已终止 · NONE 无赠送记录 */
  giftStatus: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'NONE';

  /**
   * 使用情况，与「我的硅基员工」同源（后端同一个 EmployeeUsageService）。
   *
   * 雇佣管理页靠它回答「谁在用、谁白雇着」—— 没有这组数，那一页只剩状态和
   * 日期，看不出任何该处理的事。聚合失败或无数据时为 undefined。
   */
  usage?: MyEmployeeUsage;
}

export interface ConversationSession {
  id: string;
  title: string | null;
  employeeId: string;
  modelId?: string | null; // 会话级模型覆盖
  source?: 'CHAT' | 'TASK';
  taskPlanId?: string | null;
  taskStepId?: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: Pick<DigitalEmployee, 'id' | 'name' | 'avatar' | 'avatarAsset' | 'modelId' | 'status'>;
  _count?: { messages?: number };
}

export interface ToolCallRecord {
  name?: string;
  capabilityId?: string;
  success?: boolean;
  durationMs?: number;
  arguments?: Record<string, unknown>;
  result?: unknown;
  [key: string]: unknown;
}

export type AttachmentType = 'image' | 'document' | 'video';

/**
 * 消息附件 —— 与后端 `MessageAttachmentSchema` 一一对应。
 *
 * `key` 是存储对象的永久标识，`url` 是有时效的签名链接。会话详情接口每次
 * 读取都会按 key 重签 url，所以渲染时直接用 url；只有长时间停留在页面上
 * 才可能过期，那时用 key 走 `POST /upload/refresh-url` 重取。
 */
export interface MessageAttachment {
  type: AttachmentType;
  key: string;
  url: string;
  name: string;
  size: number;
  mimeType?: string;
}

export interface Message {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'TOOL';
  content: string;
  toolCalls?: ToolCallRecord[] | null;
  knowledgeSources?: KnowledgeSource[] | null;
  /** 多模态附件（仅用户消息） */
  attachments?: MessageAttachment[] | null;
  /** 多员工协作：实际处理该消息的员工 ID，缺失时归属会话默认员工 */
  metadata?: { handledBy?: string } | null;
  createdAt: string;
}

export interface KnowledgeSource {
  chunkId: string;
  content: string;
  source: string;
  score: number;
  knowledgeBaseId: string;
}

export interface ConversationDetail extends ConversationSession {
  messages: Message[];
}

/**
 * 人才市场的公开员工视图 —— 后端 select 白名单的投影结果。
 *
 * 刻意**没有** systemPrompt / modelId / maxSteps：提示词等于这个员工的
 * 全部内容，不对访客公开。需要这些字段的地方（管理端）用 DigitalEmployee。
 */
export interface MarketEmployee {
  id: string;
  name: string;
  description: string;
  industry: string;
  position: string;
  functionalCategory: string;
  avatar: string | null;
  avatarAsset?: EmployeeAvatarAsset | null;
  price: number | null;
  annualPriceCNY: number | null;
  includedComputeCNY: number;
  version: string;
  publishedAt: string | null;
  isNew?: boolean;
  isHot?: boolean;
  bindings: {
    id: string;
    order: number;
    capability: {
      id: string;
      name: string;
      type: CapabilityType;
      description: string;
    };
  }[];
  _count?: { subscriptions?: number };
  /** 跨企业累计履历。列表和详情都带，缺失时界面留破折号 */
  stats?: EmployeeTrackRecord;
}

/** 员工模板的跨企业履历（后端 EmployeeTrackRecordService） */
export interface EmployeeTrackRecord {
  /** 累计能力执行次数（全平台） */
  totalExecutions: number;
  /** 成功率 0–100 整数；从未执行过为 null，界面留破折号而不是 0% */
  successRate: number | null;
}

// ── 企业组织 ──────────────────────────────────────────────────────────────────

export type EnterpriseRole = 'ENTERPRISE_ADMIN' | 'DEPT_MANAGER' | 'MEMBER';

export interface Department {
  id: string;
  name: string;
  memberCount?: number;
  sortOrder: number;
  parentId: string | null;
  children: Department[];
  _count?: { members: number };
}

export interface EnterpriseMember {
  id: string;
  role: EnterpriseRole;
  position: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null; avatar: string | null };
  department: { id: string; name: string; parent: { id: string; name: string } | null } | null;
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
export type InvitationEmailStatus =
  | 'UNKNOWN'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'NOT_CONFIGURED';

export interface EnterpriseInvitation {
  id: string;
  email: string;
  role: EnterpriseRole;
  position: string | null;
  status: InvitationStatus;
  emailStatus: InvitationEmailStatus;
  emailLastAttemptAt: string | null;
  emailSentAt: string | null;
  emailError: string | null;
  expiresAt: string;
  createdAt: string;
  /** 仅 ACCEPTED 有值 */
  acceptedAt?: string | null;
  department: { id: string; name: string } | null;
}

/**
 * 创建邀请的响应。`token` 是**一次性明文**，只在此响应里出现 ——
 * 列表接口不返回它（库里只存 SHA-256 摘要）。
 * 所以 UI 必须在拿到响应时立刻把链接呈现给管理员，关闭后无法找回。
 */
export interface CreatedInvitation extends EnterpriseInvitation {
  token: string;
  invitationUrl: string;
}

/**
 * `GET /auth/invitations/verify` 的响应 —— 受邀页在用户还没有账号时就要
 * 展示「你被邀请加入 X 公司」，所以这个接口是公开的。
 *
 * 字段是刻意裁剪过的：只有展示所需的企业名/角色/部门，不含企业组织结构。
 * 后端对「不存在」与「已失效」返回**同一个** 400 措辞，
 * 故前端不要试图从错误里区分二者 —— 那个区分本身就是 token 枚举的入口。
 */
export interface InvitationPreview {
  id: string;
  nextAction: InvitationNextAction;
  email: string;
  role: EnterpriseRole;
  position: string | null;
  status: InvitationStatus;
  expiresAt: string;
  enterprise: { id: string; name: string; logo: string | null };
  department: { id: string; name: string } | null;
}

/**
 * 移出成员 / 主动离职的处置结果。
 * `vacatedDepartments` 非空表示这些部门失去了负责人，需要管理员补指派 ——
 * 后端刻意不阻塞移出，把补动作交给 UI 提示。
 */
export interface OffboardResult {
  id: string;
  removed: boolean;
  reclaimedGrants: number;
  canceledRequests: number;
  vacatedDepartments: { id: string; name: string }[];
}

export interface GrantRecord {
  id: string;
  department: { id: string; name: string } | null;
  member: { id: string; name: string | null; email: string } | null;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
}

export type MemberGrantStatus = 'all' | 'grantable' | 'granted' | 'history';

export interface MemberEmployeeGrantCandidate {
  subscriptionId: string;
  name: string;
  status: SubscriptionStatus;
  endDate: string | null;
  employee: {
    id: string;
    name: string;
    avatar: string | null;
    position: string;
  };
  directGrant: {
    id: string;
    expiresAt: string | null;
    expired: boolean;
  } | null;
  coveredByDepartment: boolean;
}

export interface MemberEmployeeGrantCandidatesResponse {
  items: MemberEmployeeGrantCandidate[];
  page: number;
  pageSize: number;
  total: number;
}

export interface MemberGrantBatchResult {
  memberId: string;
  createdIds: string[];
  renewedSubscriptionIds: string[];
  skippedSubscriptionIds: string[];
}

export interface MyEmployee {
  subscriptionId: string;
  name: string;
  templateVersion: string;
  employee: {
    id: string;
    name: string;
    avatar: string | null;
    avatarAsset?: EmployeeAvatarAsset | null;
    description?: string | null;
    position?: string | null;
    functionalCategory?: import('./employee-categories').EmployeeCategory;
    bindings?: Array<{
      id: string;
      priority: number;
      capability: {
        id: string;
        name: string;
        type: CapabilityType;
        description: string;
      };
    }>;
  };
  department: { id: string; name: string } | null;
  grantSource: 'DIRECT' | 'DEPARTMENT';
  expiresAt: string | null;
  /** 运营是否已上传员工包；false 时下载按钮应禁用 */
  packageAvailable?: boolean;

  // ── 订阅赠送算力余额（元，Decimal 序列化为字符串）───────────────────────
  giftGrantedCNY?: string;
  giftUsedCNY?: string;
  /** 剩余可用赠送金额。非 ACTIVE 状态一律为 '0.00' */
  giftRemainingCNY?: string;
  giftStatus?: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'NONE';

  /** 本企业范围内的使用情况。后端没算出结果时为 undefined，此时整段隐藏 */
  usage?: MyEmployeeUsage;
}

/**
 * 卡片上的使用情况（会议2 §6.1「使用人数即口碑」）。
 * 与后端 `MyEmployeeUsage` 一一对应，字段含义见 backend/src/shared/index.ts。
 */
export interface MyEmployeeUsage {
  activeUserCount30d: number;
  grantedUserCount: number;
  /**
   * 授权是怎么给出去的：几个部门、几个人。
   *
   * 与 grantedUserCount 是两个问题 —— 那个答「覆盖到多少人」，这两个答
   * 「这些人是怎么覆盖到的」。收回方式取决于后者（改部门授权 vs 删若干条）。
   */
  grantedDepartmentCount: number;
  grantedMemberCount: number;
  /** 从未用过为 null —— 不要渲染成「1970」或「0 天前」 */
  lastUsedAt: string | null;
  /** 自然月 —— 与账单、算力余额页同口径，不要和上面的 30 天混着讲 */
  monthCostCNY: string;
  monthCallCount: number;
  /** 成功率的分母（近 30 天执行次数）。比例必须带分母显示，4/6 和 87/100 不是一回事 */
  executionCount30d: number;
  /** 无执行记录时为 null，界面上应留空而不是显示 0% */
  successRate30d: number | null;
}

/** 员工包的一个已发布版本 */
export interface EmployeePackage {
  id: string;
  version: string;
  filename: string | null;
  /** SHA-256 十六进制，供下载方核对完整性（ZIP 上传时有值） */
  sha256: string | null;
  fileSizeBytes: number | null;
  /** pi package 引用（packageRef 模式时有值，ZIP 模式为 null）*/
  packageRef: { type: 'npm' | 'git'; spec: string } | null;
  changelog: string | null;
  createdAt: string;
}

// ============================================================================
// Enterprise Model Config Types (Phase 1)
// ============================================================================

export type EmployeeModelPolicy = "FOLLOW_TEMPLATE" | "FORCE_DEFAULT";

export interface UpdateEnterpriseModelConfigDto {
  defaultChatModel?: string;
  allowedChatModels?: string[];
  allowUserSwitchModel?: boolean;
  rerankModel?: string | null;
  employeeModelPolicy?: EmployeeModelPolicy;
  employeeDefaultModel?: string | null;
  /** 编排与分析模型。null = 跟随平台默认 */
  plannerModel?: string | null;
}

export interface DepartmentModelPolicyDto {
  defaultChatModel?: string | null;
  allowedChatModels?: string[];
}

/** 模型来源，按解析优先级从高到低 */
export type EffectiveModelSource =
  | 'USER_CHOICE'
  | 'EMPLOYEE_INSTANCE'
  | 'DEPARTMENT'
  | 'ENTERPRISE'
  | 'SYSTEM_DEFAULT';

export interface EffectiveModelConfig {
  chatModel: string;
  allowedChatModels: string[];
  allowUserSwitchModel: boolean;
  embeddingModel: string;
  rerankModel: string | null;
  embeddingBatchSize: number;
  embeddingTimeoutMs: number;
  source: EffectiveModelSource;
}

export interface DeptMemberItem {
  id: string;
  role: EnterpriseRole;
  position: string | null;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    avatar: string | null;
  };
}

export interface DeptMembersResponse {
  total: number;
  page: number;
  limit: number;
  leaderId: string | null;
  items: DeptMemberItem[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  documentCount: number;
  readyDocumentCount: number;
  createdAt: string;
  updatedAt: string;
  permissions: {
    canView: boolean;
    canSearch: boolean;
    canManage: boolean;
    canUpload: boolean;
    canManageGrants: boolean;
  };
}

export type KnowledgeBaseDetail = KnowledgeBase;

export interface KnowledgePage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface KnowledgeLimits {
  allowedExtensions: string[];
  maxFileBytes: number;
  maxFilesPerRequest: number;
  maxQueryCharacters: number;
  maxSearchKnowledgeBases: number;
  maxTopK: number;
  maxResultTokens: number;
}

export interface KnowledgeBaseList extends KnowledgePage<KnowledgeBase> {
  viewer: { memberId: string; enterpriseId: string; role: 'ADMIN' | 'EMPLOYEE' };
  capabilities: { canCreateKnowledgeBase: boolean; canListGrantCandidates: boolean };
  limits: KnowledgeLimits;
}

export interface KnowledgeMemberDisplay {
  memberId: string;
  name: string;
  avatarUrl: string | null;
  position: string | null;
  departmentName: string | null;
}

export interface KnowledgeMemberGrant {
  id: string;
  member: KnowledgeMemberDisplay;
  grantedAt: string;
  grantedBy: { memberId: string | null; name: string };
}

export type KnowledgeProcessingStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface KnowledgeDocumentVersion {
  id: string;
  version: number;
  status: KnowledgeProcessingStatus;
  originalName: string;
  createdAt: string;
}

/** 后端安全投影，不包含存储路径、解析原文或上游异常。 */
export interface KnowledgeDocumentVersionDetail extends KnowledgeDocumentVersion {
  stage: string | null;
  lastError: string | null;
  errorCode: string | null;
  retryable: boolean;
  attempts: number;
  processedChunks: number;
  totalChunks: number | null;
}

export interface KnowledgeDocument {
  id: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  status: KnowledgeProcessingStatus;
  revision: number;
  etag: string;
  activeVersionId: string | null;
  latestVersionId: string | null;
  searchable: boolean;
  activeVersion: KnowledgeDocumentVersion | null;
  latestVersion: KnowledgeDocumentVersionDetail | null;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
  permissions?: { canDelete: boolean; canReprocess: boolean };
}

export interface KnowledgePreviewBlock {
  blockId: string;
  type: 'HEADING' | 'PARAGRAPH' | 'TABLE' | 'LIST' | 'CODE';
  text: string;
  location: {
    pageStart: number | null;
    pageEnd: number | null;
    sectionPath: string[];
    blockStart: number;
    blockEnd: number;
  };
}

export interface KnowledgeDocumentPreview extends KnowledgePage<{ chunkId: string; text: string }> {
  versionId: string | null;
  documentId: string;
  documentName: string;
  previewKind: 'PROCESSED_CHUNKS' | 'PARSED_BLOCKS';
}

// ── Cost Analytics (Phase 3) ──────────────────────────────────────────────────

export interface CostSummary {
  totalCost: number;
  budgetCNY: number | null;
  budgetUsagePercent: number | null;
  periodStart: string;
  periodEnd: string;
  comparisonPeriodCost?: number;
  changePercent?: number;
}

export interface CostByDimensionItem {
  id: string;
  name: string;
  cost: number;
  percent: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostTrendPoint {
  date: string;
  cost: number;
  messageCount: number;
}

export interface CostAlert {
  id: string;
  type: 'BUDGET_THRESHOLD' | 'BUDGET_EXCEEDED' | 'ANOMALY';
  severity: 'WARNING' | 'ERROR';
  message: string;
  triggeredAt: string;
  acknowledged: boolean;
}

// ── Subscription Request (P0) ──────────────────────────────────────────────────

/**
 * 订阅申请。普通员工申请订阅硅基员工，管理员审批通过后自动创建订阅并授权。
 */
export interface SubscriptionRequest {
  id: string;
  enterpriseId: string;
  requesterId: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  employeeId: string;
  employee: Pick<DigitalEmployee, 'id' | 'name' | 'avatar'>;
  reason: string | null;
  requestedDays: number | null;
  status: RequestStatus;
  /** 申请类型：SUBSCRIBE=订阅（付费）；GRANT=授权（免费） */
  kind: 'SUBSCRIBE' | 'GRANT';
  reviewerId: string | null;
  reviewer: { id: string; name: string | null; email: string } | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  subscriptionId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 申请人关联的成员信息（仅 pending 列表返回） */
  requester?: {
    id: string;
    userId: string;
    role: EnterpriseRole;
    user: { name: string | null; email: string };
  };
}
