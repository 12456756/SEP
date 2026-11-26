import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ComputeSpendingPolicyService } from './compute-spending-policy.service';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ComputeExecutionContextSchema, ComputeExecutionFeeSchema, ComputeReconciliationSchema,
  type ComputeExecutionContext, type ComputeExecutionFee, type ComputeReconciliation } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';

/** Local contract boundary. It never calculates prices, moves funds or calls the remote platform. */
@Injectable()
export class ComputeAccountingService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly spending?: ComputeSpendingPolicyService) {}

  private async lock(tx: Prisma.TransactionClient, enterpriseId: string) {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${enterpriseId} FOR UPDATE`;
    if (rows[0]?.status !== 'ACTIVE') throw new ConflictException('企业状态不允许处理新模式账务');
  }

  async createExecution(raw: ComputeExecutionContext) {
    const parsed = ComputeExecutionContextSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('执行关联参数无效');
    const value = parsed.data;
    return this.prisma.$transaction(async tx => {
      await this.lock(tx, value.enterpriseId);
      const existing = await tx.computeIntegrationExecution.findUnique({ where: { enterpriseId_kind_sourceRef: {
        enterpriseId: value.enterpriseId, kind: value.kind, sourceRef: value.sourceRef,
      } } });
      if (existing) {
        if (existing.credentialId !== value.credentialId) throw new ConflictException('原执行关联的凭证不能更改');
        return existing;
      }
      await this.spending?.assertCanSpend(tx, value.enterpriseId);
      const binding = await tx.enterpriseComputeBinding.findUnique({ where: { enterpriseId: value.enterpriseId } });
      const credential = await tx.enterpriseComputeCredential.findFirst({ where: {
        id: value.credentialId, enterpriseId: value.enterpriseId, kind: value.kind, active: true,
      } });
      if (!binding?.remoteAccountId || binding.status !== 'READY') throw new ConflictException('企业账号或用途凭证未就绪');
      if (!credential) throw new ConflictException({ code: 'CREDENTIAL_VERSION_CONFLICT', message: '企业凭证已更换，请使用当前版本；原请求尚未发送' });
      return tx.computeIntegrationExecution.create({ data: { enterpriseId: value.enterpriseId, sourceRef: value.sourceRef,
        kind: value.kind, credentialId: value.credentialId, remoteAccountId: binding.remoteAccountId, credentialVersion: credential.version } });
    });
  }

  async recordFee(raw: ComputeExecutionFee) {
    const parsed = ComputeExecutionFeeSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('实际费用必须为算力平台确认的人民币金额或明确的待确认状态');
    const value = parsed.data;
    return this.prisma.$transaction(async tx => {
      await this.lock(tx, value.enterpriseId);
      const execution = await tx.computeIntegrationExecution.findUnique({ where: { id: value.executionId } });
      if (!execution || execution.enterpriseId !== value.enterpriseId) throw new NotFoundException('执行记录不存在');
      if ((execution.computeRequestId && execution.computeRequestId !== value.computeRequestId)
        || (execution.taskId && value.taskId && execution.taskId !== value.taskId)) throw new ConflictException('执行对应远端请求或任务编号冲突');
      if (execution.feeStatus === 'FINAL') {
        if (value.status !== 'FINAL' || execution.billId !== value.billId || execution.billVersion !== value.billVersion
          || !execution.grossCny?.eq(value.grossCny)) throw new ConflictException('已经确认的实际费用不能改写或退回待确认');
        return execution;
      }
      return tx.computeIntegrationExecution.update({ where: { id: value.executionId }, data: {
        computeRequestId: value.computeRequestId, ...(value.taskId ? { taskId: value.taskId } : {}), feeStatus: value.status,
        ...(value.status === 'FINAL' ? { billId: value.billId, billVersion: value.billVersion, grossCny: value.grossCny } : {}),
      } });
    });
  }

  async reconcile(raw: ComputeReconciliation) {
    const parsed = ComputeReconciliationSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('对账参数无效');
    const value = parsed.data;
    if (value.localSequence !== value.remoteSequence) throw new ConflictException('两边流水水位不同，暂不能比较余额');
    return this.prisma.$transaction(async tx => {
      await this.lock(tx, value.enterpriseId);
      const existing = await tx.computeIntegrationReconciliation.findUnique({ where: { businessId: value.businessId } });
      if (existing) {
        if (existing.enterpriseId !== value.enterpriseId || existing.ledgerCursor !== value.ledgerCursor || existing.sequence !== value.remoteSequence
          || !existing.localBalanceCny.eq(value.localBalanceCny) || !existing.remoteBalanceCny.eq(value.remoteBalanceCny)) throw new ConflictException('原对账编号对应内容冲突');
        return existing;
      }
      const latest = await tx.computeIntegrationReconciliation.findFirst({ where: { enterpriseId: value.enterpriseId, status: 'MATCHED' }, orderBy: { createdAt: 'desc' } });
      if (latest && BigInt(latest.sequence) > BigInt(value.remoteSequence)) throw new ConflictException('不能用旧水位回退已核对的账务游标');
      const difference = new Decimal(value.localBalanceCny).minus(value.remoteBalanceCny);
      const row = await tx.computeIntegrationReconciliation.create({ data: {
        enterpriseId: value.enterpriseId, businessId: value.businessId, ledgerCursor: value.ledgerCursor, sequence: value.remoteSequence,
        localBalanceCny: value.localBalanceCny, remoteBalanceCny: value.remoteBalanceCny, differenceCny: difference,
        status: difference.isZero() ? 'MATCHED' : 'DIFFERENCE',
      } });
      // Only matching snapshots advance the reconciliation cursor. A difference never adjusts either balance.
      if (row.status === 'MATCHED') await tx.enterpriseComputeBinding.update({ where: { enterpriseId: value.enterpriseId }, data: { ledgerCursor: value.ledgerCursor } });
      return row;
    });
  }
}
