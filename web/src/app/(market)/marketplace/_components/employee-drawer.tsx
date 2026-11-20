'use client';

import { useEffect } from 'react';
import { X, Check, Wrench, Package, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { cn, CAPABILITY_TYPE_META } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { PulsingDot } from '@/components/ui/pulsing-dot';
import { Avatar } from '@/components/ui/avatar';
import type { MarketEmployee } from '@/lib/types';

// ─── avatar gradient (duplicate here to keep drawer self-contained) ───────────
// 已移除，改用 Avatar 组件内置逻辑

// ─── how-to steps ─────────────────────────────────────────────────────────────

// 收敛后只剩两步：雇佣（企业级，一次一位）→ 授权（部门/成员，可多条）
const HOW_TO = [
  { t: '企业雇佣', d: '由管理员雇佣，雇佣是企业级的，一次开通全企业可用。' },
  { t: '授权部门与成员', d: '在「雇佣管理」把 TA 授权给部门或成员，同一位员工可同时服务多个部门。' },
  { t: '开始使用', d: '被授权的人在「我的硅基员工」里即可看到并使用 TA。' },
];

// ─── props ────────────────────────────────────────────────────────────────────

interface EmployeeDrawerProps {
  emp: MarketEmployee | null;
  subscribed: boolean;
  loggedIn: boolean;
  /** 当前成员是否已被授权使用（仅普通成员视角有意义） */
  grantedToMe?: boolean;
  /** 企业管理员直接订阅；普通成员提交申请 */
  isAdmin?: boolean;
  subscribing: boolean;
  onSubscribe: () => void;
  onClose: () => void;
}

// ─── component ───────────────────────────────────────────────────────────────

export function EmployeeDrawer({
  emp,
  subscribed,
  loggedIn,
  grantedToMe = false,
  isAdmin = true,
  subscribing,
  onSubscribe,
  onClose,
}: EmployeeDrawerProps) {
  const open = Boolean(emp);

  // ESC 关闭 + 锁 body 滚动。抽屉打开时背景不该还能滚。
  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <>
      {/* backdrop */}
      <div
        aria-hidden="true"
        className={cn(
          'fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
      />

      {/* drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="员工详情"
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-full flex-col',
          'border-l border-glassline bg-glass-1 shadow-glass-xl backdrop-blur-glass-xl',
          'transition-transform duration-300 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {emp && <DrawerContent emp={emp} subscribed={subscribed} loggedIn={loggedIn} grantedToMe={grantedToMe} isAdmin={isAdmin} subscribing={subscribing} onSubscribe={onSubscribe} onClose={onClose} />}
      </div>
    </>
  );
}

// ─── inner content (only rendered when emp is set) ───────────────────────────

function DrawerContent({
  emp,
  subscribed,
  loggedIn,
  grantedToMe = false,
  isAdmin = true,
  subscribing,
  onSubscribe,
  onClose,
}: Required<Omit<EmployeeDrawerProps, 'emp'>> & { emp: MarketEmployee }) {
  const capTypes = Array.from(new Set(emp.bindings?.map((b) => b.capability.type) ?? []));
  // 列表接口已带履历；缺失时兜底零值
  const track = emp.stats ?? { totalExecutions: 0, successRate: null };
  const hasPrice = emp.annualPriceCNY != null && Number.isFinite(Number(emp.annualPriceCNY)) && Number(emp.annualPriceCNY) >= 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── header bar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-glassline px-6 py-4">
        <span className="text-[13px] text-gtext-muted">员工详情</span>
        <button
          onClick={onClose}
          className="rounded-glass-md p-1.5 text-gtext-muted transition-colors hover:bg-glass-2 hover:text-gtext-primary"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ── scrollable body ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

        {/* identity */}
        <div className="flex items-center gap-5">
          <Avatar
            name={emp.name}
            src={emp.avatar}
            asset={emp.avatarAsset}
            portrait
            className="h-20 w-20 shadow-glass-md"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-gtext-primary">{emp.name}</h2>
              <span className="flex items-center gap-1 text-[12px] text-emerald-400">
                <PulsingDot className="h-1.5 w-1.5" />
                在线
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-gtext-secondary">
              {emp.position}
              {emp.industry ? ` · ${emp.industry}` : ''}
            </p>
            <p className="mt-1 text-[12px] text-gtext-muted">
              v{emp.version} · 已服务 {emp._count?.subscriptions ?? 0} 家企业
            </p>
          </div>
        </div>

        {/* description */}
        <div>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-widest text-gtext-muted">
            简介
          </h3>
          <p className="text-[14px] leading-relaxed text-gtext-secondary">
            {emp.description || '暂无描述'}
          </p>
        </div>

        {/* capabilities */}
        {emp.bindings && emp.bindings.length > 0 && (
          <div>
            <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-widest text-gtext-muted">
              <Wrench className="h-3.5 w-3.5" />
              具备能力
            </h3>
            <ul className="space-y-2">
              {[...emp.bindings]
                .sort((a, b) => a.order - b.order)
                .map((b) => {
                  const meta = CAPABILITY_TYPE_META[b.capability.type];
                  return (
                    <li
                      key={b.id}
                      className="flex items-start gap-3 rounded-glass-lg border border-glassline bg-glass-2 p-3"
                    >
                      <span className="mt-0.5 shrink-0 rounded-full border border-glassline px-2 py-0.5 text-[10px] text-gtext-secondary">
                        {meta?.label ?? b.capability.type}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-gtext-primary">
                          {b.capability.name}
                        </p>
                        <p className="mt-0.5 text-[12px] text-gtext-muted">
                          {b.capability.description}
                        </p>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        )}

        {/* how to use */}
        <div>
          <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-widest text-gtext-muted">
            <Package className="h-3.5 w-3.5" />
            使用步骤
          </h3>
          <ol className="space-y-3">
            {HOW_TO.map((step, i) => (
              <li key={step.t} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gbrand/20 text-[11px] font-semibold text-gbrand-text">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-gtext-primary">{step.t}</p>
                  <p className="mt-0.5 text-[12px] text-gtext-muted">{step.d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* stats */}
        <div>
          <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-widest text-gtext-muted">
            <BarChart3 className="h-3.5 w-3.5" />
            运行数据
          </h3>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: '已服务企业', value: `${emp._count?.subscriptions ?? 0} 家` },
              {
                label: '累计任务量',
                // 没有执行记录时留破折号 —— 写 0 会被读成「跑过但全失败」
                value: track.totalExecutions
                  ? track.totalExecutions.toLocaleString('zh-CN')
                  : '—',
              },
              {
                label: '成功率',
                value: track.successRate === null ? '—' : `${track.successRate}%`,
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-glass-lg border border-glassline bg-glass-2 p-3 text-center"
              >
                <p className="text-[18px] font-semibold text-gtext-primary">{stat.value}</p>
                <p className="mt-1 text-[11px] text-gtext-muted">{stat.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gtext-muted">
            {track.totalExecutions > 0
              ? '任务量与成功率取自平台侧能力执行记录，跨企业累计。'
              : '该员工在平台侧尚无能力执行记录，故两项暂无数据，而非为 0。'}
          </p>
        </div>
      </div>

      {/* ── action bar ──────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-glassline p-5 space-y-3">
        {/* price */}
        <div className="flex items-baseline justify-between">
          {!hasPrice ? (
            <span className="text-sm text-gtext-muted">暂未定价</span>
          ) : Number(emp.annualPriceCNY) > 0 ? (
            <span className="text-xl font-bold text-gtext-primary">
              ¥{Number(emp.annualPriceCNY).toLocaleString()}
              <span className="text-[13px] font-normal text-gtext-muted">/年</span>
            </span>
          ) : (
            <span className="text-base font-semibold text-emerald-400">免费</span>
          )}
          <Link
            href={`/marketplace/${emp.id}`}
            className="text-[12px] text-gbrand-text underline underline-offset-2 hover:text-gtext-primary"
          >
            查看完整介绍 →
          </Link>
        </div>

        {isAdmin ? (
          subscribed ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-400">
                <Check className="h-4 w-4" />
                本企业已订阅
              </span>
              <Link href="/subscriptions" className="ml-auto">
                <Button variant="glass" size="sm">管理授权</Button>
              </Link>
            </div>
          ) : (
            <Button
              variant="glass-primary"
              size="sm"
              className="w-full"
              disabled={subscribing || !hasPrice}
              onClick={onSubscribe}
            >
              立即订阅
            </Button>
          )
        ) : grantedToMe ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-400">
              <Check className="h-4 w-4" />
              已授权使用
            </span>
            <Link href="/my-employees" className="ml-auto">
              <Button variant="glass" size="sm">去使用</Button>
            </Link>
          </div>
        ) : loggedIn ? (
          <Button
            variant="glass-primary"
            size="sm"
            className="w-full"
            disabled={subscribing}
            onClick={onSubscribe}
          >
            申请使用
          </Button>
        ) : (
          <Link
            href={`/login?redirect=${encodeURIComponent(`/marketplace/${emp.id}`)}`}
            className="block"
          >
            <Button variant="glass-primary" size="sm" className="w-full">
              登录后申请
            </Button>
          </Link>
        )}
        <p className="text-center text-[11px] text-gtext-muted">
          免费试用 7 天 · 随时解约
        </p>
      </div>
    </div>
  );
}
