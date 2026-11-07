/**
 * 企业上下文解析测试。
 *
 * 这是多租户隔离的**唯一可信来源** —— enterpriseId 只能由服务端从 userId
 * 反查得出。若此处失守，所有下游的企业过滤都建立在错误的前提上。
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EnterpriseContextService } from './enterprise-context.service';

type MockPrisma = {
  enterpriseMember: { findFirst: jest.Mock };
};

describe('EnterpriseContextService', () => {
  let prisma: MockPrisma;
  let svc: EnterpriseContextService;

  beforeEach(() => {
    prisma = { enterpriseMember: { findFirst: jest.fn() } };
    svc = new EnterpriseContextService(prisma as never);
  });

  describe('resolve', () => {
    it('返回企业上下文，memberId 用的是 EnterpriseMember 主键而非 userId', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({
        id: 'mem-1',
        enterpriseId: 'ent-acme',
        role: 'ENTERPRISE_ADMIN',
        departmentId: 'dept-tech',
      });

      const ctx = await svc.resolve('user-1');

      expect(ctx).toEqual({
        enterpriseId: 'ent-acme',
        memberId: 'mem-1',
        role: 'ENTERPRISE_ADMIN',
        departmentId: 'dept-tech',
      });
      // memberId 必须是 member.id —— 授权、申请等表引用的是它，
      // 误用 userId 会导致外键指向错误的行
      expect(ctx.memberId).not.toBe('user-1');
    });

    it('只按 userId 查询，不接受外部传入的 enterpriseId', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({
        id: 'mem-1',
        enterpriseId: 'ent-acme',
        role: 'MEMBER',
        departmentId: null,
      });

      await svc.resolve('user-1');

      const arg = prisma.enterpriseMember.findFirst.mock.calls[0][0];
      // 查询条件只能有 userId。若这里出现 enterpriseId，
      // 说明企业归属可被调用方指定 —— 等于没有隔离。
      expect(arg.where).toEqual({ userId: 'user-1', enterprise: { status: 'ACTIVE' } });
    });

    it('冻结企业成员不能解析企业业务上下文', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({
        id: 'mem-1', enterpriseId: 'ent-acme', role: 'MEMBER', departmentId: null,
        enterprise: { metadata: { suspended: true } },
      });

      await expect(svc.resolve('user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ENTERPRISE_SUSPENDED' }),
      });
    });

    it('用户不属于任何企业时抛 Forbidden，而非返回空上下文', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue(null);

      // 关键：不能返回 undefined/null 让下游自己判断，
      // 否则漏判一处就等于放开了企业过滤
      await expect(svc.resolve('user-x')).rejects.toThrow(ForbiddenException);
    });

    it('多条 membership 时取最早一条（MVP 单企业的确定性行为）', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({
        id: 'mem-first',
        enterpriseId: 'ent-first',
        role: 'MEMBER',
        departmentId: null,
      });

      await svc.resolve('user-1');

      const arg = prisma.enterpriseMember.findFirst.mock.calls[0][0];
      expect(arg.orderBy).toEqual({ createdAt: 'asc' });
    });

    it('未分配部门时 departmentId 为 null（如企业创建者）', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({
        id: 'mem-1',
        enterpriseId: 'ent-acme',
        role: 'ENTERPRISE_ADMIN',
        departmentId: null,
      });

      const ctx = await svc.resolve('user-1');
      expect(ctx.departmentId).toBeNull();
    });
  });

  describe('resolveOrNull', () => {
    it('无企业时返回 null 而不抛错', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue(null);
      await expect(svc.resolveOrNull('user-x')).resolves.toBeNull();
    });

    it('有企业时与 resolve 结果一致', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({
        id: 'mem-1',
        enterpriseId: 'ent-acme',
        role: 'DEPT_MANAGER',
        departmentId: 'dept-tech',
      });
      const ctx = await svc.resolveOrNull('user-1');
      expect(ctx?.enterpriseId).toBe('ent-acme');
    });

    it('不吞掉企业冻结拒绝', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({
        id: 'mem-1', enterpriseId: 'ent-acme', role: 'MEMBER', departmentId: null,
        enterprise: { metadata: { suspended: true } },
      });
      await expect(svc.resolveOrNull('user-1')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('角色断言', () => {
    const ctx = (role: string) =>
      ({
        enterpriseId: 'ent-acme',
        memberId: 'mem-1',
        role,
        departmentId: null,
      }) as never;

    it('assertEnterpriseAdmin：仅管理员通过', () => {
      expect(() => svc.assertEnterpriseAdmin(ctx('ENTERPRISE_ADMIN'))).not.toThrow();
      // 部门负责人不能订阅 —— 订阅要花企业的钱
      expect(() => svc.assertEnterpriseAdmin(ctx('DEPT_MANAGER'))).toThrow(ForbiddenException);
      expect(() => svc.assertEnterpriseAdmin(ctx('MEMBER'))).toThrow(ForbiddenException);
    });

    it('assertCanApprove：仅管理员通过', () => {
      expect(() => svc.assertCanApprove(ctx('ENTERPRISE_ADMIN'))).not.toThrow();
      // DEPT_MANAGER 本版暂按普通成员对待：该角色要名副其实需要「数据范围」
      // 那一层（只能管本部门），后端尚无，故不给它高于 MEMBER 的权限，
      // 避免「能审批却看不到本部门数据」的半成品状态
      expect(() => svc.assertCanApprove(ctx('DEPT_MANAGER'))).toThrow(ForbiddenException);
      expect(() => svc.assertCanApprove(ctx('MEMBER'))).toThrow(ForbiddenException);
    });
  });
});
