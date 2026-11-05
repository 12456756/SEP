import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthorVersion, useContributionAction, useCreateContribution, useCreateVersion, useReviewContribution, useSubmitVersion, useUpdateVersion, useUploadRpaPackage, useUploadSkillPackage, useVersionDiff } from './use-contributions';

const { get, post, uploadForm } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), uploadForm: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get, post }, uploadForm }));
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => { vi.clearAllMocks(); post.mockResolvedValue({}); get.mockResolvedValue({}); uploadForm.mockResolvedValue({ sha256: 'a'.repeat(64) }); });
describe('贡献 SKILL no-write guards', () => {
  it('旧上传、创建、编辑、新版本、提交 hook 全部本地拒绝，不发写请求', async () => {
    const { result } = renderHook(() => ({ create: useCreateContribution(), upload: useUploadSkillPackage(), version: useCreateVersion('cap'), edit: useUpdateVersion('cap'), submit: useSubmitVersion('cap') }), { wrapper });
    await act(async () => {
      await expect(result.current.create.mutateAsync({ type: 'skill' })).rejects.toThrow('运营后台');
      await expect(result.current.upload.mutateAsync(new File(['zip'], 'skill.zip'))).rejects.toThrow('客户端');
      await expect(result.current.version.mutateAsync({ changeSummary: '正文替换', content: '# 绕过' })).rejects.toThrow('客户端');
      await expect(result.current.edit.mutateAsync({ versionId: 'v1', content: '# 绕过' })).rejects.toThrow('客户端');
      await expect(result.current.submit.mutateAsync('v1')).rejects.toThrow('客户端');
    });
    expect(post).not.toHaveBeenCalled(); expect(uploadForm).not.toHaveBeenCalled();
  });
  it.each(['submit-enterprise-review', 'request-platform-review', 'authorize-platform-submission'] as const)('SKILL %s 被拒绝，RPA 同动作保留', async (action) => {
    const { result } = renderHook(() => ({ skill: useContributionAction(action, 'SKILL'), rpa: useContributionAction(action, 'RPA') }), { wrapper });
    await act(async () => {
      await expect(result.current.skill.mutateAsync('cap')).rejects.toThrow('不再');
      expect(post).not.toHaveBeenCalled();
      await result.current.rpa.mutateAsync('rpa-cap');
    });
    expect(post).toHaveBeenCalledWith(`/contributions/rpa-cap/${action}`);
  });
  it('SKILL generic 企业审核不可调用，RPA 精确参数和 403 均透传', async () => {
    const { result } = renderHook(() => ({ skill: useReviewContribution('enterprise', 'SKILL'), rpa: useReviewContribution('enterprise', 'RPA') }), { wrapper });
    await act(async () => {
      await expect(result.current.skill.mutateAsync({ id: 'skill', decision: 'APPROVE' })).rejects.toThrow('技能版本');
      expect(post).not.toHaveBeenCalled();
      await result.current.rpa.mutateAsync({ id: 'rpa', decision: 'REJECT', comment: '说明不足' });
      post.mockRejectedValueOnce(new Error('403 无权审核'));
      await expect(result.current.rpa.mutateAsync({ id: 'rpa', decision: 'APPROVE' })).rejects.toThrow('403');
    });
    expect(post).toHaveBeenCalledWith('/contributions/rpa/enterprise-review', { decision: 'REJECT', comment: '说明不足' });
  });
  it('RPA 包上传和 schema 校验后的创建保留', async () => {
    const { result } = renderHook(() => ({ upload: useUploadRpaPackage(), create: useCreateContribution() }), { wrapper });
    await act(async () => {
      await result.current.upload.mutateAsync(new File(['zip'], 'rpa.zip'));
      await result.current.create.mutateAsync({ name: '测试 RPA', description: '足够长的自动化能力说明', type: 'rpa', industry: [], position: [], rpaConfig: { platform: 'shizai', executionMode: 'download', packageSha256: 'a'.repeat(64), configDoc: '完整的使用与环境说明' } });
    });
    expect(uploadForm).toHaveBeenCalledWith('/contributions/rpa-package', expect.any(FormData));
    expect(post).toHaveBeenCalledWith('/contributions', expect.objectContaining({ type: 'rpa' }));
  });
  it('运营 RPA 创建使用受保护的直接送审端点', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    const localWrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCreateContribution({ submitToPlatformReview: true }), { wrapper: localWrapper });
    await act(async () => {
      await result.current.mutateAsync({ name: '测试 RPA', description: '自动归档发票', type: 'rpa', industry: [], position: [], rpaConfig: { platform: 'shizai', executionMode: 'download', packageSha256: 'a'.repeat(64), configDoc: '完整的使用与环境说明' } });
    });
    expect(post).toHaveBeenCalledWith('/admin/contributions/rpa', expect.objectContaining({ type: 'rpa' }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['capabilities'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['admin', 'contributions'] });
  });
  it('已有版本正文和差异仍可读取', async () => {
    const { result } = renderHook(() => ({ author: useAuthorVersion('v1'), diff: useVersionDiff('v1') }), { wrapper });
    await waitFor(() => expect(result.current.author.isSuccess && result.current.diff.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/contributions/versions/v1');
    expect(get).toHaveBeenCalledWith('/contributions/versions/v1/diff');
    expect(post).not.toHaveBeenCalled();
  });
});
