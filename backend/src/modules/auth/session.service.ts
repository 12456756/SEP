import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthEventService } from './auth-event.service';
import { assertEnterpriseNotSuspended } from '../enterprise/enterprise-context.service';
import { createHash, randomBytes } from 'node:crypto';

export type AuthClientType = 'WEB' | 'DESKTOP';

export interface CreateSessionInput {
  userId: string;
  clientType: AuthClientType;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
  refreshTtlSeconds: number;
}

export interface CreatedSession {
  sessionId: string;
  familyId: string;
  userId: string;
  deviceId: string | null;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  isNewDevice: boolean;
}

export interface RotatedSession {
  sessionId: string;
  familyId: string;
  userId: string;
  deviceId: string | null;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * 认证会话的唯一状态入口。
 *
 * Access JWT 是无状态的短期凭据；Refresh Token 是随机 opaque token，
 * 只以 hash 形式保存在 auth_tokens 表中。每次刷新都会消费旧 token，
 * 并在同一 session family 中生成新 token。
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events?: AuthEventService,
  ) {}

  private get refreshPepper(): string {
    return (
      this.config.get<string>('REFRESH_TOKEN_PEPPER') ??
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256')
      .update(`${this.refreshPepper}:${token}`)
      .digest('hex');
  }

  private issueRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private newFamilyId(): string {
    return randomBytes(18).toString('base64url');
  }

  private typeOf(clientType: AuthClientType): 'WEB' | 'DESKTOP' {
    return clientType;
  }

  async assertUserEnterpriseActive(userId: string, role?: string | null): Promise<void> {
    if (role === 'ADMIN' || role === 'PLATFORM_ADMIN' || role === 'SUPER_ADMIN') return;
    const membership = await this.prisma.enterpriseMember.findFirst({
      where: { userId }, orderBy: { createdAt: 'asc' },
      select: { enterprise: { select: { metadata: true } } },
    }).catch(() => {
      throw new ServiceUnavailableException('Enterprise access service unavailable');
    });
    if (membership) assertEnterpriseNotSuspended(membership.enterprise.metadata);
  }

  async assertEnterpriseActive(enterpriseId: string): Promise<void> {
    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: enterpriseId }, select: { metadata: true },
    }).catch(() => {
      throw new ServiceUnavailableException('Enterprise access service unavailable');
    });
    if (!enterprise) throw new UnauthorizedException('Enterprise is unavailable');
    assertEnterpriseNotSuspended(enterprise.metadata);
  }

  async assertActiveAccessSession(sessionId: string, userId: string): Promise<void> {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId }, select: { type: true },
    }).catch(() => {
      throw new ServiceUnavailableException('Authentication session service unavailable');
    });
    if (!session || (session.type !== 'WEB' && session.type !== 'DESKTOP')) {
      throw new UnauthorizedException('Invalid or expired authentication session');
    }
    await this.assertActiveSession(sessionId, userId, session.type);
  }

  async assertActiveSession(
    sessionId: string,
    userId: string,
    clientType: AuthClientType,
  ): Promise<void> {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      select: {
        userId: true, type: true, revokedAt: true, expiresAt: true, deviceId: true,
        user: { select: { status: true, role: true, memberships: { orderBy: { createdAt: 'asc' }, take: 1,
          select: { enterprise: { select: { metadata: true } } } } } },
        device: { select: { userId: true, revokedAt: true } },
      },
    }).catch(() => {
      throw new ServiceUnavailableException('Authentication session service unavailable');
    });
    if (!session || session.userId !== userId || session.type !== clientType ||
        session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE' ||
        (clientType === 'DESKTOP' && (!session.deviceId || !session.device ||
          session.device.revokedAt || session.device.userId !== userId))) {
      throw new UnauthorizedException('Invalid or expired authentication session');
    }
    if (session.user.role !== 'ADMIN') {
      assertEnterpriseNotSuspended(session.user.memberships[0]?.enterprise.metadata);
    }
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    if (!Number.isInteger(input.refreshTtlSeconds) || input.refreshTtlSeconds <= 0) {
      throw new UnauthorizedException('Invalid refresh token lifetime');
    }

    const refreshToken = this.issueRefreshToken();
    const refreshTokenExpiresAt = new Date(
      Date.now() + input.refreshTtlSeconds * 1000,
    );
    const familyId = this.newFamilyId();
    const tokenHash = this.hashToken(refreshToken);
    let isNewDevice = true;
    if ((input.deviceId || input.ipAddress || input.userAgent) && typeof this.prisma.authSession.findFirst === 'function') {
      const previous = await this.prisma.authSession.findFirst({
        where: {
          userId: input.userId,
          revokedAt: null,
          ...(input.deviceId
            ? { deviceId: input.deviceId }
            : { ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null }),
        },
        select: { id: true },
      });
      isNewDevice = !previous;
    }

    const session = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string; role: string }>>`SELECT id, status, role FROM users WHERE id = ${input.userId} FOR UPDATE`;
      if (!rows[0] || rows[0].status !== 'ACTIVE') {
        throw new UnauthorizedException('Account is not active');
      }
      if (rows[0].role !== 'ADMIN') {
        const memberships = await tx.$queryRaw<Array<{ enterpriseId: string; metadata: unknown }>>`
          SELECT e.id AS "enterpriseId", e.metadata
          FROM enterprise_members em
          JOIN enterprises e ON e.id = em."enterpriseId"
          WHERE em."userId" = ${input.userId}
          ORDER BY em."createdAt" ASC
          LIMIT 1
          FOR SHARE OF e
        `;
        assertEnterpriseNotSuspended(memberships[0]?.metadata);
      }
      const session = await tx.authSession.create({
        data: {
          userId: input.userId,
          type: this.typeOf(input.clientType),
          familyId,
          deviceId: input.deviceId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          expiresAt: refreshTokenExpiresAt,
          lastUsedAt: new Date(),
        },
        select: { id: true },
      });

      await tx.authToken.create({
        data: {
          sessionId: session.id,
          familyId,
          tokenHash,
          expiresAt: refreshTokenExpiresAt,
        },
      });

      return session;
    });

    return {
      sessionId: session.id,
      familyId,
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      refreshToken,
      refreshTokenExpiresAt,
      isNewDevice,
    };
  }

  /**
   * 消费当前 refresh token 并签发下一枚。
   * 已使用/已撤销 token 被再次提交时，整个 family 立即失效，
   * 这样被窃取的旧 token 不能继续与合法客户端竞争刷新权。
   */
  async rotateRefreshToken(
    refreshToken: string | undefined,
    clientType: AuthClientType,
  ): Promise<RotatedSession> {
    if (!refreshToken) throw new UnauthorizedException('No refresh token');

    const tokenHash = this.hashToken(refreshToken);
    const existing = await this.prisma.authToken.findUnique({
      where: { tokenHash },
      include: { session: true },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const now = new Date();
    const session = existing.session;
    if (
      session.type !== this.typeOf(clientType) ||
      session.revokedAt ||
      existing.revokedAt ||
      existing.usedAt ||
      existing.expiresAt <= now ||
      session.expiresAt <= now
    ) {
      // 对已消费 token 的重放，以及同一 family 中的异常 token，
      // 一律撤销 family。普通过期 token 则只拒绝，不误伤其它会话。
      if (existing.usedAt || existing.revokedAt || session.revokedAt) {
        await this.revokeSessionFamily(session.familyId, 'refresh_token_reuse');
        await this.events?.record({ userId: session.userId, action: 'TOKEN_REPLAY', success: false, sessionId: session.id, metadata: { reason: 'refresh_token_reuse' } });
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.assertActiveSession(session.id, session.userId, clientType);

    const nextRefreshToken = this.issueRefreshToken();
    const nextExpiresAt = new Date(
      Date.now() + this.getRefreshTtlSeconds(clientType) * 1000,
    );
    const nextHash = this.hashToken(nextRefreshToken);

    const consumed = await this.prisma.$transaction(async (tx) => {
      const userRows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${session.userId} FOR UPDATE`;
      if (!userRows[0] || userRows[0].status !== 'ACTIVE') return false;
      const result = await tx.authToken.updateMany({
        where: {
          id: existing.id, usedAt: null, revokedAt: null, expiresAt: { gt: now },
          session: {
            id: session.id, userId: session.userId, type: clientType,
            revokedAt: null, expiresAt: { gt: now },
            user: { status: 'ACTIVE' },
            ...(clientType === 'DESKTOP'
              ? { deviceId: { not: null }, device: { is: { userId: session.userId, revokedAt: null } } }
              : {}),
          },
        },
        data: { usedAt: now },
      });
      if (result.count !== 1) return false;

      await tx.authToken.create({
        data: {
          sessionId: session.id,
          familyId: session.familyId,
          tokenHash: nextHash,
          expiresAt: nextExpiresAt,
        },
      });
      await tx.authSession.update({
        where: { id: session.id },
        data: { lastUsedAt: now, expiresAt: nextExpiresAt },
      });
      return true;
    });

    if (!consumed) {
      await this.revokeSessionFamily(session.familyId, 'refresh_token_reuse');
      await this.events?.record({ userId: session.userId, action: 'TOKEN_REPLAY', success: false, sessionId: session.id, metadata: { reason: 'refresh_token_reuse' } });
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return {
      sessionId: session.id,
      familyId: session.familyId,
      userId: session.userId,
      deviceId: session.deviceId,
      refreshToken: nextRefreshToken,
      refreshTokenExpiresAt: nextExpiresAt,
    };
  }

  async validateRefreshToken(
    refreshToken: string | undefined,
    clientType: AuthClientType,
  ): Promise<{ sessionId: string; familyId: string; userId: string; deviceId: string | null }> {
    if (!refreshToken) throw new UnauthorizedException('No refresh token');
    const token = await this.prisma.authToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      include: { session: true },
    });
    const now = new Date();
    if (!token || token.session.type !== this.typeOf(clientType)) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (
      token.usedAt ||
      token.revokedAt ||
      token.session.revokedAt
    ) {
      // validateRefreshToken 也必须执行重放检测：Web/Desktop 刷新流程
      // 会先检查设备与业务授权，再进入 rotateRefreshToken。否则旧 token
      // 在预校验阶段就被拒绝，无法撤销整个 family。
      await this.revokeSessionFamily(token.session.familyId, 'refresh_token_reuse');
      await this.events?.record({ userId: token.session.userId, action: 'TOKEN_REPLAY', success: false, sessionId: token.session.id, metadata: { reason: 'refresh_token_reuse' } });
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (token.expiresAt <= now || token.session.expiresAt <= now) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    await this.assertActiveSession(token.session.id, token.session.userId, clientType);
    return {
      sessionId: token.session.id,
      familyId: token.session.familyId,
      userId: token.session.userId,
      deviceId: token.session.deviceId,
    };
  }

  getRefreshTtlSeconds(clientType: AuthClientType): number {
    const fallback = clientType === 'WEB' ? 7 * 24 * 60 * 60 : 30 * 24 * 60 * 60;
    const configured = this.config.get<string>('REFRESH_TOKEN_EXPIRES_IN');
    if (!configured) return fallback;
    const parsed = this.parseDurationSeconds(configured);
    return parsed > 0 ? parsed : fallback;
  }

  parseDurationSeconds(value: string): number {
    if (/^\d+$/.test(value)) return Number(value);
    const match = value.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
    if (!match) return 0;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    return amount * ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[unit];
  }

  async revokeRefreshToken(
    refreshToken: string | undefined,
    reason = 'logout',
  ): Promise<{ userId: string; sessionId: string } | null> {
    if (!refreshToken) return null;
    const token = await this.prisma.authToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      select: { sessionId: true, session: { select: { userId: true } } },
    });
    if (!token) return null;
    await this.revokeSession(token.sessionId, reason);
    return { userId: token.session.userId, sessionId: token.sessionId };
  }

  async revokeSession(sessionId: string, reason = 'logout'): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      }),
      this.prisma.authToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      }),
    ]);
  }

  async revokeSessionFamily(familyId: string, reason = 'security'): Promise<void> {
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      }),
      this.prisma.authToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      }),
    ]);
  }

  async revokeAllUserSessions(userId: string, reason = 'logout_all'): Promise<void> {
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      }),
      this.prisma.authToken.updateMany({
        where: { session: { userId }, revokedAt: null },
        data: { revokedAt, revokeReason: reason },
      }),
    ]);
  }

  async revokeEnterpriseSessionsInTx(
    tx: Prisma.TransactionClient,
    enterpriseId: string,
    reason = 'enterprise_suspended',
  ): Promise<number> {
    const revokedAt = new Date();
    const membership = {
      user: {
        role: { not: UserRole.ADMIN },
        memberships: { some: { enterpriseId } },
      },
    };
    const sessions = await tx.authSession.updateMany({
      where: { ...membership, revokedAt: null },
      data: { revokedAt, revokeReason: reason },
    });
    await tx.authToken.updateMany({
      where: { session: membership, revokedAt: null },
      data: { revokedAt, revokeReason: reason },
    });
    return sessions.count;
  }

  async revokeAllUserSessionsExcept(
    userId: string,
    keepSessionId: string | undefined,
    reason = 'security',
  ): Promise<void> {
    const revokedAt = new Date();
    const sessionWhere = {
      userId,
      revokedAt: null,
      ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
    };
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({
        where: sessionWhere,
        data: { revokedAt, revokeReason: reason },
      }),
      this.prisma.authToken.updateMany({
        where: {
          session: sessionWhere,
          revokedAt: null,
        },
        data: { revokedAt, revokeReason: reason },
      }),
    ]);
  }

  async listUserSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.prisma.authSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        type: true,
        deviceId: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return sessions.map((session) => ({
      ...session,
      isCurrent: Boolean(currentSessionId && session.id === currentSessionId),
    }));
  }
}
