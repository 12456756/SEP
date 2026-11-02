import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../../prisma/prisma.service";
import { assertActiveEnterpriseInTx, assertActiveUserInTx } from '../../common/enterprise-write-lock';
import { MemberAllowanceService } from "./member-allowance.service";
import { WalletService } from "../wallet/wallet.service";
import { PersonalWalletService } from "../personal-wallet/personal-wallet.service";
import { SettingService } from "../setting/setting.service";
import {
  AllowanceNotifierService,
  type AllowanceNotifyInput,
} from "./allowance-notifier.service";
import {
  SETTING_KEYS,
  parseCnyAmount,
  type ModelBillingSnapshot,
} from "shared";
import { calculateBilledCost, ModelBillingService } from '../model/model-billing.service';
import { ModelBillingSnapshotSchema } from 'shared';
import type {
  BalanceCheckResult,
  ChargeUsageParams,
  ChargeUsageResult,
  GrantCreditParams,
  SubscriptionCreditView,
  UsageRecordQuery,
} from "./compute-credit.types";

/** 账本精度：6 位小数。所有写库前的金额都过一遍它，避免 Prisma 层静默截断。 */
const MONEY_DP = 6;

function money(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

/**
 * 统一人民币算力账本。
 *
 * 财务口径只有「元」。一次对话的钱按固定顺序出（§5.7 ②）：
 *
 *   订阅赠送余额 → 企业钱包 → 个人钱包 → 欠费
 *   ↑ 前两腿受成员算力分配的闸门约束，闸门说「企业资金已用尽」时它们出 0，
 *     这一笔直接落到个人钱包 —— 对话照常发生，只是这次由成员自费。
 *
 * 个人钱包排**最后**而不是第二：排第二会让充了钱的成员静默补贴公司 ——
 * 他一充值，公司的钱就永远花不到他头上。
 *
 * Token 只作为用量与定价输入落在 ComputeUsageRecord 明细里，不是可扣减余额。
 */
@Injectable()
export class ComputeCreditService {
  private readonly logger = new Logger(ComputeCreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly personalWallet: PersonalWalletService,
    private readonly settings: SettingService,
    private readonly memberAllowance: MemberAllowanceService,
    private readonly allowanceNotifier: AllowanceNotifierService,
    private readonly modelBilling: ModelBillingService,
  ) {}

  // ── 赠送额度配置与发放 ─────────────────────────────────────────────────────

  /** 系统默认赠送金额（元）。运营端可改，非法值回退 0。 */
  async getDefaultGiftCNY(): Promise<number> {
    const raw = await this.settings.getEffectiveValue(
      SETTING_KEYS.DEFAULT_EMPLOYEE_GIFT_CNY,
    );
    return parseCnyAmount(raw, 0);
  }

  /**
   * 解析一个订阅应当赠送多少钱：**员工级金额 > 年费默认比例 > 默认金额**。
   *
   * `null` 与 `0` 语义不同：null 表示员工金额未配置，才使用系统默认策略；
   * 0 表示运营明确「这个员工不赠送」，必须优先于任何系统默认策略。
   */
  async resolveGrantAmountCNY(
    employeeOverride: Decimal | number | null | undefined,
    annualPriceCNY?: Decimal | number | null,
  ): Promise<number> {
    if (employeeOverride === null || employeeOverride === undefined) {
      const rawPercentage = await this.settings.getEffectiveValue(
        SETTING_KEYS.DEFAULT_EMPLOYEE_GIFT_PERCENTAGE,
      );
      const percentage =
        typeof rawPercentage === "string" && rawPercentage.trim() !== ""
          ? Number(rawPercentage)
          : typeof rawPercentage === "number"
            ? rawPercentage
            : Number.NaN;
      if (
        Number.isFinite(percentage) &&
        percentage > 0 &&
        percentage <= 100 &&
        annualPriceCNY !== null &&
        annualPriceCNY !== undefined
      ) {
        const annualPrice = new Decimal(annualPriceCNY);
        if (annualPrice.isFinite() && annualPrice.greaterThan(0)) {
          return money(annualPrice.mul(percentage).div(100)).toNumber();
        }
      }
      return this.getDefaultGiftCNY();
    }
    const value = new Decimal(employeeOverride);
    if (value.lessThan(0)) return this.getDefaultGiftCNY();
    return value.toNumber();
  }

  /**
   * 发放（或补齐）订阅赠送余额。**幂等**：subscriptionId 唯一，重复履约不重复赠送。
   *
   * 已存在时只做「复活」：把 EXPIRED 的额度重新置为可用，但**不追加金额** ——
   * 追加会让重复调用变成刷额度的口子。
   */
  async grantSubscriptionCredit(
    client: Prisma.TransactionClient,
    params: GrantCreditParams,
  ) {
    const granted = money(params.grantedCNY);

    const existing = await client.subscriptionCredit.findUnique({
      where: { subscriptionId: params.subscriptionId },
    });

    if (existing) {
      const exhausted = existing.usedCNY.greaterThanOrEqualTo(
        existing.grantedCNY,
      );
      return client.subscriptionCredit.update({
        where: { id: existing.id },
        data: { status: exhausted ? "EXHAUSTED" : "ACTIVE" },
      });
    }

    return client.subscriptionCredit.create({
      data: {
        subscriptionId: params.subscriptionId,
        enterpriseId: params.enterpriseId,
        employeeId: params.employeeId,
        grantedCNY: granted,
        usedCNY: 0,
        // 赠送 0 元的额度直接标记用尽，免得前端把它显示成「有额度可用」
        status: granted.greaterThan(0) ? "ACTIVE" : "EXHAUSTED",
        sourceType: params.sourceType,
        sourceId: params.sourceId ?? null,
      },
    });
  }

  /**
   * 订阅终止时停用剩余赠送额度。
   *
   * 第一版规则：**不折现、不退回**（见开发计划）。所以这里只把额度置为不可用，
   * 不产生退款流水 —— 真要退赠送金额，必须单独记 REFUND 并写明来源订阅。
   */
  async expireSubscriptionCredit(
    client: Prisma.TransactionClient,
    subscriptionId: string,
  ) {
    await client.subscriptionCredit.updateMany({
      where: { subscriptionId, status: { not: "EXPIRED" } },
      data: { status: "EXPIRED" },
    });
  }

  // ── 对话前余额检查 ─────────────────────────────────────────────────────────

  /**
   * 对话前的余额闸门。
   *
   * 返回两个布尔值而不是一个（§5.7 ④）：**「公司不为这次对话付钱」与「这次对话不能
   * 发生」是两件事**。成员个人钱包有余额时，两种「企业资金不可用」都只是改道自费：
   *   · 他的分配额度用尽（公司资金对他关闸）
   *   · 企业赠送额度与钱包都见底（公司资金对所有人关闸）
   * 把任一种直接拦死，就是拒掉一次账本本来付得起的对话。
   */
  async checkBalanceBeforeConversation(
    enterpriseId: string,
    subscriptionId?: string | null,
    userId?: string | null,
    model?: string | ModelBillingSnapshot,
  ): Promise<BalanceCheckResult> {
    if (model) {
      const free = typeof model === 'string'
        ? (await this.prisma.platformModel.findUnique({ where: { modelId: model }, select: { isFree: true } }))?.isFree === true
        : model.billingMultiplier === 0;
      if (free) {
        return {
          allowed: true, enterpriseFundsAllowed: true, creditRemainingCNY: 0,
          walletBalanceCNY: 0, memberWalletBalanceCNY: 0, totalAvailableCNY: 0,
          personalBalanceCNY: 0,
        };
      }
    }
    // 算力分配的闸门排在余额之前：额度用尽是「这个人不能再花公司的钱」，
    // 与「企业没钱了」是两件事，话术和出路都不同，不能合并成一句「余额不足」。
    const allowance = await this.memberAllowance.check(enterpriseId, userId);
    if (!allowance.enterpriseFundsAllowed) {
      // 闸门已经查过个人余额并把结论写进了 reason，这里不重复查库
      return {
        allowed: allowance.allowed,
        enterpriseFundsAllowed: false,
        creditRemainingCNY: 0,
        walletBalanceCNY: 0,
        memberWalletBalanceCNY: 0,
        totalAvailableCNY: 0,
        personalBalanceCNY: Number(allowance.personalBalanceCNY ?? 0),
        enterpriseFundsBlockedBy: "ALLOWANCE",
        reason: allowance.reason,
      };
    }

    const [credit, wallet, memberWallet] = await Promise.all([
      subscriptionId
        ? this.prisma.subscriptionCredit.findUnique({
            where: { subscriptionId },
          })
        : Promise.resolve(null),
      this.wallet.ensureWalletExists(enterpriseId),
      userId && this.memberAllowance.getMemberWalletBalance
        ? this.memberAllowance.getMemberWalletBalance(enterpriseId, userId)
        : Promise.resolve(new Decimal(0)),
    ]);

    const creditRemaining =
      credit && credit.status === "ACTIVE"
        ? Decimal.max(0, credit.grantedCNY.sub(credit.usedCNY))
        : new Decimal(0);
    const memberScoped = Boolean(userId && this.memberAllowance.getMemberWalletBalance);
    const walletBalance = memberScoped ? new Decimal(0) : Decimal.max(0, wallet.balance);
    // 成员充值余额是专属企业资金来源，但仍受本周期额度闸门约束；
    // 普通成员不自动使用企业公共钱包，避免专款耗尽后越权消费公共余额。
    const memberWalletBalance = Decimal.max(0, memberWallet);
    const total = creditRemaining.add(walletBalance).add(memberWalletBalance);

    if (total.lessThanOrEqualTo(0)) {
      // 企业资金见底 —— 与额度用尽同样是改道，不是拦停。扣费链走到个人钱包那一腿
      // 照样会付款，这里拦死等于凭空拒掉一次能付的对话。
      const personalBalance = userId
        ? await this.personalWallet.getBalance(userId)
        : new Decimal(0);

      if (personalBalance.greaterThan(0)) {
        return {
          allowed: true,
          enterpriseFundsAllowed: false,
          creditRemainingCNY: 0,
          walletBalanceCNY: 0,
          memberWalletBalanceCNY: 0,
          totalAvailableCNY: 0,
          personalBalanceCNY: personalBalance.toNumber(),
          enterpriseFundsBlockedBy: "BALANCE",
          reason:
            "该硅基员工的赠送算力余额、成员企业充值余额与企业钱包余额均已用尽，" +
            `本次对话将由你的个人余额支付（当前 ¥${personalBalance.toFixed(2)}）。`,
        };
      }

      return {
        allowed: false,
        enterpriseFundsAllowed: false,
        creditRemainingCNY: 0,
        walletBalanceCNY: 0,
        memberWalletBalanceCNY: 0,
        totalAvailableCNY: 0,
        personalBalanceCNY: 0,
        enterpriseFundsBlockedBy: "BALANCE",
        reason:
          "该硅基员工的赠送算力余额、成员企业充值余额与企业钱包余额均已用尽，" +
          "请为企业钱包充值后继续对话；也可为个人余额充值后自费使用。",
      };
    }

    return {
      allowed: true,
      enterpriseFundsAllowed: true,
      creditRemainingCNY: creditRemaining.toNumber(),
      walletBalanceCNY: walletBalance.toNumber(),
      memberWalletBalanceCNY: memberWalletBalance.toNumber(),
      totalAvailableCNY: total.toNumber(),
      personalBalanceCNY: 0,
    };
  }

  // ── 核心：一次模型调用的人民币扣费 ─────────────────────────────────────────

  /**
   * 为一次模型调用扣费并落一条用量账单。
   *
   * 扣费顺序：赠送余额 → 成员企业充值余额 → 企业钱包 → 个人钱包 → 欠费，五步在**同一个事务**里，
   * 否则赠送余额扣了而钱包扣失败会让账本对不上。
   * 恒等式：`creditPaid + memberWalletPaid + walletPaid + personalPaid + unpaid == cost`。
   *
   * 前两腿的总额受成员额度闸门约束。闸门在**事务内**重算（`planCharge`），不复用
   * 对话前 `check` 的结论 —— 那之间隔着一整次模型调用，同一个人的并发对话早把
   * 用量改了；闸门只在检查时生效、扣费时不生效，等于额度形同虚设。
   *
   * 幂等：以 `sessionId:messageId` 为业务键，唯一约束兜底。流式对话的网络重试
   * 会重复触发计费，靠调用方自觉挡不住 —— 命中唯一约束即视为已入账。
   */
  async chargeUsage(params: ChargeUsageParams): Promise<ChargeUsageResult> {
    const idempotencyKey = `${params.sessionId}:${params.messageId}`;

    // 计价参数在事务外读：它们是配置读取，放进事务只会拉长持锁时间
    const billingSnapshot = params.billingSnapshot
      ? ModelBillingSnapshotSchema.parse(params.billingSnapshot)
      : await this.getBillingSnapshot(params.modelId);
    if (billingSnapshot.modelId !== params.modelId) throw new BadRequestException('模型计费快照不匹配');
    const cost = calculateBilledCost(billingSnapshot, params.inputTokens, params.outputTokens);
    const rate = billingSnapshot.rate;
    const costCNY = money(cost.costCNY);
    const description = `对话算力消费（${params.modelId}，${params.inputTokens}+${params.outputTokens} tokens）`;

    // 钱包必须在事务前就位：事务内新建钱包会和乐观锁的版本比对纠缠在一起
    await this.wallet.ensureWalletExists(params.enterpriseId);

    const { result, notify } = await this.prisma.$transaction(
      async (
        tx,
      ): Promise<{
        result: ChargeUsageResult;
        notify: AllowanceNotifyInput | null;
      }> => {
        // 1. 幂等：已入账则原样返回，绝不二次扣费
        const existing = await tx.computeUsageRecord.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          // 重放不再发通知：首次入账时该发的已经发过了
          return {
            result: {
              alreadyCharged: true,
              usageRecordId: existing.id,
              costCNY: existing.costCNY,
              creditPaidCNY: existing.creditPaidCNY,
              memberWalletPaidCNY: existing.memberWalletPaidCNY,
              walletPaidCNY: existing.walletPaidCNY,
              personalPaidCNY: existing.personalPaidCNY,
              unpaidCNY: existing.unpaidCNY,
              fallbackPricing: existing.fallbackPricing,
            },
            notify: null,
          };
        }

        if (params.userId) await assertActiveUserInTx(tx, params.userId);
        await assertActiveEnterpriseInTx(tx, params.enterpriseId);
        // 2. 额度闸门：这一笔企业最多能出多少（不限额时为 null）
        const plan = await this.memberAllowance.planCharge(tx, {
          enterpriseId: params.enterpriseId,
          userId: params.userId,
        });
        // 上限是金额而不是「能/不能」：额度剩 ¥0.30 而这笔要 ¥0.50 时，
        // 自然拆成「公司 0.30 + 成员 0.20」，既不让公司超额付、也不浪费公司给的额度。
        const enterpriseBudget =
          plan.enterpriseCapCNY === null
            ? costCNY
            : money(
                Decimal.min(costCNY, Decimal.max(0, plan.enterpriseCapCNY)),
              );

        // 3. 先扣当前订阅的赠送余额（限额内）
        const { creditId, creditPaid } = await this.consumeCreditUpTo(
          tx,
          params.subscriptionId,
          params.enterpriseId,
          enterpriseBudget,
        );

        // 赠送额度之后，优先扣管理员预充值给该成员的企业算力余额。
        const memberWalletResult = params.userId && this.memberAllowance.consumeMemberWalletUpTo
          ? await this.memberAllowance.consumeMemberWalletUpTo(
              tx,
              params.enterpriseId,
              params.userId,
              enterpriseBudget.sub(creditPaid),
            )
          : { paid: new Decimal(0) };

        // 4. 差额扣企业钱包（仍在限额内）；钱包不够时扣到 0，余额永不为负
        const walletResult =
          params.userId && this.memberAllowance.consumeMemberWalletUpTo
            ? { transactionId: null, paid: new Decimal(0), unpaid: new Decimal(0) }
            : await this.wallet.consumeComputeUpTo(
                tx,
                params.enterpriseId,
                enterpriseBudget.sub(creditPaid).sub(memberWalletResult.paid),
                { relatedId: params.sessionId, description },
              );

        // 5. 企业出完之后还差的部分由成员自费兜底。
        //    注意 `walletResult.unpaid` **不能**当作本次欠费：它是相对**限额**的差额，
        //    额度用尽时限额为 0、这一步压根没调用钱包，真正的差额要对着 cost 重算。
        const afterEnterprise = money(
          Decimal.max(
            0,
            costCNY
              .sub(creditPaid)
              .sub(memberWalletResult.paid)
              .sub(walletResult.paid),
          ),
        );
        const personalResult = params.userId
          ? await this.personalWallet.consumeUpTo(
              tx,
              params.userId,
              afterEnterprise,
              { relatedId: params.sessionId, description },
            )
          : {
              transactionId: null,
              paid: new Decimal(0),
              unpaid: afterEnterprise,
            };
        const unpaid = money(
          Decimal.max(0, afterEnterprise.sub(personalResult.paid)),
        );

        // 6. 回写追加额度的消耗。口径与闸门的「已用」一致（credit + wallet + 欠费），
        //    但**封顶在这一笔的企业预算内** —— 超出预算的欠费是成员自己欠的，
        //    不该拿公司给的追加额度去抵。
        const { fromTopUpCNY } = await this.memberAllowance.commitCharge(
          tx,
          // 成员企业钱包充值批次已在上面实际扣减，不能再次作为旧版
          // 「追加额度」回写，否则会双扣余额。
          { ...plan, topUps: [] },
          Decimal.min(
            enterpriseBudget,
            creditPaid
              .add(memberWalletResult.paid)
              .add(walletResult.paid)
              .add(unpaid),
          ),
        );
        if (fromTopUpCNY.greaterThan(0)) {
          this.logger.log(
            `追加额度消耗 ¥${fromTopUpCNY.toFixed(4)}（user=${params.userId}）`,
          );
        }

        // 7. 落账单。Token 在这里只是明细，不参与任何余额判断。
        const record = await tx.computeUsageRecord.create({
          data: {
            enterpriseId: params.enterpriseId,
            subscriptionId: params.subscriptionId ?? null,
            creditId,
            employeeId: params.employeeId ?? null,
            userId: params.userId ?? null,
            sessionId: params.sessionId,
            messageId: params.messageId,
            modelId: params.modelId,
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            inputPriceUsdPerMillion: money(cost.inputPriceUsdPerMillion),
            outputPriceUsdPerMillion: money(cost.outputPriceUsdPerMillion),
            usdToCnyRate: new Decimal(rate).toDecimalPlaces(4),
            fallbackPricing: cost.isFallback,
            costCNY,
            creditPaidCNY: creditPaid,
            memberWalletPaidCNY: memberWalletResult.paid,
            walletPaidCNY: walletResult.paid,
            personalPaidCNY: personalResult.paid,
            unpaidCNY: unpaid,
            idempotencyKey,
            walletTransactionId: walletResult.transactionId,
            personalWalletTransactionId: personalResult.transactionId,
            // 账单归到发生消费的那个周期窗口，「本周期已用」因此能按窗口归集
            allowanceWindowId: plan.windowId,
          },
        });

        return {
          result: {
            alreadyCharged: false,
            usageRecordId: record.id,
            costCNY,
            creditPaidCNY: creditPaid,
            memberWalletPaidCNY: memberWalletResult.paid,
            walletPaidCNY: walletResult.paid,
            personalPaidCNY: personalResult.paid,
            unpaidCNY: unpaid,
            fallbackPricing: cost.isFallback,
          },
          // 通知判定所需的一切都在这儿了：闸门刚读出的额度快照 + 这一笔的实际去向。
          // 攒成一个对象带出事务，是为了让「要不要发通知」这一步不必再打库。
          notify: costCNY.isZero() ? null : {
            enterpriseId: params.enterpriseId,
            userId: params.userId,
            windowId: plan.windowId,
            limitCNY: plan.limitCNY,
            carriedInCNY: plan.carriedInCNY,
            availableBeforeCNY: plan.enterpriseCapCNY,
            regularRemainingBeforeCNY: plan.regularRemainingCNY,
            // 与闸门「已用」同口径（credit + 钱包 + 欠费），且**不封顶** ——
            // 这里宁可高估：高估只会多跑一次复核（复核会否掉），
            // 低估则会漏掉一次「刚好越线」的通知。
            enterpriseUsedDeltaCNY: creditPaid
              .add(memberWalletResult.paid)
              .add(walletResult.paid)
              .add(unpaid),
            walletPaidCNY: walletResult.paid,
          },
        };
      },
    );

    // 通知在事务外发：写通知不该延长持锁时间，更不该因为通知失败
    // 回滚一笔已经真实发生的模型调用。afterCharge 内部自己吞异常。
    if (notify) {
      await this.allowanceNotifier.afterCharge(notify);
    }

    return result;
  }

  async getBillingSnapshot(modelId: string): Promise<ModelBillingSnapshot> {
    return this.modelBilling.getSnapshot(modelId);
  }

  getLegacyBillingSnapshot(modelId: string): Promise<ModelBillingSnapshot> {
    return this.modelBilling.getLegacySnapshot(modelId);
  }

  /**
   * 从订阅赠送余额里扣「最多 amount」，返回实扣金额。
   * 只认传入的 subscriptionId —— 绝不扫描同企业其他订阅的额度，
   * 否则「按员工赠送」就形同虚设。
   */
  private async consumeCreditUpTo(
    tx: Prisma.TransactionClient,
    subscriptionId: string | null | undefined,
    enterpriseId: string,
    amount: Decimal,
  ): Promise<{ creditId: string | null; creditPaid: Decimal }> {
    if (!subscriptionId || amount.lessThanOrEqualTo(0)) {
      return { creditId: null, creditPaid: new Decimal(0) };
    }

    const credit = await tx.subscriptionCredit.findUnique({
      where: { subscriptionId },
    });

    // 多租户防线：额度必须属于调用方企业，否则拿到别家 subscriptionId 就能花别家的钱
    if (!credit || credit.enterpriseId !== enterpriseId) {
      return { creditId: null, creditPaid: new Decimal(0) };
    }
    if (credit.status !== "ACTIVE") {
      return { creditId: credit.id, creditPaid: new Decimal(0) };
    }

    const remaining = Decimal.max(0, credit.grantedCNY.sub(credit.usedCNY));
    const paid = money(Decimal.min(remaining, amount));
    if (paid.lessThanOrEqualTo(0)) {
      return { creditId: credit.id, creditPaid: new Decimal(0) };
    }

    const newUsed = credit.usedCNY.add(paid);
    const updated = await tx.subscriptionCredit.updateMany({
      where: { id: credit.id, version: credit.version },
      data: {
        usedCNY: newUsed,
        status: newUsed.greaterThanOrEqualTo(credit.grantedCNY)
          ? "EXHAUSTED"
          : "ACTIVE",
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      // 并发扣同一笔赠送额度。整笔重试即可，幂等键保证不会重复入账。
      throw new ConflictException("赠送余额更新冲突，请重试");
    }

    return { creditId: credit.id, creditPaid: paid };
  }

  // ── 查询 ───────────────────────────────────────────────────────────────────

  /** 企业的订阅赠送余额列表（企业算力中心「员工剩余赠送余额」）。 */
  async listSubscriptionCredits(
    enterpriseId: string,
  ): Promise<SubscriptionCreditView[]> {
    const credits = await this.prisma.subscriptionCredit.findMany({
      where: { enterpriseId },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
        subscription: { select: { name: true } },
      },
      orderBy: { grantedAt: "desc" },
    });

    return credits.map((c) => ({
      id: c.id,
      subscriptionId: c.subscriptionId,
      employeeId: c.employeeId,
      employeeName: c.subscription?.name ?? c.employee.name,
      employeeAvatar: c.employee.avatar,
      grantedCNY: c.grantedCNY.toFixed(2),
      usedCNY: c.usedCNY.toFixed(2),
      remainingCNY: Decimal.max(0, c.grantedCNY.sub(c.usedCNY)).toFixed(2),
      status: c.status,
      grantedAt: c.grantedAt,
    }));
  }

  /** 企业算力总览：钱包余额 + 赠送余额汇总，全部以元为单位。 */
  async getOverview(enterpriseId: string) {
    const wallet = await this.wallet.ensureWalletExists(enterpriseId);

    const [creditAgg, activeCredits, monthUsage, todayUsage] =
      await Promise.all([
        this.prisma.subscriptionCredit.aggregate({
          where: { enterpriseId },
          _sum: { grantedCNY: true, usedCNY: true },
        }),
        this.prisma.subscriptionCredit.findMany({
          where: { enterpriseId, status: "ACTIVE" },
          select: { grantedCNY: true, usedCNY: true },
        }),
        this.sumUsage(enterpriseId, startOfMonth()),
        this.sumUsage(enterpriseId, startOfToday()),
      ]);

    // 可用赠送余额只统计 ACTIVE 的额度：EXPIRED（订阅已终止）的剩余额度
    // 不能再花，把它算进「可用」会让企业以为还有钱
    const creditRemaining = activeCredits.reduce(
      (sum, c) => sum.add(Decimal.max(0, c.grantedCNY.sub(c.usedCNY))),
      new Decimal(0),
    );

    return {
      walletBalanceCNY: wallet.balance.toFixed(2),
      /// 算力专款：钱包里贴了「只能用于对话」标签的那部分，订阅费动不了它。
      /// 这是「算力余额」页的头号数字 —— 与钱包余额刻意不同源。
      computeReservedCNY: wallet.computeReservedCNY.toFixed(2),
      /// 钱包里没被专款占用的部分，订阅等非算力支出只能动这里。
      walletSpendableCNY: wallet.balance
        .sub(wallet.computeReservedCNY)
        .toFixed(2),
      creditRemainingCNY: creditRemaining.toFixed(2),
      totalAvailableCNY: wallet.balance.add(creditRemaining).toFixed(2),
      creditGrantedTotalCNY: (
        creditAgg._sum.grantedCNY ?? new Decimal(0)
      ).toFixed(2),
      creditUsedTotalCNY: (creditAgg._sum.usedCNY ?? new Decimal(0)).toFixed(2),
      todayConsumeCNY: todayUsage.cost.toFixed(2),
      monthConsumeCNY: monthUsage.cost.toFixed(2),
      monthInputTokens: monthUsage.inputTokens,
      monthOutputTokens: monthUsage.outputTokens,
      totalDepositCNY: wallet.totalDeposit.toFixed(2),
      totalConsumeCNY: wallet.totalConsume.toFixed(2),
    };
  }

  private async sumUsage(enterpriseId: string, since: Date) {
    const agg = await this.prisma.computeUsageRecord.aggregate({
      where: { enterpriseId, createdAt: { gte: since } },
      _sum: { costCNY: true, inputTokens: true, outputTokens: true },
    });
    return {
      cost: agg._sum.costCNY ?? new Decimal(0),
      inputTokens: agg._sum.inputTokens ?? 0,
      outputTokens: agg._sum.outputTokens ?? 0,
    };
  }

  /**
   * 用量账单明细。人民币金额是主口径，Token 作为明细同列展示。
   * 筛选在 SQL 层完成，避免「先分页再过滤」把 total 算错。
   */
  async listUsageRecords(
    enterpriseId: string,
    query: UsageRecordQuery,
    scopeUserId?: string,
  ) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.ComputeUsageRecordWhereInput = {
      enterpriseId,
      ...(query.employeeId && { employeeId: query.employeeId }),
      ...(query.memberId && { userId: query.memberId }),
      /*
        作用域，不是筛选项 —— 所以写在**最后**。

        `scopeUserId` 由控制层从 JWT 推出（成员 = 他自己，管理员 = undefined），
        写在 `query.memberId` 之后才能覆盖它：否则成员在地址栏加一个
        `?memberId=<同事的 id>` 就能翻别人的逐笔账单。
        换句话说，这一行的位置本身就是权限边界。
      */
      ...(scopeUserId && { userId: scopeUserId }),
    };

    if (query.startDate || query.endDate) {
      const createdAt: Prisma.DateTimeFilter = {};
      let start: Date | undefined;
      let end: Date | undefined;
      if (query.startDate) {
        start = new Date(query.startDate);
        if (Number.isNaN(start.getTime())) {
          throw new BadRequestException("startDate 必须是有效日期");
        }
        start.setHours(0, 0, 0, 0);
        createdAt.gte = start;
      }
      if (query.endDate) {
        end = new Date(query.endDate);
        if (Number.isNaN(end.getTime())) {
          throw new BadRequestException("endDate 必须是有效日期");
        }
        end.setHours(23, 59, 59, 999);
        createdAt.lte = end;
      }
      if (start && end && start > end) {
        throw new BadRequestException("startDate 不能晚于 endDate");
      }
      where.createdAt = createdAt;
    }

    const [total, records] = await Promise.all([
      this.prisma.computeUsageRecord.count({ where }),
      this.prisma.computeUsageRecord.findMany({
        where,
        include: {
          employee: { select: { id: true, name: true } },
          user: { select: { id: true, name: true, email: true } },
          subscription: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
      records: records.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        employeeId: r.employeeId,
        employeeName: r.subscription?.name ?? r.employee?.name ?? "—",
        memberId: r.userId,
        memberName: r.user?.name ?? r.user?.email ?? null,
        sessionId: r.sessionId,
        modelId: r.modelId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costCNY: r.costCNY.toFixed(4),
        creditPaidCNY: r.creditPaidCNY.toFixed(4),
        memberWalletPaidCNY: r.memberWalletPaidCNY.toFixed(4),
        walletPaidCNY: r.walletPaidCNY.toFixed(4),
        personalPaidCNY: r.personalPaidCNY.toFixed(4),
        unpaidCNY: r.unpaidCNY.toFixed(4),
        fallbackPricing: r.fallbackPricing,
      })),
    };
  }

  /** 单个订阅的赠送余额（员工详情页用）。 */
  async getSubscriptionCredit(enterpriseId: string, subscriptionId: string) {
    const credit = await this.prisma.subscriptionCredit.findUnique({
      where: { subscriptionId },
    });
    // 用 404 而非 403：不向越权者确认该资源是否存在
    if (!credit || credit.enterpriseId !== enterpriseId) {
      throw new NotFoundException("赠送余额不存在");
    }
    return {
      subscriptionId: credit.subscriptionId,
      grantedCNY: credit.grantedCNY.toFixed(2),
      usedCNY: credit.usedCNY.toFixed(2),
      remainingCNY: Decimal.max(
        0,
        credit.grantedCNY.sub(credit.usedCNY),
      ).toFixed(2),
      status: credit.status,
    };
  }
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
