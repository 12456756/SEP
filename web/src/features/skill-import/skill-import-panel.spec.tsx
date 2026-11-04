import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { SkillImportPanel } from './skill-import-panel';
import { safeClientDeepLink, skillImportIdentity } from './use-skill-import';
import type { SkillImportSession } from './types';

vi.mock('@/lib/api-client', async (load) => {
  const actual = await load<typeof import('@/lib/api-client')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});
vi.mock('@/config/use-client-release', () => ({
  useClientRelease: () => ({ release: null, loading: false }),
}));
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
const remove = vi.mocked(api.delete);
const artifact = { zipPath: 'skills/test.zip', sha256: 'a'.repeat(64), fileCount: 2, totalSize: 24, filename: 'test.zip', content: '# test', suggested: { name: '测试技能', description: '测试描述' }, warnings: [] };
const pairing = { pairingId: 'pair_1', keyFingerprint: 'b'.repeat(64), shortCode: '123456', label: '我的电脑', platform: 'macOS', clientVersion: '1.0.0', expiresAt: new Date(Date.now() + 300000).toISOString(), webConfirmed: false };
const base: SkillImportSession = { id: 'session_1', status: 'waiting-client', version: 1, protocolVersion: 1, instanceId: 'instance_1', expiresAt: new Date(Date.now() + 1800000).toISOString(), idleExpiresAt: new Date(Date.now() + 600000).toISOString(), deepLink: 'sep-import://skills/v1?instanceId=instance_1&sessionId=session_1', artifactReady: false, candidateCount: 0, progress: null, pairings: [], operation: null };
const candidate = { candidateId: 'candidate_1', revision: 1, name: '测试技能', description: '测试描述', sources: ['Claude'], scope: 'user', locations: [{ rootId: 'root_1', rootLabel: 'Claude Skills', relativePath: 'test' }], treeHash: 'c'.repeat(64), availability: 'previewable', warnings: [] };

function mount(onArtifact = vi.fn(), onArtifacts = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><SkillImportPanel onArtifact={onArtifact} onArtifacts={onArtifacts} onZipFile={vi.fn()} zipBusy={false} zipError={null} zipArtifact={null} /></QueryClientProvider>);
  return { ...view, client, onArtifact };
}
async function startScan() {
  await waitFor(() => expect(screen.getByRole('button', { name: '扫描本机' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '扫描本机' }));
}
function readyImport(options: { fileError?: (cursor: string | null) => Error | null; fileWait?: (cursor: string | null) => Promise<void>; pageCount?: number } = {}) {
  let requestId = '';
  let operationId = '';
  const results = { ...base, status: 'results', candidateCount: 1 };
  post.mockImplementation(async (path, body) => {
    if (path === '/skill-import/sessions') return base;
    if (path.endsWith('/preview')) { requestId = (body as { requestId: string }).requestId; return {}; }
    if (path.endsWith('/selection')) { operationId = (body as { operationId: string }).operationId; return {}; }
    throw new Error(`Unexpected POST ${path}`);
  });
  get.mockImplementation(async (path) => {
    if (path.endsWith('/config')) return { enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' };
    if (path.startsWith('/skill-import/devices')) return { items: [{ deviceId: 'device_1', label: '我的电脑', keyFingerprint: pairing.keyFingerprint, platform: 'macOS', clientVersion: '1.0.0', lastSeenAt: null, createdAt: new Date().toISOString() }], nextCursor: null };
    const params = new URL(path, 'https://example.com').searchParams;
    if (params.get('view') === 'status') return results;
    if (params.get('view') === 'candidates') return { ...results, items: [candidate], nextCursor: null };
    if (params.get('view') === 'preview') return { ...results, previewStatus: 'ready', errorCode: null, preview: { requestId, candidateId: candidate.candidateId, snapshotId: 'snapshot_retry', expiresAt: new Date(Date.now() + 120000).toISOString(), content: '# test', treeHash: candidate.treeHash, fileCount: options.pageCount ?? 2, totalUncompressedBytes: 6 + ((options.pageCount ?? 2) - 1) * 18, estimatedPackageBytes: 32, files: [{ relativePath: 'SKILL.md', bytes: 6 }], nextFilesCursor: options.pageCount === 1 ? null : 'page_2', warnings: [] } };
    if (params.get('view') === 'files') {
      const cursor = params.get('cursor');
      await options.fileWait?.(cursor);
      const error = options.fileError?.(cursor);
      if (error) throw error;
      return { snapshotId: 'snapshot_retry', files: [{ relativePath: cursor === 'page_3' ? 'scripts/second.js' : 'scripts/test.js', bytes: 18 }], nextFilesCursor: options.pageCount === 3 && cursor === 'page_2' ? 'page_3' : null };
    }
    if (params.get('view') === 'operation') return { ...results, status: 'uploaded', operation: { operationId, status: 'succeeded', retryable: false, sha256: artifact.sha256, errorCode: null, expiresAt: base.expiresAt }, artifact };
    throw new Error(`Unexpected GET ${path}`);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setAuth({ token: 'token', user: { id: 'admin', email: 'admin@example.com', name: null, avatar: null, role: 'ADMIN' }, enterprise: null, roleInEnterprise: null });
  remove.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useAuthStore.getState().clear(); });

describe('本机 Skills 导入', () => {
  it.each([['opencode', 'OpenCode'], ['workbuddy', 'WorkBuddy'], ['doubao-work', '豆包办公']])('扫描范围后提供 Agent 选项，切换 %s 从第一页查询并保留搜索词', async (agentSource, agentLabel) => {
    readyImport();
    const fallback = get.getMockImplementation()!;
    get.mockImplementation(async (path, options) => {
      const params = new URL(path, 'https://example.com').searchParams;
      if (params.get('view') !== 'candidates') return fallback(path, options);
      const source = params.get('source');
      const cursor = params.get('cursor');
      const item = { ...candidate, name: source ? `${agentLabel} 技能` : cursor ? '第二页技能' : '第一页技能', sources: [source || 'agents'] };
      return { ...base, status: 'results', items: [item], nextCursor: !source && !cursor ? 'all-page-2' : null };
    });
    mount();
    const scope = screen.getByRole('combobox', { name: '扫描范围' });
    const agent = screen.getByRole('combobox', { name: 'Agent 来源' });
    expect(scope.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Array.from((agent as HTMLSelectElement).options).map(option => option.text)).toEqual(['全部 Agent', '共享 Skills', 'Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'WorkBuddy', '豆包办公', 'CodeBuddy', 'Qoder', 'Qwen Code', 'Kimi Code', '项目通用 Skills']);
    await startScan();
    await screen.findByRole('button', { name: /第一页技能/ });
    fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), { target: { value: '技能' } });
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByRole('button', { name: /第二页技能/ });
    fireEvent.change(agent, { target: { value: agentSource } });
    await screen.findByRole('button', { name: new RegExp(`${agentLabel} 技能`) });
    const queries = get.mock.calls.map(([path]) => new URL(path, 'https://example.com').searchParams).filter(params => params.get('view') === 'candidates' && params.get('source') === agentSource);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(params => !params.has('cursor') && params.get('q') === '技能')).toBe(true);
    expect(screen.queryByRole('button', { name: /第二页技能/ })).not.toBeInTheDocument();
    expect(screen.getByText(`${agentLabel} · 用户级`)).toBeInTheDocument();
    expect(scope).toHaveValue('user');
  });

  it.each(['取消', '切换身份', '撤销设备'])('已交付结果自然过期后保留，%s仍会清空', async (action) => {
    readyImport({ pageCount: 1 });
    const { onArtifact } = mount();
    await startScan();
    fireEvent.click(await screen.findByRole('button', { name: /测试技能/ }));
    fireEvent.click(await screen.findByRole('button', { name: '导入所选技能' }));
    await waitFor(() => expect(onArtifact).toHaveBeenLastCalledWith(artifact));
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(base.expiresAt) + 1000);
    await waitFor(() => expect(screen.getByText('会话已过期')).toBeInTheDocument(), { timeout: 2500 });
    expect(onArtifact).toHaveBeenLastCalledWith(artifact);
    if (action === '取消') fireEvent.click(screen.getByRole('button', { name: '取消扫描' }));
    if (action === '切换身份') act(() => { useAuthStore.setState({ token: `header.${btoa(JSON.stringify({ sid: 'new-session' }))}.signature` }); });
    if (action === '撤销设备') {
      fireEvent.click(screen.getByText('已授权设备'));
      fireEvent.click(await screen.findByRole('button', { name: '撤销 我的电脑' }));
    }
    await waitFor(() => expect(onArtifact).toHaveBeenLastCalledWith(null));
  });

  it('文件分页遇到429后遵守Retry-After重试并恢复导入', async () => {
    const attempts: number[] = [];
    readyImport({ fileError: () => { attempts.push(Date.now()); return attempts.length === 1 ? new ApiError(429, '限流', undefined, 3) : null; } });
    mount(); await startScan();
    fireEvent.click(await screen.findByRole('button', { name: /测试技能/ }));
    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(screen.getByRole('button', { name: '导入所选技能' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: '导入所选技能' })).toBeEnabled(), { timeout: 5000 });
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(3000);
    expect(screen.getByText('scripts/test.js · 18 B')).toBeInTheDocument();
  }, 10000);

  it('文件分页失败可以手动恢复；授权错误不自动或手动重试', async () => {
    let failed = true;
    readyImport({ pageCount: 3, fileError: (cursor) => cursor === 'page_3' && failed ? new ApiError(400, '文件页暂不可用') : null });
    const { client } = mount(); await startScan();
    fireEvent.click(await screen.findByRole('button', { name: /测试技能/ }));
    const retry = await screen.findByRole('button', { name: '重试文件清单' });
    expect(retry).toBeEnabled();
    failed = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: '导入所选技能' })).toBeEnabled());
    expect(screen.getByText('scripts/test.js · 18 B')).toBeInTheDocument();
    expect(screen.getByText('scripts/second.js · 18 B')).toBeInTheDocument();
    readyImport({ fileError: () => new ApiError(403, '授权已撤销') });
    await act(async () => { await client.invalidateQueries({ queryKey: ['skill-import', 'admin', 'session_1', 'files'] }); });
    expect(await screen.findByRole('button', { name: '重试文件清单' })).toBeDisabled();
    const requests = get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '重试文件清单' }));
    expect(get.mock.calls).toHaveLength(requests);
  });

  it('文件分页自动重试次数有界，耗尽后可手动继续同一页', async () => {
    let attempts = 0;
    let unavailable = true;
    readyImport({ fileError: () => { attempts += 1; return unavailable ? new ApiError(503, '服务暂不可用') : null; } });
    mount(); await startScan();
    fireEvent.click(await screen.findByRole('button', { name: /测试技能/ }));
    const retry = await screen.findByRole('button', { name: '重试文件清单' }, { timeout: 9000 });
    expect(attempts).toBe(3);
    expect(retry).toBeEnabled();
    unavailable = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: '导入所选技能' })).toBeEnabled());
    expect(attempts).toBe(4);
  }, 12000);

  it.each(['快照过期', '会话过期', '会话终态'])('文件页迟到时%s不再自动请求后续页', async (reason) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    readyImport({ pageCount: 3, fileWait: (cursor) => cursor === 'page_2' ? pending : Promise.resolve() });
    const { client } = mount(); await startScan();
    fireEvent.click(await screen.findByRole('button', { name: /测试技能/ }));
    await waitFor(() => expect(get.mock.calls.some(([path]) => path.includes('view=files'))).toBe(true));
    if (reason === '会话终态') {
      act(() => { client.setQueryData(['skill-import', 'admin', 'session_1', 'status'], { ...base, status: 'uploaded' }); });
      await screen.findByText('已上传，待创建');
    } else {
      vi.spyOn(Date, 'now').mockReturnValue(reason === '快照过期' ? Date.now() + 121000 : Date.parse(base.expiresAt) + 1000);
      await screen.findByText(reason === '快照过期' ? '预览已过期，请重新选择技能' : '会话已过期', {}, { timeout: 2500 });
    }
    await act(async () => { release(); await pending; });
    await screen.findByText('scripts/test.js · 18 B');
    expect(get.mock.calls.filter(([path]) => path.includes('view=files'))).toHaveLength(1);
  });

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

  it('跨页多选按顺序导入，部分失败后只重试失败项', async () => {
    const candidates = [
      { ...candidate, candidateId: 'candidate_1', name: '技能一' },
      { ...candidate, candidateId: 'candidate_2', name: '技能二' },
    ];
    const operations = new Map<string, string>();
    const attempts = new Map<string, number>();
    const artifacts = new Map(candidates.map((item) => [item.candidateId, {
      ...artifact,
      zipPath: `skills/${item.candidateId}.zip`,
      filename: `${item.candidateId}.zip`,
      sha256: item.candidateId === 'candidate_1' ? '1'.repeat(64) : '2'.repeat(64),
      suggested: { name: item.name, description: `${item.name}描述` },
    }]));
    post.mockImplementation(async (path, body) => {
      if (path === '/skill-import/sessions') return base;
      if (path.endsWith('/preview') || path.endsWith('/selection')) {
        const input = body as { candidateId: string; operationId?: string };
        if (path.endsWith('/selection')) {
          operations.set(input.operationId!, input.candidateId);
          attempts.set(input.candidateId, (attempts.get(input.candidateId) ?? 0) + 1);
        }
        return {};
      }
      throw new Error(`Unexpected POST ${path}`);
    });
    get.mockImplementation(async (path) => {
      if (path.endsWith('/config')) return { enabled: true, instanceId: base.instanceId, protocolVersion: 1, minClientVersion: '1.0.0' };
      if (path.startsWith('/skill-import/devices')) return { items: [], nextCursor: null };
      const url = new URL(path, 'https://example.com');
      const view = url.searchParams.get('view');
      if (view === 'status') return { ...base, status: 'results', candidateCount: candidates.length };
      if (view === 'candidates') {
        const filtered = Boolean(url.searchParams.get('source'));
        const hasCursor = Boolean(url.searchParams.get('cursor'));
        return { ...base, status: 'results', items: filtered ? [] : hasCursor ? [candidates[1]] : [candidates[0]], nextCursor: filtered || hasCursor ? null : 'page_2' };
      }
      if (view === 'preview') {
        const candidateId = url.searchParams.get('candidateId')!;
        return { ...base, status: 'results', previewStatus: 'ready', errorCode: null, preview: {
          requestId: url.searchParams.get('requestId'), candidateId, snapshotId: `snapshot_${candidateId}`,
          expiresAt: new Date(Date.now() + 120000).toISOString(), content: '# Skill', treeHash: candidate.treeHash,
          fileCount: 1, totalUncompressedBytes: 6, estimatedPackageBytes: 32,
          files: [{ relativePath: 'SKILL.md', bytes: 6 }], nextFilesCursor: null, warnings: [],
        } };
      }
      if (view === 'operation') {
        const operationId = url.searchParams.get('operationId')!;
        const candidateId = operations.get(operationId)!;
        const succeeded = candidateId !== 'candidate_1' || attempts.get(candidateId)! > 1;
        return { ...base, status: succeeded ? 'uploaded' : 'failed', operation: {
          operationId, status: succeeded ? 'succeeded' : 'failed', retryable: false,
          sha256: succeeded ? artifacts.get(candidateId)!.sha256 : null,
          errorCode: succeeded ? null : 'PACKAGE_REJECTED', expiresAt: base.expiresAt,
        }, artifact: succeeded ? artifacts.get(candidateId) : null };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    const onArtifacts = vi.fn();
    mount(vi.fn(), onArtifacts);
    await startScan();
    await screen.findByRole('checkbox', { name: '选择 技能一' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 技能一' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent 来源' }), { target: { value: 'opencode' } });
    await waitFor(() => expect(screen.getByText('已选 1 / 20')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '移除已选 技能一' }));
    expect(screen.getByText('已选 0 / 20')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent 来源' }), { target: { value: '' } });
    await screen.findByRole('checkbox', { name: '选择 技能一' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByRole('checkbox', { name: '选择 技能二' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 技能一' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 技能二' }));
    expect(screen.getByText('已选 2 / 20')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '逐个导入已选' }));

    await screen.findByText('失败：PACKAGE_REJECTED');
    await screen.findByText('已上传');
    expect(onArtifacts).toHaveBeenLastCalledWith([{ candidateId: 'candidate_2', candidateName: '技能二', artifact: artifacts.get('candidate_2') }]);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getAllByText('已上传')).toHaveLength(2));
    expect(post.mock.calls.filter(([path]) => path.endsWith('/selection')).map(([, body]) => (body as { candidateId: string }).candidateId)).toEqual(['candidate_1', 'candidate_2', 'candidate_1']);
    expect(onArtifacts).toHaveBeenLastCalledWith([{ candidateId: 'candidate_1', candidateName: '技能一', artifact: artifacts.get('candidate_1') }]);
    expect(screen.getByText('已选 0 / 20')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '逐个导入已选' })).toBeDisabled();
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
    expect(screen.getByLabelText('技能压缩包（必须包含 SKILL.md）')).toBeInTheDocument();
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
