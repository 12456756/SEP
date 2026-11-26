import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, WalletTransactionType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ComputeIntegrationService } from './compute-integration.service';

@Injectable()
export class ComputeFundsService {
  constructor(private readonly integration: ComputeIntegrationService) {}

  async availableReserve(tx: Prisma.TransactionClient, enterpriseId: string, reserved: Decimal) {
    if (!await this.integration.isEnterpriseMode(enterpriseId, tx)) return reserved;
    if (await tx.computeIntegrationTransfer.count({ where: { enterpriseId, walletAction: 'INITIAL', status: { not: 'COMMITTED' } } })) return new Decimal(0);
    const pending = await tx.computeIntegrationTransfer.aggregate({ where: { enterpriseId, walletAction: { in: ['RESERVE', 'RELEASE'] }, localApplied: false }, _sum: { amountCny: true } });
    return Decimal.max(0, reserved.sub(pending._sum.amountCny ?? 0));
  }

  async record(tx: Prisma.TransactionClient, enterpriseId: string, transactionId: string, amount: Decimal, action: 'RESERVE' | 'RELEASE') {
    const transfer = await this.integration.recordTransfer(tx, { enterpriseId, businessId: `wallet_${transactionId}`,
      direction: action === 'RESERVE' ? 'credit_compute' : 'debit_compute', currency: 'CNY', amountCny: amount.toFixed(6), fundingRef: transactionId });
    await tx.computeIntegrationTransfer.update({ where: { id: transfer.id }, data: { walletAction: action } });
    return transfer;
  }

  async finalize(tx: Prisma.TransactionClient, transferId: string, committed: boolean) {
    const row = await tx.computeIntegrationTransfer.findUniqueOrThrow({ where: { id: transferId } });
    if (!row.walletAction || row.localApplied) return;
    await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${row.enterpriseId} FOR UPDATE`;
    const claimed = await tx.computeIntegrationTransfer.updateMany({ where: { id: row.id, localApplied: false }, data: { localApplied: true } });
    if (!claimed.count) return;
    if (row.walletAction === 'INITIAL') return;
    if (row.walletAction === 'RESERVE' && committed || row.walletAction === 'RELEASE' && !committed) return;
    const wallet = await tx.enterpriseWallet.findUniqueOrThrow({ where: { enterpriseId: row.enterpriseId } });
    if (wallet.computeReservedCNY.lt(row.amountCny)) throw new ConflictException('划转对应的本地锁定金额不足');
    await tx.enterpriseWallet.update({ where: { id: wallet.id }, data: { computeReservedCNY: { decrement: row.amountCny }, version: { increment: 1 } } });
    await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.COMPUTE_RELEASE,
      amount: row.amountCny.neg(), balanceBefore: wallet.balance, balanceAfter: wallet.balance,
      relatedType: 'compute_transfer', relatedId: row.businessId,
      description: committed ? '算力划回已确认' : '算力划入被拒绝，解除原锁定' } });
  }
}
