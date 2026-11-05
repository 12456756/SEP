import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { withEmployeeAvatar } from '../../common/employee-avatar';

@Injectable()
export class SubscriptionEmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: EnterpriseContextService,
  ) {}

  private async authorize(id: string, userId: string) {
    const ctx = await this.context.resolve(userId);
    const subscription = await this.prisma.subscription.findFirst({
      where: { id, enterpriseId: ctx.enterpriseId },
      select: { id: true, employeeId: true, status: true, endDate: true },
    });
    if (!subscription) throw new NotFoundException('雇佣关系不存在');
    if (ctx.role !== 'ENTERPRISE_ADMIN') {
      const now = new Date();
      const grant = await this.prisma.employeeGrant.findFirst({
        where: {
          subscriptionId: id,
          OR: [
            { memberId: ctx.memberId },
            ...(ctx.departmentId ? [{ departmentId: ctx.departmentId }] : []),
          ],
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
        },
        select: { id: true },
      });
      if (
        !grant ||
        subscription.status !== 'ACTIVE' ||
        (subscription.endDate && subscription.endDate <= now)
      ) {
        throw new ForbiddenException('没有有效的员工使用授权');
      }
    }
    return { ctx, subscription };
  }

  async detail(id: string, userId: string) {
    const { subscription } = await this.authorize(id, userId);
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: subscription.employeeId },
      select: {
        id: true,
        name: true,
        avatar: true,
        description: true,
        industry: true,
        position: true,
        createdAt: true,
        updatedAt: true,
        bindings: {
          where: {
            enabled: true,
            capability: { status: 'APPROVED' },
          },
          orderBy: { priority: 'asc' },
          select: {
            id: true,
            priority: true,
            capability: {
              select: {
                id: true,
                name: true,
                type: true,
                status: true,
                description: true,
              },
            },
          },
        },
      },
    });
    if (!employee) throw new NotFoundException('员工不存在');
    return withEmployeeAvatar(employee);
  }

  async stats(id: string, userId: string, days: number) {
    const { ctx, subscription } = await this.authorize(id, userId);
    const scope = ctx.role === 'ENTERPRISE_ADMIN' ? 'enterprise' : 'personal';
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 86400000);
    const scoped = {
      enterpriseId: ctx.enterpriseId,
      subscriptionId: id,
      employeeId: subscription.employeeId,
      ...(scope === 'personal' ? { userId } : {}),
    };
    const usage = await this.prisma.computeUsageRecord.findMany({
      where: { ...scoped, createdAt: { gte: startDate, lte: endDate } },
      select: {
        createdAt: true,
        inputTokens: true,
        outputTokens: true,
        costCNY: true,
        userId: true,
        user: { select: { name: true } },
      },
    });
    // Sessions have no tenant ID. Billing attribution anchors them to this subscription;
    // never infer historical tenancy from a user's current membership.
    const sessions = await this.prisma.computeUsageRecord.findMany({
      where: { ...scoped, sessionId: { not: null } },
      distinct: ['sessionId'],
      select: { sessionId: true },
    });
    const sessionIds = sessions.flatMap((row) =>
      row.sessionId ? [row.sessionId] : [],
    );
    // Exclude sessions billed to another tenant/subscription rather than mix execution histories.
    const ambiguous = sessionIds.length
      ? await this.prisma.computeUsageRecord.findMany({
          where: {
            sessionId: { in: sessionIds },
            OR: [
              { enterpriseId: { not: ctx.enterpriseId } },
              { subscriptionId: { not: id } },
              { subscriptionId: null },
            ],
          },
          distinct: ['sessionId'],
          select: { sessionId: true },
        })
      : [];
    const excluded = new Set(ambiguous.map((row) => row.sessionId));
    const attributedIds = sessionIds.filter(
      (sessionId) => !excluded.has(sessionId),
    );
    const executions = attributedIds.length
      ? await this.prisma.toolExecution.findMany({
          where: {
            sessionId: { in: attributedIds },
            createdAt: { gte: startDate, lte: endDate },
            session: {
              employeeId: subscription.employeeId,
              ...(scope === 'personal' ? { userId } : {}),
            },
          },
          select: {
            id: true,
            status: true,
            duration: true,
            createdAt: true,
            capability: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const dateKey = (date: Date) =>
      new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const trend = new Map<
      string,
      {
        date: string;
        total: number;
        success: number;
        failed: number;
        tokens: number;
        costCNY: number;
      }
    >();
    for (let i = 0; i <= days; i++) {
      const date = dateKey(new Date(startDate.getTime() + i * 86400000));
      trend.set(date, {
        date,
        total: 0,
        success: 0,
        failed: 0,
        tokens: 0,
        costCNY: 0,
      });
    }
    let cost = new Decimal(0);
    let inputTokens = 0;
    let outputTokens = 0;
    const members = new Map<
      string | null,
      { userId: string | null; name: string; callCount: number; cost: Decimal }
    >();
    for (const row of usage) {
      cost = cost.add(row.costCNY);
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      const member = members.get(row.userId) ?? {
        userId: row.userId,
        name: row.user?.name || '未知成员',
        callCount: 0,
        cost: new Decimal(0),
      };
      member.callCount++;
      member.cost = member.cost.add(row.costCNY);
      members.set(row.userId, member);
      const point = trend.get(dateKey(row.createdAt))!;
      point.tokens += row.inputTokens + row.outputTokens;
      point.costCNY += Number(row.costCNY);
    }
    for (const row of executions) {
      const point = trend.get(dateKey(row.createdAt))!;
      point.total++;
      if (row.status === 'SUCCESS') point.success++;
      if (row.status === 'FAILED') point.failed++;
    }
    const durations = executions.flatMap((row) =>
      row.duration === null ? [] : [row.duration],
    );
    return {
      scope,
      byMember:
        scope === 'enterprise'
          ? [...members.values()]
              .map(({ cost, ...member }) => ({
                ...member,
                costCNY: cost.toNumber(),
              }))
              .sort((a, b) => b.callCount - a.callCount)
          : [],
      period: {
        days,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      summary: {
        callCount: usage.length,
        total: executions.length,
        successCount: executions.filter((row) => row.status === 'SUCCESS')
          .length,
        failedCount: executions.filter((row) => row.status === 'FAILED').length,
        avgDuration: durations.length
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : 0,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costCNY: cost.toNumber(),
      },
      trend: [...trend.values()],
      recentLog: executions
        .slice(0, 10)
        .map((row) => ({
          id: row.id,
          toolName: row.capability.name,
          status: row.status,
          duration: row.duration,
          createdAt: row.createdAt.toISOString(),
        })),
    };
  }
}
