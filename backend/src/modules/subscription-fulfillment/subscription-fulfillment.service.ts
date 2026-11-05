import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { assertActiveEnterpriseInTx } from '../../common/enterprise-write-lock';

export interface FulfillSubscriptionParams {
  enterpriseId: string;
  employeeId: string;
  /** 履约后自动获得使用权的成员（企业管理员）。 */
  purchaserMemberId: string;
  /** 企业内展示名称。为空则回落员工模板名。 */
  displayName?: string | null;
  startDate?: Date;
  /** null = 无固定到期日（直接订阅），有值 = 按周期到期（市场订单）。 */
  endDate?: Date | null;
  /** 额度来源，写进 SubscriptionCredit.sourceType 便于对账。 */
  sourceType: 'subscription' | 'order';
  sourceId?: string | null;
  /** 实际成交金额快照；市场订单和直接订阅都必须显式传入。 */
  purchaseAmountCNY?: number;
  purchasePeriodMonths?: number;
  /** 下单时锁定的员工模板版本；未提供时取履约时当前版本。 */
  templateVersion?: string;
  /**
   * 赠送金额（元）。**由调用方显式传入**：市场订单要用下单时的快照，
   * 直接订阅要用当前员工配置，两者不能在这里替对方猜。
   * 省略时才回落「员工级配置 > 系统默认值」。
   */
  grantedCNY?: number;
  config?: Prisma.InputJsonValue;
}

export interface FulfillSubscriptionResult {
  subscriptionId: string;
  /** 是否是本次新建（false = 复活/重复履约） */
  created: boolean;
  grantedCNY: number;
  creditId: string;
}

/**
 * 订阅履约的**唯一入口**。直接订阅与市场支付都走这里。
 *
 * 收敛的理由：两条链路以前各写一份「建订阅 + 自动授权 + 发赠送额度」，
 * 结果市场支付走的是旧 ComputeAccount 充值、直接订阅走的是硬编码 Token 配额，
 * 同一件事产出两种账务结果。任何新增的履约副作用都必须加在这里，
 * 而不是在某一条链路里补一段。
 *
 * 所有方法都要求调用方传入事务客户端：履约的三件事（订阅生效、授权、赠送额度）
 * 必须同时成立，缺一件都会让企业「买了但用不了」或「用了但没额度」。
 */
@Injectable()
export class SubscriptionFulfillmentService {
  private readonly logger = new Logger(SubscriptionFulfillmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: ComputeCreditService,
  ) {}

  /**
   * 解析某员工的「订阅赠送算力（元）」生效值：员工级金额 > 年费默认比例 > 默认金额。
   *
   * 下单和加购物车时都要用它算快照 —— 展示金额与最终入账金额必须同源，
   * 否则用户在购物车看到 ¥1000、履约却拿到 ¥0。
   */
  async resolveGiftCNY(
    employeeOverride: Prisma.Decimal | number | null | undefined,
    annualPriceCNY?: Prisma.Decimal | number | null,
  ): Promise<number> {
    return this.credits.resolveGrantAmountCNY(employeeOverride, annualPriceCNY);
  }

  async fulfill(
    tx: Prisma.TransactionClient,
    params: FulfillSubscriptionParams,
  ): Promise<FulfillSubscriptionResult> {
    await assertActiveEnterpriseInTx(tx, params.enterpriseId);
    const employee = await tx.digitalEmployee.findUnique({
      where: { id: params.employeeId },
      select: {
        id: true,
        name: true,
        version: true,
        includedComputeCNY: true,
        annualPriceCNY: true,
      },
    });
    if (!employee) {
      throw new NotFoundException(`员工 ${params.employeeId} 不存在`);
    }

    const startDate = params.startDate ?? new Date();
    let endDate = params.endDate ?? null;

    const existing = await tx.subscription.findUnique({
      where: {
        enterpriseId_employeeId: {
          enterpriseId: params.enterpriseId,
          employeeId: params.employeeId,
        },
      },
      select: { id: true, status: true, endDate: true },
    });

    const preservesActiveSubscription =
      params.sourceType === 'order' &&
      existing?.status === 'ACTIVE' &&
      (existing.endDate === null || existing.endDate > startDate) &&
      params.purchasePeriodMonths !== undefined;
    if (preservesActiveSubscription && existing.endDate === null) {
      endDate = null;
    } else if (
      preservesActiveSubscription &&
      existing.endDate !== null &&
      existing.endDate > startDate
    ) {
      endDate = new Date(existing.endDate);
      endDate.setMonth(endDate.getMonth() + (params.purchasePeriodMonths ?? 0));
    }

    // 复活时刻意不刷新 templateVersion：停用期间模板可能已发新版，保留旧版本
    // 会让列表立刻给出升级提示，企业能知道「离开这段时间员工变了」。
    const subscription = existing
      ? await tx.subscription.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            ...(!preservesActiveSubscription && { startDate }),
            endDate,
            ...(params.displayName !== undefined && {
              name: params.displayName,
            }),
            ...(params.config !== undefined && { config: params.config }),
            ...(params.purchaseAmountCNY !== undefined && {
              purchaseAmountCNY: params.purchaseAmountCNY,
            }),
            ...(params.purchasePeriodMonths !== undefined && {
              purchasePeriodMonths: params.purchasePeriodMonths,
            }),
          },
        })
      : await tx.subscription.create({
          data: {
            enterpriseId: params.enterpriseId,
            employeeId: params.employeeId,
            status: 'ACTIVE',
            startDate,
            endDate,
            templateVersion: params.templateVersion ?? employee.version,
            name: params.displayName ?? employee.name,
            config: params.config,
            purchaseAmountCNY: params.purchaseAmountCNY,
            purchasePeriodMonths: params.purchasePeriodMonths,
          },
        });

    await this.ensureAdminGrant(
      tx,
      subscription.id,
      params.purchaserMemberId,
      endDate,
    );

    const grantedCNY =
      params.grantedCNY ??
      (await this.credits.resolveGrantAmountCNY(
        employee.includedComputeCNY,
        employee.annualPriceCNY,
      ));

    const credit = await this.credits.grantSubscriptionCredit(tx, {
      subscriptionId: subscription.id,
      enterpriseId: params.enterpriseId,
      employeeId: params.employeeId,
      grantedCNY,
      sourceType: params.sourceType,
      sourceId: params.sourceId ?? null,
    });

    this.logger.log(
      `订阅 ${subscription.id} 已履约（${existing ? '复活' : '新建'}），` +
        `赠送算力 ¥${grantedCNY.toFixed(2)}`,
    );

    return {
      subscriptionId: subscription.id,
      created: !existing,
      grantedCNY,
      creditId: credit.id,
    };
  }

  /**
   * 购买方（企业管理员）默认获得使用权，无需再手动分配。
   *
   * 用「查后更新/创建」而不是 upsert：EmployeeGrant 的唯一性由两个部分索引
   * 表达（成员级 / 部门级），Prisma 无法为它建模复合唯一键。
   */
  private async ensureAdminGrant(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    memberId: string,
    expiresAt: Date | null,
  ) {
    const existing = await tx.employeeGrant.findFirst({
      where: { subscriptionId, memberId },
      select: { id: true },
    });

    if (existing) {
      await tx.employeeGrant.update({
        where: { id: existing.id },
        data: { expiresAt },
      });
      return;
    }

    await tx.employeeGrant.create({
      data: { subscriptionId, memberId, expiresAt },
    });
  }

  /**
   * 校验履约操作人是该企业的管理员。
   *
   * 市场订单只能由企业管理员创建，履约时必须复核 —— 订单创建到支付回调
   * 之间可能已经过了几天，操作人可能已被降权或移出企业。
   */
  async assertEnterpriseAdmin(
    tx: Prisma.TransactionClient,
    userId: string,
    enterpriseId: string,
  ): Promise<{ id: string }> {
    const member = await tx.enterpriseMember.findUnique({
      where: { userId_enterpriseId: { userId, enterpriseId } },
      select: { id: true, role: true },
    });
    if (!member || member.role !== 'ENTERPRISE_ADMIN') {
      throw new BadRequestException('订单创建人不是该企业管理员，无法履约');
    }
    return { id: member.id };
  }
}
