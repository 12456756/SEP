import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import { MediaProfileWorkflow } from './media-profile-workflow';
import type { MediaProfile } from './use-media-config';
import videoFixture from '../../../../backend/src/shared/fixtures/media-video-v1.json';
import { MediaVideoProfileSchema } from 'shared/media-video.dto';

vi.mock('@/lib/api-client', () => ({ api: { post: vi.fn(), patch: vi.fn() } }));
const profile: MediaProfile = { profileId: 'explicit-image', displayName: 'New model', kind: 'image', modelId: 'new-model',
  configVersion: 'cfg_1', operations: ['generate'], executionMode: 'sync-response', enabled: false, verified: false,
  capabilities: { sizes: ['2048x2048'], maxOutputs: 1, supportsReferenceImage: false, maxReferenceCount: 0 } };
const mount = (value?: MediaProfile) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
  <MediaProfileWorkflow kind="image" model={{ modelId: 'new-model', displayName: 'New model' }} profile={value} />
</QueryClientProvider>);
const fillSpec = () => {
  fireEvent.change(screen.getByLabelText('尺寸 size'), { target: { value: '2048x2048' } });
  fireEvent.change(screen.getByLabelText('输出数量'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('质量 quality'), { target: { value: 'ultra' } });
};
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

describe('explicit media profile management', () => {
  it('saves separate reference-video limits and formats without changing the image limit', async () => {
    const video = MediaVideoProfileSchema.parse({ ...videoFixture.profile, enabled: false, verified: false });
    vi.mocked(api.patch).mockResolvedValue(video);
    render(<QueryClientProvider client={new QueryClient()}><MediaProfileWorkflow kind="video" model={{ modelId: video.modelId, displayName: video.displayName }} profile={video} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '编辑能力配置' }));
    expect(screen.getByLabelText('视频生视频')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('视频生视频'));
    expect(screen.getByLabelText('单个参考视频上限（MiB）')).toHaveValue(90);
    fireEvent.change(screen.getByLabelText('最多参考视频数量'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('单个参考视频上限（MiB）'), { target: { value: '80' } });
    fireEvent.click(screen.getByLabelText('MOV'));
    fireEvent.click(screen.getByRole('button', { name: '保存能力配置' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/admin/media/video/profiles/${video.profileId}`, expect.objectContaining({
      operations: ['image-to-video', 'video-to-video'], capabilities: expect.objectContaining({ supportsVideoToVideo: true,
        maxVideoReferenceCount: 3, maxVideoReferenceBytes: 80 * 1024 * 1024, videoReferenceMimeTypes: ['video/mp4'],
        maxInputBytes: video.capabilities.maxInputBytes, maxReferenceCount: video.capabilities.maxReferenceCount }),
    })));
  });
  it('saves quality suggestions, reference count and output limit for an auto-discovered image profile', async () => {
    const managed = { ...profile, profileId: 'auto-image-example', operations: ['generate', 'edit'] as MediaProfile['operations'],
      capabilities: { ...profile.capabilities, supportsReferenceImage: true, qualities: ['low', 'high'], maxReferenceCount: 3 } };
    vi.mocked(api.patch).mockResolvedValue(managed);
    mount(managed);
    fireEvent.click(screen.getByRole('button', { name: '编辑能力配置' }));
    expect(screen.getByLabelText('质量选项')).toHaveValue('low, high');
    expect(screen.getByLabelText('最多参考图数量')).toHaveValue(3);
    fireEvent.change(screen.getByLabelText('质量选项'), { target: { value: 'auto,medium,high,high' } });
    fireEvent.change(screen.getByLabelText('最多参考图数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('最大输出数量'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存能力配置' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/media/profiles/auto-image-example', {
      expectedConfigVersion: 'cfg_1', capabilities: { sizes: ['2048x2048'], maxOutputs: 2, supportsReferenceImage: true,
        qualities: ['auto', 'medium', 'high'], maxReferenceCount: 2 },
    }));
  });

  it('clears saved quality suggestions without inventing replacement values', async () => {
    const configured = { ...profile, capabilities: { ...profile.capabilities, qualities: ['high'] } };
    vi.mocked(api.patch).mockResolvedValue(configured);
    mount(configured);
    fireEvent.click(screen.getByRole('button', { name: '编辑能力配置' }));
    fireEvent.change(screen.getByLabelText('质量选项'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存能力配置' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/media/profiles/explicit-image', expect.objectContaining({
      capabilities: { sizes: ['2048x2048'], maxOutputs: 1, supportsReferenceImage: false, qualities: [], maxReferenceCount: 0 },
    })));
  });

  it('creates a disabled profile only after the administrator supplies a model spec and operation', async () => {
    vi.mocked(api.post).mockResolvedValue(profile);
    mount();
    fireEvent.click(screen.getByRole('button', { name: '配置通用 Profile' }));
    fireEvent.change(screen.getByLabelText('Profile ID'), { target: { value: profile.profileId } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: profile.displayName } });
    fireEvent.click(screen.getByLabelText('文生图'));
    fireEvent.change(screen.getByLabelText('支持尺寸'), { target: { value: '2048x2048' } });
    fireEvent.change(screen.getByLabelText('最大输出数量'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '创建停用 Profile' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/media/profiles', expect.objectContaining({
      modelId: 'new-model', enabled: false, operations: ['generate'], capabilities: { sizes: ['2048x2048'], maxOutputs: 1, supportsReferenceImage: false, maxReferenceCount: 0 },
    })));
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('creates one image profile with multiple validated sizes', async () => {
    vi.mocked(api.post).mockResolvedValue(profile);
    mount();
    fireEvent.click(screen.getByRole('button', { name: '配置通用 Profile' }));
    fireEvent.change(screen.getByLabelText('Profile ID'), { target: { value: profile.profileId } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: profile.displayName } });
    fireEvent.click(screen.getByLabelText('文生图'));
    fireEvent.change(screen.getByLabelText('支持尺寸'), { target: { value: '1024x1024, 1536x1024\n1024x1024' } });
    fireEvent.change(screen.getByLabelText('最大输出数量'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '创建停用 Profile' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/media/profiles', expect.objectContaining({
      operations: ['generate'], capabilities: { sizes: ['1024x1024', '1536x1024'], maxOutputs: 2, supportsReferenceImage: false, maxReferenceCount: 0 },
    })));
  });

  it('edits an existing image profile in one request and blocks values beyond the backend limit', async () => {
    vi.mocked(api.patch).mockResolvedValue(profile);
    mount(profile);
    fireEvent.click(screen.getByRole('button', { name: '编辑能力配置' }));
    fireEvent.change(screen.getByLabelText('支持尺寸'), { target: { value: '1024x1024,1536x1024,1024x1536' } });
    fireEvent.click(screen.getByRole('button', { name: '保存能力配置' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/media/profiles/explicit-image', expect.objectContaining({
      expectedConfigVersion: 'cfg_1', capabilities: { sizes: ['1024x1024', '1536x1024', '1024x1536'], maxOutputs: 1, supportsReferenceImage: false, maxReferenceCount: 0 },
    })));

    vi.mocked(api.patch).mockClear();
    fireEvent.click(screen.getByRole('button', { name: '编辑能力配置' }));
    fireEvent.change(screen.getByLabelText('支持尺寸'), { target: { value: Array.from({ length: 33 }, (_, i) => `${i + 1}x${i + 1}`).join(',') } });
    fireEvent.click(screen.getByRole('button', { name: '保存能力配置' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('creates a video profile with multiple values for each list capability', async () => {
    const video = MediaVideoProfileSchema.parse({ ...videoFixture.profile, enabled: false, verified: false });
    vi.mocked(api.post).mockResolvedValue(video);
    render(<QueryClientProvider client={new QueryClient()}><MediaProfileWorkflow kind="video" model={{ modelId: video.modelId, displayName: video.displayName }} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '配置通用 Profile' }));
    fireEvent.change(screen.getByLabelText('Profile ID'), { target: { value: 'custom-video' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Custom video' } });
    fireEvent.click(screen.getByLabelText('文生视频'));
    fireEvent.click(screen.getByLabelText('图生视频'));
    fireEvent.change(screen.getByLabelText('最多参考图数量'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('最短时长（秒）'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('最长时长（秒）'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('支持画幅比例'), { target: { value: '16:9，9:16' } });
    fireEvent.change(screen.getByLabelText('支持分辨率'), { target: { value: '720p,1080p' } });
    fireEvent.change(screen.getByLabelText('支持帧率'), { target: { value: '24,30' } });
    fireEvent.change(screen.getByLabelText('支持输出格式'), { target: { value: 'video/mp4,video/webm' } });
    fireEvent.click(screen.getByLabelText('支持音频'));
    fireEvent.click(screen.getByRole('button', { name: '创建停用 Profile' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/media/video/profiles', expect.objectContaining({
      operations: ['text-to-video', 'image-to-video'],
      capabilities: expect.objectContaining({ durationsSeconds: [5, 10], durationRange: { minimum: 5, maximum: 10 }, aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p'],
        frameRates: [24, 30], outputFormats: ['video/mp4', 'video/webm'], supportsAudio: true, maxReferenceCount: 8 }),
    })));
  });

  it('edits the reference limit of a synchronized image profile and rejects counts above the system cap', async () => {
    const automatic = { ...profile, profileId: 'auto-image-model', operations: ['edit'] as ('edit')[],
      capabilities: { ...profile.capabilities, supportsReferenceImage: true, maxReferenceCount: 4 } };
    vi.mocked(api.patch).mockResolvedValue(automatic);
    mount(automatic);
    fireEvent.click(screen.getByRole('button', { name: '编辑能力配置' }));
    const count = screen.getByLabelText('最多参考图数量');
    expect(count).toHaveValue(4);
    expect(count).toHaveAttribute('max', '32');
    fireEvent.change(count, { target: { value: '33' } });
    fireEvent.submit(screen.getByRole('form', { name: '编辑能力配置' }));
    await screen.findByRole('alert');
    expect(api.patch).not.toHaveBeenCalled();
    fireEvent.change(count, { target: { value: '8' } });
    fireEvent.submit(screen.getByRole('form', { name: '编辑能力配置' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/media/profiles/auto-image-model', expect.objectContaining({
      expectedConfigVersion: 'cfg_1', capabilities: expect.objectContaining({ maxReferenceCount: 8 }),
    })));
  });

  it('edits duration bounds on managed video profiles, keeps fps and blocks an inverted range', async () => {
    const video = MediaVideoProfileSchema.parse({ ...videoFixture.profile, profileId: 'auto-video-range', enabled: false, verified: false,
      capabilities: { ...videoFixture.profile.capabilities, durationRange: { minimum: 4, maximum: 10 } } });
    vi.mocked(api.patch).mockResolvedValue(video);
    render(<QueryClientProvider client={new QueryClient()}><MediaProfileWorkflow kind="video" model={video} profile={video} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '编辑能力配置' }));
    expect(screen.getByLabelText('最短时长（秒）')).toHaveValue(4);
    expect(screen.getByLabelText('最长时长（秒）')).toHaveValue(10);
    expect(screen.getByLabelText('支持帧率')).toHaveValue('24');
    fireEvent.change(screen.getByLabelText('最短时长（秒）'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: '保存能力配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('最长时长不能小于最短时长');
    expect(api.patch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('最长时长（秒）'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: '保存能力配置' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/media/video/profiles/auto-video-range', expect.objectContaining({
      expectedConfigVersion: video.configVersion, capabilities: expect.objectContaining({ durationRange: { minimum: 12, maximum: 15 }, frameRates: [24] }),
    })));
    expect(vi.mocked(api.patch).mock.calls[0][1]).not.toHaveProperty('operations');
  });

  it('uses explicit custom quality for read-only verification without enabling or generating', async () => {
    vi.mocked(api.post).mockResolvedValue({ profile: { ...profile, verified: true }, checkedAt: new Date().toISOString(), executionTested: false });
    mount(profile);
    expect(screen.queryByRole('button', { name: '启用' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '报价校验' }));
    fillSpec();
    fireEvent.click(screen.getByRole('button', { name: '校验报价合同' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/media/profiles/explicit-image/verify', {
      expectedConfigVersion: 'cfg_1', verificationSpec: { size: '2048x2048', count: 1, quality: 'ultra' },
    }));
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('enables only an already verified profile using its current config version', async () => {
    vi.mocked(api.patch).mockResolvedValue({ ...profile, verified: true, enabled: true });
    mount({ ...profile, verified: true });
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/media/profiles/explicit-image', {
      expectedConfigVersion: 'cfg_1', enabled: true,
    }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps optional video fields omitted when verifying only duration and resolution', async () => {
    const video = MediaVideoProfileSchema.parse({ ...videoFixture.profile, enabled: false, verified: false });
    vi.mocked(api.post).mockResolvedValue({ profile: video, checkedAt: new Date().toISOString(), executionTested: false, mock: false });
    render(<QueryClientProvider client={new QueryClient()}><MediaProfileWorkflow kind="video"
      model={{ modelId: video.modelId, displayName: video.displayName }} profile={video} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '报价校验' }));
    expect(screen.getByLabelText('音频')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('时长（秒）'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('分辨率'), { target: { value: '1440p' } });
    fireEvent.click(screen.getByRole('button', { name: '校验报价合同' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/admin/media/video/profiles/${video.profileId}/verify`, {
      expectedConfigVersion: video.configVersion, verificationSpec: { durationSeconds: 12, resolution: '1440p' },
    }));
  });
});
