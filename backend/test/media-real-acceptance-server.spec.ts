import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
  createMediaAcceptanceFixture, mediaAcceptanceHttpBoundary, mediaAcceptanceSettings,
  openMediaAcceptanceTokenFile, recoverMediaAcceptanceFixture, startMediaAcceptanceServer,
} from './media-real-acceptance-server';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { ClientService } from '../src/modules/client/client.service';
import { MediaRealBillingService } from '../src/modules/media-gateway/media-real-billing.service';
import { MediaByteCacheService } from '../src/modules/media-gateway/media-byte-cache.service';
import { MediaVideoPolicySchema } from '../src/shared/media-video-config.dto';
import { MediaVideoGatewayQuoteRequestSchema, MediaVideoProfileSchema } from '../src/shared/media-video.dto';

const settings = (changes: Record<string, string | undefined> = {}) => mediaAcceptanceSettings({
  NODE_ENV: 'test', MEDIA_REAL_ACCEPTANCE_SERVER: 'true',
  MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://test:fixture@127.0.0.1:5432/sep_media_real_unit',
  MEDIA_REAL_TEST_REDIS_URL: 'redis://127.0.0.1:6379/15', MEDIA_BASE_URL: 'https://127.0.0.1:9443/v1',
  MEDIA_API_KEY: 'unit-test-placeholder-not-an-upstream-key', MEDIA_REAL_ACCEPTANCE_TOKEN_FILE: '/private/tmp/sep-acceptance/token.json',
  MEDIA_REAL_ACCEPTANCE_FIXTURE: 'unit_20261015', ...changes,
});

describe('local media acceptance safety boundaries', () => {
  it('never falls back to inherited business DSNs/keys and requires a separate opt-in', () => {
    const local = settings({ DATABASE_URL: 'postgresql://prod/sep_platform', JWT_SECRET: 'inherited', SUB2API_API_KEY: 'do-not-copy' });
    expect(local.runtime.DATABASE_URL).toContain('/sep_media_real_unit');
    expect(local.runtime.JWT_SECRET).not.toBe('inherited');
    expect(local.runtime).not.toHaveProperty('SUB2API_API_KEY');
    expect(local.balanceCny).toBe('0.000000');
    expect(local.allowExecution).toBe(false);
    expect(local.kind).toBe('image');
    expect(local.runtime).not.toHaveProperty('MEDIA_VIDEO_API_KEY');
    expect(() => settings({ MEDIA_REAL_TEST_DATABASE_URL: undefined, DATABASE_URL: 'postgresql://localhost/sep_media_real_business' })).toThrow();
  });

  it.each([
    { MEDIA_REAL_ACCEPTANCE_SERVER: undefined }, { NODE_ENV: 'production' }, { NODE_ENV: undefined }, { E2E_TEST: '1' },
    { MEDIA_REAL_ACCEPTANCE_KIND: 'mock' }, { MEDIA_REAL_ACCEPTANCE_KIND: '' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://remote/sep_media_real_test' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_platform' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_%61' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_test?host=remote' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_test?hostaddr=remote' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_test?options=-c%20search_path=business' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_test?schema=business' },
    { MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_test?schema=public&schema=public' },
    { MEDIA_REAL_TEST_REDIS_URL: undefined }, { MEDIA_REAL_TEST_REDIS_URL: 'redis://remote:6379/15' },
    { MEDIA_REAL_TEST_REDIS_URL: 'redis://127.0.0.1:6379/0' }, { MEDIA_REAL_TEST_REDIS_URL: 'redis://127.0.0.1:6379/1junk' },
    { MEDIA_REAL_TEST_REDIS_URL: 'redis://127.0.0.1:6379/15?host=remote' },
    { MEDIA_BASE_URL: 'https://production.example/v1' }, { MEDIA_BASE_URL: 'http://127.0.0.1:8080/v1' },
    { MEDIA_BASE_URL: 'http://ai.longdaoec.com/v1' }, { MEDIA_BASE_URL: 'https://legacy-upstream.example/v1' },
    { MEDIA_BASE_URL: 'https://ai.longdaoec.com.example/v1' }, { MEDIA_BASE_URL: 'https://ai.longdaoec.com:9443/v1' },
    { MEDIA_BASE_URL: 'https://ai.longdaoec.com/v1?key=secret' }, { MEDIA_BASE_URL: 'https://key@ai.longdaoec.com/v1' },
    { MEDIA_BASE_URL: 'https://key@127.0.0.1/v1' }, { MEDIA_BASE_URL: 'https://127.0.0.1/v1?key=secret' },
    { MEDIA_BASE_URL: 'https://127.0.0.1/proxy' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { MEDIA_API_KEY: undefined }, { MEDIA_API_KEY: 'key\nsecret' },
    { MEDIA_REAL_ACCEPTANCE_PORT: '3001' }, { MEDIA_REAL_ACCEPTANCE_PORT: '3002' },
    { MEDIA_REAL_ACCEPTANCE_PORT: '0' }, { MEDIA_REAL_ACCEPTANCE_PORT: '65536' }, { MEDIA_REAL_ACCEPTANCE_PORT: '3012x' },
    { MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '-1' }, { MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '60.000001' },
    { MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '1e1' }, { MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '0.0000001' },
    { MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION: 'yes' }, { MEDIA_REAL_ACCEPTANCE_FIXTURE: '../business' },
    { MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE: 'yes' },
    { MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE: 'true', MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION: 'true' },
    { MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE: 'true', MEDIA_REAL_ACCEPTANCE_FIXTURE: undefined },
    { MEDIA_REAL_ACCEPTANCE_TOKEN_FILE: 'relative.json' }, { MEDIA_REAL_ACCEPTANCE_TOKEN_FILE: join(__dirname, 'secret.json') },
  ])('rejects unsafe configuration %# without echoing credentials', changes => {
    expect(() => settings(changes)).toThrow();
    try { settings(changes); } catch (error) {
      expect((error as Error).message).not.toContain('key\nsecret');
      expect((error as Error).message).not.toContain('production.example');
    }
  });

  it('accepts a bounded explicit balance and public-schema pool options', () => {
    const local = settings({ MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '60', MEDIA_REAL_ACCEPTANCE_ALLOW_EXECUTION: 'true',
      MEDIA_REAL_TEST_DATABASE_URL: 'postgresql://127.0.0.1/sep_media_real_test?schema=public&connection_limit=2&connect_timeout=3' });
    expect(local.balanceCny).toBe('60.000000');
    expect(local.allowExecution).toBe(true);
  });

  it('enables only explicit video mode with isolated relay credentials and private fixture cache', () => {
    const local = settings({ MEDIA_REAL_ACCEPTANCE_KIND: 'video', MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '60',
      MEDIA_VIDEO_BASE_URL: 'https://must-not-inherit.invalid', MEDIA_VIDEO_API_KEY: 'must-not-inherit',
      MEDIA_VIDEO_CACHE_DIR: '/shared/production-cache', MEDIA_VIDEO_REAL_ENABLED: 'false' });
    expect(local).toMatchObject({ kind: 'video', balanceCny: '60.000000', allowExecution: false });
    expect(local.runtime).toMatchObject({ MEDIA_VIDEO_REAL_ENABLED: 'true', MEDIA_GATEWAY_REAL_ENABLED: 'false',
      MEDIA_GATEWAY_MOCK_ENABLED: 'false', MEDIA_VIDEO_BASE_URL: local.runtime.MEDIA_BASE_URL,
      MEDIA_VIDEO_API_KEY: local.runtime.MEDIA_API_KEY,
      MEDIA_VIDEO_CACHE_DIR: '/private/tmp/sep-acceptance/video-cache-unit_20261015' });
    expect(() => settings({ MEDIA_REAL_ACCEPTANCE_KIND: 'video', MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '60.000001' })).toThrow();
    expect(() => settings({ MEDIA_REAL_ACCEPTANCE_KIND: 'video', MEDIA_API_KEY: undefined,
      MEDIA_VIDEO_API_KEY: 'must-not-fallback' })).toThrow();
  });

  it.each(['image', 'video'] as const)('creates a single bounded %s fixture without refilling', async kind => {
    const make = (id: string) => ({ create: jest.fn(async ({ data }) => ({ ...data, id })) });
    const tx = {
      systemSetting: { count: jest.fn().mockResolvedValue(0) },
      user: { ...make('user'), findUnique: jest.fn().mockResolvedValue(null) }, enterprise: make('enterprise'),
      enterpriseMember: make('member'), digitalEmployee: make('employee'), capability: make('capability'),
      skillVersion: make('skill-version'), employeeCapabilityBinding: make('binding'), subscription: make('subscription'),
      employeeGrant: make('grant'), personalWallet: make('wallet'), mediaModelProfile: make('profile'),
      enterpriseModelConfig: make('policy'), device: make('device'),
    };
    const prisma = { $transaction: (work: (tx: unknown) => unknown) => work(tx) } as unknown as PrismaService;
    const local = settings({ MEDIA_REAL_ACCEPTANCE_KIND: kind, MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '60' });
    const fixture = await createMediaAcceptanceFixture(prisma, local);
    const profile = tx.mediaModelProfile.create.mock.calls[0][0].data;
    const mediaPolicy = tx.enterpriseModelConfig.create.mock.calls[0][0].data.mediaPolicy;
    expect(tx.personalWallet.create).toHaveBeenCalledWith({ data: { userId: 'user', balance: local.balanceCny } });
    if (kind === 'video') {
      expect(profile).toMatchObject({ kind: 'video', modelId: 'minimax-h3', executionMode: 'async-query',
        operations: ['text-to-video', 'image-to-video'], enabled: true, verified: true,
        capabilities: { maxReferenceCount: 1, maxInputBytes: 10 * 1024 * 1024, supportsAudio: true } });
      expect(MediaVideoProfileSchema.safeParse(profile).success).toBe(true);
      expect(MediaVideoPolicySchema.parse(mediaPolicy.video)).toMatchObject({ periodBudget: 60, maxConcurrentJobs: 1,
        maxDurationSeconds: 4, maxResolution: '720p', allowedAspectRatios: ['16:9'] });
      expect(mediaPolicy).not.toHaveProperty('enabledProfileIds');
      expect(fixture).toMatchObject({ modelId: 'minimax-h3', configVersion: profile.configVersion, parameters: {
        durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', frameRate: 24, audio: true, outputFormat: 'video/mp4' } });
      expect(MediaVideoGatewayQuoteRequestSchema.safeParse({ profileId: profile.profileId, configVersion: profile.configVersion,
        operation: 'image-to-video', referenceIds: ['one-png'], creativeBrief: 'test', parameters: fixture.parameters }).success).toBe(true);
    } else {
      expect(profile).toMatchObject({ modelId: 'gpt-image-2', operations: ['generate', 'edit'], executionMode: 'sync-response' });
      expect(mediaPolicy).not.toHaveProperty('video');
    }
    tx.user.findUnique.mockResolvedValue({ id: 'user' });
    await expect(createMediaAcceptanceFixture(prisma, local)).rejects.toThrow('already exists');
    expect(tx.personalWallet.create).toHaveBeenCalledTimes(1);
  });

  it.each(['https://ai.longdaoec.com', 'https://ai.longdaoec.com:443/v1'])('allows authorized sub2api %s without enabling execution', upstream => {
    const local = settings({ MEDIA_BASE_URL: upstream });
    expect(new URL(local.runtime.MEDIA_BASE_URL).hostname).toBe('ai.longdaoec.com');
    expect(local.allowExecution).toBe(false);
    expect(local.balanceCny).toBe('0.000000');
  });

  it('fails before opening resources when not opted in', async () => {
    await expect(startMediaAcceptanceServer({ NODE_ENV: 'test' })).rejects.toThrow('Requires explicit');
  });

  it('cannot refill a duplicate fixture or overwrite DB media overrides', async () => {
    const tx = { systemSetting: { count: jest.fn().mockResolvedValue(1) }, user: { findUnique: jest.fn().mockResolvedValue({ id: 'existing' }) } };
    const prisma = { $transaction: (work: (tx: unknown) => unknown) => work(tx) } as unknown as PrismaService;
    await expect(createMediaAcceptanceFixture(prisma, settings())).rejects.toThrow('overrides');
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    tx.systemSetting.count.mockResolvedValue(0);
    await expect(createMediaAcceptanceFixture(prisma, settings())).rejects.toThrow('already exists');
  });

  it('reopens only the original local fixture without creating funds or extending its lifetime', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const tx = {
      systemSetting: { count: jest.fn().mockResolvedValue(0) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'original-user' }) },
      enterprise: { findMany: jest.fn().mockResolvedValue([{ id: 'original-enterprise', metadata: { localAcceptanceFixture: true, batch: 'unit_20261015' } }]) },
      enterpriseMember: { findUnique: jest.fn().mockResolvedValue({ id: 'original-member' }) },
      subscription: { findMany: jest.fn().mockResolvedValue([{ id: 'original-subscription', endDate: expiresAt }]) },
      device: { findUnique: jest.fn().mockResolvedValue({ id: 'original-device', revokedAt: null }) },
      mediaModelProfile: { findUnique: jest.fn().mockResolvedValue({ profileId: 'original-profile' }) },
    };
    const prisma = { $transaction: (work: (tx: unknown) => unknown) => work(tx) } as unknown as PrismaService;
    const local = settings({ MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE: 'true' });
    await expect(createMediaAcceptanceFixture(prisma, local)).rejects.toThrow('cannot create');
    await expect(recoverMediaAcceptanceFixture(prisma, settings())).rejects.toThrow('Read-only');
    await expect(recoverMediaAcceptanceFixture(prisma, local)).resolves.toEqual({
      userId: 'original-user', enterpriseId: 'original-enterprise', memberId: 'original-member',
      subscriptionId: 'original-subscription', deviceId: 'original-device', profileId: 'original-profile', expiresAt: expiresAt.toISOString(),
    });
    expect(tx.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      status: 'ACTIVE', endDate: { gt: expect.any(Date) },
    }) }));
    tx.enterprise.findMany.mockResolvedValue([{ id: 'other-enterprise', metadata: { localAcceptanceFixture: true, batch: 'other' } }]);
    await expect(recoverMediaAcceptanceFixture(prisma, local)).rejects.toThrow('Existing local fixture');
    tx.systemSetting.count.mockResolvedValue(1);
    await expect(recoverMediaAcceptanceFixture(prisma, local)).rejects.toThrow('overrides');
  });

  it('recovers video fixtures only as video without changing their frozen model or funds', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const tx = {
      systemSetting: { count: jest.fn().mockResolvedValue(0) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user' }) },
      enterprise: { findMany: jest.fn().mockResolvedValue([{ id: 'enterprise',
        metadata: { localAcceptanceFixture: true, batch: 'unit_20261015', kind: 'video' } }]) },
      enterpriseMember: { findUnique: jest.fn().mockResolvedValue({ id: 'member' }) },
      subscription: { findMany: jest.fn().mockResolvedValue([{ id: 'subscription', endDate: expiresAt }]) },
      device: { findUnique: jest.fn().mockResolvedValue({ id: 'device', revokedAt: null }) },
      mediaModelProfile: { findUnique: jest.fn().mockResolvedValue({ profileId: 'profile', configVersion: 'frozen',
        kind: 'video', modelId: 'minimax-h3' }) },
    };
    const prisma = { $transaction: (work: (tx: unknown) => unknown) => work(tx) } as unknown as PrismaService;
    const local = settings({ MEDIA_REAL_ACCEPTANCE_KIND: 'video', MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE: 'true' });
    await expect(recoverMediaAcceptanceFixture(prisma, local)).resolves.toMatchObject({ profileId: 'profile',
      modelId: 'minimax-h3', configVersion: 'frozen', expiresAt: expiresAt.toISOString(), parameters: { audio: true } });
    await expect(recoverMediaAcceptanceFixture(prisma, settings({ MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE: 'true' }))).rejects.toThrow('Existing local fixture');
    tx.mediaModelProfile.findUnique.mockResolvedValue({ profileId: 'profile', configVersion: 'frozen', kind: 'video', modelId: 'other' });
    await expect(recoverMediaAcceptanceFixture(prisma, local)).rejects.toThrow('profile mismatch');
  });

  it.each(['quotes', 'references', 'requests'])('blocks every POST in fixture recovery: %s', path => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mediaAcceptanceHttpBoundary(false, true)({ method: 'POST', path: `/api/gateway/v1/media/real/${path}` } as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(path === 'requests' ? 403 : 404);
  });

  it.each([
    ['GET', '/api/client/subscriptions/sub-1/runtime', false, false, null],
    ['GET', '/api/gateway/v1/media/video-real/profiles', false, true, null],
    ['GET', '/api/gateway/v1/media/video-real/requests/by-client-id/client-1', false, true, null],
    ['GET', '/api/gateway/v1/media/video-real/requests/receipt/outputs/output/content', false, true, null],
    ['POST', '/api/gateway/v1/media/video-real/references', false, false, null],
    ['POST', '/api/gateway/v1/media/video-real/quotes', false, false, null],
    ['POST', '/api/gateway/v1/media/video-real/requests', false, false, 403],
    ['POST', '/api/gateway/v1/media/video-real/requests', true, false, null],
    ['POST', '/api/gateway/v1/media/video-real/requests', true, true, 403],
    ['POST', '/api/gateway/v1/media/video-real/references', true, true, 404],
    ['POST', '/api/gateway/v1/media/video-real/quotes', true, true, 404],
    ['POST', '/api/gateway/v1/media/video-real/requests/receipt/cancel', true, false, 404],
    ['GET', '/api/gateway/v1/media/video-real/requests/receipt/unknown', false, false, 404],
    ['POST', '/api/gateway/v1/media/real/requests', true, false, 404],
    ['GET', '/api/gateway/v1/media/real/profiles', true, false, 404],
    ['POST', '/api/gateway/v1/chat/completions', true, false, 404],
    ['POST', '/api/payment/alipay/notify', true, false, 404],
    ['POST', '/api/client/auth/refresh', true, false, 404],
    ['GET', '/api/client/subscriptions', true, false, 404],
  ])('limits video HTTP surface: %s %s', (method, path, allow, recovery, status) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mediaAcceptanceHttpBoundary(allow as boolean, recovery as boolean, 'video')({ method, path } as any, res as any, next);
    if (status) { expect(res.status).toHaveBeenCalledWith(status); expect(next).not.toHaveBeenCalled(); }
    else expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['POST', '/api/gateway/v1/media/real/requests', false, 403],
    ['POST', '/API/gateway/v1/media/real/requests/', false, 403],
    ['POST', '/api/gateway/v1/media/real/requests', true, null],
    ['GET', '/api/gateway/v1/media/real/profiles', false, null],
    ['POST', '/api/gateway/v1/media/real/quotes', false, null],
    ['POST', '/api/gateway/v1/media/real/references', false, null],
    ['GET', '/api/gateway/v1/media/real/requests/receipt', false, null],
    ['POST', '/api/client/auth/login', true, 404],
    ['POST', '/api/gateway/v1/chat/completions', true, 404],
    ['POST', '/api/payment/alipay/notify', true, 404],
    ['POST', '/api/gateway/v1/media/mock/requests', true, 404],
  ])('limits HTTP surface: %s %s, execution=%s', (method, path, allow, status) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mediaAcceptanceHttpBoundary(allow as boolean)({ method, path } as any, res as any, next);
    if (status) { expect(res.status).toHaveBeenCalledWith(status); expect(next).not.toHaveBeenCalled(); }
    else expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('private credential delivery', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sep-media-delivery-')); await chmod(directory, 0o700); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('creates 0600 credentials exclusively and removes only its own file on close', async () => {
    const path = join(directory, 'token.json');
    const delivery = await openMediaAcceptanceTokenFile(path);
    try {
      await delivery.write({ employmentToken: 'test-only-token' });
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ employmentToken: 'test-only-token' });
      await expect(openMediaAcceptanceTokenFile(path)).rejects.toThrow();
    } finally { await delivery.close(); }
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects shared directories, symlink directories and symlink/existing token files', async () => {
    const path = join(directory, 'token.json');
    await chmod(directory, 0o755);
    await expect(openMediaAcceptanceTokenFile(path)).rejects.toThrow('0700');
    await chmod(directory, 0o700);
    const target = join(directory, 'target');
    await writeFile(target, 'untouched', { mode: 0o600 });
    await symlink(target, path);
    await expect(openMediaAcceptanceTokenFile(path)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('untouched');
    const link = join(directory, 'link');
    await symlink(directory, link);
    await expect(openMediaAcceptanceTokenFile(join(link, 'other.json'))).rejects.toThrow('0700');
  });
});

// Opt-in uses actual modules, sessions, services, PostgreSQL and Redis. No model requests.
const integration = process.env.MEDIA_REAL_ACCEPTANCE_SERVER_INTEGRATION === 'true' ? describe : describe.skip;
integration('real isolated media server (no upstream execution)', () => {
  it('serves video runtime and PNG references with real session guards and private disk cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sep-video-server-'));
    await chmod(directory, 0o700);
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const tokenFile = join(directory, 'token.json');
    const upstream = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No upstream calls permitted'));
    let server: Awaited<ReturnType<typeof startMediaAcceptanceServer>> | undefined;
    try {
      server = await startMediaAcceptanceServer({
        NODE_ENV: 'test', MEDIA_REAL_ACCEPTANCE_SERVER: 'true', MEDIA_REAL_ACCEPTANCE_KIND: 'video',
        MEDIA_REAL_TEST_DATABASE_URL: process.env.MEDIA_REAL_TEST_DATABASE_URL,
        MEDIA_REAL_TEST_REDIS_URL: process.env.MEDIA_REAL_TEST_REDIS_URL,
        MEDIA_BASE_URL: 'https://127.0.0.1:9443/v1', MEDIA_API_KEY: 'integration-placeholder-not-a-real-key',
        MEDIA_REAL_ACCEPTANCE_TOKEN_FILE: tokenFile, MEDIA_REAL_ACCEPTANCE_PORT: String(port),
        MEDIA_REAL_ACCEPTANCE_FIXTURE: `video_spec_${Date.now()}`, MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '1.25',
      });
      const { app, fixture } = server;
      const http = request(app.getHttpServer());
      const credentials = JSON.parse(await readFile(tokenFile, 'utf8'));
      expect(credentials).toMatchObject({ kind: 'video', executionEnabled: false, balanceCny: '1.250000',
        modelId: 'minimax-h3', parameters: { durationSeconds: 4, resolution: '720p', audio: true } });
      expect(credentials).not.toHaveProperty('refreshToken');
      expect(credentials).not.toHaveProperty('MEDIA_API_KEY');
      const runtimePath = new URL(credentials.runtimeUrl).pathname + new URL(credentials.runtimeUrl).search;
      await http.get(runtimePath).expect(401);
      await http.get(runtimePath).auth(credentials.employmentToken, { type: 'bearer' }).expect(401);
      const runtime = await http.get(runtimePath).auth(credentials.accessToken, { type: 'bearer' }).expect(200);
      expect(runtime.body.runtime.video).toMatchObject({ executionAvailable: true, executionMode: 'real',
        profiles: [{ profileId: fixture.profileId, configVersion: fixture.configVersion }] });
      const root = '/api/gateway/v1/media/video-real';
      await http.get(`${root}/profiles`).expect(401);
      await http.get(`${root}/profiles`).auth(credentials.accessToken, { type: 'bearer' }).expect(401);
      const profiles = await http.get(`${root}/profiles`).auth(credentials.employmentToken, { type: 'bearer' }).expect(200);
      expect(profiles.body).toMatchObject({ mock: false, protocolVersion: 1, persistence: 'database',
        profiles: [{ profileId: fixture.profileId, configVersion: fixture.configVersion,
          operations: ['text-to-video', 'image-to-video'], capabilities: { durationsSeconds: [4],
            aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24], supportsAudio: true,
            maxReferenceCount: 1, outputFormats: ['video/mp4'] } }] });
      await http.post(`${root}/requests`).auth(credentials.employmentToken, { type: 'bearer' }).send({}).expect(403);
      await http.post(`${root}/quotes`).auth(credentials.employmentToken, { type: 'bearer' }).send({}).expect(400);
      await http.post('/api/gateway/v1/media/real/requests').send({}).expect(404);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64');
      const upload = await http.post(`${root}/references`).auth(credentials.employmentToken, { type: 'bearer' })
        .attach('file', png, { filename: 'reference.png', contentType: 'image/png' }).expect(201);
      expect(upload.body).toMatchObject({ mock: false, mimeType: 'image/png', byteLength: png.length });
      expect((await lstat(credentials.cacheDirectory)).mode & 0o777).toBe(0o700);
      expect(credentials.cacheDirectory).toBe(join(await realpath(directory), `video-cache-${fixture.profileId.slice('acceptance-'.length)}`));
      const prisma = app.get(PrismaService);
      const profile = await prisma.mediaModelProfile.findUniqueOrThrow({ where: { profileId: fixture.profileId } });
      expect(profile).toMatchObject({ modelId: 'minimax-h3', kind: 'video', operations: ['text-to-video', 'image-to-video'] });
      const config = await prisma.enterpriseModelConfig.findUniqueOrThrow({ where: { enterpriseId: fixture.enterpriseId } });
      expect(config.mediaPolicy).toMatchObject({ video: { maxConcurrentJobs: 1, periodBudget: 1.25 } });
      expect(await prisma.mediaGatewayRequest.count({ where: { enterpriseId: fixture.enterpriseId } })).toBe(0);
      expect(await prisma.mediaRealBillingReservation.count({ where: { enterpriseId: fixture.enterpriseId } })).toBe(0);
      await prisma.employeeGrant.updateMany({ where: { subscriptionId: fixture.subscriptionId }, data: { expiresAt: new Date(0) } });
      await http.get(`${root}/profiles`).auth(credentials.employmentToken, { type: 'bearer' }).expect(403);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await server?.close(); upstream.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('serves real employment authorization, DB metadata, Redis bytes and bounded real billing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sep-media-server-'));
    await chmod(directory, 0o700);
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const tokenFile = join(directory, 'token.json');
    const upstream = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Upstream must never be called by this test'));
    const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let server: Awaited<ReturnType<typeof startMediaAcceptanceServer>> | undefined;
    let redisKey: string | undefined;
    let redis: RedisService | undefined;
    const connections = {
      MEDIA_REAL_TEST_DATABASE_URL: process.env.MEDIA_REAL_TEST_DATABASE_URL,
      MEDIA_REAL_TEST_REDIS_URL: process.env.MEDIA_REAL_TEST_REDIS_URL,
    };
    try {
      server = await startMediaAcceptanceServer({
        NODE_ENV: 'test', MEDIA_REAL_ACCEPTANCE_SERVER: 'true',
        ...connections,
        MEDIA_BASE_URL: 'https://127.0.0.1:9443/v1', MEDIA_API_KEY: 'integration-placeholder-not-a-real-key',
        MEDIA_REAL_ACCEPTANCE_TOKEN_FILE: tokenFile, MEDIA_REAL_ACCEPTANCE_PORT: String(port),
        MEDIA_REAL_ACCEPTANCE_FIXTURE: `spec_${Date.now()}`, MEDIA_REAL_ACCEPTANCE_BALANCE_CNY: '1.250000',
        DATABASE_URL: 'postgresql://production.invalid/sep_platform', SUB2API_API_KEY: 'must-not-inherit',
      });
      const { app, fixture } = server;
      const http = request(app.getHttpServer());
      const credentials = JSON.parse(await readFile(tokenFile, 'utf8'));
      const token = credentials.employmentToken as string;
      expect(credentials).toMatchObject({ localFixtureOnly: true, balanceCny: '1.250000', executionEnabled: false, expiresIn: 900 });
      expect(credentials).not.toHaveProperty('refreshToken');
      expect(credentials).not.toHaveProperty('MEDIA_API_KEY');
      const config = app.get(ConfigService);
      expect(config.get('DATABASE_URL')).toContain('/sep_media_real_');
      expect(config.get('SUB2API_API_KEY') === undefined).toBe(true);
      expect(config.get('MEDIA_API_KEY') === 'integration-placeholder-not-a-real-key').toBe(true);
      process.env.SUB2API_API_KEY = 'attempted-injection-not-a-real-key';
      expect(config.get('SUB2API_API_KEY') === undefined).toBe(true);
      expect(config.get('MAIL_ENABLED')).toBe('false');
      const claims = new JwtService().verify(token, { secret: config.get<string>('ACCESS_JWT_SECRET'), algorithms: ['HS256'] });
      expect(claims).toMatchObject({ type: 'client-employment', sub: fixture.userId, enterpriseId: fixture.enterpriseId, subscriptionId: fixture.subscriptionId });
      const path = '/api/gateway/v1/media/real';
      await http.get(`${path}/profiles`).expect(401);
      const profiles = await http.get(`${path}/profiles`).auth(token, { type: 'bearer' }).expect(200);
      expect(profiles.body).toMatchObject({ mock: false, persistence: 'database', profiles: [{ profileId: fixture.profileId }] });
      await http.post(`${path}/requests`).auth(token, { type: 'bearer' }).send({}).expect(403);
      await http.post('/api/client/auth/login').send({}).expect(404);
      await http.post(`${path}/quotes`).auth(token, { type: 'bearer' }).send({}).expect(400);
      const runtime = await app.get(ClientService).getRuntime(fixture.userId, fixture.subscriptionId, 1);
      expect(runtime.runtime.skills).toHaveLength(1);
      expect(runtime.runtime.media).toMatchObject({ executionAvailable: true, tools: ['image_generate', 'image_edit'] });
      const prisma = app.get(PrismaService);
      expect(await prisma.$queryRaw`SELECT current_database() AS name`).toEqual([
        { name: new URL(process.env.DATABASE_URL!).pathname.slice(1) },
      ]);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64');
      const upload = await http.post(`${path}/references`).auth(token, { type: 'bearer' })
        .attach('file', png, { filename: 'reference.png', contentType: 'image/png' }).expect(201);
      const reference = await prisma.mediaRealReference.findUniqueOrThrow({ where: { id: upload.body.referenceId } });
      const scope = JSON.stringify([fixture.enterpriseId, fixture.userId, fixture.memberId, fixture.subscriptionId]);
      expect(reference.scope).toBe(scope);
      const cache = app.get(MediaByteCacheService);
      expect(await cache.get('reference', scope, upload.body.referenceId, upload.body)).toEqual(png);
      redis = app.get(RedisService);
      const digest = createHash('sha256').update(JSON.stringify([scope, upload.body.referenceId])).digest('hex');
      redisKey = `sep:media:bytes:reference:${digest}`;
      expect(await redis.redis.ttl(redisKey)).toBeGreaterThan(0);
      const billing = app.get(MediaRealBillingService);
      expect(await billing.quoteFunding(claims, '1.250000')).toEqual({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.250000' });
      await expect(billing.quoteFunding(claims, '1.250001')).rejects.toMatchObject({ status: 402 });
      expect((await prisma.personalWallet.findUniqueOrThrow({ where: { userId: fixture.userId } })).balance.toFixed(6)).toBe('1.250000');
      expect(await prisma.mediaRealRequest.count({ where: { enterpriseId: fixture.enterpriseId } })).toBe(0);
      expect(await prisma.mediaRealBillingReservation.count({ where: { enterpriseId: fixture.enterpriseId } })).toBe(0);
      expect(await prisma.subscriptionCredit.count({ where: { enterpriseId: fixture.enterpriseId } })).toBe(0);
      expect(await prisma.enterpriseWallet.count({ where: { enterpriseId: fixture.enterpriseId } })).toBe(0);
      expect(await prisma.systemSetting.count({ where: { key: 'MEDIA_API_KEY' } })).toBe(0);
      const recovered = await recoverMediaAcceptanceFixture(prisma, mediaAcceptanceSettings({
        NODE_ENV: 'test', MEDIA_REAL_ACCEPTANCE_SERVER: 'true',
        ...connections,
        MEDIA_BASE_URL: 'https://127.0.0.1:9443/v1', MEDIA_API_KEY: 'integration-placeholder-not-a-real-key',
        MEDIA_REAL_ACCEPTANCE_TOKEN_FILE: join(directory, 'unused.json'),
        MEDIA_REAL_ACCEPTANCE_FIXTURE: fixture.profileId.slice('acceptance-'.length),
        MEDIA_REAL_ACCEPTANCE_RECOVER_FIXTURE: 'true',
      }));
      expect(recovered).toEqual(fixture);
      expect((await prisma.personalWallet.findUniqueOrThrow({ where: { userId: fixture.userId } })).balance.toFixed(6)).toBe('1.250000');
      await prisma.employeeGrant.updateMany({ where: { subscriptionId: fixture.subscriptionId }, data: { expiresAt: new Date(0) } });
      await http.get(`${path}/profiles`).auth(token, { type: 'bearer' }).expect(403);
      await prisma.authSession.update({ where: { id: claims.sid }, data: { revokedAt: new Date() } });
      await http.get(`${path}/profiles`).auth(token, { type: 'bearer' }).expect(401);
      expect(upstream).not.toHaveBeenCalled();
      expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
      expect(JSON.stringify(logs.mock.calls)).not.toContain('integration-placeholder-not-a-real-key');
    } finally {
      if (redisKey && redis) await redis.redis.del(redisKey);
      await server?.close();
      upstream.mockRestore(); logs.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
