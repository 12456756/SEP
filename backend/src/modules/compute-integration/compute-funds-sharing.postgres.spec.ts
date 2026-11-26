import { ConfigService } from '@nestjs/config';
import { Decimal } from '@prisma/client/runtime/library';
import { randomUUID } from 'node:crypto';
import type { ComputeBalanceEventPayload } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeBalanceSyncService } from './compute-balance-sync.service';
import { ComputeSpendingPolicyService } from './compute-spending-policy.service';
import { ComputeAccountingService } from './compute-accounting.service';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeFundsService } from './compute-funds.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { MemberAllowanceService } from '../compute-credit/member-allowance.service';
import { MemberAllowanceQueryService } from '../compute-credit/member-allowance-query.service';
import { WalletService } from '../wallet/wallet.service';
import { PersonalWalletService } from '../personal-wallet/personal-wallet.service';

const databaseUrl = process.env.COMPUTE_TEST_DATABASE_URL;
const isolated = databaseUrl ? describe : describe.skip;

isolated('Enterprise shared compute funds PostgreSQL transactions', () => {
  let db: PrismaService, sync: ComputeBalanceSyncService, policy: ComputeSpendingPolicyService;
  let integrations: ComputeIntegrationService, credit: ComputeCreditService;
  let enterpriseId: string, userIds: string[], accountId: number;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.port !== '25434' || url.pathname !== '/sep_compute_test') throw new Error('Dedicated local database only');
    db = new PrismaService({ datasourceUrl: databaseUrl });
    await db.$connect();
    const remote: any = { isConnected: () => true };
    policy = new ComputeSpendingPolicyService(db);
    integrations = new ComputeIntegrationService(db, new ConfigService({ JWT_SECRET: 'funds-fixture-only' }), remote, policy);
    const wallet = new WalletService(db, integrations, new ComputeFundsService(integrations));
    const personal = new PersonalWalletService(db);
    const allowance = new MemberAllowanceService(db, personal, wallet, new MemberAllowanceQueryService(db));
    credit = new ComputeCreditService(db, wallet, personal, {} as any, allowance, { afterCharge: jest.fn() } as any, {} as any, integrations);
    sync = new ComputeBalanceSyncService(db, remote);
  });
  afterAll(async () => { await db?.$disconnect(); });
  beforeEach(async () => {
    const stamp = randomUUID();
    const enterprise = await db.enterprise.create({ data: { name: `sharing-${stamp}`, members: { create: [0, 1, 2].map(index => ({
      role: index === 0 ? 'ENTERPRISE_ADMIN' as const : 'MEMBER' as const,
      user: { create: { email: `sharing-${stamp}-${index}@local.test` } },
    })) } }, include: { members: true } });
    enterpriseId = enterprise.id;
    userIds = enterprise.members.map(member => member.userId).sort();
    accountId = parseInt(stamp.replace(/-/g, '').slice(0, 12), 16);
    await db.enterpriseComputeBinding.create({ data: { enterpriseId, remoteAccountId: String(accountId), registrationRef: `reg_${stamp}`, mode: 'ENTERPRISE', status: 'READY' } });
    await db.enterpriseWallet.create({ data: { enterpriseId, balance: 100, computeReservedCNY: 10 } });
    await db.personalWallet.createMany({ data: userIds.map(userId => ({ userId, balance: 9 })) });
  });

  function event(sequence: number, delta: string): ComputeBalanceEventPayload {
    const amount = new Decimal(delta);
    return { contract_version: 1, event_id: `event_${enterpriseId}_${sequence}`, enterprise_id: enterpriseId, compute_account_id: accountId,
      sequence: String(sequence), origin: 'compute', type: amount.lt(0) ? 'paid_consumption' : 'compute_credit', currency: 'CNY',
      delta_cny: amount.toFixed(6), amount_cny: amount.abs().toFixed(6), free_cny: '0.000000',
      available_paid_cny: '0.000000', frozen_paid_cny: '0.000000', business_ref: `bill_${sequence}`,
      transfer_id: null, execution_id: null, settlement_id: null, exchange_rate: '7.150000000000', occurred_at: new Date().toISOString() };
  }
  async function addMembers(amounts: string[]) {
    await db.memberAllowanceTopUp.createMany({ data: amounts.map((amountCNY, index) => ({ enterpriseId, userId: userIds[index], amountCNY })) });
  }
  async function remaining() {
    const rows = await db.memberAllowanceTopUp.findMany({ where: { enterpriseId }, orderBy: { userId: 'asc' } });
    return rows.map(row => row.amountCNY.sub(row.consumedCNY).toFixed(6));
  }

  it('deduplicates concurrent events, redistributes capped shares, and preserves personal balances', async () => {
    await addMembers(['2', '10', '20']);
    const value = event(1, '-25');
    await Promise.all(Array.from({ length: 12 }, () => sync.receive(value)));
    expect(await remaining()).toEqual(['0.000000', '3.500000', '13.500000']);
    const summary = await policy.summary(enterpriseId);
    expect(summary).toMatchObject({ totalBalanceCny: '17.000000', unallocatedCny: '0.000000', memberBalanceCny: '17.000000', syncShortfallCny: '0.000000' });
    expect((await db.enterpriseWallet.findUniqueOrThrow({ where: { enterpriseId } })).balance.toString()).toBe('90');
    expect(await db.walletTransaction.count({ where: { relatedId: value.event_id } })).toBe(1);
    expect((await db.personalWallet.findMany({ where: { userId: { in: userIds } } })).every(row => row.balance.eq(9))).toBe(true);
  });

  it('recovers existing gaps from later local funds once, without another remote debit', async () => {
    await sync.receive(event(1, '-12'));
    await expect(db.$transaction(tx => policy.assertCanSpend(tx, enterpriseId))).rejects.toMatchObject({ response: { code: 'COMPUTE_BILL_OUTSTANDING' } });
    expect(await integrations.hasOpenAccounting(enterpriseId)).toBe(true);
    expect((await policy.summary(enterpriseId)).generationPaused).toBe(true);
    await db.enterpriseWallet.update({ where: { enterpriseId }, data: { balance: { increment: 1 }, computeReservedCNY: 1 } });
    await Promise.all([sync.recoverOutstanding(enterpriseId), sync.recoverOutstanding(enterpriseId)]);
    expect((await policy.summary(enterpriseId)).syncShortfallCny).toBe('1.000000');
    await addMembers(['0.3', '0.2', '0.5']);
    await sync.recoverOutstanding(enterpriseId);
    await sync.recoverOutstanding(enterpriseId);
    expect(await remaining()).toEqual(['0.000000', '0.000000', '0.000000']);
    expect((await policy.summary(enterpriseId)).syncShortfallCny).toBe('0.000000');
    expect((await policy.summary(enterpriseId)).generationPaused).toBe(false);
    expect(await db.walletTransaction.count({ where: { relatedType: 'compute_balance_recovery', relatedId: event(1, '-12').event_id } })).toBe(2);
    await expect(db.$transaction(tx => policy.assertCanSpend(tx, enterpriseId))).resolves.toBeUndefined();
  });

  it('allows original execution recovery while pausing all three new generation entrances', async () => {
    const credentials = await Promise.all(['chat', 'image', 'video'].map(kind => db.enterpriseComputeCredential.create({ data: {
      enterpriseId, kind, remoteId: `key_${enterpriseId}_${kind}`, version: 1, encryptedKey: 'fixture', maskedKey: '****fixture',
    } })));
    const accounting = new ComputeAccountingService(db, policy);
    const original = await accounting.createExecution({ enterpriseId, sourceRef: randomUUID(), kind: 'chat', credentialId: credentials[0].id });
    await sync.receive(event(1, '-12'));
    const replay = await accounting.createExecution({ enterpriseId, sourceRef: original.sourceRef, kind: 'chat', credentialId: credentials[0].id });
    expect(replay.id).toBe(original.id);
    for (const credential of credentials) await expect(accounting.createExecution({ enterpriseId, sourceRef: randomUUID(),
      kind: credential.kind as 'chat' | 'image' | 'video', credentialId: credential.id }))
      .rejects.toMatchObject({ response: { code: 'COMPUTE_BILL_OUTSTANDING' } });
    await sync.receive(event(2, '3'));
    expect((await policy.summary(enterpriseId))).toMatchObject({ unallocatedCny: '1.000000', syncShortfallCny: '0.000000' });
    await expect(accounting.createExecution({ enterpriseId, sourceRef: randomUUID(), kind: 'image', credentialId: credentials[1].id })).resolves.toHaveProperty('id');
  });

  it('does not consume locked release funds or media-held member money twice', async () => {
    await addMembers(['10', '0', '0']);
    await db.memberAllowanceTopUp.updateMany({ where: { enterpriseId, userId: userIds[0] }, data: { consumedCNY: 9 } });
    await db.computeIntegrationTransfer.create({ data: { enterpriseId, businessId: randomUUID(), direction: 'debit_compute',
      amountCny: 8, fundingRef: 'test', walletAction: 'RELEASE', localApplied: false } });
    await sync.receive(event(1, '-5'));
    const summary = await policy.summary(enterpriseId);
    expect(summary.unallocatedCny).toBe('8.000000');
    expect(summary.syncShortfallCny).toBe('2.000000');
    expect(await remaining()).toEqual(['0.000000', '0.000000', '0.000000']);
  });

  it('serializes normal chat charges with independent consumption and recovers only the original unpaid usage', async () => {
    await addMembers(['4', '4', '4']);
    await db.personalWallet.update({ where: { userId: userIds[0] }, data: { balance: 0 } });
    const execution = await db.computeIntegrationExecution.create({ data: { enterpriseId, sourceRef: randomUUID(), kind: 'chat',
      credentialId: 'fixture', credentialVersion: 1, remoteAccountId: String(accountId), feeStatus: 'FINAL',
      grossCny: 5, billId: `bill_${randomUUID()}`, billVersion: 1 } });
    const charge = () => credit.chargeUsage({ enterpriseId, userId: userIds[0], modelId: 'fixture', sessionId: 'fixture',
      messageId: execution.id, inputTokens: 1, outputTokens: 1, computeExecutionId: execution.id });
    const debit = event(1, '-12');
    await Promise.all([sync.receive(debit), charge(), charge(), sync.receive(debit)]);
    const original = await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { executionId: execution.id } });
    expect(original.unpaidCny.gt(0)).toBe(true);
    await db.memberAllowanceTopUp.create({ data: { enterpriseId, userId: userIds[0], amountCNY: 10 } });
    await Promise.all(Array.from({ length: 5 }, () => (credit as any).recoverUnpaidSettlement(original.id, execution.id)));
    const recovered = await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { id: original.id } });
    expect(recovered).toMatchObject({ status: 'LOCAL_CONFIRMED', billId: original.billId, executionId: execution.id });
    expect(recovered.paidCny.toFixed(6)).toBe('5.000000'); expect(recovered.unpaidCny.isZero()).toBe(true);
    const usage = await charge();
    expect(usage.alreadyCharged).toBe(true); expect(usage.unpaidCNY.isZero()).toBe(true);
    expect(await db.computeUsageRecord.count({ where: { enterpriseId } })).toBe(1);
    expect(await db.computeIntegrationJob.count({ where: { businessId: `settle_${original.id}` } })).toBe(1);
    expect((await policy.summary(enterpriseId)).totalBalanceCny).toBe('15.000000');
    const batches = await db.memberAllowanceTopUp.findMany({ where: { enterpriseId } });
    expect(batches.every(row => row.consumedCNY.gte(0) && row.consumedCNY.lte(row.amountCNY))).toBe(true);
  });

  it('rolls member debits back with the audit record and retains a retryable event', async () => {
    await addMembers(['1', '2', '3']);
    const failingDb = new Proxy(db, { get(target, name) {
      if (name === '$transaction') return (fn: any) => target.$transaction(tx => fn(new Proxy(tx, { get(client, delegate) {
        if (delegate === 'walletTransaction') return { create: () => { throw new Error('audit unavailable'); } };
        return Reflect.get(client, delegate);
      } })));
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const value = event(1, '-15');
    await expect(new ComputeBalanceSyncService(failingDb, {} as any).receive(value)).rejects.toThrow('audit unavailable');
    expect(await remaining()).toEqual(['1.000000', '2.000000', '3.000000']);
    expect((await policy.summary(enterpriseId)).unallocatedCny).toBe('10.000000');
    expect((await db.computeBalanceEvent.findUniqueOrThrow({ where: { eventId: value.event_id } })).status).toBe('RECEIVED');
    await sync.receive(value);
    expect((await policy.summary(enterpriseId)).totalBalanceCny).toBe('1.000000');
  });
});
