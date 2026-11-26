import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { ComputeIntegrationController, EnterpriseComputeIntegrationController } from './compute-integration.controller';

describe('Compute integration HTTP authorization', () => {
  let app: INestApplication;
  const db: any = {
    enterprise: { findUnique: jest.fn().mockResolvedValue({ name: '测试企业' }), findMany: jest.fn().mockResolvedValue([{ id: 'ent1' }]), count: jest.fn().mockResolvedValue(1) },
    enterpriseMember: { findFirst: jest.fn().mockImplementation(({ where }) => Promise.resolve(where.userId === 'company-admin' ? { enterpriseId: 'ent1' } : null)) },
    enterpriseComputeBinding: { findUnique: jest.fn().mockResolvedValue(null) },
    enterpriseComputeCredential: { findMany: jest.fn().mockResolvedValue([]) },
    computeIntegrationJob: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn().mockResolvedValue({ kind: 'PROVISION' }) },
    computeIntegrationReconciliation: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ComputeIntegrationController, EnterpriseComputeIntegrationController], providers: [
      ComputeIntegrationService, ComputeRemoteAdapter, { provide: PrismaService, useValue: db }, { provide: ConfigService, useValue: new ConfigService() },
    ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest(); const role = req.headers['x-test-user'];
      if (!role) throw new UnauthorizedException();
      req.user = { id: role, role: role === 'platform-admin' ? 'ADMIN' : 'USER' }; return true;
    } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
  });
  afterAll(async () => { await app.close(); });

  it('requires an authenticated platform administrator for list and mutation routes', async () => {
    await request(app.getHttpServer()).get('/api/admin/compute-integrations').expect(401);
    await request(app.getHttpServer()).get('/api/admin/compute-integrations').set('x-test-user', 'company-admin').expect(403);
    await request(app.getHttpServer()).post('/api/admin/compute-integrations/ent1/prepare').set('x-test-user', 'company-admin').expect(403);
    const response = await request(app.getHttpServer()).get('/api/admin/compute-integrations').set('x-test-user', 'platform-admin').expect(200);
    expect(response.body.items[0]).toMatchObject({ enterpriseId: 'ent1', connected: false });
    expect(response.body.items[0]).not.toHaveProperty('activationAllowed');
    expect(JSON.stringify(response.body)).not.toContain('encryptedKey');
  });

  it('validates pagination before querying the database', async () => {
    await request(app.getHttpServer()).get('/api/admin/compute-integrations?pageSize=10000').set('x-test-user', 'platform-admin').expect(400);
  });

  it('does not expose a manual activation switch', async () => {
    await request(app.getHttpServer()).post('/api/admin/compute-integrations/ent1/activate').set('x-test-user', 'platform-admin').expect(404);
  });

  it('derives the enterprise from membership rather than a client-supplied enterprise id', async () => {
    const response = await request(app.getHttpServer()).get('/api/enterprise/compute-integration?enterpriseId=other').set('x-test-user', 'company-admin').expect(200);
    expect(response.body.enterpriseId).toBe('ent1');
    await request(app.getHttpServer()).get('/api/enterprise/compute-integration').set('x-test-user', 'member').expect(403);
  });

  it('rejects remote retries while the adapter is disconnected', async () => {
    await request(app.getHttpServer()).post('/api/admin/compute-integrations/jobs/job1/retry').set('x-test-user', 'platform-admin').expect(503);
  });
});
