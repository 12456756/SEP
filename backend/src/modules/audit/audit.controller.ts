import { Controller, Get, Query, Request, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { AuditService } from './audit.service';

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService, private readonly context: EnterpriseContextService) {}

  @Get()
  async list(@Request() req, @Query() query: any) {
    const ctx = req.user.role === 'ADMIN' ? null : await this.context.resolve(req.user.id);
    const role = req.user.role === 'ADMIN' ? 'ADMIN' : ctx?.role === 'ENTERPRISE_ADMIN' ? 'ENTERPRISE_ADMIN' : 'MEMBER';
    if (role === 'MEMBER') return { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
    return this.audit.list({ userId: req.user.id, role, enterpriseId: ctx?.enterpriseId }, { ...query, page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 50, from: parseAuditDate(query.from), to: parseAuditDate(query.to, true) });
  }

  @Get('export')
  async export(@Request() req, @Query() query: any, @Res() res: Response) {
    const ctx = req.user.role === 'ADMIN' ? null : await this.context.resolve(req.user.id);
    const role = req.user.role === 'ADMIN' ? 'ADMIN' : ctx?.role === 'ENTERPRISE_ADMIN' ? 'ENTERPRISE_ADMIN' : 'MEMBER';
    if (role === 'MEMBER') return res.status(403).json({ message: '无权查看审计日志' });
    const csv = await this.audit.csv({ userId: req.user.id, role, enterpriseId: ctx?.enterpriseId }, { ...query, from: parseAuditDate(query.from), to: parseAuditDate(query.to, true) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    return res.send(csv);
  }
}

function parseAuditDate(value: unknown, endOfDay = false): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date;
}
