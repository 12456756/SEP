import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret-cipher';
import { ComputePasswordSyncService } from './compute-password-sync.service';

const secret = 'password-sync-fixture-only';
const passwordHash = '$2b$12$' + 'a'.repeat(53);
function setup() {
  let state: any = { id: 'sync1', enterpriseId: 'ent1', userId: 'u1', version: 1, status: 'PENDING', attempts: 0,
    encryptedPasswordHash: encryptSecret(passwordHash, secret) };
  const original = { enterpriseId: 'ent1', registrationRef: 'reg_ent1', companyName: 'Company', adminEmail: 'owner@example.test', adminUserId: 'u1' };
  const db: any = {
    enterprise: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    enterpriseComputeBinding: { findUnique: jest.fn().mockResolvedValue({ status: 'READY', remoteAccountId: '11' }) },
    computeIntegrationJob: { findMany: jest.fn().mockResolvedValue([{ enterpriseId: 'ent1', requestPayload: original }]) },
    computePasswordSync: {
      upsert: jest.fn(), findMany: jest.fn().mockImplementation(async () => state.status === 'PENDING' ? [{ ...state }] : []),
      count: jest.fn().mockImplementation(async () => state.status === 'PENDING' ? 1 : 0),
      updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
        if (where.version !== state.version) return { count: 0 };
        state = { ...state, ...data }; return { count: 1 };
      }),
    },
  };
  const remote = { isConnected: jest.fn().mockReturnValue(true), syncPassword: jest.fn().mockResolvedValue({ status: 'applied' }) };
  const service = new ComputePasswordSyncService(db, new ConfigService({ COMPUTE_CREDENTIAL_SECRET: secret }), remote as any);
  return { db, remote, service, original, getState: () => state, updateState: (patch: any) => { state = { ...state, ...patch }; } };
}

describe('Enterprise login password synchronization', () => {
  it('queues the original account owner in the caller transaction and encrypts the exact hash', async () => {
    const { db, service } = setup();
    await service.enqueue(db, { id: 'u1', email: 'owner@example.test' }, passwordHash);
    const args = db.computePasswordSync.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ enterpriseId: 'ent1' });
    expect(args.update.version).toEqual({ increment: 1 });
    expect(args.create.encryptedPasswordHash).toMatch(/^enc:v1:/);
    expect(decryptSecret(args.create.encryptedPasswordHash, secret)).toBe(passwordHash);
    expect(JSON.stringify(args)).not.toContain(passwordHash);
  });

  it('does not use email matching to replace the immutable original administrator', async () => {
    const { db, service, original } = setup();
    original.adminUserId = 'former-owner';
    await service.enqueue(db, { id: 'u1', email: 'owner@example.test' }, passwordHash);
    expect(db.computePasswordSync.upsert).not.toHaveBeenCalled();
  });

  it('does not enqueue ordinary members without an owned provisioning task', async () => {
    const { db, service } = setup(); db.computeIntegrationJob.findMany.mockResolvedValue([]);
    await service.enqueue(db, { id: 'member', email: 'member@example.test' }, passwordHash);
    expect(db.computePasswordSync.upsert).not.toHaveBeenCalled();
  });

  it('sends only the hash to the bound account and clears the local delivery secret after success', async () => {
    const { service, remote, getState } = setup();
    expect(await service.syncUser('u1')).toBe('SYNCED');
    expect(remote.syncPassword).toHaveBeenCalledWith({ enterpriseId: 'ent1', remoteAccountId: '11', operationId: 'pwd_sync1_1', version: 1, passwordHash });
    expect(getState()).toMatchObject({ status: 'SYNCED', encryptedPasswordHash: null });
  });

  it('recovers a lost response using the same operation and version without exposing the hash', async () => {
    const { service, remote, getState } = setup();
    remote.syncPassword.mockRejectedValueOnce(new ConflictException({ code: 'REMOTE_TIMEOUT', message: `failed ${passwordHash}` }));
    expect(await service.syncUser('u1')).toBe('PENDING');
    expect(getState().lastErrorMessage).not.toContain(passwordHash);
    await service.retry();
    expect(remote.syncPassword.mock.calls[0]).toEqual(remote.syncPassword.mock.calls[1]);
    expect(getState().status).toBe('SYNCED');
  });

  it('does not mark a newer password synced or clear its hash when an old response arrives', async () => {
    const { service, remote, getState, updateState } = setup();
    remote.syncPassword.mockImplementationOnce(async () => { updateState({ version: 2, encryptedPasswordHash: 'new-encrypted-hash' }); return { status: 'applied' }; });
    expect(await service.syncUser('u1')).toBe('PENDING');
    expect(getState()).toMatchObject({ status: 'PENDING', version: 2, encryptedPasswordHash: 'new-encrypted-hash' });
  });

  it.each([null, { status: 'PENDING' }])('waits for provisioning with binding %j without losing the latest password', async binding => {
    const { service, remote, db, getState } = setup(); db.enterpriseComputeBinding.findUnique.mockResolvedValue(binding);
    expect(await service.syncUser('u1')).toBe('PENDING');
    expect(remote.syncPassword).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ lastErrorCode: 'COMPUTE_ACCOUNT_PENDING' });
    expect(getState().encryptedPasswordHash).toMatch(/^enc:v1:/);
  });

  it('does not update a deleted or suspended enterprise account', async () => {
    const { service, db, remote } = setup(); db.enterprise.findUnique.mockResolvedValue({ status: 'DELETED' });
    expect(await service.syncUser('u1')).toBe('PENDING');
    expect(remote.syncPassword).not.toHaveBeenCalled();
  });

  it('does not send an undecryptable local secret', async () => {
    const { service, remote, updateState, getState } = setup(); updateState({ encryptedPasswordHash: 'enc:v1:corrupt' });
    expect(await service.syncUser('u1')).toBe('PENDING');
    expect(remote.syncPassword).not.toHaveBeenCalled();
    expect(getState().lastErrorCode).toBe('COMPUTE_PASSWORD_SECRET_INVALID');
  });
});
