/**
 * 认证服务测试。
 *
 * 目前只覆盖 `createEnterprise`（无归属账号自行开公司），因为它是
 * 状态机里唯一能把 `[无归属]` 翻成 `[企业管理员]` 的边，出错的后果分两类：
 *   ① 事务不完整 → 企业建了但没 ComputeAccount，订阅时无处扣费；
 *      或没 Member，用户看着公司存在却永远进不去。
 *   ② 已有归属者放行 → MVP 前端按单企业渲染（取最早一条 membership），
 *      新建的那家会成为"看不见的归属"：数据建了，界面永远进不去。
 */
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

const USER = {
  id: 'user-solo',
  email: 'solo@example.com',
  name: '独立用户',
  role: 'USER',
  status: 'ACTIVE',
};

describe('AuthService.createEnterprise', () => {
  let prisma: any;
  let tx: any;
  let jwt: any;
  let config: any;
  let invitations: any;
  let defaultDepartments: any;
  let res: any;
  let svc: AuthService;
  let sessions: any;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(USER) },
      // 默认无归属 —— 这是本方法唯一允许的前置状态
      enterpriseMember: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    // 事务内的 client 用同一个 tx 对象，便于断言事务里究竟发生了什么
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: USER.id }]),
      user: { findUnique: jest.fn().mockResolvedValue({ ...USER, status: 'ACTIVE' }) },
      authCredential: { findUnique: jest.fn().mockResolvedValue({ passwordHash: '$2b$10$' + 'a'.repeat(53) }) },
      enterprise: {
        create: jest.fn((a: any) =>
          Promise.resolve({ id: 'ent-new', name: a.data.name }),
        ),
      },
      enterpriseMember: {
        create: jest.fn((a: any) => Promise.resolve({ id: 'mem-new', ...a.data })),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    prisma.$transaction = jest.fn((fn: any) => fn(tx));

    // 按 payload.type 区分两种 token，否则无法断言"cookie 里放的是 refresh"
    jwt = {
      sign: jest.fn((payload: any) =>
        payload.type === 'refresh' ? 'refresh-jwt' : 'access-jwt',
      ),
    };
    config = { get: jest.fn(), getOrThrow: jest.fn().mockReturnValue('explicit-test-jwt-secret') };
    invitations = { findUsableByToken: jest.fn() };
    defaultDepartments = {
      createDefaultDepartments: jest.fn().mockResolvedValue(undefined),
    };
    res = { cookie: jest.fn() };

    sessions = {
      createSession: jest.fn().mockResolvedValue({ sessionId: 'session-1', refreshToken: 'opaque-refresh' }),
      getRefreshTtlSeconds: jest.fn().mockReturnValue(7 * 24 * 60 * 60),
      listUserSessions: jest.fn().mockResolvedValue([]),
    };
    svc = new AuthService(prisma, jwt, config, invitations, defaultDepartments, sessions);
  });

  it('一个事务里建出企业 + 算力账户 + 管理员成员', async () => {
    const result = await svc.createEnterprise(USER.id, { name: '新公司' }, res);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FROM users WHERE id = ? FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(USER.id);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.user.findUnique.mock.invocationCallOrder[0]);
    expect(tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(tx.enterpriseMember.findFirst.mock.invocationCallOrder[0]);

    // ComputeAccount 必须与企业同事务创建：分开建则中途失败会留下
    // 一家无法扣费的企业，订阅流程在下单时才炸
    expect(tx.enterprise.create).toHaveBeenCalledWith({
      data: {
        name: '新公司',
        computeAccount: { create: { balance: 0 } },
      },
    });

    // 开公司的人就是首个企业管理员 —— 这个身份无法自行申请
    expect(tx.enterpriseMember.create).toHaveBeenCalledWith({
      data: {
        userId: USER.id,
        enterpriseId: 'ent-new',
        role: 'ENTERPRISE_ADMIN',
      },
    });

    // 事务内只重新读取并锁定 User，不会创建 User
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER.id },
      select: { id: true, status: true, email: true, name: true, avatar: true, role: true },
    });

    expect(result).toEqual({
      token: 'access-jwt',
      user: { id: USER.id, email: USER.email, name: USER.name, avatar: undefined, role: USER.role },
      enterprise: { id: 'ent-new', name: '新公司' },
      roleInEnterprise: 'ENTERPRISE_ADMIN',
    });
  });

  it('返回体带上新企业与角色 —— 前端靠它把 store 里的 enterprise 从 null 换掉', async () => {
    const result = await svc.createEnterprise(USER.id, { name: '新公司' }, res);

    // 少了任何一个，前端就停在 /no-enterprise 落地页出不去
    expect(result.enterprise).not.toBeNull();
    expect(result.roleInEnterprise).toBe('ENTERPRISE_ADMIN');
    expect(result.token).toBeTruthy();
  });

  it('顺带续一次 refresh cookie，且是 httpOnly', async () => {
    await svc.createEnterprise(USER.id, { name: '新公司' }, res);

    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe('refresh_token');
    expect(options.secure).toBe(false);
    // cookie 里放的必须是 refresh token，放 access 等于把 1h 的凭据当 7d 用
    expect(value).toBe('opaque-refresh');
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
  });

  it('已有归属者一律拒绝 —— 否则新公司会成为看不见的归属', async () => {
    prisma.enterpriseMember.findFirst.mockResolvedValue({ id: 'mem-existing' });

    await expect(
      svc.createEnterprise(USER.id, { name: '第二家公司' }, res),
    ).rejects.toThrow(ConflictException);

    // 拒绝要发生在事务之前：不能建完再回滚，也不能留下半个企业
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.enterprise.create).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('拒绝信息告诉用户下一步怎么走（先退出当前企业）', async () => {
    prisma.enterpriseMember.findFirst.mockResolvedValue({ id: 'mem-existing' });

    await expect(
      svc.createEnterprise(USER.id, { name: '第二家公司' }, res),
    ).rejects.toThrow('你已归属企业，如需开新公司请先在个人设置中退出当前企业');
  });

  it('等待用户行锁后重新出现归属时，不再创建企业', async () => {
    tx.enterpriseMember.findFirst.mockResolvedValue({ id: 'member-from-invitation' });

    await expect(svc.createEnterprise(USER.id, { name: '新公司' }, res)).rejects.toThrow(ConflictException);

    expect(tx.enterprise.create).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it.each([null, { ...USER, status: 'DISABLED' }])('加锁后账号失效时拒绝创建企业：%s', async (user) => {
    tx.user.findUnique.mockResolvedValue(user);

    await expect(svc.createEnterprise(USER.id, { name: '新公司' }, res)).rejects.toThrow(UnauthorizedException);
    expect(tx.enterprise.create).not.toHaveBeenCalled();
    expect(tx.enterpriseMember.create).not.toHaveBeenCalled();
  });

  it('事务冲突返回 409，不签发新会话', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P2034' });
    await expect(svc.createEnterprise(USER.id, { name: '新公司' }, res)).rejects.toThrow(ConflictException);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('token 有效但用户已被删除 → 401，不建出无主企业', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      svc.createEnterprise('user-deleted', { name: '幽灵公司' }, res),
    ).rejects.toThrow(UnauthorizedException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.enterprise.create).not.toHaveBeenCalled();
  });

  it('建完企业后铺默认部门树 —— 新企业的部门页不该是空的', async () => {
    await svc.createEnterprise(USER.id, { name: '新公司' }, res);

    expect(defaultDepartments.createDefaultDepartments).toHaveBeenCalledWith(
      'ent-new',
    );
  });

  it('默认部门建失败不连坐：企业照样建成，用户照样拿到 token', async () => {
    // 部门只是开箱即用的便利，缺了可以自己建；
    // 让它把整个开公司流程拖挂，等于用锦上添花换掉了地基
    defaultDepartments.createDefaultDepartments.mockRejectedValue(
      new Error('部门表写入失败'),
    );

    const result = await svc.createEnterprise(USER.id, { name: '新公司' }, res);

    expect(result.enterprise).toEqual({ id: 'ent-new', name: '新公司' });
    expect(result.roleInEnterprise).toBe('ENTERPRISE_ADMIN');
    expect(result.token).toBe('access-jwt');
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });

  it('默认部门在事务之外建 —— 不占着事务连接跑 16 条 insert', async () => {
    await svc.createEnterprise(USER.id, { name: '新公司' }, res);

    // tx 里只该有企业和成员两张表被写；部门若挤进事务，
    // 会把一个三写的短事务拉成 16 条 insert 的长事务
    expect(tx.department).toBeUndefined();
  });

  it('企业算力绑定和开户待办使用创建企业的同一个事务', async () => {
    const integration = { ensureBinding: jest.fn().mockResolvedValue(undefined) };
    const withIntegration = new AuthService(prisma, jwt, config, invitations, defaultDepartments, sessions,
      undefined, undefined, undefined, undefined, undefined, undefined, integration as any);
    await withIntegration.createEnterprise(USER.id, { name: '新公司' }, res);
    expect(integration.ensureBinding).toHaveBeenCalledWith('ent-new', tx, {
      companyName: '新公司', adminEmail: USER.email, adminUserId: USER.id, passwordHash: '$2b$10$' + 'a'.repeat(53),
    });
    expect(tx.authCredential.findUnique).toHaveBeenCalledWith({
      where: { userId_type: { userId: USER.id, type: 'LOCAL_PASSWORD' } }, select: { passwordHash: true },
    });
  });

  it('无本地密码时仍固定新企业开户身份，留待设置密码后恢复', async () => {
    const integration = { ensureBinding: jest.fn().mockResolvedValue(undefined) };
    tx.authCredential.findUnique.mockResolvedValue(null);
    const withIntegration = new AuthService(prisma, jwt, config, invitations, defaultDepartments, sessions,
      undefined, undefined, undefined, undefined, undefined, undefined, integration as any);
    await withIntegration.createEnterprise(USER.id, { name: '新公司' }, res);
    expect(integration.ensureBinding).toHaveBeenCalledWith('ent-new', tx, {
      companyName: '新公司', adminEmail: USER.email, adminUserId: USER.id, passwordHash: undefined,
    });
  });
});
