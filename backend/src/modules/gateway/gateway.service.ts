import { Injectable, ForbiddenException, Logger, BadRequestException, BadGatewayException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';
import { DEFAULT_MODEL_ID, SETTING_KEYS } from 'shared';
import type { ChatCompletionRequest, ModelRuntimePolicySnapshot, ModelBillingSnapshot } from 'shared';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { createGatewayStreamLifecycle, createChatCompletionStreamObserver, timeoutValue } from './gateway-stream';
import { readGatewayJson } from './gateway-response';
import { GatewayModelPolicyService } from './gateway-model-policy.service';

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }

  // Restrict Date.parse to HTTP-date formats; arbitrary strings can parse as dates.
  const day = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
  const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const time = '\\d{2}:\\d{2}:\\d{2}';
  const standard = new RegExp(`^${day}, (\\d{2}) ${month} \\d{4} ${time} GMT$`);
  const obsolete = new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${month}-\\d{2} ${time} GMT$`);
  const asctime = new RegExp(`^${day} ${month} ( [1-9]|\\d{2}) ${time} \\d{4}$`);
  const match = standard.exec(trimmed) || obsolete.exec(trimmed) || asctime.exec(trimmed);
  if (!match) return undefined;
  // asctime has no timezone suffix but HTTP dates are always UTC.
  const timestamp = Date.parse(asctime.test(trimmed) ? `${trimmed} GMT` : trimmed);
  if (!Number.isFinite(timestamp) || new Date(timestamp).getUTCDate() !== Number(match[1])) {
    return undefined;
  }
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function sanitizeRequestId(value: string | null | undefined): string | undefined {
  const safe = value?.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
  return safe || undefined;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private settingService: SettingService,
    private computeCreditService: ComputeCreditService,
    private modelPolicy: GatewayModelPolicyService,
  ) {}

  /**
   * 验证订阅令牌 + 检查授权和余额
   * Model policy and resource checks follow this authorization step.
   */
  async validateAndAuthorize(claims: {
    sub: string;
    enterpriseId: string;
    subscriptionId: string;
    memberId: string;
  }, modelId?: string): Promise<{
    enterpriseId: string;
    subscriptionId: string;
    memberId: string;
    employeeId: string;
    billingSnapshot?: ModelBillingSnapshot;
  }> {
    const { enterpriseId, subscriptionId, memberId } = claims;

    // 1. 检查订阅状态
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        enterpriseId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
      },
      select: { employeeId: true },
    });
    if (!subscription) {
      const message = '订阅不存在、已停用或不属于该企业';
      throw new ForbiddenException({ message, error: {
        message, code: 'SUBSCRIPTION_INACTIVE', type: 'permission_error', source: 'platform', param: null,
      } });
    }

    // 2. 检查授权
    const now = new Date();
    const grant = await this.prisma.employeeGrant.findFirst({
      where: {
        subscriptionId,
        AND: [
          {
            OR: [
              { memberId },
              { department: { members: { some: { id: memberId } } } },
            ],
          },
          {
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        ],
      },
    });
    if (!grant) {
      const message = '无该订阅的使用授权或授权已过期';
      throw new ForbiddenException({ message, error: {
        message, code: 'SUBSCRIPTION_ACCESS_DENIED', type: 'permission_error', source: 'platform', param: null,
      } });
    }

    // 3. 使用统一算力账本检查余额。不要读取已废弃的 ComputeAccount，
    // 否则 Web 展示的钱包余额与客户端网关会继续使用两套账本。
    const billingSnapshot = modelId ? await this.computeCreditService.getBillingSnapshot(modelId) : undefined;
    const balance = await this.computeCreditService.checkBalanceBeforeConversation(
      enterpriseId,
      subscriptionId,
      claims.sub,
      ...(billingSnapshot ? [billingSnapshot] as const : []),
    );
    if (!balance.allowed) {
      const message = balance.reason || '企业算力余额不足，请联系管理员充值';
      throw new ForbiddenException({ message, error: {
        message, code: 'INSUFFICIENT_BALANCE', type: 'permission_error', source: 'platform', param: null,
      } });
    }

    return { enterpriseId, subscriptionId, memberId, employeeId: subscription.employeeId, ...(billingSnapshot ? { billingSnapshot } : {}) };
  }

  prepareRequest(claims: Parameters<GatewayModelPolicyService['prepare']>[0], dto: ChatCompletionRequest, snapshot: ModelRuntimePolicySnapshot) {
    // Include usage collection before policy size checks and reservation of the final body.
    const request = dto.stream
      ? { ...dto, stream_options: { ...dto.stream_options, include_usage: true } }
      : dto;
    return this.modelPolicy.prepare(claims, request, snapshot);
  }

  /**
   * 获取 sub2api 配置
   */
  async getSub2ApiConfig(): Promise<{ baseUrl: string; apiKey: string; defaultModel: string }> {
    const baseUrl =
      (await this.settingService.getEffectiveValue(SETTING_KEYS.SUB2API_BASE_URL)) ||
      'https://longdaoai.cn/v1';
    const apiKey =
      (await this.settingService.getEffectiveValue(SETTING_KEYS.SUB2API_API_KEY)) || '';
    // 兜底值必须与 DEFAULT_MODEL_ID 一致。这里原来写死 'gpt-3.5-turbo'，
    // 而中转早就不提供任何 gpt-* 模型（实测 /v1/models 只有 gemini-*），
    // 系统设置一旦为空，客户端网关就会拿一个必然 404 的模型去请求。
    const defaultModel =
      (await this.settingService.getEffectiveValue(SETTING_KEYS.SUB2API_DEFAULT_MODEL)) ||
      DEFAULT_MODEL_ID;

    if (!apiKey) {
      const message = 'sub2api API Key 未配置';
      throw new BadRequestException({ message, error: {
        message, code: 'GATEWAY_CONFIG_INVALID', type: 'server_error', source: 'platform', param: null,
      } });
    }

    return { baseUrl, apiKey, defaultModel };
  }

  /** 转发已校验的 OpenAI 兼容请求，并保留上游错误状态与字段定位信息。 */
  observeChatCompletionStream() {
    return createChatCompletionStreamObserver();
  }

  async forwardChatCompletion(dto: ChatCompletionRequest, snapshot: ModelRuntimePolicySnapshot, requestId?: string, clientSignal?: AbortSignal): Promise<Response> {
    const { baseUrl, apiKey } = await this.getSub2ApiConfig();
    const stream = createGatewayStreamLifecycle(snapshot, clientSignal, !!dto.stream);
    let response: Response;
    try {
      const signal = stream.signal;
      signal.throwIfAborted();
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body: JSON.stringify(dto),
        signal,
      });
      response = stream.wrap(response);
    } catch {
      stream.cleanup();
      this.logger.warn({
        message: 'gateway upstream request failed before stream',
        requestId: sanitizeRequestId(requestId), model: dto.model,
        code: stream.signal.reason?.getResponse?.()?.error?.code || 'UPSTREAM_UNAVAILABLE',
      });
      if (stream.signal.aborted) throw stream.signal.reason;
      const message = '无法连接 sub2api';
      throw new BadGatewayException({
        error: { message, type: 'api_error', code: 'UPSTREAM_UNAVAILABLE', param: null },
      });
    }

    if (!response.ok) {
      // 不把 HTML 代理错误页或整个上游响应直接暴露给客户端。
      const body = await readGatewayJson(response, timeoutValue(this.config, 'GATEWAY_ERROR_MAX_BYTES', 65536)).catch((error) => {
        if (stream.signal.aborted) throw stream.signal.reason;
        if (error?.getResponse?.()?.error?.code === 'UPSTREAM_RESPONSE_TOO_LARGE') throw error;
        return null;
      }) as { error?: Record<string, unknown> } | null;
      const error = body?.error;
      const isRateLimited = response.status === 429;
      const retryAfterSeconds = isRateLimited
        ? parseRetryAfter(response.headers.get('Retry-After')) : undefined;
      if (isRateLimited) {
        this.logger.warn({
          message: 'sub2api rate limit',
          status: response.status,
          requestId: sanitizeRequestId(requestId),
          upstreamRequestId: sanitizeRequestId(response.headers.get('x-request-id')),
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
      } else this.logger.warn({ message: 'sub2api request rejected', status: response.status,
        requestId: sanitizeRequestId(requestId), model: dto.model,
        upstreamRequestId: sanitizeRequestId(response.headers.get('x-request-id')) });
      throw new HttpException({
        error: {
          message: typeof error?.message === 'string' && error.message
            ? error.message.slice(0, 1000) : `sub2api 请求失败（HTTP ${response.status}）`,
          type: typeof error?.type === 'string' ? error.type.slice(0, 128)
            : isRateLimited ? 'rate_limit_error' : response.status >= 500 ? 'api_error' : 'invalid_request_error',
          code: typeof error?.code === 'string' ? error.code.slice(0, 128)
            : isRateLimited ? 'UPSTREAM_RATE_LIMIT_EXCEEDED' : 'UPSTREAM_ERROR',
          param: typeof error?.param === 'string' ? error.param.slice(0, 256) : null,
          ...(isRateLimited ? { source: 'upstream' } : {}),
        },
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      }, response.status);
    }
    return response;
  }

  readCompletion(response: Response) {
    return readGatewayJson(response, timeoutValue(this.config, 'GATEWAY_JSON_MAX_BYTES', 8 * 1024 * 1024));
  }

}
