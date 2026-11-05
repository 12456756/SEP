import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import type { ChatCompletionRequest, ModelRuntimePolicySnapshot } from 'shared';

export interface GatewayModelCapabilities {
  maxOutputTokens?: number | null;
}

export interface GatewayModelIdentity {
  sub: string;
  enterpriseId: string;
  memberId: string;
  subscriptionId?: string;
}

export interface GatewayModelPolicy {
  allowedModels: string[];
  defaultModel: string;
  allowUserSwitchModel: boolean;
  departmentId: string | null;
}

function platformErrorResponse(code: string, message: string, param: string | null,
  type = 'invalid_request_error') {
  // Nest reads the top-level message to preserve the original exception message.
  return { message, error: { code, message, type, param, source: 'platform' } };
}

@Injectable()
export class GatewayModelPolicyService {
  constructor(
    private readonly modelConfig: EnterpriseModelConfigService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async prepare(identity: GatewayModelIdentity, request: ChatCompletionRequest, snapshot?: ModelRuntimePolicySnapshot): Promise<{
    allowedModels: string[];
    request: ChatCompletionRequest;
    inputBytes: number;
  }> {
    const policy = await this.resolvePolicy(identity);
    return { allowedModels: policy.allowedModels, ...await this.validateResources(request, policy, snapshot) };
  }

  async resolvePolicy(identity: GatewayModelIdentity): Promise<GatewayModelPolicy> {
    const member = await this.prisma.enterpriseMember.findFirst({
      where: { id: identity.memberId, enterpriseId: identity.enterpriseId, userId: identity.sub, enterprise: { status: 'ACTIVE' } },
      select: { departmentId: true },
    });
    if (!member) {
      throw new ForbiddenException(platformErrorResponse(
        'MEMBER_ACCESS_DENIED', '成员不属于当前用户或企业', null, 'permission_error',
      ));
    }

    let employeeTemplateModel: string | null = null;
    if (identity.subscriptionId) {
      const subscription = await this.prisma.subscription.findFirst({
        where: { id: identity.subscriptionId, enterpriseId: identity.enterpriseId },
        select: { employee: { select: { modelId: true } } },
      });
      if (!subscription) throw new ForbiddenException(platformErrorResponse(
        'SUBSCRIPTION_ACCESS_DENIED', '订阅不属于当前企业', null, 'permission_error',
      ));
      employeeTemplateModel = subscription.employee.modelId;
    }

    const effective = await this.modelConfig.resolveEffectiveModel({
      userId: identity.sub,
      enterpriseId: identity.enterpriseId,
      departmentId: member.departmentId ?? undefined,
      subscriptionId: identity.subscriptionId,
      employeeTemplateModel,
      restrictToAvailableModels: true,
    });
    const allowedModels = effective.allowUserSwitchModel
      ? effective.allowedChatModels
      : effective.allowedChatModels.filter((id) => id === effective.chatModel);
    if (!effective.allowUserSwitchModel && allowedModels.length === 0) {
      throw new BadRequestException(platformErrorResponse(
        'MODEL_POLICY_DEFAULT_INVALID',
        '强制默认模型未启用、已下架或不在企业与部门允许范围内，请联系管理员', 'model',
      ));
    }
    return {
      allowedModels,
      defaultModel: effective.chatModel,
      allowUserSwitchModel: effective.allowUserSwitchModel,
      departmentId: member.departmentId,
    };
  }

  /** 返回副本供上游转发，应用当前输出策略并保留上游管理的省略预算。 */
  async validateResources(request: ChatCompletionRequest, policy: GatewayModelPolicy, snapshot?: ModelRuntimePolicySnapshot): Promise<{
    request: ChatCompletionRequest;
    inputBytes: number;
  }> {
    if (!policy.allowedModels.includes(request.model)) {
      throw new ForbiddenException(platformErrorResponse(
        'MODEL_NOT_ALLOWED', '该模型不在当前成员允许范围内', 'model', 'permission_error',
      ));
    }
    const model = await this.prisma.platformModel.findFirst({
      where: { modelId: request.model, enabled: true, isStale: false },
      select: { maxOutputTokens: true, supportedFeatures: true },
    });
    if (!model) throw new BadRequestException(platformErrorResponse(
      'MODEL_UNAVAILABLE', '该模型未启用或已下架', 'model',
    ));

    const features = model.supportedFeatures as Record<string, unknown> | null;
    const usesImages = request.messages.some((message) => Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url'));
    const usesTools = Boolean(request.tools?.length) ||
      (request.tool_choice !== undefined && request.tool_choice !== 'none') ||
      request.messages.some((message) => message.role === 'tool' || message.tool_calls?.length);
    if (features?.functionCalling === false && usesTools) {
      const param = request.tools?.length ? 'tools'
        : request.tool_choice !== undefined && request.tool_choice !== 'none' ? 'tool_choice' : 'messages';
      throw new BadRequestException(platformErrorResponse(
        'MODEL_FEATURE_UNSUPPORTED', '该模型不支持 functionCalling', param,
      ));
    }
    if (features?.vision === false && usesImages) {
      throw new BadRequestException(platformErrorResponse(
        'MODEL_FEATURE_UNSUPPORTED', '该模型不支持 vision', 'messages',
      ));
    }
    if (features?.streaming === false && request.stream) {
      throw new BadRequestException(platformErrorResponse(
        'MODEL_FEATURE_UNSUPPORTED', '该模型不支持 streaming', 'stream',
      ));
    }

    const cap = model.maxOutputTokens ?? null;
    if (cap !== null && (!Number.isSafeInteger(cap) || cap <= 0)) {
      throw new BadRequestException(platformErrorResponse(
        'MODEL_OUTPUT_LIMIT_INVALID', '模型 maxOutputTokens 配置无效', 'model',
      ));
    }
    const normalized = this.normalize(request, model, snapshot);
    let serialized: string;
    try {
      serialized = JSON.stringify(normalized);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new BadRequestException(platformErrorResponse(
        'REQUEST_SERIALIZATION_FAILED', '请求无法序列化', null,
      ));
    }
    // UTF-8 字节限制不是 context token 校验，也不用于计费。
    const inputBytes = Buffer.byteLength(serialized, 'utf8');
    if (inputBytes > this.positiveConfig('GATEWAY_MAX_REQUEST_BYTES', 4 * 1024 * 1024)) {
      throw new PayloadTooLargeException(platformErrorResponse(
        'MODEL_REQUEST_TOO_LARGE', '模型请求超过序列化资源上限', null,
      ));
    }
    return { request: normalized, inputBytes };
  }

  resolveOutputLimit(model: GatewayModelCapabilities, snapshot?: ModelRuntimePolicySnapshot): number | undefined {
    const platform = snapshot?.values.MODEL_MAX_OUTPUT_TOKENS ?? this.positiveConfig('MODEL_MAX_OUTPUT_TOKENS', 0, 0);
    const capability = model.maxOutputTokens;
    if (!Number.isSafeInteger(platform) || platform < 0 ||
        (capability != null && (!Number.isSafeInteger(capability) || capability <= 0))) {
      throw new ServiceUnavailableException({ error: { message: '模型输出能力配置无效', type: 'server_error',
        code: 'MODEL_OUTPUT_POLICY_INVALID', source: 'platform', ...(snapshot ? { policyVersion: snapshot.version } : {}) } });
    }
    if (platform === 0) return capability ?? undefined;
    return Math.min(platform, capability ?? platform);
  }

  normalizeInternal(model: GatewayModelCapabilities, snapshot: ModelRuntimePolicySnapshot | undefined, requested: number): number | undefined {
    const limit = this.resolveOutputLimit(model, snapshot);
    if (requested === 0) {
      const platform = snapshot?.values.MODEL_MAX_OUTPUT_TOKENS ?? this.positiveConfig('MODEL_MAX_OUTPUT_TOKENS', 0, 0);
      // A configured platform ceiling must also bound requests with no default.
      return platform > 0 ? limit : undefined;
    }
    this.validateOutput(requested);
    return limit === undefined ? requested : Math.min(requested, limit);
  }

  internalOutputTokens(model: GatewayModelCapabilities | null, snapshot: ModelRuntimePolicySnapshot, requested: number): number | undefined {
    return this.normalizeInternal(model ?? {}, snapshot, requested);
  }

  normalize<T extends object>(body: T & { max_tokens?: unknown }, model: GatewayModelCapabilities,
    snapshot?: ModelRuntimePolicySnapshot): T & { max_tokens?: number } {
    const limit = this.resolveOutputLimit(model, snapshot);
    const requested = body.max_tokens;
    if (requested !== undefined) {
      this.validateOutput(requested);
      if (limit !== undefined && (requested as number) > limit) {
        throw new BadRequestException({ error: { message: `max_tokens 不得超过模型有效输出上限 ${limit}`,
          type: 'invalid_request_error', code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', source: 'platform',
          param: 'max_tokens', limit, ...(snapshot ? { policyVersion: snapshot.version } : {}) } });
      }
    }
    const output = requested === undefined
      ? this.normalizeInternal(model, snapshot, snapshot?.values.GATEWAY_DEFAULT_MAX_TOKENS ?? this.positiveConfig('GATEWAY_DEFAULT_MAX_TOKENS', 0, 0))
      : requested as number;
    const normalized = { ...body, max_tokens: output };
    if (output === undefined) delete normalized.max_tokens;
    return normalized;
  }

  private validateOutput(value: unknown): void {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException({ error: { message: '输出数量必须为正整数', type: 'invalid_request_error',
        code: 'INVALID_PARAMETER', source: 'platform', param: 'max_tokens' } });
    }
  }

  private positiveConfig(key: string, fallback: number, minimum = 1): number {
    const raw = this.config.get<string | number>(key) ?? fallback;
    const value = typeof raw === 'number' || /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) {
      throw new InternalServerErrorException(platformErrorResponse(
        'GATEWAY_CONFIG_INVALID', `${key} must be an integer between ${minimum} and 2147483647`, null, 'server_error',
      ));
    }
    return value;
  }
}
