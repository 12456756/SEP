import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContributionCreateDialog } from './contribution-create-dialog';
import type { RpaPackageParseResult } from '../../../../backend/src/shared';

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

const createMutation = vi.fn();
const useCreateContributionMock = vi.fn((_options?: unknown) => ({ mutate: createMutation, isPending: false }));
const uploadMutation = vi.fn();
const uploadRpaMutation = vi.fn();

vi.mock('./use-contributions', () => ({
  useCreateContribution: (options?: unknown) => useCreateContributionMock(options),
  useUploadSkillPackage: () => ({ mutate: uploadMutation, isPending: false }),
  useUploadRpaPackage: () => ({ mutateAsync: uploadRpaMutation, isPending: false }),
}));

vi.mock('@/lib/auth-store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ enterprise: { id: 'e1', name: '示例企业' } }),
}));

const RPA_PARSED: RpaPackageParseResult = {
  sha256: 'c'.repeat(64),
  filename: 'invoice-rpa.zip',
  fileCount: 4,
  totalBytes: 2048,
  uncompressedBytes: 4096,
  files: ['main.exe'],
};

function renderDialog(props?: Partial<React.ComponentProps<typeof ContributionCreateDialog>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContributionCreateDialog open onOpenChange={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

function goToContentStep() {
  fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
}

async function goToInfoStep() {
  goToContentStep();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['rpa'], 'invoice-rpa.zip', { type: 'application/zip' })] } });
  await screen.findByText('invoice-rpa.zip');
  fireEvent.change(screen.getByPlaceholderText(/账号\/环境要求/), { target: { value: '需要安装客户端并配置目录后使用' } });
  fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
  fireEvent.change(screen.getByPlaceholderText(/竞品周报生成器/), { target: { value: '发票 RPA' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('创建能力贡献', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    createMutation.mockReset();
    useCreateContributionMock.mockClear();
    uploadMutation.mockReset();
    uploadRpaMutation.mockReset();
    uploadRpaMutation.mockResolvedValue(RPA_PARSED);
  });

  it('无 SKILL 创建选项和上传入口，默认进入 RPA 内容', () => {
    renderDialog();
    expect(screen.queryByRole('button', { name: /^Skill/i })).not.toBeInTheDocument();
    goToContentStep();
    expect(screen.queryByText('点击选择 SKILL ZIP 包')).not.toBeInTheDocument();
    expect(screen.getByText('点击选择 RPA 压缩包')).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();
    expect(uploadMutation).not.toHaveBeenCalled();
    expect(createMutation).not.toHaveBeenCalled();
  });

  it('RPA 缺少包或使用说明时不能创建', () => {
    renderDialog();
    goToContentStep();
    fireEvent.change(screen.getByPlaceholderText(/账号\/环境要求/), { target: { value: '完整的使用与环境说明已经填写' } });
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    expect(screen.queryByRole('button', { name: /创建草稿/ })).not.toBeInTheDocument();
    expect(createMutation).not.toHaveBeenCalled();
  });

  it('RPA 保留自己的 ZIP 上传流程', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^RPA/ }));
    goToContentStep();

    expect(screen.getByText('上传可复用的自动化流程')).toBeInTheDocument();
    expect(screen.getByText('点击选择 RPA 压缩包')).toBeInTheDocument();
    expect(screen.queryByText('上传 SKILL ZIP 包')).not.toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File(['rpa'], 'invoice-rpa.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('invoice-rpa.zip')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/账号\/环境要求/), {
      target: { value: '需要安装影刀客户端并配置发票目录，审核通过后下载使用。' },
    });
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    fireEvent.change(screen.getByPlaceholderText(/竞品周报生成器/), { target: { value: '发票 RPA' } });
    fireEvent.change(screen.getByPlaceholderText(/说明它解决什么问题/), { target: { value: '自动处理发票并生成归档结果' } });
    fireEvent.click(screen.getByRole('button', { name: /创建草稿/ }));

    const [body] = createMutation.mock.calls[0] as [{ type: string; skillConfig?: unknown; rpaConfig: Record<string, unknown> }];
    expect(body.type).toBe('rpa');
    expect(body.skillConfig).toBeUndefined();
    expect(uploadMutation).not.toHaveBeenCalled();
    expect(body.rpaConfig).toMatchObject({ packageSha256: 'c'.repeat(64), packageFilename: 'invoice-rpa.zip' });
  });

  it('平台投稿模式提交审核并返回创建结果', async () => {
    const onSuccess = vi.fn();
    renderDialog({ mode: 'platform-review', onSuccess });
    await goToInfoStep();
    fireEvent.change(screen.getByPlaceholderText(/说明它解决什么问题/), { target: { value: '自动处理发票并归档' } });
    fireEvent.click(screen.getByRole('button', { name: /提交平台审核/ }));

    expect(useCreateContributionMock).toHaveBeenCalledWith({ submitToPlatformReview: true });
    const options = createMutation.mock.calls[0]?.[1] as { onSuccess: (value: { id: string }) => void };
    options.onSuccess({ id: 'rpa-1' });
    expect(onSuccess).toHaveBeenCalledWith({ id: 'rpa-1' });
  });

  it('弹窗接受非空短描述并 trim，而不是用 10 字硬限拦截', async () => {
    renderDialog(); await goToInfoStep();
    fireEvent.change(screen.getByPlaceholderText(/说明它解决什么问题/), { target: { value: ' 短描述 ' } });
    fireEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    expect(createMutation).toHaveBeenCalledWith(expect.objectContaining({ description: '短描述', type: 'rpa' }), expect.any(Object));
  });

  it.each([' \n ', 'x'.repeat(2001)])('空白或超预算描述不能创建', async (description) => {
    renderDialog(); await goToInfoStep();
    fireEvent.change(screen.getByPlaceholderText(/说明它解决什么问题/), { target: { value: description } });
    fireEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    expect(createMutation).not.toHaveBeenCalled();
  });

  it('贡献信息接受名称 100/描述 2000 边界，保留上传包身份', async () => {
    renderDialog(); await goToInfoStep();
    fireEvent.change(screen.getByPlaceholderText(/竞品周报生成器/), { target: { value: 'a'.repeat(100) } });
    fireEvent.change(screen.getByPlaceholderText(/说明它解决什么问题/), { target: { value: 'x'.repeat(2000) } });
    fireEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    expect(createMutation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'a'.repeat(100), description: 'x'.repeat(2000),
      rpaConfig: expect.objectContaining({ packageSha256: 'c'.repeat(64), packageFilename: 'invoice-rpa.zip' }),
    }), expect.any(Object));
  });

  it.each(['   ', 'a'.repeat(101)])('空白或超预算名称不能创建', async (name) => {
    renderDialog(); await goToInfoStep();
    fireEvent.change(screen.getByPlaceholderText(/竞品周报生成器/), { target: { value: name } });
    fireEvent.change(screen.getByPlaceholderText(/说明它解决什么问题/), { target: { value: '短描述' } });
    fireEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    expect(createMutation).not.toHaveBeenCalled();
  });
});
