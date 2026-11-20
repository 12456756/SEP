import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckoutPage from './page';

const state = vi.hoisted(() => ({
  items: [] as Array<{ id: string; employeeName: string; employeeAvatar: null; unitPrice: number; subtotal: number; includedComputeCNY: number; periodMonths: number }>,
  selected: null as string | null,
  create: vi.fn(), pay: vi.fn(), alipay: vi.fn(), push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: state.push }),
  useSearchParams: () => ({ get: () => state.selected }),
}));
vi.mock('@/features/cart/use-cart', () => ({ useCart: () => ({
  isLoading: false,
  data: { items: state.items, itemCount: state.items.length, totalAmount: state.items.reduce((sum, item) => sum + item.subtotal, 0), totalIncludedCompute: 0 },
}) }));
vi.mock('@/features/order/use-order', () => ({
  useCreateOrder: () => ({ mutateAsync: state.create }),
  usePayOrderWithBalance: () => ({ mutateAsync: state.pay }),
  useCreateAlipayPayment: () => ({ mutateAsync: state.alipay }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.selected = null;
  state.items = [{ id: 'free', employeeName: 'Free Employee', employeeAvatar: null, unitPrice: 0, subtotal: 0, includedComputeCNY: 0, periodMonths: 12 }];
  state.create.mockResolvedValue({ id: 'free-order', orderNo: 'FREE1', totalAmount: 0 });
  state.pay.mockResolvedValue({ status: 'PAID' });
});

describe('free employee checkout', () => {
  it('opens a zero order without presenting or calling Alipay', async () => {
    render(<CheckoutPage />);
    expect(screen.queryByText('选择支付方式')).not.toBeInTheDocument();
    expect(screen.queryByText('支付宝')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '免费雇佣' }));
    await waitFor(() => expect(state.pay).toHaveBeenCalledWith('free-order'));
    expect(state.alipay).not.toHaveBeenCalled();
    expect(state.push).toHaveBeenCalledWith('/payment/result?orderId=free-order&status=success');
  });

  it('treats a selected free item as free even when paid items remain in the cart', () => {
    state.items.push({ ...state.items[0], id: 'paid', employeeName: 'Paid Employee', unitPrice: 100, subtotal: 100 });
    state.selected = 'free';
    render(<CheckoutPage />);
    expect(screen.getByRole('button', { name: '免费雇佣' })).toBeEnabled();
    expect(screen.queryByText('Paid Employee')).not.toBeInTheDocument();
  });

  it('charges only the server order amount for mixed free and paid employees', async () => {
    state.items.push({ ...state.items[0], id: 'paid', employeeName: 'Paid Employee', unitPrice: 100, subtotal: 100 });
    state.create.mockResolvedValue({ id: 'mixed-order', orderNo: 'MIX1', totalAmount: 100 });
    render(<CheckoutPage />);
    expect(screen.getByText('选择支付方式')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即支付' }));
    await waitFor(() => expect(state.pay).toHaveBeenCalledWith('mixed-order'));
    expect(state.alipay).not.toHaveBeenCalled();
  });
});
