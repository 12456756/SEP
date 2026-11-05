import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  SkillVersionScope,
  SkillVersionStatus,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { EnterpriseSkillDefaultService } from './enterprise-skill-default.service';
import { EnterpriseSkillReviewService, PERSONAL_REVIEW_RELATIONS, personalReviewState } from './enterprise-skill-review.service';
import {
  buildPlatformPromotion,
  platformPromotionSummary,
  validatePlatformSource,
  isPlatformWorkingCopy,
  platformMonitorClassifications,
  readAdminEnterpriseReviewStates,
} from './promote-to-platform';
import { CapabilityValidatorService } from '../capability-contribution/capability-validator.service';
import { PackageSecurityService } from '../capability-contribution/package-security.service';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { PersonalWalletService, assertActiveRewardRecipientInTx } from '../personal-wallet/personal-wallet.service';
import { SettingService } from '../setting/setting.service';
import { nextSemver } from './skill-version-numbering';
import { readAdminVersionLineages } from './skill-version-admin-lineage';
import type {
  AdoptEnterpriseVersionDto,
  AdminSkillVersionQuery,
  AdoptPersonalVersionsDto,
  CreateEnterpriseSkillVersionDto,
  CreatePlatformSkillVersionDto,
  ReviewSkillVersionDto,
  SubmitAdminPlatformReviewDto,
  PublishPlatformSkillVersionDto,
  UpdateSkillVersionDto,
} from 'shared';

const VERSION_SUMMARY_SELECT = {
  id: true,
  capabilityId: true,
  scope: true,
  enterpriseId: true,
  parentVersionId: true,
  sourceVersionId: true,
  workingCopyId: true,
  workingCopyUpdatedAt: true,
  version: true,
  changeSummary: true,
  status: true,
  ownerId: true,
  submittedAt: true,
  enterpriseReviewedAt: true,
  platformReviewedAt: true,
  rejectionReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PLATFORM_RELEASE_ORDER = [
  { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
  { createdAt: 'desc' }, { id: 'desc' },
] satisfies Prisma.SkillVersionOrderByWithRelationInput[];

type PlatformRelease = Prisma.SkillVersionGetPayload<{ include: {
  capability: true;
  sourceVersion: { select: { capability: { select: { id: true; contributorId: true; enterpriseId: true } } } };
} }>;

const PERSONAL_DIFF_SELECT = {
  ...VERSION_SUMMARY_SELECT,
  owner: { select: { id: true, name: true, email: true } },
  parentVersion: { select: { id: true, scope: true, version: true } },
  ...PERSONAL_REVIEW_RELATIONS,
} satisfies Prisma.SkillVersionSelect;

const ENTERPRISE_REVIEW_SELECT = {
  id: true, versionId: true, actorType: true, decision: true, comment: true, createdAt: true,
  reviewer: { select: { id: true, name: true } },
} satisfies Prisma.SkillVersionReviewSelect;

type PersonalDiffSource = Prisma.SkillVersionGetPayload<{ select: typeof PERSONAL_DIFF_SELECT }>;
type EffectiveVersionState = 'EXPLICIT' | 'AUTOMATIC' | 'MIXED' | 'NONE';
type CapabilityReadContext = { enterpriseId: string; memberId: string; departmentId: string | null; role: string };

@Injectable()
export class SkillVersionService {
  private readonly logger = new Logger(SkillVersionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enterpriseContext: EnterpriseContextService,
    private readonly defaults: EnterpriseSkillDefaultService = new EnterpriseSkillDefaultService(prisma),
    private readonly personalReviews: EnterpriseSkillReviewService = new EnterpriseSkillReviewService(prisma, enterpriseContext, defaults),
    private readonly platformValidator: CapabilityValidatorService = new CapabilityValidatorService(),
    private readonly platformSecurity: PackageSecurityService = new PackageSecurityService(prisma, platformValidator),
    @Optional() private readonly platformPackages?: SkillPackageService,
    private readonly platformWallet: PersonalWalletService = new PersonalWalletService(prisma),
    @Optional() private readonly platformSettings?: SettingService,
  ) {}

  async listEmployeeSkills(userId: string, employeeId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const subscription = await this.getGrantedSubscription(
      ctx.enterpriseId,
      ctx.memberId,
      ctx.departmentId,
      employeeId,
    );

    const bindings = await this.prisma.employeeCapabilityBinding.findMany({
      where: { employeeId, enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } },
      select: {
        capability: {
          select: { id: true, name: true, description: true, type: true },
        },
        defaultSkillVersion: { select: VERSION_SUMMARY_SELECT },
      },
      orderBy: { priority: 'asc' },
    });

    const capabilityIds = bindings.map((binding) => binding.capability.id);
    if (capabilityIds.length === 0) {
      return { subscriptionId: subscription.id, skills: [] };
    }

    const [versions, selections, enterpriseDefaults] = await Promise.all([
      this.prisma.skillVersion.findMany({
        where: {
          capabilityId: { in: capabilityIds },
          OR: [
            { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
            {
              scope: 'ENTERPRISE',
              enterpriseId: ctx.enterpriseId,
              status: 'ENTERPRISE_APPROVED',
            },
            { scope: 'PERSONAL', enterpriseId: ctx.enterpriseId, ownerId: userId },
          ],
        },
        select: VERSION_SUMMARY_SELECT,
        orderBy: PLATFORM_RELEASE_ORDER,
      }),
      this.prisma.subscriptionSkillVersion.findMany({
        where: { subscriptionId: subscription.id },
        select: {
          capabilityId: true,
          version: { select: VERSION_SUMMARY_SELECT },
        },
      }),
      this.prisma.enterpriseSkillDefault.findMany({
        where: { enterpriseId: ctx.enterpriseId, capabilityId: { in: capabilityIds } },
        select: { capabilityId: true, version: { select: VERSION_SUMMARY_SELECT } },
      }),
    ]);

    const versionsByCapability = new Map<string, typeof versions>();
    for (const version of versions) {
      const existing = versionsByCapability.get(version.capabilityId) ?? [];
      existing.push(version);
      versionsByCapability.set(version.capabilityId, existing);
    }
    const selectedByCapability = new Map(
      selections.map((selection) => [selection.capabilityId, selection.version]),
    );
    const defaultByCapability = new Map(enterpriseDefaults.map((row) => [row.capabilityId, row.version]));

    return {
      subscriptionId: subscription.id,
      canManage: ctx.role === 'ENTERPRISE_ADMIN',
      skills: await Promise.all(bindings.map(async (binding) => {
        const candidates = versionsByCapability.get(binding.capability.id) ?? [];
        const enterpriseVersion =
          defaultByCapability.get(binding.capability.id) ??
          selectedByCapability.get(binding.capability.id) ??
          (binding.defaultSkillVersion?.status === 'PLATFORM_APPROVED' ? binding.defaultSkillVersion : null) ??
          candidates.find((version) => version.scope === 'PLATFORM') ??
          null;
        const latestPlatformVersion = candidates.find(
          (version) => version.scope === 'PLATFORM',
        );

        const effective = await this.resolveEffectiveVersion(subscription.id, binding.capability.id, userId);
        // 解析器返回执行正文/包信息；列表仍只返回摘要，避免把完整版本泄露进元数据接口。
        const currentVersion = effective ? Object.fromEntries(
          Object.keys(VERSION_SUMMARY_SELECT).map((key) => [key, effective[key as keyof typeof effective]]),
        ) : null;
        return {
          capability: binding.capability,
          enterpriseVersion,
          currentVersion,
          versions: candidates,
          latestPublishedVersion: latestPlatformVersion ?? null,
          upgradeAvailable:
            Boolean(enterpriseVersion && latestPlatformVersion) &&
            enterpriseVersion?.id !== latestPlatformVersion?.id,
        };
      })),
    };
  }

  async previewEnterpriseVersion(userId: string, versionId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const version = await this.prisma.skillVersion.findUnique({
      where: { id: versionId },
      select: {
        ...VERSION_SUMMARY_SELECT,
        content: true,
        capability: { select: { id: true, name: true, description: true } },
      },
    });
    if (!version) throw new NotFoundException('技能版本不存在');
    if (version.scope === 'PLATFORM' && version.status !== 'PLATFORM_APPROVED') {
      throw new NotFoundException('技能版本不存在');
    }
    if (version.scope === 'ENTERPRISE' && version.enterpriseId !== ctx.enterpriseId) {
      throw new NotFoundException('技能版本不存在');
    }

    if (version.scope === 'PERSONAL') {
      if (version.enterpriseId !== ctx.enterpriseId ||
          (version.ownerId !== userId && ctx.role !== 'ENTERPRISE_ADMIN')) {
        throw new NotFoundException('技能版本不存在');
      }
      // Administrators can inspect their review queue without a personal employee grant.
      if (ctx.role === 'ENTERPRISE_ADMIN') return version;
    }
    if (version.scope === 'ENTERPRISE' && version.status !== 'ENTERPRISE_APPROVED' && ctx.role !== 'ENTERPRISE_ADMIN') {
      throw new NotFoundException('技能版本不存在');
    }
    if (version.scope === 'ENTERPRISE') return version;

    await this.assertCapabilityGrant(
      ctx.enterpriseId,
      ctx.memberId,
      ctx.departmentId,
      version.capabilityId,
    );
    return version;
  }

  async listEnterpriseVersions(userId: string, status?: SkillVersionStatus) {
    const ctx = await this.enterpriseContext.resolve(userId);
    return this.prisma.skillVersion.findMany({
      where: {
        enterpriseId: ctx.enterpriseId,
        scope: 'ENTERPRISE',
        ...(status ? { status } : {}),
      },
      select: {
        ...VERSION_SUMMARY_SELECT,
        capability: { select: { id: true, name: true, description: true } },
        parentVersion: { select: VERSION_SUMMARY_SELECT },
        promotedVersions: { select: { id: true }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    }).then((versions) =>
      versions.map(({ promotedVersions, ...version }) => ({
        ...version,
        hasPlatformSubmission: promotedVersions.length > 0,
      })),
    );
  }

  async createEnterpriseVersion(
    _userId: string,
    _subscriptionId: string,
    _dto: CreateEnterpriseSkillVersionDto,
  ) {
    throw new ForbiddenException('Web 技能正文修改已停用，请通过客户端修改并提交审核');
  }

  async updateEnterpriseVersion(
    _userId: string,
    _versionId: string,
    _dto: UpdateSkillVersionDto,
  ) {
    throw new ForbiddenException('Web 技能正文修改已停用，请通过客户端修改并提交审核');
  }

  async selectVersion(
    userId: string,
    subscriptionId: string,
    capabilityId: string,
    versionId: string,
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const subscription = await this.getActiveSubscriptionById(
      ctx.enterpriseId,
      subscriptionId,
    );
    await this.assertCapabilityBound(subscription.employeeId, capabilityId);
    const result = await this.writeEnterpriseDefault(userId, ctx.enterpriseId, capabilityId, versionId);
    return { subscriptionId, ...result };
  }

  async setEnterpriseDefault(userId: string, capabilityId: string, versionId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    await this.assertCapabilityReadable(ctx, capabilityId);
    return this.writeEnterpriseDefault(userId, ctx.enterpriseId, capabilityId, versionId);
  }

  private async writeEnterpriseDefault(userId: string, enterpriseId: string, capabilityId: string, versionId: string) {
    const version = await this.prisma.skillVersion.findUnique({ where: { id: versionId } });
    if (!version || version.capabilityId !== capabilityId) {
      throw new BadRequestException('所选版本与技能不匹配');
    }
    const selectable =
      (version.scope === 'PLATFORM' && version.status === 'PLATFORM_APPROVED') ||
      (version.scope === 'ENTERPRISE' &&
        version.enterpriseId === enterpriseId &&
        version.status === 'ENTERPRISE_APPROVED');
    if (!selectable) throw new BadRequestException('该版本尚未审核通过或无权使用');

    await this.prisma.$transaction(async (tx) => {
      await this.defaults.lock(tx, enterpriseId, capabilityId);
      await this.defaults.set(tx, enterpriseId, capabilityId, versionId, userId);
    });
    await this.notifySkillVersionUpdated(enterpriseId, capabilityId, version.version);
    return { capabilityId, versionId, version };
  }

  /** 兼容旧路由并拒绝写入，保留历史个人偏好供审计。 */
  async selectPersonalVersion(
    _userId: string,
    _subscriptionId: string,
    _capabilityId: string,
    _versionId: string | null,
  ) {
    throw new ForbiddenException('个人选版已停用，正式执行统一跟随企业启用版本');
  }

  /** 正式执行统一跟随企业启用版本，历史个人选择和工作副本仅供审计。 */
  async resolveEffectiveVersion(subscriptionId: string, capabilityId: string, _userId?: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        enterpriseId: true,
        employee: { select: { bindings: {
          where: { capabilityId, enabled: true, capability: { status: 'APPROVED' } }, select: { defaultSkillVersion: true }, take: 1,
        } } },
      },
    });
    if (!subscription) return null;
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
      select: { status: true },
    });
    if (!capability || capability.status !== 'APPROVED') return null;
    const approved = (version: { capabilityId: string; scope: string; status: string; enterpriseId?: string | null } | null | undefined) =>
      version?.capabilityId === capabilityId && (
        (version.scope === 'PLATFORM' && version.status === 'PLATFORM_APPROVED') ||
        (version.scope === 'ENTERPRISE' && version.status === 'ENTERPRISE_APPROVED' && version.enterpriseId === subscription.enterpriseId)
      );
    const enterpriseDefault = await this.defaults.get(subscription.enterpriseId, capabilityId);
    if (approved(enterpriseDefault?.version)) return enterpriseDefault!.version;
    const selection = await this.prisma.subscriptionSkillVersion.findUnique({
      where: { subscriptionId_capabilityId: { subscriptionId, capabilityId } },
      include: { version: true },
    });
    if (approved(selection?.version)) return selection!.version;
    const defaultVersion = subscription.employee.bindings[0]?.defaultSkillVersion;
    if (approved(defaultVersion)) return defaultVersion!;
    return this.prisma.skillVersion.findFirst({
      where: { capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
      orderBy: PLATFORM_RELEASE_ORDER,
    });
  }

  async submitPlatformReview(_userId: string, _versionId: string) {
    throw new ForbiddenException('企业投稿平台已停用，版本由平台运营自主选审');
  }

  /** 平台谱系的当前头部：新平台版的父版本就挂在它下面。 */
  private async latestPlatformVersionId(capabilityId: string) {
    const latest = await this.prisma.skillVersion.findFirst({
      where: { capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
      orderBy: PLATFORM_RELEASE_ORDER,
      select: { id: true },
    });
    return latest?.id ?? null;
  }

  async listAdminVersions(filters: AdminSkillVersionQuery) {
    const and: Prisma.SkillVersionWhereInput[] = [{ capability: { type: 'SKILL' } }];
    if (filters.scope) and.push({ scope: filters.scope });
    if (filters.status) and.push({ status: filters.status });
    if (filters.createdFrom || filters.createdTo) and.push({ createdAt: {
      ...(filters.createdFrom ? { gte: new Date(filters.createdFrom) } : {}),
      ...(filters.createdTo ? { lte: new Date(filters.createdTo) } : {}),
    } });
    if (filters.generationType) {
      const workingCopy: Prisma.SkillVersionWhereInput = { scope: 'PERSONAL', workingCopyId: null, workingCopyUpdatedAt: null,
        OR: [{ status: 'PERSONAL_ACTIVE' }, { status: 'DRAFT', submittedAt: null }] };
      const generation: Record<NonNullable<AdminSkillVersionQuery['generationType']>, Prisma.SkillVersionWhereInput> = {
        CLIENT_SUBMISSION: { scope: 'PERSONAL', workingCopyId: null, NOT: workingCopy },
        LEGACY_WORKING_COPY: workingCopy,
        REVIEW_SNAPSHOT: { workingCopyId: { not: null } },
        ENTERPRISE_VERSION: { scope: 'ENTERPRISE', workingCopyId: null },
        PLATFORM_CREATED: { scope: 'PLATFORM', sourceVersionId: null },
        PLATFORM_SELECTED: { scope: 'PLATFORM', sourceVersionId: { not: null } },
      };
      and.push(generation[filters.generationType]);
    }
    for (const field of ['enterpriseId', 'ownerId', 'capabilityId'] as const) {
      const value = filters[field];
      if (value) and.push({ OR: [{ [field]: value }, { sourceVersion: { [field]: value } }] });
    }
    if (filters.enterpriseName) and.push({ OR: [
      { enterprise: { name: { contains: filters.enterpriseName, mode: 'insensitive' } } },
      { sourceVersion: { enterprise: { name: { contains: filters.enterpriseName, mode: 'insensitive' } } } },
    ] });
    if (filters.ownerName) and.push({ OR: [
      { owner: { name: { contains: filters.ownerName, mode: 'insensitive' } } },
      { createdBy: { name: { contains: filters.ownerName, mode: 'insensitive' } } },
      { sourceVersion: { owner: { name: { contains: filters.ownerName, mode: 'insensitive' } } } },
      { sourceVersion: { createdBy: { name: { contains: filters.ownerName, mode: 'insensitive' } } } },
      { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: filters.ownerName, mode: 'insensitive' } } } } } },
      { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: filters.ownerName, mode: 'insensitive' } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: filters.ownerName, mode: 'insensitive' } } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: filters.ownerName, mode: 'insensitive' } } } } } } },
    ] });
    if (filters.enterpriseStatus) and.push({ OR: [
      { scope: { in: ['PERSONAL', 'ENTERPRISE'] }, status: filters.enterpriseStatus },
      { scope: 'PLATFORM', sourceVersion: { status: filters.enterpriseStatus } },
    ] });
    const platformStatus = filters.platformStatus ?? (filters.platformProcessingStatus === 'NOT_SUBMITTED' ? 'NOT_SELECTED'
      : filters.platformProcessingStatus === 'PENDING_REVIEW' ? 'PENDING_PLATFORM_REVIEW'
      : filters.platformProcessingStatus === 'APPROVED' ? 'PLATFORM_APPROVED'
      : filters.platformProcessingStatus === 'REJECTED' ? 'PLATFORM_REJECTED' : undefined);
    if (platformStatus) {
      const processing = platformStatus === 'NOT_SELECTED' ? undefined : { status: platformStatus };
      and.push(processing ? { OR: [
        { scope: 'PLATFORM', ...processing },
        { promotedVersions: { some: processing } },
        { reviewSnapshots: { some: { promotedVersions: { some: processing } } } },
      ] } : { OR: [
        { scope: { not: 'PLATFORM' }, promotedVersions: { none: {} },
          reviewSnapshots: { none: { promotedVersions: { some: {} } } } },
        ...(filters.platformProcessingStatus === 'NOT_SUBMITTED' ? [{ scope: SkillVersionScope.PLATFORM,
          status: { in: [SkillVersionStatus.DRAFT, SkillVersionStatus.ARCHIVED] } }] : []),
      ] });
    }
    if (filters.search) and.push({ OR: [
      { capability: { name: { contains: filters.search, mode: 'insensitive' } } },
      { enterprise: { name: { contains: filters.search, mode: 'insensitive' } } },
      { owner: { name: { contains: filters.search, mode: 'insensitive' } } },
      { createdBy: { name: { contains: filters.search, mode: 'insensitive' } } },
      { sourceVersion: { enterprise: { name: { contains: filters.search, mode: 'insensitive' } } } },
      { sourceVersion: { owner: { name: { contains: filters.search, mode: 'insensitive' } } } },
      { sourceVersion: { createdBy: { name: { contains: filters.search, mode: 'insensitive' } } } },
      { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: filters.search, mode: 'insensitive' } } } } } },
      { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: filters.search, mode: 'insensitive' } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: filters.search, mode: 'insensitive' } } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: filters.search, mode: 'insensitive' } } } } } } },
    ] });
    const where: Prisma.SkillVersionWhereInput = { AND: and };
    return this.prisma.$transaction(async (tx) => {
      if (filters.enterpriseReviewStatus) {
        const status: Prisma.EnumSkillVersionStatusFilter = filters.enterpriseReviewStatus === 'NOT_SUBMITTED'
          ? { notIn: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] }
          : { equals: filters.enterpriseReviewStatus === 'PENDING' ? 'PENDING_ENTERPRISE_REVIEW'
            : filters.enterpriseReviewStatus === 'APPROVED' ? 'ENTERPRISE_APPROVED' : 'ENTERPRISE_REJECTED' };
        const normalized = await readAdminEnterpriseReviewStates(tx, { status: filters.enterpriseReviewStatus });
        const ids = normalized.map((row) => row.id);
        and.push({ OR: [
          { scope: { in: ['PERSONAL', 'ENTERPRISE'] }, status },
          { scope: 'PLATFORM', sourceVersion: { status } },
          { scope: 'PERSONAL', id: { in: ids } },
          { scope: 'PLATFORM', sourceVersionId: { in: ids } },
          ...(filters.enterpriseReviewStatus === 'NOT_SUBMITTED' ? [{ scope: SkillVersionScope.PLATFORM, sourceVersionId: null }] : []),
        ] });
      }
      const [total, items] = await Promise.all([
        tx.skillVersion.count({ where }),
        tx.skillVersion.findMany({
          where,
          select: {
            ...VERSION_SUMMARY_SELECT,
            owner: { select: { id: true, name: true } },
            createdBy: { select: { id: true, name: true } },
            capability: { select: { id: true, name: true, description: true, enterpriseId: true, visibility: true,
              platformReviewStatus: true, status: true,
              _count: { select: { bindings: { where: { enabled: true, employee: { status: 'APPROVED' } } } } },
            } },
            _count: { select: { enterpriseDefaults: true, defaultBindings: true } },
            enterprise: { select: { id: true, name: true } },
            sourceVersion: { select: { ...VERSION_SUMMARY_SELECT,
              owner: { select: { id: true, name: true } },
              createdBy: { select: { id: true, name: true } },
              enterprise: { select: { id: true, name: true } },
            } },
            promotedVersions: { select: VERSION_SUMMARY_SELECT },
            reviewSnapshots: { select: { ...VERSION_SUMMARY_SELECT,
              promotedVersions: { select: VERSION_SUMMARY_SELECT },
            }, where: { promotedVersions: { some: {} } }, take: 1,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (filters.page - 1) * filters.limit,
          take: filters.limit,
        }),
      ]);
      const reviewStates = await readAdminEnterpriseReviewStates(tx, { ids: [...new Set(items.flatMap((item) =>
        item.scope === 'PLATFORM' ? item.sourceVersion ? [item.sourceVersion.id] : [] : [item.id]))] });
      const reviewStateById = new Map(reviewStates.map((row) => [row.id, row]));
      const latest = items.length ? await tx.skillVersion.findMany({ where: {
        capabilityId: { in: [...new Set(items.map((item) => item.capabilityId))] }, scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
      }, select: { id: true, capabilityId: true }, distinct: ['capabilityId'],
        orderBy: [{ capabilityId: 'asc' as const }, ...PLATFORM_RELEASE_ORDER] }) : [];
      const latestIds = new Set(latest.map((row) => row.id));
      const lineages = await readAdminVersionLineages(tx, items.map((item) => item.id));
      return { total, page: filters.page, limit: filters.limit, items: items.map((item) => {
        const state = reviewStateById.get(item.scope === 'PLATFORM' ? item.sourceVersionId ?? '' : item.id);
        return ({
        ...item,
        ...lineages.get(item.id)!,
        isWorkingCopy: isPlatformWorkingCopy(item),
        ...platformMonitorClassifications(item, state?.enterpriseReviewStatus),
        ...(state ? { enterpriseReviewedAt: state.enterpriseReviewedAt,
          ...(item.scope !== 'PLATFORM' ? { rejectionReason: state.rejectionReason } : {}),
          ...(item.sourceVersion ? { sourceVersion: { ...item.sourceVersion, ...state, id: item.sourceVersion.id } } : {}),
        } : {}),
        isEnterpriseCurrent: item._count.enterpriseDefaults > 0,
        enterpriseDefaultCount: item._count.enterpriseDefaults,
        isPlatformLatest: latestIds.has(item.id),
        defaultBindingCount: item._count.defaultBindings,
        marketBindingCount: item.capability._count.bindings,
        isMarketPublic: item.capability.visibility === 'MARKET_PUBLIC' && item.capability.platformReviewStatus === 'APPROVED' && item.capability.status === 'APPROVED',
        enterprise: item.enterprise ?? item.sourceVersion?.enterprise ?? null,
        owner: item.owner ?? item.sourceVersion?.owner ?? null,
      }); }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async getAdminVersion(versionId: string) {
    const version = await this.prisma.skillVersion.findUnique({
      where: { id: versionId },
      select: {
        ...VERSION_SUMMARY_SELECT, content: true, validationResult: true, validatedAt: true,
        packageKey: true, packageSha256: true, packageFileCount: true, packageFilename: true,
        owner: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        capability: { select: { id: true, name: true, description: true, type: true, enterpriseId: true, visibility: true,
          platformReviewStatus: true, status: true,
          _count: { select: { bindings: { where: { enabled: true, employee: { status: 'APPROVED' } } } } },
        } },
        _count: { select: { enterpriseDefaults: true, defaultBindings: true } },
        enterprise: { select: { id: true, name: true } },
        parentVersion: { select: VERSION_SUMMARY_SELECT },
        sourceVersion: { select: { ...VERSION_SUMMARY_SELECT,
          owner: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } },
          enterprise: { select: { id: true, name: true } },
          workingCopy: { select: VERSION_SUMMARY_SELECT },
        } },
        promotedVersions: { select: VERSION_SUMMARY_SELECT },
        reviewSnapshots: { select: { ...VERSION_SUMMARY_SELECT, promotedVersions: { select: VERSION_SUMMARY_SELECT } },
          where: { promotedVersions: { some: {} } }, take: 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
        reviews: { select: { id: true, actorType: true, decision: true, comment: true, createdAt: true,
          reviewer: { select: { id: true, name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      },
    });
    if (!version || version.capability.type !== 'SKILL') throw new NotFoundException('技能版本不存在');
    const [state] = await readAdminEnterpriseReviewStates(this.prisma, {
      ids: version.scope === 'PLATFORM' ? version.sourceVersionId ? [version.sourceVersionId] : [] : [version.id],
    });
    const latest = await this.prisma.skillVersion.findFirst({ where: { capabilityId: version.capabilityId,
      scope: 'PLATFORM', status: 'PLATFORM_APPROVED' }, select: { id: true }, orderBy: PLATFORM_RELEASE_ORDER });
    let platformCapabilityId = version.capabilityId;
    if (version.scope !== 'PLATFORM' && version.capability.visibility !== 'MARKET_PUBLIC') {
      const mapping = await this.prisma.skillVersion.findFirst({ where: {
        scope: 'PLATFORM', sourceVersion: { capabilityId: version.capabilityId },
        capabilityId: { not: version.capabilityId }, capability: { enterpriseId: null, type: 'SKILL' },
      }, select: { capabilityId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      platformCapabilityId = mapping?.capabilityId ?? '';
    }
    const currentPlatformVersion = platformCapabilityId ? await this.prisma.skillVersion.findFirst({
      where: { capabilityId: platformCapabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
      select: { id: true, capabilityId: true, version: true, content: true, updatedAt: true }, orderBy: PLATFORM_RELEASE_ORDER,
    }) : null;
    const lineages = await readAdminVersionLineages(this.prisma, [version.id]);
    return { ...version, currentPlatformVersion, ...lineages.get(version.id)!, isWorkingCopy: isPlatformWorkingCopy(version), ...platformMonitorClassifications(version, state?.enterpriseReviewStatus),
      ...(state ? { enterpriseReviewedAt: state.enterpriseReviewedAt,
        ...(version.scope !== 'PLATFORM' ? { rejectionReason: state.rejectionReason } : {}),
        ...(version.sourceVersion ? { sourceVersion: { ...version.sourceVersion, ...state, id: version.sourceVersion.id } } : {}),
      } : {}),
      isEnterpriseCurrent: version._count.enterpriseDefaults > 0, enterpriseDefaultCount: version._count.enterpriseDefaults,
      isPlatformLatest: latest?.id === version.id, defaultBindingCount: version._count.defaultBindings,
      marketBindingCount: version.capability._count.bindings,
      isMarketPublic: version.capability.visibility === 'MARKET_PUBLIC' && version.capability.platformReviewStatus === 'APPROVED' && version.capability.status === 'APPROVED',
      enterprise: version.enterprise ?? version.sourceVersion?.enterprise ?? null,
      owner: version.owner ?? version.sourceVersion?.owner ?? null };
  }

  async createPlatformVersion(userId: string, capabilityId: string, dto: CreatePlatformSkillVersionDto,
    guard?: { expectedTemplateSha256: string }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${capabilityId} FOR UPDATE`;
      const capability = await tx.capability.findUnique({ where: { id: capabilityId } });
      if (!capability) throw new NotFoundException('技能不存在');
      if (capability.type !== 'SKILL') throw new BadRequestException('只有 SKILL 支持版本');
      if (capability.enterpriseId) throw new BadRequestException('私有企业技能须选择来源并复制为平台技能');
      if (guard) {
        const config = await tx.skillConfig.findUnique({ where: { capabilityId }, select: { template: true } });
        if (!config || createHash('sha256').update(config.template).digest('hex') !== guard.expectedTemplateSha256) {
          throw new ConflictException('历史模板已变化，请重新审阅后补版');
        }
      }
      if (await tx.skillVersion.count({ where: { capabilityId } })) {
        throw new ConflictException('仅允许首次创建技能正文，已有技能须选择客户端来源版本');
      }
      const validation = await validatePlatformSource({ content: dto.content,
        packageKey: null, packageSha256: null, packageFileCount: null, packageFilename: null },
      this.platformValidator, this.platformSecurity, this.platformPackages);
      const now = new Date();
      return tx.skillVersion.create({ data: {
        capabilityId, scope: 'PLATFORM', version: '1.0.0', content: dto.content,
        changeSummary: dto.changeSummary, createdById: userId,
        status: 'PENDING_PLATFORM_REVIEW', submittedAt: now,
        validationResult: validation as unknown as Prisma.InputJsonValue, validatedAt: now,
      }, select: { ...VERSION_SUMMARY_SELECT, content: true } });
    });
  }

  /** 维护修订只创建待审副本，正式发布仍须调用 publishPlatformVersion。 */
  async createPlatformRevision(userId: string, capabilityId: string, dto: {
    content: string;
    changeSummary: string;
    expectedPlatformVersionId: string;
    expectedContentSha256: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const actor = await tx.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
      if (!actor || actor.role !== 'ADMIN' || actor.status !== 'ACTIVE') {
        throw new ForbiddenException('仅有效平台管理员可创建平台修订');
      }
      await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${capabilityId} FOR UPDATE`;
      const capability = await tx.capability.findUnique({ where: { id: capabilityId } });
      if (!capability) throw new NotFoundException('技能不存在');
      if (capability.type !== 'SKILL' || capability.enterpriseId !== null || capability.status !== 'APPROVED') {
        throw new BadRequestException('仅已批准的平台 SKILL 可创建修订');
      }
      const head = await tx.skillVersion.findFirst({ where: {
        capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
      }, select: { id: true, content: true, packageKey: true, packageSha256: true,
        packageFileCount: true, packageFilename: true }, orderBy: PLATFORM_RELEASE_ORDER });
      if (!head || head.id !== dto.expectedPlatformVersionId ||
          createHash('sha256').update(head.content).digest('hex') !== dto.expectedContentSha256) {
        throw new ConflictException('当前平台版本或正文已变化，请重新审阅后修订');
      }
      if (head.packageKey !== null || head.packageSha256 !== null ||
          head.packageFileCount !== null || head.packageFilename !== null) {
        throw new BadRequestException('仅单文件平台技能可创建维护修订，不能丢弃原技能包');
      }
      const packageFields = { packageKey: null, packageSha256: null, packageFileCount: null, packageFilename: null };
      const validation = await validatePlatformSource({ content: dto.content, ...packageFields },
        this.platformValidator, this.platformSecurity, this.platformPackages);
      // 幂等只认当前 head 的同内容待审子版本，不能复用已发布版本或旧 head 的修订。
      const existing = await tx.skillVersion.findFirst({ where: {
        capabilityId, scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW', enterpriseId: null,
        sourceVersionId: null, parentVersionId: head.id, content: dto.content,
        changeSummary: dto.changeSummary, ...packageFields,
      }, select: { ...VERSION_SUMMARY_SELECT, content: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (existing) return existing;
      const siblings = await tx.skillVersion.findMany({ where: { capabilityId, scope: 'PLATFORM' }, select: { version: true } });
      const now = new Date();
      return tx.skillVersion.create({ data: {
        capabilityId, scope: 'PLATFORM', enterpriseId: null, parentVersionId: head.id,
        version: nextSemver(siblings.map((row) => row.version)), content: dto.content,
        changeSummary: dto.changeSummary, createdById: userId,
        status: 'PENDING_PLATFORM_REVIEW', submittedAt: now, ...packageFields,
        validationResult: validation as unknown as Prisma.InputJsonValue, validatedAt: now,
      }, select: { ...VERSION_SUMMARY_SELECT, content: true } });
    }, { timeout: 30_000 });
  }

  async submitAdminPlatformReview(versionId: string, dto: SubmitAdminPlatformReviewDto = {}) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM skill_versions WHERE id = ${versionId} FOR UPDATE`;
      const version = await tx.skillVersion.findFirst({ where: { id: versionId, scope: 'PLATFORM' } });
      if (!version) throw new NotFoundException('技能版本不存在');
      if (dto.expectedUpdatedAt && new Date(dto.expectedUpdatedAt).getTime() !== version.updatedAt.getTime()) {
        throw new ConflictException('版本已更新，请重新预览后送审');
      }
      if (version.status !== 'DRAFT' && version.status !== 'PLATFORM_REJECTED') {
        throw new ConflictException('当前状态不能提交平台审核');
      }
      const validation = await validatePlatformSource(version, this.platformValidator, this.platformSecurity, this.platformPackages);
      return tx.skillVersion.update({ where: { id: version.id }, data: {
        status: 'PENDING_PLATFORM_REVIEW', submittedAt: new Date(), rejectionReason: null,
        validationResult: validation as unknown as Prisma.InputJsonValue, validatedAt: new Date(),
      }, select: VERSION_SUMMARY_SELECT });
    });
  }

  async reviewPlatformVersion(userId: string, versionId: string, dto: ReviewSkillVersionDto) {
    if (dto.decision === 'REJECT' && !dto.comment?.trim()) throw new BadRequestException('驳回时必须填写原因');
    return this.prisma.$transaction(async (tx) => {
      // 与来源采纳相同锁顺序：Capability -> SkillVersion，避免审核／采纳死锁。
      const ref = await tx.skillVersion.findUnique({ where: { id: versionId }, select: { capabilityId: true } });
      if (!ref) throw new NotFoundException('技能版本不存在');
      await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${ref.capabilityId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM skill_versions WHERE id = ${versionId} FOR UPDATE`;
      const version = await tx.skillVersion.findFirst({ where: { id: versionId, scope: 'PLATFORM' }, include: {
        capability: true, sourceVersion: { select: { capability: { select: { id: true, contributorId: true, enterpriseId: true } } } },
      } });
      if (!version) throw new NotFoundException('技能版本不存在');
      if (version.status !== 'PENDING_PLATFORM_REVIEW') throw new ConflictException('只有待平台审核版本可以审核');
      if (dto.expectedUpdatedAt && new Date(dto.expectedUpdatedAt).getTime() !== version.updatedAt.getTime()) {
        throw new ConflictException('版本已更新，请重新预览后审核');
      }
      if (version.capability.type !== 'SKILL') throw new BadRequestException('只有 SKILL 支持版本');
      const approved = dto.decision === 'APPROVE';
      if (approved && version.capability.enterpriseId && version.capability.visibility !== 'MARKET_PUBLIC') {
        throw new ConflictException('历史私有能力平台副本须重新选择来源，复制为独立平台技能');
      }
      const validation = approved ? await validatePlatformSource(version, this.platformValidator, this.platformSecurity, this.platformPackages) : null;
      const now = new Date();
      const updated = await tx.skillVersion.update({ where: { id: version.id }, data: {
        status: approved ? 'PLATFORM_APPROVED' : 'PLATFORM_REJECTED',
        platformReviewedById: userId, platformReviewedAt: now, rejectionReason: approved ? null : dto.comment,
        ...(validation ? { validationResult: validation as unknown as Prisma.InputJsonValue, validatedAt: now } : {}),
      }, select: VERSION_SUMMARY_SELECT });
      await tx.skillVersionReview.create({ data: { versionId: version.id, actorType: 'PLATFORM',
        decision: dto.decision, reviewerId: userId, comment: dto.comment } });
      if (approved) {
        await this.applyPlatformRelease(tx, version, userId, now);
      } else if (version.capability.visibility !== 'MARKET_PUBLIC') {
        await tx.capability.update({ where: { id: version.capabilityId }, data: {
          platformReviewStatus: 'REJECTED', platformRejectionReason: dto.comment,
        } });
      }
      return updated;
    });
  }

  async publishPlatformVersion(userId: string, versionId: string, dto: PublishPlatformSkillVersionDto) {
    return this.prisma.$transaction(async (tx) => {
      const ref = await tx.skillVersion.findUnique({ where: { id: versionId }, select: { capabilityId: true } });
      if (!ref) throw new NotFoundException('来源技能版本不存在');
      await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${ref.capabilityId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM skill_versions WHERE id = ${versionId} FOR UPDATE`;
      const source = await tx.skillVersion.findUnique({ where: { id: versionId }, include: { capability: true } });
      if (!source || source.capability.type !== 'SKILL') throw new NotFoundException('来源技能版本不存在');
      if (source.scope === 'PLATFORM' && source.status === 'PLATFORM_APPROVED') return tx.skillVersion.findUniqueOrThrow({
        where: { id: source.id }, select: { ...VERSION_SUMMARY_SELECT, content: true },
      });
      const expectedTime = new Date(dto.expectedUpdatedAt).getTime();
      if (!Number.isFinite(expectedTime) || expectedTime !== source.updatedAt.getTime()) {
        throw new ConflictException('来源已更新，请重新预览后发布');
      }
      if (source.scope === 'PLATFORM' && source.status === 'ARCHIVED') throw new BadRequestException('归档平台版本不可直接发布');
      const selected = source.scope === 'PLATFORM' ? source : await this.selectPlatformSourceInTx(tx, userId, versionId, {
        mode: 'DRAFT', expectedUpdatedAt: dto.expectedUpdatedAt, changeSummary: dto.changeSummary,
      });
      if (selected.capabilityId !== source.capabilityId) {
        await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${selected.capabilityId} FOR UPDATE`;
      }
      if (selected.id !== source.id) await tx.$queryRaw`SELECT id FROM skill_versions WHERE id = ${selected.id} FOR UPDATE`;
      const version = await tx.skillVersion.findFirst({ where: { id: selected.id, scope: 'PLATFORM' }, include: {
        capability: true, sourceVersion: { select: { capability: { select: { id: true, contributorId: true, enterpriseId: true } } } },
      } });
      if (!version) throw new NotFoundException('平台技能版本不存在');
      // An idempotent retry must not reapply an older release over the current head.
      if (version.status === 'PLATFORM_APPROVED') return tx.skillVersion.findUniqueOrThrow({
        where: { id: version.id }, select: { ...VERSION_SUMMARY_SELECT, content: true },
      });
      if (!['DRAFT', 'PENDING_PLATFORM_REVIEW', 'PLATFORM_REJECTED'].includes(version.status)) {
        throw new BadRequestException('当前平台版本不可发布');
      }
      if (version.capability.enterpriseId && version.capability.visibility !== 'MARKET_PUBLIC') {
        throw new ConflictException('历史私有平台副本须重新选择个人或企业来源，复制为独立平台技能');
      }
      const head = await tx.skillVersion.findFirst({ where: {
        capabilityId: version.capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
      }, select: { id: true }, orderBy: PLATFORM_RELEASE_ORDER });
      if ((head?.id ?? null) !== dto.expectedPlatformVersionId) {
        throw new ConflictException('当前平台版本已变化，请重新预览后发布');
      }
      const validation = await validatePlatformSource(version, this.platformValidator, this.platformSecurity, this.platformPackages);
      const siblings = await tx.skillVersion.findMany({ where: {
        capabilityId: version.capabilityId, scope: 'PLATFORM', id: { not: version.id },
      }, select: { version: true } });
      const now = new Date();
      const updated = await tx.skillVersion.update({ where: { id: version.id }, data: {
        status: 'PLATFORM_APPROVED', version: nextSemver(siblings.map((row) => row.version)), parentVersionId: head?.id ?? null,
        platformReviewedById: userId, platformReviewedAt: now, rejectionReason: null,
        validationResult: validation as unknown as Prisma.InputJsonValue, validatedAt: now,
        ...(dto.changeSummary?.trim() ? { changeSummary: dto.changeSummary.trim() } : {}),
      }, select: { ...VERSION_SUMMARY_SELECT, content: true } });
      await tx.skillVersionReview.create({ data: { versionId: version.id, actorType: 'PLATFORM', decision: 'APPROVE',
        reviewerId: userId, comment: dto.changeSummary?.trim() || '预览确认后发布为平台版本' } });
      await this.applyPlatformRelease(tx, version, userId, now);
      return updated;
    }, { timeout: 30_000 });
  }

  /** 旧接口兼容：选择来源只复制待审版本，不修改企业启用。 */
  async adoptEnterpriseVersion(userId: string, versionId: string, dto: AdoptEnterpriseVersionDto) {
    if (dto.mode && dto.mode !== 'DRAFT') throw new BadRequestException('选定来源必须经过平台审核，不能直接发布');
    return this.prisma.$transaction((tx) => this.selectPlatformSourceInTx(tx, userId, versionId, dto));
  }

  private async selectPlatformSourceInTx(tx: Prisma.TransactionClient, userId: string, versionId: string, dto: AdoptEnterpriseVersionDto) {
      const ref = await tx.skillVersion.findUnique({ where: { id: versionId }, select: { capabilityId: true } });
      if (!ref) throw new NotFoundException('来源技能版本不存在');
      // 源能力行锁串行化同技能首次映射，无需额外 schema 或独立映射表。
      await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${ref.capabilityId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM skill_versions WHERE id = ${versionId} FOR UPDATE`;
      const source = await tx.skillVersion.findUnique({ where: { id: versionId },
        include: { enterprise: true, capability: { include: { skillConfig: true } } } });
      if (!source || source.capability.type !== 'SKILL') throw new NotFoundException('来源技能版本不存在');
      if (source.scope === 'PLATFORM') throw new BadRequestException('平台版本请直接使用平台审核流程');
      if (dto.expectedUpdatedAt && new Date(dto.expectedUpdatedAt).getTime() !== source.updatedAt.getTime()) {
        throw new ConflictException('来源已更新，请重新预览后选择');
      }
      const privateSource = source.capability.visibility !== 'MARKET_PUBLIC';
      let selected = source;
      const isWorkingCopy = isPlatformWorkingCopy(source);
      let freezeSource = isWorkingCopy;
      // 旧版私有投稿占用 sourceVersionId：保留旧行及其绑定，新增独立来源快照。
      // 不移动原平台行，否则原企业的历史默认引用会跨到另一 Capability。
      if (!isWorkingCopy) {
        const existing = await tx.skillVersion.findUnique({ where: { sourceVersionId: source.id }, select: { ...VERSION_SUMMARY_SELECT, content: true } });
        if (existing) {
          if (!privateSource || existing.capabilityId !== source.capabilityId) return existing;
          freezeSource = true;
        }
      }
      if (freezeSource) {
        const snapshot = await tx.skillVersion.findFirst({ where: {
          workingCopyId: source.id, workingCopyUpdatedAt: source.updatedAt,
          promotedVersions: { some: {} },
        }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
        if (snapshot) {
          const existing = await tx.skillVersion.findUnique({ where: { sourceVersionId: snapshot.id }, select: { ...VERSION_SUMMARY_SELECT, content: true } });
          if (existing && (!privateSource || existing.capabilityId !== source.capabilityId)) return existing;
        }
      }
      const validation = await validatePlatformSource(source, this.platformValidator, this.platformSecurity, this.platformPackages);
      const now = new Date();
      if (freezeSource) {
        // 平台快照保持原企业审核信息，不伪造企业审核状态。
        const snapshot = await tx.skillVersion.create({ data: {
          capabilityId: source.capabilityId, scope: source.scope, enterpriseId: source.enterpriseId,
          ownerId: source.ownerId, createdById: source.createdById, version: source.version,
          content: source.content, changeSummary: source.changeSummary, parentVersionId: source.parentVersionId,
          workingCopyId: source.id, workingCopyUpdatedAt: source.updatedAt, status: source.status,
          enterpriseReviewedById: source.enterpriseReviewedById, enterpriseReviewedAt: source.enterpriseReviewedAt,
          rejectionReason: source.rejectionReason,
          packageKey: source.packageKey, packageSha256: source.packageSha256,
          packageFileCount: source.packageFileCount, packageFilename: source.packageFilename,
        } });
        selected = { ...source, ...snapshot };
      }
      let platformCapabilityId = source.capabilityId;
      if (privateSource) {
        const mapped = await tx.skillVersion.findFirst({ where: {
          scope: 'PLATFORM', sourceVersion: { capabilityId: source.capabilityId },
          capabilityId: { not: source.capabilityId }, capability: { enterpriseId: null, type: 'SKILL' },
        }, select: { capabilityId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        if (mapped) platformCapabilityId = mapped.capabilityId;
        else {
          const capability = await tx.capability.create({ data: {
            name: source.capability.name, description: source.capability.description, type: 'SKILL',
            industry: source.capability.industry, position: source.capability.position,
            inputSchema: source.capability.inputSchema as Prisma.InputJsonValue,
            outputSchema: source.capability.outputSchema as Prisma.InputJsonValue,
            contributorId: source.capability.contributorId, enterpriseId: null,
            visibility: 'ENTERPRISE_PRIVATE', status: 'PENDING', platformReviewStatus: 'PENDING_REVIEW',
            platformSubmittedById: userId, platformSubmittedAt: now,
            skillConfig: { create: { template: selected.content,
              ...(source.capability.skillConfig ? {
                modelId: source.capability.skillConfig.modelId, temperature: source.capability.skillConfig.temperature,
                maxTokens: source.capability.skillConfig.maxTokens,
              } : {}),
            } },
            // 不复制企业 metadata，避免内部扩展配置进入市场。
          }, select: { id: true } });
          platformCapabilityId = capability.id;
        }
      }
      if (platformCapabilityId !== source.capabilityId) {
        await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${platformCapabilityId} FOR UPDATE`;
      }
      const siblings = await tx.skillVersion.findMany({ where: { capabilityId: platformCapabilityId, scope: 'PLATFORM' }, select: { version: true } });
      const parent = await tx.skillVersion.findFirst({ where: { capabilityId: platformCapabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
        select: { id: true }, orderBy: PLATFORM_RELEASE_ORDER });
      const created = await tx.skillVersion.create({ data: {
        ...buildPlatformPromotion({ source: selected, platformCapabilityId,
          version: nextSemver(siblings.map((row) => row.version)), platformParentId: parent?.id ?? null,
          status: 'PENDING_PLATFORM_REVIEW', actorId: userId, now,
          changeSummary: platformPromotionSummary({ enterpriseName: source.enterprise?.name ?? null,
            sourceVersion: source.version, sourceSummary: source.changeSummary, override: dto.changeSummary }),
        }), validationResult: validation as unknown as Prisma.InputJsonValue, validatedAt: now,
      }, select: { ...VERSION_SUMMARY_SELECT, content: true } });
      return created;
  }

  private async applyPlatformRelease(tx: Prisma.TransactionClient, version: PlatformRelease, userId: string, now: Date) {
    await tx.capability.update({ where: { id: version.capabilityId }, data: {
      status: 'APPROVED', visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED',
      platformRejectionReason: null, approvedAt: now,
    } });
    await tx.skillConfig.upsert({ where: { capabilityId: version.capabilityId },
      create: { capabilityId: version.capabilityId, template: version.content }, update: { template: version.content } });
    await this.advancePlatformBindingDefaults(tx, version.capabilityId, version.id);
    if (await this.platformSettings?.getEffectiveValue('CONTRIBUTION_REWARDS_ENABLED') !== 'true') return;
    // Independent platform copies retain the original capability's reward identity.
    let origin = version.sourceVersion?.capability ?? version.capability;
    if (origin.id === version.capabilityId) {
      const mapping = await tx.skillVersion.findFirst({ where: { capabilityId: version.capabilityId, scope: 'PLATFORM',
        sourceVersion: { capabilityId: { not: version.capabilityId } } },
        select: { sourceVersion: { select: { capability: { select: { id: true, contributorId: true, enterpriseId: true } } } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      origin = mapping?.sourceVersion?.capability ?? origin;
    }
    const configured = Number(await this.platformSettings?.getEffectiveValue('CONTRIBUTION_PLATFORM_REWARD_CNY') ?? '50');
    const amount = new Prisma.Decimal(Number.isFinite(configured) && configured > 0 ? configured : 50);
    const dedupeKey = `platform-approved:${origin.id}`;
    await assertActiveRewardRecipientInTx(tx, origin.contributorId);
    const reward = await tx.contributionRewardEvent.createMany({ data: [{
      recipientId: origin.contributorId, enterpriseId: origin.enterpriseId, capabilityId: origin.id,
      versionId: version.id, eventType: 'PLATFORM_APPROVED', points: 50, amount,
      status: 'AVAILABLE', settledAt: now, dedupeKey,
      metadata: { reviewerId: userId, amountCNY: amount.toString(), platformCapabilityId: version.capabilityId },
    }], skipDuplicates: true });
    if (reward.count === 1) await this.platformWallet.creditContributionRewardInTx(
      tx, origin.contributorId, amount, dedupeKey, `平台审核通过奖励 ¥${amount.toFixed(2)}`,
    );
  }

  /**
   * 把员工模板里钉在旧平台版上的 `defaultSkillVersionId` 推到新平台版。
   *
   * 少了这一步，「发布为平台版」是个看不出效果的空动作：
   * `resolveEffectiveVersion` 里绑定默认版排在「最新平台版」之前，而实测 72 条
   * SKILL 绑定有 63 条钉着具体版本 —— 不推的话新版本只对那 9 条没钉的生效。
   *
   * 只动指向 PLATFORM 版本的绑定：
   *   - `null` 的不动 —— 它本来就自动跟随最新平台版，钉上去反而收紧了语义；
   *   - 企业自己的选版存在 `SubscriptionSkillVersion`，不在这张表里，天然不受影响。
   */
  private async advancePlatformBindingDefaults(
    tx: Prisma.TransactionClient,
    capabilityId: string,
    versionId: string,
  ) {
    const { count } = await tx.employeeCapabilityBinding.updateMany({
      where: {
        capabilityId,
        defaultSkillVersion: { scope: 'PLATFORM' },
        NOT: { defaultSkillVersionId: versionId },
      },
      data: { defaultSkillVersionId: versionId },
    });
    return count;
  }


  // 历史 Web 工作副本只读；客户端提交仍由统一企业审核服务处理。

  async createPersonalVersion(_userId: string, _capabilityId: string) {
    throw new ForbiddenException('Web 技能正文修改已停用，请通过客户端修改并提交审核');
  }

  async updatePersonalVersion(
    _userId: string,
    _versionId: string,
    _dto: UpdateSkillVersionDto,
  ) {
    throw new ForbiddenException('Web 技能正文修改已停用，请通过客户端修改并提交审核');
  }

  async discardPersonalVersion(_userId: string, _versionId: string) {
    throw new ForbiddenException('Web 技能正文修改已停用，请通过客户端修改并提交审核');
  }

  /**
   * 「大家的改动」：本企业内所有成员对这个能力的个人副本。
   *
   * 管理员看全部，普通成员只看自己 —— 会议要的是「管理员能看到每个人改了什么」，
   * 不是「所有人互相可见」。
   */
  async listPersonalDiffs(userId: string, capabilityId: string, page = 1, limit = 20, status?: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    await this.assertCapabilityReadable(ctx, capabilityId);
    const canManage = ctx.role === 'ENTERPRISE_ADMIN';

    const [effective, versions] = await Promise.all([
      this.readCapabilityEffectiveState(ctx, capabilityId),
      this.prisma.skillVersion.findMany({
        where: {
          capabilityId,
          scope: 'PERSONAL',
          status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
          workingCopyId: null,
          enterpriseId: ctx.enterpriseId,
          ...(canManage ? {} : { ownerId: userId }),
        },
        select: PERSONAL_DIFF_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const summaries = versions.map((version) => this.personalDiffItem(version));
    const publishedVersions = await this.readPublishedVersions(ctx.enterpriseId, capabilityId,
      summaries.map((row) => row.publishedVersionId));
    const statusRank = (row: typeof summaries[number]) => row.pending ? 0 : row.reviewStatus === 'ENTERPRISE_APPROVED' ? 1 : 2;
    const mapped = summaries.map((row) => ({ ...row,
      publishedVersion: this.publishedVersionMetadata(publishedVersions.get(row.publishedVersionId ?? ''), effective.version?.id),
    })).sort((a, b) => statusRank(a) - statusRank(b)
      || (b.submittedAt ?? b.updatedAt).getTime() - (a.submittedAt ?? a.updatedAt).getTime()
      || b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
    const pendingTotal = mapped.filter((row) => row.pending).length;
    const filtered = status ? mapped.filter((row) => status === 'PENDING_ENTERPRISE_REVIEW'
      ? row.pending : row.reviewStatus === status) : mapped;
    const pageItems = filtered.slice((page - 1) * limit, page * limit);
    const myWorkingCopy = mapped.find((row) => row.canEdit) ?? null;
    const ids = [...new Set([...pageItems.map((row) => row.id), ...(myWorkingCopy ? [myWorkingCopy.id] : [])])];
    const bodies = ids.length ? await this.prisma.skillVersion.findMany({
      where: { id: { in: ids }, enterpriseId: ctx.enterpriseId, capabilityId, scope: 'PERSONAL',
        ...(canManage ? {} : { ownerId: userId }) }, select: { id: true, content: true, updatedAt: true },
    }) : [];
    const bodyMap = new Map(bodies.map((row) => [row.id, row]));
    // Keep the body and revision paired if a save happened between the summary and body queries.
    const withBody = (row: typeof mapped[number]) => {
      const body = bodyMap.get(row.id);
      return body && body.updatedAt.getTime() === row.updatedAt.getTime() ? { ...row, content: body.content } : null;
    };
    return {
      canManage,
      baseline: effective.version
        ? { id: effective.version.id, scope: effective.version.scope, version: effective.version.version, content: effective.version.content }
        : null,
      myWorkingCopy: myWorkingCopy ? withBody(myWorkingCopy) : null,
      total: filtered.length, pendingTotal, page, limit,
      items: pageItems.flatMap((row) => { const item = withBody(row); return item ? [item] : []; }),
    };
  }

  private personalDiffItem(version: PersonalDiffSource) {
    const state = personalReviewState(version);
    return {
      id: version.id, owner: version.owner, basedOn: version.parentVersion,
      changeSummary: version.changeSummary, updatedAt: version.updatedAt,
      status: version.status, submittedAt: version.submittedAt, ...state,
      canEdit: false, adopted: Boolean(state.publishedVersionId), adoptedAt: state.enterpriseReviewedAt,
    };
  }

  private async readPublishedVersions(enterpriseId: string, capabilityId: string, ids: Array<string | null>) {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const versions = uniqueIds.length ? await this.prisma.skillVersion.findMany({ where: {
      id: { in: uniqueIds }, capabilityId, enterpriseId, scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED',
    }, select: { id: true, scope: true, version: true } }) : [];
    return new Map(versions.map((version) => [version.id, version]));
  }

  private publishedVersionMetadata(
    version: { id: string; scope: SkillVersionScope; version: string } | undefined, currentId?: string,
  ) {
    return version ? { id: version.id, scope: version.scope, version: version.version, isCurrent: version.id === currentId } : null;
  }

  async getSubmissionDetail(userId: string, capabilityId: string, id: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    await this.assertCapabilityReadable(ctx, capabilityId);
    const canManage = ctx.role === 'ENTERPRISE_ADMIN';
    const snapshotWhere: Prisma.SkillVersionWhereInput = {
      capabilityId, enterpriseId: ctx.enterpriseId, scope: 'PERSONAL',
      ...(canManage ? {} : { ownerId: userId }),
      status: { in: ['ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
    };
    const submission = await this.prisma.skillVersion.findFirst({ where: {
      id, capabilityId, enterpriseId: ctx.enterpriseId, scope: 'PERSONAL', workingCopyId: null,
      status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
      ...(canManage ? {} : { ownerId: userId }),
    }, select: {
      ...PERSONAL_DIFF_SELECT, content: true,
      reviews: { where: { actorType: 'ENTERPRISE' }, select: ENTERPRISE_REVIEW_SELECT },
      reviewSnapshots: {
        where: snapshotWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { ...PERSONAL_DIFF_SELECT,
          reviews: { where: { actorType: 'ENTERPRISE' }, select: ENTERPRISE_REVIEW_SELECT },
        },
      },
    } });
    if (!submission) throw new NotFoundException('提交不存在');

    // Only enterprise review snapshots participate in the root state or history.
    const snapshots = submission.reviewSnapshots.filter((snapshot) => snapshot.workingCopyId === submission.id
      && snapshot.enterpriseId === ctx.enterpriseId && snapshot.capabilityId === capabilityId
      && snapshot.scope === 'PERSONAL' && snapshot.ownerId === submission.ownerId
      && (snapshot.status === 'ENTERPRISE_APPROVED' || snapshot.status === 'ENTERPRISE_REJECTED'));
    const item = this.personalDiffItem({ ...submission, reviewSnapshots: snapshots });
    const [source, effective, publishedVersions] = await Promise.all([
      submission.parentVersionId ? this.prisma.skillVersion.findFirst({ where: {
        id: submission.parentVersionId, capabilityId, OR: [
          { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
          { scope: 'ENTERPRISE', enterpriseId: ctx.enterpriseId, status: 'ENTERPRISE_APPROVED' },
          { scope: 'PERSONAL', enterpriseId: ctx.enterpriseId, ...(canManage ? {} : { ownerId: userId }) },
        ],
      }, select: { id: true, scope: true, version: true, content: true } }) : null,
      this.readCapabilityEffectiveState(ctx, capabilityId),
      this.readPublishedVersions(ctx.enterpriseId, capabilityId, [item.publishedVersionId,
        ...[submission, ...snapshots].flatMap((version) => version.adoptedInto.map((adoption) => adoption.targetVersionId))]),
    ]);
    const reviews = [submission, ...snapshots].flatMap((version) => version.reviews
      .filter((review) => review.actorType === 'ENTERPRISE' && review.versionId === version.id)
      .map((review) => ({ ...review, version: version.version, changeSummary: version.changeSummary,
        workingCopyUpdatedAt: version.workingCopyId ? version.workingCopyUpdatedAt : null,
        publishedVersion: review.decision === 'APPROVE'
          ? this.publishedVersionMetadata(publishedVersions.get(version.adoptedInto[0]?.targetVersionId ?? ''), effective.version?.id)
          : null,
      })))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return {
      canManage,
      item: { ...item, version: submission.version, content: submission.content,
        publishedVersion: this.publishedVersionMetadata(publishedVersions.get(item.publishedVersionId ?? ''), effective.version?.id) },
      source: source ? { id: source.id, scope: source.scope, version: source.version, content: source.content } : null,
      sourceState: submission.parentVersionId ? source ? 'AVAILABLE' : 'UNREADABLE' : 'NONE',
      currentBaseline: effective.version ? { id: effective.version.id, scope: effective.version.scope,
        version: effective.version.version, content: effective.version.content } : null,
      currentBaselineState: effective.state,
      reviews,
    };
  }

  /** 旧 Web 审核入口兼容层；状态转换、快照和发布均由统一审核服务完成。 */
  async adoptPersonalVersions(
    userId: string,
    capabilityId: string,
    dto: AdoptPersonalVersionsDto,
  ) {
    const expected = dto.expectedVersions ?? (dto.expectedUpdatedAt && dto.sourceVersionIds.length === 1
      ? { [dto.sourceVersionIds[0]]: dto.expectedUpdatedAt } : {});
    const result = await this.personalReviews.reviewMany(userId, dto.sourceVersionIds,
      { decision: 'APPROVE', comment: dto.changeSummary }, expected, capabilityId, dto.expectedMergedContent);
    return { ...result, adoptedCount: result.sources.length, conflicts: [] };
  }

  /**
   * 「XX 技能更新了能力」——会议纪要2 §6.6 要求采纳后推送给客户端。
   *
   * 通知发送失败不能让采纳回滚：版本已经生效了，回滚会让「我明明点了采纳」
   * 和实际状态不一致。所以放在事务外，失败只记日志。
   */
  private async notifySkillVersionUpdated(
    enterpriseId: string,
    capabilityId: string,
    version: string,
  ) {
    try {
      const [capability, members] = await Promise.all([
        this.prisma.capability.findUnique({
          where: { id: capabilityId },
          select: { name: true },
        }),
        this.prisma.enterpriseMember.findMany({
          where: { enterpriseId },
          select: { userId: true },
        }),
      ]);
      if (!capability || members.length === 0) return;
      await this.prisma.notification.createMany({
        data: members.map((member) => ({
          userId: member.userId,
          type: 'SKILL_VERSION_UPDATED' as const,
          category: 'SYSTEM',
          severity: 'INFO',
          title: `${capability.name} 更新了能力`,
          message: `企业技能已启用 ${version}，正式执行统一跟随企业启用版本。`,
          relatedType: 'capability',
          relatedId: capabilityId,
        })),
      });
    } catch (error) {
      this.logger.error(
        `企业默认更新通知发送失败 capability=${capabilityId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** 停用旧 Web/AI 正文生产入口，不影响客户端提交审核。 */
  async createEnterpriseVersionFromContent(
    _userId: string,
    _enterpriseId: string,
    _capabilityId: string,
    _content: string,
    _changeSummary: string,
  ) {
    throw new ForbiddenException('Web 技能正文修改已停用，请通过客户端修改并提交审核');
  }

  /** 停用管理员 Web 草稿直接发布；只可启用已通过版本。 */
  async publishEnterpriseVersion(_userId: string, _versionId: string) {
    throw new ForbiddenException('Web 技能正文修改已停用，请通过客户端修改并提交审核');
  }

  private async getGrantedSubscription(
    enterpriseId: string,
    memberId: string,
    departmentId: string | null,
    employeeId: string,
  ) {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        enterpriseId,
        employeeId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
        grants: { some: this.activeGrantWhere(memberId, departmentId) },
      },
      select: { id: true, employeeId: true, enterpriseId: true },
    });
    if (!subscription) throw new ForbiddenException('当前成员未获得该员工的使用授权');
    return subscription;
  }

  private async getActiveSubscriptionById(enterpriseId: string, subscriptionId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        enterpriseId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
      },
      select: { id: true, employeeId: true, enterpriseId: true },
    });
    if (!subscription) throw new NotFoundException('有效订阅不存在');
    return subscription;
  }

  private async assertCapabilityGrant(
    enterpriseId: string,
    memberId: string,
    departmentId: string | null,
    capabilityId: string,
  ) {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        enterpriseId,
        status: 'ACTIVE',
        employee: { bindings: { some: { capabilityId, enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
        grants: { some: this.activeGrantWhere(memberId, departmentId) },
      },
      select: { id: true },
    });
    if (!subscription) throw new ForbiddenException('当前成员无权查看该技能正文');
  }

  private activeGrantWhere(memberId: string, departmentId: string | null) {
    const targets: Array<{ memberId?: string; departmentId?: string }> = [{ memberId }];
    if (departmentId) targets.push({ departmentId });
    return {
      OR: targets,
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    };
  }

  private async assertCapabilityBound(employeeId: string, capabilityId: string) {
    const binding = await this.prisma.employeeCapabilityBinding.findFirst({
      where: { employeeId, capabilityId, enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } },
      select: { id: true },
    });
    if (!binding) throw new BadRequestException('该技能未绑定到当前员工');
  }

  private async nextVersion(
    capabilityId: string,
    scope: SkillVersionScope,
    enterpriseId?: string,
  ) {
    const versions = await this.prisma.skillVersion.findMany({
      where: { capabilityId, scope, enterpriseId: scope === 'ENTERPRISE' ? enterpriseId : null },
      select: { version: true },
    });
    return nextSemver(versions.map((row) => row.version));
  }

  // ────────────────── 使用记录与统计 ──────────────────

  /**
   * 「这个成员看得到这个能力吗」的统一把关。
   *
   * 判据是「有一个授权订阅，且该订阅的员工绑定了这个能力」。三个读接口
   * （版本时间线 / 使用统计 / 执行明细）共用它 —— 各写一遍必然有一处漏掉，
   * 而漏掉的那个接口会把别的部门的技能数据交出去。
   */
  private async assertCapabilityVisible(
    ctx: { enterpriseId: string; memberId: string; departmentId: string | null },
    capabilityId: string,
  ) {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        enterpriseId: ctx.enterpriseId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
        grants: { some: this.activeGrantWhere(ctx.memberId, ctx.departmentId) },
        employee: { bindings: { some: { capabilityId, enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
      },
      select: { id: true },
    });
    if (!subscription) throw new ForbiddenException('当前成员未获得该技能的使用授权');
    return subscription;
  }

  private async assertCapabilityReadable(
    ctx: { enterpriseId: string; memberId: string; departmentId: string | null; role: string },
    capabilityId: string,
  ) {
    const subscription = await this.prisma.subscription.findFirst({ where: {
      enterpriseId: ctx.enterpriseId, status: 'ACTIVE',
      OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
      employee: { bindings: { some: { capabilityId, enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
      ...(ctx.role === 'ENTERPRISE_ADMIN' ? {} : {
        grants: { some: this.activeGrantWhere(ctx.memberId, ctx.departmentId) },
      }),
    }, select: { id: true } });
    if (subscription) return subscription;
    const retained = await this.prisma.skillVersion.findFirst({ where: {
      enterpriseId: ctx.enterpriseId, capabilityId, capability: { type: 'SKILL' },
      OR: [{ scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' },
        ...(ctx.role === 'ENTERPRISE_ADMIN' ? [{ scope: 'PERSONAL' as const, workingCopyId: null,
          status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] as SkillVersionStatus[] } }] : [])],
    }, select: { id: true } });
    if (!retained) throw new NotFoundException('本企业技能不存在');
    return { id: '' };
  }

  /**
   * 技能库列表：授权员工绑定技能，以及本企业全部已发布的留存技能。
   *
   * 与 `listEmployeeSkills` 的区别：那个按员工进入（我要看这位员工带哪些技能），
   * 这个按能力进入（我要迭代这个技能）。同一个技能可能绑在多位员工身上，
   * 这里按 capability 去重，并带上「哪些员工在用」。
   */
  async listIterableCapabilities(userId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);

    // 普通成员只枚举授权员工；企业已发布技能另行补充，不暴露未授权员工关系。
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        enterpriseId: ctx.enterpriseId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
        ...(ctx.role === 'ENTERPRISE_ADMIN' ? {} : {
          grants: { some: this.activeGrantWhere(ctx.memberId, ctx.departmentId) },
        }),
      },
      select: {
        id: true,
        employeeId: true,
        employee: {
          select: {
            id: true,
            name: true,
            // 列表页按员工分组，分组头要显示成「一个人」而不是一个标签 ——
            // 头像与职能就是那点拟人效果的全部数据来源。
            //
            // 副标题用 functionalCategory 而不是 position：存量数据里 54 个员工有 50 个
            // position 与 name 完全相同、48 个 industry 是「通用」，照那两个字段渲染
            // 会得到「性能基准测试专家 · 通用」压在标题「性能基准测试专家」下面。
            // position/industry 仍然返回，前端只在它们确实带信息时才显示。
            avatar: true,
            position: true,
            industry: true,
            functionalCategory: true,
            bindings: {
              where: { enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } },
              select: {
                capability: { select: { id: true, name: true, description: true } },
                defaultSkillVersion: { select: VERSION_SUMMARY_SELECT },
              },
              orderBy: { priority: 'asc' },
            },
          },
        },
        skillVersionSelections: {
          select: { capabilityId: true, version: { select: VERSION_SUMMARY_SELECT } },
        },
      },
    });

    // 按 capability 归并：一个技能可能绑在多位员工身上
    type CapabilityEntry = {
      capability: { id: string; name: string; description: string };
      employees: Array<{
        employeeId: string;
        employeeName: string;
        employeeAvatar: string | null;
        employeePosition: string;
        employeeIndustry: string;
        employeeCategory: string;
        subscriptionId: string;
      }>;
      currentVersion: { id: string; version: string; scope: SkillVersionScope } | null;
    };
    const byCapability = new Map<string, CapabilityEntry>();

    for (const subscription of subscriptions) {
      const selected = new Map(
        subscription.skillVersionSelections.map((s) => [s.capabilityId, s.version]),
      );
      for (const binding of subscription.employee.bindings) {
        const capabilityId = binding.capability.id;
        const entry = byCapability.get(capabilityId) ?? {
          capability: binding.capability,
          employees: [],
          // 生效版本：企业选版 > 员工模板默认版。与 resolveEffectiveVersion 同序，
          // 但这里不查平台兜底 —— 列表只需要展示「企业当前的选择」，
          // 兜底版本在详情页由 listVersionTimeline 给出。
          currentVersion: selected.get(capabilityId) ?? binding.defaultSkillVersion ?? null,
        };
        entry.employees.push({
          employeeId: subscription.employee.id,
          employeeName: subscription.employee.name,
          employeeAvatar: subscription.employee.avatar,
          employeePosition: subscription.employee.position,
          employeeIndustry: subscription.employee.industry,
          employeeCategory: subscription.employee.functionalCategory,
          subscriptionId: subscription.id,
        });
        // 已有条目时，企业选版优先于模板默认版
        const explicit = selected.get(capabilityId);
        if (explicit) entry.currentVersion = explicit;
        byCapability.set(capabilityId, entry);
      }
    }

    const retainedCapabilities = await this.prisma.capability.findMany({
      where: { type: 'SKILL', skillVersions: { some: {
        enterpriseId: ctx.enterpriseId,
        OR: [{ scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' },
          ...(ctx.role === 'ENTERPRISE_ADMIN' ? [{ scope: 'PERSONAL' as const, workingCopyId: null,
            status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] as SkillVersionStatus[] } }] : [])],
      } } }, select: { id: true, name: true, description: true }, orderBy: { name: 'asc' },
    });
    for (const capability of retainedCapabilities) {
      if (!byCapability.has(capability.id)) byCapability.set(capability.id, { capability, employees: [], currentVersion: null });
    }
    const capabilityIds = [...byCapability.keys()];
    if (capabilityIds.length === 0) {
      // summary 必须恒定返回 —— 前端顶部汇总条读它，缺字段时会静默不渲染，
      // 看起来像「汇总条没做」而不是「一个技能都没有」
      return {
        canManage: ctx.role === 'ENTERPRISE_ADMIN',
        summary: {
          capabilityCount: 0,
          customizedCount: 0,
          pendingAdoptionTotal: 0,
          totalRounds: 0,
        },
        items: [],
      };
    }

    const enterpriseDefaults = await this.prisma.enterpriseSkillDefault.findMany({
      where: { enterpriseId: ctx.enterpriseId, capabilityId: { in: capabilityIds } },
      select: { capabilityId: true, version: { select: { id: true, version: true, scope: true } } },
    });
    for (const current of enterpriseDefaults) {
      const entry = byCapability.get(current.capabilityId);
      if (entry) entry.currentVersion = current.version;
    }

    // 每个能力的调用轮次与使用人数，一次 groupBy 拿全，避免 N+1
    const [roundsByCapability, executions] = await Promise.all([
      this.prisma.toolExecution.groupBy({
        by: ['capabilityId'],
        where: {
          capabilityId: { in: capabilityIds },
          session: {
            user: { memberships: { some: { enterpriseId: ctx.enterpriseId } } },
            employee: {
              subscriptions: { some: { enterpriseId: ctx.enterpriseId, status: 'ACTIVE' } },
            },
          },
        },
        _count: { _all: true },
      }),
      this.prisma.toolExecution.findMany({
        where: {
          capabilityId: { in: capabilityIds },
          session: {
            user: { memberships: { some: { enterpriseId: ctx.enterpriseId } } },
            employee: {
              subscriptions: { some: { enterpriseId: ctx.enterpriseId, status: 'ACTIVE' } },
            },
          },
        },
        select: { capabilityId: true, userId: true },
        distinct: ['capabilityId', 'userId'],
      }),
    ]);

    const roundsMap = new Map(roundsByCapability.map((row) => [row.capabilityId, row._count._all]));
    const userCountMap = new Map<string, number>();
    for (const row of executions) {
      if (!row.userId) continue;
      userCountMap.set(row.capabilityId, (userCountMap.get(row.capabilityId) ?? 0) + 1);
    }

    // 个人副本：列表页要回答「有几条改动等我处理」和「我自己有没有副本」。
    // 一次查全部再在内存里分组 —— 一个企业的个人副本总数是「成员数 × 能力数」量级，
    // 不会大到需要分页；换成 N 次 count 反而变 N+1。
    const personalVersions = await this.prisma.skillVersion.findMany({
      where: {
        capabilityId: { in: capabilityIds },
        scope: 'PERSONAL',
        status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
        workingCopyId: null,
        enterpriseId: ctx.enterpriseId,
      },
      select: {
        id: true,
        capabilityId: true,
        ownerId: true,
        updatedAt: true, status: true,
        ...PERSONAL_REVIEW_RELATIONS,
      },
    });

    const pendingMap = new Map<string, number>();
    const myPendingMap = new Map<string, number>();
    const myVersionMap = new Map<string, string>();
    for (const version of personalVersions) {
      // 待审核包含新提交、工作副本的新修订及历史已通过但尚未发布记录。
      if (personalReviewState(version).pending) {
        pendingMap.set(version.capabilityId, (pendingMap.get(version.capabilityId) ?? 0) + 1);
        if (version.ownerId === userId) myPendingMap.set(version.capabilityId, (myPendingMap.get(version.capabilityId) ?? 0) + 1);
      }
      if (version.ownerId === userId && version.status === 'PERSONAL_ACTIVE') myVersionMap.set(version.capabilityId, version.id);
    }

    const items = [...byCapability.values()].map((entry) => ({
      capability: entry.capability,
      employees: entry.employees,
      currentVersion: entry.currentVersion,
      usage: {
        totalRounds: roundsMap.get(entry.capability.id) ?? 0,
        distinctUserCount: userCountMap.get(entry.capability.id) ?? 0,
      },
      /// 管理员：有多少条成员改动等着处理。普通成员看到的是自己那条（0 或 1）。
      pendingAdoptionCount: ctx.role === 'ENTERPRISE_ADMIN'
        ? pendingMap.get(entry.capability.id) ?? 0
        : myPendingMap.get(entry.capability.id) ?? 0,
      // 保留历史副本入口，但正式执行不再使用个人偏好。
      myPersonalVersionId: myVersionMap.get(entry.capability.id) ?? null,
      myPersonalVersionActive: false,
    }));

    return {
      canManage: ctx.role === 'ENTERPRISE_ADMIN',
      // 顶部汇总条的四个数由同一接口给出 —— 前端再打一遍请求算同样的东西没有意义
      summary: {
        capabilityCount: items.length,
        customizedCount: items.filter((i) => i.currentVersion?.scope === 'ENTERPRISE').length,
        pendingAdoptionTotal: items.reduce((sum, i) => sum + i.pendingAdoptionCount, 0),
        totalRounds: items.reduce((sum, i) => sum + i.usage.totalRounds, 0),
      },
      items,
    };
  }

  private isApprovedEffectiveVersion(
    version: { capabilityId: string; scope: string; status: string; enterpriseId: string | null } | null | undefined,
    enterpriseId: string, capabilityId: string,
  ) {
    return version?.capabilityId === capabilityId && (
      (version.scope === 'PLATFORM' && version.status === 'PLATFORM_APPROVED') ||
      (version.scope === 'ENTERPRISE' && version.status === 'ENTERPRISE_APPROVED' && version.enterpriseId === enterpriseId)
    );
  }

  private async readCapabilityEffectiveState(ctx: CapabilityReadContext, capabilityId: string) {
    const [current, subscriptions] = await Promise.all([
      this.defaults.get(ctx.enterpriseId, capabilityId),
      this.prisma.subscription.findMany({ where: {
        enterpriseId: ctx.enterpriseId, status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
        ...(ctx.role === 'ENTERPRISE_ADMIN' ? {} : { grants: { some: this.activeGrantWhere(ctx.memberId, ctx.departmentId) } }),
        employee: { bindings: { some: { capabilityId, enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
      }, select: {
        id: true, employee: { select: { id: true, name: true } },
        skillVersionSelections: { where: { capabilityId }, select: { versionId: true, selectedAt: true } },
      } }),
    ]);
    const explicitDefault = current && this.isApprovedEffectiveVersion(current.version, ctx.enterpriseId, capabilityId) ? current : null;
    const resolved = await Promise.all(subscriptions.map(async (subscription) => {
      const version = explicitDefault?.version ?? await this.resolveEffectiveVersion(subscription.id, capabilityId);
      const selection = subscription.skillVersionSelections.find((item) => item.versionId === version?.id);
      const selectedAt = version ? explicitDefault?.selectedAt ?? selection?.selectedAt ?? null : null;
      return { ...subscription, version, selectedAt,
        state: (version ? explicitDefault || selection ? 'EXPLICIT' : 'AUTOMATIC' : 'NONE') as EffectiveVersionState };
    }));
    if (explicitDefault) return { state: 'EXPLICIT' as EffectiveVersionState,
      version: explicitDefault.version, selectedAt: explicitDefault.selectedAt, subscriptions: resolved };
    if (!resolved.length) {
      const fallback = await this.prisma.skillVersion.findFirst({ where: {
        capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
      }, orderBy: PLATFORM_RELEASE_ORDER });
      return { state: (fallback ? 'AUTOMATIC' : 'NONE') as EffectiveVersionState,
        version: fallback, selectedAt: null, subscriptions: resolved };
    }
    // Aggregate every visible subscription; never use the authorization probe as a company default.
    const ids = new Set(resolved.map((row) => row.version?.id ?? null));
    if (ids.size > 1) return { state: 'MIXED' as EffectiveVersionState, version: null, selectedAt: null, subscriptions: resolved };
    const version = resolved[0].version;
    const allExplicit = resolved.every((row) => row.state === 'EXPLICIT');
    const dates = new Set(resolved.map((row) => row.selectedAt?.getTime() ?? null));
    return { state: (version ? allExplicit ? 'EXPLICIT' : 'AUTOMATIC' : 'NONE') as EffectiveVersionState,
      version, selectedAt: allExplicit && dates.size === 1 ? resolved[0].selectedAt : null, subscriptions: resolved };
  }

  private async pendingSubmissionTotal(ctx: CapabilityReadContext, userId: string, capabilityId: string) {
    const roots = await this.prisma.skillVersion.findMany({ where: {
      enterpriseId: ctx.enterpriseId, capabilityId, scope: 'PERSONAL', workingCopyId: null,
      status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
      ...(ctx.role === 'ENTERPRISE_ADMIN' ? {} : { ownerId: userId }),
    }, select: PERSONAL_DIFF_SELECT });
    return roots.filter((row) => row.scope === 'PERSONAL' && !row.workingCopyId && personalReviewState(row).pending).length;
  }

  private async readSourceSubmissionIds(ctx: CapabilityReadContext, userId: string, capabilityId: string, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    // Count all real sources before applying visibility, or a member's subset can look canonical.
    const ownership = { enterpriseId: ctx.enterpriseId, capabilityId, scope: 'PERSONAL' as const };
    const sources = await this.prisma.skillVersionAdoption.findMany({ where: {
      targetVersionId: { in: ids }, targetVersion: { enterpriseId: ctx.enterpriseId, capabilityId,
        scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' }, sourceVersion: ownership,
    }, select: { targetVersionId: true, sourceVersion: { select: {
      id: true, enterpriseId: true, capabilityId: true, scope: true, ownerId: true, workingCopyId: true,
      workingCopy: { select: { id: true, enterpriseId: true, capabilityId: true, scope: true, ownerId: true, workingCopyId: true } },
    } } }, orderBy: [{ adoptedAt: 'asc' }, { id: 'asc' }] });
    const grouped = new Map<string, Set<string>>();
    const unreadableTargets = new Set<string>();
    for (const adoption of sources) {
      const source = adoption.sourceVersion;
      const root = source.workingCopyId ? source.workingCopy : source;
      const readable = (row: typeof root) => row && row.enterpriseId === ctx.enterpriseId
        && row.capabilityId === capabilityId && row.scope === 'PERSONAL'
        && (ctx.role === 'ENTERPRISE_ADMIN' || row.ownerId === userId);
      if (!root || root.workingCopyId || root.ownerId !== source.ownerId || !readable(source) || !readable(root)) {
        unreadableTargets.add(adoption.targetVersionId);
        continue;
      }
      const links = grouped.get(adoption.targetVersionId) ?? new Set<string>();
      links.add(root.id);
      grouped.set(adoption.targetVersionId, links);
    }
    // Legacy multi-source adoptions have no single canonical source submission.
    return new Map([...grouped].flatMap(([id, links]) => links.size === 1 && !unreadableTargets.has(id)
      ? [[id, [...links][0]] as const] : []));
  }

  /**
   * 版本时间线：保留旧集合，独立返回真实默认与执行回落的聚合状态。
   *
   * 平台版与企业版混排、按创建时间倒序 —— 用户要的是「我改过几版、现在用哪版、
   * 能退回哪版」，而不是两个分开的列表。
   */
  async listVersionTimeline(userId: string, capabilityId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const subscription = await this.assertCapabilityReadable(ctx, capabilityId);

    const [capability, versions, effective, pendingTotal] = await Promise.all([
      this.prisma.capability.findUnique({
        where: { id: capabilityId },
        select: { id: true, name: true, description: true },
      }),
      this.prisma.skillVersion.findMany({
        where: {
          capabilityId,
          OR: [
            { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
            // 企业版把草稿与待审也列出来：迭代过程本身要可见，
            // 只显示已通过的版本会让「我提交的那版去哪了」无从回答
            { scope: 'ENTERPRISE', enterpriseId: ctx.enterpriseId,
              ...(ctx.role === 'ENTERPRISE_ADMIN' ? {} : { status: 'ENTERPRISE_APPROVED' }) },
            // 本人送审/已审版本只读跟踪；不混入其他成员个人记录。
            { scope: 'PERSONAL', enterpriseId: ctx.enterpriseId, ownerId: userId },
          ],
        },
        select: {
          ...VERSION_SUMMARY_SELECT,
          createdBy: { select: { id: true, name: true } },
          enterpriseReviewedBy: { select: { id: true, name: true } },
          enterpriseReviewedAt: true,
          rejectionReason: true,
          reviews: {
            where: { actorType: 'ENTERPRISE' },
            select: {
              id: true,
              actorType: true,
              decision: true,
              comment: true,
              createdAt: true,
              reviewer: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
          },
          promotedVersions: { select: { id: true }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.readCapabilityEffectiveState(ctx, capabilityId),
      this.pendingSubmissionTotal(ctx, userId, capabilityId),
    ]);

    if (!capability) throw new NotFoundException('能力不存在');
    const currentVersionId = effective.version?.id ?? null;
    const sourceIds = await this.readSourceSubmissionIds(ctx, userId, capabilityId,
      versions.filter((version) => version.scope === 'ENTERPRISE' && version.status === 'ENTERPRISE_APPROVED').map((version) => version.id));

    return {
      capability,
      subscriptionId: subscription.id,
      myPersonalVersionId: null,
      subscriptions: effective.subscriptions.map((item) => {
        const enterpriseVersion = item.version;
        return {
          subscriptionId: item.id,
          employeeId: item.employee.id,
          employeeName: item.employee.name,
          currentVersionId: enterpriseVersion?.id ?? null,
          enterpriseVersionId: enterpriseVersion?.id ?? null,
          personalVersionId: null,
          personalSelectionMode: 'FOLLOW_ENTERPRISE',
          effectiveVersionId: enterpriseVersion?.id ?? null,
          effectiveVersionScope: enterpriseVersion?.scope ?? null,
          canSelectPersonal: false,
          selectedAt: item.selectedAt?.toISOString() ?? null,
        };
      }),
      canManage: ctx.role === 'ENTERPRISE_ADMIN',
      currentVersionId,
      selectedAt: effective.selectedAt?.toISOString() ?? null,
      effectiveVersionState: effective.state,
      effectiveVersion: effective.version ? { id: effective.version.id, scope: effective.version.scope, version: effective.version.version } : null,
      pendingTotal,
      versions: versions.map(({ promotedVersions, ...version }) => ({
        ...version,
        hasPlatformSubmission: promotedVersions.length > 0,
        isWorkingCopy: version.scope === 'PERSONAL' && !version.submittedAt && !version.workingCopyId && !version.workingCopyUpdatedAt,
        isCurrent: version.id === currentVersionId,
        sourceSubmissionId: sourceIds.get(version.id) ?? null,
      })),
    };
  }

  /**
   * 使用记录汇总：三层聚合（总览 + 分员工 + 分用户）。
   *
   * 调用方权限决定可见范围：
   * - 普通员工看到 summary + byEmployee（全企业范围）
   * - 企业管理员额外看到 byMember（具体到人）
   */
  async getUsageSummary(userId: string, capabilityId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    // 授权校验：没有授权的成员连这个技能的存在都不该感知到，
    // 更不能读它的使用统计。与 listVersionTimeline 用同一把关。
    await this.assertCapabilityVisible(ctx, capabilityId);

    // 查本企业对这个技能的所有执行记录（不限版本 —— 企业可能在不同版本间切换）
    const executions = await this.prisma.toolExecution.findMany({
      where: {
        capabilityId,
        // userId 通过 session → user 关联，先查出本企业的所有会话再过滤
        session: {
          user: {
            memberships: {
              some: { enterpriseId: ctx.enterpriseId },
            },
          },
          employee: {
            subscriptions: { some: { enterpriseId: ctx.enterpriseId, status: 'ACTIVE' } },
          },
        },
      },
      select: {
        id: true,
        sessionId: true,
        userId: true,
        skillVersionId: true,
        session: {
          select: {
            employeeId: true,
            employee: { select: { name: true } },
          },
        },
        user: { select: { name: true } },
      },
    });

    const distinctUserIds = new Set(executions.map((e) => e.userId).filter(Boolean));
    const distinctSessionIds = new Set(executions.map((e) => e.sessionId));

    // 按员工聚合
    const byEmployeeMap = new Map<string, { name: string; count: number }>();
    for (const exec of executions) {
      const id = exec.session.employeeId;
      const entry = byEmployeeMap.get(id) ?? { name: exec.session.employee.name, count: 0 };
      entry.count += 1;
      byEmployeeMap.set(id, entry);
    }

    const byEmployee = Array.from(byEmployeeMap.entries()).map(([employeeId, data]) => ({
      employeeId,
      employeeName: data.name,
      rounds: data.count,
    }));

    // 按用户聚合（仅管理员可见）
    let byMember: Array<{ userId: string; userName: string | null; rounds: number }> | undefined;
    if (ctx.role === 'ENTERPRISE_ADMIN') {
      const byMemberMap = new Map<string, { name: string | null; count: number }>();
      for (const exec of executions) {
        if (!exec.userId) continue;
        const entry = byMemberMap.get(exec.userId) ?? { name: exec.user?.name ?? null, count: 0 };
        entry.count += 1;
        byMemberMap.set(exec.userId, entry);
      }
      byMember = Array.from(byMemberMap.entries()).map(([userId, data]) => ({
        userId,
        userName: data.name,
        rounds: data.count,
      }));
    }

    return {
      summary: {
        distinctUserCount: distinctUserIds.size,
        totalConversations: distinctSessionIds.size,
        totalRounds: executions.length,
      },
      byEmployee,
      byMember,
    };
  }

  /**
   * 某个硅基员工在本企业的使用情况（会议纪要2 §6.2）。
   *
   * 与 getUsageSummary 的区别是入口维度：那个从技能进（这个技能几个人在用），
   * 这个从员工进（这位员工谁在用、用得怎么样）。会议两个视角都要 ——
   * *进「我的企业」能看到硅基员工列表；点进硅基员工能看到使用情况跟踪*。
   *
   * 授权校验用「本企业有这位员工的 ACTIVE 订阅且当前成员被授权」，
   * 与 assertCapabilityVisible 同一套判据，只是换成按员工查。
   */
  async getEmployeeUsage(userId: string, employeeId: string, days = 30) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        enterpriseId: ctx.enterpriseId,
        status: 'ACTIVE',
        employeeId,
        grants: { some: this.activeGrantWhere(ctx.memberId, ctx.departmentId) },
      },
      select: { id: true },
    });
    if (!subscription) throw new ForbiddenException('未获得该硅基员工的使用授权');

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sessions = await this.prisma.conversationSession.findMany({
      where: {
        employeeId,
        createdAt: { gte: since },
        // 只算本企业成员的会话 —— 同一个员工模板可能被多家企业雇佣
        user: { memberships: { some: { enterpriseId: ctx.enterpriseId } } },
      },
      select: {
        id: true,
        userId: true,
        source: true,
        updatedAt: true,
        user: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
    });

    const sessionIds = sessions.map((session) => session.id);
    const executions = sessionIds.length
      ? await this.prisma.toolExecution.findMany({
          where: { sessionId: { in: sessionIds } },
          select: { id: true, sessionId: true, status: true, duration: true },
        })
      : [];

    const execBySession = new Map<string, { total: number; success: number }>();
    for (const exec of executions) {
      const entry = execBySession.get(exec.sessionId) ?? { total: 0, success: 0 };
      entry.total += 1;
      if (exec.status === 'SUCCESS') entry.success += 1;
      execBySession.set(exec.sessionId, entry);
    }

    const byMemberMap = new Map<
      string,
      { name: string | null; conversations: number; rounds: number; executions: number; lastUsedAt: Date }
    >();
    for (const session of sessions) {
      if (!session.userId) continue;
      const entry = byMemberMap.get(session.userId) ?? {
        name: session.user?.name ?? null,
        conversations: 0,
        rounds: 0,
        executions: 0,
        lastUsedAt: session.updatedAt,
      };
      entry.conversations += 1;
      entry.rounds += session._count.messages;
      entry.executions += execBySession.get(session.id)?.total ?? 0;
      if (session.updatedAt > entry.lastUsedAt) entry.lastUsedAt = session.updatedAt;
      byMemberMap.set(session.userId, entry);
    }

    const successCount = executions.filter((e) => e.status === 'SUCCESS').length;
    const durations = executions
      .map((e) => e.duration)
      .filter((d): d is number => typeof d === 'number');

    return {
      period: { days, since: since.toISOString() },
      summary: {
        distinctUserCount: byMemberMap.size,
        totalConversations: sessions.length,
        totalRounds: sessions.reduce((sum, s) => sum + s._count.messages, 0),
        totalExecutions: executions.length,
        // 成功率：没有执行记录时给 null 而不是 0% —— 「没跑过」和「全失败」是两件事
        successRate: executions.length ? Math.round((successCount / executions.length) * 100) : null,
        avgDurationMs: durations.length
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null,
        lastUsedAt:
          sessions.length
            ? sessions.reduce((max, s) => (s.updatedAt > max ? s.updatedAt : max), sessions[0].updatedAt).toISOString()
            : null,
      },
      // 按人列出「谁在用」。含成员对话内容的明细仍只给管理员，这里只有计数，
      // 所以普通成员也能看到 —— 会议要的是「使用人数即口碑」，人数本身不敏感。
      byMember: Array.from(byMemberMap.entries())
        .map(([memberUserId, data]) => ({
          userId: memberUserId,
          userName: data.name,
          conversations: data.conversations,
          rounds: data.rounds,
          executions: data.executions,
          lastUsedAt: data.lastUsedAt.toISOString(),
        }))
        .sort((a, b) => b.rounds - a.rounds),
    };
  }

  /**
   * 执行明细：单次调用的输入输出与版本归属，游标分页。
   *
   * 仅企业管理员可见 —— 涉及员工对话内容，普通员工不该看到。
   */
  async getExecutionDetails(
    userId: string,
    capabilityId: string,
    limit: number,
    cursor?: string,
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    await this.assertCapabilityVisible(ctx, capabilityId);

    const executions = await this.prisma.toolExecution.findMany({
      where: {
        capabilityId,
        session: {
          user: {
            memberships: {
              some: { enterpriseId: ctx.enterpriseId },
            },
          },
          employee: {
            subscriptions: { some: { enterpriseId: ctx.enterpriseId, status: 'ACTIVE' } },
          },
        },
        ...(cursor && { createdAt: { lt: new Date(cursor) } }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        sessionId: true,
        input: true,
        output: true,
        status: true,
        errorMessage: true,
        duration: true,
        skillVersionId: true,
        skillVersion: { select: { scope: true } },
        userId: true,
        user: { select: { name: true } },
        createdAt: true,
      },
    });

    const items = executions.map((exec) => ({
      id: exec.id,
      sessionId: exec.sessionId,
      input: exec.input,
      output: exec.output,
      status: exec.status,
      errorMessage: exec.errorMessage,
      duration: exec.duration,
      skillVersionId: exec.skillVersionId,
      versionScope: exec.skillVersion?.scope ?? null,
      userId: exec.userId,
      userName: exec.user?.name ?? null,
      createdAt: exec.createdAt.toISOString(),
    }));

    const nextCursor =
      executions.length === limit ? executions[executions.length - 1].createdAt.toISOString() : null;

    return { items, nextCursor };
  }
}
