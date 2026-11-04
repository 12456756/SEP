'use client';

import { useMemo, useState } from 'react';
import { Check, KeyRound, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { EnterpriseMember, MemberGrantStatus } from '@/lib/types';
import {
  useCreateMemberEmployeeGrants,
  useDeleteGrant,
  useMemberEmployeeGrants,
} from '@/features/enterprise/use-enterprise';

interface Props {
  member: EnterpriseMember;
  onClose: () => void;
}

const PAGE_SIZE = 20;

function formatLocalDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusLabel(status: string) {
  if (status === 'ACTIVE') return '使用中';
  if (status === 'PAUSED') return '已暂停';
  if (status === 'TERMINATED') return '已解聘';
  return '已结束';
}

export function MemberEmployeeGrantPanel({ member, onClose }: Props) {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<MemberGrantStatus>('grantable');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState('');
  const [renewExpired, setRenewExpired] = useState(false);

  const query = useMemberEmployeeGrants(member.id, {
    keyword: keyword.trim() || undefined,
    status,
    page,
    pageSize: PAGE_SIZE,
  });
  const create = useCreateMemberEmployeeGrants();
  const remove = useDeleteGrant();
  const items = query.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE_SIZE));
  const selectableIds = items
    .filter((item) => item.status !== 'EXPIRED' && item.status !== 'TERMINATED')
    .map((item) => item.subscriptionId);
  const allPageSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.subscriptionId)),
    [items, selected],
  );

  const toggle = (subscriptionId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(subscriptionId)) next.delete(subscriptionId);
      else next.add(subscriptionId);
      return next;
    });
  };

  const togglePage = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allPageSelected) selectableIds.forEach((id) => next.delete(id));
      else selectableIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const submit = () => {
    const subscriptionIds = [...selected];
    if (!subscriptionIds.length) return;
    create.mutate(
      {
        memberId: member.id,
        subscriptionIds,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        renewExpired,
      },
      {
        onSuccess: (result) => {
          toast.success(`新增 ${result.createdIds.length} 位，续期 ${result.renewedSubscriptionIds.length} 位，跳过 ${result.skippedSubscriptionIds.length} 位`);
          setSelected(new Set());
          setExpiresAt('');
          setRenewExpired(false);
          query.refetch();
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : '授权失败'),
      },
    );
  };

  const revoke = (item: (typeof items)[number]) => {
    if (!item.directGrant) return;
    const name = item.name || item.employee.name;
    if (!window.confirm(`确定收回「${name}」给该成员的直接授权吗？如果部门仍有授权，成员仍可继续使用。`)) return;
    remove.mutate(
      { grantId: item.directGrant.id, subscriptionId: item.subscriptionId },
      {
        onSuccess: () => {
          toast.success(`已收回「${name}」`);
          query.refetch();
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : '收回失败'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !create.isPending && !remove.isPending) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12 text-left">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <DialogTitle className="text-base">授权硅基员工</DialogTitle>
          </div>
          <DialogDescription>
            为 {member.user.name || member.user.email} 选择企业已雇佣的硅基员工。部门授权不会被改动。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 border-b border-border px-5 py-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
              <Input
                aria-label="搜索硅基员工"
                placeholder="搜索名称、岗位"
                value={keyword}
                onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
                className="pl-9"
              />
            </div>
            <select
              aria-label="授权状态"
              value={status}
              onChange={(event) => { setStatus(event.target.value as MemberGrantStatus); setPage(1); }}
              className="h-10 rounded-md border border-border bg-background px-3 text-sm"
            >
              <option value="grantable">可授权</option>
              <option value="granted">已授权</option>
              <option value="all">全部</option>
              <option value="history">历史</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-fg-muted">已选择 {selected.size} 位硅基员工</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={togglePage}
              disabled={!selectableIds.length || create.isPending}
              aria-pressed={allPageSelected}
            >
              {allPageSelected ? '取消全选本页' : '全选本页'}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {query.isLoading ? (
            <div className="py-12 text-center text-sm text-fg-muted">加载中…</div>
          ) : query.isError ? (
            <div className="py-12 text-center text-sm text-danger">加载授权候选失败</div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-sm text-fg-muted">没有匹配的硅基员工</div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {items.map((item) => {
                const isHistory = item.status === 'EXPIRED' || item.status === 'TERMINATED';
                const checked = selected.has(item.subscriptionId);
                return (
                  <div key={item.subscriptionId} className={`flex items-center gap-3 px-3 py-3 ${checked ? 'bg-primary/5' : ''}`}>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(item.subscriptionId)}
                      disabled={isHistory || create.isPending}
                      aria-label={`选择 ${item.name}`}
                    />
                    <Avatar name={item.name} src={item.employee.avatar} className="h-9 w-9 shrink-0 text-xs" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        <Badge className="text-[11px]">{statusLabel(item.status)}</Badge>
                        {item.coveredByDepartment && <Badge className="border-success/30 bg-success/10 text-success"><ShieldCheck className="mr-1 h-3 w-3" />部门覆盖</Badge>}
                      </div>
                      <p className="truncate text-xs text-fg-muted">{item.employee.position} · {item.employee.name}</p>
                      {item.directGrant && (
                        <p className="text-xs text-primary">
                          {item.directGrant.expired ? '直接授权已过期' : item.directGrant.expiresAt ? `直接授权至 ${new Date(item.directGrant.expiresAt).toLocaleDateString('zh-CN')}` : '直接授权 · 长期有效'}
                        </p>
                      )}
                    </div>
                    {item.directGrant && (
                      <Button type="button" size="icon" variant="ghost" title="收回直接授权" aria-label={`收回 ${item.name} 的直接授权`} onClick={() => revoke(item)} disabled={remove.isPending}>
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    )}
                    {!item.directGrant && !isHistory && checked && <Check className="h-4 w-4 text-primary" />}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-border px-5 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
            <label className="flex items-center gap-2">
              <span>有效期</span>
              <select value={expiresAt ? 'custom' : 'forever'} onChange={(event) => setExpiresAt(event.target.value === 'forever' ? '' : expiresAt || formatLocalDateTime(new Date(Date.now() + 30 * 86400000)))} className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground">
                <option value="forever">长期有效</option>
                <option value="custom">设置到期日期</option>
              </select>
            </label>
            {expiresAt && <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="h-8 w-52" />}
            {items.some((item) => item.directGrant?.expired && selected.has(item.subscriptionId)) && (
              <label className="flex items-center gap-2 text-foreground">
                <Checkbox checked={renewExpired} onCheckedChange={(value) => setRenewExpired(value === true)} />
                续期已过期授权
              </label>
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-fg-muted">第 {page} / {totalPages} 页</div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>上一页</Button>
              <Button variant="ghost" size="sm" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>下一页</Button>
              <Button size="sm" onClick={submit} disabled={!selected.size || create.isPending} loading={create.isPending} loadingText="提交中…">
                授权 {selected.size || ''} 位
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
