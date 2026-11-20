import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Decimal } from "@prisma/client/runtime/library";
import { PaymentService } from "./payment.service";

describe("PaymentService", () => {
  let service: PaymentService;
  let prisma: any;
  let orderService: any;
  let walletService: any;
  let personalWalletService: any;
  let alipayProvider: any;

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn() },
      $transaction: jest.fn(async (callback) => callback(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ status: "ACTIVE" }]),
      personalRechargeOrder: { findUnique: jest.fn() },
      paymentNotify: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    orderService = {
      fulfillInTransaction: jest.fn().mockResolvedValue({
        id: "order-1",
        status: "PAID",
      }),
    };
    walletService = { consume: jest.fn().mockResolvedValue({ id: "tx-1" }) };
    personalWalletService = { fulfillRechargeOrder: jest.fn() };
    alipayProvider = {
      pagePayment: jest.fn().mockResolvedValue("https://payment.example/form"),
      verifyNotify: jest.fn().mockReturnValue(true),
    };

    service = new PaymentService(
      prisma,
      { get: jest.fn().mockReturnValue("https://sep.example") } as any,
      orderService,
      alipayProvider,
      {} as any,
      walletService,
      personalWalletService,
    );
    jest.spyOn(service, "initializeAlipay").mockResolvedValue(undefined);
  });

  describe("payOrderWithBalance", () => {
    it('fulfills a zero order in the transaction without accessing the wallet or Alipay', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-free', orderNo: 'FREE1', enterpriseId: 'ent-1', createdBy: 'user-1',
        status: 'PENDING', totalAmount: new Decimal(0),
      });
      const result = await service.payOrderWithBalance('order-free', 'ent-1');
      expect(walletService.consume).not.toHaveBeenCalled();
      expect(alipayProvider.pagePayment).not.toHaveBeenCalled();
      expect(orderService.fulfillInTransaction).toHaveBeenCalledWith(prisma, 'order-free', 'FREE:FREE1', 'BALANCE');
      expect(result.status).toBe('PAID');
    });

    it('rejects negative order totals without charging or fulfilling', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1', enterpriseId: 'ent-1', createdBy: 'user-1', status: 'PENDING', totalAmount: new Decimal(-1),
      });
      await expect(service.payOrderWithBalance('order-1', 'ent-1')).rejects.toThrow(BadRequestException);
      expect(walletService.consume).not.toHaveBeenCalled();
      expect(orderService.fulfillInTransaction).not.toHaveBeenCalled();
    });
    it("等待企业锁期间已支付的订单不重复扣款", async () => {
      prisma.order.findUnique.mockResolvedValueOnce({ id: 'order-1', enterpriseId: 'ent-1', createdBy: 'user-1', status: 'PENDING' })
        .mockResolvedValueOnce({ id: 'order-1', enterpriseId: 'ent-1', status: 'PAID' });
      await expect(service.payOrderWithBalance('order-1', 'ent-1')).rejects.toThrow(BadRequestException);
      expect(walletService.consume).not.toHaveBeenCalled();
      expect(orderService.fulfillInTransaction).not.toHaveBeenCalled();
    });

    it("企业关闭后拒绝余额付款和履约", async () => {
      prisma.order.findUnique.mockResolvedValue({ id: 'order-1', enterpriseId: 'ent-1', createdBy: 'user-1', status: 'PENDING' });
      prisma.$queryRaw.mockResolvedValueOnce([{ status: 'ACTIVE' }]).mockResolvedValueOnce([{ status: 'CLOSED' }]);
      await expect(service.payOrderWithBalance('order-1', 'ent-1')).rejects.toThrow(ConflictException);
      expect(walletService.consume).not.toHaveBeenCalled();
      expect(orderService.fulfillInTransaction).not.toHaveBeenCalled();
    });

    it("应在同一事务内完成余额扣款和订单履约", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "order-1",
        orderNo: "ORD202608200001",
        enterpriseId: "ent-1",
        status: "PENDING",
        totalAmount: new Decimal(5000),
      });

      const result = await service.payOrderWithBalance("order-1", "ent-1");

      expect(walletService.consume).toHaveBeenCalledWith(
        "ent-1",
        5000,
        "subscription",
        "order-1",
        "余额支付订单 ORD202608200001",
        prisma,
      );
      expect(orderService.fulfillInTransaction).toHaveBeenCalledWith(
        prisma,
        "order-1",
        "BALANCE:ORD202608200001",
        "BALANCE",
      );
      expect(result.status).toBe("PAID");
    });

    it("跨企业订单应返回不存在且不扣款", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "order-1",
        enterpriseId: "ent-other",
        status: "PENDING",
      });

      await expect(
        service.payOrderWithBalance("order-1", "ent-1"),
      ).rejects.toThrow(NotFoundException);
      expect(walletService.consume).not.toHaveBeenCalled();
    });

    it("非待支付订单应拒绝重复扣款", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "order-1",
        enterpriseId: "ent-1",
        status: "PAID",
      });

      await expect(
        service.payOrderWithBalance("order-1", "ent-1"),
      ).rejects.toThrow(BadRequestException);
      expect(walletService.consume).not.toHaveBeenCalled();
    });
  });

  it('does not send a zero order to Alipay', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order-free', status: 'PENDING', totalAmount: new Decimal(0) });
    await expect(service.createAlipayPayment('order-free')).rejects.toThrow('免费订单无需支付宝支付，请直接确认开通');
    expect(service.initializeAlipay).not.toHaveBeenCalled();
    expect(alipayProvider.pagePayment).not.toHaveBeenCalled();
  });

  describe("personal recharge closure protection", () => {
    beforeEach(() => {
      prisma.personalRechargeOrder.findUnique.mockResolvedValue({
        id: "personal-order", orderNo: "PRC1", userId: "user-1",
        amount: new Decimal(30), status: "PENDING",
      });
    });

    it("locks and checks the user before generating a personal recharge payment", async () => {
      const result = await service.createPersonalRechargeAlipayPayment("PRC1");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw.mock.calls[0][0].join("?")).toContain("FROM users WHERE id = ? FOR UPDATE");
      expect(result.paymentForm).toBe("https://payment.example/form");
    });

    it.each(["CLOSURE_PENDING", "CLOSED", "DISABLED"])("does not generate a payment for a %s account", async (status) => {
      prisma.$queryRaw.mockResolvedValue([{ status }]);
      await expect(service.createPersonalRechargeAlipayPayment("PRC1")).rejects.toThrow(ConflictException);
      expect(alipayProvider.pagePayment).not.toHaveBeenCalled();
    });

    it("retains the verified failed payment notification for manual reconciliation instead of acknowledging payment", async () => {
      personalWalletService.fulfillRechargeOrder.mockRejectedValue(new ConflictException("账号当前不可自动入账，已付款请联系管理员人工对账"));
      const result = await service.handleAlipayNotify({
        out_trade_no: "PRC1", trade_no: "late-trade", trade_status: "TRADE_SUCCESS",
      });
      expect(result.success).toBe(false);
      expect(prisma.paymentNotify.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        outTradeNo: "PRC1", tradeNo: "late-trade", verified: true, processed: false,
      }) });
      expect(prisma.paymentNotify.updateMany).not.toHaveBeenCalled();
    });

    it("acknowledges a duplicate fulfilled recharge notification without crediting again", async () => {
      prisma.paymentNotify.findFirst.mockResolvedValue({ processed: true });
      const result = await service.handleAlipayNotify({
        out_trade_no: "PRC1", trade_no: "paid-trade", trade_status: "TRADE_SUCCESS",
      });
      expect(result.success).toBe(true);
      expect(personalWalletService.fulfillRechargeOrder).not.toHaveBeenCalled();
    });
  });
});
