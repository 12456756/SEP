import {
  ForbiddenException,
  Injectable,
  Optional,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ComputeConnectionService } from '../compute-integration/compute-connection.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import {
  generateText,
  isStepCount,
  jsonSchema,
  type JSONSchema7,
  type ToolSet,
} from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { PrismaService } from '../../prisma/prisma.service';
import { randomUUID } from 'node:crypto';
import { CapabilityService } from '../capability/capability.service';
import {
  type AdapterInput,
  type CapabilityExecutionContext,
} from '../capability/adapters/adapter.interface';
import { SettingService } from '../setting/setting.service';
import { ModelRuntimePolicyService } from '../setting/model-runtime-policy.service';
import { resolveSub2ApiProviderConfig } from '../conversation/sub2api-provider-config';
import { ModelRequestLifecycle } from '../conversation/model-request-lifecycle';
import {
  GatewayAdmissionService,
  type GatewayAdmissionIdentity,
} from '../gateway/gateway-admission.service';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import { localError } from '../../common/errors/error-diagnostics';
import { fetchModelUpstream } from '../../common/errors/upstream-http.exception';

@Injectable()
export class DigitalEmployeeRunner {
  private readonly logger = new Logger(DigitalEmployeeRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilityService: CapabilityService,
    private readonly settings: SettingService,
    private readonly runtimePolicy: ModelRuntimePolicyService,
    private readonly admission: GatewayAdmissionService,
    private readonly modelPolicy: GatewayModelPolicyService,
    @Optional() private readonly connections?: ComputeConnectionService,
    @Optional() private readonly computeCredit?: ComputeCreditService,
  ) {}

  async run(
    employeeId: string,
    userMessage: string,
    sessionId: string,
    userId?: string,
  ) {
    const requestId = randomUUID();
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: employeeId },
      include: {
        bindings: {
          where: { enabled: true, capability: { status: 'APPROVED' } },
          include: {
            capability: {
              select: {
                id: true,
                name: true,
                description: true,
                inputSchema: true,
                type: true,
              },
            },
          },
          orderBy: { priority: 'asc' },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException(`Digital employee ${employeeId} not found`);
    }

    const { executionContext, identity } = await this.resolveExecutionContext(
      employeeId,
      userId,
    );

    // Build Vercel AI SDK tools from bound capabilities.
    // 明确声明为 ToolSet 避免 TS 对 generateText 泛型做无限推断（OOM 来源）。
    const tools: ToolSet = {};
    let lifecycle: ModelRequestLifecycle;

    for (const binding of employee.bindings) {
      const cap = binding.capability;
      // Tool names must be snake_case and alphanumeric
      const toolName = cap.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

      // inputSchema 在 DB 里本来就是 JSON Schema，不需要转 Zod。
      // jsonSchema() 是 AI SDK 为运行时 schema 设计的零推断路径，
      // 不会触发 TS 对 generateText TOOLS 泛型的递归展开（之前的 OOM 来源）。
      tools[toolName] = {
        description: cap.description,
        inputSchema: jsonSchema(
          this.toJsonSchema(cap.inputSchema as Record<string, unknown>),
        ),
        execute: async (params: Record<string, unknown>) => {
          lifecycle.assertActive();
          this.logger.log(
            `[ModelPolicy] requestId=${requestId} sessionId=${sessionId} chain=digital-employee policyVersion=${snapshot.version} capabilityId=${cap.id}`,
          );
          const input: AdapterInput = {
            userMessage: JSON.stringify(params),
            sessionId,
            userId,
          };
          const result = await this.capabilityService.execute(
            cap.id,
            input,
            executionContext,
          );
          lifecycle.assertActive();
          return result.success ? result.output : `Error: ${result.error}`;
        },
      };
    }

    const { baseURL, apiKey, defaultModel, fetch: modelFetch, enterpriseBilling } =
      await resolveSub2ApiProviderConfig(this.settings,
        this.connections ? { enterpriseId: identity.enterpriseId, connections: this.connections,
          funding: { ...executionContext, memberId: identity.memberId, employeeId, sessionId } } : undefined);
    const snapshot = await this.runtimePolicy.getSnapshot();
    const modelId = employee.modelId || defaultModel;
    if (enterpriseBilling) {
      const balance = await this.computeCredit.checkBalanceBeforeConversation(identity.enterpriseId, executionContext.subscriptionId, userId);
      if (!balance.allowed) throw new ForbiddenException({ code: 'INSUFFICIENT_BALANCE', message: balance.reason });
    }
    const maxOutputTokens = this.modelPolicy.internalOutputTokens(
      null,
      snapshot,
      snapshot.values.WEB_DEFAULT_MAX_OUTPUT_TOKENS,
    );
    this.logger.log(
      `[ModelPolicy] requestId=${requestId} sessionId=${sessionId} chain=digital-employee policyVersion=${snapshot.version} employeeId=${employee.id}`,
    );

    const lease = await this.admission.acquire(identity, snapshot);
    try {
      lifecycle = new ModelRequestLifecycle(
        snapshot.values.WEB_MODEL_TOTAL_TIMEOUT_MS,
      );
      let reservation: Promise<void> | undefined;
      const provider = createOpenAICompatible({
        name: 'sub2api',
        baseURL,
        apiKey,
        fetch: async (url, init) => {
          lifecycle.assertActive();
          if (typeof init?.body !== 'string') {
            throw new ServiceUnavailableException('模型请求无法进行资源预留');
          }
          // SDK has already included tool definitions and all preceding tool results.
          reservation ??= this.admission.reserve(
            identity,
            snapshot,
            JSON.parse(init.body),
            maxOutputTokens,
          );
          await lifecycle.wait(reservation);
          lifecycle.assertActive();
          return fetchModelUpstream(url, {
            ...init,
            signal: AbortSignal.any([
              lifecycle.signal,
              ...(init.signal ? [init.signal] : []),
            ]),
          }, [apiKey], modelFetch);
        },
      });
      const { text, steps } = await lifecycle.wait(
        generateText({
          ...(enterpriseBilling ? { maxRetries: 0 } : {}),
          model: provider(modelId),
          system: employee.systemPrompt,
          prompt: userMessage,
          tools: Object.keys(tools).length > 0 ? tools : undefined,
          stopWhen: isStepCount(employee.maxSteps),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          prepareStep: () => {
            // Automatic retries reuse the reservation; a new logical step does not.
            reservation = undefined;
            return {};
          },
          abortSignal: lifecycle.signal,
        }),
      );

      return {
        text,
        stepsCount: steps.length,
        employeeId: employee.id,
        employeeName: employee.name,
      };
    } catch (error) {
      throw localError(error, 502, { origin: 'sep', stage: 'digital-employee' }, [apiKey]);
    } finally {
      lifecycle?.dispose();
      await lease.release();
    }
  }

  private async resolveExecutionContext(
    employeeId: string,
    userId?: string,
  ): Promise<{
    executionContext: CapabilityExecutionContext;
    identity: GatewayAdmissionIdentity;
  }> {
    if (!userId)
      throw new ForbiddenException('模型调用需要已认证的企业成员身份');

    // 与 EnterpriseContextService 一致，按最早的成员关系定位企业。
    // Preview calls still consume model resources and need a real tenant identity.
    const member = await this.prisma.enterpriseMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        enterpriseId: true,
        role: true,
        departmentId: true,
      },
    });
    if (!member) throw new ForbiddenException('模型调用需要有效的企业成员身份');

    const now = new Date();
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        enterpriseId: member.enterpriseId,
        employeeId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: now } }],
        // 企业管理员沿用 SubscriptionEmployeeService 的免 Grant 语义。
        // 普通成员（包括部门负责人）只接受未到期的直接或本部门授权。
        ...(member.role === 'ENTERPRISE_ADMIN'
          ? {}
          : {
              grants: {
                some: {
                  OR: [
                    { memberId: member.id },
                    ...(member.departmentId
                      ? [{ departmentId: member.departmentId }]
                      : []),
                  ],
                  AND: [
                    { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                  ],
                },
              },
            }),
      },
      select: { id: true },
    });

    return {
      identity: { enterpriseId: member.enterpriseId, memberId: member.id },
      executionContext: subscription
        ? { subscriptionId: subscription.id, userId }
        : { userId },
    };
  }

  /**
   * 把 Capability.inputSchema 规范成模型可用的 JSON Schema。
   *
   * 库里存的已经是 JSON Schema，这里只做两件事：
   * ① 补齐 type/properties 等顶层字段（历史数据可能只有 properties）；
   * ② properties 为空时给一个 freeform input 兜底 —— 工具必须有至少一个
   *    参数，否则部分模型会拒绝调用。
   */
  private toJsonSchema(schema: Record<string, unknown>): JSONSchema7 {
    const properties = schema?.properties as
      Record<string, JSONSchema7> | undefined;

    if (!properties || Object.keys(properties).length === 0) {
      return {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'User input' },
        },
        required: ['input'],
      };
    }

    return {
      type: 'object',
      properties,
      required: (schema?.required as string[]) ?? [],
    };
  }
}
