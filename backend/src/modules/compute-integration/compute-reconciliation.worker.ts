import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

@Injectable()
export class ComputeReconciliationWorker {
  private running = false;
  private readonly logger = new Logger(ComputeReconciliationWorker.name);
  constructor(private readonly prisma: PrismaService, private readonly remote: ComputeRemoteAdapter) {}

  @Cron('*/2 * * * *')
  async reconcile() {
    if (this.running || !this.remote.isConnected()) return;
    this.running = true;
    try {
      const bindings = await this.prisma.enterpriseComputeBinding.findMany({ where: { mode: 'ENTERPRISE', status: 'READY' }, orderBy: { updatedAt: 'asc' }, take: 10 });
      for (const binding of bindings) {
        try { await this.account(binding.enterpriseId); }
        catch (error) {
          const diagnostic = exceptionDetails(error);
          await this.prisma.enterpriseComputeBinding.update({ where: { enterpriseId: binding.enterpriseId }, data: {
            lastErrorCode: 'RECONCILIATION_PENDING', lastErrorMessage: JSON.stringify(diagnostic).slice(0, 2000) } });
          this.logger.warn({ event: 'compute_ledger_reconciliation_pending', enterpriseId: binding.enterpriseId, diagnostic });
        }
      }
    } finally { this.running = false; }
  }

  async account(enterpriseId: string) {
    // Any locally acknowledged receipt before the remote snapshot must be present in that snapshot.
    const [ackTransfers, ackSettlements] = await Promise.all([
      this.prisma.computeIntegrationTransfer.findMany({ where: { enterpriseId, status: 'COMMITTED' } }),
      this.prisma.computeIntegrationSettlement.findMany({ where: { enterpriseId, status: 'COMMITTED' } }),
    ]);
    const checkpoint = ackTransfers.every(row => row.remoteSequence) && ackSettlements.every(row => row.remoteSequence)
      ? await this.prisma.computeIntegrationReconciliation.findFirst({ where: { enterpriseId, status: 'MATCHED' }, orderBy: { createdAt: 'desc' } }) : null;
    const after = checkpoint?.sequence ?? '0';
    let page = await this.remote.ledger(enterpriseId, after, '0', 200);
    if (BigInt(page.snapshot_sequence) < BigInt(after)) throw new ConflictException('远端流水水位不能回退');
    const entries = [...page.items], sequence = page.snapshot_sequence;
    while (page.has_more) {
      page = await this.remote.ledger(enterpriseId, page.after_sequence, sequence, 200);
      entries.push(...page.items);
    }
    const [transfers, settlements, externalEvents] = await Promise.all([
      this.prisma.computeIntegrationTransfer.findMany({ where: { enterpriseId } }),
      this.prisma.computeIntegrationSettlement.findMany({ where: { enterpriseId } }),
      this.prisma.computeBalanceEvent.findMany({ where: { enterpriseId, origin: 'compute', status: 'APPLIED' } }),
    ]);
    const byTransfer = new Map(transfers.map(row => [row.businessId, row]));
    const bySettlement = new Map(settlements.map(row => [`settle_${row.id}`, row]));
    const externalById = new Map(externalEvents.map(row => [row.eventId, row]));
    const seen = new Set<string>(), consumedTransfers = new Set<string>();
    const consumption = new Map<string, { paid: Decimal; free: Decimal }>();
    const issues: string[] = [];
    let expected = new Decimal(checkpoint?.localBalanceCny ?? 0);
    for (const entry of entries) {
      if (seen.has(entry.ledger_entry_id)) { issues.push(`duplicate:${entry.ledger_entry_id}`); continue; }
      seen.add(entry.ledger_entry_id);
      const external = externalById.get(entry.ledger_entry_id);
      if (external) {
        if (external.type !== entry.type || external.sequence.toString() !== entry.sequence
          || !external.deltaCny.abs().eq(entry.amount_cny) || !new Decimal(entry.free_cny).isZero()) {
          issues.push(`external_event:${entry.ledger_entry_id}`); continue;
        }
        expected = expected.add(external.deltaCny);
        continue;
      }
      if (entry.type === 'credit_compute' || entry.type === 'debit_compute') {
        const local = byTransfer.get(entry.transfer_id);
        if (!local || local.direction !== entry.type || !local.amountCny.eq(entry.amount_cny) || !new Decimal(entry.free_cny).isZero()
          || consumedTransfers.has(entry.transfer_id) || local.status === 'FAILED') { issues.push(`transfer:${entry.transfer_id}`); continue; }
        consumedTransfers.add(entry.transfer_id);
        expected = entry.type === 'credit_compute' ? expected.add(local.amountCny) : expected.sub(local.amountCny);
      } else {
        const local = bySettlement.get(entry.settlement_id);
        if (!local || local.executionId !== entry.execution_id || !local.unpaidCny.isZero()) { issues.push(`settlement:${entry.settlement_id}`); continue; }
        const totals = consumption.get(entry.settlement_id) ?? { paid: new Decimal(0), free: new Decimal(0) };
        if (entry.type === 'paid_consumption') totals.paid = totals.paid.add(entry.amount_cny);
        else if (!new Decimal(entry.amount_cny).isZero()) issues.push(`free_amount:${entry.settlement_id}`);
        totals.free = totals.free.add(entry.free_cny);
        consumption.set(entry.settlement_id, totals);
      }
    }
    for (const [id, totals] of consumption) {
      const local = bySettlement.get(id)!;
      if (!local.paidCny.eq(totals.paid) || !local.freeCny.eq(totals.free)) issues.push(`split:${id}`);
      expected = expected.sub(local.paidCny);
    }
    for (const row of ackTransfers) if ((!row.remoteSequence || BigInt(row.remoteSequence) > BigInt(after) && BigInt(row.remoteSequence) <= BigInt(sequence)) && !seen.has(row.remoteLedgerId)) issues.push(`missing_transfer:${row.businessId}`);
    for (const row of ackSettlements) if ((!row.remoteSequence || BigInt(row.remoteSequence) > BigInt(after) && BigInt(row.remoteSequence) <= BigInt(sequence)) && !seen.has(row.remoteLedgerId)) issues.push(`missing_settlement:${row.id}`);
    const difference = expected.sub(page.total_paid_cny);
    const status = difference.isZero() && !issues.length ? 'MATCHED' : 'DIFFERENCE';
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${enterpriseId} FOR UPDATE`;
      const binding = await tx.enterpriseComputeBinding.findUnique({ where: { enterpriseId } });
      if (/^\d+$/.test(binding?.ledgerCursor ?? '') && BigInt(binding.ledgerCursor) > BigInt(sequence)) throw new ConflictException('已有更新的对账结果，本次旧快照不再提交');
      const row = await tx.computeIntegrationReconciliation.create({ data: { enterpriseId, businessId: `recon_${randomUUID()}`,
        ledgerCursor: sequence, sequence, localBalanceCny: expected, remoteBalanceCny: page.total_paid_cny,
        differenceCny: difference, status, details: { afterSequence: after, entries: entries.length, issues: issues.slice(0, 200) } } });
      await tx.enterpriseComputeBinding.update({ where: { enterpriseId }, data: { lastSyncedAt: new Date(), ...(status === 'MATCHED' ? { ledgerCursor: sequence } : {}) } });
      await tx.enterpriseComputeBinding.updateMany({ where: { enterpriseId, lastErrorCode: 'RECONCILIATION_PENDING' }, data: { lastErrorCode: null, lastErrorMessage: null } });
      return row;
    });
    if (status === 'DIFFERENCE') this.logger.error({ event: 'compute_ledger_difference', enterpriseId, sequence, differenceCny: difference.toFixed(6), issues });
    return result;
  }
}
