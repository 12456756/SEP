import { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import AdmZip from 'adm-zip';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { createJsonBodyMiddleware } from '../../common/middleware/json-body.middleware';
import { createSkillImportEventByteConsumer } from '../../common/middleware/skill-import-ingress.middleware';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { SkillImportArtifactSchema, SkillImportCandidatesResponseSchema, SkillImportDevicesResponseSchema, SkillImportFilesResponseSchema, SkillImportOperationResponseSchema, SkillImportPreviewResponseSchema } from 'shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SessionService } from '../auth/session.service';
import { AuditService } from '../audit/audit.service';
import { CsrfGuard } from '../security/guards/csrf.guard';
import { CapabilityValidatorService } from '../capability-contribution/capability-validator.service';
import { PackageSecurityService } from '../capability-contribution/package-security.service';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { SkillImportConnectorController } from './skill-import-connector.controller';
import { SkillImportController } from './skill-import.controller';
import { ImportChallenge, ImportSession } from './skill-import-state';
import { SkillImportStore } from './skill-import-store';
import { SkillImportUploadGuard } from './skill-import-upload.guard';
import { SkillImportUploadInterceptor } from './skill-import-upload.interceptor';
import { SkillImportService } from './skill-import.service';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const markdown = '---\nname: demo\ndescription: Import fixture\n---\n# Role\nResearch helper\n# Input\nTopic\n# Steps\n1. Research\n# Output\nReport';
const readme = 'reference';
const treeHash = 'a'.repeat(64);
const integration = process.env.SKILL_IMPORT_TEST_REDIS_URL ? describe : describe.skip;

// Opt in with SKILL_IMPORT_TEST_REDIS_URL=redis://127.0.0.1:6379/15. Only this suite's random prefix is removed.
integration('Skill import HTTP protocol with real Redis and ZIP pipeline', () => {
  let app: INestApplication;
  let redis: Redis;
  let root: string;
  let service: SkillImportService;
  let store: SkillImportStore;
  let packages: SkillPackageService;
  let enabled = true;
  let minimumVersion = '1.0.0';
  let role: UserRole = UserRole.ADMIN;
  let accountStatus: UserStatus = UserStatus.ACTIVE;
  let webActive = true;
  const instanceId = `http-${randomBytes(12).toString('hex')}`;
  const devices = new Map<string, Record<string, unknown>>();
  const audit = { record: jest.fn().mockResolvedValue({ id: 'audit' }) };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ name: 'Platform Admin', role, status: accountStatus })) },
    skillImportDevice: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => [...devices.values()].find((row) => matches(row, where)) ?? null),
      findMany: jest.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
        const { OR, ...conditions } = where;
        return [...devices.values()].filter((row) => matches(row, conditions) && (!OR || (OR as Array<Record<string, unknown>>).some((branch) => Object.entries(branch).every(([key, value]) => {
          if (value instanceof Date) return (row[key] as Date).getTime() === value.getTime();
          if (value && typeof value === 'object' && 'lt' in value) return row[key] < value.lt;
          return row[key] === value;
        })))).sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime() || String(b.id).localeCompare(String(a.id))).slice(0, take);
      }),
      upsert: jest.fn(async ({ where, create }: { where: { instanceId_userId_keyFingerprint: Record<string, unknown> }; create: Record<string, unknown> }) => {
        const previous = [...devices.values()].find((row) => matches(row, where.instanceId_userId_keyFingerprint));
        if (previous) return previous;
        const device = { ...create, id: `device-${randomBytes(8).toString('hex')}`, revokedAt: null, createdAt: new Date(), updatedAt: new Date() };
        devices.set(device.id, device); return device;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of devices.values()) if (matches(row, where)) { Object.assign(row, data); count += 1; }
        return { count };
      }),
    },
    packageSecurityScan: { upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => create) },
  };

  beforeAll(async () => {
    redis = new Redis(process.env.SKILL_IMPORT_TEST_REDIS_URL!, { enableOfflineQueue: false, commandTimeout: 1000, maxRetriesPerRequest: 0 });
    await new Promise<void>((resolve, reject) => { redis.once('ready', () => resolve()); redis.once('error', reject); });
    root = await mkdtemp(join(tmpdir(), 'sep-import-http-'));
    const config = { get: (key: string) => ({ SKILL_IMPORT_ENABLED: enabled, SKILL_IMPORT_INSTANCE_ID: instanceId, SKILL_IMPORT_MIN_CLIENT_VERSION: minimumVersion, SKILL_IMPORT_UPLOAD_CONCURRENCY: 1, SKILL_PACKAGE_DIR: join(root, 'packages') }[key]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [SkillImportController, SkillImportConnectorController],
      providers: [SkillImportService, SkillImportStore, SkillImportUploadGuard, SkillImportUploadInterceptor, SkillPackageService, PackageSecurityService, CapabilityValidatorService,
        { provide: ConfigService, useValue: config }, { provide: RedisService, useValue: { redis } }, { provide: PrismaService, useValue: prisma }, { provide: AuditService, useValue: audit },
        { provide: SessionService, useValue: { assertActiveSession: jest.fn(async () => { if (!webActive) throw new (await import('@nestjs/common')).UnauthorizedException('logged out'); }) } },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'admin', role: 'ADMIN', sid: req.headers['x-web-sid'] === 'missing' ? undefined : req.headers['x-web-sid'] || 'web-session' }; return true;
    } }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false }); app.setGlobalPrefix('api'); app.use(createJsonBodyMiddleware({}, createSkillImportEventByteConsumer(() => redis, { instanceId }))); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    service = app.get(SkillImportService); store = app.get(SkillImportStore); packages = app.get(SkillPackageService);
  });

  const cleanup = async () => { const keys = await redis.keys(`skill-import:v1:${instanceId}:*`); if (keys.length) await redis.del(...keys); };
  beforeEach(async () => { enabled = true; minimumVersion = '1.0.0'; role = UserRole.ADMIN; accountStatus = UserStatus.ACTIVE; webActive = true; devices.clear(); audit.record.mockClear(); await cleanup(); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await app?.close(); if (redis) { await cleanup(); await redis.quit(); } if (root) await rm(root, { recursive: true, force: true }); });

  function proof(challenge: ImportChallenge, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], rememberDevice = false, rootIds = ['root']) {
    const consentHash = hash(JSON.stringify([rememberDevice, 'user', [...new Set(rootIds)].sort()]));
    const message = JSON.stringify(['SEP-SKILL-IMPORT', 1, challenge.purpose, challenge.instanceId, challenge.sessionId ?? null, challenge.pairingId ?? null, challenge.deviceId ?? null, challenge.keyFingerprint, challenge.challengeId, challenge.nonce, challenge.expiresAt, consentHash]);
    return { challengeId: challenge.challengeId, signature: sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'), rememberDevice, scope: 'user', rootIds };
  }

  it('allows native pairing through production CSRF and still requires a valid grant for commands', async () => {
    const original = { NODE_ENV: process.env.NODE_ENV, CORS_ORIGIN: process.env.CORS_ORIGIN };
    let nativeApp: INestApplication;
    try {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGIN = 'https://sep.example';
      const csrf = new CsrfGuard(new Reflector());
      const module = await Test.createTestingModule({
        controllers: [SkillImportConnectorController],
        providers: [
          { provide: SkillImportService, useValue: service },
          { provide: SkillImportUploadGuard, useValue: app.get(SkillImportUploadGuard) },
          { provide: SkillImportUploadInterceptor, useValue: app.get(SkillImportUploadInterceptor) },
        ],
      }).compile();
      nativeApp = module.createNestApplication();
      nativeApp.setGlobalPrefix('api');
      nativeApp.useGlobalGuards(csrf);
      await nativeApp.init();
      const session = await request(app.getHttpServer()).post('/api/skill-import/sessions')
        .send({ requestId: 'native-csrf', protocolVersion: 1, scope: 'user' }).expect(201);
      const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
      const body = { requestId: 'native-pairing', sessionId: session.body.id, publicKey: publicKey.toString('base64url'),
        keyFingerprint: hash(publicKey), protocolVersion: 1, clientVersion: '1.0.0', platform: 'darwin' };
      const pairing = await request(nativeApp.getHttpServer()).post('/api/skill-import/connector/pairings').send(body).expect(200);
      expect(pairing.body.challenge.instanceId).toBe(instanceId);
      await request(nativeApp.getHttpServer()).post('/api/skill-import/connector/pairings')
        .set('Origin', 'https://evil.example').send(body).expect(403);
      await request(nativeApp.getHttpServer()).get(`/api/skill-import/connector/sessions/${session.body.id}/commands?cursor=0`).expect(401);
    } finally {
      await nativeApp?.close();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  async function paired(rememberDevice = false) {
    const created = await request(app.getHttpServer()).post('/api/skill-import/sessions').send({ requestId: randomBytes(8).toString('hex'), protocolVersion: 1, scope: 'user' }).expect(201);
    const id: string = created.body.id; const keys = generateKeyPairSync('ed25519'); const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const pairing = await request(app.getHttpServer()).post('/api/skill-import/connector/pairings').send({ requestId: 'client-independent-request', sessionId: id, publicKey: publicKey.toString('base64url'), keyFingerprint: hash(publicKey), protocolVersion: 1, clientVersion: '1.0.0', platform: 'macos' }).expect(200);
    const consent = proof(pairing.body.challenge, keys.privateKey, rememberDevice);
    await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(consent).expect(202);
    await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send({ ...consent, signature: randomBytes(64).toString('base64url') }).expect(401);
    await request(app.getHttpServer()).post(`/api/skill-import/sessions/${id}/confirm-device`).send({ pairingId: pairing.body.pairingId, keyFingerprint: hash(publicKey), shortCode: pairing.body.shortCode }).expect(200);
    const grant = await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(consent).expect(200);
    const commands = await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands`).auth(grant.body.sessionGrant, { type: 'bearer' }).expect(200);
    return { id, pairing: pairing.body, keys, consent, grant: grant.body, scan: commands.body.items[0] };
  }

  async function prepared(rememberDevice = false, performSelection = true) {
    const context = await paired(rememberDevice); const { id, grant, scan } = context;
    let sequence = 0;
    const event = (type: string, commandId: string, payload: unknown) => request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/events`).auth(grant.sessionGrant, { type: 'bearer' }).send({ eventId: `event-${++sequence}`, commandId, sequence, type, payload }).expect((response) => { if (response.status === 401) throw new Error(JSON.stringify(response.body)); });
    await event('command-started', scan.commandId, { type: 'scan' }).expect(200);
    const candidate = { candidateId: 'candidate', revision: 1, name: 'Demo', description: null, sources: ['codex'], scope: 'user', locations: [{ rootId: 'root', rootLabel: 'User skills', relativePath: 'demo' }], treeHash, availability: 'previewable', warnings: [] };
    await event('candidates', scan.commandId, { items: [candidate], final: false }).expect(200);
    await event('candidates', scan.commandId, { items: [{ ...candidate, candidateId: 'candidate-2' }], final: true }).expect(200);
    const candidates = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=candidates`).expect(200);
    expect(SkillImportCandidatesResponseSchema.parse(candidates.body).items).toHaveLength(2);
    const previewRequest = await request(app.getHttpServer()).post(`/api/skill-import/sessions/${id}/preview`).send({ requestId: 'preview', candidateId: 'candidate', revision: 1 }).expect(202);
    const preview = { requestId: 'preview', candidateId: 'candidate', snapshotId: 'snapshot', expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), content: '# Client preview', treeHash, fileCount: 2, totalUncompressedBytes: Buffer.byteLength(markdown) + Buffer.byteLength(readme), estimatedPackageBytes: 1000, files: [{ relativePath: 'SKILL.md', bytes: Buffer.byteLength(markdown) }], nextFilesCursor: 'page-2', warnings: [] };
    await event('preview', previewRequest.body.commandId, preview).expect(200);
    await request(app.getHttpServer()).post(`/api/skill-import/sessions/${id}/selection`).send({ candidateId: 'candidate', snapshotId: 'snapshot', operationId: 'operation' }).expect(409);
    await event('files', previewRequest.body.commandId, { requestId: 'preview', candidateId: 'candidate', snapshotId: 'snapshot', cursor: 'page-2', files: [{ relativePath: 'reference.md', bytes: Buffer.byteLength(readme) }], nextFilesCursor: null }).expect(200);
    const previewResponse = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=preview&requestId=preview&candidateId=candidate`).expect(200);
    expect(SkillImportPreviewResponseSchema.parse(previewResponse.body).previewStatus).toBe('ready');
    const files = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=files&snapshotId=snapshot&limit=1`).expect(200);
    const first = SkillImportFilesResponseSchema.parse(files.body); expect(first.files).toHaveLength(1); expect(first.nextFilesCursor).not.toBeNull();
    const secondFiles = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=files&snapshotId=snapshot&cursor=${first.nextFilesCursor}`).expect(200);
    expect(secondFiles.body.files[0].relativePath).toBe('reference.md');
    const zip = new AdmZip(); zip.addFile('SKILL.md', Buffer.from(markdown)); zip.addFile('reference.md', Buffer.from(readme)); const bytes = zip.toBuffer();
    const packageInput = { candidateId: 'candidate', snapshotId: 'snapshot', packageSha256: hash(bytes), packageBytes: bytes.length };
    if (!performSelection) return { ...context, bytes, packageInput, uploadGrant: '', event, previewRequest };
    await request(app.getHttpServer()).post(`/api/skill-import/sessions/${id}/selection`).send({ candidateId: 'candidate', snapshotId: 'snapshot', operationId: 'operation' }).expect(202);
    const commands = await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands`).auth(grant.sessionGrant, { type: 'bearer' }).expect(200);
    const packageCommand = commands.body.items.find((item: { type: string }) => item.type === 'package-selected');
    expect(packageCommand.payload).not.toHaveProperty('uploadGrant');
    await event('command-completed', packageCommand.commandId, { type: 'package-selected' }).expect(200);
    const uploadGrant = await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/operations/operation/upload-grant`).auth(grant.sessionGrant, { type: 'bearer' }).send(packageInput).expect(200);
    return { ...context, bytes, packageInput, uploadGrant: uploadGrant.body.uploadGrant as string, event, previewRequest };
  }

  it('completes double confirmation, candidate batches, full preview, selection and authoritative ZIP import', async () => {
    const context = await prepared(true); const { id, grant, uploadGrant, bytes } = context;
    const response = await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/package`).auth(uploadGrant, { type: 'bearer' }).attach('file', bytes, 'demo.zip');
    expect(response.body).toEqual(expect.not.objectContaining({ statusCode: 400 }));
    expect(response.status).toBe(200);
    const artifact = SkillImportArtifactSchema.parse(response.body);
    expect(artifact.content).toContain('Research helper'); expect(artifact.content).not.toContain('Client preview'); expect(artifact.sha256).toBe(hash(bytes)); expect(artifact.totalSize).toBe(bytes.length);
    expect(artifact.warnings.some((warning) => warning.code === 'STATIC_ONLY_SCAN')).toBe(true);
    const operation = await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/operations/operation`).auth(grant.sessionGrant, { type: 'bearer' }).expect(200);
    expect(operation.body).toMatchObject({ status: 'succeeded', retryable: false }); expect(operation.body).not.toHaveProperty('artifact');
    const web = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=operation&operationId=operation`).expect(200);
    expect(SkillImportOperationResponseSchema.parse(web.body).artifact.sha256).toBe(artifact.sha256);
    const stored = await redis.get(`skill-import:v1:${instanceId}:session:${id}`); expect(stored).not.toContain(grant.sessionGrant); expect(stored).not.toContain(uploadGrant);
    expect((await request(app.getHttpServer()).get('/api/skill-import/devices').expect(200)).body.items).toHaveLength(1);
    const replay = await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/package`).auth(uploadGrant, { type: 'bearer' }).expect(200); expect(replay.body.sha256).toBe(artifact.sha256);
    const challenge = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ purpose: 'session-grant', sessionId: id, pairingId: context.pairing.pairingId }).expect(200);
    const renewed = await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(proof(challenge.body, context.keys.privateKey, true)).expect(200);
    expect((await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/operations/operation`).auth(renewed.body.sessionGrant, { type: 'bearer' }).expect(200)).body.status).toBe('succeeded');
    const renewedState = await store.read<ImportSession>(`session:${id}`); expect(renewedState.commands.filter((command) => command.type === 'scan')).toHaveLength(1);
    await request(app.getHttpServer()).delete(`/api/skill-import/sessions/${id}`).expect(200);
    expect((await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=operation`).expect(200)).body.artifact.sha256).toBe(artifact.sha256);
  });

  it('requires matching Web sid and current owner ADMIN for every connector call', async () => {
    await request(app.getHttpServer()).post('/api/skill-import/sessions').set('x-web-sid', 'missing').send({ requestId: 'missing', protocolVersion: 1 }).expect(403);
    const { id, grant } = await paired();
    await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}`).set('x-web-sid', 'another-session').expect(403);
    role = UserRole.USER;
    await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands`).auth(grant.sessionGrant, { type: 'bearer' }).expect(403);
    role = UserRole.ADMIN; webActive = false;
    await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands`).auth(grant.sessionGrant, { type: 'bearer' }).expect(401);
  });

  it('paginates beyond 100 devices with stable boundaries and rejects cross-owner cursors', async () => {
    const timestamp = new Date('2026-11-01T00:00:00.000Z');
    const insert = (id: string, overrides: Record<string, unknown> = {}) => devices.set(id, { id, userId: 'admin', instanceId, revokedAt: null, keyFingerprint: treeHash, label: id, platform: 'macos', clientVersion: '1.0.0', lastSeenAt: null, createdAt: timestamp, ...overrides });
    for (let index = 0; index < 105; index += 1) insert(`device-${String(index).padStart(3, '0')}`);
    insert('foreign-owner', { userId: 'other-admin' }); insert('foreign-instance', { instanceId: 'other-instance' });
    const first = SkillImportDevicesResponseSchema.parse((await request(app.getHttpServer()).get('/api/skill-import/devices').expect(200)).body);
    expect(first.items).toHaveLength(25); expect(first.items[0].deviceId).toBe('device-104'); expect(first.nextCursor).toBe('device-080');
    await request(app.getHttpServer()).delete(`/api/skill-import/devices/${first.nextCursor}`).expect(200);
    insert('newer-device', { createdAt: new Date(timestamp.getTime() + 1000) });
    const second = SkillImportDevicesResponseSchema.parse((await request(app.getHttpServer()).get(`/api/skill-import/devices?cursor=${first.nextCursor}&limit=100`).expect(200)).body);
    expect(second.items).toHaveLength(80); expect(second.items[0].deviceId).toBe('device-079'); expect(second.items[79].deviceId).toBe('device-000'); expect(second.nextCursor).toBeNull();
    expect(second.items.some((device) => first.items.some((previous) => previous.deviceId === device.deviceId))).toBe(false);
    await request(app.getHttpServer()).delete('/api/skill-import/devices/device-000').expect(200);
    expect(devices.get('device-000').revokedAt).toBeInstanceOf(Date);
    for (const cursor of ['missing', 'foreign-owner', 'foreign-instance']) {
      const invalid = await request(app.getHttpServer()).get(`/api/skill-import/devices?cursor=${cursor}`).expect(400);
      expect(invalid.body.code).toBe('CURSOR_INVALID'); expect(invalid.body.message).toBe('设备分页游标无效'); expect(invalid.body).not.toHaveProperty('items');
    }
    await request(app.getHttpServer()).get('/api/skill-import/devices?limit=101').expect(400);
    await request(app.getHttpServer()).get('/api/skill-import/devices?unexpected=true').expect(400);
  });

  it('documents bearer authentication only for the six protected connector methods', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth({ type: 'http', scheme: 'bearer' }, 'skill-import-grant').build());
    for (const action of ['pairings', 'challenges', 'grants', 'devices/{deviceId}/revoke']) expect(document.paths[`/api/skill-import/connector/${action}`].post.security).toBeUndefined();
    for (const [path, method] of [['sessions/{id}/commands', 'get'], ['sessions/{id}/events', 'post'], ['sessions/{id}/operations/{operationId}', 'get'], ['sessions/{id}/operations/{operationId}/upload-grant', 'post'], ['sessions/{id}/package', 'post'], ['sessions/{id}', 'delete']] as const) expect(document.paths[`/api/skill-import/connector/${path}`][method].security).toEqual([{ 'skill-import-grant': [] }]);
  });

  it('never re-enqueues scan on challenge renewal and rejects consumed signature replay', async () => {
    const { id, pairing, keys, consent, grant } = await paired();
    expect((await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(consent).expect(409)).body.code).toBe('CHALLENGE_USED');
    const challenge = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ purpose: 'session-grant', sessionId: id, pairingId: pairing.pairingId }).expect(200);
    const renewed = await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(proof(challenge.body, keys.privateKey)).expect(200);
    const commands = await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands`).auth(renewed.body.sessionGrant, { type: 'bearer' }).expect(200);
    expect(commands.body.items.filter((command: { type: string }) => command.type === 'scan')).toHaveLength(1);
    expect(renewed.body.sessionGrant).not.toBe(grant.sessionGrant);
  });

  it('reuses a remembered device only for previously confirmed roots and invalidates it on revoke', async () => {
    const context = await paired(true);
    const created = await request(app.getHttpServer()).post('/api/skill-import/sessions').send({ requestId: 'remembered-session', protocolVersion: 1, scope: 'user' }).expect(201);
    const challenge = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ purpose: 'session-grant', sessionId: created.body.id, deviceId: context.grant.deviceId }).expect(200);
    const granted = await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(proof(challenge.body, context.keys.privateKey, true)).expect(200);
    expect(granted.body.status).toBe('granted');
    const expanded = await request(app.getHttpServer()).post('/api/skill-import/sessions').send({ requestId: 'expanded-session', protocolVersion: 1, scope: 'user' }).expect(201);
    const expandedChallenge = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ purpose: 'session-grant', sessionId: expanded.body.id, deviceId: context.grant.deviceId }).expect(200);
    const expandedConsent = proof(expandedChallenge.body, context.keys.privateKey, true, ['root', 'new-root']);
    const waiting = await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(expandedConsent).expect(202);
    const status = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${expanded.body.id}`).expect(200);
    const claimant = status.body.pairings.find((pairing: { pairingId: string }) => pairing.pairingId === waiting.body.pairingId);
    await request(app.getHttpServer()).post(`/api/skill-import/sessions/${expanded.body.id}/confirm-device`).send({ pairingId: claimant.pairingId, keyFingerprint: claimant.keyFingerprint, shortCode: claimant.shortCode }).expect(200);
    await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(expandedConsent).expect(200);
    await request(app.getHttpServer()).delete(`/api/skill-import/devices/${context.grant.deviceId}`).expect(200);
    expect((await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${created.body.id}/commands`).auth(granted.body.sessionGrant, { type: 'bearer' }).expect(403)).body.code).toBe('DEVICE_REVOKED');
  });

  it('ignores late old previews without losing the event ack sequence', async () => {
    const { id, event, previewRequest } = await prepared(false, false);
    const later = await request(app.getHttpServer()).post(`/api/skill-import/sessions/${id}/preview`).send({ requestId: 'later', candidateId: 'candidate-2', revision: 1 }).expect(202);
    const ack = await event('preview', previewRequest.body.commandId, { requestId: 'preview', candidateId: 'candidate', snapshotId: 'snapshot', expiresAt: new Date(Date.now() + MINUTE).toISOString(), content: '# Old', treeHash, fileCount: 1, totalUncompressedBytes: 1, estimatedPackageBytes: 1, files: [{ relativePath: 'SKILL.md', bytes: 1 }], nextFilesCursor: null, warnings: [] }).expect(200);
    expect(ack.body.ignored).toBe(true);
    await event('preview', later.body.commandId, { requestId: 'later', candidateId: 'candidate-2', snapshotId: 'new-snapshot', expiresAt: new Date(Date.now() + MINUTE).toISOString(), content: '# New', treeHash, fileCount: 1, totalUncompressedBytes: 1, estimatedPackageBytes: 1, files: [{ relativePath: 'SKILL.md', bytes: 1 }], nextFilesCursor: null, warnings: [] }).expect(200);
    const response = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=preview&requestId=later&candidateId=candidate-2`).expect(200);
    expect(response.body.preview.content).toBe('# New');
    expect(response.body.preview.snapshotId).toBe('new-snapshot');
  });

  it('retires superseded previews so the current command is delivered after more than 20 selections', async () => {
    const { id, event, scan, grant } = await prepared(false, false);
    await event('command-completed', scan.commandId, { type: 'scan' }).expect(200);
    let latestCommand = '';
    for (let index = 0; index < 22; index += 1) {
      if (index === 18) await redis.del(`skill-import:v1:${instanceId}:rate:preview:${id}`);
      const response = await request(app.getHttpServer()).post(`/api/skill-import/sessions/${id}/preview`).send({ requestId: `rapid-${index}`, candidateId: 'candidate', revision: 1 }).expect(202);
      latestCommand = response.body.commandId;
    }
    const state = await store.read<ImportSession>(`session:${id}`);
    const commands = await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands?cursor=${state.commandSequence}`).auth(grant.sessionGrant, { type: 'bearer' }).expect(200);
    expect(commands.body.items.map((command: { commandId: string }) => command.commandId)).toEqual([latestCommand]);
  });

  it('retires timed-out preview commands while acknowledging their late completion', async () => {
    const { id, event, grant, previewRequest } = await prepared(false, false);
    const state = await store.read<ImportSession>(`session:${id}`);
    state.preview.status = 'pending'; state.preview.deadline = Date.now() - 1;
    await store.put(`session:${id}`, state);
    const commands = await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands`).auth(grant.sessionGrant, { type: 'bearer' }).expect(200);
    expect(commands.body.items.some((command: { commandId: string }) => command.commandId === previewRequest.body.commandId)).toBe(false);
    expect((await event('command-completed', previewRequest.body.commandId, { type: 'preview' }).expect(200)).body.ignored).toBe(true);
  });

  it('enforces the current minimum version on remembered-device grants and accepts an upgraded client', async () => {
    const context = await paired(true);
    minimumVersion = '1.1.0';
    const target = { purpose: 'session-grant', sessionId: context.id, pairingId: context.pairing.pairingId };
    expect((await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send(target).expect(400)).body.code).toBe('CLIENT_UPGRADE_REQUIRED');
    const created = await request(app.getHttpServer()).post('/api/skill-import/sessions').send({ requestId: 'upgraded-device', protocolVersion: 1 }).expect(201);
    const remembered = { purpose: 'session-grant', sessionId: created.body.id, deviceId: context.grant.deviceId };
    expect((await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send(remembered).expect(400)).body.code).toBe('CLIENT_UPGRADE_REQUIRED');
    const challenge = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ ...remembered, clientVersion: '1.1.0' }).expect(200);
    await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(proof(challenge.body, context.keys.privateKey, true)).expect(200);
    expect(devices.get(context.grant.deviceId).clientVersion).toBe('1.1.0');
    const renewal = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ ...remembered, clientVersion: '1.1.0' }).expect(200);
    minimumVersion = '1.2.0';
    expect((await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(proof(renewal.body, context.keys.privateKey, true)).expect(400)).body.code).toBe('CLIENT_UPGRADE_REQUIRED');
  });

  it.each(['malformed-json', 'invalid-dto', 'invalid-sequence'])('charges the raw bytes of %s independently of failed event state updates', async (failure) => {
    const { id, grant, scan } = await paired();
    const body = failure === 'malformed-json' ? '{' : failure === 'invalid-dto' ? ' {}\n' : ` ${JSON.stringify({ eventId: 'bad-sequence', commandId: scan.commandId, sequence: 99, type: 'progress', payload: { phase: 'scanning', completed: 1 } })}\n`;
    const key = `skill-import:v1:${instanceId}:event-bytes:${id}`;
    const limit = 128 * 1024 * 1024;
    await redis.set(key, limit - Buffer.byteLength(body), 'PX', 35 * MINUTE);
    await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/events`).auth(grant.sessionGrant, { type: 'bearer' }).set('Content-Type', 'application/json').send(body).expect(failure === 'invalid-sequence' ? 409 : 400);
    expect(await redis.get(key)).toBe(String(limit));
    const retry = await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/events`).auth(grant.sessionGrant, { type: 'bearer' }).set('Content-Type', 'application/json').send(body).expect(400);
    expect(retry.body.code).toBe('EVENT_BUDGET_EXCEEDED');
    expect((await store.read<ImportSession>(`session:${id}`)).eventBytes).toBe(0);
  });

  it('renews with the current pairing version when a temporary grant leaves the older device record unchanged', async () => {
    const context = await paired(true);
    minimumVersion = '1.1.0';
    const created = await request(app.getHttpServer()).post('/api/skill-import/sessions').send({ requestId: 'temporary-upgrade', protocolVersion: 1 }).expect(201);
    const target = { purpose: 'session-grant', sessionId: created.body.id, deviceId: context.grant.deviceId };
    const challenge = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ ...target, clientVersion: '1.1.0' }).expect(200);
    await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(proof(challenge.body, context.keys.privateKey, false)).expect(200);
    expect(devices.get(context.grant.deviceId).clientVersion).toBe('1.0.0');
    const renewal = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send(target).expect(200);
    await request(app.getHttpServer()).post('/api/skill-import/connector/grants').send(proof(renewal.body, context.keys.privateKey, false)).expect(200);
  });

  it('delivers all 10000 file entries without consuming the Web status polling budget', async () => {
    const { id } = await prepared(false, false);
    const state = await store.read<ImportSession>(`session:${id}`);
    state.preview.files = Array.from({ length: 10000 }, (_value, index) => ({ relativePath: `${index}.md`, bytes: 1 }));
    state.preview.result.fileCount = 10000; state.preview.result.totalUncompressedBytes = 10000;
    await store.put(`session:${id}`, state);
    await redis.set(`skill-import:v1:${instanceId}:rate:status:${id}:admin`, 60, 'PX', MINUTE);
    const preview = await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=preview`).expect(200);
    let cursor: string | null = preview.body.preview.nextFilesCursor;
    const paths = preview.body.preview.files.map((file: { relativePath: string }) => file.relativePath);
    let pages = 1;
    while (cursor) {
      const page = SkillImportFilesResponseSchema.parse((await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=files&snapshotId=snapshot&cursor=${cursor}`).expect(200)).body);
      paths.push(...page.files.map((file) => file.relativePath)); cursor = page.nextFilesCursor; pages += 1;
    }
    expect(pages).toBe(100); expect(new Set(paths).size).toBe(10000);
    expect(await redis.get(`skill-import:v1:${instanceId}:rate:status:${id}:admin`)).toBe('60');
  });

  it('ignores new event IDs for a completed command without regressing a later phase', async () => {
    const { id, event, scan } = await prepared();
    await event('command-completed', scan.commandId, { type: 'scan' }).expect(200);
    const late = await event('error', scan.commandId, { code: 'SCAN_FAILED', message: 'late retry', retryable: false }).expect(200);
    expect(late.body.ignored).toBe(true);
    expect((await store.read<ImportSession>(`session:${id}`)).status).toBe('uploading');
  });

  it('locks package bytes and rejects unauthorized multipart before package processing', async () => {
    const { id, grant, bytes, packageInput } = await prepared();
    const processing = jest.spyOn(packages, 'store');
    await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/package`).auth(randomBytes(32).toString('base64url'), { type: 'bearer' }).attach('file', bytes, 'demo.zip').expect(401);
    expect(processing).not.toHaveBeenCalled();
    const response = await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/operations/operation/upload-grant`).auth(grant.sessionGrant, { type: 'bearer' }).send({ ...packageInput, packageSha256: 'b'.repeat(64) }).expect(409);
    expect(response.body.code).toBe('PACKAGE_CHANGED');
  });

  it('releases the processing lease and global slot after multipart parsing rejects a field', async () => {
    const { id, uploadGrant, bytes } = await prepared();
    await request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/package`).auth(uploadGrant, { type: 'bearer' }).field('unexpected', 'field').attach('file', bytes, 'demo.zip').expect(400);
    expect(await redis.zcard(`skill-import:v1:${instanceId}:uploads`)).toBe(0);
    const state = await store.read<ImportSession>(`session:${id}`); expect(state.operation.status).toBe('failed'); expect(state.operation.retryable).toBe(true);
  });

  it('releases admission and partial buffers when the client aborts a multipart stream', async () => {
    const { id, uploadGrant, bytes } = await prepared();
    const address = app.getHttpServer().address() as AddressInfo;
    const client = httpRequest({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: `/api/skill-import/connector/sessions/${id}/package`, headers: { Authorization: `Bearer ${uploadGrant}`, 'Content-Type': 'multipart/form-data; boundary=import-test-boundary', 'Content-Length': 100000 } });
    client.on('error', () => undefined);
    client.write(Buffer.concat([Buffer.from('--import-test-boundary\r\nContent-Disposition: form-data; name="file"; filename="demo.zip"\r\nContent-Type: application/zip\r\n\r\n'), bytes.subarray(0, 8)]));
    let admitted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await store.read<ImportSession>(`session:${id}`)).operation.status === 'processing') { admitted = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(admitted).toBe(true); client.destroy();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await redis.zcard(`skill-import:v1:${instanceId}:uploads`) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await redis.zcard(`skill-import:v1:${instanceId}:uploads`)).toBe(0);
    const state = await store.read<ImportSession>(`session:${id}`); expect(state.operation.status).toBe('failed'); expect(state.operation.retryable).toBe(true);
  });

  it.each(['cancel', 'role-revoke', 'device-revoke'])('does not publish an artifact if %s occurs while ZIP I/O is in flight', async (trigger) => {
    const { id, uploadGrant, bytes, grant } = await prepared(true);
    const original = packages.store.bind(packages); let started!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; }); const blocked = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(packages, 'store').mockImplementation(async (file) => { started(); await blocked; return original(file); });
    const pending = request(app.getHttpServer()).post(`/api/skill-import/connector/sessions/${id}/package`).auth(uploadGrant, { type: 'bearer' }).attach('file', bytes, 'demo.zip').then((response) => response);
    await entered;
    if (trigger === 'cancel') await request(app.getHttpServer()).delete(`/api/skill-import/sessions/${id}`).expect(200);
    else if (trigger === 'role-revoke') role = UserRole.USER;
    else await request(app.getHttpServer()).delete(`/api/skill-import/devices/${grant.deviceId}`).expect(200);
    release();
    expect((await pending).status).toBe(trigger === 'cancel' ? 410 : 403);
    role = UserRole.ADMIN;
    expect((await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}?view=operation`).expect(200)).body.artifact).toBeNull();
    expect(await redis.zcard(`skill-import:v1:${instanceId}:uploads`)).toBe(0);
  });

  it('permits cancellation and signed device revoke after disabling new imports', async () => {
    const { id, grant, keys } = await paired(true);
    const challenge = await request(app.getHttpServer()).post('/api/skill-import/connector/challenges').send({ purpose: 'device-revoke', deviceId: grant.deviceId }).expect(200);
    const c = challenge.body; const consentHash = hash(JSON.stringify([false, 'revoke', []]));
    const message = JSON.stringify(['SEP-SKILL-IMPORT', 1, 'device-revoke', instanceId, null, null, grant.deviceId, c.keyFingerprint, c.challengeId, c.nonce, c.expiresAt, consentHash]);
    enabled = false;
    expect((await request(app.getHttpServer()).get('/api/skill-import/config').expect(200)).body.enabled).toBe(false);
    await request(app.getHttpServer()).post('/api/skill-import/sessions').send({ requestId: 'disabled', protocolVersion: 1 }).expect(503);
    await request(app.getHttpServer()).delete(`/api/skill-import/sessions/${id}`).expect(200);
    const body = { challengeId: c.challengeId, signature: sign(null, Buffer.from(message), keys.privateKey).toString('base64url') };
    await request(app.getHttpServer()).post(`/api/skill-import/connector/devices/${grant.deviceId}/revoke`).send(body).expect(200);
    await request(app.getHttpServer()).post(`/api/skill-import/connector/devices/${grant.deviceId}/revoke`).send(body).expect(409);
    expect(devices.get(grant.deviceId).revokedAt).toBeInstanceOf(Date);
  });

  it('serializes competing selections into one package command across Redis locks', async () => {
    const { id } = await prepared(false, false);
    const results = await Promise.all(['op-a', 'op-b'].map((operationId) => request(app.getHttpServer()).post(`/api/skill-import/sessions/${id}/selection`).send({ candidateId: 'candidate', snapshotId: 'snapshot', operationId })));
    expect(results.map((response) => response.status).sort()).toEqual([202, 409]);
    const state = await store.read<ImportSession>(`session:${id}`);
    expect(state.commands.filter((command) => command.type === 'package-selected')).toHaveLength(1);
  });

  it('expires idle sessions without extending them on reads', async () => {
    const context = await paired(); const { id, grant } = context;
    const state = await store.read<ImportSession>(`session:${id}`); state.idleExpiresAt = new Date(Date.now() - 1).toISOString(); await store.put(`session:${id}`, state);
    await request(app.getHttpServer()).get(`/api/skill-import/connector/sessions/${id}/commands`).auth(grant.sessionGrant, { type: 'bearer' }).expect(410);
    expect((await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}`).expect(200)).body.status).toBe('expired');
  });

  it('fails closed on unavailable Redis and enforces global upload admission across requests', async () => {
    const { id, uploadGrant } = await prepared();
    const first = await service.beginUpload(id, uploadGrant);
    await expect(service.beginUpload(id, uploadGrant)).rejects.toMatchObject({ status: 409 });
    const second = await prepared();
    await expect(service.beginUpload(second.id, second.uploadGrant)).rejects.toMatchObject({ status: 429 });
    await service.finishUpload(first, true);
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('Redis unavailable'));
    await request(app.getHttpServer()).get(`/api/skill-import/sessions/${id}`).expect(503);
  });
});

const MINUTE = 60_000;
