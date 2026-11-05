import type { SkillVersionPreview, SkillVersionScope, SkillVersionStatus, SkillVersionSummary } from '@/lib/types';

export const VERSION_TYPE_LABELS: Record<SkillVersionScope, string> = {
  PERSONAL: '个人提交', ENTERPRISE: '企业发布版', PLATFORM: '平台版本',
};
export const ENTERPRISE_REVIEW_LABELS = {
  NOT_SUBMITTED: '未提交企业审核', PENDING: '企业待审', APPROVED: '企业通过', REJECTED: '企业驳回',
};
export const PLATFORM_PROCESSING_LABELS = {
  NOT_SUBMITTED: '未发布', PENDING_REVIEW: '历史待审', APPROVED: '已发布', REJECTED: '历史拒绝',
};
export const GENERATION_TYPE_LABELS = {
  CLIENT_SUBMISSION: '客户端提交', LEGACY_WORKING_COPY: '历史副本', REVIEW_SNAPSHOT: '审核快照',
  ENTERPRISE_VERSION: '审核生成企业版', PLATFORM_CREATED: '运营创建', PLATFORM_SELECTED: '平台收录',
};
export interface MonitorClassifications {
  originalSubmitters?: { id: string; name: string | null }[];
  enterprisePublisher?: { id: string; name: string | null } | null;
  enterprisePublishedVersions?: { id: string; version: string; isEnterpriseCurrent: boolean }[];
  ownerId?: string | null;
  owner?: { id: string; name: string | null; email?: string } | null;
  enterpriseReviewStatus?: keyof typeof ENTERPRISE_REVIEW_LABELS;
  platformProcessingStatus?: keyof typeof PLATFORM_PROCESSING_LABELS;
  promotedVersions?: SkillVersionSummary[];
  reviewSnapshots?: (SkillVersionSummary & { workingCopyUpdatedAt?: string | null; promotedVersions?: SkillVersionSummary[] })[];
  createdBy?: { id: string; name: string | null } | null;
  sourceVersion?: SkillVersionSummary & { owner?: { id: string; name: string | null } | null; workingCopy?: SkillVersionSummary | null } | null;
  isWorkingCopy?: boolean;
  workingCopyId?: string | null;
  generationType?: keyof typeof GENERATION_TYPE_LABELS;
  isEnterpriseCurrent?: boolean;
  enterpriseDefaultCount?: number;
  isPlatformLatest?: boolean;
  isMarketPublic?: boolean;
  defaultBindingCount?: number;
  marketBindingCount?: number;
}
export function originalSubmitterLabel(row: MonitorRow | MonitorDetail) {
  if (row.originalSubmitters) return row.originalSubmitters.map((person) => person.name || person.id).join('、') || '未标注';
  // 旧接口只兼容个人记录，不把企业发布版的创建人当作原提交人。
  if (row.scope === 'PERSONAL') return row.createdBy?.name || row.createdBy?.id || row.owner?.name || row.ownerId || '未标注';
  return '未标注';
}
export function enterpriseVersionEmptyLabel(row: MonitorRow | MonitorDetail) {
  if (!row.enterprisePublishedVersions) return '未标注';
  return row.enterpriseReviewStatus === 'APPROVED' || row.status === 'ENTERPRISE_APPROVED'
    ? '未关联企业发布版' : '尚无企业发布版';
}
export type MonitorRow = SkillVersionSummary & MonitorClassifications & {
  capability: { id: string; name: string; description: string };
  enterprise?: { id: string; name: string } | null;
};
export type MonitorDetail = SkillVersionPreview & MonitorClassifications & {
  currentPlatformVersion: { id: string; capabilityId: string; version: string; content: string; updatedAt: string } | null;
  validationResult?: unknown;
  packageKey?: string | null;
  packageSha256?: string | null;
  packageFileCount?: number | null;
  packageFilename?: string | null;
  packageWarnings?: { code: string; message: string; path?: string }[];
  reviews?: { id: string; actorType: string; decision: string; comment: string | null; createdAt: string; reviewer: { id: string; name: string | null } }[];
};

function validationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => validationRecord(entry) && typeof entry.message === 'string' && entry.message.trim()
    ? [entry.message.trim()] : []);
}

export function monitorValidation(result: unknown) {
  if (result == null) return { label: '无已存校验结果', issues: [], warnings: [] };
  if (!validationRecord(result)) return { label: '已存校验状态未标注', issues: [], warnings: [] };
  const warnings = validationMessages(result.warnings);
  const issues = validationMessages(result.issues);
  const failedChecks = Array.isArray(result.checks)
    ? result.checks.filter((check) => validationRecord(check) && check.passed === false) : [];
  // 不按新规则把历史失败改判为通过；新规则下 warning 对应的 check 仍可能为 false。
  const failed = result.valid === false || (Array.isArray(result.issues) && result.issues.length > 0)
    || (result.valid !== true && failedChecks.length > 0);
  return {
    label: failed ? '已存静态校验未通过' : result.valid === true ? '已存静态校验通过' : '已存校验状态未标注',
    issues: issues.length ? issues : failed ? validationMessages(failedChecks) : [],
    warnings,
  };
}
export function canSelectSource(row: MonitorDetail) {
  if (row.scope === 'PLATFORM') return false;
  if (!promotedVersion(row)) return true;
  return Boolean(row.isWorkingCopy && !row.reviewSnapshots?.some((snapshot) => snapshot.workingCopyUpdatedAt === row.updatedAt && snapshot.promotedVersions?.length));
}
export function publishedSourceVersion(row: MonitorRow | MonitorDetail) {
  return row.promotedVersions?.find((entry) => entry.status === 'PLATFORM_APPROVED')
    // 无 revision 的旧快照无法确认属于旧正文，保守保留其已发布关系。
    ?? row.reviewSnapshots?.filter((snapshot) => !row.isWorkingCopy
      || snapshot.workingCopyUpdatedAt == null || snapshot.workingCopyUpdatedAt === row.updatedAt)
      .flatMap((snapshot) => snapshot.promotedVersions ?? [])
      .find((entry) => entry.status === 'PLATFORM_APPROVED');
}
export function canPublishVersion(row: MonitorDetail) {
  // 工作副本的汇总分类可能来自旧快照，不能作为当前 revision 已发布的依据。
  if (row.status === 'PLATFORM_APPROVED' || publishedSourceVersion(row)
    || (!row.isWorkingCopy && row.platformProcessingStatus === 'APPROVED')) return false;
  return row.scope !== 'PLATFORM' || ['DRAFT', 'PENDING_PLATFORM_REVIEW', 'PLATFORM_REJECTED'].includes(row.status);
}
export interface MonitorFilters {
  search?: string;
  enterpriseName?: string;
  ownerName?: string;
  scope?: SkillVersionScope;
  status?: SkillVersionStatus;
  enterpriseReviewStatus?: keyof typeof ENTERPRISE_REVIEW_LABELS;
  platformProcessingStatus?: keyof typeof PLATFORM_PROCESSING_LABELS;
  enterpriseId?: string;
  ownerId?: string;
  capabilityId?: string;
  createdFrom?: string;
  createdTo?: string;
  generationType?: keyof typeof GENERATION_TYPE_LABELS;
}
export function monitorContextFilters(params: Pick<URLSearchParams, 'get'>): MonitorFilters {
  const capabilityId = params.get('capabilityId') || undefined;
  const scope = params.get('scope');
  return {
    ...(capabilityId ? { capabilityId } : {}),
    ...((scope === 'PLATFORM' || scope === 'ENTERPRISE' || scope === 'PERSONAL') ? { scope } : {}),
  };
}
export function monitorContextSuffix(filters: MonitorFilters) {
  const params = new URLSearchParams();
  if (filters.capabilityId) params.set('capabilityId', filters.capabilityId);
  if (filters.scope) params.set('scope', filters.scope);
  return params.size ? `?${params}` : '';
}
export function promotedVersion(row: MonitorClassifications) {
  return row.promotedVersions?.[0] ?? row.reviewSnapshots?.find((snapshot) => snapshot.promotedVersions?.length)?.promotedVersions?.[0];
}
export function creationMethodLabel(row: MonitorRow | MonitorDetail) {
  if (row.generationType) return GENERATION_TYPE_LABELS[row.generationType] ?? row.generationType;
  if (row.workingCopyId) return '审核快照';
  if (row.scope === 'PLATFORM') return row.sourceVersionId ? '平台收录' : '运营创建';
  if (row.scope === 'PERSONAL') return row.isWorkingCopy || row.workingCopyId ? '历史副本' : '客户端提交';
  return row.sourceVersionId ? '审核生成' : '历史企业版本';
}
export function currentUsageLabel(row: MonitorRow | MonitorDetail) {
  const labels: string[] = [];
  if (row.isEnterpriseCurrent) labels.push('企业已启用');
  if (row.scope === 'PLATFORM' && row.isPlatformLatest) labels.push(row.isMarketPublic ? '平台已发布' : '平台当前版本');
  if (row.status === 'ARCHIVED' || (row.scope === 'PLATFORM' && row.status === 'PLATFORM_APPROVED' && row.isPlatformLatest === false) || (row.scope === 'ENTERPRISE' && row.status === 'ENTERPRISE_APPROVED' && row.isEnterpriseCurrent === false)) labels.push('历史版本');
  if (labels.length) return labels.join(' · ');
  return row.isEnterpriseCurrent !== undefined || row.isPlatformLatest !== undefined ? '未在使用' : '使用状态未标注';
}
export function monitorQuery(filters: MonitorFilters, page: number, limit: number) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
}

// 分类优先使用服务端独立字段；旧响应中的版本状态只作为展示兼容，不用于本地筛选。
export function enterpriseReviewLabel(row: MonitorRow | MonitorDetail) {
  if (row.enterpriseReviewStatus) return ENTERPRISE_REVIEW_LABELS[row.enterpriseReviewStatus] ?? row.enterpriseReviewStatus;
  if (row.status === 'PENDING_ENTERPRISE_REVIEW') return ENTERPRISE_REVIEW_LABELS.PENDING;
  if (row.status === 'ENTERPRISE_APPROVED') return ENTERPRISE_REVIEW_LABELS.APPROVED;
  if (row.status === 'ENTERPRISE_REJECTED') return ENTERPRISE_REVIEW_LABELS.REJECTED;
  return '企业审核未标注';
}
export function platformProcessingLabel(row: MonitorRow | MonitorDetail) {
  if (row.platformProcessingStatus) return PLATFORM_PROCESSING_LABELS[row.platformProcessingStatus] ?? row.platformProcessingStatus;
  const status = row.scope === 'PLATFORM' ? row.status : promotedVersion(row)?.status;
  if (status === 'PENDING_PLATFORM_REVIEW') return PLATFORM_PROCESSING_LABELS.PENDING_REVIEW;
  if (status === 'PLATFORM_APPROVED') return PLATFORM_PROCESSING_LABELS.APPROVED;
  if (status === 'PLATFORM_REJECTED') return PLATFORM_PROCESSING_LABELS.REJECTED;
  if (row.scope === 'PLATFORM' && ['DRAFT', 'ARCHIVED'].includes(row.status)) return PLATFORM_PROCESSING_LABELS.NOT_SUBMITTED;
  return row.scope === 'PLATFORM' ? '平台处理未标注' : '发布状态未标注';
}
