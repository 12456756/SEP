import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/auth-store';
import { SkillForm } from './skill-form';

const { push, success, error } = vi.hoisted(() => ({ push: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { success, error } }));
const metadata = { zipPath: 'skills/abc.zip', sha256: 'a'.repeat(64), fileCount: 4, totalSize: 8192, filename: '测试.ZIP', content: '---\nname: complete\n---\n# 完整 SKILL.md 正文' };
const fetchMock = vi.fn();
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function mount() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><SkillForm onCancel={vi.fn()} /></QueryClientProvider>);
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'ZIP 上传' }), { button: 0, ctrlKey: false });
}
async function upload() {
  fireEvent.change(screen.getByLabelText('Zip 文件（必须包含 SKILL.md）'), { target: { files: [new File(['zip'], metadata.filename, { type: 'application/zip' })] } });
  await screen.findByText(`文件: ${metadata.filename}`);
}
function fill() {
  fireEvent.change(screen.getByLabelText('能力名称'), { target: { value: '测试技能' } });
  fireEvent.change(screen.getByLabelText('能力描述'), { target: { value: '完整上传包并保留正文的测试技能说明' } });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', (path: string, options?: RequestInit) => path === '/api/skill-import/config'
    ? Promise.resolve(response({ enabled: false, instanceId: 'test', protocolVersion: 1, minClientVersion: '1.0.0' }))
    : fetchMock(path, options));
  useAuthStore.getState().setAuth({ token: 'ops-memory-token', user: { id: 'ops', name: '运营', email: 'ops@example.com', avatar: null, role: 'ADMIN' }, enterprise: null, roleInEnterprise: null });
  fetchMock.mockImplementation(async (path: string) => response(path.endsWith('upload-skill') ? metadata : { id: 'created-cap' }));
});
afterEach(() => { useAuthStore.getState().clear(); vi.unstubAllGlobals(); });
describe('ops SKILL 首次创建认证契约', () => {
  it('兼容提示不阻断创建，自动补全名称描述且不展示包内路径', async () => {
    const suggested = { name: '抖音文案提取', description: '提取视频中的文字内容' };
    fetchMock.mockImplementation(async (path: string) => response(path.endsWith('upload-skill') ? {
      ...metadata,
      suggested,
      warnings: [
        { code: 'MISSING_REFERENCE', message: '部分文档引用未找到，已保留原包', path: 'dyextract/private-script.py' },
        { code: 'MISSING_REFERENCE', message: '部分文档引用未找到，已保留原包', path: 'other/script.py' },
      ],
    } : { id: 'created-cap' }));
    mount(); await upload();
    expect(screen.getByLabelText('能力名称')).toHaveValue(suggested.name);
    expect(screen.getByLabelText('能力描述')).toHaveValue(suggested.description);
    expect(screen.getAllByText('部分文档引用未找到，已保留原包')).toHaveLength(1);
    expect(screen.queryByText(/dyextract\/private-script\.py|other\/script\.py/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并进入平台待审' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '创建并进入平台待审' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills'));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject(suggested);
  });
  it('上传返回推荐信息时保留用户已输入的字段', async () => {
    fetchMock.mockResolvedValue(response({ ...metadata, suggested: { name: '推荐名称', description: '推荐描述' } }));
    mount(); fill(); await upload();
    expect(screen.getByLabelText('能力名称')).toHaveValue('测试技能');
    expect(screen.getByLabelText('能力描述')).toHaveValue('完整上传包并保留正文的测试技能说明');
  });
  it('只补全空白字段，兼容缺少推荐信息和提示的旧上传响应', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...metadata, suggested: { name: '推荐名称', description: '推荐描述' } }));
    mount();
    fireEvent.change(screen.getByLabelText('能力名称'), { target: { value: '自定义名称' } });
    await upload();
    expect(screen.getByLabelText('能力名称')).toHaveValue('自定义名称');
    expect(screen.getByLabelText('能力描述')).toHaveValue('推荐描述');
    expect(screen.queryByRole('list', { name: '导入提示' })).not.toBeInTheDocument();
    await upload();
    expect(screen.getByLabelText('能力名称')).toHaveValue('自定义名称');
    expect(screen.getByLabelText('能力描述')).toHaveValue('推荐描述');
  });
  it.each([
    { name: '测试技能', description: '短描述' },
    { name: 'a'.repeat(100), description: 'x'.repeat(2000) },
  ])('接受能力名称和描述预算边界 %o', async (values) => {
    mount(); await upload();
    fireEvent.change(screen.getByLabelText('能力名称'), { target: { value: values.name } });
    fireEvent.change(screen.getByLabelText('能力描述'), { target: { value: values.description } });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入平台待审' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills'));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject(values);
    expect(screen.getByLabelText('能力名称')).toHaveAttribute('maxLength', '100');
    expect(screen.getByLabelText('能力描述')).toHaveAttribute('maxLength', '2000');
  });
  it.each([
    { name: ' ', description: '短描述' },
    { name: '测试技能', description: ' \n ' },
    { name: 'a'.repeat(101), description: '短描述' },
    { name: '测试技能', description: 'x'.repeat(2001) },
  ])('拒绝空白和超出能力预算的字段 %o', async (values) => {
    mount(); await upload();
    fireEvent.change(screen.getByLabelText('能力名称'), { target: { value: values.name } });
    fireEvent.change(screen.getByLabelText('能力描述'), { target: { value: values.description } });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入平台待审' }));
    await waitFor(() => expect(document.querySelector('p.text-red-600')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
  it('上传和 generic 创建均带内存 token，完整传包 metadata 和首版正文，进入待审', async () => {
    mount(); fill(); await upload();
    fireEvent.click(screen.getByRole('button', { name: '创建并进入平台待审' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [uploadPath, uploadOptions] = fetchMock.mock.calls[0];
    expect(uploadPath).toBe('/api/admin/capabilities/upload-skill');
    expect(uploadOptions).toMatchObject({ method: 'POST', credentials: 'include', headers: { Authorization: 'Bearer ops-memory-token' } });
    expect(uploadOptions.headers['Content-Type']).toBeUndefined();
    expect(uploadOptions.body).toBeInstanceOf(FormData);
    const [createPath, createOptions] = fetchMock.mock.calls[1];
    expect(createPath).toBe('/api/capabilities');
    expect(createOptions).toMatchObject({ method: 'POST', credentials: 'include', headers: { Authorization: 'Bearer ops-memory-token', 'Content-Type': 'application/json' } });
    expect(JSON.parse(createOptions.body)).toMatchObject({ type: 'skill', name: '测试技能', metadata: { zipPath: metadata.zipPath, sha256: metadata.sha256, fileCount: 4, totalSize: 8192, filename: metadata.filename }, skillConfig: { template: metadata.content } });
    expect(success).toHaveBeenCalledWith('创建成功', '技能已进入平台待审，审核通过后才会公开');
    expect(fetchMock.mock.calls.some(([path]) => /approve|review/.test(path))).toBe(false);
  });
  it('不按文件名后缀拦截上传，由后端识别文件内容', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Zip 文件（必须包含 SKILL.md）'), {
      target: { files: [new File(['zip'], 'skill-package.bin', { type: 'application/zip' })] },
    });
    await screen.findByText(`文件: ${metadata.filename}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('上传 403 时不能创建，没有无认证备用请求', async () => {
    fetchMock.mockResolvedValue(response({ message: '仅平台管理员可上传' }, 403));
    mount(); fill();
    fireEvent.change(screen.getByLabelText('Zip 文件（必须包含 SKILL.md）'), { target: { files: [new File(['zip'], 'skill.zip')] } });
    expect(await screen.findByText('仅平台管理员可上传')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并进入平台待审' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
  it('创建 403 保留已上传包并提示，不导航或发布', async () => {
    fetchMock.mockImplementation(async (path: string) => path.endsWith('upload-skill') ? response(metadata) : response({ message: '仅平台管理员可创建 SKILL' }, 403));
    mount(); fill(); await upload();
    fireEvent.click(screen.getByRole('button', { name: '创建并进入平台待审' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('创建失败', '仅平台管理员可创建 SKILL'));
    expect(screen.getByText(`文件: ${metadata.filename}`)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('创建响应未知时保留包、禁止重复提交，提示先去列表核对', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path.endsWith('upload-skill')) return response(metadata);
      throw new TypeError('Failed to fetch');
    });
    mount(); fill(); await upload();
    fireEvent.click(screen.getByRole('button', { name: '创建并进入平台待审' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('创建结果尚未确认');
    expect(screen.getByRole('button', { name: '创建并进入平台待审' })).toBeDisabled();
    expect(screen.getByText(`文件: ${metadata.filename}`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });
});
