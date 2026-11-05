import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  CapabilityType,
  ContributionPlatformStatus,
  Prisma,
  SkillVersionStatus,
  RpaVersionStatus,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { EnterpriseContextService } from "../enterprise/enterprise-context.service";
import type {
  ContributionCapabilityCreateDto,
  ContributionCapabilityUpdateDto,
  ContributionReviewDecision as ContributionDecisionDto,
  ContributionVersionCreateDto,
  ContributionVersionUpdateDto,
} from "shared";
import { SkillPackageService } from "../skill-package/skill-package.service";
import { RpaPackageService } from "../rpa-package/rpa-package.service";
import {
  AUTHOR_VERSION_SELECT,
  CONTRIBUTION_CAPABILITY_SELECT,
  CONTRIBUTION_PLATFORM_DETAIL_SELECT,
  CONTRIBUTION_PLATFORM_LIST_SELECT,
  USAGE_VERSION_SELECT,
} from "./capability-contribution.types";
import { CapabilityValidatorService } from "./capability-validator.service";
import { SettingService } from "../setting/setting.service";
import {
  NotificationsService,
  type CreateNotificationDto,
} from "../notifications/notifications.service";
import { AuditService } from "../audit/audit.service";
import { PackageSecurityService } from './package-security.service';
import { assertActiveRewardRecipientInTx } from '../personal-wallet/personal-wallet.service';

const DEFAULT_REWARD_CNY = { enterprise: "10", platform: "50" } as const;

const VERSION_REVIEW_SELECT = {
  id: true,
  actorType: true,
  decision: true,
  reviewerId: true,
  comment: true,
  createdAt: true,
  reviewer: { select: { id: true, name: true, email: true } },
} as const;

async function creditRewardInTx(
  tx: any,
  userId: string,
  amount: Prisma.Decimal,
  eventId: string,
  description: string,
) {
  if (!tx.personalWallet || amount.lessThanOrEqualTo(0)) return;
  await assertActiveRewardRecipientInTx(tx, userId);
  const wallet = await tx.personalWallet.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  const existing = await tx.personalWalletTransaction.findFirst?.({
    where: {
      walletId: wallet.id,
      relatedType: "contribution_reward",
      relatedId: eventId,
    },
    select: { id: true },
  });
  if (existing) return;
  const before = wallet.balance;
  const after = before.add(amount);
  const updated = await tx.personalWallet.updateMany({
    where: { id: wallet.id, version: wallet.version },
    data: {
      balance: after,
      totalDepositCNY: { increment: amount },
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1)
    throw new ConflictException("个人奖励入账冲突，请重试");
  await tx.personalWalletTransaction.create({
    data: {
      walletId: wallet.id,
      type: "DEPOSIT",
      amount,
      balanceBefore: before,
      balanceAfter: after,
      relatedType: "contribution_reward",
      relatedId: eventId,
      description,
    },
  });
}

type DownloadAuditContext = {
  ip?: string | null;
  userAgent?: string | null;
};

const CAPABILITY_TYPES: Record<
  ContributionCapabilityCreateDto["type"],
  CapabilityType
> = {
  skill: "SKILL",
  agent: "AGENT",
  rpa: "RPA",
};

@Injectable()
export class CapabilityContributionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enterpriseContext: EnterpriseContextService,
    private readonly validator: CapabilityValidatorService,
    private readonly skillPackage: SkillPackageService,
    private readonly setting?: SettingService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly rpaPackage?: RpaPackageService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly security?: PackageSecurityService,
  ) {}

  private readonly logger = new Logger(CapabilityContributionService.name);

  /**
   * 通知属于审核状态变更后的旁路动作：通知中心或网关暂时不可用时，不能
   * 回滚已经完成的审核、奖励或投稿状态。所有能力贡献相关通知统一从这里
   * 发出，便于生产环境记录失败并继续主流程。
   */
  private async safeNotify(notification: CreateNotificationDto) {
    if (!this.notifications) return;
    try {
      await this.notifications.create(notification);
    } catch (error) {
      this.logger.warn(
        `能力贡献通知写入失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async safeNotifyUsers(
    userIds: string[],
    notification: Omit<CreateNotificationDto, "userId">,
  ) {
    if (!this.notifications) return;
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueUserIds.length === 0) return;
    try {
      await this.notifications.createBatch(uniqueUserIds, notification);
    } catch (error) {
      this.logger.warn(
        `能力贡献批量通知写入失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async notifyEnterpriseReviewers(
    enterpriseId: string | null | undefined,
    capabilityId: string,
    message: string,
  ) {
    if (!this.notifications || !enterpriseId) return;
    try {
      const reviewers = await this.prisma.enterpriseMember.findMany({
        where: { enterpriseId, role: "ENTERPRISE_ADMIN" },
        select: { userId: true },
      });
      await this.safeNotifyUsers(
        reviewers.map((reviewer) => reviewer.userId),
        {
          type: "INFO",
          category: "APPROVAL",
          title: "有新的能力待企业审核",
          message,
          relatedType: "capability",
          relatedId: capabilityId,
          actionUrl: `/contributions/${capabilityId}`,
        },
      );
    } catch (error) {
      this.logger.warn(
        `查询企业审核人失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async notifyPlatformReviewers(
    capabilityId: string,
    message: string,
  ) {
    if (!this.notifications) return;
    try {
      const reviewers = await this.prisma.user.findMany({
        where: { role: "ADMIN" },
        select: { id: true },
      });
      await this.safeNotifyUsers(
        reviewers.map((reviewer) => reviewer.id),
        {
          type: "INFO",
          category: "APPROVAL",
          title: "有新的能力待平台审核",
          message,
          relatedType: "capability",
          relatedId: capabilityId,
          actionUrl: `/contributions/${capabilityId}`,
        },
      );
    } catch (error) {
      this.logger.warn(
        `查询平台审核人失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async rewardAmount(kind: "enterprise" | "platform") {
    const key =
      kind === "enterprise"
        ? "CONTRIBUTION_ENTERPRISE_REWARD_CNY"
        : "CONTRIBUTION_PLATFORM_REWARD_CNY";
    const configured = await this.setting?.getEffectiveValue(key as any);
    const value = Number(configured ?? DEFAULT_REWARD_CNY[kind]);
    return Number.isFinite(value) && value > 0
      ? new Prisma.Decimal(value)
      : new Prisma.Decimal(DEFAULT_REWARD_CNY[kind]);
  }

  async overview(userId: string) {
    const ctx = await this.enterpriseContext.resolveOrNull(userId);
    const canReviewEnterprise = ctx?.role === "ENTERPRISE_ADMIN";
    const capabilities = await this.prisma.capability.findMany({
      where: canReviewEnterprise
        ? {
            OR: [{ contributorId: userId }, { enterpriseId: ctx.enterpriseId }],
          }
        : { contributorId: userId },
      select: {
        enterpriseReviewStatus: true,
        platformReviewStatus: true,
        visibility: true,
        usageCount: true,
      },
    });
    const rewards = await this.prisma.contributionRewardEvent.aggregate({
      where: { recipientId: userId, status: { in: ["PENDING", "AVAILABLE"] } },
      _sum: { points: true },
    });
    return {
      enterpriseId: ctx?.enterpriseId ?? null,
      capabilityCount: capabilities.length,
      pendingEnterpriseReview: capabilities.filter(
        (item) => item.enterpriseReviewStatus === "PENDING",
      ).length,
      pendingPlatformAuthorization: capabilities.filter(
        (item) => item.platformReviewStatus === "REQUESTED",
      ).length,
      publicCapabilityCount: capabilities.filter(
        (item) => item.visibility === "MARKET_PUBLIC",
      ).length,
      usageCount: capabilities.reduce((sum, item) => sum + item.usageCount, 0),
      pendingRewardPoints: rewards._sum.points ?? 0,
    };
  }

  async listMine(userId: string) {
    const ctx = await this.enterpriseContext.resolveOrNull(userId);
    return this.prisma.capability.findMany({
      where:
        ctx?.role === "ENTERPRISE_ADMIN"
          ? {
              OR: [
                { contributorId: userId },
                { enterpriseId: ctx.enterpriseId },
              ],
            }
          : { contributorId: userId },
      select: CONTRIBUTION_CAPABILITY_SELECT,
      orderBy: { updatedAt: "desc" },
    });
  }

  async getOne(userId: string, capabilityId: string) {
    const ctx = await this.enterpriseContext.resolveOrNull(userId);
    const capability = await this.prisma.capability.findFirst({
      where:
        ctx?.role === "ENTERPRISE_ADMIN"
          ? {
              id: capabilityId,
              OR: [
                { contributorId: userId },
                { enterpriseId: ctx.enterpriseId },
              ],
            }
          : { id: capabilityId, contributorId: userId },
      select: {
        ...CONTRIBUTION_CAPABILITY_SELECT,
        inputSchema: true,
        outputSchema: true,
        rpaVersions: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            version: true,
            packageFilename: true,
            packageFileCount: true,
            packageBytes: true,
            packageSha256: true,
            configDoc: true,
            status: true,
            validationResult: true,
            validatedAt: true,
            rejectionReason: true,
            createdById: true,
            createdAt: true,
            updatedAt: true,
          },
          take: 10,
        },
        skillVersions: {
          where: { scope: { not: "PERSONAL" } },
          select: {
            ...AUTHOR_VERSION_SELECT,
            rejectionReason: true,
            validationResult: true,
            validatedAt: true,
            createdById: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
        contributionRewards: {
          select: {
            id: true,
            eventType: true,
            points: true,
            amount: true,
            status: true,
            createdAt: true,
            settledAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });
    if (!capability) throw new NotFoundException("能力不存在或无权访问");
    return capability;
  }

  async usage(userId: string, capabilityId: string) {
    const ctx = await this.enterpriseContext.resolveOrNull(userId);
    if (!ctx?.enterpriseId)
      return {
        capability: { id: capabilityId, name: "" },
        totalBindings: 0,
        employees: [],
      };

    const capability = await this.prisma.capability.findFirst({
      where:
        ctx.role === "ENTERPRISE_ADMIN"
          ? {
              id: capabilityId,
              OR: [
                { contributorId: userId },
                { enterpriseId: ctx.enterpriseId },
              ],
            }
          : { id: capabilityId, enterpriseId: ctx.enterpriseId },
      select: { id: true, name: true },
    });
    if (!capability) throw new NotFoundException("能力不存在或无权访问");

    const memberUsers = await this.prisma.enterpriseMember.findMany({
      where: { enterpriseId: ctx.enterpriseId },
      select: { userId: true },
    });
    const userIds = memberUsers.map((member) => member.userId);
    const bindings = await this.prisma.employeeCapabilityBinding.findMany({
      where: { capabilityId },
      select: {
        employee: {
          select: {
            id: true,
            name: true,
            bindings: {
              where: { capabilityId },
              select: { defaultSkillVersion: { select: USAGE_VERSION_SELECT } },
            },
            subscriptions: {
              where: { enterpriseId: ctx.enterpriseId, status: "ACTIVE" },
              select: {
                id: true,
                skillVersionSelections: {
                  where: { capabilityId },
                  select: {
                    version: { select: USAGE_VERSION_SELECT },
                    selectedAt: true,
                  },
                },
              },
              take: 1,
            },
          },
        },
      },
    });

    const employees = await Promise.all(
      bindings.map(async ({ employee }) => {
        const subscription = employee.subscriptions[0];
        const selection = subscription?.skillVersionSelections[0] ?? null;
        const effectiveVersion =
          selection?.version ??
          employee.bindings[0]?.defaultSkillVersion ??
          null;
        const executionWhere = {
          capabilityId,
          session: { employeeId: employee.id, userId: { in: userIds } },
        };
        const [usageCount, latestExecution] = await Promise.all([
          this.prisma.toolExecution.count({ where: executionWhere }),
          this.prisma.toolExecution.findFirst({
            where: executionWhere,
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
          }),
        ]);
        return {
          employeeId: employee.id,
          employeeName: employee.name,
          subscriptionId: subscription?.id ?? null,
          selectedVersion: selection?.version ?? null,
          effectiveVersion,
          lastUsedAt: latestExecution?.createdAt ?? null,
          usageCount,
        };
      }),
    );
    return { capability, totalBindings: employees.length, employees };
  }

  async create(userId: string, dto: ContributionCapabilityCreateDto) {
    // 运营首次创建走 CapabilityService；贡献入口不再生产 SKILL 正文。
    // 也拦截混合配置，避免直接调用 service 时借其他类型创建技能正文。
    if (dto.type === "skill" || dto.skillConfig) {
      throw new ForbiddenException("SKILL 首次创建仅支持运营后台，已有技能请通过客户端修改");
    }
    const ctx = await this.enterpriseContext.resolveOrNull(userId);
    if (dto.type === "agent" && !dto.agentConfig) {
      throw new BadRequestException("Agent 能力必须提供执行平台配置");
    }
    if (dto.type === "rpa" && !dto.rpaConfig) {
      throw new BadRequestException("RPA 能力必须上传 ZIP 包并填写平台说明");
    }

    const rpa = dto.rpaConfig
      ? await this.resolveRpaSource(
          dto.rpaConfig.packageSha256,
          dto.rpaConfig.packageFilename,
        )
      : null;
    return this.prisma.capability.create({
      data: {
        name: dto.name,
        description: dto.description,
        type: CAPABILITY_TYPES[dto.type],
        industry: dto.industry,
        position: dto.position,
        inputSchema: dto.inputSchema,
        outputSchema: dto.outputSchema,
        contributorId: userId,
        enterpriseId: ctx?.enterpriseId ?? null,
        ...(rpa &&
          dto.rpaConfig && {
            rpaConfig: {
              create: {
                platform: dto.rpaConfig.platform.toUpperCase() as
                  "SHIZAI" | "YINGDAO",
                executionMode: "DOWNLOAD",
                packageUrl: rpa.key,
                packageSha256: rpa.sha256,
                configDoc: dto.rpaConfig.configDoc,
              },
            },
            rpaVersions: {
              create: {
                version: "1.0.0",
                packageKey: rpa.key,
                packageSha256: rpa.sha256,
                packageFilename: rpa.filename,
                packageFileCount: rpa.fileCount,
                packageBytes: rpa.totalBytes,
                configDoc: dto.rpaConfig.configDoc,
                status: "DRAFT",
                createdById: userId,
              },
            },
          }),
        ...(dto.agentConfig && {
          agentConfig: {
            create: {
              platform: dto.agentConfig.platform.toUpperCase() as "COZE",
              botId: dto.agentConfig.botId,
              workflowUrl: dto.agentConfig.workflowUrl,
              skillName: dto.agentConfig.skillName,
            },
          },
        }),
      },
      select: CONTRIBUTION_CAPABILITY_SELECT,
    });
  }

  async update(
    userId: string,
    capabilityId: string,
    dto: ContributionCapabilityUpdateDto,
  ) {
    const capability = await this.getOwnedCapability(userId, capabilityId);
    if (
      capability.enterpriseReviewStatus === "PENDING" ||
      capability.platformReviewStatus === "PENDING_REVIEW"
    ) {
      throw new ConflictException("审核中的能力不能编辑");
    }
    if (
      capability.enterpriseReviewStatus === "APPROVED" &&
      capability.visibility === "MARKET_PUBLIC"
    ) {
      throw new ConflictException("已公开能力不能直接修改，请创建新版本");
    }
    return this.prisma.capability.update({
      where: { id: capability.id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.industry !== undefined && { industry: dto.industry }),
        ...(dto.position !== undefined && { position: dto.position }),
        ...(dto.inputSchema !== undefined && { inputSchema: dto.inputSchema }),
        ...(dto.outputSchema !== undefined && {
          outputSchema: dto.outputSchema,
        }),
        ...(capability.enterpriseReviewStatus === "REJECTED" && {
          enterpriseReviewStatus: "NOT_SUBMITTED",
          enterpriseRejectionReason: null,
        }),
      },
      select: CONTRIBUTION_CAPABILITY_SELECT,
    });
  }

  async submitEnterpriseReview(userId: string, capabilityId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const capability = await this.getOwnedCapability(userId, capabilityId);
    if (capability.enterpriseId !== ctx.enterpriseId)
      throw new ForbiddenException("能力不属于当前企业");
    if (
      !["NOT_SUBMITTED", "REJECTED"].includes(capability.enterpriseReviewStatus)
    ) {
      throw new ConflictException("当前状态不能提交企业审核");
    }
    const validation = await this.validateCapability(
      capability.id,
      capability.type,
    );
    await this.assertCapabilityPackageReviewable(capability.id, capability.type);
    if (!validation.valid) {
      throw new BadRequestException({
        message: "自动校验未通过，暂不能提交审核",
        validation,
      });
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const validatedAt = new Date();
      const updated = await tx.capability.update({
        where: { id: capability.id },
        data: {
          enterpriseReviewStatus: "PENDING",
          enterpriseRejectionReason: null,
          validationResult: validation,
          validatedAt,
        },
        select: CONTRIBUTION_CAPABILITY_SELECT,
      });
      if (capability.type === "SKILL") {
        await tx.skillVersion.updateMany({
          where: {
            capabilityId: capability.id,
            scope: "ENTERPRISE",
            status: { in: ["DRAFT", "ENTERPRISE_REJECTED"] },
          },
          data: {
            status: "PENDING_ENTERPRISE_REVIEW",
            submittedAt: validatedAt,
            rejectionReason: null,
            validationResult: validation,
            validatedAt,
          },
        });
      } else if (capability.type === "RPA") {
        await tx.rpaVersion.updateMany({
          where: {
            capabilityId: capability.id,
            status: { in: ["DRAFT", "ENTERPRISE_REJECTED"] },
          },
          data: {
            status: "PENDING_ENTERPRISE_REVIEW",
            submittedAt: validatedAt,
            rejectionReason: null,
            validationResult: validation,
            validatedAt,
          },
        });
      }
      return updated;
    });
    await this.notifyEnterpriseReviewers(
      capability.enterpriseId,
      capability.id,
      `能力「${capability.name}」已提交企业审核，请及时处理。`,
    );
    return result;
  }

  private async recordCapabilityVersionReviews(
    tx: Prisma.TransactionClient,
    versionIds: string[],
    actorType: "ENTERPRISE" | "PLATFORM",
    decision: "APPROVE" | "REJECT",
    reviewerId: string,
    comment?: string,
  ) {
    if (versionIds.length === 0) return;
    await tx.skillVersionReview.createMany({
      data: versionIds.map((versionId) => ({
        versionId,
        actorType,
        decision,
        reviewerId,
        comment,
      })),
    });
  }

  private async recordRpaVersionReviews(
    tx: Prisma.TransactionClient,
    versions: Array<{ id: string; version: string; packageSha256: string }>,
    actorType: "ENTERPRISE" | "PLATFORM",
    decision: "APPROVE" | "REJECT",
    reviewerId: string,
    comment?: string,
  ) {
    if (versions.length === 0) return;
    await tx.rpaVersionReview.createMany({
      data: versions.map((version) => ({
        versionId: version.id,
        actorType,
        decision,
        reviewerId,
        packageVersion: version.version,
        packageSha256: version.packageSha256,
        comment,
      })),
    });
  }

  async reviewEnterprise(
    userId: string,
    capabilityId: string,
    dto: ContributionDecisionDto,
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertCanApprove(ctx);
    const capability = await this.prisma.capability.findFirst({
      where: { id: capabilityId, enterpriseId: ctx.enterpriseId },
    });
    if (!capability) throw new NotFoundException("能力不存在");
    if (capability.enterpriseReviewStatus !== "PENDING")
      throw new ConflictException("只有待企业审核能力可以审核");
    await this.assertCapabilityPackageReviewable(capability.id, capability.type);
    const approved = dto.decision === "APPROVE";
    const rewardsEnabled = approved && await this.setting?.getEffectiveValue("CONTRIBUTION_REWARDS_ENABLED") === "true";
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingSkillVersions = capability.type === "SKILL"
        ? ((await tx.skillVersion.findMany({
            where: {
              capabilityId: capability.id,
              scope: "ENTERPRISE",
              status: "PENDING_ENTERPRISE_REVIEW",
            },
            select: { id: true },
          })) ?? [])
        : [];
      const pendingRpaVersions = capability.type === "RPA"
        ? ((await tx.rpaVersion.findMany({
            where: { capabilityId: capability.id, status: "PENDING_ENTERPRISE_REVIEW" },
            select: { id: true, version: true, packageSha256: true },
          })) ?? [])
        : [];
      const updated = await tx.capability.update({
        where: { id: capability.id },
        data: {
          enterpriseReviewStatus: approved ? "APPROVED" : "REJECTED",
          enterpriseReviewedById: userId,
          enterpriseReviewedAt: new Date(),
          enterpriseRejectionReason: approved ? null : dto.comment,
        },
        select: CONTRIBUTION_CAPABILITY_SELECT,
      });
      if (capability.type === "SKILL") {
        await tx.skillVersion.updateMany({
          where: {
            capabilityId: capability.id,
            scope: "ENTERPRISE",
            status: "PENDING_ENTERPRISE_REVIEW",
          },
          data: {
            status: approved ? "ENTERPRISE_APPROVED" : "ENTERPRISE_REJECTED",
            rejectionReason: approved ? null : dto.comment,
          },
        });
        await this.recordCapabilityVersionReviews(
          tx,
          pendingSkillVersions.map((row) => row.id),
          "ENTERPRISE",
          dto.decision,
          userId,
          dto.comment,
        );
      } else if (capability.type === "RPA") {
        await tx.rpaVersion.updateMany({
          where: {
            capabilityId: capability.id,
            status: "PENDING_ENTERPRISE_REVIEW",
          },
          data: {
            status: approved ? "ENTERPRISE_APPROVED" : "ENTERPRISE_REJECTED",
            rejectionReason: approved ? null : dto.comment,
          },
        });
        await this.recordRpaVersionReviews(
          tx,
          pendingRpaVersions,
          "ENTERPRISE",
          dto.decision,
          userId,
          dto.comment,
        );
      }
      if (rewardsEnabled) {
        await assertActiveRewardRecipientInTx(tx, capability.contributorId);
        const amount = await this.rewardAmount("enterprise");
        const dedupeKey = `enterprise-approved:${capability.id}`;
        await tx.contributionRewardEvent.createMany({
          data: [
            {
              recipientId: capability.contributorId,
              enterpriseId: capability.enterpriseId,
              capabilityId: capability.id,
              eventType: "ENTERPRISE_APPROVED",
              points: 10,
              amount,
              status: "AVAILABLE",
              settledAt: new Date(),
              dedupeKey,
              metadata: { reviewerId: userId, amountCNY: amount.toString() },
            },
          ],
          skipDuplicates: true,
        });
        await creditRewardInTx(
          tx,
          capability.contributorId,
          amount,
          dedupeKey,
          `企业审核通过奖励 ¥${amount.toFixed(2)}`,
        );
      }
      return updated;
    });
    await this.safeNotify({
      userId: capability.contributorId,
      type: approved
        ? "CONTRIBUTION_ENTERPRISE_APPROVED"
        : "CONTRIBUTION_ENTERPRISE_REJECTED",
      category: "APPROVAL",
      title: approved ? "企业审核已通过" : "企业审核未通过",
      message: approved
        ? `能力「${capability.name}」已通过企业审核${rewardsEnabled ? "，奖励已入账" : ""}。`
        : `能力「${capability.name}」未通过企业审核：${dto.comment ?? "请查看审核意见"}`,
      relatedType: "capability",
      relatedId: capability.id,
      actionUrl: `/contributions/${capability.id}`,
    });
    if (rewardsEnabled)
      await this.safeNotify({
        userId: capability.contributorId,
        type: "CONTRIBUTION_REWARD_CREDITED",
        title: "贡献奖励已入账",
        message: `能力「${capability.name}」的企业审核奖励已进入个人钱包。`,
        relatedType: "contribution_reward",
        relatedId: capability.id,
        actionUrl: "/wallet",
      });
    return result;
  }

  async requestPlatformReview(userId: string, capabilityId: string) {
    const capability = await this.getOwnedCapability(userId, capabilityId);
    if (capability.type === "SKILL") {
      throw new ForbiddenException("SKILL 已停用主动投稿平台，请由平台运营选择版本审核");
    }
    if (
      capability.enterpriseId &&
      capability.enterpriseReviewStatus !== "APPROVED"
    ) {
      throw new ConflictException("企业审核通过后才能申请平台审核");
    }
    if (
      !["NOT_SUBMITTED", "REJECTED"].includes(capability.platformReviewStatus)
    ) {
      throw new ConflictException("当前状态不能申请平台审核");
    }
    const validation = await this.validateCapability(
      capability.id,
      capability.type,
    );
    await this.assertCapabilityPackageReviewable(capability.id, capability.type);
    if (!validation.valid)
      throw new BadRequestException({
        message: "自动校验未通过，暂不能申请平台投稿",
        validation,
      });
    const directPlatformSubmission = !capability.enterpriseId;
    const result = await this.prisma.$transaction(async (tx) => {
      const submittedAt = new Date();
      const updated = await tx.capability.update({
        where: { id: capability.id },
        data: {
          platformReviewStatus: directPlatformSubmission
            ? "PENDING_REVIEW"
            : "REQUESTED",
          platformSubmittedById: directPlatformSubmission ? userId : null,
          platformSubmittedAt: directPlatformSubmission ? submittedAt : null,
          platformRejectionReason: null,
          validationResult: validation,
          validatedAt: submittedAt,
        },
        select: CONTRIBUTION_CAPABILITY_SELECT,
      });
      if (capability.type === "RPA" && directPlatformSubmission) {
        await tx.rpaVersion.updateMany({
          where: {
            capabilityId: capability.id,
            status: { in: ["DRAFT", "PLATFORM_REJECTED"] },
          },
          data: {
            status: "PENDING_PLATFORM_REVIEW",
            submittedAt,
            validationResult: validation,
            validatedAt: submittedAt,
            rejectionReason: null,
          },
        });
      }
      return updated;
    });
    if (capability.enterpriseId) {
      await this.notifyEnterpriseReviewers(
        capability.enterpriseId,
        capability.id,
        `能力「${capability.name}」已提交平台公开申请，等待企业管理员授权。`,
      );
    } else {
      await this.notifyPlatformReviewers(
        capability.id,
        `能力「${capability.name}」已提交平台审核，请及时处理。`,
      );
    }
    return result;
  }

  async authorizePlatformSubmission(userId: string, capabilityId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const capability = await this.prisma.capability.findFirst({
      where: { id: capabilityId, enterpriseId: ctx.enterpriseId },
    });
    if (!capability) throw new NotFoundException("能力不存在");
    if (capability.type === "SKILL") {
      throw new ForbiddenException("SKILL 已停用企业授权投稿，请由平台运营选择版本审核");
    }
    if (
      capability.enterpriseReviewStatus !== "APPROVED" ||
      capability.platformReviewStatus !== "REQUESTED"
    ) {
      throw new ConflictException(
        "只有企业审核通过且已发起投稿申请的能力可以授权",
      );
    }
    await this.assertCapabilityPackageReviewable(capability.id, capability.type);
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.capability.update({
        where: { id: capability.id },
        data: {
          platformReviewStatus: "PENDING_REVIEW",
          platformSubmittedById: userId,
          platformSubmittedAt: new Date(),
        },
        select: CONTRIBUTION_CAPABILITY_SELECT,
      });
      if (capability.type === "RPA") {
        await tx.rpaVersion.updateMany({
          where: {
            capabilityId: capability.id,
            status: { in: ["ENTERPRISE_APPROVED", "PLATFORM_REJECTED"] },
          },
          data: {
            status: "PENDING_PLATFORM_REVIEW",
            submittedAt: new Date(),
            rejectionReason: null,
          },
        });
      }
      return updated;
    });
    await this.notifyPlatformReviewers(
      capability.id,
      `企业已授权能力「${capability.name}」投稿平台，请及时审核。`,
    );
    return result;
  }

  async reviewPlatform(
    userId: string,
    capabilityId: string,
    dto: ContributionDecisionDto,
  ) {
    const reviewer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (reviewer?.role !== "ADMIN")
      throw new ForbiddenException("仅平台运营可审核");
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
    });
    if (!capability || capability.platformReviewStatus !== "PENDING_REVIEW")
      throw new ConflictException("只有待平台审核能力可以审核");
    await this.assertCapabilityPackageReviewable(capability.id, capability.type);
    const approved = dto.decision === "APPROVE";
    const rewardsEnabled = approved && await this.setting?.getEffectiveValue("CONTRIBUTION_REWARDS_ENABLED") === "true";
    const result = await this.prisma.$transaction(async (tx) => {
      const pendingSkillVersions = capability.type === "SKILL"
        ? ((await tx.skillVersion.findMany({
            where: {
              capabilityId: capability.id,
              scope: "PLATFORM",
              status: "PENDING_PLATFORM_REVIEW",
            },
            select: { id: true },
          })) ?? [])
        : [];
      const pendingRpaVersions = capability.type === "RPA"
        ? ((await tx.rpaVersion.findMany({
            where: { capabilityId: capability.id, status: "PENDING_PLATFORM_REVIEW" },
            select: { id: true, version: true, packageSha256: true },
          })) ?? [])
        : [];
      const updated = await tx.capability.update({
        where: { id: capability.id },
        data: {
          platformReviewStatus: approved ? "APPROVED" : "REJECTED",
          visibility: approved ? "MARKET_PUBLIC" : "ENTERPRISE_PRIVATE",
          status: approved ? "APPROVED" : "REJECTED",
          platformRejectionReason: approved ? null : dto.comment,
        },
        select: CONTRIBUTION_CAPABILITY_SELECT,
      });
      if (capability.type === "SKILL") {
        await tx.skillVersion.updateMany({
          // 只作用在平台副本上。企业投稿与个人直投现在都产出 scope=PLATFORM 的行，
          // 少了这个 scope 约束，企业那行会被改成 PLATFORM_APPROVED —— 于是出现
          // 「MARKET_PUBLIC 的能力一个平台版本都没有」，别的企业订阅后拿不到正文。
          where: {
            capabilityId: capability.id,
            scope: "PLATFORM",
            status: "PENDING_PLATFORM_REVIEW",
          },
          data: {
            status: approved ? "PLATFORM_APPROVED" : "PLATFORM_REJECTED",
            rejectionReason: approved ? null : dto.comment,
          },
        });
        await this.recordCapabilityVersionReviews(
          tx,
          pendingSkillVersions.map((row) => row.id),
          "PLATFORM",
          dto.decision,
          userId,
          dto.comment,
        );
      }
      if (capability.type === "RPA") {
        await tx.rpaVersion.updateMany({
          where: {
            capabilityId: capability.id,
            status: "PENDING_PLATFORM_REVIEW",
          },
          data: {
            status: approved ? "PLATFORM_APPROVED" : "PLATFORM_REJECTED",
            rejectionReason: approved ? null : dto.comment,
          },
        });
        await this.recordRpaVersionReviews(
          tx,
          pendingRpaVersions,
          "PLATFORM",
          dto.decision,
          userId,
          dto.comment,
        );
      }
      if (rewardsEnabled) {
        await assertActiveRewardRecipientInTx(tx, capability.contributorId);
        const amount = await this.rewardAmount("platform");
        const dedupeKey = `platform-approved:${capability.id}`;
        await tx.contributionRewardEvent.createMany({
          data: [
            {
              recipientId: capability.contributorId,
              enterpriseId: capability.enterpriseId,
              capabilityId: capability.id,
              eventType: "PLATFORM_APPROVED",
              points: 50,
              amount,
              status: "AVAILABLE",
              settledAt: new Date(),
              dedupeKey,
              metadata: { reviewerId: userId, amountCNY: amount.toString() },
            },
          ],
          skipDuplicates: true,
        });
        await creditRewardInTx(
          tx,
          capability.contributorId,
          amount,
          dedupeKey,
          `平台审核通过奖励 ¥${amount.toFixed(2)}`,
        );
      }
      return updated;
    });
    await this.safeNotify({
      userId: capability.contributorId,
      type: approved
        ? "CONTRIBUTION_PLATFORM_APPROVED"
        : "CONTRIBUTION_PLATFORM_REJECTED",
      category: "APPROVAL",
      title: approved ? "平台审核已通过" : "平台审核未通过",
      message: approved
        ? `能力「${capability.name}」已公开${rewardsEnabled ? "，奖励已入账" : ""}。`
        : `能力「${capability.name}」未通过平台审核：${dto.comment ?? "请查看审核意见"}`,
      relatedType: "capability",
      relatedId: capability.id,
      actionUrl: `/contributions/${capability.id}`,
    });
    if (rewardsEnabled)
      await this.safeNotify({
        userId: capability.contributorId,
        type: "CONTRIBUTION_REWARD_CREDITED",
        title: "贡献奖励已入账",
        message: `能力「${capability.name}」的平台审核奖励已进入个人钱包。`,
        relatedType: "contribution_reward",
        relatedId: capability.id,
        actionUrl: "/wallet",
      });
    return result;
  }

  /** 旧 Web 迭代入口保留路由，但不再接受正文或包替换。 */
  async createSkillVersion(
    userId: string,
    capabilityId: string,
    _dto: ContributionVersionCreateDto,
  ) {
    const capability = await this.getOwnedCapability(userId, capabilityId);
    if (capability.type !== "SKILL")
      throw new BadRequestException("只有 Skill 支持版本迭代");
    throw new ForbiddenException("SKILL Web 版本创建已停用，请通过客户端提交修改");
  }

  async getVersionForAuthor(userId: string, versionId: string) {
    const version = await this.prisma.skillVersion.findFirst({
      where: {
        id: versionId,
        scope: { not: "PERSONAL" },
        capability: { contributorId: userId },
      },
      select: {
        ...AUTHOR_VERSION_SELECT,
        content: true,
        rejectionReason: true,
        validationResult: true,
        validatedAt: true,
        updatedAt: true,
        reviews: {
          orderBy: { createdAt: "desc" },
          select: VERSION_REVIEW_SELECT,
        },
        capability: {
          select: { id: true, name: true, description: true, visibility: true },
        },
      },
    });
    if (!version) throw new NotFoundException("版本不存在或无权访问");
    return version;
  }

  /**
   * 返回版本与其父版本的审阅对比。
   *
   * 待审正文只对投稿人、所属企业管理员和平台管理员开放；普通用户即使知道
   * versionId 也不能通过这个接口探测尚未发布的 Skill 内容。
   */
  async getVersionDiff(userId: string, versionId: string, requestRole?: string) {
    const version = await this.prisma.skillVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        capabilityId: true,
        scope: true,
        enterpriseId: true,
        parentVersionId: true,
        sourceVersionId: true,
        version: true,
        content: true,
        changeSummary: true,
        status: true,
        rejectionReason: true,
        submittedAt: true,
        createdAt: true,
        updatedAt: true,
        createdById: true,
        capability: {
          select: {
            name: true,
            contributorId: true,
          },
        },
        parentVersion: {
          select: { id: true, version: true, content: true },
        },
        sourceVersion: {
          select: { enterpriseId: true },
        },
        reviews: {
          orderBy: { createdAt: "desc" },
          select: VERSION_REVIEW_SELECT,
        },
      },
    });
    if (!version) throw new NotFoundException("版本不存在");

    let allowed = version.capability.contributorId === userId;
    if (!allowed && requestRole === "ADMIN") allowed = true;
    if (!allowed && !requestRole) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      allowed = user?.role === "ADMIN";
    }
    if (!allowed) {
      const ctx = await this.enterpriseContext.resolveOrNull(userId);
      allowed = Boolean(
        ctx?.role === "ENTERPRISE_ADMIN" &&
          (version.enterpriseId === ctx.enterpriseId ||
            version.sourceVersion?.enterpriseId === ctx.enterpriseId),
      );
    }
    if (!allowed) throw new NotFoundException("版本不存在或无权访问");

    return {
      version: {
        id: version.id,
        capabilityId: version.capabilityId,
        capabilityName: version.capability.name,
        scope: version.scope,
        enterpriseId: version.enterpriseId,
        parentVersionId: version.parentVersionId,
        sourceVersionId: version.sourceVersionId,
        version: version.version,
        changeSummary: version.changeSummary,
        status: version.status,
        rejectionReason: version.rejectionReason,
        submittedAt: version.submittedAt,
        createdAt: version.createdAt,
        updatedAt: version.updatedAt,
      },
      parent: version.parentVersion
        ? {
            id: version.parentVersion.id,
            version: version.parentVersion.version,
            content: version.parentVersion.content,
          }
        : null,
      current: { id: version.id, version: version.version, content: version.content },
      changed: version.parentVersion
        ? version.parentVersion.content !== version.content
        : true,
      reviews: version.reviews,
    };
  }

  /** 企业管理员审核单个企业 Skill 版本；审核记录与版本状态同事务写入。 */
  async reviewEnterpriseVersion(
    userId: string,
    versionId: string,
    dto: ContributionDecisionDto,
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertCanApprove(ctx);
    const version = await this.prisma.skillVersion.findFirst({
      where: {
        id: versionId,
        scope: "ENTERPRISE",
        enterpriseId: ctx.enterpriseId,
      },
      select: {
        id: true,
        capabilityId: true,
        status: true,
        createdById: true,
        version: true,
        packageSha256: true,
        capability: { select: { name: true, visibility: true } },
      },
    });
    if (!version) throw new NotFoundException("版本不存在");
    if (version.status !== "PENDING_ENTERPRISE_REVIEW") {
      throw new ConflictException("只有待企业审核版本可以审核");
    }
    if (version.packageSha256) {
      await this.security?.assertReviewable(version.packageSha256, "SKILL");
    }
    const approved = dto.decision === "APPROVE";
    const updated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.skillVersion.update({
        where: { id: version.id },
        data: {
          status: approved ? "ENTERPRISE_APPROVED" : "ENTERPRISE_REJECTED",
          enterpriseReviewedById: userId,
          enterpriseReviewedAt: new Date(),
          rejectionReason: approved ? null : dto.comment,
        },
        select: AUTHOR_VERSION_SELECT,
      });
      await tx.skillVersionReview.create({
        data: {
          versionId: version.id,
          actorType: "ENTERPRISE",
          decision: dto.decision,
          reviewerId: userId,
          comment: dto.comment,
        },
      });
      // 企业审核只记录企业结果；平台是否选审由运营独立决定。
      return updated;
    });
    await this.safeNotify({
      userId: version.createdById,
      type: approved
        ? "CONTRIBUTION_ENTERPRISE_APPROVED"
        : "CONTRIBUTION_ENTERPRISE_REJECTED",
      category: "APPROVAL",
      title: approved ? "Skill 版本企业审核已通过" : "Skill 版本企业审核未通过",
      message: approved
        ? `Skill v${version.version} 已通过企业审核。`
        : `Skill v${version.version} 未通过企业审核：${dto.comment ?? "请查看审核意见"}`,
      relatedType: "skill_version",
      relatedId: version.id,
      actionUrl: `/contributions/${version.capabilityId}`,
    });
    return updated;
  }

  /** 平台管理员审核单个平台 Skill 版本；不重复发放能力首次发布奖励。 */
  async reviewPlatformVersion(
    userId: string,
    versionId: string,
    dto: ContributionDecisionDto,
  ) {
    const reviewer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (reviewer?.role !== "ADMIN") {
      throw new ForbiddenException("仅平台运营可审核");
    }
    const version = await this.prisma.skillVersion.findFirst({
      where: { id: versionId, scope: "PLATFORM" },
      select: {
        id: true,
        capabilityId: true,
        status: true,
        createdById: true,
        version: true,
        packageSha256: true,
      },
    });
    if (!version) throw new NotFoundException("版本不存在");
    if (version.status !== "PENDING_PLATFORM_REVIEW") {
      throw new ConflictException("只有待平台审核版本可以审核");
    }
    if (version.packageSha256) {
      await this.security?.assertReviewable(version.packageSha256, "SKILL");
    }
    const approved = dto.decision === "APPROVE";
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.skillVersion.update({
        where: { id: version.id },
        data: {
          status: approved ? "PLATFORM_APPROVED" : "PLATFORM_REJECTED",
          platformReviewedById: userId,
          platformReviewedAt: new Date(),
          rejectionReason: approved ? null : dto.comment,
        },
        select: AUTHOR_VERSION_SELECT,
      });
      await tx.skillVersionReview.create({
        data: {
          versionId: version.id,
          actorType: "PLATFORM",
          decision: dto.decision,
          reviewerId: userId,
          comment: dto.comment,
        },
      });
      if (approved && tx.employeeCapabilityBinding?.updateMany) {
        await tx.employeeCapabilityBinding.updateMany({
          where: {
            capabilityId: version.capabilityId,
            defaultSkillVersion: { scope: "PLATFORM" },
            NOT: { defaultSkillVersionId: version.id },
          },
          data: { defaultSkillVersionId: version.id },
        });
      }
      return updated;
    });
    await this.safeNotify({
      userId: version.createdById,
      type: approved
        ? "CONTRIBUTION_PLATFORM_APPROVED"
        : "CONTRIBUTION_PLATFORM_REJECTED",
      category: "APPROVAL",
      title: approved ? "Skill 版本平台审核已通过" : "Skill 版本平台审核未通过",
      message: approved
        ? `Skill v${version.version} 已通过平台审核。`
        : `Skill v${version.version} 未通过平台审核：${dto.comment ?? "请查看审核意见"}`,
      relatedType: "skill_version",
      relatedId: version.id,
      actionUrl: `/contributions/${version.capabilityId}`,
    });
    return result;
  }

  /** 历史贡献正文保持只读；不接受正文改写或包替换。 */
  async updateVersion(
    userId: string,
    versionId: string,
    _dto: ContributionVersionUpdateDto,
  ) {
    await this.getEditableVersion(userId, versionId);
    throw new ForbiddenException("SKILL Web 正文编辑已停用，请通过客户端提交修改");
  }

  /** 客户端完整正文提交走独立接口，旧贡献草稿不再从 Web 发布。 */
  async submitVersion(userId: string, versionId: string) {
    await this.getEditableVersion(userId, versionId);
    throw new ForbiddenException("SKILL Web 版本提交已停用，请通过客户端提交修改");
  }

  /** 作者名下、且处于可编辑状态（草稿或被驳回）的版本。 */
  private async getEditableVersion(userId: string, versionId: string) {
    const version = await this.prisma.skillVersion.findFirst({
      where: {
        id: versionId,
        scope: { not: "PERSONAL" },
        capability: { contributorId: userId },
      },
    });
    if (!version) throw new NotFoundException("版本不存在或无权访问");
    const editable: SkillVersionStatus[] = [
      "DRAFT",
      "ENTERPRISE_REJECTED",
      "PLATFORM_REJECTED",
    ];
    if (!editable.includes(version.status)) {
      throw new ConflictException("只有草稿或被驳回的版本可以修改");
    }
    return version;
  }


  /** 已发布能力市场检索。只返回通过平台审核且可安装/下载的版本。 */
  async searchMarket(input: {
    q?: string;
    type?: string;
    industry?: string;
    position?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const q = input.q?.trim();
    const publishedFilter: Prisma.CapabilityWhereInput = {
      OR: [
        { visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED' },
        { enterpriseId: null, status: 'APPROVED' },
      ],
    };
    const where: Prisma.CapabilityWhereInput = {
      AND: [
        publishedFilter,
        ...(q ? [{
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { description: { contains: q, mode: 'insensitive' as const } },
          ],
        }] : []),
      ],
      ...(input.type ? { type: input.type.toUpperCase() as CapabilityType } : {}),
      ...(input.industry ? { industry: { has: input.industry } } : {}),
      ...(input.position ? { position: { has: input.position } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.capability.count({ where }),
      this.prisma.capability.findMany({
        where,
        orderBy: [{ usageCount: 'desc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, name: true, description: true, type: true,
          industry: true, position: true, usageCount: true, rating: true,
          visibility: true, platformReviewStatus: true, updatedAt: true,
          contributor: { select: { id: true, name: true } },
          skillVersions: {
            where: { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
            orderBy: [
              { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
            take: 1,
            select: { id: true, version: true, packageSha256: true, packageFilename: true },
          },
          rpaVersions: {
            where: { status: 'PLATFORM_APPROVED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, version: true, packageSha256: true, packageFilename: true },
          },
        },
      }),
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        install: item.type === 'SKILL' && item.skillVersions[0]
          ? { versionId: item.skillVersions[0].id, endpoint: `/contributions/versions/${item.skillVersions[0].id}/package` }
          : null,
        download: item.type === 'RPA' && item.rpaVersions[0]
          ? { versionId: item.rpaVersions[0].id, endpoint: `/contributions/${item.id}/rpa-package?versionId=${encodeURIComponent(item.rpaVersions[0].id)}` }
          : null,
      })),
      total, page, limit, totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /** 投稿后显式绑定到已有数字员工；不自动创建员工，也不允许绑定未发布版本。 */
  async bindPublishedCapability(userId: string, capabilityId: string, employeeId: string, priority?: number) {
    const [capability, employee] = await Promise.all([
      this.prisma.capability.findFirst({
        where: { id: capabilityId, OR: [
          { visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED' },
          { enterpriseId: null, status: 'APPROVED' },
        ] },
        select: { id: true, type: true },
      }),
      this.prisma.digitalEmployee.findUnique({ where: { id: employeeId }, select: { id: true } }),
    ]);
    if (!capability || !employee) throw new NotFoundException('已发布能力或数字员工不存在');
    try {
      const binding = await this.prisma.employeeCapabilityBinding.create({
        data: {
          employeeId, capabilityId,
          priority: priority ?? 0,
          defaultSkillVersionId: capability.type === 'SKILL'
            ? (await this.prisma.skillVersion.findFirst({
                where: { capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
                orderBy: [
                  { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
                  { createdAt: 'desc' },
                  { id: 'desc' },
                ],
                select: { id: true },
              }))?.id
            : undefined,
        },
        include: { capability: { select: { id: true, name: true, type: true, description: true } } },
      });
      await this.recordDownloadAudit({
        actorId: userId,
        action: 'CONTRIBUTION_BIND_EMPLOYEE',
        resourceType: 'CAPABILITY', resourceId: capabilityId,
        metadata: { employeeId, priority: priority ?? 0 },
      });
      return binding;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('能力已绑定到该数字员工');
      throw error;
    }
  }

  async productionMetrics(days = 30) {
    const since = new Date(Date.now() - Math.min(90, Math.max(1, days)) * 86_400_000);
    const [audit, reviews, notifications, scans] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { createdAt: { gte: since }, action: { startsWith: 'CONTRIBUTION_' } }, select: { action: true, result: true, createdAt: true, metadata: true } }),
      this.prisma.skillVersionReview.findMany({ where: { createdAt: { gte: since } }, select: { actorType: true, decision: true, comment: true, createdAt: true } }),
      this.prisma.notification.count({ where: { createdAt: { gte: since }, category: 'APPROVAL' } }),
      this.security?.metrics() ?? Promise.resolve(null),
    ]);
    const downloads = audit.filter((row) => row.action.endsWith('_DOWNLOAD'));
    const byAction = downloads.reduce<Record<string, number>>((out, row) => {
      out[row.action] = (out[row.action] ?? 0) + 1;
      return out;
    }, {});
    const rejected = reviews.filter((row) => row.decision === 'REJECT');
    const reasons = Object.entries(rejected.reduce<Record<string, number>>((out, row) => {
      const reason = row.comment?.trim() || '未填写原因'; out[reason] = (out[reason] ?? 0) + 1; return out;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 20);
    return {
      windowDays: Math.min(90, Math.max(1, days)),
      downloads: { authorizedRequestsByAction: byAction, totalAuthorizedRequests: downloads.length },
      review: { total: reviews.length, rejected: rejected.length, rejectionReasons: reasons },
      approvalNotifications: notifications,
      security: scans,
    };
  }

  async rewards(userId: string) {
    return this.prisma.contributionRewardEvent.findMany({
      where: { recipientId: userId },
      select: {
        id: true,
        eventType: true,
        points: true,
        amount: true,
        status: true,
        dedupeKey: true,
        metadata: true,
        createdAt: true,
        settledAt: true,
        capability: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async listPlatformQueue(
    status: ContributionPlatformStatus = "PENDING_REVIEW",
    page = 1,
    pageSize = 20,
    keyword?: string,
  ) {
    const normalizedKeyword = keyword?.trim();
    const where: Prisma.CapabilityWhereInput = {
      platformReviewStatus: status,
      ...(normalizedKeyword ? {
        OR: [
          { name: { contains: normalizedKeyword, mode: 'insensitive' } },
          { description: { contains: normalizedKeyword, mode: 'insensitive' } },
          { enterprise: { name: { contains: normalizedKeyword, mode: 'insensitive' } } },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.capability.findMany({
        where,
        select: CONTRIBUTION_PLATFORM_LIST_SELECT,
        orderBy: [{ platformSubmittedAt: "desc" }, { updatedAt: "desc" }],
        skip: Math.max(0, page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.capability.count({ where }),
    ]);
    return { items, total, page, pageSize, status };
  }

  async listUnifiedReviewQueue(
    kind: "ALL" | "CAPABILITY" | "SKILL_VERSION" = "ALL",
  ) {
    const [capabilities, versions] = await Promise.all([
      kind === "SKILL_VERSION"
        ? Promise.resolve([])
        : this.prisma.capability.findMany({
            where: { platformReviewStatus: "PENDING_REVIEW" },
            select: {
              id: true,
              name: true,
              type: true,
              platformReviewStatus: true,
              platformSubmittedAt: true,
              enterprise: { select: { id: true, name: true } },
              platformSubmittedBy: {
                select: { id: true, name: true, email: true },
              },
              contributor: { select: { id: true, name: true, email: true } },
            },
            orderBy: { platformSubmittedAt: "asc" },
          }),
      kind === "CAPABILITY"
        ? Promise.resolve([])
        : this.prisma.skillVersion.findMany({
            where: { status: "PENDING_PLATFORM_REVIEW" },
            // sourceVersion.enterprise 是投稿版本的来源企业。
            // 企业投稿时创建的是 scope=PLATFORM 的新版本，它自身 enterpriseId 为空
            // （它要成为公共版本），来源企业只能顺着 sourceVersionId 往回查 ——
            // 否则运营在审核队列里看到的一律是「个人贡献」，分不清是谁投的。
            select: {
              id: true,
              capabilityId: true,
              version: true,
              status: true,
              submittedAt: true,
              capability: { select: { name: true } },
              enterprise: { select: { id: true, name: true } },
              sourceVersion: {
                select: { enterprise: { select: { id: true, name: true } } },
              },
              createdBy: { select: { id: true, name: true, email: true } },
            },
            orderBy: { submittedAt: "asc" },
          }),
    ]);
    const items = [
      ...capabilities.map((item) => ({
        kind: "CAPABILITY" as const,
        id: item.id,
        capabilityId: item.id,
        capabilityName: item.name,
        name: item.name,
        type: item.type,
        version: null,
        status: item.platformReviewStatus,
        submittedAt: item.platformSubmittedAt,
        enterprise: item.enterprise,
        submittedBy: item.platformSubmittedBy ?? item.contributor,
      })),
      ...versions.map((item) => ({
        kind: "SKILL_VERSION" as const,
        id: item.id,
        capabilityId: item.capabilityId,
        capabilityName: item.capability.name,
        name: `${item.capability.name} v${item.version}`,
        type: "SKILL" as const,
        version: item.version,
        status: item.status,
        submittedAt: item.submittedAt,
        enterprise: item.enterprise ?? item.sourceVersion?.enterprise ?? null,
        submittedBy: item.createdBy,
      })),
    ].sort((a, b) => +(a.submittedAt ?? 0) - +(b.submittedAt ?? 0));
    return { items, total: items.length };
  }


  async getRpaVersionPreview(versionId: string) {
    const version = await this.prisma.rpaVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true, version: true, packageKey: true, packageSha256: true,
        packageFilename: true, packageFileCount: true, packageBytes: true,
        configDoc: true, status: true, validationResult: true,
        capability: { select: { id: true, name: true, description: true, enterpriseId: true } },
      },
    });
    if (!version) throw new NotFoundException('RPA 版本不存在');
    if (!this.rpaPackage) throw new BadRequestException('RPA 包服务暂不可用');
    const parsed = await this.rpaPackage.read(version.packageSha256);
    return {
      ...version,
      packageKey: undefined,
      files: parsed.files,
      security: await this.security?.getScan(version.packageSha256, 'RPA') ?? null,
    };
  }

  async getPlatformSubmission(capabilityId: string) {
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
      select: CONTRIBUTION_PLATFORM_DETAIL_SELECT,
    });
    if (!capability) throw new NotFoundException("能力不存在");
    return capability;
  }

  /** 返回已审核版本的 RPA 包下载信息。 */
  async getRpaPackage(
    userId: string,
    capabilityId: string,
    versionId?: string,
    auditContext?: DownloadAuditContext,
  ) {
    const ctx = await this.enterpriseContext.resolveOrNull(userId);
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
      select: {
        id: true,
        name: true,
        type: true,
        contributorId: true,
        enterpriseId: true,
        visibility: true,
        enterpriseReviewStatus: true,
        platformReviewStatus: true,
      },
    });
    if (!capability || capability.type !== "RPA") {
      throw new NotFoundException("RPA 包不存在");
    }

    const publicReady =
      capability.visibility === "MARKET_PUBLIC" &&
      capability.platformReviewStatus === "APPROVED";
    const enterpriseReady = Boolean(
      ctx?.enterpriseId &&
        capability.enterpriseId === ctx.enterpriseId &&
        capability.enterpriseReviewStatus === "APPROVED",
    );
    const authorReady =
      capability.contributorId === userId && (publicReady || enterpriseReady);
    if (!publicReady && !enterpriseReady && !authorReady) {
      throw new NotFoundException("RPA 包不存在或无权下载");
    }

    const allowedStatuses: RpaVersionStatus[] = publicReady
      ? [RpaVersionStatus.PLATFORM_APPROVED]
      : enterpriseReady || authorReady
        ? [RpaVersionStatus.ENTERPRISE_APPROVED, RpaVersionStatus.PLATFORM_APPROVED]
        : [];
    const version = await this.prisma.rpaVersion.findFirst({
      where: {
        ...(versionId ? { id: versionId } : { capabilityId }),
        capabilityId,
        status: { in: allowedStatuses },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        version: true,
        packageKey: true,
        packageSha256: true,
        packageFilename: true,
      },
    });
    if (!version) throw new NotFoundException("RPA 版本不存在或无权下载");

    const expectedKey = `rpa/${version.packageSha256}.zip`;
    if (
      !/^[0-9a-f]{64}$/.test(version.packageSha256) ||
      version.packageKey !== expectedKey
    ) {
      throw new NotFoundException("RPA 包存储信息无效");
    }
    await this.security?.assertDownloadable(version.packageSha256, "RPA");
    await this.recordDownloadAudit({
      actorId: userId,
      action: "CONTRIBUTION_RPA_DOWNLOAD",
      resourceType: "RPA_VERSION",
      resourceId: version.id,
      enterpriseId: capability.enterpriseId,
      metadata: {
        versionId: version.id,
        version: version.version,
        sha256: version.packageSha256,
        filename: version.packageFilename || `${capability.name}.zip`,
        visibility: capability.visibility,
        ...this.downloadRequestMetadata(auditContext),
      },
    });
    return {
      key: version.packageKey,
      sha256: version.packageSha256,
      version: version.version,
      filename: version.packageFilename || `${capability.name}.zip`,
    };
  }

  /**
   * 返回 Skill 版本包下载信息。
   *
   * 下载权限按版本状态判定，而不是按「是否是贡献者」判定：
   * - 平台公开版本：任何已登录用户可下载；
   * - 企业私有版本：同企业成员可下载；
   * - 贡献者本人：可下载自己已经通过对应审核的版本，便于回收与自检；
   * - 草稿、审核中、驳回版本永远不能通过这个客户端入口下载。
   */
  async getVersionPackage(
    userId: string,
    versionId: string,
    userRole?: string,
    auditContext?: DownloadAuditContext,
  ) {
    const ctx = await this.enterpriseContext.resolveOrNull(userId);
    const version = await this.prisma.skillVersion.findUnique({
      where: { id: versionId },
      select: {
        packageKey: true,
        packageSha256: true,
        packageFilename: true,
        version: true,
        scope: true,
        status: true,
        capability: {
          select: {
            id: true,
            name: true,
            contributorId: true,
            enterpriseId: true,
            visibility: true,
            enterpriseReviewStatus: true,
            platformReviewStatus: true,
          },
        },
      },
    });
    if (!version || !version.capability)
      throw new NotFoundException("版本不存在或无权访问");
    if (!version.packageKey || !version.packageSha256) {
      throw new NotFoundException("该版本是在线编写的正文，没有可下载的包");
    }

    const platformReady =
      version.scope === "PLATFORM" &&
      version.status === "PLATFORM_APPROVED" &&
      version.capability.visibility === "MARKET_PUBLIC" &&
      version.capability.platformReviewStatus === "APPROVED";
    const enterpriseReady = Boolean(
      version.scope === "ENTERPRISE" &&
      version.status === "ENTERPRISE_APPROVED" &&
      ctx?.enterpriseId &&
      ctx.enterpriseId === version.capability.enterpriseId &&
      version.capability.enterpriseReviewStatus === "APPROVED",
    );
    const authorReady =
      version.capability.contributorId === userId &&
      (version.status === "ENTERPRISE_APPROVED" ||
        version.status === "PLATFORM_APPROVED");
    const platformAdminReady =
      userRole === "ADMIN" &&
      (version.status === "ENTERPRISE_APPROVED" ||
        version.status === "PLATFORM_APPROVED");
    if (
      !platformReady &&
      !enterpriseReady &&
      !authorReady &&
      !platformAdminReady
    ) {
      throw new NotFoundException("版本不存在或无权访问");
    }

    if (
      !/^[0-9a-f]{64}$/.test(version.packageSha256) ||
      version.packageKey !== `skills/${version.packageSha256}.zip`
    ) {
      throw new NotFoundException("Skill 包存储信息无效");
    }
    const filename =
      version.packageFilename ||
      `${version.capability.name}-v${version.version}.zip`;
    await this.security?.assertDownloadable(version.packageSha256, 'SKILL');
    await this.recordDownloadAudit({
      actorId: userId,
      action: "CONTRIBUTION_SKILL_DOWNLOAD",
      resourceType: "SKILL_VERSION",
      resourceId: versionId,
      enterpriseId: version.capability.enterpriseId,
      metadata: {
        sha256: version.packageSha256,
        version: version.version,
        scope: version.scope,
        visibility: version.capability.visibility,
        filename,
        ...this.downloadRequestMetadata(auditContext),
      },
    });
    return {
      key: version.packageKey,
      sha256: version.packageSha256,
      version: version.version,
      filename,
    };
  }

  private async recordDownloadAudit(input: {
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    enterpriseId?: string | null;
    metadata: Record<string, unknown>;
  }) {
    if (!this.audit) return;
    try {
      await this.audit.record({
        actorId: input.actorId,
        enterpriseId: input.enterpriseId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        summary: "能力包下载成功",
        metadata: input.metadata,
      });
    } catch (error) {
      // 审计系统短暂不可用时不能把已经授权的包下载变成 5xx；AuditService 自身已负责重试，
      // 这里记录告警，后续由监控发现审计写入异常。
      this.logger.warn(
        `能力包下载审计写入失败: ${(error as Error)?.message ?? String(error)}`,
      );
    }
  }

  private downloadRequestMetadata(context?: DownloadAuditContext) {
    return {
      ...(context?.ip ? { ip: context.ip.slice(0, 128) } : {}),
      ...(context?.userAgent
        ? { userAgent: context.userAgent.slice(0, 256) }
        : {}),
    };
  }

  /**
   * 把「上传包」与「在线编写」两条正文来源归一。
   * 上传路径只信 sha256：正文从磁盘上那份字节重新提取，客户端回传的正文一律不采纳。
   */
  private async resolveRpaSource(sha256: string, filename?: string) {
    if (!this.rpaPackage) throw new BadRequestException("RPA 包服务暂不可用");
    const stored = await this.rpaPackage.read(sha256);
    return {
      sha256: stored.sha256,
      key: stored.key,
      filename: filename ?? stored.filename,
      fileCount: stored.fileCount,
      totalBytes: stored.totalBytes,
    };
  }

  private async getOwnedCapability(userId: string, capabilityId: string) {
    const capability = await this.prisma.capability.findFirst({
      where: { id: capabilityId, contributorId: userId },
    });
    if (!capability) throw new NotFoundException("能力不存在或无权访问");
    return capability;
  }

  private async assertCapabilityPackageReviewable(
    capabilityId: string,
    type: CapabilityType,
  ) {
    if (!this.security || (type !== "SKILL" && type !== "RPA")) return;
    if (type === "SKILL") {
      const versions = await this.prisma.skillVersion.findMany({
        where: {
          capabilityId,
          scope: { not: "PERSONAL" },
          packageSha256: { not: null },
          status: {
            in: [
              "DRAFT",
              "PENDING_ENTERPRISE_REVIEW",
              "ENTERPRISE_REJECTED",
              "ENTERPRISE_APPROVED",
              "PENDING_PLATFORM_REVIEW",
              "PLATFORM_REJECTED",
            ],
          },
        },
        select: { packageSha256: true },
      });
      for (const version of versions ?? []) {
        if (version.packageSha256) {
          await this.security.assertReviewable(version.packageSha256, "SKILL");
        }
      }
      return;
    }
    const versions = await this.prisma.rpaVersion.findMany({
      where: {
        capabilityId,
        status: {
          in: [
            "DRAFT",
            "PENDING_ENTERPRISE_REVIEW",
            "ENTERPRISE_REJECTED",
            "ENTERPRISE_APPROVED",
            "PENDING_PLATFORM_REVIEW",
            "PLATFORM_REJECTED",
          ],
        },
      },
      select: { packageSha256: true },
    });
    for (const version of versions ?? []) {
      await this.security.assertReviewable(version.packageSha256, "RPA");
    }
  }

  private async validateCapability(capabilityId: string, type: CapabilityType) {
    if (type === "SKILL") {
      const version = await this.prisma.skillVersion.findFirst({
        // 个人能力使用 PLATFORM 快照，企业能力在企业审核通过后使用
        // ENTERPRISE_APPROVED 快照；平台驳回后两条路径都允许重新投稿。
        where: {
          capabilityId,
          status: {
            in: [
              "DRAFT",
              "ENTERPRISE_REJECTED",
              "ENTERPRISE_APPROVED",
              "PLATFORM_REJECTED",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      });
      return this.validator.validateSkill(version?.content ?? "");
    }
    if (type === "RPA") {
      const config = await this.prisma.rPAConfig.findUnique({
        where: { capabilityId },
        select: {
          platform: true,
          executionMode: true,
          packageSha256: true,
          configDoc: true,
        },
      });
      return this.validator.validateRpa(config);
    }
    const config = await this.prisma.agentConfig.findUnique({
      where: { capabilityId },
      select: {
        platform: true,
        botId: true,
        workflowUrl: true,
        skillName: true,
      },
    });
    return this.validator.validateAgent(
      config ?? {
        platform: "" as never,
        botId: null,
        workflowUrl: null,
        skillName: null,
      },
    );
  }
}
