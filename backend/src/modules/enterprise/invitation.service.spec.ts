/**
 * 企业邀请服务测试。
 *
 * 邀请链接等同于一次性登录凭证，故重点覆盖三类**安全**行为：
 *   ① 明文 token 绝不入库 —— 只存 SHA-256 摘要
 *   ② 重邀同一邮箱必须作废旧 PENDING —— 否则撤回一条等于没撤
 *   ③ 校验失败统一措辞 —— 区分「不存在」与「已失效」会让攻击者能枚举有效 token
 * 以及多租户越权（跨企业撤回邀请）与过期收敛。
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { InvitationService } from './invitation.service';

const ACME = {
  enterpriseId: 'ent-acme',
  memberId: 'mem-boss',
  role: 'ENTERPRISE_ADMIN' as const,
  departmentId: null,
};

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s).digest('hex');

/** 一条可用的 PENDING 邀请，过期时间在未来 */
const usableInvitation = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  enterpriseId: 'ent-acme',
  email: 'newhire@acme.local',
  tokenHash: 'hash-x',
  role: 'MEMBER',
  departmentId: null,
  position: null,
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 86400_000),
  invitedBy: 'u1',
  createdAt: new Date(),
  acceptedAt: null,
  enterprise: { id: 'ent-acme', name: '示例科技', logo: null, status: 'ACTIVE' },
  department: null,
  ...over,
});

describe('InvitationService', () => {
  let prisma: any;
  let ctxSvc: any;
  let svc: InvitationService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      department: { findUnique: jest.fn() },
      enterpriseMember: { findFirst: jest.fn().mockResolvedValue(null) },
      enterprise: { findUnique: jest.fn().mockResolvedValue({ name: '示例科技' }) },
      enterpriseInvitation: {
        create: jest.fn((a: any) =>
          Promise.resolve({
            id: 'inv-new', ...a.data, createdAt: new Date(),
            department: null, acceptedAt: null,
          }),
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn((a: any) => Promise.resolve({ id: a.where.id })),
        update: jest.fn((a: any) => Promise.resolve({ id: a.where.id })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    ctxSvc = {
      resolve: jest.fn().mockResolvedValue(ACME),
      assertEnterpriseAdmin: jest.fn(),
    };
    svc = new InvitationService(prisma, ctxSvc);
  });

  describe('create', () => {
    it('企业在上下文解析后关闭，不再创建邀请', async () => {
      prisma.$queryRaw.mockResolvedValue([{ status: 'CLOSED' }]);
      await expect(svc.create('u1', { email: 'a@b.com', role: 'MEMBER' } as any)).rejects.toThrow('企业已关闭');
      expect(prisma.enterpriseInvitation.create).not.toHaveBeenCalled();
    });
    it('仅企业管理员可创建', async () => {
      await svc.create('u1', { email: 'a@b.com', role: 'MEMBER' } as any);
      expect(ctxSvc.assertEnterpriseAdmin).toHaveBeenCalled();
    });

    it('库里只存 SHA-256 摘要，明文 token 绝不入库', async () => {
      const res = await svc.create('u1', {
        email: 'newhire@acme.local',
        role: 'MEMBER',
      } as any);

      const stored = prisma.enterpriseInvitation.create.mock.calls[0][0].data;
      expect(stored.tokenHash).toBe(sha256(res.token));
      // 明文不得以任何字段形式落库
      expect(JSON.stringify(stored)).not.toContain(res.token);
    });

    it('token 具备足够熵且 URL 安全（可直接放进链接）', async () => {
      const res = await svc.create('u1', {
        email: 'a@b.com',
        role: 'MEMBER',
      } as any);
      // 32 字节 base64url = 43 字符，无 +/= 需转义
      expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('两次创建的 token 不同', async () => {
      prisma.enterpriseInvitation.findFirst.mockResolvedValue(null);
      const a = await svc.create('u1', { email: 'a@b.com', role: 'MEMBER' } as any);
      const b = await svc.create('u1', { email: 'b@b.com', role: 'MEMBER' } as any);
      expect(a.token).not.toBe(b.token);
    });

    it('重邀同一邮箱：先把旧 PENDING 作废，避免多条链接同时有效', async () => {
      prisma.enterpriseInvitation.findFirst.mockResolvedValue(null);
      await svc.create('u1', {
        email: 'newhire@acme.local',
        role: 'MEMBER',
      } as any);

      expect(prisma.enterpriseInvitation.updateMany).toHaveBeenCalledWith({
        where: {
          enterpriseId: 'ent-acme',
          email: 'newhire@acme.local',
          status: 'PENDING',
        },
        data: { status: 'REVOKED' },
      });
    });

    it('邮箱统一转小写去空格，避免大小写绕过重邀作废', async () => {
      await svc.create('u1', {
        email: '  NewHire@ACME.local ',
        role: 'MEMBER',
      } as any);
      expect(
        prisma.enterpriseInvitation.create.mock.calls[0][0].data.email,
      ).toBe('newhire@acme.local');
    });

    it('已是本企业成员 → 409', async () => {
      prisma.enterpriseMember.findFirst.mockResolvedValue({ id: 'mem-x' });
      await expect(
        svc.create('u1', { email: 'staff@acme.local', role: 'MEMBER' } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('部门属于别家企业 → 404，不泄漏存在性', async () => {
      prisma.department.findUnique.mockResolvedValue({
        id: 'dept-other',
        enterpriseId: 'ent-globex',
      });
      await expect(
        svc.create('u1', {
          email: 'a@b.com',
          role: 'MEMBER',
          departmentId: 'dept-other',
        } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('过期时间落在未来', async () => {
      await svc.create('u1', { email: 'a@b.com', role: 'MEMBER' } as any);
      const { expiresAt } =
        prisma.enterpriseInvitation.create.mock.calls[0][0].data;
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('记录 SMTP 尚在处理，并返回服务端生成的邀请链接', async () => {
      const res = await svc.create('u1', { email: 'a@b.com', role: 'MEMBER' } as any);
      const data = prisma.enterpriseInvitation.create.mock.calls[0][0].data;
      expect(data.emailStatus).toBe('SENDING');
      expect(data.emailLastAttemptAt).toBeInstanceOf(Date);
      expect(res.invitationUrl).toContain('/join?token=');
      expect(res.emailStatus).toBe('NOT_CONFIGURED');
    });

    it('SMTP 发送失败时保留邀请并只返回安全提示', async () => {
      const mail = { sendEnterpriseInvitation: jest.fn().mockRejectedValue(new Error('smtp credential rejected')) };
      svc = new InvitationService(prisma, ctxSvc, mail as any);
      const res = await svc.create('u1', { email: 'a@b.com', role: 'MEMBER' } as any);

      expect(res.emailStatus).toBe('FAILED');
      expect(res.emailError).toBe('邮件发送失败，请稍后重试');
      expect(JSON.stringify(res)).not.toContain('smtp credential rejected');
      expect(prisma.enterpriseInvitation.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: { id: 'inv-new', tokenHash: sha256(res.token), emailStatus: 'SENDING' },
        data: expect.objectContaining({ emailStatus: 'FAILED', emailSentAt: null }),
      }));
    });

    it('同企业同邮箱 60 秒内拒绝再次创建', async () => {
      prisma.enterpriseInvitation.findFirst.mockResolvedValue({ emailLastAttemptAt: new Date() });
      await expect(svc.create('u1', { email: 'a@b.com', role: 'MEMBER' } as any))
        .rejects.toThrow(ConflictException);
      expect(prisma.enterpriseInvitation.create).not.toHaveBeenCalled();
    });
  });

  describe('resend', () => {
    it('轮换 token 并重置状态和有效期', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', enterpriseId: 'ent-acme', email: 'newhire@acme.local',
        status: 'EXPIRED', tokenHash: 'old-hash',
      });
      prisma.enterpriseInvitation.updateMany.mockResolvedValue({ count: 1 });
      const res: any = await svc.resend('u1', 'inv-1');
      const update = prisma.enterpriseInvitation.updateMany.mock.calls.find((call: any[]) => call[0].where.id === 'inv-1')[0];
      expect(update.where.tokenHash).toBe('old-hash');
      expect(update.data).toMatchObject({ status: 'PENDING', emailStatus: 'SENDING', tokenHash: sha256(res.token) });
      expect(update.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(res.invitationUrl).toContain(res.token);
      expect(prisma.enterpriseInvitation.updateMany).toHaveBeenCalledWith({
        where: { enterpriseId: 'ent-acme', email: 'newhire@acme.local', status: 'PENDING', id: { not: 'inv-1' } },
        data: { status: 'REVOKED' },
      });
    });

    it('已接受邀请不可重发', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', enterpriseId: 'ent-acme', email: 'member@acme.local',
        status: 'ACCEPTED', tokenHash: 'hash',
      });
      await expect(svc.resend('u1', 'inv-1')).rejects.toThrow(ConflictException);
    });

    it('发送结果只更新本次 token 的 SENDING 状态', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue({
        id: 'inv-1', enterpriseId: 'ent-acme', email: 'newhire@acme.local',
        status: 'PENDING', tokenHash: 'old-hash',
      });
      prisma.enterpriseInvitation.updateMany.mockResolvedValue({ count: 1 });
      const mail = { sendEnterpriseInvitation: jest.fn().mockResolvedValue('SENT') };
      svc = new InvitationService(prisma, ctxSvc, mail as any);
      await svc.resend('u1', 'inv-1');

      const resultWrite = prisma.enterpriseInvitation.updateMany.mock.calls.at(-1)?.[0];
      expect(resultWrite.where).toMatchObject({ tokenHash: expect.any(String), emailStatus: 'SENDING' });
      expect(resultWrite.where.tokenHash).not.toBe('old-hash');
    });

    it('跨企业重发返回 404，且不发信', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(usableInvitation({ enterpriseId: 'ent-other' }));
      const mail = { sendEnterpriseInvitation: jest.fn() };
      svc = new InvitationService(prisma, ctxSvc, mail as any);
      await expect(svc.resend('u1', 'inv-1')).rejects.toThrow(NotFoundException);
      expect(mail.sendEnterpriseInvitation).not.toHaveBeenCalled();
    });

    it('同邮箱冷却期内不可重发', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(usableInvitation());
      prisma.enterpriseInvitation.findFirst.mockResolvedValue({ emailLastAttemptAt: new Date() });
      await expect(svc.resend('u1', 'inv-1')).rejects.toThrow(ConflictException);
      expect(prisma.enterpriseInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('已通过其它邀请加入的成员不可重发历史邀请', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(usableInvitation({ status: 'REVOKED' }));
      prisma.enterpriseMember.findFirst.mockResolvedValue({ id: 'member-existing' });
      await expect(svc.resend('u1', 'inv-1')).rejects.toThrow('该邮箱已是本企业成员');
      expect(prisma.enterpriseInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('Serializable 事务冲突返回 409，且不发信', async () => {
      prisma.$transaction.mockRejectedValue({ code: 'P2034' });
      const mail = { sendEnterpriseInvitation: jest.fn() };
      svc = new InvitationService(prisma, ctxSvc, mail as any);
      await expect(svc.resend('u1', 'inv-1')).rejects.toThrow(ConflictException);
      expect(mail.sendEnterpriseInvitation).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('必须带 enterpriseId 过滤', async () => {
      await svc.list('u1');
      expect(
        prisma.enterpriseInvitation.findMany.mock.calls[0][0].where.enterpriseId,
      ).toBe('ent-acme');
    });

    it('顺带把过期的 PENDING 收敛为 EXPIRED', async () => {
      await svc.list('u1');
      const call = prisma.enterpriseInvitation.updateMany.mock.calls[0][0];
      expect(call.where.status).toBe('PENDING');
      expect(call.data).toEqual({ status: 'EXPIRED' });
    });

    it('列表不返回 tokenHash —— 摘要也不该出现在响应里', async () => {
      await svc.list('u1');
      const select = prisma.enterpriseInvitation.findMany.mock.calls[0][0].select;
      expect(select.tokenHash).toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('跨企业撤回 → 404，不泄漏该 id 是否存在', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        enterpriseId: 'ent-globex',
        status: 'PENDING',
      });
      await expect(svc.revoke('u1', 'inv-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('已接受的邀请不可撤回 → 409，引导走移出企业', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        enterpriseId: 'ent-acme',
        status: 'ACCEPTED',
      });
      await expect(svc.revoke('u1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('已失效的邀请无需撤回 → 409', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        enterpriseId: 'ent-acme',
        status: 'EXPIRED',
      });
      await expect(svc.revoke('u1', 'inv-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('PENDING 可撤回，状态转 REVOKED', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        enterpriseId: 'ent-acme',
        status: 'PENDING',
        tokenHash: 'current-hash',
      });
      prisma.enterpriseInvitation.updateMany.mockResolvedValue({ count: 1 });
      await svc.revoke('u1', 'inv-1');
      expect(prisma.enterpriseInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', tokenHash: 'current-hash', status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
    });

    it('撤回前 token 或状态已变化时不能覆盖新状态', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(usableInvitation());
      prisma.enterpriseInvitation.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.revoke('u1', 'inv-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('verifyToken', () => {
    it('按 token 的 SHA-256 摘要查库', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation(),
      );
      await svc.verifyToken('raw-token');
      expect(prisma.enterpriseInvitation.findUnique.mock.calls[0][0].where)
        .toEqual({ tokenHash: sha256('raw-token') });
    });

    it('token 不存在与已失效返回同一措辞，防枚举', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(null);
      const notFound = await svc.verifyToken('bogus').catch((e) => e);

      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation({ status: 'REVOKED' }),
      );
      const revoked = await svc.verifyToken('revoked').catch((e) => e);

      expect(notFound).toBeInstanceOf(BadRequestException);
      expect(revoked).toBeInstanceOf(BadRequestException);
      expect(notFound.message).toBe(revoked.message);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('已过期 → 报错并把状态收敛为 EXPIRED', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(svc.verifyToken('t')).rejects.toThrow(BadRequestException);
      expect(prisma.enterpriseInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', tokenHash: sha256('t'), status: 'PENDING', expiresAt: { lte: expect.any(Date) } },
        data: { status: 'EXPIRED' },
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      [null, 'REGISTER'],
      [{ id: 'user-existing', status: 'ACTIVE' }, 'LOGIN'],
      [{ id: 'user-disabled', status: 'DISABLED' }, 'CONTACT_SUPPORT'],
    ])('有效邀请按账号状态返回下一步 %s → %s', async (user, nextAction) => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(usableInvitation());
      prisma.user.findUnique.mockResolvedValue(user);
      const result = await svc.verifyToken('raw');
      expect(result).toEqual(expect.objectContaining({ nextAction }));
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'newhire@acme.local' },
        select: { status: true },
      });
      expect(result).not.toHaveProperty('user');
      expect(result).not.toHaveProperty('userId');
      expect(result).not.toHaveProperty('memberships');
    });

    it('有效时返回企业信息供注册页展示，且不含 tokenHash', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation(),
      );
      const res: any = await svc.verifyToken('t');
      expect(res.enterprise.name).toBe('示例科技');
      const select =
        prisma.enterpriseInvitation.findUnique.mock.calls[0][0].select;
      expect(select.tokenHash).toBeUndefined();
    });
  });

  describe('acceptByUser', () => {
    let tx: any;
    beforeEach(() => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation(),
      );
      prisma.user = {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u-orphan',
          status: 'ACTIVE',
          email: 'newhire@acme.local',
          memberships: [],
        }),
      };
      tx = {
          $queryRaw: jest.fn().mockResolvedValue([{ id: 'u-orphan', status: 'ACTIVE' }]),
          user: prisma.user,
          enterpriseMember: {
            create: jest.fn((a: any) =>
              Promise.resolve({ id: 'mem-new', ...a.data }),
            ),
          },
          enterpriseInvitation: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          enterprise: {
            findUniqueOrThrow: jest
              .fn()
              .mockResolvedValue({ id: 'ent-acme', name: '示例科技' }),
          },
        };
      prisma.$transaction = jest.fn((fn: any) => fn(tx));
    });

    it('无归属用户可接受邀请并落地为成员', async () => {
      const res: any = await svc.acceptByUser('u-orphan', 'raw');
      expect(res.member.id).toBe('mem-new');
      expect(res.enterprise.name).toBe('示例科技');
      expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FROM users WHERE id = ? FOR UPDATE');
      expect(tx.$queryRaw.mock.calls[0][1]).toBe('u-orphan');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.user.findUnique.mock.invocationCallOrder[0]);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
    });

    it('邀请初检通过后企业关闭，在同企业行锁下拒绝新增成员', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ id: 'u-orphan', status: 'ACTIVE' }]).mockResolvedValueOnce([{ status: 'CLOSED' }]);
      await expect(svc.acceptByUser('u-orphan', 'raw')).rejects.toThrow('企业已关闭');
      expect(tx.$queryRaw.mock.calls[1][0].join('?')).toContain('FROM enterprises WHERE id = ? FOR UPDATE');
      expect(tx.enterpriseMember.create).not.toHaveBeenCalled();
      expect(tx.enterpriseInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('加锁后重新读取归属，拒绝已被另一个邀请加入的账号', async () => {
      tx.user = { findUnique: jest.fn().mockResolvedValue({
        id: 'u-orphan', status: 'ACTIVE', email: 'newhire@acme.local',
        memberships: [{ enterpriseId: 'ent-other' }],
      }) };
      await expect(svc.acceptByUser('u-orphan', 'raw')).rejects.toThrow(/退出当前企业/);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(tx.enterpriseMember.create).not.toHaveBeenCalled();
      expect(tx.enterpriseInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('禁用账号不可接受邀请', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-orphan', status: 'DISABLED', email: 'newhire@acme.local', memberships: [] });
      await expect(svc.acceptByUser('u-orphan', 'raw')).rejects.toThrow(/联系平台/);
      expect(tx.enterpriseMember.create).not.toHaveBeenCalled();
    });

    it.each(['P2034', 'P2002'])('事务冲突 %s 映射为409', async (code) => {
      prisma.$transaction.mockRejectedValue({ code });
      await expect(svc.acceptByUser('u-orphan', 'raw')).rejects.toThrow(ConflictException);
    });

    it('最终消费必须匹配读取时的摘要和未过期条件', async () => {
      const claim = jest.fn().mockResolvedValue({ count: 0 });
      prisma.$transaction.mockImplementation((fn: any) => fn({
        $queryRaw: tx.$queryRaw,
        user: prisma.user,
        enterpriseMember: { create: jest.fn().mockResolvedValue({ id: 'member-new' }) },
        enterpriseInvitation: { updateMany: claim },
      }));
      await expect(svc.acceptByUser('u-orphan', 'raw')).rejects.toThrow(ConflictException);
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'inv-1', tokenHash: 'hash-x', status: 'PENDING', expiresAt: { gt: expect.any(Date) } },
      }));
    });

    it('❗邀请发给别人时拒绝 —— 防链接转发给已登录用户', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-other',
        status: 'ACTIVE',
        email: 'someone-else@acme.local',
        memberships: [],
      });
      await expect(svc.acceptByUser('u-other', 'raw')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('邮箱比对不区分大小写', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-orphan',
        status: 'ACTIVE',
        email: 'NewHire@ACME.local',
        memberships: [],
      });
      await expect(svc.acceptByUser('u-orphan', 'raw')).resolves.toBeDefined();
    });

    it('已是该企业成员 → 409', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        status: 'ACTIVE',
        email: 'newhire@acme.local',
        memberships: [{ enterpriseId: 'ent-acme' }],
      });
      await expect(svc.acceptByUser('u1', 'raw')).rejects.toThrow(
        ConflictException,
      );
    });

    it('已归属其他企业 → 409 并提示先退出，避免"看不见的归属"', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        status: 'ACTIVE',
        email: 'newhire@acme.local',
        memberships: [{ enterpriseId: 'ent-globex' }],
      });
      await expect(svc.acceptByUser('u1', 'raw')).rejects.toThrow(
        /退出当前企业/,
      );
    });

    it('❗并发下同一链接只能用一次：抢不到 PENDING 则回滚', async () => {
      prisma.$transaction = jest.fn((fn: any) =>
        fn({
          $queryRaw: tx.$queryRaw,
          user: prisma.user,
          enterpriseMember: { create: jest.fn().mockResolvedValue({ id: 'm' }) },
          enterpriseInvitation: {
            // 另一个并发请求已把状态改走
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          enterprise: { findUniqueOrThrow: jest.fn() },
        }),
      );
      await expect(svc.acceptByUser('u-orphan', 'raw')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findUsableByToken', () => {
    it('返回落地成员所需的完整字段', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation({ departmentId: 'dept-tech', position: '后端' }),
      );
      const inv = await svc.findUsableByToken('t');
      expect(inv.enterpriseId).toBe('ent-acme');
      expect(inv.departmentId).toBe('dept-tech');
      expect(inv.role).toBe('MEMBER');
    });

    it('非 PENDING 一律拒绝', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation({ status: 'ACCEPTED' }),
      );
      await expect(svc.findUsableByToken('t')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('已过期 → 拒绝并收敛状态', async () => {
      prisma.enterpriseInvitation.findUnique.mockResolvedValue(
        usableInvitation({ expiresAt: new Date(Date.now() - 1) }),
      );
      await expect(svc.findUsableByToken('t')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.enterpriseInvitation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tokenHash: sha256('t'), status: 'PENDING' }),
        data: { status: 'EXPIRED' },
      }));
    });
  });
});
