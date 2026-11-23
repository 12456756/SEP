'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, Loader2, Search, SlidersHorizontal, Users, WalletCards, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCny, formatCnyPrecise, useMemberAllowances, type MemberAllowanceItem } from '@/lib/api/use-compute-credit';
import { AllocateComputeDialog } from './allocate-compute-dialog';
import { TopUpComputeDialog } from './top-up-compute-dialog';

function barColor(value: number) {
  if (value <= 20) return 'bg-red-500';
  if (value <= 40) return 'bg-amber-400';
  return 'bg-emerald-500';
}

function textColor(value: number) {
  if (value <= 20) return 'text-red-600';
  if (value <= 40) return 'text-amber-600';
  return 'text-emerald-600';
}

function shortDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${date.getMonth() + 1}月${date.getDate()}日`;
}

function remainingPercent(remaining: string | null | undefined, limit: string | null | undefined) {
  const left = Number(remaining);
  const total = Number(limit);
  if (!limit || !Number.isFinite(left) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (left / total) * 100));
}

function ProgressBar({ value, sky = false }: { value: number; sky?: boolean }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100" aria-hidden="true">
      <div className={`h-full rounded-full transition-[width] duration-500 ${sky ? 'bg-sky-500' : barColor(value)}`} style={{ width: `${value}%` }} />
    </div>
  );
}

function LimitMetric({ label, used, limit, remaining, resetText }: { label: string; used?: string | null; limit?: string | null; remaining?: string | null; resetText: string }) {
  const percentage = remainingPercent(remaining, limit);
  if (!limit || percentage === null) {
    return <div><p className="text-xs font-medium text-neutral-500">{label}</p><p className="mt-1 text-sm text-neutral-400">未设置</p></div>;
  }
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-neutral-500">{label}</p>
        <p className={`text-xs font-semibold tabular-nums ${textColor(percentage)}`}>剩余 {formatCnyPrecise(remaining)}</p>
      </div>
      <p className="mt-1 text-sm font-semibold tabular-nums text-neutral-800">{formatCnyPrecise(used)} <span className="font-normal text-neutral-400">/ {formatCny(limit)}</span></p>
      <div className="mt-2"><ProgressBar value={percentage} /></div>
      <p className="mt-1.5 text-[11px] text-neutral-400">{resetText}</p>
    </div>
  );
}

function MemberRow({ member }: { member: MemberAllowanceItem }) {
  const monthlyLimit = member.monthlyLimitCNY ?? (member.monthlyLimitCNY === null && member.limitCNY !== null ? member.limitCNY : null);
  const monthlyRemaining = member.monthlyRemainingCNY ?? (monthlyLimit ? member.remainingCNY : null);
  const monthlyUsed = member.monthlyUsedCNY ?? (monthlyLimit ? member.usedCNY : null);
  const monthlyPct = remainingPercent(monthlyRemaining, monthlyLimit);
  const dailyPct = remainingPercent(member.dailyRemainingCNY, member.dailyLimitCNY);
  const capped = (monthlyPct !== null && monthlyPct <= 0) || (dailyPct !== null && dailyPct <= 0 && !member.dailyBypassActive);
  const topUpAmount = Number(member.topUpAmountCNY ?? member.topUpRemainingCNY);
  const topUpRemaining = Number(member.topUpRemainingCNY);
  const topUpPct = topUpAmount > 0 ? Math.max(0, Math.min(100, topUpRemaining / topUpAmount * 100)) : 0;
  const hasLimit = member.limitCNY !== null || member.dailyLimitCNY || member.monthlyLimitCNY;

  return (
    <div className="grid gap-6 border-t border-neutral-200/80 px-5 py-5 first:border-t-0 lg:grid-cols-[minmax(180px,0.8fr)_minmax(300px,1.25fr)_minmax(360px,1.65fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fuchsia-50 text-sm font-semibold text-fuchsia-600">{member.name.slice(0, 1)}</div>
          <div className="min-w-0"><p className="truncate text-[15px] font-semibold text-neutral-900">{member.name}</p><p className="mt-1 truncate text-xs text-neutral-500">{member.departmentName || (hasLimit ? '已设置限额' : '未设置限额')}</p></div>
        </div>
        {capped && <span className="mt-3 inline-flex rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600">企业额度已用完 · 转自付</span>}
      </div>

      <div className="min-w-0 border-l-2 border-sky-400 pl-4">
        <div className="flex items-end justify-between gap-3"><div><p className="text-xs font-medium text-sky-700">企业充值余额</p><p className="mt-1 text-lg font-semibold tabular-nums text-neutral-900">{formatCnyPrecise(member.topUpRemainingCNY)}<span className="ml-1 text-xs font-normal text-neutral-400">可用</span></p></div><p className="text-xs tabular-nums text-neutral-500">已充值 {formatCny(member.topUpAmountCNY ?? member.topUpRemainingCNY)}</p></div>
        <div className="mt-2.5"><ProgressBar value={topUpPct} sky /></div><p className="mt-1.5 text-[11px] text-neutral-400">跨周期保留，充值时已从企业钱包扣款</p>
      </div>

      <div className="min-w-0"><div className="mb-2 flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.08em] text-neutral-500">消费限额</p>{member.dailyBypassActive && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">今日已临时放开</span>}</div><div className="grid gap-5 sm:grid-cols-2 sm:divide-x sm:divide-neutral-200 sm:[&>*:nth-child(2)]:pl-5"><LimitMetric label="本月" used={monthlyUsed} limit={monthlyLimit} remaining={monthlyRemaining} resetText={`${shortDate(member.resetAt)}重置${member.carryOver ? ' · 未用完可结转' : ''}`} /><LimitMetric label="今日" used={member.dailyUsedCNY} limit={member.dailyLimitCNY} remaining={member.dailyRemainingCNY} resetText={member.dailyBypassActive ? '临时放开中，月度限额仍有效' : '每日 00:00 重置'} /></div></div>

      <div className="flex items-center gap-2 border-t border-neutral-100 pt-4 lg:border-t-0 lg:pt-0"><TopUpComputeDialog member={member} trigger={<Button size="sm" variant="secondary"><WalletCards className="h-4 w-4" />充值余额</Button>} /><AllocateComputeDialog member={member} trigger={<Button size="sm" variant="outline"><SlidersHorizontal className="h-4 w-4" />设置限额</Button>} /></div>
    </div>
  );
}

export function MemberAllowancePanel() {
  const { data: members, isLoading, isError, error, refetch } = useMemberAllowances();
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const list = members ?? [];
  const query = search.trim().toLowerCase();
  const filteredMembers = query
    ? list.filter((member) => [member.name, member.email, member.departmentName].some((value) => value?.toLowerCase().includes(query)))
    : list;
  const allocated = list.filter((member) => member.limitCNY !== null || member.dailyLimitCNY || member.monthlyLimitCNY).length;
  const capped = list.filter((member) => (member.monthlyRemainingCNY !== null && Number(member.monthlyRemainingCNY) <= 0) || (member.dailyRemainingCNY !== null && Number(member.dailyRemainingCNY) <= 0 && !member.dailyBypassActive) || (member.usedPct !== null && member.usedPct >= 100)).length;
  const withTopUp = list.filter((member) => Number(member.topUpRemainingCNY) > 0).length;
  const clearSearch = () => {
    setSearch('');
    searchInput.current?.focus();
  };

  return (
    <section id="allowances" className="scroll-mt-8"><div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><div className="flex items-center gap-2 text-base font-semibold text-neutral-900"><SlidersHorizontal className="h-4 w-4 text-fuchsia-600" />算力分配</div><p className="mt-1.5 max-w-3xl text-sm leading-6 text-neutral-500">充值余额是成员可消费的企业资金，跨周期保留；每日、每月限额同时生效，取剩余值较低的一项。</p></div><div className="shrink-0 text-xs text-neutral-400">任一限额用尽后，成员可使用个人余额继续</div></div>
      {!isLoading && !isError && list.length > 0 && (
        <div className="mb-3 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p role="status" className="min-h-5 text-xs text-neutral-500">{query ? `找到 ${filteredMembers.length} 位，共 ${list.length} 位` : ''}</p>
          <div className="relative w-full sm:w-80">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-neutral-400" />
            <Input ref={searchInput} aria-label="搜索姓名、邮箱或部门" placeholder="搜索姓名、邮箱或部门" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9 pr-10" />
            {search && <Button type="button" variant="ghost" size="icon" title="清空搜索" aria-label="清空搜索" className="absolute right-1 top-1 h-8 w-8 text-neutral-500" onClick={clearSearch}><X aria-hidden="true" className="h-4 w-4" /></Button>}
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.04)]">
        {isLoading ? <div className="flex items-center justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-neutral-400" /></div> : isError ? <div className="py-12 text-center"><AlertTriangle className="mx-auto mb-3 h-8 w-8 text-red-500/70" /><p className="font-medium text-neutral-900">额度列表加载失败</p><p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">{error instanceof Error && error.message ? error.message : '请稍后重试'}</p><Button variant="outline" size="sm" className="mt-4" onClick={() => void refetch()}>重试</Button></div> : list.length === 0 ? <div className="py-16 text-center text-neutral-500"><Users className="mx-auto mb-3 h-9 w-9 text-neutral-300" /><p className="font-medium text-neutral-800">还没有碳基员工</p><p className="mt-1 text-sm">在“碳基员工”页添加成员后即可分配算力</p></div> : <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-200 bg-neutral-50/70 px-5 py-3.5 text-xs text-neutral-500"><span>共 <strong className="text-neutral-900">{list.length}</strong> 位成员</span><span>已设置限额 <strong className="text-neutral-900">{allocated}</strong> 位</span><span>不限额 <strong className="text-neutral-900">{list.length - allocated}</strong> 位</span>{withTopUp > 0 && <span className="text-sky-700">有充值余额 <strong>{withTopUp}</strong> 位</span>}{capped > 0 && <span className="text-red-600">企业额度已用完 <strong>{capped}</strong> 位</span>}</div>
          {filteredMembers.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <Search aria-hidden="true" className="mx-auto mb-3 h-8 w-8 text-neutral-300" />
              <p className="font-medium text-neutral-800">未找到匹配的成员</p>
              <Button type="button" variant="outline" size="sm" className="mt-4" onClick={clearSearch}>清空筛选</Button>
            </div>
          ) : <>
            <div className="hidden gap-6 px-5 pb-2 pt-4 text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400 lg:grid lg:grid-cols-[minmax(180px,0.8fr)_minmax(300px,1.25fr)_minmax(360px,1.65fr)_auto]"><span>成员</span><span>企业充值余额</span><span>消费限额</span><span>操作</span></div>
            {filteredMembers.map((member) => <MemberRow key={member.userId} member={member} />)}
          </>}
        </>}
      </div>
    </section>
  );
}
