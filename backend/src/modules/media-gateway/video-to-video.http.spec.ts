import { ExecutionContext, HttpException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mediaCatalogStub } from '../../../test/stubs/compute-catalog.stub';
import { enterpriseMediaStub, signedMediaProtocolStub } from '../../../test/stubs/enterprise-media.stub';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { MediaVideoConfigService } from '../media-config/media-video-config.service';
import { MediaVideoRealController } from './media-video-real.controller';
import { MediaVideoRealGuard } from './media-video-real.guard';
import { MediaVideoRealService } from './media-video-real.service';
import { MediaVideoRealStore } from './media-video-real.store';
import { scope, videoClaims, videoRealPrisma } from './media-video-real.test-support';
import { Sub2apiVideoAdapter } from './sub2api-video.adapter';
import { VideoFileCacheService } from './video-file-cache.service';
import { VideoReferenceUploadService } from './video-reference-upload.service';
import { contractResult } from './longdao-media.test-support';
import { MediaVideoMaintenanceService } from './media-video-maintenance.service';
import { MediaVideoRealReceiptSchema } from 'shared';
import { Decimal } from '@prisma/client/runtime/library';

const run = promisify(execFile);
const prefix = '/api/gateway/v1/media/video-real';
const modelId = 'seedance-2.0-fast';
const vref = `vref_${'a'.repeat(32)}`;
describe('reference video real HTTP chain (fake compute, real streaming and file inspection)', () => {
  let app: INestApplication;
  let directory: string;
  let priorCache: string | undefined;
  let db: ReturnType<typeof videoRealPrisma>;
  let mp4: Buffer;
  let mov: Buffer;
  let audioOnly: Buffer;
  let upstream: jest.SpyInstance;
  let service: MediaVideoRealService;
  let uploads: VideoReferenceUploadService;
  let adapter: Sub2apiVideoAdapter;
  let store: MediaVideoRealStore;
  let files: VideoFileCacheService;
  let createService: () => MediaVideoRealService;
  let nextUpload: { status: number; body: unknown; headers?: Record<string, string> } | undefined;
  let createFailure: { status: number; patch: Record<string, unknown>; headers?: Record<string, string> } | undefined;
  let rawCreateFailure: { status: number; body: unknown; headers?: Record<string, string> } | undefined;
  let queryFailure: { status: number; body: unknown; headers?: Record<string, string> } | undefined;
  let queryHeaders: Record<string, string> = {};
  let queryPatch: Record<string, unknown> = {};
  let usagePatch: Record<string, unknown> = {};
  let contentFailures = 0;
  let contentAttempts = 0;
  let restoreLostSubmission = false;
  let generationLost = false;
  let completeTasks = false;
  let nextReference = 0;
  let key = 'synthetic-video-reference-secret';
  const uploaded = new Map<string, Buffer>();
  const submissions: Array<{ body: any; headers: Headers }> = [];
  let originalRequestId: string;
  const billing = { quoteFunding: jest.fn(async () => ({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' })),
    reserve: jest.fn(async (_claims, id) => { db.state.reservations.set(id, { receiptId: id, status: 'RESERVED' }); }),
    status: jest.fn(async id => db.state.reservations.get(id)?.status ?? 'RESERVED'),
    release: jest.fn(async id => { db.state.reservations.get(id).status = 'RELEASED'; }),
    settleCompute: jest.fn(async id => { db.state.reservations.get(id).status = 'SETTLED'; return 'SETTLED'; }) };
  let enterprise: ReturnType<typeof enterpriseMediaStub>;
  const json = (body: unknown, status = 200, headers = {}) => {
    if (body && typeof body === 'object' && 'billing' in body) enterprise?.observe(body as never);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  const get = (path: string) => request(app.getHttpServer()).get(prefix + path).set('x-test-auth', 'yes');
  const post = (path: string) => request(app.getHttpServer()).post(prefix + path).set('x-test-auth', 'yes');
  const upload = (bytes: Buffer = mp4, mimeType = 'video/mp4') => post('/video-references?profileId=real-h3&configVersion=cfg-real-h3')
    .attach('file', bytes, { filename: 'untrusted-name.bin', contentType: mimeType });
  const input = (ids: string[]) => ({ protocolVersion: 3, specRevision: 1, profileId: 'real-h3', configVersion: 'cfg-real-h3',
    operation: 'video-to-video', creativeBrief: 'Retain camera movement', referenceIds: [], videoReferenceIds: ids,
    requestedSpec: { durationSeconds: 1, resolution: '90p', aspectRatio: '16:9', audio: false, frameRate: 30, outputFormat: 'video/mp4' } });

  async function boot() {
    const module = await Test.createTestingModule({ controllers: [MediaVideoRealController], providers: [MediaVideoRealGuard,
      { provide: MediaVideoRealService, useValue: service }, { provide: VideoReferenceUploadService, useValue: uploads }],
    }).overrideGuard(ClientEmploymentGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest(); if (req.headers['x-test-auth'] !== 'yes') throw new UnauthorizedException();
      req.clientEmployment = videoClaims; return true;
    } }).compile();
    const next = module.createNestApplication(); next.setGlobalPrefix('api'); next.useGlobalFilters(new HttpExceptionFilter());
    await next.init(); return next;
  }

  async function prepare(clientRequestId: string) {
    const reference = (await upload().expect(201)).body;
    const payload = input([reference.referenceId]);
    const quote = (await post('/quotes').send(payload).expect(201)).body;
    return { ...payload, quoteId: quote.quoteId, clientRequestId };
  }

  function taskQueries() {
    return upstream.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === 'GET'
      && /\/videos\/(?:original-task|sep-video-[^/?]+)(?:\?id_type=request_id)?$/.test(String(url)));
  }

  async function background() {
    await new MediaVideoMaintenanceService(store, service, files).recoverPending();
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sep-video-input-'));
    priorCache = process.env.MEDIA_VIDEO_CACHE_DIR; process.env.MEDIA_VIDEO_CACHE_DIR = join(directory, 'cache');
    for (const extension of ['mp4', 'mov']) await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=30',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(directory, `source.${extension}`)], { timeout: 30_000 });
    mp4 = await readFile(join(directory, 'source.mp4')); mov = await readFile(join(directory, 'source.mov'));
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.1', '-c:a', 'aac',
      join(directory, 'audio-only.mp4')], { timeout: 30_000 });
    audioOnly = await readFile(join(directory, 'audio-only.mp4'));
    db = videoRealPrisma();
    Object.assign(db.state.model, { modelId, operations: ['text-to-video', 'image-to-video', 'video-to-video'] });
    Object.assign(db.state.model.capabilities, { supportsVideoToVideo: true, maxVideoReferenceCount: 3,
      maxVideoReferenceBytes: 90 * 1024 * 1024, videoReferenceMimeTypes: ['video/mp4', 'video/quicktime'],
      durationsSeconds: [1, 15], durationRange: { minimum: 1, maximum: 15 }, resolutions: ['90p'] });
    db.mediaModelProfile['findMany'] = jest.fn(async () => [structuredClone(db.state.model)]);
    const config = { get: (name: string) => name === 'MEDIA_VIDEO_REAL_ENABLED' ? 'true' : 'test' };
    const settings = { getMediaConnection: async () => ({ baseUrl: 'https://fake.invalid/v1', apiKey: key, source: 'database' }),
      getEffectiveValue: async () => '7' };
    adapter = new Sub2apiVideoAdapter(settings as never, signedMediaProtocolStub as never);
    upstream = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const url = String(_url); const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${key}`);
      if (url.endsWith('/videos/references')) {
        if (nextUpload) { const next = nextUpload; nextUpload = undefined; return json(next.body, next.status, next.headers); }
        const file = (init.body as FormData).get('file') as File;
        expect((init.body as FormData).getAll('file')).toHaveLength(1);
        const bytes = Buffer.from(await file.arrayBuffer()); uploaded.set(file.type, bytes);
        return json({ reference_id: `vref_${(++nextReference).toString(16).padStart(32, '0')}`, content_type: file.type, size_bytes: bytes.length,
          expires_at: new Date(Date.now() + 7 * 86_400_000 - 1000).toISOString() }, 201);
      }
      if (url.endsWith('/sub2api/videos/pricing')) {
        const dimensions = JSON.parse(init.body as string);
        return json({ object: 'sub2api.video_pricing', schema_version: 1, currency: 'CNY', contract_version: 1,
          enterprise_id: videoClaims.enterpriseId, amount_cny: '1.400000', quote_id: 'price-video', ...dimensions,
          billing_mode: 'video', pricing_status: 'quoted', pricing_source: 'customer_video_contract', pricing_authority: 'sub2api_customer_billing',
          amount_usd: '0.2', pricing_version: 'price-video', effective_rate_multiplier: 1, observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString() });
      }
      if (url.endsWith('/videos')) {
        submissions.push({ body: JSON.parse(init.body as string), headers });
        originalRequestId = headers.get('X-Client-Request-ID');
        if (generationLost) throw new Error('Synthetic lost generation response');
        if (rawCreateFailure) return json(rawCreateFailure.body, rawCreateFailure.status, rawCreateFailure.headers);
        return json(contractResult(originalRequestId, {
          object: 'video', task_id: 'original-task', id: 'original-task', model: modelId, receipt_operation: 'create',
          ...createFailure?.patch,
        }).contract, createFailure?.status ?? 200,
          { 'X-Client-Request-ID': headers.get('X-Client-Request-ID'), ...createFailure?.headers });
      }
      if (url.endsWith('/videos/original-task')) {
        if (queryFailure) return json(queryFailure.body, queryFailure.status, queryFailure.headers);
        return json(contractResult(originalRequestId, {
        object: 'video', task_id: 'original-task', id: 'original-task', model: modelId, receipt_operation: 'query',
        status: completeTasks ? 'completed' : 'in_progress', is_final: completeTasks,
        billing: completeTasks ? { status: 'settled', actual_cost_usd: '0.2' } : { status: 'pending', actual_cost_usd: null },
        ...queryPatch,
      }).contract, 200, queryHeaders);
      }
      if (url.includes('/videos/') && new URL(url).searchParams.get('id_type') === 'request_id') {
        if (restoreLostSubmission) return json(contractResult(originalRequestId, {
          object: 'video', task_id: 'original-task', id: 'original-task', model: modelId, receipt_operation: 'query',
          status: 'in_progress', is_final: false,
        }).contract);
        return json(contractResult(new URL(url).pathname.split('/').pop(), {
          task_id: null, status: null, submission_status: 'unobserved', receipt_operation: 'query',
          billing: { status: 'unknown', actual_cost_usd: null },
          operation_error: { code: 'request_not_found', message: 'Synthetic request record not found' },
        }).contract, 404);
      }
      if (url.endsWith('/videos/original-task/content')) {
        contentAttempts++;
        if (contentFailures-- > 0) return json({ error: { code: 'content_temporarily_unavailable',
          message: 'Synthetic original video download interrupted', source: 'platform' } }, 503);
        return new Response(new Uint8Array(mp4), { headers: { 'content-type': 'video/mp4' } });
      }
      if (url.includes('/sub2api/videos/usage?')) return json({ object: 'sub2api.video_request_usage', schema_version: 1,
        currency: 'USD', request_id: new URL(url).searchParams.get('request_id'), status: 'settled', model: modelId,
        actual_cost_usd: '0.2', video_count: 1, duration_seconds: 1, resolution: '90p', ...usagePatch });
      throw new Error(`Unexpected synthetic compute request: ${new URL(url).pathname}`);
    });
    files = new VideoFileCacheService(); await files.assertAvailable();
    const runtime = new MediaVideoConfigService(db as never, {} as never, config as never, mediaCatalogStub() as never, adapter, files, undefined, settings as never);
    store = new MediaVideoRealStore(db as never);
    const connection = await adapter.connection();
    enterprise = enterpriseMediaStub(connection.base, connection.key, connection.fingerprint, '1.400000');
    enterprise.media.connection.mockImplementation(async (enterpriseId, _kind, _pinned, sourceRef) => ({
      base: connection.base, key, fingerprint: createHash('sha256').update(`${connection.base}\0${key}`).digest('hex'),
      compute: { enterpriseId, ...(sourceRef ? { executionId: `execution_${sourceRef}` } : {}) },
      snapshot: { enterpriseId, credentialId: 'enterprise-key', baseUrl: connection.base },
    }));
    Object.assign(billing, { settleCompute: jest.fn(async id => {
      const status = enterprise.feeStatus() === 'not_charged' ? 'RELEASED' : 'SETTLED';
      db.state.reservations.get(id).status = status; return status;
    }) });
    createService = () => new MediaVideoRealService(config as never, db as never, settings as never, runtime, adapter,
      new VideoFileCacheService(), billing as never, new MediaVideoRealStore(db as never), enterprise.connections as never, enterprise.media as never);
    service = createService();
    uploads = new VideoReferenceUploadService({ redis: { eval: async () => 1, zrem: jest.fn(async () => 1) } } as never);
    app = await boot();
  }, 60_000);
  beforeEach(() => {
    db.state.references.clear(); db.state.quotes.clear(); db.state.requests.clear(); db.state.reservations.clear();
    submissions.length = 0; uploaded.clear(); upstream.mockClear();
    for (const fn of Object.values(billing)) fn.mockClear();
  });
  afterEach(() => {
    nextUpload = undefined; generationLost = false; completeTasks = false; createFailure = undefined; rawCreateFailure = undefined; queryFailure = undefined;
    queryPatch = {}; queryHeaders = {}; usagePatch = {}; contentFailures = 0; contentAttempts = 0; restoreLostSubmission = false;
  });
  afterAll(async () => {
    upstream?.mockRestore(); await app?.close();
    if (priorCache === undefined) delete process.env.MEDIA_VIDEO_CACHE_DIR; else process.env.MEDIA_VIDEO_CACHE_DIR = priorCache;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('publishes separate video/image limits and video_from_video to authorized runtime', async () => {
    const result = await get('/profiles?protocolVersion=3').expect(200);
    expect(result.body.profiles[0]).toMatchObject({ operations: ['text-to-video', 'image-to-video', 'video-to-video'],
      adapter: { referenceSupport: { maxInputBytes: 10 * 1024 * 1024 }, videoReferenceSupport: { maxCount: 3, maxInputBytes: 90 * 1024 * 1024 } },
      videoReferenceRules: expect.arrayContaining([{ operation: 'video-to-video', minCount: 1, maxCount: 3,
        maxInputBytes: 90 * 1024 * 1024, mimeTypes: ['video/mp4', 'video/quicktime'] }]),
    });
  });

  it('streams MP4 and MOV unchanged, exposes only SEP IDs, cleans files and makes no paid call during upload', async () => {
    const count = submissions.length; const reservations = billing.reserve.mock.calls.length;
    for (const [bytes, mimeType] of [[mp4, 'video/mp4'], [mov, 'video/quicktime']] as const) {
      const result = await upload(bytes, 'application/octet-stream').expect(201);
      expect(result.body).toMatchObject({ mock: false, kind: 'video', mimeType, byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), profileId: 'real-h3' });
      expect(result.body.referenceId).not.toBe(vref); expect(JSON.stringify(result.body)).not.toContain(key);
      expect(uploaded.get(mimeType)).toEqual(bytes);
    }
    expect(submissions).toHaveLength(count); expect(billing.reserve).toHaveBeenCalledTimes(reservations);
    expect(await readdir(join(directory, 'cache', 'incoming'))).toEqual([]);
  });

  it('rejects unauthorized uploads before creating temporary files or forwarding', async () => {
    const directorySpy = jest.spyOn(uploads, 'directory'); const count = upstream.mock.calls.length;
    await request(app.getHttpServer()).post(prefix + '/video-references?profileId=real-h3&configVersion=cfg-real-h3').attach('file', mp4, 'x.mp4').expect(401);
    db.state.enterprise.mediaPolicy.video.enabledProfileIds = [];
    try { await upload().expect(403); } finally { db.state.enterprise.mediaPolicy.video.enabledProfileIds = ['real-h3']; }
    expect(directorySpy).not.toHaveBeenCalled(); expect(upstream.mock.calls).toHaveLength(count); directorySpy.mockRestore();
  });

  it('rejects missing, corrupt, duplicate files, extra fields, oversize and stale configuration', async () => {
    await post('/video-references?profileId=real-h3&configVersion=cfg-real-h3').field('extra', 'not allowed').expect(400);
    await upload(Buffer.from('not a video')).expect(415);
    await upload(Buffer.concat([mp4.subarray(0, 32), Buffer.from('corrupt container')])).expect(400);
    await upload(audioOnly).expect(400);
    await upload().attach('file', mp4, 'second.mp4').expect(400);
    await post('/video-references?profileId=real-h3&configVersion=old').attach('file', mp4, 'x.mp4').expect(409);
    const c = db.state.model.capabilities as any; const limit = c.maxVideoReferenceBytes;
    c.maxVideoReferenceBytes = mp4.length;
    try {
      await upload().expect(201);
      await upload(Buffer.concat([mp4, Buffer.from([0])])).expect(413);
    } finally { c.maxVideoReferenceBytes = limit; }
    expect(await readdir(join(directory, 'cache', 'incoming'))).toEqual([]);
  });

  it('preserves compute rejection details and distinguishes an invalid 201 receipt as SEP validation', async () => {
    nextUpload = { status: 429, body: { error: { code: 'rate_limit_error', message: 'Upload quota exhausted', source: 'platform' } }, headers: { 'retry-after': '1' } };
    const refused = await upload().expect(429);
    expect(refused.body.error.message).toBe('Upload quota exhausted'); expect(refused.headers['retry-after']).toBe('1');
    nextUpload = { status: 201, body: { reference_id: vref } };
    const invalid = await upload().expect(502);
    expect(invalid.body.error).toMatchObject({ origin: 'sep', code: 'INVALID_VIDEO_REFERENCE_RESPONSE', computeStatus: 201 });
    expect(invalid.headers['x-sep-error-source']).toBeUndefined();
  });

  it('quotes, submits ordered video IDs as JSON once, recovers after input expiry and downloads the original result', async () => {
    const first = (await upload().expect(201)).body; const second = (await upload(mov).expect(201)).body;
    const payload = input([first.referenceId, second.referenceId]);
    const quote = (await post('/quotes').send(payload).expect(201)).body;
    expect(quote.billingDimensions.operation).toBe('video-to-video');
    const body = { ...payload, quoteId: quote.quoteId, clientRequestId: 'video-ref-client' };
    const start = submissions.length;
    const [accepted, duplicate] = await Promise.all([post('/requests').send(body).expect(202), post('/requests').send(body).expect(202)]);
    const submitted = accepted.body;
    expect(submitted.execution).toMatchObject({ submissionStatus: 'accepted', taskId: 'original-task' });
    expect(duplicate.body.receiptId).toBe(submitted.receiptId);
    expect(submissions).toHaveLength(start + 1);
    const scope = JSON.stringify([videoClaims.enterpriseId, videoClaims.subscriptionId, videoClaims.memberId, videoClaims.sub]);
    const frozen = await Promise.all(payload.videoReferenceIds.map(id => store.findVideoReference(scope, id)));
    expect(submissions[start].body).toMatchObject({ model: modelId, generate_audio: false, metadata: { content: [
      { type: 'video_url', video_url: { reference_id: frozen[0].upstreamReferenceId }, role: 'reference_video' },
      { type: 'video_url', video_url: { reference_id: frozen[1].upstreamReferenceId }, role: 'reference_video' },
    ] } });
    expect(submissions[start].body).not.toHaveProperty('frameRate'); expect(submissions[start].body).not.toHaveProperty('fps');
    expect(submissions[start].headers.get('X-Video-Operation')).toBe('video-to-video');
    for (const id of payload.videoReferenceIds) {
      const row = db.state.references.get(id); row.expiresAt = new Date(Date.now() - 1000); row.metadata.value.expiresAt = row.expiresAt.toISOString();
    }
    completeTasks = true;
    await service.recoverPending(scope, submitted.receiptId);
    expect(await store.findRequest(scope, submitted.receiptId)).toMatchObject({ receipt: {
      status: 'SUCCEEDED', fileStatus: 'available', billingStatus: 'SETTLED',
    } });
    const replay = (await post('/requests').send(body).expect(200)).body;
    expect(replay).toMatchObject({ receiptId: submitted.receiptId, status: 'SUCCEEDED', billingStatus: 'SETTLED', operation: 'video-to-video' });
    const downloaded = await get(`/requests/${submitted.receiptId}/outputs/${replay.outputs[0].outputId}/content`).expect(200);
    expect(downloaded.body).toEqual(mp4); expect(submissions).toHaveLength(start + 1);
  });

  it('rejects foreign, expired, image, raw compute IDs and changed connection before quotation', async () => {
    const ref = (await upload().expect(201)).body;
    await expect(store.findVideoReference('foreign-scope', ref.referenceId)).resolves.toBeNull();
    await post('/quotes').send(input([vref])).expect(404);
    const foreign = db.state.references.get(ref.referenceId); foreign.scope = 'other';
    await post('/quotes').send(input([ref.referenceId])).expect(404); foreign.scope = JSON.stringify([videoClaims.enterpriseId, videoClaims.subscriptionId, videoClaims.memberId, videoClaims.sub]);
    key = 'changed-synthetic-key';
    try { await post('/quotes').send(input([ref.referenceId])).expect(409); } finally { key = 'synthetic-video-reference-secret'; }
    foreign.expiresAt = new Date(Date.now() - 1000); foreign.metadata.value.expiresAt = foreign.expiresAt.toISOString();
    await post('/quotes').send(input([ref.referenceId])).expect(410);
    await post('/quotes').send(input(['nonexistent-image'])).expect(404);
    await post('/quotes').send(input(['a', 'b', 'c', 'd'])).expect(422);
  });

  it('does not resend an ambiguously submitted paid generation and detects replay changes', async () => {
    const ref = (await upload().expect(201)).body; const payload = input([ref.referenceId]);
    const quote = (await post('/quotes').send(payload).expect(201)).body;
    generationLost = true; const before = submissions.length;
    const body = { ...payload, quoteId: quote.quoteId, clientRequestId: 'lost-video-response' };
    const initial = await post('/requests').send(body).expect(202);
    expect(initial.body).toMatchObject({ status: 'SUBMISSION_UNKNOWN', receiptVersion: 2,
      execution: { submissionStatus: 'unknown' }, clientActions: { shouldPoll: true, pollPurpose: 'submission' } });
    const recovered = await post('/requests').send(body).expect(404);
    expect(recovered.body.submission_status).toBe('unobserved');
    expect((await store.findRequest(scope, initial.body.receiptId)).receipt.status).toBe('SUBMISSION_UNKNOWN');
    expect(submissions).toHaveLength(before + 1);
    await post('/requests').send({ ...body, creativeBrief: 'Different request' }).expect(409);
  });

  it.each(['raw', 'contract'])('preserves a current %s video query 429 without replaying generation', async mode => {
    const body = await prepare(`query-limit-${mode}`);
    const created = (await post('/requests').send(body).expect(202)).body;
    const reason = { code: 'rate_limit_exceeded', message: 'Synthetic video query limited' };
    queryFailure = { status: 429, headers: { 'retry-after': '9', 'x-request-id': 'compute-video-limited' },
      body: mode === 'raw' ? { error: reason } : contractResult('current-query', {
        task_id: null, status: null, submission_status: 'unobserved', receipt_operation: 'query',
        operation_error: reason, billing: { status: 'unknown', actual_cost_cny: null },
      }).contract };
    const refused = await get(`/requests/${created.receiptId}`).expect(429);
    expect(refused.headers['retry-after']).toBe('9');
    expect(refused.headers['x-compute-request-id']).toBe('compute-video-limited');
    expect(refused.headers['x-sep-receipt-id']).toBe(created.receiptId);
    expect(refused.body).toEqual(queryFailure.body);
    queryFailure = undefined;
    queryPatch = { status: 'failed', is_final: true, task_error: reason,
      submission_error: reason, http_status: 429, billing: { status: 'not_charged', actual_cost_cny: '0' } };
    const recovered = (await get(`/requests/${created.receiptId}`).expect(200)).body;
    expect(recovered).toMatchObject({ status: 'FAILED', execution: { taskError: reason, submissionHttpStatus: 429 } });
    expect(submissions).toHaveLength(1);
  });

  it('forwards video pending wait headers and refreshes them with each upstream reply', async () => {
    const body = await prepare('pending-wait');
    createFailure = { status: 202, patch: {}, headers: { 'retry-after': '20' } };
    const created = await post('/requests').send(body).expect(202);
    expect(created.headers['retry-after']).toBe('20'); expect(created.body.pollAfterMs).toBeGreaterThan(18000);
    queryHeaders = { 'retry-after': '30' };
    const pending = await get(`/requests/${created.body.receiptId}`).expect(200);
    expect(pending.headers['retry-after']).toBe('30'); expect(pending.body.pollAfterMs).toBeGreaterThan(28000);
    queryHeaders = {};
    const next = await get(`/requests/${created.body.receiptId}`).expect(200);
    expect(next.headers['retry-after']).toBeUndefined(); expect(next.body.pollAfterMs).toBe(3000);
    expect(submissions).toHaveLength(1); expect(taskQueries()).toHaveLength(2);
  });

  it('updates repeated video query limits and clears them after successful client-ID lookup', async () => {
    const body = await prepare('query-repeated-limit');
    const created = (await post('/requests').send(body).expect(202)).body;
    for (const seconds of ['2', '12']) {
      queryFailure = { status: 429, body: { error: { message: 'Synthetic repeated video query limit', retry_after: Number(seconds) } },
        headers: { 'retry-after': seconds } };
      const limited = await get(`/requests/by-client-id/${body.clientRequestId}`).expect(429);
      expect(limited.headers['retry-after']).toBe(seconds); expect(limited.body).toEqual(queryFailure.body);
    }
    queryFailure = undefined;
    const recovered = await get(`/requests/by-client-id/${body.clientRequestId}`).expect(200);
    expect(recovered.body.receiptId).toBe(created.receiptId); expect(recovered.body.status).toBe('RUNNING');
    expect(recovered.body.execution).not.toHaveProperty('operationError'); expect(recovered.body).not.toHaveProperty('upstreamError');
    expect(recovered.headers['retry-after']).toBeUndefined(); expect(taskQueries()).toHaveLength(3); expect(submissions).toHaveLength(1);
  });

  it('rechecks a video query 429 after independent settlement and removes it on successful lookup', async () => {
    const body = await prepare('settled-query-recovery');
    const created = (await post('/requests').send(body).expect(202)).body;
    completeTasks = true;
    queryPatch = { billing: { status: 'unknown', actual_cost_cny: null } };
    const delivered = (await get(`/requests/${created.receiptId}`).expect(200)).body;
    expect(delivered).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'RECONCILING' });
    queryFailure = { status: 429, body: { error: { message: 'Synthetic query temporarily limited' } }, headers: { 'retry-after': '8' } };
    enterprise.media.fee.mockResolvedValueOnce({ id: `execution_${created.receiptId}`, feeStatus: 'FINAL', grossCny: new Decimal('0.7') });
    const limited = await get(`/requests/${created.receiptId}`).expect(429);
    expect(limited.headers['retry-after']).toBe('8');
    queryFailure.headers = { 'retry-after': '15' };
    const again = await get(`/requests/${created.receiptId}`).expect(429);
    expect(again.headers['retry-after']).toBe('15');
    const before = taskQueries().length;
    queryFailure = undefined; queryPatch = {};
    const recovered = await get(`/requests/${created.receiptId}`).expect(200);
    expect(taskQueries()).toHaveLength(before + 1);
    expect(recovered.body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', fileStatus: 'available' });
    expect(recovered.body.execution).not.toHaveProperty('operationError'); expect(recovered.body).not.toHaveProperty('upstreamError');
    expect(recovered.headers['retry-after']).toBeUndefined(); expect(submissions).toHaveLength(1); expect(billing.settleCompute).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 402, 403, 409, 422, 429, 500, 502, 503, 504])(
    'closes an explicit HTTP %s creation failure with its original reason and no charge', async httpStatus => {
      const reason = { code: 'synthetic_video_creation_failure', message: `Reference video creation rejected (${httpStatus})` };
      createFailure = { status: httpStatus, headers: { 'retry-after': '7' }, patch: {
        task_id: null, id: null, submission_status: 'failed', status: null, http_status: httpStatus,
        submission_error: reason, operation_error: reason, billing: { status: 'not_charged', actual_cost_usd: '0' },
      } };
      const body = await prepare(`refused-${httpStatus}`);
      const refused = await post('/requests').send(body).expect(httpStatus);
      expect(refused.headers['retry-after']).toBe('7');
      expect(refused.body).toMatchObject({ submission_error: reason, http_status: httpStatus });
      const receipt = (await get(`/requests/${refused.headers['x-sep-receipt-id']}`).expect(200)).body;
      expect(MediaVideoRealReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(receipt).toMatchObject({ operation: 'video-to-video', status: 'FAILED', billingStatus: 'RELEASED',
        fileStatus: 'unavailable', execution: { submissionStatus: 'failed', generationStatus: null,
          submissionError: reason, submissionHttpStatus: httpStatus, operationError: { status: httpStatus },
          billing: { status: 'not_charged', actualCostCny: null } },
        clientActions: { generationFinished: true, canStartNewRequest: true, shouldPoll: false },
      });
      expect((await post('/requests').send(body).expect(200)).body.receiptId).toBe(receipt.receiptId);
      expect((await get(`/requests/by-client-id/${body.clientRequestId}`).expect(200)).body.execution.submissionError).toEqual(reason);
      expect(submissions).toHaveLength(1); expect(taskQueries()).toHaveLength(0); expect(contentAttempts).toBe(0);
      expect(billing.release).not.toHaveBeenCalled(); expect(billing.settleCompute).toHaveBeenCalledTimes(1);
    });

  it('closes a protocol error with a diagnostic task ID and preserves all submission diagnostics', async () => {
    const reason = { code: 'video_protocol_error', message: 'Synthetic supplier acknowledgment has an invalid model' };
    createFailure = { status: 502, patch: { task_id: 'diagnostic-task', id: 'diagnostic-task', model: 'invalid-model',
      submission_status: 'protocol_error', status: null, submission_error: reason, operation_error: reason,
      submission_record_error: { message: 'Synthetic association record unavailable' }, http_status: 502,
      billing: { status: 'not_charged', actual_cost_usd: '0' } } };
    const body = await prepare('protocol-refused');
    const refused = await post('/requests').send(body).expect(502);
    const receipt = (await get(`/requests/${refused.headers['x-sep-receipt-id']}`).expect(200)).body;
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED', execution: {
      submissionStatus: 'protocol_error', taskId: 'diagnostic-task', submissionError: reason,
      submissionRecordError: { message: 'Synthetic association record unavailable' },
    }, clientActions: { shouldPoll: false, canStartNewRequest: true } });
    await background(); await post('/requests').send(body).expect(200);
    expect(submissions).toHaveLength(1); expect(taskQueries()).toHaveLength(0); expect(contentAttempts).toBe(0);
  });

  it.each([403, 429, 502])('preserves HTTP %s without inferring rejection or refund from an incomplete receipt', async status => {
    rawCreateFailure = { status, headers: { 'retry-after': '4' }, body: { error: { code: 'incomplete_reply', message: 'Synthetic missing task and billing evidence' } } };
    const body = await prepare(`incomplete-${status}`);
    const refused = await post('/requests').send(body).expect(status);
    expect(refused.body).toEqual(rawCreateFailure.body);
    expect(refused.headers['retry-after']).toBe('4');
    const receipt = (await store.findRequest(scope, refused.headers['x-sep-receipt-id'])).receipt;
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'RECONCILING', execution: {
      submissionStatus: 'unknown', operationError: { status, body: rawCreateFailure.body },
    }, clientActions: { canStartNewRequest: false, pollPurpose: 'submission' } });
    expect(billing.release).not.toHaveBeenCalled(); expect(billing.settleCompute).not.toHaveBeenCalled();
    restoreLostSubmission = true; await background(); completeTasks = true; await background();
    expect((await get(`/requests/${receipt.receiptId}`).expect(200)).body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED' });
    expect(submissions).toHaveLength(1);
  });

  it('retains failure and no-charge evidence while retrying only the failed wallet release', async () => {
    createFailure = { status: 403, patch: { task_id: null, id: null, submission_status: 'rejected', status: null,
      submission_error: { code: 'model_forbidden', message: 'Synthetic reference video access denied' },
      billing: { status: 'not_charged', actual_cost_usd: '0' } } };
    billing.settleCompute.mockRejectedValueOnce(new HttpException({ error: { code: 'wallet_unavailable',
      message: 'Synthetic reservation release unavailable' } }, 503));
    const body = await prepare('release-recovery');
    const refused = await post('/requests').send(body).expect(403);
    const receipt = (await store.findRequest(scope, refused.headers['x-sep-receipt-id'])).receipt;
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING',
      billingError: { status: 503, body: { error: { message: 'Synthetic reservation release unavailable' } } },
      execution: { billing: { status: 'not_charged' } },
      clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    await background();
    const recovered = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(recovered).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED', execution: {
      submissionError: { code: 'model_forbidden', message: 'Synthetic reference video access denied' },
    }, clientActions: { shouldPoll: false } });
    expect(recovered).not.toHaveProperty('billingError'); expect(submissions).toHaveLength(1);
    expect(taskQueries()).toHaveLength(0); expect(billing.settleCompute).toHaveBeenCalledTimes(2);
  });

  it('returns a final generation failure without confusing it with a rejected submission', async () => {
    const body = await prepare('generation-failed');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    queryPatch = { status: 'failed', is_final: true,
      task_error: { code: 'reference_content_rejected', message: 'Synthetic reference content rejected by provider' },
      billing: { status: 'not_charged', actual_cost_usd: '0' } };
    await background();
    const failed = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(failed).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED', fileStatus: 'unavailable',
      execution: { submissionStatus: 'accepted', generationStatus: 'failed', isFinal: true,
        taskError: { code: 'reference_content_rejected', message: 'Synthetic reference content rejected by provider' } },
      clientActions: { generationFinished: true, shouldPoll: false, canStartNewRequest: true } });
    expect(failed.execution).not.toHaveProperty('submissionError'); expect(contentAttempts).toBe(0);
    expect(submissions).toHaveLength(1); expect(billing.settleCompute).toHaveBeenCalledTimes(1);
  });

  it('finishes failed generation while billing is unknown and later releases confirmed uncharged funds', async () => {
    const body = await prepare('failed-billing-unknown');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    queryPatch = { status: 'failed', is_final: true,
      task_error: { code: 'supplier_failed', message: 'Synthetic supplier task failed' },
      billing: { status: 'unknown', actual_cost_usd: null, error: { message: 'Synthetic compute settlement unavailable' } } };
    const failed = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(failed).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING', execution: {
      generationStatus: 'failed', billing: { status: 'unknown', actualCostCny: null,
        error: { message: 'Synthetic compute settlement unavailable' } },
    }, clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(billing.release).not.toHaveBeenCalled(); expect(billing.settleCompute).not.toHaveBeenCalled();
    queryPatch.billing = { status: 'not_charged', actual_cost_usd: '0' };
    await background();
    expect((await get(`/requests/${receipt.receiptId}`).expect(200)).body).toMatchObject({
      status: 'FAILED', billingStatus: 'RELEASED', clientActions: { shouldPoll: false },
    });
    expect(contentAttempts).toBe(0); expect(submissions).toHaveLength(1);
  });

  it('settles an independent final bill while the video receipt still says pending', async () => {
    const body = await prepare('independent-final-fee');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    enterprise.media.fee.mockResolvedValueOnce({ id: `execution_${receipt.receiptId}`,
      feeStatus: 'FINAL', grossCny: new Decimal('0.700000') });
    const calls = enterprise.media.fee.mock.calls.length;
    const recovered = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(recovered).toMatchObject({ status: 'RUNNING', billingStatus: 'SETTLED', actualCostCny: '0.700000',
      execution: { billing: { status: 'pending' } } });
    expect(enterprise.media.fee).toHaveBeenCalledTimes(calls + 1);
    expect(billing.settleCompute).toHaveBeenCalledTimes(1);
    expect(billing.settleCompute).toHaveBeenCalledWith(receipt.receiptId, `execution_${receipt.receiptId}`, modelId);
    expect(submissions).toHaveLength(1);
  });

  it('releases a confirmed zero bill despite a failed video status query and never generates again', async () => {
    const body = await prepare('query-failed-final-zero');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    queryFailure = { status: 503, body: { error: { code: 'status_unavailable', message: 'Synthetic status unavailable' } } };
    enterprise.media.fee.mockResolvedValueOnce({ id: `execution_${receipt.receiptId}`,
      feeStatus: 'FINAL', grossCny: new Decimal(0) });
    billing.settleCompute.mockImplementationOnce(async id => {
      db.state.reservations.get(id).status = 'RELEASED'; return 'RELEASED';
    });
    await background();
    const refused = await get(`/requests/${receipt.receiptId}`).expect(503);
    expect(refused.body).toEqual(queryFailure.body);
    const recovered = (await store.findRequest(scope, receipt.receiptId)).receipt;
    expect(recovered).toMatchObject({ billingStatus: 'RELEASED', actualCostCny: '0.000000',
      execution: { operationError: { status: 503, body: queryFailure.body } } });
    expect(billing.settleCompute).toHaveBeenCalledTimes(1);
    expect(billing.release).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(1);
  });

  it('retries a final bill after a fee lookup failure even when video status stays unavailable', async () => {
    const body = await prepare('fee-retry-without-status');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    queryFailure = { status: 503, body: { error: { code: 'status_unavailable', message: 'Synthetic status unavailable' } } };
    enterprise.media.fee.mockRejectedValueOnce(new HttpException({ error: { code: 'fee_unavailable', message: 'Synthetic fee unavailable' } }, 503));
    await get(`/requests/${receipt.receiptId}`).expect(503);
    const pending = (await store.findRequest(scope, receipt.receiptId)).receipt;
    expect(pending).toMatchObject({ billingStatus: 'RECONCILING', billingError: {
      status: 503, body: { error: { code: 'fee_unavailable' } },
    } });
    expect(billing.settleCompute).not.toHaveBeenCalled(); expect(billing.release).not.toHaveBeenCalled();
    enterprise.media.fee.mockResolvedValueOnce({ id: `execution_${receipt.receiptId}`,
      feeStatus: 'FINAL', grossCny: new Decimal('0.500000') });
    await background();
    await get(`/requests/${receipt.receiptId}`).expect(503);
    const recovered = (await store.findRequest(scope, receipt.receiptId)).receipt;
    expect(recovered).toMatchObject({ billingStatus: 'SETTLED', actualCostCny: '0.500000',
      execution: { operationError: { status: 503 } } });
    expect(recovered).not.toHaveProperty('billingError');
    expect(billing.settleCompute).toHaveBeenCalledTimes(1); expect(submissions).toHaveLength(1);
  });

  it('keeps a failed task reserved until the independent bill is final', async () => {
    const body = await prepare('failed-final-fee-pending');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    queryPatch = { status: 'failed', is_final: true, billing: { status: 'pending', actual_cost_usd: null } };
    enterprise.media.fee.mockResolvedValueOnce({ id: `execution_${receipt.receiptId}`, feeStatus: 'PENDING', grossCny: null });
    const calls = enterprise.media.fee.mock.calls.length;
    const pending = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(pending).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING',
      clientActions: { generationFinished: true, pollPurpose: 'billing' } });
    expect(enterprise.media.fee).toHaveBeenCalledTimes(calls + 1);
    expect(billing.settleCompute).not.toHaveBeenCalled(); expect(billing.release).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(1);
  });

  it('retries original content after download failure without resubmitting or charging twice', async () => {
    const body = await prepare('download-recovery');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    completeTasks = true; contentFailures = 1;
    await get(`/requests/${receipt.receiptId}`).expect(503);
    const failed = (await store.findRequest(scope, receipt.receiptId)).receipt;
    expect(failed).toMatchObject({ fileStatus: 'download_failed', billingStatus: 'SETTLED', execution: {
      generationStatus: 'completed', operation: 'download', operationError: { status: 503, body: { error: {
        code: 'content_temporarily_unavailable', message: 'Synthetic original video download interrupted',
      } } },
    }, clientActions: { generationFinished: true, canRetryDownload: true, pollPurpose: 'delivery' } });
    const queried = taskQueries().length;
    await background();
    const recovered = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(recovered).toMatchObject({ status: 'SUCCEEDED', fileStatus: 'available', billingStatus: 'SETTLED',
      clientActions: { shouldPoll: false, canRetryDownload: false } });
    expect(recovered.execution).not.toHaveProperty('operationError'); expect(recovered).not.toHaveProperty('upstreamError');
    const output = recovered.outputs[0];
    expect(output.sha256).toBe(createHash('sha256').update(mp4).digest('hex'));
    expect((await get(`/requests/${receipt.receiptId}/outputs/${output.outputId}/content`).expect(200)).body).toEqual(mp4);
    expect(taskQueries()).toHaveLength(queried); expect(contentAttempts).toBe(2);
    expect(submissions).toHaveLength(1); expect(billing.settleCompute).toHaveBeenCalledTimes(1);
  });

  it('delivers valid video while billing evidence disagrees and settles once after correction', async () => {
    const body = await prepare('billing-mismatch');
    const receipt = (await post('/requests').send(body).expect(202)).body;
    completeTasks = true;
    enterprise.media.fee.mockRejectedValueOnce(new HttpException({ error: {
      code: 'BILLING_PENDING', message: 'Final CNY bill differs from the original execution',
    } }, 409));
    const pending = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(pending).toMatchObject({ status: 'SUCCEEDED', fileStatus: 'available', billingStatus: 'RECONCILING',
      billingError: { status: 409, body: { error: { code: 'BILLING_PENDING' } } },
      recovery: { canDownload: true }, clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(billing.settleCompute).not.toHaveBeenCalled(); expect(billing.release).not.toHaveBeenCalled();
    usagePatch = {};
    await background();
    const settled = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(settled).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', actualCostCny: '1.400000',
      clientActions: { shouldPoll: false } });
    expect(settled).not.toHaveProperty('billingError'); expect(contentAttempts).toBe(1);
    expect(submissions).toHaveLength(1); expect(billing.settleCompute).toHaveBeenCalledTimes(1);
  });

  it.each(['unobserved', 'malformed'])('preserves known task state and money on a %s query failure', async mode => {
    const body = await prepare(`query-${mode}`);
    const receipt = (await post('/requests').send(body).expect(202)).body;
    queryFailure = mode === 'unobserved' ? { status: 403, body: contractResult('unrelated-query-id', {
      task_id: null, status: null, submission_status: 'unobserved', receipt_operation: 'query',
      billing: { status: 'unknown', actual_cost_usd: null }, operation_error: {
        code: 'query_denied', message: 'Synthetic original task lookup denied' },
    }).contract } : { status: 502, body: { error: { code: 'bad_reply', message: 'Synthetic malformed query reply' } } };
    const refused = await get(`/requests/${receipt.receiptId}`).expect(queryFailure.status);
    expect(refused.body).toEqual(queryFailure.body);
    const failed = (await store.findRequest(scope, receipt.receiptId)).receipt;
    expect(failed).toMatchObject({ status: 'QUEUED', billingStatus: receipt.billingStatus, execution: {
      requestId: receipt.execution.requestId, taskId: 'original-task', submissionStatus: 'accepted', generationStatus: 'queued',
      operationError: { status: queryFailure.status },
    }, clientActions: { shouldPoll: true, canStartNewRequest: false } });
    expect(billing.release).not.toHaveBeenCalled(); expect(billing.settleCompute).not.toHaveBeenCalled();
    queryFailure = undefined; completeTasks = true;
    await background();
    expect((await get(`/requests/${receipt.receiptId}`).expect(200)).body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED' });
    expect(submissions).toHaveLength(1);
  });

  it('restores a lost submission and downloads after application restart without expired reference reuploads', async () => {
    const body = await prepare('restart-recovery'); generationLost = true;
    const receipt = (await post('/requests').send(body).expect(202)).body;
    expect(receipt.status).toBe('SUBMISSION_UNKNOWN');
    for (const row of db.state.references.values()) {
      row.expiresAt = new Date(Date.now() - 1000); row.metadata.value.expiresAt = row.expiresAt.toISOString();
    }
    await app.close(); service = createService(); app = await boot();
    restoreLostSubmission = true;
    await background();
    const restored = (await get(`/requests/by-client-id/${body.clientRequestId}`).expect(200)).body;
    expect(restored).toMatchObject({ receiptId: receipt.receiptId, operation: 'video-to-video', execution: {
      requestId: receipt.execution.requestId, taskId: 'original-task', submissionStatus: 'accepted',
    } });
    expect(taskQueries().some(([url]) => String(url).endsWith(`${receipt.execution.requestId}?id_type=request_id`))).toBe(true);
    completeTasks = true; await background();
    const completed = (await get(`/requests/${receipt.receiptId}`).expect(200)).body;
    expect(completed).toMatchObject({ status: 'SUCCEEDED', fileStatus: 'available', billingStatus: 'SETTLED' });
    await app.close(); service = createService(); app = await boot();
    const output = completed.outputs[0];
    expect((await get(`/requests/${receipt.receiptId}/outputs/${output.outputId}/content`).expect(200)).body).toEqual(mp4);
    await post('/requests').send(body).expect(200);
    expect(submissions).toHaveLength(1); expect(billing.settleCompute).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls.filter(([url]) => String(url).endsWith('/videos/references'))).toHaveLength(1);
  });
});
