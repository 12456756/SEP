'use client';

import { useState } from 'react';
import { MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/feedback';
import type { ConversationSession } from '@/lib/types';

interface SessionListProps {
  sessions: ConversationSession[];
  activeId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function SessionList({
  sessions,
  activeId,
  loading,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: SessionListProps) {
  return (
    <div className="flex h-full w-full shrink-0 flex-col border-r border-border bg-sidebar md:w-72">
      <div className="p-3">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-white py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <MessageSquarePlus className="h-4 w-4" />
          新建会话
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 scroll-thin">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner className="text-primary" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-fg-subtle">
            还没有会话，点上方按钮开始
          </p>
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeId}
                onSelect={() => onSelect(s.id)}
                onRename={(title) => onRename(s.id, title)}
                onDelete={() => onDelete(s.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: ConversationSession;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? '');

  // P2.3: 会话标题策略 = 员工名 · 首句截断（若无自定义标题）
  const defaultTitle = session.employee?.name
    ? `${session.employee.name}的对话`
    : '新会话';
  const title = session.title || defaultTitle;
  const employeeArchived = session.employee?.status === 'ARCHIVED';

  if (editing) {
    return (
      <li>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-full rounded-lg border border-primary/50 bg-white px-3 py-2 text-sm outline-none ring-2 ring-primary-ring"
        />
      </li>
    );
  }

  function commit() {
    const t = draft.trim();
    setEditing(false);
    if (t && t !== session.title) onRename(t);
  }

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'relative flex w-full flex-col items-start gap-0.5 rounded-lg py-2 text-left transition-all duration-150',
          active
            ? 'bg-muted pl-5 pr-3 before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r before:bg-primary'
            : 'px-3 hover:bg-muted/50 hover:pl-5',
        )}
      >
        <span
          className={cn(
            'line-clamp-1 w-full pr-6 text-sm font-medium',
            active ? 'text-foreground' : 'text-foreground',
          )}
        >
          {title}
        </span>
        {employeeArchived && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
            员工已下架
          </span>
        )}
        <span className="text-xs text-fg-subtle">
          {formatDistanceToNow(new Date(session.updatedAt), {
            addSuffix: true,
            locale: zhCN,
          })}
          {session._count?.messages ? ` · ${session._count.messages} 条` : ''}
        </span>
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((o) => !o);
        }}
        className={cn(
          'absolute right-2 top-2 rounded p-1 text-fg-subtle opacity-0 transition-opacity hover:bg-border group-hover:opacity-100',
          menuOpen && 'opacity-100',
        )}
        aria-label="会话操作"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute right-2 top-9 z-20 w-32 overflow-hidden rounded-lg border border-border bg-white py-1 shadow-md">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setDraft(session.title ?? '');
                setEditing(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-muted"
            >
              <Pencil className="h-3.5 w-3.5" /> 重命名
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-danger hover:bg-muted"
            >
              <Trash2 className="h-3.5 w-3.5" /> 删除
            </button>
          </div>
        </>
      )}
    </li>
  );
}
