import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemberAllowances, type MemberAllowanceItem } from '@/lib/api/use-compute-credit';
import { MemberAllowancePanel } from './member-allowance-panel';

vi.mock('@/lib/api/use-compute-credit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api/use-compute-credit')>(),
  useMemberAllowances: vi.fn(),
}));
vi.mock('./allocate-compute-dialog', () => ({
  AllocateComputeDialog: ({ member, trigger }: { member: MemberAllowanceItem; trigger: ReactNode }) => <div data-testid={`allocate-${member.userId}`}>{trigger}</div>,
}));
vi.mock('./top-up-compute-dialog', () => ({
  TopUpComputeDialog: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

const baseMember: MemberAllowanceItem = {
  userId: 'u1', name: '张三', email: 'zhang@acme.local', departmentName: '研发部',
  limitCNY: '100', period: 'MONTH', periodLabel: '每月', carryOver: false, enabled: true,
  carriedInCNY: '0', usedCNY: '20', remainingCNY: '80', topUpRemainingCNY: '10',
  totalRemainingCNY: '90', usedPct: 20, periodStart: '2026-11-01T00:00:00Z', resetAt: '2026-12-01T00:00:00Z',
};
const members: MemberAllowanceItem[] = [
  baseMember,
  { ...baseMember, userId: 'u2', name: '李四', email: 'Li@acme.local', departmentName: '市场部', limitCNY: null, usedPct: null, remainingCNY: null, topUpRemainingCNY: '0' },
  { ...baseMember, userId: 'u3', name: '王五', email: 'wang@acme.local', departmentName: null },
];
const search = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: '搜索姓名、邮箱或部门' }), { target: { value } });

describe('算力分配成员搜索', () => {
  beforeEach(() => {
    vi.mocked(useMemberAllowances).mockReturnValue({ data: members, isLoading: false, isError: false, error: null, refetch: vi.fn() } as unknown as ReturnType<typeof useMemberAllowances>);
  });
  afterEach(cleanup);

  it('按姓名局部匹配，只保留对应成员及其操作，汇总仍统计全公司', () => {
    render(<MemberAllowancePanel />);
    search('张');
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.queryByText('李四')).not.toBeInTheDocument();
    expect(screen.queryByText('王五')).not.toBeInTheDocument();
    expect(screen.getByTestId('allocate-u1')).toBeInTheDocument();
    expect(screen.queryByTestId('allocate-u2')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('找到 1 位，共 3 位');
    expect(screen.getByText('位成员', { exact: false })).toHaveTextContent('共 3 位成员');
    expect(screen.getByText('已设置限额', { exact: false })).toHaveTextContent('已设置限额 2 位');
    expect(screen.getByText('有充值余额', { exact: false })).toHaveTextContent('有充值余额 2 位');
  });

  it('邮箱忽略大小写和首尾空格，也能按部门筛选并兼容未设置部门', () => {
    render(<MemberAllowancePanel />);
    search('  LI@ACME  ');
    expect(screen.getByText('李四')).toBeInTheDocument();
    expect(screen.queryByText('张三')).not.toBeInTheDocument();
    search('研发');
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.queryByText('李四')).not.toBeInTheDocument();
    search('wang@');
    expect(screen.getByText('王五')).toBeInTheDocument();
  });

  it('无结果时显示空态，清空筛选恢复全部成员并聚焦搜索框', () => {
    render(<MemberAllowancePanel />);
    search('不存在的成员');
    expect(screen.getByText('未找到匹配的成员')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('找到 0 位，共 3 位');
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(screen.getAllByRole('button', { name: '设置限额' })).toHaveLength(3);
    expect(screen.queryByText('未找到匹配的成员')).not.toBeInTheDocument();
  });

  it('输入框清空按钮恢复全部成员，仅输入空格时不筛选', () => {
    render(<MemberAllowancePanel />);
    search('李四');
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(screen.getAllByRole('button', { name: '设置限额' })).toHaveLength(3);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    search('   ');
    expect(screen.getAllByRole('button', { name: '设置限额' })).toHaveLength(3);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
