import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api-client';
import { VideoModelsPanel } from './video-models-panel';
import fixture from 'shared/fixtures/media-video-v1.json';

vi.mock('@/lib/api-client', async (original) => ({ ...await original<typeof import('@/lib/api-client')>(), api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const profile = { ...fixture.profile, profileId: 'video-demo', displayName: 'Demo', modelId: 'mock-video-v1', configVersion: 'v1', enabled: true, verified: true };
const candidate = { modelId: profile.modelId, displayName: profile.displayName, compatible: true, reason: null, suggested: null };
const discovery = { checkedAt: new Date().toISOString(), mock: true, executionTested: false, models: [candidate, { ...candidate, modelId: 'vendor-new-video', displayName: 'New vendor model', compatible: false, reason: '未知适配', suggested: null }] };
function renderPanel() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}><VideoModelsPanel /></QueryClientProvider>); }
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockImplementation(async (path) => path.endsWith('/connection') ? { baseUrl: 'https://video.example/v1', apiKeyConfigured: true, configured: true, source: 'database' } : [profile]); vi.mocked(api.post).mockResolvedValue(discovery); vi.mocked(api.put).mockResolvedValue({ baseUrl: 'https://video.example/v1', apiKeyConfigured: true, configured: true }); vi.mocked(api.patch).mockResolvedValue({ ...profile, enabled: false }); });

describe('video unified model panel', () => {
  it('shows connection and discovered models read-only and does not auto-authorize enterprise', async () => {
    renderPanel();
    expect(await screen.findByText('Demo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '检测并同步' }));
    expect(await screen.findByText('New vendor model')).toBeInTheDocument();
    expect(screen.getByText('目录候选，尚未验证')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置通用 Profile' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '编辑能力配置' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '导入' })).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/admin/media/video/models/discover', {});
    expect(api.put).not.toHaveBeenCalled();
  });
  it('allows emergency disable without exposing an enable control', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '紧急停用' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/media/video/profiles/video-demo', { expectedConfigVersion: 'v1', enabled: false }));
  });
  it('lets operators repair a failed connection read with a new complete pair', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => { if (path.endsWith('/connection')) throw new ApiError(503, '连接配置不可用'); return [profile]; });
    renderPanel();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('可填写完整新连接后保存'));
    const url = screen.getByLabelText('Base URL'); const key = screen.getByLabelText(/API Key/);
    fireEvent.change(url, { target: { value: 'https://fixed.example/v1' } }); fireEvent.change(key, { target: { value: 'brand-new-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存连接' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/media/video/connection', { baseUrl: 'https://fixed.example/v1', apiKey: 'brand-new-key' }));
    expect(JSON.stringify(vi.mocked(api.put).mock.calls)).not.toContain('•••');
  });
});
