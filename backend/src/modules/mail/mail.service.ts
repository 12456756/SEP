import { BadRequestException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';
import { SettingService } from '../setting/setting.service';
import { SETTING_KEYS } from 'shared';

type MailMessage = { to: string; subject: string; text: string; html?: string };
function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

export interface MailDeliveryProvider {
  send(message: MailMessage): Promise<void>;
}
export type EnterpriseInvitationMailResult = 'SENT' | 'NOT_CONFIGURED';

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ['token', 'code']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch {
    return '[redacted-link]';
  }
}

function redactEmailCodes(value: string): string {
  return value.replace(/(验证码(?:是|为)?[：:]?\s*)\d{6}/g, '$1******');
}

@Injectable()
export class ConsoleMailProvider implements MailDeliveryProvider {
  private readonly logger = new Logger(ConsoleMailProvider.name);
  async send(message: MailMessage): Promise<void> {
    this.logger.log(`邮件已准备（开发模式）：to=${message.to}, subject=${message.subject}`);
    if (message.text) {
      this.logger.debug(
        redactEmailCodes(message.text.replace(/https?:\/\/\S+/g, redactUrl)),
      );
    }
  }
}

@Injectable()
export class SmtpMailProvider implements MailDeliveryProvider {
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  constructor(config: ConfigService) {
    const port = Number(config.get<string>('MAIL_PORT') ?? 587);
    const address = config.get<string>('MAIL_FROM') ?? 'no-reply@example.com';
    const fromName = config.get<string>('MAIL_FROM_NAME') ?? '元机AI';
    this.from = `${fromName} <${address}>`;
    this.transporter = nodemailer.createTransport({
      host: config.getOrThrow<string>('MAIL_HOST'),
      port,
      secure: config.get<string>('MAIL_SECURE') === 'true' || port === 465,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      auth: {
        user: config.getOrThrow<string>('MAIL_USER'),
        pass: config.getOrThrow<string>('MAIL_PASSWORD'),
      },
    });
  }
  async verifyConnection(): Promise<void> {
    await this.transporter.verify();
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private provider: MailDeliveryProvider;
  private providerFingerprint?: string;
  private readonly hasRuntimeSettings: boolean;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly settings?: SettingService,
  ) {
    this.hasRuntimeSettings = Boolean(settings);
    // Keep an environment-backed provider available immediately for tests and
    // for bootstrap paths; when SystemSetting is present send() refreshes it
    // from the current effective values and replaces it on configuration change.
    this.provider = this.createProviderFromValues({
      enabled: config.get<string>('MAIL_ENABLED') === 'true',
      host: config.get<string>('MAIL_HOST'),
      port: Number(config.get<string>('MAIL_PORT') ?? 587),
      secure: config.get<string>('MAIL_SECURE') === 'true' || Number(config.get<string>('MAIL_PORT') ?? 587) === 465,
      user: config.get<string>('MAIL_USER'),
      password: config.get<string>('MAIL_PASSWORD'),
      from: config.get<string>('MAIL_FROM') ?? 'no-reply@example.com',
      fromName: config.get<string>('MAIL_FROM_NAME') ?? '元机AI',
    });
  }

  private createProviderFromValues(values: {
    enabled: boolean;
    host?: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
    fromName: string;
  }): MailDeliveryProvider {
    if (!values.enabled) return new ConsoleMailProvider();
    if (!values.host || !values.user || !values.password) {
      this.logger.warn('邮件服务已启用但 SMTP 配置不完整，将使用控制台邮件提供器');
      return new ConsoleMailProvider();
    }
    return new SmtpMailProvider({
      get: (key: string) => ({
        MAIL_PORT: String(values.port),
        MAIL_SECURE: String(values.secure),
        MAIL_FROM: values.from,
        MAIL_FROM_NAME: values.fromName,
        MAIL_HOST: values.host,
        MAIL_USER: values.user,
        MAIL_PASSWORD: values.password,
      } as Record<string, string>)[key],
      getOrThrow: (key: string) => {
        const value = ({ MAIL_HOST: values.host, MAIL_USER: values.user, MAIL_PASSWORD: values.password } as Record<string, string | undefined>)[key];
        if (!value) throw new Error(`${key} 未配置`);
        return value;
      },
    } as ConfigService);
  }

  private async effective(key: keyof typeof SETTING_KEYS, envKey: string): Promise<string | undefined> {
    return this.settings
      ? this.settings.getEffectiveValue(SETTING_KEYS[key])
      : this.config.get<string>(envKey);
  }

  private async refreshProvider(): Promise<{ enabled: boolean; fromName: string }> {
    const [enabledRaw, host, portRaw, secureRaw, user, password, from, fromName] = await Promise.all([
      this.effective('MAIL_ENABLED', 'MAIL_ENABLED'),
      this.effective('MAIL_HOST', 'MAIL_HOST'),
      this.effective('MAIL_PORT', 'MAIL_PORT'),
      this.effective('MAIL_SECURE', 'MAIL_SECURE'),
      this.effective('MAIL_USER', 'MAIL_USER'),
      this.effective('MAIL_PASSWORD', 'MAIL_PASSWORD'),
      this.effective('MAIL_FROM', 'MAIL_FROM'),
      this.effective('MAIL_FROM_NAME', 'MAIL_FROM_NAME'),
    ]);
    const port = Number(portRaw ?? 587);
    const values = {
      enabled: enabledRaw === 'true',
      host,
      port: Number.isInteger(port) && port > 0 ? port : 587,
      secure: secureRaw === 'true' || port === 465,
      user,
      password,
      from: from ?? 'no-reply@example.com',
      fromName: fromName ?? '元机AI',
    };
    const fingerprint = JSON.stringify({
      ...values,
      password: password ? crypto.createHash('sha256').update(password).digest('hex') : '',
    });
    if (this.hasRuntimeSettings && fingerprint !== this.providerFingerprint) {
      this.provider = this.createProviderFromValues(values);
      this.providerFingerprint = fingerprint;
    }
    return { enabled: values.enabled, fromName: values.fromName };
  }

  async testConnection(): Promise<{ enabled: boolean; verified: boolean; message: string }> {
    const { enabled } = await this.refreshProvider();
    if (!enabled) return { enabled: false, verified: false, message: '邮件服务未启用' };
    const provider = this.provider;
    if (!(provider instanceof SmtpMailProvider)) return { enabled: true, verified: false, message: 'SMTP 配置不完整' };
    await provider.verifyConnection();
    return { enabled: true, verified: true, message: 'SMTP 连接正常' };
  }

  async sendTestDelivery(to: string): Promise<void> {
    if (!/^\S+@\S+\.\S+$/.test(to)) throw new BadRequestException('测试收件地址不是有效邮箱');
    const { enabled } = await this.refreshProvider();
    if (!enabled) throw new BadRequestException('邮件服务未启用');
    if (!(this.provider instanceof SmtpMailProvider)) throw new BadRequestException('SMTP 配置不完整');
    await this.send({
      to,
      subject: '邮件服务测试',
      text: '这是一封来自运营配置中心的测试邮件。',
    });
  }

  async send(input: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const { enabled, fromName } = await this.refreshProvider();
    if (!enabled && this.config.get<string>('NODE_ENV') === 'test') return;
    await this.provider.send({ ...input, subject: `[${fromName}] ${input.subject}` });
  }

  async sendPasswordReset(input: { to: string; resetUrl: string }): Promise<void> {
    return this.send({
      to: input.to,
      subject: '重置密码',
      text: `请在 20 分钟内打开以下链接重置密码：${input.resetUrl}\n如果不是你本人操作，请忽略本邮件。`,
    });
  }

  private async sendClosureMail(message: MailMessage): Promise<void> {
    const { enabled, fromName } = await this.refreshProvider();
    const provider = this.provider;
    if (!enabled || !(provider instanceof SmtpMailProvider)) {
      throw new ServiceUnavailableException('注销需要可用的 SMTP 邮件服务，请联系平台管理员');
    }
    try {
      await provider.send({ ...message, subject: `[${fromName}] ${message.subject}` });
    } catch {
      throw new ServiceUnavailableException('注销邮件发送失败，请稍后重试');
    }
  }

  async sendAccountClosureVerification(input: { to: string; verificationUrl: string; enterpriseNames?: string[] }): Promise<void> {
    const enterpriseNotice = input.enterpriseNames?.length
      ? `将同时关闭企业：${input.enterpriseNames.join('、')}。企业订阅和访问权限将终止，历史账务与工作记录保留。\n`
      : '';
    await this.sendClosureMail({
      to: input.to,
      subject: '确认注销账号',
      text: `你正在申请注销账号。${enterpriseNotice}请在 20 分钟内登录本人账号并打开以下链接，确认注销后果：${input.verificationUrl}\n打开链接不会直接注销。最终确认后立即生效，无法撤回或恢复。若非本人操作，请忽略本邮件。`,
    });
  }

  async sendEmailVerification(input: { to: string; verificationUrl: string }): Promise<void> {
    return this.send({
      to: input.to,
      subject: '验证邮箱地址',
      text: `请打开以下链接完成邮箱验证：${input.verificationUrl}`,
    });
  }

  async sendRegistrationEmailCode(input: { to: string; code: string }): Promise<void> {
    return this.send({
      to: input.to,
      subject: '邮箱注册验证码',
      text: `你的注册验证码是：${input.code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
    });
  }

  async sendPasswordChanged(input: { to: string }): Promise<void> {
    return this.send({
      to: input.to,
      subject: '密码已修改',
      text: '你的账号密码已修改。如果不是你本人操作，请立即联系平台管理员。',
    });
  }

  async sendEnterpriseInvitation(input: { to: string; invitationUrl: string; enterpriseName: string }): Promise<EnterpriseInvitationMailResult> {
    const { enabled, fromName } = await this.refreshProvider();
    const provider = this.provider;
    if (!enabled || !(provider instanceof SmtpMailProvider)) return 'NOT_CONFIGURED';
    await provider.send({
      to: input.to,
      subject: `[${fromName}] 加入${input.enterpriseName}`,
      text: `你收到加入「${input.enterpriseName}」的邀请，请打开以下链接：${input.invitationUrl}\n链接有效期：7 天。如非本人操作，请忽略本邮件。`,
      html: `<p>你收到加入「${escapeHtml(input.enterpriseName)}」的邀请。</p><p><a href="${escapeHtml(input.invitationUrl)}">点击加入</a></p><p>链接有效期：7 天。如非本人操作，请忽略本邮件。</p>`,
    });
    return 'SENT';
  }

  async sendNewDeviceLogin(input: { to: string; ipAddress?: string; userAgent?: string; clientType: string }): Promise<void> {
    const location = input.ipAddress ? `IP：${input.ipAddress}` : 'IP：未知';
    const client = input.clientType === 'DESKTOP' ? '桌面客户端' : '浏览器';
    return this.send({
      to: input.to,
      subject: '新设备登录提醒',
      text: `你的账号刚刚通过${client}登录。\n${location}\n设备信息：${input.userAgent ?? '未知'}\n如果不是你本人操作，请立即修改密码并退出全部设备。`,
    });
  }
}
