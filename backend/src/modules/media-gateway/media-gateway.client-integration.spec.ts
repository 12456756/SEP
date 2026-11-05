import { CanActivate, Controller, ExecutionContext, Get, Injectable, INestApplication, Param, Post, Query, Request, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { Prisma, PrismaClient, SkillVersion } from '@prisma/client';
import request from 'supertest';
import { MediaRuntimeQuery, MediaRuntimeQuerySchema } from 'shared';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../auth/session.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ClientService } from '../client/client.service';
import { ClientSkillArtifactController } from '../client/client-skill-artifact.controller';
import { ClientSkillArtifactService } from '../client/client-skill-artifact.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SkillVersionService } from '../skill-version/skill-version.service';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { GatewayAuthRateLimitService } from '../gateway/gateway-auth-rate-limit.service';
import { SecurityModule } from '../security/security.module';
import { MediaGatewayController } from './media-gateway.controller';
import { MediaGatewayMockGuard } from './media-gateway-mock.guard';
import { MediaGatewayMockAdapter } from './media-gateway-mock.adapter';
import { MediaGatewayService } from './media-gateway.service';
import { MediaGatewayStore } from './media-gateway.store';

// This harness deliberately bypasses login/session DB and uses synthetic ordinary access
// tokens. Only media receipt/quote/reference persistence reaches the isolated PostgreSQL DB.
// Unexpected service dependencies fail immediately instead of contacting production services.
function unusedPort<T>(): T {
  return new Proxy({}, { get: (_target, key) => { throw new Error(`Unexpected fixture dependency: ${String(key)}`); } }) as T;
}
type FixtureState = 'v1' | 'v2' | 'blocked' | 'revoked';
@Injectable()
class EmployeeFixture {
  readonly userId = 'integration-user';
  readonly employeeId = 'integration-employee';
  readonly capabilityId = 'integration-image-skill';
  readonly accessToken = `synthetic-ordinary-access-${randomUUID()}`;
  state: FixtureState = 'v1';
  readonly calls = { runtime: 0, metadata: 0 };
  readonly versions: Record<Exclude<FixtureState, 'revoked'>, SkillVersion>;
  readonly prisma: PrismaService;
  readonly skills: SkillVersionService;
  readonly artifacts: ClientSkillArtifactService;
  readonly client: ClientService;

  constructor(readonly enterpriseId: string, readonly subscriptionId: string, readonly memberId: string) {
    const version = (id: string, number: string, content: string): SkillVersion => ({
      id, capabilityId: this.capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED', version: number, content,
      enterpriseId: null, ownerId: null, parentVersionId: null, workingCopyId: null, workingCopyUpdatedAt: null,
      sourceVersionId: null, changeSummary: null, packageKey: null, packageSha256: null, packageFileCount: null,
      packageFilename: null, createdById: 'fixture-approver', submittedAt: null, enterpriseReviewedById: null,
      enterpriseReviewedAt: null, platformReviewedById: 'fixture-approver', platformReviewedAt: new Date('2026-10-14'),
      rejectionReason: null, validationResult: null, validatedAt: null,
      createdAt: new Date('2026-10-14'), updatedAt: new Date('2026-10-14'),
    });
    // Plain approved content forces the production artifact service to create frontmatter
    // and distinct bytes/hash. Copying runtime.content into SKILL.md cannot pass this test.
    this.versions = {
      v1: version('integration-skill-v1', '1.0.0', 'Create a static product image using the approved media tool. Fixture revision one.'),
      v2: version('integration-skill-v2', '2.0.0', 'Create a static product image using the approved media tool. Fixture revision two.'),
      blocked: version('integration-skill-blocked', '3.0.0', ''),
    };
    const current = () => this.versions[this.state === 'revoked' ? 'v2' : this.state];
    const capability = { id: this.capabilityId, name: 'Approved image skill', description: 'Static media fixture', type: 'SKILL', status: 'APPROVED' };
    const subscription = () => ({ id: subscriptionId, enterpriseId, employeeId: this.employeeId, status: 'ACTIVE',
      endDate: null, name: 'Fixture employee', templateVersion: '1.0.0', config: null,
      employee: { id: this.employeeId, name: 'Fixture employee', description: 'Synthetic subscription; no real login',
        avatar: null, avatarStyle: null, avatarBindings: null, systemPrompt: 'Only generate the static integration PNG.',
        modelId: 'mock-no-model', maxSteps: 8, version: '1.0.0',
        bindings: [{ capabilityId: this.capabilityId, capability, defaultSkillVersion: current() }] } });
    this.prisma = {
      capability: { findUnique: async () => capability },
      subscription: {
        findFirst: async ({ where, select }: Prisma.SubscriptionFindFirstArgs) => {
          // Verify that the real services ask for active, scoped grants before exposing runtime/bytes.
          expect(where).toMatchObject({ enterpriseId, status: 'ACTIVE', grants: { some: expect.any(Object) },
            OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }] });
          expect(where?.grants?.some).toMatchObject({ OR: [{ memberId }], AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }] });
          if (this.state === 'revoked' || (where?.id && where.id !== subscriptionId) ||
            (where?.employeeId && where.employeeId !== this.employeeId)) return null;
          if (select?.employee) {
            expect(select).toMatchObject({ employee: { select: { bindings: {
              where: { enabled: true, capability: { type: 'SKILL' } },
            } } } });
            const binding = select.employee as { select: { bindings: { where: { capabilityId: string } } } };
            if (binding.select.bindings.where.capabilityId !== this.capabilityId) {
              return { ...subscription(), employee: { ...subscription().employee, bindings: [] } };
            }
          }
          return subscription();
        },
        findUnique: async ({ where }: Prisma.SubscriptionFindUniqueArgs) => where.id === subscriptionId ? subscription() : null,
      },
      employeeGrant: { findMany: async () => this.state === 'revoked' ? [] : [{ subscription: subscription() }] },
      employeeCapabilityBinding: { findMany: async () => [{ capability, defaultSkillVersion: current() }] },
      platformModel: { findMany: async () => [{ modelId: 'mock-no-model' }] },
      enterpriseModelConfig: { findUnique: async () => ({ allowedChatModels: ['mock-no-model'] }) },
      subscriptionSkillVersion: { findMany: async () => [], findUnique: async () => null },
      enterpriseSkillDefault: { findMany: async () => [], findUnique: async () => null },
      skillVersion: { findMany: async () => Object.values(this.versions), findFirst: async () => current() },
    } as unknown as PrismaService;
    const context = { resolve: async (userId: string) => {
      if (userId !== this.userId) throw new UnauthorizedException('Synthetic fixture identity required');
      return { enterpriseId, memberId, departmentId: null, role: 'MEMBER' };
    } } as EnterpriseContextService;
    this.skills = new SkillVersionService(this.prisma, context);
    this.artifacts = new ClientSkillArtifactService(this.prisma, context, this.skills, unusedPort<SkillPackageService>());
    this.client = new ClientService(this.prisma, new JwtService(), unusedPort(), unusedPort(), context,
      unusedPort(), unusedPort(), unusedPort(), unusedPort(), this.skills, undefined, undefined, undefined, undefined,
      { resolvePolicy: async () => ({ allowedModels: ['mock-no-model'] }) } as unknown as ConstructorParameters<typeof ClientService>[14],
      // The production media configuration remains unavailable for execution. The desktop
      // test separately injects /media/mock/profiles capabilities into MediaService.
      { getRuntimeMedia: async () => ({ protocolVersion: 1, executionAvailable: false, defaultProfileId: null,
        tools: [], profiles: [] }) } as unknown as ConstructorParameters<typeof ClientService>[15], this.artifacts);
  }
}

@Injectable()
class SyntheticAccessGuard implements CanActivate {
  constructor(private readonly fixture: EmployeeFixture) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: { authorization?: string }; user?: { id: string } }>();
    if (req.headers.authorization !== `Bearer ${this.fixture.accessToken}`) throw new UnauthorizedException('Synthetic ordinary access token required');
    req.user = { id: this.fixture.userId };
    return true;
  }
}

// Deliberately restricted testing controller: no login, refresh or production mutations.
@Controller()
@UseGuards(SyntheticAccessGuard)
class EmployeeFixtureController {
  constructor(private readonly fixture: EmployeeFixture) {}
  @Get('client/subscriptions')
  subscriptions(@Request() req: { user: { id: string } }) { return this.fixture.client.listSubscriptions(req.user.id); }
  @Get('client/subscriptions/:subscriptionId/runtime')
  runtime(@Request() req: { user: { id: string } }, @Param('subscriptionId') id: string,
    @Query(new ZodValidationPipe(MediaRuntimeQuerySchema)) query: MediaRuntimeQuery) {
    this.fixture.calls.runtime++;
    return this.fixture.client.getRuntime(req.user.id, id, query.mediaProtocolVersion, query.skillArtifactProtocolVersion);
  }
  @Get('enterprise/employees/:employeeId/skills')
  metadata(@Request() req: { user: { id: string } }, @Param('employeeId') id: string) {
    this.fixture.calls.metadata++;
    return this.fixture.skills.listEmployeeSkills(req.user.id, id);
  }
  @Post('__media-integration/fixture/:state')
  state(@Param('state') state: string) {
    if (!['v1', 'v2', 'blocked', 'revoked'].includes(state)) throw new Error('Invalid fixture state');
    this.fixture.state = state as FixtureState;
    return { state };
  }
}

async function employeeFixtureModule(fixture: EmployeeFixture) {
  return Test.createTestingModule({ controllers: [EmployeeFixtureController, ClientSkillArtifactController], providers: [
    { provide: EmployeeFixture, useValue: fixture }, SyntheticAccessGuard,
    { provide: ClientSkillArtifactService, useValue: fixture.artifacts },
  ] }).overrideGuard(JwtAuthGuard).useClass(SyntheticAccessGuard).compile();
}

// Always runnable, including on machines without the opt-in media PostgreSQL database.
describe('real employee runtime and approved artifact fixture HTTP boundary (no real login)', () => {
  let app: INestApplication;
  let fixture: EmployeeFixture;
  beforeAll(async () => {
    fixture = new EmployeeFixture('fixture-enterprise', 'fixture-subscription', 'fixture-member');
    app = (await employeeFixtureModule(fixture)).createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  it('negotiates inside runtime and downloads production artifact bytes/hash, rejecting employment credentials', async () => {
    const runtimePath = `/api/client/subscriptions/${fixture.subscriptionId}/runtime?skillArtifactProtocolVersion=1&mediaProtocolVersion=1`;
    for (const token of ['', 'synthetic-employment-token']) {
      await request(app.getHttpServer()).get(runtimePath).set('Authorization', `Bearer ${token}`).expect(401);
    }
    const response = await request(app.getHttpServer()).get(runtimePath).auth(fixture.accessToken, { type: 'bearer' }).expect(200);
    expect(response.body.skillArtifactProtocolVersion).toBeUndefined();
    expect(response.body.runtime).toMatchObject({ skillArtifactProtocolVersion: 1, media: { executionAvailable: false, tools: [] } });
    const artifact = response.body.runtime.skills[0].artifact;
    expect(artifact).toMatchObject({ protocolVersion: 1, status: 'AVAILABLE', format: 'single-file', entryPath: 'SKILL.md', fileCount: 1,
      capabilityId: fixture.capabilityId, versionId: fixture.versions.v1.id,
      approvedContentSha256: createHash('sha256').update(fixture.versions.v1.content).digest('hex') });
    await request(app.getHttpServer()).get(`/api${artifact.downloadPath}`).auth('synthetic-employment-token', { type: 'bearer' }).expect(401);
    const download = await request(app.getHttpServer()).get(`/api${artifact.downloadPath}`).auth(fixture.accessToken, { type: 'bearer' }).expect(200);
    const bytes = Buffer.from(download.text);
    expect(bytes.toString()).toContain('name:');
    expect(bytes.toString()).not.toBe(fixture.versions.v1.content);
    expect(bytes.length).toBe(artifact.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.artifactSha256);
    expect(download.headers['x-sha256']).toBe(artifact.entrySha256);
    const metadata = await request(app.getHttpServer()).get(`/api/enterprise/employees/${fixture.employeeId}/skills`)
      .auth(fixture.accessToken, { type: 'bearer' }).expect(200);
    expect(metadata.body.skills[0].currentVersion.id).toBe(fixture.versions.v1.id);
    expect(metadata.body.skills[0].currentVersion.content).toBeUndefined();
    fixture.state = 'v2';
    await request(app.getHttpServer()).get(`/api${artifact.downloadPath}`).auth(fixture.accessToken, { type: 'bearer' }).expect(404);
    fixture.state = 'blocked';
    const blocked = await request(app.getHttpServer()).get(runtimePath).auth(fixture.accessToken, { type: 'bearer' }).expect(200);
    expect(blocked.body.runtime.skills[0].artifact).toMatchObject({ status: 'BLOCKED', reason: 'INVALID_ENTRY' });
    const blockedPath = `/api/client/subscriptions/${fixture.subscriptionId}/skills/${fixture.capabilityId}/versions/${fixture.versions.blocked.id}/artifact`;
    await request(app.getHttpServer()).get(blockedPath).auth(fixture.accessToken, { type: 'bearer' }).expect(409);
    fixture.state = 'revoked';
    await request(app.getHttpServer()).get(runtimePath).auth(fixture.accessToken, { type: 'bearer' }).expect(404);
    await request(app.getHttpServer()).get(`/api${artifact.downloadPath}`).auth(fixture.accessToken, { type: 'bearer' }).expect(404);
    await request(app.getHttpServer()).get(`/api/enterprise/employees/${fixture.employeeId}/skills`)
      .auth(fixture.accessToken, { type: 'bearer' }).expect(403);
  });
});

const databaseUrl = process.env.MEDIA_GATEWAY_TEST_DATABASE_URL;
const clientRoot = process.env.SEP_MEDIA_TEST_CLIENT_ROOT;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/sep_media_mock_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error('Client integration requires a local sep_media_mock_* database');
  }
}
const integration = databaseUrl && clientRoot ? describe : describe.skip;

integration('SEP and desktop client HTTP / PostgreSQL mock integration', () => {
  let app: INestApplication | undefined;
  let database: PrismaClient;
  const enterpriseId = `media-integration-${randomUUID()}`;
  const subscriptionId = 'integration-subscription';
  const memberId = 'integration-member';
  const secret = randomUUID();
  const jwt = new JwtService();
  const token = jwt.sign({ sub: 'integration-user', sid: 'integration-session', enterpriseId, subscriptionId, memberId,
    type: 'client-employment' }, { secret, algorithm: 'HS256', expiresIn: 600 });
  const foreignToken = jwt.sign({ sub: 'integration-user', sid: 'integration-session', enterpriseId, subscriptionId,
    memberId: 'other-member', type: 'client-employment' }, { secret, algorithm: 'HS256', expiresIn: 600 });
  const fixture = new EmployeeFixture(enterpriseId, subscriptionId, memberId);
  let submissions = 0;
  let sessionsChecked = 0;
  let clientActivity: Promise<string> | undefined;
  let stopClient: ((error: Error) => void) | undefined;

  async function start(port = 0) {
    const module = await Test.createTestingModule({
      imports: [SecurityModule], controllers: [MediaGatewayController, EmployeeFixtureController, ClientSkillArtifactController],
      providers: [MediaGatewayService, MediaGatewayMockAdapter, MediaGatewayMockGuard, ClientEmploymentGuard, SyntheticAccessGuard,
        { provide: EmployeeFixture, useValue: fixture },
        { provide: ClientSkillArtifactService, useValue: fixture.artifacts },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: (key: string) => ({ NODE_ENV: 'test', MEDIA_GATEWAY_MOCK_ENABLED: 'true',
          ACCESS_JWT_SECRET: secret })[key] } },
        { provide: SessionService, useValue: { assertActiveSession: async () => { sessionsChecked++; } } },
        { provide: GatewayAuthRateLimitService, useValue: { consumeFailure: async () => ({ allowed: true }) } },
        { provide: PrismaService, useValue: { enterpriseMember: { findFirst: async () => ({ departmentId: null }) },
          subscription: { findFirst: async () => fixture.state === 'revoked' ? null : ({ id: subscriptionId }) } } },
        { provide: MediaGatewayStore, useValue: new MediaGatewayStore(database as unknown as PrismaService) },
      ],
    }).overrideGuard(JwtAuthGuard).useClass(SyntheticAccessGuard).overrideProvider(getOptionsToken()).useValue([{ name: 'default', ttl: 60_000, limit: 1000 },
      { name: 'auth', ttl: 60_000, limit: 1000 }, { name: 'chat', ttl: 60_000, limit: 1000 }]).compile();
    const adapter = module.get(MediaGatewayMockAdapter);
    const submit = adapter.submit.bind(adapter);
    jest.spyOn(adapter, 'submit').mockImplementation(async (...args) => { submissions++; return submit(...args); });
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(port, '127.0.0.1');
    return app.getHttpServer().address().port as number;
  }

  beforeAll(async () => {
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await database.$connect();
  });
  afterAll(async () => {
    stopClient?.(new Error('Client integration teardown'));
    // Jest's test timeout must not bypass the child/reconstruction barrier.
    await clientActivity?.catch(() => undefined);
    try {
      try { await app?.close(); } finally {
        await database.mediaGatewayRequest.deleteMany({ where: { enterpriseId } });
        const scope = JSON.stringify([enterpriseId, subscriptionId, memberId, 'integration-user']);
        await database.mediaGatewayQuote.deleteMany({ where: { scope } });
        await database.mediaGatewayReference.deleteMany({ where: { scope } });
      }
    } finally { await database.$disconnect(); }
  }, 90_000);

  it('uses client service and atomic files against real Nest endpoints, including both-side reconstruction', async () => {
    const script = resolve(clientRoot!, 'scripts/test-sep-media-integration.ts');
    if (!existsSync(script)) throw new Error('SEP_MEDIA_TEST_CLIENT_ROOT does not contain the client integration runner');
    const port = await start();
    const output = await (clientActivity = new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: clientRoot, env: { ...process.env,
        SEP_BASE_URL: `http://127.0.0.1:${port}/api`,
        SEP_MEDIA_TEST_URL: `http://127.0.0.1:${port}/api`, SEP_MEDIA_TEST_TOKEN: token,
        SEP_MEDIA_TEST_ACCESS_TOKEN: fixture.accessToken, SEP_MEDIA_TEST_EMPLOYEE: fixture.employeeId,
        SEP_MEDIA_TEST_FOREIGN_TOKEN: foreignToken, SEP_MEDIA_TEST_ENTERPRISE: enterpriseId,
        SEP_MEDIA_TEST_MEMBER: memberId, SEP_MEDIA_TEST_SUBSCRIPTION: subscriptionId,
      }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', closed = false;
      let failure: Error | undefined;
      let restart: Promise<void> | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (error: Error) => {
        failure ??= error;
        if (closed) return;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000);
      };
      stopClient = terminate;
      const timer = setTimeout(() => terminate(new Error('Client integration timed out')), 60_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!restart && !failure && stdout.includes('SEP_MEDIA_RESTART_READY\n')) {
          restart = (async () => {
            await app!.close();
            if (closed || failure) return;
            await database.$disconnect();
            if (closed || failure) return;
            await database.$connect();
            if (closed || failure) return;
            await start(port);
            if (!closed && !failure) child.stdin.write('RESUME\n');
          })().catch(error => terminate(error instanceof Error ? error : new Error('Server reconstruction failed')));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', terminate);
      child.stdin.on('error', terminate);
      child.on('close', code => {
        closed = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        // Teardown cannot race a still-running child or server reconstruction.
        void (async () => {
          await restart;
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error(`Client integration failed (${code}): ${stdout}\n${stderr}`));
          else done(stdout);
        })();
      });
    }));
    expect(output).toContain('SEP_MEDIA_INTEGRATION_PASSED');
    expect(sessionsChecked).toBeGreaterThan(20);
    expect(fixture.calls.runtime).toBeGreaterThan(10);
    expect(fixture.calls.metadata).toBeGreaterThan(10);
    const records = await database.mediaGatewayRequest.count({ where: { enterpriseId } });
    expect(submissions).toBe(records);
    expect(records).toBeGreaterThanOrEqual(6);
  }, 90_000);
});
