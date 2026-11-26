import { Injectable, ForbiddenException, ServiceUnavailableException, Optional } from '@nestjs/common';
import { ComputeConnectionService } from '../compute-integration/compute-connection.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';
import type { ChatCompletionRequest, ModelRuntimePolicySnapshot, ModelBillingSnapshot, PaymentMode } from 'shared';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { createGatewayStreamLifecycle, createChatCompletionStreamObserver, timeoutValue } from './gateway-stream';
import { readGatewayJson } from './gateway-response';
import { GatewayModelPolicyService } from './gateway-model-policy.service';
import { localError } from '../../common/errors/error-diagnostics';
import { assertUpstreamPayload, upstreamException, redactUpstreamStream } from '../../common/errors/upstream-http.exception';
import type { ComputeChatFunding } from '../compute-integration/compute-model-transport.service';

@Injectable()
export class GatewayService {
  private readonly responseSecrets = new WeakMap<Response, string>();

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private settingService: SettingService,
    private computeCreditService: ComputeCreditService,
    private modelPolicy: GatewayModelPolicyService,
    @Optional() private readonly connections?: ComputeConnectionService,
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
    paymentMode?: PaymentMode;
    billingSnapshot?: ModelBillingSnapshot;
  }> {
    const { enterpriseId, subscriptionId, memberId } = claims;
    await this.connections?.assertEnterpriseModeSupported(enterpriseId);

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
    const enterpriseMode = await this.connections?.isEnterpriseMode(enterpriseId) ?? false;
    const paymentMode = enterpriseMode ? (await this.computeCreditService.getPaymentPreference(enterpriseId, claims.sub)).paymentMode : undefined;
    const billingSnapshot = modelId && !enterpriseMode ? await this.computeCreditService.getBillingSnapshot(modelId, enterpriseId, claims.sub) : undefined;
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
        paymentMode: paymentMode ?? billingSnapshot?.paymentMode ?? 'AUTO',
      } });
    }

    return { enterpriseId, subscriptionId, memberId, employeeId: subscription.employeeId, paymentMode: paymentMode ?? billingSnapshot?.paymentMode ?? 'AUTO', ...(billingSnapshot ? { billingSnapshot } : {}) };
  }

  prepareRequest(claims: Parameters<GatewayModelPolicyService['prepare']>[0], dto: ChatCompletionRequest, snapshot: ModelRuntimePolicySnapshot) {
    // Include usage collection before policy size checks and reservation of the final body.
    const request = dto.stream
      ? { ...dto, stream_options: { ...dto.stream_options, include_usage: true } }
      : dto;
    return this.modelPolicy.prepare(claims, request, snapshot);
  }

  async getSub2ApiConfig(funding?: ComputeChatFunding & { enterpriseId: string }): Promise<{
    baseUrl: string; apiKey: string; defaultModel?: string; fetch?: typeof fetch;
  }> {
    if (!funding?.enterpriseId || !this.connections) throw new ServiceUnavailableException({
      code: 'COMPUTE_ENTERPRISE_CONTEXT_REQUIRED', message: '模型调用缺少企业算力连接，无法使用企业凭证',
    });
    const enterprise = await this.connections.chatProvider(funding.enterpriseId, funding);
    if (!enterprise) throw new ServiceUnavailableException({ code: 'COMPUTE_SETTLEMENT_NOT_CONNECTED', message: '企业算力连接不可用' });
    return { baseUrl: enterprise.baseURL, apiKey: enterprise.apiKey, fetch: enterprise.fetch };
  }

  /** 转发已校验的 OpenAI 兼容请求，并保留上游错误状态与字段定位信息。 */
  observeChatCompletionStream() {
    return createChatCompletionStreamObserver();
  }

  async forwardChatCompletion(dto: ChatCompletionRequest, snapshot: ModelRuntimePolicySnapshot, requestId?: string, clientSignal?: AbortSignal,
    funding?: { enterpriseId: string; userId: string; memberId: string; subscriptionId: string; employeeId: string; gatewayId: string }): Promise<Response> {
    const { baseUrl, apiKey, fetch: enterpriseFetch } = await this.getSub2ApiConfig(funding);
    const stream = createGatewayStreamLifecycle(snapshot, clientSignal, !!dto.stream);
    let response: Response;
    try {
      const signal = stream.signal;
      signal.throwIfAborted();
      response = await (enterpriseFetch ?? fetch)(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
    } catch (error) {
      stream.cleanup();
      if (stream.signal.aborted) throw stream.signal.reason;
      throw localError(error, 502, { origin: 'sep', stage: 'transport' }, [apiKey]);
    }

    if (!response.ok) {
      throw await upstreamException(response, [apiKey], timeoutValue(this.config, 'GATEWAY_ERROR_MAX_BYTES', 262144));
    }
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream') {
      response = redactUpstreamStream(response, [apiKey]);
    }
    this.responseSecrets.set(response, apiKey);
    return response;
  }

  async readCompletion(response: Response) {
    const value = await readGatewayJson(response, timeoutValue(this.config, 'GATEWAY_JSON_MAX_BYTES', 8 * 1024 * 1024), [this.responseSecrets.get(response) ?? '']);
    assertUpstreamPayload(value, response, [this.responseSecrets.get(response) ?? '']);
    return value;
  }

}
