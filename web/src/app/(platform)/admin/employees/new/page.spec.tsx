import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewEmployeePage from './page';

const { createEmployee, generateEmployeeCopyDraft, bind, push, error } = vi.hoisted(() => ({
  createEmployee: vi.fn(), generateEmployeeCopyDraft: vi.fn(), bind: vi.fn(), push: vi.fn(), error: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, back: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { error, success: vi.fn() } }));
vi.mock('@/features/admin/admin-api', () => ({ adminApi: { createEmployee, generateEmployeeCopyDraft, submitEmployeeForReview: vi.fn() } }));
vi.mock('@/features/admin/use-admin', () => ({
  useAvailableCapabilities: () => ({ data: [{ id: 'cap-1', name: '测试能力', description: '说明', type: 'AGENT' }], isLoading: false }),
  useBindCapabilities: () => ({ mutateAsync: bind }),
  useDefaultEmployeeGiftCNY: () => ({ data: 0 }),
  useDefaultEmployeeGiftPercentage: () => ({ data: 0 }),
}));
vi.mock('@/features/admin/use-models', () => ({ useEnabledModels: () => ({ data: [], isLoading: false }) }));

function mount() {
  render(<NewEmployeePage />);
  fireEvent.change(screen.getByLabelText('员工名称 *'), { target: { value: '测试员工' } });
  fireEvent.change(screen.getByLabelText('员工简介'), { target: { value: '短描述' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /测试能力/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  createEmployee.mockResolvedValue({ id: 'employee-1' });
  generateEmployeeCopyDraft.mockResolvedValue({ draft: 'AI 生成的系统提示词，包含测试能力', modelId: 'gemini-3.5-flash-high', modelSource: 'PLATFORM_DEFAULT' });
  bind.mockResolvedValue(undefined);
});

describe('新建员工表单', () => {
  it('不展示头像地址和模型字段，提交时不发送它们', async () => {
    mount();
    expect(screen.queryByLabelText('头像地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存为草稿' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/employees'));
    expect(createEmployee.mock.calls[0][0]).not.toHaveProperty('avatar');
    expect(createEmployee.mock.calls[0][0]).not.toHaveProperty('modelId');
    expect(createEmployee.mock.calls[0][0]).toMatchObject({ description: '短描述', includedComputeCNY: null });
    expect(bind).toHaveBeenCalledWith({ employeeId: 'employee-1', capabilityIds: ['cap-1'] });
  });

  it.each(['', ' \n '])('草稿省略未填写的描述 %j', async (description) => {
    mount();
    fireEvent.change(screen.getByLabelText('员工简介'), { target: { value: description } });
    fireEvent.click(screen.getByRole('button', { name: '保存为草稿' }));
    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(createEmployee.mock.calls[0][0]).not.toHaveProperty('description');
  });

  it('接受 2000 字描述，并保留未被共享 pick 包含的员工配置', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('员工简介'), { target: { value: 'x'.repeat(2000) } });
    fireEvent.click(screen.getByRole('button', { name: '保存为草稿' }));
    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(createEmployee.mock.calls[0][0]).toMatchObject({
      description: 'x'.repeat(2000), industry: '通用', position: '通用',
      systemPrompt: '你是一位专业的硅基员工，随时准备协助用户完成各项任务。',
    });
    expect(createEmployee.mock.calls[0][0]).not.toHaveProperty('avatar');
    expect(createEmployee.mock.calls[0][0]).not.toHaveProperty('modelId');
  });

  it('拒绝超过 2000 字的员工描述，不进入绑定流程', () => {
    mount();
    fireEvent.change(screen.getByLabelText('员工简介'), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(screen.getByRole('button', { name: '保存为草稿' }));
    expect(error).toHaveBeenCalled();
    expect(createEmployee).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('按员工信息调用 AI 生成可编辑的系统提示词草稿', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成提示词' }));
    await waitFor(() => expect(generateEmployeeCopyDraft).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'systemPrompt',
      employee: expect.objectContaining({ name: '测试员工', capabilities: [{ name: '测试能力', description: '说明' }] }),
    })));
    await waitFor(() => expect((screen.getByLabelText('系统提示词') as HTMLTextAreaElement).value).toContain('测试能力'));
  });

  it('可通过 AI 生成简介并显示实际使用的模型', async () => {
    generateEmployeeCopyDraft.mockResolvedValueOnce({ draft: '为电商团队查询订单状态。', modelId: 'platform-model', modelSource: 'PLATFORM_DEFAULT' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成简介' }));
    await waitFor(() => expect(generateEmployeeCopyDraft).toHaveBeenCalledWith(expect.objectContaining({ kind: 'description' })));
    await waitFor(() => expect((screen.getByLabelText('员工简介') as HTMLTextAreaElement).value).toBe('为电商团队查询订单状态。'));
    expect(screen.getByText(/当前生成模型：platform-model/)).toBeInTheDocument();
  });

  it('显式填写赠送额度 0 不会变成默认额度 null', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('订阅赠送算力（元）'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存为草稿' }));
    await waitFor(() => expect(createEmployee).toHaveBeenCalled());
    expect(createEmployee.mock.calls[0][0]).toMatchObject({ includedComputeCNY: 0 });
  });
});
