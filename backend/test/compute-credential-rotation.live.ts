import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { encryptSecret } from '../src/common/crypto/secret-cipher';
import { ComputeProtocolClient } from '../src/modules/compute-integration/compute-protocol.client';
import { ComputeCredentialRotationRemote } from '../src/modules/compute-integration/compute-credential-rotation.remote';
import { ComputeCredentialRotationService } from '../src/modules/compute-integration/compute-credential-rotation.service';

async function main() {
  assert.equal(process.env.SEP_ROTATION_CONTRACT_TEST, 'isolated-only');
  const url = new URL(process.env.COMPUTE_TEST_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '25434'); assert.equal(url.pathname, '/sep_compute_test');
  const enterpriseId = process.env.ROTATION_TEST_ENTERPRISE_ID!;
  assert.ok(enterpriseId.startsWith('rotation-live-'));
  const config = new ConfigService({ ...process.env, NODE_ENV: 'test', COMPUTE_CREDENTIAL_SECRET: 'rotation-live-test-secret',
    COMPUTE_INTEGRATION_ENABLED: 'true', COMPUTE_ALLOW_LOOPBACK_HTTP: 'true', COMPUTE_SIGNING_KEY_ID: 'sign-live', COMPUTE_ENCRYPTION_KEY_ID: 'enc-test',
    COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES: JSON.stringify({ 'enc-test': process.env.ROTATION_TEST_ENCRYPTION_FILE }) });
  const protocol = new ComputeProtocolClient(config);
  const db = new PrismaService({ datasourceUrl: url.toString() });
  const service = new ComputeCredentialRotationService(db, config, new ComputeCredentialRotationRemote(protocol));
  let userId: string | undefined;
  try {
    await db.$connect();
    const user = await db.user.create({ data: { email: `rotation-live-${randomUUID()}@example.test` } }); userId = user.id;
    await db.enterprise.create({ data: { id: enterpriseId, name: 'Rotation signed contract fixture', members: { create: { userId, role: 'ENTERPRISE_ADMIN' } } } });
    await db.enterpriseComputeBinding.create({ data: { enterpriseId, registrationRef: randomUUID(), remoteAccountId: '1', mode: 'ENTERPRISE', status: 'READY' } });
    for (const kind of ['chat', 'image', 'video']) await db.enterpriseComputeCredential.create({ data: { enterpriseId, kind, remoteId: `old-${kind}`,
      version: 1, encryptedKey: encryptSecret(`old-${kind}`, config.getOrThrow('COMPUTE_CREDENTIAL_SECRET')), maskedKey: 'old****' } });
    for (const kind of ['chat', 'image', 'video'] as const) {
      const request = { operationId: randomUUID(), kind, expectedVersion: 1 };
      const replies = await Promise.all(Array.from({ length: 4 }, () => service.start(userId!, request)));
      assert.equal(new Set(replies.map(row => row!.id)).size, 1);
      const row = await db.computeCredentialRotation.findUniqueOrThrow({ where: { operationId: request.operationId } });
      await Promise.all([service.deliver(row), service.deliver(row)]);
      assert.equal((await db.computeCredentialRotation.findUniqueOrThrow({ where: { id: row.id } })).status, 'COMPLETED');
      const current = await db.enterpriseComputeCredential.findFirstOrThrow({ where: { enterpriseId, kind, active: true } });
      assert.equal(current.version, 2);
      const receipt: any = await protocol.json(`/api/v1/sep/enterprises/${enterpriseId}/credential-rotations/${request.operationId}`, { enterpriseId });
      assert.equal(receipt.status, 'completed'); assert.equal(receipt.credential.credential_id, current.remoteId);
      assert.ok(!JSON.stringify(await service.list(userId!)).includes('encrypted_key'));
    }
    assert.equal(await db.computeIntegrationSettlement.count({ where: { enterpriseId } }), 0);
    assert.equal(await db.computeIntegrationTransfer.count({ where: { enterpriseId } }), 0);
    process.stdout.write('Signed cross-platform rotation passed for chat, image and video; no generation or money mutation.\n');
  } finally {
    await db.computeCredentialRotation.deleteMany({ where: { enterpriseId } });
    await db.enterpriseComputeCredential.deleteMany({ where: { enterpriseId } });
    await db.enterpriseComputeBinding.deleteMany({ where: { enterpriseId } });
    await db.enterprise.deleteMany({ where: { id: enterpriseId } });
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  }
}
main().catch(() => { process.stderr.write('Isolated rotation contract failed; inspect scoped test state without printing credentials.\n'); process.exitCode = 1; });
