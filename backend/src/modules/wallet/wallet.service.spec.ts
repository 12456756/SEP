import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

describe('WalletService', () => {
  let service: WalletService;
  let prisma: jest.Mocked<PrismaService>;

  const mockWallet = {
    id: 'wallet-1',
    enterpriseId: 'ent-1',
    balance: new Decimal(1000),
    frozenAmount: new Decimal(0),
    /// 算力专款默认 0 = 未启用，行为与加这个字段之前完全一致
    computeReservedCNY: new Decimal(0),
    totalDeposit: new Decimal(5000),
    totalConsume: new Decimal(3500),
    totalRefund: new Decimal(500),
    version: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const mockTransaction = {
    id: 'tx-1',
    walletId: 'wallet-1',
    type: 'CONSUME',
    amount: new Decimal(100),
    balanceBefore: new Decimal(1000),
    balanceAfter: new Decimal(900),
    relatedType: 'compute',
    relatedId: 'session-1',
    description: '对话消费',
    metadata: null,
    createdAt: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    const mockPrisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
      enterpriseWallet: {
        findUnique: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      walletTransaction: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(mockPrisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    prisma = module.get(PrismaService) as jest.Mocked<PrismaService>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getBalance', () => {
    it('does not lazily create a wallet after enterprise closure', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ status: 'CLOSED' }]);
      await expect(service.getBalance('ent-1')).rejects.toThrow(ConflictException);
      expect(prisma.enterpriseWallet.create).not.toHaveBeenCalled();
    });

    it('should return wallet statistics', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);

      const result = await service.getBalance('ent-1');

      expect(result.balance.toNumber()).toBe(1000);
      expect(result.totalDeposit.toNumber()).toBe(5000);
      expect(result.totalConsume.toNumber()).toBe(3500);
      expect(prisma.enterpriseWallet.findUnique).toHaveBeenCalledWith({
        where: { enterpriseId: 'ent-1' },
      });
    });
  });

  describe('deposit', () => {
    it('rejects closed enterprise without writing balance or ledger', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ status: 'CLOSED' }]);
      await expect(service.deposit('ent-1', 100, 'order-1')).rejects.toThrow(ConflictException);
      expect(prisma.enterpriseWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('uses the caller transaction for recharge fulfillment', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
        enterpriseWallet: {
          findUnique: jest.fn().mockResolvedValue(mockWallet),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        walletTransaction: { create: jest.fn().mockResolvedValue(mockTransaction) },
      };
      await service.deposit('ent-1', 100, 'order-1', undefined, tx as any);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.enterpriseWallet.updateMany).toHaveBeenCalled();
      expect(tx.walletTransaction.create).toHaveBeenCalled();
    });

    it('should create deposit transaction and update balance', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue({
        ...mockTransaction,
        type: 'DEPOSIT',
        amount: new Decimal(100),
        balanceBefore: new Decimal(1000),
        balanceAfter: new Decimal(1100),
        paymentOrderId: 'order-1',
        description: '充值 ¥100',
      });

      const result = await service.deposit('ent-1', 100, 'order-1', '支付宝充值');

      expect(result.type).toBe('DEPOSIT');
      expect(result.amount.toNumber()).toBe(100);
      expect(prisma.enterpriseWallet.updateMany).toHaveBeenCalled();
      expect(prisma.walletTransaction.create).toHaveBeenCalled();
    });

    it('should throw BadRequestException if amount <= 0', async () => {
      await expect(service.deposit('ent-1', 0, 'order-1')).rejects.toThrow(
        BadRequestException,
      );

      await expect(service.deposit('ent-1', -10, 'order-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('consume', () => {
    it('should create consume transaction and deduct balance', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue({
        ...mockTransaction,
        type: 'CONSUME',
        amount: new Decimal(-100),
        balanceBefore: new Decimal(1000),
        balanceAfter: new Decimal(900),
      });

      const result = await service.consume(
        'ent-1',
        100,
        'compute',
        'session-1',
        '对话消费',
      );

      expect(result.type).toBe('CONSUME');
      expect(result.amount.toNumber()).toBe(-100);
      expect(prisma.enterpriseWallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { enterpriseId: 'ent-1', version: 1 },
        }),
      );
    });

    it('should throw BadRequestException if balance insufficient', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue({
        ...mockWallet,
        balance: new Decimal(50),
      });

      await expect(
        service.consume('ent-1', 100, 'compute', null, '消费'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if wallet does not exist', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.consume('ent-1', 100, 'compute', null, '消费'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if amount <= 0', async () => {
      await expect(
        service.consume('ent-1', 0, 'compute', null, '消费'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('refund', () => {
    it('should create refund transaction and increase balance', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue({
        ...mockTransaction,
        type: 'REFUND',
        amount: new Decimal(100),
        balanceBefore: new Decimal(1000),
        balanceAfter: new Decimal(1100),
        relatedType: 'subscription',
        relatedId: 'sub-1',
        description: '试用期退款',
      });

      const result = await service.refund(
        'ent-1',
        100,
        'subscription',
        'sub-1',
        '试用期退款',
      );

      expect(result.type).toBe('REFUND');
      expect(result.amount.toNumber()).toBe(100);
    });

    it('should throw NotFoundException if wallet does not exist', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.refund('ent-1', 100, 'subscription', null, '退款'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if amount <= 0', async () => {
      await expect(
        service.refund('ent-1', 0, 'subscription', null, '退款'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('refundDeposit', () => {
    it.each([0, -1, 0.001, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid refund amount %s before starting a transaction', async (amount) => {
        await expect(service.refundDeposit({
          enterpriseId: 'ent-1', depositTransactionId: 'deposit-1', amount, operatorId: 'admin-1',
        })).rejects.toThrow(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('refunds whole cents only, protects reserved funds, and recomputes the remaining limit', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue({
        ...mockWallet, balance: new Decimal('150.299999'),
        computeReservedCNY: new Decimal(100), frozenAmount: new Decimal(10),
      });
      (prisma.walletTransaction.findFirst as jest.Mock).mockResolvedValue({
        id: 'deposit-1', amount: new Decimal(1000),
      });
      (prisma.walletTransaction.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue({ id: 'refund-1' });

      await expect(service.refundDeposit({
        enterpriseId: 'ent-1', depositTransactionId: 'deposit-1', amount: 40.3, operatorId: 'admin-1',
      })).rejects.toThrow(BadRequestException);
      const result = await service.refundDeposit({
        enterpriseId: 'ent-1', depositTransactionId: 'deposit-1', amount: 40.29, operatorId: 'admin-1',
      });
      expect(result.balance).toBe(110.009999);
      expect(result.remainingRefundableAmount).toBe(0);
      expect(prisma.enterpriseWallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { enterpriseId: 'ent-1', version: 1 },
        data: expect.objectContaining({ balance: new Decimal('110.009999') }),
      }));
    });

    it('accepts a valid two-decimal amount without floating point rejection', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.walletTransaction.findFirst as jest.Mock).mockResolvedValue({
        id: 'deposit-1', walletId: 'wallet-1', type: 'DEPOSIT', amount: new Decimal(1000),
      });
      (prisma.walletTransaction.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue({ id: 'refund-1' });

      await expect(service.refundDeposit({
        enterpriseId: 'ent-1', depositTransactionId: 'deposit-1', amount: 0.29, operatorId: 'admin-1',
      })).resolves.toEqual(expect.objectContaining({ refundAmount: 0.29 }));
    });

    it('refunds only the unused amount of a deposit and records its source', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.walletTransaction.findFirst as jest.Mock).mockResolvedValue({
        id: 'deposit-1',
        walletId: 'wallet-1',
        type: 'DEPOSIT',
        amount: new Decimal(1000),
      });
      (prisma.walletTransaction.findMany as jest.Mock).mockResolvedValue([
        { amount: new Decimal(-100) },
      ]);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue({ id: 'refund-1' });

      const result = await service.refundDeposit({
        enterpriseId: 'ent-1',
        depositTransactionId: 'deposit-1',
        amount: 200,
        operatorId: 'admin-1',
      });

      expect(result.refundAmount).toBe(200);
      expect(result.remainingRefundableAmount).toBe(700);
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          type: 'REFUND',
          amount: new Decimal(-200),
          createdBy: 'admin-1',
          metadata: { sourceTransactionId: 'deposit-1', refundKind: 'DEPOSIT_REFUND' },
        }),
      }));
    });

    it('rejects a refund above the deposit remainder or spendable balance', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue({
        ...mockWallet,
        balance: new Decimal(50),
      });
      (prisma.walletTransaction.findFirst as jest.Mock).mockResolvedValue({
        id: 'deposit-1', walletId: 'wallet-1', type: 'DEPOSIT', amount: new Decimal(1000),
      });
      (prisma.walletTransaction.findMany as jest.Mock).mockResolvedValue([]);

      await expect(service.refundDeposit({
        enterpriseId: 'ent-1',
        depositTransactionId: 'deposit-1',
        amount: 51,
        operatorId: 'admin-1',
      })).rejects.toThrow(BadRequestException);
      expect(prisma.enterpriseWallet.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('admin balance operations', () => {
    it('should create a missing wallet before admin deposit', async () => {
      const createdWallet = {
        ...mockWallet,
        id: 'wallet-created',
        balance: new Decimal(0),
        totalDeposit: new Decimal(0),
        totalConsume: new Decimal(0),
        totalRefund: new Decimal(0),
        version: 0,
      };

      (prisma.enterpriseWallet.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdWallet);
      (prisma.enterpriseWallet.create as jest.Mock).mockResolvedValue(createdWallet);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue({
        ...mockTransaction,
        walletId: 'wallet-created',
        type: 'DEPOSIT',
        amount: new Decimal(100),
        balanceBefore: new Decimal(0),
        balanceAfter: new Decimal(100),
      });

      const result = await service.adminDeposit('ent-1', 100, '运营充值', 'admin-1');

      expect(result.balance).toBe(100);
      expect(prisma.enterpriseWallet.create).toHaveBeenCalledWith({
        data: { enterpriseId: 'ent-1' },
      });
      expect(prisma.enterpriseWallet.updateMany).toHaveBeenCalled();
    });

    it('should initialize a missing wallet before admin deduct and then report insufficient balance', async () => {
      const createdWallet = {
        ...mockWallet,
        id: 'wallet-created',
        balance: new Decimal(0),
        totalDeposit: new Decimal(0),
        totalConsume: new Decimal(0),
        totalRefund: new Decimal(0),
        version: 0,
      };

      (prisma.enterpriseWallet.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdWallet);
      (prisma.enterpriseWallet.create as jest.Mock).mockResolvedValue(createdWallet);

      await expect(
        service.adminDeduct('ent-1', 100, '运营扣款', 'admin-1'),
      ).rejects.toThrow(/余额不足/);

      expect(prisma.enterpriseWallet.create).toHaveBeenCalledWith({
        data: { enterpriseId: 'ent-1' },
      });
      expect(prisma.enterpriseWallet.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getTransactions', () => {
    it('should return paginated transaction list', async () => {
      const mockTransactions = [
        { ...mockTransaction, id: 'tx-1' },
        { ...mockTransaction, id: 'tx-2' },
      ];

      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.walletTransaction.findMany as jest.Mock).mockResolvedValue(mockTransactions);
      (prisma.walletTransaction.count as jest.Mock).mockResolvedValue(2);

      const result = await service.getTransactions('ent-1', {
        page: 1,
        limit: 10,
      });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('should filter by type', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.walletTransaction.findMany as jest.Mock).mockResolvedValue([mockTransaction]);
      (prisma.walletTransaction.count as jest.Mock).mockResolvedValue(1);

      await service.getTransactions('ent-1', {
        page: 1,
        limit: 10,
        type: 'CONSUME',
      });

      expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'CONSUME',
          }),
        }),
      );
    });
  });

  describe('optimistic locking', () => {
    it('should throw ConflictException on version conflict', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(
        service.consume('ent-1', 100, 'compute', null, '消费'),
      ).rejects.toThrow(ConflictException);
    });
  });

  /**
   * 算力扣款的「有多少扣多少」语义。
   *
   * 它和 consume() 的差别是刻意的：模型调用**已经发生**了，抛错回滚会连
   * 「这次消费存在过」一起丢掉。所以扣到 0 为止，差额交给账单记欠费。
   */
  describe('consumeComputeUpTo', () => {
    const meta = { relatedId: 'session-1', description: '对话算力消费' };

    beforeEach(() => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue(mockTransaction);
    });

    it('余额充足时全额扣款，无欠费', async () => {
      const result = await service.consumeComputeUpTo(
        prisma as never,
        'ent-1',
        new Decimal(100),
        meta,
      );

      expect(result.paid.toNumber()).toBe(100);
      expect(result.unpaid.toNumber()).toBe(0);
      expect(result.transactionId).toBe('tx-1');
    });

    it('❗余额不足时扣到 0，差额作为欠费返回，余额不变负', async () => {
      const result = await service.consumeComputeUpTo(
        prisma as never,
        'ent-1',
        new Decimal(1500), // 余额只有 1000
        meta,
      );

      expect(result.paid.toNumber()).toBe(1000);
      expect(result.unpaid.toNumber()).toBe(500);

      const data = (prisma.enterpriseWallet.updateMany as jest.Mock).mock
        .calls[0][0].data;
      expect(new Decimal(data.balance).toNumber()).toBe(0);
    });

    it('余额为 0 时不产生流水，整笔作为欠费', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue({
        ...mockWallet,
        balance: new Decimal(0),
      });

      const result = await service.consumeComputeUpTo(
        prisma as never,
        'ent-1',
        new Decimal(10),
        meta,
      );

      expect(result.paid.toNumber()).toBe(0);
      expect(result.unpaid.toNumber()).toBe(10);
      expect(result.transactionId).toBeNull();
      // 0 元流水只会污染账单，不记
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('金额为 0 时直接返回，不查库不写库', async () => {
      const result = await service.consumeComputeUpTo(
        prisma as never,
        'ent-1',
        new Decimal(0),
        meta,
      );

      expect(result.paid.toNumber()).toBe(0);
      expect(prisma.enterpriseWallet.findUnique).not.toHaveBeenCalled();
    });

    it('并发冲突抛 ConflictException，由调用方整笔重试', async () => {
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(
        service.consumeComputeUpTo(prisma as never, 'ent-1', new Decimal(100), meta),
      ).rejects.toThrow(ConflictException);
    });

    it('流水按算力消费归类，relatedId 记会话以便追溯', async () => {
      await service.consumeComputeUpTo(
        prisma as never,
        'ent-1',
        new Decimal(100),
        meta,
      );

      const data = (prisma.walletTransaction.create as jest.Mock).mock.calls[0][0]
        .data;
      expect(data.relatedType).toBe('compute');
      expect(data.relatedId).toBe('session-1');
      // 出账记负数，与其他消费流水的符号约定一致
      expect(new Decimal(data.amount).toNumber()).toBe(-100);
    });

    it('钱包不存在时报 404 —— 扣费链路必须先确保钱包就位', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.consumeComputeUpTo(prisma as never, 'ent-1', new Decimal(10), meta),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('consumeForMemberTopUp', () => {
    const meta = { relatedId: 'user-1', description: '成员充值' };

    it('从算力专款足额扣款，同时减少钱包余额与算力余额', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue({ ...mockWallet, balance: new Decimal(100), computeReservedCNY: new Decimal(60) });
      (prisma.enterpriseWallet.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.walletTransaction.create as jest.Mock).mockResolvedValue(mockTransaction);
      await expect(service.consumeForMemberTopUp(prisma as never, 'ent-1', new Decimal(50), meta)).resolves.toEqual({ transactionId: 'tx-1' });
      const data = (prisma.enterpriseWallet.updateMany as jest.Mock).mock.calls[0][0].data;
      expect(new Decimal(data.balance).toNumber()).toBe(50);
      expect(new Decimal(data.computeReservedCNY).toNumber()).toBe(10);
    });

    it('算力余额不足时失败且不写入扣款', async () => {
      (prisma.enterpriseWallet.findUnique as jest.Mock).mockResolvedValue({ ...mockWallet, balance: new Decimal(100), computeReservedCNY: new Decimal(40) });
      await expect(service.consumeForMemberTopUp(prisma as never, 'ent-1', new Decimal(50), meta)).rejects.toThrow(/算力余额不足/);
      expect(prisma.enterpriseWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });
  });
});
