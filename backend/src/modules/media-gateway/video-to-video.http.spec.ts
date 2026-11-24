import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
import { videoClaims, videoRealPrisma } from './media-video-real.test-support';
import { Sub2apiVideoAdapter } from './sub2api-video.adapter';
import { VideoFileCacheService } from './video-file-cache.service';
import { VideoReferenceUploadService } from './video-reference-upload.service';

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
  let nextUpload: { status: number; body: unknown; headers?: Record<string, string> } | undefined;
  let generationLost = false;
  let completeTasks = false;
  let nextReference = 0;
  let key = 'synthetic-video-reference-secret';
  const uploaded = new Map<string, Buffer>();
  const submissions: Array<{ body: any; headers: Headers }> = [];
  const billing = { quoteFunding: jest.fn(async () => ({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' })),
    reserve: jest.fn(async (_claims, id) => { db.state.reservations.set(id, { receiptId: id, status: 'RESERVED' }); }),
    status: jest.fn(async id => db.state.reservations.get(id)?.status ?? 'RESERVED'), release: jest.fn(),
    settleNegotiated: jest.fn(async id => { db.state.reservations.get(id).status = 'SETTLED'; return 'SETTLED'; }) };
  const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json', ...headers } });
  const get = (path: string) => request(app.getHttpServer()).get(prefix + path).set('x-test-auth', 'yes');
  const post = (path: string) => request(app.getHttpServer()).post(prefix + path).set('x-test-auth', 'yes');
  const upload = (bytes: Buffer = mp4, mimeType = 'video/mp4') => post('/video-references?profileId=real-h3&configVersion=cfg-real-h3')
    .attach('file', bytes, { filename: 'untrusted-name.bin', contentType: mimeType });
  const input = (ids: string[]) => ({ protocolVersion: 3, specRevision: 1, profileId: 'real-h3', configVersion: 'cfg-real-h3',
    operation: 'video-to-video', creativeBrief: 'Retain camera movement', referenceIds: [], videoReferenceIds: ids,
    requestedSpec: { durationSeconds: 1, resolution: '90p', aspectRatio: '16:9', audio: false, frameRate: 30, outputFormat: 'video/mp4' } });

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
    adapter = new Sub2apiVideoAdapter(settings as never);
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
        return json({ object: 'sub2api.video_pricing', schema_version: 1, currency: 'USD', ...dimensions,
          billing_mode: 'video', pricing_status: 'quoted', pricing_source: 'customer_video_contract', pricing_authority: 'sub2api_customer_billing',
          amount_usd: '0.2', pricing_version: 'price-video', effective_rate_multiplier: 1, observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString() });
      }
      if (url.endsWith('/videos')) {
        submissions.push({ body: JSON.parse(init.body as string), headers });
        if (generationLost) throw new Error('Synthetic lost generation response');
        return json({ object: 'video', id: 'original-task', model: modelId, status: 'queued' }, 200,
          { 'X-Client-Request-ID': headers.get('X-Client-Request-ID') });
      }
      if (url.endsWith('/videos/original-task')) return json({ object: 'video', id: 'original-task', model: modelId, status: completeTasks ? 'completed' : 'in_progress' });
      if (url.endsWith('/videos/original-task/content')) return new Response(new Uint8Array(mp4), { headers: { 'content-type': 'video/mp4' } });
      if (url.includes('/sub2api/videos/usage?')) return json({ object: 'sub2api.video_request_usage', schema_version: 1,
        currency: 'USD', request_id: new URL(url).searchParams.get('request_id'), status: 'settled', model: modelId,
        actual_cost_usd: '0.2', video_count: 1, duration_seconds: 1, resolution: '90p' });
      throw new Error(`Unexpected synthetic compute request: ${new URL(url).pathname}`);
    });
    const files = new VideoFileCacheService(); await files.assertAvailable();
    const runtime = new MediaVideoConfigService(db as never, {} as never, config as never, adapter, files, undefined, settings as never);
    store = new MediaVideoRealStore(db as never);
    service = new MediaVideoRealService(config as never, db as never, settings as never, runtime, adapter, files, billing as never, store);
    uploads = new VideoReferenceUploadService({ redis: { eval: async () => 1, zrem: jest.fn(async () => 1) } } as never);
    const module = await Test.createTestingModule({ controllers: [MediaVideoRealController], providers: [MediaVideoRealGuard,
      { provide: MediaVideoRealService, useValue: service }, { provide: VideoReferenceUploadService, useValue: uploads }],
    }).overrideGuard(ClientEmploymentGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest(); if (req.headers['x-test-auth'] !== 'yes') throw new UnauthorizedException();
      req.clientEmployment = videoClaims; return true;
    } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
  }, 60_000);
  afterEach(() => { nextUpload = undefined; generationLost = false; completeTasks = false; });
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
    await post('/requests').send(body).expect(502);
    const recovered = await post('/requests').send(body).expect(202);
    expect(recovered.body.status).toBe('SUBMISSION_UNKNOWN'); expect(submissions).toHaveLength(before + 1);
    await post('/requests').send({ ...body, creativeBrief: 'Different request' }).expect(409);
  });
});
