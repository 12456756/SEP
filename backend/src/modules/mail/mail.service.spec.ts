import * as nodemailer from 'nodemailer';
import { ConsoleMailProvider, MailService, SmtpMailProvider } from './mail.service';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

const createTransport = nodemailer.createTransport as jest.Mock;

describe('MailService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createTransport.mockReturnValue({ sendMail: jest.fn().mockResolvedValue(undefined) });
  });

  it('开发模式使用 Console provider，日志脱敏 token/code', async () => {
    const logger = { log: jest.fn(), debug: jest.fn() };
    const provider = new ConsoleMailProvider();
    (provider as any).logger = logger;

    await provider.send({
      to: 'user@example.com',
      subject: '验证',
      text: '请打开 https://example.com/verify?token=secret-token&code=secret-code',
    });

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('user@example.com'));
    expect(logger.debug).toHaveBeenCalledWith(
      expect.not.stringContaining('secret-token'),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.not.stringContaining('secret-code'),
    );

    await provider.send({
      to: 'user@example.com',
      subject: '验证码',
      text: '你的注册验证码是：123456，10 分钟内有效。',
    });
    expect(logger.debug).toHaveBeenLastCalledWith('你的注册验证码是：******，10 分钟内有效。');
  });

  it('MAIL_ENABLED=false 不创建 SMTP transporter', async () => {
    const config = {
      get: jest.fn((key: string) => ({
        MAIL_ENABLED: 'false',
        NODE_ENV: 'test',
        MAIL_FROM: 'noreply@example.com',
        MAIL_FROM_NAME: '元机AI',
      } as Record<string, string>)[key]),
      getOrThrow: jest.fn(),
    };
    const service = new MailService(config as any);

    await service.sendPasswordChanged({ to: 'user@example.com' });

    expect(createTransport).not.toHaveBeenCalled();
  });

  it('SMTP provider 使用配置的显示名称和发件地址', async () => {
    const transport = { sendMail: jest.fn().mockResolvedValue(undefined) };
    createTransport.mockReturnValue(transport);
    const config = {
      get: jest.fn((key: string) => ({
        MAIL_PORT: '587',
        MAIL_FROM: 'noreply@example.com',
        MAIL_FROM_NAME: '元机AI',
        MAIL_SECURE: 'false',
        MAIL_HOST: 'smtp.example.com',
        MAIL_USER: 'mailer',
        MAIL_PASSWORD: 'password',
      } as Record<string, string>)[key]),
      getOrThrow: jest.fn((key: string) => ({
        MAIL_HOST: 'smtp.example.com',
        MAIL_USER: 'mailer',
        MAIL_PASSWORD: 'password',
      } as Record<string, string>)[key]),
    };

    const provider = new SmtpMailProvider(config as any);
    await provider.send({
      to: 'user@example.com',
      subject: '主题',
      text: '正文',
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      auth: { user: 'mailer', pass: 'password' },
    });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: '元机AI <noreply@example.com>',
      to: 'user@example.com',
      subject: '主题',
      text: '正文',
      html: undefined,
    });
  });

  it('密码修改通知不包含密码或 token', async () => {
    const provider = { send: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn((key: string) => ({
        MAIL_ENABLED: 'true',
        MAIL_FROM: 'noreply@example.com',
        MAIL_FROM_NAME: '元机AI',
      } as Record<string, string>)[key]),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAIL_HOST') return 'smtp.example.com';
        if (key === 'MAIL_USER') return 'mailer';
        return 'password';
      }),
    };
    const service = new MailService(config as any);
    (service as any).provider = provider;

    await service.sendPasswordChanged({ to: 'user@example.com' });

    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.not.stringMatching(/password|token/i),
    }));
  });

  it('注册验证码邮件只发给目标邮箱并包含有效时长', async () => {
    const provider = { send: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn((key: string) => ({
        MAIL_ENABLED: 'true',
        MAIL_FROM: 'noreply@example.com',
        MAIL_FROM_NAME: '元机AI',
      } as Record<string, string>)[key]),
      getOrThrow: jest.fn((key: string) => key === 'MAIL_HOST' ? 'smtp.example.com' : 'secret'),
    };
    const service = new MailService(config as any);
    (service as any).provider = provider;

    await service.sendRegistrationEmailCode({ to: 'user@example.com', code: '012345' });

    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      subject: '[元机AI] 邮箱注册验证码',
      text: expect.stringContaining('012345'),
    }));
    expect(provider.send.mock.calls[0][0].text).toContain('10 分钟');
  });

  it('邀请邮件返回 SMTP 接收结果并转义 HTML 动态内容', async () => {
    const config = {
      get: jest.fn((key: string) => ({
        MAIL_ENABLED: 'true',
        MAIL_PORT: '587',
        MAIL_SECURE: 'false',
        MAIL_HOST: 'smtp.example.com',
        MAIL_USER: 'mailer',
        MAIL_PASSWORD: 'password',
        MAIL_FROM: 'noreply@example.com',
        MAIL_FROM_NAME: '元机AI',
      } as Record<string, string>)[key]),
      getOrThrow: jest.fn((key: string) => ({
        MAIL_HOST: 'smtp.example.com', MAIL_USER: 'mailer', MAIL_PASSWORD: 'password',
      } as Record<string, string>)[key]),
    };
    const transport = { sendMail: jest.fn().mockResolvedValue(undefined) };
    createTransport.mockReturnValue(transport);
    const service = new MailService(config as any);

    await expect(service.sendEnterpriseInvitation({
      to: 'user@example.com',
      enterpriseName: '<Acme & Co>',
      invitationUrl: 'https://example.com/join?token=abc&x=1',
    })).resolves.toBe('SENT');

    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      html: expect.stringContaining('&lt;Acme &amp; Co&gt;'),
    }));
    expect(transport.sendMail.mock.calls[0][0].html).toContain('&amp;x=1');
    expect(transport.sendMail.mock.calls[0][0].text).toContain('7 天');
  });

  it('邮件未启用时不把控制台邮件误报为已发送', async () => {
    const config = {
      get: jest.fn((key: string) => ({ MAIL_ENABLED: 'false', NODE_ENV: 'test' } as Record<string, string>)[key]),
      getOrThrow: jest.fn(),
    };
    const service = new MailService(config as any);
    await expect(service.sendEnterpriseInvitation({
      to: 'user@example.com', enterpriseName: 'Acme', invitationUrl: 'http://localhost:3000/join?token=abc',
    })).resolves.toBe('NOT_CONFIGURED');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('运行时 SMTP 密码轮换时重建 transporter，指纹不包含明文密码', async () => {
    const values: Record<string, string> = {
      MAIL_ENABLED: 'true', MAIL_PORT: '587', MAIL_SECURE: 'false',
      MAIL_HOST: 'smtp.example.com', MAIL_USER: 'mailer', MAIL_PASSWORD: 'old-secret',
      MAIL_FROM: 'noreply@example.com', MAIL_FROM_NAME: '元机AI',
    };
    const setting = { getEffectiveValue: jest.fn(async (key: string) => values[key]) };
    const config = {
      get: jest.fn((key: string) => ({ NODE_ENV: 'production' } as Record<string, string>)[key]),
      getOrThrow: jest.fn(),
    };
    const service = new MailService(config as any, setting as any);
    createTransport.mockImplementation(() => ({ sendMail: jest.fn().mockResolvedValue(undefined) }));

    await service.sendEnterpriseInvitation({
      to: 'user@example.com', enterpriseName: 'Acme', invitationUrl: 'https://example.com/join?token=abc',
    });
    const initialFingerprint = (service as any).providerFingerprint as string;
    expect(initialFingerprint).not.toContain('old-secret');
    expect(createTransport).toHaveBeenCalledTimes(1);

    values.MAIL_PASSWORD = 'new-secret';
    await service.sendEnterpriseInvitation({
      to: 'user@example.com', enterpriseName: 'Acme', invitationUrl: 'https://example.com/join?token=def',
    });

    expect(createTransport).toHaveBeenCalledTimes(2);
    expect((service as any).providerFingerprint).not.toContain('new-secret');
  });

  it('已启用但 SMTP 配置缺失时返回 NOT_CONFIGURED', async () => {
    const service = new MailService({ get: (key: string) => key === 'MAIL_ENABLED' ? 'true' : undefined } as any);
    await expect(service.sendEnterpriseInvitation({
      to: 'user@example.com', enterpriseName: 'Acme', invitationUrl: 'https://example.com/join?token=abc',
    })).resolves.toBe('NOT_CONFIGURED');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('注销邮件禁止控制台降级，不会把未配置 SMTP 当作发送成功', async () => {
    const service = new MailService({ get: () => undefined } as any);
    await expect(service.sendAccountClosureVerification({ to: 'user@example.com', verificationUrl: 'https://app.example.com/account-closure?token=secret' })).rejects.toMatchObject({ status: 503 });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('注销确认邮件告知联动关闭和不可撤回，发送异常返回脱敏 503', async () => {
    const values: Record<string, string> = { MAIL_ENABLED: 'true', MAIL_HOST: 'smtp.example.com', MAIL_USER: 'mailer', MAIL_PASSWORD: 'password', MAIL_FROM_NAME: '平台' };
    const transport = { sendMail: jest.fn().mockResolvedValue(undefined) };
    createTransport.mockReturnValue(transport);
    const service = new MailService({ get: (key: string) => values[key], getOrThrow: (key: string) => values[key] } as any);
    await service.sendAccountClosureVerification({ to: 'user@example.com', verificationUrl: 'https://app.example.com/account-closure?token=secret', enterpriseNames: ['Acme'] });
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'user@example.com', subject: '[平台] 确认注销账号', text: expect.stringContaining('20 分钟') }));
    expect(transport.sendMail.mock.calls[0][0].text).toContain('将同时关闭企业：Acme');
    expect(transport.sendMail.mock.calls[0][0].text).toContain('无法撤回或恢复');
    transport.sendMail.mockRejectedValue(new Error('smtp credential secret'));
    await expect(service.sendAccountClosureVerification({ to: 'user@example.com', verificationUrl: 'https://app.example.com/account-closure?token=secret' })).rejects.toMatchObject({ status: 503, message: '注销邮件发送失败，请稍后重试' });
  });
});
