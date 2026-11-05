import { Test, TestingModule } from "@nestjs/testing";
import { OrderService } from "./order.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SubscriptionFulfillmentService } from "../subscription-fulfillment/subscription-fulfillment.service";
import { EmployeeBundleService } from "../employee-bundle/employee-bundle.service";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Decimal } from "@prisma/client/runtime/library";

describe("OrderService", () => {
  let service: OrderService;
  let prisma: any;
  let creditService: any;
  let bundleService: any;

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
      cartItem: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      order: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      subscription: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: "sub-1" }),
        update: jest.fn().mockResolvedValue({ id: "sub-1" }),
      },
      subscriptionCredit: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => Promise.resolve({ id: "credit-1", ...a.data })),
        update: jest.fn((a: any) => Promise.resolve({ id: a.where.id, ...a.data })),
      },
      enterpriseMember: {
        findUnique: jest.fn().mockResolvedValue({
          id: "mem-admin",
          role: "ENTERPRISE_ADMIN",
        }),
      },
      employeeGrant: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      digitalEmployee: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(prisma)),
    };

    creditService = {
      // 「员工级配置 > 系统默认值」的解析；这里直接回落员工级配置
      resolveGrantAmountCNY: jest.fn(async (override: unknown) =>
        override === null || override === undefined ? 0 : Number(override),
      ),
      grantSubscriptionCredit: jest.fn(async (tx: any, params: any) =>
        tx.subscriptionCredit.create({ data: params }),
      ),
      expireSubscriptionCredit: jest.fn(),
    };
    bundleService = {
      getForPurchase: jest.fn(),
      resolveGiftCNY: jest.fn(async (item: any) => item.includedComputeCNY?.toNumber() ?? 20),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmployeeBundleService, useValue: bundleService },
        // 用真实履约服务：建订阅、自动授权、发赠送额度都是它的职责，
        // mock 掉就等于不测「支付成功后企业到底拿到了什么」
        {
          provide: SubscriptionFulfillmentService,
          useFactory: () =>
            new SubscriptionFulfillmentService(prisma as any, creditService as any),
        },
      ],
    }).compile();

    service = module.get<OrderService>(OrderService);
  });

  describe("createFromCart", () => {
    it("购物车为空应拒绝", async () => {
      prisma.cartItem.findMany.mockResolvedValue([]);

      await expect(service.createFromCart("ent-1", "user-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("购物车中存在未审核员工应拒绝", async () => {
      prisma.cartItem.findMany.mockResolvedValue([
        {
          employeeId: "emp-1",
          periodMonths: 12,
          employee: {
            id: "emp-1",
            name: "销售助手",
            annualPriceCNY: new Decimal(5000),
            includedComputeCNY: new Decimal(1000),
            status: "DRAFT",
          },
        },
      ]);

      await expect(service.createFromCart("ent-1", "user-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("应正确创建订单并计算金额", async () => {
      prisma.cartItem.findMany.mockResolvedValue([
        {
          enterpriseId: "ent-1",
          employeeId: "emp-1",
          periodMonths: 12,
          employee: {
            id: "emp-1",
            name: "销售助手",
            annualPriceCNY: new Decimal(5000),
            includedComputeCNY: new Decimal(1000),
            status: "APPROVED",
          },
        },
      ]);

      prisma.order.create.mockResolvedValue({
        id: "order-1",
        orderNo: "20260811120000123456",
        totalAmount: new Decimal(5000),
      });

      const result = await service.createFromCart("ent-1", "user-1");

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          enterpriseId: "ent-1",
          createdBy: "user-1",
          status: "PENDING",
          totalAmount: expect.any(Decimal),
          items: {
            create: [
              expect.objectContaining({
                employeeId: "emp-1",
                employeeName: "销售助手",
                unitPrice: expect.any(Decimal),
                periodMonths: 12,
                quantity: 1,
              }),
            ],
          },
        }),
        include: expect.any(Object),
      });

      expect(result.id).toBe("order-1");
    });

    it("总金额不再乘数量 —— 一员工一份，只按周期折算", async () => {
      prisma.cartItem.findMany.mockResolvedValue([
        {
          enterpriseId: "ent-1",
          employeeId: "emp-1",
          periodMonths: 6,
          employee: {
            id: "emp-1",
            name: "销售助手",
            annualPriceCNY: new Decimal(5000),
            includedComputeCNY: new Decimal(1000),
            status: "APPROVED",
          },
        },
      ]);
      prisma.order.create.mockResolvedValue({ id: "order-1" });

      await service.createFromCart("ent-1", "user-1");

      const data = prisma.order.create.mock.calls[0][0].data;
      // 5000 * (6/12) = 2500
      expect(data.totalAmount.toString()).toBe("2500");
      // 赠送算力取单份，不随周期或数量放大
      expect(data.items.create[0].includedComputeCNY.toString()).toBe("1000");
    });
  });

  describe("findOne", () => {
    it("订单不存在应返回 404", async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.findOne("order-999", "ent-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("跨租户访问应返回 404", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "order-1",
        enterpriseId: "ent-other",
      });

      await expect(service.findOne("order-1", "ent-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("应成功返回订单详情", async () => {
      const mockOrder = {
        id: "order-1",
        enterpriseId: "ent-1",
        orderNo: "20260811120000123456",
        totalAmount: new Decimal(10000),
      };

      prisma.order.findUnique.mockResolvedValue(mockOrder);

      const result = await service.findOne("order-1", "ent-1");

      expect(result).toEqual(mockOrder);
    });
  });

  describe("createDirect", () => {
    const approvedEmployee = {
      id: "emp-1",
      name: "销售助手",
      avatar: null,
      description: "描述",
      annualPriceCNY: new Decimal(5000),
      includedComputeCNY: new Decimal(1000),
      status: "APPROVED",
    };

    it("应创建不依赖购物车的直接订单并按周期折算金额", async () => {
      prisma.digitalEmployee.findUnique.mockResolvedValue(approvedEmployee);
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.order.create.mockResolvedValue({ id: "order-1" });

      await service.createDirect("ent-1", "user-1", {
        employeeId: "emp-1",
        periodMonths: 6,
      });

      expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            enterpriseId: "ent-1",
            createdBy: "user-1",
            totalAmount: new Decimal(2500),
            items: {
              create: [
                expect.objectContaining({
                  employeeId: "emp-1",
                  periodMonths: 6,
                  unitPrice: new Decimal(5000),
                }),
              ],
            },
          }),
        }),
      );
    });

    it("已存在 ACTIVE 订阅时应拒绝重复下单", async () => {
      prisma.digitalEmployee.findUnique.mockResolvedValue(approvedEmployee);
      prisma.subscription.findUnique.mockResolvedValue({ status: "ACTIVE" });

      await expect(
        service.createDirect("ent-1", "user-1", {
          employeeId: "emp-1",
          periodMonths: 12,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("未审核员工应拒绝下单", async () => {
      prisma.digitalEmployee.findUnique.mockResolvedValue({
        ...approvedEmployee,
        status: "DRAFT",
      });

      await expect(
        service.createDirect("ent-1", "user-1", {
          employeeId: "emp-1",
          periodMonths: 12,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createBundle', () => {
    const bundle = {
      id: 'bundle-1',
      name: 'Operations bundle',
      priceCNY: new Decimal(300),
      periodMonths: 12,
      items: [
        {
          id: 'bundle-item-1', employeeId: 'emp-1', periodMonths: 12, includedComputeCNY: null,
          employee: { id: 'emp-1', name: 'Sales', version: '1.0.0', annualPriceCNY: new Decimal(100), includedComputeCNY: null },
        },
        {
          id: 'bundle-item-2', employeeId: 'emp-2', periodMonths: 12, includedComputeCNY: new Decimal(0),
          employee: { id: 'emp-2', name: 'Support', version: '2.1.0', annualPriceCNY: new Decimal(300), includedComputeCNY: null },
        },
      ],
    };

    it('creates a pending bundle order with server-calculated employee price and compute snapshots', async () => {
      bundleService.getForPurchase.mockResolvedValue(bundle);
      prisma.order.create.mockResolvedValue({ id: 'order-bundle-1', totalAmount: new Decimal(300) });

      await service.createBundle('ent-1', 'user-1', 'bundle-1');

      const create = prisma.order.create.mock.calls[0][0];
      expect(create.data).toMatchObject({
        enterpriseId: 'ent-1',
        createdBy: 'user-1',
        orderType: 'BUNDLE',
        bundleId: 'bundle-1',
        bundleName: 'Operations bundle',
        totalAmount: new Decimal(300),
        status: 'PENDING',
      });
      expect(create.data.items.create.map((item: any) => ({
        employeeId: item.employeeId,
        employeeVersion: item.employeeVersion,
        purchaseAmountCNY: item.purchaseAmountCNY.toString(),
        includedComputeCNY: item.includedComputeCNY.toString(),
      }))).toEqual([
        { employeeId: 'emp-1', employeeVersion: '1.0.0', purchaseAmountCNY: '75', includedComputeCNY: '20' },
        { employeeId: 'emp-2', employeeVersion: '2.1.0', purchaseAmountCNY: '225', includedComputeCNY: '0' },
      ]);
    });

    it('rejects the bundle if the enterprise already has an active bundle employee', async () => {
      bundleService.getForPurchase.mockResolvedValue(bundle);
      prisma.subscription.findMany.mockResolvedValueOnce([{ employeeId: 'emp-2' }]);

      await expect(service.createBundle('ent-1', 'user-1', 'bundle-1')).rejects.toThrow(BadRequestException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('keeps rounded employee allocations non-negative and within a low bundle price', async () => {
      const tinyBundle = {
        ...bundle,
        priceCNY: new Decimal('0.02'),
        items: Array.from({ length: 4 }, (_, index) => ({
          id: `item-${index}`,
          employeeId: `emp-${index}`,
          periodMonths: 12,
          includedComputeCNY: null,
          employee: {
            id: `emp-${index}`,
            name: `Employee ${index}`,
            version: '1.0.0',
            annualPriceCNY: new Decimal(1),
            includedComputeCNY: null,
          },
        })),
      };
      bundleService.getForPurchase.mockResolvedValue(tinyBundle);
      prisma.order.create.mockResolvedValue({ id: 'tiny-order' });

      await service.createBundle('ent-1', 'user-1', 'bundle-tiny');

      const amounts = prisma.order.create.mock.calls[0][0].data.items.create
        .map((item: any) => item.purchaseAmountCNY);
      expect(amounts.every((amount: Decimal) => amount.greaterThanOrEqualTo(0))).toBe(true);
      expect(amounts.reduce((sum: Decimal, amount: Decimal) => sum.add(amount), new Decimal(0)).toString()).toBe('0.02');
    });
  });

  describe("fulfill", () => {
    it("关闭企业的待付款订单拒绝履约，保留人工对账状态", async () => {
      prisma.order.findUnique.mockResolvedValue({ id: 'order-1', status: 'PENDING', enterpriseId: 'ent-1', createdBy: 'user-1', items: [] });
      prisma.$queryRaw.mockResolvedValueOnce([{ status: 'ACTIVE' }]).mockResolvedValueOnce([{ status: 'CLOSED' }]);
      await expect(service.fulfill('order-1', 'trade-1')).rejects.toThrow(ConflictException);
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.subscription.create).not.toHaveBeenCalled();
    });

    it("订单不存在应返回 404", async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.fulfill("order-999", "alipay-123")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("已支付订单应跳过重复处理", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "order-1",
        status: "PAID",
      });

      const result = await service.fulfill("order-1", "alipay-123");

      expect(result.status).toBe("PAID");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("非 PENDING 订单应拒绝履约", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "order-1",
        status: "CLOSED",
      });

      await expect(service.fulfill("order-1", "alipay-123")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("应成功履约并完成所有操作", async () => {
      const mockOrder = {
        id: "order-1",
        orderNo: "20260811120000123456",
        enterpriseId: "ent-1",
        status: "PENDING",
        items: [
          {
            id: "item-1",
            employeeId: "emp-1",
            employeeName: "销售助手",
            periodMonths: 12,
            includedComputeCNY: new Decimal(2000),
            employee: {},
          },
        ],
      };

      prisma.order.findUnique.mockResolvedValue(mockOrder);
      prisma.order.update.mockResolvedValue({ ...mockOrder, status: "PAID" });
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.digitalEmployee.findUnique.mockResolvedValue({ version: "2.1.0" });
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });

      await service.fulfill("order-1", "alipay-123");

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "order-1" },
        data: expect.objectContaining({
          status: "PAID",
          payTradeNo: "alipay-123",
          paidAt: expect.any(Date),
        }),
      });

      expect(prisma.subscription.create).toHaveBeenCalled();
      // expiresAt 取履约算出的订阅到期日（下单周期推出），不再依赖建订阅的返回值
      expect(prisma.employeeGrant.create).toHaveBeenCalledWith({
        data: {
          subscriptionId: "sub-1",
          memberId: "mem-admin",
          expiresAt: expect.any(Date),
        },
      });
      // 赠送额度按下单时的快照发放为人民币余额，不再往旧算力账户充值
      expect(creditService.grantSubscriptionCredit).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          subscriptionId: "sub-1",
          enterpriseId: "ent-1",
          employeeId: "emp-1",
          grantedCNY: 2000,
          sourceType: "order",
          sourceId: "order-1",
        }),
      );
      expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
        where: {
          enterpriseId: "ent-1",
          employeeId: { in: ["emp-1"] },
        },
      });
    });

    it("❗履约只建雇佣关系，不再按数量创建实例", async () => {
      const mockOrder = {
        id: "order-1",
        orderNo: "20260811120000123456",
        enterpriseId: "ent-1",
        status: "PENDING",
        items: [
          {
            id: "item-1",
            employeeId: "emp-1",
            employeeName: "销售助手",
            periodMonths: 12,
            includedComputeCNY: new Decimal(0),
            employee: {},
          },
        ],
      };

      prisma.order.findUnique.mockResolvedValue(mockOrder);
      prisma.order.update.mockResolvedValue({ ...mockOrder, status: "PAID" });
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.digitalEmployee.findUnique.mockResolvedValue({ version: "2.1.0" });
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });

      await service.fulfill("order-1", "alipay-123");

      // 一个订单项 → 恰好一次 upsert，不循环建实例
      expect(prisma.subscription.create).toHaveBeenCalledTimes(1);
      expect(prisma.employeeInstance).toBeUndefined();
    });

    it("支付履约后自动授权给下单的企业管理员", async () => {
      const mockOrder = {
        id: "order-1",
        orderNo: "20260811120000123456",
        enterpriseId: "ent-1",
        createdBy: "admin-user",
        status: "PENDING",
        items: [
          {
            id: "item-1",
            employeeId: "emp-1",
            employeeName: "销售助手",
            periodMonths: 12,
            includedComputeCNY: new Decimal(0),
            employee: {},
          },
        ],
      };

      prisma.order.findUnique.mockResolvedValue(mockOrder);
      prisma.order.update.mockResolvedValue({ ...mockOrder, status: "PAID" });
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.subscription.create.mockResolvedValue({
        id: "sub-1",
        endDate: new Date("2027-08-28"),
      });
      prisma.digitalEmployee.findUnique.mockResolvedValue({ version: "2.1.0" });
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });

      await service.fulfill("order-1", "alipay-123");

      expect(prisma.enterpriseMember.findUnique).toHaveBeenCalledWith({
        where: {
          userId_enterpriseId: {
            userId: "admin-user",
            enterpriseId: "ent-1",
          },
        },
        select: { id: true, role: true },
      });
      expect(prisma.employeeGrant.create).toHaveBeenCalledWith({
        data: {
          subscriptionId: "sub-1",
          memberId: "mem-admin",
          expiresAt: expect.any(Date),
        },
      });
    });

    it("已有管理员授权时更新到新的订阅到期日，不重复创建", async () => {
      const mockOrder = {
        id: "order-1",
        orderNo: "20260811120000123456",
        enterpriseId: "ent-1",
        createdBy: "admin-user",
        status: "PENDING",
        items: [
          {
            id: "item-1",
            employeeId: "emp-1",
            employeeName: "销售助手",
            periodMonths: 12,
            includedComputeCNY: new Decimal(0),
            employee: {},
          },
        ],
      };

      prisma.order.findUnique.mockResolvedValue(mockOrder);
      prisma.order.update.mockResolvedValue({ ...mockOrder, status: "PAID" });
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.subscription.create.mockResolvedValue({
        id: "sub-1",
        endDate: new Date("2027-08-28"),
      });
      prisma.digitalEmployee.findUnique.mockResolvedValue({ version: "2.1.0" });
      prisma.employeeGrant.findFirst.mockResolvedValue({ id: "grant-1" });
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });

      await service.fulfill("order-1", "alipay-123");

      expect(prisma.employeeGrant.update).toHaveBeenCalledWith({
        where: { id: "grant-1" },
        data: { expiresAt: expect.any(Date) },
      });
      expect(prisma.employeeGrant.create).not.toHaveBeenCalled();
    });

    it("非企业管理员创建的订单不能履约", async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: "mem-member",
        role: "MEMBER",
      });
      prisma.order.findUnique.mockResolvedValue({
        id: "order-1",
        enterpriseId: "ent-1",
        createdBy: "member-user",
        status: "PENDING",
        items: [],
      });

      await expect(service.fulfill("order-1", "alipay-123")).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("雇佣关系锁定履约时刻的模板版本，而非写死版本号", async () => {
      const mockOrder = {
        id: "order-1",
        orderNo: "20260811120000123456",
        enterpriseId: "ent-1",
        status: "PENDING",
        items: [
          {
            id: "item-1",
            employeeId: "emp-1",
            employeeName: "销售助手",
            periodMonths: 12,
            includedComputeCNY: new Decimal(0),
            employee: {},
          },
        ],
      };

      prisma.order.findUnique.mockResolvedValue(mockOrder);
      prisma.order.update.mockResolvedValue({ ...mockOrder, status: "PAID" });
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.digitalEmployee.findUnique.mockResolvedValue({ version: "2.1.0" });
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });

      await service.fulfill("order-1", "alipay-123");

      const createArg = prisma.subscription.create.mock.calls[0][0];
      expect(createArg.data).toMatchObject({
        enterpriseId: "ent-1",
        employeeId: "emp-1",
        status: "ACTIVE",
        templateVersion: "2.1.0",
        name: "销售助手",
      });
    });

    it("订单项对应的员工已被删除时报 404，不落半份雇佣关系", async () => {
      const mockOrder = {
        id: "order-1",
        orderNo: "20260811120000123456",
        enterpriseId: "ent-1",
        status: "PENDING",
        items: [
          {
            id: "item-1",
            employeeId: "emp-gone",
            employeeName: "销售助手",
            periodMonths: 12,
            includedComputeCNY: new Decimal(0),
            employee: {},
          },
        ],
      };

      prisma.order.findUnique.mockResolvedValue(mockOrder);
      prisma.order.update.mockResolvedValue({ ...mockOrder, status: "PAID" });
      prisma.digitalEmployee.findUnique.mockResolvedValue(null);

      await expect(service.fulfill("order-1", "alipay-123")).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.subscription.create).not.toHaveBeenCalled();
    });
  });
});
