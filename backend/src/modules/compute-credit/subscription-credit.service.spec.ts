/**
 * 赠送额度的发放、解析与余额闸门。
 *
 * 重点是「员工级配置 > 系统默认值」这条规则里 null 与 0 的区别 ——
 * 把两者混为一谈会让系统默认值对所有存量员工突然生效，
 * 产生一批没人批准过的赠送额度。
 */
import { Decimal } from "@prisma/client/runtime/library";
import { ComputeCreditService } from "./compute-credit.service";
import { SETTING_KEYS } from "shared";

describe("ComputeCreditService —— 赠送额度", () => {
  let prisma: any;
  let wallet: any;
  let settings: any;
  let svc: ComputeCreditService;
  let defaultGift: string | undefined;
  let giftPercentage: string | undefined;
  let walletBalance: Decimal;
  let personalBalance: Decimal;
  let personalWallet: any;
  let allowance: any;

  beforeEach(() => {
    defaultGift = "1000";
    giftPercentage = undefined;
    walletBalance = new Decimal(0);
    personalBalance = new Decimal(0);

    prisma = {
      subscriptionCredit: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) =>
          Promise.resolve({ id: "credit-1", ...a.data }),
        ),
        update: jest.fn((a: any) =>
          Promise.resolve({ id: a.where.id, ...a.data }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    wallet = {
      ensureWalletExists: jest.fn(() =>
        Promise.resolve({ id: "wallet-1", balance: walletBalance }),
      ),
    };
    settings = {
      getEffectiveValue: jest.fn((key: string) =>
        key === SETTING_KEYS.DEFAULT_EMPLOYEE_GIFT_CNY
          ? defaultGift
          : key === SETTING_KEYS.DEFAULT_EMPLOYEE_GIFT_PERCENTAGE
            ? giftPercentage
            : undefined,
      ),
    };
    personalWallet = {
      getBalance: jest.fn(async () => personalBalance),
      consumeUpTo: jest.fn(),
    };
    // 额度闸门默认放行 —— 这组用例锁的是发放与企业余额，不是分配规则
    allowance = {
      check: jest
        .fn()
        .mockResolvedValue({ allowed: true, enterpriseFundsAllowed: true }),
      planCharge: jest.fn(),
      commitCharge: jest.fn(),
      getMemberWalletBalance: jest.fn().mockResolvedValue(new Decimal(0)),
    };
    svc = new ComputeCreditService(
      prisma,
      wallet,
      personalWallet,
      settings,
      allowance,
      { afterCharge: jest.fn() } as any,
      {} as any,
    );
  });

  describe("resolveGrantAmountCNY —— 员工级配置 > 系统默认值", () => {
    it("员工未配置（null）时用系统默认值", async () => {
      await expect(svc.resolveGrantAmountCNY(null)).resolves.toBe(1000);
      await expect(svc.resolveGrantAmountCNY(undefined)).resolves.toBe(1000);
    });

    it("❗员工明确配置 0 时优先于比例和默认金额", async () => {
      giftPercentage = "15";
      // `|| default` 会把 0 吞掉，让运营「这个员工不赠送」的决定被静默覆盖。
      await expect(
        svc.resolveGrantAmountCNY(new Decimal(0), 5000),
      ).resolves.toBe(0);
      await expect(svc.resolveGrantAmountCNY(0, 5000)).resolves.toBe(0);
    });

    it("员工金额未配置时按年费比例赠送，并按账本精度舍入", async () => {
      giftPercentage = "12.5";
      await expect(
        svc.resolveGrantAmountCNY(null, new Decimal("1234.567891")),
      ).resolves.toBe(154.320986);
    });

    it("比例为 0、非法或年费非正时回退默认金额", async () => {
      giftPercentage = "0";
      await expect(svc.resolveGrantAmountCNY(null, 5000)).resolves.toBe(1000);
      giftPercentage = "not-a-number";
      await expect(svc.resolveGrantAmountCNY(null, 5000)).resolves.toBe(1000);
      giftPercentage = "101";
      await expect(svc.resolveGrantAmountCNY(null, 5000)).resolves.toBe(1000);
      giftPercentage = "10";
      await expect(svc.resolveGrantAmountCNY(null, 0)).resolves.toBe(1000);
    });

    it("员工配置了金额时覆盖系统默认值", async () => {
      await expect(svc.resolveGrantAmountCNY(new Decimal(500))).resolves.toBe(
        500,
      );
    });

    it("系统默认值非法或缺失时按 0，不把 NaN 写进账本", async () => {
      defaultGift = "abc";
      await expect(svc.resolveGrantAmountCNY(null)).resolves.toBe(0);

      defaultGift = undefined;
      await expect(svc.resolveGrantAmountCNY(null)).resolves.toBe(0);

      defaultGift = "-100";
      await expect(svc.resolveGrantAmountCNY(null)).resolves.toBe(0);
    });
  });

  describe("grantSubscriptionCredit", () => {
    it("首次发放按传入金额创建，状态为可用", async () => {
      await svc.grantSubscriptionCredit(prisma, {
        subscriptionId: "sub-1",
        enterpriseId: "ent-1",
        employeeId: "emp-1",
        grantedCNY: 1000,
        sourceType: "subscription",
      });

      const data = prisma.subscriptionCredit.create.mock.calls[0][0].data;
      expect(Number(data.grantedCNY)).toBe(1000);
      expect(data.status).toBe("ACTIVE");
      expect(data.sourceType).toBe("subscription");
    });

    it("赠送 0 元时直接标记用尽，避免前端显示成「有额度可用」", async () => {
      await svc.grantSubscriptionCredit(prisma, {
        subscriptionId: "sub-1",
        enterpriseId: "ent-1",
        employeeId: "emp-1",
        grantedCNY: 0,
        sourceType: "subscription",
      });

      const data = prisma.subscriptionCredit.create.mock.calls[0][0].data;
      expect(data.status).toBe("EXHAUSTED");
    });

    it("❗重复履约不追加金额 —— 否则重复调用就是刷额度的口子", async () => {
      prisma.subscriptionCredit.findUnique.mockResolvedValue({
        id: "credit-1",
        grantedCNY: new Decimal(1000),
        usedCNY: new Decimal(300),
        status: "ACTIVE",
      });

      await svc.grantSubscriptionCredit(prisma, {
        subscriptionId: "sub-1",
        enterpriseId: "ent-1",
        employeeId: "emp-1",
        grantedCNY: 1000,
        sourceType: "order",
      });

      expect(prisma.subscriptionCredit.create).not.toHaveBeenCalled();
      const data = prisma.subscriptionCredit.update.mock.calls[0][0].data;
      // 只恢复可用状态，不碰金额
      expect(data).toEqual({ status: "ACTIVE" });
    });

    it("重新订阅时把已用尽的额度如实标回 EXHAUSTED，不假装可用", async () => {
      prisma.subscriptionCredit.findUnique.mockResolvedValue({
        id: "credit-1",
        grantedCNY: new Decimal(1000),
        usedCNY: new Decimal(1000),
        status: "EXPIRED",
      });

      await svc.grantSubscriptionCredit(prisma, {
        subscriptionId: "sub-1",
        enterpriseId: "ent-1",
        employeeId: "emp-1",
        grantedCNY: 1000,
        sourceType: "subscription",
      });

      const data = prisma.subscriptionCredit.update.mock.calls[0][0].data;
      expect(data.status).toBe("EXHAUSTED");
    });
  });

  describe("expireSubscriptionCredit", () => {
    it("订阅终止后额度不可用（第一版不折现、不退回）", async () => {
      await svc.expireSubscriptionCredit(prisma, "sub-1");

      expect(prisma.subscriptionCredit.updateMany).toHaveBeenCalledWith({
        where: { subscriptionId: "sub-1", status: { not: "EXPIRED" } },
        data: { status: "EXPIRED" },
      });
    });
  });

  describe("checkBalanceBeforeConversation —— 对话前的余额闸门", () => {
    it("赠送余额有钱就放行，即使钱包为空", async () => {
      prisma.subscriptionCredit.findUnique.mockResolvedValue({
        grantedCNY: new Decimal(100),
        usedCNY: new Decimal(30),
        status: "ACTIVE",
      });
      walletBalance = new Decimal(0);

      const result = await svc.checkBalanceBeforeConversation("ent-1", "sub-1");

      expect(result.allowed).toBe(true);
      expect(result.creditRemainingCNY).toBe(70);
      expect(result.totalAvailableCNY).toBe(70);
    });

    it("赠送用尽但钱包有钱时放行 —— 赠送归零不代表员工不能用了", async () => {
      prisma.subscriptionCredit.findUnique.mockResolvedValue({
        grantedCNY: new Decimal(100),
        usedCNY: new Decimal(100),
        status: "EXHAUSTED",
      });
      walletBalance = new Decimal(50);

      const result = await svc.checkBalanceBeforeConversation("ent-1", "sub-1");

      expect(result.allowed).toBe(true);
      expect(result.creditRemainingCNY).toBe(0);
      expect(result.walletBalanceCNY).toBe(50);
    });

    it("企业公共钱包为空但成员有充值余额时仍放行", async () => {
      prisma.subscriptionCredit.findUnique.mockResolvedValue(null);
      walletBalance = new Decimal(0);
      allowance.getMemberWalletBalance.mockResolvedValue(new Decimal(300));

      const result = await svc.checkBalanceBeforeConversation(
        "ent-1",
        "sub-1",
        "user-1",
      );

      expect(result.allowed).toBe(true);
      expect(result.enterpriseFundsAllowed).toBe(true);
      expect(result.memberWalletBalanceCNY).toBe(300);
      expect(result.totalAvailableCNY).toBe(300);
      expect(personalWallet.getBalance).not.toHaveBeenCalled();
    });

    it("❗两者都为 0 时拦下，并给出可操作的提示", async () => {
      prisma.subscriptionCredit.findUnique.mockResolvedValue(null);
      walletBalance = new Decimal(0);

      const result = await svc.checkBalanceBeforeConversation("ent-1", "sub-1");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("充值");
    });

    it("已停用的赠送额度不计入可用余额", async () => {
      prisma.subscriptionCredit.findUnique.mockResolvedValue({
        grantedCNY: new Decimal(100),
        usedCNY: new Decimal(0),
        status: "EXPIRED",
      });
      walletBalance = new Decimal(0);

      const result = await svc.checkBalanceBeforeConversation("ent-1", "sub-1");

      // 花不掉的钱显示成剩余，会让企业以为还能对话
      expect(result.allowed).toBe(false);
      expect(result.creditRemainingCNY).toBe(0);
    });

    it("无订阅时只看钱包余额", async () => {
      walletBalance = new Decimal(20);

      const result = await svc.checkBalanceBeforeConversation("ent-1", null);

      expect(prisma.subscriptionCredit.findUnique).not.toHaveBeenCalled();
      expect(result.allowed).toBe(true);
      expect(result.totalAvailableCNY).toBe(20);
    });

    it("成员充值余额耗尽时不自动使用企业公共钱包", async () => {
      walletBalance = new Decimal(20);

      const result = await svc.checkBalanceBeforeConversation(
        "ent-1",
        null,
        "user-1",
      );

      expect(result.enterpriseFundsAllowed).toBe(false);
      expect(result.allowed).toBe(false);
      expect(result.enterpriseFundsBlockedBy).toBe("BALANCE");
      expect(personalWallet.getBalance).toHaveBeenCalledWith("user-1");
      expect(result.personalBalanceCNY).toBe(0);
    });

    it("❗企业资金见底但个人余额有钱 → 改道自费，不是拦停", async () => {
      walletBalance = new Decimal(0);
      personalBalance = new Decimal(20);

      const result = await svc.checkBalanceBeforeConversation(
        "ent-1",
        null,
        "user-1",
      );

      // 扣费链走到个人钱包那一腿照样会付款，这里拦死等于凭空拒掉一次付得起的对话
      expect(result.allowed).toBe(true);
      expect(result.enterpriseFundsAllowed).toBe(false);
      expect(result.personalBalanceCNY).toBe(20);
      expect(result.reason).toContain("个人余额支付");
    });

    it("❗额度闸门关掉企业资金时原样透传，不再去看企业余额", async () => {
      allowance.check.mockResolvedValue({
        enterpriseFundsAllowed: false,
        allowed: true,
        reason:
          "你本月的算力额度已用完，本次对话将由你的个人余额支付（当前 ¥8.00）。",
        personalBalanceCNY: "8.00",
      });
      walletBalance = new Decimal(999);

      const result = await svc.checkBalanceBeforeConversation(
        "ent-1",
        "sub-1",
        "user-1",
      );

      expect(result.allowed).toBe(true);
      expect(result.enterpriseFundsAllowed).toBe(false);
      expect(result.personalBalanceCNY).toBe(8);
      // 企业还有 999 元，但这个人已经不许花公司的钱了 —— 余额不该被展示成可用
      expect(result.totalAvailableCNY).toBe(0);
      expect(prisma.subscriptionCredit.findUnique).not.toHaveBeenCalled();
      expect(wallet.ensureWalletExists).not.toHaveBeenCalled();
    });

    it("额度与个人余额双空时才真的拦，理由沿用闸门给出的出路", async () => {
      allowance.check.mockResolvedValue({
        enterpriseFundsAllowed: false,
        allowed: false,
        reason: "你本月的算力额度已用完，个人余额也已用尽。额度将于 … 重置；",
        personalBalanceCNY: "0.00",
      });

      const result = await svc.checkBalanceBeforeConversation(
        "ent-1",
        "sub-1",
        "user-1",
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("额度将于");
    });
  });
});
