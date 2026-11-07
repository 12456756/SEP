import { ConflictException } from '@nestjs/common';
import { EnterpriseDeletionService } from './enterprise-deletion.service';

describe('EnterpriseDeletionService', () => {
  const previewRow = {
    id: 'enterprise-1',
    name: '示例企业',
    wallet: { balance: 12.5, frozenAmount: 2, computeReservedCNY: 3 },
    _count: { members: 4, subscriptions: 2, knowledgeBases: 1, taskRuns: 3 },
  };

  function setup() {
    const prisma = {
      enterprise: { findUnique: jest.fn().mockResolvedValue(previewRow) },
      document: { count: jest.fn().mockResolvedValue(5) },
      taskRun: { count: jest.fn().mockResolvedValue(1) },
      order: { count: jest.fn().mockResolvedValue(2) },
      enterpriseDeletionJob: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    const sessions = {};
    const cleanup = {};
    const service = new EnterpriseDeletionService(prisma as never, sessions as never, cleanup as never);
    jest.spyOn(service, 'process').mockResolvedValue();
    return { service, prisma };
  }

  it('previews financial risk as warnings and does not block deletion', async () => {
    const { service } = setup();
    const result = await service.preview('enterprise-1');

    expect(result).toMatchObject({
      balance: 12.5,
      frozenAmount: 2,
      computeReservedCNY: 3,
      memberCount: 4,
      documentCount: 5,
      runningTaskCount: 1,
      pendingOrderCount: 2,
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('余额 ¥12.50'),
      expect.stringContaining('冻结金额'),
      expect.stringContaining('算力专款'),
    ]));
  });

  it('requires the exact enterprise name before creating a deletion job', async () => {
    const { service, prisma } = setup();

    await expect(service.request('enterprise-1', { confirmName: '示例企业 ' }, 'admin-1'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(prisma.enterpriseDeletionJob.create).not.toHaveBeenCalled();
  });

  it('accepts deletion with a positive balance after exact-name confirmation', async () => {
    const { service, prisma } = setup();
    const now = new Date();
    prisma.enterpriseDeletionJob.create.mockResolvedValue({
      id: 'job-1',
      enterpriseId: 'enterprise-1',
      enterpriseName: '示例企业',
      status: 'PENDING',
      phase: 'PREPARE',
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    await expect(service.request('enterprise-1', { confirmName: '示例企业' }, 'admin-1'))
      .resolves.toMatchObject({ id: 'job-1', status: 'PENDING' });
    expect(prisma.enterpriseDeletionJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ enterpriseId: 'enterprise-1', requestedById: 'admin-1' }),
    }));
    expect(service.process).toHaveBeenCalledWith('job-1');
  });
});
