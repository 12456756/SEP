import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Subscription } from '@/lib/types';
import SubscriptionsPage from './page';

const mocks = vi.hoisted(() => ({ subscriptions: vi.fn() }));
vi.mock('@/lib/auth-store', () => ({
  useAuthStore: () => ({ roleInEnterprise: 'ENTERPRISE_ADMIN' }),
}));
vi.mock('@/features/subscription/use-subscriptions', () => ({
  useSubscriptions: mocks.subscriptions,
  useTerminateSubscription: () => ({ isPending: false, mutate: vi.fn() }),
  useUpdateSubscription: () => ({ isPending: false, mutate: vi.fn() }),
  useChangeSubscriptionStatus: () => ({ isPending: false, mutate: vi.fn() }),
  useUpgradeSubscription: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/features/subscription-request/use-subscription-requests', () => ({
  usePendingSubscriptionRequests: () => ({ data: [], isLoading: false }),
  useAllSubscriptionRequests: () => ({ data: [], isLoading: false }),
  useApproveSubscriptionRequest: () => ({ isPending: false, mutate: vi.fn() }),
  useRejectSubscriptionRequest: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/features/enterprise/grant-panel', () => ({ GrantPanel: () => null }));

function subscription(id: string, status: Subscription['status']): Subscription {
  return {
    id,
    name: `${id}员工`,
    status,
    templateVersion: '1.0.0',
    latestVersion: '1.0.0',
    upgradeAvailable: false,
    config: null,
    startDate: '2026-10-01T00:00:00Z',
    endDate: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    giftGrantedCNY: '0',
    giftUsedCNY: '0',
    giftRemainingCNY: '0',
    giftStatus: 'NONE',
    employee: {
      id: `emp-${id}`,
      name: `${id}员工`,
      description: '',
      avatar: null,
      industry: '通用',
      position: '内容策划',
      functionalCategory: 'OPERATIONS_ORG',
      status: 'APPROVED',
      version: '1.0.0',
      annualPriceCNY: 5000,
    },
    usage: {
      activeUserCount30d: status === 'PAUSED' ? 0 : 1,
      grantedUserCount: 2,
      grantedDepartmentCount: 0,
      grantedMemberCount: 2,
      lastUsedAt: null,
      monthCostCNY: '0',
      monthCallCount: 0,
      executionCount30d: 0,
      successRate30d: 0,
    },
  };
}

const subscriptions = [
  subscription('在岗', 'ACTIVE'),
  subscription('暂停', 'PAUSED'),
  subscription('过期', 'EXPIRED'),
  subscription('终止', 'TERMINATED'),
];

beforeEach(() => {
  mocks.subscriptions.mockReturnValue({ data: subscriptions, isLoading: false });
});

describe('雇佣管理分类', () => {
  it('默认只显示有效雇佣，暂停仍保留在当前列表', () => {
    render(<SubscriptionsPage />);
    expect(screen.getByRole('button', { name: /雇佣中\s*2/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: '在岗员工' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '暂停员工' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '过期员工' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '终止员工' })).not.toBeInTheDocument();
  });

  it('历史分类包含两种终态，保持可读且不提供管理操作', () => {
    render(<SubscriptionsPage />);
    fireEvent.click(screen.getByRole('button', { name: /已解聘\s*2/ }));
    expect(screen.getByRole('link', { name: '过期员工' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '终止员工' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '在岗员工' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '授权' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /更多操作/ })).not.toBeInTheDocument();
  });

  it('搜索在当前分类内生效，清空搜索不会把历史记录混回来', () => {
    render(<SubscriptionsPage />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索雇佣关系' }), {
      target: { value: '  终止  ' },
    });
    expect(screen.getByText('没有匹配的雇佣关系')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /雇佣中\s*2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已解聘\s*2/ }));
    expect(screen.getByRole('link', { name: '终止员工' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '过期员工' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /雇佣中\s*2/ }));
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(screen.getAllByRole('link', { name: /员工$/ })).toHaveLength(2);
    expect(screen.queryByRole('link', { name: '终止员工' })).not.toBeInTheDocument();
  });

  it('仅有历史记录时默认显示当前雇佣为空，仍可切换查阅历史', () => {
    mocks.subscriptions.mockReturnValue({ data: subscriptions.slice(2), isLoading: false });
    render(<SubscriptionsPage />);
    expect(screen.getByText('暂无雇佣中的员工')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /雇佣中\s*0/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已解聘\s*2/ }));
    expect(screen.getByRole('link', { name: '终止员工' })).toBeInTheDocument();
  });

  it('顶部统计只计算当前雇佣，切到历史后统计口径保持一致', () => {
    render(<SubscriptionsPage />);
    const stat = (label: string) => within(screen.getByText(label).parentElement!.parentElement!);
    expect(stat('当前雇佣').getByText('2')).toBeInTheDocument();
    expect(stat('近30天使用').getByText('1')).toBeInTheDocument();
    expect(stat('近30天使用').getByText('50% 使用率')).toBeInTheDocument();
    expect(stat('未使用').getByText('1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已解聘\s*2/ }));
    expect(stat('当前雇佣').getByText('2')).toBeInTheDocument();
    expect(stat('近30天使用').getByText('50% 使用率')).toBeInTheDocument();
  });

  it('雇佣解除后从默认列表移出，保留到历史分类', () => {
    const { rerender } = render(<SubscriptionsPage />);
    mocks.subscriptions.mockReturnValue({
      data: subscriptions.map((sub) => sub.id === '在岗' ? { ...sub, status: 'TERMINATED' } : sub),
      isLoading: false,
    });
    rerender(<SubscriptionsPage />);
    expect(screen.queryByRole('link', { name: '在岗员工' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /雇佣中\s*1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已解聘\s*3/ }));
    expect(screen.getByRole('link', { name: '在岗员工' })).toBeInTheDocument();
  });
});
