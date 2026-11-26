import { Decimal } from '@prisma/client/runtime/library';
import { ComputeReconciliationWorker } from './compute-reconciliation.worker';

describe('Remote ledger reconciliation evidence', () => {
  function setup() {
    const transfer = { businessId: 'transfer1', direction: 'credit_compute', amountCny: new Decimal(10), status: 'COMMITTED', remoteLedgerId: 'ledger1' };
    const settlement = { id: 'settlement1', executionId: 'exec1', paidCny: new Decimal(3), freeCny: new Decimal(2), unpaidCny: new Decimal(0), status: 'COMMITTED', remoteLedgerId: 'ledger2' };
    const db: any = { computeBalanceEvent: { findMany: jest.fn().mockResolvedValue([]) }, computeIntegrationTransfer: { findMany: jest.fn().mockResolvedValue([transfer]) },
      computeIntegrationSettlement: { findMany: jest.fn().mockResolvedValue([settlement]) },
      computeIntegrationReconciliation: { create: jest.fn(async ({ data }) => data) },
      enterpriseComputeBinding: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn().mockResolvedValue({ ledgerCursor: null }) }, $queryRaw: jest.fn() };
    db.$transaction = (fn: any) => fn(db);
    const entries = [{ ledger_entry_id: 'ledger1', type: 'credit_compute', transfer_id: 'transfer1', amount_cny: '10.000000', free_cny: '0.000000' },
      { ledger_entry_id: 'ledger2', type: 'paid_consumption', settlement_id: 'settle_settlement1', execution_id: 'exec1', amount_cny: '3.000000', free_cny: '0.000000' },
      { ledger_entry_id: 'ledger3', type: 'free_record', settlement_id: 'settle_settlement1', execution_id: 'exec1', amount_cny: '0.000000', free_cny: '2.000000' }];
    const remote: any = { ledger: jest.fn().mockResolvedValue({ items: entries, snapshot_sequence: '3', after_sequence: '3', has_more: false, total_paid_cny: '7.000000' }) };
    return { db, remote, entries, worker: new ComputeReconciliationWorker(db, remote) };
  }

  it('matches paid balance and the free record independently without charging free money', async () => {
    const { worker } = setup();
    expect(await worker.account('ent1')).toMatchObject({ status: 'MATCHED', localBalanceCny: new Decimal(7), differenceCny: new Decimal(0) });
  });
  it('reports a free-right mismatch even when paid balances are equal', async () => {
    const { worker, entries, db } = setup(); entries[2].free_cny = '1.000000';
    expect(await worker.account('ent1')).toMatchObject({ status: 'DIFFERENCE', differenceCny: new Decimal(0) });
    expect(db.enterpriseComputeBinding.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ ledgerCursor: expect.anything() }) }));
  });
  it('does not treat an unrecognized credit or missing acknowledged receipt as a matching account', async () => {
    const { worker, entries } = setup(); entries[0].transfer_id = 'unknown-transfer';
    expect((await worker.account('ent1')).status).toBe('DIFFERENCE');
  });
  it('keeps every page on the original snapshot when money changes during pagination', async () => {
    const { worker, entries, remote } = setup();
    remote.ledger.mockReset().mockResolvedValueOnce({ items: entries.slice(0, 1), snapshot_sequence: '3', after_sequence: '1', has_more: true, total_paid_cny: '7.000000' })
      .mockResolvedValueOnce({ items: entries.slice(1), snapshot_sequence: '3', after_sequence: '3', has_more: false, total_paid_cny: '7.000000' });
    expect((await worker.account('ent1')).status).toBe('MATCHED');
    expect(remote.ledger.mock.calls[1]).toEqual(['ent1', '1', '3', 200]);
  });

  it('continues from a confirmed watermark without adding historical credits or consumption twice', async () => {
    const { worker, db, remote } = setup();
    const oldTransfer = (await db.computeIntegrationTransfer.findMany())[0]; oldTransfer.remoteSequence = '1';
    const oldSettlement = (await db.computeIntegrationSettlement.findMany())[0]; oldSettlement.remoteSequence = '3';
    db.computeIntegrationTransfer.findMany.mockResolvedValue([oldTransfer, { businessId: 'transfer2', direction: 'credit_compute',
      amountCny: new Decimal(2), status: 'COMMITTED', remoteLedgerId: 'ledger4', remoteSequence: '4' }]);
    db.computeIntegrationReconciliation.findFirst = jest.fn().mockResolvedValue({ sequence: '3', localBalanceCny: new Decimal(7) });
    remote.ledger.mockResolvedValue({ items: [{ ledger_entry_id: 'ledger4', type: 'credit_compute', transfer_id: 'transfer2', amount_cny: '2.000000', free_cny: '0.000000' }],
      snapshot_sequence: '4', after_sequence: '4', has_more: false, total_paid_cny: '9.000000' });
    expect(await worker.account('ent1')).toMatchObject({ status: 'MATCHED', localBalanceCny: new Decimal(9) });
    expect(remote.ledger).toHaveBeenCalledWith('ent1', '3', '0', 200);
  });

  it('does not let an older worker overwrite a newer matched watermark', async () => {
    const { worker, db } = setup(); db.enterpriseComputeBinding.findUnique.mockResolvedValue({ ledgerCursor: '5' });
    await expect(worker.account('ent1')).rejects.toThrow('旧快照');
    expect(db.computeIntegrationReconciliation.create).not.toHaveBeenCalled();
  });

  it('includes imported compute-origin credits and direct consumption in the expected balance', async () => {
    const { worker, db, remote, entries } = setup();
    entries.push({ ledger_entry_id: 'external1', type: 'compute_credit', sequence: '4', amount_cny: '2.000000', free_cny: '0.000000' } as any);
    entries.push({ ledger_entry_id: 'external2', type: 'paid_consumption', sequence: '5', amount_cny: '1.000000', free_cny: '0.000000' } as any);
    db.computeBalanceEvent.findMany.mockResolvedValue([
      { eventId: 'external1', sequence: 4n, type: 'compute_credit', deltaCny: new Decimal(2) },
      { eventId: 'external2', sequence: 5n, type: 'paid_consumption', deltaCny: new Decimal(-1) },
    ]);
    remote.ledger.mockResolvedValue({ items: entries, snapshot_sequence: '5', after_sequence: '5', has_more: false, total_paid_cny: '8.000000' });
    expect(await worker.account('ent1')).toMatchObject({ status: 'MATCHED', differenceCny: new Decimal(0) });
  });
});
