import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentModal } from './payment-modal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);

describe('PaymentModal pricing', () => {
  it('confirms free employees without retaining a previously selected Alipay method', () => {
    const onConfirm = vi.fn();
    const props = { open: true, subscribing: false, onConfirm, onClose: vi.fn() };
    const { rerender } = render(<PaymentModal {...props} emp={{ name: 'Paid Employee', price: 100 }} />);
    fireEvent.click(screen.getByRole('button', { name: '支付宝' }));
    rerender(<PaymentModal {...props} emp={{ name: 'Free Employee', price: 0 }} />);
    expect(screen.queryByText('支付方式')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '免费雇佣' }));
    expect(onConfirm).toHaveBeenCalledWith('balance');
  });

  it.each([null, undefined, -1])('does not treat an invalid price as free: %s', (price) => {
    const onConfirm = vi.fn();
    render(<PaymentModal open emp={{ name: 'Unpriced Employee', price }} subscribing={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    expect(screen.getByText('暂未定价')).toBeInTheDocument();
    expect(screen.queryByText('免费')).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: '暂不可订阅' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('preserves Alipay confirmation for paid employees', () => {
    const onConfirm = vi.fn();
    render(<PaymentModal open emp={{ name: 'Paid Employee', price: 100 }} subscribing={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '支付宝' }));
    fireEvent.click(screen.getByRole('button', { name: '前往支付宝支付' }));
    expect(onConfirm).toHaveBeenCalledWith('alipay');
  });
});
