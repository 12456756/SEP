'use client';

import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  Bot,
  Receipt,
  TrendingDown,
} from 'lucide-react';
import { useAuthStore } from '@/lib/auth-store';
import { MyComputePanel } from '@/features/compute/my-compute-panel';
import { AllowanceAuditPanel } from './allowance-audit-panel';
import { ComputeBalanceStrip } from './compute-balance-strip';
import { MemberAllowancePanel } from './member-allowance-panel';
import { MyUsageRecords } from './my-usage-records';
import { UsageRecordTable } from './usage-record-table';

/** 页头。标题只承担页面定位，副标题说明当前角色能做什么。 */
function PageHeader({ subtitle }: { subtitle: string }) {
  return (
    /*
      页头到第一个板块的间距：pb-4 + space-y-6 共 40px。
      原来是 pb-7 + space-y-8（60px），标题和内容像分了两屏。
    */
    <section className="border-b border-border/70 pb-4">
      <h1 className="text-2xl font-semibold text-foreground">算力余额</h1>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-fg-muted">{subtitle}</p>
    </section>
  );
}

/**
 * 普通成员视角：**公司给我的额度 + 我的个人余额 + 我自己的逐笔账单**，
 * 没有企业池、没有别人的账。
 *
 * 这一屏原来挂在「硅基员工」页上。搬过来的理由：额度是**算力**这件事，
 * 与「我被授权用哪几位硅基员工」是两个概念（方案 §5.5 #5：取消授权后
 * 看不到员工，额度数字不变），混在一页会让人以为额度是员工的属性。
 *
 * 逐笔账单以前不在这里：`usage-records` 曾经对非管理员一律 403，
 * 成员手上只有一个「本周期已用 ¥0.12」的汇总数，问不出这钱花在哪几次对话上。
 * 那些行**一直都记着**（每次模型调用一行），只是没人给他看。现在接口按
 * JWT 作用域返回他自己的行，这块就补上了。
 */
function MemberView() {
  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        subtitle="公司给我的额度、我的个人余额、每一笔花在哪，以及额度用尽后会发生什么"
      />

      {/* `id` 供对话里「额度用尽」弹窗跳回来定位 */}
      <div id="my-compute" className="scroll-mt-8">
        <MyComputePanel />
      </div>

      <section id="my-usage-records" className="scroll-mt-8">
        <div className="mb-3">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Receipt className="h-4 w-4 text-sky-600" />
            我的算力消费明细
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            每次模型调用一行，标明这笔钱是公司付的还是你的个人余额付的。
            只包含你自己的记录。
          </p>
        </div>
        <MyUsageRecords />
      </section>

      <Link
        href="/usage"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-card px-4 py-3 transition-colors hover:bg-muted/40"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BarChart3 className="h-4 w-4 text-sky-600" />
          看我这段时间的花费分布
        </span>
        <span className="flex items-center gap-1 text-xs text-fg-muted">
          在「用量分析」页按模型 / 硅基员工汇总 —— 上面是逐笔，那里是趋势
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </Link>
    </div>
  );
}

/**
 * 企业管理员视角。
 *
 * 展示企业算力管理，以及管理员自己的额度与个人钱包。
 *
 * 两处刻意不放在这里：
 *   · 企业钱包余额与资金流水 → `/wallet`（这一页显示的是从钱包充值进来的算力）
 *   · 硅基员工自带的赠送额度 → 「硅基员工」页每张卡片（那是员工的属性，不是企业算力池）
 *   · 按部门 / 员工的花费分布 → `/usage`
 */
function AdminView() {
  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        subtitle="管理企业算力专款、成员余额与消费明细，查看自己的额度与个人余额"
      />

      <ComputeBalanceStrip />

      <section id="my-compute" className="scroll-mt-8">
        <h2 className="mb-3 text-base font-semibold text-foreground">我的算力与个人钱包</h2>
        <MyComputePanel />
      </section>

      <MemberAllowancePanel />

      <AllowanceAuditPanel />

      <section id="usage-records" className="scroll-mt-8">
        <div className="mb-3">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <TrendingDown className="h-4 w-4 text-sky-600" />
            算力消费明细
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            每次模型调用的人民币成本与扣费来源。Token 是用量明细，不是可购买的余额。
          </p>
        </div>
        <UsageRecordTable />
      </section>

      {/* 赠送额度从本页移走了，得告诉用户去哪找 —— 否则会以为功能没了 */}
      <Link
        href="/my-employees"
        className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-card px-4 py-3 transition-colors hover:bg-muted/40"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Bot className="h-4 w-4 text-emerald-600" />
          查看每位硅基员工自带的赠送算力余额
        </span>
        <span className="flex items-center gap-1 text-xs text-fg-muted">
          在「硅基员工」页的卡片上，赠送额度随订阅发放、只属于对应员工
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </Link>
    </div>
  );
}

/**
 * 算力余额页 —— 三种企业内角色都能进，看到的东西完全不同。
 *
 * 分叉在页面这一层而不是各面板内部：管理员那几块（企业池、分配表、审计）
 * 读的接口后端已对非管理员 403，成员视角必须**不挂载**它们，
 * 而不是挂上再隐藏 —— 否则一进页面就是三个失败请求。
 * 逐笔账单是唯一两种角色都能读的接口，但两侧渲染的是不同的表：
 * 管理员那张带筛选栏（要拉员工与成员列表，成员读不到），成员那张只有分页。
 *
 * ⚠️ 这里的角色判断只决定「渲染什么」。真正的隔离在后端
 * （`assertEnterpriseAdmin` + 用量分析的服务端作用域）：store 里的
 * `roleInEnterprise` 是浏览器里的值，用户改得动。
 *
 * 不需要等 hydrate：`(enterprise)` 路由组外面是 `AuthGate`，
 * 它在 refresh 落定前不渲染 children，进到这里角色已经定了。
 */
export default function ComputeQuotaPage() {
  const roleInEnterprise = useAuthStore((s) => s.roleInEnterprise);
  const isAdmin = roleInEnterprise === 'ENTERPRISE_ADMIN';

  return isAdmin ? <AdminView /> : <MemberView />;
}
