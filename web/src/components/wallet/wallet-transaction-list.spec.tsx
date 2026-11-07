import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WalletTransactionList } from './wallet-transaction-list';

vi.mock('@/lib/api/wallet', () => ({
  useWalletTransactions: () => ({ data: { totalPages: 1, total: 2, items: [
    { id: 'deposit-refund', type: 'REFUND', amount: '-12.34', balanceAfter: '87.66',
      createdAt: '2026-11-07T00:00:00Z', description: '充值退款', relatedType: 'deposit_refund' },
    { id: 'internal-refund', type: 'REFUND', amount: '5.00', balanceAfter: '92.66',
      createdAt: '2026-11-07T00:00:00Z', description: '订阅退款', relatedType: 'subscription' },
  ] }, isLoading: false, error: null }),
}));
afterEach(cleanup);
it('按流水符号区分充值退款支出和订阅退款收入', () => {
  render(<WalletTransactionList />);
  expect(screen.getByText('−¥12.34')).toHaveClass('text-danger');
  expect(screen.getByText('+¥5.00')).toHaveClass('text-success');
  expect(screen.queryByText('算力')).not.toBeInTheDocument();
});
