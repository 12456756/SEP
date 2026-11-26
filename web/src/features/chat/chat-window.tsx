'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { qk } from '@/lib/query-keys';
import { computeCreditKeys } from '@/lib/api/use-compute-credit';
import { personalWalletKeys } from '@/lib/api/use-personal-wallet';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { MessageBubble } from './message-bubble';
import { InputBar } from './input-bar';
import { ModelSwitcher } from './model-switcher';
import { useChatStream, type SendOutcome } from './use-chat-stream';
import { QuotaBlockedDialog } from './quota-blocked-dialog';
import { useConversation } from './use-conversations';
import { useSubscribedEmployees } from './use-subscribed-employees';
import { useAuthStore } from '@/lib/auth-store';
import { useModelConfig } from '@/features/enterprise-settings/use-model-config';
import type { Message, MessageAttachment } from '@/lib/types';

interface ChatWindowProps {
  conversationId: string;
  onNewSession?: () => void;
}

/** Local echo of a just-sent user message before the server round-trips. */
interface PendingUser {
  id: string;
  content: string;
  attachments?: MessageAttachment[];
}

export function ChatWindow({ conversationId, onNewSession }: ChatWindowProps) {
  const qc = useQueryClient();
  const { data: conversation, isLoading, isError, refetch } = useConversation(conversationId);
  const { state, send, stop, reset, dismissBlocked } = useChatStream();
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null);
  // 本轮流式回复的作者，用于让实时气泡显示正确的员工而非会话默认员工
  const [streamingAuthorId, setStreamingAuthorId] = useState<string | null>(null);
  // 本轮回复落库后的 id（后端 done 事件给的）。历史里出现这条 id 就说明
  // 权威副本已到位，实时气泡必须让位 —— 否则同一段回复会挂两遍。
  const [settledMessageId, setSettledMessageId] = useState<string | null>(null);
  // 发送轮次。refetch 是异步的，期间用户可能又发了一条；收尾逻辑靠它确认
  // 「我还是最新那一轮」，不去清掉后一轮的状态。
  const sendSeqRef = useRef(0);
  // 本轮开始时历史里有多少条消息，供 messageId 缺失时的兜底判据用
  const [baselineCount, setBaselineCount] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 企业模型策略：用于 ModelSwitcher 的白名单 + 锁定控制
  const enterprise = useAuthStore((s) => s.enterprise);
  const { data: modelConfig } = useModelConfig(enterprise?.id ?? '');

  // 多员工协作：加载用户订阅的所有员工
  const { data: subscribedEmployees = [] } = useSubscribedEmployees();

  const employee = conversation?.employee;
  const employeeArchived = employee?.status === 'ARCHIVED';
  const persisted: Message[] = conversation?.messages ?? [];

  // 会话默认员工排在首位，其余订阅员工去重跟在后面
  const employees = useMemo(() => {
    const list = employee
      ? [
          {
            id: employee.id,
            name: employee.name,
            avatar: employee.avatar ?? null,
            avatarAsset: subscribedEmployees.find((s) => s.id === employee.id)?.avatarAsset ?? employee.avatarAsset,
            position: subscribedEmployees.find((s) => s.id === employee.id)?.position,
          },
        ]
      : [];
    for (const sub of subscribedEmployees) {
      if (sub.id !== employee?.id) {
        list.push({
          id: sub.id,
          name: sub.name,
          avatar: sub.avatar,
          avatarAsset: sub.avatarAsset,
          position: sub.position,
        });
      }
    }
    return list;
  }, [employee, subscribedEmployees]);

  const employeeById = useMemo(
    () => new Map(employees.map((e) => [e.id, e])),
    [employees],
  );

  /** 消息的实际作者；handledBy 缺失时（旧数据）归属会话默认员工 */
  const authorOf = (m: Message) =>
    (m.metadata?.handledBy ? employeeById.get(m.metadata.handledBy) : undefined) ??
    (employee ? employeeById.get(employee.id) : undefined) ?? employee;

  /** 本轮流式回复的作者；streamingAuthorId 未设置时归属会话默认员工 */
  const streamingAuthor =
    (streamingAuthorId ? employeeById.get(streamingAuthorId) : undefined) ??
    (employee ? employeeById.get(employee.id) : undefined) ?? employee;


  /**
   * 本轮回复的权威副本是否已经在历史里。
   *
   * 首选按 done 事件给的 messageId 精确比对；老后端或异常情况下拿不到 id 时，
   * 退回「历史比本轮开始时变长了」这个兜底判据 —— 不能只看「最后一条是助手
   * 消息」，因为进入会话时最后一条本来就常常是助手消息，那样流一停就会把
   * 实时气泡撤掉，refetch 还没落地，回复会闪一下不见。
   *
   * 两条路都不做文本比对：内容偶然一致时的误判代价太高。
   */
  const liveReplyPersisted = settledMessageId
    ? persisted.some((m) => m.id === settledMessageId)
    : baselineCount !== null && persisted.length > baselineCount;

  const showLiveAssistant =
    !liveReplyPersisted &&
    (state.streaming || !!state.text || !!state.error || state.toolCalls.length > 0);

  // auto-scroll to bottom on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [persisted.length, state.text, state.reasoning, state.toolCalls, pendingUser]);

  const handleSend = async (
    text: string,
    targetEmployeeId?: string,
    attachments?: MessageAttachment[],
  ): Promise<SendOutcome> => {
    // 会话详情未加载成功或默认员工已下架时，不允许误发到无效会话。
    if (!conversation || isError || employeeArchived) return 'failed';

    const seq = ++sendSeqRef.current;
    setPendingUser({ id: `pending-${Date.now()}`, content: text, attachments });
    setStreamingAuthorId(targetEmployeeId ?? employee?.id ?? null);
    // 新一轮开始：清掉上一轮的落库标记，记下当前历史长度作为兜底基线
    setSettledMessageId(null);
    setBaselineCount(persisted.length);

    const outcome = await send(
      conversationId,
      text,
      targetEmployeeId,
      async (info) => {
        // 记下落库 id：历史刷回来时靠它判断实时气泡该不该撤
        setSettledMessageId(info.messageId ?? null);

        // on completion, refetch canonical history (includes persisted tool calls)
        await Promise.all([
          qc.invalidateQueries({ queryKey: qk.conversation(conversationId) }),
          qc.invalidateQueries({ queryKey: qk.conversations }),
          // 本轮扣费在后端与消息落库同一轮完成；不失效这些缓存时，
          // 额度页会继续显示扣费前余额，直到用户手动刷新页面。
          qc.invalidateQueries({ queryKey: computeCreditKeys.all }),
          qc.invalidateQueries({ queryKey: personalWalletKeys.all }),
        ]);

        // 期间用户又发了新消息，后一轮的状态不能被这一轮的收尾清掉
        if (sendSeqRef.current !== seq) return;

        // 权威副本已在界面上，本地这份可以退场了。等 refetch 落地后再清，
        // 顺序反了会有一帧「两条都没有」的空档。
        setPendingUser(null);
        reset();
      },
      attachments,
    );

    // 发送失败时这条消息没落库，乐观气泡必须撤掉 —— 留着的话界面上有条
    // 刷新就消失的假消息，正是"记录不见了"的观感来源。文字和附件由
    // InputBar 依据返回值还原，用户不用重新输入、重新上传。
    if (outcome === 'failed') {
      setPendingUser(null);
      setStreamingAuthorId(null);
      setBaselineCount(null);
    }

    return outcome;
  };

  // notice 也算「有内容」：改道自费的提示可能出现在第一条消息上，
  // 那时历史还是空的。只看 showLiveAssistant 的话空态会盖住这条提示 ——
  // 但它不该反过来撑出一个空的助手气泡，所以判据放这里而不是并进 showLiveAssistant。
  const isEmpty =
    persisted.length === 0 &&
    !pendingUser &&
    !showLiveAssistant &&
    !state.notice &&
    !employeeArchived;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <header className="z-10 flex flex-shrink-0 items-center gap-3 border-b border-border bg-white px-6 py-3">
        <Bot className="h-5 w-5 text-primary" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            {employee?.name ?? '对话'}
          </h2>
          {conversation?.title && (
            <p className="text-xs text-fg-subtle">{conversation.title}</p>
          )}
        </div>
        {conversation && (
          <ModelSwitcher
            conversationId={conversationId}
            currentModelId={conversation.modelId ?? null}
            employeeModelId={employee?.modelId}
            enterpriseDefaultModel={modelConfig?.defaultChatModel ?? null}
            employeeModelPolicy={modelConfig?.employeeModelPolicy}
            employeeDefaultModel={modelConfig?.employeeDefaultModel ?? null}
            enterpriseId={enterprise?.id ?? ''}
            allowedChatModels={modelConfig?.allowedChatModels ?? []}
            canSwitch={modelConfig?.allowUserSwitchModel ?? true}
          />
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {isLoading ? (
          <CenteredSpinner label="加载会话…" />
        ) : isError ? (
          <ErrorState
            title="会话加载失败"
            message="会话详情暂时无法读取，请重试；如果仍然失败，请刷新页面后再试。"
            onRetry={() => void refetch()}
          />
        ) : isEmpty ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title={`开始和 ${employee?.name ?? '碳基员工'} 对话`}
              description="输入你的问题，看它如何调用硅基能力完成任务。"
            />
          </div>
        ) : (
          <div
            className="mx-auto max-w-3xl space-y-5 px-4 py-6"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
          >
            {employeeArchived && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <p className="font-medium">该硅基员工已下架</p>
                <p className="mt-1 text-amber-800">
                  这段历史消息仍可查看，但不能继续发送。请新建会话选择当前已上架的员工。
                </p>
                {onNewSession && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3 border-amber-300 bg-white hover:bg-amber-100"
                    onClick={onNewSession}
                  >
                    新建会话
                  </Button>
                )}
              </div>
            )}

            {persisted
              .filter((m) => m.role !== 'TOOL')
              .map((m) => {
                const author = authorOf(m);
                return (
                  <MessageBubble
                    key={m.id}
                    role={m.role.toLowerCase() as 'user' | 'assistant'}
                    content={m.content}
                    toolCalls={m.toolCalls}
                    knowledgeSources={m.knowledgeSources}
                    attachments={m.attachments}
                    employeeName={author?.name}
                    employeeAvatar={author?.avatar}
                    employeeAvatarAsset={author?.avatarAsset}
                    createdAt={m.createdAt}
                  />
                );
              })}

            {pendingUser && (
              <MessageBubble
                role="user"
                content={pendingUser.content}
                attachments={pendingUser.attachments}
              />
            )}

            {showLiveAssistant && (
              <MessageBubble
                role="assistant"
                content={state.text}
                reasoning={state.reasoning}
                toolCalls={state.toolCalls}
                employeeName={streamingAuthor?.name}
                employeeAvatar={streamingAuthor?.avatar}
                employeeAvatarAsset={streamingAuthor?.avatarAsset}
                streaming={state.streaming}
              />
            )}

            {/* 非致命提示（目前只有「本轮由个人余额支付」）。琥珀色而非红色 ——
                这一轮照常出结果，红字会让用户以为发失败了。 */}
            {state.notice && (
              <p className="rounded-lg bg-amber-500/10 px-4 py-2 text-sm text-amber-700">
                {state.notice}
              </p>
            )}

            {state.error && (
              <p className="rounded-lg bg-danger/10 px-4 py-2 text-sm text-danger">
                {state.error}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 无条件挂载：点「个人余额充值」时它会先自关，条件挂载会把充值弹窗一起卸掉 */}
      <QuotaBlockedDialog info={state.blocked} onClose={dismissBlocked} />

      {!isLoading && !isError && !employeeArchived && conversation && (
        <div className="z-20 flex-shrink-0 border-t bg-white">
          <InputBar
            onSend={handleSend}
            onStop={stop}
            streaming={state.streaming}
            defaultEmployeeId={employee?.id ?? ''}
            employees={employees}
          />
        </div>
      )}
    </div>
  );
}
