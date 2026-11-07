import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminAccountSettingsPage from './page';

const mocks = vi.hoisted(() => ({
  profile: {
    id: 'admin-1', email: 'admin@example.com', emailVerifiedAt: '2026-10-01T00:00:00.000Z',
    name: '运营管理员', avatar: null, role: 'ADMIN', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as { id: string; email: string; emailVerifiedAt: string | null; name: string; avatar: null; role: string; createdAt: string; updatedAt: string },
  changePassword: vi.fn(),
  requestEmailChange: vi.fn(),
  requestEmailVerification: vi.fn(),
  passwordError: null as Error | null,
  emailChangeError: null as Error | null,
  verificationError: null as Error | null,
}));

vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('@/features/user/use-user', () => ({
  useMe: () => ({ data: mocks.profile, isLoading: false, isError: false }),
  useChangePassword: () => ({ mutate: mocks.changePassword, isPending: false, error: mocks.passwordError }),
}));
vi.mock('@/features/auth/use-auth', () => ({
  useRequestEmailChange: () => ({ mutate: mocks.requestEmailChange, isPending: false, error: mocks.emailChangeError }),
  useRequestEmailVerification: () => ({ mutate: mocks.requestEmailVerification, isPending: false, error: mocks.verificationError }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.profile = {
    id: 'admin-1', email: 'admin@example.com', emailVerifiedAt: '2026-10-01T00:00:00.000Z',
    name: '运营管理员', avatar: null, role: 'ADMIN', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  mocks.passwordError = null;
  mocks.emailChangeError = null;
  mocks.verificationError = null;
});
afterEach(cleanup);

describe('平台管理员账号设置', () => {
  it('显示当前登录邮箱并通过现有流程请求变更邮箱', async () => {
    render(<AdminAccountSettingsPage />);
    expect(screen.getByText('admin@example.com')).toBeVisible();
    fireEvent.change(screen.getByLabelText('新的登录邮箱'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '发送确认邮件' }));

    await waitFor(() => expect(mocks.requestEmailChange).toHaveBeenCalledWith(
      'new@example.com', expect.objectContaining({ onSuccess: expect.any(Function) }),
    ));
    act(() => mocks.requestEmailChange.mock.calls[0][1].onSuccess({ message: '确认邮件已发送到新邮箱' }));
    expect(await screen.findByRole('status')).toHaveTextContent('确认邮件已发送到新邮箱');
    expect(screen.getByLabelText('新的登录邮箱')).toHaveValue('');
  });

  it('未验证当前邮箱时只提供验证邮件入口', () => {
    mocks.profile = { ...mocks.profile, emailVerifiedAt: null };
    render(<AdminAccountSettingsPage />);
    expect(screen.getByText('未验证')).toBeInTheDocument();
    expect(screen.queryByLabelText('新的登录邮箱')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }));
    expect(mocks.requestEmailVerification).toHaveBeenCalledWith(undefined, expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it('提交当前密码和新密码，成功后清空表单并显示会话提示', async () => {
    render(<AdminAccountSettingsPage />);
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-123' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password-123' } });
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));

    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledWith(
      { currentPassword: 'old-password', newPassword: 'new-password-123' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    ));
    act(() => mocks.changePassword.mock.calls[0][1].onSuccess());
    expect(await screen.findByRole('status')).toHaveTextContent('密码已修改');
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
  });

  it('展示服务端当前密码错误', () => {
    mocks.passwordError = new Error('当前密码不正确');
    render(<AdminAccountSettingsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('当前密码不正确');
  });
});
