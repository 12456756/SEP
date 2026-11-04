import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberEmployeeGrantPanel } from '../member-employee-grant-panel';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
  state: { data: undefined as any, isLoading: false, isError: false },
}));

vi.mock('../use-enterprise', () => ({
  useMemberEmployeeGrants: () => ({ ...mocks.state, refetch: mocks.refetch }),
  useCreateMemberEmployeeGrants: () => ({ mutate: mocks.create, isPending: false }),
  useDeleteGrant: () => ({ mutate: mocks.remove, isPending: false }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const member = {
  id: 'member-1',
  role: 'MEMBER',
  position: '工程师',
  createdAt: '2026-01-01T00:00:00.000Z',
  user: { id: 'user-1', email: 'member@example.com', name: '李四', avatar: null },
  department: { id: 'dept-1', name: '研发部', parent: null },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = {
    isLoading: false,
    isError: false,
    data: {
      page: 1,
      pageSize: 20,
      total: 2,
      items: [
        {
          subscriptionId: 'sub-1', name: '数据分析师', status: 'ACTIVE', endDate: null,
          employee: { id: 'emp-1', name: '数据分析师', avatar: null, position: '数据分析' },
          directGrant: null, coveredByDepartment: false,
        },
        {
          subscriptionId: 'sub-2', name: '客服助手', status: 'ACTIVE', endDate: null,
          employee: { id: 'emp-2', name: '客服助手', avatar: null, position: '客服' },
          directGrant: { id: 'grant-2', expiresAt: null, expired: false }, coveredByDepartment: true,
        },
      ],
    },
  };
});

describe('MemberEmployeeGrantPanel', () => {
  it('selects all eligible employees on the current page and can clear the page selection', () => {
    render(<MemberEmployeeGrantPanel member={member} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '全选本页' }));
    expect(screen.getByRole('checkbox', { name: '选择 数据分析师' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 客服助手' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '取消全选本页' }));
    expect(screen.getByRole('checkbox', { name: '选择 数据分析师' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 客服助手' })).not.toBeChecked();
  });

  it('submits one or many selected subscriptions for the member', async () => {
    mocks.create.mockImplementation((_payload: unknown, options: any) => {
      options?.onSuccess?.({ createdIds: ['grant-1'], renewedSubscriptionIds: [], skippedSubscriptionIds: [] });
    });
    render(<MemberEmployeeGrantPanel member={member} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 数据分析师' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 客服助手' }));
    fireEvent.click(screen.getByRole('button', { name: '授权 2 位' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'member-1', subscriptionIds: ['sub-1', 'sub-2'],
    }), expect.anything()));
  });

  it('can revoke a direct grant while retaining department coverage', () => {
    render(<MemberEmployeeGrantPanel member={member} onClose={() => {}} />);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '收回 客服助手 的直接授权' }));
    expect(mocks.remove).toHaveBeenCalledWith(
      { grantId: 'grant-2', subscriptionId: 'sub-2' },
      expect.anything(),
    );
  });
});
