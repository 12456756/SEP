import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminSkillsPage from './page';
import DetailPage from './[versionId]/page';
import { canPublishVersion, canSelectSource, creationMethodLabel, currentUsageLabel, monitorContextFilters, monitorQuery, originalSubmitterLabel, publishedSourceVersion, type MonitorDetail } from './monitor';

const { get, post, push, replace, navigation, toastError, toastSuccess } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), replace: vi.fn(), navigation: { search: '', versionId: 'source-1' }, toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get, post } }));
vi.mock('next/navigation', () => ({ useParams: () => ({ versionId: navigation.versionId }), useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => ({ push, replace }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('@/features/chat/markdown', () => ({ Markdown: ({ content }: { content: string }) => <div>{content}</div> }));

function version(overrides: Partial<MonitorDetail> = {}): MonitorDetail {
  return {
    id: 'source-1', capabilityId: 'private-cap', capability: { id: 'private-cap', name: '来源技能', description: '测试正文' },
    scope: 'PERSONAL', enterpriseId: 'enterprise-1', enterprise: { id: 'enterprise-1', name: '来源企业' },
    ownerId: 'owner-1', owner: { id: 'owner-1', name: '来源所有者' }, parentVersionId: null, sourceVersionId: null,
    version: '1.0.1', changeSummary: '客户端修改', content: '# 完整来源正文', status: 'PENDING_ENTERPRISE_REVIEW',
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T01:00:00.000Z',
    enterpriseReviewStatus: 'PENDING', platformProcessingStatus: 'NOT_SUBMITTED', currentPlatformVersion: null, ...overrides,
  };
}
function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  return client;
}
beforeEach(() => { vi.clearAllMocks(); navigation.search = ''; navigation.versionId = 'source-1'; });

async function confirmPublish() {
  fireEvent.click(await screen.findByRole('button', { name: '发布为平台版本' }));
  const dialog = await screen.findByRole('dialog', { name: '发布为平台版本' });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认发布' }));
}

describe('monitor 列表', () => {
  beforeEach(() => {
    get.mockImplementation(async (path: string) => {
      const query = new URLSearchParams(path.split('?')[1]);
      return { items: [version({ id: `page-${query.get('page')}`, status: 'ARCHIVED' })], total: 41, page: Number(query.get('page')), limit: Number(query.get('limit')) };
    });
  });
  it('默认全量含历史版本，常用筛选精简，高级筛选默认折叠', async () => {
    mount(<AdminSkillsPage />);
    expect(await screen.findByText('来源技能')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/admin/skill-versions?page=1&limit=20');
    const row = screen.getByRole('row', { name: /来源技能/ });
    expect(within(row).getByText('企业待审')).toBeInTheDocument();
    expect(within(row).getByText('未发布')).toBeInTheDocument();
    for (const label of ['版本类型', '企业审核', '平台发布状态']) expect(screen.getByLabelText(label)).toHaveValue('');
    expect(Array.from(screen.getByLabelText('平台发布状态').querySelectorAll('option'), (option) => [option.value, option.textContent])).toEqual([
      ['', '全部'], ['NOT_SUBMITTED', '未发布'], ['PENDING_REVIEW', '历史待审'], ['APPROVED', '已发布'], ['REJECTED', '历史拒绝'],
    ]);
    const typeFilter = screen.getByLabelText('版本类型');
    expect(Array.from(typeFilter.querySelectorAll('option'), (option) => option.textContent)).toEqual(['全部', '个人提交', '企业发布版', '平台版本']);
    expect(screen.queryByLabelText('来源')).not.toBeInTheDocument();
    expect(screen.getByText('高级筛选').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByLabelText('版本状态')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('产生方式')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('企业 ID')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '应用筛选' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回硅基能力' })).toHaveAttribute('href', '/admin/capabilities');
    expect(screen.queryByText(/查看个人、企业、平台的全部版本/)).not.toBeInTheDocument();
  });
  it('稳定翻页、组合筛选传服务端并重置页码，时间转 ISO', async () => {
    mount(<AdminSkillsPage />);
    await screen.findByText('来源技能');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/skill-versions?page=2&limit=20'));
    fireEvent.change(screen.getByLabelText('版本类型'), { target: { value: 'ENTERPRISE' } });
    fireEvent.click(screen.getByText('高级筛选'));
    fireEvent.change(screen.getByLabelText('企业审核'), { target: { value: 'REJECTED' } });
    fireEvent.change(screen.getByLabelText('平台发布状态'), { target: { value: 'PENDING_REVIEW' } });
    for (const [label, value] of [['企业名称', 'e & 1'], ['提交人', '张三'], ['搜索技能', '沟通'], ['创建开始时间', '2026-10-01T00:00'], ['创建结束时间', '2026-10-09T23:59']]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    await waitFor(() => {
      const params = new URLSearchParams(get.mock.calls.at(-1)?.[0].split('?')[1]);
      expect(Object.fromEntries(params)).toEqual({ page: '1', limit: '20', scope: 'ENTERPRISE', enterpriseReviewStatus: 'REJECTED', platformProcessingStatus: 'PENDING_REVIEW', search: '沟通', enterpriseName: 'e & 1', ownerName: '张三', createdFrom: new Date('2026-10-01T00:00').toISOString(), createdTo: new Date('2026-10-09T23:59').toISOString() });
    });
    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } });
    await waitFor(() => expect(get.mock.calls.at(-1)?.[0]).toContain('page=1&limit=50'));
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/skill-versions?page=1&limit=50'));
  });
  it('无效时间不发送筛选请求', async () => {
    mount(<AdminSkillsPage />);
    await screen.findByText('来源技能');
    fireEvent.click(screen.getByText('高级筛选'));
    fireEvent.change(screen.getByLabelText('创建开始时间'), { target: { value: '2026-10-09T23:59' } });
    await waitFor(() => expect(get.mock.calls.at(-1)?.[0]).toContain('createdFrom='));
    const count = get.mock.calls.length;
    fireEvent.change(screen.getByLabelText('创建结束时间'), { target: { value: '2026-10-01T00:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('开始时间不能晚于结束时间');
    expect(get).toHaveBeenCalledTimes(count);
  });
  it('企业发布版分别显示成员原提交人和管理员审核发布人，并链接对应版本', async () => {
    get.mockResolvedValue({ items: [version({
      scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', ownerId: null, owner: null,
      enterpriseReviewStatus: 'APPROVED', createdBy: { id: 'admin-1', name: '审核管理员' },
      originalSubmitters: [{ id: 'member-1', name: '原修改成员' }, { id: 'member-2', name: '另一成员' }],
      enterprisePublisher: { id: 'admin-1', name: '审核管理员' },
      enterprisePublishedVersions: [{ id: 'enterprise-1', version: '1.0.2', isEnterpriseCurrent: true }],
    })], total: 1, page: 1, limit: 20 });
    mount(<AdminSkillsPage />);
    const row = await screen.findByRole('row', { name: /来源技能/ });
    expect(within(row).getByText('原修改成员、另一成员')).toBeInTheDocument();
    expect(within(row).getByText('审核管理员')).toBeInTheDocument();
    expect(within(row).getByText('原提交人')).toBeInTheDocument();
    expect(within(row).getByText('审核发布人')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '企业发布版 v1.0.2' })).toHaveAttribute('href', '/admin/skills/enterprise-1');
    expect(within(row).getByText('企业已启用')).toBeInTheDocument();
    expect(within(row).getByText('技能 ID：private-cap')).toBeInTheDocument();
    expect(within(row).getByText('版本 ID：source-1')).toBeInTheDocument();
  });
  it('已通过个人提交显示独立的企业发布版，历史缺关联不推断已发布', async () => {
    get.mockResolvedValue({ items: [version({
      enterpriseReviewStatus: 'APPROVED', status: 'ENTERPRISE_APPROVED',
      originalSubmitters: [{ id: 'member-1', name: '原修改成员' }],
      enterprisePublisher: { id: 'admin-1', name: '审核管理员' }, enterprisePublishedVersions: [],
    })], total: 1, page: 1, limit: 20 });
    mount(<AdminSkillsPage />);
    const row = await screen.findByRole('row', { name: /来源技能/ });
    expect(within(row).getByText('个人提交')).toBeInTheDocument();
    expect(within(row).getByText('企业通过')).toBeInTheDocument();
    expect(within(row).getByText('未关联企业发布版')).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /企业发布版 v/ })).not.toBeInTheDocument();
  });
  it('快速输入只发送最终搜索，重置取消尚未执行的搜索', async () => {
    mount(<AdminSkillsPage />);
    await screen.findByText('来源技能');
    fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: '供' } });
    fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: '  供应商  ' } });
    expect(get).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(get.mock.calls.at(-1)?.[0]).toContain('search=%E4%BE%9B%E5%BA%94%E5%95%86'));
    expect(get).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: '待取消' } });
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(get.mock.calls.at(-1)?.[0]).toBe('/admin/skill-versions?page=1&limit=20');
    expect(screen.getByLabelText('搜索技能')).toHaveValue('');
  });
  it('403 显示拒绝错误，重试可恢复；不暴露旧缓存操作', async () => {
    get.mockRejectedValueOnce(new Error('403 无权访问'));
    mount(<AdminSkillsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('403 无权访问');
    expect(screen.queryByRole('link', { name: '查看来源与处理' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('来源技能')).toBeInTheDocument();
  });
  it('能力 URL 上下文用于首次查询、翻页、重置和详情链接，可显式清除', async () => {
    navigation.search = 'capabilityId=cap%2F1&scope=PLATFORM';
    mount(<AdminSkillsPage />);
    await screen.findByText('来源技能');
    expect(get).toHaveBeenCalledWith('/admin/skill-versions?page=1&limit=20&capabilityId=cap%2F1&scope=PLATFORM');
    expect(screen.getByLabelText('版本类型')).toHaveValue('PLATFORM');
    expect(screen.getByRole('region', { name: '能力上下文' })).toHaveTextContent('cap/1');
    expect(screen.getByRole('link', { name: '查看来源与处理' })).toHaveAttribute('href', '/admin/skills/page-1?capabilityId=cap%2F1&scope=PLATFORM');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/skill-versions?page=2&limit=20&capabilityId=cap%2F1&scope=PLATFORM'));
    fireEvent.change(screen.getByLabelText('平台发布状态'), { target: { value: 'APPROVED' } });
    await waitFor(() => expect(get.mock.calls.at(-1)?.[0]).toContain('platformProcessingStatus=APPROVED'));
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/skill-versions?page=1&limit=20&capabilityId=cap%2F1&scope=PLATFORM'));
    fireEvent.click(screen.getByRole('button', { name: '清除能力上下文' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/skill-versions?page=1&limit=20'));
    expect(replace).toHaveBeenCalledWith('/admin/skills', { scroll: false });
    expect(screen.queryByRole('region', { name: '能力上下文' })).not.toBeInTheDocument();
  });
  it('URL 平台范围在重新挂载（刷新）后继续生效，不接受未知 scope', async () => {
    navigation.search = 'capabilityId=private-cap&scope=PLATFORM';
    const client = new QueryClient();
    const first = render(<QueryClientProvider client={client}><AdminSkillsPage /></QueryClientProvider>);
    await screen.findByText('来源技能'); first.unmount(); get.mockClear();
    mount(<AdminSkillsPage />);
    await screen.findByText('来源技能');
    expect(get).toHaveBeenCalledWith('/admin/skill-versions?page=1&limit=20&capabilityId=private-cap&scope=PLATFORM');
    expect(monitorContextFilters(new URLSearchParams('scope=unknown'))).toEqual({});
  });
  it('只有平台范围的 URL 也可清除上下文，保留无关 URL 参数', async () => {
    navigation.search = 'scope=PLATFORM&from=capabilities';
    mount(<AdminSkillsPage />);
    await screen.findByText('来源技能');
    expect(screen.getByRole('region', { name: '能力上下文' })).toHaveTextContent('当前范围：平台版本');
    fireEvent.click(screen.getByRole('button', { name: '清除能力上下文' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/skill-versions?page=1&limit=20'));
    expect(replace).toHaveBeenCalledWith('/admin/skills?from=capabilities', { scroll: false });
    expect(screen.getByLabelText('版本类型')).toHaveValue('');
  });
});

describe('monitor 详情发布', () => {
  it('平台详情追溯原提交人和对应企业发布版，不把平台创建人当作提交人', async () => {
    get.mockResolvedValue(version({
      scope: 'PLATFORM', status: 'PLATFORM_APPROVED', sourceVersionId: 'enterprise-1',
      createdBy: { id: 'platform-admin', name: '平台运营人员' },
      originalSubmitters: [{ id: 'member-1', name: '原修改成员' }],
      enterprisePublisher: { id: 'enterprise-admin', name: '企业审核管理员' },
      enterprisePublishedVersions: [
        { id: 'enterprise-1', version: '1.0.2', isEnterpriseCurrent: false },
        { id: 'enterprise-2', version: '1.0.3', isEnterpriseCurrent: true },
      ],
    }));
    mount(<DetailPage />);
    const attribution = await screen.findByRole('region', { name: '版本归属' });
    expect(within(attribution).getByText('原修改成员')).toBeInTheDocument();
    expect(within(attribution).getByText('企业审核管理员')).toBeInTheDocument();
    expect(within(attribution).queryByText('平台运营人员')).not.toBeInTheDocument();
    expect(within(attribution).getByRole('link', { name: '企业发布版 v1.0.2' })).toHaveAttribute('href', '/admin/skills/enterprise-1');
    expect(within(attribution).getByRole('link', { name: '企业发布版 v1.0.3' })).toHaveAttribute('href', '/admin/skills/enterprise-2');
    expect(within(attribution).getByText('历史版本')).toBeInTheDocument();
    expect(within(attribution).getByText('企业已启用')).toBeInTheDocument();
  });
  it.each(['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_REJECTED', 'ARCHIVED'] as const)('来源 %s 只读，确认一次即发布并刷新三组缓存后导航', async (status) => {
    get.mockResolvedValue(version({ status }));
    post.mockResolvedValue(version({ id: 'platform-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' }));
    const client = mount(<DetailPage />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByRole('button', { name: '发布为平台版本' });
    expect(screen.queryByRole('button', { name: /审核通过并发布|直接发布|编辑/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /正文/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发布为平台版本' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('个人提交 v1.0.1');
    expect(dialog).toHaveTextContent('当前平台版本：无（首次发布）');
    expect(dialog).toHaveTextContent('企业审核状态、企业默认版本与企业订阅选版保持不变');
    expect(dialog).toHaveTextContent('企业原能力不会公开');
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认发布' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills/platform-1'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/admin/skill-versions/source-1/publish', { expectedUpdatedAt: '2026-10-08T01:00:00.000Z', expectedPlatformVersionId: null });
    for (const key of ['skill-versions', 'capabilities', 'admin']) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });
  it('平台待审保留原始来源和能力包，不再展示驳回/送审/收录操作', async () => {
    get.mockResolvedValue(version({ scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW', sourceVersion: version(), sourceVersionId: 'origin', packageKey: 'skill.zip', packageFilename: '原始包.zip', packageSha256: 'a'.repeat(64), packageFileCount: 3 }));
    mount(<DetailPage />);
    await screen.findByRole('button', { name: '发布为平台版本' });
    expect(screen.getByRole('link', { name: /个人提交 v/ })).toHaveAttribute('href', '/admin/skills/source-1');
    expect(screen.getByText('原始包.zip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /驳回|审核通过|提交平台审核|收录到平台待审/ })).not.toBeInTheDocument();
  });
  it.each(['DRAFT', 'PENDING_PLATFORM_REVIEW', 'PLATFORM_REJECTED'] as const)('历史 PLATFORM %s 可直接发布精确版本，不调用旧接口', async (status) => {
    get.mockResolvedValue(version({ scope: 'PLATFORM', status })); post.mockResolvedValue(version({ id: 'published-1' }));
    mount(<DetailPage />);
    await confirmPublish();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills/published-1'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual(['/admin/skill-versions/source-1/publish', { expectedPlatformVersionId: null, expectedUpdatedAt: '2026-10-08T01:00:00.000Z' }]);
  });
  it.each(['PLATFORM_APPROVED', 'ARCHIVED'] as const)('PLATFORM %s 不可发布，已发布版展示当前/历史状态', async (status) => {
    get.mockResolvedValue(version({ scope: 'PLATFORM', status, isPlatformLatest: false }));
    mount(<DetailPage />);
    await screen.findByRole('region', { name: '版本分类' });
    expect(screen.queryByRole('button', { name: '发布为平台版本' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '版本分类' })).toHaveTextContent('历史版本');
    expect(post).not.toHaveBeenCalled();
  });
  it.each(['direct', 'snapshot', 'processing'] as const)('当前来源已发布（%s）不允许再次发布', async (kind) => {
    const platform = version({ id: 'platform-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    get.mockResolvedValue(version(kind === 'direct' ? { promotedVersions: [platform] }
      : kind === 'snapshot' ? { isWorkingCopy: true, reviewSnapshots: [{ ...version(), workingCopyUpdatedAt: version().updatedAt, promotedVersions: [platform] }] }
        : { platformProcessingStatus: 'APPROVED' }));
    mount(<DetailPage />);
    await screen.findByRole('region', { name: '版本分类' });
    expect(screen.queryByRole('button', { name: '发布为平台版本' })).not.toBeInTheDocument();
    if (kind !== 'processing') expect(screen.getByRole('link', { name: /查看平台版本/ })).toHaveAttribute('href', '/admin/skills/platform-1');
  });
  it('工作副本旧 revision 已发布且汇总分类为 APPROVED，新 revision 仍能发布', async () => {
    const platform = version({ id: 'platform-old', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    const updatedAt = '2026-10-09T02:00:00.000Z';
    get.mockResolvedValue(version({ isWorkingCopy: true, updatedAt, platformProcessingStatus: 'APPROVED',
      reviewSnapshots: [{ ...version(), workingCopyUpdatedAt: version().updatedAt, promotedVersions: [platform] }] }));
    post.mockResolvedValue(version({ id: 'platform-new', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' }));
    mount(<DetailPage />);
    expect(await screen.findByRole('button', { name: '发布为平台版本' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: '来源已发布' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '历史平台处理记录' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /查看平台版本/ })).toHaveAttribute('href', '/admin/skills/platform-old');
    await confirmPublish();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills/platform-new'));
    expect(post).toHaveBeenCalledWith('/admin/skill-versions/source-1/publish', {
      expectedUpdatedAt: updatedAt, expectedPlatformVersionId: null,
    });
  });
  it('来源只有历史待审/拒绝处理记录仍允许发布，保留审核历史', async () => {
    get.mockResolvedValue(version({ promotedVersions: [version({ scope: 'PLATFORM', status: 'PLATFORM_REJECTED' })],
      reviews: [{ id: 'review-1', actorType: 'PLATFORM', decision: 'REJECT', comment: '历史原因', reviewer: { id: 'admin-1', name: '管理员' }, createdAt: version().createdAt }] }));
    mount(<DetailPage />);
    expect(await screen.findByRole('button', { name: '发布为平台版本' })).toBeEnabled();
    expect(screen.getByRole('region', { name: '审核历史' })).toHaveTextContent('历史原因');
  });
  it('确认取消不发送请求', async () => {
    get.mockResolvedValue(version()); mount(<DetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '发布为平台版本' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(post).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
  it('当前平台基线使用映射平台版而非父版，差异复用行预览，说明限长且正文只读', async () => {
    const currentPlatformVersion = { id: 'mapped-head', capabilityId: 'public-mapping', version: '1.0.8', content: '# 原平台正文\n保持行', updatedAt: version().updatedAt };
    get.mockResolvedValue(version({ scope: 'ENTERPRISE', parentVersionId: 'enterprise-parent', content: '# 新来源正文\n保持行', currentPlatformVersion }));
    post.mockResolvedValue(version({ id: 'published-1' })); mount(<DetailPage />);
    const baseline = await screen.findByRole('region', { name: '当前平台版本' });
    expect(baseline).toHaveTextContent('平台版 v1.0.8');
    expect(baseline).toHaveTextContent('平台技能 ID：public-mapping');
    expect(within(baseline).getByRole('link')).toHaveAttribute('href', '/admin/skills/mapped-head');
    fireEvent.mouseDown(screen.getByRole('tab', { name: '差异预览' }), { button: 0, ctrlKey: false });
    const diff = await screen.findByRole('region', { name: '正文差异' });
    expect(diff).toHaveTextContent('- # 原平台正文'); expect(diff).toHaveTextContent('+ # 新来源正文');
    expect(screen.queryByRole('textbox', { name: /正文/ })).not.toBeInTheDocument();
    const summary = screen.getByLabelText('发布说明（可选）'); expect(summary).toHaveAttribute('maxlength', '2000');
    fireEvent.change(summary, { target: { value: '  发布说明  ' } });
    await confirmPublish();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/skill-versions/source-1/publish', {
      expectedUpdatedAt: version().updatedAt, expectedPlatformVersionId: 'mapped-head', changeSummary: '发布说明',
    }));
  });
  it('相同正文与首次发布差异分别明确显示，不将空基线伪造成差异', async () => {
    get.mockResolvedValue(version({ currentPlatformVersion: { id: 'head', capabilityId: 'cap', version: '1.0.0', content: version().content, updatedAt: version().updatedAt } }));
    const client = mount(<DetailPage />);
    await screen.findByRole('region', { name: '当前平台版本' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '差异预览' }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('与当前平台版本正文相同')).toBeInTheDocument();
    get.mockResolvedValue(version());
    await act(async () => { await client.invalidateQueries({ queryKey: ['skill-versions'] }); });
    expect(await screen.findByText('首次发布，无平台基线；所选正文将作为首个平台版本。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '正文差异' })).not.toBeInTheDocument();
  });
  it('确认锁定已预览来源与平台版本，后台刷新不静默改发新基线', async () => {
    const head = { id: 'head-1', capabilityId: 'cap', version: '1.0.0', content: '基线正文', updatedAt: version().updatedAt };
    get.mockResolvedValue(version({ currentPlatformVersion: head })); post.mockRejectedValue(new Error('409 平台版本已变化'));
    const client = mount(<DetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '发布为平台版本' }));
    get.mockResolvedValue(version({ updatedAt: '2026-10-09T00:00:00.000Z', currentPlatformVersion: { ...head, id: 'head-2' } }));
    await act(async () => { await client.invalidateQueries({ queryKey: ['skill-versions'] }); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认发布' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('409 平台版本已变化');
    expect(post).toHaveBeenCalledWith('/admin/skill-versions/source-1/publish', { expectedUpdatedAt: version().updatedAt, expectedPlatformVersionId: 'head-1' });
    expect(push).not.toHaveBeenCalled();
  });
  it.each([{ currentPlatformVersion: undefined }, { content: '   ' }])('基线字段缺失或空正文时禁止发布 %#', async (overrides) => {
    get.mockResolvedValue(version(overrides)); mount(<DetailPage />);
    expect(await screen.findByRole('button', { name: '发布为平台版本' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });
  it('返回与发布成功跳转保留能力上下文，版本 ID 使用 URL 编码', async () => {
    navigation.search = 'capabilityId=cap%2F1&scope=PLATFORM'; navigation.versionId = 'source/1';
    get.mockResolvedValue(version({ id: 'source/1' })); post.mockResolvedValue(version({ id: 'published/1' }));
    mount(<DetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '返回技能监控' }));
    expect(push).toHaveBeenCalledWith('/admin/skills?capabilityId=cap%2F1&scope=PLATFORM');
    await confirmPublish();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills/published%2F1?capabilityId=cap%2F1&scope=PLATFORM'));
    expect(post).toHaveBeenCalledWith('/admin/skill-versions/source%2F1/publish', expect.any(Object));
  });
});

describe('monitor 详情校验与操作错误', () => {
  it('展示现存技能包的资源提醒并允许发布', async () => {
    const message = '资源引用未匹配到包内文件：scripts/missing.py。不影响审核通过。';
    get.mockResolvedValue(version({ packageWarnings: [{ code: 'RESOURCE_REFERENCE', path: 'scripts/missing.py', message }] }));
    post.mockResolvedValue(version({ id: 'platform-1' }));
    mount(<DetailPage />);
    expect(await screen.findByRole('region', { name: '技能包提醒' })).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: '发布为平台版本' })).toBeEnabled();
    await confirmPublish();
    await waitFor(() => expect(post).toHaveBeenCalled());
  });

  const actions = [
    { name: '来源发布', overrides: {} },
    { name: '历史草稿发布', overrides: { scope: 'PLATFORM', status: 'DRAFT' } },
    { name: '历史待审发布', overrides: { scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW' } },
  ] satisfies { name: string; overrides: Partial<MonitorDetail> }[];

  it.each(actions)('$name：warning 只展示 message，不阻断发布', async ({ overrides }) => {
    const message = '建议补充“角色”标题 <script>alert("warning")</script>';
    get.mockResolvedValue(version({
      ...overrides,
      validationResult: {
        valid: true,
        issues: [],
        checks: [{ code: 'SECTION_ROLE', passed: false, message: '不能直接展示的检查对象' }],
        warnings: [
          { code: 'SECTION_ROLE', message, path: 'private/path', raw: 'private-value' },
          null, '不能展示的原始字符串', { message: { secret: '不能展示的原始对象' } }, { message: '   ' },
        ],
        raw: '不能展示的原始结果',
      },
    }));
    post.mockResolvedValue(version({ id: 'platform-1' }));
    mount(<DetailPage />);
    const validation = await screen.findByRole('region', { name: '已存校验结果' });
    expect(within(validation).getByText('已存静态校验通过')).toBeInTheDocument();
    const warnings = within(validation).getByRole('list', { name: '校验提醒' });
    expect(within(warnings).getAllByRole('listitem')).toHaveLength(1);
    expect(warnings).toHaveTextContent(message);
    expect(validation.querySelector('script')).toBeNull();
    expect(validation).not.toHaveTextContent(/private\/path|private-value|SECTION_ROLE|不能展示|不能直接展示|\[object Object\]/);
    expect(screen.getByRole('button', { name: '发布为平台版本' })).toBeEnabled();
    await confirmPublish();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/skill-versions/source-1/publish', expect.any(Object)));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(actions)('$name：具体失败持续显示，刷新不清除，重试及成功清理', async ({ overrides }) => {
    const detail = version(overrides);
    const message = '校验失败：Skill 正文至少需要 20 个字符；正文不能包含敏感凭据；能力包未通过安全扫描';
    get.mockResolvedValue(detail);
    let resolveRetry!: (value: MonitorDetail) => void;
    post.mockRejectedValueOnce(new Error(message)).mockImplementationOnce(() => new Promise<MonitorDetail>((resolve) => { resolveRetry = resolve; }));
    const client = mount(<DetailPage />);
    await confirmPublish();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(toastError).toHaveBeenCalledWith(message);
    expect(push).not.toHaveBeenCalled();
    await act(async () => { await client.invalidateQueries({ queryKey: ['skill-versions'] }); });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('region', { name: '只读正文' })).toHaveTextContent(detail.content);
    await waitFor(() => expect(screen.getByRole('button', { name: '发布为平台版本' })).toBeEnabled());
    await confirmPublish();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await act(async () => { resolveRetry(version({ id: 'platform-1' })); });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(post).toHaveBeenLastCalledWith('/admin/skill-versions/source-1/publish', expect.any(Object));
    expect(push).toHaveBeenCalledWith('/admin/skills/platform-1');
  });

  it.each([
    { validationResult: { valid: false, issues: [{ code: 'SECTION_ROLE', message: '历史校验缺少角色标题' }], warnings: [{ message: '建议补充示例' }] } },
    { validationResult: { valid: false, checks: [{ code: 'SECTION_ROLE', passed: false, message: '历史校验缺少角色标题' }] } },
    { validationResult: { checks: [{ code: 'SECTION_ROLE', passed: false, message: '历史校验缺少角色标题' }] } },
  ])('保留历史失败标题，不按新 warning 规则改判通过 %#', async (overrides) => {
    get.mockResolvedValue(version(overrides));
    mount(<DetailPage />);
    const validation = await screen.findByRole('region', { name: '已存校验结果' });
    expect(within(validation).getByText('已存静态校验未通过')).toBeInTheDocument();
    expect(within(validation).getByRole('list', { name: '校验问题' })).toHaveTextContent('历史校验缺少角色标题');
    expect(validation).not.toHaveTextContent('已存静态校验通过');
    expect(validation).not.toHaveTextContent('安全通过');
    expect(screen.getByRole('button', { name: '发布为平台版本' })).toBeEnabled();
  });

  it.each([
    { validationResult: undefined, label: '无已存校验结果' },
    { validationResult: null, label: '无已存校验结果' },
    { validationResult: {}, label: '已存校验状态未标注' },
    { validationResult: '旧格式记录', label: '已存校验状态未标注' },
    { validationResult: [], label: '已存校验状态未标注' },
    { validationResult: { warnings: { message: '非数组' }, issues: '旧字段', checks: null }, label: '已存校验状态未标注' },
    { validationResult: { valid: false, issues: [null, { message: { raw: '不能展示' } }], warnings: [42] }, label: '已存静态校验未通过' },
  ])('旧/无校验字段兼容且不误报通过 %#', async ({ validationResult, label }) => {
    get.mockResolvedValue(version({ validationResult }));
    mount(<DetailPage />);
    const validation = await screen.findByRole('region', { name: '已存校验结果' });
    expect(within(validation).getByText(label)).toBeInTheDocument();
    expect(within(validation).queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发布为平台版本' })).toBeEnabled();
  });
  it.each(['403 无权发布', '409 来源版本已变化', '409 当前平台版本已变化', '能力包正文与所选版本不一致'])('发布失败 %s 不导航，刷新后错误保留且使用新预览重试', async (message) => {
    get.mockResolvedValue(version()); post.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(version({ id: 'platform-1' }));
    mount(<DetailPage />); await confirmPublish();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(push).not.toHaveBeenCalled();
    const nextUpdatedAt = '2026-10-09T02:00:00.000Z';
    get.mockResolvedValue(version({ updatedAt: nextUpdatedAt, currentPlatformVersion: { id: 'head-2', capabilityId: 'mapped-cap', version: '1.0.2', content: '平台正文', updatedAt: nextUpdatedAt } }));
    fireEvent.click(screen.getByRole('button', { name: '刷新预览' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '当前平台版本' })).toHaveTextContent('平台版 v1.0.2'));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    await confirmPublish();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/skills/platform-1'));
    expect(post).toHaveBeenLastCalledWith('/admin/skill-versions/source-1/publish', { expectedUpdatedAt: nextUpdatedAt, expectedPlatformVersionId: 'head-2' });
  });
});

describe('monitor 展示兼容', () => {
  it('历史企业版缺来源不冒用管理员，规范化空来源也不使用创建人兜底', () => {
    const admin = { id: 'admin-1', name: '审核管理员' };
    expect(originalSubmitterLabel(version({ scope: 'ENTERPRISE', createdBy: admin }))).toBe('未标注');
    expect(originalSubmitterLabel(version({ createdBy: admin, originalSubmitters: [] }))).toBe('未标注');
    expect(originalSubmitterLabel(version({ createdBy: admin }))).toBe('审核管理员');
    expect(originalSubmitterLabel(version({ originalSubmitters: [{ id: 'deleted-name', name: null }] }))).toBe('deleted-name');
  });
  it('产生方式独立于审核状态，当前发布不能由通过推断', () => {
    expect(creationMethodLabel(version({ isWorkingCopy: true }))).toBe('历史副本');
    expect(creationMethodLabel(version({ scope: 'ENTERPRISE', sourceVersionId: 'source' }))).toBe('审核生成');
    expect(creationMethodLabel(version({ scope: 'PLATFORM' }))).toBe('运营创建');
    expect(creationMethodLabel(version({ scope: 'PLATFORM', sourceVersionId: 'source' }))).toBe('平台收录');
    expect(currentUsageLabel(version({ status: 'PLATFORM_APPROVED' }))).toBe('使用状态未标注');
    expect(currentUsageLabel(version({ scope: 'PLATFORM', isEnterpriseCurrent: true, isPlatformLatest: true, isMarketPublic: true }))).toBe('企业已启用 · 平台已发布');
    expect(currentUsageLabel(version({ scope: 'PLATFORM', status: 'PLATFORM_APPROVED', isPlatformLatest: false }))).toBe('历史版本');
    expect(creationMethodLabel(version({ generationType: 'REVIEW_SNAPSHOT' }))).toBe('审核快照');
  });
  it('变化后的历史工作副本可以选择新快照', () => {
    expect(canSelectSource(version({ isWorkingCopy: true, reviewSnapshots: [{ ...version(), workingCopyUpdatedAt: '2026-10-07T00:00:00.000Z', promotedVersions: [version()] }] }))).toBe(true);
    expect(monitorQuery({}, 20, 100)).toBe('page=20&limit=100');
  });
  it('发布判断不复用旧收录判断：草稿/拒绝关系不阻止首次发布，已发布来源不可重发', () => {
    const pending = version({ scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW' });
    const approved = version({ scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    expect(canPublishVersion(version({ promotedVersions: [pending] }))).toBe(true);
    expect(canPublishVersion(version({ promotedVersions: [pending, approved] }))).toBe(false);
    expect(canPublishVersion(version({ isWorkingCopy: true, reviewSnapshots: [{ ...version(), workingCopyUpdatedAt: '2026-10-07T00:00:00.000Z', promotedVersions: [approved] }] }))).toBe(true);
  });
  it.each(['DRAFT', 'PENDING_PLATFORM_REVIEW', 'PLATFORM_REJECTED'] as const)('旧已发布快照不影响工作副本当前 revision 的 %s 关系', (status) => {
    const oldPlatform = version({ id: 'platform-old', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    const row = version({ isWorkingCopy: true, platformProcessingStatus: 'APPROVED', reviewSnapshots: [
      { ...version(), workingCopyUpdatedAt: '2026-10-07T00:00:00.000Z', promotedVersions: [oldPlatform] },
      { ...version(), workingCopyUpdatedAt: version().updatedAt, promotedVersions: [version({ scope: 'PLATFORM', status })] },
    ] });
    expect(publishedSourceVersion(row)).toBeUndefined();
    expect(canPublishVersion(row)).toBe(true);
  });
  it('工作副本多个已发布快照只返回当前 revision 的平台版本', () => {
    const oldPlatform = version({ id: 'platform-old', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    const currentPlatform = version({ id: 'platform-current', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    const row = version({ isWorkingCopy: true, reviewSnapshots: [
      { ...version(), workingCopyUpdatedAt: '2026-10-07T00:00:00.000Z', promotedVersions: [oldPlatform] },
      { ...version(), workingCopyUpdatedAt: version().updatedAt, promotedVersions: [currentPlatform] },
    ] });
    expect(publishedSourceVersion(row)).toBe(currentPlatform);
    expect(canPublishVersion(row)).toBe(false);
  });
  it.each([undefined, null])('缺少 revision（%s）的旧已发布快照保守阻止重发', (workingCopyUpdatedAt) => {
    const platform = version({ scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    const row = version({ isWorkingCopy: true, reviewSnapshots: [{ ...version(), workingCopyUpdatedAt, promotedVersions: [platform] }] });
    expect(publishedSourceVersion(row)).toBe(platform);
    expect(canPublishVersion(row)).toBe(false);
  });
  it('工作副本没有快照关系时不以汇总 APPROVED 推断当前 revision 已发布', () => {
    const row = version({ isWorkingCopy: true, platformProcessingStatus: 'APPROVED' });
    expect(publishedSourceVersion(row)).toBeUndefined();
    expect(canPublishVersion(row)).toBe(true);
  });
  it.each([false, undefined])('非工作副本（%s）仍考虑所有快照的已发布关系', (isWorkingCopy) => {
    const platform = version({ scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    const row = version({ isWorkingCopy, reviewSnapshots: [{ ...version(), workingCopyUpdatedAt: '2026-10-07T00:00:00.000Z', promotedVersions: [platform] }] });
    expect(publishedSourceVersion(row)).toBe(platform);
    expect(canPublishVersion(row)).toBe(false);
  });
  it('工作副本的直接已发布关系没有 revision，保守阻止重发', () => {
    const platform = version({ scope: 'PLATFORM', status: 'PLATFORM_APPROVED' });
    const row = version({ isWorkingCopy: true, promotedVersions: [platform] });
    expect(publishedSourceVersion(row)).toBe(platform);
    expect(canPublishVersion(row)).toBe(false);
  });
});
