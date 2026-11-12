import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
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

const run = promisify(execFile);
const prefix = '/api/gateway/v1/media/video-real';
const modelId = 'future-video-native';
const profileId = 'real-h3';
const input = { protocolVersion: 3, profileId, configVersion: 'cfg-real-h3',
  operation: 'text-to-video', referenceIds: [], creativeBrief: 'Synthetic product scene', specRevision: 1,
  requestedSpec: { durationSeconds: 2, resolution: '90p', width: 90, height: 160, aspectRatio: '9:16',
    frameRate: 30, audio: false, outputFormat: 'video/mp4' }, parameterSources: { audio: 'user', durationSeconds: 'model' } };

describe('V3 HTTP with production video adapter, cache and fake upstream', () => {
  let app: INestApplication;
  let directory: string;
  let previousCache: string | undefined;
  let db: ReturnType<typeof videoRealPrisma>;
  let upstream: jest.SpyInstance;
  let matchedBytes: Buffer;
  let mismatchedBytes: Buffer;
  const submissions: Array<{ fields: Record<string, unknown>; clientId: string }> = [];
  const settlements = new Map<string, string>();
  const taskSpecs = new Map<string, Record<string, unknown>>();
  const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value),
    { headers: { 'Content-Type': 'application/json', ...headers } });

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'sep-media-v3-')));
    previousCache = process.env.MEDIA_VIDEO_CACHE_DIR;
    process.env.MEDIA_VIDEO_CACHE_DIR = join(directory, 'cache');
    for (const seconds of [2, 15]) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=90x160:r=30',
        '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', join(directory, `${seconds}.mp4`)], { timeout: 30_000 });
    }
    matchedBytes = await readFile(join(directory, '2.mp4'));
    mismatchedBytes = await readFile(join(directory, '15.mp4'));
    db = videoRealPrisma();
    db.state.model.modelId = modelId;
    db.mediaModelProfile['findMany'] = jest.fn(async () => [structuredClone(db.state.model)]);
    const config = { get: (key: string) => key === 'MEDIA_VIDEO_REAL_ENABLED' ? 'true' : 'test' };
    const settings = { getMediaConnection: async () => ({
      baseUrl: 'https://fake-upstream.invalid/v1', apiKey: 'synthetic-test-key', source: 'environment',
    }), getEffectiveValue: async () => '7' };
    const adapter = new Sub2apiVideoAdapter(settings as never);
    upstream = jest.spyOn(globalThis, 'fetch').mockImplementation(async (target, options) => {
      const url = new URL(String(target));
      if (url.origin !== 'https://fake-upstream.invalid') throw new Error('Unexpected upstream destination');
      if (url.pathname === '/v1/sub2api/videos/pricing') {
        const spec = JSON.parse(String(options?.body));
        return json({ object: 'sub2api.video_pricing', schema_version: 1, currency: 'USD',
          ...spec, billing_mode: 'video', pricing_status: 'quoted', pricing_source: 'group',
          pricing_authority: 'sub2api_customer_billing', amount_usd: '0.2', pricing_version: 'synthetic-v3',
          effective_rate_multiplier: 1, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
      }
      if (url.pathname === '/v1/videos' && options?.method === 'POST') {
        const fields = JSON.parse(String(options.body));
        const clientId = new Headers(options.headers).get('X-Client-Request-ID')!;
        expect(new Headers(options.headers).get('X-Video-Pricing-Version')).toBe('synthetic-v3');
        const taskId = `task-${clientId}`;
        submissions.push({ fields, clientId });
        taskSpecs.set(taskId, fields);
        return json({ object: 'video', id: taskId, model: modelId, status: 'queued' }, { 'x-client-request-id': clientId });
      }
      if (/^\/v1\/videos\/task-[A-Za-z0-9_-]+$/.test(url.pathname)) {
        return json({ object: 'video', id: url.pathname.split('/').pop(), model: modelId, status: 'completed' });
      }
      if (url.pathname.endsWith('/content')) {
        const task = taskSpecs.get(url.pathname.split('/').at(-2)!);
        return new Response(new Uint8Array(task?.seconds === 8 ? mismatchedBytes : matchedBytes),
          { headers: { 'Content-Type': 'video/mp4' } });
      }
      if (url.pathname === '/v1/sub2api/videos/usage') {
        const requestId = url.searchParams.get('request_id')!;
        const task = taskSpecs.get(`task-${requestId.replace(/^client:/, '')}`)!;
        return json({ object: 'sub2api.video_request_usage', schema_version: 1, currency: 'USD',
          request_id: requestId, status: 'settled', model: modelId, actual_cost_usd: '0.1',
          video_count: 1, duration_seconds: task.seconds, resolution: task.resolution });
      }
      throw new Error(`Unexpected fake upstream path: ${url.pathname}`);
    });
    const cache = new VideoFileCacheService();
    await cache.assertAvailable();
    const runtime = new MediaVideoConfigService(db as never, {} as never, config as never, adapter, cache, undefined, settings as never);
    const billing = { quoteFunding: async () => ({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' }),
      reserve: async (_claims: unknown, id: string) => { db.state.reservations.set(id, { receiptId: id, status: 'RESERVED' }); },
      status: async (id: string) => db.state.reservations.get(id)?.status ?? 'RESERVED',
      release: jest.fn(async (id: string) => { db.state.reservations.get(id).status = 'RELEASED'; }),
      settleNegotiated: async (id: string, actualCny: string, _usd: string, verifiedModel: string, frozenModel: string) => {
        expect(verifiedModel).toBe(modelId); expect(frozenModel).toBe(modelId);
        settlements.set(id, actualCny); db.state.reservations.get(id).status = 'SETTLED'; return 'SETTLED';
      } };
    const service = new MediaVideoRealService(config as never, db as never, settings as never, runtime, adapter, cache,
      billing as never, new MediaVideoRealStore(db as never));
    const module = await Test.createTestingModule({ controllers: [MediaVideoRealController],
      providers: [MediaVideoRealGuard, { provide: MediaVideoRealService, useValue: service }],
    }).overrideGuard(ClientEmploymentGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      if (req.headers['x-test-auth'] !== 'yes') throw new UnauthorizedException();
      req.clientEmployment = videoClaims; return true;
    } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
  }, 60_000);

  afterAll(async () => {
    upstream?.mockRestore(); await app?.close();
    if (previousCache === undefined) delete process.env.MEDIA_VIDEO_CACHE_DIR;
    else process.env.MEDIA_VIDEO_CACHE_DIR = previousCache;
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const get = (path: string) => request(app.getHttpServer()).get(prefix + path).set('x-test-auth', 'yes');
  const post = (path: string, value: object) => request(app.getHttpServer()).post(prefix + path).set('x-test-auth', 'yes').send(value);

  it('negotiates unknown-model hints and delivers non-default specs without an extra dispatch on replay', async () => {
    const runtime = await get('/profiles?protocolVersion=3').expect(200);
    expect(runtime.body).toMatchObject({ protocolVersion: 3, profiles: [
      { profileId, authorized: true, adapter: { available: true } },
    ] });
    expect(JSON.stringify(runtime.body)).not.toContain('defaults');
    const quote = await post('/quotes', input).expect(result => expect(result.body.error).toBeUndefined()).expect(201);
    expect(quote.body).toMatchObject({ protocolVersion: 3, effectiveSpec: input.requestedSpec });
    const submitted = await post('/requests', { ...input, quoteId: quote.body.quoteId, clientRequestId: 'v3-complete' }).expect(202);
    expect(submissions.at(-1)?.fields).toMatchObject({ model: modelId, seconds: 2, resolution: '90p',
      size: '90x160', aspect_ratio: '9:16', generate_audio: false, output_format: 'video/mp4' });
    expect(submissions.at(-1)?.fields).not.toHaveProperty('fps');
    const done = await get(`/requests/${submitted.body.receiptId}`).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', deliveryStatus: 'matched',
      actualSpec: { durationSeconds: 2, width: 90, height: 160, frameRate: 30, hasAudio: false } });
    expect(settlements.get(done.body.receiptId)).toBe('0.700000');
    const content = await get(`/requests/${done.body.receiptId}/outputs/${done.body.outputs[0].outputId}/content`).expect(200);
    expect(content.headers['x-sha256']).toBe(createHash('sha256').update(matchedBytes).digest('hex'));
    expect(content.body).toEqual(matchedBytes);
    const count = submissions.length;
    await post('/requests', { ...input, quoteId: quote.body.quoteId, clientRequestId: 'v3-complete' }).expect(200);
    expect(submissions).toHaveLength(count);
    await post('/requests', { ...input, specRevision: 2, quoteId: quote.body.quoteId, clientRequestId: 'v3-complete' }).expect(409);
  });

  it('delivers the measured frame rate when the upstream cannot honor requested fps', async () => {
    const value = { ...input, requestedSpec: { ...input.requestedSpec, frameRate: 24 } };
    const quote = await post('/quotes', value).expect(201);
    const submitted = await post('/requests', { ...value, quoteId: quote.body.quoteId, clientRequestId: 'v3-native-fps' }).expect(202);
    expect(submissions.at(-1)?.fields).not.toHaveProperty('fps');
    const done = await get(`/requests/${submitted.body.receiptId}`).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', deliveryStatus: 'matched',
      errorCode: null, effectiveSpec: { frameRate: 24 }, actualSpec: { frameRate: 30 },
      outputs: [{ frameRate: 30 }], recovery: { canDownload: true } });
    const content = await get(`/requests/${done.body.receiptId}/outputs/${done.body.outputs[0].outputId}/content`).expect(200);
    expect(content.body).toEqual(matchedBytes);
  });

  it('retains a measured 15-second original for an 8-second request while independently settling frozen billing dimensions', async () => {
    const value = { ...input, requestedSpec: { ...input.requestedSpec, durationSeconds: 8 } };
    const quote = await post('/quotes', value).expect(result => expect(result.body.error).toBeUndefined()).expect(201);
    const submitted = await post('/requests', { ...value, quoteId: quote.body.quoteId, clientRequestId: 'v3-mismatch' }).expect(202);
    const done = await get(`/requests/${submitted.body.receiptId}`).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', errorCode: 'OUTPUT_SPEC_MISMATCH', billingStatus: 'SETTLED',
      deliveryStatus: 'mismatched', effectiveSpec: { durationSeconds: 8 }, actualSpec: { durationSeconds: 15 },
      recovery: { canDownload: true } });
    const content = await get(`/requests/${done.body.receiptId}/outputs/${done.body.outputs[0].outputId}/content`).expect(200);
    expect(content.body).toEqual(mismatchedBytes);
  });

  it('keeps a silent original downloadable when the requested audio track is missing', async () => {
    const value = { ...input, requestedSpec: { ...input.requestedSpec, audio: true } };
    const quote = await post('/quotes', value).expect(201);
    const submitted = await post('/requests', { ...value, quoteId: quote.body.quoteId, clientRequestId: 'v3-audio-mismatch' }).expect(202);
    const done = await get(`/requests/${submitted.body.receiptId}`).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', deliveryStatus: 'mismatched', errorCode: 'OUTPUT_SPEC_MISMATCH',
      billingStatus: 'SETTLED', actualSpec: { hasAudio: false }, recovery: { canDownload: true } });
    const content = await get(`/requests/${done.body.receiptId}/outputs/${done.body.outputs[0].outputId}/content`).expect(200);
    expect(content.body).toEqual(matchedBytes);
  });

  it('rejects missing billable specs and contradictions without an upstream generation POST', async () => {
    const count = submissions.length;
    const missing = await post('/quotes', { ...input, requestedSpec: { audio: false } });
    expect(missing.body.error).toMatchObject({ code: 'MISSING_SPEC', source: 'adapter', submissionState: 'not_submitted' });
    expect(missing.status).toBe(422);
    const conflict = await post('/quotes', { ...input, requestedSpec: { ...input.requestedSpec, aspectRatio: '16:9' } }).expect(400);
    expect(conflict.body.error).toMatchObject({ code: 'SPEC_CONFLICT', source: 'request', submissionState: 'not_submitted' });
    expect(submissions).toHaveLength(count);
  });

  it('keeps omitted optional fields absent from submission and exposes unknown named resolution acceptance', async () => {
    const value = { ...input, requestedSpec: { durationSeconds: 2, resolution: 'native-portrait' } };
    const quote = await post('/quotes', value).expect(201);
    const submitted = await post('/requests', { ...value, quoteId: quote.body.quoteId, clientRequestId: 'v3-omitted' }).expect(202);
    expect(submissions.at(-1)?.fields).toEqual({ model: modelId, prompt: input.creativeBrief, seconds: 2, resolution: 'native-portrait' });
    const done = await get('/requests/' + submitted.body.receiptId).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', deliveryStatus: 'unknown', billingStatus: 'SETTLED' });
  });

  it('does not hide a measured duration mismatch when audio was unspecified', async () => {
    const value = { ...input, requestedSpec: { durationSeconds: 8, resolution: '90p' } };
    const quote = await post('/quotes', value).expect(201);
    const submitted = await post('/requests', { ...value, quoteId: quote.body.quoteId, clientRequestId: 'v3-omitted-audio-mismatch' }).expect(202);
    const done = await get('/requests/' + submitted.body.receiptId).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', deliveryStatus: 'mismatched', errorCode: 'OUTPUT_SPEC_MISMATCH',
      billingStatus: 'SETTLED', recovery: { canDownload: true } });
  });

  it('rejects an output format without a safe parser before upstream pricing or submission', async () => {
    const calls = upstream.mock.calls.length;
    const unsupported = await post('/quotes', { ...input, requestedSpec: { ...input.requestedSpec, outputFormat: 'video/webm' } }).expect(422);
    expect(unsupported.body.error).toMatchObject({ code: 'ADAPTER_FIELD_UNMAPPED', field: 'requestedSpec.outputFormat',
      source: 'adapter', stage: 'quote', submissionState: 'not_submitted', billingState: 'not_reserved' });
    expect(upstream.mock.calls).toHaveLength(calls);
  });
});
