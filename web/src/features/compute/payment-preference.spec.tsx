import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { PaymentPreferenceControl } from './payment-preference';

vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), patch: vi.fn() } }));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaymentPreferenceControl /></QueryClientProvider>);
}
describe('付款方式选择', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue({ paymentMode: 'AUTO' });
    vi.mocked(api.patch).mockResolvedValue({ paymentMode: 'PERSONAL_ONLY' });
  });
  afterEach(() => { cleanup(); vi.resetAllMocks(); });

  it('loads the saved mode and persists personal-only without sending identity fields', async () => {
    mount();
    expect(await screen.findByRole('radio', { name: '自动选择' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '仅个人余额' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '仅个人余额' })).toBeChecked());
    expect(api.patch).toHaveBeenCalledWith('/compute-credit/payment-preference', { paymentMode: 'PERSONAL_ONLY' });
    expect(screen.getByText(/不扣企业资金或订阅赠送余额/)).toBeInTheDocument();
  });
  it('keeps the saved selection when saving fails and permits retry', async () => {
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('保存暂不可用'));
    mount();
    await screen.findByRole('radio', { name: '自动选择' });
    fireEvent.click(screen.getByRole('radio', { name: '仅个人余额' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存暂不可用');
    expect(screen.getByRole('radio', { name: '自动选择' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '仅个人余额' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '仅个人余额' })).toBeChecked());
  });
  it('does not invent a default if reading fails', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('读取暂不可用'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('读取暂不可用');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
