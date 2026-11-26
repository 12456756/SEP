import { ServiceUnavailableException } from "@nestjs/common";
import { DEFAULT_MODEL_ID, SETTING_KEYS } from "shared";
import { SettingService } from "../setting/setting.service";
import type { ComputeConnectionService } from '../compute-integration/compute-connection.service';
import type { ComputeChatFunding } from '../compute-integration/compute-model-transport.service';

type SettingReader = Pick<SettingService, "getEffectiveValue">;

export interface Sub2ApiProviderConfig {
  baseURL: string;
  apiKey: string;
  /** 系统设置里的默认模型，未配置时回落 DEFAULT_MODEL_ID。 */
  defaultModel: string;
  fetch?: typeof fetch;
  enterpriseBilling?: boolean;
}

/** Enterprise execution never falls back to an administrator credential. */
export async function resolveSub2ApiProviderConfig(
  settings: SettingReader,
  tenant?: { enterpriseId: string; connections: ComputeConnectionService; funding?: ComputeChatFunding },
): Promise<Sub2ApiProviderConfig> {
  if (!tenant?.enterpriseId || !tenant.connections) throw new ServiceUnavailableException({
    code: 'COMPUTE_ENTERPRISE_CONTEXT_REQUIRED', message: '模型调用缺少企业算力连接，无法使用企业凭证',
  });
  await tenant.connections.assertEnterpriseModeSupported(tenant.enterpriseId);
  const enterprise = await tenant.connections.chatProvider(tenant.enterpriseId, tenant.funding);
  if (!enterprise) throw new ServiceUnavailableException({ code: 'COMPUTE_SETTLEMENT_NOT_CONNECTED', message: '企业算力连接不可用' });
  return { ...enterprise, defaultModel: (await settings.getEffectiveValue(SETTING_KEYS.SUB2API_DEFAULT_MODEL)) || DEFAULT_MODEL_ID, enterpriseBilling: true };
}

/** Explicit administrator-only operations, never used as an enterprise fallback. */
export async function resolveAdminSub2ApiProviderConfig(settings: SettingReader): Promise<Sub2ApiProviderConfig> {
  const [baseURL, apiKey, defaultModel] = await Promise.all([
    settings.getEffectiveValue(SETTING_KEYS.SUB2API_BASE_URL),
    settings.getEffectiveValue(SETTING_KEYS.SUB2API_API_KEY),
    settings.getEffectiveValue(SETTING_KEYS.SUB2API_DEFAULT_MODEL),
  ]);

  if (!baseURL || !apiKey) {
    throw new ServiceUnavailableException(
      "上游渠道未配置，请先在系统设置中填写 sub2api 地址和密钥",
    );
  }

  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey,
    defaultModel: defaultModel || DEFAULT_MODEL_ID,
  };
}
