import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/auth-store';
import { PlatformShell } from './platform-shell';
import { ContributorShell } from './contributor-shell';

const route = vi.hoisted(() => ({ pathname: '/admin' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props} onClick={(event) => event.preventDefault()}>{children}</a>
  ),
}));
vi.mock('@/features/auth/use-auth', () => ({ useLogout: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));

let desktop: MediaQueryList;
beforeEach(() => {
  route.pathname = '/admin';
  desktop = Object.assign(new EventTarget(), { matches: false, media: '(min-width: 1024px)' }) as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => query === desktop.media
    ? desktop
    : Object.assign(new EventTarget(), { matches: false, media: query })));
  vi.stubGlobal('PointerEvent', MouseEvent);
  useAuthStore.setState({
    user: { id: 'u1', name: '测试', email: 'test@example.com', avatar: '/avatar.png', role: 'USER' },
    enterprise: null,
    roleInEnterprise: null,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([
  ['PlatformShell', PlatformShell, '管理后台导航', '硅基员工', '/admin/employees'],
  ['standalone ContributorShell', ContributorShell, '个人工作台导航', '能力贡献中心', '/contributions'],
] as const)('%s 移动端导航', (_name, Shell, title, linkName, href) => {
  const renderShell = () => render(<Shell><button>页面内容</button></Shell>);
  const openMenu = async () => {
    const trigger = screen.getByRole('button', { name: '打开导航菜单' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: title });
    return { trigger, dialog };
  };

  it('移动端默认不占侧栏宽度，桌面侧栏和顶栏保留响应式布局', () => {
    const { container } = renderShell();
    expect(container.querySelector('aside')).toHaveClass('hidden', 'lg:flex', 'w-60');
    expect(screen.getByRole('main')).toHaveClass('min-w-0');
    expect(container.querySelector('header')).toHaveClass('pl-16', 'lg:pl-6');
    expect(screen.getByRole('button', { name: '打开导航菜单' })).toHaveClass('lg:hidden');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '测试' })).toHaveClass('h-8', 'w-8', 'shrink-0');
  });

  it('打开后焦点进入菜单并约束在菜单内，Escape 关闭且返回触发器', async () => {
    renderShell();
    const outside = screen.getByRole('button', { name: '页面内容' });
    const { trigger, dialog } = await openMenu();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', dialog.id);
    expect(dialog).toHaveClass('left-0', 'top-0', 'h-dvh', 'w-60');
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => outside.focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('关闭按钮关闭菜单并返回焦点', async () => {
    renderShell();
    const { trigger, dialog } = await openMenu();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('点击遮罩关闭菜单', async () => {
    renderShell();
    const { trigger, dialog } = await openMenu();
    // DialogContent 的前一个 portal 节点是实际 Radix Overlay，不 mock 原语。
    const overlay = dialog.previousElementSibling!;
    expect(overlay).toHaveAttribute('data-state', 'open');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.pointerDown(overlay, { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(overlay, { button: 0, pointerType: 'mouse' });
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('点击导航（包括当前路径）立即关闭菜单', async () => {
    route.pathname = href;
    renderShell();
    const { dialog } = await openMenu();
    const link = within(dialog).getByRole('link', { name: linkName });
    expect(link).toHaveAttribute('href', href);
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('外部路由变化也关闭菜单', async () => {
    const { rerender } = renderShell();
    await openMenu();
    route.pathname = '/marketplace';
    rerender(<Shell><button>页面内容</button></Shell>);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('保留桌面折叠状态，但移动菜单始终显示完整导航和固定尺寸头像', async () => {
    const { container } = renderShell();
    if (_name === 'PlatformShell') {
      expect(container.querySelector('a[href="/admin/account"]')).toHaveAttribute('aria-label', '账号设置');
    }
    fireEvent.click(screen.getByRole('button', { name: '折叠侧边栏' }));
    expect(container.querySelector('aside')).toHaveClass('w-16');
    if (_name === 'PlatformShell') {
      expect(container.querySelector('a[href="/admin/account"]')).toBeInTheDocument();
    }
    const { dialog } = await openMenu();
    expect(within(dialog).getByRole('link', { name: linkName })).toHaveTextContent(linkName);
    expect(within(dialog).queryByRole('button', { name: '展开侧边栏' })).not.toBeInTheDocument();
    const avatar = within(dialog).getByRole('img', { name: '测试' });
    expect(avatar).toHaveClass('h-8', 'w-8', 'shrink-0');
    fireEvent.error(avatar);
    expect(within(dialog).getByText('测')).toHaveClass('h-8', 'w-8', 'shrink-0');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(container.querySelector('aside')).toHaveClass('w-16');
    fireEvent.click(screen.getByRole('button', { name: '展开侧边栏' }));
    expect(container.querySelector('aside')).toHaveClass('w-60');
  });

  it('切换到桌面断点关闭模态菜单，解除背景交互锁定', async () => {
    renderShell();
    await openMenu();
    act(() => {
      Object.assign(desktop, { matches: true });
      desktop.dispatchEvent(new Event('change'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '页面内容' })).toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
});
