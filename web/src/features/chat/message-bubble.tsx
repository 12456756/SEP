'use client';

import { useState } from 'react';
import { Brain, ChevronRight, FileText } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Markdown } from './markdown';
import { ToolCallBlock } from './tool-call-block';
import { AttachmentDisplay } from './attachment-display';
import type { LiveToolCall } from './use-chat-stream';
import type {
  Message,
  MessageAttachment,
  ToolCallRecord,
  KnowledgeSource,
  EmployeeAvatarAsset,
} from '@/lib/types';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: (LiveToolCall | ToolCallRecord)[] | null;
  knowledgeSources?: KnowledgeSource[] | null;
  attachments?: MessageAttachment[] | null;
  employeeName?: string | null;
  employeeAvatar?: string | null;
  employeeAvatarAsset?: EmployeeAvatarAsset | null;
  streaming?: boolean;
  createdAt?: string;
}

export function MessageBubble({
  role,
  content,
  reasoning,
  toolCalls,
  knowledgeSources,
  attachments,
  employeeName,
  employeeAvatar,
  employeeAvatarAsset,
  streaming,
  createdAt,
}: MessageBubbleProps) {
  const [showTimestamp, setShowTimestamp] = useState(false);

  const formattedTime = createdAt
    ? formatDistanceToNow(new Date(createdAt), { addSuffix: true, locale: zhCN })
    : null;

  if (role === 'user') {
    const hasAttachments = !!attachments && attachments.length > 0;
    return (
      <div className="group flex justify-end">
        <div className="flex flex-col items-end gap-1">
          {showTimestamp && formattedTime && (
            <span className="text-xs text-fg-subtle">{formattedTime}</span>
          )}
          <div
            className={cn(
              'min-w-[4rem] max-w-[75%] space-y-2 rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-[15px] leading-relaxed text-primary-foreground shadow-sm transition-shadow hover:shadow-md',
              // 纯附件消息（content 为空）不需要文字行的左右内边距对齐
              hasAttachments && !content && 'py-2',
            )}
            onMouseEnter={() => setShowTimestamp(true)}
            onMouseLeave={() => setShowTimestamp(false)}
          >
            {hasAttachments && (
              <AttachmentDisplay attachments={attachments} onPrimary />
            )}
            {content && <div className="whitespace-pre-wrap px-1">{content}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="group flex gap-3"
      onMouseEnter={() => setShowTimestamp(true)}
      onMouseLeave={() => setShowTimestamp(false)}
    >
      <Avatar
        name={employeeName ?? 'AI'}
        src={employeeAvatar ?? undefined}
        asset={employeeAvatarAsset}
        className="mt-0.5 h-9 w-9 shrink-0 text-sm shadow-sm"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          {employeeName && (
            <p className="text-xs font-medium text-fg-muted">{employeeName}</p>
          )}
          {showTimestamp && formattedTime && (
            <span className="text-xs text-fg-subtle">{formattedTime}</span>
          )}
        </div>
        {reasoning && <ReasoningBlock text={reasoning} />}
        {toolCalls?.map((tc, i) => (
          <ToolCallBlock key={i} call={tc} />
        ))}
        {content ? (
          <div className="rounded-2xl rounded-tl-sm bg-card px-4 py-3 shadow-sm ring-1 ring-border transition-shadow hover:shadow-md">
            <Markdown content={content} />
          </div>
        ) : streaming && !reasoning && !toolCalls?.length ? (
          <TypingDots />
        ) : null}
        {streaming && content && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-fg-muted align-middle" />}
        {knowledgeSources && knowledgeSources.length > 0 && (
          <KnowledgeSources sources={knowledgeSources} />
        )}
      </div>
    </div>
  );
}

function KnowledgeSources({ sources }: { sources: KnowledgeSource[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 rounded-xl border border-border bg-gradient-to-br from-muted/40 to-muted/20 shadow-sm ring-1 ring-border/50 text-sm backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/60 rounded-t-xl"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
          <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
        </div>
        <span className="font-medium text-fg-muted">参考来源</span>
        <Badge variant="glass" className="ml-auto text-xs">
          {sources.length}
        </Badge>
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-fg-subtle transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
          {sources.map((source, i) => (
            <div
              key={source.chunkId}
              className="group relative overflow-hidden rounded-lg border border-border bg-card p-3.5 text-xs shadow-sm ring-1 ring-border/50 transition-all hover:shadow-md hover:ring-border"
            >
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="glass-info" className="text-xs font-medium">
                  [{i + 1}]
                </Badge>
                <span className="font-semibold text-fg-muted">{source.source}</span>
                <div
                  className={cn(
                    'ml-auto flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                    source.score >= 0.8
                      ? 'bg-success/10 text-success'
                      : source.score >= 0.6
                      ? 'bg-info/10 text-info'
                      : 'bg-muted text-fg-muted',
                  )}
                >
                  <div
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      source.score >= 0.8
                        ? 'bg-success'
                        : source.score >= 0.6
                        ? 'bg-info'
                        : 'bg-fg-subtle',
                    )}
                  />
                  {(source.score * 100).toFixed(0)}%
                </div>
              </div>
              <p className="text-fg-subtle leading-relaxed line-clamp-3">
                {source.content}
              </p>
              {/* 左侧装饰条 */}
              <div
                className={cn(
                  'absolute left-0 top-0 h-full w-1 transition-opacity',
                  source.score >= 0.8
                    ? 'bg-success'
                    : source.score >= 0.6
                    ? 'bg-info'
                    : 'bg-muted',
                )}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-muted/40 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-90',
          )}
        />
        <Brain className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        <span className="font-medium text-fg-muted">思考过程</span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-border px-3 py-2 text-[13px] leading-relaxed text-fg-muted">
          {text}
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-tl-sm bg-card px-4 py-3 shadow-sm ring-1 ring-border">
      <span className="text-xs text-fg-muted">正在输入</span>
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-fg-muted"
            style={{
              animationDelay: `${i * 0.15}s`,
              animationDuration: '1s',
            }}
          />
        ))}
      </div>
    </div>
  );
}
