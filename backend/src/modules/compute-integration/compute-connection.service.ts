import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { SettingService } from '../setting/setting.service';
import { SETTING_KEYS, DEFAULT_MODEL_ID, type ComputeIntegrationKind } from 'shared';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeProtocolClient } from './compute-protocol.client';
import { ComputeModelTransportService, type ComputeChatFunding } from './compute-model-transport.service';

@Injectable()
export class ComputeConnectionService {
  constructor(private readonly settings: SettingService, private readonly integrations: ComputeIntegrationService,
    @Optional() private readonly protocol?: ComputeProtocolClient,
    @Optional() private readonly transport?: ComputeModelTransportService) {}

  isEnterpriseMode(enterpriseId: string) { return this.integrations.isEnterpriseMode(enterpriseId); }

  async chatProvider(enterpriseId: string, funding: ComputeChatFunding = {}) {
    if (!this.transport) throw new ServiceUnavailableException('企业模型传输服务未注册');
    return this.transport.provider(enterpriseId, await this.resolve(enterpriseId, 'chat'), funding);
  }

  async assertEnterpriseModeSupported(enterpriseId: string) {
    await this.integrations.assertEnterpriseReady(enterpriseId);
  }

  async resolve(enterpriseId: string, kind: ComputeIntegrationKind) {
    await this.assertEnterpriseModeSupported(enterpriseId);
    return this.enterprise(enterpriseId, kind);
  }

  /** Read-only catalog access is allowed before accounting activation; execution remains gated separately. */
  async enterprise(enterpriseId: string, kind: ComputeIntegrationKind) {
    const credential = await this.integrations.selectEnterpriseCredential(enterpriseId, kind);
    const addressKey = kind === 'chat' ? SETTING_KEYS.SUB2API_BASE_URL
      : kind === 'image' ? SETTING_KEYS.MEDIA_BASE_URL : SETTING_KEYS.MEDIA_VIDEO_BASE_URL;
    const rawBase = await this.settings.getEffectiveValue(addressKey);
    let baseURL: string;
    try {
      const url = this.protocol ? this.protocol.validateAddress(rawBase ?? '') : new URL(rawBase ?? '');
      if ((!this.protocol && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) throw new ServiceUnavailableException();
      baseURL = url.href.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
    } catch { throw new ServiceUnavailableException('企业算力服务地址尚未配置或无效'); }
    return { ...credential, baseURL, source: 'enterprise' as const };
  }

  async platform(kind: ComputeIntegrationKind) {
    if (kind !== 'chat') {
      const value = await this.settings.getMediaConnection(kind);
      return { baseURL: value.baseUrl, apiKey: value.apiKey, defaultModel: DEFAULT_MODEL_ID, source: 'platform' as const };
    }
    const [baseURL, apiKey, defaultModel] = await Promise.all([
      this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_BASE_URL),
      this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_API_KEY),
      this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_DEFAULT_MODEL),
    ]);
    return { baseURL, apiKey, defaultModel: defaultModel || DEFAULT_MODEL_ID, source: 'platform' as const };
  }
}
