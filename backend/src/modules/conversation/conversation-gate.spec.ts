/**
 * 逐条消息的额度闸门。
 *
 * 这组用例锁的是一个曾经真实存在的漏洞：闸门只挂在「新建会话」上，
 * 老会话开着不关，成员额度用尽后照样能一直发消息，事后只在账单上堆欠费 ——
 * 「公司这周期最多为你付 ¥50」于是形同虚设。
 *
 * 另一半同样重要：额度用尽**不是**拦停。个人余额有钱时对话必须照常发生，
 * 只是这一轮由成员自己付（方案 §5.7 ④ 改道语义）。
 */
import { ConversationStreamService } from "./conversation-stream.service";
import { ServiceUnavailableException } from '@nestjs/common';
import type { SseEvent } from "./conversation.types";

/** acquireLock 抛这个哨兵：拿到它就说明执行流已经越过闸门。 */
const REACHED_LOCK = new Error("__reached_lock__");

describe("ConversationStreamService —— 逐条消息的额度闸门", () => {
  let prisma: any;
  let computeCredit: any;
  let sessionLock: any;
  let modelConfig: any;
  let svc: ConversationStreamService;

  const session = {
    id: "sess-1",
    userId: "user-1",
    employeeId: "emp-1",
    employee: { id: "emp-1", name: "小助手", bindings: [] },
  };

  beforeEach(() => {
    prisma = {
      conversationSession: { findUnique: jest.fn().mockResolvedValue(session) },
      subscription: { findUnique: jest.fn().mockResolvedValue({ id: "sub-1" }) },
      message: { create: jest.fn() },
      platformModel: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    computeCredit = {
      getBillingSnapshot: jest.fn().mockResolvedValue({
        modelId: 'model', isFree: false, billingMultiplier: 1, rate: 7,
        inputPriceUsdPerMillion: 0.15, outputPriceUsdPerMillion: 0.6, isFallback: false,
      }),
      checkBalanceBeforeConversation: jest.fn(),
    };
    sessionLock = { acquireLock: jest.fn().mockRejectedValue(REACHED_LOCK) };
    modelConfig = { resolveEffectiveModel: jest.fn().mockResolvedValue({ chatModel: 'model' }) };

    svc = new ConversationStreamService(
      prisma,
      {} as any, // capabilityService
      sessionLock,
      {} as any, // conversationService
      {} as any, // subscriptionService
      {} as any, // settingService
      { resolve: jest.fn().mockResolvedValue({ enterpriseId: "ent-1" }) } as any,
      {} as any, // knowledgeSearch
      modelConfig,
      {} as any, // uploadService
      {} as any, // attachmentContext
      computeCredit,
      { getSnapshot: jest.fn().mockResolvedValue({ version: 0, values: {} }) } as any,
      {} as any,
      { internalOutputTokens: jest.fn().mockReturnValue(4096) } as any,
    );
  });

  /** 收流直到结束或抛错；抛错时把已收到的事件一并交出来。 */
  async function collect(): Promise<{ events: SseEvent[]; error?: unknown }> {
    const events: SseEvent[] = [];
    try {
      for await (const e of svc.streamConversation("sess-1", "你好", "user-1")) {
        events.push(e);
      }
    } catch (error) {
      return { events, error };
    }
    return { events };
  }

  it('requires an available model within the resolved enterprise before billing or writing', async () => {
    modelConfig.resolveEffectiveModel.mockRejectedValue(new ServiceUnavailableException('No permitted model'));
    const { error } = await collect();
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(modelConfig.resolveEffectiveModel).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', enterpriseId: 'ent-1', requireAvailableModel: true,
    }));
    expect(computeCredit.getBillingSnapshot).not.toHaveBeenCalled();
    expect(sessionLock.acquireLock).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("❗额度与个人余额双空时拦下本条消息，不加锁、不落库", async () => {
    computeCredit.checkBalanceBeforeConversation.mockResolvedValue({
      allowed: false,
      enterpriseFundsAllowed: false,
      enterpriseFundsBlockedBy: "ALLOWANCE",
      creditRemainingCNY: 0,
      walletBalanceCNY: 0,
      totalAvailableCNY: 0,
      personalBalanceCNY: 0,
      reason:
        "你本月的算力额度已用完（已用 ¥50.00 / 上限 ¥50.00），个人余额也已用尽。" +
        "额度将于 2026-10-01 00:00 重置；",
    });

    const { events, error } = await collect();

    expect(error).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as Record<string, unknown>;
    expect(data.code).toBe("COMPUTE_BLOCKED");
    expect(data.blockedBy).toBe("ALLOWANCE");
    // 出路必须在话术里，否则用户只看到「不能用」
    expect(String(data.message)).toContain("重置");

    // 被拦下的消息不占会话锁，也不该在历史里留一条永远没有回复的用户消息
    expect(sessionLock.acquireLock).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("❗额度用尽但个人余额有钱 → 改道自费，对话继续（notice 而非 error）", async () => {
    computeCredit.checkBalanceBeforeConversation.mockResolvedValue({
      allowed: true,
      enterpriseFundsAllowed: false,
      enterpriseFundsBlockedBy: "ALLOWANCE",
      creditRemainingCNY: 0,
      walletBalanceCNY: 0,
      totalAvailableCNY: 0,
      personalBalanceCNY: 20,
      reason: "你本月的算力额度已用完，本次对话将由你的个人余额支付（当前 ¥20.00）。",
    });

    const { events, error } = await collect();

    // 越过闸门后才会去拿锁 —— 拿到哨兵就证明这一轮没被拦
    expect(error).toBe(REACHED_LOCK);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("notice");
    const data = events[0].data as Record<string, unknown>;
    expect(data.code).toBe("COMPUTE_SELF_PAID");
    expect(data.personalBalanceCNY).toBe("20.00");
  });

  it("企业资金可用时不多发事件，直接进入正常流程", async () => {
    computeCredit.checkBalanceBeforeConversation.mockResolvedValue({
      allowed: true,
      enterpriseFundsAllowed: true,
      creditRemainingCNY: 100,
      walletBalanceCNY: 0,
      totalAvailableCNY: 100,
      personalBalanceCNY: 0,
    });

    const { events, error } = await collect();

    expect(error).toBe(REACHED_LOCK);
    expect(events).toHaveLength(0);
  });

  it("闸门收到的是本人 + 本企业 + 本雇佣关系，缺一个就判错人", async () => {
    computeCredit.checkBalanceBeforeConversation.mockResolvedValue({
      allowed: true,
      enterpriseFundsAllowed: true,
      creditRemainingCNY: 1,
      walletBalanceCNY: 0,
      totalAvailableCNY: 1,
      personalBalanceCNY: 0,
    });

    await collect();

    expect(computeCredit.checkBalanceBeforeConversation).toHaveBeenCalledWith(
      "ent-1",
      "sub-1",
      "user-1",
      expect.objectContaining({ modelId: "model", billingMultiplier: 1 }),
    );
  });
});
