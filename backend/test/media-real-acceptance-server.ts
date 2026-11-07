import 'reflect-metadata';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import cookieParser from 'cookie-parser';
import type { RequestHandler } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { basicRateLimitMiddleware } from '../src/common/middleware/basic-rate-limit.middleware';
import { createJsonBodyMiddleware } from '../src/common/middleware/json-body.middleware';
import { requestContextMiddleware } from '../src/common/middleware/request-context.middleware';
import type { SessionService } from '../src/modules/auth/session.service';
import type { ClientService } from '../src/modules/client/client.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Local fixtures only; never migrates, tops up an existing wallet, or calls upstream.
 * Required: NODE_ENV=test|development, MEDIA_REAL_ACCEPTANCE_SERVER=true,
 * MEDIA_REAL_TEST_DATABASE_URL, MEDIA_REAL_TEST_REDIS_URL, MEDIA_BASE_URL,
 * MEDIA_API_KEY and MEDIA_REAL_ACCEPTANCE_TOKEN_FILE (outside the repo, parent 0700).
 * Upstream: HTTPS loopback or the explicitly authorized ai.longdaoec.com:443 sub2api.
 * Optional: MEDIA_REAL_ACCEPTANCE_PORT=3012, MEDIA_REAL_ACCEPTANCE_FIXTURE=<batch>,
 * MEDIA_REAL_ACCEPTANCE_KIND=image|video (default image),
 * MEDIA_REAL_ACCEPTANCE_BALANCE_CNY=0 (maximum 60; isolated local fixture only),
 * MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION=true (default: requests POST is blocked).
 * MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE=true reopens only an existing fixture,
 * with GET-only HTTP, no new balance/grants or extended subscription lifetime.
 * Schema must already exist. A fixture name is single-use; restart never refills it.
 */
export class MediaAcceptanceConfigurationError extends Error {}
const invalid = (message: string): never => { throw new MediaAcceptanceConfigurationError(message); };
type Environment = Record<string, string | undefined>;
type AcceptanceKind = 'image' | 'video';
const repoRoot = resolve(__dirname, '../..');
const loopback = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
const videoParameters = { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', frameRate: 24,
  audio: true, outputFormat: 'video/mp4' } as const;
const videoCapabilities = { supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: true,
  durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24],
  maxInputBytes: 10 * 1024 * 1024, maxReferenceCount: 1, outputFormats: ['video/mp4'],
  supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 86_400 };

function localUrl(value: string | undefined): URL {
  try { return new URL(value ?? ''); } catch { invalid('Explicit local connection URL required'); }
}

export function mediaAcceptanceSettings(env: Environment) {
  if (env.MEDIA_REAL_ACCEPTANCE_SERVER !== 'true' || !['test', 'development'].includes(env.NODE_ENV ?? '') || env.E2E_TEST === '1') {
    invalid('Requires explicit MEDIA_REAL_ACCEPTANCE_SERVER=true and test/development without E2E_TEST');
  }
  const kind = env.MEDIA_REAL_ACCEPTANCE_KIND ?? 'image';
  if (kind !== 'image' && kind !== 'video') invalid('MEDIA_REAL_ACCEPTANCE_KIND must be image or video');
  const database = localUrl(env.MEDIA_REAL_TEST_DATABASE_URL);
  const allowedDbOptions = new Set(['schema', 'connection_limit', 'connect_timeout']);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !loopback(database) ||
      !/^\/sep_media_real_[a-z0-9_]+$/.test(database.pathname) || database.hash ||
      [...database.searchParams].some(([key, value]) => !allowedDbOptions.has(key) ||
        (key === 'schema' ? value !== 'public' : !/^[1-9]\d{0,2}$/.test(value))) ||
      [...database.searchParams.keys()].some(key => database.searchParams.getAll(key).length !== 1)) {
    invalid('Database must be loopback sep_media_real_* with only public schema/connection limits');
  }
  const redis = localUrl(env.MEDIA_REAL_TEST_REDIS_URL);
  if (redis.protocol !== 'redis:' || !loopback(redis) || !/^\/(?:[1-9]|1[0-5])$/.test(redis.pathname) || redis.search || redis.hash) {
    invalid('Requires explicit loopback Redis database 1..15; DB 0 is not isolated');
  }
  const upstream = localUrl(env.MEDIA_BASE_URL);
  const authorizedUpstream = loopback(upstream) || (upstream.hostname === 'ai.longdaoec.com' && !upstream.port);
  if (upstream.protocol !== 'https:' || !authorizedUpstream || upstream.username || upstream.password ||
      upstream.search || upstream.hash || !['/', '/v1', '/v1/'].includes(upstream.pathname) || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    invalid('MEDIA_BASE_URL requires HTTPS loopback or authorized ai.longdaoec.com:443, root or /v1; TLS bypass is forbidden');
  }
  if (!env.MEDIA_API_KEY?.trim() || env.MEDIA_API_KEY.length > 4096 || /[\r\n]/.test(env.MEDIA_API_KEY)) {
    invalid('MEDIA_API_KEY must be supplied in memory');
  }
  const rawPort = env.MEDIA_REAL_ACCEPTANCE_PORT ?? '3012';
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || [3001, 3002].includes(port)) {
    invalid('Requires separate MEDIA_REAL_ACCEPTANCE_PORT (default 3012)');
  }
  const fixture = env.MEDIA_REAL_ACCEPTANCE_FIXTURE ?? randomUUID().replace(/-/g, '');
  if (!/^[a-z0-9][a-z0-9_]{2,39}$/.test(fixture)) invalid('Fixture name must contain 3..40 lowercase letters/digits/underscores');
  const balance = env.MEDIA_REAL_ACCEPTANCE_BALANCE_CNY ?? '0';
  if (!/^\d{1,2}(?:\.\d{1,6})?$/.test(balance) || new Decimal(balance).greaterThan(60)) {
    invalid('Local fixture balance must be between 0 and 60 CNY, at most six decimals');
  }
  if (env.MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION !== undefined && !['true', 'false'].includes(env.MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION)) {
    invalid('MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION must be true or false');
  }
  if (env.MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE !== undefined && !['true', 'false'].includes(env.MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE)) {
    invalid('MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE must be true or false');
  }
  const recoverFixture = env.MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE === 'true';
  if (recoverFixture && (env.MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION === 'true' || !env.MEDIA_REAL_ACCEPTANCE_FIXTURE)) {
    invalid('Recovery requires an explicit existing fixture and forbids execution');
  }
  const tokenFile = env.MEDIA_REAL_ACCEPTANCE_TOKEN_FILE;
  const withinRepo = tokenFile && relative(repoRoot, resolve(tokenFile));
  if (!tokenFile || !isAbsolute(tokenFile) || !withinRepo || (!withinRepo.startsWith('..' + '/') && !isAbsolute(withinRepo))) {
    invalid('Token file must be an absolute path outside the repository');
  }
  return {
    databaseUrl: database.href, redisUrl: redis.href, port, fixture, tokenFile, kind: kind as AcceptanceKind,
    balanceCny: new Decimal(balance).toFixed(6), allowExecution: env.MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION === 'true', recoverFixture,
    // This allowlist intentionally excludes all inherited business/cloud/payment credentials.
    runtime: {
      NODE_ENV: env.NODE_ENV, DATABASE_URL: database.href, REDIS_URL: redis.href,
      JWT_SECRET: randomBytes(32).toString('hex'), ACCESS_JWT_SECRET: randomBytes(32).toString('hex'),
      REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex'), REFRESH_TOKEN_EXPIRES_IN: '1h',
      CLIENT_TOKEN_TTL_MINUTES: '15', USD_TO_CNY_RATE: '7.2', MAIL_ENABLED: 'false',
      MEDIA_GATEWAY_REAL_ENABLED: kind === 'image' ? 'true' : 'false', MEDIA_GATEWAY_MOCK_ENABLED: 'false',
      MEDIA_BASE_URL: upstream.href, MEDIA_API_KEY: env.MEDIA_API_KEY,
      ...(kind === 'video' ? {
        MEDIA_VIDEO_REAL_ENABLED: 'true', MEDIA_VIDEO_BASE_URL: upstream.href, MEDIA_VIDEO_API_KEY: env.MEDIA_API_KEY,
        MEDIA_VIDEO_CACHE_DIR: resolve(dirname(tokenFile), `video-cache-${fixture}`),
      } : {}),
    },
  };
}
export type MediaAcceptanceSettings = ReturnType<typeof mediaAcceptanceSettings>;

export async function openMediaAcceptanceTokenFile(path: string) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.()) {
    invalid('Token parent must be an existing owner-only 0700 directory');
  }
  const resolvedParent = await realpath(dirname(path));
  const resolvedRepo = await realpath(repoRoot);
  if (resolvedParent === resolvedRepo || resolvedParent.startsWith(`${resolvedRepo}/`)) {
    invalid('Token directory must not resolve inside the repository');
  }
  // Exclusive create rejects symlinks, existing files, FIFOs and accidental overwrites.
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const created = await handle.stat();
  return {
    directory: resolvedParent,
    async write(value: unknown) { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); },
    async close() {
      try {
        const current = await lstat(path).catch(() => undefined);
        if (current?.ino === created.ino && current?.dev === created.dev) await unlink(path);
      } finally { await handle.close(); }
    },
  };
}

export function mediaAcceptanceHttpBoundary(allowExecution: boolean, recoveryOnly = false, kind: AcceptanceKind = 'image'): RequestHandler {
  return (req, res, next) => {
    const path = req.path.replace(/\/+$/, '').toLowerCase();
    const root = `/api/gateway/v1/media/${kind === 'video' ? 'video-real' : 'real'}`;
    const requestRead = kind === 'image' ? path.startsWith(`${root}/requests/`) :
      new RegExp(`^${root}/requests/(?:by-client-id/[a-z0-9_-]{1,128}|[a-z0-9_-]{1,128}(?:/outputs/[a-z0-9_-]{1,128}/content)?)$`).test(path);
    const runtime = kind === 'video' && /^\/api\/client\/subscriptions\/[a-z0-9_-]{1,128}\/runtime$/.test(path);
    const read = req.method === 'GET' && (runtime || path === `${root}/profiles` || requestRead);
    const prepare = req.method === 'POST' && [`${root}/quotes`, `${root}/references`].includes(path);
    const submit = req.method === 'POST' && path === `${root}/requests`;
    if (read || (!recoveryOnly && (prepare || (submit && allowExecution)))) return next();
    res.status(submit ? 403 : 404).json({ error: { code: submit ? 'LOCAL_EXECUTION_DISABLED' : 'LOCAL_ROUTE_DISABLED' } });
  };
}

export async function recoverMediaAcceptanceFixture(prisma: PrismaService, local: MediaAcceptanceSettings) {
  if (!local.recoverFixture || local.allowExecution) invalid('Read-only fixture recovery required');
  const prefix = `media-real-acceptance-${local.fixture}`;
  return prisma.$transaction(async tx => {
    if (await tx.systemSetting.count({ where: { key: { in: [
      'MEDIA_BASE_URL', 'MEDIA_API_KEY', 'MEDIA_VIDEO_BASE_URL', 'MEDIA_VIDEO_API_KEY', 'CLIENT_TOKEN_TTL_MINUTES', 'USD_TO_CNY_RATE',
    ] } } })) invalid('Isolated DB has connection/TTL/rate overrides');
    const user = await tx.user.findUnique({ where: { email: `${prefix}@fixture.invalid` }, select: { id: true } });
    const enterprises = await tx.enterprise.findMany({ where: { name: `${prefix} LOCAL FIXTURE` }, select: { id: true, metadata: true } });
    const enterprise = enterprises.length === 1 ? enterprises[0] : null;
    const metadata = enterprise?.metadata;
    if (!user || !enterprise || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        metadata.localAcceptanceFixture !== true || metadata.batch !== local.fixture ||
        (metadata.kind ?? 'image') !== local.kind) invalid('Existing local fixture required');
    const member = await tx.enterpriseMember.findUnique({ where: { userId_enterpriseId: { userId: user.id, enterpriseId: enterprise.id } }, select: { id: true } });
    const subscriptions = await tx.subscription.findMany({ where: { enterpriseId: enterprise.id, name: prefix,
      employee: { name: prefix }, status: 'ACTIVE', endDate: { gt: new Date() } }, select: { id: true, endDate: true } });
    const device = await tx.device.findUnique({ where: { userId_fingerprint: { userId: user.id, fingerprint: prefix } }, select: { id: true, revokedAt: true } });
    const profile = await tx.mediaModelProfile.findUnique({ where: { profileId: `acceptance-${local.fixture}` },
      select: { profileId: true, kind: true, modelId: true, configVersion: true, capabilities: true } });
    if (!member || subscriptions.length !== 1 || !device || device.revokedAt || !profile) invalid('Existing local fixture is unavailable');
    if (local.kind === 'video' && (profile.kind !== 'video' || profile.modelId !== 'minimax-h3')) invalid('Existing video fixture profile mismatch');
    return { userId: user.id, enterpriseId: enterprise.id, memberId: member.id, subscriptionId: subscriptions[0].id,
      deviceId: device.id, profileId: profile.profileId, expiresAt: subscriptions[0].endDate!.toISOString(),
      ...(local.kind === 'video' ? { configVersion: profile.configVersion, modelId: profile.modelId, parameters: videoParameters } : {}) };
  }, { isolationLevel: 'Serializable', timeout: 15_000 });
}

export async function createMediaAcceptanceFixture(prisma: PrismaService, local: MediaAcceptanceSettings) {
  if (local.recoverFixture) invalid('Recovery cannot create or refill a fixture');
  const prefix = `media-real-acceptance-${local.fixture}`;
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  return prisma.$transaction(async tx => {
    // DB overrides win over environment. Refuse them, never modify another run's settings.
    const overrides = await tx.systemSetting.count({ where: { key: { in: [
      'MEDIA_BASE_URL', 'MEDIA_API_KEY', 'MEDIA_VIDEO_BASE_URL', 'MEDIA_VIDEO_API_KEY', 'CLIENT_TOKEN_TTL_MINUTES', 'USD_TO_CNY_RATE',
    ] } } });
    if (overrides) invalid('Isolated DB has connection/TTL/rate overrides; use a clean acceptance database');
    if (await tx.user.findUnique({ where: { email: `${prefix}@fixture.invalid` }, select: { id: true } })) {
      invalid('Fixture already exists; choose a new batch (existing balances are never refilled)');
    }
    const user = await tx.user.create({ data: { email: `${prefix}@fixture.invalid`, name: `${prefix} LOCAL FIXTURE`, role: 'USER' } });
    const enterprise = await tx.enterprise.create({ data: { name: `${prefix} LOCAL FIXTURE`,
      metadata: { localAcceptanceFixture: true, batch: local.fixture, kind: local.kind } } });
    const member = await tx.enterpriseMember.create({ data: { userId: user.id, enterpriseId: enterprise.id, role: 'MEMBER' } });
    const employee = await tx.digitalEmployee.create({ data: {
      name: prefix, description: 'Local media HTTP acceptance fixture, not a production employee', industry: 'testing',
      position: 'media-acceptance', systemPrompt: 'Local media acceptance fixture', status: 'APPROVED',
      modelId: local.kind === 'video' ? 'minimax-h3' : 'gpt-image-2', includedComputeCNY: 0,
    } });
    const capability = await tx.capability.create({ data: {
      name: `${prefix}-skill`, description: 'Local acceptance media skill fixture', type: 'SKILL',
      industry: ['testing'], position: ['media-acceptance'], inputSchema: {}, outputSchema: {},
      contributorId: user.id, enterpriseId: enterprise.id, status: 'APPROVED', enterpriseReviewStatus: 'APPROVED',
    } });
    const version = await tx.skillVersion.create({ data: {
      capabilityId: capability.id, scope: 'ENTERPRISE', enterpriseId: enterprise.id, status: 'ENTERPRISE_APPROVED',
      version: '1.0.0', content: local.kind === 'video'
        ? '# Local video acceptance\nUse video_generate only after explicit confirmation.'
        : '# Local media acceptance\nUse image_generate or image_edit only after explicit confirmation.',
      createdById: user.id, enterpriseReviewedAt: new Date(),
    } });
    await tx.employeeCapabilityBinding.create({ data: { employeeId: employee.id, capabilityId: capability.id, defaultSkillVersionId: version.id } });
    const subscription = await tx.subscription.create({ data: {
      enterpriseId: enterprise.id, employeeId: employee.id, templateVersion: '1.0.0', name: prefix, endDate: expiresAt,
    } });
    await tx.employeeGrant.create({ data: { subscriptionId: subscription.id, memberId: member.id, expiresAt } });
    // Synthetic local personal funds only: no enterprise credit, top-ups, recharge or payment records.
    await tx.personalWallet.create({ data: { userId: user.id, balance: local.balanceCny } });
    const profile = await tx.mediaModelProfile.create({ data: {
      profileId: `acceptance-${local.fixture}`, displayName: `${local.fixture} LOCAL FIXTURE`,
      configVersion: `local-${randomUUID()}`,
      ...(local.kind === 'video' ? { kind: 'video', modelId: 'minimax-h3', operations: ['text-to-video', 'image-to-video'],
        executionMode: 'async-query', capabilities: videoCapabilities } : {
        modelId: 'gpt-image-2', operations: ['generate', 'edit'], executionMode: 'sync-response',
        capabilities: { supportsReferenceImage: true, maxOutputs: 1, sizes: ['1024x1024'] },
      }),
      // Fixture attestation only; this does not assert that upstream execution has been verified.
      enabled: true, verified: true,
    } });
    await tx.enterpriseModelConfig.create({ data: { enterpriseId: enterprise.id, mediaPolicy: local.kind === 'video' ? { video: {
      enabledProfileIds: [profile.profileId], defaultProfileId: profile.profileId,
      allowedOperations: ['text-to-video', 'image-to-video'], maxDurationSeconds: 4,
      allowedAspectRatios: ['16:9'], maxResolution: '720p', maxConcurrentJobs: 1, periodBudget: Number(local.balanceCny),
    } } : {
      enabledProfileIds: [profile.profileId], defaultProfileId: profile.profileId, allowedOperations: ['generate', 'edit'],
      maxOutputs: 1, maxWidth: 1024, maxHeight: 1024,
    } } });
    const device = await tx.device.create({ data: { userId: user.id, fingerprint: prefix, platform: process.platform } });
    return { userId: user.id, enterpriseId: enterprise.id, memberId: member.id, subscriptionId: subscription.id,
      deviceId: device.id, profileId: profile.profileId, expiresAt: expiresAt.toISOString(),
      ...(local.kind === 'video' ? { configVersion: profile.configVersion, modelId: profile.modelId, parameters: videoParameters } : {}) };
  }, { isolationLevel: 'Serializable', timeout: 15_000 });
}

export async function startMediaAcceptanceServer(env: Environment = process.env) {
  const local = mediaAcceptanceSettings(env);
  Logger.overrideLogger(false);
  const delivery = await openMediaAcceptanceTokenFile(local.tokenFile);
  if (local.kind === 'video') local.runtime.MEDIA_VIDEO_CACHE_DIR = resolve(delivery.directory, `video-cache-${local.fixture}`);
  let moduleRef: TestingModule | undefined;
  let app: INestApplication | undefined;
  let sessions: SessionService | undefined;
  let sessionId: string | undefined;
  let closing: Promise<void> | undefined;
  const previousEnvironment = process.env;
  // This ConfigService version falls back to process.env even with ignoreEnvVars.
  // Prisma also reads process.env directly. Keep both on the same explicit allowlist.
  const hostEnvironment: Environment = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'NODE_EXTRA_CA_CERTS']) {
    if (previousEnvironment[key] !== undefined) hostEnvironment[key] = previousEnvironment[key];
  }
  // Generated Prisma clients may auto-load .env. They must not inject or replace
  // anything here, including settings that ConfigService would otherwise inherit.
  process.env = new Proxy({ ...hostEnvironment, ...local.runtime }, {
    set: () => true, defineProperty: () => false, deleteProperty: () => false,
  });
  const close = () => closing ??= (async () => {
    try {
      if (sessionId) await sessions?.revokeSession(sessionId, 'local_acceptance_shutdown');
    } finally {
      try { if (app) await app.close(); else await moduleRef?.close(); }
      finally {
        try { await delivery.close(); }
        finally {
          process.env = previousEnvironment;
        }
      }
    }
  })();
  try {
    // Lazy imports ensure validation and the explicit Prisma DSN precede module initialization.
    const [client, media, security, redis, prisma, session] = await Promise.all([
      import('../src/modules/client/client.module'), import('../src/modules/media-gateway/media-gateway.module'),
      import('../src/modules/security/security.module'), import('../src/redis/redis.service'),
      import('../src/prisma/prisma.service'), import('../src/modules/auth/session.service'),
    ]);
    const config = await ConfigModule.forRoot({
      isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => local.runtime],
    });
    moduleRef = await Test.createTestingModule({ imports: [config, security.SecurityModule, client.ClientModule, media.MediaGatewayModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    app.setGlobalPrefix('api');
    app.use(mediaAcceptanceHttpBoundary(local.allowExecution, local.recoverFixture, local.kind));
    app.use(requestContextMiddleware, basicRateLimitMiddleware, createJsonBodyMiddleware(), cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.get(redis.RedisService).redis.ping();
    const database = app.get(prisma.PrismaService);
    const fixture = await (local.recoverFixture ? recoverMediaAcceptanceFixture : createMediaAcceptanceFixture)(database, local);
    sessions = app.get(session.SessionService);
    const created = await sessions.createSession({ userId: fixture.userId, clientType: 'DESKTOP', deviceId: fixture.deviceId, refreshTtlSeconds: 3600 });
    sessionId = created.sessionId;
    const { ClientService: ClientServiceClass } = await import('../src/modules/client/client.service');
    const clientService = app.get<ClientService>(ClientServiceClass);
    const access = local.kind === 'video' ? await clientService.refreshAccessToken({ refreshToken: created.refreshToken }) : undefined;
    const tokens = await clientService.refreshInstanceToken({ refreshToken: access?.refreshToken ?? created.refreshToken, subscriptionId: fixture.subscriptionId });
    // Neither session refresh tokens nor upstream credentials are delivered or logged.
    await app.listen(local.port, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${local.port}/api`;
    const wallet = await database.personalWallet.findUniqueOrThrow({ where: { userId: fixture.userId }, select: { balance: true } });
    await delivery.write({ baseUrl, employmentToken: tokens.employmentToken, expiresIn: tokens.expiresIn,
      ...fixture, balanceCny: wallet.balance.toFixed(6), localFixtureOnly: true, executionEnabled: local.allowExecution,
      recoveryOnly: local.recoverFixture, kind: local.kind,
      ...(access ? { accessToken: access.accessToken, accessTokenExpiresIn: access.accessTokenExpiresIn,
        runtimeUrl: `${baseUrl}/client/subscriptions/${fixture.subscriptionId}/runtime?videoProtocolVersion=1`,
        cacheDirectory: local.runtime.MEDIA_VIDEO_CACHE_DIR } : {}) });
    return { app, fixture, baseUrl, close };
  } catch (error) { await close(); throw error; }
}

export async function mediaAcceptanceServerCli() {
  let stopping = false;
  let server: Awaited<ReturnType<typeof startMediaAcceptanceServer>> | undefined;
  const stop = () => { stopping = true; if (server) void server.close().catch(reportCloseFailure); };
  const reportCloseFailure = () => { console.error('MEDIA_REAL_ACCEPTANCE_SERVER_CLOSE_FAILED (details suppressed)'); process.exitCode = 1; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    server = await startMediaAcceptanceServer();
    if (stopping) await server.close();
    else console.log(`MEDIA_REAL_ACCEPTANCE_SERVER_READY ${server.baseUrl}`);
  } catch (error) {
    console.error(error instanceof MediaAcceptanceConfigurationError
      ? `MEDIA_REAL_ACCEPTANCE_SERVER_CONFIG_ERROR: ${error.message}`
      : 'MEDIA_REAL_ACCEPTANCE_SERVER_START_FAILED (details suppressed)');
    process.exitCode = 1;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) void mediaAcceptanceServerCli();
