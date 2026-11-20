'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { Spinner } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { useSubscriptions } from '@/features/subscription/use-subscriptions';

interface NewSessionDialogProps {
  open: boolean;
  creating?: boolean;
  presetEmployeeId?: string | null;
  onClose: () => void;
  onPick: (employeeId: string) => void;
}

export function NewSessionDialog({
  open,
  creating,
  presetEmployeeId,
  onClose,
  onPick,
}: NewSessionDialogProps) {
  const { data: subs = [], isLoading } = useSubscriptions();
  const [selected, setSelected] = useState<string | null>(presetEmployeeId ?? null);
  const [lastOpen, setLastOpen] = useState(open);

  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setSelected(presetEmployeeId ?? null);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => !creating && onClose()}
      />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-xl border border-border bg-white shadow-md">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          {/* 列表里是硅基员工（数字员工模板），不是碳基员工（真人成员）。
              原文案把两者说反了，而这两个词在本产品里是核心区分。 */}
          <h3 className="text-base font-semibold text-foreground">选择硅基员工</h3>
          <button
            type="button"
            onClick={() => !creating && onClose()}
            className="rounded p-1 text-fg-subtle hover:bg-muted"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-3 scroll-thin">
          {isLoading ? (
            <CenteredSpinner label="加载雇佣关系…" />
          ) : subs.length === 0 ? (
            <EmptyState
              title="你还没有可对话的硅基员工"
              description="先去元机AI人才市场雇佣一位硅基员工，再回来开始对话。"
              action={
                <Link href="/marketplace">
                  <Button size="sm">前往元机AI人才市场</Button>
                </Link>
              }
            />
          ) : (
            <ul className="space-y-1">
              {subs.map((sub) => {
                const emp = sub.employee;
                const active = selected === emp.id;
                return (
                  <li key={sub.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(emp.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                        active
                          ? 'border-primary/40 bg-primary-subtle'
                          : 'border-transparent hover:bg-muted',
                      )}
                    >
                      <Avatar
                        name={emp.name}
                        src={emp.avatar}
                        asset={emp.avatarAsset}
              portrait
                        className="h-9 w-9 shrink-0 text-sm"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium text-foreground">
                          {emp.name}
                        </p>
                        <p className="line-clamp-1 text-xs text-fg-muted">
                          {emp.position} · {emp.industry}
                        </p>
                      </div>
                      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {subs.length > 0 && (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={creating}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!selected || creating}
              onClick={() => selected && onPick(selected)}
            >
              {creating && <Spinner className="text-white" />}
              开始对话
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
