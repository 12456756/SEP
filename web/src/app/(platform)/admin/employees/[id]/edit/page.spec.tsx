import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EditEmployeePage from './page';

const { getEmployeeDetail, updateEmployee, bindCapabilities, bindingsQuery, push, router, toastError, toastSuccess } = vi.hoisted(() => {
  const push = vi.fn();
  const back = vi.fn();
  return {
    getEmployeeDetail: vi.fn(), updateEmployee: vi.fn(), bindCapabilities: vi.fn(), bindingsQuery: vi.fn(), push, router: { push, back }, toastError: vi.fn(), toastSuccess: vi.fn(),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ id: 'employee-1' }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock('@/features/admin/admin-api', () => ({ adminApi: { getEmployeeDetail, updateEmployee } }));
vi.mock('@/features/admin/use-admin', () => ({
  useAvailableCapabilities: () => ({ data: [{ id: 'cap-1', name: '分析能力', description: '分析资料', type: 'SKILL' }], isLoading: false, isError: false }),
  useEmployeeBindings: bindingsQuery,
  useBindCapabilities: () => ({ mutateAsync: bindCapabilities }),
  useSaveAdminEmployee: () => ({ mutateAsync: ({ id, data }: { id: string; data: unknown }) => updateEmployee(id, data) }),
  useDefaultEmployeeGiftCNY: () => ({ data: 0 }),
  useDefaultEmployeeGiftPercentage: () => ({ data: 0 }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getEmployeeDetail.mockResolvedValue({
    id: 'employee-1', name: '旧员工', description: '旧简介', industry: '通用', position: '通用',
    avatar: '/legacy/avatar.webp', systemPrompt: '保留的旧系统提示词', modelId: 'legacy-model',
    annualPriceCNY: 10, includedComputeCNY: null,
  });
  updateEmployee.mockResolvedValue({});
  bindCapabilities.mockResolvedValue(undefined);
  bindingsQuery.mockReturnValue({ data: [{ enabled: true, capability: { id: 'cap-1', status: 'APPROVED' } }], isLoading: false, isError: false });
});

describe('编辑员工表单', () => {
  it('仅更新资料时省略头像和模型，保留旧提示词与原有绑定', async () => {
    render(<EditEmployeePage />);
    const name = await screen.findByLabelText('员工名称 *');
    expect(screen.queryByLabelText('头像地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
    expect(screen.getByLabelText('系统提示词')).toHaveValue('保留的旧系统提示词');

    fireEvent.change(name, { target: { value: '更新后的员工' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更新' }));

    await waitFor(() => expect(updateEmployee).toHaveBeenCalled());
    const payload = updateEmployee.mock.calls[0][1];
    expect(payload).toMatchObject({ name: '更新后的员工', systemPrompt: '保留的旧系统提示词' });
    expect(payload).not.toHaveProperty('avatar');
    expect(payload).not.toHaveProperty('modelId');
    expect(payload).not.toHaveProperty('capabilityIds');
    expect(bindCapabilities).not.toHaveBeenCalled();
  });

  it('下架和禁用绑定不进入选中项，资料仍可单独保存', async () => {
    bindingsQuery.mockReturnValue({ data: [
      { enabled: false, capability: { id: 'archived', status: 'ARCHIVED' } },
      { enabled: false, capability: { id: 'cap-1', status: 'APPROVED' } },
    ], isLoading: false, isError: false });
    render(<EditEmployeePage />);
    fireEvent.change(await screen.findByLabelText('员工名称 *'), { target: { value: '下架后改名' } });
    expect(screen.getByRole('checkbox', { name: '分析能力' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存更新' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/employees'));
    expect(updateEmployee).toHaveBeenCalledWith('employee-1', expect.objectContaining({ name: '下架后改名' }));
    expect(updateEmployee.mock.calls[0][1]).not.toHaveProperty('capabilityIds');
    expect(bindCapabilities).not.toHaveBeenCalled();
  });

  it('调整能力时与基本资料通过同一请求保存', async () => {
    bindingsQuery.mockReturnValue({ data: [{ enabled: false, capability: { id: 'archived', status: 'ARCHIVED' } }], isLoading: false, isError: false });
    render(<EditEmployeePage />);
    await screen.findByLabelText('员工名称 *');
    fireEvent.click(screen.getByRole('checkbox', { name: '分析能力' }));
    fireEvent.click(screen.getByRole('button', { name: '保存更新' }));
    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith('employee-1', expect.objectContaining({ capabilityIds: ['cap-1'] })));
    expect(bindCapabilities).not.toHaveBeenCalled();
  });

  it('绑定查询失败时禁止保存，防止覆盖未知绑定', async () => {
    bindingsQuery.mockReturnValue({ isLoading: false, isError: true });
    render(<EditEmployeePage />);
    await screen.findByLabelText('员工名称 *');
    fireEvent.click(screen.getByRole('button', { name: '保存更新' }));
    expect(updateEmployee).not.toHaveBeenCalled();
  });

  it('提交失败时保留页面和用户输入', async () => {
    updateEmployee.mockRejectedValueOnce(new Error('只能绑定已发布的能力'));
    render(<EditEmployeePage />);
    fireEvent.change(await screen.findByLabelText('员工名称 *'), { target: { value: '尚未保存' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更新' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('只能绑定已发布的能力'));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByLabelText('员工名称 *')).toHaveValue('尚未保存');
  });
});
