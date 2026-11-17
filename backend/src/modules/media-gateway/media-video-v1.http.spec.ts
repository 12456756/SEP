import { Controller, ExecutionContext, ForbiddenException, INestApplication, Post, Request, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { MediaModelProfile, Prisma } from '@prisma/client';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { MediaVideoRuntimeV3Schema } from 'shared';
import fixture from '../../shared/fixtures/media-video-v1.json';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientController } from '../client/client.controller';
import { ClientService } from '../client/client.service';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { ClientSkillArtifactService } from '../client/client-skill-artifact.service';
import { MemberAllowanceQueryService } from '../compute-credit/member-allowance-query.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { MediaConfigService } from '../media-config/media-config.service';
import { MediaVideoConfigController } from '../media-config/media-video-config.controller';
import { MediaVideoConfigService } from '../media-config/media-video-config.service';
import { PersonalWalletService } from '../personal-wallet/personal-wallet.service';
import { SessionService } from '../auth/session.service';
import { SettingService } from '../setting/setting.service';
import { SkillVersionService } from '../skill-version/skill-version.service';
import { SubscriptionRequestService } from '../subscription-request/subscription-request.service';
import { MediaGatewayMockGuard } from './media-gateway-mock.guard';
import { MediaGatewayService } from './media-gateway.service';
import { MediaVideoGatewayController } from './media-video-gateway.controller';
import { MediaVideoGatewayService } from './media-video-gateway.service';
import { MediaVideoGatewayStore } from './media-video-gateway.store';
import { createVideoPrismaMock, videoClaims as claims, videoFile, videoInput } from './media-video-gateway.test-support';

const gatewayRoot = '/api/gateway/v1/media/video';
const profileRoot = '/api/admin/media/video/profiles';
const policyPath = '/api/enterprise/media-config/video';
const runtimePath = '/api/client/subscriptions/sub-1/runtime';
const profileId = 'configured-video-http';

/** In-memory Prisma double only: HTTP, production controllers/services and store codec are real.
 * Authentication is synthetic; there is no login, approved Skill, database, upstream or billing. */
class VideoV1Fixture {
  environment: Record<string, string> = { NODE_ENV: 'test', MEDIA_GATEWAY_MOCK_ENABLED: 'true' };
  profiles = new Map<string, MediaModelProfile>();
  configs = new Map<string, { enterpriseId: string; mediaPolicy: Prisma.JsonValue; allowedChatModels: string[] }>();
  activeMember = true;
  grant: 'member' | 'department' | null = 'member';
  readonly subscription = {
    id: 'sub-1', templateVersion: '1', config: null,
    employee: { id: 'employee-1', name: 'fixture', version: '1', avatar: null, description: null,
      systemPrompt: 'fixture', modelId: 'chat-fixture', maxSteps: 10, bindings: [] },
  };
  readonly prisma = {
    ...createVideoPrismaMock(),
    platformModel: { findMany: jest.fn().mockResolvedValue([{ modelId: 'chat-fixture' }]) },
    mediaModelProfile: {
      create: jest.fn(async ({ data }) => {
        const row = { id: `profile-${this.profiles.size + 1}`, ...structuredClone(data), createdAt: new Date(), updatedAt: new Date() };
        this.profiles.set(row.profileId, row); return structuredClone(row);
      }),
      findUnique: jest.fn(async ({ where }) => structuredClone(this.profiles.get(where.profileId) ?? null)),
      findMany: jest.fn(async ({ where }) => structuredClone([...this.profiles.values()].filter(row =>
        Object.entries(where).every(([key, value]) => row[key] === value)))),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = this.profiles.get(where.profileId);
        if (!row || Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
        this.profiles.set(row.profileId, { ...row, ...structuredClone(data), updatedAt: new Date() }); return { count: 1 };
      }),
    },
    enterpriseModelConfig: {
      findUnique: jest.fn(async ({ where }) => structuredClone(this.configs.get(where.enterpriseId) ?? null)),
      upsert: jest.fn(async ({ where, create, update }) => {
        const row = this.configs.get(where.enterpriseId);
        const next = row ? { ...row, ...structuredClone(update) } : { allowedChatModels: [], ...structuredClone(create) };
        this.configs.set(where.enterpriseId, next); return structuredClone(next);
      }),
    },
    $transaction: jest.fn(async (work) => work(this.prisma)),
  };
  readonly context = {
    resolve: jest.fn(async () => ({ enterpriseId: claims.enterpriseId, memberId: claims.memberId,
      departmentId: 'department-1', role: 'ENTERPRISE_ADMIN' })),
    assertEnterpriseAdmin: jest.fn((ctx) => { if (ctx.role !== 'ENTERPRISE_ADMIN') throw new ForbiddenException(); }),
  };
  constructor() {
    this.prisma.enterpriseMember.findFirst.mockImplementation(async ({ where }) => this.activeMember &&
      where.id === claims.memberId && where.enterpriseId === claims.enterpriseId && where.userId === claims.sub &&
      where.user?.status === 'ACTIVE' ? { departmentId: 'department-1' } : null);
    this.prisma.subscription.findFirst.mockImplementation(async ({ where }) => {
      const alternatives = where.grants?.some?.OR ?? [];
      const granted = this.grant === 'member' ? alternatives.some(item => item.memberId === claims.memberId)
        : this.grant === 'department' && alternatives.some(item => item.departmentId === 'department-1');
      return this.activeMember && granted && where.id === claims.subscriptionId && where.enterpriseId === claims.enterpriseId &&
        where.status === 'ACTIVE' ? structuredClone(this.subscription) : null;
    });
  }
}

// Registered in this test module only; these control routes never enter AppModule.
@Controller('__test/video')
@UseGuards(JwtAuthGuard)
class VideoV1ControlController {
  constructor(private readonly fixture: VideoV1Fixture, private readonly video: MediaVideoConfigService) {}
  @Post('revoke') revoke(@Request() req: { user: { id: string } }) {
    return this.video.updateEnterpriseConfig(req.user.id, { enabledProfileIds: [], defaultProfileId: null });
  }
  @Post('restore') async restore(@Request() req: { user: { id: string } }) {
    const profile = this.fixture.profiles.get(profileId)!;
    if (!profile.enabled) await this.video.updateProfile(profileId, { expectedConfigVersion: profile.configVersion, enabled: true });
    return this.video.updateEnterpriseConfig(req.user.id, { enabledProfileIds: [profileId], defaultProfileId: profileId, allowedOperations: ['image-to-video'] });
  }
  @Post('disable-profile') disable() {
    return this.video.updateProfile(profileId, { expectedConfigVersion: this.fixture.profiles.get(profileId)!.configVersion, enabled: false });
  }
}

describe('V1 video configuration → runtime → gateway real HTTP (in-memory Prisma, synthetic auth)', () => {
  let app: INestApplication;
  let state: VideoV1Fixture;
  let runtimeSpy: jest.SpyInstance;
  beforeEach(async () => {
    state = new VideoV1Fixture();
    const module = await Test.createTestingModule({
      controllers: [MediaVideoConfigController, ClientController, MediaVideoGatewayController, VideoV1ControlController],
      providers: [ClientService, MediaVideoConfigService, MediaVideoGatewayStore, MediaVideoGatewayService, MediaGatewayMockGuard,
        { provide: VideoV1Fixture, useValue: state },
        { provide: PrismaService, useValue: state.prisma },
        { provide: EnterpriseContextService, useValue: state.context },
        { provide: ConfigService, useValue: { get: (key: string) => state.environment[key] } },
        { provide: MediaGatewayService, useFactory: (config: ConfigService) => new MediaGatewayService(config, state.prisma as never, null as never, null as never), inject: [ConfigService] },
        { provide: MediaConfigService, useValue: { getRuntimeMediaV3: jest.fn().mockResolvedValue({ protocolVersion: 3, status: 'empty', executionMode: 'disabled', executionAvailable: false, profiles: [], tools: [], defaultProfileId: null }) } },
        { provide: SkillVersionService, useValue: { resolveEffectiveVersion: jest.fn() } },
        { provide: ClientSkillArtifactService, useValue: { describe: jest.fn() } },
        ...[JwtService, SettingService, SessionService, MemberAllowanceQueryService, PersonalWalletService, SubscriptionRequestService]
          .map(provide => ({ provide, useValue: {} })),
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      if (req.headers['x-test-auth'] !== 'yes') throw new UnauthorizedException();
      req.user = { id: claims.sub, role: req.headers['x-test-role'] ?? 'MEMBER' }; return true;
    } }).overrideGuard(ClientEmploymentGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      if (req.headers['x-test-auth'] !== 'yes') throw new UnauthorizedException();
      req.clientEmployment = { ...claims, memberId: req.headers['x-test-member'] ?? claims.memberId }; return true;
    } }).compile();
    runtimeSpy = jest.spyOn(module.get(ClientService), 'getRuntime');
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => { jest.restoreAllMocks(); await app?.close(); });
  const get = (path: string) => request(app.getHttpServer()).get(path).set('x-test-auth', 'yes');
  const post = (path: string) => request(app.getHttpServer()).post(path).set('x-test-auth', 'yes');
  const policy = (body: object) => request(app.getHttpServer()).put(policyPath).set('x-test-auth', 'yes').send(body);
  const patch = (body: object) => request(app.getHttpServer()).patch(`${profileRoot}/${profileId}`).set('x-test-auth', 'yes').set('x-test-role', 'ADMIN').send(body);
  async function configure() {
    const { configVersion: _version, verified: _verified, ...profile } = fixture.profile;
    const created = await post(profileRoot).set('x-test-role', 'ADMIN').send({ ...profile, profileId, modelId: 'mock-video-v1' }).expect(201);
    expect(created.body).toMatchObject({ enabled: false, verified: false });
    await patch({ expectedConfigVersion: created.body.configVersion, enabled: true }).expect(400);
    const checked = await post(`${profileRoot}/${profileId}/verify`).set('x-test-role', 'ADMIN')
      .send({ expectedConfigVersion: created.body.configVersion }).expect(201);
    expect(checked.body).toMatchObject({ executionTested: false, mock: true, profile: { verified: true } });
    const enabled = await patch({ expectedConfigVersion: checked.body.profile.configVersion, enabled: true }).expect(200);
    expect(enabled.body).toMatchObject({ enabled: true, verified: true });
    await policy({ enabledProfileIds: [profileId], defaultProfileId: profileId, allowedOperations: ['image-to-video'] }).expect(200);
    return enabled.body;
  }
  async function prepared(clientRequestId = 'v1-http-request') {
    const runtime = await get(`${runtimePath}?videoProtocolVersion=3`).expect(200);
    const profile = runtime.body.runtime.video.profiles[0];
    const reference = await post(`${gatewayRoot}/references`).attach('file', videoFile().buffer, { filename: 'fixture.png', contentType: 'image/png' }).expect(201);
    const input = { ...videoInput(reference.body.referenceId), profileId: profile.profileId, configVersion: profile.configVersion };
    const quote = await post(`${gatewayRoot}/quotes`).send(input).expect(201);
    return { input, dto: { ...input, quoteId: quote.body.quoteId, clientRequestId } };
  }

  it('creates, verifies, enables, grants, independently negotiates, quotes/submits/polls/downloads, then revokes all reads', async () => {
    const old = await get(runtimePath).expect(200);
    expect(old.body.runtime.video).toMatchObject({ protocolVersion: 3, status: 'empty', profiles: [] });
    expect((await get(`${runtimePath}?videoProtocolVersion=3`).expect(200)).body.runtime.video.executionAvailable).toBe(false);
    await get(`${gatewayRoot}/profiles`).expect(403);
    const enabled = await configure();
    expect(enabled.profileId).not.toBe(fixture.profile.profileId);
    expect(enabled.configVersion).not.toBe(fixture.profile.configVersion);
    const all = await get(`${runtimePath}?mediaProtocolVersion=3&skillArtifactProtocolVersion=1&videoProtocolVersion=3`).expect(200);
    expect(runtimeSpy).toHaveBeenLastCalledWith('user-1', 'sub-1', 3, 1, 3);
    expect(all.body).toMatchObject({ manifestVersion: 1, subscriptionId: 'sub-1', templateVersion: '1',
      employee: { id: 'employee-1', name: 'fixture', version: '1', maxSteps: 10 },
      runtime: { systemPrompt: 'fixture', modelId: 'chat-fixture', allowedModels: ['chat-fixture'], skills: [], skillArtifactProtocolVersion: 1 } });
    expect(MediaVideoRuntimeV3Schema.safeParse(all.body.runtime.video).success).toBe(true);
    expect(all.body.runtime.video.profiles[0]).toMatchObject({ profileId, configVersion: enabled.configVersion });
    expect(all.body.runtime.video.profiles[0]).toHaveProperty('modelId', 'mock-video-v1');
    await get(`${runtimePath}?videoProtocolVersion=2`).expect(400);
    expect((await get(`${gatewayRoot}/profiles`).expect(200)).body.profiles).toEqual([
      expect.objectContaining({ profileId, configVersion: enabled.configVersion }),
    ]);
    const { input, dto } = await prepared();
    const submitted = await post(`${gatewayRoot}/requests`).send(dto).expect(202);
    expect(submitted.body).toMatchObject({ profileId, configVersion: enabled.configVersion, status: 'QUEUED' });
    const path = `${gatewayRoot}/requests/${submitted.body.receiptId}`;
    const lookup = `${gatewayRoot}/requests/by-client-id/${dto.clientRequestId}`;
    await get(path).expect(200); const done = await get(path).expect(200);
    const contentPath = `${path}/outputs/${done.body.outputs[0].outputId}/content`;
    const content = await get(contentPath).expect(200);
    expect(createHash('sha256').update(content.body).digest('hex')).toBe(fixture.mediaFixture.sha256);
    expect((await post(`${gatewayRoot}/requests`).send(dto).expect(200)).body).toEqual(done.body);
    expect((await get(lookup).expect(200)).body).toEqual(done.body);
    await policy({ enabledProfileIds: [], defaultProfileId: null }).expect(200);
    for (const target of [path, lookup, contentPath, `${gatewayRoot}/profiles`]) await get(target).expect(403);
    await post(`${gatewayRoot}/quotes`).send(input).expect(403);
    await post(`${gatewayRoot}/requests`).send(dto).expect(403);
    expect(state.prisma.mediaGatewayRequest.create).toHaveBeenCalledTimes(1);
    expect(state.prisma.state.requests.get(submitted.body.receiptId)!.revision).toBe(2);
  });

  it('restores frozen versions without resubmission; new quotes and submits require the current version', async () => {
    await configure();
    const { input, dto } = await prepared();
    const first = await post(`${gatewayRoot}/requests`).send(dto).expect(202);
    const bumped = await patch({ expectedConfigVersion: input.configVersion, displayName: 'New configured name' }).expect(200);
    expect(bumped.body.configVersion).not.toBe(input.configVersion);
    expect((await get(`${gatewayRoot}/requests/by-client-id/${dto.clientRequestId}`).expect(200)).body).toEqual(first.body);
    expect((await post(`${gatewayRoot}/requests`).send(dto).expect(202)).body).toEqual(first.body);
    await post(`${gatewayRoot}/quotes`).send(input).expect(409);
    await post(`${gatewayRoot}/requests`).send({ ...dto, clientRequestId: 'new-stale-request' }).expect(409);
    const current = { ...input, configVersion: bumped.body.configVersion };
    const quote = await post(`${gatewayRoot}/quotes`).send(current).expect(201);
    const second = await post(`${gatewayRoot}/requests`).send({ ...current, quoteId: quote.body.quoteId, clientRequestId: 'new-current-request' }).expect(202);
    expect(second.body.configVersion).toBe(bumped.body.configVersion);
    state.prisma.state.references.clear(); state.prisma.state.quotes.clear();
    expect((await post(`${gatewayRoot}/requests`).send(dto).expect(202)).body.receiptId).toBe(first.body.receiptId);
    const path = `${gatewayRoot}/requests/${first.body.receiptId}`;
    await get(path).expect(200); const done = await get(path).expect(200);
    await get(`${path}/outputs/${done.body.outputs[0].outputId}/content`).expect(200);
    expect(state.prisma.mediaGatewayRequest.create).toHaveBeenCalledTimes(2);
  });

  it.each(['profile', 'member', 'grant'] as const)('rechecks %s revocation on replay/query/download and restores the original request', async kind => {
    await configure(); const { input, dto } = await prepared();
    const first = await post(`${gatewayRoot}/requests`).send(dto).expect(202);
    const path = `${gatewayRoot}/requests/${first.body.receiptId}`;
    await get(path).expect(200); const done = await get(path).expect(200);
    const content = `${path}/outputs/${done.body.outputs[0].outputId}/content`;
    if (kind === 'profile') await post('/api/__test/video/disable-profile').expect(201);
    if (kind === 'member') state.activeMember = false;
    if (kind === 'grant') state.grant = null;
    await post(`${gatewayRoot}/quotes`).send(input).expect(403);
    await post(`${gatewayRoot}/requests`).send(dto).expect(403);
    for (const target of [path, `${gatewayRoot}/requests/by-client-id/${dto.clientRequestId}`, content]) await get(target).expect(403);
    state.activeMember = true; state.grant = 'department';
    await post('/api/__test/video/restore').expect(201);
    expect((await get(path).expect(200)).body).toEqual(done.body);
    await get(content).expect(200);
    expect((await post(`${gatewayRoot}/requests`).send(dto).expect(200)).body).toEqual(done.body);
    expect(state.prisma.mediaGatewayRequest.create).toHaveBeenCalledTimes(1);
  });

  it('ignores the deprecated enterprise operation restriction during replay and execution', async () => {
    await configure(); const { input, dto } = await prepared();
    await policy({ allowedOperations: [] }).expect(200);
    const quote = await post(`${gatewayRoot}/quotes`).send(input).expect(201);
    const request = await post(`${gatewayRoot}/requests`).send({ ...dto, quoteId: quote.body.quoteId }).expect(202);
    expect(request.body.profileId).toBe(input.profileId);
    expect(state.prisma.mediaGatewayRequest.create).toHaveBeenCalledTimes(1);
  });

  it('keeps disabled mock and production guards effective even with a configured profile', async () => {
    await configure();
    for (const changes of [{ MEDIA_GATEWAY_MOCK_ENABLED: 'false', NODE_ENV: 'test' }, { MEDIA_GATEWAY_MOCK_ENABLED: 'true', NODE_ENV: 'production' }]) {
      Object.assign(state.environment, changes);
      const response = await get(`${gatewayRoot}/profiles`).expect(503);
      expect(response.body.error.code).toBe('MEDIA_MOCK_DISABLED');
    }
    expect(state.prisma.mediaGatewayRequest.create).not.toHaveBeenCalled();
  });

  it('revokes gateway access when model changes invalidate verification and refuses unsupported real models', async () => {
    await configure(); const { input, dto } = await prepared();
    const first = await post(`${gatewayRoot}/requests`).send(dto).expect(202);
    const changed = await patch({ expectedConfigVersion: input.configVersion, modelId: 'unadapted-real-video-model' }).expect(200);
    expect(changed.body).toMatchObject({ enabled: false, verified: false });
    const version = changed.body.configVersion;
    await post(`${profileRoot}/${profileId}/verify`).set('x-test-role', 'ADMIN').send({ expectedConfigVersion: version }).expect(400);
    await patch({ expectedConfigVersion: version, enabled: true }).expect(400);
    expect((await get(`${runtimePath}?videoProtocolVersion=3`).expect(200)).body.runtime.video).toMatchObject({ executionAvailable: false,
      profiles: [expect.objectContaining({ profileId, unavailableReason: 'PROFILE_DISABLED' })], tools: [] });
    await post(`${gatewayRoot}/requests`).send(dto).expect(403);
    await get(`${gatewayRoot}/requests/${first.body.receiptId}`).expect(403);
    expect(state.prisma.mediaGatewayRequest.create).toHaveBeenCalledTimes(1);
  });

  it.each(['bad', '', '0', '-1', '1.5', 'Infinity', '1&videoProtocolVersion=2'])('rejects invalid video negotiation before service dispatch: %s', async value => {
    await get(`${runtimePath}?videoProtocolVersion=${value}`).expect(400);
    expect(runtimeSpy).not.toHaveBeenCalled();
  });

  const crossRepository = process.env.SEP_VIDEO_V1_CLIENT_INTEGRATION === 'true' ? it : it.skip;
  crossRepository('runs the desktop adapter/EmployeeAuthorizer/host/disk against configured V1 HTTP', async () => {
    await configure();
    const clientRoot = resolve(process.env.SEP_VIDEO_TEST_CLIENT_ROOT ?? resolve(__dirname, '../../../../../sep-client'));
    const base = `${await app.getUrl()}/api`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/test-video-v1-http.ts'], {
      cwd: clientRoot, timeout: 45_000,
      env: { ...process.env, SEP_BASE_URL: base, SEP_VIDEO_MOCK_TEST_BASE_URL: base },
    });
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({ mock: true, realModels: false, realBilling: false, syntheticScope: true,
      profileId, saveStatus: 'SAVED', sha256: fixture.mediaFixture.sha256,
      authorizationRevocation: true, originalReceiptRestored: true, counts: { quote: 1, submit: 1 } });
    expect(state.prisma.mediaGatewayRequest.create).toHaveBeenCalledTimes(1);
    expect(state.prisma.state.requests.size).toBe(1);
  }, 50_000);
});
