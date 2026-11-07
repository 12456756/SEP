import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { OAuthStateService, ConsumedOAuthTransaction } from './oauth-state.service';
import { NormalizedOAuthProfile, OAuthIntent, OAuthProviderAdapter, OAuthProviderId, OAuthProviderType } from './oauth.types';
import { WechatOAuthProvider } from './providers/wechat.provider';
import { QqOAuthProvider } from './providers/qq.provider';
import { DingtalkOAuthProvider } from './providers/dingtalk.provider';
import { InvitationService } from '../enterprise/invitation.service';
import { AuthEventService } from './auth-event.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { SettingService } from '../setting/setting.service';
import { SETTING_KEYS, type SettingKey } from 'shared';

@Injectable()
export class OAuthService {
  private readonly providers: Map<string, OAuthProviderAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly state: OAuthStateService,
    private readonly auth: AuthService,
    private readonly invitations: InvitationService,
    wechat: WechatOAuthProvider,
    qq: QqOAuthProvider,
    @Optional() private readonly events?: AuthEventService,
    @Optional() private readonly rateLimit?: AuthRateLimitService,
    @Optional() private readonly settings?: SettingService,
    @Optional() dingtalk?: DingtalkOAuthProvider,
  ) {
    this.providers = new Map<string, OAuthProviderAdapter>();
    this.providers.set(wechat.id, wechat);
    this.providers.set(qq.id, qq);
    if (dingtalk) this.providers.set(dingtalk.id, dingtalk);
  }

  private async provider(id: string): Promise<OAuthProviderAdapter> {
    const provider = this.providers.get(id);
    if (!provider) throw new NotFoundException('不支持的登录方式');
    if (!await provider.isConfigured()) throw new BadRequestException(`${provider.displayName} 登录暂未配置`);
    return provider;
  }

  private async redirectUri(provider: string): Promise<string> {
    const settingKeys: Record<string, SettingKey | undefined> = {
      wechat: SETTING_KEYS.WECHAT_REDIRECT_URI,
      qq: SETTING_KEYS.QQ_REDIRECT_URI,
      dingtalk: SETTING_KEYS.DINGTALK_REDIRECT_URI,
    };
    const key = settingKeys[provider];
    const configured = key && this.settings
      ? await this.settings.getEffectiveValue(key)
      : this.config.get<string>(`${provider.toUpperCase()}_REDIRECT_URI`);
    if (!configured) throw new BadRequestException('第三方登录回调地址未配置');
    return configured;
  }

  private webBaseUrl(): string {
    return (this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  async start(input: { provider: string; intent?: OAuthIntent; userId?: string; metadata?: Record<string, unknown> }) {
    const adapter = await this.provider(input.provider);
    if (input.intent === 'LINK' && !input.userId) {
      throw new UnauthorizedException('绑定第三方账号需要先登录');
    }
    const redirectUri = await this.redirectUri(input.provider);
    const transaction = await this.state.create({
      provider: input.provider,
      intent: input.intent ?? 'LOGIN',
      redirectUri,
      userId: input.userId,
      metadata: input.metadata,
    });
    const authorizationUrl = await adapter.buildAuthorizationUrl({
      state: transaction.state,
      nonce: transaction.nonce,
      redirectUri,
    });
    return { provider: input.provider, authorizationUrl, expiresAt: transaction.expiresAt };
  }

  /**
   * 返回前端可展示的第三方渠道。只暴露启用且配置完整的渠道，
   * 不返回任何 Client Secret / App Secret。
   */
  async listPublicProviders(): Promise<Array<{ id: string; displayName: string; type: OAuthProviderType; }>> {
    const providers = await Promise.all(
      [...this.providers.values()].map(async (provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        type: provider.type,
        configured: await provider.isConfigured(),
      })),
    );
    return providers
      .filter((provider) => provider.configured)
      .map(({ id, displayName, type }) => ({ id, displayName, type }));
  }

  async startRegistration(provider: string) {
    return this.start({ provider, intent: 'REGISTER' });
  }

  /**
   * 从受邀链接启动第三方登录。邀请 token 只用于本次服务端校验，
   * OAuth state 事务保存 invitationId 与 token 摘要，不把明文 token 带入数据库。
   */
  async startInvitation(provider: string, token: string) {
    const invitation = await this.invitations.findUsableByToken(token);
    return this.start({
      provider,
      intent: 'INVITATION',
      metadata: { invitationId: invitation.id, invitationTokenHash: invitation.tokenHash },
    });
  }

  async callback(input: { provider: string; code?: string; state?: string; error?: string; ipAddress?: string; userAgent?: string }, res: Response): Promise<void> {
    let transaction: ConsumedOAuthTransaction | undefined;
    let adapter: OAuthProviderAdapter | undefined;
    let redirectUri: string | undefined;
    const frontend = new URL('/oauth/callback', this.webBaseUrl());
    frontend.searchParams.set('provider', input.provider);

    try {
      const rateLimit = input.ipAddress ? await this.rateLimit?.consume('oauth-callback-ip', input.ipAddress, { limit: 30, windowSeconds: 300 }) : undefined;
      if (rateLimit && !rateLimit.allowed) throw new BadRequestException('第三方登录请求过于频繁，请稍后重试');
      adapter = await this.provider(input.provider);
      redirectUri = await this.redirectUri(input.provider);
      // 即使用户在第三方页面点击取消，只要带回 state 也必须消费事务，
      // 防止同一授权事务稍后被重复提交。
      transaction = await this.state.consume({ provider: input.provider, state: input.state ?? '', redirectUri });
      if (transaction.intent !== 'LOGIN') frontend.searchParams.set('intent', transaction.intent);
      if (input.error || !input.code) {
        await this.events?.record({
          userId: transaction.userId ?? undefined,
          action: 'OAUTH_CALLBACK_FAILED',
          success: false,
          provider: input.provider,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          metadata: { reason: input.error ? 'oauth_cancelled' : 'missing_code' },
        });
        frontend.searchParams.set('status', 'cancelled');
        res.redirect(frontend.toString());
        return;
      }
      const tokens = await adapter!.exchangeCode({ code: input.code, redirectUri: redirectUri! });
      const profile = await adapter!.fetchUserProfile(tokens);
      const userId = transaction.intent === 'INVITATION'
        ? await this.resolveInvitationIdentity(transaction, profile)
        : await this.resolveIdentity(transaction, profile);
      if (transaction.intent === 'LINK') {
        await this.events?.record({ userId, action: 'IDENTITY_LINKED', provider: profile.provider });
      }
      await this.auth.loginWithUser(userId, res, { ipAddress: input.ipAddress, userAgent: input.userAgent });
      frontend.searchParams.set('status', 'success');
    } catch (error) {
      const errorResponse = error instanceof UnauthorizedException ? error.getResponse() : undefined;
      const enterpriseSuspended = errorResponse && typeof errorResponse === 'object' &&
        'code' in errorResponse && errorResponse.code === 'ENTERPRISE_SUSPENDED';
      await this.events?.record({
        userId: transaction?.userId ?? undefined,
        action: 'OAUTH_CALLBACK_FAILED',
        success: false,
        provider: input.provider,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: {
          reason: enterpriseSuspended
            ? 'enterprise_suspended'
            : error instanceof ConflictException
            ? transaction?.intent === 'REGISTER' ? 'account_exists' : 'account_conflict'
            : error instanceof UnauthorizedException
              ? transaction?.intent === 'INVITATION' ? 'invitation_email_mismatch' : 'oauth_not_registered'
              : error instanceof BadRequestException
                ? 'invalid_callback'
                : 'provider_error',
        },
      });
      frontend.searchParams.set('status', 'error');
      if (enterpriseSuspended) {
        frontend.searchParams.set('reason', 'enterprise_suspended');
      } else if (error instanceof ConflictException) {
        frontend.searchParams.set('reason', transaction?.intent === 'REGISTER' ? 'account_exists' : 'account_conflict');
      } else if (error instanceof UnauthorizedException) {
        frontend.searchParams.set('reason', transaction?.intent === 'INVITATION' ? 'invitation_email_mismatch' : 'oauth_not_registered');
      } else if (error instanceof BadRequestException) {
        frontend.searchParams.set('reason', 'invitation_invalid');
      }
    }
    res.redirect(frontend.toString());
  }

  /**
   * 受邀 OAuth 闭环：邀请记录和第三方身份必须在同一事务内落地。
   *
   * 微信/QQ 可能不返回可靠邮箱，因此新账号使用邀请记录中的邮箱；
   * 如果 Provider 返回邮箱，则必须与邀请邮箱一致。已有本地账号不做
   * 静默合并，要求先登录后接受邀请，避免账号接管。
   */
  private async resolveInvitationIdentity(
    transaction: ConsumedOAuthTransaction,
    profile: NormalizedOAuthProfile,
  ): Promise<string> {
    const metadata = transaction.metadata;
    const invitationId = metadata && typeof metadata === 'object' && 'invitationId' in metadata
      ? String((metadata as { invitationId?: unknown }).invitationId ?? '')
      : '';
    const invitationTokenHash = metadata && typeof metadata === 'object' && 'invitationTokenHash' in metadata
      ? String((metadata as { invitationTokenHash?: unknown }).invitationTokenHash ?? '')
      : '';
    if (!invitationId || !invitationTokenHash) throw new BadRequestException('邀请 OAuth 事务无效');
    if (profile.provider !== transaction.provider) throw new BadRequestException('第三方身份不匹配');

    const now = new Date();
    const normalizeEmail = (value: string) => value.toLowerCase().trim();
    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.enterpriseInvitation.findUnique({
        where: { id: invitationId },
        select: {
          id: true, email: true, enterpriseId: true, role: true,
          departmentId: true, position: true, status: true, expiresAt: true, tokenHash: true,
        },
      });
      if (!invitation || invitation.tokenHash !== invitationTokenHash || invitation.status !== 'PENDING' || invitation.expiresAt <= now) {
        throw new BadRequestException('邀请链接无效或已失效');
      }
      const expectedEmail = normalizeEmail(invitation.email);
      if (profile.email && normalizeEmail(profile.email) !== expectedEmail) {
        throw new UnauthorizedException('第三方账号邮箱与邀请不匹配');
      }

      const existingIdentity = await tx.authIdentity.findUnique({
        where: { provider_providerAccountId: { provider: profile.provider, providerAccountId: profile.providerAccountId } },
        select: { id: true, userId: true },
      });
      let userId: string;
      if (existingIdentity) {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${existingIdentity.userId} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: existingIdentity.userId },
          select: { id: true, status: true, email: true },
        });
        if (!user || normalizeEmail(user.email) !== expectedEmail) {
          throw new ConflictException('该第三方账号与邀请邮箱不匹配，请使用邀请邮箱对应的账号');
        }
        if (user.status !== 'ACTIVE') {
          throw new ConflictException('账号当前不可加入企业，请联系平台');
        }
        userId = user.id;
        await tx.authIdentity.update({
          where: { id: existingIdentity.id },
          data: {
            providerEmail: profile.email,
            profile: profile.rawProfile as Prisma.InputJsonValue,
            emailVerified: profile.emailVerified,
            lastUsedAt: now,
          },
        });
      } else {
        const emailUser = await tx.user.findUnique({ where: { email: expectedEmail }, select: { id: true } });
        if (emailUser) throw new ConflictException('该邮箱已注册，请先登录后接受邀请');
        const created = await tx.user.create({
          data: {
            email: expectedEmail,
            name: profile.name,
            avatar: profile.avatar,
            authIdentities: {
              create: {
                provider: profile.provider,
                providerAccountId: profile.providerAccountId,
                providerEmail: profile.email,
                profile: profile.rawProfile as Prisma.InputJsonValue,
                emailVerified: profile.emailVerified,
                lastUsedAt: now,
              },
            },
          },
          select: { id: true },
        });
        userId = created.id;
      }

      const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${invitation.enterpriseId} FOR UPDATE`;
      if (enterprises[0]?.status !== 'ACTIVE') throw new ConflictException('企业已关闭，无法接受邀请');
      const memberships = await tx.enterpriseMember.findMany({ where: { userId }, select: { enterpriseId: true } });
      if (memberships.some((m) => m.enterpriseId === invitation.enterpriseId)) throw new ConflictException('你已是该企业成员');
      if (memberships.length > 0) throw new ConflictException('你已归属其他企业，请先退出当前企业后再接受邀请');

      await tx.enterpriseMember.create({
        data: {
          userId,
          enterpriseId: invitation.enterpriseId,
          role: invitation.role,
          departmentId: invitation.departmentId,
          position: invitation.position,
        },
      });
      const claimed = await tx.enterpriseInvitation.updateMany({
        where: {
          id: invitation.id,
          tokenHash: invitationTokenHash,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        data: { status: 'ACCEPTED', acceptedAt: now },
      });
      if (claimed.count !== 1) throw new ConflictException('该邀请已被使用');
      return userId;
    }, { isolationLevel: 'ReadCommitted' });
  }

  private async resolveIdentity(transaction: ConsumedOAuthTransaction, profile: NormalizedOAuthProfile): Promise<string> {
    if (profile.provider !== transaction.provider) throw new BadRequestException('第三方身份不匹配');
    const existing = await this.prisma.authIdentity.findUnique({
      where: { provider_providerAccountId: { provider: profile.provider, providerAccountId: profile.providerAccountId } },
      select: { id: true, userId: true },
    });
    if (existing) {
      if (transaction.intent === 'REGISTER' && !transaction.userId) {
        throw new ConflictException('该第三方账号已注册，请直接登录');
      }
      if (transaction.intent === 'LINK' && transaction.userId && existing.userId !== transaction.userId) {
        throw new ConflictException('该第三方账号已绑定其他账号');
      }
      const updated = await this.prisma.$transaction(async (tx) => {
        const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${existing.userId} FOR UPDATE`;
        if (!users[0] || users[0].status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可登录或绑定');
        return tx.authIdentity.update({
        where: { id: existing.id },
        data: {
          providerEmail: profile.email,
          profile: profile.rawProfile as Prisma.InputJsonValue,
          emailVerified: profile.emailVerified,
          lastUsedAt: new Date(),
        },
        select: { userId: true },
        });
      });
      if (transaction.intent === 'LINK' && transaction.userId && updated.userId !== transaction.userId) {
        throw new ConflictException('该第三方账号已绑定其他账号');
      }
      return updated.userId;
    }

    if (transaction.intent === 'LINK') {
      if (!transaction.userId) throw new UnauthorizedException('绑定第三方账号需要先登录');
      await this.prisma.$transaction(async (tx) => {
        const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${transaction.userId} FOR UPDATE`;
        if (!users[0] || users[0].status !== 'ACTIVE') throw new UnauthorizedException('账号当前不可绑定');
        await tx.authIdentity.create({
        data: {
          userId: transaction.userId,
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
          providerEmail: profile.email,
          profile: profile.rawProfile as Prisma.InputJsonValue,
          emailVerified: profile.emailVerified,
          lastUsedAt: new Date(),
        },
        });
      });
      return transaction.userId;
    }

    if (transaction.userId) throw new BadRequestException('登录事务无效');
    if (transaction.intent === 'LOGIN') {
      throw new UnauthorizedException('该第三方账号尚未注册，请先注册');
    }
    if (profile.email) {
      const emailUser = await this.prisma.user.findUnique({ where: { email: profile.email }, select: { id: true } });
      if (emailUser) throw new ConflictException('该邮箱已注册，请先使用原登录方式登录后绑定第三方账号');
    }

    const accountKey = createHash('sha256').update(`${profile.provider}:${profile.providerAccountId}`).digest('hex').slice(0, 32);
    const email = `${profile.provider}.${accountKey}@oauth.sep.invalid`;
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: profile.name,
          avatar: profile.avatar,
          authIdentities: {
            create: {
              provider: profile.provider,
              providerAccountId: profile.providerAccountId,
              providerEmail: profile.email,
              profile: profile.rawProfile as Prisma.InputJsonValue,
              emailVerified: profile.emailVerified,
              lastUsedAt: new Date(),
            },
          },
        },
        select: { id: true },
      });
      return created;
    });
    return user.id;
  }

  async listIdentities(userId: string) {
    return this.prisma.authIdentity.findMany({
      where: { userId },
      select: { id: true, provider: true, providerAccountId: true, providerEmail: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async unlink(userId: string, identityId: string) {
    const identity = await this.prisma.authIdentity.findFirst({ where: { id: identityId, userId }, select: { id: true, provider: true } });
    if (!identity) throw new NotFoundException('第三方账号不存在');
    const [identityCount, credential] = await Promise.all([
      this.prisma.authIdentity.count({ where: { userId } }),
      this.prisma.authCredential.findUnique({ where: { userId_type: { userId, type: 'LOCAL_PASSWORD' } }, select: { id: true, passwordHash: true } }),
    ]);
    if (identityCount <= 1 && !credential?.passwordHash) {
      throw new ConflictException('请先设置密码或绑定其他登录方式');
    }
    await this.prisma.authIdentity.delete({ where: { id: identityId } });
    await this.events?.record({ userId, action: 'IDENTITY_UNLINKED', provider: identity.provider });
    return { message: '第三方账号已解绑' };
  }
}
