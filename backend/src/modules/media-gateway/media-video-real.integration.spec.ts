import { Controller, ExecutionContext, Get, INestApplication, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mediaCatalogStub } from '../../../test/stubs/compute-catalog.stub';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { MediaVideoConfigService } from '../media-config/media-video-config.service';
import { MediaVideoRealController } from './media-video-real.controller';
import { MediaVideoRealGuard } from './media-video-real.guard';
import { MediaVideoRealService } from './media-video-real.service';
import { MediaVideoRealStore } from './media-video-real.store';
import { fingerprint, videoClaims, videoRealPrisma } from './media-video-real.test-support';
import { VideoFileCacheService } from './video-file-cache.service';
import { VideoReferenceUploadService } from './video-reference-upload.service';
import { enterpriseMediaStub } from '../../../test/stubs/enterprise-media.stub';

const run = promisify(execFile);

class VideoRealIntegrationState {
  readonly db = videoRealPrisma();
  readonly config = { get: (key: string) => key === 'MEDIA_VIDEO_REAL_ENABLED' ? 'true' : 'test' };
  readonly runtime = new MediaVideoConfigService(this.db as never, {} as never, this.config as never,
    mediaCatalogStub() as never, undefined, undefined, undefined, { getMediaConnection: async () => ({
      baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic', source: 'environment',
    }) } as never);
  revoked = false;
  readonly submitIds: string[] = [];
  readonly submitted: Array<{ operation: string; referenceCount: number; referenceHashes: string[] }> = [];
  readonly settledIds = new Set<string>();
  bytes: Buffer;

  constructor() {
    this.db.mediaModelProfile['findMany'] = jest.fn(async () => [structuredClone(this.db.state.model)]);
    this.db.enterpriseMember.findFirst.mockImplementation(async () => this.revoked ? null : { departmentId: 'department-1' });
  }
}

// Test-only controls are never registered in the application module.
@Controller('__test/video')
@UseGuards(ClientEmploymentGuard)
class VideoRealIntegrationController {
  constructor(private readonly state: VideoRealIntegrationState) {}
  @Get('runtime') runtime() { return this.state.runtime.getRuntimeVideo(videoClaims.enterpriseId); }
  @Post('revoke') revoke() {
    this.state.revoked = true;
    this.state.db.state.enterprise.mediaPolicy.video.enabledProfileIds = [];
    return { revoked: true };
  }
  @Post('restore') restore() {
    this.state.revoked = false;
    this.state.db.state.enterprise.mediaPolicy.video.enabledProfileIds = ['real-h3'];
    return { revoked: false };
  }
}

const acceptance = process.env.SEP_VIDEO_V2_CLIENT_INTEGRATION === 'true' ? describe : describe.skip;
acceptance('real-mode video HTTP, cache and Electron host integration (synthetic upstream, identity and billing)', () => {
  let app: INestApplication;
  let directory: string;
  let previousCache: string | undefined;
  let state: VideoRealIntegrationState;

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'sep-video-real-http-')));
    previousCache = process.env.MEDIA_VIDEO_CACHE_DIR;
    process.env.MEDIA_VIDEO_CACHE_DIR = join(directory, 'cache');
    state = new VideoRealIntegrationState();
    const recorded = process.env.SEP_VIDEO_V2_TEST_SOURCE_FILE;
    const source = recorded ? await realpath(recorded) : join(directory, 'synthetic.mp4');
    if (recorded) {
      const info = await stat(source);
      if (!info.isFile() || info.size < 12 || info.size > 256 * 1024 * 1024) throw new Error('Invalid recorded video fixture');
    } else {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=1344x768:r=24',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '4.458333', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source], { timeout: 30_000 });
    }
    state.bytes = await readFile(source);
    const cache = new VideoFileCacheService();
    await cache.assertAvailable();
    const store = new MediaVideoRealStore(state.db as never);
    const adapter = {
      connection: async () => ({ base: 'https://synthetic.invalid/v1', key: 'synthetic', fingerprint }),
      pricing: async (_connection, input) => ({ model: 'minimax-h3', operation: input.operation, resolution: '720p',
        duration_seconds: 4, pricing_status: 'quoted', amount_usd: null, amount_cny: '1.400000', quote_id: 'synthetic-v1', pricing_version: 'synthetic-v1',
        expires_at: new Date(Date.now() + 60_000).toISOString() }),
      submit: async (_connection, input, _model, references: Buffer[], clientId) => {
        state.submitIds.push(clientId);
        state.submitted.push({ operation: input.operation, referenceCount: input.referenceIds.length,
          referenceHashes: references.map(bytes => createHash('sha256').update(bytes).digest('hex')) });
        return { taskId: `task-${clientId}`, requestId: `client:${clientId}`, status: 'queued' };
      },
      query: async (_connection, taskId) => ({ id: taskId, model: 'minimax-h3', status: 'completed' }),
      rawContent: async () => new Response(new Uint8Array(state.bytes), { headers: { 'Content-Type': 'video/mp4' } }),
      usage: async (_connection, requestId) => ({ request_id: requestId, status: 'settled', model: 'minimax-h3',
        actual_cost_usd: '0.1', video_count: 1, duration_seconds: 4, resolution: '720p' }),
    };
    const billing = {
      quoteFunding: async () => ({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' }),
      reserve: async (_claims, receiptId) => {
        state.db.state.reservations.set(receiptId, { receiptId, status: 'RESERVED', updatedAt: new Date() });
      },
      status: async receiptId => state.db.state.reservations.get(receiptId)?.status ?? 'RESERVED',
      release: async receiptId => { state.db.state.reservations.get(receiptId).status = 'RELEASED'; },
      settleCompute: async (receiptId) => {
        state.settledIds.add(receiptId);
        Object.assign(state.db.state.reservations.get(receiptId), { status: 'SETTLED', settledCny: '0.700000' });
        return 'SETTLED';
      },
    };
    const enterprise = enterpriseMediaStub('https://synthetic.invalid/v1', 'synthetic', fingerprint, '0.700000');
    const service = new MediaVideoRealService(state.config as never, state.db as never,
      { getEffectiveValue: async () => '7' } as never, state.runtime, adapter as never, cache, billing as never, store,
      enterprise.connections as never, enterprise.media as never);
    const module = await Test.createTestingModule({ controllers: [MediaVideoRealController, VideoRealIntegrationController],
      providers: [MediaVideoRealGuard, { provide: MediaVideoRealService, useValue: service }, { provide: VideoReferenceUploadService, useValue: {} },
        { provide: VideoRealIntegrationState, useValue: state }],
    }).overrideGuard(ClientEmploymentGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      if (req.headers['x-test-auth'] !== 'yes') throw new UnauthorizedException();
      req.clientEmployment = videoClaims;
      return true;
    } }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
  }, 45_000);

  afterAll(async () => {
    await app?.close();
    if (previousCache === undefined) delete process.env.MEDIA_VIDEO_CACHE_DIR;
    else process.env.MEDIA_VIDEO_CACHE_DIR = previousCache;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(['text-to-video', 'image-to-video'] as const)('%s saves verified bytes and restores original identities across the actual desktop host and HTTP adapter', async operation => {
    const previousSubmits = state.submitIds.length;
    const previousSettled = state.settledIds.size;
    const clientRoot = resolve(process.env.SEP_VIDEO_TEST_CLIENT_ROOT ?? resolve(__dirname, '../../../../../sep-client'));
    const base = `${await app.getUrl()}/api`;
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import {runVideoV2Http} from './scripts/test-video-v2-http.ts'; runVideoV2Http().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});"], {
      cwd: clientRoot, timeout: 60_000,
      env: { ...process.env, SEP_BASE_URL: base, SEP_VIDEO_V2_TEST_BASE_URL: base, SEP_VIDEO_V2_TEST_OPERATION: operation },
    });
    const evidence = JSON.parse(stdout.trim());
    expect(evidence).toMatchObject({ mock: false, realModels: false, realBilling: false,
      syntheticScope: true, operation, saveStatus: 'SAVED', originalReceiptRestored: true,
      referenceUploadApproved: operation === 'image-to-video' });
    expect(evidence.byteLength).toBe(state.bytes.length);
    expect(evidence.sha256).toBe(createHash('sha256').update(state.bytes).digest('hex'));
    expect(new Set(state.submitIds).size).toBe(state.submitIds.length);
    expect(state.submitIds.length - previousSubmits).toBe(1);
    expect(state.settledIds.size - previousSettled).toBe(1);
    const submitted = state.submitted[previousSubmits];
    expect(submitted.operation).toBe(operation);
    expect(submitted.referenceCount).toBe(operation === 'image-to-video' ? 1 : 0);
    expect(submitted.referenceHashes).toHaveLength(submitted.referenceCount);
    if (operation === 'image-to-video') {
      const request = [...state.db.state.requests.values()].find(row => row.clientRequestId === state.submitIds[previousSubmits]);
      expect(request.referenceHashes).toEqual(submitted.referenceHashes);
    }
  }, 65_000);
});
