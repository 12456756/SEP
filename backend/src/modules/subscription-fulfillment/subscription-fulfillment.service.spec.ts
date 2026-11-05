/**
 * 订阅履约的共用实现。
 *
 * 收敛前直接订阅与市场支付各写一份「建订阅 + 自动授权 + 发赠送额度」，
 * 结果两条链路的账务结果不一致。这里的用例就是那条验收标准：
 * **市场支付和直接订阅的授权、赠送和账务结果必须一致**。
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { SubscriptionFulfillmentService } from './subscription-fulfillment.service';

const EMPLOYEE = {
  id: 'emp-1',
  name: '销售助手',
  version: '2.1.0',
  includedComputeCNY: null as Decimal | null,
  annualPriceCNY: new Decimal(5000),
};

describe('SubscriptionFulfillmentService', () => {
  let prisma: any;
  let credits: any;
  let svc: SubscriptionFulfillmentService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
      digitalEmployee: { findUnique: jest.fn().mockResolvedValue(EMPLOYEE) },
      subscription: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => Promise.resolve({ id: 'sub-1', ...a.data })),
        update: jest.fn((a: any) => Promise.resolve({ id: a.where.id, ...a.data })),
      },
      employeeGrant: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      enterpriseMember: { findUnique: jest.fn() },
    };
    credits = {
      resolveGrantAmountCNY: jest.fn().mockResolvedValue(1000),
      grantSubscriptionCredit: jest.fn().mockResolvedValue({ id: 'credit-1' }),
    };
    svc = new SubscriptionFulfillmentService(prisma, credits);
  });

  const baseParams = {
    enterpriseId: 'ent-1',
    employeeId: 'emp-1',
    purchaserMemberId: 'mem-admin',
  };

  describe('新建订阅', () => {
    it('企业关闭后拒绝新增订阅和赠送额度', async () => {
      prisma.$queryRaw.mockResolvedValue([{ status: 'CLOSED' }]);
      await expect(svc.fulfill(prisma, { ...baseParams, sourceType: 'subscription' }))
        .rejects.toThrow(ConflictException);
      expect(prisma.subscription.create).not.toHaveBeenCalled();
      expect(credits.grantSubscriptionCredit).not.toHaveBeenCalled();
    });

    it('锁定履约时刻的模板版本，而非写死版本号', async () => {
      await svc.fulfill(prisma, { ...baseParams, sourceType: 'subscription' });

      const data = prisma.subscription.create.mock.calls[0][0].data;
      // templateVersion 是「提示式升级」的基准，写错会让模板发新版后永远提示可升级
      expect(data.templateVersion).toBe('2.1.0');
      expect(data.status).toBe('ACTIVE');
    });

    it('订单提供模板版本快照时优先使用下单时版本', async () => {
      await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'order',
        templateVersion: '2.0.0',
      });

      const data = prisma.subscription.create.mock.calls[0][0].data;
      expect(data.templateVersion).toBe('2.0.0');
    });

    it('购买方（管理员）默认获得使用权，无需再手动分配', async () => {
      await svc.fulfill(prisma, { ...baseParams, sourceType: 'subscription' });

      expect(prisma.employeeGrant.create).toHaveBeenCalledWith({
        data: {
          subscriptionId: 'sub-1',
          memberId: 'mem-admin',
          expiresAt: null,
        },
      });
    });

    it('员工不存在时报 404，不落半份订阅', async () => {
      prisma.digitalEmployee.findUnique.mockResolvedValue(null);

      await expect(
        svc.fulfill(prisma, { ...baseParams, sourceType: 'subscription' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.subscription.create).not.toHaveBeenCalled();
    });
  });

  describe('复活订阅', () => {
    beforeEach(() => {
      prisma.subscription.findUnique.mockResolvedValue({ id: 'sub-old' });
    });

    it('❗不刷新 templateVersion —— 停用期间的模板变更要照样提示', async () => {
      await svc.fulfill(prisma, { ...baseParams, sourceType: 'subscription' });

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.status).toBe('ACTIVE');
      // 写进去就等于把「员工已变过」这件事静默吞掉
      expect(data).not.toHaveProperty('templateVersion');
    });

    it('已有授权时更新到新的到期日，不重复创建', async () => {
      prisma.employeeGrant.findFirst.mockResolvedValue({ id: 'grant-1' });
      const endDate = new Date('2027-01-01');

      await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'order',
        endDate,
      });

      expect(prisma.employeeGrant.update).toHaveBeenCalledWith({
        where: { id: 'grant-1' },
        data: { expiresAt: endDate },
      });
      expect(prisma.employeeGrant.create).not.toHaveBeenCalled();
    });

    it('二次购买从现有到期日续期，不重置订阅开始日', async () => {
      const startDate = new Date('2026-01-01');
      const currentEndDate = new Date('2027-01-01');
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-old',
        status: 'ACTIVE',
        startDate,
        endDate: currentEndDate,
      });

      await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'order',
        startDate: new Date('2026-11-05'),
        endDate: new Date('2027-11-05'),
        purchasePeriodMonths: 12,
      });

      expect(prisma.subscription.update.mock.calls[0][0].data).toMatchObject({
        status: 'ACTIVE',
        endDate: new Date('2028-01-01'),
      });
      expect(prisma.subscription.update.mock.calls[0][0].data).not.toHaveProperty('startDate');
    });

    it('二次购买不会把永久订阅改成限期订阅', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-old',
        status: 'ACTIVE',
        startDate: new Date('2026-01-01'),
        endDate: null,
      });

      await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'order',
        startDate: new Date('2026-11-05'),
        endDate: new Date('2027-11-05'),
        purchasePeriodMonths: 12,
      });

      expect(prisma.subscription.update.mock.calls[0][0].data.endDate).toBeNull();
      expect(prisma.subscription.update.mock.calls[0][0].data).not.toHaveProperty('startDate');
    });

    it('返回 created=false，让调用方能区分新建与复活', async () => {
      const result = await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'subscription',
      });
      expect(result.created).toBe(false);
    });
  });

  describe('赠送额度', () => {
    it('调用方给出金额时按它发放（市场订单用下单时的快照）', async () => {
      await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'order',
        sourceId: 'order-1',
        grantedCNY: 2000,
      });

      // 订单已成交，运营事后改配置不该改变已付款订单的赠送金额
      expect(credits.resolveGrantAmountCNY).not.toHaveBeenCalled();
      expect(credits.grantSubscriptionCredit).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          grantedCNY: 2000,
          sourceType: 'order',
          sourceId: 'order-1',
        }),
      );
    });

    it('调用方未给金额时回落「员工级配置 > 系统默认值」', async () => {
      await svc.fulfill(prisma, { ...baseParams, sourceType: 'subscription' });

      expect(credits.resolveGrantAmountCNY).toHaveBeenCalledWith(
        null,
        EMPLOYEE.annualPriceCNY,
      );
      expect(credits.grantSubscriptionCredit).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ grantedCNY: 1000 }),
      );
    });

    it('❗赠送 0 元要照常调用发放 —— 记录必须存在，只是余额为 0', async () => {
      await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'order',
        grantedCNY: 0,
      });

      // 不建记录会让「这个员工赠送了多少」在账上无从查证
      expect(credits.grantSubscriptionCredit).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ grantedCNY: 0 }),
      );
    });
  });

  describe('两条链路结果一致（验收标准）', () => {
    it('直接订阅与市场支付产出同样的订阅、授权和赠送额度', async () => {
      const direct = await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'subscription',
        grantedCNY: 1000,
      });
      const directSubscription = prisma.subscription.create.mock.calls[0][0].data;
      const directGrant = prisma.employeeGrant.create.mock.calls[0][0].data;
      const directCredit = credits.grantSubscriptionCredit.mock.calls[0][1];

      jest.clearAllMocks();
      prisma.digitalEmployee.findUnique.mockResolvedValue(EMPLOYEE);
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.subscription.create.mockImplementation((a: any) =>
        Promise.resolve({ id: 'sub-1', ...a.data }),
      );
      prisma.employeeGrant.findFirst.mockResolvedValue(null);
      credits.grantSubscriptionCredit.mockResolvedValue({ id: 'credit-1' });

      const viaOrder = await svc.fulfill(prisma, {
        ...baseParams,
        sourceType: 'order',
        sourceId: 'order-1',
        grantedCNY: 1000,
      });
      const orderSubscription = prisma.subscription.create.mock.calls[0][0].data;
      const orderGrant = prisma.employeeGrant.create.mock.calls[0][0].data;
      const orderCredit = credits.grantSubscriptionCredit.mock.calls[0][1];

      expect(orderSubscription.status).toBe(directSubscription.status);
      expect(orderSubscription.templateVersion).toBe(
        directSubscription.templateVersion,
      );
      expect(orderGrant).toEqual(directGrant);
      expect(orderCredit.grantedCNY).toBe(directCredit.grantedCNY);
      expect(viaOrder.created).toBe(direct.created);
      // 只有额度来源标记不同 —— 那正是它存在的意义（对账时区分链路）
      expect(orderCredit.sourceType).not.toBe(directCredit.sourceType);
    });
  });

  describe('assertEnterpriseAdmin', () => {
    it('管理员通过校验并返回成员 ID', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: 'mem-admin',
        role: 'ENTERPRISE_ADMIN',
      });

      await expect(
        svc.assertEnterpriseAdmin(prisma, 'user-1', 'ent-1'),
      ).resolves.toEqual({ id: 'mem-admin' });
    });

    it('❗履约时复核角色 —— 下单到支付之间操作人可能已被降权', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: 'mem-1',
        role: 'MEMBER',
      });

      await expect(
        svc.assertEnterpriseAdmin(prisma, 'user-1', 'ent-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('已被移出企业的操作人不能履约', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(null);

      await expect(
        svc.assertEnterpriseAdmin(prisma, 'user-1', 'ent-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
