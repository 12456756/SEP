import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaModelProfile, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CreateMediaVideoProfileDto, CreateMediaVideoProfileDtoSchema, MediaVideoAvailableProfile,
  MediaVideoEnterpriseConfig, MediaVideoModelDiscovery, MediaVideoPolicy, MediaVideoPolicySchema,
  MediaVideoPolicyPreview, MediaVideoPolicyPreviewRequest, MediaVideoPolicyPreviewRequestSchema, MediaVideoPolicyPreviewSchema,
  MediaVideoProfile, MediaVideoProfileSchema, MediaVideoProfileVerification, MediaVideoRuntime,
  MediaVideoRuntimeSchema, UpdateMediaVideoPolicyDto, UpdateMediaVideoPolicyDtoSchema,
  MediaVideoRuntimeV2Schema,
  MediaVideoAuthorizationSchema,
  UpdateMediaVideoProfileDto, UpdateMediaVideoProfileDtoSchema, VerifyMediaVideoProfileDto,
  VerifyMediaVideoProfileDtoSchema,
  UpdateMediaConnectionDto,
} from 'shared';
import fixture from '../../shared/fixtures/media-video-v1.json';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { MEDIA_MOCK_PNG } from '../media-gateway/media-gateway-mock.adapter';
import { Sub2apiVideoAdapter } from '../media-gateway/sub2api-video.adapter';
import { VideoFileCacheService } from '../media-gateway/video-file-cache.service';
import { SettingService } from '../setting/setting.service';
import { MediaModelSyncService, mediaConnectionFingerprint } from './media-model-sync.service';
import { MediaVideoRuntimeV3Schema } from 'shared';
import type { MediaVideoRuntimeV3 } from 'shared';

const MOCK_PROFILE = MediaVideoProfileSchema.parse(fixture.profile);

@Injectable()
export class MediaVideoConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enterpriseContext: EnterpriseContextService,
    private readonly config: ConfigService,
    @Optional() private readonly videoAdapter?: Sub2apiVideoAdapter,
    @Optional() private readonly videoFiles?: VideoFileCacheService,
    @Optional() private readonly modelSync?: MediaModelSyncService,
    @Optional() private readonly settings?: SettingService,
  ) {}

  private realEnabled(): boolean {
    return this.config.get<string>('MEDIA_VIDEO_REAL_ENABLED') === 'true';
  }

  private realCapabilities(): MediaVideoProfile['capabilities'] {
    return { supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: true,
      durationsSeconds: [4], aspectRatios: ['16:9'], resolutions: ['720p'], frameRates: [24],
      maxInputBytes: 10 * 1024 * 1024, maxReferenceCount: 1, outputFormats: ['video/mp4'],
      supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 86_400 };
  }

  private realCompatible(profile: MediaVideoProfile): boolean {
    const c = profile.capabilities;
    return profile.modelId === 'minimax-h3' && profile.executionMode === 'async-query'
      && !c.supportsCancel && c.supportsTaskQuery && c.supportsAudio
      && c.durationsSeconds.every(value => value === 4) && c.aspectRatios.every(value => value === '16:9')
      && c.resolutions.every(value => value === '720p') && c.frameRates.every(value => value === 24)
      && c.outputFormats.every(value => value === 'video/mp4') && c.maxInputBytes <= 10 * 1024 * 1024
      && c.maxReferenceCount === 1 && c.resultRetentionSeconds === 86_400;
  }

  private v3Compatible(profile: MediaVideoProfile): boolean {
    const c = profile.capabilities;
    return profile.executionMode === 'async-query' && c.supportsTaskQuery && !c.supportsCancel
      && c.maxInputBytes <= 10 * 1024 * 1024 && c.maxReferenceCount <= 1
      && c.outputFormats.every(format => ['video/mp4', 'video/webm'].includes(format));
  }

  private mockEnabled(): boolean {
    return this.config.get<string>('NODE_ENV') !== 'production'
      && this.config.get<string>('MEDIA_GATEWAY_MOCK_ENABLED') === 'true';
  }

  private profileView(row: MediaModelProfile): MediaVideoProfile {
    const parsed = MediaVideoProfileSchema.safeParse({
      profileId: row.profileId, kind: row.kind, displayName: row.displayName, modelId: row.modelId,
      configVersion: row.configVersion, operations: row.operations, executionMode: row.executionMode,
      capabilities: row.capabilities, enabled: row.enabled, verified: row.verified,
    });
    if (!parsed.success) throw new ServiceUnavailableException('视频 Profile 配置无效，请联系平台管理员');
    return parsed.data;
  }

  private async findProfile(profileId: string): Promise<MediaVideoProfile> {
    const row = await this.prisma.mediaModelProfile.findUnique({ where: { profileId } });
    if (!row || row.kind !== 'video') throw new NotFoundException('视频 Profile 不存在');
    return this.profileView(row);
  }

  private parse<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('视频配置参数无效');
    return parsed.data!;
  }

  private parsePolicy(mediaPolicy: unknown): MediaVideoPolicy {
    const value = mediaPolicy && typeof mediaPolicy === 'object' && !Array.isArray(mediaPolicy)
      ? (mediaPolicy as Record<string, unknown>).video : undefined;
    const parsed = MediaVideoPolicySchema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    const authorization = MediaVideoAuthorizationSchema.safeParse(value ?? {});
    // Invalid stored policy must never accidentally grant access.
    return MediaVideoPolicySchema.parse(authorization.success ? authorization.data : {});
  }

  private compatible(profile: MediaVideoProfile): boolean {
    const c = profile.capabilities;
    const supported = MOCK_PROFILE.capabilities;
    return profile.modelId === 'mock-video-v1' && profile.executionMode === 'async-query'
      && profile.operations.every(operation => operation === 'image-to-video')
      && c.supportsImageToVideo && !c.supportsTextToVideo && !c.supportsAudio && !c.supportsCancel
      && c.supportsTaskQuery && c.durationsSeconds.every(value => value === 5)
      && c.aspectRatios.every(value => value === '9:16') && c.resolutions.every(value => value === '720p')
      && c.frameRates.every(value => value === 24) && c.outputFormats.every(value => value === 'video/mp4')
      && c.maxReferenceCount === 1 && c.maxInputBytes >= MEDIA_MOCK_PNG.byteLength && c.maxInputBytes <= supported.maxInputBytes
      && c.resultRetentionSeconds === supported.resultRetentionSeconds;
  }

  private assertExecutable(profile: MediaVideoProfile): void {
    if (profile.modelId !== 'mock-video-v1' && this.realEnabled()) {
      if (!this.v3Compatible(profile)) throw new BadRequestException('视频配置超出通用适配器协议边界：异步查询、单 PNG 参考、MP4/WebM，不支持取消');
      return;
    }
    if (!this.mockEnabled()) throw new ServiceUnavailableException('视频仅支持显式启用的 mock，尚未接入真实执行');
    if (!this.compatible(profile)) throw new BadRequestException('当前仅支持 mock-video-v1 fixture：图生视频 5s 9:16 720p 24fps 无音 MP4；真实模型未适配');
  }

  async listProfiles(): Promise<MediaVideoProfile[]> {
    const rows = await this.prisma.mediaModelProfile.findMany({ where: { kind: 'video' }, orderBy: { createdAt: 'asc' } });
    return rows.map(row => this.profileView(row));
  }

  async getConnection() {
    if (!this.settings) throw new ServiceUnavailableException('视频连接配置暂不可用');
    const { baseUrl, apiKey, source } = await this.settings.getMediaConnection('video');
    return { configured: Boolean(baseUrl?.trim() && apiKey?.trim()), baseUrl: baseUrl ?? '',
      apiKeyConfigured: Boolean(apiKey?.trim()), source };
  }

  async updateConnection(dto: UpdateMediaConnectionDto, actorId?: string) {
    if (!this.settings) throw new ServiceUnavailableException('视频连接配置暂不可用');
    await this.settings.updateMediaConnection(dto, 'video', actorId);
    return this.getConnection();
  }

  async createProfile(input: CreateMediaVideoProfileDto): Promise<MediaVideoProfile> {
    const dto = this.parse<CreateMediaVideoProfileDto>(CreateMediaVideoProfileDtoSchema, input);
    if (dto.profileId.startsWith('auto-')) throw new BadRequestException('自动模型标识由系统维护');
    if (dto.enabled) throw new BadRequestException('视频配置必须先通过校验后才能启用');
    try {
      const row = await this.prisma.mediaModelProfile.create({
        data: { profileId: dto.profileId, kind: dto.kind, displayName: dto.displayName, modelId: dto.modelId,
          operations: [...new Set(dto.operations)], executionMode: dto.executionMode, capabilities: dto.capabilities,
          configVersion: `cfg_${randomUUID()}`, enabled: false, verified: false },
      });
      return this.profileView(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('媒体 Profile ID 已存在');
      throw error;
    }
  }

  async updateProfile(profileId: string, input: UpdateMediaVideoProfileDto): Promise<MediaVideoProfile> {
    const dto = this.parse<UpdateMediaVideoProfileDto>(UpdateMediaVideoProfileDtoSchema, input);
    if (profileId.startsWith('auto-') && ['modelId', 'operations', 'executionMode', 'capabilities'].some(key => key in dto)) {
      throw new BadRequestException('模型规格由适配器自动维护，请在客户端选择本次生成参数');
    }
    const current = await this.findProfile(profileId);
    if (dto.expectedConfigVersion !== current.configVersion) throw new ConflictException('视频配置已更新，请重新加载后保存');
    const { expectedConfigVersion: _version, capabilities, ...changes } = dto;
    const next = this.parse<MediaVideoProfile>(MediaVideoProfileSchema, {
      ...current, ...changes, operations: [...new Set(changes.operations ?? current.operations)],
      capabilities: { ...current.capabilities, ...capabilities },
    });
    const contractChanged = !isDeepStrictEqual(
      [current.modelId, current.operations, current.executionMode, current.capabilities],
      [next.modelId, next.operations, next.executionMode, next.capabilities],
    );
    if (contractChanged) { next.enabled = false; next.verified = false; }
    if (next.enabled) {
      if (!next.verified) throw new BadRequestException('视频配置必须先通过校验后才能启用');
      this.assertExecutable(next);
    }
    if (isDeepStrictEqual(current, next)) return current;
    const result = await this.prisma.mediaModelProfile.updateMany({
      where: { profileId, kind: 'video', configVersion: current.configVersion },
      data: { displayName: next.displayName, modelId: next.modelId, operations: next.operations,
        executionMode: next.executionMode, capabilities: next.capabilities, enabled: next.enabled, verified: next.verified,
        configVersion: `cfg_${randomUUID()}` },
    });
    if (!result.count) throw new ConflictException('视频配置已更新，请重新加载后保存');
    return this.findProfile(profileId);
  }

  async verifyProfile(profileId: string, input: VerifyMediaVideoProfileDto): Promise<MediaVideoProfileVerification> {
    const dto = this.parse<VerifyMediaVideoProfileDto>(VerifyMediaVideoProfileDtoSchema, input);
    const profile = await this.findProfile(profileId);
    if (dto.expectedConfigVersion !== profile.configVersion) throw new ConflictException('视频配置已更新，请重新加载后校验');
    this.assertExecutable(profile);
    if (profile.modelId !== 'mock-video-v1') {
      if (!this.videoAdapter || !this.videoFiles) throw new ServiceUnavailableException('真实视频组件不可用');
      await this.videoFiles.assertAvailable();
      const connection = await this.videoAdapter.connection();
      const models = await this.videoAdapter.discover(connection);
      if (!models.some(item => item.modelId === profile.modelId)) throw new BadRequestException('当前视频连接未授权此模型');
      const requestedSpec = dto.verificationSpec ?? { durationSeconds: profile.capabilities.durationsSeconds[0],
        aspectRatio: profile.capabilities.aspectRatios[0], resolution: profile.capabilities.resolutions[0],
        frameRate: profile.capabilities.frameRates[0], audio: profile.capabilities.supportsAudio,
        outputFormat: profile.capabilities.outputFormats[0] };
      if (profile.modelId !== 'minimax-h3' && !dto.verificationSpec) {
        throw new BadRequestException('新模型须显式提供 verificationSpec 校验通用视频协议，不能从目录推断规格');
      }
      for (const operation of profile.operations) await this.videoAdapter.pricing(connection, {
        protocolVersion: 3, specRevision: 1,
        profileId: profile.profileId, configVersion: profile.configVersion, operation,
        referenceIds: operation === 'image-to-video' ? ['verification-only'] : [], creativeBrief: 'Configuration verification only',
        requestedSpec,
      }, profile.modelId);
    }
    const updated = await this.prisma.mediaModelProfile.updateMany({
      where: { profileId, kind: 'video', configVersion: profile.configVersion },
      data: { verified: true, configVersion: `cfg_${randomUUID()}` },
    });
    if (!updated.count) throw new ConflictException('视频配置在校验期间已更新，请重试');
    return { profile: await this.findProfile(profileId), checkedAt: new Date().toISOString(), executionTested: false, mock: profile.modelId === 'mock-video-v1' };
  }

  async discoverModels(): Promise<MediaVideoModelDiscovery> {
    if (this.realEnabled() || !this.mockEnabled()) {
      if (!this.videoAdapter || !this.modelSync || !this.videoFiles) throw new ServiceUnavailableException('真实视频组件不可用');
      const connection = await this.videoAdapter.connection();
      const models = await this.videoAdapter.discover(connection);
      await this.videoFiles.assertAvailable();
      await this.modelSync.sync('video', models.map(model => ({
        ...model, autoCreate: model.modelId === 'minimax-h3', operations: ['image-to-video', 'text-to-video'], executionMode: 'async-query', capabilities: this.realCapabilities(),
      })), connection.fingerprint, row => {
        const parsed = MediaVideoProfileSchema.safeParse({
          profileId: row.profileId, kind: row.kind, displayName: row.displayName, modelId: row.modelId,
          configVersion: row.configVersion, operations: row.operations, executionMode: row.executionMode,
          capabilities: row.capabilities, enabled: row.enabled, verified: row.verified,
        });
        return parsed.success && this.v3Compatible(parsed.data);
      });
      return { checkedAt: new Date().toISOString(), mock: false, executionTested: false,
        models: models.map(model => ({ ...model,
          compatible: model.modelId === 'minimax-h3', reason: model.modelId === 'minimax-h3' ? '目录候选；需要显式配置、报价校验后启用' : '仅目录候选；可显式创建通用视频协议 Profile 并校验报价，尚未验证适配',
          suggested: model.modelId === 'minimax-h3' ? { operations: ['image-to-video', 'text-to-video'],
            executionMode: 'async-query', capabilities: this.realCapabilities() } : null,
        })),
      };
    }
    // No upstream catalog call, execution probe, pricing call, or connection credentials.
    return { checkedAt: new Date().toISOString(), mock: true, executionTested: false,
      models: this.mockEnabled() ? [{
        modelId: 'mock-video-v1', displayName: MOCK_PROFILE.displayName, compatible: true,
        reason: '仅离线 mock fixture 兼容，不代表真实模型验证或执行验收',
        suggested: { operations: [...MOCK_PROFILE.operations], executionMode: MOCK_PROFILE.executionMode,
          capabilities: structuredClone(MOCK_PROFILE.capabilities) },
      }] : [],
    };
  }

  private async availableProfiles(includeV3 = false): Promise<MediaVideoProfile[]> {
    if (!this.mockEnabled() && !this.realEnabled()) return [];
    if (this.realEnabled()) {
      if (!this.settings) return [];
      try { mediaConnectionFingerprint(await this.settings.getMediaConnection('video')); }
      catch (error) {
        if (error instanceof ServiceUnavailableException) return [];
        throw error;
      }
    }
    const rows = await this.prisma.mediaModelProfile.findMany({
      where: { kind: 'video', enabled: true, verified: true }, orderBy: { createdAt: 'asc' },
    });
    return rows.map(row => this.profileView(row)).filter(profile => this.realEnabled()
      ? includeV3 ? this.v3Compatible(profile) : this.realCompatible(profile) : this.compatible(profile));
  }

  async getAvailableProfiles(userId: string): Promise<MediaVideoAvailableProfile[]> {
    await this.enterpriseContext.resolve(userId);
    return (await this.availableProfiles(true)).map(({ modelId: _modelId, ...profile }) => profile);
  }

  async getEnterpriseConfig(userId: string): Promise<MediaVideoEnterpriseConfig> {
    const context = await this.enterpriseContext.resolve(userId);
    const config = await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId: context.enterpriseId } });
    return { policy: this.parsePolicy(config?.mediaPolicy), configured: this.mockEnabled() || (this.settings ? (await this.getConnection()).configured : false),
      canEdit: context.role === 'ENTERPRISE_ADMIN', mock: !this.realEnabled(), executionTested: false };
  }

  async updateEnterpriseConfig(userId: string, input: UpdateMediaVideoPolicyDto): Promise<MediaVideoEnterpriseConfig> {
    const dto = this.parse<UpdateMediaVideoPolicyDto>(UpdateMediaVideoPolicyDtoSchema, input);
    const context = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(context);
    try {
      await this.prisma.$transaction(async tx => {
        const existing = await tx.enterpriseModelConfig.findUnique({ where: { enterpriseId: context.enterpriseId } });
        const next = this.parse<MediaVideoPolicy>(MediaVideoPolicySchema, { ...this.parsePolicy(existing?.mediaPolicy), ...dto });
        next.enabledProfileIds = [...new Set(next.enabledProfileIds)];
        next.allowedOperations = [...new Set(next.allowedOperations)];
        next.allowedAspectRatios = [...new Set(next.allowedAspectRatios)];
        if (next.defaultProfileId && !next.enabledProfileIds.includes(next.defaultProfileId)) throw new BadRequestException('默认视频 Profile 必须包含在企业允许列表中');
        const stored = existing?.mediaPolicy;
        if (stored !== null && stored !== undefined && (typeof stored !== 'object' || Array.isArray(stored))) {
          throw new ServiceUnavailableException('企业媒体策略无效，请联系平台管理员');
        }
        // Read/merge/write in one Serializable transaction: preserve the entire image policy.
        const mediaPolicy = { ...(stored as Record<string, Prisma.JsonValue> ?? {}), video: next } as Prisma.InputJsonValue;
        await tx.enterpriseModelConfig.upsert({
          where: { enterpriseId: context.enterpriseId },
          create: { enterpriseId: context.enterpriseId, mediaPolicy }, update: { mediaPolicy },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(error.code)) {
        throw new ConflictException('企业媒体策略已被其他管理员更新，请重新加载后保存');
      }
      throw error;
    }
    return this.getEnterpriseConfig(userId);
  }

  async previewEnterpriseConfig(userId: string, input: MediaVideoPolicyPreviewRequest): Promise<MediaVideoPolicyPreview> {
    const request = this.parse<MediaVideoPolicyPreviewRequest>(MediaVideoPolicyPreviewRequestSchema, input);
    const context = await this.enterpriseContext.resolve(userId);
    const storedConfig = await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId: context.enterpriseId } });
    const policy = context.role === 'ENTERPRISE_ADMIN' ? request.policy : this.parsePolicy(storedConfig?.mediaPolicy);
    const configured = this.mockEnabled() || (this.settings ? (await this.getConnection()).configured : false);
    const rows = await this.listProfiles();
    const runtimeProfiles = await this.availableProfiles();
    const visibleRows = context.role === 'ENTERPRISE_ADMIN' ? rows : rows.filter(profile => policy.enabledProfileIds.includes(profile.profileId));
    const permissive: MediaVideoPolicy = { ...policy, enabledProfileIds: rows.map(profile => profile.profileId), defaultProfileId: null };
    const [available, effective] = await Promise.all([
      request.protocolVersion === 3 ? this.getRuntimeVideoV3(context.enterpriseId, permissive, rows)
        : request.protocolVersion === 2 ? this.getRuntimeVideoV2(context.enterpriseId, permissive, runtimeProfiles)
          : this.getRuntimeVideo(context.enterpriseId, permissive, runtimeProfiles),
      request.protocolVersion === 3 ? this.getRuntimeVideoV3(context.enterpriseId, policy, rows)
        : request.protocolVersion === 2 ? this.getRuntimeVideoV2(context.enterpriseId, policy, runtimeProfiles)
          : this.getRuntimeVideo(context.enterpriseId, policy, runtimeProfiles),
    ]);
    const availableById = new Map(available.profiles.map(profile => [profile.profileId, profile] as const));
    const effectiveById = new Map(effective.profiles.map(profile => [profile.profileId, profile] as const));
    const executionMode = this.realEnabled() ? 'real' as const : this.mockEnabled() ? 'mock' as const : 'disabled' as const;
    const executableProfile = (profile: (typeof effective.profiles)[number]) => request.protocolVersion !== 3
      || ('adapter' in profile && profile.adapter.available && !profile.unavailableReason);
    const result = { protocolVersion: request.protocolVersion, executionMode, configured, executionAvailable: effective.executionAvailable,
      defaultProfileId: policy.defaultProfileId, defaultProfileValid: executionMode !== 'disabled' && Boolean(policy.defaultProfileId
        && effective.profiles.some(profile => profile.profileId === policy.defaultProfileId && executableProfile(profile))),
      profiles: [...visibleRows.map(profile => {
        const reasons: MediaVideoPolicyPreview['profiles'][number]['reasons'] = [];
        const baseline = availableById.get(profile.profileId);
        const current = effectiveById.get(profile.profileId);
        if (!policy.enabledProfileIds.includes(profile.profileId)) reasons.push('not-authorized');
        if (!profile.enabled) reasons.push('disabled');
        if (!profile.verified) reasons.push('unverified');
        if (!configured) reasons.push('connection-unconfigured');
        if (executionMode === 'disabled') reasons.push('execution-disabled');
        if (!baseline && profile.enabled && profile.verified && configured) reasons.push('adapter-unsupported');
        if (request.protocolVersion === 3 && current && !executableProfile(current)
          && !reasons.some(reason => ['disabled', 'unverified', 'connection-unconfigured', 'execution-disabled'].includes(reason))) {
          reasons.push('adapter-unsupported');
        }
        const status: MediaVideoPolicyPreview['profiles'][number]['status'] = current && executableProfile(current) && executionMode !== 'disabled' ? 'effective'
          : reasons.includes('not-authorized') ? 'not-authorized' : 'unavailable';
        return { profileId: profile.profileId, configVersion: profile.configVersion, status, effectiveProfile: current ?? null, reasons };
      }), ...(context.role === 'ENTERPRISE_ADMIN' ? policy.enabledProfileIds.filter(profileId => !rows.some(profile => profile.profileId === profileId)) : [])
        .map(profileId => ({ profileId, configVersion: null, status: 'unavailable' as const, effectiveProfile: null, reasons: ['profile-missing' as const] }))] };
    return this.parse<MediaVideoPolicyPreview>(MediaVideoPolicyPreviewSchema, result);
  }

  async getRuntimeVideo(enterpriseId: string, policyOverride?: MediaVideoPolicy, profilesOverride?: MediaVideoProfile[]): Promise<MediaVideoRuntime> {
    const disabled: MediaVideoRuntime = { protocolVersion: 1, executionAvailable: false, defaultProfileId: null, tools: [], profiles: [] };
    if (!this.mockEnabled() && !this.realEnabled()) return disabled;
    const config = policyOverride ? null : await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId } });
    const policy = policyOverride ?? this.parsePolicy(config?.mediaPolicy);
    const profiles = (profilesOverride ?? await this.availableProfiles()).filter(profile => policy.enabledProfileIds.includes(profile.profileId))
      .map(profile => ({
        profileId: profile.profileId, kind: profile.kind, displayName: profile.displayName,
        configVersion: profile.configVersion, executionMode: profile.executionMode,
        operations: profile.operations,
        capabilities: { ...profile.capabilities,
          supportsCancel: false,
        },
      })).filter(profile => profile.operations.length && profile.capabilities.durationsSeconds.length
        && profile.capabilities.aspectRatios.length && profile.capabilities.resolutions.length);
    return MediaVideoRuntimeSchema.parse({
      protocolVersion: 1, executionAvailable: profiles.length > 0, profiles,
      ...(this.realEnabled() ? { executionMode: 'real' as const } : {}),
      defaultProfileId: profiles.some(profile => profile.profileId === policy.defaultProfileId) ? policy.defaultProfileId : null,
      tools: profiles.length ? [
        ...(profiles.some(profile => profile.operations.includes('image-to-video')) ? ['video_from_image' as const] : []),
        ...(profiles.some(profile => profile.operations.includes('text-to-video')) ? ['video_generate' as const] : []),
        'video_get_job',
      ] : [],
    });
  }

  async getRuntimeVideoV2(enterpriseId: string, policyOverride?: MediaVideoPolicy, profilesOverride?: MediaVideoProfile[]) {
    const legacy = await this.getRuntimeVideo(enterpriseId, policyOverride, profilesOverride);
    const modelIds = new Map((profilesOverride ?? await this.availableProfiles()).map(profile => [profile.profileId, profile.modelId]));
    const profiles = legacy.profiles.map(profile => {
      const c = profile.capabilities;
      const audioModes = modelIds.get(profile.profileId) === 'minimax-h3' && this.realEnabled() ? [true] : c.supportsAudio ? [false, true] : [false];
      const defaultAudio = audioModes[0];
      return { ...profile, capabilities: { ...c, audioModes, defaultAudio,
        defaults: { durationSeconds: c.durationsSeconds[0], aspectRatio: c.aspectRatios[0],
          resolution: c.resolutions[0], frameRate: c.frameRates[0], audio: defaultAudio,
          outputFormat: c.outputFormats[0] } } };
    });
    return MediaVideoRuntimeV2Schema.parse({ ...legacy, protocolVersion: 2, profiles });
  }

  async getRuntimeVideoV3(enterpriseId: string, policyOverride?: MediaVideoPolicy, profilesOverride?: MediaVideoProfile[]): Promise<MediaVideoRuntimeV3> {
    const config = policyOverride ? null : await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId } });
    const policy = policyOverride ?? this.parsePolicy(config?.mediaPolicy);
    const configuredProfiles = profilesOverride ?? await this.listProfiles();
    let connectionUsable = false;
    if (this.realEnabled() && this.settings) {
      try {
        mediaConnectionFingerprint(await this.settings.getMediaConnection('video'));
        connectionUsable = true;
      } catch {
        connectionUsable = false;
      }
    }
    const profiles = configuredProfiles.filter(profile => policy.enabledProfileIds.includes(profile.profileId)).map(profile => {
      const operations = profile.operations.filter(operation => operation === 'image-to-video' || operation === 'text-to-video');
      const reason = !profile.enabled ? 'PROFILE_DISABLED'
        : !profile.verified ? 'PROFILE_UNVERIFIED'
          : !this.realEnabled() ? 'EXECUTION_DISABLED'
            : !connectionUsable ? 'CONNECTION_UNAVAILABLE'
              : profile.executionMode !== 'async-query' ? 'ADAPTER_PROTOCOL_UNSUPPORTED'
                : operations.length === 0 ? 'ADAPTER_OPERATION_UNSUPPORTED' : undefined;
      const capabilityHints = [
        { field: 'durationSeconds', values: profile.capabilities.durationsSeconds, source: 'profile-config', observedAt: null, confidence: 'declared' as const },
        { field: 'aspectRatio', values: profile.capabilities.aspectRatios, source: 'profile-config', observedAt: null, confidence: 'declared' as const },
        { field: 'resolution', values: profile.capabilities.resolutions, source: 'profile-config', observedAt: null, confidence: 'declared' as const },
        ...(profile.capabilities.supportsAudio
          ? [{ field: 'audio', values: [true], source: 'profile-config', observedAt: null, confidence: 'declared' as const }]
          : []),
        { field: 'outputFormat', values: profile.capabilities.outputFormats, source: 'profile-config', observedAt: null, confidence: 'declared' as const },
      ].filter(hint => hint.values.length > 0);
      return {
        profileId: profile.profileId, configVersion: profile.configVersion, kind: 'video' as const,
        displayName: profile.displayName, operations, executionMode: 'async-query' as const, authorized: true,
        adapter: {
          id: 'sub2api-video', version: '3', available: reason === undefined, ...(reason ? { reason } : {}), operations,
          referenceSupport: {
            maxCount: operations.includes('image-to-video') ? 1 : 0,
            maxInputBytes: 10 * 1024 * 1024,
            mimeTypes: operations.includes('image-to-video') ? ['image/png'] : [],
          },
          supportsTaskQuery: true,
          supportsCancel: false,
        },
        capabilityHints,
        ...(reason ? { unavailableReason: reason } : {}),
      };
    });
    const executable = profiles.filter(profile => profile.adapter.available);
    const tools = [
      ...(executable.some(profile => profile.operations.includes('image-to-video')) ? ['video_from_image'] : []),
      ...(executable.some(profile => profile.operations.includes('text-to-video')) ? ['video_generate'] : []),
      ...(executable.some(profile => profile.adapter.supportsTaskQuery) ? ['video_get_job'] : []),
      ...(executable.some(profile => profile.adapter.supportsCancel) ? ['video_cancel_job'] : []),
    ];
    return MediaVideoRuntimeV3Schema.parse({
      protocolVersion: 3,
      executionMode: this.realEnabled() && connectionUsable ? 'real' : this.mockEnabled() ? 'mock' : 'disabled',
      executionAvailable: executable.length > 0,
      defaultProfileId: policy.defaultProfileId && profiles.some(profile => profile.profileId === policy.defaultProfileId)
        ? policy.defaultProfileId : null,
      tools: executable.length > 0 ? tools : [],
      profiles,
    });
  }
}
