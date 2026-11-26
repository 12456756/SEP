import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { randomUUID } from 'node:crypto';
import { ComputeAccountingService } from './compute-accounting.service';

const databaseUrl = process.env.COMPUTE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('Compute integration isolated PostgreSQL', () => {
  let db: PrismaService;
  let service: ComputeIntegrationService;
  let enterpriseId: string;
  let accounting: ComputeAccountingService;

  async function finalExecution(kind: string, grossCny: string) {
    return db.computeIntegrationExecution.create({ data: { enterpriseId, sourceRef: `source_${randomUUID()}`, kind,
      credentialId: 'isolated-fixture', credentialVersion: 1, remoteAccountId: 'isolated-fixture', feeStatus: 'FINAL',
      billId: `bill_${randomUUID()}`, billVersion: 1, grossCny } });
  }

  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.startsWith('/sep_compute_test')) {
      throw new Error('Only a dedicated local sep_compute_test database is allowed');
    }
    db = new PrismaService({ datasourceUrl: databaseUrl });
    await db.$connect();
    service = new ComputeIntegrationService(db, new ConfigService({ JWT_SECRET: 'isolated-compute-test-key-only' }), new ComputeRemoteAdapter());
    accounting = new ComputeAccountingService(db);
    const enterprise = await db.enterprise.create({ data: { name: `compute-integration-${randomUUID()}` } });
    enterpriseId = enterprise.id;
  });
  afterAll(async () => { await db?.$disconnect(); });

  it('rolls back new user, enterprise, credentials and provisioning task together', async () => {
    const email = `registration-rollback-${randomUUID()}@local.test`;
    let companyId = '';
    await expect(db.$transaction(async tx => {
      const user = await tx.user.create({ data: { email, authCredentials: { create: {
        type: 'LOCAL_PASSWORD', passwordHash: '$2b$10$' + 'a'.repeat(53),
      } } } });
      const company = await tx.enterprise.create({ data: { name: 'registration-rollback', members: { create: {
        userId: user.id, role: 'ENTERPRISE_ADMIN',
      } } } });
      companyId = company.id;
      await service.ensureBinding(company.id, tx, { companyName: company.name, adminEmail: email, adminUserId: user.id,
        passwordHash: '$2b$10$' + 'a'.repeat(53) });
      throw new Error('registration transaction failed');
    })).rejects.toThrow('registration transaction failed');
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await db.enterprise.count({ where: { id: companyId } })).toBe(0);
    expect(await db.enterpriseComputeBinding.count({ where: { enterpriseId: companyId } })).toBe(0);
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId: companyId } })).toBe(0);
  });

  it('keeps the original encrypted registration snapshot on repeated creation', async () => {
    const company = await db.enterprise.create({ data: { name: `registration-snapshot-${randomUUID()}` } });
    const passwordHash = '$2b$10$' + 'a'.repeat(53);
    await db.$transaction(tx => service.ensureBinding(company.id, tx, {
      companyName: company.name, adminEmail: 'original@local.test', passwordHash,
    }));
    const original = await db.computeIntegrationJob.findFirstOrThrow({ where: { enterpriseId: company.id, kind: 'PROVISION' } });
    await db.$transaction(tx => service.ensureBinding(company.id, tx, {
      companyName: 'Changed', adminEmail: 'changed@local.test', passwordHash: '$2b$12$' + 'b'.repeat(53),
    }));
    const replay = await db.computeIntegrationJob.findUniqueOrThrow({ where: { id: original.id } });
    expect(replay.requestPayload).toEqual(original.requestPayload);
    expect(JSON.stringify(replay.requestPayload)).not.toContain(passwordHash);
    expect((replay.requestPayload as any).encryptedPasswordHash).toMatch(/^enc:v1:/);
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId: company.id, kind: 'PROVISION' } })).toBe(1);
  });

  it('serializes concurrent preparation into one account binding and one original job', async () => {
    await Promise.all(Array.from({ length: 6 }, () => service.prepare(enterpriseId)));
    expect(await db.enterpriseComputeBinding.count({ where: { enterpriseId } })).toBe(1);
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId, kind: 'PROVISION' } })).toBe(1);
    expect(await service.view(enterpriseId)).toMatchObject({ mode: 'PREPARING', connected: false });
  });

  it('concurrent same-execution decisions produce exactly one record and one outbox', async () => {
    const execution = await finalExecution('chat', '10.000000');
    const decision: any = { enterpriseId, executionId: execution.id, kind: 'chat', billId: execution.billId, billVersion: 1, currency: 'CNY',
      grossCny: '10.000000', freeCny: '3.000000', paidCny: '7.000000', unpaidCny: '0.000000' };
    const results = await Promise.all(Array.from({ length: 5 }, () => db.$transaction(tx => service.recordSettlement(tx, decision))));
    expect(new Set(results.map(row => row.id)).size).toBe(1);
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId, kind: 'SETTLEMENT' } })).toBe(1);
    await expect(db.$transaction(tx => service.recordSettlement(tx, { ...decision, freeCny: '4.000000', paidCny: '6.000000' }))).rejects.toThrow('结算编号对应内容冲突');
  });

  it('rolls back decision and outbox if the local money transaction fails', async () => {
    const execution = await finalExecution('image', '1.000000');
    const executionId = execution.id;
    const jobsBefore = await db.computeIntegrationJob.count({ where: { enterpriseId, kind: 'SETTLEMENT' } });
    await expect(db.$transaction(async tx => {
      await service.recordSettlement(tx, { enterpriseId, executionId, kind: 'image', billId: execution.billId!, billVersion: 1,
        currency: 'CNY', grossCny: '1.000000', freeCny: '1.000000', paidCny: '0.000000', unpaidCny: '0.000000' });
      throw new Error('simulated local money failure');
    })).rejects.toThrow('simulated local money failure');
    expect(await db.computeIntegrationSettlement.count({ where: { executionId } })).toBe(0);
    expect(await db.computeIntegrationJob.count({ where: { enterpriseId, kind: 'SETTLEMENT' } })).toBe(jobsBefore);
  });

  it('stores complete account credentials only as ciphertext before automatic connection initialization', async () => {
    const job = await db.computeIntegrationJob.findFirstOrThrow({ where: { enterpriseId, kind: 'PROVISION' } });
    const lease = randomUUID();
    await db.computeIntegrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', leaseToken: lease } });
    await service.saveProvisioned(enterpriseId, { remoteAccountId: `remote_${randomUUID()}`, credentials: (['chat', 'image', 'video'] as const).map(kind => ({ kind,
      remoteId: `remote_${kind}`, version: 1, apiKey: `only-local-${kind}-credential` })) }, job.id, lease);
    const stored = await db.enterpriseComputeCredential.findMany({ where: { enterpriseId } });
    expect(stored).toHaveLength(3);
    expect(stored.every(row => row.encryptedKey.startsWith('enc:v1:') && !row.encryptedKey.includes('only-local'))).toBe(true);
    const view = await service.view(enterpriseId);
    expect(view).toMatchObject({ status: 'READY', mode: 'PREPARING' });
    expect(JSON.stringify(view)).not.toContain('encryptedKey');
    for (const kind of ['chat', 'image', 'video'] as const) {
      expect((await service.selectEnterpriseCredential(enterpriseId, kind)).apiKey).toBe(`only-local-${kind}-credential`);
    }
  });

  it('persists execution context before dispatch and separates pending costs from final zero', async () => {
    const credential = await db.enterpriseComputeCredential.findFirstOrThrow({ where: { enterpriseId, kind: 'video', active: true } });
    const input = { enterpriseId, kind: 'video' as const, credentialId: credential.id, sourceRef: `task_${randomUUID()}` };
    const executions = await Promise.all(Array.from({ length: 4 }, () => accounting.createExecution(input)));
    expect(new Set(executions.map(row => row.id)).size).toBe(1);
    const executionId = executions[0].id;
    expect(executions[0]).toMatchObject({ credentialVersion: 1, feeStatus: 'PENDING', grossCny: null });
    const fee = { enterpriseId, executionId, computeRequestId: `request_${randomUUID()}`, currency: 'CNY' as const };
    await accounting.recordFee({ ...fee, status: 'PENDING' });
    const final = { ...fee, status: 'FINAL' as const, billId: `bill_${randomUUID()}`, billVersion: 1, grossCny: '0.000000' };
    await accounting.recordFee(final);
    await accounting.recordFee(final);
    await expect(accounting.recordFee({ ...final, grossCny: '1.000000' })).rejects.toThrow('已经确认的实际费用不能改写');
    await expect(accounting.recordFee({ ...fee, status: 'PENDING' })).rejects.toThrow('已经确认的实际费用不能改写');
    await db.enterpriseComputeCredential.update({ where: { id: credential.id }, data: { active: false } });
    expect((await service.selectExecutionCredential(enterpriseId, executionId)).apiKey).toBe('only-local-video-credential');
    await expect(service.selectExecutionCredential('foreign-enterprise', executionId)).rejects.toThrow('执行记录不存在');
    expect((await accounting.createExecution(input)).credentialId).toBe(credential.id);
    await expect(accounting.createExecution({ ...input, sourceRef: `new_${randomUUID()}` })).rejects.toThrow('原请求尚未发送');
  });

  it('keeps balance differences and advances the cursor only for matching watermarks', async () => {
    const input = { enterpriseId, businessId: `reconcile_${randomUUID()}`, ledgerCursor: 'cursor20', localSequence: '20', remoteSequence: '20',
      currency: 'CNY' as const, localBalanceCny: '10.000000', remoteBalanceCny: '9.000000' };
    const row = await accounting.reconcile(input);
    expect(row.status).toBe('DIFFERENCE');
    expect(row.differenceCny.toFixed(6)).toBe('1.000000');
    expect((await db.enterpriseComputeBinding.findUniqueOrThrow({ where: { enterpriseId } })).ledgerCursor).toBeNull();
    await expect(accounting.reconcile({ ...input, businessId: `reconcile_${randomUUID()}`, remoteSequence: '21' })).rejects.toThrow('两边流水水位不同');
    const match = { ...input, businessId: `reconcile_${randomUUID()}`, localBalanceCny: '9.000000' };
    await accounting.reconcile(match);
    expect((await db.enterpriseComputeBinding.findUniqueOrThrow({ where: { enterpriseId } })).ledgerCursor).toBe('cursor20');
    expect((await service.view(enterpriseId)).lastReconciliation?.status).toBe('MATCHED');
    await expect(accounting.reconcile({ ...match, businessId: `reconcile_${randomUUID()}`, localSequence: '19', remoteSequence: '19' })).rejects.toThrow('不能用旧水位');
  });

  it('isolates concurrent enterprise and purpose selection and refuses a foreign credential', async () => {
    const second = await db.enterprise.create({ data: { name: `second-${randomUUID()}` } });
    await service.prepare(second.id);
    const job = await db.computeIntegrationJob.findFirstOrThrow({ where: { enterpriseId: second.id, kind: 'PROVISION' } });
    await db.computeIntegrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', leaseToken: 'second-lease' } });
    await service.saveProvisioned(second.id, { remoteAccountId: `remote_${randomUUID()}`, credentials: (['chat', 'image', 'video'] as const).map(kind => ({
      kind, remoteId: `second_${kind}`, version: 1, apiKey: `second-local-${kind}-credential`,
    })) }, job.id, 'second-lease');
    const [firstChat, secondChat, secondImage] = await Promise.all([
      service.selectEnterpriseCredential(enterpriseId, 'chat'), service.selectEnterpriseCredential(second.id, 'chat'), service.selectEnterpriseCredential(second.id, 'image'),
    ]);
    expect(firstChat.apiKey).toBe('only-local-chat-credential');
    expect(secondChat.apiKey).toBe('second-local-chat-credential');
    expect(secondImage.apiKey).toBe('second-local-image-credential');
    await expect(accounting.createExecution({ enterpriseId: second.id, kind: 'chat', credentialId: firstChat.credentialId, sourceRef: 'foreign-key' })).rejects.toThrow('原请求尚未发送');
  });

  it('serializes concurrent transfer intents into one operation and refuses changed amounts', async () => {
    const input = { enterpriseId, businessId: `transfer_${randomUUID()}`, direction: 'debit_compute' as const, currency: 'CNY' as const,
      amountCny: '8.000000', fundingRef: `fund_${randomUUID()}` };
    const rows = await Promise.all(Array.from({ length: 4 }, () => db.$transaction(tx => service.recordTransfer(tx, input))));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    expect(await db.computeIntegrationJob.count({ where: { businessId: input.businessId } })).toBe(1);
    await expect(db.$transaction(tx => service.recordTransfer(tx, { ...input, amountCny: '9.000000' }))).rejects.toThrow('划转编号对应内容冲突');
  });

  it('retains the wire maximum CNY precision without float conversion or truncation', async () => {
    const amount = '999999999999999999.999999';
    const row = await db.$transaction(tx => service.recordTransfer(tx, { enterpriseId, businessId: `precision_${randomUUID()}`,
      direction: 'credit_compute', currency: 'CNY', amountCny: amount, fundingRef: `precision_fund_${randomUUID()}` }));
    expect(row.amountCny.toFixed(6)).toBe(amount);
  });

  it('keeps reconciling evidence distinct from a final zero fee', async () => {
    const credential = await db.enterpriseComputeCredential.findFirstOrThrow({ where: { enterpriseId, kind: 'chat', active: true } });
    const execution = await accounting.createExecution({ enterpriseId, kind: 'chat', credentialId: credential.id, sourceRef: `reconciling_${randomUUID()}` });
    const saved = await accounting.recordFee({ enterpriseId, executionId: execution.id, computeRequestId: `compute_${randomUUID()}`, currency: 'CNY', status: 'RECONCILING' });
    expect(saved.feeStatus).toBe('RECONCILING'); expect(saved.grossCny).toBeNull(); expect(saved.billId).toBeNull();
  });
});
