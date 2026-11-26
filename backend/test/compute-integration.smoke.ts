import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/modules/auth/session.service';

async function main() {
  const databaseUrl = process.env.COMPUTE_TEST_DATABASE_URL;
  const baseUrl = process.env.COMPUTE_TEST_API_ORIGIN;
  const secret = process.env.COMPUTE_TEST_JWT_SECRET;
  if (!databaseUrl || !baseUrl || !secret) throw new Error('Explicit isolated database, API origin and test JWT secret are required');
  const database = new URL(databaseUrl); const origin = new URL(baseUrl);
  if (!['localhost', '127.0.0.1'].includes(database.hostname) || !database.pathname.startsWith('/sep_compute_test')
    || origin.hostname !== '127.0.0.1' || origin.port !== '3012') throw new Error('Only the dedicated local compute preview is allowed');
  const db = new PrismaService({ datasourceUrl: databaseUrl });
  const config = new ConfigService({ JWT_SECRET: secret });
  const sessions = new SessionService(db, config);
  try {
    const password = 'SepPreview_20261120!';
    const admin = await db.user.upsert({ where: { email: 'compute-preview@example.test' }, update: {},
      create: { email: 'compute-preview@example.test', name: '本地验证管理员', role: 'ADMIN', emailVerifiedAt: new Date(),
        authCredentials: { create: { type: 'LOCAL_PASSWORD', passwordHash: await bcrypt.hash(password, 10) } } } });
    const enterprise = await db.enterprise.create({ data: { name: `本地算力验证-${randomUUID().slice(0, 8)}` } });
    const companyAdmin = await db.user.create({ data: { email: `compute-company-${randomUUID()}@example.test`,
      memberships: { create: { enterpriseId: enterprise.id, role: 'ENTERPRISE_ADMIN' } } } });
    const member = await db.user.create({ data: { email: `compute-member-${randomUUID()}@example.test` } });
    const jwt = new JwtService({ secret });
    async function token(user: { id: string; role: string }) {
      const session = await sessions.createSession({ userId: user.id, clientType: 'WEB', refreshTtlSeconds: 3600 });
      return jwt.sign({ sub: user.id, sid: session.sessionId, type: 'access' }, { expiresIn: '1h' });
    }
    const [adminToken, companyToken, memberToken] = await Promise.all([token(admin), token(companyAdmin), token(member)]);
    async function check(path: string, expected: number, access?: string, method = 'GET') {
      const response = await fetch(`${baseUrl}/api${path}`, { method, headers: access ? { Authorization: `Bearer ${access}` } : {} });
      const body = await response.json();
      if (response.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, received ${response.status}`);
      if (/encryptedKey|"apiKey"/.test(JSON.stringify(body))) throw new Error('Status API exposed credential material');
      return body;
    }
    await check('/admin/compute-integrations', 401);
    await check('/admin/compute-integrations', 403, memberToken);
    await check('/admin/compute-integrations?pageSize=10000', 400, adminToken);
    const prepared = await check(`/admin/compute-integrations/${enterprise.id}/prepare`, 201, adminToken, 'POST');
    if (prepared.mode !== 'PREPARING' || prepared.connected || 'activationAllowed' in prepared) throw new Error('Unexpected provisioning state or manual activation switch');
    await check(`/admin/compute-integrations/${enterprise.id}/activate`, 404, adminToken, 'POST');
    const own = await check('/enterprise/compute-integration?enterpriseId=other', 200, companyToken);
    if (own.enterpriseId !== enterprise.id) throw new Error('Enterprise tenant isolation failed');
    await check('/enterprise/compute-integration', 403, memberToken);
    const records = await check(`/admin/compute-integrations/${enterprise.id}/records`, 200, adminToken);
    await check(`/admin/compute-integrations/jobs/${records.jobs[0].id}/retry`, 503, adminToken, 'POST');
    await check('/admin/compute-integrations', 200, adminToken);
    const missingCatalog = await check('/enterprise/model-config/available-models', 503, companyToken);
    if (!missingCatalog.message?.includes('尚未就绪')) throw new Error('Enterprise model catalog hid the missing account reason');
    await check('/enterprise/model-config', 503, companyToken);
    for (const path of ['/enterprise/media-config', '/enterprise/media-config/video']) {
      const media = await check(path, 200, companyToken);
      if (media.configured) throw new Error('Missing enterprise credential borrowed an administrator connection');
      const profiles = await check(`${path}/available-profiles`, 200, companyToken);
      if (!Array.isArray(profiles) || profiles.length) throw new Error('Missing enterprise credential exposed administrator profiles');
    }
    console.log('PASS: 18 live HTTP checks on isolated backend; no remote model or billing calls');
    console.log('Local preview account: compute-preview@example.test / ' + password);
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
