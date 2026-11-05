import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SubscriptionEmployeeService } from './subscription-employee.service';
import { withEmployeeAvatar } from '../../common/employee-avatar';

describe('SubscriptionEmployeeService', () => {
  let prisma: any;
  let context: any;
  let service: SubscriptionEmployeeService;
  const ctx = {
    enterpriseId: 'ent-a',
    memberId: 'm1',
    departmentId: 'dept-a',
    role: 'ENTERPRISE_ADMIN',
  };
  const subscription = {
    id: 'sub-a',
    employeeId: 'employee-a',
    status: 'ACTIVE',
    endDate: null,
  };
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-16T06:00:00Z'));
    prisma = {
      subscription: { findFirst: jest.fn().mockResolvedValue(subscription) },
      employeeGrant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'grant' }),
      },
      digitalEmployee: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'employee-a', bindings: [] }),
      },
      computeUsageRecord: { findMany: jest.fn().mockResolvedValue([]) },
      toolExecution: { findMany: jest.fn().mockResolvedValue([]) },
    };
    context = { resolve: jest.fn().mockResolvedValue(ctx) };
    service = new SubscriptionEmployeeService(prisma, context);
  });
  afterEach(() => jest.useRealTimers());

  it('returns canonical avatar metadata for the authorized employee detail', async () => {
    const employee = { id: 'employee-a', name: 'Renamed', avatar: '/assets/employees/silicon/frontend-engineer.webp', bindings: [] };
    prisma.digitalEmployee.findUnique.mockResolvedValue(employee);
    expect(await service.detail('sub-a', 'u1')).toEqual(withEmployeeAvatar(employee));
  });

  it('rejects cross-enterprise access before reading employee or billing', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(service.detail('sub-b', 'u1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.stats('sub-b', 'u1', 7)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sub-b', enterpriseId: 'ent-a' },
      }),
    );
    expect(prisma.digitalEmployee.findUnique).not.toHaveBeenCalled();
    expect(prisma.computeUsageRecord.findMany).not.toHaveBeenCalled();
  });
  it('admin detail selects public fields without credentials', async () => {
    await service.detail('sub-a', 'u1');
    const { select } = prisma.digitalEmployee.findUnique.mock.calls[0][0];
    expect(select.bindings.select.capability.select).toEqual({
      id: true,
      name: true,
      type: true,
      status: true,
      description: true,
    });
    expect(select.bindings.where).toEqual({
      enabled: true,
      capability: { status: 'APPROVED' },
    });
    expect(select.systemPrompt).toBeUndefined();
    expect(select.config).toBeUndefined();
    expect(prisma.employeeGrant.findFirst).not.toHaveBeenCalled();
  });
  it('members require valid direct or department grants', async () => {
    context.resolve.mockResolvedValue({ ...ctx, role: 'MEMBER' });
    await service.detail('sub-a', 'u1');
    const { where } = prisma.employeeGrant.findFirst.mock.calls[0][0];
    expect(where.subscriptionId).toBe('sub-a');
    expect(where.OR).toEqual([{ memberId: 'm1' }, { departmentId: 'dept-a' }]);
    expect(where.AND).toEqual([
      { OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
    ]);
    prisma.employeeGrant.findFirst.mockResolvedValue(null);
    await expect(service.detail('sub-a', 'u1')).rejects.toThrow(
      ForbiddenException,
    );
  });
  it.each(['PAUSED', 'EXPIRED', 'TERMINATED'])(
    'members cannot access %s subscription',
    async (status) => {
      context.resolve.mockResolvedValue({ ...ctx, role: 'MEMBER' });
      prisma.subscription.findFirst.mockResolvedValue({
        ...subscription,
        status,
      });
      await expect(service.stats('sub-a', 'u1', 7)).rejects.toThrow(
        ForbiddenException,
      );
    },
  );
  it('checks end date even while status remains active', async () => {
    context.resolve.mockResolvedValue({ ...ctx, role: 'MEMBER' });
    prisma.subscription.findFirst.mockResolvedValue({
      ...subscription,
      endDate: new Date('2026-09-01'),
    });
    await expect(service.detail('sub-a', 'u1')).rejects.toThrow(
      ForbiddenException,
    );
  });
  it.each(['MEMBER', 'ENTERPRISE_ADMIN'])(
    'scopes billing and old-session execution by %s',
    async (role) => {
      context.resolve.mockResolvedValue({ ...ctx, role });
      prisma.computeUsageRecord.findMany
        .mockResolvedValueOnce([
          {
            createdAt: new Date('2026-09-15T12:00:00Z'),
            inputTokens: 100,
            outputTokens: 20,
            costCNY: '0.1',
            userId: 'u1',
            user: { name: '小林' },
          },
          {
            createdAt: new Date('2026-09-15T12:01:00Z'),
            inputTokens: 50,
            outputTokens: 30,
            costCNY: '0.2',
            userId: 'u1',
            user: { name: '小林' },
          },
        ])
        .mockResolvedValueOnce([
          { sessionId: 'old-session' },
          { sessionId: 'ambiguous-session' },
        ])
        .mockResolvedValueOnce([{ sessionId: 'ambiguous-session' }]);
      prisma.toolExecution.findMany.mockResolvedValue([
        {
          id: 'exec',
          status: 'SUCCESS',
          duration: 1200,
          createdAt: new Date('2026-09-15T12:01:00Z'),
          capability: { name: '检索' },
        },
      ]);
      const result = await service.stats('sub-a', 'u1', 7);
      const scoped = {
        enterpriseId: 'ent-a',
        subscriptionId: 'sub-a',
        employeeId: 'employee-a',
        ...(role === 'MEMBER' ? { userId: 'u1' } : {}),
      };
      expect(prisma.computeUsageRecord.findMany.mock.calls[0][0].where).toEqual(
        {
          ...scoped,
          createdAt: {
            gte: new Date('2026-09-09T06:00:00Z'),
            lte: new Date('2026-09-16T06:00:00Z'),
          },
        },
      );
      expect(
        prisma.computeUsageRecord.findMany.mock.calls[1][0].where.createdAt,
      ).toBeUndefined();
      expect(
        prisma.computeUsageRecord.findMany.mock.calls[2][0].where.OR,
      ).toContainEqual({ subscriptionId: null });
      expect(prisma.toolExecution.findMany.mock.calls[0][0].where).toEqual({
        sessionId: { in: ['old-session'] },
        createdAt: { gte: expect.any(Date), lte: expect.any(Date) },
        session: {
          employeeId: 'employee-a',
          ...(role === 'MEMBER' ? { userId: 'u1' } : {}),
        },
      });
      expect(result.summary).toMatchObject({
        callCount: 2,
        total: 1,
        successCount: 1,
        totalTokens: 200,
        costCNY: 0.3,
        avgDuration: 1200,
      });
      expect(result.scope).toBe(role === 'MEMBER' ? 'personal' : 'enterprise');
      expect(result.byMember).toEqual(
        role === 'MEMBER'
          ? []
          : [{ userId: 'u1', name: '小林', callCount: 2, costCNY: 0.3 }],
      );
    },
  );
  it('empty billing never queries unscoped executions', async () => {
    const result = await service.stats('sub-a', 'u1', 30);
    expect(result.summary).toMatchObject({
      callCount: 0,
      total: 0,
      costCNY: 0,
    });
    expect(result.recentLog).toEqual([]);
    expect(prisma.toolExecution.findMany).not.toHaveBeenCalled();
  });
});
