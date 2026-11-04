import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EditEmployeePage from './page';

const { getEmployeeDetail, updateEmployee, bindCapabilities, push, router, toastError, toastSuccess } = vi.hoisted(() => {
  const push = vi.fn();
  const back = vi.fn();
  return {
    getEmployeeDetail: vi.fn(), updateEmployee: vi.fn(), bindCapabilities: vi.fn(), push, router: { push, back }, toastError: vi.fn(), toastSuccess: vi.fn(),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ id: 'employee-1' }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock('@/features/admin/admin-api', () => ({ adminApi: { getEmployeeDetail, updateEmployee } }));
vi.mock('@/features/admin/use-admin', () => ({
  useAvailableCapabilities: () => ({ data: [{ id: 'cap-1', name: '分析能力', description: '分析资料', type: 'SKILL' }], isLoading: false, isError: false }),
  useEmployeeBindings: () => ({ data: [{ capability: { id: 'cap-1' } }] }),
  useBindCapabilities: () => ({ mutateAsync: bindCapabilities }),
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
});

describe('编辑员工表单', () => {
  it('更新时省略头像和模型，保留旧提示词并提交绑定能力', async () => {
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
    expect(bindCapabilities).toHaveBeenCalledWith({ employeeId: 'employee-1', capabilityIds: ['cap-1'] });
  });
});
