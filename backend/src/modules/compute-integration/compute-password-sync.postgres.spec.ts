import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptSecret } from '../../common/crypto/secret-cipher';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputePasswordSyncService } from './compute-password-sync.service';

const databaseUrl = process.env.COMPUTE_TEST_DATABASE_URL;
const isolated = databaseUrl ? describe : describe.skip;
const secret = 'isolated-password-sync-test-only';
const firstHash = '$2b$12$' + 'a'.repeat(53);
const secondHash = '$2b$12$' + 'b'.repeat(53);

isolated('Password synchronization PostgreSQL transaction', () => {
  let db: PrismaService;
  let service: ComputePasswordSyncService;
  let integrations: ComputeIntegrationService;
  let user: { id: string; email: string };
  let enterpriseId: string;
  const remote: any = { isConnected: () => false, syncPassword: jest.fn().mockResolvedValue({ status: 'applied' }) };
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.port !== '25434' || url.pathname !== '/sep_compute_test') throw new Error('Dedicated local database only');
    db = new PrismaService({ datasourceUrl: databaseUrl }); await db.$connect();
    const config = new ConfigService({ COMPUTE_CREDENTIAL_SECRET: secret });
    service = new ComputePasswordSyncService(db, config, remote);
    integrations = new ComputeIntegrationService(db, config, remote);
  });
  afterAll(async () => { await db?.$disconnect(); });
  beforeEach(async () => {
    user = await db.user.create({ data: { email: `password-${randomUUID()}@example.test`, authCredentials: { create: { type: 'LOCAL_PASSWORD', passwordHash: firstHash } } } });
    const enterprise = await db.enterprise.create({ data: { name: 'Password sync test' } }); enterpriseId = enterprise.id;
    await integrations.ensureBinding(enterpriseId, db, { companyName: enterprise.name, adminEmail: user.email, adminUserId: user.id, passwordHash: firstHash });
    remote.syncPassword.mockClear();
  });

  async function save(hash: string, rollback = false) {
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${user.id} FOR UPDATE`;
      await tx.authCredential.update({ where: { userId_type: { userId: user.id, type: 'LOCAL_PASSWORD' } }, data: { passwordHash: hash } });
      await service.enqueue(tx, user, hash);
      if (rollback) throw new Error('rollback fixture');
    });
  }
  it('rolls back the password and delivery task together', async () => {
    await expect(save(secondHash, true)).rejects.toThrow('rollback fixture');
    expect((await db.authCredential.findUniqueOrThrow({ where: { userId_type: { userId: user.id, type: 'LOCAL_PASSWORD' } } })).passwordHash).toBe(firstHash);
    expect(await db.computePasswordSync.count({ where: { enterpriseId } })).toBe(0);
  });
  it('serializes concurrent password versions and keeps only the hash matching the final local password', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => save(i % 2 ? secondHash : firstHash)));
    const state = await db.computePasswordSync.findUniqueOrThrow({ where: { enterpriseId } });
    const current = await db.authCredential.findUniqueOrThrow({ where: { userId_type: { userId: user.id, type: 'LOCAL_PASSWORD' } } });
    expect(state.version).toBe(6);
    expect(decryptSecret(state.encryptedPasswordHash!, secret)).toBe(current.passwordHash);
    expect(await db.computePasswordSync.count({ where: { enterpriseId } })).toBe(1);
  });
  it('waits for account creation and then sends the latest password and clears its delivery secret', async () => {
    await save(secondHash);
    expect(await service.syncUser(user.id)).toBe('PENDING');
    expect(remote.syncPassword).not.toHaveBeenCalled();
    await db.enterpriseComputeBinding.update({ where: { enterpriseId }, data: { status: 'READY', remoteAccountId: `remote-${randomUUID()}` } });
    expect(await service.syncUser(user.id)).toBe('SYNCED');
    expect(remote.syncPassword).toHaveBeenCalledWith(expect.objectContaining({ passwordHash: secondHash }));
    expect(await db.computePasswordSync.findUniqueOrThrow({ where: { enterpriseId } })).toMatchObject({ status: 'SYNCED', encryptedPasswordHash: null });
  });
});
