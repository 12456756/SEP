import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../auth/session.service';
import { EnterpriseDeletionCleanupService, type EnterpriseDeletionManifest } from './enterprise-deletion-cleanup.service';
import { RequestEnterpriseDeletion, type EnterpriseDeletionPreview, type EnterpriseDeletionView } from 'shared';
import { randomUUID } from 'node:crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

type JobStatus = 'PENDING' | 'RUNNING' | 'FAILED' | 'COMPLETED';
type JobPhase = 'PREPARE' | 'DATABASE' | 'FILES' | 'DONE';

@Injectable()
export class EnterpriseDeletionService {
  private readonly logger = new Logger(EnterpriseDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly cleanup: EnterpriseDeletionCleanupService,
  ) {}

  async preview(enterpriseId: string): Promise<EnterpriseDeletionPreview> {
    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: enterpriseId },
      select: {
        id: true,
        name: true,
        wallet: { select: { balance: true, frozenAmount: true, computeReservedCNY: true } },
        _count: { select: { members: true, subscriptions: true, knowledgeBases: true, taskRuns: true } },
      },
    });
    if (!enterprise) throw new NotFoundException('企业不存在');
    const [documentCount, runningTaskCount, pendingOrderCount] = await Promise.all([
      this.prisma.document.count({ where: { knowledgeBase: { enterpriseId } } }),
      this.prisma.taskRun.count({ where: { enterpriseId, status: 'RUNNING' } }),
      this.prisma.order.count({ where: { enterpriseId, status: 'PENDING' } }),
    ]);
    const balance = Number(enterprise.wallet?.balance ?? 0);
    const frozenAmount = Number(enterprise.wallet?.frozenAmount ?? 0);
    const computeReservedCNY = Number(enterprise.wallet?.computeReservedCNY ?? 0);
    const warnings: string[] = [];
    if (balance > 0) warnings.push(`企业余额 ¥${balance.toFixed(2)} 将被清除，不会自动退款`);
    if (frozenAmount > 0) warnings.push(`企业有 ¥${frozenAmount.toFixed(2)} 冻结金额，将随企业数据清除`);
    if (computeReservedCNY > 0) warnings.push(`企业有 ¥${computeReservedCNY.toFixed(2)} 算力专款，将随企业数据清除`);
    if (enterprise._count.subscriptions > 0) warnings.push(`将取消 ${enterprise._count.subscriptions} 个企业订阅`);
    if (runningTaskCount > 0) warnings.push(`将停止 ${runningTaskCount} 个运行中的任务`);
    if (pendingOrderCount > 0) warnings.push(`将关闭 ${pendingOrderCount} 个待支付订单`);
    return {
      enterpriseId,
      enterpriseName: enterprise.name,
      balance,
      frozenAmount,
      computeReservedCNY,
      memberCount: enterprise._count.members,
      subscriptionCount: enterprise._count.subscriptions,
      knowledgeBaseCount: enterprise._count.knowledgeBases,
      documentCount,
      taskCount: enterprise._count.taskRuns,
      runningTaskCount,
      pendingOrderCount,
      warnings,
    };
  }

  async current(enterpriseId: string): Promise<EnterpriseDeletionView | null> {
    const job = await this.prisma.enterpriseDeletionJob.findUnique({ where: { enterpriseId } });
    return job ? this.view(job) : null;
  }

  async request(enterpriseId: string, dto: RequestEnterpriseDeletion, actorId: string): Promise<EnterpriseDeletionView> {
    const existing = await this.prisma.enterpriseDeletionJob.findUnique({ where: { enterpriseId } });
    if (existing) return this.view(existing);
    const preview = await this.preview(enterpriseId);
    if (dto.confirmName !== preview.enterpriseName) throw new ConflictException('企业名称不匹配，未执行删除');
    let job;
    try {
      job = await this.prisma.enterpriseDeletionJob.create({
        data: {
          enterpriseId,
          enterpriseName: preview.enterpriseName,
          requestedById: actorId,
          snapshot: JSON.parse(JSON.stringify(preview)) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const concurrent = await this.prisma.enterpriseDeletionJob.findUnique({ where: { enterpriseId } });
      if (!concurrent) throw error;
      return this.view(concurrent);
    }
    void this.process(job.id);
    return this.view(job);
  }

  async retry(jobId: string): Promise<EnterpriseDeletionView> {
    const job = await this.prisma.enterpriseDeletionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('删除任务不存在');
    if (job.status !== 'FAILED') throw new ConflictException('只有失败的删除任务可以重试');
    const updated = await this.prisma.enterpriseDeletionJob.update({
      where: { id: jobId },
      data: { status: 'PENDING', error: null, leaseToken: null, leaseUntil: null },
    });
    void this.process(updated.id);
    return this.view(updated);
  }

  async get(jobId: string): Promise<EnterpriseDeletionView> {
    const job = await this.prisma.enterpriseDeletionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('删除任务不存在');
    return this.view(job);
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async recoverPendingJobs(): Promise<void> {
    const jobs = await this.prisma.enterpriseDeletionJob.findMany({
      where: { OR: [{ status: 'PENDING' }, { status: 'RUNNING', leaseUntil: { lt: new Date() } }] },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: { id: true },
    });
    await Promise.all(jobs.map(({ id }) => this.process(id)));
  }

  async process(jobId: string): Promise<void> {
    const token = randomUUID();
    let claim;
    try {
      claim = await this.prisma.enterpriseDeletionJob.updateMany({
      where: {
        id: jobId,
        OR: [
          { status: 'PENDING' },
          { status: 'RUNNING', leaseUntil: { lt: new Date() } },
        ],
      },
        data: { status: 'RUNNING', attempts: { increment: 1 }, leaseToken: token, leaseUntil: new Date(Date.now() + 5 * 60_000) },
      });
    } catch (error) {
      this.logger.error(`Enterprise deletion ${jobId} could not be claimed: ${(error as Error).message}`);
      return;
    }
    if (!claim.count) return;
    const heartbeat = setInterval(() => {
      void this.prisma.enterpriseDeletionJob.updateMany({
        where: { id: jobId, status: 'RUNNING', leaseToken: token },
        data: { leaseUntil: new Date(Date.now() + 5 * 60_000) },
      }).catch((error) => this.logger.warn(`Enterprise deletion lease renewal failed: ${(error as Error).message}`));
    }, 60_000);
    heartbeat.unref?.();
    try {
      const job = await this.prisma.enterpriseDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
      let manifest = job.manifest as unknown as EnterpriseDeletionManifest | null;
      if (!manifest) {
        await this.prisma.$transaction(async (tx) => {
          const claim = await tx.enterpriseDeletionJob.updateMany({
            where: { id: jobId, status: 'RUNNING', leaseToken: token },
            data: { phase: 'DATABASE', leaseUntil: new Date(Date.now() + 5 * 60_000) },
          });
          if (!claim.count) return;
          await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${job.enterpriseId} FOR UPDATE`;
          const enterprise = await tx.enterprise.findUnique({ where: { id: job.enterpriseId }, select: { id: true, name: true } });
          if (!enterprise) throw new NotFoundException('企业已不存在');
          await tx.enterprise.update({ where: { id: enterprise.id }, data: { status: 'CLOSED', closedAt: new Date() } });
          await this.sessions.revokeEnterpriseSessionsInTx(tx, enterprise.id, 'enterprise_deleted');
          await tx.taskRun.updateMany({ where: { enterpriseId: enterprise.id, status: 'RUNNING' }, data: { stopRequestedAt: new Date() } });
          manifest = await this.cleanup.buildManifest(tx, enterprise.id);
          await tx.enterpriseDeletionJob.update({ where: { id: jobId, leaseToken: token }, data: { manifest: JSON.parse(JSON.stringify(manifest)) as Prisma.InputJsonValue, phase: 'DATABASE', leaseUntil: new Date(Date.now() + 5 * 60_000) } });
        }, { maxWait: 15_000, timeout: 120_000 });
      }
      if (!manifest) throw new Error('删除清单为空');
      const latest = await this.prisma.enterpriseDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
      if (latest.phase === 'DATABASE') {
        await this.prisma.$transaction(async (tx) => {
          await tx.enterprise.updateMany({ where: { id: job.enterpriseId, status: { not: 'CLOSED' } }, data: { status: 'CLOSED', closedAt: new Date() } });
          await this.sessions.revokeEnterpriseSessionsInTx(tx, job.enterpriseId, 'enterprise_deleted');
          await tx.taskRun.updateMany({ where: { enterpriseId: job.enterpriseId, status: 'RUNNING' }, data: { stopRequestedAt: new Date() } });
          await tx.knowledgeProcessingJob.updateMany({
            where: { document: { knowledgeBase: { enterpriseId: job.enterpriseId } }, status: { in: ['PENDING', 'RUNNING'] } },
            data: { status: 'CANCELLED', fence: { increment: 1 }, leaseUntil: null },
          });
        });
        await this.waitForRunningTasks(job.enterpriseId);
        const releasedReservations = await this.cleanup.releaseReservedMedia(job.enterpriseId);
        const updated = await this.prisma.enterpriseDeletionJob.updateMany({
          where: { id: jobId, status: 'RUNNING', leaseToken: token },
          data: {
            manifest: {
              ...(manifest as unknown as Record<string, Prisma.InputJsonValue>),
              mediaReservations: releasedReservations as unknown as Prisma.InputJsonValue,
            },
            phase: 'FILES',
          },
        });
        if (!updated.count) throw new ConflictException('删除任务租约已失效');
        manifest = { ...manifest, mediaReservations: releasedReservations };
      }
      const beforeFiles = await this.prisma.enterpriseDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
      if (beforeFiles.phase === 'FILES') {
        await this.cleanup.cleanupMediaCaches(manifest);
        await this.cleanup.cleanupFiles(job.enterpriseId, manifest);
        await this.prisma.$transaction(async (tx) => {
          const lease = await tx.enterpriseDeletionJob.updateMany({
            where: { id: jobId, status: 'RUNNING', leaseToken: token },
            data: { leaseUntil: new Date(Date.now() + 5 * 60_000) },
          });
          if (!lease.count) throw new ConflictException('删除任务租约已失效');
          await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${job.enterpriseId} FOR UPDATE`;
          await tx.auditLog.create({ data: {
            actorId: job.requestedById,
            enterpriseId: job.enterpriseId,
            action: 'ENTERPRISE_PERMANENTLY_DELETED',
            resourceType: 'enterprise',
            resourceId: job.enterpriseId,
            summary: `永久删除企业：${job.enterpriseName}`,
            metadata: {
              snapshot: job.snapshot as Prisma.InputJsonValue,
              manifest: JSON.parse(JSON.stringify(manifest)) as Prisma.InputJsonValue,
            },
          } });
          await this.cleanup.deleteDatabase(tx, job.enterpriseId, manifest!);
          await tx.enterpriseDeletionJob.update({
            where: { id: jobId, leaseToken: token },
            data: { status: 'COMPLETED', phase: 'DONE', leaseUntil: null, completedAt: new Date(), error: null },
          });
        }, { maxWait: 15_000, timeout: 120_000 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '企业删除失败';
      this.logger.error(`Enterprise deletion ${jobId} failed: ${message}`);
      await this.prisma.enterpriseDeletionJob.updateMany({ where: { id: jobId, leaseToken: token }, data: { status: 'FAILED', error: message, leaseUntil: null } });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async waitForRunningTasks(enterpriseId: string): Promise<void> {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const running = await this.prisma.taskRun.count({ where: { enterpriseId, status: 'RUNNING' } });
      if (!running) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ConflictException('运行中的企业任务尚未停止，请稍后重试删除');
  }

  private view(job: any): EnterpriseDeletionView {
    return {
      id: job.id,
      enterpriseId: job.enterpriseId,
      enterpriseName: job.enterpriseName,
      status: job.status as JobStatus,
      phase: job.phase as JobPhase,
      attempts: job.attempts,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }
}
