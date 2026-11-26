import { ConfigService } from '@nestjs/config';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-cipher';
import { ComputeCredentialRotationService } from './compute-credential-rotation.service';
import { ComputeAccountingService } from './compute-accounting.service';

const databaseUrl = process.env.COMPUTE_TEST_DATABASE_URL;
const isolated = databaseUrl ? describe : describe.skip;
const secret = 'rotation-isolated-test-secret';

isolated('Credential rotation PostgreSQL transactions and recovery', () => {
  let db: PrismaService, service: ComputeCredentialRotationService, enterpriseId: string, userId: string;
  let old: { id: string; remoteId: string };
  const remote: any = { connected: () => true, encryptionKeyId: () => 'enc-test', prepare: jest.fn(), advance: jest.fn() };
  const request = (kind = 'chat') => ({ operationId: randomUUID(), kind: kind as 'chat', expectedVersion: 1 });
  const currentTask = () => db.computeCredentialRotation.findFirstOrThrow({ where: { enterpriseId } });
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.port !== '25434' || url.pathname !== '/sep_compute_test') throw new Error('Dedicated local database only');
    db = new PrismaService({ datasourceUrl: databaseUrl }); await db.$connect();
    service = new ComputeCredentialRotationService(db, new ConfigService({ COMPUTE_CREDENTIAL_SECRET: secret }), remote);
  });
  afterAll(async () => { await db?.$disconnect(); });
  beforeEach(async () => {
    const user = await db.user.create({ data: { email: `rotation-${randomUUID()}@example.test` } }); userId = user.id;
    const enterprise = await db.enterprise.create({ data: { name: 'Rotation test', members: { create: { userId, role: 'ENTERPRISE_ADMIN' } } } }); enterpriseId = enterprise.id;
    await db.enterpriseComputeBinding.create({ data: { enterpriseId, registrationRef: randomUUID(), remoteAccountId: randomUUID(), mode: 'ENTERPRISE', status: 'READY' } });
    const keys = await Promise.all(['chat', 'image', 'video'].map(kind => db.enterpriseComputeCredential.create({ data: {
      enterpriseId, kind, remoteId: randomUUID(), version: 1, encryptedKey: encryptSecret('original-key', secret), maskedKey: 'orig****key',
    } })));
    old = keys[0];
    remote.prepare.mockReset().mockImplementation(async row => ({ enterprise_id: row.enterpriseId, compute_account_id: row.remoteAccountId,
      type: row.kind, credential_id: `new-${row.oldRemoteId}`, credential_version: row.expectedVersion + 1, key: `new-secret-${row.kind}` }));
    remote.advance.mockReset().mockResolvedValue({});
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.computeCredentialRotation.deleteMany({ where: { enterpriseId } });
    await db.computeIntegrationSettlement.deleteMany({ where: { enterpriseId } });
    await db.computeIntegrationExecution.deleteMany({ where: { enterpriseId } });
    await db.enterpriseComputeCredential.deleteMany({ where: { enterpriseId } });
    await db.enterpriseComputeBinding.deleteMany({ where: { enterpriseId } });
    await db.enterprise.delete({ where: { id: enterpriseId } });
    await db.user.delete({ where: { id: userId } });
  });

  it('replays concurrent identical operations and exposes no internal credentials', async () => {
    const value = request();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.start(userId, value)));
    expect(new Set(results.map(row => row!.id)).size).toBe(1);
    expect(await db.computeCredentialRotation.count({ where: { enterpriseId } })).toBe(1);
    expect(results[0]).not.toHaveProperty('oldCredentialId');
    expect(results[0]).not.toHaveProperty('encryptionKeyId');
    expect(remote.prepare).not.toHaveBeenCalled();
    await expect(service.start(userId, { ...value, kind: 'image' })).rejects.toThrow('不同请求');
  });
  it('allows one new operation per purpose while allowing separate purposes', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.start(userId, request())));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    await expect(service.start(userId, request('image'))).resolves.toMatchObject({ kind: 'image' });
    await expect(service.start(userId, request('video'))).resolves.toMatchObject({ kind: 'video' });
  });
  it('rejects stale versions and non-admins before creating a task', async () => {
    await expect(service.start(userId, { ...request(), expectedVersion: 2 })).rejects.toThrow('版本已变化');
    await db.enterpriseMember.updateMany({ where: { enterpriseId }, data: { role: 'MEMBER' } });
    await expect(service.start(userId, request())).rejects.toThrow('仅企业管理员');
    expect(await db.computeCredentialRotation.count({ where: { enterpriseId } })).toBe(0);
  });
  it('claims one worker, switches once, encrypts the key and leaves all accounting untouched', async () => {
    await service.start(userId, request()); const row = await currentTask();
    const snapshots = await Promise.all([db.computeIntegrationSettlement.count({ where: { enterpriseId } }), db.computeIntegrationTransfer.count({ where: { enterpriseId } })]);
    await Promise.all(Array.from({ length: 8 }, () => service.deliver(row)));
    expect(remote.prepare).toHaveBeenCalledTimes(1);
    expect(remote.advance.mock.calls.map(([, action]) => action)).toEqual(['ack', 'retire']);
    expect(await currentTask()).toMatchObject({ status: 'COMPLETED', openSlot: null, leaseToken: null });
    const credentials = await db.enterpriseComputeCredential.findMany({ where: { enterpriseId, kind: 'chat' }, orderBy: { version: 'asc' } });
    expect(credentials.map(row => [row.version, row.active])).toEqual([[1, false], [2, true]]);
    expect(credentials[1].encryptedKey).not.toContain('new-secret-chat');
    expect(decryptSecret(credentials[1].encryptedKey, secret)).toBe('new-secret-chat');
    expect(await Promise.all([db.computeIntegrationSettlement.count({ where: { enterpriseId } }), db.computeIntegrationTransfer.count({ where: { enterpriseId } })])).toEqual(snapshots);
  });
  it('keeps the old key when delivery times out and retries the same operation', async () => {
    await service.start(userId, request());
    remote.prepare.mockRejectedValueOnce(new ServiceUnavailableException('回执暂未收到'));
    await service.deliver(await currentTask());
    expect(await db.enterpriseComputeCredential.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ active: true });
    expect(await currentTask()).toMatchObject({ status: 'PENDING', leaseToken: null });
    await service.deliver(await currentTask());
    expect(remote.prepare.mock.calls[0][0].operationId).toBe(remote.prepare.mock.calls[1][0].operationId);
    expect(await currentTask()).toMatchObject({ status: 'COMPLETED' });
  });
  it('rolls back local switching if storing the new key fails', async () => {
    await service.start(userId, request());
    // A valid delivery can still fail a local unique constraint; both local changes must roll back.
    remote.prepare.mockImplementationOnce(async row => ({ credential_id: 'bad-version', credential_version: 1, key: 'new-secret' }));
    await service.deliver(await currentTask());
    expect(await db.enterpriseComputeCredential.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ active: true });
    expect(await db.enterpriseComputeCredential.count({ where: { enterpriseId, kind: 'chat' } })).toBe(1);
    expect(remote.advance).not.toHaveBeenCalled();
  });
  it('recovers a lost acknowledgement without preparing or switching another key', async () => {
    await service.start(userId, request());
    remote.advance.mockRejectedValueOnce(new ServiceUnavailableException('确认响应丢失'));
    await service.deliver(await currentTask());
    expect(await currentTask()).toMatchObject({ status: 'SWITCHED' });
    await service.deliver(await currentTask());
    expect(remote.prepare).toHaveBeenCalledTimes(1);
    expect(remote.advance.mock.calls.map(([, action]) => action)).toEqual(['ack', 'ack', 'retire']);
    expect(await db.enterpriseComputeCredential.count({ where: { enterpriseId, kind: 'chat' } })).toBe(2);
    expect(await currentTask()).toMatchObject({ status: 'COMPLETED' });
  });
  it('holds retirement for prepared or uncertain old executions and preserves their credentials', async () => {
    const accounting = new ComputeAccountingService(db);
    const execution = await accounting.createExecution({ enterpriseId, kind: 'chat', sourceRef: randomUUID(), credentialId: old.id });
    await service.start(userId, request()); await service.deliver(await currentTask());
    expect(await currentTask()).toMatchObject({ status: 'DRAINING', lastErrorCode: 'CREDENTIAL_TASKS_PENDING' });
    expect(remote.advance.mock.calls.map(([, action]) => action)).toEqual(['ack']);
    await expect(accounting.createExecution({ enterpriseId, kind: 'chat', sourceRef: execution.sourceRef, credentialId: old.id })).resolves.toMatchObject({ id: execution.id });
    await expect(accounting.createExecution({ enterpriseId, kind: 'chat', sourceRef: randomUUID(), credentialId: old.id })).rejects.toThrow('原请求尚未发送');
    await db.computeIntegrationExecution.update({ where: { id: execution.id }, data: { dispatchStatus: 'UNKNOWN' } });
    await service.deliver(await currentTask());
    expect(remote.advance).toHaveBeenCalledTimes(1);
    await db.computeIntegrationExecution.update({ where: { id: execution.id }, data: { dispatchStatus: 'NOT_SUBMITTED' } });
    await service.deliver(await currentTask());
    expect(await currentTask()).toMatchObject({ status: 'COMPLETED' });
    expect(await db.enterpriseComputeCredential.findUnique({ where: { id: old.id } })).not.toBeNull();
  });
  it('blocks mismatched receipts and resumes only the original operation after correction', async () => {
    await service.start(userId, request());
    remote.prepare.mockRejectedValueOnce(new ConflictException({ code: 'CREDENTIAL_ROTATION_RECEIPT_MISMATCH', message: '凭证归属不一致' }));
    await service.deliver(await currentTask());
    const blocked = await currentTask(); expect(blocked.status).toBe('BLOCKED');
    await expect(service.start(userId, request())).rejects.toThrow('未完成');
    await expect(service.get('unknown-user', blocked.operationId)).rejects.toThrow('仅企业管理员');
    expect(await service.retry(userId, blocked.operationId)).toMatchObject({ status: 'PENDING', operationId: blocked.operationId });
    await service.deliver(await currentTask());
    expect(await currentTask()).toMatchObject({ status: 'COMPLETED', operationId: blocked.operationId });
  });
  it('waits for a locally final bill to be committed remotely before retiring', async () => {
    const execution = await new ComputeAccountingService(db).createExecution({ enterpriseId, kind: 'chat', sourceRef: randomUUID(), credentialId: old.id });
    await db.computeIntegrationExecution.update({ where: { id: execution.id }, data: { dispatchStatus: 'COMPLETED', feeStatus: 'FINAL', localUsageRecordId: 'local-usage' } });
    const settlement = await db.computeIntegrationSettlement.create({ data: { enterpriseId, executionId: execution.id, kind: 'chat', billId: randomUUID(),
      billVersion: 1, grossCny: '0', freeCny: '0', paidCny: '0', unpaidCny: '0', decisionHash: 'test', status: 'LOCAL_CONFIRMED' } });
    await service.start(userId, request()); await service.deliver(await currentTask());
    expect(await currentTask()).toMatchObject({ status: 'DRAINING', lastErrorCode: 'CREDENTIAL_TASKS_PENDING' });
    expect(remote.advance.mock.calls.map(([, action]) => action)).toEqual(['ack']);
    await db.computeIntegrationSettlement.update({ where: { id: settlement.id }, data: { status: 'COMMITTED' } });
    await service.deliver(await currentTask());
    expect(await currentTask()).toMatchObject({ status: 'COMPLETED' });
  });
  it('rejects a late worker after its lease was taken over', async () => {
    await service.start(userId, request()); const row = await currentTask();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    remote.prepare.mockImplementationOnce(async task => { entered(); await gate; return {
      credential_id: `new-${task.oldRemoteId}`, credential_version: 2, key: 'late-key',
    }; });
    const first = service.deliver(row); await started;
    await db.computeCredentialRotation.update({ where: { id: row.id }, data: { leaseUntil: new Date(0) } });
    await service.deliver(await currentTask()); release(); await first;
    expect(await currentTask()).toMatchObject({ status: 'COMPLETED', lastErrorCode: null });
    const next = await db.enterpriseComputeCredential.findFirstOrThrow({ where: { enterpriseId, kind: 'chat', active: true } });
    expect(decryptSecret(next.encryptedKey, secret)).toBe('new-secret-chat');
  });
});
