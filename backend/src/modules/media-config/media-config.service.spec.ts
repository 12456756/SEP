import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MediaConfigService } from './media-config.service';
import { Prisma } from '@prisma/client';
import { CreateMediaProfileDtoSchema, MediaRuntimeSchema, SETTING_KEYS } from 'shared';

function fixture(config?: any) {
  const row = {
    id: 'row-1', profileId: 'product-image', kind: 'image', displayName: '商品图片',
    modelId: 'private-model-id', configVersion: 'cfg_1', operations: ['generate', 'edit'],
    executionMode: 'sync-response', enabled: true, verified: true,
    capabilities: { supportsReferenceImage: true, maxOutputs: 4, sizes: ['1024x1024', '2048x2048'] },
  };
  const prisma: any = {
    mediaModelProfile: {
      findMany: jest.fn().mockResolvedValue([row]),
      findUnique: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockImplementation(async ({ data }) => ({ ...row, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    enterpriseModelConfig: {
      findUnique: jest.fn().mockResolvedValue({ mediaPolicy: {
        enabledProfileIds: ['product-image'], defaultProfileId: 'product-image',
        allowedOperations: ['generate'], maxOutputs: 2, maxWidth: 1024, maxHeight: 1024,
      } }),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  const settings: any = {
    getEffectiveValue: jest.fn(async (key) => key === SETTING_KEYS.MEDIA_BASE_URL ? 'https://relay.example/v1' : 'test-secret'),
    updateMediaConnection: jest.fn(),
  };
  settings.getMediaConnection = jest.fn(async () => ({
    baseUrl: await settings.getEffectiveValue(SETTING_KEYS.MEDIA_BASE_URL),
    apiKey: await settings.getEffectiveValue(SETTING_KEYS.MEDIA_API_KEY), source: 'database',
  }));
  const context: any = {
    resolve: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', role: 'ENTERPRISE_ADMIN' }),
    assertEnterpriseAdmin: jest.fn(),
  };
  const imageAdapter: any = {
    discoverModels: jest.fn().mockResolvedValue([{ modelId: 'gpt-image-2', displayName: 'GPT Image 2' }]),
    pricing: jest.fn().mockResolvedValue({ amount_usd: '0.04' }),
  };
  const sync: any = { sync: jest.fn() };
  return { service: new MediaConfigService(prisma, settings, context, config, imageAdapter, sync), prisma, settings, context, row, imageAdapter, sync };
}

describe('MediaConfigService', () => {
  it('publishes the configured reference maximum and lets administrators edit auto profiles', async () => {
    const { service, row, prisma } = fixture({ get: () => 'true' });
    row.profileId = 'auto-image-reference';
    Object.assign(row.capabilities, { maxReferenceCount: 7 });
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { enabledProfileIds: [row.profileId] } });
    expect(await service.getRuntimeMediaV3('ent-1')).toMatchObject({ profiles: [{ adapter: { referenceSupport: { maxCount: 7 } } }] });
    await service.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion, capabilities: { maxReferenceCount: 3 } });
    expect(prisma.mediaModelProfile.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ capabilities: expect.objectContaining({ maxReferenceCount: 3 }), verified: false }),
    }));
  });
  it('verifies an explicitly configured new model through V3 pricing without a static model allow-list', async () => {
    const { service, row, imageAdapter } = fixture();
    row.modelId = 'new-image-protocol-model';
    row.capabilities.sizes = ['2048x2048'];
    row.capabilities.maxOutputs = 1;
    imageAdapter.discoverModels.mockResolvedValue([{ modelId: row.modelId, displayName: 'New' }]);
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(imageAdapter.pricing).not.toHaveBeenCalled();
    expect(await service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion,
      verificationSpec: { size: '2048x2048', count: 1, quality: 'ultra' } }))
      .toMatchObject({ profile: { verified: true }, executionTested: false });
    expect(imageAdapter.pricing).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: 3,
      requestedSpec: expect.objectContaining({ size: '2048x2048', count: 1, quality: 'ultra' }) }), row.modelId);
  });

  it('uses equivalent pixel dimensions for explicit verification and rejects an unexpressible combination', async () => {
    const { service, row, imageAdapter } = fixture();
    row.modelId = 'new-image-model';
    imageAdapter.discoverModels.mockResolvedValue([{ modelId: row.modelId, displayName: 'New' }]);
    await service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion,
      verificationSpec: { width: 2048, height: 1024, count: 1, quality: 'ultra' } });
    expect(imageAdapter.pricing).toHaveBeenCalledWith(expect.objectContaining({ requestedSpec: {
      size: '2048x1024', width: 2048, height: 1024, count: 1, quality: 'ultra',
    } }), row.modelId);
    imageAdapter.pricing.mockClear();
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion,
      verificationSpec: { size: 'auto', width: 2048, height: 1024, count: 1, quality: 'ultra' } }))
      .rejects.toMatchObject({ response: { error: { code: 'ADAPTER_FIELD_UNMAPPED', field: 'requestedSpec.width' } } });
    expect(imageAdapter.pricing).not.toHaveBeenCalled();
  });
  it('ignores all retired image limits in both runtime versions and authorization preview', async () => {
    const { service, prisma, row } = fixture({ get: jest.fn(() => 'true') });
    row.modelId = 'gpt-image-2';
    row.capabilities.sizes = ['1024x1024', '1536x1024', '1024x1536'];
    const policy = { enabledProfileIds: [row.profileId], defaultProfileId: row.profileId,
      allowedOperations: [], maxOutputs: 1, maxWidth: 1, maxHeight: 1 };
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: policy });
    for (const runtime of [await service.getRuntimeMedia('ent-1'), await service.getRuntimeMediaV2('ent-1')]) {
      expect(runtime).toMatchObject({ executionAvailable: true, defaultProfileId: row.profileId,
        tools: ['image_generate', 'image_edit'], profiles: [{ operations: row.operations,
          capabilities: { maxOutputs: 4, sizes: row.capabilities.sizes, maxWidth: 1536, maxHeight: 1536 } }] });
    }
    const preview = await service.previewEnterpriseConfig('admin', { policy });
    expect(preview.profiles[0]).toMatchObject({ status: 'effective', reasons: [] });
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { ...policy, maxWidth: -1 } });
    expect((await service.getRuntimeMedia('ent-1')).executionAvailable).toBe(true);
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { ...policy, enabledProfileIds: [] } });
    expect((await service.getRuntimeMedia('ent-1')).executionAvailable).toBe(false);
  });

  it('publishes v3 authorization separately from adapter readiness and without defaults', async () => {
    const { service, row } = fixture({ get: jest.fn(() => 'true') });
    const runtime = await service.getRuntimeMediaV3('ent-1');
    expect(runtime).toMatchObject({ protocolVersion: 3, executionMode: 'real', executionAvailable: true,
      defaultProfileId: row.profileId, tools: ['image_generate', 'image_edit'], profiles: [{
        profileId: row.profileId, authorized: true, adapter: { id: 'sub2api-image', available: true,
          referenceSupport: { maxCount: 4, maxInputBytes: 5 * 1024 * 1024, mimeTypes: ['image/png'] } },
      }] });
    expect(runtime.profiles[0]).toMatchObject({ modelId: row.modelId, modelDisplayName: row.modelId,
      parameters: { size: { values: row.capabilities.sizes, valuesMode: 'suggested', confidence: 'declared' },
        count: { minimum: 1, maximum: 4, required: true } } });
    expect(runtime.profiles[0]).not.toHaveProperty('capabilityHints');
    expect(JSON.stringify(runtime)).not.toContain('defaultSize');
    row.verified = false;
    const unavailable = await service.getRuntimeMediaV3('ent-1');
    expect(unavailable).toMatchObject({ executionAvailable: false, tools: [], profiles: [{
      authorized: true, adapter: { available: false, reason: 'PROFILE_UNVERIFIED' }, unavailableReason: 'PROFILE_UNVERIFIED',
    }] });
    expect(unavailable.defaultProfileId).toBeNull();
  });

  it('creates an unverified profile with a server-owned version', async () => {
    const { service, prisma } = fixture();
    const dto = CreateMediaProfileDtoSchema.parse({
      profileId: 'new-image', kind: 'image', displayName: '图片', modelId: 'test-model',
      operations: ['generate'], executionMode: 'sync-response', capabilities: { sizes: ['1024x1024'] },
    });
    const result = await service.createProfile(dto);
    expect(result).toMatchObject({ verified: false, enabled: false, configVersion: expect.stringMatching(/^cfg_/) });
    expect(prisma.mediaModelProfile.create.mock.calls[0][0].data).not.toHaveProperty('apiKey');
  });

  it('retains an authorized profile with no executable operation and clears its default', async () => {
    const { service, row } = fixture({ get: jest.fn(() => 'true') });
    row.operations = ['edit'];
    row.capabilities.supportsReferenceImage = false;
    expect(await service.getRuntimeMediaV3('ent-1')).toMatchObject({ status: 'unavailable', executionAvailable: false,
      defaultProfileId: null, tools: [], profiles: [{ profileId: row.profileId, modelId: row.modelId, operations: [],
        parameters: {}, constraints: [], referenceRules: [], unavailableReason: 'ADAPTER_OPERATION_UNSUPPORTED',
        unavailableMessage: '当前适配器不支持该操作', adapter: { available: false } }] });
  });

  it('distinguishes empty grants and connection read failures without contacting the model', async () => {
    const { service, prisma, settings, imageAdapter } = fixture({ get: jest.fn(() => 'true') });
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { enabledProfileIds: [] } });
    expect(await service.getRuntimeMediaV3('ent-1')).toMatchObject({ status: 'empty', profiles: [], executionAvailable: false });
    const failure = new ServiceUnavailableException({ message: '读取连接失败', errors: [{ field: 'connection', message: 'storage unavailable' }] });
    settings.getMediaConnection.mockRejectedValue(failure);
    await expect(service.getRuntimeMediaV3('ent-1')).rejects.toBe(failure);
    expect(imageAdapter.pricing).not.toHaveBeenCalled();
    expect(imageAdapter.discoverModels).not.toHaveBeenCalled();
  });

  it('rejects creating or enabling a profile before configuration verification', async () => {
    const { service, prisma, row } = fixture();
    const dto = CreateMediaProfileDtoSchema.parse({
      profileId: 'new-image', kind: 'image', displayName: '图片', modelId: 'gpt-image-2',
      operations: ['generate'], executionMode: 'sync-response', enabled: true,
      capabilities: { sizes: ['1024x1024'] },
    });
    await expect(service.createProfile(dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.mediaModelProfile.create).not.toHaveBeenCalled();
    row.verified = false;
    await expect(service.updateProfile('product-image', { enabled: true, expectedConfigVersion: 'cfg_1' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
  });

  it('discovers visible models without exposing the configured key and marks only adapter models compatible', async () => {
    const { service, imageAdapter, sync } = fixture();
    imageAdapter.discoverModels.mockResolvedValue([
      { modelId: 'gpt-image-2', displayName: 'GPT Image 2' },
      { modelId: 'gpt-image-2-exact', displayName: 'GPT Image 2 Exact' },
      { modelId: 'gpt-image-2.5', displayName: 'GPT Image 2.5' },
      { modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare' },
      { modelId: 'gpt-image-2.5-sunburst', displayName: 'GPT Image 2.5 Sunburst' },
      { modelId: 'gpt-image-2.5-custom', displayName: 'GPT Image 2.5 Custom' },
    ]);
    const result = await service.discoverModels();
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'gpt-image-2', compatible: true }),
      expect.objectContaining({ modelId: 'gpt-image-2-exact', compatible: true }),
      expect.objectContaining({ modelId: 'gpt-image-2.5', compatible: true }),
      expect.objectContaining({ modelId: 'gpt-image-2.5-flare', compatible: true }),
      expect.objectContaining({ modelId: 'gpt-image-2.5-sunburst', compatible: true }),
      expect.objectContaining({ modelId: 'gpt-image-2.5-custom', compatible: false, suggested: null }),
    ]));
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(sync.sync).toHaveBeenCalledWith('image', expect.arrayContaining([
      expect.objectContaining({ modelId: 'gpt-image-2', operations: ['generate', 'edit'] }),
    ]), expect.any(String), expect.any(Function));
    expect(sync.sync.mock.calls[0][1]).toHaveLength(6);
    expect(sync.sync.mock.calls[0][1][5]).toMatchObject({ autoCreate: false });
    expect(imageAdapter.pricing).not.toHaveBeenCalled();
  });

  it('does not synchronize a failed catalog or permit manual identity edits to managed models', async () => {
    const { service, imageAdapter, sync, row } = fixture();
    imageAdapter.discoverModels.mockRejectedValue(new ServiceUnavailableException());
    await expect(service.discoverModels()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sync.sync).not.toHaveBeenCalled();
    row.profileId = 'auto-image-123456789';
    await expect(service.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion, modelId: 'other-model' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists image settings on managed profiles, clears verification and publishes the saved limits', async () => {
    const { service, prisma, row } = fixture({ get: jest.fn(() => 'true') });
    row.profileId = 'auto-image-example';
    prisma.mediaModelProfile.updateMany.mockImplementation(async ({ data }) => { Object.assign(row, data); return { count: 1 }; });
    const saved = await service.updateProfile(row.profileId, { expectedConfigVersion: row.configVersion,
      capabilities: { maxOutputs: 2, qualities: ['auto', 'high'], maxReferenceCount: 2 } });
    expect(saved).toMatchObject({ verified: false, capabilities: { maxOutputs: 2, qualities: ['auto', 'high'], maxReferenceCount: 2 } });
    expect(saved.configVersion).not.toBe('cfg_1');
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { enabledProfileIds: [row.profileId] } });
    const runtime = await service.getRuntimeMediaV3('ent-1');
    expect(runtime.profiles[0]).toMatchObject({ unavailableReason: 'PROFILE_UNVERIFIED',
      parameters: { count: { maximum: 2 }, quality: { values: ['auto', 'high'], valuesMode: 'suggested' } },
      adapter: { referenceSupport: { maxCount: 2 } } });
  });

  it('rejects a verification count above the configured output limit without requesting a price', async () => {
    const { service, row, imageAdapter } = fixture();
    row.modelId = 'gpt-image-2';
    row.capabilities.maxOutputs = 1;
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion,
      verificationSpec: { size: '1024x1024', quality: 'auto', count: 2 } })).rejects.toBeInstanceOf(BadRequestException);
    expect(imageAdapter.pricing).not.toHaveBeenCalled();
  });

  it('requires an explicit pricing spec for configured quality suggestions instead of assuming legacy quality names', async () => {
    const { service, row, imageAdapter } = fixture();
    row.modelId = 'gpt-image-2';
    Object.assign(row.capabilities, { qualities: ['auto', 'studio'] });
    await expect(service.verifyProfile(row.profileId, { expectedConfigVersion: row.configVersion }))
      .rejects.toThrow('显式填写报价校验规格');
    expect(imageAdapter.pricing).not.toHaveBeenCalled();
  });

  it('verifies each advertised operation, size, quality, and output boundary using pricing only', async () => {
    const { service, prisma, row, imageAdapter } = fixture();
    row.modelId = 'gpt-image-2';
    row.capabilities.sizes = ['1024x1024', '1536x1024'];
    await expect(service.verifyProfile('product-image', { expectedConfigVersion: 'cfg_1' }))
      .resolves.toMatchObject({ executionTested: false, profile: { verified: true } });
    expect(imageAdapter.discoverModels).toHaveBeenCalledTimes(1);
    expect(imageAdapter.pricing).toHaveBeenCalledTimes(48);
    expect(imageAdapter.pricing).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ count: 2 }) }), 'gpt-image-2');
    expect(imageAdapter.pricing).toHaveBeenCalledWith(expect.objectContaining({ operation: 'edit' }), 'gpt-image-2');
    expect(prisma.mediaModelProfile.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { profileId: 'product-image', configVersion: 'cfg_1' }, data: { verified: true, configVersion: expect.stringMatching(/^cfg_/) },
    }));
  });

  it('does not verify when the model is missing from discovery or any read-only quote fails', async () => {
    const { service, prisma, row, imageAdapter } = fixture();
    row.modelId = 'gpt-image-2';
    row.capabilities.sizes = ['1024x1024'];
    imageAdapter.discoverModels.mockResolvedValue([]);
    await expect(service.verifyProfile('product-image', { expectedConfigVersion: 'cfg_1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.mediaModelProfile.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaModelProfile.updateMany.mock.calls[0][0].data.verified).toBe(false);
    imageAdapter.discoverModels.mockResolvedValue([{ modelId: 'gpt-image-2', displayName: 'GPT Image 2' }]);
    imageAdapter.pricing.mockRejectedValueOnce(new ServiceUnavailableException());
    await expect(service.verifyProfile('product-image', { expectedConfigVersion: 'cfg_1' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.mediaModelProfile.updateMany).toHaveBeenCalledTimes(2);
  });

  it('rejects stale versions before writing and detects concurrent CAS failure', async () => {
    const { service, prisma } = fixture();
    await expect(service.updateProfile('product-image', { enabled: false, expectedConfigVersion: 'stale' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
    prisma.mediaModelProfile.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.updateProfile('product-image', { enabled: false, expectedConfigVersion: 'cfg_1' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('delegates image connection mutation to the atomic settings operation without unconditional version churn', async () => {
    const { service, prisma, settings, row } = fixture();
    const video = { ...row, profileId: 'product-video', kind: 'video', configVersion: 'video-cfg' };
    const profiles = [row, video];
    prisma.mediaModelProfile.updateMany.mockImplementation(async ({ where, data }) => {
      const matches = profiles.filter(profile => !where?.kind || profile.kind === where.kind);
      for (const profile of matches) Object.assign(profile, data);
      return { count: matches.length };
    });
    await service.updateConnection({ baseUrl: 'https://new-relay.example/v1', apiKey: 'new-secret' });
    expect(settings.updateMediaConnection).toHaveBeenCalledWith({ baseUrl: 'https://new-relay.example/v1', apiKey: 'new-secret' }, 'image', undefined);
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
    expect(video).toMatchObject({ verified: true, enabled: true, configVersion: 'video-cfg' });
  });

  it('keeps verification for display-only changes but revokes it for model changes', async () => {
    const { service, prisma } = fixture();
    await service.updateProfile('product-image', { displayName: '新名称', expectedConfigVersion: 'cfg_1' });
    expect(prisma.mediaModelProfile.updateMany.mock.calls[0][0]).toMatchObject({
      where: { profileId: 'product-image', configVersion: 'cfg_1' }, data: { verified: true },
    });
    await service.updateProfile('product-image', { modelId: 'changed-model', expectedConfigVersion: 'cfg_1' });
    expect(prisma.mediaModelProfile.updateMany.mock.calls[1][0].data.verified).toBe(false);
  });

  it('does not churn versions for unchanged profiles and rejects invalid capability combinations', async () => {
    const { service, prisma } = fixture();
    await service.updateProfile('product-image', { enabled: true, expectedConfigVersion: 'cfg_1' });
    expect(prisma.mediaModelProfile.updateMany).not.toHaveBeenCalled();
    await expect(service.updateProfile('product-image', {
      expectedConfigVersion: 'cfg_1', capabilities: { supportsReferenceImage: false },
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateProfile('product-image', {
      expectedConfigVersion: 'cfg_1', capabilities: { sizes: [] },
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns Nest errors for missing or invalid stored profiles', async () => {
    const { service, prisma, row } = fixture();
    prisma.mediaModelProfile.findUnique.mockResolvedValue(null);
    await expect(service.updateProfile('missing', { enabled: true, expectedConfigVersion: 'cfg_1' })).rejects.toBeInstanceOf(NotFoundException);
    prisma.mediaModelProfile.findMany.mockResolvedValue([{ ...row, capabilities: {} }]);
    await expect(service.listProfiles()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns connection state without exposing the secret', async () => {
    const { service } = fixture();
    const result = await service.getConnection();
    expect(result).toEqual({ configured: true, baseUrl: 'https://relay.example/v1', apiKeyConfigured: true, source: 'database' });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('disables media for broken connection pairs without breaking chat runtime or hiding admin diagnostics', async () => {
    const { service, settings } = fixture({ get: jest.fn(() => 'true') });
    settings.getMediaConnection.mockRejectedValue(new ServiceUnavailableException('媒体连接配置不完整'));
    await expect(service.getConnection()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await service.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, tools: [], profiles: [] });
  });

  it('requires enterprise context even for the available profile list', async () => {
    const { service, context, prisma } = fixture();
    context.resolve.mockRejectedValue(new ForbiddenException());
    await expect(service.getAvailableProfiles('outsider')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.mediaModelProfile.findMany).not.toHaveBeenCalled();
  });

  it('omits the upstream model ID from enterprise available profiles', async () => {
    const { service, context } = fixture();
    const profiles = await service.getAvailableProfiles('member');
    expect(context.resolve).toHaveBeenCalledWith('member');
    expect(profiles[0]).not.toHaveProperty('modelId');
    expect(profiles[0]).toMatchObject({ profileId: 'product-image', enabled: true, verified: true });
  });

  it('restricts policy updates to enterprise admins', async () => {
    const { service, context, prisma } = fixture();
    context.assertEnterpriseAdmin.mockImplementation(() => { throw new ForbiddenException(); });
    await expect(service.updateEnterpriseConfig('member', { maxOutputs: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.enterpriseModelConfig.upsert).not.toHaveBeenCalled();
  });

  it('allows unavailable allowlist entries but keeps defaults inside the allowlist', async () => {
    const { service, prisma } = fixture();
    await service.updateEnterpriseConfig('admin', { enabledProfileIds: ['unknown'], defaultProfileId: null });
    await service.updateEnterpriseConfig('admin', { enabledProfileIds: ['product-image'] });
    await expect(service.updateEnterpriseConfig('admin', { defaultProfileId: 'unknown' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.enterpriseModelConfig.upsert).toHaveBeenCalled();
  });

  it('previews effective profiles, missing grants, default validity, and disabled execution without secrets', async () => {
    const { service } = fixture();
    const preview = await service.previewEnterpriseConfig('admin', { protocolVersion: 1, policy: {
      enabledProfileIds: ['product-image', 'missing-image'], defaultProfileId: 'product-image', allowedOperations: ['generate'],
      maxOutputs: 2, maxWidth: 1024, maxHeight: 1024,
    } });
    expect(preview).toMatchObject({ executionMode: 'disabled', executionAvailable: false, defaultProfileValid: false,
      profiles: [
        { profileId: 'product-image', status: 'unavailable', reasons: ['execution-disabled'], effectiveProfile: expect.objectContaining({ capabilities: expect.objectContaining({ sizes: ['1024x1024', '2048x2048'] }) }) },
        { profileId: 'missing-image', status: 'unavailable', effectiveProfile: null, reasons: ['profile-missing'] },
      ] });
    expect(JSON.stringify(preview)).not.toContain('private-model-id');
    expect(JSON.stringify(preview)).not.toContain('test-secret');
  });

  it('does not expose non-authorized profile details to enterprise members', async () => {
    const { service, context } = fixture();
    context.resolve.mockResolvedValue({ enterpriseId: 'ent-1', role: 'MEMBER' });
    const preview = await service.previewEnterpriseConfig('member', { policy: {
      enabledProfileIds: [], defaultProfileId: null, allowedOperations: [], maxOutputs: 4, maxWidth: 4096, maxHeight: 4096,
    } });
    expect(preview.profiles).toMatchObject([{ profileId: 'product-image' }]);
  });

  it('ignores member-supplied preview grants and uses the stored enterprise policy', async () => {
    const { service, context, prisma } = fixture();
    context.resolve.mockResolvedValue({ enterpriseId: 'ent-1', role: 'MEMBER' });
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: {
      enabledProfileIds: [], defaultProfileId: null, allowedOperations: [], maxOutputs: 4, maxWidth: 4096, maxHeight: 4096,
    } });
    const preview = await service.previewEnterpriseConfig('member', { policy: {
      enabledProfileIds: ['product-image'], defaultProfileId: 'product-image', allowedOperations: ['generate'], maxOutputs: 4, maxWidth: 4096, maxHeight: 4096,
    } });
    expect(preview.profiles).toEqual([]);
  });

  it('stores only media policy, without modifying chat configuration', async () => {
    const { service, prisma } = fixture();
    await service.updateEnterpriseConfig('admin', { maxOutputs: 1 });
    expect(prisma.enterpriseModelConfig.upsert.mock.calls[0][0]).toMatchObject({
      where: { enterpriseId: 'ent-1' }, update: { mediaPolicy: { maxOutputs: 1 } },
    });
    expect(Object.keys(prisma.enterpriseModelConfig.upsert.mock.calls[0][0].update)).toEqual(['mediaPolicy']);
  });

  it('maps concurrent policy transaction conflicts to HTTP 409', async () => {
    const { service, prisma } = fixture();
    prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034', clientVersion: 'test',
    }));
    await expect(service.updateEnterpriseConfig('admin', { maxOutputs: 1 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('publishes model capabilities without advertising executable tools or secrets when execution is disabled', async () => {
    const { service, prisma } = fixture();
    const runtime = await service.getRuntimeMedia('ent-1');
    expect(MediaRuntimeSchema.safeParse(runtime).success).toBe(true);
    expect(runtime).toMatchObject({ protocolVersion: 1, executionAvailable: false, tools: [], defaultProfileId: 'product-image',
      profiles: [{ operations: ['generate', 'edit'], capabilities: { maxOutputs: 4, sizes: ['1024x1024', '2048x2048'] } }] });
    expect(prisma.mediaModelProfile.findMany.mock.calls[0][0].where).toEqual({ kind: 'image', enabled: true, verified: true });
    const json = JSON.stringify(runtime);
    for (const secret of ['private-model-id', 'test-secret', 'relay.example']) expect(json).not.toContain(secret);
  });

  it('negotiates image v2 only for adapted models with defaults inside adapter-supported sizes', async () => {
    const config = { get: jest.fn(() => 'true') } as any;
    const { service, prisma, row } = fixture(config);
    row.modelId = 'gpt-image-2';
    row.capabilities = { supportsReferenceImage: true, maxOutputs: 4, sizes: ['1024x1024', '1536x1024', '2048x2048'] };
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: {
      enabledProfileIds: ['product-image'], defaultProfileId: 'product-image', allowedOperations: ['generate'],
      maxOutputs: 4, maxWidth: 1024, maxHeight: 1024,
    } });
    const runtime = await service.getRuntimeMediaV2('ent-1');
    expect(runtime).toMatchObject({ protocolVersion: 2, defaultProfileId: 'product-image', profiles: [{ capabilities: {
      sizes: ['1024x1024', '1536x1024'], qualities: ['low', 'medium', 'high'], defaultQuality: 'medium', defaultSize: '1024x1024',
    } }] });
    expect(JSON.stringify(runtime)).not.toContain('gpt-image-2');
    expect(JSON.stringify(runtime)).not.toContain('test-secret');
  });

  it('fails closed on missing grants or connection while ignoring obsolete size limits', async () => {
    const { service, prisma, settings } = fixture();
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { maxOutputs: -1 } });
    expect((await service.getRuntimeMedia('ent-1')).profiles).toEqual([]);
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: { enabledProfileIds: ['product-image'], defaultProfileId: 'product-image', maxWidth: 1 } });
    expect(await service.getRuntimeMedia('ent-1')).toMatchObject({ defaultProfileId: 'product-image', profiles: [{ profileId: 'product-image' }] });
    settings.getEffectiveValue.mockResolvedValue(undefined);
    expect((await service.getRuntimeMedia('ent-1')).profiles).toEqual([]);
  });

  it('enables only real-compatible profiles when the exact switch and usable HTTPS connection are present', async () => {
    const config = { get: jest.fn(() => 'true') };
    const { service, prisma, row } = fixture(config);
    row.modelId = 'gpt-image-2';
    row.capabilities = {
      supportsReferenceImage: true, maxOutputs: 8,
      sizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048'],
    };
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue({ mediaPolicy: {
      enabledProfileIds: ['product-image'], defaultProfileId: 'product-image',
      allowedOperations: ['generate', 'edit'], maxOutputs: 8, maxWidth: 1536, maxHeight: 1536,
    } });

    const runtime = await service.getRuntimeMedia('ent-1');
    expect(MediaRuntimeSchema.safeParse(runtime).success).toBe(true);
    expect(runtime).toMatchObject({
      executionAvailable: true, tools: ['image_generate', 'image_edit'], defaultProfileId: 'product-image',
      profiles: [{ operations: ['generate', 'edit'], capabilities: {
        maxOutputs: 4, sizes: ['1024x1024', '1536x1024', '1024x1536'],
      } }],
    });
    const json = JSON.stringify(runtime);
    for (const secret of ['gpt-image-2', 'test-secret', 'relay.example']) expect(json).not.toContain(secret);
  });

  it('keeps execution closed unless the real switch is exactly true', async () => {
    const config = { get: jest.fn(() => 'TRUE') };
    const { service, row } = fixture(config);
    row.modelId = 'gpt-image-2';

    expect(await service.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, tools: [] });
  });

  it('fails closed for unusable real connection or profiles outside the real execution contract', async () => {
    const config = { get: jest.fn(() => 'true') };
    const { service, settings, prisma, row } = fixture(config);
    row.modelId = 'gpt-image-2';
    settings.getEffectiveValue.mockImplementation(async (key: string) =>
      key === SETTING_KEYS.MEDIA_BASE_URL ? 'http://relay.example/v1' : 'test-secret');
    expect(await service.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, tools: [] });

    settings.getEffectiveValue.mockImplementation(async (key: string) =>
      key === SETTING_KEYS.MEDIA_BASE_URL ? 'https://relay.example/v1' : 'test-secret');
    row.modelId = 'private-model-id';
    expect(await service.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, tools: [], profiles: [] });
    row.modelId = 'gpt-image-2';
    row.executionMode = 'async-query';
    expect(await service.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, tools: [], profiles: [] });

    row.executionMode = 'sync-response';
    prisma.mediaModelProfile.findMany.mockResolvedValue([]);
    expect(await service.getRuntimeMedia('ent-1')).toMatchObject({ executionAvailable: false, tools: [], profiles: [] });
  });
});
