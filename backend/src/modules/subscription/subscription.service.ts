import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { withEmployeeAvatar } from '../../common/employee-avatar';
import {
  SubscriptionCreateDto,
  SubscriptionUpdateDto,
  SubscriptionStatusValue,
} from 'shared';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { EmployeeUsageService } from '../enterprise/employee-usage.service';
import { WalletService } from '../wallet/wallet.service';
import { SubscriptionFulfillmentService } from '../subscription-fulfillment/subscription-fulfillment.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertActiveEnterpriseInTx } from '../../common/enterprise-write-lock';

/** 允许的状态流转。EXPIRED 是终态。 */
const ALLOWED_TRANSITIONS: Record<
  SubscriptionStatusValue,
  SubscriptionStatusValue[]
> = {
  ACTIVE: ['PAUSED', 'EXPIRED'],
  PAUSED: ['ACTIVE', 'EXPIRED'],
  // 终止后不可复活：凭据已吊销，重新雇佣走 subscribe() 而非状态回滚，
  // 那样 startDate 会刷新，审计上能看出这是一次新的雇佣
  EXPIRED: [],
};

@Injectable()
export class SubscriptionService {
  constructor(
    private prisma: PrismaService,
    private enterpriseContext: EnterpriseContextService,
    private walletService: WalletService,
    private fulfillment: SubscriptionFulfillmentService,
    private credits: ComputeCreditService,
    private usage: EmployeeUsageService,
    @Optional() private notifications?: NotificationsService,
  ) {}

  /** 每日提醒未来 7 天到期的企业管理员；同一订阅每天最多一条。 */
  @Cron('15 9 * * *')
  async notifyExpiringSubscriptions() {
    if (!this.notifications) return;
    const now = new Date();
    const until = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', endDate: { gt: now, lte: until } },
      select: {
        id: true,
        endDate: true,
        employee: { select: { name: true } },
        enterprise: { select: { members: { where: { role: 'ENTERPRISE_ADMIN' }, select: { userId: true } } } },
      },
    });
    for (const subscription of subscriptions) {
      const days = Math.max(1, Math.ceil((subscription.endDate!.getTime() - now.getTime()) / 86_400_000));
      const targets = [] as string[];
      for (const member of subscription.enterprise.members) {
        const existing = await this.prisma.notification.findFirst({ where: { userId: member.userId, type: 'SUBSCRIPTION_EXPIRING', relatedType: 'subscription', relatedId: subscription.id, createdAt: { gte: dayStart } }, select: { id: true } });
        if (!existing) targets.push(member.userId);
      }
      if (targets.length === 0) continue;
      await this.notifications.createBatch(targets, {
        type: 'SUBSCRIPTION_EXPIRING',
        title: '员工订阅即将到期',
        message: `「${subscription.employee.name}」将在约 ${days} 天后到期，请及时续费。`,
        relatedType: 'subscription',
        relatedId: subscription.id,
        actionUrl: `/subscriptions/${subscription.id}`,
      });
    }
  }

  /**
   * 企业订阅一个市场员工模板。
   *
   * 订阅主体是【企业】而非个人 —— 订阅要花企业的钱，
   * 故要求 ENTERPRISE_ADMIN 角色；其他角色应走 SubscriptionRequest 申请流程。
   *
   * 规则：
   *  - 模板必须已上架（PUBLISHED）
   *  - 同一企业对同一模板只订阅一次；PAUSED/EXPIRED 时重新激活
   *  - 订阅本身即雇佣关系，创建时锁定模板版本，不再另建实例
   *  - 从钱包扣款（年费），记录交易 ID
   */
  async subscribe(userId: string, dto: SubscriptionCreateDto) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);

    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: dto.employeeId },
    });
    if (!employee) throw new NotFoundException(`Employee ${dto.employeeId} not found`);
    if (employee.status !== 'APPROVED') {
      throw new BadRequestException('Cannot subscribe to an unapproved employee');
    }

    // 检查是否设置了年费
    if (employee.annualPriceCNY == null || !Number.isFinite(employee.annualPriceCNY.toNumber()) || employee.annualPriceCNY.toNumber() < 0) {
      throw new BadRequestException('Employee does not have a valid annual price');
    }

    // Upsert: reactivate existing or create new
    const existing = await this.prisma.subscription.findUnique({
      where: {
        enterpriseId_employeeId: {
          enterpriseId: ctx.enterpriseId,
          employeeId: dto.employeeId,
        },
      },
    });

    if (existing?.status === 'ACTIVE') {
      throw new ConflictException('Already subscribed to this employee');
    }

    const amount = employee.annualPriceCNY.toNumber();
    const isRenewal = !!existing;

    // 赠送金额在事务外解析：它要读系统设置，塞进事务只会白白拉长持锁时间。
    // 「员工级配置 > 系统默认值」的判定在 resolveGrantAmountCNY 里。
    const grantedCNY = await this.credits.resolveGrantAmountCNY(
      employee.includedComputeCNY,
      employee.annualPriceCNY,
    );

    // 履约与扣款必须同一个事务：订阅建成但扣款失败 = 白送一年，
    // 扣款成功但订阅没建 = 企业付了钱拿不到员工。
    const subscriptionId = await this.prisma.$transaction(async (tx) => {
      if (amount === 0) {
        await assertActiveEnterpriseInTx(tx, ctx.enterpriseId);
        const current = await tx.subscription.findUnique({
          where: { enterpriseId_employeeId: { enterpriseId: ctx.enterpriseId, employeeId: dto.employeeId } },
          select: { status: true },
        });
        if (current?.status === 'ACTIVE') throw new ConflictException('Already subscribed to this employee');
      }
      const result = await this.fulfillment.fulfill(tx, {
        enterpriseId: ctx.enterpriseId,
        employeeId: dto.employeeId,
        purchaserMemberId: ctx.memberId,
        displayName: isRenewal ? undefined : employee.name,
        endDate: null,
        sourceType: 'subscription',
        purchaseAmountCNY: amount,
        purchasePeriodMonths: 12,
        grantedCNY,
        config: dto.config as Prisma.InputJsonValue | undefined,
      });

      // 复活订阅也要重新付费
      const transaction = amount > 0
        ? await this.walletService.consume(
            ctx.enterpriseId,
            amount,
            'subscription',
            result.subscriptionId,
            `${isRenewal ? '重新订阅' : '订阅'}【${employee.name}】`,
            tx,
          )
        : null;

      await tx.subscription.update({
        where: { id: result.subscriptionId },
        data: { walletTransactionId: transaction?.id ?? null },
      });

      return result.subscriptionId;
    });

    const subscription = await this.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: {
        employee: {
          select: { id: true, name: true, avatar: true, position: true },
        },
        credit: {
          select: { grantedCNY: true, usedCNY: true, status: true },
        },
      },
    });
    return { ...subscription, employee: withEmployeeAvatar(subscription.employee) };
  }

  /**
   * 列出【本企业】的雇佣关系，并附带升级提示。
   *
   * 不再按 status 过滤 —— 管理台要能看到已暂停的雇佣关系才能恢复它，
   * 只返回 ACTIVE 会让暂停后的记录凭空消失、无从操作。
   *
   * 升级判断只比较版本字符串是否相等，不做语义化版本比较 ——
   * 模板版本由运营发布时填写，只要与雇佣关系锁定的版本不同就提示。
   * 这样降级发布（如撤回到旧版）也会被提示，符合「有变化就告知」的预期。
   */
  async findAll(userId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const rows = await this.prisma.subscription.findMany({
      where: { enterpriseId: ctx.enterpriseId },
      include: {
        employee: {
          select: {
            id: true, name: true, description: true, avatar: true,
            industry: true, position: true, functionalCategory: true, status: true, version: true,
            annualPriceCNY: true,
          },
        },
        credit: {
          select: { grantedCNY: true, usedCNY: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 使用情况与「我的硅基员工」同源（同一个 EmployeeUsageService）——
    // 雇佣管理要回答的是「谁在用、谁白雇着」，那必须和员工卡片上的数字一致，
    // 否则同一个员工在两页显示两个「在用人数」，没人知道该信哪个。
    // 6 条查询覆盖整张列表，与行数无关。
    const usageBySubscription = await this.usage.forSubscriptions(
      ctx.enterpriseId,
      rows.map((r) => ({ subscriptionId: r.id, employeeId: r.employee.id })),
    );

    return rows.map((r) => ({
      ...r,
      employee: {
        ...withEmployeeAvatar(r.employee),
        annualPriceCNY: r.employee.annualPriceCNY?.toNumber() ?? null,
      },
      // 未自定义称呼时回落到模板名，前端不必各自兜底
      name: r.name ?? r.employee.name,
      latestVersion: r.employee.version,
      upgradeAvailable: r.employee.version !== r.templateVersion,
      usage: usageBySubscription.get(r.id),
      // 赠送余额扁平化到列表项：员工卡片要展示「剩余 ¥X.XX」，
      // 让前端各自从 credit 里算剩余，容易漏掉 EXPIRED 不可用这一层
      giftGrantedCNY: r.credit ? r.credit.grantedCNY.toFixed(2) : '0.00',
      giftUsedCNY: r.credit ? r.credit.usedCNY.toFixed(2) : '0.00',
      giftRemainingCNY:
        r.credit && r.credit.status === 'ACTIVE'
          ? Decimal.max(0, r.credit.grantedCNY.sub(r.credit.usedCNY)).toFixed(2)
          : '0.00',
      giftStatus: r.credit?.status ?? 'NONE',
    }));
  }

  /**
   * 按 id 取单个订阅，并校验其属于调用方所在企业。
   *
   * ⚠️ 多租户防线：这里必须比对 enterpriseId 而非 userId ——
   * 攻击者会直接把 URL 里的 id 换成别家企业的订阅 id 来调接口，
   * 仅靠"前端只展示本企业数据"挡不住。
   */
  async findOne(id: string, userId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: { employee: true },
    });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);
    if (sub.enterpriseId !== ctx.enterpriseId) {
      // 用 404 而非 403：不向越权者确认该资源是否存在
      throw new NotFoundException(`Subscription ${id} not found`);
    }
    return { ...sub, employee: sub.employee ? withEmployeeAvatar(sub.employee) : sub.employee };
  }

  /** 更新订阅上的企业侧配置 */
  async updateConfig(id: string, userId: string, config: Record<string, any>) {
    const sub = await this.findOne(id, userId);
    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { config: config as any },
      include: { employee: { select: { id: true, name: true, avatar: true, position: true } } },
    });
    return { ...updated, employee: withEmployeeAvatar(updated.employee) };
  }

  /**
   * 修改雇佣关系（自定义称呼 / 配置）。
   *
   * 已过期的不可改：过期是终态，改名改配置都无从生效，
   * 允许修改只会让管理台显示出「改了但没用」的假象。
   */
  async update(id: string, userId: string, dto: SubscriptionUpdateDto) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const sub = await this.findOne(id, userId);

    if (sub.status === 'EXPIRED') {
      throw new ConflictException('已过期的雇佣关系不可修改');
    }

    return this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.config !== undefined && { config: dto.config as any }),
      },
      select: { id: true, name: true, config: true, status: true },
    });
  }

  /**
   * 变更雇佣关系状态（启用 / 暂停 / 终止）。
   *
   * 暂停与终止**不删除授权记录**：暂停往往是临时的，删掉授权则恢复时
   * 要重新配一遍，是无谓的返工。权限判定由「雇佣关系状态 + 授权」
   * 共同决定 —— 非 ACTIVE 时一律不可用，授权记录留着不生效。
   *
   * EXPIRED 是终态，不可转回：凭据已吊销，且「终止雇佣」对企业是一次
   * 明确的动作，允许撤销会让权限状态难以审计。想重新雇佣走订阅流程，
   * 那会走 subscribe() 的复活分支并刷新 startDate。
   */
  async changeStatus(
    id: string,
    userId: string,
    next: SubscriptionStatusValue,
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const sub = await this.findOne(id, userId);

    const current = sub.status as SubscriptionStatusValue;
    if (current === next) {
      return { id: sub.id, status: current, changed: false };
    }
    if (!ALLOWED_TRANSITIONS[current] || !ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new ConflictException(
        `雇佣关系状态不能从 ${current} 变为 ${next}`,
      );
    }

    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: next,
        // 终止时落下结束时间，恢复时清掉，否则列表会显示一个过去的到期日
        ...(next === 'EXPIRED'
          ? { endDate: new Date() }
          : { endDate: null }),
      },
      select: { id: true, status: true },
    });
    return { ...updated, changed: true };
  }

  /**
   * 升级到模板最新版本（提示式升级，由企业主动确认，决策 14）。
   *
   * **不迁移 config**：新版可能增删配置项，自动迁移需要清单声明配置项的
   * 版本演进规则，成本高且容易静默写坏数据。这里只更新版本号并把结果
   * 告知调用方，由前端提示「请重新检查配置」。
   */
  async upgrade(id: string, userId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const sub = await this.findOne(id, userId);

    if (sub.status === 'EXPIRED') {
      throw new ConflictException('已过期的雇佣关系不可升级');
    }

    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: sub.employeeId },
      select: { version: true },
    });
    if (!employee) throw new NotFoundException('员工模板不存在');

    if (employee.version === sub.templateVersion) {
      throw new ConflictException('当前已是最新版本');
    }

    const from = sub.templateVersion;
    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { templateVersion: employee.version },
      select: { id: true, templateVersion: true },
    });

    return {
      ...updated,
      from,
      to: employee.version,
      // 提醒前端：配置未自动迁移
      configReviewRequired: true,
    };
  }

  /** Unsubscribe (set status to EXPIRED, keep record) */
  async unsubscribe(id: string, userId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const sub = await this.findOne(id, userId);
    if (sub.status !== 'ACTIVE') {
      throw new ConflictException('Subscription is not active');
    }
    return this.prisma.$transaction(async (tx) => {
      // 退订后赠送余额不可再用。第一版规则：不折现、不退回（见开发计划）。
      await this.credits.expireSubscriptionCredit(tx, sub.id);
      return tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'EXPIRED', endDate: new Date() },
      });
    });
  }

  /**
   * 解雇员工（TERMINATED）：7 天试用期内全额退款，之后不退款。
   *
   * 试用期计算：从 startDate 起 7 天内
   * 退款金额：试用期内 = 全额（年费），试用期外 = 0
   */
  async terminate(id: string, userId: string, reason?: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const sub = await this.findOne(id, userId);

    if (sub.status !== 'ACTIVE' && sub.status !== 'PAUSED') {
      throw new ConflictException('Only active or paused subscriptions can be terminated');
    }

    // 获取员工信息（用于退款金额和描述）
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: sub.employeeId },
      select: { name: true, annualPriceCNY: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    // 退款金额优先使用订阅成交快照，避免 1/6/24 个月订单被按年费退款。
    // 兼容直接订阅历史数据：再回退到钱包扣款流水和当前年费。
    const paidTransaction = sub.walletTransactionId
      ? await this.prisma.walletTransaction.findUnique({
          where: { id: sub.walletTransactionId },
          select: { amount: true },
        })
      : null;

    // 计算是否在试用期内（7 天）
    const now = new Date();
    const trialEndDate = new Date(sub.startDate);
    trialEndDate.setDate(trialEndDate.getDate() + 7);
    const isWithinTrial = now <= trialEndDate;

    // 退款、停用赠送额度、更新订阅必须在同一个事务中完成，避免退款成功但状态更新失败。
    return this.prisma.$transaction(async (tx) => {
      let refundAmount = 0;
      let refundTransactionId: string | null = null;

      const paidAmount = sub.purchaseAmountCNY?.toNumber()
        ?? (paidTransaction ? Math.abs(paidTransaction.amount.toNumber()) : employee.annualPriceCNY?.toNumber() ?? 0);
      if (isWithinTrial && paidAmount > 0) {
        // 试用期内全额退**订阅费**。未用完的赠送算力不折现、不退回（见开发计划）：
        // 赠送额度不是企业付过的钱，退它等于凭空发钱。
        refundAmount = paidAmount;
        const refundTransaction = await this.walletService.refund(
          ctx.enterpriseId,
          refundAmount,
          'subscription',
          sub.id,
          `解雇【${employee.name}】- 试用期退款`,
          tx,
        );
        refundTransactionId = refundTransaction.id;
      }

      await this.credits.expireSubscriptionCredit(tx, sub.id);
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'TERMINATED',
          endDate: now,
          terminatedAt: now,
          terminatedBy: userId,
          terminatedReason:
            reason || (isWithinTrial ? 'trial_refund' : 'user_cancel'),
          refundAmount: refundAmount > 0 ? refundAmount : null,
          refundTransactionId,
        },
      });

      return {
        ...updated,
        refunded: refundAmount > 0,
        refundAmount: refundAmount > 0 ? refundAmount : null,
        refundDestination: refundAmount > 0 ? 'ENTERPRISE_WALLET' : null,
      };
    });
  }

  /**
   * 校验企业对某员工有有效订阅（对话层调用前检查）。
   * 订阅主体是企业，从 userId 解析出企业后再查。
   */
  async assertActiveSubscription(userId: string, employeeId: string): Promise<void> {
    const ctx = await this.enterpriseContext.resolve(userId);
    const sub = await this.prisma.subscription.findUnique({
      where: {
        enterpriseId_employeeId: {
          enterpriseId: ctx.enterpriseId,
          employeeId,
        },
      },
    });
    if (
      !sub ||
      sub.status !== 'ACTIVE' ||
      (sub.endDate !== null && sub.endDate <= new Date())
    ) {
      throw new ForbiddenException('Active subscription required to start a conversation');
    }
  }
}
