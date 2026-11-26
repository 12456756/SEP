import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import {
  type AllowancePeriod,
  previousPeriodWindow,
  resolvePeriodWindow,
} from "./allowance-period";
import { computeCarriedIn } from "./allowance-carryover";
import type { AllowanceRow, WindowState } from "./member-allowance.types";

/** 与 member-allowance.service.ts 同一「已用」口径：企业资金三项。 */
const USED_SUM_SELECT = {
  creditPaidCNY: true,
  walletPaidCNY: true,
  memberWalletPaidCNY: true,
  unpaidCNY: true,
} as const;

type Client = Pick<
  Prisma.TransactionClient,
  "computeUsageRecord" | "memberAllowanceWindow"
>;

/** 没有额度记录的成员按「每月」展示已用金额 —— 与 schema 的 period 默认值一致。 */
const DISPLAY_DEFAULT_PERIOD: AllowancePeriod = "MONTH";

/**
 * 批量取全体成员的周期窗口状态（管理端列表用）。
 *
 * 查询数固定为 **3 × 在用周期种类数**（最多 5 种），与成员数无关 —— 一家 200 人的
 * 企业和 5 人的企业打一样多的查询。逐人调 `resolveWindow` 是 N+1，这张页面
 * 是管理员每天要看好几次的。
 *
 * 与单人路径的另一处差别：这里**只读不写**。展示一次列表就给全体成员建一批
 * 窗口行是纯粹的副作用污染，缺行时在内存里把结转算出来即可。
 */
export async function loadWindowStates(
  client: Client,
  params: {
    enterpriseId: string;
    userIds: readonly string[];
    allowanceByUser: ReadonlyMap<string, AllowanceRow>;
    at: Date;
  },
): Promise<Map<string, WindowState>> {
  const byPeriod = new Map<AllowancePeriod, string[]>();
  for (const userId of params.userIds) {
    const period =
      params.allowanceByUser.get(userId)?.period ?? DISPLAY_DEFAULT_PERIOD;
    const bucket = byPeriod.get(period);
    if (bucket) bucket.push(userId);
    else byPeriod.set(period, [userId]);
  }

  const states = new Map<string, WindowState>();
  const hasParallelLimits = [...params.allowanceByUser.values()].some(
    (allowance) => Boolean(allowance.dailyLimitCNY || allowance.monthlyLimitCNY),
  );
  const day = resolvePeriodWindow("DAY", params.at);
  const month = resolvePeriodWindow("MONTH", params.at);
  const [dailyUsedByUser, monthlyUsedByUser] = hasParallelLimits
    ? await Promise.all([
        sumByUser(client, params.enterpriseId, params.userIds, day),
        sumByUser(client, params.enterpriseId, params.userIds, month),
      ])
    : [new Map<string, Decimal>(), new Map<string, Decimal>()];

  await Promise.all(
    [...byPeriod].map(async ([period, userIds]) => {
      const current = resolvePeriodWindow(period, params.at);
      const previous = previousPeriodWindow(period, current);
      const allowanceIds = userIds
        .map((id) => params.allowanceByUser.get(id)?.id)
        .filter((id): id is string => Boolean(id));

      const [usedCurrent, usedPrevious, windows] = await Promise.all([
        sumByUser(client, params.enterpriseId, userIds, current),
        sumByUser(client, params.enterpriseId, userIds, previous),
        allowanceIds.length
          ? client.memberAllowanceWindow.findMany({
              where: {
                allowanceId: { in: allowanceIds },
                periodStart: { in: [current.start, previous.start] },
              },
              select: {
                id: true,
                allowanceId: true,
                periodStart: true,
                carriedInCNY: true,
                limitAtOpenCNY: true,
              },
            })
          : Promise.resolve([]),
      ]);

      const windowKey = (allowanceId: string, start: Date) =>
        `${allowanceId}@${start.getTime()}`;
      const windowByKey = new Map(
        windows.map((w) => [windowKey(w.allowanceId, w.periodStart), w]),
      );

      for (const userId of userIds) {
        const allowance = params.allowanceByUser.get(userId);
        const used = usedCurrent.get(userId) ?? new Decimal(0);
        const limitCNY = allowance?.enabled ? allowance.limitCNY : null;

        if (!allowance || !limitCNY || limitCNY.lessThanOrEqualTo(0)) {
          states.set(userId, {
            windowId: null,
            periodStart: current.start,
            periodEnd: current.end,
            limitCNY: null,
            carriedInCNY: new Decimal(0),
            usedCNY: used,
            dailyUsedCNY: dailyUsedByUser.get(userId) ?? new Decimal(0),
            monthlyUsedCNY: monthlyUsedByUser.get(userId) ?? new Decimal(0),
          });
          continue;
        }

        const currentRow = windowByKey.get(
          windowKey(allowance.id, current.start),
        );
        const carriedInCNY = currentRow
          ? currentRow.carriedInCNY
          : carryInFromPrevious({
              allowance,
              previousStart: previous.start,
              previousRow: windowByKey.get(
                windowKey(allowance.id, previous.start),
              ),
              previousUsed: usedPrevious.get(userId) ?? new Decimal(0),
            });

        states.set(userId, {
          windowId: currentRow?.id ?? null,
          periodStart: current.start,
          periodEnd: current.end,
          limitCNY,
          carriedInCNY,
          usedCNY: used,
          dailyUsedCNY: dailyUsedByUser.get(userId) ?? new Decimal(0),
          monthlyUsedCNY: monthlyUsedByUser.get(userId) ?? new Decimal(0),
        });
      }
    }),
  );

  return states;
}

/** 与 `MemberAllowanceService.computeCarryIn` 同一规则，只是数据已经批量取好。 */
function carryInFromPrevious(input: {
  allowance: AllowanceRow;
  previousStart: Date;
  previousRow?: { carriedInCNY: Decimal; limitAtOpenCNY: Decimal | null };
  previousUsed: Decimal;
}): Decimal {
  const { allowance } = input;
  if (!allowance.carryOver || !allowance.limitCNY) return new Decimal(0);
  // 额度是在上一周期开始之后才创建的 —— 那时没有额度，也就没有剩余可结转
  if (allowance.createdAt >= input.previousStart) return new Decimal(0);

  return computeCarriedIn({
    limitCNY: allowance.limitCNY,
    previousLimitCNY: input.previousRow?.limitAtOpenCNY ?? allowance.limitCNY,
    previousCarriedInCNY: input.previousRow?.carriedInCNY ?? new Decimal(0),
    previousUsedCNY: input.previousUsed,
  });
}

async function sumByUser(
  client: Client,
  enterpriseId: string,
  userIds: readonly string[],
  window: { start: Date; end: Date },
): Promise<Map<string, Decimal>> {
  if (userIds.length === 0) return new Map();
  const rows = await client.computeUsageRecord.groupBy({
    by: ["userId"],
    where: {
      enterpriseId,
      userId: { in: [...userIds] },
      paymentMode: { not: 'PERSONAL_ONLY' },
      createdAt: { gte: window.start, lt: window.end },
    },
    _sum: USED_SUM_SELECT,
  });
  return new Map(
    rows
      .filter((r): r is typeof r & { userId: string } => Boolean(r.userId))
      .map((r) => [
        r.userId,
        new Decimal(0)
          .add(r._sum.creditPaidCNY ?? 0)
          .add(r._sum.walletPaidCNY ?? 0)
          .add(r._sum.memberWalletPaidCNY ?? 0)
          .add(r._sum.unpaidCNY ?? 0),
      ]),
  );
}
