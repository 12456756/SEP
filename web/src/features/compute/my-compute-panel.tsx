'use client';

import { useState } from 'react';
import type { PaymentMode } from 'shared/payment-preference.dto';
import {
  ChevronDown,
  ChevronUp,
  Gauge,
  Infinity as InfinityIcon,
  Loader2,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  formatCny,
  formatCnyPrecise,
  useMyAllowance,
  type MemberAllowanceItem,
} from '@/lib/api/use-compute-credit';
import {
  usePersonalWallet,
  usePersonalWalletTransactions,
  type PersonalWalletTransaction,
} from '@/lib/api/use-personal-wallet';
import { PersonalDepositDialog } from './personal-deposit-dialog';
import { PaymentPreferenceControl, usePaymentPreference } from './payment-preference';

/** 「10月1日」—— 重置时刻只要月日，年份对「下次什么时候重置」没有信息量。 */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日`;
}

function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 与管理端同一口径：画**剩余**，满格绿 = 这周期还没怎么花。 */
function remainingBarColor(remainingPct: number): string {
  if (remainingPct <= 20) return 'bg-red-500';
  if (remainingPct <= 40) return 'bg-yellow-400';
  return 'bg-emerald-500';
}

/** 公司额度那一栏。不限额与限额是两种完全不同的读法，分开渲染。 */
function AllowanceBlock({ allowance, paymentMode }: { allowance: MemberAllowanceItem; paymentMode?: PaymentMode }) {
  const unlimited = allowance.limitCNY === null && !allowance.dailyLimitCNY && !allowance.monthlyLimitCNY;
  const monthlyLimit = allowance.monthlyLimitCNY ?? (allowance.monthlyLimitCNY === null && allowance.limitCNY !== null ? allowance.limitCNY : null);
  const monthlyRemaining = allowance.monthlyRemainingCNY ?? (monthlyLimit ? allowance.remainingCNY : null);
  const monthlyPct = monthlyLimit && Number(monthlyLimit) > 0 ? Math.max(0, Math.min(100, (Number(monthlyRemaining) / Number(monthlyLimit)) * 100)) : null;
  const dailyPct = allowance.dailyLimitCNY && Number(allowance.dailyLimitCNY) > 0 ? Math.max(0, Math.min(100, Number(allowance.dailyRemainingCNY) / Number(allowance.dailyLimitCNY) * 100)) : null;
  const leftPct = monthlyPct;
  const capped = (monthlyPct !== null && monthlyPct <= 0) || (dailyPct !== null && dailyPct <= 0 && !allowance.dailyBypassActive);
  const carriedIn = Number(allowance.carriedInCNY) > 0;
  const topUpAmount = Number(allowance.topUpAmountCNY ?? allowance.topUpRemainingCNY);
  const topUpRemaining = Number(allowance.topUpRemainingCNY);
  const topUpPct = topUpAmount > 0 ? Math.max(0, Math.min(100, (topUpRemaining / topUpAmount) * 100)) : 0;

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-center gap-2">
        <Gauge className="h-4 w-4 shrink-0 text-gtext-secondary" />
        <span className="text-sm font-medium text-gtext-primary">公司给我的额度</span>
        {capped && (
          <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
            {paymentMode === 'AUTO' ? '已用完 · 转自费' : '企业额度已用完'}
          </span>
        )}
      </div>

      <div className="mb-2 border-l-2 border-sky-400 bg-sky-50/60 px-2.5 py-2 text-xs text-sky-700">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">企业充值余额</span>
          <span className="tabular-nums">剩余 {formatCnyPrecise(allowance.topUpRemainingCNY)} / 已充值 {formatCny(allowance.topUpAmountCNY ?? allowance.topUpRemainingCNY)}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sky-100"><div className="h-full rounded-full bg-sky-500" style={{ width: `${topUpPct}%` }} /></div>
        <p className="mt-1 text-sky-600/80">跨周期保留，充值时已从企业钱包扣款</p>
      </div>
      {unlimited ? (
        <p className="text-sm text-gtext-secondary">
          <InfinityIcon className="mr-1 inline h-3.5 w-3.5" />
          公司未给你设上限 · {allowance.periodLabel}已用{' '}
          <span className="tabular-nums">{formatCnyPrecise(allowance.usedCNY)}</span>
        </p>
      ) : (
        <>
          {/* §5.5 #2 的验收句式：「本月 ¥0 / ¥50，下次重置 X 月 X 日」 */}
          <p className="text-sm text-gtext-primary">
            <span className="tabular-nums">
              本月已用 {formatCnyPrecise(allowance.monthlyUsedCNY ?? allowance.usedCNY)} / {formatCny(monthlyLimit ?? allowance.limitCNY)}
            </span>
            {carriedIn && (
              <span className="text-emerald-600">
                {' '}
                + 结转 {formatCny(allowance.carriedInCNY)}
              </span>
            )}
          </p>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-glass-2">
            <div
              className={`h-1.5 rounded-full transition-all duration-500 ${remainingBarColor(
                leftPct ?? 0,
              )}`}
              style={{ width: `${leftPct ?? 0}%` }}
            />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gtext-muted">
            <span className="tabular-nums">
              剩余 {formatCnyPrecise(allowance.monthlyRemainingCNY ?? allowance.remainingCNY)}
            </span>
            <span>{shortDate(allowance.resetAt)}重置</span>
            {allowance.carryOver && <span>未用完可结转</span>}
          </div>
          {allowance.dailyLimitCNY && <div className="mt-1 text-xs text-gtext-muted">今日已用 {formatCnyPrecise(allowance.dailyUsedCNY)} / {formatCny(allowance.dailyLimitCNY)} · 剩余 {formatCnyPrecise(allowance.dailyRemainingCNY)}{allowance.dailyBypassActive ? ' · 今日已临时放开' : ''}</div>}
        </>
      )}
    </div>
  );
}

/** 一条个人钱包流水。金额带符号，按符号选颜色 —— 取绝对值就分不出收支了。 */
function TransactionRow({ tx }: { tx: PersonalWalletTransaction }) {
  const amount = Number(tx.amountCNY);
  const income = amount > 0;
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate text-gtext-secondary">
        {tx.description ?? (income ? '充值' : '对话自费')}
      </span>
      <span className="shrink-0 tabular-nums text-gtext-muted">
        {shortDateTime(tx.createdAt)}
      </span>
      <span
        className={`w-20 shrink-0 text-right tabular-nums ${
          income ? 'text-emerald-600' : 'text-amber-600'
        }`}
      >
        {income ? '+' : '-'}
        {formatCnyPrecise(Math.abs(amount))}
      </span>
    </li>
  );
}

/**
 * 「我的算力」—— 使用者自己的那两个数字，挂在「算力余额」页（`/compute-quota`）。
 *
 * 曾经挂在 `/my-employees`，因为那时 `/compute-quota` 整页是管理员专属。
 * 现在那一页三种角色都能进、按角色分叉，这块就回到了它的概念主场：
 * 额度是**算力**这件事，不是硅基员工的属性（方案 §5.5 #6 四个概念各归其位）。
 *
 * 管理员视角也挂这一块 —— 他同样是「用的人」，自己也有额度和个人余额；
 * 个人余额充值入口全站只有这一处（以及对话被拦下时的弹窗）。
 *
 * 两个数字必须放在一起看：**「公司还愿意为我付多少」和「我自己还有多少」**。
 * 只看前者会以为额度用尽就不能对话了 —— 实际上个人余额有钱就自费继续，
 * 对话不中断（扣费链 §5.7 ②：个人钱包排最后一位）。
 */
export function MyComputePanel() {
  const [showTx, setShowTx] = useState(false);
  const allowance = useMyAllowance();
  const wallet = usePersonalWallet();
  const preference = usePaymentPreference();
  // 折叠状态下不打这次请求：一份看不见的列表不值得一次往返
  const transactions = usePersonalWalletTransactions({ pageSize: 8 }, showTx);

  if (allowance.isLoading || wallet.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-gtext-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在加载我的算力…
        </CardContent>
      </Card>
    );
  }

  // 这个面板是页面的补充信息，取数失败不该把「我的硅基员工」整页顶掉；
  // 但也不能静默隐藏 —— 用户会以为自己没有额度。
  if (allowance.isError || wallet.isError || !allowance.data || !wallet.data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-gtext-muted">
          我的算力暂时读取失败，刷新页面可重试。这不影响下方硅基员工的使用。
        </CardContent>
      </Card>
    );
  }

  const my = allowance.data;
  const personalBalance = Number(wallet.data.balanceCNY);
  const capped = my.usedPct !== null && my.usedPct >= 100;
  const blocked = capped && personalBalance <= 0;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <PaymentPreferenceControl />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <AllowanceBlock allowance={my} paymentMode={preference.data?.paymentMode} />

          <div className="w-full shrink-0 border-glassline sm:w-56 sm:border-l sm:pl-4">
            <div className="mb-1.5 flex items-center gap-2">
              <Wallet className="h-4 w-4 shrink-0 text-gtext-secondary" />
              <span className="text-sm font-medium text-gtext-primary">我的个人余额</span>
            </div>
            <p className="text-lg font-semibold tabular-nums text-gtext-primary">
              {formatCnyPrecise(wallet.data.balanceCNY)}
            </p>
            <PersonalDepositDialog
              trigger={
                <Button size="sm" variant={blocked ? 'glass-primary' : 'glass'} className="mt-2">
                  充值
                </Button>
              }
            />
          </div>
        </div>

        {/*
          这句话是这个面板存在的理由：额度用尽**不等于**不能对话。
          三种状态给三句话，含糊其辞会让用户误以为自己被停用了。
        */}
        <p className="rounded-glass-sm bg-glass-2 px-3 py-2 text-xs leading-relaxed text-gtext-secondary">
          {preference.data?.paymentMode === 'PERSONAL_ONLY' ? (
            <>本次使用个人余额支付，企业资金与分配额度不受影响。{personalBalance <= 0 && '个人余额不足，请充值或切换付款方式。'}</>
          ) : preference.data?.paymentMode === 'ENTERPRISE_ONLY' ? (
            <>仅使用获授权的企业资金，受每日、每月限额约束；不足时不会自动扣个人余额。</>
          ) : blocked ? (
            <>
              公司额度与个人余额都已用尽，现在发消息会被拦下。
              {shortDate(my.resetAt)}额度重置；想提前恢复，可联系企业管理员调高额度或给企业充值，
              也可给个人余额充值后自费使用。
            </>
          ) : capped ? (
            <>
              公司额度已用完，对话不会中断 —— 接下来由你的个人余额支付，
              {shortDate(my.resetAt)}额度重置后自动回到公司账上。
            </>
          ) : (
            <>
              先花赠送额度，再花成员企业充值余额；日/月限额任一触顶后由个人余额继续支付，对话不中断。
              自费的部分不计入上面的「已用」—— 自己掏钱不会让公司额度掉得更快。
            </>
          )}
        </p>

        <div>
          <button
            type="button"
            onClick={() => setShowTx((v) => !v)}
            className="flex items-center gap-1 text-xs text-gtext-secondary hover:text-gtext-primary"
          >
            {showTx ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            个人余额流水
            <span className="text-gtext-muted">
              （充值 {formatCny(wallet.data.totalDepositCNY)} · 自费{' '}
              {formatCnyPrecise(wallet.data.totalConsumeCNY)}）
            </span>
          </button>

          {showTx && (
            <div className="mt-2 border-t border-glassline pt-1">
              {transactions.isLoading ? (
                <p className="py-2 text-xs text-gtext-muted">加载中…</p>
              ) : transactions.data && transactions.data.records.length > 0 ? (
                <ul className="divide-y divide-glassline">
                  {transactions.data.records.map((tx) => (
                    <TransactionRow key={tx.id} tx={tx} />
                  ))}
                </ul>
              ) : (
                <p className="py-2 text-xs text-gtext-muted">
                  还没有流水。个人余额只在公司不为这次对话付钱时才会被动用。
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
