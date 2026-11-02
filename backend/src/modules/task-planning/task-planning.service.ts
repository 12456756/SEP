import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  HttpException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { SettingService } from '../setting/setting.service';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import { resolveSub2ApiProviderConfig } from '../conversation/sub2api-provider-config';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { type ModelRuntimePolicySnapshot } from 'shared';
import { ModelRuntimePolicyService } from '../setting/model-runtime-policy.service';
import { GatewayAdmissionService } from '../gateway/gateway-admission.service';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import { ModelRequestLifecycle } from '../conversation/model-request-lifecycle';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import {
  PlannerOutputSchema,
  type PlannerOutput,
  type TaskPlanPreviewDto,
} from './task-planning.types';

type CandidateCapability = { id: string; name: string; description: string; type: string };
type CandidateEmployee = {
  id: string;
  name: string;
  description: string;
  position: string;
  industry: string;
  avatar: string | null;
  capabilities: CandidateCapability[];
};

@Injectable()
export class TaskPlanningService {
  private readonly logger = new Logger(TaskPlanningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly enterpriseContext: EnterpriseContextService,
    private readonly config: ConfigService,
    private readonly settings: SettingService,
    private readonly modelConfig: EnterpriseModelConfigService,
    private readonly runtimePolicies: ModelRuntimePolicyService,
    private readonly admission: GatewayAdmissionService,
    private readonly modelPolicy: GatewayModelPolicyService,
    private readonly computeCredit: ComputeCreditService,
  ) {}

  async preview(userId: string, dto: TaskPlanPreviewDto, signal?: AbortSignal) {
    const context = await this.enterpriseContext.resolve(userId);
    const grants = await this.prisma.employeeGrant.findMany({
      where: {
        OR: [{ memberId: context.memberId }, ...(context.departmentId ? [{ departmentId: context.departmentId }] : [])],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
        subscription: { enterpriseId: context.enterpriseId, status: 'ACTIVE' },
      },
      select: { subscriptionId: true },
    });
    const grantedSubscriptionIds = new Set(grants.map((grant) => grant.subscriptionId));
    const subscriptions = (await this.subscriptions.findAll(userId))
      .filter((subscription) => subscription.status === 'ACTIVE')
      .filter((subscription) => grantedSubscriptionIds.has(subscription.id))
      .filter((subscription) => !dto.employeeIds || dto.employeeIds.includes(subscription.employee.id));

    if (subscriptions.length === 0) {
      throw new BadRequestException('当前没有可用于编排的已订阅硅基员工');
    }

    const employeeIds = subscriptions.map((subscription) => subscription.employee.id);
    const employees = await this.prisma.digitalEmployee.findMany({
      where: { id: { in: employeeIds }, status: 'APPROVED' },
      select: {
        id: true,
        name: true,
        description: true,
        position: true,
        industry: true,
        avatar: true,
        bindings: {
          orderBy: { priority: 'asc' },
          select: {
            capability: {
              select: { id: true, name: true, description: true, type: true },
            },
          },
        },
      },
    }) as unknown as Array<{
      id: string;
      name: string;
      description: string;
      position: string;
      industry: string;
      avatar: string | null;
      bindings: Array<{ capability: CandidateCapability }>;
    }>;

    const candidates: CandidateEmployee[] = employees.map((employee) => ({
      id: employee.id,
      name: employee.name,
      description: employee.description,
      position: employee.position,
      industry: employee.industry,
      avatar: employee.avatar,
      capabilities: employee.bindings.map(({ capability }) => capability),
    })).filter((employee) => employee.capabilities.length > 0);

    if (candidates.length === 0) {
      throw new BadRequestException('已订阅员工都没有绑定可执行能力');
    }

    // 先解析模型再请求：报错文案里要带上模型名，否则用户不知道该去改哪个设置
    const plannerModel = await this.resolvePlannerModel(context.enterpriseId);
    const gate = await this.computeCredit.checkBalanceBeforeConversation(context.enterpriseId, undefined, userId, plannerModel);
    if (!gate.allowed) throw new ForbiddenException({ code: 'COMPUTE_BLOCKED', message: gate.reason ?? '算力余额不足' });
    signal?.throwIfAborted();
    const policy = await this.runtimePolicies.getSnapshot();
    const identity = { enterpriseId: context.enterpriseId, memberId: context.memberId };
    const model = await this.prisma.platformModel.findUnique({ where: { modelId: plannerModel }, select: { maxOutputTokens: true } });
    const outputTokens = this.modelPolicy.internalOutputTokens(model, policy, policy.values.PLANNER_MAX_OUTPUT_TOKENS);
    const lease = await this.admission.acquire(identity, policy);
    let plannerOutput: PlannerOutput;
    try {
      plannerOutput = await this.generatePlan(dto.objective, candidates, plannerModel, identity, policy, outputTokens, signal);
    } finally {
      await lease.release();
    }
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const stepIds = plannerOutput.steps.map((_, index) => `step-${index + 1}`);
    const steps = plannerOutput.steps.flatMap((step, index) => {
      const employee = candidateById.get(step.employeeId);
      const capability = employee?.capabilities.find((item) => item.id === step.capabilityId);
      if (!employee || !capability) return [];

      const dependsOn = step.dependsOnStepNumbers
        .filter((number) => number <= index && number > 0)
        .map((number) => stepIds[number - 1]);

      return [{
        id: stepIds[index],
        order: index + 1,
        title: step.title,
        description: step.description,
        intent: 'llm_planned',
        employee,
        capability,
        dependsOn,
        rationale: step.rationale,
        estimatedSeconds: step.estimatedSeconds,
        status: 'queued' as const,
        progress: 0,
      }];
    });

    if (steps.length === 0) {
      throw new BadGatewayException('规划模型返回了无效的员工或能力选择，请重试');
    }

    return {
      id: `plan-${crypto.randomUUID()}`,
      objective: dto.objective.trim(),
      summary: plannerOutput.summary,
      steps,
      status: 'awaiting_confirmation' as const,
      createdAt: new Date().toISOString(),
      planner: {
        type: 'llm',
        model: plannerModel,
      },
    };
  }

  /**
   * 规划器用哪个模型。解析顺序：
   *   env SUB2API_PLANNER_MODEL（排障用的强制覆盖，平时不设）
   *     → 企业「编排与分析模型」
   *       → 平台系统设置 SUB2API_DEFAULT_MODEL
   *         → 代码常量 DEFAULT_MODEL_ID
   *
   * env 放最前面是刻意的：线上模型出问题时要能不动数据库就把全站切到已知可用的
   * 模型；平时它是空的，所以企业的选择才是实际生效的那一档。
   */
  private async resolvePlannerModel(enterpriseId: string): Promise<string> {
    const override = this.config.get<string>('SUB2API_PLANNER_MODEL');
    if (override) return override;
    const enterpriseChoice = await this.modelConfig.getPlannerModel(enterpriseId);
    if (enterpriseChoice) return enterpriseChoice;
    const { defaultModel } = await resolveSub2ApiProviderConfig(this.settings);
    return defaultModel;
  }

  private async generatePlan(
    objective: string,
    candidates: CandidateEmployee[],
    modelId: string,
    identity: { enterpriseId: string; memberId: string },
    policy: ModelRuntimePolicySnapshot,
    outputTokens: number | undefined,
    signal?: AbortSignal,
  ): Promise<PlannerOutput> {
    // 走系统设置而不是 env —— 这里原来直接读 ConfigService，而线上 env 里的
    // SUB2API_API_KEY 已失效、SystemSetting 里的是有效的，于是「对话正常、
    // 任务规划报 relay 401」，同一台机器两个功能两种结果。见该函数的注释。
    const { baseURL, apiKey } = await resolveSub2ApiProviderConfig(this.settings);
    const catalog = JSON.stringify(candidates, null, 2);

    const body = {
          model: modelId,
          messages: [
            {
              role: 'system',
              content: [
          '你是硅基人才平台的任务编排规划器。',
          '你的工作是把用户目标拆解为可执行、有依赖关系的步骤，并从候选硅基员工及其能力中选择最合适的执行者。',
          '只能使用候选目录中出现的 employeeId 和 capabilityId，禁止臆造 ID。',
          '只有确实需要多个角色时才拆成多个步骤；简单任务可以只有一个步骤。',
          'dependsOnStepNumbers 只能填写前面已经出现的步骤编号。',
          'estimatedSeconds 必须是 10 到 3600 之间的整数。',
          '不要执行任何任务，只生成等待用户确认的计划。',
          '只返回一个合法 JSON 对象，不要使用 Markdown 代码块或附加说明。',
          'JSON 必须符合：{ "summary": string, "steps": [{ "employeeId": string, "capabilityId": string, "title": string, "description": string, "rationale": string, "dependsOnStepNumbers": number[], "estimatedSeconds": number }] }。',
              ].join('\n'),
            },
            { role: 'user', content: `用户任务目标：\n${objective}\n\n候选硅基员工与能力目录：\n${catalog}` },
          ],
          temperature: 0.1,
          ...(outputTokens === undefined ? {} : { max_tokens: outputTokens }),
    };
    await this.admission.reserve(identity, policy, body, outputTokens);
    const lifecycle = new ModelRequestLifecycle(policy.values.PLANNER_REQUEST_TIMEOUT_MS, signal, 'planner');
    const requestId = randomUUID();
    this.logger.log(`[ModelPolicy] requestId=${requestId} chain=planner policyVersion=${policy.version}`);
    let response: Response | undefined;
    try {
      lifecycle.assertActive();
      response = await lifecycle.wait(fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: lifecycle.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (!response.ok) {
        await lifecycle.wait(response.text());
        throw new BadGatewayException('任务规划上游服务暂时不可用');
      }
      const payload = await lifecycle.wait(response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      lifecycle.assertActive();
      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new BadGatewayException('规划模型返回了空内容');

      return PlannerOutputSchema.parse(this.extractPlanJson(text));
    } catch (error) {
      if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
      if (error instanceof HttpException) throw error;
      this.logger.error(`Task planning failed requestId=${requestId} chain=planner policyVersion=${policy.version} status=internal`);
      throw new BadGatewayException('任务规划模型暂时不可用，请稍后重试');
    } finally {
      lifecycle.dispose();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    }
  }

  private extractPlanJson(text: string): unknown {
    const fencedJson = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const source = (fencedJson?.[1] ?? text).trim();
    const firstBrace = source.indexOf('{');
    const lastBrace = source.lastIndexOf('}');

    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw new BadGatewayException('规划模型没有返回可解析的 JSON 计划');
    }

    return JSON.parse(source.slice(firstBrace, lastBrace + 1));
  }
}
