import { Injectable, Logger, ServiceUnavailableException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { ModelBillingSnapshotSchema, type ChatCompletionUsage, type ModelRuntimePolicySnapshot, type ModelBillingSnapshot } from 'shared';
import { validGatewayUsage } from './gateway-response';
import { timeoutValue } from './gateway-stream';
import { waitForGatewayOperation } from './gateway-operation';

@Injectable()
export class GatewayExecutionService implements OnModuleInit {
  private readonly logger = new Logger(GatewayExecutionService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: ComputeCreditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    void this.reconcile().catch(() => this.logger.error({ event: 'gateway_reconcile_unavailable' }));
  }

  async start(claims: ClientEmploymentClaims, employeeId: string, modelId: string, requestId: string,
    snapshot?: ModelRuntimePolicySnapshot, billingSnapshot?: ModelBillingSnapshot) {
    const budget = snapshot ? Math.max(
      snapshot.values.GATEWAY_STREAM_TOTAL_TIMEOUT_MS,
      snapshot.values.GATEWAY_NON_STREAM_TIMEOUT_MS,
    ) : Math.max(
      timeoutValue(this.config, 'GATEWAY_STREAM_TOTAL_TIMEOUT_MS', 600000),
      timeoutValue(this.config, 'GATEWAY_NON_STREAM_TIMEOUT_MS', 120000),
    );
    const frozenBilling = ModelBillingSnapshotSchema.parse(billingSnapshot ?? await this.credit.getBillingSnapshot(modelId));
    try {
      return await this.prisma.$transaction(async tx => {
        const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${claims.sub} FOR UPDATE`;
        if (!users[0] || users[0].status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
        const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${claims.enterpriseId} FOR UPDATE`;
        if (enterprises[0]?.status !== 'ACTIVE') throw new UnauthorizedException('Enterprise is not active');
        return tx.gatewayExecution.create({ data: {
        enterpriseId: claims.enterpriseId, userId: claims.sub, memberId: claims.memberId,
        subscriptionId: claims.subscriptionId, employeeId, modelId, requestId,
        billingSnapshot: frozenBilling,
        expiresAt: new Date(Date.now() + budget + 120000),
        } });
      });
    } catch (error) {
      // Authorization failures are expected request outcomes, not journal outages.
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error({ event: 'gateway_journal_unavailable', requestId });
      throw new ServiceUnavailableException({ error: {
        code: 'EXECUTION_JOURNAL_UNAVAILABLE', type: 'server_error', source: 'platform',
        message: '模型执行记录暂不可用，请稍后重试', param: null,
      } });
    }
  }

  async setUpstreamRequest(id: string, upstreamRequestId?: string) {
    if (!upstreamRequestId) return;
    await this.prisma.gatewayExecution.update({ where: { id }, data: { upstreamRequestId } });
  }

  async saveUsage(id: string, value: ChatCompletionUsage) {
    const usage = validGatewayUsage(value);
    if (!usage) return;
    const saved = await this.prisma.gatewayExecution.updateMany({
      where: { id, status: { in: ['STARTED', 'USAGE_PENDING'] }, settlementReady: false, settlementLeaseUntil: null },
      data: { status: 'USAGE_PENDING', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
    });
    if (!saved.count) throw new ServiceUnavailableException({ error: {
      code: 'EXECUTION_USAGE_CHECKPOINT_REJECTED', type: 'server_error', source: 'platform',
      message: '模型用量记录状态不确定，需要对账', param: null,
    } });
  }

  async finish(id: string, details: { finishReason?: string | null; done?: boolean; errorCode?: string }) {
    await this.prisma.gatewayExecution.update({ where: { id }, data: {
      finishReason: details.finishReason?.slice(0, 100), done: details.done ?? false, errorCode: details.errorCode,
      settlementReady: true,
    } });
    await this.prisma.gatewayExecution.updateMany({
      where: { id, status: 'STARTED' },
      data: { status: 'NEEDS_RECONCILIATION', errorCode: details.errorCode ?? 'USAGE_MISSING' },
    });
  }

  async fail(id: string, errorCode: string, definitive = false, usageUncertain = false) {
    if (usageUncertain) {
      // A timed-out checkpoint may still commit. Never settle its older snapshot.
      await this.prisma.gatewayExecution.updateMany({
        where: { id, status: { in: ['STARTED', 'USAGE_PENDING'] }, settlementReady: false, settlementLeaseUntil: null },
        data: { status: 'NEEDS_RECONCILIATION', settlementReady: false, errorCode: 'USAGE_CHECKPOINT_UNCERTAIN' },
      });
      return;
    }
    await this.prisma.gatewayExecution.update({ where: { id }, data: { settlementReady: true } });
    await this.prisma.gatewayExecution.updateMany({ where: { id, status: 'STARTED' }, data: {
      status: definitive ? 'FAILED' : 'NEEDS_RECONCILIATION', errorCode: errorCode.slice(0, 100),
    } });
  }

  async settle(id: string) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 120000);
    const claim = await waitForGatewayOperation(this.prisma.gatewayExecution.updateMany({
      where: { id, status: 'USAGE_PENDING', settlementReady: true, OR: [{ settlementLeaseUntil: null }, { settlementLeaseUntil: { lt: now } }] },
      data: { settlementLeaseUntil: leaseUntil, settlementAttempts: { increment: 1 } },
    }));
    if (!claim.count) return;
    const owned = { id, status: 'USAGE_PENDING' as const, settlementLeaseUntil: leaseUntil };
    let requestId: string | undefined;
    try {
      const execution = await waitForGatewayOperation(this.prisma.gatewayExecution.findUniqueOrThrow({ where: { id } }));
      requestId = execution.requestId;
      if (execution.status !== 'USAGE_PENDING' || execution.settlementLeaseUntil?.getTime() !== leaseUntil.getTime()) return;
      const frozenBilling = execution.billingSnapshot
        ? ModelBillingSnapshotSchema.parse(execution.billingSnapshot)
        : await this.credit.getLegacyBillingSnapshot(execution.modelId);
      const result = await waitForGatewayOperation(this.credit.chargeUsage({
        enterpriseId: execution.enterpriseId, userId: execution.userId,
        subscriptionId: execution.subscriptionId, employeeId: execution.employeeId,
        sessionId: 'gateway-execution', messageId: execution.id, modelId: execution.modelId,
        inputTokens: execution.inputTokens!, outputTokens: execution.outputTokens!,
        billingSnapshot: frozenBilling,
      }));
      const settled = await waitForGatewayOperation(this.prisma.gatewayExecution.updateMany({ where: owned, data: {
        status: 'SETTLED', usageRecordId: result.usageRecordId, settlementLeaseUntil: null,
      } }));
      if (!settled.count) return;
      this.logger.log({ event: 'gateway_settled', executionId: id, requestId: execution.requestId,
        usageRecordId: result.usageRecordId, alreadyCharged: result.alreadyCharged });
    } catch (error) {
      this.logger.error({ event: 'gateway_settlement_pending', executionId: id, requestId });
      // Timed-out operations may still commit: preserve ownership until lease expiry.
      if (error instanceof ServiceUnavailableException &&
          (error.getResponse() as { error?: { code?: string } }).error?.code === 'EXECUTION_JOURNAL_TIMEOUT') return;
      // Even if this update fails, the durable lease expires and another sweep can retry.
      await waitForGatewayOperation(this.prisma.gatewayExecution.updateMany({ where: owned, data: {
        settlementLeaseUntil: null, errorCode: 'SETTLEMENT_FAILED',
      } })).catch(() => undefined);
    }
  }

  @Cron('*/1 * * * *')
  async reconcile() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = new Date();
      const stale = await waitForGatewayOperation(this.prisma.gatewayExecution.updateMany({
        where: { status: 'STARTED', expiresAt: { lt: now } },
        data: { status: 'NEEDS_RECONCILIATION', errorCode: 'EXECUTION_EXPIRED_WITHOUT_USAGE' },
      }));
      if (stale.count) this.logger.warn({ event: 'gateway_reconciliation_required', count: stale.count });
      await waitForGatewayOperation(this.prisma.gatewayExecution.updateMany({
        where: { status: 'USAGE_PENDING', settlementReady: false, expiresAt: { lt: now } },
        data: { status: 'NEEDS_RECONCILIATION', errorCode: 'EXECUTION_EXPIRED_WITH_UNCONFIRMED_USAGE' },
      }));
      const pending = await waitForGatewayOperation(this.prisma.gatewayExecution.findMany({
        where: { status: 'USAGE_PENDING', settlementReady: true, OR: [{ settlementLeaseUntil: null }, { settlementLeaseUntil: { lt: now } }] },
        orderBy: { updatedAt: 'asc' }, take: 100, select: { id: true },
      }));
      for (const execution of pending) {
        await this.settle(execution.id).catch(() => this.logger.error({ event: 'gateway_settlement_unavailable', executionId: execution.id }));
      }
    } finally {
      this.sweeping = false;
    }
  }
}
