import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/auth-store';
import VerifyEmailChangePage from './page';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), mutate: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=confirmation'),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/features/auth/use-auth', () => ({
  useConfirmEmailChange: () => ({ mutate: mocks.mutate, isPending: false, isSuccess: true }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, token: null, hydrated: false });
});
afterEach(cleanup);

it('等待认证恢复后将管理员带回账号设置', () => {
  render(<VerifyEmailChangePage />);
  const back = screen.getByRole('button', { name: '返回个人设置' });
  expect(back).toBeDisabled();
  fireEvent.click(back);
  expect(mocks.replace).not.toHaveBeenCalled();
  act(() => useAuthStore.setState({ hydrated: true, user: {
    id: 'admin', email: 'admin@example.com', name: null, avatar: null, role: 'ADMIN',
  } }));
  expect(back).toBeEnabled();
  fireEvent.click(back);
  expect(mocks.replace).toHaveBeenCalledWith('/admin/account');
});
