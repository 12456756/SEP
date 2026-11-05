'use client';

import { useState } from 'react';
import { X, Clock, Inbox, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { SubscriptionRequest } from '@/lib/types';
import {
  useMySubscriptionRequests,
  useCancelSubscriptionRequest,
} from './use-subscription-requests';
import { Z_CLASS } from '@/lib/z-index';
import { common } from '@/locales/zh-CN';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const STATUS_META: Record<SubscriptionRequest['status'], { label: string; tone: string }> = {
  PENDING: { label: common.status.pendingApproval, tone: 'bg-warning/10 text-warning' },
  APPROVED: { label: '已通过', tone: 'bg-success/10 text-success' },
  REJECTED: { label: '已拒绝', tone: 'bg-danger/10 text-danger' },
  CANCELED: { label: '已取消', tone: 'bg-muted text-fg-muted' },
};

/**
 * 普通成员的「我的申请」弹窗：查看自己发起的员工使用申请与审批状态，
 * 待审批（企业内部审批流）的可以撤回。挂在人才市场页，因为申请就是从那里发起的。
 */
export function MyRequestsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<'ALL' | SubscriptionRequest['status']>('ALL');
  const [keyword, setKeyword] = useState('');
  const { data: requests = [], isLoading } = useMySubscriptionRequests({ status: status === 'ALL' ? undefined : status, keyword });
  const cancelRequest = useCancelSubscriptionRequest();

  if (!open) return null;

  const pendingCount = requests.filter((r) => r.status === 'PENDING').length;

  return (
    <>
      {/* backdrop */}
      <div
        aria-hidden="true"
        className={cn('fixed inset-0 bg-black/50 backdrop-blur-sm', Z_CLASS.dialog)}
        onClick={onClose}
      />

      {/* modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="我的申请"
        className={cn(
          'fixed left-1/2 top-1/2 flex max-h-[80vh] w-full max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-glass-2xl border border-glassline bg-glass-1 shadow-glass-xl backdrop-blur-glass-xl',
          Z_CLASS.dialog
        )}
      >
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-glassline px-6 py-4">
          <h2 className="text-lg font-semibold text-gtext-primary">我的申请</h2>
          <button
            onClick={onClose}
            className="rounded-glass-md p-1.5 text-gtext-muted transition-colors hover:bg-glass-2 hover:text-gtext-primary"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mb-4 flex flex-wrap gap-2"><div className="relative min-w-[200px] flex-1"><Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索员工名称" /></div><Select value={status} onValueChange={(value: typeof status) => setStatus(value)}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部状态</SelectItem><SelectItem value="PENDING">待审批</SelectItem><SelectItem value="APPROVED">已通过</SelectItem><SelectItem value="REJECTED">已拒绝</SelectItem><SelectItem value="CANCELED">已取消</SelectItem></SelectContent></Select></div>
          {isLoading ? (
            <p className="py-10 text-center text-[13px] text-gtext-muted">加载中…</p>
          ) : requests.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Inbox className="h-8 w-8 text-gtext-muted" />
              <p className="text-[13px] text-gtext-muted">还没有申请记录</p>
              <p className="text-[12px] text-gtext-muted">
                在人才市场选择员工后，点「申请使用」即可发起
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {requests.map((req) => {
                const meta = STATUS_META[req.status];
                return (
                  <li
                    key={req.id}
                    className="rounded-glass-lg border border-glassline bg-glass-2 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <Avatar
                        name={req.employee.name}
                        src={req.employee.avatar ?? null}
              portrait
                        className="h-10 w-10 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium text-gtext-primary">
                            {req.employee.name}
                          </p>
                          <span
                            className={cn(
                              'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                              meta.tone,
                            )}
                          >
                            {meta.label}
                          </span>
                          {req.kind === 'GRANT' ? (
                            <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[11px] text-success">
                              授权
                            </span>
                          ) : (
                            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                              订阅
                            </span>
                          )}
                        </div>

                        {req.reason && (
                          <p className="mt-1.5 text-[13px] leading-relaxed text-gtext-secondary">
                            {req.reason}
                          </p>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gtext-muted">
                          {req.requestedDays && <span>期望 {req.requestedDays} 天</span>}
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(req.createdAt).toLocaleDateString('zh-CN')}
                          </span>
                        </div>

                        {req.status === 'REJECTED' && req.reviewNote && (
                          <p className="mt-2 rounded-md bg-danger/5 px-2 py-1.5 text-[12px] text-danger">
                            拒绝原因：{req.reviewNote}
                          </p>
                        )}
                        {req.status === 'APPROVED' && req.reviewNote && (
                          <p className="mt-2 rounded-md bg-success/5 px-2 py-1.5 text-[12px] text-success">
                            审批备注：{req.reviewNote}
                          </p>
                        )}
                      </div>

                      {req.status === 'PENDING' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0 self-start text-gtext-muted hover:text-danger"
                          disabled={cancelRequest.isPending}
                          onClick={() =>
                            cancelRequest.mutate(req.id, {
                              onSuccess: () => toast.success('已撤回申请'),
                              onError: (e) =>
                                toast.error(e instanceof ApiError ? e.message : '撤回失败'),
                            })
                          }
                        >
                          撤回
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* footer */}
        <div className="flex shrink-0 justify-between gap-3 border-t border-glassline px-6 py-3.5">
          <p className="text-[12px] text-gtext-muted">
            {pendingCount > 0 ? `${pendingCount} 条${common.status.pendingApproval}` : `暂无${common.status.pendingApproval}`}
          </p>
          <Button variant="glass" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </>
  );
}
