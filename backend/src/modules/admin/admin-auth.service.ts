import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthEventService } from '../auth/auth-event.service';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly events: AuthEventService,
    private readonly auth: AuthService,
  ) {}

  async listUsers(params: {
    keyword?: string;
    status?: UserStatus;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(params.page ?? 1, 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
    const keyword = params.keyword?.trim();
    const where: Prisma.UserWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(keyword
        ? {
            OR: [
              { email: { contains: keyword, mode: 'insensitive' } },
              { name: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          name: true,
          avatar: true,
          role: true,
          status: true,
          emailVerifiedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { authIdentities: true, authSessions: true, authEvents: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: items.map(({ _count, ...user }) => ({
        ...user,
        identityCount: _count.authIdentities,
        sessionCount: _count.authSessions,
        eventCount: _count.authEvents,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getUserDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        updatedAt: true,
        authCredentials: {
          select: { type: true, failedCount: true, lockedUntil: true, lastUsedAt: true },
        },
        authIdentities: {
          select: { id: true, provider: true, providerAccountId: true, providerEmail: true, emailVerified: true, lastUsedAt: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        authSessions: {
          where: { revokedAt: null },
          orderBy: { lastUsedAt: 'desc' },
          take: 100,
          select: { id: true, type: true, deviceId: true, familyId: true, createdAt: true, lastUsedAt: true, expiresAt: true },
        },
      },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  async listUserEvents(userId: string, limit = 100) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('用户不存在');
    return this.events.listForUser(userId, limit);
  }

  async getSecurityMetrics(hours = 24) {
    const windowHours = Math.min(Math.max(Number.isFinite(hours) ? Math.floor(hours) : 24, 1), 168);
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const events = await this.prisma.authEvent.findMany({
      where: { createdAt: { gte: since } },
      select: { action: true, success: true },
    });
    const byAction: Record<string, { total: number; success: number; failed: number }> = {};
    for (const event of events) {
      const row = byAction[event.action] ?? { total: 0, success: 0, failed: 0 };
      row.total += 1;
      if (event.success) {
        row.success += 1;
      } else {
        row.failed += 1;
      }
      byAction[event.action] = row;
    }
    return { windowHours, since, total: events.length, success: events.filter((event) => event.success).length, failed: events.filter((event) => !event.success).length, byAction };
  }

  async disableUser(userId: string, actorId: string, reason: string) {
    if (userId === actorId) throw new BadRequestException('不能禁用当前管理员账号');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
      if (!user) throw new NotFoundException('用户不存在');
      if (user.role === UserRole.ADMIN) throw new ConflictException('不能通过此接口禁用平台管理员');
      if (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.DISABLED) throw new ConflictException('注销中的账号不可变更状态');
      if (user.status !== UserStatus.DISABLED) {
        await tx.user.update({ where: { id: userId }, data: { status: UserStatus.DISABLED } });
      }
    });
    await this.sessions.revokeAllUserSessions(userId, 'admin_disabled');
    await this.events.record({ userId, action: 'ACCOUNT_DISABLED', success: true, metadata: { actorId, reason } });
    return { message: '账号已禁用', status: UserStatus.DISABLED };
  }

  async enableUser(userId: string, actorId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
      if (!user) throw new NotFoundException('用户不存在');
      if (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.DISABLED) throw new ConflictException('注销中的账号不可变更状态');
      await tx.user.update({ where: { id: userId }, data: { status: UserStatus.ACTIVE } });
    });
    await this.events.record({ userId, action: 'ACCOUNT_ENABLED', success: true, metadata: { actorId } });
    return { message: '账号已解禁', status: UserStatus.ACTIVE };
  }

  async revokeAllSessions(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('用户不存在');
    await this.sessions.revokeAllUserSessions(userId, 'admin_logout_all');
    await this.events.record({ userId, action: 'LOGOUT_ALL', success: true, metadata: { actorId, source: 'admin' } });
    return { message: '已强制退出全部设备' };
  }

  async forceEmailVerification(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, emailVerifiedAt: true } });
    if (!user) throw new NotFoundException('用户不存在');
    const result = await this.auth.requestEmailVerification(userId, true);
    await this.events.record({ userId, action: 'EMAIL_VERIFICATION_REQUESTED', success: true, metadata: { actorId, forced: true } });
    return result;
  }

  async forcePasswordReset(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, status: true } });
    if (!user) throw new NotFoundException('用户不存在');
    if (user.status !== UserStatus.ACTIVE) throw new ConflictException('仅正常账号可以重置密码');
    await this.auth.requestPasswordReset({ email: user.email }, {}, { skipRateLimit: true });
    await this.sessions.revokeAllUserSessions(userId, 'admin_force_password_reset');
    await this.events.record({ userId, action: 'PASSWORD_RESET_REQUESTED', success: true, provider: 'admin', metadata: { actorId, forced: true } });
    return { message: '密码重置邮件已发送' };
  }
}
