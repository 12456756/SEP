/**
 * 统一人民币算力账本的扣费行为。
 *
 * 这里覆盖的都是「测试全绿也可能亏钱」的路径：四条腿的扣减顺序
 * （赠送 → 企业钱包 → **个人钱包** → 欠费）、额度闸门给出的金额上限如何把一笔
 * 消费拆成「公司一部分 + 成员一部分」、余额不足时不许变负、流式重试不许重复扣费、
 * 并发冲突要抛错而不是静默丢账。
 *
 * 个人钱包排**最后**是有代价的设计选择（§5.7 ②）：排第二会让充了钱的成员静默
 * 补贴公司。所以「企业钱包还有钱时个人余额一分不动」是一条必须锁住的断言。
 */
import { ConflictException } from "@nestjs/common";
import { Decimal } from "@prisma/client/runtime/library";
import { ComputeCreditService } from "./compute-credit.service";
import { SETTING_KEYS } from "shared";
import { ModelBillingService } from '../model/model-billing.service';

const ENTERPRISE = "ent-acme";
const SUBSCRIPTION = "sub-1";

/** 固定 1 元/1K 输入、0 输出的保底价，让每个用例的成本都是好算的整数。 */
const FLAT_PRICE_SETTINGS: Record<string, string> = {
  [SETTING_KEYS.SUB2API_BASE_URL]: 'https://relay.example/v1',
  [SETTING_KEYS.SUB2API_API_KEY]: 'test-key',
  [SETTING_KEYS.USD_TO_CNY_RATE]: "7.2",
  [SETTING_KEYS.FALLBACK_PRICE_INPUT]: "1",
  [SETTING_KEYS.FALLBACK_PRICE_OUTPUT]: "0",
};

interface CreditRow {
  id: string;
  subscriptionId: string;
  enterpriseId: string;
  grantedCNY: Decimal;
  usedCNY: Decimal;
  status: string;
  version: number;
}

function makeCredit(overrides: Partial<CreditRow> = {}): CreditRow {
  return {
    id: "credit-1",
    subscriptionId: SUBSCRIPTION,
    enterpriseId: ENTERPRISE,
    grantedCNY: new Decimal(0),
    usedCNY: new Decimal(0),
    status: "ACTIVE",
    version: 0,
    ...overrides,
  };
}

describe("ComputeCreditService.chargeUsage", () => {
  let prisma: any;
  let wallet: any;
  let settings: any;
  let svc: ComputeCreditService;
  let createdRecord: any;

  /** 企业钱包余额（元）。用例改这个值来构造「够 / 不够 / 完全没钱」。 */
  let walletBalance: Decimal;
  /** 成员个人钱包余额（元）。默认 0 —— 多数用例只关心企业那两腿。 */
  let personalBalance: Decimal;
  let creditRow: CreditRow | null;
  let personalWallet: any;
  let allowance: any;
  let allowanceNotifier: any;
  /** 闸门给这一笔的企业资金上限。null = 不限额（默认）。 */
  let allowanceCap: Decimal | null;

  beforeEach(() => {
    walletBalance = new Decimal(100);
    personalBalance = new Decimal(0);
    allowanceCap = null;
    creditRow = null;
    createdRecord = null;

    prisma = {
      platformModel: { findUnique: jest.fn().mockResolvedValue({ isFree: false }) },
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
      computeUsageRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => {
          createdRecord = a.data;
          return Promise.resolve({ id: "usage-1", ...a.data });
        }),
        aggregate: jest.fn(),
      },
      subscriptionCredit: {
        findUnique: jest.fn(() => Promise.resolve(creditRow)),
        create: jest.fn((a: any) =>
          Promise.resolve({ id: "credit-1", ...a.data }),
        ),
        update: jest.fn((a: any) =>
          Promise.resolve({ id: a.where.id, ...a.data }),
        ),
        updateMany: jest.fn((a: any) => {
          // 模拟乐观锁：版本不匹配则 0 行受影响
          if (creditRow && a.where.version !== creditRow.version) {
            return Promise.resolve({ count: 0 });
          }
          if (creditRow) {
            creditRow.usedCNY = a.data.usedCNY;
            creditRow.status = a.data.status;
            creditRow.version += 1;
          }
          return Promise.resolve({ count: 1 });
        }),
      },
      $transaction: jest.fn((cb: any) => cb(prisma)),
    };

    wallet = {
      ensureWalletExists: jest.fn(() =>
        Promise.resolve({ id: "wallet-1", balance: walletBalance }),
      ),
      // 真实实现的语义：有多少扣多少，差额作为 unpaid 返回，余额不变负
      consumeComputeUpTo: jest.fn(
        async (_client: unknown, _entId: string, amount: Decimal) => {
          const paid = Decimal.min(walletBalance, amount);
          const unpaid = amount.sub(paid);
          walletBalance = walletBalance.sub(paid);
          return {
            transactionId: paid.greaterThan(0) ? "wtx-1" : null,
            paid,
            unpaid,
          };
        },
      ),
    };

    // 真实实现的语义：有多少扣多少，没有钱包行也不抛异常（返回全 0 + unpaid）
    personalWallet = {
      consumeUpTo: jest.fn(
        async (_client: unknown, _userId: string, amount: Decimal) => {
          const want = Decimal.max(0, amount);
          const paid = Decimal.min(personalBalance, want);
          personalBalance = personalBalance.sub(paid);
          return {
            transactionId: paid.greaterThan(0) ? "ptx-1" : null,
            paid,
            unpaid: want.sub(paid),
          };
        },
      ),
      getBalance: jest.fn(async () => personalBalance),
    };

    settings = {
      getEffectiveValue: jest.fn((key: string) => FLAT_PRICE_SETTINGS[key]),
    };

    // 闸门默认不限额 —— 这组用例锁的是扣费顺序与恒等式，不是分配规则。
    // 想构造「公司只出 ¥X」的用例，改 allowanceCap 即可。
    allowance = {
      planCharge: jest.fn(async () => ({
        windowId: allowanceCap === null ? null : "w-1",
        enterpriseCapCNY: allowanceCap,
        regularRemainingCNY: allowanceCap ?? new Decimal(0),
        limitCNY: allowanceCap,
        carriedInCNY: new Decimal(0),
        topUps: [],
      })),
      commitCharge: jest.fn(async () => ({ fromTopUpCNY: new Decimal(0) })),
      check: jest
        .fn()
        .mockResolvedValue({ allowed: true, enterpriseFundsAllowed: true }),
    };

    allowanceNotifier = { afterCharge: jest.fn(async () => undefined) };
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token', effective_rate_multiplier: 1,
    })));

    svc = new ComputeCreditService(
      prisma,
      wallet,
      personalWallet,
      settings,
      allowance,
      allowanceNotifier,
      new ModelBillingService(prisma, settings),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const charge = (overrides: Record<string, unknown> = {}) =>
    svc.chargeUsage({
      enterpriseId: ENTERPRISE,
      subscriptionId: SUBSCRIPTION,
      employeeId: "emp-1",
      userId: "user-1",
      sessionId: "sess-1",
      messageId: "msg-1",
      modelId: "unknown-model",
      inputTokens: 10_000, // × ¥1 / 1K = ¥10
      outputTokens: 0,
      ...overrides,
    } as any);

  it('活动免费保留非零 token 用量账单，不消耗赠送、钱包或额度', async () => {
    prisma.platformModel.findUnique.mockResolvedValue({ isFree: true });
    creditRow = makeCredit({ grantedCNY: new Decimal(50) });
    personalBalance = new Decimal(40);
    allowanceCap = new Decimal(0);

    const result = await charge();

    expect(result.costCNY.toNumber()).toBe(0);
    expect(result.unpaidCNY.toNumber()).toBe(0);
    expect(Number(createdRecord.inputPriceUsdPerMillion)).toBe(0);
    expect(createdRecord.inputTokens).toBe(10_000);
    expect(walletBalance.toNumber()).toBe(100);
    expect(personalBalance.toNumber()).toBe(40);
    expect(creditRow.usedCNY.toNumber()).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('关闭免费恢复中转倍率，并只应用一次倍率', async () => {
    (global.fetch as jest.Mock).mockImplementation(async () => new Response(JSON.stringify({
      object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token', effective_rate_multiplier: 0.5,
    })));

    const result = await charge();

    expect(result.costCNY.toNumber()).toBe(5);
    expect(walletBalance.toNumber()).toBe(95);
    expect(Number(createdRecord.inputPriceUsdPerMillion)).toBeCloseTo(1000 / 7.2 / 2);
  });

  it('冻结的免费规则在活动关闭后仍以零元结算', async () => {
    prisma.platformModel.findUnique.mockResolvedValue({ isFree: true });
    const billingSnapshot = await svc.getBillingSnapshot('unknown-model');
    prisma.platformModel.findUnique.mockResolvedValue({ isFree: false });

    expect((await charge({ billingSnapshot })).costCNY.toNumber()).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('免费模型余额为零且额度用尽时仍放行，不查询资金闸门', async () => {
    prisma.platformModel.findUnique.mockResolvedValue({ isFree: true });
    walletBalance = new Decimal(0);
    allowance.check.mockResolvedValue({ allowed: false, enterpriseFundsAllowed: false });

    expect(await svc.checkBalanceBeforeConversation(ENTERPRISE, SUBSCRIPTION, 'user-1', 'unknown-model'))
      .toMatchObject({ allowed: true, enterpriseFundsAllowed: true });
    expect(allowance.check).not.toHaveBeenCalled();
  });

  it('非免费模型仍受额度与余额闸门限制', async () => {
    allowance.check.mockResolvedValue({ allowed: false, enterpriseFundsAllowed: false, reason: '额度用尽' });

    expect(await svc.checkBalanceBeforeConversation(ENTERPRISE, SUBSCRIPTION, 'user-1', 'unknown-model'))
      .toMatchObject({ allowed: false, enterpriseFundsAllowed: false });
  });

  it('未知中转倍率不扣费，也不落入倍率 1', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('unavailable'));

    await expect(charge()).rejects.toMatchObject({ status: 503 });
    expect(prisma.computeUsageRecord.create).not.toHaveBeenCalled();
    expect(wallet.consumeComputeUpTo).not.toHaveBeenCalled();
  });

  it('关闭企业拒绝新扣费，并按账号、企业的顺序锁定', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ status: 'ACTIVE' }]).mockResolvedValueOnce([{ status: 'CLOSED' }]);
    await expect(charge()).rejects.toThrow(ConflictException);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('FROM users');
    expect(prisma.$queryRaw.mock.calls[1][0].join('')).toContain('FROM enterprises');
    expect(prisma.computeUsageRecord.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionCredit.updateMany).not.toHaveBeenCalled();
    expect(wallet.consumeComputeUpTo).not.toHaveBeenCalled();
  });

  it("赠送余额充足时全额从赠送扣，不动钱包", async () => {
    creditRow = makeCredit({ grantedCNY: new Decimal(50) });

    const result = await charge();

    expect(result.costCNY.toNumber()).toBe(10);
    expect(result.creditPaidCNY.toNumber()).toBe(10);
    expect(result.walletPaidCNY.toNumber()).toBe(0);
    expect(walletBalance.toNumber()).toBe(100);
    expect(creditRow!.usedCNY.toNumber()).toBe(10);
    expect(creditRow!.status).toBe("ACTIVE");
  });

  it("❗赠送余额不足时先扣光赠送，差额才扣钱包", async () => {
    creditRow = makeCredit({ grantedCNY: new Decimal(4) });

    const result = await charge();

    expect(result.creditPaidCNY.toNumber()).toBe(4);
    expect(result.walletPaidCNY.toNumber()).toBe(6);
    expect(result.unpaidCNY.toNumber()).toBe(0);
    expect(walletBalance.toNumber()).toBe(94);
    // 赠送用尽后要标记 EXHAUSTED，否则下次还会尝试从这里扣
    expect(creditRow!.status).toBe("EXHAUSTED");
  });

  it("没有订阅赠送额度时整笔走钱包", async () => {
    creditRow = null;

    const result = await charge();

    expect(result.creditPaidCNY.toNumber()).toBe(0);
    expect(result.walletPaidCNY.toNumber()).toBe(10);
    expect(walletBalance.toNumber()).toBe(90);
  });

  it("赠送额度已停用（订阅终止）时不再扣它", async () => {
    creditRow = makeCredit({ grantedCNY: new Decimal(50), status: "EXPIRED" });

    const result = await charge();

    expect(result.creditPaidCNY.toNumber()).toBe(0);
    expect(result.walletPaidCNY.toNumber()).toBe(10);
    // 停用的额度余额不动
    expect(creditRow!.usedCNY.toNumber()).toBe(0);
  });

  it("❗别家企业的 subscriptionId 不能花本企业的赠送额度", async () => {
    creditRow = makeCredit({
      grantedCNY: new Decimal(50),
      enterpriseId: "ent-globex", // ← 别家
    });

    const result = await charge();

    expect(result.creditPaidCNY.toNumber()).toBe(0);
    expect(result.walletPaidCNY.toNumber()).toBe(10);
    expect(creditRow!.usedCNY.toNumber()).toBe(0);
  });

  it("❗钱包余额不足时扣到 0 并记欠费，余额绝不变负", async () => {
    creditRow = null;
    walletBalance = new Decimal(3);

    const result = await charge();

    expect(result.walletPaidCNY.toNumber()).toBe(3);
    expect(result.unpaidCNY.toNumber()).toBe(7);
    expect(walletBalance.toNumber()).toBe(0);
    // 恒等式：赠送 + 企业钱包 + 个人钱包 + 欠费 == 成本。
    // 少一项就有钱不知去向 —— 这是整套账本唯一不能破的等式。
    expect(
      result.creditPaidCNY
        .add(result.walletPaidCNY)
        .add(result.personalPaidCNY)
        .add(result.unpaidCNY)
        .toNumber(),
    ).toBe(result.costCNY.toNumber());
  });

  it("成员专属充值余额用尽后不自动扣企业公共钱包", async () => {
    allowance.consumeMemberWalletUpTo = jest.fn().mockResolvedValue({ paid: new Decimal(0) });
    allowanceCap = new Decimal(10);
    walletBalance = new Decimal(100);

    const result = await charge();

    expect(result.walletPaidCNY.toNumber()).toBe(0);
    expect(wallet.consumeComputeUpTo).not.toHaveBeenCalled();
    expect(result.unpaidCNY.toNumber()).toBeGreaterThan(0);
  });

  it("❗流式重试命中幂等键时不重复扣费", async () => {
    prisma.computeUsageRecord.findUnique.mockResolvedValue({
      id: "usage-existing",
      costCNY: new Decimal(10),
      creditPaidCNY: new Decimal(10),
      memberWalletPaidCNY: new Decimal(0),
      walletPaidCNY: new Decimal(0),
      personalPaidCNY: new Decimal(0),
      unpaidCNY: new Decimal(0),
      fallbackPricing: true,
    });
    creditRow = makeCredit({ grantedCNY: new Decimal(50) });

    const result = await charge();

    expect(result.alreadyCharged).toBe(true);
    expect(result.usageRecordId).toBe("usage-existing");
    expect(result.personalPaidCNY.toNumber()).toBe(0);
    expect(prisma.computeUsageRecord.create).not.toHaveBeenCalled();
    expect(wallet.consumeComputeUpTo).not.toHaveBeenCalled();
    expect(personalWallet.consumeUpTo).not.toHaveBeenCalled();
    expect(creditRow!.usedCNY.toNumber()).toBe(0);
  });

  it("幂等键由 sessionId + messageId 构成", async () => {
    creditRow = null;

    await charge({ sessionId: "sess-9", messageId: "msg-9" });

    expect(prisma.computeUsageRecord.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: "sess-9:msg-9" },
    });
    expect(createdRecord.idempotencyKey).toBe("sess-9:msg-9");
  });

  it("❗并发扣同一笔赠送额度时抛冲突，整笔重试而不是静默少扣", async () => {
    creditRow = makeCredit({ grantedCNY: new Decimal(50) });
    // 模拟「读到 version=0，写入前别人已经改成 1」
    prisma.subscriptionCredit.updateMany.mockResolvedValue({ count: 0 });

    await expect(charge()).rejects.toThrow(ConflictException);
    expect(prisma.computeUsageRecord.create).not.toHaveBeenCalled();
  });

  it("账单落库时同时记下 Token 明细与计价参数，便于事后复核", async () => {
    creditRow = makeCredit({ grantedCNY: new Decimal(50) });

    await charge({ inputTokens: 1000, outputTokens: 500 });

    expect(createdRecord).toMatchObject({
      enterpriseId: ENTERPRISE,
      subscriptionId: SUBSCRIPTION,
      employeeId: "emp-1",
      userId: "user-1",
      sessionId: "sess-1",
      messageId: "msg-1",
      modelId: "unknown-model",
      inputTokens: 1000,
      outputTokens: 500,
      fallbackPricing: true,
    });
    expect(Number(createdRecord.usdToCnyRate)).toBe(7.2);
    // Token 只是明细：金额由单价算出，不是 token 数本身
    expect(Number(createdRecord.costCNY)).toBeCloseTo(1, 6);
  });

  it("成本为 0 的调用不扣任何余额，但仍留一条账单", async () => {
    creditRow = makeCredit({ grantedCNY: new Decimal(50) });

    const result = await charge({ inputTokens: 0, outputTokens: 0 });

    expect(result.costCNY.toNumber()).toBe(0);
    expect(result.creditPaidCNY.toNumber()).toBe(0);
    expect(result.walletPaidCNY.toNumber()).toBe(0);
    expect(prisma.computeUsageRecord.create).toHaveBeenCalled();
  });

  it("钱包在进入事务前就绪 —— 事务内建钱包会和乐观锁纠缠", async () => {
    creditRow = null;

    await charge();

    expect(wallet.ensureWalletExists).toHaveBeenCalledWith(ENTERPRISE);
  });

  describe("个人钱包与额度闸门 —— 扣费链的第三腿", () => {
    it("❗企业钱包还有钱时个人余额一分不动 —— 个人钱包排最后不是排第二", async () => {
      creditRow = null;
      walletBalance = new Decimal(100);
      personalBalance = new Decimal(50);

      const result = await charge();

      expect(result.walletPaidCNY.toNumber()).toBe(10);
      expect(result.personalPaidCNY.toNumber()).toBe(0);
      // 成员充了钱不等于他要替公司买单
      expect(personalBalance.toNumber()).toBe(50);
    });

    it("❗额度剩 ¥0.30 而这笔要 ¥10 → 拆成公司 0.30 + 成员 9.70", async () => {
      creditRow = null;
      allowanceCap = new Decimal("0.3");
      walletBalance = new Decimal(100);
      personalBalance = new Decimal(50);

      const result = await charge();

      expect(result.walletPaidCNY.toNumber()).toBe(0.3);
      expect(result.personalPaidCNY.toNumber()).toBe(9.7);
      expect(result.unpaidCNY.toNumber()).toBe(0);
      // 企业钱包只被扣了限额那么多，剩下的没超额付
      expect(walletBalance.toNumber()).toBe(99.7);
      expect(personalBalance.toNumber()).toBe(40.3);
    });

    it("❗额度用尽（上限 0）→ 企业资金一分不出，全额自费，对话照常发生", async () => {
      creditRow = makeCredit({ grantedCNY: new Decimal(50) });
      allowanceCap = new Decimal(0);
      walletBalance = new Decimal(100);
      personalBalance = new Decimal(50);

      const result = await charge();

      expect(result.creditPaidCNY.toNumber()).toBe(0);
      expect(result.walletPaidCNY.toNumber()).toBe(0);
      expect(result.personalPaidCNY.toNumber()).toBe(10);
      expect(result.unpaidCNY.toNumber()).toBe(0);
      // 闸门是「不许花公司的钱」，不是「不许扣款」：两边余额都要如实变化
      expect(walletBalance.toNumber()).toBe(100);
      expect(creditRow!.usedCNY.toNumber()).toBe(0);
      expect(personalBalance.toNumber()).toBe(40);
    });

    it("❗欠费对着成本重算，不能拿钱包相对限额的差额当欠费", async () => {
      // 限额 0.30，钱包只有 0.10：钱包会返回 unpaid=0.20（相对限额），
      // 但这一笔真正的缺口是 10 − 0.10 = 9.90。写错这里会让账单少记 9.70 的欠费。
      creditRow = null;
      allowanceCap = new Decimal("0.3");
      walletBalance = new Decimal("0.1");
      personalBalance = new Decimal(0);

      const result = await charge();

      expect(result.walletPaidCNY.toNumber()).toBe(0.1);
      expect(result.personalPaidCNY.toNumber()).toBe(0);
      expect(result.unpaidCNY.toNumber()).toBe(9.9);
      expect(
        result.creditPaidCNY
          .add(result.walletPaidCNY)
          .add(result.personalPaidCNY)
          .add(result.unpaidCNY)
          .toNumber(),
      ).toBe(result.costCNY.toNumber());
    });

    it("❗回写追加额度的金额封顶在企业预算内 —— 成员自己欠的钱不该抵公司额度", async () => {
      // 限额 0.30，企业实际一分没出（钱包空），缺口 10 全成欠费。
      // 若不封顶，公司的追加额度会被这 10 元一次性抽干。
      creditRow = null;
      allowanceCap = new Decimal("0.3");
      walletBalance = new Decimal(0);
      personalBalance = new Decimal(0);

      const result = await charge();

      expect(result.unpaidCNY.toNumber()).toBe(10);
      const funded = allowance.commitCharge.mock.calls[0][2];
      expect(funded.toNumber()).toBe(0.3);
    });

    it("不限额时回写口径就是 credit + 钱包 + 欠费（= 成本 − 自付）", async () => {
      creditRow = makeCredit({ grantedCNY: new Decimal(4) });
      walletBalance = new Decimal(3);
      personalBalance = new Decimal(1);

      const result = await charge();

      expect(result.creditPaidCNY.toNumber()).toBe(4);
      expect(result.walletPaidCNY.toNumber()).toBe(3);
      expect(result.personalPaidCNY.toNumber()).toBe(1);
      expect(result.unpaidCNY.toNumber()).toBe(2);
      const funded = allowance.commitCharge.mock.calls[0][2];
      // 9 = 成本 10 − 成员自付 1：成员自费的部分绝不算进公司额度的已用
      expect(funded.toNumber()).toBe(9);
    });

    it("系统内部调用（没有 userId）不碰个人钱包，差额直接记欠费", async () => {
      creditRow = null;
      walletBalance = new Decimal(3);
      personalBalance = new Decimal(50);

      const result = await charge({ userId: null });

      expect(personalWallet.consumeUpTo).not.toHaveBeenCalled();
      expect(result.personalPaidCNY.toNumber()).toBe(0);
      expect(result.unpaidCNY.toNumber()).toBe(7);
      expect(personalBalance.toNumber()).toBe(50);
    });

    it("账单落下个人腿、个人流水号与周期窗口 id", async () => {
      creditRow = null;
      allowanceCap = new Decimal("0.3");
      personalBalance = new Decimal(50);

      await charge();

      expect(Number(createdRecord.personalPaidCNY)).toBeCloseTo(9.7, 6);
      expect(createdRecord.personalWalletTransactionId).toBe("ptx-1");
      // 归到窗口才能按周期聚合「本周期已用」
      expect(createdRecord.allowanceWindowId).toBe("w-1");
    });

    it("闸门在动用企业资金之前就问过 —— 事后才发现超额，钱已经出去了", async () => {
      creditRow = makeCredit({ grantedCNY: new Decimal(50) });

      await charge();

      const planOrder = allowance.planCharge.mock.invocationCallOrder[0];
      const creditOrder =
        prisma.subscriptionCredit.updateMany.mock.invocationCallOrder[0];
      const walletOrder = wallet.consumeComputeUpTo.mock.invocationCallOrder[0];
      expect(planOrder).toBeLessThan(creditOrder);
      expect(planOrder).toBeLessThan(walletOrder);
    });

    it("成本为 0 时个人钱包也不动", async () => {
      creditRow = null;
      personalBalance = new Decimal(50);

      const result = await charge({ inputTokens: 0, outputTokens: 0 });

      expect(result.personalPaidCNY.toNumber()).toBe(0);
      expect(personalBalance.toNumber()).toBe(50);
    });
  });

  describe("额度通知 —— 扣完之后、事务之外", () => {
    it("❗把闸门的额度快照与这一笔的去向交给通知判定，省掉它自己再打一遍库", async () => {
      creditRow = makeCredit({ grantedCNY: new Decimal(4) });
      allowanceCap = new Decimal(50);

      await charge(); // 成本 ¥10：赠送 4 + 钱包 6

      expect(allowanceNotifier.afterCharge).toHaveBeenCalledTimes(1);
      const input = allowanceNotifier.afterCharge.mock.calls[0][0];
      expect(input.enterpriseId).toBe(ENTERPRISE);
      expect(input.userId).toBe("user-1");
      expect(input.windowId).toBe("w-1");
      expect(input.limitCNY.toNumber()).toBe(50);
      expect(input.availableBeforeCNY.toNumber()).toBe(50);
      expect(input.regularRemainingBeforeCNY.toNumber()).toBe(50);
      // 与闸门「已用」同口径：赠送 + 钱包 + 欠费
      expect(input.enterpriseUsedDeltaCNY.toNumber()).toBe(10);
      expect(input.walletPaidCNY.toNumber()).toBe(6);
    });

    it("❗通知在事务提交之后才发 —— 通知失败不该回滚一笔已经发生的消费", async () => {
      creditRow = makeCredit({ grantedCNY: new Decimal(50) });

      await charge();

      const notifyOrder =
        allowanceNotifier.afterCharge.mock.invocationCallOrder[0];
      const recordOrder =
        prisma.computeUsageRecord.create.mock.invocationCallOrder[0];
      expect(recordOrder).toBeLessThan(notifyOrder);
    });

    it("欠费那部分也算进企业已用 —— 公司终究要付", async () => {
      creditRow = null;
      walletBalance = new Decimal(3);
      allowanceCap = new Decimal(50);
      personalBalance = new Decimal(0);

      await charge(); // 成本 ¥10：钱包 3 + 欠费 7

      expect(
        allowanceNotifier.afterCharge.mock.calls[0][0].enterpriseUsedDeltaCNY.toNumber(),
      ).toBe(10);
    });

    it("❗幂等重放不再发一遍通知", async () => {
      prisma.computeUsageRecord.findUnique.mockResolvedValue({
        id: "usage-existing",
        costCNY: new Decimal(10),
        creditPaidCNY: new Decimal(10),
        walletPaidCNY: new Decimal(0),
        personalPaidCNY: new Decimal(0),
        unpaidCNY: new Decimal(0),
        fallbackPricing: false,
      });

      const result = await charge();

      expect(result.alreadyCharged).toBe(true);
      expect(allowanceNotifier.afterCharge).not.toHaveBeenCalled();
    });
  });
});
