import {
  BadGatewayException,
  ForbiddenException,
  HttpException,
  Injectable,
  Optional,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ComputeConnectionService } from '../compute-integration/compute-connection.service';
import {
  TASK_EVENT_TYPE,
  TASK_STEP_STATUS,
  type TaskRun,
  type TaskRunStep,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TaskEventBus } from './task-event-bus';
import { SettingService } from '../setting/setting.service';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import { resolveSub2ApiProviderConfig } from '../conversation/sub2api-provider-config';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { ModelRequestLifecycle } from '../conversation/model-request-lifecycle';
import { TaskEventRecorder } from './task-event-recorder';
import { ModelRuntimePolicyService } from '../setting/model-runtime-policy.service';
import { GatewayAdmissionService } from '../gateway/gateway-admission.service';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';
import { fetchUpstream, readUpstreamJson } from '../../common/errors/upstream-http.exception';

/** 单步产出送进汇总模型时的截断长度。太长会把上下文吃满且对成稿帮助有限。 */
const MAX_STEP_CHARS = 6000;

/**
 * 最终交付物。
 *
 * 会议要求「每一步结果均可查看」**且**「最终交付结果」，是两件事。此前只有前者：
 * TaskResultDialog 的注释自己承认它是「把有输出的步骤列出来让人自己翻」。
 * 让用户自己把 5 步产出在脑子里拼成一份方案，等于没有交付。
 */
@Injectable()
export class TaskDeliverableService {
  private readonly logger = new Logger(TaskDeliverableService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingService,
    private readonly modelConfig: EnterpriseModelConfigService,
    private readonly bus: TaskEventBus,
    private readonly events: TaskEventRecorder,
    private readonly runtimePolicy: ModelRuntimePolicyService,
    private readonly admission: GatewayAdmissionService,
    private readonly modelPolicy: GatewayModelPolicyService,
    @Optional() private readonly connections?: ComputeConnectionService,
    @Optional() private readonly computeCredit?: ComputeCreditService,
  ) {}

  async generate(run: TaskRun, steps: TaskRunStep[]): Promise<void> {
    const produced = [...steps]
      .sort((a, b) => a.order - b.order)
      .filter(
        (step) =>
          step.status === TASK_STEP_STATUS.COMPLETED && step.output?.trim(),
      );

    if (produced.length === 0) {
      this.logger.warn(
        `Run ${run.id} completed with no step output; skipping deliverable`,
      );
      return;
    }

    let deliverable: string;
    let degraded = false;
    let diagnostic: ReturnType<typeof exceptionDetails> | undefined;

    try {
      deliverable = await this.summarize(run, produced);
    } catch (error) {
      diagnostic = exceptionDetails(error);
      // 汇总失败不能让整个运行变成失败 —— 步骤产出都在，只是少了一层加工。
      // 退化成机械拼接并如实标注，前端会显示「未经汇总」。
      this.logger.warn(
        `Deliverable summarization failed runId=${run.id} chain=task-deliverable status=${error instanceof HttpException ? error.getStatus() : 'internal'}; falling back to concatenation`,
      );
      deliverable = this.concatenate(run, produced);
      degraded = true;
    }

    const generatedAt = new Date();
    await this.prisma.taskRun.update({
      where: { id: run.id },
      data: {
        deliverable,
        deliverableGeneratedAt: generatedAt,
        deliverableDegraded: degraded,
      },
    });

    this.bus.publish(run.id, {
      type: 'deliverable',
      deliverable,
      degraded,
      ...(diagnostic !== undefined ? { diagnostic } : {}),
      generatedAt: generatedAt.toISOString(),
    });
    await this.events.record({
      taskRunId: run.id,
      type: TASK_EVENT_TYPE.DELIVERABLE_READY,
      message: degraded
        ? '最终交付物已生成（汇总模型不可用，按步骤顺序拼接）'
        : `最终交付物已生成（汇总了 ${produced.length} 位员工的产出）`,
      payload: {
        degraded,
        ...(diagnostic !== undefined ? { diagnostic } : {}),
        chars: deliverable.length,
        stepCount: produced.length,
      },
    });
  }

  private stepBlocks(steps: TaskRunStep[]): string {
    return steps
      .map((step) => {
        const body = (step.output ?? '').trim();
        const clipped =
          body.length > MAX_STEP_CHARS
            ? `${body.slice(0, MAX_STEP_CHARS)}\n…（内容过长已截断）`
            : body;
        return `### 第 ${step.order} 步 · ${step.title}（${step.employeeName}）\n${clipped}`;
      })
      .join('\n\n');
  }

  private concatenate(run: TaskRun, steps: TaskRunStep[]): string {
    return [
      `# ${run.objective}`,
      run.summary?.trim() ? `> ${run.summary.trim()}` : '',
      '',
      this.stepBlocks(steps),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async summarize(run: TaskRun, steps: TaskRunStep[]): Promise<string> {
    if (!run.enterpriseId)
      throw new ForbiddenException('任务缺少企业归属，无法调用汇总模型');
    const member = await this.prisma.enterpriseMember.findFirst({
      where: { userId: run.userId, enterpriseId: run.enterpriseId },
      select: { id: true },
    });
    if (!member)
      throw new ForbiddenException(
        '任务发起人不再是该企业成员，无法调用汇总模型',
      );
    const identity = { enterpriseId: run.enterpriseId, memberId: member.id };
    // 中转参数统一从系统设置取，不读 env（见 resolveSub2ApiProviderConfig）
    const { baseURL, apiKey, defaultModel, fetch: modelFetch, enterpriseBilling } =
      await resolveSub2ApiProviderConfig(this.settings,
        this.connections ? { enterpriseId: run.enterpriseId, connections: this.connections,
          funding: { userId: run.userId, memberId: member.id, sessionId: run.id } } : undefined);

    // 与任务规划同一档「编排与分析模型」：
    // env 强制覆盖（排障）→ 企业选择 → 平台系统设置 → 代码常量。
    // 历史无企业归属的任务只走机械拼接，不借用其他企业的模型预算。
    const override = this.config.get<string>('SUB2API_PLANNER_MODEL');
    const enterpriseChoice =
      !override && run.enterpriseId
        ? await this.modelConfig.getPlannerModel(run.enterpriseId)
        : null;
    const modelId = override || enterpriseChoice || defaultModel;
    if (enterpriseBilling) {
      const balance = await this.computeCredit.checkBalanceBeforeConversation(run.enterpriseId, undefined, run.userId);
      if (!balance.allowed) throw new ForbiddenException({ code: 'INSUFFICIENT_BALANCE', message: balance.reason });
    }

    const snapshot = await this.runtimePolicy.getSnapshot();
    this.logger.log(
      `[ModelPolicy] runId=${run.id} chain=task-deliverable policyVersion=${snapshot.version}`,
    );
    const maxOutputTokens = this.modelPolicy.internalOutputTokens(
      null,
      snapshot,
      snapshot.values.PLANNER_MAX_OUTPUT_TOKENS,
    );
    const request = {
      model: modelId,
      messages: [
        {
          role: 'system',
          content: [
            '你负责把一个多员工协作任务的分步产出，整理成一份可以直接交给业务方的最终交付物。',
            '要求：',
            '1. 用 Markdown 输出，开头是一级标题（任务目标），紧接一段不超过 3 句的整体结论。',
            '2. 按业务逻辑重新组织内容，不要照抄步骤顺序，也不要保留「第几步」这种过程性表述。',
            '3. 各部分末尾用「— 来自：员工名 · 步骤标题」标注来源，让每段都能溯源。',
            '4. 只使用给定产出中的信息，不要补充任何未出现过的事实、数据或结论。',
            '5. 如果多份产出互相矛盾，明确指出矛盾点，不要自行取舍。',
            '6. 直接输出 Markdown 正文，不要用代码块包裹，不要加任何前言或说明。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `任务目标：\n${run.objective}\n\n各步骤产出：\n\n${this.stepBlocks(steps)}`,
        },
      ],
      temperature: 0.2,
      ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
    };

    // Summarization is a separate business call after all conversation steps finish.
    const lease = await this.admission.acquire(identity, snapshot);
    const lifecycle = new ModelRequestLifecycle(
      snapshot.values.PLANNER_REQUEST_TIMEOUT_MS,
      undefined,
      'planner',
    );
    let response: Response | undefined;
    try {
      await lifecycle.wait(
        this.admission.reserve(identity, snapshot, request, maxOutputTokens),
      );
      lifecycle.assertActive();
      response = await lifecycle.wait(
        (modelFetch ?? fetchUpstream)(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: lifecycle.signal,
        }, [apiKey]),
      );

      const payload = (await lifecycle.wait(readUpstreamJson(response, [apiKey]))) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) throw new BadGatewayException('汇总模型返回了空内容');

      return text;
    } finally {
      lifecycle.dispose();
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => undefined);
      await lease.release();
    }
  }
}
