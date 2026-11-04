'use client';

import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import Link from 'next/link';
import {
  ArrowUpRight,
  Building2,
  Check,
  FileCode2,
  Inbox,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton, EmptyState } from '@/components/ui/feedback';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import {
  useAllCapabilities,
  useApproveCapability,
  useRejectCapability,
  useDeleteCapability,
  type AdminCapabilityRow,
} from '@/features/admin/use-admin';
import { useMonitorReview } from '../skills/use-skill-monitor';
import { CAPABILITY_TYPE_META, cn } from '@/lib/utils';
import { common } from '@/locales/zh-CN';

/**
 * 能力管理 —— 目录与审核合成一页。
 *
 * 这里合掉了原先的两个页面：
 *   · 「审核中心」能力 tab（`/admin/audit`）—— 它调的是公开端点 `/capabilities/:id/approve`，
 *     只改 `status` 不改 `platformReviewStatus`，审企业投稿会让投稿永远卡在队列里
 *   · 「能力审核」（`/admin/capability-review`）—— 只是个跳转列表，本身不做决定
 *
 * 技能全量版本从页头的技能监控入口查看；非技能投稿保留行内详情入口。
 *
 * 审核路径按来源分流，不是偷懒，是两条链路的语义不同：
 *   · 技能 → 技能监控选择精确版本发布，不走通用审核
 *   · 平台自有非技能能力（enterpriseId 为空）→ 行内通过/驳回
 *   · 非技能企业投稿 → 去投稿详情页审，那里能看到企业审核人、自动校验结果、版本正文，
 *     且走的是 `reviewPlatform`（企业快照版本也会一起推进）
 */

type StatusFilter = 'ALL' | 'APPROVED' | 'PENDING' | 'REJECTED';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'APPROVED', label: '已发布' },
  { key: 'PENDING', label: common.status.pendingReview },
  { key: 'REJECTED', label: '已拒绝' },
];

const STATUS_META: Record<string, { label: string; tone: string }> = {
  PENDING: { label: common.status.pendingReview, tone: 'border border-glassline bg-glass-2 text-gwarning' },
  APPROVED: { label: '已发布', tone: 'border border-glassline bg-glass-2 text-gsuccess' },
  REJECTED: { label: '已拒绝', tone: 'border border-glassline bg-glass-2 text-gdanger' },
};

/** 企业投稿走投稿详情页审核，平台自有能力行内审 */
function isContribution(cap: AdminCapabilityRow) {
  return Boolean(cap.enterpriseId) || cap.platformReviewStatus === 'PENDING_REVIEW';
}

export default function CapabilitiesPage() {
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [keyword, setKeyword] = useState('');
  const [rejecting, setRejecting] = useState<AdminCapabilityRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [deleting, setDeleting] = useState<AdminCapabilityRow | null>(null);
  const [approvingSkill, setApprovingSkill] = useState<AdminCapabilityRow | null>(null);

  const query = useAllCapabilities(status === 'ALL' ? undefined : status);
  const approve = useApproveCapability();
  const reject = useRejectCapability();
  const remove = useDeleteCapability();
  const reviewSkill = useMonitorReview();

  const visible = useMemo(() => {
    const items = query.data?.items ?? [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter(
      (cap) =>
        cap.name.toLowerCase().includes(kw) ||
        cap.description?.toLowerCase().includes(kw) ||
        cap.enterprise?.name.toLowerCase().includes(kw),
    );
  }, [query.data?.items, keyword]);

  const handleApprove = (cap: AdminCapabilityRow) => {
    approve.mutate(
      { id: cap.id },
      {
        onSuccess: () => toast.success(`能力「${cap.name}」已通过`, '已收录为平台公共能力，可绑定到硅基员工'),
        onError: (e) => toast.error(e instanceof Error ? e.message : '审核失败'),
      },
    );
  };

  const handleReject = () => {
    if (!rejecting || !rejectReason.trim()) return;
    reject.mutate(
      { id: rejecting.id, reason: rejectReason.trim() },
      {
        onSuccess: () => {
          toast.success(`能力「${rejecting.name}」已驳回`);
          setRejecting(null);
          setRejectReason('');
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : '驳回失败'),
      },
    );
  };

  const handleApproveSkill = async () => {
    if (!approvingSkill?.pendingPlatformVersion) return;
    try {
      await reviewSkill.mutateAsync({ id: approvingSkill.pendingPlatformVersion.id, decision: 'APPROVE' });
      toast.success(`技能「${approvingSkill.name}」已审核通过`, '当前待审版本已发布为平台版本');
      setApprovingSkill(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '审核失败');
    }
  };

  const handleDelete = () => {
    if (!deleting) return;
    remove.mutate(deleting.id, {
      onSuccess: () => {
        toast.success(`能力「${deleting.name}」已删除`);
        setDeleting(null);
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : '删除失败'),
    });
  };

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gbrand-text">
            <ShieldCheck className="h-4 w-4" /> Capability catalog
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-gtext-primary">能力管理</h1>
          <p className="mt-1 max-w-2xl text-sm text-gtext-muted">
            审核通过的能力会成为平台公共能力，可绑定到硅基员工 —— 用户在员工市场买到的是
            带着这些能力的员工，平台没有单独的能力市场。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin/skills"><Button variant="glass" size="sm"><FileCode2 className="h-4 w-4" />技能监控</Button></Link>
          <Link href="/admin/capabilities/new">
            <Button size="sm">+ 新建能力</Button>
          </Link>
        </div>
      </header>

      <Card variant="solid">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setStatus(key)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  status === key
                    ? 'bg-primary/10 text-primary'
                    : 'text-fg-muted hover:bg-muted/50 hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative w-full lg:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索能力名称、描述或来源企业"
              className="pl-9"
            />
          </div>
        </div>

        <CardContent className="overflow-x-auto p-0">
          {query.isLoading ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : query.isError ? (
            <div className="p-8">
              <EmptyState title="加载失败" description="无法获取能力列表，请稍后重试。" />
            </div>
          ) : visible.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={<Inbox className="h-8 w-8" />}
                title={keyword ? '没有匹配的能力' : '暂无能力'}
                description={keyword ? '换个关键词试试。' : '点击右上角「新建能力」开始接入。'}
              />
            </div>
          ) : (
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-fg-muted">
                  <th className="px-5 py-2 text-left font-medium">名称</th>
                  <th className="px-5 py-2 text-left font-medium">类型</th>
                  <th className="px-5 py-2 text-left font-medium">当前平台版本</th>
                  <th className="px-5 py-2 text-left font-medium">来源</th>
                  <th className="px-5 py-2 text-left font-medium">已绑定员工</th>
                  <th className="px-5 py-2 text-left font-medium">状态</th>
                  <th className="px-5 py-2 text-left font-medium">创建时间</th>
                  <th className="px-5 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((cap) => {
                  const typeMeta = CAPABILITY_TYPE_META[cap.type];
                  const statusMeta = STATUS_META[cap.status];
                  const contribution = isContribution(cap);
                  const pending = cap.status === 'PENDING';
                  const skill = cap.type === 'SKILL';
                  const monitorHref = `/admin/skills?capabilityId=${encodeURIComponent(cap.id)}&scope=PLATFORM`;

                  return (
                    <tr
                      key={cap.id}
                      className="border-b border-border transition-colors last:border-0 odd:bg-muted/20 hover:bg-muted/40"
                    >
                      <td className="max-w-[280px] px-5 py-3">
                        <p className="truncate font-medium">{cap.name}</p>
                        <p className="truncate text-xs text-fg-subtle">{cap.description}</p>
                      </td>
                      <td className="px-5 py-3">
                        <Badge className={typeMeta?.tone ?? ''}>{typeMeta?.label ?? cap.type}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3">
                        {skill ? (
                          cap.currentPlatformVersion ? (
                            <Link href={monitorHref} className="text-primary hover:underline">
                              v{cap.currentPlatformVersion.version}
                            </Link>
                          ) : (
                            <span className="text-fg-subtle">未发布</span>
                          )
                        ) : (
                          <span className="text-fg-subtle">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-fg-muted">
                        {cap.enterprise ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                            {cap.enterprise.name}
                          </span>
                        ) : (
                          '平台自有'
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <BoundEmployees cap={cap} />
                      </td>
                      <td className="px-5 py-3">
                        <Badge className={statusMeta?.tone ?? ''}>
                          {statusMeta?.label ?? cap.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-fg-muted">
                        {format(new Date(cap.createdAt), 'yyyy-MM-dd', { locale: zhCN })}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {skill && (
                            <Link href={monitorHref}>
                              <Button variant="ghost" size="sm">
                                <FileCode2 className="h-3.5 w-3.5" />
                                技能监控
                              </Button>
                            </Link>
                          )}
                          {pending && skill && !cap.enterpriseId && cap.pendingPlatformVersion && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={reviewSkill.isPending}
                              onClick={() => setApprovingSkill(cap)}
                            >
                              <Check className="mr-1 h-3.5 w-3.5" />
                              审核通过
                            </Button>
                          )}
                          {pending && !skill && contribution && (
                            <Link href={`/admin/contributions?selected=${encodeURIComponent(cap.id)}`}>
                              <Button variant="ghost" size="sm">
                                去审核
                                <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          )}
                          {pending && !skill && !contribution && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={approve.isPending}
                                onClick={() => handleApprove(cap)}
                              >
                                <Check className="mr-1 h-3.5 w-3.5" />
                                通过
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setRejecting(cap);
                                  setRejectReason('');
                                }}
                              >
                                <X className="mr-1 h-3.5 w-3.5" />
                                驳回
                              </Button>
                            </>
                          )}
                          {cap.status !== 'APPROVED' && (
                            <Button variant="ghost" size="sm" onClick={() => setDeleting(cap)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {visible.length > 0 && (
        <p className="text-xs text-fg-subtle">
          共 {query.data?.total ?? visible.length} 个能力
          {keyword && ` · 当前筛选出 ${visible.length} 个`}
        </p>
      )}

      <Dialog open={Boolean(rejecting)} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>驳回能力「{rejecting?.name}」</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">驳回原因会记录在能力上，提交人可以看到。</p>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="请说明驳回原因..."
              rows={4}
              className={!rejectReason.trim() ? 'border-gdanger/40' : ''}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={!rejectReason.trim() || reject.isPending}
              onClick={handleReject}
            >
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="删除能力"
        description={`确定删除「${deleting?.name}」？该操作不可恢复。已发布的能力无法删除。`}
        confirmText="删除"
        variant="danger"
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={Boolean(approvingSkill)}
        onOpenChange={(open) => !open && !reviewSkill.isPending && setApprovingSkill(null)}
        title="审核通过技能"
        description={approvingSkill
          ? `确认通过「${approvingSkill.name}」的待审平台版本 v${approvingSkill.pendingPlatformVersion?.version ?? '-'}？通过后会立即公开并供硅基员工使用。`
          : ''}
        confirmText="确认审核通过"
        loading={reviewSkill.isPending}
        onConfirm={handleApproveSkill}
      />
    </div>
  );
}
/**
 * 「已绑定员工」列。
 *
 * 这一列回答的是「我审这个能力有用吗」—— 平台没有能力市场页面，
 * 能力通过审核后的真实去处就是被硅基员工带着，用户在员工市场的
 * 「我能做什么」里看到的正是这些绑定。所以「已通过 + 0 绑定」
 * 是个需要运营看见的信号：审是审了，但还没人用上。
 */
function BoundEmployees({ cap }: { cap: AdminCapabilityRow }) {
  const total = cap._count?.bindings ?? 0;

  if (total === 0) {
    return (
      <span
        className={cn(
          'text-xs',
          cap.status === 'APPROVED' ? 'text-gwarning' : 'text-fg-subtle',
        )}
        title={
          cap.status === 'APPROVED'
            ? '已收录为公共能力，但还没有硅基员工带着它 —— 去员工的「能力绑定」里挂上才会被用户看到'
            : undefined
        }
      >
        {cap.status === 'APPROVED' ? '未绑定' : '—'}
      </span>
    );
  }

  const names = cap.bindings?.map((b) => b.employee) ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {names.slice(0, 2).map((emp) => (
        <Link
          key={emp.id}
          href={`/admin/employees/${emp.id}`}
          className="rounded border border-glassline bg-glass-2 px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:text-primary"
        >
          {emp.name}
        </Link>
      ))}
      {total > 2 && (
        <span className="text-xs text-fg-subtle" title={names.map((e) => e.name).join('、')}>
          等 {total} 位
        </span>
      )}
    </div>
  );
}
