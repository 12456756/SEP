import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EnterpriseShell } from './enterprise-shell';
import { PlatformShell } from './platform-shell';
import { ContributorShell } from './contributor-shell';
import { useAuthStore } from '@/lib/auth-store';
// 断言引用文案单一来源，避免文案调整后测试与实现漂移
import { nav } from '@/locales/zh-CN';

// next/navigation 在测试环境没有 router 上下文：NavItem 用 usePathname 判高亮，
// 顶栏里的 CartButton 用 useRouter 跳购物车 —— 少 mock 一个整个 shell 都渲染不出来。
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

// logout 会发请求，这里只关心导航渲染
vi.mock('@/features/auth/use-auth', () => ({
  useLogout: () => ({ mutate: vi.fn() }),
}));

// 真 ThemeProvider 在 effect 里读 localStorage，测试环境不可用。
// 导航渲染与主题无关，给个固定值即可。
vi.mock('@/lib/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));

// Shell 只验证导航和头像展示；实时员工状态由独立 WebSocket 链路负责，
// 测试环境不启动后端网关，避免自动重连让用例超时。
vi.mock('@/lib/websocket', () => ({
  useEmployeeStatus: () => ({}),
}));

const enterpriseInfo = vi.hoisted(() => ({ logo: null as string | null }));
vi.mock('@/features/enterprise/use-enterprise', () => ({
  useEnterpriseInfo: () => ({ data: { name: '示例科技', logo: enterpriseInfo.logo } }),
}));

const setRole = (roleInEnterprise: string | null) =>
  useAuthStore.setState({
    token: 't',
    user: { id: 'u1', email: 'a@b.c', name: '测试', avatar: null, role: 'USER' },
    enterprise: { id: 'e1', name: '示例科技' },
    roleInEnterprise,
    hydrated: true,
  });

/**
 * 外壳内含 NotificationBell，它用 useQuery 拉未读数，
 * 缺少 QueryClientProvider 会直接抛错 —— 故所有渲染都走这个包装。
 * 主题不走真 Provider（它读 localStorage），改为 mock，见上方。
 */
const renderShell = (Shell = EnterpriseShell) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Shell>内容</Shell>
    </QueryClientProvider>,
  );
};

describe('EnterpriseShell 导航角色过滤', () => {
  beforeEach(() => {
    enterpriseInfo.logo = null;
    useAuthStore.setState({
      token: null,
      user: null,
      enterprise: null,
      roleInEnterprise: null,
      hydrated: false,
    });
  });

  it.each([
    ['企业端', EnterpriseShell],
    ['平台端', PlatformShell],
    ['贡献者端', ContributorShell],
  ])('%s 用户头像及加载失败占位保持固定尺寸，不挤占姓名邮箱', (_name, Shell) => {
    setRole('ENTERPRISE_ADMIN');
    useAuthStore.setState((state) => ({
      user: { ...state.user!, avatar: '/api/users/avatar/images/large-photo.png' },
    }));
    renderShell(Shell);

    const avatar = screen.getByRole('img', { name: '测试' });
    expect(avatar).toHaveAttribute('src', '/api/users/avatar/images/large-photo.png');
    expect(avatar).toHaveClass('h-8', 'w-8', 'shrink-0', 'rounded-full', 'object-cover');
    expect(screen.getByText('测试')).toBeVisible();
    expect(screen.getByText('a@b.c')).toBeVisible();

    fireEvent.error(avatar);
    expect(screen.queryByRole('img', { name: '测试' })).not.toBeInTheDocument();
    expect(screen.getByText('测')).toHaveClass('h-8', 'w-8', 'shrink-0', 'rounded-full');
  });

  it('侧边栏使用企业上传的 Logo，加载失败退回企业首字', () => {
    setRole('MEMBER');
    enterpriseInfo.logo = '/api/enterprise/logo/images/company.png';
    renderShell();
    const logo = screen.getByRole('img', { name: '示例科技' });
    expect(logo).toHaveAttribute('src', enterpriseInfo.logo);
    fireEvent.error(logo);
    expect(screen.queryByRole('img', { name: '示例科技' })).not.toBeInTheDocument();
    expect(screen.getByText('示')).toBeInTheDocument();
  });

  it.each([null, '', '   '])('企业 Logo 为 %s 时使用平台 Logo 并保留企业名称', (logo) => {
    setRole('MEMBER');
    enterpriseInfo.logo = logo;
    const { container } = renderShell();
    expect(screen.queryByText('示')).not.toBeInTheDocument();
    expect(container.querySelector('img[src="/yuanji-A-icon.svg"]')).toHaveAttribute('width', '32');
    expect(screen.getByText('示例科技')).toBeInTheDocument();
  });

  it('企业管理员能看到「组织」组的部门与碳基员工', () => {
    setRole('ENTERPRISE_ADMIN');
    renderShell();

    expect(screen.getByText(nav.departments)).toBeInTheDocument();
    expect(screen.getByText(nav.members)).toBeInTheDocument();
  });
  it.each(['ENTERPRISE_ADMIN', 'MEMBER'])('%s仅保留技能库，不再展示独立技能审核入口', (role) => {
    setRole(role);
    const { container } = renderShell();
    expect(container.querySelector('a[href="/capabilities"]')).not.toBeNull();
    expect(container.querySelector('a[href="/skill-reviews"]')).toBeNull();
    expect(screen.queryByText('技能审核')).not.toBeInTheDocument();
  });

  it('普通成员看不到部门/团队成员 —— 进去也什么都改不了', () => {
    setRole('MEMBER');
    renderShell();

    expect(screen.queryByText(nav.departments)).not.toBeInTheDocument();
    expect(screen.queryByText(nav.members)).not.toBeInTheDocument();
  });

  it('DEPT_MANAGER 本版按普通成员对待，同样看不到组织组', () => {
    // 该角色要名副其实需要「数据范围」那一层，后端尚无，
    // 故不给它任何高于 MEMBER 的可见项
    setRole('DEPT_MANAGER');
    renderShell();

    expect(screen.queryByText(nav.departments)).not.toBeInTheDocument();
  });

  it('所有角色都能看到「我的硅基员工」与用量分析', () => {
    for (const role of ['ENTERPRISE_ADMIN', 'MEMBER', 'DEPT_MANAGER']) {
      setRole(role);
      const { unmount } = renderShell();
      expect(screen.getByText(nav.myEmployees)).toBeInTheDocument();
      expect(screen.getByText(nav.usage)).toBeInTheDocument();
      unmount();
    }
  });

  it('侧边栏显示企业名而非平台名（多租户下确认在哪家企业）', () => {
    setRole('MEMBER');
    renderShell();

    expect(screen.getByText('示例科技')).toBeInTheDocument();
  });

  // 收敛后雇佣关系只有一个入口（原「员工授权」/instances 已并入 /subscriptions），
  // 雇佣、暂停、升级、授权都在这一处，所以这里只需断言这一个入口的可见性。
  it('「雇佣管理」仅管理员可见 —— 普通成员进去全是点不动的按钮', () => {
    setRole('ENTERPRISE_ADMIN');
    const { unmount } = renderShell();
    expect(screen.getByText(nav.subscriptions)).toBeInTheDocument();
    unmount();

    setRole('MEMBER');
    renderShell();
    expect(screen.queryByText(nav.subscriptions)).not.toBeInTheDocument();
    // 但「我的硅基员工」仍在 —— 这是成员的主页面
    expect(screen.getByText(nav.myEmployees)).toBeInTheDocument();
  });

  // 原有断言「导航里没有对话中心入口（会话已暂停）」已删除：
  // 会话功能在 4f0704a 恢复，导航入口与 chat/page.tsx 都已回归，
  // 该断言是暂停期的遗留，与当前实现矛盾。
  // 「算力余额」曾经是 adminOnly，于是成员在站内没有任何地方能查到
  // 「公司还愿意为我付多少、我自己还剩多少」。企业钱包仍然只给管理员 ——
  // 那是公司的钱，两者不能一起放开。
  it('「算力余额」三种角色都可见，「企业钱包」仍只给管理员', () => {
    for (const role of ['ENTERPRISE_ADMIN', 'MEMBER', 'DEPT_MANAGER']) {
      setRole(role);
      const { unmount } = renderShell();
      expect(screen.getByText('算力余额')).toBeInTheDocument();
      unmount();
    }

    setRole('MEMBER');
    const { unmount } = renderShell();
    expect(screen.queryByText('企业钱包')).not.toBeInTheDocument();
    unmount();

    setRole('ENTERPRISE_ADMIN');
    renderShell();
    expect(screen.getByText('企业钱包')).toBeInTheDocument();
  });

  it('对话中心与任务中心对所有角色可见', () => {
    setRole('MEMBER');
    renderShell();

    expect(screen.getByText(nav.chat)).toBeInTheDocument();
    expect(screen.getByText(nav.tasks)).toBeInTheDocument();
  });
});
