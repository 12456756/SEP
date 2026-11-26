'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MessageSquare, MessageSquarePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/feedback';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { SessionList } from '@/features/chat/session-list';
import { ChatWindow } from '@/features/chat/chat-window';
import { NewSessionDialog } from '@/features/chat/new-session-dialog';
import {
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useRenameConversation,
} from '@/features/chat/use-conversations';

export default function ChatPage() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { data: sessions = [], isLoading } = useConversations();
  const { mutate: createConversation, isPending: isCreating } = useCreateConversation();
  const renameConv = useRenameConversation();
  const deleteConv = useDeleteConversation();

  // preselect employee from ?employeeId= (e.g. arriving from marketplace)
  const presetEmployee = searchParams.get('employeeId');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const handledPreset = useRef<string | null>(null);

  // 历史会话可能关联已下架员工；优先打开仍可用的会话，避免进入页面就被旧会话卡住。
  const defaultSessionId =
    sessions.find((session) => session.employee?.status !== 'ARCHIVED')?.id ??
    sessions[0]?.id ??
    null;
  const effectiveActive = activeId ?? defaultSessionId;

  const handleCreate = useCallback((employeeId: string) => {
    createConversation(
      { employeeId },
      {
        onSuccess: (conv) => {
          setActiveId(conv.id);
          setPickerOpen(false);
          setMobileSessionsOpen(false);
        },
        /*
          没有这个分支时，创建失败的表现是「点了开始对话，什么都不发生」——
          弹窗不关、没有提示、按钮的 loading 转一下就恢复。而后端在这条路上有三种
          明确的拒绝理由（员工不存在 / 无有效雇佣 / 算力与个人余额都见底），
          全被吞掉了。线上就是这么表现的：按钮像坏了，其实后端每次都回了原因。
        */
        onError: (error) =>
          toast.error(
            error instanceof ApiError || error instanceof Error
              ? error.message
              : '创建会话失败，请稍后重试',
          ),
      },
    );
  }, [createConversation]);

  useEffect(() => {
    if (!presetEmployee) {
      handledPreset.current = null;
      return;
    }
    if (handledPreset.current === presetEmployee) return;

    handledPreset.current = presetEmployee;
    const params = new URLSearchParams(searchParams.toString());
    params.delete('employeeId');
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
    handleCreate(presetEmployee);
  }, [handleCreate, pathname, presetEmployee, router, searchParams]);

  const handleDelete = (id: string) => {
    deleteConv.mutate(id, {
      onSuccess: () => {
        if (effectiveActive === id) setActiveId(null);
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden pb-[calc(6rem+env(safe-area-inset-bottom))] md:flex-row md:pb-0">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-sidebar px-3 py-2 md:hidden">
        <Button variant="ghost" size="sm" aria-expanded={mobileSessionsOpen} aria-controls="chat-sessions"
          onClick={() => setMobileSessionsOpen(open => !open)}>
          {mobileSessionsOpen ? <X className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
          {mobileSessionsOpen ? '收起会话' : '会话列表'}
        </Button>
        <Button variant="ghost" size="icon" aria-label="新建会话" title="新建会话" onClick={() => setPickerOpen(true)}>
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div id="chat-sessions" className={cn('absolute inset-0 z-30 md:static md:block md:shrink-0', !mobileSessionsOpen && 'hidden')}>
          <SessionList
            sessions={sessions}
            activeId={effectiveActive}
            loading={isLoading}
            onSelect={(id) => { setActiveId(id); setMobileSessionsOpen(false); }}
            onNew={() => setPickerOpen(true)}
            onRename={(id, title) => renameConv.mutate({ id, title })}
            onDelete={handleDelete}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {effectiveActive ? (
            <ChatWindow
              key={effectiveActive}
              conversationId={effectiveActive}
              onNewSession={() => setPickerOpen(true)}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={<MessageSquare className="h-8 w-8" />}
                title="选择或新建一个会话"
                description="从左侧选择已有会话，或点击新建会话挑选一位硅基员工开始对话。"
              />
            </div>
          )}
        </div>
      </div>

      <NewSessionDialog
        open={pickerOpen}
        creating={isCreating}
        presetEmployeeId={presetEmployee}
        onClose={() => setPickerOpen(false)}
        onPick={handleCreate}
      />
    </div>
  );
}
