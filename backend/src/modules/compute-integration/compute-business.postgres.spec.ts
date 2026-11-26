import { ConfigService } from '@nestjs/config';
import { Decimal } from '@prisma/client/runtime/library';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeFundsService } from './compute-funds.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { MemberAllowanceService } from '../compute-credit/member-allowance.service';
import { MemberAllowanceQueryService } from '../compute-credit/member-allowance-query.service';
import { WalletService } from '../wallet/wallet.service';
import { PersonalWalletService } from '../personal-wallet/personal-wallet.service';
import { MediaRealBillingService } from '../media-gateway/media-real-billing.service';
import { ComputeIntegrationWorker } from './compute-integration.worker';
import { encryptSecret } from '../../common/crypto/secret-cipher';

const databaseUrl = process.env.COMPUTE_TEST_DATABASE_URL;
const isolated = databaseUrl ? describe : describe.skip;

isolated('Enterprise compute real money transactions', () => {
  let db: PrismaService, integrations: ComputeIntegrationService, funds: ComputeFundsService;
  let wallet: WalletService, credit: ComputeCreditService, billing: MediaRealBillingService;
  const remote: any = { isConnected: () => true };
  let enterpriseId: string, userId: string, memberId: string, employeeId: string, subscriptionId: string;
  const modelBilling = { getSnapshot: jest.fn(() => { throw new Error('New mode must not use local prices'); }) };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.port !== '25434' || url.pathname !== '/sep_compute_test') throw new Error('Dedicated local database only');
    db = new PrismaService({ datasourceUrl: databaseUrl });
    await db.$connect();
    integrations = new ComputeIntegrationService(db, new ConfigService({ JWT_SECRET: 'local-business-fixture-only' }), remote);
    funds = new ComputeFundsService(integrations);
    wallet = new WalletService(db, integrations, funds);
    const personal = new PersonalWalletService(db);
    const allowance = new MemberAllowanceService(db, personal, wallet, new MemberAllowanceQueryService(db));
    credit = new ComputeCreditService(db, wallet, personal, {} as any, allowance, { afterCharge: jest.fn() } as any, modelBilling as any, integrations);
    billing = new MediaRealBillingService(db, integrations);
  });
  afterAll(async () => { await db?.$disconnect(); });

  beforeEach(async () => {
    const stamp = randomUUID();
    const company = await db.enterprise.create({ data: { name: `business-${stamp}`, members: { create: {
      role: 'ENTERPRISE_ADMIN', user: { create: { email: `business-${stamp}@local.test` } },
    } } }, include: { members: true } });
    enterpriseId = company.id; userId = company.members[0].userId; memberId = company.members[0].id;
    await db.enterpriseComputeBinding.create({ data: { enterpriseId, remoteAccountId: stamp, registrationRef: `reg_${stamp}`, mode: 'ENTERPRISE', status: 'READY' } });
    const employee = await db.digitalEmployee.create({ data: { name: `fixture-${stamp}`, description: 'test', industry: 'test', position: 'test', systemPrompt: 'test' } });
    employeeId = employee.id;
    const subscription = await db.subscription.create({ data: { enterpriseId, employeeId, templateVersion: '1' } });
    subscriptionId = subscription.id;
    await db.subscriptionCredit.create({ data: { enterpriseId, employeeId, subscriptionId, grantedCNY: '0.300000' } });
    await db.enterpriseWallet.create({ data: { enterpriseId, balance: 10 } });
    await db.personalWallet.create({ data: { userId, balance: 2 } });
  });

  async function execution(gross = '0.150000', kind = 'chat') {
    return db.computeIntegrationExecution.create({ data: { enterpriseId, sourceRef: randomUUID(), kind, credentialId: 'fixture', credentialVersion: 1,
      remoteAccountId: 'fixture', feeStatus: 'FINAL', billId: `bill_${randomUUID()}`, billVersion: 1, grossCny: gross } });
  }
  async function charge(id: string, messageId = id) {
    return credit.chargeUsage({ enterpriseId, userId, subscriptionId, employeeId, modelId: 'fixture-model', sessionId: 'fixture',
      messageId, inputTokens: 999999, outputTokens: 999999, computeExecutionId: id });
  }

  it('uses remote CNY and serializes concurrent gift/member/personal consumption', async () => {
    await db.memberAllowanceTopUp.create({ data: { enterpriseId, userId, amountCNY: '0.300000' } });
    const executions = await Promise.all(Array.from({ length: 8 }, () => execution()));
    const results = await Promise.all(executions.map(row => charge(row.id)));
    const totals = results.reduce((sum, row) => ({ free: sum.free.add(row.creditPaidCNY), member: sum.member.add(row.memberWalletPaidCNY),
      personal: sum.personal.add(row.personalPaidCNY), cost: sum.cost.add(row.costCNY) }), { free: new Decimal(0), member: new Decimal(0), personal: new Decimal(0), cost: new Decimal(0) });
    expect(totals.free.toFixed(6)).toBe('0.300000'); expect(totals.member.toFixed(6)).toBe('0.300000');
    expect(totals.personal.toFixed(6)).toBe('0.600000'); expect(totals.cost.toFixed(6)).toBe('1.200000');
    expect((await db.personalWallet.findUniqueOrThrow({ where: { userId } })).balance.toFixed(6)).toBe('1.400000');
    expect(await db.computeIntegrationSettlement.count({ where: { enterpriseId } })).toBe(8);
    expect(modelBilling.getSnapshot).not.toHaveBeenCalled();
    const records = await db.computeUsageRecord.findMany({ where: { enterpriseId } });
    expect(records.every(row => row.inputPriceUsdPerMillion === null && row.usdToCnyRate === null)).toBe(true);
  });

  it('deduplicates one execution even with different local message identifiers and concurrent replay', async () => {
    const row = await execution();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => charge(row.id, `message-${i}`)));
    expect(new Set(results.map(result => result.usageRecordId)).size).toBe(1);
    expect(results.filter(result => !result.alreadyCharged)).toHaveLength(1);
    expect((await db.subscriptionCredit.findUniqueOrThrow({ where: { subscriptionId } })).usedCNY.toFixed(6)).toBe('0.150000');
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId, kind: 'SETTLEMENT' } })).toBe(1);
  });

  it('keeps unpaid money visible and never submits it as paid or free', async () => {
    await db.personalWallet.update({ where: { userId }, data: { balance: 0 } });
    const row = await execution('1.000000');
    const result = await charge(row.id);
    expect(result.unpaidCNY.toFixed(6)).toBe('0.700000');
    expect((await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { executionId: row.id } })).status).toBe('UNPAID');
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId, kind: 'SETTLEMENT' } })).toBe(0);
    expect(await integrations.hasOpenAccounting(enterpriseId)).toBe(true);
  });

  it('allows an empty compute account to close but blocks it once real money awaits synchronization', async () => {
    expect(await integrations.hasOpenAccounting(enterpriseId)).toBe(false);
    await wallet.reserveForCompute(enterpriseId, 1);
    expect(await integrations.hasOpenAccounting(enterpriseId)).toBe(true);
  });

  it('keeps the original personal-only preference through concurrent partial debt recovery', async () => {
    await db.personalWallet.update({ where: { userId }, data: { balance: 0 } });
    await db.memberAllowanceTopUp.create({ data: { enterpriseId, userId, amountCNY: 3 } });
    const row = await execution('1.000000');
    await db.computeIntegrationExecution.update({ where: { id: row.id }, data: { fundingContext: { paymentMode: 'PERSONAL_ONLY' } } });
    const result = await charge(row.id);
    expect(result.unpaidCNY.toFixed(6)).toBe('1.000000');
    expect(result.creditPaidCNY.isZero()).toBe(true);
    expect(result.memberWalletPaidCNY.isZero()).toBe(true);
    const decision = await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { executionId: row.id } });
    await db.personalWallet.update({ where: { userId }, data: { balance: '0.400000' } });
    const recover = () => (credit as any).recoverUnpaidSettlement(decision.id, row.id);
    await Promise.all([recover(), recover()]);
    expect(await db.computeIntegrationTransfer.count({ where: { enterpriseId, direction: 'credit_compute' } })).toBe(1);
    expect((await db.computeUsageRecord.findUniqueOrThrow({ where: { id: result.usageRecordId } })).unpaidCNY.toFixed(6)).toBe('0.600000');
    await db.personalWallet.update({ where: { userId }, data: { balance: '0.600000' } });
    await Promise.all([recover(), recover()]);
    expect(await db.computeUsageRecord.findUniqueOrThrow({ where: { id: result.usageRecordId } })).toMatchObject({ paymentMode: 'PERSONAL_ONLY' });
    const final = await db.computeUsageRecord.findUniqueOrThrow({ where: { id: result.usageRecordId } });
    expect(final.personalPaidCNY.toFixed(6)).toBe('1.000000'); expect(final.unpaidCNY.isZero()).toBe(true);
    expect((await db.subscriptionCredit.findUniqueOrThrow({ where: { subscriptionId } })).usedCNY.isZero()).toBe(true);
    expect((await db.memberAllowanceTopUp.findMany({ where: { enterpriseId } })).every(value => value.consumedCNY.isZero())).toBe(true);
    expect((await db.enterpriseWallet.findUniqueOrThrow({ where: { enterpriseId } })).balance.toFixed(6)).toBe('10.000000');
    expect(await db.computeIntegrationTransfer.count({ where: { enterpriseId, direction: 'credit_compute' } })).toBe(2);
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId, kind: 'SETTLEMENT' } })).toBe(1);
  });

  it('imports only existing paid funds once and blocks spending until the initial transfer is confirmed', async () => {
    await db.enterpriseComputeBinding.update({ where: { enterpriseId }, data: { mode: 'PREPARING' } });
    await db.enterpriseWallet.update({ where: { enterpriseId }, data: { computeReservedCNY: 2 } });
    await db.memberAllowanceTopUp.create({ data: { enterpriseId, userId, amountCNY: 1 } });
    for (const kind of ['chat', 'image', 'video']) await db.enterpriseComputeCredential.create({ data: {
      enterpriseId, kind, remoteId: `credential_${kind}`, version: 1,
      encryptedKey: encryptSecret(`local-fixture-${kind}`, 'local-business-fixture-only'), maskedKey: '****fixture',
    } });
    remote.balance = jest.fn().mockResolvedValue({ total_paid_cny: '0.000000', sequence: '0' });
    const connected = await Promise.all(Array.from({ length: 5 }, () => integrations.completeConnection(enterpriseId)));
    expect(connected.every(value => value.mode === 'ENTERPRISE')).toBe(true);
    const initial = await db.computeIntegrationTransfer.findFirstOrThrow({ where: { enterpriseId, walletAction: 'INITIAL' } });
    expect(initial.amountCny.toFixed(6)).toBe('3.000000');
    expect((await wallet.getAvailableComputeBalance(enterpriseId)).toString()).toBe('0');
    await expect(integrations.assertEnterpriseReady(enterpriseId)).rejects.toMatchObject({ response: { code: 'COMPUTE_INITIAL_FUNDS_PENDING' } });
    await db.$transaction(async tx => {
      await funds.finalize(tx, initial.id, true);
      await tx.computeIntegrationTransfer.update({ where: { id: initial.id }, data: { status: 'COMMITTED' } });
    });
    expect((await wallet.getAvailableComputeBalance(enterpriseId)).toString()).toBe('2');
    await integrations.completeConnection(enterpriseId);
    expect(await db.computeIntegrationTransfer.count({ where: { enterpriseId, walletAction: 'INITIAL' } })).toBe(1);
    expect((await db.subscriptionCredit.findUniqueOrThrow({ where: { subscriptionId } })).usedCNY.isZero()).toBe(true);
  });

  it('locks pending credits/releases and applies remote confirmation or rejection once', async () => {
    const reserve = await wallet.reserveForCompute(enterpriseId, 4, userId);
    expect(reserve.syncStatus).toBe('PENDING');
    await expect(db.$transaction(tx => wallet.consumeForMemberTopUp(tx, enterpriseId, new Decimal(1), { description: 'test' }))).rejects.toThrow('算力余额不足');
    const transfer = await db.computeIntegrationTransfer.findUniqueOrThrow({ where: { businessId: reserve.transferId } });
    await db.$transaction(tx => funds.finalize(tx, transfer.id, true));
    await db.computeIntegrationTransfer.update({ where: { id: transfer.id }, data: { status: 'COMMITTED' } });
    const requests = await Promise.allSettled([wallet.releaseFromCompute(enterpriseId, 3), wallet.releaseFromCompute(enterpriseId, 3)]);
    expect(requests.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect((await db.enterpriseWallet.findUniqueOrThrow({ where: { enterpriseId } })).computeReservedCNY.toString()).toBe('4');
    const release = await db.computeIntegrationTransfer.findFirstOrThrow({ where: { enterpriseId, direction: 'debit_compute' } });
    await db.$transaction(tx => funds.finalize(tx, release.id, true));
    await db.$transaction(tx => funds.finalize(tx, release.id, true));
    expect((await db.enterpriseWallet.findUniqueOrThrow({ where: { enterpriseId } })).computeReservedCNY.toString()).toBe('1');
    const rejected = await wallet.reserveForCompute(enterpriseId, 2);
    const intent = await db.computeIntegrationTransfer.findUniqueOrThrow({ where: { businessId: rejected.transferId } });
    await db.$transaction(tx => funds.finalize(tx, intent.id, false));
    expect((await db.enterpriseWallet.findUniqueOrThrow({ where: { enterpriseId } })).computeReservedCNY.toString()).toBe('1');
  });

  it('refunds unused media holds and writes only actual free/paid CNY plus personal funding', async () => {
    const receiptId = `media_${randomUUID()}`;
    const row = await execution('0.500000', 'image');
    await db.computeIntegrationExecution.update({ where: { id: row.id }, data: { sourceRef: receiptId } });
    const claims: any = { sub: userId, enterpriseId, memberId, subscriptionId };
    await billing.reserve(claims, receiptId, '1.000000', null);
    expect((await db.personalWallet.findUniqueOrThrow({ where: { userId } })).balance.toFixed(6)).toBe('1.300000');
    expect(await billing.settleCompute(receiptId, row.id, 'fixture-image')).toBe('SETTLED');
    expect(await billing.settleCompute(receiptId, row.id, 'fixture-image')).toBe('SETTLED');
    const decision = await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { executionId: row.id } });
    expect(decision.freeCny.toFixed(6)).toBe('0.300000'); expect(decision.paidCny.toFixed(6)).toBe('0.200000');
    expect((await db.personalWallet.findUniqueOrThrow({ where: { userId } })).balance.toFixed(6)).toBe('1.800000');
    expect((await db.computeIntegrationTransfer.findFirstOrThrow({ where: { enterpriseId } })).amountCny.toFixed(6)).toBe('0.200000');
  });

  it('does not deliver a settlement before the exact personal funding transfer is confirmed', async () => {
    const row = await execution('0.500000'); await charge(row.id);
    const proxy = new Proxy(db, { get(target, name) {
      if (name === 'computeIntegrationJob') return { ...target.computeIntegrationJob,
        findMany: (args: any) => target.computeIntegrationJob.findMany({ ...args, where: { ...args.where, enterpriseId, kind: 'SETTLEMENT' } }) };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    remote.settle = jest.fn();
    await new ComputeIntegrationWorker(proxy, remote, integrations, funds).deliver();
    expect(remote.settle).not.toHaveBeenCalled();
    expect((await db.computeIntegrationJob.findFirstOrThrow({ where: { enterpriseId, kind: 'SETTLEMENT' } })).lastErrorCode).toBe('COMPUTE_PERSONAL_FUNDING_PENDING');
  });

  it('refunds a zero-cost failed media task once and completes its execution accounting', async () => {
    const receiptId = `media_zero_${randomUUID()}`;
    const row = await execution('0.000000', 'image');
    await db.computeIntegrationExecution.update({ where: { id: row.id }, data: { sourceRef: receiptId } });
    const claims: any = { sub: userId, enterpriseId, memberId, subscriptionId };
    const before = await db.personalWallet.findUniqueOrThrow({ where: { userId } });
    await billing.reserve(claims, receiptId, '1.000000', null);
    const results = await Promise.all(Array.from({ length: 4 }, () => billing.settleCompute(receiptId, row.id, 'fixture-image')));
    expect(results).toEqual(Array(4).fill('RELEASED'));
    expect((await db.personalWallet.findUniqueOrThrow({ where: { userId } })).balance.eq(before.balance)).toBe(true);
    expect(await db.computeUsageRecord.count({ where: { idempotencyKey: `media-real:${receiptId}` } })).toBe(1);
    const decision = await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { executionId: row.id } });
    expect(decision.grossCny.isZero()).toBe(true);
    expect((await db.computeIntegrationExecution.findUniqueOrThrow({ where: { id: row.id } })).localUsageRecordId).not.toBeNull();
  });
});
