import { Decimal } from '@prisma/client/runtime/library';
import { ComputeIntegrationWorker } from './compute-integration.worker';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';

function setup(kind = 'SETTLEMENT') {
  const job = { id: 'job1', enterpriseId: 'ent1', businessId: kind === 'SETTLEMENT' ? 'settle_s1' : 'transfer1', kind, attempts: 0 };
  const db: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'ent1' }]),
    computeIntegrationExecution: { findUnique: jest.fn().mockResolvedValue(null) },
    enterprise: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    enterpriseComputeBinding: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ status: 'READY', mode: 'ENTERPRISE', remoteAccountId: 'acct1' }), updateMany: jest.fn() },
    computeIntegrationJob: { findMany: jest.fn().mockResolvedValue([job]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    computeIntegrationSettlement: { findUnique: jest.fn().mockResolvedValue({ id: 's1', enterpriseId: 'ent1', executionId: 'exec1', kind: 'chat',
      status: 'LOCAL_CONFIRMED', billId: 'bill1', billVersion: 1, grossCny: new Decimal(10), freeCny: new Decimal(3), paidCny: new Decimal(7), unpaidCny: new Decimal(0) }), update: jest.fn() },
    computeIntegrationTransfer: { updateMany: jest.fn(), findUnique: jest.fn().mockResolvedValue({ id: 't1', enterpriseId: 'ent1', businessId: 'transfer1', direction: 'credit_compute', status: 'PENDING',
      amountCny: new Decimal(100), fundingRef: 'fund1' }), update: jest.fn() },
  };
  db.computeIntegrationTransfer.findUniqueOrThrow = db.computeIntegrationTransfer.findUnique;
  db.$transaction = jest.fn(fn => fn(db));
  const receipt = { enterpriseId: 'ent1', businessId: 'settle_s1', remoteAccountId: 'acct1', remoteLedgerId: 'ledger1', executionId: 'exec1', billId: 'bill1', billVersion: 1,
    currency: 'CNY', freeCny: '3.000000', paidCny: '7.000000' };
  const remote = { isConnected: () => true, settle: jest.fn().mockResolvedValue(receipt), transfer: jest.fn().mockResolvedValue({
    enterpriseId: 'ent1', businessId: 'transfer1', remoteAccountId: 'acct1', remoteLedgerId: 'ledger2', currency: 'CNY', direction: 'credit_compute', amountCny: '100.000000',
  }) };
  const worker = new ComputeIntegrationWorker(db, remote as any, {} as any);
  return { db, job, remote, receipt, worker };
}

function provisioning() {
  const { db, job } = setup('PROVISION');
  const passwordHash = '$2b$10$' + 'a'.repeat(53);
  const admin = { id: 'admin1', email: 'original@example.test', authCredentials: [{ passwordHash }] };
  db.enterprise.findUnique.mockResolvedValue({ name: 'Original', status: 'ACTIVE', members: [{ user: admin }] });
  const remote = new ComputeRemoteAdapter({ isConfigured: () => true, encryptionKeyId: () => 'enc1' } as any);
  const provision = jest.spyOn(remote, 'provision').mockResolvedValue({ remoteAccountId: 'acct1', credentials: [] });
  const service = new ComputeIntegrationService(db, new ConfigService({ COMPUTE_CREDENTIAL_SECRET: 'fixture-secret' }), remote);
  const save = jest.spyOn(service, 'saveProvisioned').mockResolvedValue(undefined);
  const complete = jest.spyOn(service, 'completeConnection').mockResolvedValue({ mode: 'ENTERPRISE' } as any);
  db.computeIntegrationJob.updateMany.mockImplementation(({ data }) => {
    if (data.requestPayload) (job as any).requestPayload = data.requestPayload;
    return Promise.resolve({ count: 1 });
  });
  const worker = new ComputeIntegrationWorker(db, remote, service);
  return { db, job, admin, passwordHash, remote, service, provision, save, complete, worker };
}

describe('Compute integration durable delivery', () => {
  it('automatically completes the connection immediately after credentials are saved', async () => {
    const { worker, save, complete } = provisioning();
    await worker.deliver();
    expect(complete).toHaveBeenCalledWith('ent1');
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
  });

  it('automatically recovers previously provisioned accounts without provisioning them again', async () => {
    const { worker, db, provision, complete } = provisioning();
    db.computeIntegrationJob.findMany.mockResolvedValue([]);
    db.enterpriseComputeBinding.findMany.mockResolvedValue([{ enterpriseId: 'ent1' }, { enterpriseId: 'ent2' }]);
    complete.mockRejectedValueOnce(new ConflictException({ code: 'COMPUTE_INITIAL_BALANCE_CONFLICT', message: '余额需要核对' }));
    await worker.deliver();
    expect(provision).not.toHaveBeenCalled();
    expect(complete).toHaveBeenNthCalledWith(2, 'ent2');
    expect(db.enterpriseComputeBinding.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enterpriseId: 'ent1', status: 'READY' }),
      data: { lastErrorCode: 'COMPUTE_INITIAL_BALANCE_CONFLICT', lastErrorMessage: '余额需要核对' },
    }));
    await worker.deliver();
    expect(complete).toHaveBeenCalledTimes(4);
  });

  it('retains saved provisioning results if initialization fails and retries automatically', async () => {
    const { worker, save, complete, db } = provisioning();
    complete.mockRejectedValueOnce(new ConflictException('原任务尚未完成'));
    await worker.deliver();
    expect(save).toHaveBeenCalledTimes(1);
    expect(db.computeIntegrationJob.updateMany.mock.calls.some(([args]) => args.data.status === 'BLOCKED' || args.data.status === 'PENDING')).toBe(false);
    expect(db.enterpriseComputeBinding.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastErrorCode: 'COMPUTE_CONNECTION_PENDING', lastErrorMessage: '原任务尚未完成' },
    }));
  });

  it('freezes the exact hash and encryption version before sending and reuses them after a lost response', async () => {
    const { worker, provision, admin, db, job, passwordHash } = provisioning();
    provision.mockRejectedValueOnce(new Error('response lost'));
    await worker.deliver();
    admin.email = 'changed@example.test';
    admin.authCredentials[0].passwordHash = '$2b$12$' + 'b'.repeat(53);
    await worker.deliver();
    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision.mock.calls[0][0]).toEqual(provision.mock.calls[1][0]);
    expect(provision.mock.calls[1][0]).toMatchObject({ adminEmail: 'original@example.test', passwordHash, encryptionKeyId: 'enc1' });
    expect(JSON.stringify((job as any).requestPayload)).not.toContain(passwordHash);
    expect(db.computeIntegrationJob.updateMany.mock.calls.find(([args]) => args.data.requestPayload)[0].where)
      .toMatchObject({ status: 'RUNNING', leaseToken: expect.any(String) });
  });

  it('blocks missing passwords, retains the original identity and resumes after that admin sets a password', async () => {
    const { worker, admin, db, job, provision, service, passwordHash } = provisioning();
    admin.authCredentials = [];
    await worker.deliver();
    expect(provision).not.toHaveBeenCalled();
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'BLOCKED', lastErrorCode: 'LOCAL_PASSWORD_REQUIRED' }),
    }));
    expect((job as any).requestPayload).toMatchObject({ companyName: 'Original', adminEmail: admin.email, adminUserId: admin.id });
    admin.authCredentials = [{ passwordHash }];
    db.enterprise.findUnique.mockResolvedValue({ name: 'Changed', status: 'ACTIVE', members: [{ user: admin }] });
    await worker.deliver();
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'Original', adminEmail: 'original@example.test', passwordHash }));
    expect(service.registrationRequest((job as any).requestPayload).passwordHash).toBe(passwordHash);
  });

  it('does not take a password from a replacement administrator', async () => {
    const { worker, admin, db, job, service, provision } = provisioning();
    (job as any).requestPayload = service.registrationPayload({ enterpriseId: job.enterpriseId, registrationRef: job.businessId,
      companyName: 'Original', adminEmail: 'former@example.test', adminUserId: 'former-admin' });
    await worker.deliver();
    expect(admin.id).not.toBe('former-admin');
    expect(provision).not.toHaveBeenCalled();
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'BLOCKED', lastErrorCode: 'ENTERPRISE_UNAVAILABLE' }),
    }));
  });

  it.each(['EMAIL_ALREADY_EXISTS', 'INVALID_PASSWORD_HASH'])('blocks the original registration on %s without confirming or exposing the hash', async code => {
    const { worker, db, provision, save, passwordHash } = provisioning();
    provision.mockRejectedValue(new ConflictException({ error: { code, message: `registration rejected ${passwordHash}`, password_hash: passwordHash } }));
    await worker.deliver();
    expect(save).not.toHaveBeenCalled();
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'BLOCKED', lastErrorCode: code, lastErrorMessage: 'registration rejected [REDACTED]' }),
    }));
  });

  it('blocks an invalid local bcrypt hash before the network call', async () => {
    const { worker, admin, db, provision } = provisioning();
    admin.authCredentials[0].passwordHash = 'invalid-hash';
    await worker.deliver();
    expect(provision).not.toHaveBeenCalled();
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'BLOCKED', lastErrorCode: 'INVALID_PASSWORD_HASH' }),
    }));
  });

  it('blocks a corrupted frozen secret instead of replacing it with the current password', async () => {
    const { worker, db, job, provision, service, admin, passwordHash } = provisioning();
    (job as any).requestPayload = service.registrationPayload({ enterpriseId: job.enterpriseId, registrationRef: job.businessId,
      companyName: 'Original', adminEmail: admin.email, passwordHash });
    (job as any).requestPayload.encryptedPasswordHash = 'enc:v1:corrupted';
    await worker.deliver();
    expect(provision).not.toHaveBeenCalled();
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'BLOCKED', lastErrorCode: 'COMPUTE_REGISTRATION_SECRET_UNAVAILABLE' }),
    }));
  });

  it('does not send registration after losing the snapshot lease', async () => {
    const { worker, db, provision } = provisioning();
    db.computeIntegrationJob.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    await worker.deliver();
    expect(provision).not.toHaveBeenCalled();
  });

  it('commits only a matching settlement receipt and never mutates a local wallet', async () => {
    const { worker, db, remote } = setup(); await worker.deliver();
    expect(remote.settle).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'settle_s1', freeCny: '3.000000', paidCny: '7.000000' }));
    expect(db.computeIntegrationSettlement.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'COMMITTED', remoteLedgerId: 'ledger1' } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([{ paidCny: '10.000000' }, { enterpriseId: 'other' }, { currency: 'USD' }, { billVersion: 2 }])('does not confirm a mismatched receipt %j', async patch => {
    const { worker, db, remote, receipt } = setup(); remote.settle.mockResolvedValue({ ...receipt, ...patch }); await worker.deliver();
    expect(db.computeIntegrationSettlement.update).not.toHaveBeenCalled();
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING', lastErrorCode: 'SETTLEMENT_RECEIPT_MISMATCH' }) }));
  });

  it('reuses the original operation after an unknown result', async () => {
    const { worker, db, remote, receipt } = setup(); remote.settle.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(receipt);
    await worker.deliver(); await worker.deliver();
    expect(remote.settle.mock.calls[0][0]).toEqual(remote.settle.mock.calls[1][0]);
    expect(db.computeIntegrationSettlement.update).toHaveBeenCalledTimes(1);
  });

  it('prevents a stale lease holder from completing the original operation', async () => {
    const { worker, db } = setup(); db.computeIntegrationJob.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    await worker.deliver(); expect(db.computeIntegrationSettlement.update).not.toHaveBeenCalled();
  });

  it('does not send unpaid or disabled-mode operations', async () => {
    const { worker, db, remote } = setup(); db.enterpriseComputeBinding.findUnique.mockResolvedValue({ mode: 'PREPARING', status: 'READY', remoteAccountId: 'acct1' });
    await worker.deliver(); expect(remote.settle).not.toHaveBeenCalled();
  });

  it('checks direction and amount before completing a transfer', async () => {
    const { worker, db, remote } = setup('TRANSFER'); await worker.deliver();
    expect(remote.transfer).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'transfer1', amountCny: '100.000000', direction: 'credit_compute' }));
    expect(db.computeIntegrationTransfer.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'COMMITTED', remoteLedgerId: 'ledger2' } });
  });

  it('stops retrying an explicitly rejected transfer and preserves its reason', async () => {
    const { worker, db, remote } = setup('TRANSFER');
    remote.transfer.mockRejectedValue(new ConflictException({ code: 'COMPUTE_TRANSFER_REJECTED', message: '余额不足，原单已拒绝' }));
    await worker.deliver();
    expect(db.computeIntegrationTransfer.update).not.toHaveBeenCalled();
    expect(db.computeIntegrationTransfer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'FAILED' } }));
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED', lastErrorMessage: '余额不足，原单已拒绝' }) }));
  });

  it('reuses the durable registration identity and encryption version after company details change', async () => {
    const { db, remote } = setup('PROVISION');
    const original = { enterpriseId: 'ent1', registrationRef: 'reg1', companyName: 'Original', adminEmail: 'first@example.test', encryptionKeyId: 'old-version', passwordHash: '$2b$10$' + 'a'.repeat(53) };
    db.enterprise.findUnique.mockResolvedValue({ name: 'Changed', status: 'ACTIVE', members: [{ user: { email: 'changed@example.test' } }] });
    const adapter = { ...remote, provision: jest.fn().mockResolvedValue({}), registration: jest.fn(value => value) };
    const integration = new ComputeIntegrationService(db, new ConfigService({ COMPUTE_CREDENTIAL_SECRET: 'fixture-secret' }), adapter as any);
    const stored = integration.registrationPayload(original);
    db.computeIntegrationJob.findMany.mockResolvedValue([{ id: 'job1', enterpriseId: 'ent1', businessId: 'reg1', kind: 'PROVISION', attempts: 1, requestPayload: stored }]);
    jest.spyOn(integration, 'saveProvisioned').mockResolvedValue(undefined);
    await new ComputeIntegrationWorker(db, adapter as any, integration as any).deliver();
    expect(adapter.provision).toHaveBeenCalledWith(original);
    expect(integration.saveProvisioned).toHaveBeenCalled();
  });

  it('records an upstream configuration failure verbatim after removing credentials', async () => {
    const { worker, db, remote } = setup();
    remote.settle.mockRejectedValue(new ConflictException({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'original payload differs; Bearer sk-secret-fixture' } }));
    await worker.deliver();
    expect(db.computeIntegrationJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'BLOCKED',
      lastErrorCode: 'IDEMPOTENCY_CONFLICT', lastErrorMessage: 'original payload differs; Bearer [REDACTED]' }) }));
  });
});
