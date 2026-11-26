import { Decimal } from "@prisma/client/runtime/library";
import {
  type AllowanceClient,
  resolveWindow,
  sumEnterpriseUsed,
  USED_SUM_SELECT,
} from "./member-allowance-window";
import type { AllowanceRow } from "./member-allowance.types";

const d = (value: number | string) => new Decimal(value);
const params = {
  enterpriseId: "ent-1",
  userId: "user-1",
  from: new Date("2026-10-01T00:00:00Z"),
  to: new Date("2026-11-01T00:00:00Z"),
};

function harness() {
  const prisma = {
    computeUsageRecord: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { creditPaidCNY: d(1), walletPaidCNY: d(2), memberWalletPaidCNY: d(3), unpaidCNY: d(4) },
      }),
    },
    mediaRealBillingReservation: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { creditCny: d(2), memberWalletCny: d(3) } }),
    },
    memberAllowanceWindow: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  return { prisma, client: prisma as unknown as AllowanceClient };
}

describe("member-allowance-window pending image funds", () => {
  it("includes only the scoped enterprise portion of unresolved reservations across periods", async () => {
    const { prisma, client } = harness();

    expect((await sumEnterpriseUsed(client, params)).toFixed(6)).toBe("15.000000");
    expect(prisma.computeUsageRecord.aggregate).toHaveBeenCalledWith({
      where: { enterpriseId: params.enterpriseId, userId: params.userId, paymentMode: { not: 'PERSONAL_ONLY' }, createdAt: { gte: params.from, lt: params.to } },
      _sum: USED_SUM_SELECT,
    });
    expect(prisma.mediaRealBillingReservation.aggregate).toHaveBeenCalledWith({
      where: { enterpriseId: params.enterpriseId, userId: params.userId, status: { in: ["RESERVED", "RECONCILING"] } },
      _sum: { creditCny: true, memberWalletCny: true },
    });
  });

  it("treats empty reservation sums as zero", async () => {
    const { prisma, client } = harness();
    prisma.mediaRealBillingReservation.aggregate.mockResolvedValue({ _sum: { creditCny: null, memberWalletCny: null } });

    expect((await sumEnterpriseUsed(client, params)).toFixed(6)).toBe("10.000000");
  });

  it("can explicitly read settled usage only without querying current reservations", async () => {
    const { prisma, client } = harness();

    expect((await sumEnterpriseUsed(client, { ...params, includePendingReservations: false })).toFixed(6)).toBe("10.000000");
    expect(prisma.mediaRealBillingReservation.aggregate).not.toHaveBeenCalled();
  });

  it.each(["RESERVED", "RECONCILING", "SETTLED", "RELEASED"])("handles %s without double counting settled usage or personal funds", async status => {
    const { prisma, client } = harness();
    const reservation = { status, creditCny: d(2), memberWalletCny: d(3), personalCny: d(90) };
    prisma.mediaRealBillingReservation.aggregate.mockImplementation(async ({ where }) => ({
      _sum: where.status.in.includes(reservation.status)
        ? { creditCny: reservation.creditCny, memberWalletCny: reservation.memberWalletCny }
        : { creditCny: null, memberWalletCny: null },
    }));
    prisma.computeUsageRecord.aggregate.mockResolvedValue({
      _sum: { creditPaidCNY: status === "SETTLED" ? d(2) : d(0), walletPaidCNY: d(0), memberWalletPaidCNY: status === "SETTLED" ? d(3) : d(0), unpaidCNY: d(0) },
    });

    expect((await sumEnterpriseUsed(client, params)).toFixed(6)).toBe(status === "RELEASED" ? "0.000000" : "5.000000");
  });

  it("fails closed if unresolved funds cannot be read", async () => {
    const { prisma, client } = harness();
    prisma.mediaRealBillingReservation.aggregate.mockRejectedValue(new Error("storage unavailable"));

    await expect(sumEnterpriseUsed(client, params)).rejects.toThrow("storage unavailable");
  });

  it("does not subtract current freezes from historical carryover", async () => {
    const { prisma, client } = harness();
    const allowance: AllowanceRow = {
      id: "allowance-1", enterpriseId: params.enterpriseId, userId: params.userId,
      limitCNY: d(100), period: "MONTH", enabled: true, carryOver: true,
      createdAt: new Date("2020-01-01T00:00:00Z"),
    };
    prisma.computeUsageRecord.aggregate
      .mockResolvedValueOnce({ _sum: { creditPaidCNY: d(0), walletPaidCNY: d(0), memberWalletPaidCNY: d(0), unpaidCNY: d(0) } })
      .mockResolvedValueOnce({ _sum: { creditPaidCNY: d(40), walletPaidCNY: d(0), memberWalletPaidCNY: d(0), unpaidCNY: d(0) } });

    const window = await resolveWindow(client, allowance, new Date("2026-10-15T12:00:00Z"), false);

    expect(window.usedCNY.toFixed(6)).toBe("5.000000");
    expect(window.carriedInCNY.toFixed(6)).toBe("60.000000");
    expect(prisma.computeUsageRecord.aggregate).toHaveBeenCalledTimes(2);
    expect(prisma.mediaRealBillingReservation.aggregate).toHaveBeenCalledTimes(1);
  });
});
