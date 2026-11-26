import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Optional,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ComputeConnectionService } from '../compute-integration/compute-connection.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MODEL_ID, SETTING_KEYS } from 'shared';
import { localError } from '../../common/errors/error-diagnostics';
import { fetchUpstream, readUpstreamJson } from '../../common/errors/upstream-http.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SkillVersionService } from '../skill-version/skill-version.service';
import { SettingService } from '../setting/setting.service';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import { resolveSub2ApiProviderConfig } from '../conversation/sub2api-provider-config';
import { ModelRequestLifecycle } from '../conversation/model-request-lifecycle';
import { ModelRuntimePolicyService } from '../setting/model-runtime-policy.service';
import {
  GatewayAdmissionService,
  type GatewayAdmissionIdentity,
} from '../gateway/gateway-admission.service';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import {
  InsightOutputSchema,
  type AdoptInsightDto,
  type GenerateInsightDto,
  type InsightOutput,
} from './capability-insight.types';

/** 送进模型的执行样本上限。再多不会让建议更准，只会更贵更慢。 */
const MAX_EXECUTION_SAMPLES = 40;
/** 单条输入/输出截断长度。完整对话可能上万字，全塞进去会挤掉别的样本。 */
const SAMPLE_CHARS = 800;

@Injectable()
export class CapabilityInsightService {
  private readonly logger = new Logger(CapabilityInsightService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enterpriseContext: EnterpriseContextService,
    private readonly skillVersions: SkillVersionService,
    private readonly config: ConfigService,
    private readonly settings: SettingService,
    private readonly modelConfig: EnterpriseModelConfigService,
    private readonly runtimePolicy: ModelRuntimePolicyService,
    private readonly admission: GatewayAdmissionService,
    private readonly modelPolicy: GatewayModelPolicyService,
    @Optional() private readonly connections?: ComputeConnectionService,
    @Optional() private readonly computeCredit?: ComputeCreditService,
  ) {}

  /**
   * 生成迭代建议（会议纪要2 §6.5）。
   *
   * 两种模式共用一条实现，只是取材范围不同：
   * - MEMBER：某位成员的执行记录 + 他的个人副本 diff
   * - ALL：全企业执行记录 + 所有个人副本 → 统一提炼一份
   *
   * 同步执行而不是入队：一次 LLM 调用 10–30 秒，前端可以等；
   * 引入队列反而要多做一套「建议生成到哪一步了」的状态机。
   */
  async generate(
    userId: string,
    capabilityId: string,
    dto: GenerateInsightDto,
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);

    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
      select: { id: true, name: true, description: true, type: true },
    });
    if (!capability) throw new NotFoundException('能力不存在');

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        enterpriseId: ctx.enterpriseId,
        status: 'ACTIVE',
        employee: { bindings: { some: { capabilityId } } },
      },
      select: { id: true },
    });
    if (!subscription)
      throw new ForbiddenException('本企业未雇佣携带该技能的硅基员工');

    const baseline = await this.skillVersions.resolveEffectiveVersion(
      subscription.id,
      capabilityId,
    );
    if (!baseline)
      throw new NotFoundException('该技能还没有可用版本，无法分析');

    const [executions, personalVersions] = await Promise.all([
      this.prisma.toolExecution.findMany({
        where: {
          capabilityId,
          session: {
            user: {
              memberships: { some: { enterpriseId: ctx.enterpriseId } },
              ...(dto.scope === 'MEMBER' ? { id: dto.memberId } : {}),
            },
          },
        },
        select: {
          id: true,
          input: true,
          output: true,
          status: true,
          createdAt: true,
          user: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_EXECUTION_SAMPLES,
      }),
      this.prisma.skillVersion.findMany({
        where: {
          capabilityId,
          scope: 'PERSONAL',
          status: 'PERSONAL_ACTIVE',
          enterpriseId: ctx.enterpriseId,
          ...(dto.scope === 'MEMBER' ? { ownerId: dto.memberId } : {}),
        },
        select: {
          id: true,
          content: true,
          changeSummary: true,
          owner: { select: { id: true, name: true } },
        },
      }),
    ]);

    if (executions.length === 0 && personalVersions.length === 0) {
      throw new BadRequestException(
        dto.scope === 'MEMBER'
          ? '这位成员还没有使用记录也没有个人改动，无从分析'
          : '本企业还没有使用记录也没有成员改动，无从分析',
      );
    }

    const modelId = await this.resolveModelId(ctx.enterpriseId);
    const output = await this.askModel({
      capabilityName: capability.name,
      baselineContent: baseline.content,
      executions: executions.map((exec) => ({
        member: exec.user?.name ?? '未知成员',
        status: exec.status,
        input: this.truncate(exec.input),
        output: this.truncate(exec.output),
      })),
      personalVersions: personalVersions.map((version) => ({
        owner: version.owner?.name ?? '未知成员',
        changeSummary: version.changeSummary,
        content: version.content.slice(0, 4000),
      })),
      modelId,
      userId,
      identity: { enterpriseId: ctx.enterpriseId, memberId: ctx.memberId },
    });

    return this.prisma.capabilityInsight.create({
      data: {
        capabilityId,
        enterpriseId: ctx.enterpriseId,
        scope: dto.scope,
        memberId: dto.scope === 'MEMBER' ? dto.memberId : null,
        findings: output.findings,
        sampleSize: executions.length,
        personalCount: personalVersions.length,
        modelId,
        createdById: userId,
      },
    });
  }

  /** 建议列表。仅企业管理员 —— 建议正文里含成员的使用细节。 */
  async list(userId: string, capabilityId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.prisma.capabilityInsight.findMany({
      where: { capabilityId, enterpriseId: ctx.enterpriseId },
      include: {
        createdBy: { select: { id: true, name: true } },
        adoptedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  /** 旧采纳入口只保留权限和记录校验，不再从 Web 正文生成企业版本。 */
  async adopt(userId: string, insightId: string, _dto: AdoptInsightDto) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);

    const insight = await this.prisma.capabilityInsight.findFirst({
      where: { id: insightId, enterpriseId: ctx.enterpriseId },
    });
    if (!insight) throw new NotFoundException('建议不存在');
    if (insight.status !== 'PENDING') {
      throw new ConflictException('该建议已处理过');
    }
    throw new ForbiddenException(
      'AI 建议正文采纳已停用，请通过客户端修改技能并提交企业审核',
    );
  }

  /** 拒绝建议。留痕而不删除 —— 同一个现象被反复建议时能看出「已经拒过一次」。 */
  async dismiss(userId: string, insightId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    const insight = await this.prisma.capabilityInsight.findFirst({
      where: { id: insightId, enterpriseId: ctx.enterpriseId },
    });
    if (!insight) throw new NotFoundException('建议不存在');
    if (insight.status !== 'PENDING')
      throw new ConflictException('该建议已处理过');
    return this.prisma.capabilityInsight.update({
      where: { id: insight.id },
      data: {
        status: 'DISMISSED',
        adoptedById: userId,
        resolvedAt: new Date(),
      },
    });
  }

  /**
   * 与任务规划同一档「编排与分析模型」：
   * env 强制覆盖（排障）→ 企业选择 → 平台系统设置 → 代码常量。
   */
  private async resolveModelId(enterpriseId: string): Promise<string> {
    const override = this.config.get<string>('SUB2API_PLANNER_MODEL');
    if (override) return override;
    const enterpriseChoice =
      await this.modelConfig.getPlannerModel(enterpriseId);
    if (enterpriseChoice) return enterpriseChoice;
    return (await this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_DEFAULT_MODEL)) || DEFAULT_MODEL_ID;
  }

  private truncate(value: unknown) {
    const text =
      typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return text.length > SAMPLE_CHARS
      ? `${text.slice(0, SAMPLE_CHARS)}…`
      : text;
  }

  private async askModel(params: {
    capabilityName: string;
    baselineContent: string;
    executions: Array<{
      member: string;
      status: string;
      input: string;
      output: string;
    }>;
    personalVersions: Array<{
      owner: string;
      changeSummary: string | null;
      content: string;
    }>;
    modelId: string;
    userId: string;
    identity: GatewayAdmissionIdentity;
  }): Promise<InsightOutput> {
    // 中转参数统一从系统设置取，不读 env（见 resolveSub2ApiProviderConfig）
    const { baseURL, apiKey, fetch: modelFetch, enterpriseBilling } = await resolveSub2ApiProviderConfig(
      this.settings,
      this.connections ? { enterpriseId: params.identity.enterpriseId, connections: this.connections, funding: { memberId: params.identity.memberId } } : undefined,
    );
    if (!apiKey) throw new BadGatewayException('分析模型未配置，请联系管理员');
    if (enterpriseBilling) {
      const balance = await this.computeCredit.checkBalanceBeforeConversation(params.identity.enterpriseId, undefined, params.userId);
      if (!balance.allowed) throw new ForbiddenException({ code: 'INSUFFICIENT_BALANCE', message: balance.reason });
    }

    const material = [
      `## 技能当前生效正文\n${params.baselineContent.slice(0, 8000)}`,
      params.personalVersions.length
        ? `## 成员的个人改动（${params.personalVersions.length} 份）\n${params.personalVersions
            .map(
              (version, index) =>
                `### ${index + 1}. ${version.owner}${version.changeSummary ? `（自述：${version.changeSummary}）` : ''}\n${version.content}`,
            )
            .join('\n\n')}`
        : '## 成员的个人改动\n（无）',
      params.executions.length
        ? `## 最近的使用记录（${params.executions.length} 条）\n${params.executions
            .map(
              (exec, index) =>
                `### ${index + 1}. ${exec.member} · ${exec.status}\n输入：${exec.input}\n输出：${exec.output}`,
            )
            .join('\n\n')}`
        : '## 最近的使用记录\n（无）',
    ].join('\n\n');

    const snapshot = await this.runtimePolicy.getSnapshot();
    const requestId = randomUUID();
    this.logger.log(
      `[ModelPolicy] requestId=${requestId} chain=capability-insight policyVersion=${snapshot.version}`,
    );
    const maxOutputTokens = this.modelPolicy.internalOutputTokens(
      null,
      snapshot,
      snapshot.values.PLANNER_MAX_OUTPUT_TOKENS,
    );
    const request = {
      model: params.modelId,
      messages: [
        {
          role: 'system',
          content: [
            '你是企业能力沉淀分析器。企业买了一个技能，成员在使用中各自改了自己的副本、也留下了使用记录。',
            '你的任务：找出「值得升级进企业统一版本」的共性改进点。',
            '判据 —— 只报下面这类：',
            '  1. 多位成员在个人副本里做了相似的修改（说明企业版缺这一块）',
            '  2. 使用记录显示某类输入反复得不到好结果（说明正文有盲区）',
            '  3. 成员补充了企业特定的术语、话术、流程约束（属于组织知识，应该沉淀）',
            '不要报这类：个人偏好、一次性的临时调整、与技能职责无关的内容。',
            'confidence 反映证据强度：多人一致且有使用记录支撑给 0.8 以上；只有一个人改过给 0.5 以下。',
            'affectedSnippet 只在你能从当前正文里准确定位到片段时给出，定位不到就省略这个字段，不要编。',
            '没有值得沉淀的内容时返回空数组 —— 硬凑建议会让管理员失去对这个功能的信任。',
            '只返回一个合法 JSON 对象，不要 Markdown 代码块：',
            '{ "findings": [{ "phenomenon": string, "suggestion": string, "affectedSnippet"?: string, "confidence": number }] }',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `技能名称：${params.capabilityName}\n\n${material}`,
        },
      ],
      temperature: 0.2,
      ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
    };
    const lease = await this.admission.acquire(params.identity, snapshot);
    const lifecycle = new ModelRequestLifecycle(
      snapshot.values.PLANNER_REQUEST_TIMEOUT_MS,
      undefined,
      'planner',
    );
    let response: Response | undefined;
    try {
      // Admission errors must keep their platform status/code rather than become upstream 502.
      await lifecycle.wait(
        this.admission.reserve(
          params.identity,
          snapshot,
          request,
          maxOutputTokens,
        ),
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
      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new BadGatewayException('分析模型返回了空内容');
      return InsightOutputSchema.parse(this.extractJson(text));
    } catch (error) {
      if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
      this.logger.error(
        `Model request failed requestId=${requestId} chain=capability-insight policyVersion=${snapshot.version} status=${error instanceof HttpException ? error.getStatus() : 'internal'}`,
      );
      if (error instanceof HttpException) throw error;
      throw localError(error, 502, { origin: 'sep', stage: 'capability-insight' }, [apiKey]);
    } finally {
      lifecycle.dispose();
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => undefined);
      await lease.release();
    }
  }

  private extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const source = (fenced?.[1] ?? text).trim();
    const first = source.indexOf('{');
    const last = source.lastIndexOf('}');
    if (first < 0 || last <= first) {
      throw new BadGatewayException('分析模型没有返回可解析的 JSON');
    }
    return JSON.parse(source.slice(first, last + 1));
  }
}
