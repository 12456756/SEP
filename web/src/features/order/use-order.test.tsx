import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PaymentResultPage from '@/app/(enterprise)/payment/result/page';
import {
  useCreateDirectOrder,
  useCreateOrder,
  useOrder,
  useOrders,
  usePayOrderWithBalance,
} from './use-order';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('orderId=paid-order'),
  useRouter: () => ({ push: vi.fn() }),
}));

// Matches Prisma JSON: Decimal strings, nested avatar and no subtotal field.
const rawOrder = {
  id: 'paid-order',
  orderNo: '20261010172544874726',
  totalAmount: '30000',
  status: 'PAID',
  createdAt: '2026-10-10T15:25:44Z',
  paidAt: '2026-10-10T15:25:45Z',
  items: [
    {
      id: 'item-1', employeeName: 'Employee One', unitPrice: '12000',
      periodMonths: 6, quantity: 1, includedComputeCNY: '30',
      employee: { avatar: '/employee-one.png', annualPriceCNY: '99999' },
    },
    {
      id: 'item-2', employeeName: 'Employee Two', unitPrice: '24000',
      periodMonths: 12, quantity: 1, includedComputeCNY: '0', employee: { avatar: null },
    },
  ],
};

const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function respond(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => body }));
}

beforeEach(() => respond(structuredClone(rawOrder)));
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

describe('order API normalization', () => {
  it('converts Decimal amounts and calculates subtotals from order snapshots', async () => {
    const { result } = renderHook(() => useOrder('paid-order'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.totalAmount).toBe(30000);
    expect(result.current.data?.items[0]).toMatchObject({
      unitPrice: 12000, subtotal: 6000, employeeAvatar: '/employee-one.png',
    });
    expect(result.current.data?.items[1].subtotal).toBe(24000);
  });

  it('handles fractional prices, periods and historical quantities without inventing zero', async () => {
    respond({ ...rawOrder, totalAmount: '50.05', items: [{
      ...rawOrder.items[0], unitPrice: '100.10', periodMonths: 3, quantity: 2,
    }] });
    const { result } = renderHook(() => useOrder('paid-order'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0].subtotal).toBe(50.05);
  });

  it('uses the actual allocated bundle price stored on each order item', async () => {
    respond({
      ...rawOrder,
      orderType: 'BUNDLE',
      bundleName: 'Operations bundle',
      bundlePriceCNY: '800.00',
      totalAmount: '800.00',
      items: [
        { ...rawOrder.items[0], purchaseAmountCNY: '400.00' },
        { ...rawOrder.items[1], purchaseAmountCNY: '400.00' },
      ],
    });
    const { result } = renderHook(() => useOrder('paid-order'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      orderType: 'BUNDLE',
      bundleName: 'Operations bundle',
      items: [{ subtotal: 400, includedComputeCNY: 30 }, { subtotal: 400, includedComputeCNY: 0 }],
    });
  });

  it('unwraps the paginated list and normalizes each order', async () => {
    respond({ orders: [rawOrder], pagination: { total: 1, page: 1, limit: 20, totalPages: 1 } });
    const { result } = renderHook(() => useOrders(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject([{ totalAmount: 30000, items: [{ subtotal: 6000 }, { subtotal: 24000 }] }]);
  });

  it.each(['cart', 'direct'])('normalizes the %s creation response', async (kind) => {
    const { result } = renderHook(() => ({ cart: useCreateOrder(), direct: useCreateDirectOrder() }), { wrapper: wrapper() });
    await act(async () => {
      const order = kind === 'cart'
        ? await result.current.cart.mutateAsync({ itemIds: ['cart-item'] })
        : await result.current.direct.mutateAsync({ employeeId: 'employee-1' });
      expect(order.totalAmount).toBe(30000);
      expect(order.items[0].subtotal).toBe(6000);
    });
  });

  it('accepts a balance payment receipt without an items relation', async () => {
    const { items: _items, ...receipt } = rawOrder;
    respond(receipt);
    const { result } = renderHook(() => usePayOrderWithBalance(), { wrapper: wrapper() });
    await act(async () => {
      const payment = await result.current.mutateAsync('paid-order');
      expect(payment.totalAmount).toBe(30000);
      expect(payment.status).toBe('PAID');
    });
  });

  it('reports malformed amounts instead of showing a zero subtotal', async () => {
    respond({ ...rawOrder, items: [{ ...rawOrder.items[0], unitPrice: undefined }] });
    const { result } = renderHook(() => useOrder('paid-order'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('payment result page', () => {
  it('renders a paid raw API order without crashing or losing the order ID', async () => {
    render(<PaymentResultPage />, { wrapper: wrapper() });
    expect(await screen.findByRole('heading', { name: '支付成功' })).toBeInTheDocument();
    expect(screen.getByText(rawOrder.orderNo)).toBeInTheDocument();
    expect(screen.getByText('¥30,000')).toBeInTheDocument();
    expect(screen.getByText('¥6,000')).toBeInTheDocument();
    expect(screen.getByText('¥24,000')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Employee One' })).toHaveAttribute('src', '/employee-one.png');
    expect(screen.queryByText('缺少订单号')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/orders/paid-order'), expect.anything());
  });

  it('renders bundle snapshots using the bundle total and allocated employee amounts', async () => {
    respond({
      ...rawOrder,
      orderType: 'BUNDLE',
      bundleName: 'Operations bundle',
      bundlePriceCNY: '800.00',
      totalAmount: '800.00',
      items: [
        { ...rawOrder.items[0], purchaseAmountCNY: '400.00' },
        { ...rawOrder.items[1], purchaseAmountCNY: '400.00' },
      ],
    });
    render(<PaymentResultPage />, { wrapper: wrapper() });
    expect(await screen.findByText('Operations bundle')).toBeInTheDocument();
    expect(screen.getByText('员工套餐')).toBeInTheDocument();
    expect(screen.getByText('¥800')).toBeInTheDocument();
    expect(screen.getAllByText('¥400')).toHaveLength(2);
    expect(screen.getByText('套餐内员工')).toBeInTheDocument();
  });

  it('shows a query error instead of an endless loading state', async () => {
    respond({ message: '订单不存在' }, false);
    render(<PaymentResultPage />, { wrapper: wrapper() });
    expect(await screen.findByText('订单不存在')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新查询' })).toBeInTheDocument();
    expect(screen.queryByText('正在查询支付结果...')).not.toBeInTheDocument();
  });
});
