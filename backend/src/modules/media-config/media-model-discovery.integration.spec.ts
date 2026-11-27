import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { MediaRuntimeSchema, MediaVideoRuntimeSchema } from 'shared';
import { MediaConfigService } from './media-config.service';
import { MediaVideoConfigService } from './media-video-config.service';
import { MediaModelSyncService, mediaConnectionFingerprint } from './media-model-sync.service';
import { mediaCatalogStub } from '../../../test/stubs/compute-catalog.stub';

function setup() {
  let rows: any[] = [];
  let policy: any = {};
  let real = false;
  let connection = { baseUrl: 'https://relay.example/v1', apiKey: 'test-only-key', source: 'environment' };
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
  const prisma: any = {
    mediaModelProfile: {
      findMany: jest.fn(async ({ where }) => rows.filter(row => matches(row, where))),
      findUnique: jest.fn(async ({ where }) => rows.find(row => matches(row, where)) ?? null),
      create: jest.fn(async ({ data }) => {
        const row = { id: `row-${rows.length}`, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(data) };
        rows.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const found = rows.filter(row => matches(row, where));
        for (const row of found) Object.assign(row, structuredClone(data));
        return { count: found.length };
      }),
    },
    enterpriseModelConfig: {
      findUnique: jest.fn(async () => ({ mediaPolicy: policy })),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(async fn => {
      const before = structuredClone(rows);
      try { return await fn(prisma); } catch (error) { rows = before; throw error; }
    }),
  };
  const settings: any = { getMediaConnection: jest.fn(async () => ({ ...connection })) };
  const config: any = { get: jest.fn(key => key === 'NODE_ENV' ? 'production'
    : ['MEDIA_VIDEO_REAL_ENABLED', 'MEDIA_GATEWAY_REAL_ENABLED'].includes(key) ? String(real) : undefined) };
  const context: any = { resolve: jest.fn(async () => ({ enterpriseId: 'ent-1', role: 'ENTERPRISE_ADMIN' })) };
  const imageAdapter: any = {
    discoverModels: jest.fn(async () => [{ modelId: 'gpt-image-2', displayName: 'Image 2' }, { modelId: 'language-only', displayName: 'Language' }]),
    pricing: jest.fn(), execute: jest.fn(),
  };
  const videoAdapter: any = {
    connection: jest.fn(async () => ({ base: connection.baseUrl, key: connection.apiKey, fingerprint: mediaConnectionFingerprint(connection) })),
    discover: jest.fn(async () => [{ modelId: 'minimax-h3', displayName: 'H3' }, { modelId: 'language-only', displayName: 'Language' }]),
    pricing: jest.fn(), submit: jest.fn(),
  };
  const files: any = { assertAvailable: jest.fn() };
  const sync = new MediaModelSyncService(prisma, settings);
  const catalog = mediaCatalogStub();
  return {
    image: new MediaConfigService(prisma, settings, context, catalog as any, config, imageAdapter, sync),
    video: new MediaVideoConfigService(prisma, context, config, catalog as any, videoAdapter, files, sync, settings),
    rows: () => rows, prisma, imageAdapter, videoAdapter, files,
    authorize: (value: unknown) => { policy = value; }, enable: () => { real = true; },
    replaceConnection: () => { connection = { ...connection, apiKey: 'other-test-key' }; },
  };
}

describe('automatic media discovery → stored contract → authorized runtime (in-memory DB, no network)', () => {
  it('creates image capabilities without CRUD or pricing and never grants enterprise permissions implicitly', async () => {
    const f = setup();
    f.enable();
    await f.image.discoverModels();
    expect(f.rows()).toHaveLength(1);
    const row = f.rows()[0];
    expect(row).toMatchObject({ profileId: expect.stringMatching(/^auto-image-/), enabled: false, verified: false });
    expect(await f.image.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, profiles: [], tools: [] });
    expect(f.prisma.enterpriseModelConfig.upsert).not.toHaveBeenCalled();
    f.authorize({ enabledProfileIds: [row.profileId], defaultProfileId: row.profileId, maxOutputs: 2 });
    expect(await f.image.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, profiles: [] });
    f.imageAdapter.pricing.mockResolvedValue({ currency: 'CNY', amount_cny: '0.280000' });
    await f.image.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion });
    await f.image.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion, enabled: true });
    const runtime = await f.image.getRuntimeMedia('ent-1');
    expect(MediaRuntimeSchema.safeParse(runtime).success).toBe(true);
    expect(runtime).toMatchObject({ executionAvailable: true, defaultProfileId: row.profileId,
      profiles: [{ capabilities: { maxOutputs: 1 } }] });
    const before = structuredClone(f.rows());
    await f.image.discoverModels();
    expect(f.rows()).toEqual(before);
    expect(f.imageAdapter.pricing).toHaveBeenCalled();
    expect(f.imageAdapter.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(runtime)).not.toMatch(/test-only-key|relay\.example|gpt-image-2/);
  });

  it('detects video with execution closed and enables tools only after both authorization and the explicit switch', async () => {
    const f = setup();
    expect(await f.video.discoverModels()).toMatchObject({ mock: false, executionTested: false });
    expect(f.rows()).toHaveLength(1);
    const row = f.rows()[0];
    expect(row).toMatchObject({ kind: 'video', modelId: 'minimax-h3', enabled: false, verified: false });
    f.authorize({ video: { enabledProfileIds: [row.profileId], defaultProfileId: row.profileId,
      allowedOperations: ['text-to-video', 'image-to-video'], maxDurationSeconds: 4, allowedAspectRatios: ['16:9'] } });
    expect(await f.video.getRuntimeVideo('ent-1')).toMatchObject({ executionAvailable: false, profiles: [] });
    f.enable();
    expect(await f.video.getRuntimeVideo('ent-1')).toMatchObject({ executionAvailable: false, profiles: [] });
    f.videoAdapter.pricing.mockResolvedValue({ currency: 'CNY', amount_cny: '0.840000' });
    await f.video.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion });
    await f.video.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion, enabled: true });
    const runtime = await f.video.getRuntimeVideo('ent-1');
    expect(MediaVideoRuntimeSchema.safeParse(runtime).success).toBe(true);
    expect(runtime).toMatchObject({ executionAvailable: true, executionMode: 'real', defaultProfileId: row.profileId,
      tools: ['video_from_image', 'video_generate', 'video_get_job'] });
    expect(f.videoAdapter.pricing).toHaveBeenCalledTimes(2);
    expect(f.videoAdapter.submit).not.toHaveBeenCalled();
    expect(f.files.assertAvailable).toHaveBeenCalledTimes(2);
    expect(f.prisma.enterpriseModelConfig.upsert).not.toHaveBeenCalled();
  });

  it('rejects a catalog from a superseded connection without storing its model records', async () => {
    const f = setup();
    f.imageAdapter.discoverModels.mockImplementation(async () => {
      f.replaceConnection();
      return [{ modelId: 'gpt-image-2', displayName: 'Image 2' }];
    });
    await expect(f.image.discoverModels()).rejects.toBeInstanceOf(ConflictException);
    expect(f.rows()).toEqual([]);
  });

  it('does not interpret a failed catalog as an empty directory or revoke existing models', async () => {
    const f = setup();
    await f.image.discoverModels();
    const before = structuredClone(f.rows());
    f.imageAdapter.discoverModels.mockRejectedValue(new ServiceUnavailableException());
    await expect(f.image.discoverModels()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.rows()).toEqual(before);
  });
});
