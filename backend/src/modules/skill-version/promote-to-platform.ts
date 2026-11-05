import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { parseSkillMarkdown, prepareSkillMarkdown, singleFileSkillWarnings } from '../../shared/skill-content';
import { CapabilityValidatorService } from '../capability-contribution/capability-validator.service';
import { PackageSecurityService } from '../capability-contribution/package-security.service';
import { SkillPackageService } from '../skill-package/skill-package.service';

/** 运营选定个人／企业来源后，复制正文、来源关系和原始包到独立平台谱系。 */

/** 复制平台版需要读的字段。用常量而不是各自写 select，防止调用方漏字段。 */
export const PLATFORM_PROMOTION_SOURCE_SELECT = {
  id: true,
  capabilityId: true,
  version: true,
  content: true,
  changeSummary: true,
  status: true,
  parentVersionId: true,
  packageKey: true,
  packageSha256: true,
  packageFileCount: true,
  packageFilename: true,
} as const;

export interface PlatformPromotionSource {
  id: string;
  capabilityId: string;
  version: string;
  content: string;
  changeSummary: string | null;
  parentVersionId: string | null;
  packageKey: string | null;
  packageSha256: string | null;
  packageFileCount: number | null;
  packageFilename: string | null;
}

export interface PlatformPromotionArgs {
  source: PlatformPromotionSource;
  /** 平台谱系下的新版本号，由调用方按 `scope=PLATFORM` 的兄弟版本算出 */
  version: string;
  /** 私有企业能力复制后由调用方指定独立平台能力。 */
  platformCapabilityId?: string;
  /**
   * 平台谱系上的父版本 = 当前最新的已发布平台版。
   *
   * 不用企业版的父版本：来源已经由 `sourceVersionId` 记着，`parentVersionId` 要能
   * 连出平台自己的时间线。平台首版父版本为空，跨能力来源仅通过 sourceVersionId 追溯。
   */
  platformParentId: string | null;
  status: 'PENDING_PLATFORM_REVIEW' | 'PLATFORM_APPROVED';
  actorId: string;
  changeSummary: string;
  now: Date;
}

export function buildPlatformPromotion(
  args: PlatformPromotionArgs,
): Prisma.SkillVersionUncheckedCreateInput {
  const { source, status, actorId, now } = args;
  const approved = status === 'PLATFORM_APPROVED';
  return {
    capabilityId: args.platformCapabilityId ?? source.capabilityId,
    scope: 'PLATFORM',
    // 唯一索引：同一个企业版本只能被收录一次。投稿过的版本运营再点采纳会撞在这里，
    // 平台侧不会出现同一份正文进两遍。
    sourceVersionId: source.id,
    parentVersionId: args.platformParentId,
    version: args.version,
    content: source.content,
    changeSummary: args.changeSummary,
    status,
    submittedAt: now,
    createdById: actorId,
    // 包是内容寻址的（同一份包只落一次盘），多个版本指向同一个 key 是设计内的，
    // 所以正文过来时可下载产物要一起过来。
    packageKey: source.packageKey,
    packageSha256: source.packageSha256,
    packageFileCount: source.packageFileCount,
    packageFilename: source.packageFilename,
    ...(approved ? { platformReviewedById: actorId, platformReviewedAt: now } : {}),
  };
}

/**
 * 采纳/投稿的默认变更说明。
 *
 * 平台版的列表里只看得到 changeSummary，如果直接沿用企业版那句「基于 v1.0.0 创建」，
 * 运营三个月后完全说不出这一版是从哪家企业收来的。
 */
export function platformPromotionSummary(args: {
  enterpriseName: string | null;
  sourceVersion: string;
  sourceSummary: string | null;
  override?: string;
}) {
  const override = args.override?.trim();
  if (override) return override;
  const origin = `平台采纳 ${args.enterpriseName ?? '企业'} 的 v${args.sourceVersion}`;
  return args.sourceSummary ? `${origin} —— ${args.sourceSummary}` : origin;
}

export function isPlatformWorkingCopy(source: {
  scope: string; status: string; submittedAt?: Date | null;
  workingCopyId?: string | null; workingCopyUpdatedAt?: Date | null;
}) {
  return source.scope === 'PERSONAL' && !source.workingCopyId && !source.workingCopyUpdatedAt &&
    (source.status === 'PERSONAL_ACTIVE' || (source.status === 'DRAFT' && !source.submittedAt));
}

type MonitorClassificationSource = {
  scope: string; status: string;
  sourceVersionId?: string | null; workingCopyId?: string | null;
  workingCopyUpdatedAt?: Date | null; submittedAt?: Date | null;
  promotedVersions?: Array<{ status: string }>;
  reviewSnapshots?: Array<{ promotedVersions?: Array<{ status: string }> }>;
  sourceVersion?: { status: string; enterpriseReviewStatus?: string } | null;
};

export function platformMonitorClassifications(source: MonitorClassificationSource, normalizedStatus?: string) {
  // 历史副本仍可审核，但运营采纳不代表已经提交企业审核。
  const enterpriseStatus = source.scope === 'PLATFORM' ? source.sourceVersion?.status : source.status;
  const enterpriseReviewStatus = normalizedStatus ?? source.sourceVersion?.enterpriseReviewStatus ??
    (enterpriseStatus === 'PENDING_ENTERPRISE_REVIEW' ? 'PENDING'
    : enterpriseStatus === 'ENTERPRISE_APPROVED' ? 'APPROVED'
    : enterpriseStatus === 'ENTERPRISE_REJECTED' ? 'REJECTED' : 'NOT_SUBMITTED');
  const platformStatus = source.scope === 'PLATFORM' ? source.status
    : source.promotedVersions?.[0]?.status ?? source.reviewSnapshots?.find((row) => row.promotedVersions?.length)?.promotedVersions?.[0]?.status;
  const platformProcessingStatus = platformStatus === 'PENDING_PLATFORM_REVIEW' ? 'PENDING_REVIEW'
    : platformStatus === 'PLATFORM_APPROVED' ? 'APPROVED'
    : platformStatus === 'PLATFORM_REJECTED' ? 'REJECTED' : 'NOT_SUBMITTED';
  const generationType = source.workingCopyId ? 'REVIEW_SNAPSHOT'
    : source.scope === 'PLATFORM' ? source.sourceVersionId ? 'PLATFORM_SELECTED' : 'PLATFORM_CREATED'
    : source.scope === 'ENTERPRISE' ? 'ENTERPRISE_VERSION'
    : isPlatformWorkingCopy(source) ? 'LEGACY_WORKING_COPY' : 'CLIENT_SUBMISSION';
  return { enterpriseReviewStatus, platformProcessingStatus, generationType };
}

export type AdminEnterpriseReviewState = {
  id: string;
  enterpriseReviewStatus: 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  enterpriseReviewedAt: Date | null;
  rejectionReason: string | null;
};

/** Cross-row revision comparisons need SQL; run before count/pagination in the same read snapshot. */
export async function readAdminEnterpriseReviewStates(
  tx: Prisma.TransactionClient,
  options: { ids?: string[]; status?: string },
): Promise<AdminEnterpriseReviewState[]> {
  if (options.ids?.length === 0) return [];
  return tx.$queryRaw<AdminEnterpriseReviewState[]>(Prisma.sql`
    SELECT * FROM (
      SELECT v.id,
        CASE WHEN s.id IS NOT NULL AND (
          (s."workingCopyUpdatedAt" IS NOT NULL AND s."workingCopyUpdatedAt" = COALESCE(v."workingCopyUpdatedAt", v."updatedAt")) OR
          (s."workingCopyUpdatedAt" IS NULL AND s."createdAt" >= COALESCE(v."workingCopyUpdatedAt", v."updatedAt"))
        ) THEN CASE WHEN s.status = 'ENTERPRISE_APPROVED' THEN 'APPROVED' ELSE 'REJECTED' END
        WHEN s.id IS NULL AND a."adoptedAt" >= COALESCE(v."workingCopyUpdatedAt", v."updatedAt") THEN 'APPROVED'
        ELSE 'NOT_SUBMITTED' END AS "enterpriseReviewStatus",
        CASE WHEN s."workingCopyUpdatedAt" = COALESCE(v."workingCopyUpdatedAt", v."updatedAt") OR
          (s."workingCopyUpdatedAt" IS NULL AND s."createdAt" >= COALESCE(v."workingCopyUpdatedAt", v."updatedAt"))
          THEN s."enterpriseReviewedAt" WHEN s.id IS NULL AND a."adoptedAt" >= COALESCE(v."workingCopyUpdatedAt", v."updatedAt")
          THEN a."adoptedAt" ELSE NULL END AS "enterpriseReviewedAt",
        CASE WHEN s."workingCopyUpdatedAt" = COALESCE(v."workingCopyUpdatedAt", v."updatedAt") OR
          (s."workingCopyUpdatedAt" IS NULL AND s."createdAt" >= COALESCE(v."workingCopyUpdatedAt", v."updatedAt"))
          THEN s."rejectionReason" ELSE NULL END AS "rejectionReason"
      FROM skill_versions v JOIN capabilities c ON c.id = v."capabilityId"
      LEFT JOIN LATERAL (
        SELECT r.* FROM skill_versions r
        WHERE r."workingCopyId" = COALESCE(v."workingCopyId", v.id)
          AND r.status IN ('ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED')
          AND (v."workingCopyId" IS NULL OR r."createdAt" <= v."createdAt")
          AND (EXISTS (SELECT 1 FROM skill_version_reviews e WHERE e."versionId" = r.id AND e."actorType" = 'ENTERPRISE')
            OR EXISTS (SELECT 1 FROM skill_version_adoptions d WHERE d."sourceVersionId" = r.id)
            OR (r."enterpriseReviewedAt" IS NOT NULL AND r."enterpriseReviewedById" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM skill_versions p WHERE p."sourceVersionId" = r.id)))
        ORDER BY r."createdAt" DESC, r.id DESC LIMIT 1
      ) s ON TRUE
      LEFT JOIN LATERAL (
        SELECT d."adoptedAt" FROM skill_version_adoptions d
        WHERE d."sourceVersionId" = COALESCE(v."workingCopyId", v.id)
          AND (v."workingCopyId" IS NULL OR d."adoptedAt" <= v."createdAt")
        ORDER BY d."adoptedAt" DESC, d.id DESC LIMIT 1
      ) a ON TRUE
      WHERE v.scope = 'PERSONAL' AND v.status = 'PERSONAL_ACTIVE' AND c.type = 'SKILL'
        ${options.ids ? Prisma.sql`AND v.id IN (${Prisma.join(options.ids)})` : Prisma.empty}
    ) normalized
    ${options.status ? Prisma.sql`WHERE normalized."enterpriseReviewStatus" = ${options.status}` : Prisma.empty}
  `);
}

/** 对选定版本校验，禁止关联其他历史草稿或沿用 Capability 的旧包。 */
export async function validatePlatformSource(
  source: Pick<PlatformPromotionSource, 'content' | 'packageKey' | 'packageSha256' | 'packageFileCount' | 'packageFilename'>,
  validator: CapabilityValidatorService,
  security: PackageSecurityService,
  packages?: SkillPackageService,
) {
  let body: string;
  try {
    body = source.packageKey || source.packageSha256 ? source.content : parseSkillMarkdown(source.content).content;
  } catch {
    throw new BadRequestException('SKILL.md frontmatter 格式无效');
  }
  const validation = validator.validateSkill(body);
  if (!validation.valid) {
    const reasons = [...new Set(validation.issues.map((issue) => issue.message))].join('；');
    throw new BadRequestException({ message: `技能正文自动校验未通过：${reasons}`, validation });
  }
  if (source.packageKey || source.packageSha256 || source.packageFileCount != null || source.packageFilename) {
    if (!source.packageKey || !source.packageSha256 || !packages) {
      throw new BadRequestException('技能包信息不完整，不能进入平台审核');
    }
    await security.assertReviewable(source.packageSha256, 'SKILL');
    const bytes = await packages.readBytes(source.packageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== source.packageSha256) {
      throw new BadRequestException('技能包哈希与所选版本不一致');
    }
    const stored = await packages.read(source.packageSha256);
    if (stored.key !== source.packageKey || stored.fileCount !== source.packageFileCount ||
        stored.content !== body.trimStart()) {
      throw new BadRequestException('技能包正文或文件信息与所选版本不一致');
    }
    const installable = await packages.readInstallablePackage(source.packageSha256);
    if (source.packageKey !== `skills/${source.packageSha256}.zip` ||
        installable.fileCount !== source.packageFileCount || installable.content !== source.content) {
      throw new BadRequestException('技能包不能按所选版本安装，不能发布');
    }
    validation.warnings.push(...(stored.warnings ?? []));
  } else {
    const prepared = prepareSkillMarkdown(source.content, 'sep-publication-check');
    if (prepared.status === 'BLOCKED') {
      throw new BadRequestException({
        code: 'SKILL_ARTIFACT_BLOCKED', reason: prepared.reason,
        message: prepared.reason === 'PACKAGE_REQUIRED'
          ? '技能引用了本地依赖，请上传完整技能包后发布'
          : '技能入口不可安装，请检查名称、frontmatter 或 UTF-8 大小',
      });
    }
    validation.warnings.push(...singleFileSkillWarnings(source.content));
  }
  return validation;
}
