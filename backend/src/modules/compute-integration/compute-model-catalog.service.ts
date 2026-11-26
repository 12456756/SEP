import { BadRequestException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { AvailableModel, ComputeIntegrationKind } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { readUpstreamJson } from '../../common/errors/upstream-http.exception';
import { localError } from '../../common/errors/error-diagnostics';
import { isSupportedImageModel } from '../media-gateway/image-model-contract';
import { ComputeConnectionService } from './compute-connection.service';
import { ComputeProtocolClient } from './compute-protocol.client';

const CatalogSchema = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(256).regex(/^[^\s\p{Cc}\p{Cf}]+$/u),
  display_name: z.string().trim().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u).optional(),
})).max(2000), partial: z.boolean().optional() });

@Injectable()
export class ComputeModelCatalogService {
  constructor(private readonly prisma: PrismaService, private readonly connections: ComputeConnectionService,
    @Optional() private readonly protocol?: ComputeProtocolClient) {}

  async configured(enterpriseId: string, kind: ComputeIntegrationKind) {
    try { await this.connections.enterprise(enterpriseId, kind); return true; }
    catch (error) { if (error instanceof ServiceUnavailableException) return false; throw error; }
  }

  executionReady(): boolean { return this.protocol?.isConfigured() ?? false; }

  async assertProfiles(enterpriseId: string, kind: 'image' | 'video', profiles: Array<{ profileId?: string; modelId?: string }>, selected: string[], retained: string[] = []) {
    const added = selected.filter(id => !retained.includes(id));
    if (!added.length) return;
    const candidates = profiles.filter(profile => added.includes(profile.profileId));
    const allowed = new Set((await this.filterProfiles(enterpriseId, kind, candidates)).map(profile => profile.profileId));
    for (const id of added) if (!allowed.has(id)) throw new BadRequestException({
      message: `配置 ${id} 不在本企业${kind === 'image' ? '图片' : '视频'} Key 的可用范围内`, code: 'ENTERPRISE_MEDIA_PROFILE_UNAVAILABLE', profileId: id,
    });
  }

  /** No shared cache: every lookup uses the current enterprise and purpose credential. */
  async list(enterpriseId: string, kind: ComputeIntegrationKind) {
    const connection = await this.connections.enterprise(enterpriseId, kind);
    try {
      if (!this.protocol) throw new ServiceUnavailableException({ code: 'COMPUTE_SIGNING_NOT_CONFIGURED', message: '企业模型目录需要 SEP 服务签名' });
      const url = new URL(`${connection.baseURL}/models`);
      const response = await this.protocol.request(url.pathname + url.search, {
        enterpriseId, apiKey: connection.apiKey,
      }, url.origin);
      const payload = await readUpstreamJson(response, [connection.apiKey]);
      const parsed = CatalogSchema.safeParse(payload);
      if (!parsed.success) throw new ServiceUnavailableException({ message: '企业算力模型目录格式无效', code: 'ENTERPRISE_MODEL_CATALOG_INVALID' });
      if (parsed.data.partial || response.headers.get('x-data-degraded') === 'true') {
        throw new ServiceUnavailableException({ message: '企业算力模型目录不完整，请稍后重新查询', code: 'ENTERPRISE_MODEL_CATALOG_PARTIAL' });
      }
      return [...new Map(parsed.data.data.map(model => [model.id, { modelId: model.id, displayName: model.display_name ?? model.id }])).values()]
        .sort((a, b) => a.modelId.localeCompare(b.modelId));
    } catch (error) { throw localError(error, 503, { origin: 'sep', stage: 'enterprise-model-catalog' }, [connection.apiKey]); }
  }

  async chatModels(enterpriseId: string): Promise<AvailableModel[]> {
    const visible = await this.list(enterpriseId, 'chat');
    if (!visible.length) return [];
    const media = await this.prisma.mediaModelProfile.findMany({
      where: { modelId: { in: visible.map(model => model.modelId) } }, select: { modelId: true },
    });
    const mediaIds = new Set(media.map(model => model.modelId));
    return visible.filter(model => !mediaIds.has(model.modelId) && !isSupportedImageModel(model.modelId))
      .map(model => ({ modelId: model.modelId, label: model.displayName, displayName: model.displayName,
        isFree: false, billingMultiplier: null, discountLabel: '费用由算力平台确认',
        pricingInputPer1M: null, pricingOutputPer1M: null,
        vendor: null, category: null, contextLength: null, maxOutputTokens: null,
        supportedFeatures: null, description: null }));
  }

  async assertChatModels(enterpriseId: string, ids: string[]) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return;
    const available = new Set((await this.chatModels(enterpriseId)).map(model => model.modelId));
    for (const id of wanted) if (!available.has(id)) throw new BadRequestException({
      message: `模型 ${id} 不在本企业对话 Key 的可用范围内`, code: 'ENTERPRISE_MODEL_UNAVAILABLE', modelId: id,
    });
  }

  async filterProfiles<T extends { modelId?: string }>(enterpriseId: string, kind: 'image' | 'video', profiles: T[]): Promise<T[]> {
    if (!profiles.length) return [];
    const visible = new Set((await this.list(enterpriseId, kind)).map(model => model.modelId));
    return profiles.filter(profile => visible.has(profile.modelId));
  }
}
