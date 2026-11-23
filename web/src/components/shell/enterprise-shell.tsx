'use client';

import { useState } from 'react';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  GitBranch,
  MonitorPlay,
  Boxes,
  Library,
  Store,
  Settings,
  LogOut,
  Menu,
  X,
  BarChart3,
  BookOpen,
  ListTodo,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Wallet,
  Gauge,
  Upload,
  ShieldCheck,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { ThemeLogo } from '@/components/ui/theme-logo';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { AuroraBackground } from '@/components/ui/aurora-background';
import { useEnterpriseInfo } from '@/features/enterprise/use-enterprise';
import { nav } from '@/locales/zh-CN';
import { cn } from '@/lib/utils';
import { NavItem, type NavLink } from './nav-item';
import { ShellTopbar, type CrumbMap } from './shell-topbar';
import { useAuthStore } from '@/lib/auth-store';
import { useLogout } from '@/features/auth/use-auth';
import { NotificationBell } from '@/components/notification-bell';
import { CartButton } from '@/components/cart-button';
import Link from 'next/link';
import { useEmployeeStatus } from '@/lib/websocket';
import { FloatingDock } from '@/components/aceternity/floating-dock';

/** 单条导航项，可单独标记仅管理员可见 */
type GuardedNavLink = NavLink & { adminOnly?: boolean };

interface NavGroup {
  title?: string;
  links: GuardedNavLink[];
  /** 整组仅企业管理员可见；不设则看各 link 自己的 adminOnly */
  adminOnly?: boolean;
}

/**
 * 侧边栏分组。
 *
 * 过滤原则：**能看到的页面 = 在那儿至少能做一件事**。
 * 普通成员看不到「组织」组，不是怕他看，而是部门/成员的增删改都要
 * 企业管理员权限，进去除了看树什么都做不了，不如不给入口。
 *
 * ⚠️ 这是体验优化，**不是安全措施** —— roleInEnterprise 存在浏览器里，
 * 用户改得动。真正拦人的是后端的 assertEnterpriseAdmin。
 */
const NAV_GROUPS: NavGroup[] = [
  {
    links: [
      { href: '/dashboard', label: nav.dashboard, icon: LayoutDashboard, exact: true },
    ],
  },
  {
    title: '组织',
    adminOnly: true,
    links: [
      { href: '/departments', label: nav.departments, icon: GitBranch },
      // 碳基员工（真人成员），与下方「员工」组形成对比
      { href: '/members', label: nav.members, icon: Users },
    ],
  },
  {
    title: '员工',
    links: [
      // 使用者视角：我被授权使用的硅基员工。普通成员的核心页面
      { href: '/my-employees', label: nav.myEmployees, icon: MonitorPlay },
      // 管理视角：雇佣关系一个入口管到底 ——
      // 雇佣（买）、暂停/恢复、升级、授权给碳基员工都在这里
      { href: '/subscriptions', label: nav.subscriptions, icon: Boxes, adminOnly: true },
    ],
  },
  {
    title: '工作',
    links: [
      { href: '/chat', label: nav.chat, icon: MessageSquare },
      { href: '/tasks', label: nav.tasks, icon: ListTodo },
    ],
  },
  {
    title: '组织能力',
    links: [
      // 企业自己的技能资产：个人修改、统一审核、版本回退。与「能力贡献中心」
      // （向平台投稿）分开 —— 会议批评过「过度收拢到一个模块」，两者受众和动作都不同。
      //
      // 叫「技能库」而不是会议给的「能力迭代」：决策 1 要求「减少技术化表达」，
      // 而「迭代」正是技术词；「技能库 / 知识库」在同一组里天然对称，一眼看得懂各是什么。
      { href: '/capabilities', label: nav.capabilities, icon: Library },
      // 知识库是企业的文档资产，与技能库并列
      { href: '/knowledge', label: nav.knowledge, icon: BookOpen, adminOnly: true },
      //
      // 能力贡献中心：把企业的技能投到平台市场。
      //
      // 这个入口以前压根不存在 —— ContributionRouteShell 会给企业用户渲染
      // EnterpriseShell，FULL_HEIGHT_ROUTES 里也早就列了 /contributions，
      // 说明本来是打算给企业用户用的，但导航里从来没有这一项，只有无企业身份的
      // 贡献者（ContributorShell）能看到。结果是平台侧的能力审核队列**没有上游**，
      // 三个审核入口长期是 0/0/0。
      { href: '/contributions', label: nav.contributions, icon: Upload },
    ],
  },
  {
    title: '服务',
    links: [
      { href: '/wallet', label: '企业钱包', icon: Wallet, adminOnly: true },
      //
      // 算力余额对三种角色都开，页面内按角色分叉：管理员看企业算力池与分配，
      // 普通成员看「公司给我的额度 + 我的个人余额」。
      //
      // 曾经这里是 adminOnly，于是成员在站内**没有任何地方**能查到
      // 「公司还愿意为我付多少、我自己还剩多少」—— 被额度拦下时只能干瞪眼。
      { href: '/compute-quota', label: '算力余额', icon: Gauge },
      { href: '/usage', label: nav.usage, icon: BarChart3 },
      { href: '/audit', label: '安全与审计', icon: ShieldCheck, adminOnly: true },
    ],
  },
];

/** 顶栏面包屑用的「路径段 → 中文名」映射，从 NAV_GROUPS 推导 + 补上非导航路由 */
const CRUMBS: CrumbMap = {
  ...Object.fromEntries(
    NAV_GROUPS.flatMap((g) =>
      g.links.map((l) => [l.href.replace(/^\//, ''), l.label] as const),
    ),
  ),
  marketplace: nav.marketplace,
  cart: '购物车',
  checkout: '确认订单',
  payment: '支付',
  result: '支付结果',
  settings: '设置',
  // settings 子路由
  profile: '个人资料',
  security: '安全策略',
  notifications: '通知设置',
  billing: '账单与套餐',
  organization: '企业信息',
  roles: '角色权限',
  'api-keys': 'API 密钥',
  integrations: '集成与 Webhook',
  models: '模型偏好',
  // 其他非导航路由
  chat: '对话',
  contributions: nav.contributions,
  capabilities: nav.capabilities,
  skills: nav.capabilities,
  wallet: '企业钱包',
  'compute-quota': '算力余额',
  audit: '安全与审计',
  recharge: '充值',
  new: '新建',
  edit: '编辑',
};

/**
 * 这些路由自己管理高度与滚动（聊天窗口需要输入框固定在底部），
 * 内容区不能再加 p-6，也不能是滚动容器 —— 否则会把子元素顶出视口。
 */
const FULL_HEIGHT_ROUTES = ['/chat', '/tasks', '/contributions'];

export function EnterpriseShell({ children }: { children: React.ReactNode }) {
  const { user, enterprise, roleInEnterprise } = useAuthStore();
  const pathname = usePathname();
  const logout = useLogout();
  const { data: enterpriseInfo } = useEnterpriseInfo();

  const isFullHeight = FULL_HEIGHT_ROUTES.some(
    (r) => pathname === r || pathname?.startsWith(`${r}/`),
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const isAdmin = roleInEnterprise === 'ENTERPRISE_ADMIN';

  const employeeStatuses = useEmployeeStatus();
  const statusDotStatus = Object.values(employeeStatuses).includes('busy')
    ? 'busy'
    : Object.values(employeeStatuses).includes('online')
      ? 'online'
      : ('offline' as const);

  // 先过滤整组，再过滤组内单项;两级都为空的组不渲染标题
  const groups = NAV_GROUPS.filter((g) => !g.adminOnly || isAdmin)
    .map((g) => ({ ...g, links: g.links.filter((l) => !l.adminOnly || isAdmin) }))
    .filter((g) => g.links.length > 0);

  // FloatingDock 移动端导航项（精简版，只显示最常用的）
  const dockItems = [
    { title: '工作台', icon: <LayoutDashboard />, href: '/dashboard' },
    { title: '我的员工', icon: <MonitorPlay />, href: '/my-employees' },
    { title: '对话', icon: <MessageSquare />, href: '/chat' },
    { title: '任务', icon: <ListTodo />, href: '/tasks' },
    { title: '市场', icon: <Store />, href: '/marketplace' },
  ];

  return (
    // 主题 B 极光（PRD §背景渐变配方）。blobs=1：企业端多为表格/长列表，
    // 少一层 80px blur 给内容区留 GPU 预算。
    <AuroraBackground blobs={1} className="flex h-screen min-h-screen bg-[#f0f2f5] dark:bg-slate-950">
      {/* Mobile menu button */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-glass-sm border border-glassline bg-glass-2 text-gtext-primary backdrop-blur-glass-md lg:hidden"
        aria-label="Toggle menu"
      >
        {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Backdrop overlay for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-gbg-deep/70 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed lg:static inset-y-0 left-0 z-40',
          'glass-nav flex shrink-0 flex-col transition-all duration-300',
          'lg:translate-x-0',
          // 移动端：完全隐藏或显示
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          // 桌面端：折叠时宽度变窄
          collapsed ? 'lg:w-[72px]' : 'w-[248px]',
        )}
      >
        {/* Logo 区域 - 固定 64px 高度，与顶栏对齐 */}
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-glassline px-5">
          <div className="flex items-center gap-2 overflow-hidden">
            {enterpriseInfo?.logo?.trim() ? (
              <Avatar name={enterpriseInfo?.name ?? enterprise?.name} src={enterpriseInfo.logo} className="h-8 w-8 shrink-0 rounded-md object-contain" />
            ) : (
              <ThemeLogo width={32} height={32} className="rounded-md" />
            )}
            {/* 显示企业名而非平台名；数据尚未加载时保持留白，避免伪装成平台 Logo 文案 */}
            {!collapsed && enterprise?.name && (
              <p className="min-w-0 flex-1 truncate text-sm font-semibold text-gtext-primary">
                {enterprise.name}
              </p>
            )}
          </div>
          {/* 桌面端折叠按钮 */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-glass-2 lg:flex"
            aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 text-gtext-secondary" />
            ) : (
              <ChevronLeft className="h-4 w-4 text-gtext-secondary" />
            )}
          </button>
          {/* WebSocket 连接状态指示器 - 折叠时隐藏 */}
          {!collapsed && <StatusDot status={statusDotStatus} size="sm" />}
        </div>

        <nav className="flex-1 overflow-y-auto scroll-thin px-4 py-5">
          {groups.map((group, i) => (
            <div key={group.title ?? `g${i}`} className="mb-1">
              {group.title && !collapsed && (
                <p className="mb-2 px-3 text-xs font-semibold text-gtext-muted">
                  {group.title}
                </p>
              )}
              <div className="space-y-0.5">
                {group.links.map((link) => (
                  <div key={link.href} onClick={() => setSidebarOpen(false)}>
                    <NavItem {...link} collapsed={collapsed} />
                  </div>
                ))}
              </div>
              {/* 分组分割线 */}
              {i < groups.length - 1 && (
                <div className="my-3 border-t border-glassline" />
              )}
            </div>
          ))}
        </nav>

        {/* 用户信息区域 - 底部固定 */}
        <div className="shrink-0 border-t border-glassline p-3">
          {!collapsed ? (
            <>
              <div className="mb-2 flex items-center gap-2 rounded-glass-sm border border-glassline bg-glass-2 px-2 py-2.5">
                <Avatar name={user?.name || user?.email || '用户'} src={user?.avatar} className="h-8 w-8 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gtext-primary">
                    {user?.name || '用户'}
                  </p>
                  <p className="truncate text-xs text-gtext-muted">{user?.email}</p>
                </div>
              </div>
              <div onClick={() => setSidebarOpen(false)}>
                <NavItem href="/settings" label={nav.personalSettings} icon={Settings} />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full justify-start text-gtext-secondary hover:bg-glass-2 hover:text-gtext-primary"
                onClick={() => logout.mutate()}
              >
                <LogOut className="h-4 w-4" />
                退出登录
              </Button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={() => setSidebarOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-glass-sm hover:bg-glass-2"
                title="个人设置"
              >
                <Settings className="h-5 w-5 text-gtext-secondary" />
              </button>
              <button
                onClick={() => logout.mutate()}
                className="flex h-10 w-10 items-center justify-center rounded-glass-sm hover:bg-glass-2"
                title="退出登录"
              >
                <LogOut className="h-5 w-5 text-gtext-secondary" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* 内容区是滚动容器 —— sticky 顶栏必须是它的直接子元素才能吸住。
          全高路由例外：由页面自己管理滚动，这里只做不滚动的 flex 容器。 */}
      <main
        className={cn(
          'flex-1 min-w-0',
          isFullHeight
            ? 'flex h-full min-h-0 flex-col overflow-hidden'
            : 'overflow-y-auto scroll-thin',
        )}
      >
        <ShellTopbar
          crumbs={CRUMBS}
          rootLabel="工作台"
          rootHref="/dashboard"
          roleLabel={isAdmin ? '企业管理员' : '企业成员'}
          hamburgerGutter
        >
          <Link
            href="/marketplace"
            className="hidden shrink-0 items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-sm font-semibold text-indigo-700 transition-colors hover:border-indigo-300 hover:bg-indigo-100 sm:inline-flex dark:border-indigo-400/30 dark:bg-indigo-400/10 dark:text-indigo-200 dark:hover:bg-indigo-400/20"
          >
            <Store className="h-4 w-4" />
            <span>{nav.marketplace}</span>
          </Link>
          <CartButton />
          <NotificationBell />
        </ShellTopbar>
        {isFullHeight ? (
          <div className="min-h-0 flex-1">{children}</div>
        ) : (
          <div className="px-4 py-5 sm:px-6 lg:px-7">{children}</div>
        )}
      </main>

      {/* FloatingDock - 仅移动端显示 */}
      <FloatingDock items={dockItems} mobileClassName="pb-safe" />
    </AuroraBackground>
  );
}
