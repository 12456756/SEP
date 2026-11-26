import { ExecutionContext, ForbiddenException, INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import fixture from '../../shared/fixtures/media-video-v1.json';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SettingService } from '../setting/setting.service';
import { MediaVideoConfigController } from './media-video-config.controller';
import { MediaVideoConfigService } from './media-video-config.service';
import { ComputeModelCatalogService } from '../compute-integration/compute-model-catalog.service';
import { mediaCatalogStub } from '../../../test/stubs/compute-catalog.stub';

describe('video configuration HTTP (real controller + service, mock Prisma, no upstream)', () => {
  let app: INestApplication;
  let profiles: Map<string, any>;
  let policies: Map<string, any>;
  let mockFlag: string;
  let nodeEnv: string;
  const imagePolicy = { enabledProfileIds: ['product-image'], defaultProfileId: 'product-image', allowedOperations: ['generate'], maxOutputs: 2, maxWidth: 1024, maxHeight: 1024 };
  const admin = { 'x-test-role': 'ADMIN' };
  const enterpriseAdmin = { 'x-test-role': 'ENTERPRISE_ADMIN' };
  const member = { 'x-test-role': 'MEMBER' };
  const settings = {
    getMediaConnection: jest.fn(async () => ({ baseUrl: 'https://video.example/v1', apiKey: 'private-video-key', source: 'database' })),
    updateMediaConnection: jest.fn(),
  };
  const prisma: any = {
    mediaModelProfile: {
      findMany: jest.fn(async ({ where }) => [...profiles.values()].filter(row => Object.entries(where).every(([key, value]) => row[key] === value))),
      findUnique: jest.fn(async ({ where }) => profiles.get(where.profileId) ?? null),
      create: jest.fn(async ({ data }) => { profiles.set(data.profileId, structuredClone(data)); return profiles.get(data.profileId); }),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = profiles.get(where.profileId);
        if (!row || !Object.entries(where).every(([key, value]) => row[key] === value)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      }),
    },
    enterpriseModelConfig: {
      findUnique: jest.fn(async ({ where }) => policies.get(where.enterpriseId) ?? null),
      upsert: jest.fn(async ({ where, create, update }) => {
        const saved = { ...(policies.get(where.enterpriseId) ?? create), ...update };
        policies.set(where.enterpriseId, saved);
        return saved;
      }),
    },
    $transaction: jest.fn(async fn => fn(prisma)),
  };

  const createBody = () => {
    const { verified: _verified, configVersion: _version, ...body } = fixture.profile;
    return { ...structuredClone(body), modelId: 'mock-video-v1' };
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MediaVideoConfigController],
      providers: [MediaVideoConfigService,
        { provide: ComputeModelCatalogService, useValue: mediaCatalogStub() },
        { provide: SettingService, useValue: settings },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: key => key === 'NODE_ENV' ? nodeEnv
          : key === 'MEDIA_GATEWAY_MOCK_ENABLED' ? mockFlag : undefined } },
        { provide: EnterpriseContextService, useValue: {
          resolve: jest.fn(async userId => {
            if (userId === 'user-OUTSIDER') throw new ForbiddenException('无企业成员身份');
            return { enterpriseId: userId === 'user-OTHER_ENTERPRISE' ? 'ent-other' : 'ent-1', role: userId === 'user-ENTERPRISE_ADMIN' ? 'ENTERPRISE_ADMIN' : 'MEMBER' };
          }),
          assertEnterpriseAdmin: context => { if (context.role !== 'ENTERPRISE_ADMIN') throw new ForbiddenException(); },
        } },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest();
      const role = req.headers['x-test-role'];
      if (!role) throw new UnauthorizedException();
      req.user = { id: `user-${role}`, role };
      return true;
    } }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    profiles = new Map();
    policies = new Map([['ent-1', { enterpriseId: 'ent-1', mediaPolicy: structuredClone(imagePolicy) }]]);
    mockFlag = 'true'; nodeEnv = 'test';
  });
  afterAll(async () => app.close());

  it.each([
    ['get', '/admin/media/video/profiles'], ['post', '/admin/media/video/profiles'],
    ['patch', '/admin/media/video/profiles/video'], ['post', '/admin/media/video/profiles/video/verify'],
    ['post', '/admin/media/video/models/discover'],
    ['get', '/admin/media/video/connection'], ['put', '/admin/media/video/connection'],
  ])('guards platform routes with authentication and ADMIN role: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](`/api${path}`).send({}).expect(401);
    await request(app.getHttpServer())[method](`/api${path}`).set(member).send({}).expect(403);
    expect(prisma.mediaModelProfile.create).not.toHaveBeenCalled();
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('reads and saves a video-only connection without exposing its key', async () => {
    const result = await request(app.getHttpServer()).get('/api/admin/media/video/connection').set(admin).expect(200);
    expect(result.body).toEqual({ configured: true, baseUrl: 'https://video.example/v1', apiKeyConfigured: true, source: 'database' });
    expect(JSON.stringify(result.body)).not.toContain('private-video-key');
    await request(app.getHttpServer()).put('/api/admin/media/video/connection').set(admin)
      .send({ baseUrl: 'https://video-new.example/v1', apiKey: 'new-private-key' }).expect(200);
    expect(settings.updateMediaConnection).toHaveBeenCalledWith({ baseUrl: 'https://video-new.example/v1', apiKey: 'new-private-key' }, 'video', 'user-ADMIN');
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('rejects invalid video connections before touching settings', async () => {
    for (const body of [{ baseUrl: 'not-a-url' }, { baseUrl: 'https://video.example/v1', kind: 'image' },
      { baseUrl: 'https://user:password@video.example/v1' }]) {
      await request(app.getHttpServer()).put('/api/admin/media/video/connection').set(admin).send(body).expect(400);
    }
    expect(settings.updateMediaConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['get', '/enterprise/media-config/video'], ['put', '/enterprise/media-config/video'],
    ['get', '/enterprise/media-config/video/available-profiles'],
  ])('requires enterprise membership: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](`/api${path}`).send({}).expect(401);
    await request(app.getHttpServer())[method](`/api${path}`).set('x-test-role', 'OUTSIDER').send({}).expect(403);
  });

  it('creates, verifies, enables, authorizes and reads a mock profile while preserving image configuration', async () => {
    const created = await request(app.getHttpServer()).post('/api/admin/media/video/profiles').set(admin).send(createBody()).expect(201);
    expect(created.body).toMatchObject({ kind: 'video', modelId: 'mock-video-v1', enabled: false, verified: false });
    const profileId = created.body.profileId;
    await request(app.getHttpServer()).patch(`/api/admin/media/video/profiles/${profileId}`).set(admin)
      .send({ enabled: true, expectedConfigVersion: created.body.configVersion }).expect(400);
    const checked = await request(app.getHttpServer()).post(`/api/admin/media/video/profiles/${profileId}/verify`).set(admin)
      .send({ expectedConfigVersion: created.body.configVersion }).expect(201);
    expect(checked.body).toMatchObject({ mock: true, executionTested: false, profile: { verified: true, enabled: false } });
    const enabled = await request(app.getHttpServer()).patch(`/api/admin/media/video/profiles/${profileId}`).set(admin)
      .send({ enabled: true, expectedConfigVersion: checked.body.profile.configVersion }).expect(200);
    expect(enabled.body.enabled).toBe(true);
    const choices = await request(app.getHttpServer()).get('/api/enterprise/media-config/video/available-profiles').set(member).expect(200);
    expect(choices.body).toHaveLength(1);
    expect(choices.body[0]).not.toHaveProperty('modelId');
    const saved = await request(app.getHttpServer()).put('/api/enterprise/media-config/video').set(enterpriseAdmin)
      .send({ enabledProfileIds: [profileId], defaultProfileId: profileId, allowedOperations: ['image-to-video'], periodBudget: 25, maxConcurrentJobs: 2 }).expect(200);
    expect(saved.body).toMatchObject({ mock: true, executionTested: false, canEdit: true, policy: { enabledProfileIds: [profileId], periodBudget: 25, maxConcurrentJobs: 2 } });
    expect(policies.get('ent-1').mediaPolicy).toMatchObject(imagePolicy);
    const read = await request(app.getHttpServer()).get('/api/enterprise/media-config/video').set(member).expect(200);
    expect(read.body).toMatchObject({ canEdit: false, policy: saved.body.policy });
    const other = await request(app.getHttpServer()).get('/api/enterprise/media-config/video').set('x-test-role', 'OTHER_ENTERPRISE').expect(200);
    expect(other.body.policy.enabledProfileIds).toEqual([]);
    const list = await request(app.getHttpServer()).get('/api/admin/media/video/profiles').set(admin).expect(200);
    expect(list.body).toHaveLength(1);
    expect(prisma.mediaModelProfile.findMany).toHaveBeenCalledWith({ where: { kind: 'video' }, orderBy: { createdAt: 'asc' } });
  });

  it('allows saving authorization intent for an unverified profile but keeps it out of runtime', async () => {
    const created = await request(app.getHttpServer()).post('/api/admin/media/video/profiles').set(admin)
      .send({ ...createBody(), modelId: 'unadapted-real-video' }).expect(201);
    const path = `/api/admin/media/video/profiles/${created.body.profileId}`;
    await request(app.getHttpServer()).post(`${path}/verify`).set(admin).send({ expectedConfigVersion: created.body.configVersion }).expect(400);
    await request(app.getHttpServer()).patch(path).set(admin).send({ expectedConfigVersion: created.body.configVersion, enabled: true }).expect(400);
    const saved = await request(app.getHttpServer()).put('/api/enterprise/media-config/video').set(enterpriseAdmin)
      .send({ enabledProfileIds: [created.body.profileId], defaultProfileId: created.body.profileId,
        allowedOperations: ['text-to-video'], maxDurationSeconds: 20, allowedAspectRatios: ['9:16'],
        maxResolution: '8k', maxConcurrentJobs: 3 }).expect(200);
    expect(saved.body.policy).toMatchObject({ enabledProfileIds: [created.body.profileId],
      defaultProfileId: created.body.profileId, maxDurationSeconds: 20, allowedAspectRatios: ['9:16'],
      maxResolution: '8k', maxConcurrentJobs: 3 });
    const preview = await request(app.getHttpServer()).post('/api/enterprise/media-config/video/preview').set(enterpriseAdmin)
      .send({ protocolVersion: 1, policy: saved.body.policy }).expect(201);
    expect(preview.body.profiles).toContainEqual(expect.objectContaining({ profileId: created.body.profileId,
      status: 'unavailable', reasons: expect.arrayContaining(['unverified']) }));
    expect(preview.body.executionAvailable).toBe(false);
    const runtime = await app.get(MediaVideoConfigService).getRuntimeVideo('ent-1');
    expect(runtime).toMatchObject({ executionAvailable: false, profiles: [], tools: [] });
    expect(profiles.get(created.body.profileId)).toMatchObject({ enabled: false, verified: false });
  });

  it('discovery strictly accepts only {} and disclaims real verification', async () => {
    for (const payload of [{ apiKey: 'secret' }, { baseUrl: 'https://example.test' }, { modelId: 'real-video' }, [], null]) {
      const response = request(app.getHttpServer()).post('/api/admin/media/video/models/discover').set(admin);
      if (payload === null) await response.set('Content-Type', 'application/json').send('null').expect(400);
      else await response.send(payload).expect(400);
    }
    const result = await request(app.getHttpServer()).post('/api/admin/media/video/models/discover').set(admin).send({}).expect(201);
    expect(result.body).toMatchObject({ mock: true, executionTested: false, models: [{ modelId: 'mock-video-v1' }] });
    expect(profiles.size).toBe(0);
  });

  it('rejects verification injection, image capabilities, arbitrary vendor fields and missing CAS versions', async () => {
    for (const payload of [
      { ...createBody(), verified: true }, { ...createBody(), apiKey: 'secret' },
      { ...createBody(), operations: ['generate'] }, { ...createBody(), capabilities: { sizes: ['1024x1024'] } },
    ]) await request(app.getHttpServer()).post('/api/admin/media/video/profiles').set(admin).send(payload).expect(400);
    await request(app.getHttpServer()).patch('/api/admin/media/video/profiles/video').set(admin).send({ enabled: true }).expect(400);
    await request(app.getHttpServer()).post('/api/admin/media/video/profiles/video/verify').set(admin).send({ expectedConfigVersion: 'cfg_1', apiKey: 'secret' }).expect(400);
    expect(prisma.mediaModelProfile.create).not.toHaveBeenCalled();
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('rejects stale versions and invalidates both flags when capabilities change', async () => {
    const body = { ...structuredClone(fixture.profile), modelId: 'mock-video-v1', enabled: true, verified: true };
    profiles.set(body.profileId, body);
    const path = `/api/admin/media/video/profiles/${body.profileId}`;
    await request(app.getHttpServer()).patch(path).set(admin).send({ expectedConfigVersion: 'stale', enabled: false }).expect(409);
    await request(app.getHttpServer()).post(`${path}/verify`).set(admin).send({ expectedConfigVersion: 'stale' }).expect(409);
    const result = await request(app.getHttpServer()).patch(path).set(admin)
      .send({ expectedConfigVersion: body.configVersion, capabilities: { durationsSeconds: [10] }, enabled: true }).expect(200);
    expect(result.body).toMatchObject({ enabled: false, verified: false });
    await request(app.getHttpServer()).post(`${path}/verify`).set(admin).send({ expectedConfigVersion: result.body.configVersion }).expect(400);
  });

  it('does not allow enterprise members or identity injection to write another enterprise policy', async () => {
    await request(app.getHttpServer()).put('/api/enterprise/media-config/video').set(member).send({ periodBudget: 12 }).expect(403);
    for (const payload of [{ enterpriseId: 'ent-other' }, { maxOutputs: 2 }, { periodBudget: -1 }, { maxConcurrentJobs: 0 }]) {
      await request(app.getHttpServer()).put('/api/enterprise/media-config/video').set(enterpriseAdmin).send(payload).expect(400);
    }
    expect(prisma.enterpriseModelConfig.upsert).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'production'])('reports unavailable real discovery instead of pretending its catalog is empty: %s', async mode => {
    if (mode === 'production') nodeEnv = 'production'; else mockFlag = 'false';
    const body = { ...structuredClone(fixture.profile), modelId: 'mock-video-v1' };
    profiles.set(body.profileId, body);
    await request(app.getHttpServer()).post('/api/admin/media/video/models/discover').set(admin).send({}).expect(503);
    await request(app.getHttpServer()).post(`/api/admin/media/video/profiles/${body.profileId}/verify`).set(admin)
      .send({ expectedConfigVersion: body.configVersion }).expect(503);
    const read = await request(app.getHttpServer()).get('/api/enterprise/media-config/video').set(member).expect(200);
    expect(read.body.configured).toBe(true);
  });

  it('returns 404 for missing or image profiles without mutating them', async () => {
    profiles.set('image-profile', { ...fixture.profile, kind: 'image' });
    for (const profileId of ['missing', 'image-profile']) {
      await request(app.getHttpServer()).patch(`/api/admin/media/video/profiles/${profileId}`).set(admin).send({ expectedConfigVersion: 'cfg_1', enabled: false }).expect(404);
      await request(app.getHttpServer()).post(`/api/admin/media/video/profiles/${profileId}/verify`).set(admin).send({ expectedConfigVersion: 'cfg_1' }).expect(404);
    }
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });
});
