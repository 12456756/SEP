import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeCredentialRotationController } from './compute-credential-rotation.controller';
import { ComputeCredentialRotationService } from './compute-credential-rotation.service';
import { ComputeCredentialRotationRemote } from './compute-credential-rotation.remote';

describe('Credential rotation HTTP scope and validation', () => {
  let app: INestApplication;
  const operationId = randomUUID();
  const db: any = { enterpriseMember: { findFirst: jest.fn(({ where }) => where.userId === 'admin' ? { enterpriseId: 'own-enterprise' } : null) },
    computeCredentialRotation: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) } };
  const remote = { connected: () => true };
  beforeAll(async () => {
    db.$transaction = (fn: (tx: any) => Promise<unknown>) => fn(db);
    const module = await Test.createTestingModule({ controllers: [ComputeCredentialRotationController], providers: [ComputeCredentialRotationService,
      { provide: PrismaService, useValue: db }, { provide: ConfigService, useValue: new ConfigService() }, { provide: ComputeCredentialRotationRemote, useValue: remote },
    ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest();
      if (!req.headers['x-test-user']) throw new UnauthorizedException();
      req.user = { id: req.headers['x-test-user'] }; return true;
    } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
  });
  afterAll(async () => { await app.close(); });
  const url = '/api/enterprise/compute-integration/credential-rotations';
  it('requires authentication for all routes and forbids ordinary members', async () => {
    await request(app.getHttpServer()).get(url).expect(401);
    await request(app.getHttpServer()).post(url).send({ operationId, kind: 'chat', expectedVersion: 1 }).expect(401);
    await request(app.getHttpServer()).post(`${url}/${operationId}/retry`).expect(401);
    await request(app.getHttpServer()).get(url).set('x-test-user', 'member').expect(403);
    await request(app.getHttpServer()).post(url).set('x-test-user', 'member').send({ operationId, kind: 'chat', expectedVersion: 1 }).expect(403);
  });
  it('rejects client supplied enterprise identity, invalid versions, kinds and operation numbers', async () => {
    for (const body of [{ operationId, kind: 'chat', expectedVersion: 1, enterpriseId: 'foreign' }, { operationId, kind: 'all', expectedVersion: 1 },
      { operationId, kind: 'chat', expectedVersion: 0 }, { operationId: 'invalid', kind: 'chat', expectedVersion: 1 }]) {
      await request(app.getHttpServer()).post(url).set('x-test-user', 'admin').send(body).expect(400);
    }
  });
  it('scopes reads to membership and conceals foreign operations', async () => {
    await request(app.getHttpServer()).get(url + '?enterpriseId=foreign').set('x-test-user', 'admin').expect(200, []);
    expect(db.computeCredentialRotation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ enterpriseId: 'own-enterprise' }) }));
    await request(app.getHttpServer()).get(`${url}/${operationId}`).set('x-test-user', 'admin').expect(404);
  });
});
