'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, Store } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/lib/auth-store';
import { ApiError } from '@/lib/api-client';
import {
  useSubscriptions,
  useTerminateSubscription,
  useUpdateSubscription,
  useChangeSubscriptionStatus,
  useUpgradeSubscription,
} from '@/features/subscription/use-subscriptions';
import {
  useAllSubscriptionRequests,
  useApproveSubscriptionRequest,
  useRejectSubscriptionRequest,
} from '@/features/subscription-request/use-subscription-requests';
import { GrantPanel } from '@/features/enterprise/grant-panel';
import { buildEmploymentRow } from '@/features/subscription/employment-row';
import { SUBSCRIPTION_STATUS_META } from '@/lib/utils';
import { employment } from '@/locales/zh-CN';
import type { Subscription, SubscriptionRequest } from '@/lib/types';
import { getExpectedRefund } from '@/features/subscription/release-policy';
import { SubscriptionStats } from '@/features/subscription/subscription-stats';
import { EmploymentTable } from './employment-table';
import { RequestList } from './request-list';
import { Modal } from './modal';

type TopTab = 'employments' | 'dismissed' | 'requests';

/**
 * 雇佣管理。
 *
 * 与「我的硅基员工」的分工：那一页是**使用者视角**的门户（我能用谁、去跟谁对话），
 * 这一页是**管理台**（谁被授权了、谁白雇着、要不要收回）。两页同时用卡片网格时
 * 长得几乎一样，用户会以为是同一个功能的两个入口 —— 所以这里改成表格：
 * 管理判断靠跨行比较（哪一行的在用人数是 0），卡片网格恰恰不支持这件事。
 */
export default function SubscriptionsPage() {
  const { roleInEnterprise } = useAuthStore();
  const isAdmin = roleInEnterprise === 'ENTERPRISE_ADMIN';

  const [topTab, setTopTab] = useState<TopTab>('employments');
  const [keyword, setKeyword] = useState('');
  const [requestStatus, setRequestStatus] = useState<SubscriptionRequest['status']>('PENDING');
  const [requestKeyword, setRequestKeyword] = useState('');

  const { data: subs = [], isLoading } = useSubscriptions();
  const { data: pendingRequests = [], isLoading: loadingRequests } = useAllSubscriptionRequests(requestStatus, requestKeyword);
  const terminate = useTerminateSubscription();
  const updateSub = useUpdateSubscription();
  const changeStatus = useChangeSubscriptionStatus();
  const upgradeSub = useUpgradeSubscription();
  const approveRequest = useApproveSubscriptionRequest();
  const rejectRequest = useRejectSubscriptionRequest();

  const [releasing, setReleasing] = useState<Subscription | null>(null);
  const [renaming, setRenaming] = useState<Subscription | null>(null);
  const [granting, setGranting] = useState<Subscription | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [approving, setApproving] = useState<SubscriptionRequest | null>(null);
  const [rejecting, setRejecting] = useState<SubscriptionRequest | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [approvedDays, setApprovedDays] = useState<number | undefined>(undefined);

  const allRows = useMemo(() => subs.map(buildEmploymentRow), [subs]);
  const currentCount = allRows.filter((row) => !row.dismissed).length;
  const dismissedCount = allRows.length - currentCount;
  const rows = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return allRows.filter((row) => {
      if (row.dismissed !== (topTab === 'dismissed')) return false;
      if (!query) return true;
      const sub = row.subscription;
      return (
        sub.name.toLowerCase().includes(query) ||
        sub.employee.name.toLowerCase().includes(query) ||
        sub.employee.position.toLowerCase().includes(query)
      );
    });
  }, [allRows, keyword, topTab]);

  const busy =
    terminate.isPending || changeStatus.isPending || upgradeSub.isPending;

  const expectedRefund = releasing
    ? getExpectedRefund(releasing)
    : 0;

  const handleRelease = () => {
    if (!releasing) return;
    const name = releasing.employee.name;
    terminate.mutate(releasing.id, {
      onSuccess: (result) => {
        toast.success(
          result.refunded
            ? `已解除「${name}」，¥${Number(result.refundAmount ?? 0).toFixed(2)} 已退回企业钱包`
            : `已解除「${name}」，本次不退款`,
        );
        setReleasing(null);
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : '解除失败'),
    });
  };

  const setStatus = (sub: Subscription, status: 'ACTIVE' | 'PAUSED') => {
    changeStatus.mutate(
      { id: sub.id, status },
      {
        onSuccess: (r) =>
          toast.success(
            r.changed
              ? `「${sub.name}」已${SUBSCRIPTION_STATUS_META[status].label}`
              : '状态未变化',
          ),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : '操作失败'),
      },
    );
  };

  const handleRename = () => {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    updateSub.mutate(
      // 清空即恢复展示模板名，后端把 null 当作「取消自定义」
      { id: renaming.id, name: trimmed || null },
      {
        onSuccess: () => {
          toast.success('已更新称呼');
          setRenaming(null);
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : '更新失败'),
      },
    );
  };

  const handleUpgrade = (sub: Subscription) => {
    upgradeSub.mutate(sub.id, {
      onSuccess: (r) =>
        toast.success(
          `已从 v${r.from} 升级到 v${r.to}` +
            (r.configReviewRequired ? '，请复核配置（未自动迁移）' : ''),
        ),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : '升级失败'),
    });
  };

  const handleApprove = () => {
    if (!approving) return;
    approveRequest.mutate(
      {
        id: approving.id,
        dto: { reviewNote: reviewNote.trim() || undefined, approvedDays },
      },
      {
        onSuccess: () => {
          toast.success(`已通过「${approving.employee.name}」的使用申请`);
          setApproving(null);
          setReviewNote('');
          setApprovedDays(undefined);
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : '审批失败'),
      },
    );
  };

  const handleReject = () => {
    if (!rejecting) return;
    const note = reviewNote.trim();
    if (!note) {
      toast.error('拒绝时必须填写原因');
      return;
    }
    rejectRequest.mutate(
      { id: rejecting.id, dto: { reviewNote: note } },
      {
        onSuccess: () => {
          toast.success(`已拒绝「${rejecting.employee.name}」的使用申请`);
          setRejecting(null);
          setReviewNote('');
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : '拒绝失败'),
      },
    );
  };

  if (isLoading) return <SubscriptionsSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{employment.section}</h1>
          <p className="mt-1 text-sm text-fg-muted">{employment.description}</p>
        </div>
        <Link href="/marketplace">
          <Button size="sm">
            <Store className="h-4 w-4" />
            前往人才市场
          </Button>
        </Link>
      </div>

      {subs.length > 0 && <SubscriptionStats subscriptions={subs} />}

      <div className="flex gap-2 border-b border-border" aria-label="雇佣管理分类">
        <TabButton
          active={topTab === 'employments'}
          onClick={() => setTopTab('employments')}
          label="雇佣中"
          count={currentCount}
          showZeroCount
        />
        <TabButton
          active={topTab === 'dismissed'}
          onClick={() => setTopTab('dismissed')}
          label="已解聘"
          count={dismissedCount}
          showZeroCount
        />
        {isAdmin && (
          <TabButton
            active={topTab === 'requests'}
            onClick={() => setTopTab('requests')}
            label="使用申请"
            count={pendingRequests.length}
            highlightCount
          />
        )}
      </div>

      {topTab !== 'requests' ? (
        <>
          {subs.length === 0 && topTab === 'employments' ? (
            <EmptyState
              icon={<Store className="h-8 w-8" />}
              title="还没有雇佣关系"
              description="前往硅基人才市场招聘你的第一位硅基员工，雇佣后在这里把 TA 授权给部门或成员。"
              action={
                <Link href="/marketplace">
                  <Button size="sm">前往硅基人才市场</Button>
                </Link>
              }
            />
          ) : (
            <>
              <div className="relative max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
                <Input
                  aria-label="搜索雇佣关系"
                  placeholder="搜索称呼、模板名或岗位"
                  className="h-10 pl-10 shadow-sm transition-shadow focus:shadow-md"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>

              {rows.length === 0 ? (
                <EmptyState
                  icon={<Search className="h-8 w-8" />}
                  title={
                    keyword.trim()
                      ? '没有匹配的雇佣关系'
                      : topTab === 'dismissed'
                        ? '暂无已解聘员工'
                        : '暂无雇佣中的员工'
                  }
                  description={
                    keyword.trim()
                      ? '当前分类下没有匹配结果，试试清空搜索或切换分类。'
                      : topTab === 'dismissed'
                        ? '已解除的雇佣关系会保留在这里，方便查阅。'
                        : '历史雇佣关系可在「已解聘」中查看，也可以前往人才市场雇佣员工。'
                  }
                  action={keyword.trim() ? (
                    <Button size="sm" onClick={() => setKeyword('')}>
                      清空搜索
                    </Button>
                  ) : topTab === 'employments' ? (
                    <Link href="/marketplace">
                      <Button size="sm">前往硅基人才市场</Button>
                    </Link>
                  ) : undefined}
                />
              ) : (
                <EmploymentTable
                  rows={rows}
                  isAdmin={isAdmin}
                  busy={busy}
                  onGrant={setGranting}
                  onRename={(sub) => {
                    setRenaming(sub);
                    // 与模板同名说明没自定义过，输入框留空更好改
                    setRenameValue(sub.name === sub.employee.name ? '' : sub.name);
                  }}
                  onRelease={setReleasing}
                  onUpgrade={handleUpgrade}
                  onChangeStatus={setStatus}
                />
              )}
            </>
          )}
        </>
      ) : (
        <div className="space-y-4"><div className="flex flex-wrap gap-2"><Input value={requestKeyword} onChange={(e) => setRequestKeyword(e.target.value)} placeholder="搜索员工名称" className="max-w-sm" />{(['PENDING', 'APPROVED', 'REJECTED', 'CANCELED'] as const).map((status) => <Button key={status} variant={requestStatus === status ? 'primary' : 'outline'} size="sm" onClick={() => setRequestStatus(status)}>{status === 'PENDING' ? '待审批' : status === 'APPROVED' ? '已通过' : status === 'REJECTED' ? '已拒绝' : '已取消'}</Button>)}</div><RequestList
          requests={pendingRequests}
          isLoading={loadingRequests}
          busy={approveRequest.isPending || rejectRequest.isPending}
          onApprove={setApproving}
          onReject={setRejecting}
        /></div>
      )}

      {releasing && (
        <Modal title={employment.release} onClose={() => setReleasing(null)}>
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-fg-muted">
              {employment.releaseConfirm(releasing.employee.name, expectedRefund)}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setReleasing(null)}>
                我再想想
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleRelease}
                disabled={terminate.isPending}
              >
                确认解除
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {renaming && (
        <Modal title={`改称呼 · ${renaming.employee.name}`} onClose={() => setRenaming(null)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium">企业内称呼</label>
              <Input
                placeholder={renaming.employee.name}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
              <p className="mt-1 text-xs text-fg-subtle">
                留空则显示模板名「{renaming.employee.name}」。
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                取消
              </Button>
              <Button size="sm" onClick={handleRename} disabled={updateSub.isPending}>
                保存
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {granting && <GrantPanel subscription={granting} onClose={() => setGranting(null)} />}

      {approving && (
        <Modal
          title={`通过使用申请 · ${approving.employee.name}`}
          onClose={() => {
            setApproving(null);
            setReviewNote('');
            setApprovedDays(undefined);
          }}
        >
          <div className="space-y-4">
            <div
              className={cn(
                'rounded-lg border px-3 py-2 text-sm',
                approving.kind === 'GRANT'
                  ? 'border-success/30 bg-success/5 text-success'
                  : 'border-primary/30 bg-primary/5 text-primary',
              )}
            >
              {approving.kind === 'GRANT'
                ? '企业已雇佣该员工，通过后直接开通使用权限，不产生费用。'
                : '企业尚未雇佣该员工，通过后将完成雇佣（付费）并开通使用权限。'}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium">
                审批备注 <span className="text-fg-subtle">(可选)</span>
              </label>
              <textarea
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="可选：记录审批原因或备注"
                className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm placeholder:text-fg-muted focus:border-primary focus:outline-none"
                rows={3}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium">
                使用时长 <span className="text-fg-subtle">(可选)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: '永久', value: undefined },
                  { label: '30 天', value: 30 },
                  { label: '90 天', value: 90 },
                  { label: '180 天', value: 180 },
                  { label: '365 天', value: 365 },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => setApprovedDays(opt.value)}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                      approvedDays === opt.value
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-muted/30 text-fg-muted hover:bg-muted',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-fg-subtle">
                不选择则使用申请人期望的时长（{approving.requestedDays ?? '永久'}）
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setApproving(null);
                  setReviewNote('');
                  setApprovedDays(undefined);
                }}
              >
                取消
              </Button>
              <Button size="sm" onClick={handleApprove} disabled={approveRequest.isPending}>
                确认通过
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {rejecting && (
        <Modal
          title={`拒绝使用申请 · ${rejecting.employee.name}`}
          onClose={() => {
            setRejecting(null);
            setReviewNote('');
          }}
        >
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-danger">
                拒绝原因 <span className="text-fg-subtle">(必填)</span>
              </label>
              <textarea
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="请说明拒绝原因，申请人将看到此信息"
                className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm placeholder:text-fg-muted focus:border-danger focus:outline-none"
                rows={4}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRejecting(null);
                  setReviewNote('');
                }}
              >
                取消
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleReject}
                disabled={!reviewNote.trim() || rejectRequest.isPending}
              >
                确认拒绝
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  highlightCount = false,
  showZeroCount = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  highlightCount?: boolean;
  showZeroCount?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'relative px-4 py-2 text-sm font-medium transition-colors',
        active ? 'text-primary' : 'text-fg-muted hover:text-foreground',
      )}
    >
      {label}
      {(count > 0 || showZeroCount) && (
        <Badge
          className={cn(
            'ml-1.5',
            highlightCount ? 'bg-warning/10 text-warning' : 'bg-muted text-fg-muted',
          )}
        >
          {count}
        </Badge>
      )}
      {active && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
    </button>
  );
}

function SubscriptionsSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header skeleton */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-8 w-32 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-64 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="h-9 w-32 animate-pulse rounded-md bg-muted" />
      </div>

      {/* Stats skeleton */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-lg border border-border bg-muted/30"
          />
        ))}
      </div>

      {/* Search bar skeleton */}
      <div className="flex items-center gap-4">
        <div className="h-10 flex-1 max-w-md animate-pulse rounded-md bg-muted" />
      </div>

      {/* Table skeleton */}
      <div className="space-y-3 rounded-lg border border-border bg-background p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-8 w-20 animate-pulse rounded bg-muted" />
            <div className="h-8 w-24 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
