import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminAuthUserDetailContent } from './page';

const mocks = vi.hoisted(() => ({
  status: 'ACTIVE' as 'ACTIVE' | 'DISABLED' | 'CLOSURE_PENDING' | 'CLOSED',
  reset: vi.fn(),
  resetPending: false,
  resetError: null as Error | null,
}));

vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/features/admin/use-admin-auth', async () => {
  const actual = await vi.importActual<typeof import('@/features/admin/use-admin-auth')>('@/features/admin/use-admin-auth');
  return {
    ...actual,
    useAdminAuthUser: () => ({ data: {
      id: 'user-1', email: 'user@example.com', name: '测试用户', avatar: null, role: 'USER',
      status: mocks.status, emailVerifiedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      authCredentials: [], authIdentities: [], authSessions: [],
    }, isLoading: false, isError: false }),
    useAdminAuthUserEvents: () => ({ data: [], isLoading: false }),
    useDisableAdminAuthUser: () => ({ mutate: vi.fn(), isPending: false }),
    useEnableAdminAuthUser: () => ({ mutate: vi.fn(), isPending: false }),
    useForceEmailVerification: () => ({ mutate: vi.fn(), isPending: false }),
    useForceLogoutAdminAuthUser: () => ({ mutate: vi.fn(), isPending: false }),
    useForcePasswordReset: () => ({ mutate: mocks.reset, isPending: mocks.resetPending, error: mocks.resetError }),
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.status = 'ACTIVE';
  mocks.resetPending = false;
  mocks.resetError = null;
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPage = () => render(<AdminAuthUserDetailContent userId="user-1" />);

describe('认证中心密码重置', () => {
  it('活动账号确认后请求邮件，并在成功后说明结果', async () => {
    renderPage();
    expect(await screen.findByText(/用户会收到设置新密码的邮件/)).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: '强制重置密码' }));

    await waitFor(() => expect(mocks.reset).toHaveBeenCalledWith({}, expect.objectContaining({ onSuccess: expect.any(Function) })));
    mocks.reset.mock.calls[0][1].onSuccess({ message: '重置密码邮件已发送' });
    expect(await screen.findByRole('status')).toHaveTextContent('重置密码邮件已发送');
    expect(screen.getByRole('status')).toHaveTextContent('全部登录设备已退出');
  });

  it.each(['DISABLED', 'CLOSURE_PENDING', 'CLOSED'] as const)('%s 账号不能发起重置', async (status) => {
    mocks.status = status;
    renderPage();
    expect(await screen.findByRole('button', { name: '强制重置密码' })).toBeDisabled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('显示邮件请求错误，不显示成功状态', async () => {
    mocks.resetError = new Error('邮件服务暂不可用');
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('邮件服务暂不可用');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
