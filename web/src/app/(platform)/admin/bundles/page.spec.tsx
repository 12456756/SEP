import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminBundlesPage from './page';

const { create, update, generate, upload, error, state } = vi.hoisted(() => ({
  create: vi.fn(), update: vi.fn(), generate: vi.fn(), upload: vi.fn(), error: vi.fn(),
  state: { bundles: [] as unknown[] },
}));
vi.mock('@/components/ui/toast', () => ({ toast: { error, success: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [
  { id: 'tech-1', name: '研发员工', position: '工程师', functionalCategory: 'TECH', annualPriceCNY: 1200 },
  { id: 'tech-2', name: '测试员工', position: '测试工程师', functionalCategory: 'TECH', annualPriceCNY: 600 },
  { id: 'sales-1', name: '销售员工', position: '客户经理', functionalCategory: 'SALES_CUSTOMER', annualPriceCNY: 800 },
] }) }));
vi.mock('@/features/employee-bundle/use-employee-bundles', () => ({
  useAdminEmployeeBundles: () => ({ data: state.bundles }),
  useCreateEmployeeBundle: () => ({ mutateAsync: create }),
  useUpdateEmployeeBundle: () => ({ mutateAsync: update }),
  usePublishEmployeeBundle: () => ({ mutateAsync: vi.fn() }),
  useArchiveEmployeeBundle: () => ({ mutateAsync: vi.fn() }),
  useGenerateBundleDescription: () => ({ mutateAsync: generate, reset: vi.fn() }),
  useUploadBundleCover: () => ({ mutateAsync: upload, reset: vi.fn() }),
}));

function mount() {
  render(<AdminBundlesPage />);
  fireEvent.click(screen.getByRole('button', { name: '新建套餐' }));
  fireEvent.change(screen.getByLabelText('套餐编码'), { target: { value: 'test-bundle' } });
  fireEvent.change(screen.getByLabelText('套餐名称'), { target: { value: '业务套餐' } });
  fireEvent.change(screen.getByLabelText('套餐价格（元）'), { target: { value: '100' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.bundles = [];
  create.mockResolvedValue({});
  generate.mockResolvedValue({ draft: '协同完成研发和销售任务。', modelId: 'platform-model' });
  upload.mockResolvedValue({ cover: '/api/market/bundles/covers/12345678-1234-4123-8123-123456789abc.png' });
});

describe('套餐表单', () => {
  it('按分类全选并保留跨分类选择，搜索后的取消只影响当前结果', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('员工分类'), { target: { value: 'TECH' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }));
    expect(screen.getByText('已选 2 位')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('员工分类'), { target: { value: 'SALES_CUSTOMER' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }));
    fireEvent.change(screen.getByLabelText('员工分类'), { target: { value: 'ALL' } });
    fireEvent.change(screen.getByLabelText('搜索员工'), { target: { value: '研发' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].items.map((item: { employeeId: string }) => item.employeeId)).toEqual(['tech-2', 'sales-1']);
  });

  it('部分选中显示中间态，并可清空所有分类的选择', () => {
    mount();
    fireEvent.click(screen.getByRole('checkbox', { name: /研发员工/ }));
    expect((screen.getByRole('checkbox', { name: '全选当前结果' }) as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '清空已选' }));
    expect(screen.getByText('已选 0 位')).toBeInTheDocument();
  });

  it('依据套餐名称和所选员工生成可编辑说明', async () => {
    mount();
    expect(screen.getByRole('button', { name: 'AI 生成说明' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /研发员工/ }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成说明' }));
    await waitFor(() => expect(screen.getByLabelText('套餐说明')).toHaveValue('协同完成研发和销售任务。'));
    expect(generate).toHaveBeenCalledWith({ name: '业务套餐', employeeIds: ['tech-1'] });
    expect(screen.getByText('当前生成模型：platform-model')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('套餐说明'), { target: { value: '人工修改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ description: '人工修改' })));
  });

  it('生成失败保留原说明，旧表单的异步结果不写入新表单', async () => {
    mount();
    fireEvent.click(screen.getByRole('checkbox', { name: /研发员工/ }));
    fireEvent.change(screen.getByLabelText('套餐说明'), { target: { value: '原说明' } });
    generate.mockRejectedValueOnce(new Error('模型暂不可用'));
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成说明' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('模型暂不可用'));
    expect(screen.getByLabelText('套餐说明')).toHaveValue('原说明');
    let finish!: (value: unknown) => void;
    generate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成说明' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }));
    finish({ draft: '过期结果', modelId: 'old-model' });
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('套餐说明')).toHaveValue('');
  });

  it('上传本地图片并保存稳定封面地址，支持移除', async () => {
    mount();
    expect(screen.queryByLabelText(/封面图片 URL/)).not.toBeInTheDocument();
    const file = new File(['png'], 'cover.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传套餐封面'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByAltText('套餐封面预览')).toHaveAttribute('src', '/api/market/bundles/covers/12345678-1234-4123-8123-123456789abc.png'));
    expect(upload).toHaveBeenCalledWith(file);
    fireEvent.click(screen.getByRole('checkbox', { name: /研发员工/ }));
    fireEvent.click(screen.getByRole('button', { name: '移除封面' }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ cover: null })));
  });

  it('拒绝非图片和无效周期，不发送请求', () => {
    mount();
    fireEvent.change(screen.getByLabelText('上传套餐封面'), { target: { files: [new File(['x'], 'x.svg', { type: 'image/svg+xml' })] } });
    expect(upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /研发员工/ }));
    fireEvent.change(screen.getByLabelText('默认周期（月）'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(create).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });
});
