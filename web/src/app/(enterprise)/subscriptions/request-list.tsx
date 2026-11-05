'use client';

import { Store } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import type { SubscriptionRequest } from '@/lib/types';
import { common } from '@/locales/zh-CN';

interface RequestListProps {
  requests: readonly SubscriptionRequest[];
  isLoading: boolean;
  busy: boolean;
  onApprove: (request: SubscriptionRequest) => void;
  onReject: (request: SubscriptionRequest) => void;
}

/**
 * 成员发起的「我想用某位硅基员工」申请。
 *
 * 这一栏保持卡片式而非表格：每条申请的主体是**申请理由**（一段自由文本），
 * 长短不一，塞进表格单元格只能截断 —— 而理由正是管理员据以决定通过与否的东西。
 * 主列表那边相反：那些行要跨行比数字，所以是表格。
 */
export function RequestList({
  requests,
  isLoading,
  busy,
  onApprove,
  onReject,
}: RequestListProps) {
  if (isLoading) return <CenteredSpinner label="加载中…" />;

  if (requests.length === 0) {
    return (
      <EmptyState
        icon={<Store className="h-8 w-8" />}
        title={`暂无${common.status.pendingApproval}申请`}
        description="当有成员申请使用硅基员工时，会显示在这里"
      />
    );
  }

  return (
    <div className="space-y-4">
      {requests.map((req) => (
        <div key={req.id} className="rounded-xl border border-border bg-background p-5">
          <div className="flex items-start gap-4">
            <Avatar
              name={req.employee.name}
              src={req.employee.avatar}
              portrait
              className="h-14 w-14 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-foreground">{req.employee.name}</p>
                  <p className="mt-0.5 text-sm text-fg-muted">
                    申请人：{req.requesterName ?? req.requesterEmail ?? '未知'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* 免费 / 付费必须在通过之前就看得见：GRANT 只是开权限，
                      SUBSCRIBE 会真的从企业钱包扣一笔年费 */}
                  <Badge
                    className={
                      req.kind === 'GRANT'
                        ? 'bg-success/10 text-success'
                        : 'bg-primary/10 text-primary'
                    }
                  >
                    {req.kind === 'GRANT' ? '仅授权（免费）' : '新雇佣（付费）'}
                  </Badge>
                  <Badge className={req.status === 'PENDING' ? 'bg-warning/10 text-warning' : req.status === 'APPROVED' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}>{req.status === 'PENDING' ? common.status.pendingApproval : req.status === 'APPROVED' ? '已通过' : req.status === 'REJECTED' ? '已拒绝' : '已取消'}</Badge>
                </div>
              </div>
              {req.reason && (
                <div className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <p className="text-xs font-medium text-fg-muted">使用场景</p>
                  <p className="mt-1 text-sm leading-relaxed text-foreground">{req.reason}</p>
                </div>
              )}
              {req.requestedDays && (
                <p className="mt-2 text-xs text-fg-muted">
                  期望使用时长：{req.requestedDays} 天
                </p>
              )}
              <p className="mt-1 text-xs text-fg-subtle">
                申请时间：{new Date(req.createdAt).toLocaleString('zh-CN')}
              </p>
              {req.status === 'PENDING' && <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => onApprove(req)} disabled={busy}>
                  通过
                </Button>
                <Button variant="outline" size="sm" onClick={() => onReject(req)} disabled={busy}>
                  拒绝
                </Button>
              </div>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
