import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import {
  RegisterDto,
  LoginDto,
  AuthResponse,
  RegisterByInvitationDto,
  CreateEnterpriseDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  ConfirmEmailVerificationDto,
  RequestEmailChangeDto,
  ConfirmEmailChangeDto,
  RequestRegistrationEmailCodeDto,
} from 'shared';
import { InvitationService } from '../enterprise/invitation.service';
import { DefaultDepartmentsService } from '../enterprise/default-departments.service';
import { SessionService } from './session.service';
import { OneTimeTokenService } from './one-time-token.service';
import { MailService } from '../mail/mail.service';
import { AuthEventService } from './auth-event.service';
import { AuthRiskService, LoginAuditContext } from './auth-risk.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { RegistrationEmailCodeService } from './registration-email-code.service';

const ACCESS_EXPIRES = '15m';
const DEFAULT_REFRESH_COOKIE = '__Host-sep_refresh';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private invitations: InvitationService,
    private defaultDepartments: DefaultDepartmentsService,
    private readonly sessions: SessionService,
    @Optional() private readonly oneTimeTokens?: OneTimeTokenService,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly events?: AuthEventService,
    @Optional() private readonly risk?: AuthRiskService,
    @Optional() private readonly rateLimit?: AuthRateLimitService,
    @Optional() private readonly registrationEmailCodes?: RegistrationEmailCodeService,
  ) {}

  // ──────────────── helpers ────────────────

  private get refreshCookieName(): string {
    const configured = this.config.get<string>('REFRESH_COOKIE_NAME');
    if (configured) return configured;
    return this.config.get('NODE_ENV') === 'production'
      ? DEFAULT_REFRESH_COOKIE
      : 'refresh_token';
  }

  private get jwtSecret(): string {
    return (
      this.config.get<string>('ACCESS_JWT_SECRET') ??
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  private get accessExpiresIn(): string {
    return this.config.get<string>('ACCESS_TOKEN_EXPIRES_IN') ?? ACCESS_EXPIRES;
  }

  private signAccess(
    user: { id: string; email: string; role: string },
    sessionId?: string,
  ): string {
    return this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        sid: sessionId,
        type: 'access',
      },
      { secret: this.jwtSecret, expiresIn: this.accessExpiresIn },
    );
  }

  private async issueWebSession(
    user: { id: string; email: string; role: string },
    res: Response,
    context: Pick<LoginAuditContext, 'ipAddress' | 'userAgent'> = {},
    notifyNewDevice = false,
    auditProvider = 'password',
  ): Promise<string> {
    const session = await this.sessions.createSession({
      userId: user.id,
      clientType: 'WEB',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      refreshTtlSeconds: this.sessions.getRefreshTtlSeconds('WEB'),
    });
    this.setRefreshCookie(res, session.refreshToken);
    if (notifyNewDevice && session.isNewDevice && this.mail) {
      void this.mail.sendNewDeviceLogin({
        to: user.email,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        clientType: 'WEB',
      }).catch((error) => this.logger.warn('新设备通知邮件发送失败', error instanceof Error ? error.message : String(error)));
      await this.events?.record({ userId: user.id, action: 'NEW_DEVICE_LOGIN', provider: auditProvider, sessionId: session.sessionId, ipAddress: context.ipAddress, userAgent: context.userAgent });
    }
    return this.signAccess(user, session.sessionId);
  }

  /**
   * 铺默认部门树。**吞掉异常**：部门缺了管理员自己能建，
   * 但企业已经建成、邮箱已被占用，此时上抛会让用户既登不进去也重注册不了。
   * 失败只记日志，注册照常返回。
   */
  private async seedDefaultDepartments(enterpriseId: string): Promise<void> {
    try {
      await this.defaultDepartments.createDefaultDepartments(enterpriseId);
    } catch (error) {
      this.logger.error(
        `企业 ${enterpriseId} 默认部门创建失败，企业已建成但部门页为空`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private setRefreshCookie(res: Response, token: string): void {
    const cookieName = this.refreshCookieName;
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: cookieName.startsWith('__Host-') || this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      maxAge: this.sessions
        ? this.sessions.getRefreshTtlSeconds('WEB') * 1000
        : 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  private requireRegistrationEmailCodes(): RegistrationEmailCodeService {
    if (!this.registrationEmailCodes) {
      throw new ServiceUnavailableException('注册邮箱验证码服务暂不可用');
    }
    return this.registrationEmailCodes;
  }

  // ──────────────── public methods ────────────────

  async requestRegistrationEmailCode(
    dto: RequestRegistrationEmailCodeDto,
    context: Pick<LoginAuditContext, 'ipAddress'> = {},
  ): Promise<{ message: string }> {
    const email = dto.email.trim().toLowerCase();
    const emailLimit = await this.rateLimit?.consume(
      'registration-email-code-email',
      email,
      { limit: 3, windowSeconds: 3600 },
    );
    const ipLimit = context.ipAddress
      ? await this.rateLimit?.consume(
        'registration-email-code-ip',
        context.ipAddress,
        { limit: 10, windowSeconds: 3600 },
      )
      : undefined;

    if (emailLimit && !emailLimit.allowed || ipLimit && !ipLimit.allowed) {
      throw new HttpException('验证码请求过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!existingUser) {
      await this.requireRegistrationEmailCodes().issue(email);
    }

    return { message: '如果该邮箱可用于注册，验证码将发送至该邮箱' };
  }

  /**
   * 企业自助注册：一次创建「公司 + 创建者」。
   *
   * 四件事必须**同时成功或同时失败**，故包在事务里：
   *   ① User             注册人本人
   *   ② Enterprise       他的公司
   *   ③ EnterpriseMember 把二者绑定，角色 = ENTERPRISE_ADMIN
   *   ④ ComputeAccount   挂在企业上，否则订阅后无处扣费
   *
   * 若不用事务：建了 User 但建企业失败，该用户会卡在"有账号无公司"的
   * 死状态 —— 能登录但什么都干不了，且重新注册会报"邮箱已被占用"。
   *
   * 注意：注册入口只用于「开公司」。第二个人起由管理员在企业管理台
   * 添加，若同事也走注册会创建出第二家公司。
   */
  async register(dto: RegisterDto, res: Response): Promise<AuthResponse> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existingUser) throw new ConflictException('邮箱已被注册');

    await this.requireRegistrationEmailCodes().consume(dto.email, dto.emailCode);

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const { user, enterprise, member } = await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: {
            email: dto.email,
            name: dto.name,
            emailVerifiedAt: new Date(),
            authCredentials: { create: { type: 'LOCAL_PASSWORD', passwordHash: hashedPassword } },
          },
        });

        const enterprise = await tx.enterprise.create({
          data: {
            name: dto.enterpriseName,
            // 算力账户与企业同生命周期，一并创建
            computeAccount: { create: { balance: 0 } },
          },
        });

        const member = await tx.enterpriseMember.create({
          data: {
            userId: user.id,
            enterpriseId: enterprise.id,
            // 创建者即首个企业管理员 —— 这个身份无法自行申请，
            // 只能来自"这家公司是我开的"
            role: 'ENTERPRISE_ADMIN',
          },
        });

        return { user, enterprise, member };
      },
    );

    // 默认部门树在事务外铺：它是开箱即用的便利，不是注册的必要条件。
    // 挤进事务会把一个三写的短事务拉成十几条 insert；失败若上抛，
    // 则用户卡在"邮箱已占用但公司没建成"的死状态。
    await this.seedDefaultDepartments(enterprise.id);

    const token = await this.issueWebSession(user, res);

    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role },
      enterprise: { id: enterprise.id, name: enterprise.name },
      roleInEnterprise: member.role,
    };
  }

  /**
   * 受邀注册：凭邀请链接加入**已存在**的企业，不创建新公司。
   *
   * 与 register 的分工：register 是「开公司」，本方法是「入职」。
   * 这是第二个人进入企业的第二条途径（第一条是管理员代建账号），
   * 区别在于密码由本人设置 —— 管理员不接触他人凭据。
   *
   * 校验 email 与邀请记录一致是安全要求，不是体验优化：
   * 否则链接被转发后，任何人都能用它加入企业。
   *
   * 三件事必须同时成功或同时失败，故包在事务里：
   *   ① User                     受邀人本人
   *   ② EnterpriseMember         按邀请里的角色/部门/岗位落地
   *   ③ 邀请标记 ACCEPTED         防止同一链接被重复使用
   *
   * 不建 ComputeAccount —— 它挂在企业上，加入者共用企业的账户。
   */
  async registerByInvitation(
    dto: RegisterByInvitationDto,
    res: Response,
  ): Promise<AuthResponse> {
    const invitation = await this.invitations.findUsableByToken(dto.token);

    const email = dto.email.toLowerCase().trim();
    if (invitation.email !== email) {
      // 措辞不暗示"正确的邮箱是什么"，避免把被邀请人邮箱泄露给持链接的第三方
      throw new UnauthorizedException('邮箱与邀请不匹配');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    // 已有账号的人不该走注册 —— 请其登录后在「加入企业」入口用同一链接
    if (existingUser) {
      throw new ConflictException('邮箱已被注册，请登录后再接受邀请');
    }

    await this.requireRegistrationEmailCodes().consume(email, dto.emailCode);

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const { user, enterprise, member } = await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            name: dto.name,
            emailVerifiedAt: new Date(),
            authCredentials: { create: { type: 'LOCAL_PASSWORD', passwordHash: hashedPassword } },
          },
        });

        const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${invitation.enterpriseId} FOR UPDATE`;
        if (enterprises[0]?.status !== 'ACTIVE') throw new ConflictException('企业已关闭，无法接受邀请');
        const member = await tx.enterpriseMember.create({
          data: {
            userId: user.id,
            enterpriseId: invitation.enterpriseId,
            role: invitation.role,
            departmentId: invitation.departmentId,
            position: invitation.position,
          },
        });

        // 条件更新 + count 校验：并发下两个请求同时走到这里，
        // 只有一个能把 PENDING 改掉，另一个 count=0 → 抛错回滚，
        // 避免同一链接建出两个成员
        const claimed = await tx.enterpriseInvitation.updateMany({
          where: {
            id: invitation.id,
            tokenHash: invitation.tokenHash,
            status: 'PENDING',
            expiresAt: { gt: new Date() },
          },
          data: { status: 'ACCEPTED', acceptedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new ConflictException('该邀请已被使用');
        }

        const enterprise = await tx.enterprise.findUniqueOrThrow({
          where: { id: invitation.enterpriseId },
          select: { id: true, name: true },
        });

        return { user, enterprise, member };
      },
    );

    const token = await this.issueWebSession(user, res);

    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role },
      enterprise: { id: enterprise.id, name: enterprise.name },
      roleInEnterprise: member.role,
    };
  }

  /**
   * 无企业归属的账号自行开公司。
   *
   * 对应状态机里 `[无归属] ── 开新公司 ──> [企业管理员]` 这条边：
   * 被前公司移除、或主动离职的人，不该为了开自己的公司而注册第二个邮箱。
   *
   * 与 register 的差别只在于 User 已存在，故建三样而非四样：
   *   ① Enterprise       他的新公司（含 ComputeAccount，否则订阅后无处扣费）
   *   ② EnterpriseMember 角色 = ENTERPRISE_ADMIN
   *   ③ —— 不建 User
   *
   * **已有归属者一律拒绝**：MVP 前端按单企业渲染（取最早一条 membership），
   * 允许一人多企业会让新建的那家成为"看不见的归属"——
   * 数据建了，界面永远进不去。要开新公司先退出当前企业。
   */
  async createEnterprise(
    userId: string,
    dto: CreateEnterpriseDto,
    res: Response,
  ): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, email: true, name: true, avatar: true, role: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可创建企业');

    const existing = await this.prisma.enterpriseMember.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        '你已归属企业，如需开新公司请先在个人设置中退出当前企业',
      );
    }

    const { enterprise, member } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const lockedUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, status: true, email: true, name: true, avatar: true, role: true },
      });
      if (!lockedUser) throw new UnauthorizedException('User not found');
      if (lockedUser.status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可创建企业');
      const lockedMembership = await tx.enterpriseMember.findFirst({ where: { userId }, select: { id: true } });
      if (lockedMembership) {
        throw new ConflictException('你已归属企业，如需开新公司请先在个人设置中退出当前企业');
      }
      const enterprise = await tx.enterprise.create({
        data: {
          name: dto.name,
          computeAccount: { create: { balance: 0 } },
        },
      });

      const member = await tx.enterpriseMember.create({
        data: {
          userId: user.id,
          enterpriseId: enterprise.id,
          role: 'ENTERPRISE_ADMIN',
        },
      });

      return { enterprise, member };
    }, { isolationLevel: 'ReadCommitted' }).catch((error: unknown) => {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2034') {
        throw new ConflictException('企业归属状态冲突，请刷新后重试');
      }
      throw error;
    });

    // 同 register：默认部门是便利，不该拖垮开公司流程。见 seedDefaultDepartments
    await this.seedDefaultDepartments(enterprise.id);

    // 重新签发：access token 本身不带企业信息，但前端要靠这个响应
    // 把 store 里的 enterprise 从 null 换成新公司，顺带续一次 refresh
    const token = await this.issueWebSession(user, res);

    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role },
      enterprise: { id: enterprise.id, name: enterprise.name },
      roleInEnterprise: member.role,
    };
  }

  async login(
    dto: LoginDto,
    res: Response,
    context: Pick<LoginAuditContext, 'ipAddress' | 'userAgent'> = {},
  ): Promise<AuthResponse> {
    const emailHash = createHash('sha256').update(dto.email.trim().toLowerCase()).digest('hex');
    const auditContext: LoginAuditContext = { provider: 'password', ...context, emailHash };
    const ipLimit = context.ipAddress ? await this.rateLimit?.isBlocked('login-ip', context.ipAddress, { limit: 30, windowSeconds: 300 }) : undefined;
    const accountLimit = await this.rateLimit?.isBlocked('login-account', emailHash, { limit: 12, windowSeconds: 900 });
    if (ipLimit && !ipLimit.allowed || accountLimit && !accountLimit.allowed) {
      await this.events?.record({ action: 'LOGIN_FAILED', success: false, provider: 'password', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { reason: 'rate_limited', emailHash } });
      throw new UnauthorizedException('邮箱或密码错误');
    }
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { authCredentials: { where: { type: 'LOCAL_PASSWORD' }, take: 1 } },
    });
    if (!user) {
      await this.rateLimit?.consume('login-account', emailHash, { limit: 12, windowSeconds: 900 });
      if (context.ipAddress) await this.rateLimit?.consume('login-ip', context.ipAddress, { limit: 30, windowSeconds: 300 });
      await this.risk?.recordAnonymousFailure(auditContext);
      throw new UnauthorizedException('邮箱或密码错误');
    }
    if (user.status !== 'ACTIVE') {
      await this.rateLimit?.consume('login-account', emailHash, { limit: 12, windowSeconds: 900 });
      if (context.ipAddress) await this.rateLimit?.consume('login-ip', context.ipAddress, { limit: 30, windowSeconds: 300 });
      await this.events?.record({ userId: user.id, action: 'LOGIN_FAILED', success: false, provider: 'password', metadata: { reason: 'account_disabled' } });
      throw new UnauthorizedException('账号当前不可登录');
    }
    const credential = user.authCredentials[0];
    const passwordHash = credential?.passwordHash ?? null;
    if (!passwordHash) {
      await this.events?.record({ userId: user.id, action: 'LOGIN_FAILED', success: false, provider: 'password', metadata: { reason: 'password_credential_missing' } });
      throw new UnauthorizedException('邮箱或密码错误');
    }
    await this.risk?.assertLoginAllowed(user.id, {
      passwordHash,
      failedCount: credential?.failedCount ?? 0,
      lockedUntil: credential?.lockedUntil ?? null,
    }, auditContext);
    const isPasswordValid = await bcrypt.compare(dto.password, passwordHash);
    if (!isPasswordValid) {
      await this.rateLimit?.consume('login-account', emailHash, { limit: 12, windowSeconds: 900 });
      if (context.ipAddress) await this.rateLimit?.consume('login-ip', context.ipAddress, { limit: 30, windowSeconds: 300 });
      await this.risk?.recordPasswordFailure(user.id, passwordHash, auditContext);
      throw new UnauthorizedException('邮箱或密码错误');
    }
    await this.sessions.assertUserEnterpriseActive(user.id, user.role);
    await this.risk?.recordPasswordSuccess(user.id);

    const token = await this.issueWebSession(user, res, context, true);

    const membership = await this.findMembership(user.id);

    await this.events?.record({ userId: user.id, action: 'LOGIN_SUCCESS', provider: 'password', ipAddress: context.ipAddress, userAgent: context.userAgent });
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role },
      ...membership,
    };
  }

  private requireOneTimeServices(): { tokens: OneTimeTokenService; mail: MailService } {
    if (!this.oneTimeTokens || !this.mail) {
      throw new InternalServerErrorException('认证邮件服务未配置');
    }
    return { tokens: this.oneTimeTokens, mail: this.mail };
  }

  private async passwordHashFor(userId: string): Promise<string> {
    const credential = await this.prisma.authCredential.findUnique({
      where: { userId_type: { userId, type: 'LOCAL_PASSWORD' } },
      select: { passwordHash: true },
    });
    return credential?.passwordHash ?? '';
  }

  async requestPasswordReset(dto: ForgotPasswordDto, context: Pick<LoginAuditContext, 'ipAddress'> = {}, options: { skipRateLimit?: boolean } = {}): Promise<{ message: string }> {
    const { tokens, mail } = this.requireOneTimeServices();
    const emailHash = createHash('sha256').update(dto.email.trim().toLowerCase()).digest('hex');
    const emailLimit = options.skipRateLimit ? undefined : await this.rateLimit?.consume('password-reset-email', emailHash, { limit: 3, windowSeconds: 3600 });
    const ipLimit = options.skipRateLimit || !context.ipAddress ? undefined : await this.rateLimit?.consume('password-reset-ip', context.ipAddress, { limit: 10, windowSeconds: 3600 });
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailLimit && !emailLimit.allowed || ipLimit && !ipLimit.allowed) {
      await this.events?.record({ userId: user?.id, action: 'PASSWORD_RESET_REQUESTED', success: false, provider: 'email', metadata: { reason: 'rate_limited', emailHash } });
      return { message: '如果该邮箱已注册，你会收到密码重置邮件' };
    }
    await this.events?.record({
      userId: user?.id,
      action: 'PASSWORD_RESET_REQUESTED',
      provider: 'email',
      metadata: { emailHash },
    });
    if (user?.status === 'ACTIVE') {
      const issued = await tokens.issue({ userId: user.id, type: 'PASSWORD_RESET' });
      await mail.sendPasswordReset({
        to: user.email,
        resetUrl: `${this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3000'}/reset-password?token=${encodeURIComponent(issued.token)}`,
      });
    }
    return { message: '如果该邮箱已注册，你会收到密码重置邮件' };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const { tokens, mail } = this.requireOneTimeServices();
    const consumed = await tokens.consume(dto.token, 'PASSWORD_RESET');
    const user = await this.prisma.user.findUnique({ where: { id: consumed.userId } });
    if (!user || user.status !== 'ACTIVE') throw new BadRequestException('令牌无效或已过期');
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${user.id} FOR UPDATE`;
      if (!rows[0] || rows[0].status !== 'ACTIVE') throw new BadRequestException('令牌无效或已过期');
      await tx.authCredential.upsert({
        where: { userId_type: { userId: user.id, type: 'LOCAL_PASSWORD' } },
        create: { userId: user.id, type: 'LOCAL_PASSWORD', passwordHash, lastUsedAt: new Date() },
        update: { passwordHash, failedCount: 0, lockedUntil: null, lastUsedAt: new Date() },
      });
    });
    await this.sessions.revokeAllUserSessions(user.id, 'password_reset');
    await mail.sendPasswordChanged({ to: user.email });
    await this.events?.record({ userId: user.id, action: 'PASSWORD_RESET_COMPLETED' });
    return { message: '密码已重置，请使用新密码登录' };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, currentSessionId?: string): Promise<void> {
    const { mail } = this.requireOneTimeServices();
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可用');
    const currentHash = await this.passwordHashFor(userId);
    if (!currentHash || !(await bcrypt.compare(dto.currentPassword, currentHash))) {
      throw new UnauthorizedException('当前密码不正确');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0] || rows[0].status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可用');
      await tx.authCredential.upsert({
        where: { userId_type: { userId, type: 'LOCAL_PASSWORD' } },
        create: { userId, type: 'LOCAL_PASSWORD', passwordHash, lastUsedAt: new Date() },
        update: { passwordHash, failedCount: 0, lockedUntil: null, lastUsedAt: new Date() },
      });
    });
    await this.sessions.revokeAllUserSessionsExcept(userId, currentSessionId, 'password_changed');
    await mail.sendPasswordChanged({ to: user.email });
    await this.events?.record({ userId, action: 'PASSWORD_CHANGED', sessionId: currentSessionId });
  }

  async requestEmailVerification(userId: string, force = false, context: Pick<LoginAuditContext, 'ipAddress'> = {}): Promise<{ message: string }> {
    const { tokens, mail } = this.requireOneTimeServices();
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可用');
    if (force && user.emailVerifiedAt) {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!rows[0] || rows[0].status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可用');
        await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: null } });
      });
    }
    const emailLimit = force ? undefined : await this.rateLimit?.consume('email-verification-user', userId, { limit: 3, windowSeconds: 3600 });
    const ipLimit = force || !context.ipAddress ? undefined : await this.rateLimit?.consume('email-verification-ip', context.ipAddress, { limit: 10, windowSeconds: 3600 });
    if ((emailLimit && !emailLimit.allowed || ipLimit && !ipLimit.allowed) && !force) {
      await this.events?.record({ userId, action: 'EMAIL_VERIFICATION_REQUESTED', success: false, metadata: { reason: 'rate_limited' } });
      return { message: '如果需要验证，你会收到验证邮件' };
    }
    if (force || !user.emailVerifiedAt) {
      const issued = await tokens.issue({ userId, type: 'EMAIL_VERIFICATION' });
      await mail.sendEmailVerification({
        to: user.email,
        verificationUrl: `${this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3000'}/verify-email?token=${encodeURIComponent(issued.token)}`,
      });
    }
    await this.events?.record({ userId, action: 'EMAIL_VERIFICATION_REQUESTED' });
    return { message: '如果需要验证，你会收到验证邮件' };
  }

  async confirmEmailVerification(dto: ConfirmEmailVerificationDto): Promise<{ message: string }> {
    const { tokens } = this.requireOneTimeServices();
    const consumed = await tokens.consume(dto.token, 'EMAIL_VERIFICATION');
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${consumed.userId} FOR UPDATE`;
      if (!rows[0] || rows[0].status !== 'ACTIVE') throw new BadRequestException('令牌无效或已过期');
      await tx.user.update({ where: { id: consumed.userId }, data: { emailVerifiedAt: new Date() } });
    });
    await this.events?.record({ userId: consumed.userId, action: 'EMAIL_VERIFIED' });
    return { message: '邮箱验证成功' };
  }

  async requestEmailChange(userId: string, dto: RequestEmailChangeDto): Promise<{ message: string }> {
    const { tokens, mail } = this.requireOneTimeServices();
    const existing = await this.prisma.user.findUnique({ where: { email: dto.newEmail }, select: { id: true } });
    if (existing) throw new ConflictException('该邮箱已被使用');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, status: true, role: true },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可用');
    if (user.role === 'ADMIN') {
      if (!dto.currentPassword) throw new BadRequestException('请输入当前密码');
      const currentHash = await this.passwordHashFor(userId);
      if (!currentHash || !(await bcrypt.compare(dto.currentPassword, currentHash))) {
        throw new UnauthorizedException('当前密码不正确');
      }
    } else if (!user.emailVerifiedAt) {
      throw new BadRequestException('请先验证当前邮箱');
    }
    const issued = await tokens.issue({ userId, type: 'EMAIL_CHANGE', metadata: { newEmail: dto.newEmail } });
    await mail.sendEmailVerification({
      to: dto.newEmail,
      verificationUrl: `${this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3000'}/verify-email-change?token=${encodeURIComponent(issued.token)}`,
    });
    return { message: '确认邮件已发送到新邮箱' };
  }

  async confirmEmailChange(dto: ConfirmEmailChangeDto): Promise<{ message: string; email: string }> {
    const { tokens } = this.requireOneTimeServices();
    const consumed = await tokens.consume(dto.token, 'EMAIL_CHANGE');
    const newEmail = typeof consumed.metadata?.newEmail === 'string' ? consumed.metadata.newEmail : '';
    if (!newEmail) throw new BadRequestException('令牌无效或已过期');
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${consumed.userId} FOR UPDATE`;
        if (!rows[0] || rows[0].status !== 'ACTIVE') throw new BadRequestException('令牌无效或已过期');
        await tx.user.update({ where: { id: consumed.userId }, data: { email: newEmail, emailVerifiedAt: new Date() } });
      });
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictException('该邮箱已被使用');
      throw error;
    }
    await this.events?.record({ userId: consumed.userId, action: 'EMAIL_CHANGED' });
    return { message: '邮箱修改成功', email: newEmail };
  }

  /**
   * 查询用户的企业归属，供登录/刷新返回给前端。
   *
   * 平台运营人员不属于任何企业，返回 null 而非抛错 ——
   * 他们要能登录去运营端，只是访问企业资源时会被 403。
   *
   * MVP 单企业：取最早一条 membership（与 EnterpriseContextService 一致）。
   */
  private async findMembership(userId: string): Promise<{
    enterprise: { id: string; name: string } | null;
    roleInEnterprise: string | null;
  }> {
    const member = await this.prisma.enterpriseMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        enterprise: { select: { id: true, name: true } },
      },
    });

    if (!member) return { enterprise: null, roleInEnterprise: null };
    return { enterprise: member.enterprise, roleInEnterprise: member.role };
  }

  /** OAuth 登录/回调完成后复用统一 Web Session 和 AuthResponse。 */
  async loginWithUser(userId: string, res: Response, context: Pick<LoginAuditContext, 'ipAddress' | 'userAgent'> = {}): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可登录');
    await this.sessions.assertUserEnterpriseActive(user.id, user.role);
    const token = await this.issueWebSession(user, res, context, true, 'oauth');
    const membership = await this.findMembership(user.id);
    await this.events?.record({ userId: user.id, action: 'LOGIN_SUCCESS', provider: 'oauth', ipAddress: context.ipAddress, userAgent: context.userAgent });
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role },
      ...membership,
    };
  }

  /**
   * 刷新 access token。前端在页面重载后调它重建内存态，
   * 因此**必须一并返回企业信息** —— 否则刷新页面后侧边栏会失去角色，
   * 菜单项渲染不出来。
   */
  async refresh(
    refreshToken: string | undefined,
    res?: Response,
  ): Promise<Omit<AuthResponse, 'token'> & { token: string }> {
    const rotated = await this.sessions.rotateRefreshToken(refreshToken, 'WEB');
    const user = await this.prisma.user.findUnique({ where: { id: rotated.userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可登录');
    await this.sessions.assertUserEnterpriseActive(user.id, user.role);

    if (res) this.setRefreshCookie(res, rotated.refreshToken);
    const token = this.signAccess(user, rotated.sessionId);
    const membership = await this.findMembership(user.id);

    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role },
      ...membership,
    };
  }

  /** 当前登录用户信息（含企业归属，前端侧边栏与管理台都要用）。 */
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true, name: true, avatar: true, role: true, createdAt: true, updatedAt: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    const membership = await this.findMembership(userId);
    return { ...user, ...membership };
  }

  async logout(refreshToken: string | undefined, res: Response): Promise<void> {
    const revoked = await this.sessions.revokeRefreshToken(refreshToken, 'logout');
    if (revoked) await this.events?.record({ userId: revoked.userId, action: 'LOGOUT', sessionId: revoked.sessionId });
    res.clearCookie(this.refreshCookieName, { path: '/' });
  }

  async logoutAll(userId: string, res: Response): Promise<void> {
    await this.sessions.revokeAllUserSessions(userId, 'logout_all');
    await this.events?.record({ userId, action: 'LOGOUT_ALL' });
    res.clearCookie(this.refreshCookieName, { path: '/' });
  }

  async listSessions(userId: string, currentSessionId?: string) {
    return this.sessions.listUserSessions(userId, currentSessionId);
  }

  async listAuthEvents(userId: string) {
    return this.events?.listForUser(userId) ?? [];
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const sessions = await this.sessions.listUserSessions(userId);
    if (!sessions.some((session) => session.id === sessionId)) {
      throw new UnauthorizedException('Session not found');
    }
    await this.sessions.revokeSession(sessionId, 'user_revoke');
    await this.events?.record({ userId, action: 'SESSION_REVOKED', sessionId });
  }

  async validateUser(userId: string, sessionId?: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE' },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!user) return null;
    if (!sessionId) throw new UnauthorizedException('Invalid or expired authentication session');
    await this.sessions.assertActiveAccessSession(sessionId, userId);
    return user;
  }
}
