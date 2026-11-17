import { ExecutionContext, INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientController } from '../client/client.controller';
import { ClientService } from '../client/client.service';
import { MediaConfigController } from './media-config.controller';
import { MediaConfigService } from './media-config.service';

describe('media configuration HTTP contracts', () => {
  let app: INestApplication;
  const media = {
    listProfiles: jest.fn().mockResolvedValue([]),
    discoverModels: jest.fn().mockResolvedValue({ checkedAt: new Date().toISOString(), models: [] }),
    verifyProfile: jest.fn().mockResolvedValue({ executionTested: false }),
    createProfile: jest.fn().mockResolvedValue({}),
    updateProfile: jest.fn().mockResolvedValue({}),
    getAvailableProfiles: jest.fn().mockResolvedValue([]),
    getConnection: jest.fn().mockResolvedValue({ configured: true, baseUrl: 'https://image.example/v1', apiKeyConfigured: true, source: 'database' }),
    updateConnection: jest.fn().mockResolvedValue({ configured: true }),
  };
  const client = { getRuntime: jest.fn().mockResolvedValue({ manifestVersion: 1 }) };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MediaConfigController, ClientController],
      providers: [
        { provide: MediaConfigService, useValue: media },
        { provide: ClientService, useValue: client },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        const role = req.headers['x-test-role'];
        if (!role) throw new UnauthorizedException();
        req.user = { id: 'user-1', role };
        return true;
      },
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it('requires authentication and platform-admin role for admin profiles', async () => {
    await request(app.getHttpServer()).get('/api/admin/media/profiles').expect(401);
    await request(app.getHttpServer()).get('/api/admin/media/profiles').set('x-test-role', 'MEMBER').expect(403);
    expect(media.listProfiles).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/api/admin/media/profiles').set('x-test-role', 'ADMIN').expect(200);
    expect(media.listProfiles).toHaveBeenCalledTimes(1);
  });

  it.each(['get', 'put'])('guards the independent image connection: %s', async method => {
    const path = '/api/admin/media/connection';
    const body = { baseUrl: 'https://image.example/v1', apiKey: 'test-private-key' };
    await request(app.getHttpServer())[method](path).send(body).expect(401);
    await request(app.getHttpServer())[method](path).set('x-test-role', 'MEMBER').send(body).expect(403);
    expect(media.getConnection).not.toHaveBeenCalled();
    expect(media.updateConnection).not.toHaveBeenCalled();
    await request(app.getHttpServer())[method](path).set('x-test-role', 'ADMIN').send(body).expect(200);
    if (method === 'put') expect(media.updateConnection).toHaveBeenCalledWith(body, 'user-1');
  });

  it('restricts discovery and verification to platform admins and rejects extra request fields', async () => {
    await request(app.getHttpServer()).post('/api/admin/media/models/discover').send({}).expect(401);
    await request(app.getHttpServer()).post('/api/admin/media/models/discover').set('x-test-role', 'MEMBER').send({}).expect(403);
    await request(app.getHttpServer()).post('/api/admin/media/models/discover').set('x-test-role', 'ADMIN').send({ apiKey: 'mock-secret' }).expect(400);
    expect(media.discoverModels).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/api/admin/media/models/discover').set('x-test-role', 'ADMIN').send({}).expect(201);
    expect(media.discoverModels).toHaveBeenCalledTimes(1);

    await request(app.getHttpServer()).post('/api/admin/media/profiles/image/verify').set('x-test-role', 'ADMIN').send({}).expect(400);
    await request(app.getHttpServer()).post('/api/admin/media/profiles/image/verify').set('x-test-role', 'ADMIN')
      .send({ expectedConfigVersion: 'cfg_1', apiKey: 'mock-secret' }).expect(400);
    await request(app.getHttpServer()).post('/api/admin/media/profiles/image/verify').set('x-test-role', 'ADMIN')
      .send({ expectedConfigVersion: 'cfg_1' }).expect(201);
    expect(media.verifyProfile).toHaveBeenCalledWith('image', { expectedConfigVersion: 'cfg_1' });
  });

  it('passes the authenticated identity to the enterprise profile resolver', async () => {
    await request(app.getHttpServer()).get('/api/enterprise/media-config/available-profiles').set('x-test-role', 'MEMBER').expect(200);
    expect(media.getAvailableProfiles).toHaveBeenCalledWith('user-1');
  });

  it('defaults both media versions to V3', async () => {
    await request(app.getHttpServer()).get('/api/client/subscriptions/sub-1/runtime').set('x-test-role', 'MEMBER').expect(200);
    expect(client.getRuntime).toHaveBeenCalledWith('user-1', 'sub-1', 3, undefined, 3);
  });

  it('parses the media version before passing it to the client service', async () => {
    await request(app.getHttpServer()).get('/api/client/subscriptions/sub-1/runtime?mediaProtocolVersion=3').set('x-test-role', 'MEMBER').expect(200);
    expect(client.getRuntime).toHaveBeenCalledWith('user-1', 'sub-1', 3, undefined, 3);
  });

  it('rejects malformed runtime queries before service dispatch', async () => {
    await request(app.getHttpServer()).get('/api/client/subscriptions/sub-1/runtime?mediaProtocolVersion=bad').set('x-test-role', 'MEMBER').expect(400);
    expect(client.getRuntime).not.toHaveBeenCalled();
  });

  it('requires authentication before artifact runtime negotiation', async () => {
    await request(app.getHttpServer()).get('/api/client/subscriptions/sub-1/runtime?skillArtifactProtocolVersion=1').expect(401);
    expect(client.getRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['skillArtifactProtocolVersion=1', 3, 1],
    ['mediaProtocolVersion=3&skillArtifactProtocolVersion=1', 3, 1],
    ['mediaProtocolVersion=3&skillArtifactProtocolVersion=2', 3, 2],
    ['skillArtifactProtocolVersion=99', 3, 99],
  ])('passes independently negotiated protocol versions to runtime: %s', async (query, mediaVersion, artifactVersion) => {
    await request(app.getHttpServer()).get(`/api/client/subscriptions/sub-1/runtime?${query}`).set('x-test-role', 'MEMBER').expect(200);
    expect(client.getRuntime).toHaveBeenCalledTimes(1);
    expect(client.getRuntime).toHaveBeenCalledWith('user-1', 'sub-1', mediaVersion, artifactVersion, 3);
  });

  it.each([
    'skillArtifactProtocolVersion=bad',
    'skillArtifactProtocolVersion=',
    'skillArtifactProtocolVersion=0',
    'skillArtifactProtocolVersion=-1',
    'skillArtifactProtocolVersion=1.5',
    'skillArtifactProtocolVersion=Infinity',
    'skillArtifactProtocolVersion=1&skillArtifactProtocolVersion=2',
    'skillArtifactProtocolVersion[version]=1',
    'mediaProtocolVersion=1&skillArtifactProtocolVersion=bad',
    'mediaProtocolVersion=bad&skillArtifactProtocolVersion=1',
    'mediaProtocolVersion=1&skillArtifactProtocolVersion=1&apiKey=mock-secret',
    'mediaProtocolVersion=1&skillArtifactProtocolVersion=1&skillArtifactVersion=1',
  ])('rejects malformed combined artifact runtime query before dispatch: %s', async (query) => {
    await request(app.getHttpServer()).get(`/api/client/subscriptions/sub-1/runtime?${query}`).set('x-test-role', 'MEMBER').expect(400);
    expect(client.getRuntime).not.toHaveBeenCalled();
  });

  it('rejects profile verification injection and updates without an expected version', async () => {
    await request(app.getHttpServer()).post('/api/admin/media/profiles').set('x-test-role', 'ADMIN').send({
      profileId: 'test-image', kind: 'image', displayName: '图片', modelId: 'test-model',
      operations: ['generate'], executionMode: 'sync-response', capabilities: { sizes: ['1024x1024'] },
      verified: true,
    }).expect(400);
    await request(app.getHttpServer()).patch('/api/admin/media/profiles/test-image').set('x-test-role', 'ADMIN').send({ enabled: true }).expect(400);
    expect(media.createProfile).not.toHaveBeenCalled();
    expect(media.updateProfile).not.toHaveBeenCalled();
  });
});
