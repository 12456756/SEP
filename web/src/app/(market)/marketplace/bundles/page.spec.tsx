import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MarketplaceBundlesPage from './page';

const { state } = vi.hoisted(() => ({ state: { bundles: [] as unknown[] } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/auth-store', () => ({ useAuthStore: () => ({ token: null, hydrated: true, roleInEnterprise: null }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/features/order/use-order', () => ({
  useCreateAlipayPayment: () => ({ mutateAsync: vi.fn() }),
  useCreateBundleOrder: () => ({ mutateAsync: vi.fn() }),
  usePayOrderWithBalance: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/features/employee-bundle/use-employee-bundles', () => ({
  usePublishedEmployeeBundles: () => ({ data: state.bundles, isLoading: false }),
}));

beforeEach(() => {
  state.bundles = [{
    id: 'bundle-1', code: 'MARKETING', name: '营销套餐', description: '营销团队组合', cover: null,
    status: 'PUBLISHED', priceCNY: '1000', periodMonths: 12, originalAmountCNY: '3000',
    discountCNY: '2000', totalComputeCNY: '300', publishedAt: null, createdAt: '', updatedAt: '',
    items: Array.from({ length: 33 }, (_, index) => ({
      id: `item-${index + 1}`, employeeId: `employee-${index + 1}`, employeeName: `员工${index + 1}`,
      employeeAvatar: null, employeeVersion: '1.0.0', unitPrice: '100', periodMonths: 12,
      subtotal: '90', includedComputeCNY: '10',
    })),
  }];
});

describe('市场套餐列表', () => {
  it('默认折叠长员工名单，并提供可访问的展开和收起操作', () => {
    render(<MarketplaceBundlesPage />);
    expect(screen.getByText('员工1')).toBeInTheDocument();
    expect(screen.getByText('员工5')).toBeInTheDocument();
    expect(screen.queryByText('员工6')).not.toBeInTheDocument();

    const expand = screen.getByRole('button', { name: '展开剩余 28 位员工' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);

    expect(screen.getByText('员工33')).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: '收起员工列表' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapse);
    expect(screen.queryByText('员工6')).not.toBeInTheDocument();
  });
});
