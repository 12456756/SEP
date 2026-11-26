import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '@prisma/client/runtime/library';
import { encryptSecret } from '../../common/crypto/secret-cipher';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeConnectionService } from './compute-connection.service';
import { ComputeIntegrationWorker } from './compute-integration.worker';
import { ComputeRemoteAdapter } from './compute-remote.adapter';

const secret = 'compute-integration-test-secret-only';
function setup() {
  const db: any = {
    enterprise: { findUnique: jest.fn().mockResolvedValue({ name: '测试企业', status: 'ACTIVE' }), findMany: jest.fn(), count: jest.fn() },
    enterpriseMember: { findFirst: jest.fn() },
    enterpriseComputeBinding: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({ registrationRef: 'reg_ent1', mode: 'LEGACY' }), update: jest.fn(), updateMany: jest.fn() },
    enterpriseComputeCredential: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
    computeIntegrationReconciliation: { findFirst: jest.fn().mockResolvedValue(null) },
    computeIntegrationExecution: { findUnique: jest.fn().mockResolvedValue({ enterpriseId: 'ent1', kind: 'chat', feeStatus: 'FINAL', billId: 'bill1', billVersion: 1, grossCny: new Decimal('10') }) },
    computeIntegrationJob: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn(), create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    computeIntegrationSettlement: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'settle1', ...data })) },
    computeIntegrationTransfer: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'transfer1', ...data })) },
    enterpriseWallet: { findUnique: jest.fn().mockResolvedValue(null) },
    memberAllowanceTopUp: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountCNY: null, consumedCNY: null } }) },
    gatewayExecution: { count: jest.fn().mockResolvedValue(0) },
    mediaRealBillingReservation: { count: jest.fn().mockResolvedValue(0) },
    message: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
  };
  db.$transaction = jest.fn(fn => fn(db));
  const config = { get: jest.fn().mockReturnValue(undefined), getOrThrow: jest.fn().mockReturnValue(secret) } as unknown as ConfigService;
  const remote = new ComputeRemoteAdapter();
  const service = new ComputeIntegrationService(db, config, remote);
  return { db, config, remote, service };
}
const decision: any = { enterpriseId: 'ent1', executionId: 'exec1', kind: 'chat', billId: 'bill1', billVersion: 1,
  currency: 'CNY', grossCny: '10.000000', freeCny: '3.000000', paidCny: '7.000000', unpaidCny: '0.000000' };

describe('Compute integration preparation', () => {
  it('shows an unconnected legacy enterprise without making up keys or balances', async () => {
    const { service } = setup();
    const view = await service.view('ent1');
    expect(view).toMatchObject({ mode: 'LEGACY', status: 'NOT_CONNECTED', connected: false });
    expect(view).not.toHaveProperty('activationAllowed');
    expect(view.credentials).toHaveLength(3);
    expect(view.credentials.every(key => !key.configured)).toBe(true);
  });

  it('creates a durable blocked registration operation with the same transaction', async () => {
    const { service, db } = setup();
    await service.ensureBinding('ent1', db);
    expect(db.computeIntegrationJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId: 'reg_ent1' }, create: expect.objectContaining({ status: 'BLOCKED', kind: 'PROVISION' }),
    }));
  });

  it('freezes the registration password encrypted even before the remote connection is configured', async () => {
    const { service, db, remote } = setup();
    const identity = { companyName: 'Original', adminEmail: 'first@example.test', passwordHash: '$2b$10$' + 'a'.repeat(53) };
    await service.ensureBinding('ent1', db, identity);
    const stored = db.computeIntegrationJob.upsert.mock.calls[0][0].create.requestPayload;
    expect(stored.encryptedPasswordHash).toMatch(/^enc:v1:/);
    expect(JSON.stringify(stored)).not.toContain(identity.passwordHash);
    jest.spyOn(remote, 'registration').mockImplementation(value => ({ ...value, encryptionKeyId: value.encryptionKeyId ?? 'enc1' }));
    expect(service.registrationRequest(stored)).toMatchObject(identity);
  });

  it('prepares without external calls or enabling new billing', async () => {
    const { service, remote, db } = setup();
    const provision = jest.spyOn(remote, 'provision');
    await service.prepare('ent1');
    expect(provision).not.toHaveBeenCalled();
    expect(db.enterpriseComputeBinding.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mode: 'PREPARING', status: 'NOT_CONNECTED' }) }));
  });

  it('refuses preparation for a suspended enterprise', async () => {
    const { service, db } = setup(); db.$queryRaw.mockResolvedValue([{ status: 'SUSPENDED' }]);
    await expect(service.prepare('ent1')).rejects.toThrow(ConflictException);
    expect(db.enterpriseComputeBinding.update).not.toHaveBeenCalled();
  });

  it('wakes an existing blocked provisioning job when the adapter becomes available', async () => {
    const { service, db, remote } = setup(); jest.spyOn(remote, 'isConnected').mockReturnValue(true);
    await service.prepare('ent1');
    expect(db.computeIntegrationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId: 'reg_ent1', status: 'BLOCKED' }, data: expect.objectContaining({ status: 'PENDING', lastErrorCode: null }),
    }));
  });

  it('blocks unsupported activation and never falls back to a platform credential', async () => {
    const { service, db } = setup();
    db.enterpriseComputeBinding.findUnique.mockResolvedValue({ mode: 'ENTERPRISE' });
    const settings = { getEffectiveValue: jest.fn(), getMediaConnection: jest.fn() };
    const resolver = new ComputeConnectionService(settings as any, service);
    await expect(resolver.resolve('ent1', 'chat')).rejects.toThrow(ServiceUnavailableException);
    expect(settings.getEffectiveValue).not.toHaveBeenCalled();
  });

  it.each([null, { mode: 'LEGACY', status: 'READY' }, { mode: 'PREPARING', status: 'READY' }])(
    'blocks unactivated enterprise calls with binding %j even when administrator credentials exist', async binding => {
      const { service, db, remote } = setup();
      db.enterpriseComputeBinding.findUnique.mockResolvedValue(binding);
      jest.spyOn(remote, 'isConnected').mockReturnValue(true);
      const settings = { getEffectiveValue: jest.fn().mockResolvedValue('administrator-key') };
      const transport = { provider: jest.fn() };
      const resolver = new ComputeConnectionService(settings as any, service, undefined, transport as any);
      await expect(resolver.chatProvider('ent1')).rejects.toMatchObject({ response: { code: 'COMPUTE_ENTERPRISE_NOT_ENABLED' } });
      for (const kind of ['image', 'video'] as const) await expect(resolver.resolve('ent1', kind))
        .rejects.toMatchObject({ response: { code: 'COMPUTE_ENTERPRISE_NOT_ENABLED' } });
      expect(settings.getEffectiveValue).not.toHaveBeenCalled();
      expect(transport.provider).not.toHaveBeenCalled();
      expect(db.enterpriseComputeCredential.findFirst).not.toHaveBeenCalled();
    },
  );

  it('blocks initial balance synchronization before selecting credentials', async () => {
    const { service, db, remote } = setup();
    jest.spyOn(remote, 'isConnected').mockReturnValue(true);
    db.enterpriseComputeBinding.findUnique.mockResolvedValue({ mode: 'ENTERPRISE', status: 'READY' });
    db.computeIntegrationTransfer.count.mockResolvedValue(1);
    await expect(service.assertEnterpriseReady('ent1')).rejects.toMatchObject({ response: { code: 'COMPUTE_INITIAL_FUNDS_PENDING' } });
  });

  function readyConnection() {
    const context = setup();
    const binding = { id: 'binding1', registrationRef: 'reg_ent1', mode: 'PREPARING', status: 'READY', remoteAccountId: 'remote1' };
    context.db.enterpriseComputeBinding.findUnique.mockImplementation(async () => ({ ...binding }));
    context.db.enterpriseComputeBinding.update.mockImplementation(async ({ data }) => Object.assign(binding, { mode: data.mode }));
    context.db.enterpriseComputeCredential.findMany.mockResolvedValue(['chat', 'image', 'video'].map(kind => ({ kind })));
    jest.spyOn(context.remote, 'isConnected').mockReturnValue(true);
    const balance = jest.spyOn(context.remote, 'balance').mockResolvedValue({ total_paid_cny: '0.000000', sequence: '0' } as any);
    return { ...context, binding, balance };
  }

  it('completes a newly provisioned connection automatically without a separate switch or transfer', async () => {
    const { service, db } = readyConnection();
    expect((await service.completeConnection('ent1')).mode).toBe('ENTERPRISE');
    await service.assertEnterpriseReady('ent1');
    expect(db.computeIntegrationTransfer.create).not.toHaveBeenCalled();
    expect(db.enterpriseComputeBinding.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      mode: 'ENTERPRISE', lastErrorCode: null, lastErrorMessage: null,
    }) }));
  });

  it('does not block a zero-local-funds account just because it already received a compute-side top-up', async () => {
    const { service, balance, db } = readyConnection();
    balance.mockResolvedValue({ total_paid_cny: '5.000000', sequence: '1' } as any);
    expect((await service.completeConnection('ent1')).mode).toBe('ENTERPRISE');
    expect(db.computeIntegrationTransfer.create).not.toHaveBeenCalled();
  });

  it('imports existing paid funds once even if automatic initialization is repeated', async () => {
    const { service, db, balance } = readyConnection();
    db.enterpriseWallet.findUnique.mockResolvedValue({ computeReservedCNY: new Decimal(2) });
    db.memberAllowanceTopUp.aggregate.mockResolvedValue({ _sum: { amountCNY: new Decimal(3), consumedCNY: new Decimal(1) } });
    db.computeIntegrationTransfer.update = jest.fn();
    await service.completeConnection('ent1');
    await service.completeConnection('ent1');
    expect(db.computeIntegrationTransfer.create).toHaveBeenCalledTimes(1);
    expect(db.computeIntegrationTransfer.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      businessId: 'initial_binding1', amountCny: '4.000000',
    }) });
    expect(balance).toHaveBeenCalledTimes(1);
  });

  it('retains initial-balance conflict protection during automatic connection completion', async () => {
    const { service, db, balance } = readyConnection();
    db.enterpriseWallet.findUnique.mockResolvedValue({ computeReservedCNY: new Decimal(2) });
    balance.mockResolvedValue({ total_paid_cny: '5.000000', sequence: '1' } as any);
    await expect(service.completeConnection('ent1')).rejects.toMatchObject({ response: { code: 'COMPUTE_INITIAL_BALANCE_CONFLICT' } });
    expect(db.enterpriseComputeBinding.update).not.toHaveBeenCalled();
    expect(db.computeIntegrationTransfer.create).not.toHaveBeenCalled();
  });

  it('retains protections for missing credentials and unfinished old tasks', async () => {
    const { service, db } = readyConnection();
    db.enterpriseComputeCredential.findMany.mockResolvedValue([{ kind: 'chat' }]);
    await expect(service.completeConnection('ent1')).rejects.toThrow('三种企业用途凭证必须齐全');
    db.enterpriseComputeCredential.findMany.mockResolvedValue(['chat', 'image', 'video'].map(kind => ({ kind })));
    db.gatewayExecution.count.mockResolvedValue(1);
    await expect(service.completeConnection('ent1')).rejects.toThrow('请先完成旧模型任务');
    expect(db.enterpriseComputeBinding.update).not.toHaveBeenCalled();
  });

  it('keeps platform media calibration independent of enterprise credentials', async () => {
    const { service } = setup();
    const settings = { getMediaConnection: jest.fn().mockResolvedValue({ baseUrl: 'https://relay.test/v1', apiKey: 'platform-test-key' }) };
    const resolver = new ComputeConnectionService(settings as any, service);
    expect(await resolver.platform('image')).toMatchObject({ apiKey: 'platform-test-key', source: 'platform' });
  });

  it('selects only the requested enterprise and key kind and rejects plaintext storage', async () => {
    const { service, db } = setup();
    db.enterpriseComputeBinding.findUnique.mockResolvedValue({ status: 'READY', remoteAccountId: 'remote1' });
    db.enterpriseComputeCredential.findFirst.mockResolvedValue({ id: 'key1', version: 2, encryptedKey: encryptSecret('enterprise-video-test-key', secret) });
    expect(await service.selectEnterpriseCredential('ent1', 'video')).toMatchObject({ apiKey: 'enterprise-video-test-key', version: 2 });
    expect(db.enterpriseComputeCredential.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { enterpriseId: 'ent1', kind: 'video', active: true } }));
    db.enterpriseComputeCredential.findFirst.mockResolvedValue({ encryptedKey: 'plaintext-not-accepted' });
    await expect(service.selectEnterpriseCredential('ent1', 'video')).rejects.toThrow(ServiceUnavailableException);
  });

  it('never returns ciphertext or cleartext from the status endpoint', async () => {
    const { service, db } = setup();
    db.enterpriseComputeCredential.findMany.mockResolvedValue([{ kind: 'chat', maskedKey: '****test', version: 1 }]);
    const view = await service.view('ent1');
    expect(JSON.stringify(view)).not.toContain('encryptedKey');
    expect(db.enterpriseComputeCredential.findMany.mock.calls[0][0].select).toEqual({ kind: true, maskedKey: true, version: true });
  });

  it('does not allow a normal member to inspect enterprise integration', async () => {
    const { service, db } = setup(); db.enterpriseMember.findFirst.mockResolvedValue(null);
    await expect(service.forEnterpriseAdmin('user1')).rejects.toThrow(ForbiddenException);
  });

  it('records a conserved CNY decision and a blocked outbox item without moving funds', async () => {
    const { service, db } = setup();
    const row = await service.recordSettlement(db, decision);
    expect(row).toMatchObject({ status: 'LOCAL_CONFIRMED', grossCny: '10.000000' });
    expect(db.computeIntegrationJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'SETTLEMENT', status: 'BLOCKED' }) }));
  });

  it('keeps unpaid decisions out of the remote full-settlement outbox', async () => {
    const { service, db } = setup();
    expect(await service.recordSettlement(db, { ...decision, paidCny: '2.000000', unpaidCny: '5.000000' })).toMatchObject({ status: 'UNPAID' });
    expect(db.computeIntegrationJob.create).not.toHaveBeenCalled();
  });

  it('refuses settlements for pending or foreign execution fees', async () => {
    const { service, db } = setup();
    db.computeIntegrationExecution.findUnique.mockResolvedValue({ enterpriseId: 'other', feeStatus: 'PENDING' });
    await expect(service.recordSettlement(db, decision)).rejects.toThrow(ConflictException);
    expect(db.computeIntegrationSettlement.create).not.toHaveBeenCalled();
  });

  it.each([{ freeCny: '10.000000', paidCny: '0.000000' }, { freeCny: '0.000000', paidCny: '10.000000' }])('records full-free and full-paid splits %j', async split => {
    const { service, db } = setup();
    expect(await service.recordSettlement(db, { ...decision, ...split })).toMatchObject({ status: 'LOCAL_CONFIRMED', ...split });
  });

  it.each([{ currency: 'USD' }, { paidCny: '7e0' }, { paidCny: '7.000001' }, { freeCny: '-1.000000' }])('rejects invalid or nonconserved money %j', async patch => {
    const { service, db } = setup();
    await expect(service.recordSettlement(db, { ...decision, ...patch })).rejects.toThrow(BadRequestException);
    expect(db.computeIntegrationSettlement.create).not.toHaveBeenCalled();
  });

  it('reuses a decision exactly once and rejects changed content', async () => {
    const { service, db } = setup(); const row = await service.recordSettlement(db, decision);
    db.computeIntegrationSettlement.findUnique.mockResolvedValue(row);
    expect(await service.recordSettlement(db, decision)).toEqual(row);
    await expect(service.recordSettlement(db, { ...decision, freeCny: '4.000000', paidCny: '6.000000' })).rejects.toThrow(ConflictException);
    expect(db.computeIntegrationSettlement.create).toHaveBeenCalledTimes(1);
  });

  it('reuses transfer intents and rejects another tenant using the same business id', async () => {
    const { service, db } = setup();
    const value: any = { enterpriseId: 'ent1', businessId: 'transfer1', direction: 'credit_compute', currency: 'CNY', amountCny: '100.000000', fundingRef: 'fund1' };
    const row = await service.recordTransfer(db, value);
    db.computeIntegrationTransfer.findUnique.mockResolvedValue({ ...row, amountCny: new Decimal(row.amountCny) });
    await service.recordTransfer(db, value);
    await expect(service.recordTransfer(db, { ...value, enterpriseId: 'ent2' })).rejects.toThrow(ConflictException);
    expect(db.computeIntegrationTransfer.create).toHaveBeenCalledTimes(1);
  });

  it('does not run a fake remote worker while disconnected', async () => {
    const { service, db, remote } = setup();
    await new ComputeIntegrationWorker(db, remote, service).deliver();
    expect(db.computeIntegrationJob.findMany).not.toHaveBeenCalled();
  });

  it('rejects a stale worker before writing any credentials', async () => {
    const { service, db } = setup(); db.enterpriseComputeBinding.findUnique.mockResolvedValue({ registrationRef: 'reg_ent1' }); db.computeIntegrationJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.saveProvisioned('ent1', { remoteAccountId: 'remote1', credentials: ['chat', 'image', 'video'].map(kind => ({ kind, remoteId: kind, version: 1, apiKey: `test-${kind}` })) } as any, 'job1', 'stale')).rejects.toThrow(ConflictException);
    expect(db.enterpriseComputeCredential.upsert).not.toHaveBeenCalled();
  });

  it('rejects downgrading a stored key version', async () => {
    const { service, db } = setup(); db.enterpriseComputeBinding.findUnique.mockResolvedValue({ registrationRef: 'reg_ent1' }); db.enterpriseComputeCredential.findFirst.mockResolvedValue({ version: 3 });
    await expect(service.saveProvisioned('ent1', { remoteAccountId: 'remote1', credentials: ['chat', 'image', 'video'].map(kind => ({ kind, remoteId: kind, version: 1, apiKey: `test-${kind}` })) } as any, 'job1', 'lease')).rejects.toThrow('不能用旧版本');
  });
});
