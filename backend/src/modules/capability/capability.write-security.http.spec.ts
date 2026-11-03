import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CapabilityController } from './capability.controller';
import { CapabilityService } from './capability.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { SkillVersionService } from '../skill-version/skill-version.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdapterFactory } from './adapters/adapter.factory';
import { SessionService } from '../auth/session.service';

describe('Capability write HTTP validation', () => {
  let app: INestApplication;
  const sessions = { assertActiveSession: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    capability: {
      create: jest.fn().mockResolvedValue({ id: 'cap-1' }),
      findUnique: jest.fn().mockResolvedValue({ id: 'cap-1', type: 'AGENT', contributorId: 'user-1' }),
      update: jest.fn().mockResolvedValue({ id: 'cap-1' }),
    },
  };
  const sha256 = 'a'.repeat(64);
  const metadata = { zipPath: `skills/${sha256}.zip`, sha256, fileCount: 1, totalSize: 512 };
  const skill = {
    name: 'Initial skill', description: 'A valid initial description', type: 'skill',
    industry: [], position: [], inputSchema: {}, outputSchema: {},
    skillConfig: { template: '# Initial skill', metadata },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CapabilityController],
      providers: [
        CapabilityService,
        { provide: SessionService, useValue: sessions },
        { provide: PrismaService, useValue: prisma },
        { provide: AdapterFactory, useValue: {} },
        { provide: SkillVersionService, useValue: {} },
        { provide: SkillPackageService, useValue: { read: jest.fn().mockResolvedValue({
          key: metadata.zipPath, fileCount: metadata.fileCount, totalBytes: metadata.totalSize,
          content: skill.skillConfig.template,
        }) } },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate: (context: any) => {
        const req = context.switchToHttp().getRequest();
        req.user = { id: 'user-1', role: req.headers['x-test-role'] ?? 'USER',
          sid: req.headers['x-test-sid'] === 'missing' ? undefined : 'web-session-1' };
        return true;
      },
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sessions.assertActiveSession.mockResolvedValue(undefined);
  });
  afterAll(async () => { await app?.close(); });

  it('passes the authenticated admin role and preserves package metadata through the body pipe', async () => {
    await request(app.getHttpServer()).post('/capabilities').set('x-test-role', 'ADMIN')
      .send({ ...skill, enterpriseId: 'forged-enterprise', status: 'APPROVED' }).expect(201);
    const data = prisma.capability.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      contributorId: 'user-1', platformReviewStatus: 'PENDING_REVIEW',
      metadata: { ...metadata, source: 'ADMIN_CREATED' },
      skillVersions: { create: { status: 'PENDING_PLATFORM_REVIEW',
        packageKey: metadata.zipPath, packageSha256: sha256, packageFileCount: 1 } },
    });
    expect(data).not.toHaveProperty('enterpriseId');
    expect(data).not.toHaveProperty('status', 'APPROVED');
    expect(sessions.assertActiveSession).toHaveBeenCalledWith('web-session-1', 'user-1', 'WEB');
  });

  it('rejects an admin skill creation without a Web session', async () => {
    await request(app.getHttpServer()).post('/capabilities').set('x-test-role', 'ADMIN')
      .set('x-test-sid', 'missing').send(skill).expect(403);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('rejects revoked or non-Web login sessions before package creation', async () => {
    sessions.assertActiveSession.mockRejectedValueOnce(new UnauthorizedException('登录会话已撤销'));
    await request(app.getHttpServer()).post('/capabilities').set('x-test-role', 'ADMIN').send(skill).expect(401);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('forbids non-admin creation even for a valid payload', async () => {
    await request(app.getHttpServer()).post('/capabilities').send(skill).expect(403);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it.each([
    { ...skill, type: 'SKILL' },
    { ...skill, description: ' \t\r\n' },
    { ...skill, skillConfig: undefined },
    { ...skill, type: 'agent' },
    { ...skill, skillConfig: { template: '# Skill', metadata: { zipPath: metadata.zipPath } } },
    { ...skill, skillConfig: { template: '# Skill', metadata: { ...metadata, fileCount: '1' } } },
  ])('returns 400 for an invalid create request before persistence: %j', async (payload) => {
    await request(app.getHttpServer()).post('/capabilities').set('x-test-role', 'ADMIN')
      .send(payload).expect(400);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it.each([{ type: 'UNKNOWN' }, { description: ' \t\r\n' }, { inputSchema: 'not-a-schema' }])(
    'validates partial updates before reaching the service: %j', async (payload) => {
      await request(app.getHttpServer()).patch('/capabilities/cap-1').send(payload).expect(400);
      expect(prisma.capability.findUnique).not.toHaveBeenCalled();
      expect(prisma.capability.update).not.toHaveBeenCalled();
    },
  );

  it('accepts a short Chinese description on creation and persists its trimmed value', async () => {
    await request(app.getHttpServer()).post('/capabilities').set('x-test-role', 'ADMIN')
      .send({ ...skill, description: ' 做图 ' }).expect(201);
    expect(prisma.capability.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: '做图' }),
    }));
  });

  it('accepts a short Chinese description on update and persists its trimmed value', async () => {
    await request(app.getHttpServer()).patch('/capabilities/cap-1')
      .send({ description: ' 做图 ' }).expect(200);
    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { description: '做图' },
    }));
  });

  it('rejects AGENT to SKILL conversion over HTTP', async () => {
    await request(app.getHttpServer()).patch('/capabilities/cap-1').send({ type: 'skill' }).expect(400);
    expect(prisma.capability.update).not.toHaveBeenCalled();
  });

  it('accepts partial updates and strips untrusted ownership and status fields', async () => {
    await request(app.getHttpServer()).patch('/capabilities/cap-1')
      .send({ name: 'Renamed', contributorId: 'forged-owner', status: 'APPROVED' }).expect(200);
    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Renamed' } }));
  });
});
