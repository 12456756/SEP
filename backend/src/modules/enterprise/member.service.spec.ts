/**
 * 企业成员服务测试。
 *
 * 重点覆盖两类**会把企业锁死**的操作：
 *   ① 移除/降级最后一名管理员 → 企业永久失去管理能力
 *      （没人能加成员、建部门、订阅，也没人能把自己提回管理员）
 *   ② 管理员降低自己的角色 → 一步把自己锁在门外
 * 以及多租户越权：跨企业读写成员、把成员分配到别家企业的部门。
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MemberService } from './member.service';

const ACME = {
  enterpriseId: 'ent-acme',
  memberId: 'mem-boss',
  role: 'ENTERPRISE_ADMIN' as const,
  departmentId: null,
};

describe('MemberService', () => {
  let prisma: any;
  let tx: any;
  let ctxSvc: any;
  let svc: MemberService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      department: { findUnique: jest.fn() },
      enterpriseMember: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(2),
        findUnique: jest.fn(),
        create: jest.fn((a: any) => Promise.resolve({ id: 'mem-new', ...a.data })),
        update: jest.fn((a: any) => Promise.resolve({ id: a.where.id, ...a.data })),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    // 事务内的 client 用同一个 tx 对象，便于断言事务里发生了什么
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      knowledgeMemberGrant: { findMany: jest.fn().mockResolvedValue([]) },
      knowledgeBase: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { create: jest.fn().mockResolvedValue({ id: 'user-new' }) },
      enterpriseMember: {
        create: jest.fn((a: any) =>
          Promise.resolve({ id: 'mem-new', ...a.data }),
        ),
        delete: jest.fn().mockResolvedValue({}),
      },
      subscriptionRequest: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      employeeGrant: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction = jest.fn((fn: any) => fn(tx));
    ctxSvc = {
      resolve: jest.fn().mockResolvedValue(ACME),
      assertEnterpriseAdmin: jest.fn(),
    };
    svc = new MemberService(prisma, ctxSvc);
  });

  describe('knowledge grant candidate projection', () => {
    it('paginates within the current enterprise and never selects email or user IDs', async () => {
      prisma.enterpriseMember.findMany.mockResolvedValue([{ id: 'm-a', position: null,
        user: { name: '  ', avatar: null }, department: { name: '财务' } }]);
      const result = await svc.listKnowledgeGrantCandidates('u1', { view: 'knowledge-grant', page: 2, pageSize: 10, keyword: '财务' });
      expect(result).toEqual({ items: [{ memberId: 'm-a', name: '企业成员', avatarUrl: null, position: null, departmentName: '财务' }], page: 2, pageSize: 10, total: 2 });
      expect(ctxSvc.assertEnterpriseAdmin).toHaveBeenCalledWith(ACME);
      const args = prisma.enterpriseMember.findMany.mock.calls[0][0];
      expect(args).toMatchObject({ where: { enterpriseId: 'ent-acme' }, skip: 10, take: 10 });
      expect(args.select.user.select).toEqual({ name: true, avatar: true });
      expect(JSON.stringify(args.where)).not.toContain('email');
      expect(prisma.enterpriseMember.count).toHaveBeenCalledWith({ where: args.where });
    });
    it('checks admin privileges before running either pagination query', async () => {
      ctxSvc.assertEnterpriseAdmin.mockImplementation(() => { throw new ForbiddenException(); });
      await expect(svc.listKnowledgeGrantCandidates('u1', { view: 'knowledge-grant', page: 1, pageSize: 20 })).rejects.toThrow(ForbiddenException);
      expect(prisma.enterpriseMember.findMany).not.toHaveBeenCalled();
      expect(prisma.enterpriseMember.count).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('必须带 enterpriseId 过滤', async () => {
      await svc.list('u1');
      expect(prisma.enterpriseMember.findMany.mock.calls[0][0].where.enterpriseId).toBe(
        'ent-acme',
      );
    });

    it('可按部门过滤', async () => {
      await svc.list('u1', 'dept-tech');
      const where = prisma.enterpriseMember.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ enterpriseId: 'ent-acme', departmentId: 'dept-tech' });
    });
  });

  describe('create', () => {
    it('统一委托邀请服务，不再由管理员创建账号或设置密码', async () => {
      const invitation = {
        create: jest.fn().mockResolvedValue({ id: 'inv-new', token: 'one-time-token' }),
      };
      svc = new MemberService(prisma, ctxSvc, invitation as any);

      const result = await svc.create('u1', {
        email: '  NewHire@ACME.local ',
        password: 'LegacyPasswordShouldBeIgnored',
        role: 'MEMBER',
        departmentId: 'dept-tech',
        position: '后端',
      } as never);

      expect(result).toEqual({ id: 'inv-new', token: 'one-time-token' });
      expect(invitation.create).toHaveBeenCalledWith('u1', {
        email: '  NewHire@ACME.local ',
        role: 'MEMBER',
        departmentId: 'dept-tech',
        position: '后端',
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('缺少邀请服务时拒绝走旧的管理员代设密码旁路', async () => {
      await expect(
        svc.create('u1', { email: 'new@acme.local', role: 'MEMBER' } as never),
      ).rejects.toThrow(/邀请服务未配置/);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('❗管理员不能降低自己的角色（防自锁）', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: 'mem-boss', // 与 ctx.memberId 相同
        enterpriseId: 'ent-acme',
        role: 'ENTERPRISE_ADMIN',
      });

      await expect(
        svc.update('u1', 'mem-boss', { role: 'MEMBER' } as never),
      ).rejects.toThrow(/不能降低自己的角色/);
    });

    it('❗降级最后一名管理员时拒绝', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: 'mem-other',
        enterpriseId: 'ent-acme',
        role: 'ENTERPRISE_ADMIN',
      });
      prisma.enterpriseMember.count.mockResolvedValue(1); // 仅剩一名

      await expect(
        svc.update('u1', 'mem-other', { role: 'MEMBER' } as never),
      ).rejects.toThrow(/至少需要保留一名管理员/);
    });

    it('还有其他管理员时可以降级', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: 'mem-other',
        enterpriseId: 'ent-acme',
        role: 'ENTERPRISE_ADMIN',
      });
      prisma.enterpriseMember.count.mockResolvedValue(2);

      await expect(
        svc.update('u1', 'mem-other', { role: 'MEMBER' } as never),
      ).resolves.toBeDefined();
    });

    it('把普通成员提为管理员不触发最后管理员检查', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: 'mem-staff',
        enterpriseId: 'ent-acme',
        role: 'MEMBER',
      });

      await expect(
        svc.update('u1', 'mem-staff', { role: 'ENTERPRISE_ADMIN' } as never),
      ).resolves.toBeDefined();
      expect(prisma.enterpriseMember.count).not.toHaveBeenCalled();
    });

    it('❗别家企业的成员不可更新', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: 'mem-globex',
        enterpriseId: 'ent-globex',
        role: 'MEMBER',
      });

      await expect(
        svc.update('u1', 'mem-globex', { role: 'DEPT_MANAGER' } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    /** 一名普通成员，无主管部门 */
    const staff = {
      id: 'mem-staff',
      enterpriseId: 'ent-acme',
      role: 'MEMBER',
      user: { id: 'u-staff', email: 'staff@acme.local', name: '张三' },
      ledDepartments: [],
    };

    it('❗不能移除自己', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        ...staff,
        id: 'mem-boss',
        role: 'ENTERPRISE_ADMIN',
      });

      await expect(svc.remove('u1', 'mem-boss')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('❗不能移除最后一名管理员', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        ...staff,
        id: 'mem-other',
        role: 'ENTERPRISE_ADMIN',
      });
      prisma.enterpriseMember.count.mockResolvedValue(1);

      await expect(svc.remove('u1', 'mem-other')).rejects.toThrow(
        ConflictException,
      );
    });

    it('只删成员关系，保留 User 账号', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);

      await svc.remove('u1', 'mem-staff');
      expect(tx.enterpriseMember.delete).toHaveBeenCalledWith({
        where: { id: 'mem-staff' },
      });
      // User 不删：可能还属于别家企业，且离职后要能凭原账号接受新邀请
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('❗别家企业的成员不可移除', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        ...staff,
        id: 'mem-globex',
        enterpriseId: 'ent-globex',
      });

      await expect(svc.remove('u1', 'mem-globex')).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.enterpriseMember.delete).not.toHaveBeenCalled();
    });

    it('回收本人名下的席位授权，并报出回收数量', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);
      tx.employeeGrant.deleteMany.mockResolvedValue({ count: 3 });

      const res = await svc.remove('u1', 'mem-staff');

      // 只按 memberId 删 —— 授权给部门的记录不能受牵连
      expect(tx.employeeGrant.deleteMany).toHaveBeenCalledWith({
        where: { memberId: 'mem-staff' },
      });
      expect(res.reclaimedGrants).toBe(3);
    });

    it('increments each affected knowledge revision when offboarding cascades member grants', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);
      tx.knowledgeMemberGrant.findMany.mockResolvedValue([
        { knowledgeBaseId: 'kb-a' }, { knowledgeBaseId: 'kb-b' },
      ]);
      await svc.remove('u1', 'mem-staff');
      expect(tx.knowledgeMemberGrant.findMany).toHaveBeenCalledWith({
        where: { memberId: 'mem-staff' }, select: { knowledgeBaseId: true },
      });
      expect(tx.knowledgeBase.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['kb-a', 'kb-b'] } }, data: { revision: { increment: 1 } },
      });
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.knowledgeMemberGrant.findMany.mock.invocationCallOrder[0]);
      expect(tx.enterpriseMember.delete.mock.invocationCallOrder[0]).toBeLessThan(tx.knowledgeBase.updateMany.mock.invocationCallOrder[0]);
    });

    it('does not change knowledge revisions when the leaving member has no grants', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);
      await svc.remove('u1', 'mem-staff');
      expect(tx.knowledgeBase.updateMany).not.toHaveBeenCalled();
    });

    it('❗不回收授权给部门的席位（那属于部门，不随离职人员消失）', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);

      await svc.remove('u1', 'mem-staff');

      const where = tx.employeeGrant.deleteMany.mock.calls[0][0].where;
      expect(where).toEqual({ memberId: 'mem-staff' });
      expect(where.departmentId).toBeUndefined();
    });

    it('❗审批历史保留：只取消 PENDING，已审批的申请不动', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);

      await svc.remove('u1', 'mem-staff');

      // 只把 PENDING 置为 CANCELED，从不删除申请行 —— 已审批的沉淀保留
      expect(tx.subscriptionRequest.updateMany).toHaveBeenCalledWith({
        where: { requesterId: 'mem-staff', status: 'PENDING' },
        data: { status: 'CANCELED' },
      });
      expect(tx.subscriptionRequest.deleteMany).toBeUndefined();
    });

    it('待审批的申请置为 CANCELED —— 非成员的申请无从批准', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);
      tx.subscriptionRequest.updateMany.mockResolvedValueOnce({ count: 2 });

      const res = await svc.remove('u1', 'mem-staff');

      expect(res.canceledRequests).toBe(2);
    });

    it('主管的部门在响应中报出，供管理员重新指派', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        ...staff,
        role: 'DEPT_MANAGER',
        ledDepartments: [{ id: 'dept-1', name: '技术部' }],
      });

      const res = await svc.remove('u1', 'mem-staff');

      // 部门无主是需要补动作的状态，静默处理会留下没人负责的部门
      expect(res.vacatedDepartments).toEqual([
        { id: 'dept-1', name: '技术部' },
      ]);
    });

    it('全过程在同一事务内 —— 半途失败不能留下"授权已收、人还在"', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(staff);

      await svc.remove('u1', 'mem-staff');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // 事务外不得有删除动作
      expect(prisma.enterpriseMember.delete).not.toHaveBeenCalled();
    });
  });

  describe('leaveEnterprise（主动离职）', () => {
    const self = {
      id: 'mem-boss',
      enterpriseId: 'ent-acme',
      role: 'MEMBER',
      user: { id: 'u1', email: 'me@acme.local', name: '我' },
      enterprise: { id: 'ent-acme', name: '示例科技' },
      ledDepartments: [],
    };

    beforeEach(() => {
      ctxSvc.resolveOrNull = jest.fn().mockResolvedValue(ACME);
    });

    it('普通成员可自行离职，处置与管理员移除一致', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(self);
      tx.employeeGrant.deleteMany.mockResolvedValue({ count: 2 });

      const res = await svc.leaveEnterprise('u1');

      expect(tx.employeeGrant.deleteMany).toHaveBeenCalledWith({
        where: { memberId: 'mem-boss' },
      });
      expect(tx.enterpriseMember.delete).toHaveBeenCalledWith({
        where: { id: 'mem-boss' },
      });
      expect(res.reclaimedGrants).toBe(2);
      // 前端要展示"你已离开 X 公司"
      expect(res.enterprise).toEqual({ id: 'ent-acme', name: '示例科技' });
    });

    it('❗审批历史照样保留 —— 主动离职只取消 PENDING，不动已审批沉淀', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(self);

      await svc.leaveEnterprise('u1');

      expect(tx.subscriptionRequest.updateMany).toHaveBeenCalledWith({
        where: { requesterId: 'mem-boss', status: 'PENDING' },
        data: { status: 'CANCELED' },
      });
    });

    it('❗唯一管理员不可离职 —— 否则企业永久失去管理能力', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        ...self,
        role: 'ENTERPRISE_ADMIN',
      });
      prisma.enterpriseMember.count.mockResolvedValue(1);

      await expect(svc.leaveEnterprise('u1')).rejects.toThrow(
        ConflictException,
      );
      await expect(svc.leaveEnterprise('u1')).rejects.toThrow(
        /唯一的管理员/,
      );
      expect(tx.enterpriseMember.delete).not.toHaveBeenCalled();
    });

    it('还有其他管理员时，管理员本人可以离职', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        ...self,
        role: 'ENTERPRISE_ADMIN',
      });
      prisma.enterpriseMember.count.mockResolvedValue(2);

      await expect(svc.leaveEnterprise('u1')).resolves.toMatchObject({
        removed: true,
      });
    });

    it('❗无企业归属时报 400，不能报成 403「无权操作」', async () => {
      // resolve() 对无归属用户抛 403，会把"你本来就没有企业"
      // 说成"你无权操作"，用户无从下手
      ctxSvc.resolveOrNull = jest.fn().mockResolvedValue(null);

      await expect(svc.leaveEnterprise('u-orphan')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('❗不需要管理员权限 —— 否则普通成员永远走不掉', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue(self);

      await svc.leaveEnterprise('u1');

      expect(ctxSvc.assertEnterpriseAdmin).not.toHaveBeenCalled();
    });

    it('主管的部门同样报出，供原企业重新指派', async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        ...self,
        role: 'DEPT_MANAGER',
        ledDepartments: [{ id: 'dept-9', name: '市场部' }],
      });

      const res = await svc.leaveEnterprise('u1');

      expect(res.vacatedDepartments).toEqual([
        { id: 'dept-9', name: '市场部' },
      ]);
    });
  });
});
