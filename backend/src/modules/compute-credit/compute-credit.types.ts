import { Decimal } from "@prisma/client/runtime/library";
import type { ModelBillingSnapshot } from 'shared';

/** 赠送额度来源，用于对账时区分是哪条链路产生的额度。 */
export type CreditSourceType = "subscription" | "order" | "migration";

export interface GrantCreditParams {
  subscriptionId: string;
  enterpriseId: string;
  employeeId: string;
  /** 赠送金额（元）。允许 0 —— 运营明确「本员工不赠送」。 */
  grantedCNY: number;
  sourceType: CreditSourceType;
  sourceId?: string | null;
}

export interface ChargeUsageParams {
  enterpriseId: string;
  /** 当前对话对应的订阅。缺失时整笔走企业钱包。 */
  subscriptionId?: string | null;
  employeeId?: string | null;
  userId?: string | null;
  sessionId: string;
  /** 幂等锚点：同一条 assistant 消息只入账一次。 */
  messageId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** 服务端在模型调用开始时冻结的中转倍率与模型免费状态。 */
  billingSnapshot?: ModelBillingSnapshot;
}

export interface ChargeUsageResult {
  /** true = 幂等命中，本次没有产生新的扣费 */
  alreadyCharged: boolean;
  usageRecordId: string;
  costCNY: Decimal;
  creditPaidCNY: Decimal;
  /** 由企业预充值给该成员的企业算力钱包承担的部分 */
  memberWalletPaidCNY: Decimal;
  walletPaidCNY: Decimal;
  /**
   * 成员个人钱包出的钱（分配额度用尽或企业没钱时的兜底，排扣费链最后一位）。
   * 它**不计入**分配额度的「本周期已用」—— 否则成员越自费、公司额度掉得越快。
   */
  personalPaidCNY: Decimal;
  /** > 0 表示企业资金与个人余额都已耗尽，本次消费有欠费 */
  unpaidCNY: Decimal;
  fallbackPricing: boolean;
}

/**
 * 对话前的余额检查结果。
 *
 * 两个布尔值刻意分开（§5.7 ④）：`enterpriseFundsAllowed` 说的是「公司还愿不愿意
 * 为这次对话付钱」，`allowed` 说的是「这次对话能不能发生」。额度用尽而个人钱包
 * 有余额时前者 false、后者 true —— 对话照常，只是这次自费。合成一个布尔值就等于
 * 把「公司这月不再为你付费」错报成「系统不可用」。
 */
export interface BalanceCheckResult {
  allowed: boolean;
  /** 能否动用企业资金（赠送额度 + 成员充值余额 + 企业钱包）；false 时本次对话由个人余额支付 */
  enterpriseFundsAllowed: boolean;
  /** 该订阅剩余赠送余额（元） */
  creditRemainingCNY: number;
  /** 企业钱包可用余额（元） */
  walletBalanceCNY: number;
  /** 当前成员的企业充值余额（元），跨周期保留 */
  memberWalletBalanceCNY: number;
  /** 三者之和 —— 用户视角的「公司还能为我付多少」 */
  totalAvailableCNY: number;
  /** 成员个人钱包余额（元）。改道自费时前端要显示它 */
  personalBalanceCNY: number;
  /**
   * 企业资金为什么用不了。仅在 `enterpriseFundsAllowed === false` 时有值。
   *
   * 前端靠它选标题和第二条出路：`ALLOWANCE` 是「这个人这周期花超了」——
   * 出路是找管理员调额度；`BALANCE` 是「公司账上没钱了」—— 出路是给企业钱包充值。
   * 两者都被叫成「余额不足」的话，成员会去催财务充值，而实际上钱是够的。
   */
  enterpriseFundsBlockedBy?: "ALLOWANCE" | "BALANCE";
  reason?: string;
}

export interface SubscriptionCreditView {
  id: string;
  subscriptionId: string;
  employeeId: string;
  employeeName: string;
  employeeAvatar: string | null;
  grantedCNY: string;
  usedCNY: string;
  remainingCNY: string;
  status: string;
  grantedAt: Date;
}

export interface UsageRecordQuery {
  page?: number;
  pageSize?: number;
  employeeId?: string;
  memberId?: string;
  startDate?: string;
  endDate?: string;
}
