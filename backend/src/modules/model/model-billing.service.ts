import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';
import {
  SETTING_KEYS, calculateCost, parseFallbackPriceConfig, parseUsdToCnyRate, ModelBillingSnapshotSchema,
  type ModelBillingSnapshot, type ComputeCostBreakdown,
} from 'shared';

const KeyBillingSchema = z.object({
  object: z.literal('sub2api.key_billing'),
  schema_version: z.literal(1),
  billing_scope: z.literal('token'),
  effective_rate_multiplier: z.number().finite().nonnegative(),
});

/** SEP 活动覆盖优先；非活动使用实际转发 key 的 token 生效倍率。 */
@Injectable()
export class ModelBillingService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingService) {}

  private async upstreamMultiplier(): Promise<number> {
    try {
      const [baseUrl, apiKey] = await Promise.all([
        this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_BASE_URL),
        this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_API_KEY),
      ]);
      if (!baseUrl || !apiKey) throw new ServiceUnavailableException();
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/sub2api/billing`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new ServiceUnavailableException();
      return KeyBillingSchema.parse(await response.json()).effective_rate_multiplier;
    } catch {
      // Never expose upstream responses or credentials, or assume an unknown rate is 1.
      throw new ServiceUnavailableException({ message: '中转计费倍率暂不可用，请稍后重试',
        error: { code: 'MODEL_BILLING_UNAVAILABLE', message: '中转计费倍率暂不可用，请稍后重试', source: 'platform', type: 'server_error' } });
    }
  }

  async describe(models: Array<{ isFree: boolean }>) {
    let multiplier: number | null = null;
    if (models.some(model => !model.isFree)) {
      try { multiplier = await this.upstreamMultiplier(); }
      catch (error) { if (!(error instanceof ServiceUnavailableException)) throw error; }
    }
    return models.map(model => ({
      isFree: model.isFree,
      billingMultiplier: model.isFree ? '0' : multiplier === null ? null : String(multiplier),
      discountLabel: model.isFree ? '活动免费' : multiplier === null ? '中转倍率暂不可用'
        : multiplier === 0 ? '中转免费' : '按中转倍率计费',
    }));
  }

  async getSnapshot(modelId: string): Promise<ModelBillingSnapshot> {
    const model = await this.prisma.platformModel.findUnique({ where: { modelId }, select: { isFree: true } });
    const isFree = model?.isFree === true;
    const multiplier = isFree ? 0 : await this.upstreamMultiplier();
    return this.priceSnapshot(modelId, isFree, multiplier);
  }

  /** 升级前已开始且没有快照的执行，保持旧版 SEP 一倍计费，避免被新活动追溯改价。 */
  getLegacySnapshot(modelId: string): Promise<ModelBillingSnapshot> {
    return this.priceSnapshot(modelId, false, 1);
  }

  private async priceSnapshot(modelId: string, isFree: boolean, multiplier: number): Promise<ModelBillingSnapshot> {
    const [rawRate, rawInput, rawOutput] = await Promise.all([
      this.settings.getEffectiveValue(SETTING_KEYS.USD_TO_CNY_RATE),
      this.settings.getEffectiveValue(SETTING_KEYS.FALLBACK_PRICE_INPUT),
      this.settings.getEffectiveValue(SETTING_KEYS.FALLBACK_PRICE_OUTPUT),
    ]);
    const rate = parseUsdToCnyRate(rawRate);
    const price = calculateCost(modelId, 0, 0, rate, parseFallbackPriceConfig(rawInput, rawOutput));
    const snapshot = {
      modelId, isFree, billingMultiplier: multiplier, rate,
      inputPriceUsdPerMillion: price.inputPriceUsdPerMillion * multiplier,
      outputPriceUsdPerMillion: price.outputPriceUsdPerMillion * multiplier,
      isFallback: price.isFallback,
    };
    const parsed = ModelBillingSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw new ServiceUnavailableException('模型计费规则无效，请联系管理员');
    return parsed.data;
  }
}

/** 单价已包含倍率；结算只乘 token 与汇率，避免重复乘倍率。 */
export function calculateBilledCost(snapshot: ModelBillingSnapshot, inputTokens: number, outputTokens: number): ComputeCostBreakdown {
  const costUSD = (inputTokens * snapshot.inputPriceUsdPerMillion + outputTokens * snapshot.outputPriceUsdPerMillion) / 1_000_000;
  return {
    costUSD, costCNY: costUSD * snapshot.rate, isFallback: snapshot.isFallback,
    rate: snapshot.rate, inputPriceUsdPerMillion: snapshot.inputPriceUsdPerMillion,
    outputPriceUsdPerMillion: snapshot.outputPriceUsdPerMillion,
  };
}
