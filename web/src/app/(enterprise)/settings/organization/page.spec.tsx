import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrganizationPage from './page';
import { useAuthStore } from '@/lib/auth-store';
import { useEnterpriseInfo } from '@/features/enterprise/use-enterprise';

const mocks = vi.hoisted(() => ({ get: vi.fn(), upload: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get }, uploadForm: mocks.upload }));
vi.mock('@/features/enterprise-settings/use-enterprise-settings', () => ({
  useEnterpriseSetting: () => ({ data: undefined }),
}));

function SidebarProbe() {
  const { data } = useEnterpriseInfo();
  return <span data-testid="sidebar-logo">{data?.logo ?? '无 Logo'}</span>;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><OrganizationPage /><SidebarProbe /></QueryClientProvider>);
}
const enterprise = { id: 'e1', name: '示例企业', logo: null };

beforeEach(() => {
  vi.resetAllMocks();
  useAuthStore.setState({ enterprise, roleInEnterprise: 'ENTERPRISE_ADMIN' });
  mocks.get.mockResolvedValue(enterprise);
});

describe('企业 Logo 设置', () => {
  it.each([null, '', '   '])('企业 Logo 为 %s 时展示平台 Logo，仍可上传企业 Logo', async (logo) => {
    mocks.get.mockResolvedValue({ ...enterprise, logo });
    const { container } = setup();
    await screen.findByLabelText('选择企业 Logo');
    expect(container.querySelector('img[src="/yuanji-A-icon.svg"]')).toHaveAttribute('width', '80');
    expect(screen.queryByText('示')).not.toBeInTheDocument();
  });

  it('上传完成后刷新共享企业数据，无需刷新页面', async () => {
    mocks.upload.mockImplementation(async () => {
      mocks.get.mockResolvedValue({ ...enterprise, logo: '/api/enterprise/logo/images/new.png' });
      return { logo: '/api/enterprise/logo/images/new.png' };
    });
    setup();
    const input = await screen.findByLabelText('选择企业 Logo');
    const file = new File(['png'], 'logo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText('企业 Logo 已更新');
    expect(mocks.upload).toHaveBeenCalledWith('/enterprise/logo', expect.any(FormData));
    expect(mocks.upload.mock.calls[0][1].get('file')).toBe(file);
    expect(screen.getByTestId('sidebar-logo')).toHaveTextContent('/api/enterprise/logo/images/new.png');
    expect(screen.getByRole('img', { name: '示例企业' })).toHaveAttribute('src', '/api/enterprise/logo/images/new.png');
  });

  it('普通成员只能查看，没有上传入口', async () => {
    useAuthStore.setState({ roleInEnterprise: 'MEMBER' });
    setup();
    await screen.findByText('企业 Logo 由企业管理员维护。');
    expect(screen.queryByLabelText('选择企业 Logo')).not.toBeInTheDocument();
  });

  it('错误格式和超大文件不会发起上传', async () => {
    setup();
    const input = await screen.findByLabelText('选择企业 Logo');
    fireEvent.change(input, { target: { files: [new File(['svg'], 'logo.svg', { type: 'image/svg+xml' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('请选择 PNG、JPG 或 WebP 图片');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'logo.png', { type: 'image/png' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('不能超过 2 MB');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('上传失败保留原头像并显示错误', async () => {
    mocks.get.mockResolvedValue({ ...enterprise, logo: '/previous.png' });
    mocks.upload.mockRejectedValue(new Error('上传失败'));
    setup();
    const input = await screen.findByLabelText('选择企业 Logo');
    fireEvent.change(input, { target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('上传失败'));
    expect(screen.getByRole('img', { name: '示例企业' })).toHaveAttribute('src', '/previous.png');
    expect(screen.queryByText('企业 Logo 已更新')).not.toBeInTheDocument();
  });
});
