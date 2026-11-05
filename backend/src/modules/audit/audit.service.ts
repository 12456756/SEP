import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const RETENTION_DAYS = 90;
export const AUDIT_EXPORT_MAX_ROWS = 5_000;

type AuditActor = {
  userId: string;
  role: 'ADMIN' | 'ENTERPRISE_ADMIN' | 'MEMBER';
  enterpriseId?: string | null;
};

type AuditQuery = {
  actorId?: string;
  action?: string;
  resourceType?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    actorId: string;
    enterpriseId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    result?: string;
    summary?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.auditLog.create({
          data: {
            actorId: input.actorId,
            enterpriseId: input.enterpriseId ?? null,
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId ?? null,
            result: input.result ?? 'SUCCESS',
            summary: input.summary ?? null,
            metadata: input.metadata as any,
          },
        });
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      }
    }
    this.logger.error(input.resourceType === 'KNOWLEDGE' ? 'KNOWLEDGE_AUDIT_STORAGE_UNAVAILABLE'
      : `审计日志写入失败（已重试 3 次）: ${(lastError as Error)?.message ?? String(lastError)}`);
    throw lastError;
  }

  async list(actor: AuditActor, query: AuditQuery) {
    const page = this.normalizeInteger(query.page, 1);
    const pageSize = this.normalizeInteger(query.pageSize, 50, 100);
    const where = this.buildWhere(actor, query);
    const include = this.auditInclude();
    const [total, items] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include }),
    ]);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async csv(actor: AuditActor, query: AuditQuery) {
    const where = this.buildWhere(actor, query);
    const total = await this.prisma.auditLog.count({ where });
    if (total > AUDIT_EXPORT_MAX_ROWS) {
      throw new BadRequestException(`当前筛选命中 ${total} 条审计日志，单次最多导出 ${AUDIT_EXPORT_MAX_ROWS} 条，请缩小时间范围或分批导出`);
    }

    const items = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: AUDIT_EXPORT_MAX_ROWS,
      include: this.auditInclude(),
    });
    const esc = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = ['时间,操作人,企业,操作,资源类型,资源ID,结果,摘要'];
    for (const item of items) lines.push([item.createdAt.toISOString(), item.actor.name ?? item.actor.email, item.enterprise?.name, item.action, item.resourceType, item.resourceId, item.result, item.summary].map(esc).join(','));
    return `\ufeff${lines.join('\n')}`;
  }

  private normalizeInteger(value: number | undefined, fallback: number, max?: number): number {
    if (value === undefined || !Number.isInteger(value)) return fallback;
    const normalized = Math.max(1, value);
    return max === undefined ? normalized : Math.min(max, normalized);
  }

  private buildWhere(actor: AuditActor, query: AuditQuery): any {
    this.assertValidDateRange(query.from, query.to);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    return {
      createdAt: { gte: query.from && query.from > cutoff ? query.from : cutoff, ...(query.to ? { lte: query.to } : {}) },
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(actor.role === 'ENTERPRISE_ADMIN' ? { enterpriseId: actor.enterpriseId ?? '__missing__' } : {}),
    };
  }

  private assertValidDateRange(from?: Date, to?: Date): void {
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && (!(value instanceof Date) || Number.isNaN(value.getTime()))) {
        throw new BadRequestException(`${name} 必须是有效日期`);
      }
    }
    if (from && to && from > to) throw new BadRequestException('from 不能晚于 to');
  }

  private auditInclude() {
    return { actor: { select: { id: true, name: true, email: true } }, enterprise: { select: { id: true, name: true } } };
  }
}
