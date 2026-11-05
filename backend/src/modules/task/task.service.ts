import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import { assertActiveEnterpriseInTx } from '../../common/enterprise-write-lock';
import { CreateTaskDto, CreateTemplateDto, StepPatchDto, TaskQuery, UpdateTaskDto } from 'shared';

const statusToDb: any = {
  draft: 'DRAFT',
  awaiting_confirmation: 'AWAITING_CONFIRMATION',
  running: 'RUNNING',
  completed: 'COMPLETED',
  failed: 'FAILED',
  stopped: 'STOPPED',
};

const statusFromDb: any = {
  DRAFT: 'draft',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

const eventFor: any = {
  RUNNING: 'RUN_STARTED',
  COMPLETED: 'RUN_COMPLETED',
  FAILED: 'RUN_FAILED',
  STOPPED: 'RUN_STOPPED',
};

const stepEvent: any = {
  running: 'STEP_STARTED',
  completed: 'STEP_COMPLETED',
  failed: 'STEP_FAILED',
  skipped: 'STEP_SKIPPED',
};

@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  private async membership(userId: string) {
    return this.prisma.enterpriseMember.findFirst({
      where: { userId },
      select: { enterpriseId: true, role: true },
    });
  }

  private async assertActiveUser(tx: Prisma.TransactionClient, userId: string) {
    const users = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM users WHERE id = ${userId} FOR UPDATE
    `;
    if (users[0]?.status !== 'ACTIVE') throw new ConflictException('账号当前不可创建或启动任务');
  }

  private async owned(id: string, userId: string, tx: Prisma.TransactionClient = this.prisma) {
    const r = await tx.taskRun.findUnique({
      where: { id },
      // runSteps 供 toTaskRunSummary 统计真实进度；这里同样只取三列，
      // 详情接口的 steps 字段仍然来自 JSON 快照（前端规划期要的形状）。
      include: { runSteps: { select: { order: true, status: true, employeeName: true } } },
    });
    if (!r || r.userId !== userId) throw new NotFoundException('Task not found');
    return r;
  }

  private async ownedTemplate(id: string, userId: string) {
    const r = await this.prisma.taskTemplate.findUnique({ where: { id } });
    if (!r || r.userId !== userId) throw new NotFoundException('Template not found');
    return r;
  }

  private validateLayout(layout: any, steps: any[]) {
    if (!layout) return;
    const ids = new Set(steps.map((s) => s.id));
    for (const id of Object.keys(layout.nodes || {})) {
      if (!ids.has(id)) throw new BadRequestException('layout contains unknown step');
    }
  }

  private async eventsFor(task: any, oldSteps: any[], newSteps: any[], oldStatus: any, newStatus: any, tx: Prisma.TransactionClient = this.prisma) {
    const ev: any[] = [];

    if (oldStatus !== newStatus && eventFor[newStatus]) {
      ev.push({ taskRunId: task.id, type: eventFor[newStatus] });
    }

    const om = new Map(oldSteps.map((s) => [s.id, s]));
    for (const s of newSteps) {
      const o = om.get(s.id);
      if (o && o.status !== s.status && stepEvent[s.status]) {
        ev.push({
          taskRunId: task.id,
          type: stepEvent[s.status],
          stepId: s.id,
          stepTitle: s.title,
          employeeName: s.employee?.name,
        });
      }
    }

    if (ev.length) await tx.taskRunEvent.createMany({ data: ev });
  }

  /**
   * 列表与详情里的进度统计。
   *
   * 执行引擎搬到服务端后权威状态是 `TaskRunStep` 行，`TaskRun.steps` 这个 JSON
   * 快照只在规划期被写。所以有行就按行算 —— 否则跑完的任务在工作记录里会显示
   * 「已完成 · 0/2 步」，状态和进度自相矛盾。
   */
  private toTaskRunSummary(r: any, owner = false) {
    const jsonSteps: any[] = Array.isArray(r.steps) ? r.steps : [];
    const rows: any[] = Array.isArray(r.runSteps) ? r.runSteps : [];
    const useRows = rows.length > 0;

    const ordered = useRows
      ? [...rows].sort((a, b) => a.order - b.order)
      : [...jsonSteps].sort((a, b) => a.order - b.order);

    const summary: any = {
      id: r.id,
      objective: r.objective,
      status: statusFromDb[r.status] || r.status,
      stepCount: ordered.length,
      completedStepCount: useRows
        ? rows.filter((s) => s.status === 'COMPLETED').length
        : jsonSteps.filter((s) => s.status === 'completed').length,
      employeeNames: [
        ...new Set(
          ordered.map((s) => (useRows ? s.employeeName : s.employee?.name)).filter(Boolean),
        ),
      ].slice(0, 4),
      startedAt: r.startedAt?.toISOString() || null,
      completedAt: r.completedAt?.toISOString() || null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };

    if (owner) summary.owner = r.user;
    return summary;
  }

  private serializeTaskRun(r: any, owner = false) {
    return {
      ...this.toTaskRunSummary(r, owner),
      summary: r.summary,
      steps: r.steps,
      layout: r.layout,
      planner: r.planner,
    };
  }

  async create(userId: string, dto: CreateTaskDto) {
    this.validateLayout(dto.layout, dto.steps);
    const r = await this.prisma.$transaction(async (tx) => {
      await this.assertActiveUser(tx, userId);
      const m = await tx.enterpriseMember.findFirst({ where: { userId }, select: { enterpriseId: true } });
      if (m?.enterpriseId) await assertActiveEnterpriseInTx(tx, m.enterpriseId);
      const created = await tx.taskRun.create({
      data: {
        objective: dto.objective,
        summary: dto.summary || '',
        steps: dto.steps as any,
        layout: dto.layout as any,
        planner: dto.planner as any,
        status: statusToDb[dto.status || 'awaiting_confirmation'],
        userId,
        enterpriseId: m?.enterpriseId,
      },
      });
      await tx.taskRunEvent.create({ data: { taskRunId: created.id, type: 'RUN_CREATED' } });
      return created;
    });
    return this.serializeTaskRun(r);
  }

  async list(userId: string, q: TaskQuery) {
    const where: any = {};

    if (q.scope === 'enterprise') {
      const m = await this.membership(userId);
      if (!m || m.role !== 'ENTERPRISE_ADMIN') throw new ForbiddenException('企业管理员权限 required');
      where.enterpriseId = m.enterpriseId;
    } else {
      where.userId = userId;
    }

    const statuses = q.status ? (Array.isArray(q.status) ? q.status : [q.status]).map((s) => statusToDb[s]) : undefined;
    if (statuses) where.status = { in: statuses };
    if (q.keyword?.trim()) where.objective = { contains: q.keyword.trim(), mode: 'insensitive' };

    if (q.cursor) {
      const c = await this.prisma.taskRun.findUnique({ where: { id: q.cursor }, select: { createdAt: true, id: true } });
      if (c) where.OR = [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }];
    }

    const rows = await this.prisma.taskRun.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: {
        // 只取统计要用的三列。带上全部字段的话，列表接口会把每一步的
        // inputPrompt 和 output 全拉回来 —— 那是几十 KB 一条的东西。
        runSteps: { select: { order: true, status: true, employeeName: true } },
        ...(q.scope === 'enterprise' ? { user: { select: { id: true, name: true } } } : {}),
      },
    });

    const has = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const items = page.map((r: any) => this.toTaskRunSummary(r, q.scope === 'enterprise'));
    return { items, nextCursor: has ? page[page.length - 1].id : null };
  }

  async get(id: string, userId: string) {
    const r = await this.owned(id, userId);
    return this.serializeTaskRun(r);
  }

  async update(id: string, userId: string, dto: UpdateTaskDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveUser(tx, userId);
      return this.updateInTx(tx, id, userId, dto);
    });
  }

  private async updateInTx(tx: Prisma.TransactionClient, id: string, userId: string, dto: UpdateTaskDto) {
    const old = await this.owned(id, userId, tx);
    if (old.enterpriseId) await assertActiveEnterpriseInTx(tx, old.enterpriseId);

    if (dto.expectedUpdatedAt && new Date(dto.expectedUpdatedAt).getTime() !== old.updatedAt.getTime()) {
      throw new ConflictException({ message: 'Task was updated', current: this.serializeTaskRun(old) });
    }

    const nextSteps: any[] = dto.steps || (Array.isArray(old.steps) ? old.steps : []);
    this.validateLayout(dto.layout !== undefined ? dto.layout : old.layout, nextSteps);

    const data: any = {};
    if (dto.status) data.status = statusToDb[dto.status];
    if (dto.steps) data.steps = dto.steps;
    if (dto.layout !== undefined) data.layout = dto.layout;
    if (dto.startedAt !== undefined) data.startedAt = dto.startedAt ? new Date(dto.startedAt) : null;
    if (dto.completedAt !== undefined) data.completedAt = dto.completedAt ? new Date(dto.completedAt) : null;

    let r: any;
    if (dto.expectedUpdatedAt) {
      const result = await tx.taskRun.updateMany({
        where: { id, updatedAt: new Date(dto.expectedUpdatedAt) },
        data,
      });
      if (result.count !== 1) {
        const current = await this.owned(id, userId, tx);
        throw new ConflictException({ message: 'Task was updated', current: this.serializeTaskRun(current) });
      }
      r = await tx.taskRun.findUniqueOrThrow({ where: { id } });
    } else {
      r = await tx.taskRun.update({ where: { id }, data });
    }

    await this.eventsFor(r, Array.isArray(old.steps) ? old.steps : [], nextSteps, old.status, r.status, tx);
    return this.serializeTaskRun(r);
  }

  async patchStep(id: string, userId: string, stepId: string, dto: StepPatchDto) {
    const old = await this.owned(id, userId);
    if (dto.expectedUpdatedAt && new Date(dto.expectedUpdatedAt).getTime() !== old.updatedAt.getTime()) {
      throw new ConflictException(this.serializeTaskRun(old));
    }

    const steps: any[] = JSON.parse(JSON.stringify(old.steps || []));
    const i = steps.findIndex((s) => s.id === stepId);
    if (i < 0) throw new NotFoundException('Step not found');

    const { expectedUpdatedAt, ...changes } = dto as any;
    Object.assign(steps[i], changes);
    return this.update(id, userId, { steps, expectedUpdatedAt } as any);
  }

  async remove(id: string, userId: string) {
    const r = await this.owned(id, userId);
    if (r.status === 'RUNNING') throw new ConflictException('请先停止运行中的任务');
    await this.prisma.taskRun.delete({ where: { id } });
    return { success: true };
  }

  async events(id: string, userId: string) {
    await this.owned(id, userId);
    return this.prisma.taskRunEvent.findMany({ where: { taskRunId: id }, orderBy: { createdAt: 'asc' }, take: 200 });
  }

  async reconcile(id: string, userId: string) {
    const r = await this.owned(id, userId);

    if (r.status === 'RUNNING' && Date.now() - r.updatedAt.getTime() > 10 * 60 * 1000) {
      const steps: any[] = JSON.parse(JSON.stringify(r.steps || []));
      steps.forEach((s) => {
        if (s.status === 'running') {
          s.status = 'failed';
          s.error = '执行中断';
        }
      });

      const u = await this.prisma.taskRun.update({
        where: { id },
        data: { status: 'STOPPED', steps, completedAt: new Date() },
      });
      await this.eventsFor(u, r.steps as any, steps, r.status, u.status);
      return this.serializeTaskRun(u);
    }

    return this.serializeTaskRun(r);
  }

  async templates(userId: string) {
    return this.prisma.taskTemplate.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async createTemplate(userId: string, dto: CreateTemplateDto) {
    const m = await this.membership(userId);
    const steps = dto.steps.map((s) => ({
      ...s,
      status: 'queued',
      output: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
      durationMs: undefined,
    }));

    return this.prisma.taskTemplate.create({
      data: { name: dto.name.trim(), objective: dto.objective, steps: steps as any, layout: dto.layout as any, userId, enterpriseId: m?.enterpriseId },
    });
  }

  async removeTemplate(id: string, userId: string) {
    await this.ownedTemplate(id, userId);
    await this.prisma.taskTemplate.delete({ where: { id } });
    return { success: true };
  }
}
