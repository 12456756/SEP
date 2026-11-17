import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaModelProfile, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { resolveSub2apiImageSpec, Sub2apiImageAdapter } from '../media-gateway/sub2api-image.adapter';
import { imageModelCapabilities, IMAGE_MODEL_SIZES, isSupportedImageModel } from '../media-gateway/image-model-contract';
import { MediaModelSyncService, mediaConnectionFingerprint } from './media-model-sync.service';
import { MediaRuntimeV3Schema } from 'shared';
import type { MediaRuntimeV3 } from 'shared';
import {
  CreateMediaProfileDto,
  MediaCapabilitiesSchema,
  MediaPolicyPreview,
  MediaPolicyPreviewRequest,
  MediaPolicyPreviewRequestSchema,
  MediaPolicyPreviewSchema,
  MediaPolicy,
  MediaPolicySchema,
  MediaAuthorizationSchema,
  MediaProfile,
  MediaProfileSchema,
  MediaRuntime,
  MediaRuntimeV2Schema,
  MediaModelDiscovery,
  MediaProfileVerification,
  MediaRealQuoteRequest,
  MediaRealQuoteRequestV3,
  UpdateMediaConnectionDto,
  UpdateMediaPolicyDto,
  UpdateMediaProfileDto,
  VerifyMediaProfileDto,
} from 'shared';

@Injectable()
export class MediaConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingService: SettingService,
    private readonly enterpriseContext: EnterpriseContextService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly imageAdapter?: Sub2apiImageAdapter,
    @Optional() private readonly modelSync?: MediaModelSyncService,
  ) {}

  private profileView(row: MediaModelProfile): MediaProfile {
    const result = MediaProfileSchema.safeParse({
      profileId: row.profileId, kind: row.kind, displayName: row.displayName,
      modelId: row.modelId, configVersion: row.configVersion,
      operations: row.operations, executionMode: row.executionMode,
      capabilities: row.capabilities, enabled: row.enabled, verified: row.verified,
    });
    if (!result.success) throw new ServiceUnavailableException('媒体 Profile 配置无效，请联系平台管理员');
    return result.data;
  }

  private parsePolicy(value: unknown): MediaPolicy {
    const parsed = MediaPolicySchema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    // Invalid video JSON must not reset an otherwise valid image policy.
    if (value && typeof value === 'object' && !Array.isArray(value) && 'video' in value) {
      const { video: _video, ...imagePolicy } = value;
      const image = MediaPolicySchema.safeParse(imagePolicy);
      if (image.success) return image.data;
    }
    // Retired limits (including malformed historical values) are not grants.
    const authorization = MediaAuthorizationSchema.safeParse(value ?? {});
    if (authorization.success) return MediaPolicySchema.parse(authorization.data);
    return MediaPolicySchema.parse({});
  }

  async listProfiles(): Promise<MediaProfile[]> {
    const rows = await this.prisma.mediaModelProfile.findMany({ where: { kind: 'image' }, orderBy: { createdAt: 'asc' } });
    return rows.map((row) => this.profileView(row));
  }

  async createProfile(dto: CreateMediaProfileDto): Promise<MediaProfile> {
    if (dto.profileId.startsWith('auto-')) throw new BadRequestException('自动模型标识由系统维护');
    if (dto.enabled) throw new BadRequestException('媒体 Profile 必须先通过配置校验后才能启用');
    const capabilities = MediaCapabilitiesSchema.safeParse(dto.capabilities);
    if (!capabilities.success) throw new BadRequestException('媒体能力配置无效');
    try {
      const created = await this.prisma.mediaModelProfile.create({
        data: {
          profileId: dto.profileId,
          kind: dto.kind,
          displayName: dto.displayName,
          modelId: dto.modelId,
          executionMode: dto.executionMode,
          enabled: dto.enabled,
          operations: [...new Set(dto.operations)],
          capabilities: capabilities.data,
          configVersion: `cfg_${randomUUID()}`,
          verified: false,
        },
      });
      return this.profileView(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('媒体 Profile ID 已存在');
      }
      throw error;
    }
  }

  async updateProfile(profileId: string, dto: UpdateMediaProfileDto): Promise<MediaProfile> {
    if (profileId.startsWith('auto-') && ['modelId', 'executionMode'].some(key => key in dto)) {
      throw new BadRequestException('自动模型的模型标识和执行协议不可修改');
    }
    const row = await this.prisma.mediaModelProfile.findUnique({ where: { profileId } });
    if (!row) throw new NotFoundException('媒体 Profile 不存在');
    const current = this.profileView(row);
    if (dto.expectedConfigVersion !== current.configVersion) {
      throw new ConflictException('媒体配置已更新，请重新加载后保存');
    }
    const { expectedConfigVersion: _version, capabilities, ...changes } = dto;
    const parsed = MediaProfileSchema.safeParse({
      ...current, ...changes,
      operations: [...new Set(changes.operations ?? current.operations)],
      capabilities: { ...current.capabilities, ...capabilities },
    });
    if (!parsed.success) throw new BadRequestException('媒体 Profile 配置无效');
    const next = parsed.data;
    if (next.enabled && !current.verified) throw new BadRequestException('媒体 Profile 必须先通过配置校验后才能启用');
    if (next.operations.includes('edit') && (!next.capabilities.supportsReferenceImage || next.capabilities.maxReferenceCount < 1)) {
      throw new BadRequestException('编辑能力必须支持参考图');
    }
    const contractChanged = !isDeepStrictEqual(
      [current.modelId, current.operations, current.executionMode, current.capabilities],
      [next.modelId, next.operations, next.executionMode, next.capabilities],
    );
    if (isDeepStrictEqual(current, next)) return current;
    const updated = await this.prisma.mediaModelProfile.updateMany({
      where: { profileId, configVersion: current.configVersion },
      data: {
        displayName: next.displayName, modelId: next.modelId,
        operations: next.operations, executionMode: next.executionMode,
        capabilities: next.capabilities, enabled: next.enabled,
        configVersion: `cfg_${randomUUID()}`,
        verified: contractChanged ? false : current.verified,
      },
    });
    if (!updated.count) throw new ConflictException('媒体配置已更新，请重新加载后保存');
    const saved = await this.prisma.mediaModelProfile.findUnique({ where: { profileId } });
    if (!saved) throw new NotFoundException('媒体 Profile 不存在');
    return this.profileView(saved);
  }

  async getConnection() {
    const { baseUrl, apiKey, source } = await this.settingService.getMediaConnection('image');
    return {
      configured: Boolean(baseUrl?.trim() && apiKey?.trim()),
      baseUrl: baseUrl ?? '', apiKeyConfigured: Boolean(apiKey?.trim()),
      source,
    };
  }

  async updateConnection(dto: UpdateMediaConnectionDto, actorId?: string) {
    await this.settingService.updateMediaConnection(dto, 'image', actorId);
    return this.getConnection();
  }

  async discoverModels(): Promise<MediaModelDiscovery> {
    if (!this.imageAdapter || !this.modelSync) throw new ServiceUnavailableException('媒体模型检测暂不可用');
    const connection = await this.settingService.getMediaConnection('image');
    const fingerprint = mediaConnectionFingerprint(connection);
    const models = await this.imageAdapter.discoverModels({ base: connection.baseUrl, key: connection.apiKey });
    await this.modelSync.sync('image', models.map(model => ({
      ...model, autoCreate: isSupportedImageModel(model.modelId), operations: ['generate', 'edit'], executionMode: 'sync-response',
      capabilities: { supportsReferenceImage: true, maxOutputs: 4, sizes: [...IMAGE_MODEL_SIZES] },
    })), fingerprint, row => {
      const parsed = MediaProfileSchema.safeParse({
        profileId: row.profileId, kind: row.kind, displayName: row.displayName, modelId: row.modelId,
        configVersion: row.configVersion, operations: row.operations, executionMode: row.executionMode,
        capabilities: row.capabilities, enabled: row.enabled, verified: row.verified,
      });
      return parsed.success && this.adapterCompatible(parsed.data);
    });
    return {
      checkedAt: new Date().toISOString(),
      models: models.map(model => {
        const compatible = isSupportedImageModel(model.modelId);
        return {
          ...model, compatible,
          reason: compatible ? '目录候选；需要显式配置、报价校验后启用' : '仅目录候选；可显式创建通用图片协议 Profile 并校验报价，尚未验证适配',
          suggested: compatible ? {
            operations: ['generate', 'edit'], executionMode: 'sync-response',
            capabilities: { supportsReferenceImage: true, maxOutputs: 4, sizes: [...IMAGE_MODEL_SIZES] },
          } : null,
        };
      }),
    };
  }

  private adapterCompatible(profile: MediaProfile): boolean {
    return profile.executionMode === 'sync-response'
      && profile.capabilities.maxOutputs <= 8
      && profile.capabilities.sizes.every(size => /^\S{1,64}$/.test(size))
      && (!profile.operations.includes('edit') || profile.capabilities.supportsReferenceImage);
  }

  async verifyProfile(profileId: string, dto: VerifyMediaProfileDto): Promise<MediaProfileVerification> {
    if (!this.imageAdapter) throw new ServiceUnavailableException('媒体配置校验暂不可用');
    const row = await this.prisma.mediaModelProfile.findUnique({ where: { profileId } });
    if (!row) throw new NotFoundException('媒体 Profile 不存在');
    const profile = this.profileView(row);
    if (profile.configVersion !== dto.expectedConfigVersion) throw new ConflictException('媒体配置已更新，请重新加载后校验');
    if (profile.executionMode !== 'sync-response' ||
      profile.capabilities.maxOutputs > 8 || profile.capabilities.sizes.some(size => !/^\S{1,64}$/.test(size)) ||
      (profile.operations.includes('edit') && !profile.capabilities.supportsReferenceImage)) {
      throw new BadRequestException('当前模型或参数超出图片适配器支持范围');
    }
    try {
      const discovered = await this.imageAdapter.discoverModels();
      if (!discovered.some(model => model.modelId === profile.modelId)) throw new BadRequestException('媒体连接的模型目录中不存在此模型');
      const checks: Array<MediaRealQuoteRequest | MediaRealQuoteRequestV3> = [];
      if (!isSupportedImageModel(profile.modelId) && !dto.verificationSpec) {
        throw new BadRequestException('新模型须显式提供 verificationSpec 校验通用图片协议，不能从目录推断规格');
      }
      if (dto.verificationSpec) {
        for (const operation of profile.operations) {
          const input: MediaRealQuoteRequestV3 = { protocolVersion: 3, specRevision: 1, profileId,
            configVersion: profile.configVersion, operation, creativeBrief: 'Media configuration preflight',
            referenceIds: operation === 'edit' ? ['verification-only'] : [], requestedSpec: dto.verificationSpec };
          checks.push({ ...input, requestedSpec: resolveSub2apiImageSpec(input, 'quote') });
        }
      } else {
        for (const operation of [...new Set(profile.operations)]) {
          for (const size of [...new Set(profile.capabilities.sizes)]) {
            for (const quality of ['low', 'medium', 'high'] as const) {
              for (let count = 1; count <= profile.capabilities.maxOutputs; count++) {
                checks.push({ profileId, configVersion: profile.configVersion, operation,
                  creativeBrief: 'Media configuration preflight', referenceIds: [],
                  parameters: { size: size as MediaRealQuoteRequest['parameters']['size'], count, quality } });
              }
            }
          }
        }
      }
      // Pricing is read-only. Bound concurrency and never call the execution endpoint here.
      for (let offset = 0; offset < checks.length; offset += 3) {
        await Promise.all(checks.slice(offset, offset + 3).map(async input => {
          const price = await this.imageAdapter!.pricing(input, profile.modelId);
          if (!price.amount_usd || new Decimal(price.amount_usd).lte(0)) throw new ServiceUnavailableException('模型没有可用的正金额报价');
        }));
      }
    } catch (error) {
      await this.prisma.mediaModelProfile.updateMany({
        where: { profileId, configVersion: profile.configVersion, verified: true },
        data: { verified: false, configVersion: `cfg_${randomUUID()}` },
      });
      throw error;
    }
    const updated = await this.prisma.mediaModelProfile.updateMany({
      where: { profileId, configVersion: profile.configVersion },
      data: { verified: true, configVersion: `cfg_${randomUUID()}` },
    });
    if (!updated.count) throw new ConflictException('媒体连接或配置在校验期间已变更，请重新加载后重试');
    const saved = await this.prisma.mediaModelProfile.findUnique({ where: { profileId } });
    if (!saved) throw new NotFoundException('媒体 Profile 已被删除');
    return { profile: this.profileView(saved), checkedAt: new Date().toISOString(), executionTested: false };
  }

  private async availableProfiles() {
    try {
      if (!(await this.getConnection()).configured) return [];
    } catch (error) {
      // A broken media credential must disable media, not the employee's chat runtime.
      if (error instanceof ServiceUnavailableException) return [];
      throw error;
    }
    const rows = await this.prisma.mediaModelProfile.findMany({
      where: { kind: 'image', enabled: true, verified: true }, orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.profileView(row));
  }

  private async realConnectionUsable(): Promise<boolean> {
    try {
      const { baseUrl, apiKey } = await this.settingService.getMediaConnection('image');
      if (!baseUrl?.trim() || !apiKey?.trim() || /[\r\n]/.test(apiKey)) return false;
      const url = new URL(baseUrl.trim());
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  private async realRuntimeEnabled(): Promise<boolean> {
    if (this.config?.get<string>('MEDIA_GATEWAY_REAL_ENABLED') !== 'true') return false;
    return this.realConnectionUsable();
  }

  async getAvailableProfiles(userId: string) {
    await this.enterpriseContext.resolve(userId);
    return (await this.availableProfiles()).map(({ modelId: _modelId, ...profile }) => profile);
  }

  async getEnterpriseConfig(userId: string) {
    const context = await this.enterpriseContext.resolve(userId);
    const [config, connection] = await Promise.all([
      this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId: context.enterpriseId } }),
      this.getConnection(),
    ]);
    return {
      policy: this.parsePolicy(config?.mediaPolicy), configured: connection.configured,
      canEdit: context.role === 'ENTERPRISE_ADMIN',
    };
  }

  async updateEnterpriseConfig(userId: string, dto: UpdateMediaPolicyDto) {
    const context = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(context);
    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.enterpriseModelConfig.findUnique({ where: { enterpriseId: context.enterpriseId } });
        const parsed = MediaPolicySchema.safeParse({ ...this.parsePolicy(existing?.mediaPolicy), ...dto });
        if (!parsed.success) throw new BadRequestException('企业媒体策略无效');
        const next = parsed.data;
        next.enabledProfileIds = [...new Set(next.enabledProfileIds)];
        next.allowedOperations = [...new Set(next.allowedOperations)];
        if (next.defaultProfileId && !next.enabledProfileIds.includes(next.defaultProfileId)) {
          throw new BadRequestException('默认媒体 Profile 必须包含在企业允许列表中');
        }
        // The image endpoint never owns the independently managed video JSON.
        const stored = existing?.mediaPolicy;
        const mediaPolicy = stored && typeof stored === 'object' && !Array.isArray(stored) && 'video' in stored
          ? { ...next, video: stored.video } : next;
        await tx.enterpriseModelConfig.upsert({
          where: { enterpriseId: context.enterpriseId },
          create: { enterpriseId: context.enterpriseId, mediaPolicy: mediaPolicy as Prisma.InputJsonValue },
          update: { mediaPolicy: mediaPolicy as Prisma.InputJsonValue },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('企业媒体策略已被其他管理员更新，请重新加载后保存');
      }
      throw error;
    }
    return this.getEnterpriseConfig(userId);
  }

  async previewEnterpriseConfig(userId: string, input: MediaPolicyPreviewRequest): Promise<MediaPolicyPreview> {
    const request = MediaPolicyPreviewRequestSchema.parse(input);
    const context = await this.enterpriseContext.resolve(userId);
    const storedConfig = await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId: context.enterpriseId } });
    const policy = context.role === 'ENTERPRISE_ADMIN' ? request.policy as MediaPolicy : this.parsePolicy(storedConfig?.mediaPolicy);
    const configured = (await this.getConnection()).configured;
    const profiles = await this.listProfiles();
    const runtimeProfiles = await this.availableProfiles();
    const visibleProfiles = context.role === 'ENTERPRISE_ADMIN' ? profiles : profiles.filter(profile => policy.enabledProfileIds.includes(profile.profileId));
    const permissive: MediaPolicy = { ...policy, enabledProfileIds: profiles.map(profile => profile.profileId), defaultProfileId: null };
    const [available, effective] = await Promise.all([
      request.protocolVersion === 3 ? this.getRuntimeMediaV3(context.enterpriseId, permissive, profiles)
        : request.protocolVersion === 2 ? this.getRuntimeMediaV2(context.enterpriseId, permissive, runtimeProfiles)
          : this.getRuntimeMedia(context.enterpriseId, permissive, runtimeProfiles),
      request.protocolVersion === 3 ? this.getRuntimeMediaV3(context.enterpriseId, policy, profiles)
        : request.protocolVersion === 2 ? this.getRuntimeMediaV2(context.enterpriseId, policy, runtimeProfiles)
          : this.getRuntimeMedia(context.enterpriseId, policy, runtimeProfiles),
    ]);
    const availableById = new Map(available.profiles.map(profile => [profile.profileId, profile] as const));
    const effectiveById = new Map(effective.profiles.map(profile => [profile.profileId, profile] as const));
    const executionMode = (await this.realRuntimeEnabled()) ? 'real' as const : 'disabled' as const;
    const executableProfile = (profile: (typeof effective.profiles)[number]) => request.protocolVersion !== 3
      || ('adapter' in profile && profile.adapter.available && !profile.unavailableReason);
    const result = { protocolVersion: request.protocolVersion, executionMode, configured, executionAvailable: effective.executionAvailable,
      defaultProfileId: policy.defaultProfileId, defaultProfileValid: executionMode !== 'disabled' && Boolean(policy.defaultProfileId
        && effective.profiles.some(profile => profile.profileId === policy.defaultProfileId && executableProfile(profile))),
      profiles: [...visibleProfiles.map(profile => {
        const reasons: MediaPolicyPreview['profiles'][number]['reasons'] = [];
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
        const status: MediaPolicyPreview['profiles'][number]['status'] = current && executableProfile(current) && executionMode !== 'disabled' ? 'effective'
          : reasons.includes('not-authorized') ? 'not-authorized' : 'unavailable';
        return { profileId: profile.profileId, configVersion: profile.configVersion, status, effectiveProfile: current ?? null, reasons };
      }), ...(context.role === 'ENTERPRISE_ADMIN' ? policy.enabledProfileIds.filter(profileId => !profiles.some(profile => profile.profileId === profileId)) : [])
        .map(profileId => ({ profileId, configVersion: null, status: 'unavailable' as const, effectiveProfile: null, reasons: ['profile-missing' as const] }))] };
    return MediaPolicyPreviewSchema.parse(result);
  }

  async getRuntimeMedia(enterpriseId: string, policyOverride?: MediaPolicy, profilesOverride?: MediaProfile[]): Promise<MediaRuntime> {
    const config = policyOverride ? null : await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId } });
    const policy = policyOverride ?? this.parsePolicy(config?.mediaPolicy);
    const realEnabled = await this.realRuntimeEnabled();
    const profiles = (profilesOverride ?? await this.availableProfiles())
      .filter((profile) => policy.enabledProfileIds.includes(profile.profileId))
      .filter((profile) => !realEnabled || (isSupportedImageModel(profile.modelId) && profile.executionMode === 'sync-response'))
      .map((profile) => {
        const sizes = profile.capabilities.sizes.filter(size => !realEnabled || (IMAGE_MODEL_SIZES as readonly string[]).includes(size));
        const dimensions = sizes.map(size => size.split('x').map(Number));
        return {
          profileId: profile.profileId, kind: profile.kind, displayName: profile.displayName,
          configVersion: profile.configVersion, executionMode: profile.executionMode,
          operations: profile.operations.filter((operation) => !realEnabled || operation === 'generate' || profile.capabilities.supportsReferenceImage),
          capabilities: {
            supportsReferenceImage: profile.capabilities.supportsReferenceImage,
            maxOutputs: Math.min(profile.capabilities.maxOutputs, realEnabled ? 4 : 8),
            maxWidth: Math.max(0, ...dimensions.map(([width]) => width)),
            maxHeight: Math.max(0, ...dimensions.map(([, height]) => height)),
            sizes,
          },
        };
      })
      .filter((profile) => profile.operations.length > 0 && profile.capabilities.sizes.length > 0);
    const tools = realEnabled
      ? [
        ...(profiles.some((profile) => profile.operations.includes('generate')) ? ['image_generate'] : []),
        ...(profiles.some((profile) => profile.operations.includes('edit')) ? ['image_edit'] : []),
      ]
      : [];
    return {
      protocolVersion: 1,
      executionAvailable: realEnabled && profiles.length > 0,
      tools, profiles,
      defaultProfileId: profiles.some((profile) => profile.profileId === policy.defaultProfileId)
        ? policy.defaultProfileId : null,
    };
  }

  async getRuntimeMediaV2(enterpriseId: string, policyOverride?: MediaPolicy, profilesOverride?: MediaProfile[]) {
    const legacy = await this.getRuntimeMedia(enterpriseId, policyOverride, profilesOverride);
    const modelIds = new Map((profilesOverride ?? await this.availableProfiles()).map(profile => [profile.profileId, profile.modelId]));
    const profiles = legacy.profiles.filter(profile => isSupportedImageModel(modelIds.get(profile.profileId) ?? '')).map(profile => {
      const capabilities = imageModelCapabilities(modelIds.get(profile.profileId) ?? '');
      const sizes = profile.capabilities.sizes.filter(size => capabilities?.sizes.includes(size as typeof IMAGE_MODEL_SIZES[number]));
      const defaultSize = capabilities?.defaultSize && sizes.includes(capabilities.defaultSize) ? capabilities.defaultSize : sizes[0] ?? '';
      return { ...profile, capabilities: { ...profile.capabilities, sizes,
        qualities: capabilities?.qualities ?? [], defaultQuality: capabilities?.defaultQuality ?? 'medium', defaultSize } };
    }).filter(profile => profile.capabilities.sizes.length > 0);
    const value = { ...legacy, protocolVersion: 2 as const, profiles,
      defaultProfileId: profiles.some(profile => profile.profileId === legacy.defaultProfileId) ? legacy.defaultProfileId : null,
      executionAvailable: legacy.executionAvailable && profiles.length > 0,
      tools: profiles.length ? legacy.tools : [] };
    return MediaRuntimeV2Schema.parse(value);
  }

  async getRuntimeMediaV3(enterpriseId: string, policyOverride?: MediaPolicy, profilesOverride?: MediaProfile[]): Promise<MediaRuntimeV3> {
    const config = policyOverride ? null : await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId } });
    const policy = policyOverride ?? this.parsePolicy(config?.mediaPolicy);
    const configuredProfiles = profilesOverride ?? await this.listProfiles();
    const executionEnabled = this.config?.get<string>('MEDIA_GATEWAY_REAL_ENABLED') === 'true';
    const connectionUsable = await this.realConnectionUsable();
    const profiles = configuredProfiles.filter(profile => policy.enabledProfileIds.includes(profile.profileId)).map(profile => {
      const operations = profile.operations.filter(operation => operation === 'generate' || operation === 'edit');
      const reason = !profile.enabled ? 'PROFILE_DISABLED'
        : !profile.verified ? 'PROFILE_UNVERIFIED'
          : !executionEnabled ? 'EXECUTION_DISABLED'
            : !connectionUsable ? 'CONNECTION_UNAVAILABLE'
              : profile.executionMode !== 'sync-response' ? 'ADAPTER_PROTOCOL_UNSUPPORTED'
                : operations.length === 0 ? 'ADAPTER_OPERATION_UNSUPPORTED' : undefined;
      const hints = [
        { field: 'size', values: profile.capabilities.sizes, source: 'profile-config', observedAt: null, confidence: 'declared' as const },
      ].filter(hint => hint.values.length > 0);
      return {
        profileId: profile.profileId, configVersion: profile.configVersion, kind: 'image' as const,
        displayName: profile.displayName, operations, executionMode: 'sync-response' as const, authorized: true,
        adapter: {
          id: 'sub2api-image', version: '3', available: reason === undefined, ...(reason ? { reason } : {}), operations,
          referenceSupport: {
            maxCount: profile.capabilities.supportsReferenceImage ? profile.capabilities.maxReferenceCount : 0,
            maxInputBytes: profile.capabilities.supportsReferenceImage ? 5 * 1024 * 1024 : 1,
            mimeTypes: profile.capabilities.supportsReferenceImage ? ['image/png'] : [],
          },
          supportsTaskQuery: false, supportsCancel: false,
        },
        capabilityHints: hints,
        ...(reason ? { unavailableReason: reason } : {}),
      };
    });
    const executable = profiles.filter(profile => profile.adapter.available);
    const tools = [
      ...(executable.some(profile => profile.operations.includes('generate')) ? ['image_generate'] : []),
      ...(executable.some(profile => profile.operations.includes('edit')) ? ['image_edit'] : []),
    ];
    const defaultProfileId = policy.defaultProfileId && profiles.some(profile => profile.profileId === policy.defaultProfileId)
      ? policy.defaultProfileId : null;
    return MediaRuntimeV3Schema.parse({
      protocolVersion: 3 as const,
      executionMode: executionEnabled && connectionUsable ? 'real' as const : 'disabled' as const,
      executionAvailable: executable.length > 0,
      defaultProfileId,
      tools,
      profiles,
    });
  }
}
