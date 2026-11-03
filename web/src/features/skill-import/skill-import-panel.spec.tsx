import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { SkillImportPanel } from './skill-import-panel';
import { safeClientDeepLink, skillImportIdentity } from './use-skill-import';
import type { SkillImportSession } from './types';

vi.mock('@/lib/api-client', async (load) => {
  const actual = await load<typeof import('@/lib/api-client')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
const remove = vi.mocked(api.delete);
const artifact = { zipPath: 'skills/test.zip', sha256: 'a'.repeat(64), fileCount: 2, totalSize: 24, filename: 'test.zip', content: '# test', suggested: { name: '测试技能', description: '测试描述' }, warnings: [] };
const pairing = { pairingId: 'pair_1', keyFingerprint: 'b'.repeat(64), shortCode: '123456', label: '我的电脑', platform: 'macOS', clientVersion: '1.0.0', expiresAt: new Date(Date.now() + 300000).toISOString(), webConfirmed: false };
const base: SkillImportSession = { id: 'session_1', status: 'waiting-client', version: 1, protocolVersion: 1, instanceId: 'instance_1', expiresAt: new Date(Date.now() + 1800000).toISOString(), idleExpiresAt: new Date(Date.now() + 600000).toISOString(), deepLink: 'sep-import://skills/v1?instanceId=instance_1&sessionId=session_1', artifactReady: false, candidateCount: 0, progress: null, pairings: [], operation: null };
const candidate = { candidateId: 'candidate_1', revision: 1, name: '测试技能', description: '测试描述', sources: ['Claude'], scope: 'user', locations: [{ rootId: 'root_1', rootLabel: 'Claude Skills', relativePath: 'test' }], treeHash: 'c'.repeat(64), availability: 'previewable', warnings: [] };

function mount(onArtifact = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><SkillImportPanel onArtifact={onArtifact} onZipFile={vi.fn()} zipBusy={false} zipError={null} zipArtifact={null} /></QueryClientProvider>);
  return { ...view, client, onArtifact };
}
async function startScan() {
  await waitFor(() => expect(screen.getByRole('button', { name: '扫描本机' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '扫描本机' }));
}
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setAuth({ token: 'token', user: { id: 'admin', email: 'admin@example.com', name: null, avatar: null, role: 'ADMIN' }, enterprise: null, roleInEnterprise: null });
  remove.mockResolvedValue(undefined);
});
afterEach(() => { useAuthStore.getState().clear(); });

describe('本机 Skills 导入', () => {
  it('确认指纹配对，轮询异步预览并读取全部文件页，按 operationId 交付一次完整包', async () => {
    let confirmed = false;
    let requestId = '';
    let operationId = '';
    let previewReads = 0;
    let operationReads = 0;
    const status = () => ({ ...base, status: confirmed ? 'results' : 'pairing', pairings: [{ ...pairing, webConfirmed: confirmed }], candidateCount: confirmed ? 1 : 0 });
    post.mockImplementation(async (path, body) => {
      if (path === '/skill-import/sessions') return base;
      if (path.endsWith('/confirm-device')) { confirmed = true; return {}; }
      if (path.endsWith('/preview')) { requestId = (body as { requestId: string }).requestId; return { requestId }; }
      if (path.endsWith('/selection')) { operationId = (body as { operationId: string }).operationId; return {}; }
      throw new Error(`Unexpected POST ${path}`);
    });
    get.mockImplementation(async (path) => {
      if (path.endsWith('/config')) return { enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' };
      const url = new URL(path, 'https://example.com');
      const view = url.searchParams.get('view');
      if (view === 'status') return status();
      if (view === 'candidates') return { ...status(), items: [candidate], nextCursor: null };
      if (view === 'preview') {
        expect(url.searchParams.get('candidateId')).toBe(candidate.candidateId);
        expect(url.searchParams.get('requestId')).toBe(requestId);
        const ready = ++previewReads > 1;
        return { ...status(), previewStatus: ready ? 'ready' : 'pending', errorCode: null, preview: ready ? { requestId, candidateId: candidate.candidateId, snapshotId: 'snapshot_1', expiresAt: new Date(Date.now() + 120000).toISOString(), content: '# test', treeHash: candidate.treeHash, fileCount: 2, totalUncompressedBytes: 24, estimatedPackageBytes: 32, files: [{ relativePath: 'SKILL.md', bytes: 6 }], nextFilesCursor: 'page_2', warnings: [] } : null };
      }
      if (view === 'files') {
        expect(url.searchParams.get('snapshotId')).toBe('snapshot_1');
        expect(url.searchParams.get('cursor')).toBe('page_2');
        return { snapshotId: 'snapshot_1', files: [{ relativePath: 'scripts/test.js', bytes: 18 }], nextFilesCursor: null };
      }
      if (view === 'operation') {
        expect(url.searchParams.get('operationId')).toBe(operationId);
        const done = ++operationReads > 1;
        return { ...status(), status: done ? 'uploaded' : 'uploading', operation: { operationId, status: done ? 'succeeded' : 'processing', retryable: false, sha256: done ? artifact.sha256 : null, errorCode: null, expiresAt: base.expiresAt }, artifact: done ? artifact : null };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const { onArtifact, client } = mount();
    await startScan();
    expect(await screen.findByText(`设备指纹：${pairing.keyFingerprint}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '与客户端一致，确认设备' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/skill-import/sessions/session_1/confirm-device', { pairingId: pairing.pairingId, keyFingerprint: pairing.keyFingerprint, shortCode: pairing.shortCode }, expect.anything()));
    fireEvent.click(await screen.findByRole('button', { name: /测试技能/ }));
    expect(await screen.findByLabelText('SKILL.md 预览', {}, { timeout: 5000 })).toHaveValue('# test');
    await waitFor(() => expect(screen.getByRole('button', { name: '导入所选技能' })).toBeEnabled());
    expect(screen.getByText('scripts/test.js · 18 B')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入所选技能' }));
    await waitFor(() => expect(onArtifact).toHaveBeenCalledWith(artifact), { timeout: 5000 });
    await act(async () => { await client.invalidateQueries({ queryKey: ['skill-import', 'admin', 'session_1', 'operation'] }); });
    expect(onArtifact.mock.calls.filter(([value]) => value !== null)).toHaveLength(1);
    expect(post.mock.calls.filter(([path]) => path.endsWith('/selection'))).toHaveLength(1);
  }, 15000);

  it('取消会话时删除服务端授权并清空产物，不再轮询', async () => {
    get.mockImplementation(async (path) => path.endsWith('/config') ? { enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' } : base);
    post.mockResolvedValue(base);
    const { onArtifact } = mount();
    await startScan();
    fireEvent.click(await screen.findByRole('button', { name: '取消扫描' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/skill-import/sessions/session_1', { keepalive: true }));
    expect(screen.queryByRole('button', { name: '打开 SEP 客户端' })).not.toBeInTheDocument();
    expect(onArtifact).toHaveBeenLastCalledWith(null);
  });

  it('到期会话禁用导入并停止状态请求', async () => {
    get.mockResolvedValue({ enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' });
    post.mockResolvedValue({ ...base, status: 'expired', expiresAt: new Date(Date.now() - 1000).toISOString() });
    mount(); await startScan();
    expect(await screen.findByText('会话已过期')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开 SEP 客户端' })).not.toBeInTheDocument();
    expect(get.mock.calls.every(([path]) => path === '/skill-import/config')).toBe(true);
  });

  it('重新扫描取消结果未知时保留旧会话 ID，取消确认前不创建新会话', async () => {
    get.mockImplementation(async (path) => path.endsWith('/config') ? { enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' } : base);
    post.mockResolvedValue(base);
    remove.mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValue(undefined);
    mount(); await startScan();
    fireEvent.click(await screen.findByRole('button', { name: '重新扫描' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('旧会话取消失败');
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '扫描本机' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(remove.mock.calls.slice(0, 2)).toEqual([
      ['/skill-import/sessions/session_1', { keepalive: true }],
      ['/skill-import/sessions/session_1', { keepalive: true }],
    ]);
  });

  it('功能关闭时保留 ZIP 上传回退且不创建会话', async () => {
    get.mockResolvedValue({ enabled: false, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' });
    mount();
    expect(await screen.findByText('本机扫描暂未开放，请使用 ZIP 上传')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '扫描本机' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '扫描本机' }));
    expect(post).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'ZIP 上传' }), { button: 0, ctrlKey: false });
    expect(screen.getByLabelText('Zip 文件（必须包含 SKILL.md）')).toBeInTheDocument();
  });

  it('拒绝含凭证、额外参数或错误会话的客户端链接', () => {
    expect(safeClientDeepLink(base)).toBe(base.deepLink);
    expect(safeClientDeepLink({ ...base, deepLink: `${base.deepLink}&token=secret` })).toBeNull();
    expect(safeClientDeepLink({ ...base, deepLink: base.deepLink.replace('session_1', 'session_2') })).toBeNull();
    expect(safeClientDeepLink({ ...base, deepLink: base.deepLink.replace('skills/', 'user@skills/') })).toBeNull();
    expect(safeClientDeepLink({ ...base, deepLink: `${base.deepLink}#secret` })).toBeNull();
    expect(safeClientDeepLink({ ...base, deepLink: base.deepLink.replace('skills/', 'skills:999/') })).toBeNull();
    expect(safeClientDeepLink({ ...base, deepLink: 'javascript:alert(1)' })).toBeNull();
  });

  it('同账号切换登录会话时取消旧导入；同 sid 刷新 token 保持身份', async () => {
    const jwt = (sid: string, iat: number) => `header.${btoa(JSON.stringify({ sid, iat }))}.signature`;
    expect(skillImportIdentity('admin', jwt('one', 1))).toBe(skillImportIdentity('admin', jwt('one', 2)));
    get.mockImplementation(async (path) => path.endsWith('/config') ? { enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' } : base);
    post.mockResolvedValue(base);
    const { onArtifact } = mount();
    await startScan();
    await screen.findByRole('button', { name: '取消扫描' });
    act(() => { useAuthStore.setState({ token: jwt('another-session', 2) }); });
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/skill-import/sessions/session_1', { keepalive: true }));
    expect(screen.queryByRole('button', { name: '取消扫描' })).not.toBeInTheDocument();
    expect(onArtifact).toHaveBeenLastCalledWith(null);
    act(() => { useAuthStore.setState({ token: 'token' }); });
    expect(screen.queryByRole('button', { name: '取消扫描' })).not.toBeInTheDocument();
  });

  it('配置加载失败时禁止扫描，提示 ZIP 回退且不创建会话', async () => {
    get.mockRejectedValue(new TypeError('Offline'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('扫描配置加载失败，请使用 ZIP 上传');
    expect(screen.getByRole('button', { name: '扫描本机' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('分页加载已授权设备，可撤销第二页旧设备并刷新设备列表', async () => {
    let revoked = false;
    const device = (deviceId: string, label: string) => ({ deviceId, label, keyFingerprint: 'd'.repeat(64), platform: 'macOS', clientVersion: '1.0.0', lastSeenAt: null, createdAt: new Date().toISOString() });
    get.mockImplementation(async (path) => {
      if (path.endsWith('/config')) return { enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' };
      const params = new URL(path, 'https://example.com').searchParams;
      expect(params.get('limit')).toBe('25');
      return params.get('cursor') === 'device_1' ? { items: revoked ? [] : [device('device_old', '旧电脑')], nextCursor: null } : { items: [device('device_1', '新电脑')], nextCursor: 'device_1' };
    });
    remove.mockImplementation(async (path) => { expect(path).toBe('/skill-import/devices/device_old'); revoked = true; });
    mount();
    const summary = await screen.findByText('已授权设备');
    fireEvent.click(summary);
    expect(await screen.findByText('新电脑 · macOS')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载更多设备' }));
    fireEvent.click(await screen.findByRole('button', { name: '撤销 旧电脑' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/skill-import/devices/device_old'));
    await waitFor(() => expect(screen.queryByRole('button', { name: '撤销 旧电脑' })).not.toBeInTheDocument());
    expect(get.mock.calls.some(([path]) => path === '/skill-import/devices?limit=25&cursor=device_1')).toBe(true);
  });
});
