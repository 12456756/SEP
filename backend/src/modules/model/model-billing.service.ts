import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ModelBillingSnapshot, ComputeCostBreakdown } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';

function pricingUnavailable(): never {
  throw new ServiceUnavailableException({ code: 'COMPUTE_FINAL_FEE_REQUIRED',
    message: 'SEP 已停止本地模型定价，请使用算力平台确认的人民币费用；历史任务需核对原费用单' });
}

@Injectable()
export class ModelBillingService {
  constructor(_prisma: PrismaService, _settings: SettingService) {}

  async describe(models: Array<{ isFree: boolean }>) {
    return models.map(() => ({ isFree: false, billingMultiplier: null, discountLabel: '费用由算力平台确认' }));
  }

  /** Retained as an explicit rejection for callers holding historical pricing contracts. */
  async getSnapshot(_modelId: string): Promise<ModelBillingSnapshot> { return pricingUnavailable(); }
  async getLegacySnapshot(_modelId: string): Promise<ModelBillingSnapshot> { return pricingUnavailable(); }
}

/** @deprecated Local model pricing is disabled, including historical recomputation. */
export function calculateBilledCost(_snapshot: ModelBillingSnapshot, _inputTokens: number, _outputTokens: number): ComputeCostBreakdown {
  return pricingUnavailable();
}
