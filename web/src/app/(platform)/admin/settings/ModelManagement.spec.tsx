import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import type { PlatformModel } from '@/features/model/use-models';
import ModelManagement from './ModelManagement';

vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const active: PlatformModel = {
  id: 'upstream-1', modelId: 'vendorx-model-alpha', label: 'VendorX Alpha', enabled: false,
  sortOrder: 1, lastSeenAt: '2026-10-27', isStale: false, hasPricing: true,
  isFree: false,
  createdAt: '2026-10-27', updatedAt: '2026-10-27',
};
const retired: PlatformModel = {
  ...active, id: 'history-1', modelId: 'claude-retired', label: 'Retired model', isStale: true,
};
const syncResult = { upstreamTotal: 1, added: 0, restored: 0, staled: 1 };
let client: QueryClient;

function mount() {
  // Simulate a catalog cached from a previous admin visit, including historical rows.
  client.setQueryData(['models', 'all'], [{ ...retired, isStale: false }]);
  return render(<QueryClientProvider client={client}><ModelManagement /></QueryClientProvider>);
}
const synchronize = () => fireEvent.click(screen.getByRole('button', { name: '同步上游' }));

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(api.get).mockResolvedValue([active, retired]);
  vi.mocked(api.post).mockResolvedValue(syncResult);
});
afterEach(() => { cleanup(); client.clear(); });

describe('ModelManagement upstream catalog', () => {
  it('does not request or display the database catalog before synchronization', () => {
    mount();
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.getByText('尚未同步上游模型')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Retired model')).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('fetches the updated catalog after sync and hides historical models and their vendor filters', async () => {
    mount();
    synchronize();
    await screen.findByText('VendorX Alpha');
    expect(api.post).toHaveBeenCalledWith('/models/sync');
    expect(api.get).toHaveBeenCalledWith('/models');
    expect(screen.queryByText('Retired model')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Anthropic' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '已下架' })).not.toBeInTheDocument();
    expect(screen.getByText('显示 1 / 1 个上游模型')).toBeInTheDocument();
  });

  it('waits for the fresh catalog instead of flashing cached rows after the sync response', async () => {
    let finish!: (models: PlatformModel[]) => void;
    vi.mocked(api.get).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mount();
    synchronize();
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '同步中...' })).toBeDisabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Retired model')).not.toBeInTheDocument();
    await act(async () => finish([active, retired]));
    await screen.findByText('VendorX Alpha');
  });

  it('keeps the catalog hidden when upstream sync fails and allows retry', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('上游不可用'));
    mount();
    synchronize();
    expect(await screen.findByRole('alert')).toHaveTextContent('上游不可用');
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    synchronize();
    await screen.findByText('VendorX Alpha');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps cached data hidden when reading the refreshed catalog fails', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('目录读取失败'));
    mount();
    synchronize();
    expect(await screen.findByRole('alert')).toHaveTextContent('目录读取失败');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Retired model')).not.toBeInTheDocument();
  });

  it('distinguishes a successful empty upstream from an unsynchronized page', async () => {
    vi.mocked(api.post).mockResolvedValue({ ...syncResult, upstreamTotal: 0 });
    vi.mocked(api.get).mockResolvedValue([retired]);
    mount();
    synchronize();
    await screen.findByText('上游暂未返回模型，可稍后重新同步');
    expect(screen.queryByText('尚未同步上游模型')).not.toBeInTheDocument();
    expect(screen.queryByText('Retired model')).not.toBeInTheDocument();
  });

  it('keeps search, enablement filters, toggling and model tests working on current upstream rows', async () => {
    const enabled = { ...active, enabled: true };
    vi.mocked(api.patch).mockResolvedValue(enabled);
    vi.mocked(api.get).mockResolvedValueOnce([active, retired]).mockResolvedValue([enabled, retired]);
    mount();
    synchronize();
    await screen.findByText('VendorX Alpha');
    fireEvent.change(screen.getByLabelText('搜索上游模型'), { target: { value: 'missing' } });
    expect(screen.getByText('没有符合条件的模型')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索上游模型'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 VendorX Alpha' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/models/upstream-1', { enabled: true }));
    const testButton = await screen.findByRole('button', { name: '测试 VendorX Alpha' });
    vi.mocked(api.post).mockResolvedValueOnce({ success: true, latency: 100, response: 'OK' });
    fireEvent.click(testButton);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/models/upstream-1/test'));
    fireEvent.change(screen.getByLabelText('筛选启用状态'), { target: { value: 'disabled' } });
    expect(screen.getByText('没有符合条件的模型')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('筛选启用状态'), { target: { value: 'enabled' } });
    expect(screen.getByText('VendorX Alpha')).toBeInTheDocument();
  });

  it('updates the per-model free campaign setting independently from model enablement', async () => {
    mount();
    synchronize();
    await screen.findByText('VendorX Alpha');

    fireEvent.click(screen.getByRole('checkbox', { name: '活动免费 VendorX Alpha' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/models/upstream-1', { isFree: true }));
    expect(api.patch).not.toHaveBeenCalledWith('/models/upstream-1', { enabled: true });
  });

  it('turns an existing free campaign off and keeps the checkbox unchanged when saving fails', async () => {
    const free = { ...active, isFree: true };
    vi.mocked(api.get).mockResolvedValue([free, retired]);
    mount();
    synchronize();
    await screen.findByText('VendorX Alpha');

    const checkbox = screen.getByRole('checkbox', { name: '活动免费 VendorX Alpha' });
    expect(checkbox).toBeChecked();
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('保存失败'));
    fireEvent.click(checkbox);

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/models/upstream-1', { isFree: false }));
    expect(checkbox).toBeChecked();
  });

  it('replaces the prior catalog and clears filters when upstream is synchronized again', async () => {
    mount();
    synchronize();
    await screen.findByText('VendorX Alpha');
    fireEvent.change(screen.getByLabelText('搜索上游模型'), { target: { value: 'alpha' } });
    vi.mocked(api.get).mockResolvedValueOnce([{ ...active, id: 'new-1', modelId: 'vendorx-beta', label: 'VendorX Beta' }, { ...active, isStale: true }]);
    synchronize();
    await screen.findByText('VendorX Beta');
    expect(screen.queryByText('VendorX Alpha')).not.toBeInTheDocument();
    expect(screen.getByLabelText('搜索上游模型')).toHaveValue('');
  });
});
