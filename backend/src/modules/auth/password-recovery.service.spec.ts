import { AuthService } from './auth.service';
import * as bcrypt from 'bcrypt';
import { RequestEmailChangeDtoSchema } from 'shared';

describe('AuthService password and email recovery', () => {
  function make() {
    const user = { id: 'u1', email: 'u@example.com', name: 'U', avatar: null, role: 'USER', status: 'ACTIVE' };
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'u1', status: 'ACTIVE' }]),
      user: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn().mockResolvedValue(user) },
      authCredential: {
        findUnique: jest.fn().mockResolvedValue({ passwordHash: '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((ops: any) => Array.isArray(ops) ? Promise.all(ops) : ops(prisma)),
    };
    const tokens = { issue: jest.fn().mockResolvedValue({ token: 'secret-token', expiresAt: new Date() }), consume: jest.fn() };
    const mail = { sendPasswordReset: jest.fn().mockResolvedValue(undefined), sendPasswordChanged: jest.fn().mockResolvedValue(undefined), sendEmailVerification: jest.fn().mockResolvedValue(undefined) };
    const sessions = { revokeAllUserSessions: jest.fn(), revokeAllUserSessionsExcept: jest.fn() };
    const config = { get: jest.fn().mockReturnValue('http://localhost:3000'), getOrThrow: jest.fn().mockReturnValue('secret') };
    const service = new AuthService(prisma, { sign: jest.fn() } as any, config as any, {} as any, {} as any, sessions as any, tokens as any, mail as any);
    return { service, prisma, tokens, mail, sessions, user };
  }

  it('忘记密码对外统一响应并给存在用户发邮件', async () => {
    const { service, tokens, mail } = make();
    const result = await service.requestPasswordReset({ email: 'u@example.com' });
    expect(result.message).toContain('如果该邮箱已注册');
    expect(tokens.issue).toHaveBeenCalledWith({ userId: 'u1', type: 'PASSWORD_RESET' });
    expect(mail.sendPasswordReset).toHaveBeenCalledWith(expect.objectContaining({ to: 'u@example.com' }));
  });

  it('密码重置后撤销全部会话并发送通知', async () => {
    const { service, tokens, mail, sessions } = make();
    tokens.consume.mockResolvedValue({ userId: 'u1', type: 'PASSWORD_RESET', metadata: null });
    await service.resetPassword({ token: 'secret-token', newPassword: 'NewPassword123' });
    expect(sessions.revokeAllUserSessions).toHaveBeenCalledWith('u1', 'password_reset');
    expect(mail.sendPasswordChanged).toHaveBeenCalledWith({ to: 'u@example.com' });
  });

  it('邮箱验证确认只写入当前用户', async () => {
    const { service, tokens, prisma } = make();
    tokens.consume.mockResolvedValue({ userId: 'u1', type: 'EMAIL_VERIFICATION', metadata: null });
    await service.confirmEmailVerification({ token: 'email-token' });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { emailVerifiedAt: expect.any(Date) } });
  });

  it('普通用户要求当前邮箱已验证后才允许变更邮箱', async () => {
    const { service, prisma } = make();
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ email: 'u@example.com', emailVerifiedAt: null, status: 'ACTIVE' });
    await expect(
      service.requestEmailChange('u1', { newEmail: 'new@example.com' }),
    ).rejects.toThrow('请先验证当前邮箱');
  });

  describe('修改登录邮箱', () => {
    const currentPassword = 'AdminPassword123';
    let passwordHash: string;

    beforeAll(async () => { passwordHash = await bcrypt.hash(currentPassword, 4); });

    function makeEmailChange(role: string, emailVerifiedAt: Date | null = null) {
      const setup = make();
      setup.prisma.user.findUnique.mockImplementation(({ where }: any) => Promise.resolve(
        where.id ? { ...setup.user, email: 'admin@sep.local', role, emailVerifiedAt } : null,
      ));
      setup.prisma.authCredential.findUnique.mockResolvedValue({ passwordHash });
      return setup;
    }

    it.each([null, new Date('2026-11-07')])('管理员使用当前密码即可申请更换邮箱，旧邮箱验证时间为 %s', async (emailVerifiedAt) => {
      const { service, tokens, mail, prisma } = makeEmailChange('ADMIN', emailVerifiedAt);
      await expect(service.requestEmailChange('u1', { newEmail: 'new@example.com', currentPassword }))
        .resolves.toEqual({ message: '确认邮件已发送到新邮箱' });
      expect(tokens.issue).toHaveBeenCalledWith({ userId: 'u1', type: 'EMAIL_CHANGE', metadata: { newEmail: 'new@example.com' } });
      expect(mail.sendEmailVerification).toHaveBeenCalledTimes(1);
      expect(mail.sendEmailVerification).toHaveBeenCalledWith({
        to: 'new@example.com', verificationUrl: 'http://localhost:3000/verify-email-change?token=secret-token',
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it.each([undefined, 'wrong-password'])('管理员未提供正确密码时拒绝申请：%s', async (password) => {
      const { service, tokens, mail } = makeEmailChange('ADMIN');
      await expect(service.requestEmailChange('u1', { newEmail: 'new@example.com', currentPassword: password }))
        .rejects.toThrow(password ? '当前密码不正确' : '请输入当前密码');
      expect(tokens.issue).not.toHaveBeenCalled();
      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('管理员没有本地密码凭据时拒绝申请', async () => {
      const { service, prisma, tokens, mail } = makeEmailChange('ADMIN');
      prisma.authCredential.findUnique.mockResolvedValue(null);
      await expect(service.requestEmailChange('u1', { newEmail: 'new@example.com', currentPassword })).rejects.toThrow('当前密码不正确');
      expect(tokens.issue).not.toHaveBeenCalled();
      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('普通未验证用户提供密码也不能绕过旧邮箱验证', async () => {
      const { service, tokens, mail } = makeEmailChange('USER');
      await expect(service.requestEmailChange('u1', { newEmail: 'new@example.com', currentPassword })).rejects.toThrow('请先验证当前邮箱');
      expect(tokens.issue).not.toHaveBeenCalled();
      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('普通已验证用户保持原有更换流程', async () => {
      const { service, tokens } = makeEmailChange('USER', new Date());
      await service.requestEmailChange('u1', { newEmail: 'new@example.com' });
      expect(tokens.issue).toHaveBeenCalledTimes(1);
    });

    it('已占用的新邮箱不能用于更换', async () => {
      const { service, prisma, tokens, mail } = makeEmailChange('ADMIN');
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'another-user' });
      await expect(service.requestEmailChange('u1', { newEmail: 'used@example.com', currentPassword })).rejects.toThrow('该邮箱已被使用');
      expect(tokens.issue).not.toHaveBeenCalled();
      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('停用管理员不能申请更换邮箱', async () => {
      const { service, prisma, tokens, mail } = makeEmailChange('ADMIN');
      prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: 'ADMIN', status: 'DISABLED' });
      await expect(service.requestEmailChange('u1', { newEmail: 'new@example.com', currentPassword })).rejects.toThrow('账号当前不可用');
      expect(tokens.issue).not.toHaveBeenCalled();
      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('只有确认新邮箱的令牌后才修改邮箱并标为已验证', async () => {
      const { service, tokens, prisma } = makeEmailChange('ADMIN');
      tokens.consume.mockResolvedValue({ userId: 'u1', type: 'EMAIL_CHANGE', metadata: { newEmail: 'new@example.com' } });
      await expect(service.confirmEmailChange({ token: 'secret-token' })).resolves.toEqual({ message: '邮箱修改成功', email: 'new@example.com' });
      expect(tokens.consume).toHaveBeenCalledWith('secret-token', 'EMAIL_CHANGE');
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { email: 'new@example.com', emailVerifiedAt: expect.any(Date) } });
    });

    it('共享 DTO 保留当前密码并归一化新邮箱', () => {
      expect(RequestEmailChangeDtoSchema.parse({ newEmail: ' NEW@EXAMPLE.COM ', currentPassword })).toEqual({ newEmail: 'new@example.com', currentPassword });
      expect(RequestEmailChangeDtoSchema.safeParse({ newEmail: 'new@example.com', currentPassword: '' }).success).toBe(false);
    });
  });

  it.each(['CLOSURE_PENDING', 'CLOSED', 'DISABLED'])('does not send password reset mail for %s accounts', async (status) => {
    const { service, prisma, tokens, mail, user } = make();
    prisma.user.findUnique.mockResolvedValue({ ...user, status });
    await expect(service.requestPasswordReset({ email: user.email })).resolves.toHaveProperty('message');
    expect(tokens.issue).not.toHaveBeenCalled();
    expect(mail.sendPasswordReset).not.toHaveBeenCalled();
  });

  it.each(['CLOSURE_PENDING', 'CLOSED', 'DISABLED'])('rejects password and OAuth login for %s accounts', async (status) => {
    const { service, prisma, user } = make();
    prisma.user.findUnique.mockResolvedValue({ ...user, status });
    await expect(service.login({ email: user.email, password: 'Password123' }, {} as any)).rejects.toThrow('账号当前不可登录');
    await expect(service.loginWithUser(user.id, {} as any)).rejects.toThrow('账号当前不可登录');
  });

  it.each(['PASSWORD_RESET', 'EMAIL_VERIFICATION', 'EMAIL_CHANGE'])('rejects old %s tokens when closure starts before the mutation', async (type) => {
    const { service, prisma, tokens, sessions } = make();
    tokens.consume.mockResolvedValue({ userId: 'u1', type, metadata: { newEmail: 'new@example.com' } });
    prisma.$queryRaw.mockResolvedValue([{ id: 'u1', status: 'CLOSURE_PENDING' }]);
    const action = type === 'PASSWORD_RESET'
      ? service.resetPassword({ token: 'old-token', newPassword: 'NewPassword123' })
      : type === 'EMAIL_VERIFICATION'
        ? service.confirmEmailVerification({ token: 'old-token' })
        : service.confirmEmailChange({ token: 'old-token' });
    await expect(action).rejects.toThrow('令牌无效或已过期');
    expect(prisma.authCredential.upsert).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
  });
});
