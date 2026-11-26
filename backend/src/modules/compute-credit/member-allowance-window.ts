import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { PrismaService } from "../../prisma/prisma.service";
import { previousPeriodWindow, resolvePeriodWindow } from "./allowance-period";
import { computeCarriedIn, type TopUpRow } from "./allowance-carryover";
import type { AllowanceRow, WindowState } from "./member-allowance.types";

/**
 * 周期窗口与结转的数据访问层。写成自由函数而不是方法，因为闸门（写路径）和
 * 列表（读路径）都要用它，而两者已经是两个 service —— 让它们共享一个基类
 * 只会把「谁在什么事务里跑」这件事藏起来。
 *
 * 每个函数都显式收 client：事务内外调用同一段逻辑，语义必须一眼可见。
 */
export type AllowanceClient = Prisma.TransactionClient | PrismaService;

/**
 * 「已用」的口径：**企业资金**四项之和。
 *
 * 不是 `costCNY`。`costCNY` 含成员自掏腰包的那部分（personalPaidCNY），
 * 把它算进额度会得出「你越自费、公司额度掉得越快」的荒谬结论。
 * 而 `unpaidCNY`（企业没钱时的欠费）必须算进来 —— 那笔钱企业终究要付。
 */
export const USED_SUM_SELECT = {
  creditPaidCNY: true,
  walletPaidCNY: true,
  memberWalletPaidCNY: true,
  unpaidCNY: true,
} as const;

// ── 已用金额 ───────────────────────────────────────────────────────────────

/** 区间内已用企业资金，加上跨周期仍未决的企业资金冻结。历史结转须显式排除冻结。 */
export async function sumEnterpriseUsed(
  client: AllowanceClient,
  params: {
    enterpriseId: string;
    userId: string;
    from: Date;
    to: Date;
    includePendingReservations?: boolean;
  },
): Promise<Decimal> {
  const agg = await client.computeUsageRecord.aggregate({
    where: {
      enterpriseId: params.enterpriseId,
      userId: params.userId,
      paymentMode: { not: 'PERSONAL_ONLY' },
      createdAt: { gte: params.from, lt: params.to },
    },
    _sum: USED_SUM_SELECT,
  });
  const used = sumUsed(agg._sum);
  if (params.includePendingReservations === false) return used;

  // 未决冻结跨周期占用额度；个人自费不占企业限额，已结算记录仅从用量表计入。
  const pending = await client.mediaRealBillingReservation.aggregate({
    where: {
      enterpriseId: params.enterpriseId,
      userId: params.userId,
      status: { in: ["RESERVED", "RECONCILING"] },
    },
    _sum: { creditCny: true, memberWalletCny: true },
  });
  return used.add(pending._sum.creditCny ?? 0).add(pending._sum.memberWalletCny ?? 0);
}

// ── 周期窗口与结转 ─────────────────────────────────────────────────────────

/**
 * 取（必要时创建）成员当前周期的窗口行，并算出结转金额与本周期已用。
 *
 * 结转是 O(1) 的：只读**上一行**窗口的结转额与上限快照，加一次上一周期的用量聚合。
 * 这正是「结转封顶 1 个周期」换来的性质 —— 封顶更大就得链式回溯到额度创建那天，
 * 而这段代码在每轮对话前都要跑。
 */
export async function resolveWindow(
  client: AllowanceClient,
  allowance: AllowanceRow,
  at: Date,
  persist: boolean,
): Promise<WindowState> {
  const window = resolvePeriodWindow(allowance.period, at);
  const limitCNY = allowance.enabled ? allowance.limitCNY : null;
  const hasParallelLimits = Boolean(
    allowance.dailyLimitCNY || allowance.monthlyLimitCNY,
  );
  let used: Decimal;
  let dailyUsedCNY: Decimal;
  let monthlyUsedCNY: Decimal;
  if (hasParallelLimits) {
    const day = resolvePeriodWindow("DAY", at);
    const month = resolvePeriodWindow("MONTH", at);
    [used, dailyUsedCNY, monthlyUsedCNY] = await Promise.all([
      sumEnterpriseUsed(client, {
        enterpriseId: allowance.enterpriseId,
        userId: allowance.userId,
        from: window.start,
        to: window.end,
      }),
      sumEnterpriseUsed(client, {
        enterpriseId: allowance.enterpriseId,
        userId: allowance.userId,
        from: day.start,
        to: day.end,
      }),
      sumEnterpriseUsed(client, {
        enterpriseId: allowance.enterpriseId,
        userId: allowance.userId,
        from: month.start,
        to: month.end,
      }),
    ]);
  } else {
    // 兼容旧的单周期额度：只执行原本的一次聚合，避免改变结转查询的调用顺序。
    used = await sumEnterpriseUsed(client, {
      enterpriseId: allowance.enterpriseId,
      userId: allowance.userId,
      from: window.start,
      to: window.end,
    });
    dailyUsedCNY = allowance.period === "DAY" ? used : new Decimal(0);
    monthlyUsedCNY = allowance.period === "MONTH" ? used : new Decimal(0);
  }
  const parallel = {
    dailyUsedCNY,
    monthlyUsedCNY,
    dailyLimitCNY: allowance.enabled ? allowance.dailyLimitCNY ?? null : null,
    monthlyLimitCNY: allowance.enabled ? allowance.monthlyLimitCNY ?? null : null,
    dailyBypassUntil: allowance.dailyBypassUntil ?? null,
  };

  // 不限额的成员不建窗口行：没有额度就没有结转，建了也只是垃圾数据
  if (!limitCNY || limitCNY.lessThanOrEqualTo(0)) {
    return {
      windowId: null,
      periodStart: window.start,
      periodEnd: window.end,
      limitCNY: null,
      carriedInCNY: new Decimal(0),
      usedCNY: used,
      ...parallel,
    };
  }

  const existing = await client.memberAllowanceWindow.findUnique({
    where: {
      allowanceId_periodStart: {
        allowanceId: allowance.id,
        periodStart: window.start,
      },
    },
  });
  if (existing) {
    return {
      windowId: existing.id,
      periodStart: window.start,
      periodEnd: window.end,
      limitCNY,
      carriedInCNY: existing.carriedInCNY,
      usedCNY: used,
      ...parallel,
    };
  }

  const carriedIn = await computeCarryIn(client, allowance, window.start);

  if (!persist) {
    return {
      windowId: null,
      periodStart: window.start,
      periodEnd: window.end,
      limitCNY,
      carriedInCNY: carriedIn,
      usedCNY: used,
      ...parallel,
    };
  }

  // 并发的「本周期第一次对话」会同时建同一行，唯一约束兜底后改读
  let windowId: string;
  try {
    const created = await client.memberAllowanceWindow.create({
      data: {
        allowanceId: allowance.id,
        periodStart: window.start,
        periodEnd: window.end,
        carriedInCNY: carriedIn,
        limitAtOpenCNY: limitCNY,
      },
    });
    windowId = created.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await client.memberAllowanceWindow.findUniqueOrThrow({
        where: {
          allowanceId_periodStart: {
            allowanceId: allowance.id,
            periodStart: window.start,
          },
        },
      });
      return {
        windowId: raced.id,
        periodStart: window.start,
        periodEnd: window.end,
        limitCNY,
        carriedInCNY: raced.carriedInCNY,
        usedCNY: used,
        ...parallel,
      };
    }
    throw error;
  }

  return {
    windowId,
    periodStart: window.start,
    periodEnd: window.end,
    limitCNY,
    carriedInCNY: carriedIn,
    usedCNY: used,
    ...parallel,
  };
}

/**
 * 新周期开门时应结转多少。
 *
 * 「上一周期没有窗口行」有两种截然不同的含义，靠 `allowance.createdAt` 区分：
 *   · 额度在上一周期开始后才创建 → 那时还没有额度可剩，结转 0
 *   · 额度早已存在，只是上周期没对话 → 一分没花，整期结转（仍封顶 1 个周期）
 * 混淆这两者的后果是：管理员今天新分配 ¥500，成员当场就有 ¥1000 能花。
 */
async function computeCarryIn(
  client: AllowanceClient,
  allowance: AllowanceRow,
  currentStart: Date,
): Promise<Decimal> {
  if (!allowance.carryOver || !allowance.limitCNY) return new Decimal(0);

  const previous = previousPeriodWindow(allowance.period, {
    start: currentStart,
    end: currentStart,
  });
  if (allowance.createdAt >= previous.start) return new Decimal(0);

  const [previousRow, previousUsed] = await Promise.all([
    client.memberAllowanceWindow.findUnique({
      where: {
        allowanceId_periodStart: {
          allowanceId: allowance.id,
          periodStart: previous.start,
        },
      },
    }),
    sumEnterpriseUsed(client, {
      enterpriseId: allowance.enterpriseId,
      userId: allowance.userId,
      from: previous.start,
      to: previous.end,
      includePendingReservations: false,
    }),
  ]);

  return computeCarriedIn({
    limitCNY: allowance.limitCNY,
    previousLimitCNY: previousRow?.limitAtOpenCNY ?? allowance.limitCNY,
    previousCarriedInCNY: previousRow?.carriedInCNY ?? new Decimal(0),
    previousUsedCNY: previousUsed,
  });
}

/** 该成员未用完的一次性追加额度（跨周期存活，按批次先后消耗）。 */
export async function loadTopUps(
  client: AllowanceClient,
  enterpriseId: string,
  userId: string,
): Promise<TopUpRow[]> {
  const rows = await loadAllTopUps(client, enterpriseId, userId);
  return rows.filter((r) => r.amountCNY.greaterThan(r.consumedCNY));
}

/** 查询完整充值历史，供余额详情展示累计充值金额。 */
export async function loadAllTopUps(
  client: AllowanceClient,
  enterpriseId: string,
  userId: string,
): Promise<TopUpRow[]> {
  return client.memberAllowanceTopUp.findMany({
    where: { enterpriseId, userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, amountCNY: true, consumedCNY: true, version: true },
  });
}

export function sumUsed(sum: {
  creditPaidCNY: Decimal | null;
  walletPaidCNY: Decimal | null;
  memberWalletPaidCNY: Decimal | null;
  unpaidCNY: Decimal | null;
}): Decimal {
  return new Decimal(0)
    .add(sum.creditPaidCNY ?? 0)
    .add(sum.walletPaidCNY ?? 0)
    .add(sum.memberWalletPaidCNY ?? 0)
    .add(sum.unpaidCNY ?? 0);
}

export function unlimitedPlaceholder(
  enterpriseId: string,
  userId: string,
): AllowanceRow {
  return {
    id: "",
    enterpriseId,
    userId,
    limitCNY: null,
    period: "MONTH",
    carryOver: false,
    enabled: true,
    createdAt: new Date(0),
  };
}
