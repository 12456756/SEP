import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CapabilitiesPage from './page';

const { list, approve, reject, reviewSkill } = vi.hoisted(() => ({ list: vi.fn(), approve: vi.fn(), reject: vi.fn(), reviewSkill: vi.fn() }));
vi.mock('@/features/admin/use-admin', () => ({
  useAllCapabilities: list,
  useApproveCapability: () => ({ mutate: approve }),
  useRejectCapability: () => ({ mutate: reject }),
  useDeleteCapability: () => ({ mutate: vi.fn() }),
}));
vi.mock('../skills/use-skill-monitor', () => ({ useMonitorReview: () => ({ mutateAsync: reviewSkill, isPending: false }) }));

function capability(overrides: Record<string, unknown> = {}) {
  return { id: 'skill-1', name: '写作技能', description: '文案生成', type: 'SKILL', status: 'PENDING',
    enterpriseId: null, enterprise: null, platformReviewStatus: 'NOT_SUBMITTED',
    createdAt: '2026-10-10T00:00:00Z', currentPlatformVersion: null,
    _count: { bindings: 0 }, bindings: [], ...overrides };
}

describe('能力管理监控入口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockReturnValue({ data: { items: [] } });
  });
  it('只有一个技能监控入口，无待审计数，保留新建能力', () => {
    render(<CapabilitiesPage />);
    expect(screen.getAllByRole('link', { name: '技能监控' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: '技能监控' })).toHaveAttribute('href', '/admin/skills');
    expect(screen.getByRole('link', { name: /新建能力/ })).toHaveAttribute('href', '/admin/capabilities/new');
    expect(screen.queryByText('投稿待审')).not.toBeInTheDocument();
    expect(screen.queryByText('版本待审')).not.toBeInTheDocument();
    expect(screen.queryByText(/两个队列/)).not.toBeInTheDocument();
  });
  it('非技能企业投稿保留行内审核入口', () => {
    list.mockReturnValue({ data: { items: [{ id: 'rpa-1', name: '对账自动化', description: 'RPA',
      type: 'RPA', status: 'PENDING', enterpriseId: 'e-1', enterprise: { name: '测试企业' },
      platformReviewStatus: 'PENDING_REVIEW', createdAt: '2026-10-10T00:00:00Z',
      _count: { bindings: 0 }, bindings: [] }] } });
    render(<CapabilitiesPage />);
    expect(screen.getByRole('link', { name: /审核/ })).toHaveAttribute('href', '/admin/contributions?selected=rpa-1');
  });

  it('展示平台版本、未发布和非技能占位，版本链接保留能力及平台范围', () => {
    list.mockReturnValue({ data: { items: [
      capability({ id: 'skill/id &1', name: '已发布技能', status: 'APPROVED',
        currentPlatformVersion: { id: 'platform-2', version: '1.0.1', platformReviewedAt: '2026-10-10T00:00:00Z' } }),
      capability({ id: 'skill-new', name: '未发布技能' }),
      capability({ id: 'rpa-1', name: '自动化', type: 'RPA', status: 'APPROVED',
        currentPlatformVersion: { id: 'unexpected', version: '9.0.0' } }),
    ] } });
    render(<CapabilitiesPage />);
    expect(screen.getByRole('columnheader', { name: '当前平台版本' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'v1.0.1' })).toHaveAttribute('href', '/admin/skills?capabilityId=skill%2Fid%20%261&scope=PLATFORM');
    expect(within(screen.getByRole('row', { name: /未发布技能/ })).getByText('未发布')).toBeInTheDocument();
    const nonSkill = screen.getByRole('row', { name: /自动化/ });
    expect(within(nonSkill).getByText('-')).toBeInTheDocument();
    expect(within(nonSkill).queryByRole('link', { name: /^v/ })).not.toBeInTheDocument();
  });

  it.each([
    { enterpriseId: null, platformReviewStatus: 'NOT_SUBMITTED' },
    { enterpriseId: 'enterprise', enterprise: { name: '测试企业' }, platformReviewStatus: 'PENDING_REVIEW' },
  ])('待审技能只进入技能监控，不走旧通用或投稿审核：%j', (source) => {
    list.mockReturnValue({ data: { items: [capability(source)] } });
    render(<CapabilitiesPage />);
    const row = within(screen.getByRole('row', { name: /写作技能/ }));
    expect(row.getByRole('link', { name: '技能监控' })).toHaveAttribute('href', '/admin/skills?capabilityId=skill-1&scope=PLATFORM');
    expect(row.queryByRole('button', { name: '审核通过' })).not.toBeInTheDocument();
    expect(row.queryByRole('button', { name: '驳回' })).not.toBeInTheDocument();
    expect(row.queryByRole('link', { name: /审核/ })).not.toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it('平台待审技能可从能力列表直接审核确切待审版本', async () => {
    list.mockReturnValue({ data: { items: [capability({
      pendingPlatformVersion: { id: 'pending-version-1', capabilityId: 'skill-1', version: '1.0.0', updatedAt: '2026-10-10T00:00:00Z' },
    })] } });
    reviewSkill.mockResolvedValue({});
    render(<CapabilitiesPage />);
    fireEvent.click(screen.getByRole('button', { name: '审核通过' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('待审平台版本 v1.0.0');
    fireEvent.click(screen.getByRole('button', { name: '确认审核通过' }));
    await vi.waitFor(() => expect(reviewSkill).toHaveBeenCalledWith({ id: 'pending-version-1', decision: 'APPROVE' }));
  });

  it('非技能平台能力保留行内通过与驳回操作', () => {
    list.mockReturnValue({ data: { items: [capability({ type: 'RPA', name: '自动化' })] } });
    render(<CapabilitiesPage />);
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(approve).toHaveBeenCalledWith({ id: 'skill-1' }, expect.any(Object));
    fireEvent.click(screen.getByRole('button', { name: '驳回' }));
    fireEvent.change(screen.getByPlaceholderText('请说明驳回原因...'), { target: { value: '  需要修正  ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }));
    expect(reject).toHaveBeenCalledWith({ id: 'skill-1', reason: '需要修正' }, expect.any(Object));
  });

  it('保留状态和名称、描述、企业关键词筛选', () => {
    list.mockReturnValue({ data: { items: [
      capability(),
      capability({ id: 'rpa-1', name: '自动化', type: 'RPA', description: '账务核对', enterprise: { name: '示例企业' } }),
    ] } });
    render(<CapabilitiesPage />);
    expect(list).toHaveBeenLastCalledWith(undefined, 1, 20);
    for (const [label, value] of [['待审核', 'PENDING'], ['已发布', 'APPROVED'], ['已拒绝', 'REJECTED'], ['全部', undefined]]) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(list).toHaveBeenLastCalledWith(value, 1, 20);
    }
    const search = screen.getByPlaceholderText('搜索能力名称、描述或来源企业');
    for (const keyword of ['自动化', '账务', '示例企业']) {
      fireEvent.change(search, { target: { value: keyword } });
      expect(screen.getByRole('row', { name: /自动化/ })).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /写作技能/ })).not.toBeInTheDocument();
    }
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByRole('row', { name: /写作技能/ })).toBeInTheDocument();
  });
});
