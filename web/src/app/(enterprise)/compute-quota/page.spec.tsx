import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ComputeQuotaPage from './page';
import { useAuthStore } from '@/lib/auth-store';

/**
 * 这一页对三种角色开放，但**渲染什么**必须分得干净：
 *
 *   · 企业池、成员额度分配、审计 —— 这三块读的接口后端对非管理员一律 403。
 *     成员视角必须「不挂载」，而不是挂上再用 CSS 隐藏 ——
 *     否则他一进页面就是三个失败请求，控制台三条红字。
 *   · 逐笔账单两种角色都有，但**是两个不同的组件**：管理员那张带筛选栏
 *     （筛选栏要拉员工与成员列表，两个接口对成员都是 403），成员那张只有分页。
 *     挂错一张的后果不是样式问题，是一进页面就失败。
 *   · 「我的算力」（公司给我的额度 + 我的个人余额）对成员和管理员均展示。
 *     管理员的个人钱包与企业资金分开展示。
 *
 * 子面板全部换成桩件：这里测的是「按角色挂哪些块」，不是各面板自己的取数。
 */
vi.mock('./compute-balance-strip', () => ({
  ComputeBalanceStrip: () => <div>桩·企业算力池</div>,
}));
vi.mock('./member-allowance-panel', () => ({
  MemberAllowancePanel: () => <div>桩·成员额度分配</div>,
}));
vi.mock('./allowance-audit-panel', () => ({
  AllowanceAuditPanel: () => <div>桩·额度变更审计</div>,
}));
vi.mock('./usage-record-table', () => ({
  UsageRecordTable: () => <div>桩·全公司逐笔账单</div>,
}));
vi.mock('./my-usage-records', () => ({
  MyUsageRecords: () => <div>桩·我的逐笔账单</div>,
}));
vi.mock('@/features/compute/my-compute-panel', () => ({
  MyComputePanel: () => <div>桩·我的算力</div>,
}));

const ADMIN_ONLY = [
  '桩·企业算力池',
  '桩·成员额度分配',
  '桩·额度变更审计',
  '桩·全公司逐笔账单',
];

const setRole = (roleInEnterprise: string | null) =>
  useAuthStore.setState({
    token: 't',
    user: { id: 'u1', email: '***@***', name: '测试', avatar: null, role: 'USER' },
    enterprise: { id: 'e1', name: '示例科技' },
    roleInEnterprise,
    hydrated: true,
  });

describe('算力余额页按角色分叉', () => {
  beforeEach(() => {
    useAuthStore.setState({
      token: null,
      user: null,
      enterprise: null,
      roleInEnterprise: null,
      hydrated: false,
    });
  });

  it('管理员：展示企业算力管理和自己的个人钱包', () => {
    setRole('ENTERPRISE_ADMIN');
    render(<ComputeQuotaPage />);

    for (const stub of ADMIN_ONLY) {
      expect(screen.getByText(stub)).toBeInTheDocument();
    }
    expect(screen.getByText('桩·我的算力')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '我的算力与个人钱包' })).toBeInTheDocument();
    // 管理员那张表已经能筛出任何人，再挂一张「只有我」的重复且矛盾
    expect(screen.queryByText('桩·我的逐笔账单')).not.toBeInTheDocument();
  });

  it('❗普通成员：我的算力 + 我自己的逐笔账单，企业那四块一块都不挂载', () => {
    setRole('MEMBER');
    render(<ComputeQuotaPage />);

    expect(screen.getByText('桩·我的算力')).toBeInTheDocument();
    expect(screen.getByText('桩·我的逐笔账单')).toBeInTheDocument();
    for (const stub of ADMIN_ONLY) {
      expect(screen.queryByText(stub)).not.toBeInTheDocument();
    }
  });

  it('DEPT_MANAGER 按普通成员对待 —— 「数据范围」那一层后端还没有', () => {
    setRole('DEPT_MANAGER');
    render(<ComputeQuotaPage />);

    expect(screen.getByText('桩·我的算力')).toBeInTheDocument();
    expect(screen.getByText('桩·我的逐笔账单')).toBeInTheDocument();
    expect(screen.queryByText('桩·成员额度分配')).not.toBeInTheDocument();
  });

  it('成员和管理员均带 #my-compute 锚点，支持充值及额度提示回跳', () => {
    setRole('MEMBER');
    const { container } = render(<ComputeQuotaPage />);
    expect(container.querySelector('#my-compute')).not.toBeNull();

    setRole('ENTERPRISE_ADMIN');
    const admin = render(<ComputeQuotaPage />);
    expect(admin.container.querySelector('#my-compute')).not.toBeNull();
  });

  it('成员那块逐笔账单带 #my-usage-records 锚点 —— 用量分析页按它跳过来', () => {
    setRole('MEMBER');
    const { container } = render(<ComputeQuotaPage />);

    expect(container.querySelector('#my-usage-records')).not.toBeNull();
  });

  it('成员的底部入口指向用量分析 —— 逐笔在本页，分布在那一页', () => {
    setRole('MEMBER');
    render(<ComputeQuotaPage />);

    expect(
      screen.getByRole('link', { name: /看我这段时间的花费分布/ }),
    ).toHaveAttribute('href', '/usage');
  });
});
