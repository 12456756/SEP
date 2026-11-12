import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateMediaVideoProfileDtoSchema, MediaPolicySchema, MediaRuntimeQuerySchema,
  MediaVideoEnterpriseConfigSchema, MediaVideoModelDiscoverySchema, MediaVideoPolicySchema,
  MediaVideoProfileVerificationSchema, MediaVideoRuntimeSchema, SETTING_KEYS,
  UpdateMediaVideoPolicyDtoSchema, UpdateMediaVideoProfileDtoSchema,
} from 'shared';
import videoFixture from '../../shared/fixtures/media-video-v1.json';
import { MediaConfigService } from './media-config.service';
import { MediaVideoConfigService } from './media-video-config.service';

function setup(real = false) {
  const row: any = { ...structuredClone(videoFixture.profile), modelId: 'mock-video-v1', configVersion: 'cfg_video', enabled: true, verified: true };
  const imagePolicy = { enabledProfileIds: ['product-image'], defaultProfileId: 'product-image',
    allowedOperations: ['generate'], maxOutputs: 2, maxWidth: 1024, maxHeight: 1024 };
  const videoPolicy = MediaVideoPolicySchema.parse({ enabledProfileIds: [row.profileId], defaultProfileId: row.profileId });
  let stored: any = { mediaPolicy: { ...imagePolicy, video: videoPolicy } };
  const prisma: any = {
    mediaModelProfile: {
      findMany: jest.fn(async ({ where }) => [row].filter(value => Object.entries(where ?? {}).every(([key, expected]) => value[key] === expected))),
      findUnique: jest.fn(async () => row),
      create: jest.fn(async ({ data }) => ({ ...row, ...data })),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!Object.entries(where).every(([key, expected]) => row[key] === expected)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      }),
    },
    enterpriseModelConfig: {
      findUnique: jest.fn(async () => stored),
      upsert: jest.fn(async ({ create, update }) => { stored = { ...(stored ?? create), ...update }; return stored; }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(fn => fn(prisma));
  const context: any = {
    resolve: jest.fn(async () => ({ enterpriseId: 'ent-1', role: 'ENTERPRISE_ADMIN' })),
    assertEnterpriseAdmin: jest.fn(value => { if (value.role !== 'ENTERPRISE_ADMIN') throw new ForbiddenException(); }),
  };
  const config: any = { get: jest.fn(key => key === 'MEDIA_VIDEO_REAL_ENABLED' ? real ? 'true' : undefined
    : key === 'NODE_ENV' ? 'test' : 'true') };
  const videoAdapter: any = { connection: jest.fn(async () => ({ fingerprint: 'test' })),
    discover: jest.fn(async () => [{ modelId: 'minimax-h3', displayName: 'H3' }, { modelId: 'minimax-m3', displayName: 'M3' }]),
    pricing: jest.fn(async () => ({ amount_usd: '0.12' })) };
  const videoFiles: any = { assertAvailable: jest.fn(async () => {}) };
  const settings: any = { getEffectiveValue: jest.fn(async key => key === SETTING_KEYS.MEDIA_BASE_URL ? 'https://relay.example/v1' : 'key'),
    getMediaConnection: jest.fn(async () => ({ baseUrl: 'https://video.example/v1', apiKey: 'video-key', source: 'database' })),
    updateMediaConnection: jest.fn() };
  const sync: any = { sync: jest.fn() };
  return { service: new MediaVideoConfigService(prisma, context, config, videoAdapter, videoFiles, sync, settings), videoAdapter, videoFiles, sync, settings,
    imageService: new MediaConfigService(prisma, settings, context),
    prisma, context, config, row, imagePolicy, videoPolicy,
    getStored: () => stored, setStored: (value: any) => { stored = value; } };
}

function createInput(overrides: Record<string, unknown> = {}) {
  const { configVersion: _version, verified: _verified, ...profile } = videoFixture.profile;
  return CreateMediaVideoProfileDtoSchema.parse({ ...profile, modelId: 'mock-video-v1', ...overrides });
}

describe('MediaVideoConfigService real configuration', () => {
  it('ignores retired video limits in V1/V2 runtime and preview while still requiring model authorization', async () => {
    const f = setup(true);
    f.row.modelId = 'minimax-h3';
    f.row.operations = ['image-to-video', 'text-to-video'];
    f.row.capabilities = structuredClone(f.service['realCapabilities']());
    const policy = f.getStored().mediaPolicy.video;
    Object.assign(policy, { allowedOperations: [], maxDurationSeconds: 1,
      allowedAspectRatios: [], maxResolution: 'unknown', maxConcurrentJobs: 1 });
    for (const runtime of [await f.service.getRuntimeVideo('ent-1'), await f.service.getRuntimeVideoV2('ent-1')]) {
      expect(runtime).toMatchObject({ executionAvailable: true, defaultProfileId: f.row.profileId,
        profiles: [{ operations: f.row.operations, capabilities: { durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'] } }] });
    }
    const preview = await f.service.previewEnterpriseConfig('user-1', { policy });
    expect(preview.profiles[0]).toMatchObject({ status: 'effective', reasons: [] });
    policy.maxConcurrentJobs = -1;
    expect((await f.service.getRuntimeVideo('ent-1')).executionAvailable).toBe(true);
    policy.enabledProfileIds = [];
    expect((await f.service.getRuntimeVideo('ent-1')).executionAvailable).toBe(false);
  });

  function realSetup() {
    const f = setup(true);
    f.row.modelId = 'minimax-h3';
    f.row.operations = ['text-to-video', 'image-to-video'];
    Object.assign(f.row.capabilities, { supportsTextToVideo: true, supportsAudio: true,
      durationsSeconds: [4], aspectRatios: ['16:9'] });
    Object.assign(f.getStored().mediaPolicy.video, { allowedOperations: ['text-to-video', 'image-to-video'],
      allowedAspectRatios: ['16:9'], maxDurationSeconds: 4, periodBudget: 10 });
    return f;
  }

  it('verifies and enables an explicitly configured new V3 model with its declared spec', async () => {
    const f = realSetup();
    f.row.modelId = 'new-video-protocol-model';
    f.row.capabilities.durationsSeconds = [1200];
    f.row.capabilities.resolutions = ['1440p'];
    f.row.capabilities.frameRates = [144];
    f.row.enabled = false; f.row.verified = false;
    f.videoAdapter.discover.mockResolvedValue([{ modelId: f.row.modelId, displayName: 'New' }]);
    await expect(f.service.verifyProfile(f.row.profileId, { expectedConfigVersion: f.row.configVersion }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(f.videoAdapter.pricing).not.toHaveBeenCalled();
    expect(await f.service.verifyProfile(f.row.profileId, { expectedConfigVersion: f.row.configVersion,
      verificationSpec: { durationSeconds: 1200, resolution: '1440p', frameRate: 144, audio: false } }))
      .toMatchObject({ profile: { verified: true, enabled: false }, executionTested: false });
    expect(f.videoAdapter.pricing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ protocolVersion: 3,
      requestedSpec: expect.objectContaining({ durationSeconds: 1200, resolution: '1440p' }) }), f.row.modelId);
    await f.service.updateProfile(f.row.profileId, { expectedConfigVersion: f.row.configVersion, enabled: true });
    expect((await f.service.getRuntimeVideoV3('ent-1')).executionAvailable).toBe(true);
    expect((await f.service.getRuntimeVideo('ent-1')).executionAvailable).toBe(false);
    expect(await f.service.getAvailableProfiles('user-1')).toEqual([expect.objectContaining({ profileId: f.row.profileId })]);
  });

  it('discovers and synchronizes only exact h3 without generation or pricing calls', async () => {
    const f = realSetup();
    expect(await f.service.discoverModels()).toMatchObject({ mock: false, executionTested: false,
      models: [{ modelId: 'minimax-h3', compatible: true }, { modelId: 'minimax-m3', compatible: false, suggested: null }] });
    expect(f.prisma.mediaModelProfile.create).not.toHaveBeenCalled();
    expect(f.videoAdapter.pricing).not.toHaveBeenCalled();
    expect(f.sync.sync).toHaveBeenCalledWith('video', [expect.objectContaining({ modelId: 'minimax-h3', autoCreate: true }),
      expect.objectContaining({ modelId: 'minimax-m3', autoCreate: false })], 'test', expect.any(Function));
  });

  it('publishes v3 video authorization, adapter implementation limits, and non-binding hints', async () => {
    const f = realSetup();
    const runtime = await f.service.getRuntimeVideoV3('ent-1');
    expect(runtime).toMatchObject({ protocolVersion: 3, executionMode: 'real', executionAvailable: true,
      tools: ['video_from_image', 'video_generate', 'video_get_job'], profiles: [{
        profileId: f.row.profileId, authorized: true,
        adapter: { id: 'sub2api-video', available: true, supportsTaskQuery: true, supportsCancel: false,
          referenceSupport: { maxCount: 1, maxInputBytes: 10 * 1024 * 1024, mimeTypes: ['image/png'] } },
      }] });
    expect(runtime.profiles[0].capabilityHints).toContainEqual(expect.objectContaining({
      field: 'durationSeconds', values: [4], confidence: 'declared',
    }));
    expect(runtime.profiles[0].capabilityHints).toContainEqual(expect.objectContaining({ field: 'audio', values: [true] }));
    expect(runtime.profiles[0].capabilityHints).not.toContainEqual(expect.objectContaining({ field: 'frameRate' }));
    expect(JSON.stringify(runtime)).not.toContain('defaults');
  });

  it('saves the independent video connection without mutating image settings', async () => {
    const f = realSetup();
    expect(await f.service.getConnection()).toEqual({ configured: true, baseUrl: 'https://video.example/v1', apiKeyConfigured: true, source: 'database' });
    await f.service.updateConnection({ baseUrl: 'https://new-video.example/v1', apiKey: 'new-video-key' });
    expect(f.settings.updateMediaConnection).toHaveBeenCalledWith({ baseUrl: 'https://new-video.example/v1', apiKey: 'new-video-key' }, 'video', undefined);
    expect(f.prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('withholds real video tools for an absent or invalid independent connection', async () => {
    const f = realSetup();
    for (const connection of [
      { baseUrl: '', apiKey: '', source: 'unconfigured' },
      { baseUrl: 'http://video.example', apiKey: 'video-key', source: 'database' },
      { baseUrl: 'https://video.example', apiKey: 'bad key', source: 'database' },
    ]) {
      f.settings.getMediaConnection.mockResolvedValue(connection);
      expect(await f.service.getAvailableProfiles('user')).toEqual([]);
    }
    expect(f.settings.getMediaConnection).toHaveBeenCalledWith('video');
    expect(f.prisma.mediaModelProfile.findMany).not.toHaveBeenCalled();
  });

  it('rejects manual capabilities for automatic video models', async () => {
    const f = realSetup();
    await expect(f.service.updateProfile('auto-video-model', { expectedConfigVersion: 'cfg_video', capabilities: { supportsAudio: false } }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies directory, both operation prices and inspector but never generates', async () => {
    const f = realSetup();
    f.row.enabled = false; f.row.verified = false;
    expect(await f.service.verifyProfile(f.row.profileId, { expectedConfigVersion: f.row.configVersion }))
      .toMatchObject({ mock: false, executionTested: false, profile: { verified: true, enabled: false } });
    expect(f.videoFiles.assertAvailable).toHaveBeenCalledTimes(1);
    expect(f.videoAdapter.pricing).toHaveBeenCalledTimes(2);
    await f.service.updateProfile(f.row.profileId, { expectedConfigVersion: f.row.configVersion, enabled: true });
    expect(await f.service.getRuntimeVideo('ent-1')).toMatchObject({ executionMode: 'real', executionAvailable: true,
      tools: ['video_from_image', 'video_generate', 'video_get_job'] });
  });

  it('fails closed when inspector or actual customer quote is unavailable', async () => {
    const f = realSetup();
    f.videoFiles.assertAvailable.mockRejectedValue(new ServiceUnavailableException());
    await expect(f.service.verifyProfile(f.row.profileId, { expectedConfigVersion: f.row.configVersion })).rejects.toThrow();
    expect(f.prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
    f.videoFiles.assertAvailable.mockResolvedValue(undefined);
    f.videoAdapter.pricing.mockRejectedValue(new ServiceUnavailableException());
    await expect(f.service.verifyProfile(f.row.profileId, { expectedConfigVersion: f.row.configVersion })).rejects.toThrow();
    expect(f.prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('allows explicitly enabled real discovery in production without enabling mock', async () => {
    const f = realSetup();
    f.config.get.mockImplementation(key => key === 'NODE_ENV' ? 'production'
      : key === 'MEDIA_VIDEO_REAL_ENABLED' ? 'true' : undefined);
    expect(await f.service.discoverModels()).toMatchObject({ mock: false, executionTested: false });
    expect(await f.service.getRuntimeVideo('ent-1')).toMatchObject({ executionAvailable: true, executionMode: 'real' });
  });

  it('does not expose mock profiles on real runtime and preserves the independent image policy', async () => {
    const f = setup(true);
    expect(await f.service.getRuntimeVideo('ent-1')).toMatchObject({ executionAvailable: false, profiles: [] });
    expect(await f.service.getEnterpriseConfig('user-1')).toMatchObject({ mock: false, configured: true });
    expect(f.getStored().mediaPolicy).toMatchObject(f.imagePolicy);
  });
});

describe('video configuration shared contracts', () => {
  it('keeps image policy defaults and independently nests a disabled video policy', () => {
    expect(MediaPolicySchema.parse({})).not.toHaveProperty('video');
    expect(MediaPolicySchema.parse({ video: {} })).toMatchObject({ enabledProfileIds: [], video: { enabledProfileIds: [], defaultProfileId: null, periodBudget: 0 } });
    expect(UpdateMediaVideoPolicyDtoSchema.parse({ periodBudget: 12 })).toEqual({ periodBudget: 12 });
    expect(UpdateMediaVideoPolicyDtoSchema.parse({})).toEqual({});
  });

  it('strictly rejects image fields, verification injection, vendor parameters, and missing CAS versions', () => {
    for (const extra of [{ verified: true }, { configVersion: 'cfg_x' }, { vendorPayload: {} }, { apiKey: 'secret' }]) {
      expect(CreateMediaVideoProfileDtoSchema.safeParse({ ...createInput(), ...extra }).success).toBe(false);
    }
    expect(CreateMediaVideoProfileDtoSchema.safeParse({ ...createInput(), operations: ['generate'] }).success).toBe(false);
    expect(CreateMediaVideoProfileDtoSchema.safeParse({ ...createInput(), capabilities: { sizes: ['1024x1024'] } }).success).toBe(false);
    expect(UpdateMediaVideoProfileDtoSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(UpdateMediaVideoProfileDtoSchema.safeParse({ expectedConfigVersion: 'cfg_x' }).success).toBe(false);
    expect(UpdateMediaVideoPolicyDtoSchema.safeParse({ enterpriseId: 'other' }).success).toBe(false);
    expect(UpdateMediaVideoPolicyDtoSchema.safeParse({ periodBudget: -1 }).success).toBe(false);
    expect(UpdateMediaVideoPolicyDtoSchema.safeParse({ maxConcurrentJobs: 0 }).success).toBe(false);
    expect(UpdateMediaVideoPolicyDtoSchema.parse({ maxConcurrentJobs: Number.MAX_SAFE_INTEGER, maxResolution: '8k', allowedOperations: [] }))
      .toEqual({ maxConcurrentJobs: Number.MAX_SAFE_INTEGER, maxResolution: '8k', allowedOperations: [] });
  });

  it('negotiates video independently and rejects malformed video queries', () => {
    expect(MediaRuntimeQuerySchema.parse({ videoProtocolVersion: '1' })).toEqual({ videoProtocolVersion: 1 });
    expect(MediaRuntimeQuerySchema.parse({ mediaProtocolVersion: '1', videoProtocolVersion: '2', skillArtifactProtocolVersion: '1' }))
      .toEqual({ mediaProtocolVersion: 1, videoProtocolVersion: 2, skillArtifactProtocolVersion: 1 });
    for (const value of ['', 'bad', '0', '-1', '1.5', ['1', '2'], 'Infinity']) {
      expect(MediaRuntimeQuerySchema.safeParse({ videoProtocolVersion: value }).success).toBe(false);
    }
  });
});

describe('MediaVideoConfigService profiles (mock only)', () => {
  it('filters listing by video and does not feed video rows to the image profile parser', async () => {
    const { service, imageService, prisma } = setup();
    expect(await service.listProfiles()).toHaveLength(1);
    expect(await imageService.listProfiles()).toEqual([]);
    expect(prisma.mediaModelProfile.findMany).toHaveBeenNthCalledWith(1, { where: { kind: 'video' }, orderBy: { createdAt: 'asc' } });
    expect(prisma.mediaModelProfile.findMany).toHaveBeenNthCalledWith(2, { where: { kind: 'image' }, orderBy: { createdAt: 'asc' } });
  });

  it('allows importing arbitrary real models as disabled/unverified without contacting upstream', async () => {
    const { service, prisma } = setup();
    expect(await service.createProfile(createInput({ modelId: 'real-vendor-video' }))).toMatchObject({ modelId: 'real-vendor-video', enabled: false, verified: false, configVersion: expect.stringMatching(/^cfg_/) });
    expect(prisma.mediaModelProfile.create).toHaveBeenCalledTimes(1);
  });

  it('rejects pre-enabled creation and translates duplicate IDs to conflict', async () => {
    const { service, prisma } = setup();
    await expect(service.createProfile(createInput({ enabled: true }))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.mediaModelProfile.create).not.toHaveBeenCalled();
    prisma.mediaModelProfile.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }));
    await expect(service.createProfile(createInput())).rejects.toBeInstanceOf(ConflictException);
  });

  it('verifies only configuration, rotates CAS version, and explicitly disclaims execution', async () => {
    const { service, row } = setup();
    row.enabled = false; row.verified = false;
    const result = await service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion });
    expect(MediaVideoProfileVerificationSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ mock: true, executionTested: false, profile: { enabled: false, verified: true } });
    expect(result.profile.configVersion).not.toBe('cfg_video');
    expect(await service.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion, enabled: true })).toMatchObject({ enabled: true, verified: true });
  });

  it('keeps real and merely similarly named models unverifiable and unexecutable', async () => {
    const { service, row } = setup();
    for (const modelId of ['real-video', 'mock-video-model', 'mock-video-v1-custom']) {
      row.modelId = modelId;
      await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion, enabled: true })).rejects.toBeInstanceOf(BadRequestException);
      expect(await service.getRuntimeVideo('ent-1')).toMatchObject({ executionAvailable: false, profiles: [], tools: [] });
    }
  });

  it.each([
    { durationsSeconds: [10] }, { aspectRatios: ['16:9'] }, { resolutions: ['1080p'] },
    { frameRates: [30] }, { supportsAudio: true }, { supportsCancel: true },
    { outputFormats: ['video/webm'] }, { supportsTextToVideo: true },
    { maxReferenceCount: 2 }, { maxInputBytes: 20 * 1024 * 1024 }, { maxInputBytes: 1 },
    { resultRetentionSeconds: 172800 }, { resultRetentionSeconds: 3600 },
  ])('does not verify unsupported fixture capabilities: %s', async capabilities => {
    const { service, row, prisma } = setup();
    row.capabilities = { ...row.capabilities, ...capabilities };
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
    expect((await service.getRuntimeVideo('ent-1')).executionAvailable).toBe(false);
  });

  it.each([undefined, 'false', 'TRUE', true])('keeps execution closed but permits independent connection discovery: %s', async flag => {
    const { service, config, row, prisma } = setup();
    config.get.mockReturnValue(flag);
    expect(await service.discoverModels()).toMatchObject({ mock: false, executionTested: false, models: [expect.objectContaining({ modelId: 'minimax-h3' }), expect.anything()] });
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion, enabled: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await service.getRuntimeVideo('ent-1')).toEqual({ protocolVersion: 1, executionAvailable: false, profiles: [], tools: [], defaultProfileId: null });
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('discovers just a mock fixture suggestion without auto-creating or verifying', async () => {
    const { service, prisma } = setup();
    const result = await service.discoverModels();
    expect(MediaVideoModelDiscoverySchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ mock: true, executionTested: false, models: [{ modelId: 'mock-video-v1', compatible: true }] });
    expect(prisma.mediaModelProfile.create).not.toHaveBeenCalled();
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('never exposes mock discovery in production but permits real catalog detection while execution is closed', async () => {
    const { service, config, row } = setup();
    config.get.mockImplementation(key => key === 'NODE_ENV' ? 'production'
      : key === 'MEDIA_GATEWAY_MOCK_ENABLED' ? 'true' : undefined);
    expect(await service.discoverModels()).toMatchObject({ mock: false, models: [expect.objectContaining({ modelId: 'minimax-h3' }), expect.anything()] });
    expect(await service.getAvailableProfiles('user-1')).toEqual([]);
    expect((await service.getRuntimeVideo('ent-1')).executionAvailable).toBe(false);
    expect((await service.getEnterpriseConfig('user-1')).configured).toBe(true);
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.updateProfile(row.profileId, { enabled: true, expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('preserves verification for display changes and revokes both flags for model or capability changes', async () => {
    const { service, row } = setup();
    expect(await service.updateProfile(row.profileId, { displayName: '新名称', expectedConfigVersion: row.configVersion })).toMatchObject({ enabled: true, verified: true });
    expect(await service.updateProfile(row.profileId, { modelId: 'future-real-video', enabled: true, expectedConfigVersion: row.configVersion })).toMatchObject({ enabled: false, verified: false });
    row.enabled = true; row.verified = true; row.modelId = 'mock-video-v1';
    expect(await service.updateProfile(row.profileId, { capabilities: { durationsSeconds: [10] }, enabled: true, expectedConfigVersion: row.configVersion })).toMatchObject({ enabled: false, verified: false });
  });

  it('revokes verification for operation changes and rejects inconsistent capability updates', async () => {
    const { service, row } = setup();
    await expect(service.updateProfile(row.profileId, { capabilities: { supportsImageToVideo: false }, expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(BadRequestException);
    expect(await service.updateProfile(row.profileId, { operations: ['text-to-video'], capabilities: { supportsTextToVideo: true }, expectedConfigVersion: row.configVersion }))
      .toMatchObject({ enabled: false, verified: false });
  });

  it('requires verification to enable and refuses cross-kind lookups', async () => {
    const { service, row } = setup();
    row.verified = false;
    await expect(service.updateProfile(row.profileId, { enabled: true, expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(BadRequestException);
    row.kind = 'image';
    await expect(service.updateProfile(row.profileId, { enabled: false, expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects stale and racing profile changes through CAS', async () => {
    const { service, row, prisma } = setup();
    await expect(service.updateProfile(row.profileId, { displayName: 'x', expectedConfigVersion: 'stale' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: 'stale' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
    prisma.mediaModelProfile.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.updateProfile(row.profileId, { enabled: false, expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('MediaVideoConfigService enterprise isolation', () => {
  it('defaults to disabled when enterprise configuration is absent and uses authenticated enterprise context', async () => {
    const { service, prisma, context, setStored } = setup();
    setStored(null);
    const result = await service.getEnterpriseConfig('user-1');
    expect(MediaVideoEnterpriseConfigSchema.parse(result)).toEqual(result);
    expect(result.policy).toEqual(MediaVideoPolicySchema.parse({}));
    expect(context.resolve).toHaveBeenCalledWith('user-1');
    expect(prisma.enterpriseModelConfig.findUnique).toHaveBeenCalledWith({ where: { enterpriseId: 'ent-1' } });
    expect((await service.getRuntimeVideo('ent-1')).executionAvailable).toBe(false);
  });

  it('removes model IDs from enterprise choices and excludes disabled/unverified profiles', async () => {
    const { service, row, context } = setup();
    const available = await service.getAvailableProfiles('user-1');
    expect(available).toHaveLength(1);
    expect(available[0]).not.toHaveProperty('modelId');
    expect(context.resolve).toHaveBeenCalledWith('user-1');
    row.enabled = false;
    expect(await service.getAvailableProfiles('user-1')).toEqual([]);
    row.enabled = true; row.verified = false;
    expect(await service.getAvailableProfiles('user-1')).toEqual([]);
  });

  it('publishes only the safe capability intersection and the two mock tools', async () => {
    const { service, row, getStored } = setup();
    getStored().mediaPolicy.video.allowedOperations = ['image-to-video', 'text-to-video'];
    const result = await service.getRuntimeVideo('ent-1');
    expect(MediaVideoRuntimeSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ executionAvailable: true, tools: ['video_from_image', 'video_get_job'], profiles: [{ operations: ['image-to-video'], capabilities: { supportsAudio: false, supportsCancel: false } }] });
    expect(JSON.stringify(result)).not.toContain('modelId');
    expect(result.profiles[0]).not.toHaveProperty('verified');
    expect(result.defaultProfileId).toBe(row.profileId);
  });

  it('negotiates mock v2 audio modes and defaults inside the filtered capability ranges', async () => {
    const { service } = setup();
    const runtime = await service.getRuntimeVideoV2('ent-1');
    expect(runtime.protocolVersion).toBe(2);
    expect(runtime.profiles[0].capabilities).toMatchObject({ audioModes: [false], defaultAudio: false,
      defaults: { durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', frameRate: 24, audio: false, outputFormat: 'video/mp4' } });
    expect(JSON.stringify(runtime)).not.toContain('mock-video-v1');
  });

  it('fixes real H3 v2 audio mode to enabled', async () => {
    const f = setup(true);
    f.row.modelId = 'minimax-h3';
    f.row.capabilities = structuredClone(f.service['realCapabilities']());
    f.row.operations = ['image-to-video', 'text-to-video'];
    Object.assign(f.getStored().mediaPolicy.video, {
      allowedOperations: ['image-to-video', 'text-to-video'],
      allowedAspectRatios: ['16:9'],
      maxDurationSeconds: 4,
    });
    const runtime = await f.service.getRuntimeVideoV2('ent-1');
    expect(runtime.profiles[0].capabilities.audioModes).toEqual([true]);
    expect(runtime.profiles[0].capabilities.defaultAudio).toBe(true);
  });

  it.each([
    { maxDurationSeconds: 4 }, { allowedAspectRatios: ['16:9'] }, { maxResolution: '480p' },
    { allowedOperations: ['text-to-video'] },
  ])('ignores retired enterprise parameter filters: %s', async changes => {
    const { service, getStored } = setup();
    Object.assign(getStored().mediaPolicy.video, changes);
    expect(await service.getRuntimeVideo('ent-1')).toMatchObject({ protocolVersion: 1, executionAvailable: true, profiles: [{ capabilities: { durationsSeconds: [5], aspectRatios: ['9:16'], resolutions: ['720p'] } }] });
  });

  it('fails closed for malformed saved model authorization', async () => {
    const { service, getStored } = setup();
    getStored().mediaPolicy.video.enabledProfileIds = 'invalid';
    expect((await service.getRuntimeVideo('ent-1')).executionAvailable).toBe(false);
  });

  it('keeps image policy on video updates and keeps video policy on image updates in Serializable transactions', async () => {
    const { service, imageService, prisma, imagePolicy, videoPolicy, getStored, row } = setup();
    await service.updateEnterpriseConfig('user-1', { periodBudget: 200, maxConcurrentJobs: 2 });
    expect(getStored().mediaPolicy).toMatchObject({ ...imagePolicy, video: { ...videoPolicy, periodBudget: 200, maxConcurrentJobs: 2 } });
    // No enabled image rows are required to change a policy with no image grants.
    getStored().mediaPolicy.enabledProfileIds = [];
    getStored().mediaPolicy.defaultProfileId = null;
    const videoBefore = structuredClone(getStored().mediaPolicy.video);
    await imageService.updateEnterpriseConfig('user-1', { maxOutputs: 3 });
    expect(getStored().mediaPolicy).toMatchObject({ maxOutputs: 3, video: videoBefore });
    expect(prisma.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    expect(prisma.$transaction).toHaveBeenNthCalledWith(2, expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    expect((await service.getRuntimeVideo('ent-1')).defaultProfileId).toBe(row.profileId);
  });

  it('preserves a legacy periodBudget when saving only current video controls', async () => {
    const { service, getStored } = setup();
    getStored().mediaPolicy.video.periodBudget = 0;
    await service.updateEnterpriseConfig('user-1', { maxConcurrentJobs: 3 });
    expect(getStored().mediaPolicy.video).toMatchObject({ periodBudget: 0, maxConcurrentJobs: 3 });
  });

  it('preserves arbitrary independent image JSON fields rather than reconstructing the image policy', async () => {
    const { service, getStored } = setup();
    getStored().mediaPolicy.imageFutureField = { keep: true };
    await service.updateEnterpriseConfig('user-1', { periodBudget: 10 });
    expect(getStored().mediaPolicy.imageFutureField).toEqual({ keep: true });
  });

  it('preserves video JSON even if the image policy cannot parse it', async () => {
    const { imageService, getStored } = setup();
    const video = { futureVideoField: 'do-not-drop' };
    getStored().mediaPolicy = { video };
    await imageService.updateEnterpriseConfig('user-1', { maxOutputs: 3 });
    expect(getStored().mediaPolicy.video).toEqual(video);
  });

  it('does not reset valid image grants and limits when independent video JSON is malformed', async () => {
    const { imageService, imagePolicy, getStored } = setup();
    getStored().mediaPolicy.video = { futureVideoField: 'keep' };
    expect((await imageService.getEnterpriseConfig('user-1')).policy).toEqual(imagePolicy);
    expect(getStored().mediaPolicy.video).toEqual({ futureVideoField: 'keep' });
  });

  it('allows unavailable grants but keeps defaults outside the allowlist invalid', async () => {
    const { service, context, row } = setup();
    await service.updateEnterpriseConfig('user-1', { enabledProfileIds: ['unknown'], defaultProfileId: null });
    await service.updateEnterpriseConfig('user-1', { enabledProfileIds: [row.profileId] });
    await expect(service.updateEnterpriseConfig('user-1', { defaultProfileId: 'unknown' })).rejects.toBeInstanceOf(BadRequestException);
    context.resolve.mockResolvedValue({ enterpriseId: 'ent-1', role: 'MEMBER' });
    expect((await service.getEnterpriseConfig('user-1')).canEdit).toBe(false);
    await expect(service.updateEnterpriseConfig('user-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ignores an unknown legacy authorization resolution in preview', async () => {
    const { service, getStored } = setup();
    Object.assign(getStored().mediaPolicy.video, { maxResolution: '2k' });
    const preview = await service.previewEnterpriseConfig('user-1', { policy: getStored().mediaPolicy.video });
    expect(preview.profiles[0].reasons).toEqual([]);
    expect(preview.profiles[0].status).toBe('effective');
  });

  it.each(['P2034', 'P2002'])('returns a retryable conflict instead of overwriting concurrent policy data: %s', async code => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('concurrent change', { code, clientVersion: 'test' }));
    await expect(service.updateEnterpriseConfig('user-1', { periodBudget: 42 })).rejects.toBeInstanceOf(ConflictException);
  });
});
