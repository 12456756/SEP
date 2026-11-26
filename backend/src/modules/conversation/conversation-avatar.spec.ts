import { ForbiddenException } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { withEmployeeAvatar } from '../../common/employee-avatar';

describe('conversation employee avatars', () => {
  const employee = { id: 'employee-1', name: 'Engineer', avatar: '/assets/employees/silicon/frontend-engineer.webp' };
  const session = { id: 'session-1', userId: 'user-1', employee, messages: [] };
  let service: ConversationService;
  let prisma: any;
  beforeEach(() => {
    prisma = {
      digitalEmployee: { findUnique: jest.fn().mockResolvedValue(employee) },
      subscription: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1' }) },
      conversationSession: {
        create: jest.fn().mockResolvedValue(session),
        findMany: jest.fn().mockResolvedValue([session]),
        findUnique: jest.fn().mockResolvedValue(session),
      },
    };
    service = new ConversationService(
      prisma,
      { assertActiveSubscription: jest.fn() } as any,
      { get: jest.fn().mockResolvedValue({ defaultChatModel: 'model-1' }) } as any,
      {} as any,
      { checkBalanceBeforeConversation: jest.fn().mockResolvedValue({ allowed: true }) } as any,
      {
        resolve: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', memberId: 'member-1', departmentId: 'dept-1' }),
        resolveOrNull: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', memberId: 'member-1', departmentId: 'dept-1' }),
      } as any,
    );
  });

  it('returns the same platform image in create, list and detail', async () => {
    const created = await service.create('user-1', { employeeId: employee.id } as any);
    const [listed] = await service.findAll('user-1');
    const detail = await service.findOne(session.id, 'user-1');
    for (const result of [created, listed, detail]) {
      expect(result.employee).toEqual(withEmployeeAvatar(employee));
    }
    expect(employee.avatar).toBe('/assets/employees/silicon/frontend-engineer.webp');
  });

  it('does not return another user conversation or its employee metadata', async () => {
    await expect(service.findOne(session.id, 'user-2')).rejects.toThrow(ForbiddenException);
  });

  it('shows archived employee chats only with an active subscription and unexpired member or department grant', async () => {
    await service.findAll('user-1', 'CHAT');

    const [query] = prisma.conversationSession.findMany.mock.calls[0];
    expect(query.where).toMatchObject({
      userId: 'user-1',
      source: 'CHAT',
      status: 'ACTIVE',
      employee: {
        is: {
          OR: [
            { status: { not: 'ARCHIVED' } },
            {
              status: 'ARCHIVED',
              subscriptions: {
                some: {
                  enterpriseId: 'ent-1',
                  status: 'ACTIVE',
                  grants: {
                    some: {
                      OR: [{ memberId: 'member-1' }, { departmentId: 'dept-1' }],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    });

    const archivedSubscription = query.where.employee.is.OR[1].subscriptions.some;
    expect(archivedSubscription.OR).toEqual([
      { endDate: null },
      { endDate: { gt: expect.any(Date) } },
    ]);
    expect(archivedSubscription.grants.some.AND).toEqual([{
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    }]);
  });

  it('does not expose archived employee chats when the user has no enterprise context', async () => {
    (service as any).enterpriseContext.resolveOrNull = jest.fn().mockResolvedValue(null);

    await service.findAll('user-1', 'CHAT');

    expect(prisma.conversationSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          source: 'CHAT',
          status: 'ACTIVE',
          employee: { is: { status: { not: 'ARCHIVED' } } },
        },
      }),
    );
  });

  it('keeps task execution history independent from employee publication status', async () => {
    await service.findAll('user-1', 'TASK');

    expect(prisma.conversationSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', source: 'TASK', status: 'ACTIVE' },
      }),
    );
  });
});
