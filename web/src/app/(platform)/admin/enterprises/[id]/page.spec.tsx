import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EnterpriseDetailPage from './page';

const mocks = vi.hoisted(() => ({ refund: vi.fn(), pending: false }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'ent-1' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/features/admin/use-admin', () => ({
  useEnterpriseDetail: () => ({ data: {
    id: 'ent-1', name: '测试企业', createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z',
    balance: 40.299999, members: [], subscriptions: [], departments: [], transactions: [{
      id: 'deposit-1', type: 'DEPOSIT', amount: 100, refundedAmount: 0, refundableAmount: 40.29,
      createdAt: '2026-11-07T00:00:00Z',
    }],
  }, isLoading: false, error: null }),
  useCreditAdjustment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRefundDeposit: () => ({ mutateAsync: mocks.refund, isPending: mocks.pending }),
  useSuspendEnterprise: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useResumeEnterprise: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
beforeEach(() => { vi.clearAllMocks(); mocks.pending = false; });
afterEach(cleanup);
function openRefund() {
  render(<EnterpriseDetailPage />);
  fireEvent.click(screen.getByRole('button', { name: '交易记录' }));
  fireEvent.click(screen.getByRole('button', { name: /^退款$/ }));
  return screen.getByRole('button', { name: '确认退款' });
}
it('全部退款提交后端提供的分精度金额', async () => {
  const submit = openRefund();
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.refund).toHaveBeenCalledWith({
    enterpriseId: 'ent-1', transactionId: 'deposit-1', data: { amount: 40.29, reason: undefined },
  }));
});
it('非法部分金额禁用确认，合法两位小数可以提交', () => {
  const submit = openRefund();
  fireEvent.click(screen.getByLabelText('退还部分金额'));
  const amount = screen.getByPlaceholderText('请输入退款金额');
  for (const value of ['', '0', '-1', '0.001', '40.30']) {
    fireEvent.change(amount, { target: { value } });
    expect(submit).toBeDisabled();
  }
  fireEvent.change(amount, { target: { value: '0.29' } });
  expect(submit).toBeEnabled();
});
