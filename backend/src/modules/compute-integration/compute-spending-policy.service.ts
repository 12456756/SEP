import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ComputeSpendingPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  private blockers(tx: Prisma.TransactionClient, enterpriseId: string) {
    return Promise.all([
      tx.computeBalanceEvent.count({ where: { enterpriseId, OR: [{ outstandingCny: { gt: 0 } }, { status: 'RECEIVED' }] } }),
      tx.computeIntegrationSettlement.count({ where: { enterpriseId, status: 'UNPAID' } }),
      tx.computeIntegrationJob.count({ where: { enterpriseId, kind: 'SETTLEMENT', status: { not: 'SUCCEEDED' },
        lastErrorCode: { in: ['INSUFFICIENT_PAID_FUNDS', 'ENTERPRISE_BILL_OUTSTANDING'] } } }),
    ]);
  }

  async assertCanSpend(tx: Prisma.TransactionClient, enterpriseId: string) {
    if ((await this.blockers(tx, enterpriseId)).some(Boolean)) throw new ConflictException({ code: 'COMPUTE_BILL_OUTSTANDING',
      message: '企业存在未结清费用或尚未处理的余额事件，新增生成暂缓；请补足算力资金并等待原单恢复，不要重新生成原任务',
      accounting_status: 'pending', retryable: true, next_action: 'fund_compute_then_reconcile_original_bill' });
  }

  async summary(enterpriseId: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${enterpriseId} FOR UPDATE`;
      const [wallet, members, gaps, localUnpaid, pending, state, blockers] = await Promise.all([
        tx.enterpriseWallet.findUnique({ where: { enterpriseId } }),
        tx.memberAllowanceTopUp.aggregate({ where: { enterpriseId }, _sum: { amountCNY: true, consumedCNY: true } }),
        tx.computeBalanceEvent.aggregate({ where: { enterpriseId }, _sum: { outstandingCny: true } }),
        tx.computeIntegrationSettlement.aggregate({ where: { enterpriseId, status: 'UNPAID' }, _sum: { unpaidCny: true } }),
        tx.computeIntegrationSettlement.aggregate({ where: { enterpriseId, status: 'LOCAL_CONFIRMED' }, _sum: { paidCny: true } }),
        tx.computeBalanceSyncState.findUnique({ where: { enterpriseId } }),
        this.blockers(tx, enterpriseId),
      ]);
      const unallocated = new Decimal(wallet?.computeReservedCNY ?? 0);
      const allocated = new Decimal(members._sum.amountCNY ?? 0).sub(members._sum.consumedCNY ?? 0);
      return { totalBalanceCny: unallocated.add(allocated).toFixed(6), unallocatedCny: unallocated.toFixed(6),
        generationPaused: blockers.some(Boolean),
        memberBalanceCny: allocated.toFixed(6), syncShortfallCny: new Decimal(gaps._sum.outstandingCny ?? 0).toFixed(6),
        localUnpaidCny: new Decimal(localUnpaid._sum.unpaidCny ?? 0).toFixed(6),
        pendingSettlementCny: new Decimal(pending._sum.paidCny ?? 0).toFixed(6),
        remoteAvailableCny: state?.remoteAvailableCny?.toFixed(6) ?? null, remoteFrozenCny: state?.remoteFrozenCny?.toFixed(6) ?? null,
        sequence: state?.sequence.toString() ?? '0', observedAt: state?.lastPolledAt?.toISOString() ?? null,
        checkedAt: state?.updatedAt.toISOString() ?? null };
    });
  }
}
