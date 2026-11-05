"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { Search, Users, SlidersHorizontal } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/auth-store";
import { useMarketEmployees } from "@/features/employee/use-employees";
import { useSubscriptions } from "@/features/subscription/use-subscriptions";
import { useMyEmployees } from "@/features/enterprise/use-enterprise";
import { useAddToCart } from "@/features/cart/use-cart";
import {
  useCreateSubscriptionRequest,
  useMySubscriptionRequests,
} from "@/features/subscription-request/use-subscription-requests";
import {
  useCreateDirectOrder,
  useCreateAlipayPayment,
  usePayOrderWithBalance,
} from "@/features/order/use-order";
import { MyRequestsModal } from "@/features/subscription-request/my-requests-modal";
import { SubscriptionRequestModal } from "@/components/subscription-request-modal";
import type { MarketEmployee } from "@/lib/types";
import { EMPLOYEE_CATEGORIES } from "@/lib/employee-categories";
import { EmployeeCard } from "./_components/employee-card";
import { EmployeeDrawer } from "./_components/employee-drawer";
import { CategoryTabs } from "./_components/category-tabs";
import { PaymentModal } from "@/components/ui/payment-modal";
import {
  FilterPanel,
  INITIAL_FILTERS,
  type FilterState,
} from "./_components/filter-panel";
import Link from "next/link";

const CATEGORY_KEYS = EMPLOYEE_CATEGORIES.map((category) => category.value);

type SortMode = "" | "hot" | "new" | "price";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "", label: "推荐排序" },
  { value: "hot", label: "使用最多" },
  { value: "new", label: "最新上架" },
  { value: "price", label: "价格从低到高" },
];

export default function MarketplacePage() {
  const router = useRouter();
  const { token, hydrated, roleInEnterprise } = useAuthStore();
  const loggedIn = hydrated && Boolean(token);
  const isAdmin = roleInEnterprise === "ENTERPRISE_ADMIN";

  // Initialize filters from URL params - use lazy initialization
  const [filters, setFilters] = useState<FilterState>(() => {
    if (typeof window === 'undefined') return INITIAL_FILTERS;
    const params = new URLSearchParams(window.location.search);
    const capTypes = params.getAll("capTypes");
    return {
      search: params.get("q") ?? "",
      category: params.get("category") ?? "",
      capTypes,
    };
  });

  // Initialize sort from URL params - use lazy initialization
  const [sort, setSort] = useState<SortMode>(() => {
    if (typeof window === 'undefined') return "";
    const params = new URLSearchParams(window.location.search);
    const nextSort = params.get("sort") as SortMode;
    return SORT_OPTIONS.some((option) => option.value === nextSort) ? nextSort : "";
  });

  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [payingEmp, setPayingEmp] = useState<MarketEmployee | null>(null);
  const [subscribeSucceeded, setSubscribeSucceeded] = useState(false);
  // 普通成员的"申请订阅" modal 状态
  const [requestingEmp, setRequestingEmp] = useState<MarketEmployee | null>(
    null,
  );
  // 「我的申请」弹窗
  const [myRequestsOpen, setMyRequestsOpen] = useState(false);

  // Track if component is mounted to prevent initial URL update
  const isMountedRef = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;
  }, []);

  useEffect(() => {
    if (!isMountedRef.current) return;
    const params = new URLSearchParams();
    if (filters.search) params.set("q", filters.search);
    if (filters.category) params.set("category", filters.category);
    filters.capTypes.forEach((type) => params.append("capTypes", type));
    if (sort) params.set("sort", sort);
    const query = params.toString();
    router.replace(query ? `/marketplace?${query}` : "/marketplace", { scroll: false });
  }, [filters, sort, router]);

  // 我的申请（用于角标显示待审批数）
  const { data: myRequests = [] } = useMySubscriptionRequests({
    enabled: loggedIn,
  });
  const pendingRequestCount = useMemo(
    () => myRequests.filter((r) => r.status === "PENDING").length,
    [myRequests],
  );

  // 搜索走服务端（后端支持 ?search=），300ms 防抖
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  const {
    data: employees = [],
    isLoading,
    isError,
    error,
  } = useMarketEmployees(debouncedSearch);

  // 订阅列表需登录 —— 访客不请求，否则每次都白跑一轮 401 + refresh
  const { data: subs = [] } = useSubscriptions({ enabled: loggedIn });
  // 我已获授权的员工（用于区分「企业已订阅」与「我可用」）
  const { data: myEmployees = [] } = useMyEmployees({ enabled: loggedIn });
  const createDirectOrder = useCreateDirectOrder();
  const createPayment = useCreateAlipayPayment();
  const payWithBalance = usePayOrderWithBalance();
  const addToCart = useAddToCart();
  const createRequest = useCreateSubscriptionRequest();
  const subscribedIds = useMemo(
    () => new Set(subs.map((s) => s.employee.id)),
    [subs],
  );
  const grantedToMeIds = useMemo(
    () => new Set(myEmployees.map((m) => m.employee.id)),
    [myEmployees],
  );

  function patchFilters(next: Partial<FilterState>) {
    setFilters((prev) => ({ ...prev, ...next }));
  }

  /**
   * Tab 栏是单选「视图」：热门/新上架 = 排序（并清掉职能筛选），
   * 其余 = 职能筛选（并清掉排序）。
   */
  function handleTab(v: string) {
    if (v === "__hot__") {
      setSort("hot");
      patchFilters({ category: "" });
    } else if (v === "__new__") {
      setSort("new");
      patchFilters({ category: "" });
    } else {
      setSort("");
      patchFilters({ category: v });
    }
  }

  const activeTab =
    filters.category ||
    (sort === "hot" ? "__hot__" : sort === "new" ? "__new__" : "");

  // 除「职能分类」外的所有筛选 —— 用它算各分类数量，
  // 这样选中某个分类后其他分类的数字不会全变 0
  const preCategory = useMemo(() => {
    return employees.filter((emp) => {
      if (filters.capTypes.length > 0) {
        const types = new Set<string>(
          emp.bindings?.map((b) => b.capability.type) ?? [],
        );
        if (!filters.capTypes.some((t) => types.has(t))) return false;
      }
      return true;
    });
  }, [employees, filters.capTypes]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const key of CATEGORY_KEYS) {
      out[key] = preCategory.filter((e) => e.functionalCategory === key).length;
    }
    return out;
  }, [preCategory]);

  const visible = useMemo(() => {
    const list = preCategory.filter(
      (e) => !filters.category || e.functionalCategory === filters.category,
    );
    if (sort === "hot") {
      return [...list].sort(
        (a, b) =>
          ((b._count?.subscriptions ?? 0) * 100 + (b.stats?.totalExecutions ?? 0)) -
          ((a._count?.subscriptions ?? 0) * 100 + (a.stats?.totalExecutions ?? 0)),
      );
    }
    if (sort === "new") {
      return [...list].sort(
        (a, b) =>
          new Date(b.publishedAt ?? 0).getTime() -
          new Date(a.publishedAt ?? 0).getTime(),
      );
    }
    if (sort === "price") {
      return [...list].sort(
        (a, b) => Number(a.annualPriceCNY ?? a.price ?? 0) - Number(b.annualPriceCNY ?? b.price ?? 0),
      );
    }
    return list;
  }, [preCategory, filters.category, sort]);

  const drawerEmp = drawerId
    ? (employees.find((e) => e.id === drawerId) ?? null)
    : null;

  /**
   * 点「订阅/申请订阅」入口。
   * 管理员 → PaymentModal 直接下单；普通成员 → SubscriptionRequestModal 提交申请。
   */
  function doSubscribe(emp: MarketEmployee) {
    if (isAdmin) {
      setPayingEmp(emp);
    } else {
      setRequestingEmp(emp);
    }
  }

  /** 支付确认后才真正调订阅接口。成功则切换到引导界面，失败留在弹窗里让用户重试。 */
  async function confirmPayment(paymentMethod: "balance" | "alipay") {
    const emp = payingEmp;
    if (!emp) return;

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
      setSubscribeSucceeded(true);
    } catch (error) {
      toast.error((error as Error).message || "订阅失败");
    }
  }

  function closePaymentModal() {
    setPayingEmp(null);
    setSubscribeSucceeded(false);
  }

  /** 普通成员提交订阅申请 */
  function handleSubmitRequest(data: {
    reason: string;
    requestedDays?: number;
  }) {
    const emp = requestingEmp;
    if (!emp) return;
    createRequest.mutate(
      { employeeId: emp.id, ...data },
      {
        onSuccess: () => {
          toast.success(`已提交「${emp.name}」的使用申请，等待管理员审批`);
          setRequestingEmp(null);
        },
        onError: (e) =>
          toast.error(e instanceof ApiError ? e.message : "提交申请失败"),
      },
    );
  }

  /** 加入购物车 */
  function handleAddToCart(emp: MarketEmployee) {
    addToCart.mutate(
      { employeeId: emp.id, periodMonths: 12 },
      {
        onSuccess: () => {
          toast.success(`${emp.name} 已加入购物车`);
        },
        onError: (e) =>
          toast.error(e instanceof ApiError ? e.message : "加入购物车失败"),
      },
    );
  }

  return (
    <div className="space-y-5 sm:space-y-8">
      {/* ── page header ──────────────────────────────────────────────── */}
      <header className="space-y-4 text-center sm:space-y-5 sm:pt-4">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          <span className="gradient-text-glass inline-block">硅基人才市场</span>
        </h1>
        <p className="mx-auto max-w-xl text-[15px] text-gtext-secondary">
          按职能、能力类型和预算挑选硅基员工，雇佣后即可授权给部门与成员。
        </p>

        <div className="relative mx-auto max-w-xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gtext-muted" />
          <input
            type="search"
            value={filters.search}
            onChange={(e) => patchFilters({ search: e.target.value })}
            placeholder="搜索员工名称、岗位、行业…"
            aria-label="搜索员工"
            className={cn(
              "w-full rounded-glass-pill border border-glassline bg-glass-2 py-3 pl-11 pr-4",
              "text-[14px] text-gtext-primary placeholder:text-gtext-muted",
              "shadow-glass-sm backdrop-blur-glass-md transition-colors duration-200",
              "focus:border-glassline-brand focus:outline-none focus:ring-2 focus:ring-gbrand/40",
            )}
          />
        </div>
        <Link href="/marketplace/bundles" className="inline-flex items-center gap-2 rounded-glass-md border border-glassline bg-glass-2 px-4 py-2 text-sm font-medium text-gtext-primary transition-colors hover:bg-glass-3">
          <Users className="h-4 w-4" />浏览员工套餐
        </Link>
      </header>

      {/* ── tabs ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-glassline">
        <CategoryTabs active={activeTab} onChange={handleTab} />
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <label className="sr-only" htmlFor="market-sort">排序</label>
          <select
            id="market-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            className="rounded-glass-md border border-glassline bg-glass-2 px-3 py-1.5 text-[12px] text-gtext-secondary outline-none transition-colors focus:border-glassline-brand"
          >
            {SORT_OPTIONS.map((option) => <option key={option.value || "recommended"} value={option.value}>{option.label}</option>)}
          </select>
          {loggedIn && !isAdmin && (
            <button
              onClick={() => setMyRequestsOpen(true)}
              className="flex items-center gap-1.5 rounded-glass-md border border-glassline bg-glass-2 px-3 py-1.5 text-[12px] text-gtext-secondary transition-colors hover:text-gtext-primary"
            >
              我的申请
              {pendingRequestCount > 0 && (
                <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-white">
                  {pendingRequestCount}
                </span>
              )}
            </button>
          )}
          <button
            onClick={() => setMobileFilterOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-glass-md border border-glassline bg-glass-2 px-3 py-1.5 text-[12px] text-gtext-secondary transition-colors hover:text-gtext-primary lg:hidden"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            筛选
          </button>
        </div>
      </div>

      {/* ── body: filter + grid ──────────────────────────────────────── */}
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* 桌面常驻，移动端按需展开 */}
        <div className={cn("lg:block", mobileFilterOpen ? "block" : "hidden")}>
          <FilterPanel
            filters={filters}
            onChange={patchFilters}
            counts={counts}
            total={preCategory.length}
          />
        </div>

        <div className="min-w-0 flex-1">
          {isLoading ? (
            <CardGridSkeleton />
          ) : isError ? (
            <GlassEmpty
              title="加载失败"
              desc={error?.message || "无法加载员工列表，请稍后重试。"}
              action={
                <Button
                  variant="glass"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  刷新页面
                </Button>
              }
            />
          ) : visible.length === 0 ? (
            <GlassEmpty
              title={
                debouncedSearch || filters.category || filters.capTypes.length
                  ? "没有匹配的员工"
                  : "暂无已上架的员工"
              }
              desc={
                debouncedSearch || filters.category || filters.capTypes.length
                  ? "试试放宽筛选条件或换个关键词。"
                  : "员工上架后会出现在这里。"
              }
              action={
                debouncedSearch ||
                filters.category ||
                filters.capTypes.length ? (
                  <Button
                    variant="glass"
                    size="sm"
                    onClick={() =>
                      patchFilters({
                        search: "",
                        category: "",
                        capTypes: [],
                      })
                    }
                  >
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-gtext-secondary">找到 {visible.length} 位员工</p>
                <div className="flex flex-wrap gap-1.5 text-[11px] text-gtext-muted">
                  {filters.category && <span className="rounded-full border border-glassline bg-glass-2 px-2 py-1">{EMPLOYEE_CATEGORIES.find((c) => c.value === filters.category)?.label}</span>}
                  {filters.capTypes.map((type) => <span key={type} className="rounded-full border border-glassline bg-glass-2 px-2 py-1">{type === "AGENT" ? "AI 对话" : type === "RPA" ? "RPA 自动化" : type === "SKILL" ? "技能脚本" : "AI 应用"}</span>)}
                  {(filters.category || filters.capTypes.length > 0) && <button className="rounded px-1.5 py-1 text-gbrand-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gbrand" onClick={() => patchFilters({ category: "", capTypes: [] })}>清除筛选</button>}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map((emp) => (
                  <EmployeeCard
                    key={emp.id}
                    emp={emp}
                    subscribed={subscribedIds.has(emp.id)}
                    grantedToMe={grantedToMeIds.has(emp.id)}
                    loggedIn={loggedIn}
                    isAdmin={isAdmin}
                    subscribing={
                      createDirectOrder.isPending ||
                      createPayment.isPending ||
                      payWithBalance.isPending ||
                      createRequest.isPending
                    }
                    onSubscribe={() => doSubscribe(emp)}
                    onClick={() => setDrawerId(emp.id)}
                    onAddToCart={() => handleAddToCart(emp)}
                    addingToCart={addToCart.isPending}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── drawer ───────────────────────────────────────────────────── */}
      <EmployeeDrawer
        emp={drawerEmp}
        subscribed={drawerEmp ? subscribedIds.has(drawerEmp.id) : false}
        grantedToMe={drawerEmp ? grantedToMeIds.has(drawerEmp.id) : false}
        loggedIn={loggedIn}
        isAdmin={isAdmin}
        subscribing={
          createDirectOrder.isPending ||
          createPayment.isPending ||
          payWithBalance.isPending ||
          createRequest.isPending
        }
        onSubscribe={() => drawerEmp && doSubscribe(drawerEmp)}
        onClose={() => setDrawerId(null)}
      />

      {/* ── 支付确认（仅管理员直接订阅） ─────────────────────────────── */}
      {payingEmp && (
        <PaymentModal
          open
          emp={{ name: payingEmp.name, price: payingEmp.annualPriceCNY }}
          subscribing={
            payWithBalance.isPending ||
            createDirectOrder.isPending ||
            createPayment.isPending
          }
          succeeded={subscribeSucceeded}
          onConfirm={confirmPayment}
          onClose={closePaymentModal}
        />
      )}

      {/* ── 申请订阅（普通成员） ─────────────────────────────────────── */}
      <SubscriptionRequestModal
        open={Boolean(requestingEmp)}
        emp={requestingEmp}
        onClose={() => setRequestingEmp(null)}
        onSubmit={handleSubmitRequest}
        submitting={createRequest.isPending}
      />

      {/* ── 我的申请（申请记录 + 审批状态） ──────────────────────────── */}
      <MyRequestsModal
        open={myRequestsOpen}
        onClose={() => setMyRequestsOpen(false)}
      />
    </div>
  );
}

// ─── local glass states ───────────────────────────────────────────────────────

function CardGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="glass-card animate-pulse space-y-4 p-5"
          aria-hidden="true"
        >
          <div className="flex gap-4">
            <div className="h-[72px] w-[72px] shrink-0 rounded-full bg-glass-3" />
            <div className="flex-1 space-y-2 pt-2">
              <div className="h-3.5 w-2/3 rounded bg-glass-3" />
              <div className="h-3 w-1/2 rounded bg-glass-2" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-3 w-full rounded bg-glass-2" />
            <div className="h-3 w-4/5 rounded bg-glass-2" />
          </div>
          <div className="h-px bg-glassline" />
          <div className="flex justify-between">
            <div className="h-4 w-16 rounded bg-glass-3" />
            <div className="h-7 w-16 rounded-glass-md bg-glass-3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function GlassEmpty({
  title,
  desc,
  action,
}: {
  title: string;
  desc: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="glass-card flex flex-col items-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-glassline bg-glass-2">
        <Users className="h-5 w-5 text-gtext-muted" />
      </div>
      <h3 className="text-[15px] font-semibold text-gtext-primary">{title}</h3>
      <p className="max-w-sm text-[13px] text-gtext-secondary">{desc}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
