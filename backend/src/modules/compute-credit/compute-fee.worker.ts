import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeRemoteAdapter } from '../compute-integration/compute-remote.adapter';
import { ComputeAccountingService } from '../compute-integration/compute-accounting.service';
import { ComputeCreditService } from './compute-credit.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';
import { ComputeChatContextSchema } from '../compute-integration/compute-model-transport.service';

@Injectable()
export class ComputeFeeWorker {
  private readonly logger = new Logger(ComputeFeeWorker.name);
  constructor(private readonly prisma: PrismaService, private readonly remote: ComputeRemoteAdapter,
    private readonly accounting: ComputeAccountingService, private readonly credit: ComputeCreditService) {}

  @Cron('*/1 * * * *')
  async recover() {
    if (!this.remote.isConnected()) return;
    await this.credit.recoverUnpaidSettlements();
    const now = new Date();
    const eligible = { kind: 'FEE', OR: [{ status: 'PENDING' as const, nextRunAt: { lte: now } }, { status: 'RUNNING' as const, leaseUntil: { lte: now } }] };
    const jobs = await this.prisma.computeIntegrationJob.findMany({ where: eligible, orderBy: { nextRunAt: 'asc' }, take: 50 });
    for (const job of jobs) {
      const token = randomUUID();
      const claim = await this.prisma.computeIntegrationJob.updateMany({ where: { ...eligible, id: job.id },
        data: { status: 'RUNNING', leaseToken: token, leaseUntil: new Date(Date.now() + 120000), attempts: { increment: 1 } } });
      if (!claim.count) continue;
      try {
        const original = await this.prisma.computeIntegrationExecution.findUniqueOrThrow({ where: { id: job.businessId.replace(/^fee_/, '') } });
        if (original.enterpriseId !== job.enterpriseId || original.kind !== 'chat') throw new ConflictException('执行关联与费用查询任务不匹配');
        const context = ComputeChatContextSchema.parse(original.fundingContext);
        const { fee, usage, executionStatus } = await this.remote.executionEvidence(original.enterpriseId, original.id, 'chat', context.modelId);
        const execution = await this.accounting.recordFee(fee);
        if (execution.feeStatus !== 'FINAL') throw new ConflictException(`算力费用仍为 ${execution.feeStatus}`);
        const tokens = z.object({ input_tokens: z.number().int().min(0).max(2147483647).default(0),
          output_tokens: z.number().int().min(0).max(2147483647).default(0) }).parse(usage ?? {});
        const result = await this.credit.chargeUsage({ enterpriseId: execution.enterpriseId, userId: context.userId,
          subscriptionId: context.subscriptionId, employeeId: context.employeeId, modelId: context.modelId,
          sessionId: context.gatewayId ? 'gateway-execution' : context.sessionId ?? 'compute-execution',
          messageId: context.gatewayId ?? execution.id, inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens, computeExecutionId: execution.id });
        await this.prisma.$transaction(async tx => {
          const held = await tx.computeIntegrationJob.updateMany({ where: { id: job.id, status: 'RUNNING', leaseToken: token },
            data: { status: 'SUCCEEDED', leaseToken: null, leaseUntil: null, lastErrorCode: null, lastErrorMessage: null } });
          if (held.count) await tx.computeIntegrationExecution.update({ where: { id: execution.id }, data: { dispatchStatus: executionStatus.toUpperCase() } });
          if (held.count && context.gatewayId) await tx.gatewayExecution.update({ where: { id: context.gatewayId },
            data: { status: 'SETTLED', usageRecordId: result.usageRecordId, settlementLeaseUntil: null } });
        });
      } catch (error) {
        const diagnostic = exceptionDetails(error);
        await this.prisma.computeIntegrationJob.updateMany({ where: { id: job.id, status: 'RUNNING', leaseToken: token },
          data: { status: 'PENDING', leaseToken: null, leaseUntil: null, nextRunAt: new Date(Date.now() + 60000),
            lastErrorCode: 'FEE_RECONCILIATION_PENDING', lastErrorMessage: JSON.stringify(diagnostic).slice(0, 2000) } });
        this.logger.warn({ event: 'compute_fee_pending', executionId: job.businessId, diagnostic });
      }
    }
  }
}
