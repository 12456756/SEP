import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  HttpException,
  GatewayTimeoutException,
} from "@nestjs/common";
import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { randomUUID } from 'node:crypto';
import { PrismaService } from "../../prisma/prisma.service";
import { CapabilityService } from "../capability/capability.service";
import { AdapterInput } from "../capability/adapters/adapter.interface";
import { SessionLockService } from "./session-lock.service";
import { ConversationService } from "./conversation.service";
import { SubscriptionService } from "../subscription/subscription.service";
import { EnterpriseContextService } from "../enterprise/enterprise-context.service";
import { KnowledgeSearchService } from "../knowledge/knowledge-search.service";
import { EnterpriseModelConfigService } from "../enterprise-model-config/enterprise-model-config.service";
import { ComputeCreditService } from "../compute-credit/compute-credit.service";
import {
  type MessageAttachment,
  type ModelBillingSnapshot,
} from "shared";
import { calculateBilledCost } from '../model/model-billing.service';
import { SettingService } from "../setting/setting.service";
import { UploadService } from "../upload/upload.service";
import { AttachmentContextService } from "./attachment-context.service";
import { resolveSub2ApiProviderConfig } from "./sub2api-provider-config";
import { ModelRuntimePolicyService } from "../setting/model-runtime-policy.service";
import { GatewayAdmissionService } from "../gateway/gateway-admission.service";
import { GatewayModelPolicyService } from "../gateway/gateway-model-policy.service";
import { ModelRequestLifecycle } from "./model-request-lifecycle";
import {
  SseEvent,
  ModelMessage,
  StoredToolCall,
  AssistantMessageContent,
  ToolResultContent,
} from "./conversation.types";

@Injectable()
export class ConversationStreamService {
  private readonly logger = new Logger(ConversationStreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilityService: CapabilityService,
    private readonly sessionLockService: SessionLockService,
    private readonly conversationService: ConversationService,
    private readonly subscriptionService: SubscriptionService,
    private readonly settingService: SettingService,
    private readonly enterpriseContext: EnterpriseContextService,
    private readonly knowledgeSearch: KnowledgeSearchService,
    private readonly modelConfig: EnterpriseModelConfigService,
    private readonly uploadService: UploadService,
    private readonly attachmentContext: AttachmentContextService,
    private readonly computeCredit: ComputeCreditService,
    private readonly runtimePolicies: ModelRuntimePolicyService,
    private readonly admission: GatewayAdmissionService,
    private readonly modelPolicy: GatewayModelPolicyService,
  ) {}

  // ── main entry ────────────────────────────────────────────────────────────

  async *streamConversation(
    sessionId: string,
    content: string,
    userId: string,
    targetEmployeeId?: string, // 指定处理该消息的员工（多员工协作）
    attachments?: MessageAttachment[], // 多模态附件（图片/文档/视频）
    signal?: AbortSignal,
    onAbort?: (reason: unknown) => void,
  ): AsyncGenerator<SseEvent> {
    // 1. 验证会话归属 + 加载 employee 配置
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: sessionId },
      include: {
        employee: {
          include: {
            bindings: {
              include: {
                capability: {
                  select: {
                    id: true,
                    name: true,
                    description: true,
                    inputSchema: true,
                  },
                },
              },
              orderBy: { priority: "asc" },
            },
          },
        },
      },
    });

    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (session.userId !== userId) throw new ForbiddenException();

    // 附件归属校验：attachments 是前端回传的，必须确认这些存储键属于本人，
    // 否则可以借发消息引用他人文件（前缀含 userId，见 StorageService.buildKey）
    const safeAttachments = attachments ?? [];
    if (safeAttachments.length > 0) {
      await this.uploadService.assertOwnership(
        safeAttachments.map((a) => a.key),
        userId,
      );
    }

    // 🆕 多员工协作：如果指定了 targetEmployeeId，切换到目标员工
    let activeEmployee = session.employee;
    let actualEmployeeId = session.employeeId;

    if (targetEmployeeId && targetEmployeeId !== session.employeeId) {
      // 验证用户是否订阅了目标员工
      await this.subscriptionService.assertActiveSubscription(userId, targetEmployeeId);

      // 加载目标员工配置（包含其绑定的技能）
      const targetEmployee = await this.prisma.digitalEmployee.findUnique({
        where: { id: targetEmployeeId },
        include: {
          bindings: {
            include: {
              capability: {
                select: {
                  id: true,
                  name: true,
                  description: true,
                  inputSchema: true,
                },
              },
            },
            orderBy: { priority: "asc" },
          },
        },
      });

      if (!targetEmployee) {
        throw new NotFoundException(`Employee ${targetEmployeeId} not found`);
      }

      activeEmployee = targetEmployee;
      actualEmployeeId = targetEmployeeId;
      this.logger.log(
        `[Multi-Employee] Session ${sessionId} switching from ${session.employee.name} to ${targetEmployee.name}`,
      );
    }

    const employee = activeEmployee;

    // 逐条消息记录实际处理者。无条件写入（而非仅在切换时写）：
    // 前端要按作者渲染每条气泡，"缺失即默认员工"的隐式约定会让
    // 历史记录在会话默认员工变化后错误归属。
    const handledByMetadata = { handledBy: actualEmployeeId } as unknown as object;

    // 1a. 解析企业上下文（用于预算检查 + 模型解析，仅解析一次）
    const enterpriseCtx = await this.enterpriseContext.resolve(userId);

    // 1b. 预算硬阻断：超额且开启了 hardStopOnBudget 时，直接 403，不加锁不落库

    // 获取雇佣关系（订阅）ID，用于知识库检索 + 模型解析。
    // 收敛后「一企业一员工一雇佣关系」，唯一约束保证这里最多命中一条。
    const subscription = await this.prisma.subscription.findUnique({
      where: {
        enterpriseId_employeeId: {
          enterpriseId: enterpriseCtx.enterpriseId,
          employeeId: employee.id,
        },
      },
      select: { id: true },
    });
    const subscriptionId = subscription?.id;
    const effective = await this.modelConfig.resolveEffectiveModel({
      userId, enterpriseId: enterpriseCtx.enterpriseId,
      requireAvailableModel: true,
      userSelectedModel: session.modelId ?? undefined, subscriptionId,
      employeeTemplateModel: employee.modelId, departmentId: enterpriseCtx.departmentId ?? undefined,
    });
    const modelId = effective.chatModel;
    const billingSnapshot = await this.computeCredit.getBillingSnapshot(modelId);
    Object.assign(handledByMetadata, { billingSnapshot });

    // 1c. 额度 / 余额闸门 —— **每条消息**都要过，不能只在建会话时过一次。
    //
    // 只在 ConversationService.create 里查的话，额度是「开会话那一刻够不够」：
    // 老会话开着不关，额度用尽后照样能一直发，事后只在账单上堆欠费。
    // 而这道闸门本来的意思是「公司这周期还愿不愿意为你付钱」，逐条判定才成立。
    //
    // 放在加锁与落库之前：被拦下的消息不该占用会话锁，也不该在历史里留下
    // 一条永远等不到回复的用户消息。
    const gate = await this.computeCredit.checkBalanceBeforeConversation(
      enterpriseCtx.enterpriseId,
      subscriptionId,
      userId,
      billingSnapshot,
    );
    if (!gate.allowed) {
      // 结构化字段而不是只给一句话：前端要据此弹「额度用尽」对话框并给出
      // 对应的出路（找管理员调额度 / 给企业钱包充值 / 个人充值）。
      yield {
        event: "error",
        data: {
          message: gate.reason ?? "算力余额不足，无法继续对话。",
          code: "COMPUTE_BLOCKED",
          blockedBy: gate.enterpriseFundsBlockedBy ?? "BALANCE",
          personalBalanceCNY: gate.personalBalanceCNY.toFixed(2),
        },
      };
      return;
    }
    if (!gate.enterpriseFundsAllowed) {
      // 改道自费不是错误：对话照常进行，只是这一轮的钱从成员个人余额出。
      // 用 notice 而不是 error —— 前端的 error 分支会中止本轮渲染。
      yield {
        event: "notice",
        data: {
          message: gate.reason,
          code: "COMPUTE_SELF_PAID",
          blockedBy: gate.enterpriseFundsBlockedBy ?? "BALANCE",
          personalBalanceCNY: gate.personalBalanceCNY.toFixed(2),
        },
      };
    }

    signal?.throwIfAborted();
    const policy = await this.runtimePolicies.getSnapshot();
    const model = await this.prisma.platformModel.findUnique({ where: { modelId }, select: { maxOutputTokens: true } });
    const maxOutputTokens = this.modelPolicy.internalOutputTokens(model, policy, policy.values.WEB_DEFAULT_MAX_OUTPUT_TOKENS);
    const requestId = randomUUID();
    Object.assign(handledByMetadata, { policyVersion: policy.version, requestId });
    const identity = { enterpriseId: enterpriseCtx.enterpriseId, memberId: enterpriseCtx.memberId };
    const lockValue = await this.sessionLockService.acquireLock(sessionId, signal);
    let lifecycle: ModelRequestLifecycle | undefined;
    let lease: { release(): Promise<void> } | undefined;
    let lostLock: unknown;
    const notifyAbort = () => onAbort?.(lifecycle?.signal.reason);
    const stopRenewal = this.sessionLockService.startRenewal(sessionId, lockValue, (error) => {
      lostLock = error;
      lifecycle?.abort(error);
    });
    const assertOwnership = () => { if (lostLock) throw lostLock; };

    try {
      lease = await this.admission.acquire(identity, policy);
      lifecycle = new ModelRequestLifecycle(policy.values.WEB_MODEL_TOTAL_TIMEOUT_MS, signal);
      lifecycle.signal.addEventListener('abort', notifyAbort, { once: true });
      if (lifecycle.signal.aborted) notifyAbort();
      assertOwnership();
      lifecycle.assertActive();
      this.logger.log(`[ModelPolicy] requestId=${requestId} session=${sessionId} chain=web policyVersion=${policy.version}`);
      // 3. 持久化用户消息（标记实际处理者 + 附件）
      await this.prisma.message.create({
        data: {
          sessionId,
          role: "USER",
          content,
          metadata: handledByMetadata,
          attachments:
            safeAttachments.length > 0
              ? (safeAttachments as unknown as object[])
              : undefined,
        },
      });

      // 4. 加载历史消息（最近 20 条，已含刚写入的本轮用户消息）
      // 注意：本轮用户消息在上一步已落库，loadMessages 会把它一并读出，
      // 所以这里不能再 push 一次 —— 否则模型会连续看到两条一样的用户消息。
      // 只有最后一条（本轮）带图片字节：历史图片每轮重传会线性推高 input token，
      // 而且多数上游对历史图片并不敏感，退化成文件名说明足够。
      const messages = await lifecycle.wait(this.loadMessages(sessionId, 20));
      assertOwnership();

      // 5. 构建工具映射
      const { tools, capabilityByToolName } = this.buildTools(
        employee.bindings,
      );

      // 5.5. 知识库检索（RAG）
      let knowledgeContext: string | null = null;
      let knowledgeSources: Array<{
        chunkId: string;
        content: string;
        source: string;
        score: number;
        knowledgeBaseId: string;
      }> = [];

      // 只有当雇佣关系存在、且有查询文本时才检索知识库
      // （纯附件消息 content 为空，空串检索没有意义还会白跑一次 embedding）
      if (subscriptionId && content.trim().length > 0) {
        try {
          const searchResult = await lifecycle.wait(this.knowledgeSearch.search(
            content,
            userId,
            subscriptionId,
            3, // topK: 检索 3 个最相关的文本块
            0.7, // scoreThreshold: 相似度阈值
          ));

          if (searchResult.count > 0) {
            // 保存知识来源供后续持久化
            knowledgeSources = searchResult.results.map((r) => ({
              chunkId: r.chunkId,
              content: r.content,
              source: r.source,
              score: r.score,
              knowledgeBaseId: r.knowledgeBaseId,
            }));

            // 构建知识库上下文
            knowledgeContext = searchResult.results
              .map(
                (r, i) =>
                  `[${i + 1}] ${r.content}\n来源: ${r.source} (相似度: ${r.score.toFixed(2)})`,
              )
              .join("\n\n");

            this.logger.log(
              `[RAG] Found ${searchResult.count} knowledge chunks for session ${sessionId}`,
            );
          } else {
            this.logger.debug(
              `[RAG] No relevant knowledge found for session ${sessionId}`,
            );
          }
        } catch (error) {
          lifecycle.assertActive();
          // 知识库检索失败不应阻断对话
          this.logger.error(`[RAG] Search failed for session ${sessionId}:`, error);
        }
      }
      lifecycle.assertActive();
      assertOwnership();

      // 6. 初始化 sub2api provider
      const { baseURL, apiKey } = await resolveSub2ApiProviderConfig(
        this.settingService,
      );
      const hasTools = Object.keys(tools).length > 0;
      // includeUsage 会往请求里加 stream_options，让上游回真实 usage —— 这是准确
      // 计费的前提（缺失时只能按字符估算，input token 会被严重低估）。
      // 但 sub2api 中继在 tools + stream_options 同时出现时返回 400 Invalid request，
      // 故仅在无工具时启用；带工具的会话退回字符估算。

      this.logger.debug(
        `[Model] resolved=${modelId}, source=${effective.source}, session=${sessionId}`,
      );

      // 7. 手动工具循环(每轮一步,finishReason === 'tool-calls' 则继续)
      let stepCount = 0;
      let accumulatedText = "";
      let finishReason: string | undefined;
      let usage: any;

      this.logger.debug(
        `[Stream Init] session=${sessionId}, model=${modelId}, tools=${hasTools ? Object.keys(tools).length : 0}`,
      );

      while (stepCount <= employee.maxSteps) {
        lifecycle.assertActive();
        assertOwnership();
        this.logger.debug(
          `[Stream Step] step=${stepCount}, messages=${messages.length}`,
        );

        // Idle is per model step; the outer total deadline is never reset.
        const abort = new AbortController();
        const cancelStep = () => abort.abort(lifecycle!.signal.reason);
        lifecycle.signal.addEventListener('abort', cancelStep, { once: true });
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimedOut = false;
        const bumpIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleTimedOut = true;
            abort.abort(new GatewayTimeoutException({ message: '模型流空闲超时', code: 'MODEL_STREAM_TIMEOUT', phase: 'idle', policyVersion: policy.version }));
          }, policy.values.SUB2API_STREAM_IDLE_TIMEOUT_MS);
        };

        // Reserve the complete serialized request once per SDK step, including tools/history.
        let reservation: Promise<void> | undefined;
        let reservationError: unknown;
        const provider = createOpenAICompatible({
          name: "sub2api", baseURL, apiKey, includeUsage: !hasTools,
          fetch: async (url, options) => {
            lifecycle!.assertActive();
            assertOwnership();
            const body = JSON.parse(String(options?.body ?? '{}'));
            reservation ??= this.admission.reserve(identity, policy, body, maxOutputTokens).catch((error) => {
              reservationError = error;
              throw error;
            });
            await lifecycle!.wait(reservation);
            lifecycle!.assertActive();
            assertOwnership();
            bumpIdle();
            return fetch(url, options);
          },
        });

        let result: ReturnType<typeof streamText>;
        let streamFinished = false;
        accumulatedText = "";
        const pendingToolCalls: Array<{
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
        }> = [];

        // 🔴 修复 P0-1: 包裹异常处理
        try {
          result = streamText({
            model: provider(modelId),
            instructions: this.buildSystemPrompt(employee.systemPrompt, knowledgeContext),
            messages: messages as Parameters<typeof streamText>[0]["messages"],
            tools: hasTools ? tools : undefined,
            abortSignal: abort.signal,
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          });
          this.logger.debug(`[Stream Result Created] session=${sessionId}`);
          // Cast to any: AI SDK v7 stream chunk property names are unstable across patch versions
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const iterator = result.fullStream[Symbol.asyncIterator]();
          while (true) {
            bumpIdle();
            const next = await lifecycle.wait(iterator.next(), abort.signal);
            if (idleTimer) clearTimeout(idleTimer);
            lifecycle.assertActive();
            assertOwnership();
            if (next.done) {
              streamFinished = true;
              break;
            }
            const rawChunk = next.value;
            // 有动静就重新计时 —— 判定的是「卡住了」，不是「写得久」
            const chunk = rawChunk as any; // eslint-disable-line @typescript-eslint/no-explicit-any
            switch (chunk.type) {
              case "text-delta": {
                const delta: string = chunk.text ?? chunk.textDelta ?? "";
                accumulatedText += delta;
                yield { event: "text_delta", data: delta };
                break;
              }
              case "tool-call": {
                const cap = capabilityByToolName.get(chunk.toolName as string);
                pendingToolCalls.push({
                  toolCallId: (chunk.toolCallId as string) ?? "",
                  toolName: (chunk.toolName as string) ?? "",
                  args: (chunk.input ?? chunk.args ?? {}) as Record<
                    string,
                    unknown
                  >,
                });
                yield {
                  event: "tool_start",
                  data: { name: chunk.toolName, capabilityId: cap?.id },
                };
                break;
              }
              case "reasoning":
              case "reasoning-start":
              case "reasoning-end": {
                const text: string = chunk.content ?? chunk.text ?? "";
                if (text) yield { event: "reasoning_delta", data: text };
                break;
              }
              // AI SDK v7 在 fullStream 中以 error chunk 上报上游错误，
              // 不 throw。若不显式处理，错误会被吞掉，随后 await result.finishReason
              // 抛出无信息的 "No output generated"。这里把真实错误抛出，交给 catch 处理。
              case "error": {
                const err = chunk.error ?? chunk;
                throw err instanceof Error
                  ? err
                  : new Error(
                      typeof err === "string" ? err : JSON.stringify(err),
                    );
              }
            }
          }
        } catch (streamError) {
          streamError = reservationError ?? streamError;
          lifecycle.assertActive();
          assertOwnership();
          // 🔴 修复 P0-1: 捕获流消费异常
          this.logger.error(`Stream consumption error session=${sessionId} requestId=${requestId} policyVersion=${policy.version} status=${streamError instanceof HttpException ? streamError.getStatus() : 'upstream'}`);
          // 空闲超时要说清是「上游没回」而不是含糊的 aborted：
          // AI SDK 把 abort 包装成 AbortError，原话对用户毫无信息量，
          // 而这条消息决定了用户下一步该找谁（换模型 / 找运维看中转）。
          const timedOutSeconds = Math.round(policy.values.SUB2API_STREAM_IDLE_TIMEOUT_MS / 1000);
          const structured = streamError instanceof HttpException ? streamError.getResponse() : undefined;
          const details = structured && typeof structured === 'object' && 'error' in structured &&
            structured.error && typeof structured.error === 'object' ? structured.error : structured;
          yield {
            event: "error",
            data: details && typeof details === 'object' ? { ...details, policyVersion: policy.version } : idleTimedOut
              ? {
                  message: `模型 ${modelId} 超过 ${timedOutSeconds} 秒没有返回任何内容，可能是中转未提供该模型的流式响应。请换一个模型或联系管理员。`,
                  code: "MODEL_STREAM_TIMEOUT",
                  phase: 'idle', policyVersion: policy.version,
                }
              : {
                  message: "AI 回复生成失败，请稍后重试",
                  code: "STREAM_CONSUMPTION_ERROR",
                },
          };
          // 保存错误消息到数据库
          await this.prisma.message.create({
            data: {
              sessionId,
              role: "ASSISTANT",
              content: "❌ 对话生成失败,请稍后重试",
              metadata: handledByMetadata,
            },
          });
          break; // 中断循环
        } finally {
          // 正常走完也要清，否则悬着的定时器会把事件循环拖住
          if (idleTimer) clearTimeout(idleTimer);
          lifecycle.signal.removeEventListener('abort', cancelStep);
          if (!streamFinished || idleTimedOut || lifecycle.signal.aborted) abort.abort();
        }

        // 中止时 AI SDK 让 fullStream **静默结束**，真正的 reject 发生在下面
        // `await result.finishReason` 上 —— 那个异常跑到生成器外面，被控制器的
        // catch 兜成一句 "This operation was aborted"，既没有 code 也没有出路。
        // 所以在这里就地判定：只有本轮真的空闲超时了才走这一支。
        if (idleTimedOut) {
          const timedOutSeconds = Math.round(policy.values.SUB2API_STREAM_IDLE_TIMEOUT_MS / 1000);
          this.logger.error(
            `Upstream model ${modelId} sent nothing for ${timedOutSeconds}s (session ${sessionId})`,
          );
          yield {
            event: "error",
            data: {
              message: `模型 ${modelId} 超过 ${timedOutSeconds} 秒没有返回任何内容，可能是中转未提供该模型的流式响应。请在右上角换一个模型，或联系管理员检查中转。`,
              code: "MODEL_STREAM_TIMEOUT",
              phase: 'idle', policyVersion: policy.version,
            },
          };
          await this.prisma.message.create({
            data: {
              sessionId,
              role: "ASSISTANT",
              content: `❌ 模型 ${modelId} 无响应（等待 ${timedOutSeconds} 秒），本轮未产生回复`,
              metadata: handledByMetadata,
            },
          });
          break;
        }

        lifecycle.assertActive();
        assertOwnership();
        [finishReason, usage] = await lifecycle.wait(Promise.all([
          result.finishReason,
          result.usage,
        ]));
        lifecycle.assertActive();
        assertOwnership();

        // ── 最终回复(无工具调用)────────────────────────────────────────────
        if (finishReason !== "tool-calls") {
          // AI SDK v7 usage 字段兼容处理
          let inputTokens = usage?.promptTokens ?? usage?.inputTokens ?? 0;
          let outputTokens =
            usage?.completionTokens ?? usage?.outputTokens ?? 0;

          // 🔴 Fallback: 当上游未返回 token 数据时,使用文本长度估算(1 token ≈ 4 chars)
          if (inputTokens === 0 && content.length > 0) {
            inputTokens = Math.ceil(content.length / 4);
            this.logger.warn(
              `[Billing] Input tokens missing, estimated from content length: ${inputTokens}`,
            );
          }
          if (outputTokens === 0 && accumulatedText.length > 0) {
            outputTokens = Math.ceil(accumulatedText.length / 4);
            this.logger.warn(
              `[Billing] Output tokens missing, estimated from response length: ${outputTokens}`,
            );
          }

          this.logger.debug(
            `[Billing Check] usage=${JSON.stringify(usage)}, input=${inputTokens}, output=${outputTokens}`,
          );

          // 计算消息成本（用于账单明细和成本分析）。
          // 与 chargeUsage 共用调用开始时的快照，活动中途切换不会改变本笔价格。
          const { costCNY } = calculateBilledCost(billingSnapshot, inputTokens, outputTokens);

          lifecycle.assertActive();
          assertOwnership();
          const saved = await this.prisma.message.create({
            data: {
              sessionId,
              role: "ASSISTANT",
              content: accumulatedText,
              inputTokens,
              outputTokens,
              modelId, // 记录实际使用的模型（会话级 > 员工级 > 系统默认）
              cost: costCNY, // 单条消息成本（CNY），精确到 6 位小数
              knowledgeSources:
                knowledgeSources.length > 0
                  ? (knowledgeSources as unknown as object)
                  : null,
              metadata: handledByMetadata,
            },
          });

          // 计费记账 (只要有实际对话就记账,不能因上游数据缺失而漏计费)
          if (inputTokens > 0 && outputTokens > 0) {
            this.logger.log(
              `[Billing] Recording usage for session ${sessionId}: input=${inputTokens}, output=${outputTokens}`,
            );
            await this.recordUsage({
              enterpriseId: enterpriseCtx.enterpriseId,
              userId: session.userId,
              sessionId,
              messageId: saved.id,
              modelId,
              inputTokens,
              outputTokens,
              employeeId: employee.id,
              subscriptionId,
              billingSnapshot,
            });
          } else {
            this.logger.error(
              `[Billing] Cannot record usage - both input and output tokens are 0 for session ${sessionId}`,
            );
          }

          lifecycle.assertActive();
          assertOwnership();
          await this.prisma.conversationSession.update({
            where: { id: sessionId },
            data: { updatedAt: new Date() },
          });
          await this.conversationService.autoGenerateTitle(sessionId, content);
          lifecycle.assertActive();
          assertOwnership();
          yield { event: "done", data: { messageId: saved.id, usage } };
          break;
        }

        // ── 工具调用步骤：持久化 assistant 消息 ──────────────────────────────
        const storedToolCalls: StoredToolCall[] = pendingToolCalls.map(
          (tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          }),
        );
        await this.prisma.message.create({
          data: {
            sessionId,
            role: "ASSISTANT",
            content: accumulatedText,
            toolCalls: storedToolCalls as unknown as object,
            metadata: handledByMetadata,
          },
        });

        // ── 手动执行每个工具 ─────────────────────────────────────────────────
        const toolResults: ToolResultContent[] = [];

        for (const tc of pendingToolCalls) {
          lifecycle.assertActive();
          assertOwnership();
          const cap = capabilityByToolName.get(tc.toolName);

          // 🔴 修复: 检查工具是否存在
          if (!cap) {
            this.logger.error(
              `Tool "${tc.toolName}" not found in bindings for session ${sessionId}`,
            );
            toolResults.push({
              type: "tool-result",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: {
                type: "error-text",
                value: `工具 "${tc.toolName}" 未找到或未绑定`,
              },
            });
            yield {
              event: "tool_end",
              data: { name: tc.toolName, success: false, durationMs: 0 },
            };
            continue;
          }

          const startTime = Date.now();
          let resultText = "No result";
          let execSuccess = false;

          try {
            const input: AdapterInput = {
              userMessage: JSON.stringify(tc.args),
              sessionId,
              userId,
            };
            const execResult = await this.capabilityService.execute(
              cap.id,
              input,
              // 正式执行统一取企业启用版本，userId 仅保留调用者归因。
              { subscriptionId, userId },
            );
            resultText = execResult.success
              ? execResult.output
              : `Error: ${execResult.error}`;
            execSuccess = execResult.success;
            await this.prisma.toolExecution.create({
              data: {
                sessionId,
                capabilityId: cap.id,
                input: tc.args as unknown as object,
                output: { text: resultText },
                duration: Date.now() - startTime,
                status: execResult.success ? "SUCCESS" : "FAILED",
                errorMessage: execResult.error,
                skillVersionId: execResult.skillVersionId ?? null,
                userId: userId ?? null,
              },
            });
          } catch (err) {
            resultText = `Execution error: ${(err as Error).message}`;
            this.logger.error(`Tool execution failed: ${tc.toolName}`, err);
          }

          toolResults.push({
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: execSuccess
              ? { type: "text", value: resultText }
              : { type: "error-text", value: resultText },
          });
          yield {
            event: "tool_end",
            data: {
              name: tc.toolName,
              success: execSuccess,
              durationMs: Date.now() - startTime,
            },
          };
          // Non-cancellable tools retain their real execution record even after the deadline.
          // Losing ownership forbids any further session writes or tool dispatch.
          assertOwnership();
          if (lifecycle.signal.aborted) break;
        }

        // 工具结果的人类可读形式（前端直接渲染这段）
        const toolResultText = toolResults
          .map((r) => `🔧 工具: ${r.toolName}\n📋 结果: ${r.output.value}`)
          .join("\n\n");

        // 持久化工具结果：content 存人类可读文本（前端直接渲染），
        // 结构化部件存 toolCalls 字段供 loadMessages 还原成 ModelMessage。
        // 此前只存可读文本却用 JSON.parse 读回，带工具调用的会话必然续聊失败。
        await this.prisma.message.create({
          data: {
            sessionId,
            role: "TOOL",
            content: toolResultText,
            toolCalls: toolResults as unknown as object,
          },
        });
        lifecycle.assertActive();
        assertOwnership();

        // 追加到 messages 供下一轮使用
        // AI SDK v7 的 tool-call 部件字段是 input（v4 时代叫 args）
        const assistantParts: AssistantMessageContent[] = pendingToolCalls.map(
          (tc) => ({
            type: "tool-call" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.args,
          }),
        );
        messages.push({ role: "assistant", content: assistantParts });
        messages.push({ role: "tool", content: toolResults });

        stepCount++;
      }

      // 🔴 修复 P0-3: 兜底逻辑,防止达到 maxSteps 后无最终回复
      if (stepCount > employee.maxSteps) {
        lifecycle.assertActive();
        assertOwnership();
        this.logger.warn(
          `Session ${sessionId} reached maxSteps=${employee.maxSteps} without final reply`,
        );
        const fallbackContent =
          accumulatedText || "抱歉,处理步骤超过限制,无法继续生成回复";
        const saved = await this.prisma.message.create({
          data: {
            sessionId,
            role: "ASSISTANT",
            content: fallbackContent,
            inputTokens: null,
            outputTokens: null,
            metadata: handledByMetadata,
          },
        });
        yield { event: "done", data: { messageId: saved.id, usage: {} } };
      }
    } catch (err) {
      if (!lease) throw err;
      this.logger.error(`Stream error session=${sessionId} requestId=${requestId} policyVersion=${policy.version} status=${err instanceof HttpException ? err.getStatus() : 'internal'}`);
      const response = err instanceof HttpException ? err.getResponse() : undefined;
      const details = response && typeof response === 'object' && 'error' in response &&
        response.error && typeof response.error === 'object' ? response.error : response;
      yield {
        event: "error",
        data: {
          message: err instanceof HttpException ? err.message : "对话处理失败，请稍后重试",
          ...(details && typeof details === 'object' ? details : {}),
          policyVersion: policy.version,
        },
      };
    } finally {
      lifecycle?.signal.removeEventListener('abort', notifyAbort);
      lifecycle?.dispose();
      await stopRenewal();
      try {
        await lease?.release();
      } finally {
        await this.sessionLockService.releaseLock(sessionId, lockValue);
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * 从 DB 加载最近 N 条消息，转换为 AI SDK ModelMessage 格式
   */
  private async loadMessages(
    sessionId: string,
    limit: number,
  ): Promise<ModelMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        role: true,
        content: true,
        toolCalls: true,
        attachments: true,
      },
    });

    rows.reverse(); // 最早的在前
    const messages: ModelMessage[] = [];
    // 最后一条用户消息即本轮 —— 只有它带图片字节
    const lastUserIndex = rows.reduce(
      (acc, row, i) => (row.role === "USER" ? i : acc),
      -1,
    );

    for (const [index, row] of rows.entries()) {
      if (row.role === "USER") {
        const attachments = (row.attachments ?? []) as unknown as
          | MessageAttachment[]
          | null;

        if (attachments && attachments.length > 0) {
          const ctx = await this.attachmentContext.build(attachments, {
            includeImageBytes: index === lastUserIndex,
          });
          if (ctx.parts.length > 0) {
            // 文本部件放最前，附件跟在后面 —— 模型更容易把问题与材料对应上
            const parts = row.content
              ? [{ type: "text" as const, text: row.content }, ...ctx.parts]
              : ctx.parts;
            messages.push({
              role: "user",
              content: parts as never,
            });
            continue;
          }
        }

        messages.push({ role: "user", content: row.content });
      } else if (row.role === "ASSISTANT") {
        if (row.toolCalls) {
          const tcs = row.toolCalls as unknown as StoredToolCall[];
          const parts: AssistantMessageContent[] = [];
          if (row.content) parts.push({ type: "text", text: row.content });
          parts.push(
            ...tcs.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              // v7 用 input（非 args）
              input: tc.args,
            })),
          );
          messages.push({ role: "assistant", content: parts });
        } else {
          messages.push({ role: "assistant", content: row.content });
        }
      } else if (row.role === "TOOL") {
        // 结构化部件存在 toolCalls 字段（content 是给前端看的可读文本）。
        // 缺失说明是旧数据（当时只存了可读文本），跳过而非抛错，
        // 否则历史会话一律无法加载。
        if (!row.toolCalls) continue;
        const results = row.toolCalls as unknown as ToolResultContent[];
        messages.push({ role: "tool", content: results });
      }
    }

    return messages;
  }

  /**
   * 从员工绑定的 capabilities 构建 AI SDK tools 对象（无 execute，手动执行）
   */
  private buildTools(
    bindings: Array<{
      capability: {
        id: string;
        name: string;
        description: string;
        inputSchema: unknown;
      };
    }>,
  ) {
    const capabilityByToolName = new Map<
      string,
      { id: string; name: string }
    >();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};

    for (const binding of bindings) {
      const cap = binding.capability;
      // 工具名基于 capability.id（避免中文名转换问题），但必须先做归一化：
      // 部分上游（如 Anthropic）会把工具名里的 `-` 规范成 `_` 再回传，
      // 导致 `demo-cap-search` 发出去、`demo_cap_search` 回来，查表 miss。
      // 这里统一用下划线形式，发送与查表两侧同源。
      const toolName = this.toToolName(cap.id);
      capabilityByToolName.set(toolName, { id: cap.id, name: cap.name });
      tools[toolName] = {
        description: cap.description,
        inputSchema: z.object(
          this.buildZodShape(cap.inputSchema as Record<string, unknown>),
        ),
      };
    }

    return { tools, capabilityByToolName };
  }

  /**
   * capability.id → 合法且稳定的工具名。
   * OpenAI 工具名规范为 `^[a-zA-Z0-9_-]{1,64}$`，但部分上游会把 `-` 归一成 `_`，
   * 故这里主动统一为下划线，保证发送名与回传名一致。
   */
  private toToolName(capabilityId: string): string {
    return capabilityId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
  }

  /**
   * JSON Schema properties → Zod shape（复用自 DigitalEmployeeRunner）
   */
  private buildZodShape(
    schema: Record<string, unknown>,
  ): Record<string, z.ZodTypeAny> {
    const properties = schema?.properties as
      Record<string, Record<string, unknown>> | undefined;
    const required = (schema?.required as string[]) ?? [];

    if (!properties || Object.keys(properties).length === 0) {
      return { input: z.string().describe("User input") };
    }

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, def] of Object.entries(properties)) {
      let zodType: z.ZodTypeAny;
      switch (def.type as string) {
        case "number":
        case "integer":
          zodType = z.number();
          break;
        case "boolean":
          zodType = z.boolean();
          break;
        case "array":
          zodType = z.array(z.any());
          break;
        case "object":
          zodType = z.record(z.any());
          break;
        default:
          zodType = z.string();
      }
      if (typeof def.description === "string") {
        zodType = zodType.describe(def.description);
      }
      shape[key] = required.includes(key) ? zodType : zodType.optional();
    }
    return shape;
  }

  /**
   * 记录用量并按统一人民币口径扣费。
   *
   * 扣费顺序：该订阅的赠送人民币余额 → 企业钱包。Token 只作为账单明细，
   * 不再从任何 Token 配额扣减 —— 同一次对话不会既扣配额又扣钱。
   *
   * `messageId` 是幂等锚点：流式对话会因网络重试重复走到这里，
   * 没有它就会对同一条回复重复扣费。
   */
  private async recordUsage(params: {
    enterpriseId: string;
    userId: string;
    sessionId: string;
    messageId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    employeeId: string;
    subscriptionId?: string;
    billingSnapshot: ModelBillingSnapshot;
  }): Promise<void> {
    const { enterpriseId, userId, sessionId, messageId, modelId } = params;
    try {
      const result = await this.computeCredit.chargeUsage({
        enterpriseId,
        subscriptionId: params.subscriptionId ?? null,
        employeeId: params.employeeId,
        userId,
        sessionId,
        messageId,
        modelId,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        billingSnapshot: params.billingSnapshot,
      });

      if (result.alreadyCharged) {
        this.logger.warn(
          `[Billing] Message ${messageId} already charged, skipped duplicate deduction`,
        );
        return;
      }

      // 四条腿全打出来：它们之和恒等于 cost，所以这一行日志自带对账能力。
      // 少印「个人」那条，成员自费的对话会显示成「花了 ¥0.12，来源全是 0」。
      this.logger.log(
        `[Billing] session=${sessionId} tokens=${params.inputTokens}/${params.outputTokens} ` +
          `cost=¥${result.costCNY.toFixed(6)} ` +
          `(赠送 ¥${result.creditPaidCNY.toFixed(6)} + 钱包 ¥${result.walletPaidCNY.toFixed(6)}` +
          ` + 个人 ¥${result.personalPaidCNY.toFixed(6)}` +
          ` + 欠费 ¥${result.unpaidCNY.toFixed(6)})` +
          `${result.fallbackPricing ? " [FALLBACK PRICING]" : ""}`,
      );

      if (result.unpaidCNY.greaterThan(0)) {
        // 余额永不为负是硬约束，所以欠费如实记账而不是让扣款失败。
        // 走到这里意味着企业资金**和**成员个人余额都见底了 —— 个人钱包排在扣费链
        // 最后一位，它还有钱的话这笔就不会欠。下一次对话前的闸门会拦下后续调用。
        this.logger.warn(
          `[Billing] 企业 ${enterpriseId} 与成员 ${userId} 的余额均已用尽，` +
            `本次欠费 ¥${result.unpaidCNY.toFixed(6)}`,
        );
      }
      if (result.personalPaidCNY.greaterThan(0)) {
        // 改道自费是正常路径（额度用尽或企业没钱），但管理员事后一定会问
        // 「为什么这笔算在员工头上」，所以留一条可检索的痕。
        this.logger.log(
          `[Billing] 成员 ${userId} 自费承担 ¥${result.personalPaidCNY.toFixed(6)}` +
            `（企业资金不足或本周期算力额度已用尽）`,
        );
      }
      if (result.fallbackPricing) {
        this.logger.warn(
          `Model ${modelId} has no configured pricing — charged at fallback rate. Add it to MODEL_PRICING.`,
        );
      }
    } catch (err) {
      // 计费失败不应阻断对话，记录错误即可
      this.logger.error(`Failed to record usage for user ${userId}`, err);
    }
  }

  /**
   * 构建系统提示词，注入知识库上下文（如果有）
   */
  private buildSystemPrompt(
    basePrompt: string,
    knowledgeContext: string | null,
  ): string {
    if (!knowledgeContext) {
      return basePrompt;
    }

    return `${basePrompt}

## 知识库参考

以下是从知识库中检索到的相关内容，请优先基于这些内容回答用户问题：

${knowledgeContext}

---

**重要提示**：
- 如果知识库内容能够回答用户问题，请优先使用知识库信息
- 引用知识库内容时，可以标注来源编号（如 [1]、[2]）
- 如果知识库内容与问题不相关或不足以回答，请结合你的通用知识回答
- 不要编造知识库中没有的内容`;
  }
}
