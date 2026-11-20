import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmployeeCard } from '../employee-card';
import type { MarketEmployee } from '@/lib/types';

const mockEmployee: MarketEmployee = {
  id: 'emp-1',
  name: '数据分析师小王',
  position: '高级数据分析师',
  industry: '金融科技',
  functionalCategory: '数据分析',
  description: '擅长数据挖掘和可视化，精通 Python 和 SQL',
  avatar: '/avatars/analyst.png',
  price: null,
  annualPriceCNY: 50000,
  includedComputeCNY: 0,
  version: '1.2',
  publishedAt: '2026-01-01T00:00:00.000Z',
  isNew: false,
  isHot: true,
  bindings: [
    {
      id: 'bind-1',
      order: 0,
      capability: {
        id: 'cap-1',
        name: 'SQL 查询',
        type: 'AGENT',
        description: 'SQL查询能力',
      },
    },
    {
      id: 'bind-2',
      order: 1,
      capability: {
        id: 'cap-2',
        name: 'Python 分析',
        type: 'RPA',
        description: 'Python分析能力',
      },
    },
  ],
  _count: {
    subscriptions: 42,
  },
};

describe('EmployeeCard', () => {
  it('should render employee basic info', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('数据分析师小王')).toBeInTheDocument();
    expect(screen.getByText(/高级数据分析师/)).toBeInTheDocument();
    expect(screen.getByText(/金融科技/)).toBeInTheDocument();
    expect(screen.getByText('擅长数据挖掘和可视化，精通 Python 和 SQL')).toBeInTheDocument();
  });

  it('should show HOT badge when isHot is true', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('HOT')).toBeInTheDocument();
  });

  it('should show NEW badge when isNew is true', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();
    const newEmployee = { ...mockEmployee, isNew: true, isHot: false };

    render(
      <EmployeeCard
        emp={newEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('NEW')).toBeInTheDocument();
  });

  it('should display annual price correctly', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText(/¥50,000/)).toBeInTheDocument();
    expect(screen.getByText('/年')).toBeInTheDocument();
  });

  it('should show free badge when price is 0', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();
    const freeEmployee = { ...mockEmployee, annualPriceCNY: 0 };

    render(
      <EmployeeCard
        emp={freeEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('免费')).toBeInTheDocument();
  });

  it('disables purchasing an unpriced employee instead of displaying free', () => {
    render(<EmployeeCard emp={{ ...mockEmployee, annualPriceCNY: null }} subscribed={false} loggedIn isAdmin subscribing={false} onSubscribe={vi.fn()} onClick={vi.fn()} onAddToCart={vi.fn()} />);
    expect(screen.getByText('暂未定价')).toBeInTheDocument();
    expect(screen.queryByText('免费')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '订阅' })).toBeDisabled();
    expect(screen.getByTitle('加入购物车')).toBeDisabled();
  });

  it('should show subscription count', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText(/家企业在用/)).toBeInTheDocument();
  });

  it('should show capabilities count', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText(/2 项技能/)).toBeInTheDocument();
  });

  it('should show version', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('v1.2')).toBeInTheDocument();
  });

  it('should call onClick when card is clicked', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    const { container } = render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    const article = container.querySelector('article');
    if (article) {
      fireEvent.click(article);
      expect(onClick).toHaveBeenCalledTimes(1);
    }
  });

  it('should show subscribe button for admin when not subscribed', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    const subscribeBtn = screen.getByRole('button', { name: '订阅' });
    expect(subscribeBtn).toBeInTheDocument();
  });

  it('should call onSubscribe when subscribe button is clicked', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    const subscribeBtn = screen.getByRole('button', { name: '订阅' });
    fireEvent.click(subscribeBtn);

    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled(); // Should stop propagation
  });

  it('should disable subscribe button when subscribing', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={true}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    const subscribeBtn = screen.getByRole('button', { name: '订阅' });
    expect(subscribeBtn).toBeDisabled();
  });

  it('should show manage button when subscribed', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={true}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByRole('link', { name: '管理' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '订阅' })).not.toBeInTheDocument();
  });

  it('should show subscribed badge when subscribed', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={true}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('✓ 已入职')).toBeInTheDocument();
  });

  it('should show add to cart button when onAddToCart provided', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();
    const onAddToCart = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
        onAddToCart={onAddToCart}
      />,
    );

    const cartButtons = screen.getAllByRole('button');
    const cartBtn = cartButtons.find((btn) => btn.getAttribute('title') === '加入购物车');
    expect(cartBtn).toBeInTheDocument();
  });

  it('should call onAddToCart when cart button is clicked', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();
    const onAddToCart = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
        onAddToCart={onAddToCart}
      />,
    );

    const cartButtons = screen.getAllByRole('button');
    const cartBtn = cartButtons.find((btn) => btn.getAttribute('title') === '加入购物车');
    if (cartBtn) {
      fireEvent.click(cartBtn);
      expect(onAddToCart).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    }
  });

  it('should show apply button for non-admin member when not granted', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={false}
        grantedToMe={false}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByRole('button', { name: '申请使用' })).toBeInTheDocument();
  });

  it('should show use button for non-admin member when granted', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={false}
        grantedToMe={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByRole('link', { name: '使用' })).toBeInTheDocument();
  });

  it('should show subscribe button for admin even when not logged in', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();

    render(
      <EmployeeCard
        emp={mockEmployee}
        subscribed={false}
        loggedIn={false}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    // When loggedIn=false but isAdmin=true, the component still shows subscribe button
    // because the admin check comes before the login check in the conditional logic
    expect(screen.getByRole('button', { name: '订阅' })).toBeInTheDocument();
  });

  it('should handle empty bindings array', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();
    const noBindingsEmployee = { ...mockEmployee, bindings: [] };

    render(
      <EmployeeCard
        emp={noBindingsEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText(/0 项技能/)).toBeInTheDocument();
  });

  it('should handle missing description', () => {
    const onSubscribe = vi.fn();
    const onClick = vi.fn();
    const noDescEmployee = { ...mockEmployee, description: '' };

    render(
      <EmployeeCard
        emp={noDescEmployee}
        subscribed={false}
        loggedIn={true}
        isAdmin={true}
        subscribing={false}
        onSubscribe={onSubscribe}
        onClick={onClick}
      />,
    );

    expect(screen.getByText('暂无描述')).toBeInTheDocument();
  });
});
