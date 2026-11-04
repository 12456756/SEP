import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { PersonalWalletService } from '../personal-wallet/personal-wallet.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, TransactionType } from '@prisma/client';
import { SettingService } from '../setting/setting.service';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: PrismaService;

  const mockPrismaService = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'contributor-1', status: 'ACTIVE' }]),
    enterprise: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    computeAccount: {
      create: jest.fn(),
      update: jest.fn(),
    },
    computeTransaction: {
      create: jest.fn(),
    },
    walletTransaction: {
      groupBy: jest.fn(),
    },
    enterpriseWallet: {
      aggregate: jest.fn(),
    },
    capability: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    skillVersion: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    skillVersionReview: { createMany: jest.fn() },
    contributionRewardEvent: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const mockWalletService = {
    adminDeposit: jest.fn(),
    adminDeduct: jest.fn(),
  };
  const mockPersonalWalletService = { creditContributionRewardInTx: jest.fn() };
  const mockSettingService = { getEffectiveValue: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: WalletService,
          useValue: mockWalletService,
        },
        { provide: PersonalWalletService, useValue: mockPersonalWalletService },
        { provide: SettingService, useValue: mockSettingService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
    prisma = module.get<PrismaService>(PrismaService);

    // Reset mocks
    jest.clearAllMocks();
    mockSettingService.getEffectiveValue.mockReset().mockResolvedValue('false');
    mockWalletService.adminDeposit.mockResolvedValue({ balance: 150 });
    mockWalletService.adminDeduct.mockResolvedValue({ balance: 50 });
    mockPrismaService.skillVersion.findMany.mockResolvedValue([]);
    mockPrismaService.$transaction.mockImplementation((callback) => callback(mockPrismaService));
  });

  describe('listCapabilities', () => {
    it('loads minimal published and pending platform versions in batched queries', async () => {
      const version = {
        id: 'platform-v2', version: '1.0.1', platformReviewedAt: new Date('2026-10-10T00:00:00Z'),
      };
      mockPrismaService.capability.findMany.mockResolvedValue([
        { id: 'skill-published', type: 'SKILL', skillVersions: [version] },
        { id: 'skill-unpublished', type: 'SKILL', skillVersions: [] },
        { id: 'rpa', type: 'RPA', skillVersions: [] },
      ]);
      mockPrismaService.capability.count.mockResolvedValue(3);
      mockPrismaService.skillVersion.findMany.mockResolvedValue([
        { id: 'pending-1', capabilityId: 'skill-unpublished', version: '1.0.0', updatedAt: new Date('2026-10-11T00:00:00Z') },
      ]);

      const result = await service.listCapabilities({ type: 'SKILL', page: 2, pageSize: 10 });

      expect(mockPrismaService.capability.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.capability.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { type: 'SKILL' }, skip: 10, take: 10,
        include: expect.objectContaining({
          skillVersions: {
            where: { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
            orderBy: [
              { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
            take: 1,
            select: { id: true, version: true, platformReviewedAt: true },
          },
        }),
      }));
      expect(mockPrismaService.capability.count).toHaveBeenCalledWith({ where: { type: 'SKILL' } });
      expect(mockPrismaService.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { capabilityId: { in: ['skill-published', 'skill-unpublished'] }, scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW' },
      }));
      expect(result).toEqual({
        items: [
          { id: 'skill-published', type: 'SKILL', currentPlatformVersion: version, pendingPlatformVersion: null },
          { id: 'skill-unpublished', type: 'SKILL', currentPlatformVersion: null, pendingPlatformVersion: { id: 'pending-1', capabilityId: 'skill-unpublished', version: '1.0.0', updatedAt: new Date('2026-10-11T00:00:00Z') } },
          { id: 'rpa', type: 'RPA', currentPlatformVersion: null, pendingPlatformVersion: null },
        ],
        total: 3, page: 2, pageSize: 10,
      });
    });

    it('preserves old version summaries without a publication timestamp', async () => {
      const version = { id: 'legacy', version: '1.0.0', platformReviewedAt: null };
      mockPrismaService.capability.findMany.mockResolvedValue([
        { id: 'skill', type: 'SKILL', skillVersions: [version] },
      ]);
      mockPrismaService.capability.count.mockResolvedValue(1);
      const result = await service.listCapabilities();
      expect(result.items[0].currentPlatformVersion).toEqual(version);
      expect(result.items[0]).not.toHaveProperty('skillVersions');
      expect(result.items[0].pendingPlatformVersion).toBeNull();
    });

    it.each([
      ['PENDING', { OR: [{ enterpriseId: null, status: 'PENDING' }, { platformReviewStatus: 'PENDING_REVIEW' }] }],
      ['APPROVED', { OR: [{ visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED' }, { enterpriseId: null, status: 'APPROVED' }] }],
      ['REJECTED', { status: 'REJECTED' }],
    ] as const)('preserves the %s filter', async (status, where) => {
      mockPrismaService.capability.findMany.mockResolvedValue([]);
      mockPrismaService.capability.count.mockResolvedValue(0);
      await service.listCapabilities({ status });
      expect(mockPrismaService.capability.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(mockPrismaService.capability.count).toHaveBeenCalledWith({ where });
    });
  });

  describe.each(['approve', 'reject'] as const)('%sCapability', (decision) => {
    const review = () => decision === 'approve'
      ? service.approveCapability('cap', 'admin', 'review note')
      : service.rejectCapability('cap', 'admin', 'review reason');

    it.each(['PENDING', 'APPROVED', 'REJECTED'])('blocks SKILL in %s before any writes', async (status) => {
      mockPrismaService.capability.findUnique.mockResolvedValue({ id: 'cap', type: 'SKILL', status });
      await expect(review()).rejects.toThrow(BadRequestException);
      await expect(review()).rejects.toThrow(/技能监控/);
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      expect(mockPrismaService.capability.update).not.toHaveBeenCalled();
      expect(mockPrismaService.skillVersion.updateMany).not.toHaveBeenCalled();
      expect(mockPrismaService.skillVersionReview.createMany).not.toHaveBeenCalled();
      expect(mockPrismaService.contributionRewardEvent.create).not.toHaveBeenCalled();
    });

    it.each(['AGENT', 'RPA', 'AI_APP'])('preserves inline review for %s', async (type) => {
      mockPrismaService.capability.findUnique.mockResolvedValue({ id: 'cap', type, status: 'PENDING' });
      const updated = { id: 'cap', type, status: decision === 'approve' ? 'APPROVED' : 'REJECTED' };
      mockPrismaService.capability.update.mockResolvedValue(updated);
      expect(await review()).toEqual(updated);
      expect(mockPrismaService.capability.update).toHaveBeenCalledWith({
        where: { id: 'cap' },
        data: decision === 'approve'
          ? { status: 'APPROVED', approvedAt: expect.any(Date) }
          : { status: 'REJECTED' },
      });
      expect(mockPrismaService.skillVersion.findMany).not.toHaveBeenCalled();
    });

    it('preserves enterprise contribution status, visibility and reward behavior', async () => {
      mockSettingService.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? 'true' : undefined);
      mockPrismaService.capability.findUnique.mockResolvedValue({
        id: 'cap', type: 'RPA', status: 'PENDING', platformReviewStatus: 'PENDING_REVIEW',
        contributorId: 'contributor', enterpriseId: 'enterprise',
      });
      mockPrismaService.contributionRewardEvent.findUnique.mockResolvedValue(null);
      mockPrismaService.contributionRewardEvent.create.mockResolvedValue({ id: 'reward' });
      await review();
      expect(mockPrismaService.capability.update).toHaveBeenCalledWith({
        where: { id: 'cap' },
        data: decision === 'approve'
          ? { status: 'APPROVED', approvedAt: expect.any(Date), platformReviewStatus: 'APPROVED', visibility: 'MARKET_PUBLIC', platformRejectionReason: null }
          : { status: 'REJECTED', platformReviewStatus: 'REJECTED', visibility: 'ENTERPRISE_PRIVATE', platformRejectionReason: 'review reason' },
      });
      if (decision === 'approve') {
        expect(mockPrismaService.contributionRewardEvent.create).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({ dedupeKey: 'platform-approved:cap', recipientId: 'contributor', amount: new Prisma.Decimal(50) }),
        }));
        expect(mockPersonalWalletService.creditContributionRewardInTx).toHaveBeenCalledTimes(1);
      } else {
        expect(mockPrismaService.contributionRewardEvent.create).not.toHaveBeenCalled();
      }
    });

    it('preserves missing capability and non-pending errors for non-skills', async () => {
      mockPrismaService.capability.findUnique.mockResolvedValue(null);
      await expect(review()).rejects.toThrow(NotFoundException);
      mockPrismaService.capability.findUnique.mockResolvedValue({ id: 'cap', type: 'RPA', status: 'APPROVED' });
      await expect(review()).rejects.toThrow('只能审核待审核状态的能力');
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('approveCapability reward switch', () => {
    beforeEach(() => {
      mockPrismaService.capability.findUnique.mockResolvedValue({
        id: 'cap', type: 'RPA', status: 'PENDING', platformReviewStatus: 'PENDING_REVIEW',
        contributorId: 'contributor', enterpriseId: 'enterprise',
      });
      mockPrismaService.capability.update.mockResolvedValue({ id: 'cap', status: 'APPROVED', platformReviewStatus: 'APPROVED', visibility: 'MARKET_PUBLIC' });
      mockPrismaService.contributionRewardEvent.findUnique.mockResolvedValue(null);
      mockPrismaService.contributionRewardEvent.create.mockResolvedValue({ id: 'reward' });
      mockPersonalWalletService.creditContributionRewardInTx.mockResolvedValue(undefined);
    });

    it.each([undefined, null, 'false', '', 'TRUE', '1', true])('approves without reward events or credit when the switch is %p', async (value) => {
      mockSettingService.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? value : '75');
      await expect(service.approveCapability('cap', 'admin')).resolves.toEqual(expect.objectContaining({ status: 'APPROVED' }));
      expect(mockPrismaService.capability.update).toHaveBeenCalledWith({
        where: { id: 'cap' }, data: expect.objectContaining({
          status: 'APPROVED', platformReviewStatus: 'APPROVED', visibility: 'MARKET_PUBLIC',
        }),
      });
      expect(mockPrismaService.contributionRewardEvent.findUnique).not.toHaveBeenCalled();
      expect(mockPrismaService.contributionRewardEvent.create).not.toHaveBeenCalled();
      expect(mockPersonalWalletService.creditContributionRewardInTx).not.toHaveBeenCalled();
      expect(mockSettingService.getEffectiveValue).not.toHaveBeenCalledWith('CONTRIBUTION_PLATFORM_REWARD_CNY');
    });

    it.each([
      ['75', 75], [undefined, 50], ['not-a-number', 50], ['0', 50], ['-1', 50],
    ])('preserves configured amount %p and fallback behavior when enabled', async (configured, expected) => {
      mockSettingService.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? 'true' : configured);
      await service.approveCapability('cap', 'admin');
      expect(mockSettingService.getEffectiveValue).toHaveBeenCalledWith('CONTRIBUTION_PLATFORM_REWARD_CNY');
      expect(mockPrismaService.contributionRewardEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: new Prisma.Decimal(expected), dedupeKey: 'platform-approved:cap' }),
      }));
      expect(mockPersonalWalletService.creditContributionRewardInTx).toHaveBeenCalledWith(
        mockPrismaService, 'contributor', new Prisma.Decimal(expected), 'reward', expect.any(String),
      );
    });
  });

  describe('getComputeSummary', () => {
    const walletTotals = {
      _sum: { balance: 93558.98, computeReservedCNY: 2500 },
    };

    it('sums recharge and consume from wallet transactions, balance from wallets', async () => {
      mockPrismaService.walletTransaction.groupBy.mockResolvedValue([
        { type: 'DEPOSIT', _sum: { amount: 232999 } },
        { type: 'CONSUME', _sum: { amount: -136468.95 } },
      ]);
      mockPrismaService.enterpriseWallet.aggregate.mockResolvedValue(walletTotals);

      const result = await service.getComputeSummary();

      expect(result).toEqual({
        totalRecharge: 232999,
        totalConsume: 136468.95,
        totalRefund: 0,
        totalBalance: 93558.98,
        totalComputeReserved: 2500,
      });
    });

    it('counts ADJUSTMENT as recharge, matching the transaction list mapping', async () => {
      mockPrismaService.walletTransaction.groupBy.mockResolvedValue([
        { type: 'DEPOSIT', _sum: { amount: 1000 } },
        { type: 'ADJUSTMENT', _sum: { amount: 250 } },
      ]);
      mockPrismaService.enterpriseWallet.aggregate.mockResolvedValue(walletTotals);

      const result = await service.getComputeSummary();

      expect(result.totalRecharge).toBe(1250);
    });

    it('excludes COMPUTE_RESERVE / COMPUTE_RELEASE — they only relabel money, not move it', async () => {
      mockPrismaService.walletTransaction.groupBy.mockResolvedValue([
        { type: 'DEPOSIT', _sum: { amount: 500 } },
        { type: 'COMPUTE_RESERVE', _sum: { amount: 3000 } },
        { type: 'COMPUTE_RELEASE', _sum: { amount: -500 } },
      ]);
      mockPrismaService.enterpriseWallet.aggregate.mockResolvedValue(walletTotals);

      const result = await service.getComputeSummary();

      expect(result.totalRecharge).toBe(500);
      expect(result.totalConsume).toBe(0);
    });

    it('returns zeros when there is no data at all', async () => {
      mockPrismaService.walletTransaction.groupBy.mockResolvedValue([]);
      mockPrismaService.enterpriseWallet.aggregate.mockResolvedValue({
        _sum: { balance: null, computeReservedCNY: null },
      });

      const result = await service.getComputeSummary();

      expect(result).toEqual({
        totalRecharge: 0,
        totalConsume: 0,
        totalRefund: 0,
        totalBalance: 0,
        totalComputeReserved: 0,
      });
    });
  });

  describe('getEnterpriseDetail', () => {
    it('should flatten wallet balance and transactions onto the detail', async () => {
      const createdAt = new Date();
      const mockEnterprise = {
        id: 'ent1',
        name: 'Test Enterprise',
        description: 'Test Description',
        logo: null,
        createdAt,
        updatedAt: createdAt,
        members: [],
        // 收敛后企业下挂的是雇佣关系，不再有中间的实例层
        subscriptions: [],
        // 余额与流水读钱包，不读已废弃的 ComputeAccount
        wallet: {
          id: 'w1',
          balance: 49568,
          computeReservedCNY: 2000,
          transactions: [
            {
              id: 'tx1',
              type: 'DEPOSIT',
              amount: 49568,
              balanceAfter: 49568,
              description: '支付宝充值',
              metadata: null,
              createdAt,
            },
          ],
        },
        departments: [],
      };

      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);

      const result = await service.getEnterpriseDetail('ent1');

      // wallet 被摊平成 balance / computeReservedCNY / transactions，自身不再外泄
      expect(result).not.toHaveProperty('wallet');
      expect(result.balance).toBe(49568);
      expect(result.computeReservedCNY).toBe(2000);
      expect(result.transactions).toEqual([
        {
          id: 'tx1',
          type: 'DEPOSIT',
          amount: 49568,
          balanceAfter: 49568,
          description: '支付宝充值',
          metadata: null,
          createdAt,
        },
      ]);
      expect(prisma.enterprise.findUnique).toHaveBeenCalledWith({
        where: { id: 'ent1' },
        include: expect.any(Object),
      });
    });

    it('should default balance to 0 when the enterprise has no wallet yet', async () => {
      mockPrismaService.enterprise.findUnique.mockResolvedValue({
        id: 'ent2',
        name: 'No Wallet',
        members: [],
        subscriptions: [],
        wallet: null,
        departments: [],
      });

      const result = await service.getEnterpriseDetail('ent2');

      expect(result.balance).toBe(0);
      expect(result.computeReservedCNY).toBe(0);
      expect(result.transactions).toEqual([]);
    });

    it('should throw NotFoundException if enterprise does not exist', async () => {
      mockPrismaService.enterprise.findUnique.mockResolvedValue(null);

      await expect(service.getEnterpriseDetail('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('creditAdjustment', () => {
    const mockEnterprise = {
      id: 'ent1',
      name: 'Test Enterprise',
      computeAccount: {
        id: 'acc1',
        balance: 100,
      },
    };

    it('should recharge credit successfully', async () => {
      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);

      const result = await service.creditAdjustment({
        enterpriseId: 'ent1',
        amount: 50,
        type: 'RECHARGE',
        note: 'Test recharge',
        operatorId: 'admin1',
      });

      expect(result).toEqual({
        success: true,
        newBalance: 150,
      });
      expect(mockWalletService.adminDeposit).toHaveBeenCalledWith(
        'ent1',
        50,
        'Test recharge',
        'admin1',
      );
    });

    it('should deduct credit successfully when balance is sufficient', async () => {
      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);

      const result = await service.creditAdjustment({
        enterpriseId: 'ent1',
        amount: 50,
        type: 'DEDUCT',
        note: 'Test deduct',
        operatorId: 'admin1',
      });

      expect(result).toEqual({
        success: true,
        newBalance: 50,
      });
      expect(mockWalletService.adminDeduct).toHaveBeenCalledWith(
        'ent1',
        50,
        'Test deduct',
        'admin1',
      );
    });

    it('should throw BadRequestException when deducting more than balance', async () => {
      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);
      mockWalletService.adminDeduct.mockRejectedValue(new BadRequestException('余额不足'));

      await expect(
        service.creditAdjustment({
          enterpriseId: 'ent1',
          amount: 200,
          type: 'DEDUCT',
          note: 'Test deduct',
          operatorId: 'admin1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for non-positive amount', async () => {
      await expect(
        service.creditAdjustment({
          enterpriseId: 'ent1',
          amount: -50,
          type: 'RECHARGE',
          note: 'Test',
          operatorId: 'admin1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should delegate recharge even when the legacy compute account relation is absent', async () => {
      const enterpriseWithoutAccount = {
        id: 'ent1',
        name: 'Test Enterprise',
        computeAccount: null,
      };

      mockPrismaService.enterprise.findUnique.mockResolvedValue(
        enterpriseWithoutAccount,
      );
      mockWalletService.adminDeposit.mockResolvedValue({ balance: 100 });

      const result = await service.creditAdjustment({
        enterpriseId: 'ent1',
        amount: 100,
        type: 'RECHARGE',
        note: 'Initial recharge',
        operatorId: 'admin1',
      });

      expect(mockWalletService.adminDeposit).toHaveBeenCalledWith(
        'ent1',
        100,
        'Initial recharge',
        'admin1',
      );
      expect(result.success).toBe(true);
    });
  });

  describe('suspendEnterprise', () => {
    it('should suspend enterprise successfully', async () => {
      const mockEnterprise = {
        id: 'ent1',
        name: 'Test Enterprise',
        metadata: {},
      };

      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);
      mockPrismaService.enterprise.update.mockResolvedValue({
        ...mockEnterprise,
        metadata: { suspended: true },
      });

      const result = await service.suspendEnterprise(
        'ent1',
        'Test reason',
        'admin1',
      );

      expect(result).toEqual({ success: true });
      expect(prisma.enterprise.update).toHaveBeenCalledWith({
        where: { id: 'ent1' },
        data: {
          metadata: expect.objectContaining({
            suspended: true,
            suspendReason: 'Test reason',
          }),
        },
      });
    });

    it('should throw BadRequestException if already suspended', async () => {
      const mockEnterprise = {
        id: 'ent1',
        name: 'Test Enterprise',
        metadata: { suspended: true },
      };

      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);

      await expect(
        service.suspendEnterprise('ent1', 'Test reason', 'admin1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resumeEnterprise', () => {
    it('should resume enterprise successfully', async () => {
      const mockEnterprise = {
        id: 'ent1',
        name: 'Test Enterprise',
        metadata: { suspended: true, suspendReason: 'Test' },
      };

      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);
      mockPrismaService.enterprise.update.mockResolvedValue({
        ...mockEnterprise,
        metadata: { suspended: false },
      });

      const result = await service.resumeEnterprise('ent1', 'admin1');

      expect(result).toEqual({ success: true });
      expect(prisma.enterprise.update).toHaveBeenCalledWith({
        where: { id: 'ent1' },
        data: {
          metadata: expect.objectContaining({
            suspended: false,
          }),
        },
      });
    });

    it('should throw BadRequestException if not suspended', async () => {
      const mockEnterprise = {
        id: 'ent1',
        name: 'Test Enterprise',
        metadata: { suspended: false },
      };

      mockPrismaService.enterprise.findUnique.mockResolvedValue(mockEnterprise);

      await expect(service.resumeEnterprise('ent1', 'admin1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('listEnterprises', () => {
    it('should return paginated enterprise list', async () => {
      const mockEnterprises = [
        {
          id: 'ent1',
          name: 'Enterprise 1',
          description: null,
          logo: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
          // 余额来自钱包（唯一主账本），不再是已停止写入的 ComputeAccount.balance
          wallet: { balance: 100 },
          _count: { members: 5, subscriptions: 3 },
        },
      ];

      mockPrismaService.enterprise.findMany.mockResolvedValue(mockEnterprises);
      mockPrismaService.enterprise.count.mockResolvedValue(1);

      const result = await service.listEnterprises({
        page: 1,
        pageSize: 20,
      });

      expect(result).toEqual({
        data: expect.arrayContaining([
          expect.objectContaining({
            id: 'ent1',
            balance: 100,
            memberCount: 5,
            subscriptionCount: 3,
            suspended: false,
          }),
        ]),
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      });
    });

    it('should filter by keyword', async () => {
      mockPrismaService.enterprise.findMany.mockResolvedValue([]);
      mockPrismaService.enterprise.count.mockResolvedValue(0);

      await service.listEnterprises({
        page: 1,
        pageSize: 20,
        keyword: 'test',
      });

      expect(prisma.enterprise.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.any(Array),
          }),
        }),
      );
    });
  });
});
