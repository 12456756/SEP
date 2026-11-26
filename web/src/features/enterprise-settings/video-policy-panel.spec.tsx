import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { MediaVideoPolicySchema, MediaVideoAvailableProfileSchema } from 'shared/media-video-config.dto';
import fixture from '../../../../backend/src/shared/fixtures/media-video-v1.json';
import { VideoPolicyPanel } from './video-policy-panel';

vi.mock('@/lib/api-client', async (original) => ({ ...await original<typeof import('@/lib/api-client')>(), api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { modelId: _modelId, ...raw } = fixture.profile;
const profile = MediaVideoAvailableProfileSchema.parse({ ...raw, enabled: true, verified: true });
const policy = MediaVideoPolicySchema.parse({ enabledProfileIds: [profile.profileId, 'removed-video'], defaultProfileId: 'removed-video' });
function mockConfig(canEdit = true) {
  vi.mocked(api.get).mockImplementation(async (path) => path === '/enterprise/media-config/video'
    ? { policy, canEdit, configured: true, mock: true, executionTested: false } : [profile]);
}
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><VideoPolicyPanel /></QueryClientProvider>);
}
afterEach(() => { cleanup(); useAuthStore.getState().clear(); });
beforeEach(() => {
  vi.resetAllMocks();
  useAuthStore.getState().setAuth({ token: 'mock', user: { id: 'a', email: 'a@example.invalid', name: '视频管理员', avatar: null, role: 'USER' }, enterprise: { id: 'a', name: '视频企业' }, roleInEnterprise: 'ENTERPRISE_ADMIN' });
  mockConfig();
  vi.mocked(api.put).mockResolvedValue({ policy, configured: true, canEdit: true, mock: true, executionTested: false });
});

describe('video policy panel', () => {
  it('hides legacy video restriction fields and saves only profile authorization', async () => {
    renderPanel();
    await screen.findByLabelText('默认视频 Profile');
    for (const label of ['视频最高分辨率', '新增授权画幅', '视频最大时长（秒）', '视频最大并发任务']) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('允许的视频操作')).not.toBeInTheDocument();
    expect(screen.queryByText('允许的视频画幅')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'removed-video（不可用）' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '保存视频策略' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/enterprise/media-config/video', {
      enabledProfileIds: policy.enabledProfileIds, defaultProfileId: policy.defaultProfileId,
    }));
  });

  it('previews a disjoint policy without blocking save, and invalidates the result on edit', async () => {
    vi.mocked(api.post).mockResolvedValue({
      protocolVersion: 2, executionMode: 'mock', configured: true, executionAvailable: false,
      defaultProfileId: policy.defaultProfileId, defaultProfileValid: false,
      profiles: [{ profileId: profile.profileId, configVersion: profile.configVersion, status: 'empty-intersection', effectiveProfile: null, reasons: ['aspect-ratio-intersection-empty'] }],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '预览当前授权' }));
    expect(await screen.findByText('授权画幅与当前能力没有交集')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存视频策略' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /removed-video/ }));
    expect(screen.queryByLabelText('授权预览结果')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存视频策略' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  });

  it('hides a late preview after switching enterprise', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.post).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '预览当前授权' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '保存视频策略' })).toBeEnabled();
    act(() => useAuthStore.setState({ enterprise: { id: 'b', name: '其他企业' } }));
    await screen.findByRole('button', { name: '保存视频策略' });
    await act(async () => { reject(new ApiError(503, '旧企业预览失败')); });
    expect(screen.queryByText(/旧企业预览失败/)).not.toBeInTheDocument();
  });
  it('removes unavailable selections, clears their default and saves specs to video only', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('checkbox', { name: /removed-video/ }));
    expect(screen.getByLabelText('默认视频 Profile')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '保存视频策略' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/enterprise/media-config/video', { enabledProfileIds: [profile.profileId], defaultProfileId: null }));
  });
  it.each(['MEMBER', 'DEPT_MANAGER'])('keeps %s read only even when server canEdit is true', async (roleInEnterprise) => {
    useAuthStore.setState({ roleInEnterprise });
    renderPanel();
    await screen.findByText('当前为只读视图，视频授权由企业管理员维护。');
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
    expect(screen.getByLabelText('默认视频 Profile')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '保存视频策略' })).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('form', { name: '视频授权策略' }));
    expect(api.put).not.toHaveBeenCalled();
  });
  it('respects server canEdit=false', async () => {
    mockConfig(false);
    renderPanel();
    await screen.findByText('当前为只读视图，视频授权由企业管理员维护。');
    expect(screen.getByLabelText('默认视频 Profile')).toBeDisabled();
  });
  it('keeps form values after a save error', async () => {
    vi.mocked(api.put).mockRejectedValue(new ApiError(400, '视频策略不合法'));
    renderPanel();
    const profileCheckbox = await screen.findByRole('checkbox', { name: /mock-video-from-image/ });
    fireEvent.click(profileCheckbox);
    fireEvent.click(screen.getByRole('button', { name: '保存视频策略' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('视频策略不合法');
    expect(screen.getByRole('checkbox', { name: /mock-video-from-image/ })).not.toBeChecked();
  });
  it('shows loading, failure and supports retry', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, '视频服务未开放'));
    renderPanel();
    expect(screen.getByRole('status', { name: '加载视频授权' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('视频服务未开放');
    mockConfig();
    fireEvent.click(screen.getByRole('button', { name: '重试视频授权' }));
    await screen.findByRole('button', { name: '保存视频策略' });
  });
  it('shows an unconfigured empty state', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => path === '/enterprise/media-config/video' ? { policy: MediaVideoPolicySchema.parse({}), canEdit: true, configured: false, mock: true, executionTested: false } : []);
    renderPanel();
    await screen.findByText('暂无已启用且已校验的视频 Profile');
    expect(screen.getByText('本企业视频 Key 尚未就绪。')).toBeInTheDocument();
  });
  it('keeps old video policy fields hidden and omits them from updates', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => path === '/enterprise/media-config/video'
      ? { policy: MediaVideoPolicySchema.parse({ periodBudget: 0, maxConcurrentJobs: 2 }), canEdit: true, configured: true, mock: false, executionTested: false }
      : [profile]);
    vi.mocked(api.put).mockResolvedValue({ policy, configured: true, canEdit: true, mock: false, executionTested: false });
    renderPanel();
    expect(await screen.findByText('真实视频')).toBeInTheDocument();
    expect(screen.queryByText('视频自然月预算（元）')).not.toBeInTheDocument();
    expect(screen.queryByText(/并发任务由服务端限制/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存视频策略' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/enterprise/media-config/video', {
      enabledProfileIds: [], defaultProfileId: null,
    }));
  });
});
