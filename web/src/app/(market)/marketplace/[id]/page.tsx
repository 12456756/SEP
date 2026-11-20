"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Wrench,
  Check,
  Package,
  PlayCircle,
  BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PulsingDot } from "@/components/ui/pulsing-dot";
import { Avatar } from "@/components/ui/avatar";
import { cn, CAPABILITY_TYPE_META } from "@/lib/utils";
import { useAuthStore } from "@/lib/auth-store";
import { useMarketEmployee } from "@/features/employee/use-employees";
import { useSubscriptions } from "@/features/subscription/use-subscriptions";
import { useMyEmployees } from "@/features/enterprise/use-enterprise";
import {
  useMySubscriptionRequests,
  useCreateSubscriptionRequest,
} from "@/features/subscription-request/use-subscription-requests";
import {
  useCreateDirectOrder,
  useCreateAlipayPayment,
  usePayOrderWithBalance,
} from "@/features/order/use-order";
import { toast } from "@/components/ui/toast";
import { PaymentModal } from "@/components/ui/payment-modal";
import { SubscriptionRequestModal } from "@/components/subscription-request-modal";
import { MyRequestsModal } from "@/features/subscription-request/my-requests-modal";
import { ApiError } from "@/lib/api-client";

// ─── avatar gradient（与卡片/抽屉同一套映射）──────────────────────────────────

const GRAD_MAP: [string, string][] = [
  ["人事", "linear-gradient(135deg,#7c3aed,#a855f7)"],
  ["HR", "linear-gradient(135deg,#7c3aed,#a855f7)"],
  ["销售", "linear-gradient(135deg,#2563eb,#3b82f6)"],
  ["CRM", "linear-gradient(135deg,#2563eb,#3b82f6)"],
  ["财务", "linear-gradient(135deg,#0891b2,#06b6d4)"],
  ["运营", "linear-gradient(135deg,#059669,#10b981)"],
  ["营销", "linear-gradient(135deg,#db2777,#f43f5e)"],
  ["技术", "linear-gradient(135deg,#d97706,#f59e0b)"],
];

function avatarGradient(position: string, industry: string) {
  const text = `${position} ${industry}`;
  for (const [key, grad] of GRAD_MAP) {
    if (text.includes(key)) return grad;
  }
  return "linear-gradient(135deg,#4f46e5,#818cf8)";
}

// ─── 玻璃分区容器 ─────────────────────────────────────────────────────────────

function GlassSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-card p-6">
      <h2 className="mb-4 flex items-center gap-2 text-[15px] font-semibold text-gtext-primary">
        <span className="text-gbrand-text">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

// ─── 使用步骤（静态文案）──────────────────────────────────────────────────────

const HOW_TO = [
  {
    t: "企业雇佣",
    d: "由企业管理员雇佣该员工，获得使用权。雇佣是企业级的，一次雇佣可在多处部署。",
  },
  {
    // 收敛后不再创建实例：一企业一员工一段雇佣关系，部门差异化落在授权记录上
    t: "开通授权",
    d: "在「雇佣管理」把 TA 授权给部门或具体成员，可设到期时间。同一位员工可同时服务多个部门。",
  },
  {
    t: "开始使用",
    d: "被授权的人在「我的硅基员工」里就能看到 TA，直接发起任务或对话。",
  },
  {
    t: "下载到本地运行",
    d: "员工以员工包形式下载到本地，放入你自己的运行环境即可使用；企业知识库留在本地不出内网。",
  },
];

// ─── page ────────────────────────────────────────────────────────────────────

export default function EmployeeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { token, hydrated } = useAuthStore();
  const loggedIn = hydrated && Boolean(token);

  // 走公开接口 —— 访客也要能看详情（不能用需登录的 useEmployee）
  const { data: emp, isLoading, isError } = useMarketEmployee(id);
  // 访客不请求订阅列表
  const { data: subs = [] } = useSubscriptions({ enabled: loggedIn });
  // 访客不请求「我已被授权」列表 —— 用于判断是否已有使用权限
  const { data: myEmployees = [] } = useMyEmployees({ enabled: loggedIn });
  const createDirectOrder = useCreateDirectOrder();
  const createPayment = useCreateAlipayPayment();
  const payWithBalance = usePayOrderWithBalance();

  // 支付弹窗开关。Hook 必须在早退分支之前声明。
  const [payOpen, setPayOpen] = useState(false);
  // 订阅申请弹窗开关
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  // 「我的申请」弹窗
  const [myRequestsOpen, setMyRequestsOpen] = useState(false);

  const subscribed = subs.some((s) => s.employee.id === id);
  // 我是否已被授权使用（直接或经部门）
  const alreadyGrantedToMe = myEmployees.some((m) => m.employee.id === id);

  // 查询我对该员工的订阅申请（仅登录用户）
  const { data: myRequests = [] } = useMySubscriptionRequests();
  const hasPendingRequest = myRequests.some(
    (r) => r.employeeId === id && r.status === "PENDING",
  );

  const createRequest = useCreateSubscriptionRequest();

  // 履历缺失时兜底为零值，让下面的渲染只判断数值、不再判断 undefined
  const trackRecord = emp?.stats ?? { totalExecutions: 0, successRate: null };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="h-6 w-20 animate-pulse rounded-glass-md bg-glass-2" />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-glass-2xl border border-glassline bg-glass-1"
          />
        ))}
      </div>
    );
  }

  // 未上架的员工后端返回 404，对访客表现为「不存在」
  if (isError || !emp) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="glass-card flex flex-col items-center gap-4 px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-glassline bg-glass-2 text-gtext-muted">
            <Package className="h-6 w-6" />
          </div>
          <div>
            <p className="text-[15px] font-medium text-gtext-primary">
              员工不存在或尚未上架
            </p>
            <p className="mt-1 text-[13px] text-gtext-secondary">
              它可能已下架，或链接有误。
            </p>
          </div>
          <Link href="/marketplace">
            <Button variant="glass-primary" size="sm">
              返回人才市场
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const grad = avatarGradient(emp.position ?? "", emp.industry ?? "");
  const hasPrice = emp.annualPriceCNY != null && Number.isFinite(Number(emp.annualPriceCNY)) && Number(emp.annualPriceCNY) >= 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-[13px] text-gtext-secondary transition-colors hover:text-gtext-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        返回
      </button>

      {/* 详情页五段式：我是谁 / 如何获得 / 我能做什么 / 如何使用 / 做得怎么样
          「如何获得」提到第二位 —— 访客看完介绍最想知道的是下一步怎么做 */}

      {/* 一 · 我是谁 */}
      <section className="glass-hero relative overflow-hidden p-6 sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full opacity-25 blur-3xl"
          style={{ background: grad }}
        />
        <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center">
          <Avatar
            name={emp.name}
            src={emp.avatar}
            asset={emp.avatarAsset}
            portrait
            className="h-24 w-24 shrink-0 shadow-glass-lg ring-1 ring-glassline"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold text-gtext-primary">
                {emp.name}
              </h1>
              <span className="rounded-full border border-glassline bg-glass-2 px-2 py-0.5 text-[11px] text-gtext-secondary">
                v{emp.version}
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-emerald-400">
                <PulsingDot className="h-1.5 w-1.5" />
                在线
              </span>
            </div>
            <p className="mt-1 text-[13px] text-gtext-secondary">
              {emp.position}
              {emp.industry ? ` · ${emp.industry}` : ""}
            </p>
            <p className="mt-3 text-[14px] leading-relaxed text-gtext-secondary">
              {emp.description || "暂无描述"}
            </p>
          </div>
        </div>
      </section>

      {/* 二 · 如何获得（前置：访客最想知道的下一步动作） */}
      <GlassSection icon={<Package className="h-4 w-4" />} title="如何获得">
        <div className="flex flex-wrap items-center gap-3">
          {/* 统一入口：
              - 我已有使用权限 → 已授权使用（禁用）
              - 有 PENDING 申请 → 申请审批中（禁用）
              - 其余（未订阅 / 已订阅但未授权给我）→ 申请使用（后端自动判定订阅 or 授权）
          */}
          {alreadyGrantedToMe ? (
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-400">
              <Check className="h-4 w-4" />
              已授权使用
            </span>
          ) : hasPendingRequest ? (
            <>
              <Button variant="glass" size="sm" disabled>
                申请审批中
              </Button>
              <button
                onClick={() => setMyRequestsOpen(true)}
                className="text-[12px] text-gbrand-text underline underline-offset-2 hover:text-gtext-primary"
              >
                查看我的申请
              </button>
            </>
          ) : loggedIn ? (
            <>
              <Button
                variant="glass-primary"
                size="sm"
                onClick={() => setRequestModalOpen(true)}
                disabled={!subscribed && !hasPrice}
              >
                申请使用
              </Button>
              {subscribed && (
                <span className="text-[12px] text-gtext-secondary">
                  本企业已订阅，通过后直接开通授权（免费）
                </span>
              )}
            </>
          ) : (
            <Link
              href={`/login?redirect=${encodeURIComponent(`/marketplace/${emp.id}`)}`}
            >
              <Button variant="glass-primary" size="sm">
                登录后申请
              </Button>
            </Link>
          )}

          {!hasPrice ? (
            <span className="text-[13px] text-gtext-muted">暂未定价</span>
          ) : Number(emp.annualPriceCNY) > 0 ? (
            <span className="text-[15px] font-semibold text-gtext-primary">
              ¥{Number(emp.annualPriceCNY).toLocaleString()}
              <span className="text-[12px] font-normal text-gtext-muted">
                /年
              </span>
            </span>
          ) : (
            <span className="text-[13px] font-medium text-emerald-400">
              免费
            </span>
          )}
        </div>
        <p className="mt-3 text-[12px] text-gtext-muted">
          申请通过后即可使用：企业未订阅时由管理员完成订阅并授权，企业已订阅时直接为你开通授权。
        </p>
        {loggedIn && (
          <button
            onClick={() => setMyRequestsOpen(true)}
            className="mt-2 text-[12px] text-gbrand-text underline underline-offset-2 hover:text-gtext-primary"
          >
            查看我的申请记录与审批状态 →
          </button>
        )}
      </GlassSection>

      {/* 三 · 我能做什么 */}
      <GlassSection icon={<Wrench className="h-4 w-4" />} title="我能做什么">
        {!emp.bindings || emp.bindings.length === 0 ? (
          <p className="text-[13px] text-gtext-muted">暂无技能</p>
        ) : (
          <ul className="space-y-2.5">
            {[...emp.bindings]
              .sort((a, b) => a.order - b.order)
              .map((b) => {
                const cap = b.capability;
                const meta = CAPABILITY_TYPE_META[cap.type];
                return (
                  <li
                    key={b.id}
                    className="flex items-start gap-3 rounded-glass-lg border border-glassline bg-glass-2 p-3.5"
                  >
                    <span className="mt-0.5 shrink-0 rounded-full border border-glassline bg-glass-3 px-2 py-0.5 text-[11px] text-gtext-secondary">
                      {meta?.label ?? cap.type}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-gtext-primary">
                        {cap.name}
                      </p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-gtext-muted">
                        {cap.description}
                      </p>
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </GlassSection>

      {/* 四 · 如何使用 —— 纯静态说明，讲清从订阅到用起来的路径 */}
      <GlassSection icon={<PlayCircle className="h-4 w-4" />} title="如何使用">
        <ol className="space-y-3.5">
          {HOW_TO.map((s, i) => (
            <li key={s.t} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gbrand/20 text-[11px] font-semibold text-gbrand-text">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-gtext-primary">
                  {s.t}
                </p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-gtext-muted">
                  {s.d}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </GlassSection>

      {/* 五 · 做得怎么样 —— 真实聚合，没有记录时保留破折号而不是写 0（方案 §4.3）*/}
      <GlassSection icon={<BarChart3 className="h-4 w-4" />} title="做得怎么样">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            {
              label: "已服务企业",
              value: `${emp._count?.subscriptions ?? 0} 家`,
              real: true,
            },
            {
              label: "累计任务量",
              // 0 次执行走破折号：写「0」会让新上架员工看起来像跑失败了
              value: trackRecord.totalExecutions
                ? trackRecord.totalExecutions.toLocaleString("zh-CN")
                : "—",
              real: trackRecord.totalExecutions > 0,
            },
            {
              label: "任务成功率",
              value:
                trackRecord.successRate === null
                  ? "—"
                  : `${trackRecord.successRate}%`,
              real: trackRecord.successRate !== null,
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className={cn(
                "rounded-glass-lg p-4",
                stat.real
                  ? "border border-glassline bg-glass-2"
                  : "border border-dashed border-glassline bg-transparent",
              )}
            >
              <p className="text-[11px] text-gtext-muted">{stat.label}</p>
              <p
                className={cn(
                  "mt-1 text-xl font-semibold",
                  stat.real ? "text-gtext-primary" : "text-gtext-disabled",
                )}
              >
                {stat.value}
              </p>
            </div>
          ))}
        </div>
        {/* 有数据说口径，没数据说「为什么没有」—— 两种情况都不能让用户猜 */}
        <p className="mt-3 text-[12px] leading-relaxed text-gtext-muted">
          {trackRecord.totalExecutions > 0
            ? "任务量与成功率取自平台侧能力执行记录，跨企业累计，不含客户端本地运行的部分。「已服务企业」取自平台订阅记录。"
            : "该员工在平台侧尚无能力执行记录，故任务量与成功率暂无数据，而非为 0。「已服务企业」取自平台订阅记录，是真实值。"}
        </p>
      </GlassSection>

      {/* ── 支付确认 ─────────────────────────────────────────────────── */}
      <PaymentModal
        open={payOpen}
        emp={{ name: emp.name, price: emp.annualPriceCNY }}
        subscribing={
          payWithBalance.isPending ||
          createDirectOrder.isPending ||
          createPayment.isPending
        }
        onConfirm={async (paymentMethod) => {
          if (paymentMethod === "alipay") {
            // 员工市场直接订阅：创建独立订单，不经过购物车
            try {
              const order = await createDirectOrder.mutateAsync({
                employeeId: emp.id,
                periodMonths: 12,
              });
              const payment = await createPayment.mutateAsync(order.id);
              window.location.href = payment.paymentForm;
            } catch (error: any) {
              toast.error(error.message || "创建订单失败");
            }
            return;
          }
          // 余额支付：市场直订阅同样创建独立订单，不经过购物车。
          try {
            const order = await createDirectOrder.mutateAsync({
              employeeId: emp.id,
              periodMonths: 12,
            });
            await payWithBalance.mutateAsync(order.id);
            setPayOpen(false);
            toast.success(`已雇佣「${emp.name}」，可去「雇佣管理」开通授权`);
          } catch (error) {
            toast.error((error as Error).message || "订阅失败");
          }
        }}
        onClose={() => setPayOpen(false)}
      />

      {/* ── 订阅申请弹窗 ─────────────────────────────────────────────── */}
      <SubscriptionRequestModal
        open={requestModalOpen}
        emp={emp}
        submitting={createRequest.isPending}
        onClose={() => setRequestModalOpen(false)}
        onSubmit={({ reason, requestedDays }) => {
          createRequest.mutate(
            { employeeId: emp.id, reason, requestedDays },
            {
              onSuccess: () => {
                setRequestModalOpen(false);
                toast.success("使用申请已提交，等待管理员审批");
              },
              onError: (e) =>
                toast.error(e instanceof ApiError ? e.message : "提交申请失败"),
            },
          );
        }}
      />

      {/* ── 我的申请（申请记录 + 审批状态） ──────────────────────────── */}
      <MyRequestsModal
        open={myRequestsOpen}
        onClose={() => setMyRequestsOpen(false)}
      />
    </div>
  );
}
