'use client';

import { History, Loader2, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TaskRunStatus } from '../task-orchestration';
import type { TaskRunSummary } from '../task-run';


const STATUS_CHIP: Record<TaskRunStatus, string> = {
  draft: 'border-glassline bg-glass-2 text-gtext-muted',
  awaiting_confirmation: 'border-glassline-brand bg-gbrand/10 text-gbrand-text',
  running: 'border-glassline-brand bg-gbrand/10 text-gbrand-text',
  completed: 'border-gsuccess/25 bg-gsuccess/[0.08] text-gsuccess',
  failed: 'border-gdanger/25 bg-gdanger/[0.08] text-gdanger',
  stopped: 'border-gwarning/25 bg-gwarning/[0.08] text-gwarning',
};

const STATUS_LABEL: Record<TaskRunStatus, string> = {
  draft: '草稿',
  awaiting_confirmation: '待确认',
  running: '进行中',
  completed: '已完成',
  failed: '有步骤卡住',
  stopped: '已停止',
};

/**
 * 工作记录抽屉。
 *
 * 「孤儿运行 + 手动回收」那套东西在执行引擎搬到服务端后不再需要：失联的运行由
 * TaskReconcileService 每分钟自动接回或收口，用户不用（也不该）自己去点
 * 「标记为已停止」—— 他看到的现象是「一直转圈」，本来就不会想到去点那个按钮。
 */
export function TaskHistoryDrawer({
  open,
  runs,
  loading,
  activeRunId,
  running,
  onOpenChange,
  onSelect,
  onDelete,
  onNew,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  open: boolean;
  runs: TaskRunSummary[];
  loading: boolean;
  activeRunId?: string;
  running: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (run: TaskRunSummary) => void;
  onDelete: (run: TaskRunSummary) => void;
  onNew: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40">
      <div
        className="absolute inset-0 bg-gbg-deep/55 backdrop-blur-glass-xs"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <aside
        className="flex h-full w-[min(22rem,100vw)] flex-col border-r border-glassline bg-gbg-raised shadow-glass-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-glassline px-4 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">
              <History className="h-4 w-4 text-gbrand-text" />
              工作记录
            </p>
            <p className="mt-1 text-[11px] text-gtext-muted">保存在你的账号下，换设备也能看到</p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-glass-md text-gtext-muted transition-colors hover:bg-glass-2 hover:text-gtext-primary"
            aria-label="关闭工作记录"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 scroll-thin">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-gtext-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在读取工作记录
            </div>
          ) : runs.length === 0 ? (
            <div className="grid place-items-center py-12 text-center">
              <History className="h-6 w-6 text-gtext-disabled" />
              <p className="mt-3 text-sm font-medium text-gtext-secondary">还没有工作记录</p>
              <p className="mt-1 text-[11px] text-gtext-muted">描述一个目标，编排出的计划会存在这里</p>
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => {
                const active = run.id === activeRunId;
                const percent = run.stepCount > 0 ? Math.round((run.completedStepCount / run.stepCount) * 100) : 0;
                return (
                  <div
                    key={run.id}
                    className={cn(
                      'group rounded-glass-lg border px-3 py-2.5 transition-all duration-200',
                      active ? 'border-glassline-brand bg-glass-2' : 'border-glassline bg-glass-1 hover:bg-glass-2',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(run)}
                      disabled={running && !active}
                      className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <p className="line-clamp-2 text-xs font-medium leading-5 text-gtext-primary">{run.objective}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className={cn('rounded-glass-pill border px-1.5 py-0.5 text-[10px]', STATUS_CHIP[run.status])}>
                          {STATUS_LABEL[run.status]}
                        </span>
                        <span className="text-[10px] tabular-nums text-gtext-muted">
                          {run.completedStepCount}/{run.stepCount} 步 · {percent}%
                        </span>
                        <span className="text-[10px] text-gtext-muted">
                          {new Date(run.createdAt).toLocaleDateString('zh-CN')}
                        </span>
                      </div>
                      {run.employeeNames.length > 0 && (
                        <p className="mt-1.5 truncate text-[10px] text-gtext-muted">
                          {run.employeeNames.join('、')}
                        </p>
                      )}
                    </button>

                    <div className="mt-1.5 flex justify-end opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => onDelete(run)}
                        disabled={run.status === 'running'}
                        title={run.status === 'running' ? '进行中的任务不能删除' : '删除这条记录'}
                        className="grid h-6 w-6 place-items-center rounded-glass-md text-gtext-muted transition-colors hover:bg-gdanger/12 hover:text-gdanger disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="删除工作记录"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {hasMore && onLoadMore && (
                <Button
                  type="button"
                  variant="glass"
                  className="w-full"
                  onClick={onLoadMore}
                  loading={loadingMore}
                  disabled={loadingMore}
                >
                  加载更多
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-glassline p-3">
          <Button variant="glass" className="w-full" onClick={onNew} disabled={running}>
            <Plus className="h-4 w-4" />
            新建
          </Button>
        </div>
      </aside>
    </div>
  );
}
