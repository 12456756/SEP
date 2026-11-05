import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SkillVersionService } from './skill-version.service';

/**
 * 阶段二新增的三个读接口（能力列表 / 版本时间线 / 使用统计 / 执行明细）
 * 共用一把授权关。这里覆盖的是「关得住吗」和「统计算得对吗」——
 * 两者都是「写错了不会报错、只会静默给出错数据」的地方。
 */
describe('SkillVersionService 使用记录与统计', () => {
  // role 不用 `as const`：测试要靠 `{ ...ADMIN_CTX, role: 'MEMBER' }` 覆盖非管理员路径，
  // 收窄成字面量后那种写法过不了类型检查。
  const ADMIN_CTX: {
    enterpriseId: string;
    memberId: string;
    departmentId: string | null;
    role: 'ENTERPRISE_ADMIN' | 'DEPT_MANAGER' | 'MEMBER';
  } = {
    enterpriseId: 'ent-1',
    memberId: 'mem-admin',
    departmentId: null,
    role: 'ENTERPRISE_ADMIN',
  };

  function build(overrides: {
    subscriptionFindFirst?: jest.Mock;
    subscriptionFindMany?: jest.Mock;
    toolExecutionFindMany?: jest.Mock;
    toolExecutionGroupBy?: jest.Mock;
    capabilityFindUnique?: jest.Mock;
    skillVersionFindMany?: jest.Mock;
    subscriptionSkillVersionFindUnique?: jest.Mock;
    context?: typeof ADMIN_CTX;
  } = {}) {
    const prisma = {
      subscription: {
        findFirst: overrides.subscriptionFindFirst ?? jest.fn().mockResolvedValue({ id: 'sub-1' }),
        findMany: overrides.subscriptionFindMany ?? jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', employee: { bindings: [] } }),
      },
      toolExecution: {
        findMany: overrides.toolExecutionFindMany ?? jest.fn().mockResolvedValue([]),
        groupBy: overrides.toolExecutionGroupBy ?? jest.fn().mockResolvedValue([]),
      },
      capability: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique:
          overrides.capabilityFindUnique ??
          jest.fn().mockResolvedValue({ id: 'cap-1', name: '电商运营', description: '', status: 'APPROVED' }),
      },
      skillVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: overrides.skillVersionFindMany ?? jest.fn().mockResolvedValue([]),
      },
      memberSkillVersionSelection: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      subscriptionSkillVersion: {
        findUnique: overrides.subscriptionSkillVersionFindUnique ?? jest.fn().mockResolvedValue(null),
      },
      enterpriseSkillDefault: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    };
    const enterpriseContext = {
      resolve: jest.fn().mockResolvedValue(overrides.context ?? ADMIN_CTX),
      assertEnterpriseAdmin: jest.fn((ctx) => {
        if (ctx.role !== 'ENTERPRISE_ADMIN') throw new ForbiddenException();
      }),
    };
    const defaults = { get: jest.fn().mockResolvedValue(null), lock: jest.fn(), set: jest.fn() };
    const service = new SkillVersionService(prisma as never, enterpriseContext as never, defaults as never);
    return { service, prisma, enterpriseContext, defaults };
  }

  describe('授权关', () => {
    it.each(['MEMBER', 'DEPT_MANAGER'] as const)(
      '%s 查看非留存技能时间线要求有效的本人或部门 grant', async (role) => {
        const { service, prisma } = build({ context: { ...ADMIN_CTX, role, departmentId: 'dept-1' } });
        await service.listVersionTimeline('user-1', 'cap-1');
        expect(prisma.subscription.findFirst).toHaveBeenCalledWith({ where: {
          enterpriseId: 'ent-1', status: 'ACTIVE',
          OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }],
          employee: { bindings: { some: { capabilityId: 'cap-1', enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
          grants: { some: { OR: [{ memberId: 'mem-admin' }, { departmentId: 'dept-1' }],
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }],
          } },
        }, select: { id: true } });
      },
    );

    it('无部门的成员读取时间线时不匹配全企业或空部门授权', async () => {
      const { service, prisma } = build({ context: { ...ADMIN_CTX, role: 'MEMBER' } });
      await service.listVersionTimeline('user-1', 'cap-1');
      expect(prisma.subscription.findFirst.mock.calls[0][0].where.grants.some.OR)
        .toEqual([{ memberId: 'mem-admin' }]);
    });

    it('管理员可查看企业绑定技能，不要求本人 grant', async () => {
      const { service, prisma } = build();
      await service.listVersionTimeline('admin-1', 'cap-1');
      expect(prisma.subscription.findFirst.mock.calls[0][0].where).not.toHaveProperty('grants');
    });

    it('本企业既无有效技能绑定也无留存版本时，版本时间线隐藏技能', async () => {
      const { service, prisma } = build({ subscriptionFindFirst: jest.fn().mockResolvedValue(null) });
      await expect(service.listVersionTimeline('u1', 'cap-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
        enterpriseId: 'ent-1', capabilityId: 'cap-1', capability: { type: 'SKILL' },
      }) }));
    });

    it('成员可查看本企业留存发布版，但不会获得他人个人改动或额外执行授权', async () => {
      const { service, prisma } = build({
        context: { ...ADMIN_CTX, role: 'MEMBER' }, subscriptionFindFirst: jest.fn().mockResolvedValue(null),
      });
      prisma.skillVersion.findFirst.mockResolvedValue({ id: 'retained-version' } as never);
      await service.listVersionTimeline('user-1', 'cap-1');
      expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
        enterpriseId: 'ent-1', capabilityId: 'cap-1', capability: { type: 'SKILL' },
        OR: [{ scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' }],
      } }));
      expect(prisma.skillVersion.findMany.mock.calls[0][0].where.OR).toEqual([
        { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
        { scope: 'ENTERPRISE', enterpriseId: 'ent-1', status: 'ENTERPRISE_APPROVED' },
        { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1' },
      ]);
      await expect(service.getUsageSummary('user-1', 'cap-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('没有授权订阅时，使用统计同样拒绝 —— 三个接口不能有一个漏掉', async () => {
      const { service } = build({ subscriptionFindFirst: jest.fn().mockResolvedValue(null) });
      await expect(service.getUsageSummary('u1', 'cap-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('没有授权订阅时，执行明细同样拒绝', async () => {
      const { service } = build({ subscriptionFindFirst: jest.fn().mockResolvedValue(null) });
      await expect(service.getExecutionDetails('u1', 'cap-1', 20)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('授权关按「订阅的员工绑定了这个能力」判定，而不只是「企业有这个订阅」', async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: 'sub-1' });
      const { service } = build({ subscriptionFindFirst: findFirst });
      await service.getUsageSummary('u1', 'cap-1');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            employee: { bindings: { some: { capabilityId: 'cap-1', enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } } } },
          }),
        }),
      );
    });
  });

  describe('getUsageSummary', () => {
    const executions = [
      execution('e1', 'u-boss', 'sess-1', 'emp-1', '电商专家'),
      execution('e2', 'u-boss', 'sess-1', 'emp-1', '电商专家'),
      execution('e3', 'u-staff', 'sess-2', 'emp-1', '电商专家'),
      // userId 为空的历史记录（B2 之前落的库）不该被算进「使用人数」
      execution('e4', null, 'sess-2', 'emp-1', '电商专家'),
    ];

    it('会话与用户各自去重，调用轮次按行数算', async () => {
      const { service } = build({
        context: { ...ADMIN_CTX, role: 'MEMBER' },
        toolExecutionFindMany: jest.fn().mockResolvedValue(executions),
      });
      const result = await service.getUsageSummary('u1', 'cap-1');

      expect(result.summary).toEqual({
        distinctUserCount: 2, // u-boss、u-staff；null 不计
        totalConversations: 2, // sess-1、sess-2
        totalRounds: 4,
      });
    });

    it('按员工聚合把同一员工的多次调用合并', async () => {
      const { service } = build({
        toolExecutionFindMany: jest.fn().mockResolvedValue([
          ...executions,
          execution('e5', 'u-boss', 'sess-3', 'emp-2', '直播教练'),
        ]),
      });
      const result = await service.getUsageSummary('u1', 'cap-1');

      expect(result.byEmployee).toEqual([
        { employeeId: 'emp-1', employeeName: '电商专家', rounds: 4 },
        { employeeId: 'emp-2', employeeName: '直播教练', rounds: 1 },
      ]);
    });

    it('管理员拿到 byMember', async () => {
      const { service } = build({
        toolExecutionFindMany: jest.fn().mockResolvedValue(executions),
      });
      const result = await service.getUsageSummary('u1', 'cap-1');

      expect(result.byMember).toEqual([
        { userId: 'u-boss', userName: '甲总', rounds: 2 },
        { userId: 'u-staff', userName: '甲总', rounds: 1 },
      ]);
    });

    it('非管理员拿不到 byMember —— 那里面是成员的使用明细', async () => {
      const { service } = build({
        context: { ...ADMIN_CTX, role: 'MEMBER' },
        toolExecutionFindMany: jest.fn().mockResolvedValue(executions),
      });
      const result = await service.getUsageSummary('u1', 'cap-1');

      expect(result.byMember).toBeUndefined();
      // 但总览和按员工两层照常返回
      expect(result.summary.distinctUserCount).toBe(2);
      expect(result.byEmployee).toHaveLength(1);
    });

    it('统计查询同时约束会话员工在当前企业的有效订阅', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = build({ toolExecutionFindMany: findMany });

      await service.getUsageSummary('u1', 'cap-1');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            session: expect.objectContaining({
              employee: {
                subscriptions: { some: { enterpriseId: 'ent-1', status: 'ACTIVE' } },
              },
            }),
          }),
        }),
      );
    });
  });

  describe('getExecutionDetails', () => {
    it('拒绝非管理员读取含对话内容的执行明细', async () => {
      const { service } = build({ context: { ...ADMIN_CTX, role: 'MEMBER' } });
      await expect(service.getExecutionDetails('u1', 'cap-1', 20)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('版本作用域展平成 versionScope，供前端打「企业版 / 平台版」标签', async () => {
      const { service } = build({
        toolExecutionFindMany: jest.fn().mockResolvedValue([
          {
            id: 'e1',
            sessionId: 'sess-1',
            input: { query: 'x' },
            output: { text: 'y' },
            status: 'SUCCESS',
            errorMessage: null,
            duration: 1200,
            skillVersionId: 'sv-ent',
            skillVersion: { scope: 'ENTERPRISE' },
            userId: 'u-boss',
            user: { name: '甲总' },
            createdAt: new Date('2026-08-30T10:00:00.000Z'),
          },
        ]),
      });

      const result = await service.getExecutionDetails('u1', 'cap-1', 20);

      expect(result.items[0]).toMatchObject({
        versionScope: 'ENTERPRISE',
        userName: '甲总',
        createdAt: '2026-08-30T10:00:00.000Z',
      });
    });

    it('没有版本归属的历史记录 versionScope 为 null，不假装是平台版', async () => {
      const { service } = build({
        toolExecutionFindMany: jest.fn().mockResolvedValue([
          {
            id: 'e1',
            sessionId: 'sess-1',
            input: {},
            output: null,
            status: 'SUCCESS',
            errorMessage: null,
            duration: null,
            skillVersionId: null,
            skillVersion: null,
            userId: null,
            user: null,
            createdAt: new Date('2026-08-30T10:00:00.000Z'),
          },
        ]),
      });

      const result = await service.getExecutionDetails('u1', 'cap-1', 20);
      expect(result.items[0].versionScope).toBeNull();
      expect(result.items[0].userName).toBeNull();
    });

    it('满页时给出游标，不满页时为 null —— 否则前端会多请求一次空页', async () => {
      const row = (id: string) => ({
        id,
        sessionId: 's',
        input: {},
        output: null,
        status: 'SUCCESS' as const,
        errorMessage: null,
        duration: null,
        skillVersionId: null,
        skillVersion: null,
        userId: null,
        user: null,
        createdAt: new Date('2026-08-30T10:00:00.000Z'),
      });

      const full = build({ toolExecutionFindMany: jest.fn().mockResolvedValue([row('a'), row('b')]) });
      expect((await full.service.getExecutionDetails('u1', 'cap-1', 2)).nextCursor).toBe(
        '2026-08-30T10:00:00.000Z',
      );

      const partial = build({ toolExecutionFindMany: jest.fn().mockResolvedValue([row('a')]) });
      expect((await partial.service.getExecutionDetails('u1', 'cap-1', 2)).nextCursor).toBeNull();
    });

    it('游标转成 createdAt < cursor 的过滤条件', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = build({ toolExecutionFindMany: findMany });
      await service.getExecutionDetails('u1', 'cap-1', 20, '2026-08-30T10:00:00.000Z');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { lt: new Date('2026-08-30T10:00:00.000Z') },
          }),
        }),
      );
    });

    it('明细查询同时约束会话员工在当前企业的有效订阅', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = build({ toolExecutionFindMany: findMany });

      await service.getExecutionDetails('u1', 'cap-1', 20);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            session: expect.objectContaining({
              employee: {
                subscriptions: { some: { enterpriseId: 'ent-1', status: 'ACTIVE' } },
              },
            }),
          }),
        }),
      );
    });
  });

  describe('listIterableCapabilities', () => {
    it.each(['MEMBER', 'DEPT_MANAGER'] as const)(
      '%s 仅枚举有效本人或部门授权的员工，未授权留存技能不暴露员工关系', async (role) => {
        const { service, prisma } = build({ context: { ...ADMIN_CTX, role, departmentId: 'dept-1' } });
        prisma.capability.findMany.mockResolvedValue([{ id: 'retained', name: '留存', description: '' }] as never);
        const result = await service.listIterableCapabilities('user-1');
        expect(prisma.subscription.findMany.mock.calls[0][0].where).toEqual({
          enterpriseId: 'ent-1', status: 'ACTIVE',
          OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }],
          grants: { some: { OR: [{ memberId: 'mem-admin' }, { departmentId: 'dept-1' }],
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }],
          } },
        });
        expect(prisma.subscription.findMany.mock.calls[0][0].select.employee.select.bindings.where)
          .toEqual({ enabled: true, capability: { type: 'SKILL', status: 'APPROVED' } });
        expect(prisma.capability.findMany.mock.calls[0][0].where).toEqual({ type: 'SKILL', skillVersions: { some: {
          enterpriseId: 'ent-1', OR: [{ scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' }],
        } } });
        expect(result.items).toMatchObject([{ capability: { id: 'retained' }, employees: [] }]);
      },
    );

    it('无部门成员目录只匹配本人 grant，管理员目录不要求 grant', async () => {
      const member = build({ context: { ...ADMIN_CTX, role: 'MEMBER' } });
      await member.service.listIterableCapabilities('user-1');
      expect(member.prisma.subscription.findMany.mock.calls[0][0].where.grants.some.OR)
        .toEqual([{ memberId: 'mem-admin' }]);
      const admin = build();
      await admin.service.listIterableCapabilities('admin-1');
      expect(admin.prisma.subscription.findMany.mock.calls[0][0].where).not.toHaveProperty('grants');
    });

    it.each(['ENTERPRISE_ADMIN', 'MEMBER'] as const)('无订阅时 %s 仍能看到本企业留存发布技能及持久默认', async (role) => {
      const { service, prisma } = build({ context: { ...ADMIN_CTX, role } });
      prisma.capability.findMany.mockResolvedValue([
        { id: 'cap-retained', name: '留存技能', description: '' },
      ] as never);
      const current = { id: 'enterprise-old', version: '1.0.0', scope: 'ENTERPRISE' };
      prisma.enterpriseSkillDefault.findMany.mockResolvedValue([
        { capabilityId: 'cap-retained', version: current },
      ] as never);

      const result = await service.listIterableCapabilities('user-1');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ capability: { id: 'cap-retained' }, employees: [], currentVersion: current });
      expect(result.summary.capabilityCount).toBe(1);
      const retainedWhere = prisma.capability.findMany.mock.calls[0][0].where;
      expect(retainedWhere).toMatchObject({ type: 'SKILL', skillVersions: { some: { enterpriseId: 'ent-1' } } });
      const scopes = retainedWhere.skillVersions.some.OR;
      expect(scopes).toContainEqual({ scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' });
      if (role === 'MEMBER') {
        expect(scopes).toHaveLength(1);
      } else {
        expect(scopes).toContainEqual({ scope: 'PERSONAL', workingCopyId: null,
          status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] } });
      }
      expect(prisma.enterpriseSkillDefault.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
        enterpriseId: 'ent-1', capabilityId: { in: ['cap-retained'] },
      } }));
    });

    it('技能库展示持久企业默认，不被旧订阅选版或模板默认覆盖', async () => {
      const stale = { id: 'enterprise-old', version: '1.0.0', scope: 'ENTERPRISE' };
      const current = { id: 'enterprise-new', version: '1.1.0', scope: 'ENTERPRISE' };
      const { service, prisma } = build({ subscriptionFindMany: jest.fn().mockResolvedValue([{
        id: 'sub-1', employee: { id: 'emp-1', name: '电商专家', bindings: [{
          capability: { id: 'cap-1', name: '电商运营', description: '' }, defaultSkillVersion: stale,
        }] }, skillVersionSelections: [{ capabilityId: 'cap-1', version: stale }],
      }]) });
      prisma.enterpriseSkillDefault.findMany.mockResolvedValue([{
        capabilityId: 'cap-1', versionId: current.id, version: current,
      }] as never);
      const result = await service.listIterableCapabilities('user-1');
      expect(result.items[0].currentVersion).toMatchObject(current);
      expect(prisma.enterpriseSkillDefault.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
        enterpriseId: 'ent-1', capabilityId: { in: ['cap-1'] },
      } }));
    });

    it('同时统计 Web 与客户端待审改动，排除已发布与驳回记录', async () => {
      const updatedAt = new Date('2026-10-09T08:00:00.000Z');
      const row = (id: string, status: string, ownerId = 'other-user', overrides = {}) => ({
        id, capabilityId: 'cap-1', ownerId, status, updatedAt, adoptedInto: [], reviewSnapshots: [], ...overrides,
      });
      const { service, prisma } = build({ subscriptionFindMany: jest.fn().mockResolvedValue([{
        id: 'sub-1', employee: { id: 'emp-1', name: '电商专家', bindings: [{
          capability: { id: 'cap-1', name: '电商运营', description: '' }, defaultSkillVersion: null,
        }] }, skillVersionSelections: [],
      }]) });
      prisma.skillVersion.findMany.mockResolvedValue([
        row('web-copy', 'PERSONAL_ACTIVE', 'user-1'),
        row('client-pending', 'PENDING_ENTERPRISE_REVIEW'),
        row('published', 'ENTERPRISE_APPROVED', 'other-user', {
          adoptedInto: [{ targetVersionId: 'enterprise-v2', adoptedAt: updatedAt }],
        }),
        row('rejected', 'ENTERPRISE_REJECTED'),
      ]);
      const result = await service.listIterableCapabilities('user-1');
      expect(result.items[0]).toMatchObject({ pendingAdoptionCount: 2, myPersonalVersionId: 'web-copy' });
      expect(result.summary.pendingAdoptionTotal).toBe(2);
      expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
        capabilityId: { in: ['cap-1'] }, scope: 'PERSONAL', enterpriseId: 'ent-1', workingCopyId: null,
        status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] },
      } }));
    });

    it('能力列表统计同样按会话员工的企业订阅隔离', async () => {
      const groupBy = jest.fn().mockResolvedValue([]);
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = build({
        subscriptionFindMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-1',
            employee: {
              id: 'emp-1',
              name: '电商专家',
              bindings: [
                {
                  capability: { id: 'cap-1', name: '电商运营', description: '' },
                  defaultSkillVersion: null,
                },
              ],
            },
            skillVersionSelections: [],
          },
        ]),
        toolExecutionGroupBy: groupBy,
        toolExecutionFindMany: findMany,
      });

      await service.listIterableCapabilities('u1');

      for (const query of [groupBy, findMany]) {
        expect(query).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              session: expect.objectContaining({
                employee: {
                  subscriptions: { some: { enterpriseId: 'ent-1', status: 'ACTIVE' } },
                },
              }),
            }),
          }),
        );
      }
    });
  });

  describe('listVersionTimeline', () => {
    it('时间线优先标记持久企业默认，保留历史版本可切换', async () => {
      const selectedAt = new Date('2026-10-09T08:00:00.000Z');
      const { service, defaults } = build({ skillVersionFindMany: jest.fn().mockResolvedValue([
        { id: 'enterprise-new', scope: 'ENTERPRISE', version: '1.1.0', promotedVersions: [], reviews: [] },
        { id: 'enterprise-old', scope: 'ENTERPRISE', version: '1.0.0', promotedVersions: [], reviews: [] },
      ]), subscriptionSkillVersionFindUnique: jest.fn().mockResolvedValue({
        versionId: 'enterprise-old', selectedAt,
      }) });
      defaults.get.mockResolvedValue({ versionId: 'enterprise-new', selectedAt,
        version: { id: 'enterprise-new', capabilityId: 'cap-1', enterpriseId: 'ent-1',
          scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', version: '1.1.0' } } as never);
      const result = await service.listVersionTimeline('user-1', 'cap-1');
      expect(result.currentVersionId).toBe('enterprise-new');
      expect(result.effectiveVersionState).toBe('EXPLICIT');
      expect(result.effectiveVersion).toEqual({ id: 'enterprise-new', scope: 'ENTERPRISE', version: '1.1.0' });
      expect(result.selectedAt).toBe(selectedAt.toISOString());
      expect(result.versions.map((version) => [version.id, version.isCurrent])).toEqual([
        ['enterprise-new', true], ['enterprise-old', false],
      ]);
      expect(defaults.get).toHaveBeenCalledWith('ent-1', 'cap-1');
    });

    it('不同订阅实际使用不同版本时返回 MIXED，不把首条选版冒充企业当前版本', async () => {
      const selectedAt = new Date('2026-08-28T00:00:00.000Z');
      const enterpriseVersion = { id: 'sv-ent', capabilityId: 'cap-1', enterpriseId: 'ent-1',
        scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', version: '1.1.0' };
      const platformVersion = { id: 'sv-plat', capabilityId: 'cap-1', enterpriseId: null,
        scope: 'PLATFORM', status: 'PLATFORM_APPROVED', version: '1.0.0' };
      const { service, prisma } = build({
        skillVersionFindMany: jest.fn().mockResolvedValue([
          { id: 'sv-ent', version: '1.1.0', scope: 'ENTERPRISE', promotedVersions: [], reviews: [] },
          { id: 'sv-plat', version: '1.0.0', scope: 'PLATFORM', promotedVersions: [], reviews: [] },
        ]),
        subscriptionFindMany: jest.fn().mockResolvedValue([
          { id: 'sub-1', employee: { id: 'employee-1', name: '员工1' },
            skillVersionSelections: [{ versionId: 'sv-ent', selectedAt }] },
          { id: 'sub-2', employee: { id: 'employee-2', name: '员工2' }, skillVersionSelections: [] },
        ]),
        subscriptionSkillVersionFindUnique: jest.fn().mockImplementation(async ({ where }) =>
          where.subscriptionId_capabilityId.subscriptionId === 'sub-1'
            ? { versionId: 'sv-ent', selectedAt, version: enterpriseVersion } : null),
      });
      prisma.subscription.findUnique.mockResolvedValue({ enterpriseId: 'ent-1',
        employee: { bindings: [{ defaultSkillVersion: platformVersion }] } });

      const result = await service.listVersionTimeline('u1', 'cap-1');

      expect(result.effectiveVersionState).toBe('MIXED');
      expect(result.effectiveVersion).toBeNull();
      expect(result.currentVersionId).toBeNull();
      expect(result.selectedAt).toBeNull();
      expect(result.subscriptions.map((item) => [item.subscriptionId, item.currentVersionId, item.selectedAt]))
        .toEqual([['sub-1', 'sv-ent', selectedAt.toISOString()], ['sub-2', 'sv-plat', null]]);
      expect(result.versions.map((v) => [v.id, v.isCurrent])).toEqual([
        ['sv-ent', false],
        ['sv-plat', false],
      ]);
    });

    it('没有选版记录时 currentVersionId 为 null —— 执行时会兜底到平台版', async () => {
      const { service } = build({
        skillVersionFindMany: jest.fn().mockResolvedValue([
          { id: 'sv-plat', version: '1.0.0', scope: 'PLATFORM', promotedVersions: [], reviews: [] },
        ]),
      });

      const result = await service.listVersionTimeline('u1', 'cap-1');
      expect(result.currentVersionId).toBeNull();
      expect(result.versions[0].isCurrent).toBe(false);
    });

    it('企业版把草稿与待审也列出来 —— 否则「我提交的那版去哪了」无从回答', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = build({ skillVersionFindMany: findMany });
      await service.listVersionTimeline('u1', 'cap-1');

      const where = findMany.mock.calls[0][0].where;
      // 平台版只要审核通过的，企业版不限状态
      expect(where.OR).toEqual([
        { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
        { scope: 'ENTERPRISE', enterpriseId: 'ent-1' },
        { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'u1' },
      ]);
    });

    it.each(['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] as const)(
      '本人送审状态 %s 出现在只读时间线但不成为启用版本', async (status) => {
        const submitted = { id: 'submitted', version: '0.0.0-personal.test', scope: 'PERSONAL',
          status, ownerId: 'user-1', submittedAt: new Date(), rejectionReason: status === 'ENTERPRISE_REJECTED' ? '补充说明' : null,
          promotedVersions: [], reviews: [] };
        const findMany = jest.fn().mockResolvedValue([submitted]);
        const { service } = build({ skillVersionFindMany: findMany, context: { ...ADMIN_CTX, role: 'MEMBER' } });
        const result = await service.listVersionTimeline('user-1', 'cap-1');
        expect(findMany.mock.calls[0][0].where).toEqual({ capabilityId: 'cap-1', OR: [
          { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
          { scope: 'ENTERPRISE', enterpriseId: 'ent-1', status: 'ENTERPRISE_APPROVED' },
          { scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1' },
        ] });
        expect(result.versions[0]).toMatchObject({ id: 'submitted', status, ownerId: 'user-1', isCurrent: false,
          rejectionReason: submitted.rejectionReason });
        expect(result.currentVersionId).toBeNull();
      },
    );

    it('普通成员只枚举授权且未过期的订阅，忽略历史 PIN 并统一跟随企业启用', async () => {
      const { service, prisma } = build({ context: { ...ADMIN_CTX, role: 'MEMBER' } });
      prisma.subscription.findMany.mockResolvedValue([
        { id: 'sub-b', employee: { id: 'employee-b', name: '员工B' },
          grants: [{ id: 'grant-b' }], skillVersionSelections: [{ versionId: 'enterprise-v', selectedAt: new Date() }],
          personalSkillSelections: [{ versionId: 'platform-old' }] },
      ]);
      jest.spyOn(service, 'resolveEffectiveVersion').mockImplementation(async (_sub, _cap, userId) => (
        { id: userId ? 'platform-old' : 'enterprise-v', scope: userId ? 'PLATFORM' : 'ENTERPRISE' } as never
      ));
      const result = await service.listVersionTimeline('user-1', 'cap-1');
      expect(prisma.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
        enterpriseId: 'ent-1', status: 'ACTIVE', OR: expect.any(Array), grants: { some: expect.anything() },
      }) }));
      expect(result.subscriptions[0]).toMatchObject({
        subscriptionId: 'sub-b', currentVersionId: 'enterprise-v', enterpriseVersionId: 'enterprise-v',
        personalVersionId: null, personalSelectionMode: 'FOLLOW_ENTERPRISE', effectiveVersionId: 'enterprise-v',
        effectiveVersionScope: 'ENTERPRISE', canSelectPersonal: false,
      });
    });

    it('管理员可管理未授权给自己的订阅，但不能个人切版', async () => {
      const { service, prisma } = build();
      prisma.subscription.findMany.mockResolvedValue([
        { id: 'sub-b', employee: { id: 'employee-b', name: '员工B' },
          grants: [], skillVersionSelections: [], personalSkillSelections: [] },
      ]);
      jest.spyOn(service, 'resolveEffectiveVersion').mockResolvedValue({ id: 'platform-fallback', scope: 'PLATFORM' } as never);
      const result = await service.listVersionTimeline('admin-1', 'cap-1');
      expect(prisma.subscription.findMany.mock.calls[0][0].where.grants).toBeUndefined();
      expect(result.subscriptions[0]).toMatchObject({ canSelectPersonal: false, effectiveVersionId: 'platform-fallback',
        enterpriseVersionId: 'platform-fallback', personalSelectionMode: 'FOLLOW_ENTERPRISE', currentVersionId: 'platform-fallback' });
    });

    it('能力不存在时抛 NotFound', async () => {
      const { service } = build({ capabilityFindUnique: jest.fn().mockResolvedValue(null) });
      await expect(service.listVersionTimeline('u1', 'cap-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

function execution(
  id: string,
  userId: string | null,
  sessionId: string,
  employeeId: string,
  employeeName: string,
) {
  return {
    id,
    sessionId,
    userId,
    skillVersionId: 'sv-ent',
    session: { employeeId, employee: { name: employeeName } },
    user: userId ? { name: '甲总' } : null,
  };
}
