import { Decimal } from '@prisma/client/runtime/library';
import { ComputeBalanceEventSchema, type ComputeBalanceEventPayload } from 'shared';
import { ComputeBalanceSyncService } from './compute-balance-sync.service';

export function balanceEvent(patch: Partial<ComputeBalanceEventPayload> = {}): ComputeBalanceEventPayload {
  return { contract_version: 1, event_id: 'event1', enterprise_id: 'ent1', compute_account_id: 52,
    sequence: '1', origin: 'compute', type: 'compute_credit', currency: 'CNY', delta_cny: '1.000000',
    amount_cny: '1.000000', free_cny: '0.000000', available_paid_cny: '11.000000', frozen_paid_cny: '0.000000',
    business_ref: 'admin:1', transfer_id: null, execution_id: null, settlement_id: null,
    exchange_rate: '7.150000000000', occurred_at: '2026-11-23T10:00:00+08:00', ...patch };
}

function setup() {
  const rows = new Map<string, any>();
  const topUps: any[] = [];
  let state: any;
  const wallet = { id: 'wallet1', balance: new Decimal(20), computeReservedCNY: new Decimal(10), version: 0 };
  const db: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
    enterpriseComputeBinding: { findUnique: jest.fn().mockResolvedValue({ mode: 'ENTERPRISE', remoteAccountId: '52' }) },
    enterpriseMember: { findMany: jest.fn(async () => [...new Set(topUps.map(row => row.userId))].map(userId => ({ userId }))) },
    memberAllowanceTopUp: { findMany: jest.fn(async () => topUps), updateMany: jest.fn(async ({ where, data }) => {
      const row = topUps.find(item => item.id === where.id && item.version === where.version);
      if (!row) return { count: 0 };
      row.consumedCNY = row.consumedCNY.add(data.consumedCNY.increment); row.version++;
      return { count: 1 };
    }) },
    computeBalanceEvent: {
      findUnique: jest.fn(async ({ where }) => where.eventId ? rows.get(where.eventId) : [...rows.values()].find(row => row.enterpriseId === where.enterpriseId_sequence.enterpriseId && row.sequence === where.enterpriseId_sequence.sequence)),
      findUniqueOrThrow: jest.fn(async ({ where }) => rows.get(where.eventId)),
      create: jest.fn(async ({ data }) => { const row = { id: data.eventId, status: 'RECEIVED', outstandingCny: new Decimal(0), ...data, deltaCny: new Decimal(data.deltaCny) }; rows.set(data.eventId, row); return row; }),
      update: jest.fn(async ({ where, data }) => {
        const row = rows.get(where.id ?? where.eventId);
        const values = { ...data };
        if (data.outstandingCny?.decrement) values.outstandingCny = row.outstandingCny.sub(data.outstandingCny.decrement);
        return Object.assign(row, values);
      }),
      findMany: jest.fn(async ({ where }) => [...rows.values()].filter(row => row.enterpriseId === where.enterpriseId && (!where.status || row.status === where.status) && (!where.outstandingCny || row.outstandingCny.gt(0)) && (!('acknowledgedAt' in where) || !row.acknowledgedAt))),
    },
    computeBalanceSyncState: {
      upsert: jest.fn(async ({ create, update }) => state ? Object.assign(state, update) : state = { id: 'state1', sequence: 0n, baselineSequence: 0n, ...create }),
      findUnique: jest.fn(async () => state), update: jest.fn(async ({ data }) => Object.assign(state, data)),
    },
    enterpriseWallet: { upsert: jest.fn(async () => wallet), updateMany: jest.fn(async ({ data }) => {
      Object.assign(wallet, { balance: data.balance, computeReservedCNY: data.computeReservedCNY, version: wallet.version + 1 }); return { count: 1 };
    }) },
    walletTransaction: { create: jest.fn(async ({ data }) => data) },
    computeIntegrationTransfer: { findUnique: jest.fn(), aggregate: jest.fn().mockResolvedValue({ _sum: { amountCny: null } }) }, computeIntegrationSettlement: { findUnique: jest.fn() },
    computeIntegrationReconciliation: { findFirst: jest.fn() },
  };
  db.$transaction = jest.fn(async fn => {
    const snapshot = { wallet: { ...wallet }, state: state && { ...state }, rows: [...rows.entries()].map(([key, row]) => [key, { ...row }] as const), topUps: topUps.map(row => ({ ...row })) };
    try { return await fn(db); }
    catch (error) {
      Object.assign(wallet, snapshot.wallet); state = snapshot.state;
      rows.clear(); for (const [key, row] of snapshot.rows) rows.set(key, row);
      topUps.splice(0, topUps.length, ...snapshot.topUps);
      throw error;
    }
  });
  const remote: any = { acknowledgeBalanceEvent: jest.fn().mockResolvedValue({ status: 'applied' }), balanceEvents: jest.fn(), ledger: jest.fn() };
  return { db, rows, wallet, topUps, remote, service: new ComputeBalanceSyncService(db, remote) };
}

describe('Compute balance event accounting', () => {
  it('imports external credit only to public compute funds without a second bank deposit', async () => {
    const { service, wallet, db } = setup();
    await expect(service.receive(balanceEvent())).resolves.toEqual({ event_id: 'event1', status: 'applied' });
    expect(wallet.balance.toFixed(6)).toBe('21.000000'); expect(wallet.computeReservedCNY.toFixed(6)).toBe('11.000000');
    expect(db.enterpriseWallet.updateMany.mock.calls[0][0].data).not.toHaveProperty('totalDeposit');
    expect(db.walletTransaction.create.mock.calls[0][0].data).toMatchObject({ relatedType: 'compute_balance_event', type: 'ADJUSTMENT', metadata: { origin: 'compute', businessRef: 'admin:1' } });
    expect(db.enterpriseMember.findMany).not.toHaveBeenCalled(); expect(db.memberAllowanceTopUp.updateMany).not.toHaveBeenCalled();
  });

  it('applies repeated events once and rejects a changed payload using the same event id', async () => {
    const { service, db, wallet } = setup();
    await service.receive(balanceEvent()); await service.receive(balanceEvent());
    expect(wallet.computeReservedCNY.toFixed(6)).toBe('11.000000'); expect(db.walletTransaction.create).toHaveBeenCalledTimes(1);
    await expect(service.receive(balanceEvent({ business_ref: 'changed' }))).rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_CONFLICT' } });
  });

  it.each(['compute_debit', 'compute_refund', 'paid_consumption'] as const)('imports external %s from public funds', async type => {
    const { service, wallet, db } = setup();
    await service.receive(balanceEvent({ type, delta_cny: '-1.000000' }));
    expect(wallet.balance.toFixed(6)).toBe('19.000000'); expect(wallet.computeReservedCNY.toFixed(6)).toBe('9.000000');
    if (type === 'paid_consumption') expect(db.enterpriseWallet.updateMany.mock.calls[0][0].data.totalConsume.increment.toString()).toBe('1');
  });

  it('uses capped equal member shares after public funds and records the actual batches once', async () => {
    const { service, topUps, wallet, rows } = setup();
    topUps.push(...['2','10','20'].map((amount, i) => ({ id: `batch${i}`, userId: `member${i}`, amountCNY: new Decimal(amount), consumedCNY: new Decimal(0), version: 0 })));
    const event = balanceEvent({ type: 'paid_consumption', delta_cny: '-25.000000', amount_cny: '25.000000' });
    await service.receive(event); await service.receive(event);
    expect(wallet.balance.toString()).toBe('10'); expect(wallet.computeReservedCNY.toString()).toBe('0');
    expect(topUps.map(row => row.consumedCNY.toString())).toEqual(['2','6.5','6.5']);
    expect(rows.get('event1').outstandingCny.toString()).toBe('0');
    expect(rows.get('event1').allocation.memberDebits).toHaveLength(3);
  });

  it('records an uncovered external debit and consumes later compute credits to recover it without blocking sequence', async () => {
    const { service, wallet, rows } = setup();
    await service.receive(balanceEvent({ type: 'compute_debit', delta_cny: '-12.000000', amount_cny: '12.000000' }));
    expect(wallet.computeReservedCNY.toString()).toBe('0'); expect(wallet.balance.toString()).toBe('10');
    expect(rows.get('event1').outstandingCny.toString()).toBe('2');
    await service.receive(balanceEvent({ event_id: 'event2', sequence: '2', delta_cny: '3.000000', amount_cny: '3.000000' }));
    expect(rows.get('event1').outstandingCny.toString()).toBe('0');
    expect(wallet.computeReservedCNY.toString()).toBe('1'); expect(wallet.balance.toString()).toBe('11');
    expect((await service.status('ent1')).state.sequence).toBe('2');
  });

  it.each(['compute_debit', 'compute_refund', 'paid_consumption'] as const)('keeps employee funds separate when importing %s', async type => {
    const { service, db, wallet } = setup();
    const event = balanceEvent({ type, delta_cny: '-6.000000', amount_cny: '6.000000' });
    await service.receive(event); await service.receive(event);
    expect(wallet.balance.toString()).toBe('14'); expect(wallet.computeReservedCNY.toString()).toBe('4');
    expect(db.enterpriseMember.findMany).not.toHaveBeenCalled(); expect(db.memberAllowanceTopUp.findMany).not.toHaveBeenCalled();
    expect(db.memberAllowanceTopUp.updateMany).not.toHaveBeenCalled();
    expect(db.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(db.walletTransaction.create.mock.calls[0][0].data.amount.toString()).toBe('-6');
    expect(db.walletTransaction.create.mock.calls[0][0].data.metadata.memberDebits).toEqual([]);
  });

  it('rolls all funds back if the audit write fails, then recovers once', async () => {
    const { service, db, rows, wallet } = setup();
    db.walletTransaction.create.mockRejectedValueOnce(new Error('audit write unavailable'));
    const event = balanceEvent({ type: 'compute_debit', delta_cny: '-3.000000', amount_cny: '3.000000' });
    await expect(service.receive(event)).rejects.toThrow('audit write unavailable');
    expect(wallet.balance.toString()).toBe('20');
    expect(wallet.computeReservedCNY.toString()).toBe('10'); expect(rows.get('event1').status).toBe('RECEIVED');
    await service.receive(event);
    expect(wallet.computeReservedCNY.toString()).toBe('7'); expect(db.memberAllowanceTopUp.updateMany).not.toHaveBeenCalled();
  });

  it('does not spread SEP-origin paid receipts to other members', async () => {
    const { service, db } = setup();
    db.computeIntegrationSettlement.findUnique.mockResolvedValue({ id: 's1', enterpriseId: 'ent1', status: 'COMMITTED', remoteSequence: '1',
      remoteLedgerId: 'event1', unpaidCny: new Decimal(0), paidCny: new Decimal(1), freeCny: new Decimal(0) });
    await service.receive(balanceEvent({ origin: 'sep', type: 'paid_consumption', execution_id: 'exec1', settlement_id: 'settle_s1', delta_cny: '-1.000000' }));
    expect(db.enterpriseMember.findMany).not.toHaveBeenCalled(); expect(db.memberAllowanceTopUp.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a foreign account before persisting or acknowledging', async () => {
    const { service, db, remote } = setup();
    await expect(service.receive(balanceEvent({ compute_account_id: 53 }))).rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_ACCOUNT_MISMATCH' } });
    expect(db.computeBalanceEvent.create).not.toHaveBeenCalled(); expect(remote.acknowledgeBalanceEvent).not.toHaveBeenCalled();
  });

  it('retains out-of-order events, then applies them in sequence once earlier events arrive', async () => {
    const { service, wallet, db } = setup();
    const second = balanceEvent({ event_id: 'event2', sequence: '2' });
    await expect(service.receive(second)).rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_SEQUENCE_GAP' } });
    await service.receive(balanceEvent()); await service.receive(second);
    expect(wallet.computeReservedCNY.toFixed(6)).toBe('12.000000'); expect(db.walletTransaction.create).toHaveBeenCalledTimes(2);
  });

  it('does not apply SEP-origin transfer receipts a second time', async () => {
    const { service, wallet, db } = setup();
    db.computeIntegrationTransfer.findUnique.mockResolvedValue({ enterpriseId: 'ent1', direction: 'credit_compute', amountCny: new Decimal(1),
      status: 'COMMITTED', remoteLedgerId: 'event1', remoteSequence: '1', walletAction: 'RESERVE', localApplied: true });
    await service.receive(balanceEvent({ origin: 'sep', type: 'credit_compute', transfer_id: 'transfer1' }));
    expect(wallet.computeReservedCNY.toString()).toBe('10'); expect(db.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('does not acknowledge a SEP receipt until the original operation is confirmed', async () => {
    const { service, remote } = setup();
    await expect(service.receive(balanceEvent({ origin: 'sep', type: 'credit_compute', transfer_id: 'unknown' })))
      .rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_ORIGINAL_TRANSFER_PENDING' } });
    await expect(service.acknowledge('ent1', 'event1')).rejects.toThrow(); expect(remote.acknowledgeBalanceEvent).not.toHaveBeenCalled();
  });

  it.each([false, true])('matches paid/free original settlement receipts without charging again (free=%s)', async free => {
    const { service, db } = setup();
    db.computeIntegrationSettlement.findUnique.mockResolvedValue({ id: 's1', enterpriseId: 'ent1', status: 'COMMITTED', remoteSequence: '1',
      remoteLedgerId: 'event1', unpaidCny: new Decimal(0), paidCny: new Decimal(free ? 0 : 1), freeCny: new Decimal(free ? 1 : 0) });
    await service.receive(balanceEvent({ origin: 'sep', type: free ? 'free_record' : 'paid_consumption', execution_id: 'exec1', settlement_id: 'settle_s1',
      delta_cny: free ? '0.000000' : '-1.000000', amount_cny: free ? '0.000000' : '1.000000', free_cny: free ? '1.000000' : '0.000000' }));
    expect(db.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('matches both mixed settlement events against the final watermark and continues with a recharge', async () => {
    const { service, db, wallet, rows } = setup();
    db.computeIntegrationSettlement.findUnique.mockResolvedValue({ id: 's1', enterpriseId: 'ent1', status: 'COMMITTED', remoteSequence: '2',
      remoteLedgerId: 'event1', unpaidCny: new Decimal(0), paidCny: new Decimal('0.6'), freeCny: new Decimal('0.4') });
    const paid = balanceEvent({ origin: 'sep', type: 'paid_consumption', execution_id: 'exec1', settlement_id: 'settle_s1',
      delta_cny: '-0.600000', amount_cny: '0.600000', free_cny: '0.000000' });
    const free = balanceEvent({ event_id: 'event2', sequence: '2', origin: 'sep', type: 'free_record', execution_id: 'exec1', settlement_id: 'settle_s1',
      delta_cny: '0.000000', amount_cny: '0.000000', free_cny: '0.400000' });
    await service.receive(paid); await service.receive(free); await service.receive(paid); await service.receive(free);
    expect(wallet.computeReservedCNY.toString()).toBe('10'); expect(db.walletTransaction.create).not.toHaveBeenCalled();
    expect(rows.get('event1').status).toBe('APPLIED'); expect(rows.get('event2').status).toBe('APPLIED');
    await service.receive(balanceEvent({ event_id: 'event3', sequence: '3' }));
    expect(wallet.computeReservedCNY.toString()).toBe('11');
    expect((await service.status('ent1')).state.sequence).toBe('3');
  });

  it.each([
    { remoteSequence: '1' }, { remoteLedgerId: 'foreign' }, { paidCny: new Decimal('0.5') },
    { unpaidCny: new Decimal('0.1') }, { status: 'PENDING' },
  ])('keeps a mismatched mixed settlement pending: %j', async patch => {
    const { service, db, wallet } = setup();
    db.computeIntegrationSettlement.findUnique.mockResolvedValue({ id: 's1', enterpriseId: 'ent1', status: 'COMMITTED', remoteSequence: '2',
      remoteLedgerId: 'event1', unpaidCny: new Decimal(0), paidCny: new Decimal('0.6'), freeCny: new Decimal('0.4'), ...patch });
    await expect(service.receive(balanceEvent({ origin: 'sep', type: 'paid_consumption', execution_id: 'exec1', settlement_id: 'settle_s1',
      delta_cny: '-0.600000', amount_cny: '0.600000' })))
      .rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_ORIGINAL_SETTLEMENT_PENDING' } });
    expect(wallet.computeReservedCNY.toString()).toBe('10'); expect(db.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('retries a failed remote acknowledgement without repeating local funds mutation', async () => {
    const { service, remote, db } = setup();
    await service.receive(balanceEvent()); remote.acknowledgeBalanceEvent.mockRejectedValueOnce(new Error('network'));
    await expect(service.acknowledge('ent1', 'event1')).rejects.toMatchObject({ response: {
      code: 'COMPUTE_EVENT_ACK_PENDING', accounting_status: 'committed', event_status: 'applied', event_id: 'event1',
    } });
    await service.acknowledge('ent1', 'event1'); await service.acknowledge('ent1', 'event1');
    expect(remote.acknowledgeBalanceEvent).toHaveBeenCalledTimes(2); expect(db.walletTransaction.create).toHaveBeenCalledTimes(1);
  });

  it('prevents skipping events when setting a migration baseline', async () => {
    const { service, remote } = setup(); remote.balanceEvents.mockResolvedValue({ items: [{ sequence: '4' }] });
    await expect(service.initializeBaseline('ent1', '4')).rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_BASELINE_INVALID' } });
  });

  it('requires a matched historical snapshot before a nonzero baseline is admitted', async () => {
    const { service, remote } = setup(); remote.balanceEvents.mockResolvedValue({ items: [{ sequence: '4' }] });
    remote.ledger.mockResolvedValue({ snapshot_sequence: '3', total_paid_cny: '10.000000' });
    await expect(service.initializeBaseline('ent1', '3')).rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_BASELINE_NOT_RECONCILED' } });
  });

  it('sets only an explicitly matched historical baseline without touching funds', async () => {
    const { service, remote, db, wallet } = setup(); remote.balanceEvents.mockResolvedValue({ items: [{ sequence: '4' }] });
    remote.ledger.mockResolvedValue({ snapshot_sequence: '3', total_paid_cny: '10.000000' });
    db.computeIntegrationReconciliation.findFirst.mockResolvedValue({ localBalanceCny: new Decimal(10) });
    const status = await service.initializeBaseline('ent1', '3');
    expect(status.state.sequence).toBe('3'); expect(status.state.baselineSequence).toBe('3');
    expect(wallet.balance.toString()).toBe('20'); expect(db.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('recovers a paginated sequence and pending acknowledgements using the original events', async () => {
    const { service, remote, wallet } = setup();
    const first = balanceEvent(), second = balanceEvent({ event_id: 'event2', sequence: '2' });
    remote.balanceEvents.mockResolvedValueOnce({ items: [{ event_id: first.event_id, payload: first }], after_sequence: '1', has_more: true })
      .mockResolvedValueOnce({ items: [{ event_id: second.event_id, payload: second }], after_sequence: '2', has_more: false });
    const result = await service.sync('ent1');
    expect(result.state.sequence).toBe('2'); expect(wallet.computeReservedCNY.toString()).toBe('12');
    expect(remote.balanceEvents.mock.calls.map(call => call[1])).toEqual(['0', '1']);
    expect(remote.acknowledgeBalanceEvent).toHaveBeenCalledTimes(2);
  });

  it.each([
    { delta_cny: '-1.000000' }, { amount_cny: '1.00' }, { sequence: '0' },
    { origin: 'sep', type: 'compute_credit' }, { type: 'compute_credit', free_cny: '1.000000' },
  ])('rejects malformed money, direction or origin %j', patch => {
    expect(ComputeBalanceEventSchema.safeParse(balanceEvent(patch as any)).success).toBe(false);
  });
});
