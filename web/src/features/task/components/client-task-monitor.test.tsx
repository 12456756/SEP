import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientTaskMirrorDetailView, ClientTaskMonitor } from './client-task-monitor';
import { clientTaskMonitorDetailFixture, clientTaskMonitorOptionsFixture } from './client-task-monitor.fixture';
import type { ClientTaskMirror, ClientTaskMirrorDetail, ClientTaskMirrorEvent, ClientTaskMirrorPage } from '../use-client-task-mirrors';
import { ApiError } from '@/lib/api-client';
import type { EmployeeUsageDetail } from '@/features/employee/use-employee-usage';

const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), scopedDetail: vi.fn(), options: vi.fn(), refetch: vi.fn(), refetchOptions: vi.fn() }));
vi.mock('../use-client-task-mirrors', async (importOriginal) => ({
  ...await importOriginal<typeof import('../use-client-task-mirrors')>(),
  useClientTaskMirrors: mocks.list, useClientTaskMirror: mocks.detail, useClientTaskMirrorFilterOptions: mocks.options,
}));
vi.mock('@/features/employee/use-employee-usage', () => ({ useEmployeeUsageDetail: mocks.scopedDetail }));

const task: ClientTaskMirror = { ...clientTaskMonitorDetailFixture, status: 'PAUSED', lastHeartbeatAt: '2020-01-01T00:00:00Z' };
const page = (items = [task], total = items.length, page = 1): ClientTaskMirrorPage => ({ items, total, page, limit: 50, hasNextPage: page * 50 < total });
const event = (sequence: number, type: string, message: string, stepKey: string | null = null): ClientTaskMirrorEvent => ({ id: String(sequence), clientRunId: 'run-1', sequence, type, message, stepKey, progress: null, occurredAt: null, createdAt: '' });
const detail = (events: ClientTaskMirrorEvent[]): ClientTaskMirrorDetail => ({ ...task, runs: [], events });
const scopedDetail = (text = '当前员工正文'): EmployeeUsageDetail => ({
  source: 'client', recordId: task.id,
  task: { id: task.id, clientTaskId: task.clientTaskId, title: task.title },
  runs: [{ ...clientTaskMonitorDetailFixture.runs![0], queuedAt: '2026-10-09T00:59:00Z', participations: [{
    ...clientTaskMonitorDetailFixture.runs![0].participations[0], subscriptionName: '研究助手', events: [event(1, 'model_output', text)],
  }] }],
});
const taskRow = () => screen.getByRole('button', { name: /联调任务/ });

beforeEach(() => {
  window.history.replaceState(null, '', '/tasks?tab=monitoring');
  vi.clearAllMocks();
  mocks.list.mockReturnValue({ data: page(), refetch: mocks.refetch });
  mocks.options.mockReturnValue({ data: clientTaskMonitorOptionsFixture, refetch: mocks.refetchOptions });
  mocks.detail.mockReturnValue({ data: detail([]), refetch: mocks.refetch });
  mocks.scopedDetail.mockReturnValue({ data: scopedDetail(), refetch: mocks.refetch });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('client monitor', () => {
  it('defaults to all statuses and suppresses default or mismatched progress evidence', () => {
    render(<ClientTaskMonitor />);
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ view: 'history', sort: 'activityAt_desc', statuses: undefined }));
    expect(screen.queryByRole('option', { name: /未知/ })).not.toBeInTheDocument();
    expect(within(taskRow()).queryByText(/%/)).not.toBeInTheDocument();
    expect(within(taskRow()).getByText('来源未核实')).toBeInTheDocument();
  });
  it('shows only explicitly reported progress and interrupted stop time', () => {
    mocks.list.mockReturnValue({ data: page([{ ...task, status: 'INTERRUPTED', progress: 0, stateEvidence: {
      version: 1, reportedStatus: 'INTERRUPTED', source: 'local-run', observedAt: '2026-10-10T01:00:00Z', progress: 32,
      runEndedAt: '2026-10-10T00:59:00Z',
    } }]) });
    render(<ClientTaskMonitor />);
    expect(within(taskRow()).getByText('32%')).toBeInTheDocument();
    expect(within(taskRow()).getByText(/停止：/)).toBeInTheDocument();
    expect(within(taskRow()).queryByText(/心跳延迟/)).not.toBeInTheDocument();
  });
  it('restores URL filters on reload and popstate without accepting UNKNOWN', () => {
    window.history.replaceState(null, '', '/tasks?tab=monitoring&scopeSubscriptionId=sub-1&monitorSubscriptionId=sub-2&statuses=INTERRUPTED,UNKNOWN&page=2&q=report');
    render(<ClientTaskMonitor />);
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ scopeSubscriptionId: 'sub-1', subscriptionId: 'sub-2', statuses: 'INTERRUPTED', page: 2, q: 'report' }));
    act(() => {
      window.history.replaceState(null, '', '/tasks?tab=monitoring&scopeSubscriptionId=sub-1&statuses=COMPLETED');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ scopeSubscriptionId: 'sub-1', statuses: 'COMPLETED', page: 1, q: undefined }));
    expect(screen.getByLabelText('搜索任务标题')).toHaveValue('');
  });
  it('renders legacy candidates without pretending they are proven participation', () => {
    mocks.options.mockReturnValue({ data: { ...clientTaskMonitorOptionsFixture, subscriptions: [{
      subscriptionId: 'legacy', employeeId: null, employeeName: '旧员工', subscriptionName: null, legacy: true,
    }] } });
    render(<ClientTaskMonitor />);
    expect(screen.getByRole('option', { name: '旧员工 · 旧记录归属未核实' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('员工筛选'), { target: { value: 'legacy' } });
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ subscriptionId: 'legacy', scopeSubscriptionId: undefined }));
  });
  it('keeps the reply region for empty detail and hides raw metadata JSON', () => {
    const metadata = event(1, 'content_recovery', JSON.stringify({ version: 1, reason: 'source-missing', checkedAt: '2026-10-10T01:00:00Z', source: 'local-history' }));
    render(<ClientTaskMirrorDetailView detail={detail([metadata])} />);
    expect(screen.getByRole('region', { name: '员工回复' })).toHaveTextContent('历史回复无法恢复');
    expect(screen.queryByText(metadata.message!)).not.toBeInTheDocument();
  });
  it('shows compact activity and business time without opening detail', () => {
    render(<ClientTaskMonitor />);
    const row = within(taskRow());
    expect(row.getByText('生成中')).toBeInTheDocument();
    expect(row.getByText(/业务发生（UTC\+8）：.*9:00:20/)).toBeInTheDocument();
    expect(row.queryByText(/版本|最近同步|当前步骤/)).not.toBeInTheDocument();
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it('falls back only to a reported current step when activity is absent', () => {
    mocks.list.mockReturnValue({ data: page([{ ...task, activity: null }]) });
    render(<ClientTaskMonitor />);
    expect(within(taskRow()).getByText('处理输入')).toBeInTheDocument();
    expect(within(taskRow()).queryByText(/当前步骤/)).not.toBeInTheDocument();
  });
  it('does not infer missing activity or start time from task status or heartbeat', () => {
    mocks.list.mockReturnValue({ data: page([{ ...task, activity: null, currentStep: null, startedAt: null }]) });
    render(<ClientTaskMonitor />);
    expect(within(taskRow()).queryByText(/未同步|开始（UTC/)).not.toBeInTheDocument();
  });
  it('does not replace a paused task state with an offline inference', () => {
    render(<ClientTaskMonitor />);
    expect(within(taskRow()).getByText('已暂停')).toBeInTheDocument();
    expect(within(taskRow()).getByText(/心跳延迟/)).toBeInTheDocument();
  });
  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'])('does not mark terminal %s tasks offline because their heartbeat stopped', (status) => {
    mocks.list.mockReturnValue({ data: page([{ ...task, status }]) });
    render(<ClientTaskMonitor />);
    expect(within(taskRow()).queryByText(/心跳延迟/)).not.toBeInTheDocument();
  });
  it('updates heartbeat age with a clock and clears the interval on unmount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T02:00:00Z'));
    mocks.list.mockReturnValue({ data: page([{ ...task, status: 'RUNNING', lastHeartbeatAt: '2026-10-09T01:59:05Z' }]) });
    const { unmount } = render(<ClientTaskMonitor />);
    expect(within(taskRow()).queryByText(/心跳延迟/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10000));
    expect(within(taskRow()).getByText('心跳延迟 · 65 秒未收到')).toBeInTheDocument();
    expect(within(taskRow()).getByText('执行中')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10000));
    expect(within(taskRow()).getByText('心跳延迟 · 75 秒未收到')).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shows all server-authorized users and proven employee summary without local filtering', () => {
    mocks.list.mockReturnValue({ data: page([task, { ...task, id: 'mirror-2', title: '另一个成员的任务', user: { id: 'u-2', name: '用户乙' } }]) });
    render(<ClientTaskMonitor />);
    expect(screen.getByText('另一个成员的任务')).toBeInTheDocument();
    expect(within(taskRow()).getByText(/用户甲/)).toBeInTheDocument();
    expect(within(taskRow()).getByText('研究助手 · 1 次执行')).toBeInTheDocument();
    expect(screen.getByText(/结果 2 条 · 权限范围 33 条/)).toBeInTheDocument();
  });
  it('displays complete multiline input/output, creator and update time on expansion', () => {
    mocks.detail.mockReturnValue({ data: detail([event(1, 'user_input', '输入\n第二行'), event(2, 'model_output', '答复'.repeat(600), 'content:v1:m:0:2'), event(3, 'model_output', '末尾', 'content:v1:m:1:2')]) });
    render(<ClientTaskMonitor />);
    expect(mocks.detail).not.toHaveBeenCalled();
    fireEvent.click(taskRow());
    expect(screen.getByText('用户输入')).toBeInTheDocument();
    expect(screen.getByText('员工回复')).toBeInTheDocument();
    expect(screen.getByText('输入 第二行')).toBeInTheDocument();
    expect(screen.getByText(`${'答复'.repeat(600)}末尾`)).toBeInTheDocument();
    expect(screen.getByText('已收到回复，完整性未核实')).toBeInTheDocument();
    expect(screen.getByText(/更新时间（UTC\+8）：/)).toBeInTheDocument();
    expect(mocks.detail).toHaveBeenLastCalledWith(task.id);
  });
  it('warns for missing content chunks and approximate content timestamps', () => {
    mocks.detail.mockReturnValue({ data: detail([event(1, 'model_output', '部分内容', 'content:v1:m:0:2')]) });
    render(<ClientTaskMonitor />);
    fireEvent.click(taskRow());
    expect(screen.getByText('回复同步未完成：已收到 1/2 个片段')).toBeInTheDocument();
    expect(screen.getByText(/正文时间近似/)).toBeInTheDocument();
    expect(screen.getByText(/发生时间（UTC\+8）：时间未知 · 接收时间（UTC\+8）：时间未知/)).toBeInTheDocument();
  });
  it('queries separate pages and closes the previous detail', () => {
    mocks.list.mockImplementation((_enabled, { page: requested }) => ({ data: page([task], 101, requested) }));
    render(<ClientTaskMonitor />);
    fireEvent.click(taskRow());
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ page: 2, limit: 50, view: 'history', sort: 'activityAt_desc' }));
    expect(screen.getByText('第 2 页 · 每页 50 条')).toBeInTheDocument();
    expect(screen.queryByText(/任务事件 ·/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ page: 1, limit: 50 }));
  });
  it('allows returning from a failed page and retrying', () => {
    mocks.list.mockImplementation((_enabled, { page: requested }) => requested === 1 ? { data: page([task], 100) } : { isError: true, refetch: mocks.refetch });
    render(<ClientTaskMonitor />);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByRole('alert')).toHaveTextContent('客户端任务监控暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
    expect(taskRow()).toBeInTheDocument();
  });
  it('distinguishes empty cloud records from missing local tasks', () => {
    mocks.list.mockReturnValue({ data: page([]) });
    render(<ClientTaskMonitor />);
    expect(screen.getByText('暂无已同步的客户端任务')).toBeInTheDocument();
  });
  it('shows detail errors rather than a false empty result and allows retry', () => {
    mocks.detail.mockReturnValue({ isError: true, refetch: mocks.refetch });
    render(<ClientTaskMonitor />);
    fireEvent.click(taskRow());
    expect(screen.getByRole('alert')).toHaveTextContent('事件读取失败，请稍后重试。记录可能不存在或没有访问权限。');
    fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
  it('shows a compatibility notice for old server responses', () => {
    mocks.list.mockReturnValue({ data: { ...page(), legacy: true } });
    render(<ClientTaskMonitor />);
    expect(screen.getByText(/服务端尚未支持完整分页/)).toBeInTheDocument();
  });
  it('uses server status counts with history only, resetting pagination and detail', () => {
    mocks.list.mockImplementation((_enabled, { page: requested }) => ({ data: page([task], 101, requested) }));
    render(<ClientTaskMonitor />);
    expect(screen.getByRole('combobox', { name: '任务状态' })).toHaveValue('');
    expect(screen.getByRole('option', { name: '执行中 · 1' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    fireEvent.click(taskRow());
    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: 'COMPLETED' } });
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ view: 'history', statuses: 'COMPLETED', page: 1 }));
    expect(screen.queryByText(/任务事件 ·/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: '' } });
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ view: 'history', page: 1 }));
  });
  it('applies dropdowns immediately and debounces title search with UTC+8 date bounds', () => {
    vi.useFakeTimers();
    render(<ClientTaskMonitor />);
    expect(screen.queryByText('高级筛选')).not.toBeInTheDocument();
    expect(screen.getByLabelText('成员筛选')).toBeVisible();
    expect(screen.getByLabelText('任务类型筛选')).toBeVisible();
    expect(screen.getByLabelText('任务排序')).toBeVisible();
    expect(screen.getByLabelText('时间范围起点')).toBeVisible();
    fireEvent.change(screen.getByLabelText('搜索任务标题'), { target: { value: '  报告  ' } });
    fireEvent.change(screen.getByLabelText('员工筛选'), { target: { value: 'sub-1' } });
    fireEvent.change(screen.getByLabelText('成员筛选'), { target: { value: 'u-2' } });
    fireEvent.change(screen.getByLabelText('任务类型筛选'), { target: { value: 'workflow' } });
    fireEvent.change(screen.getByLabelText('任务排序'), { target: { value: 'startedAt_asc' } });
    fireEvent.change(screen.getByLabelText('时间范围起点'), { target: { value: '2026-10-09T00:00' } });
    fireEvent.change(screen.getByLabelText('时间范围终点'), { target: { value: '2026-10-10T00:00' } });
    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: 'PAUSED' } });
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ view: 'history', subscriptionId: 'sub-1', userId: 'u-2', statuses: 'PAUSED', q: undefined }));
    act(() => vi.advanceTimersByTime(299));
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ q: undefined }));
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ page: 1, limit: 50, view: 'history', q: '报告', subscriptionId: 'sub-1', userId: 'u-2',
      taskType: 'workflow', sort: 'startedAt_asc', statuses: 'PAUSED', from: '2026-10-08T16:00:00.000Z', to: '2026-10-09T16:00:00.000Z' }));
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ page: 1, limit: 50, view: 'history', sort: 'activityAt_desc', q: undefined, subscriptionId: undefined }));
    expect(screen.getByLabelText('搜索任务标题')).toHaveValue('');
  });
  it('rejects backwards time bounds without querying them', () => {
    render(<ClientTaskMonitor />);
    fireEvent.change(screen.getByLabelText('时间范围起点'), { target: { value: '2026-10-10T00:00' } });
    fireEvent.change(screen.getByLabelText('时间范围终点'), { target: { value: '2026-10-09T00:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('结束时间必须晚于开始时间');
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ from: '2026-10-09T16:00:00.000Z', to: undefined }));
  });
  it('does not infer filter options or counts from page items and refreshes both endpoints', () => {
    mocks.options.mockReturnValue({ isError: true, refetch: mocks.refetchOptions });
    render(<ClientTaskMonitor />);
    expect(screen.getByRole('option', { name: '已完成' })).toBeInTheDocument();
    expect(screen.queryByText(/当前权限范围共/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('员工筛选')).getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '重试选项' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(mocks.refetchOptions).toHaveBeenCalledTimes(2);
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
  it.each(['empty', 'loading', 'error'])('opens authorized deep-link detail independently of an %s list', (state) => {
    mocks.list.mockReturnValue(state === 'empty' ? { data: page([]) } : state === 'loading' ? { isLoading: true } : { isError: true });
    const { rerender } = render(<ClientTaskMonitor taskId="offpage-mirror" subscriptionId="sub-1" />);
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client', recordId: 'offpage-mirror' }, 10000);
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: '指定任务详情' })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ scopeSubscriptionId: 'sub-1' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭指定任务详情' }));
    expect(screen.queryByRole('region', { name: '指定任务详情' })).not.toBeInTheDocument();
    rerender(<ClientTaskMonitor taskId="another-mirror" subscriptionId="sub-1" />);
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client', recordId: 'another-mirror' }, 10000);
  });
  it('reopens the same deep link after leaving it, without reopening on an ordinary rerender', () => {
    const { rerender } = render(<ClientTaskMonitor taskId="offpage-mirror" />);
    fireEvent.click(screen.getByRole('button', { name: '关闭指定任务详情' }));
    rerender(<ClientTaskMonitor taskId="offpage-mirror" />);
    expect(screen.queryByRole('region', { name: '指定任务详情' })).not.toBeInTheDocument();
    rerender(<ClientTaskMonitor />);
    rerender(<ClientTaskMonitor taskId="offpage-mirror" />);
    expect(screen.getByRole('region', { name: '指定任务详情' })).toBeInTheDocument();
    expect(mocks.detail).toHaveBeenLastCalledWith('offpage-mirror');
  });
  it('reopens a dismissed deep link when navigating to a different subscription', () => {
    const { rerender } = render(<ClientTaskMonitor taskId="offpage-mirror" subscriptionId="sub-1" />);
    fireEvent.click(screen.getByRole('button', { name: '关闭指定任务详情' }));
    rerender(<ClientTaskMonitor taskId="offpage-mirror" subscriptionId="sub-2" />);
    expect(screen.getByRole('region', { name: '指定任务详情' })).toBeInTheDocument();
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-2', { source: 'client', recordId: 'offpage-mirror' }, 10000);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it('expanded rows use only the applied employee scope and never request full task text', () => {
    mocks.detail.mockReturnValue({ data: detail([event(1, 'model_output', '其他员工正文')]) });
    render(<ClientTaskMonitor subscriptionId="sub-1" />);
    fireEvent.change(screen.getByLabelText('员工筛选'), { target: { value: 'sub-1' } });
    expect(mocks.scopedDetail).not.toHaveBeenCalled();
    fireEvent.click(taskRow());
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client', recordId: task.id }, 10000);
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(screen.getByText('当前员工正文')).toBeInTheDocument();
    expect(screen.queryByText('其他员工正文')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '任务监控' })).not.toBeInTheDocument();
  });
  it('pinned detail and reset never release the fixed subscription scope', () => {
    mocks.options.mockReturnValue({ data: { ...clientTaskMonitorOptionsFixture, subscriptions: [
      ...clientTaskMonitorOptionsFixture.subscriptions,
      { subscriptionId: 'sub-2', employeeId: 'employee-2', employeeName: '审核员', subscriptionName: '审核助手' },
    ] } });
    render(<ClientTaskMonitor taskId="offpage-mirror" subscriptionId="sub-1" />);
    fireEvent.change(screen.getByLabelText('员工筛选'), { target: { value: 'sub-2' } });
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client', recordId: 'offpage-mirror' }, 10000);
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client', recordId: 'offpage-mirror' }, 10000);
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ subscriptionId: 'sub-2', scopeSubscriptionId: 'sub-1' }));
    expect(screen.getByText('当前员工正文')).toBeInTheDocument();
    expect(mocks.detail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ subscriptionId: undefined, scopeSubscriptionId: 'sub-1' }));
  });
  it('clears an uncommitted search without releasing URL scope or reviving its pending debounce', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/tasks?tab=monitoring&scopeSubscriptionId=sub-1&subscriptionId=sub-1&statuses=FAILED&page=2#monitor');
    render(<ClientTaskMonitor />);
    fireEvent.change(screen.getByLabelText('搜索任务标题'), { target: { value: 'pending' } });
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    act(() => vi.advanceTimersByTime(300));
    expect(mocks.list).toHaveBeenLastCalledWith(true, expect.objectContaining({ view: 'history', page: 1, scopeSubscriptionId: 'sub-1', subscriptionId: undefined, statuses: undefined, q: undefined }));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('scopeSubscriptionId')).toBe('sub-1');
    expect(params.get('subscriptionId')).toBe('sub-1');
    expect(params.get('view')).toBe('history');
    expect(params.has('q')).toBe(false);
    expect(window.location.hash).toBe('#monitor');
    fireEvent.click(taskRow());
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client', recordId: task.id }, 10000);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it('scoped authorization failures do not fall back to full task detail', () => {
    mocks.scopedDetail.mockReturnValue({ isError: true, refetch: mocks.refetch });
    render(<ClientTaskMonitor taskId="unauthorized-mirror" subscriptionId="sub-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('没有访问权限');
    expect(mocks.detail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
  it('legacy employee links read only the same subscription legacy endpoint after verified 404', () => {
    const legacy: EmployeeUsageDetail = {
      source: 'client-legacy', recordId: task.id,
      task: { id: task.id, clientTaskId: task.clientTaskId, title: task.title },
      run: { clientRunId: 'legacy-run', status: 'COMPLETED', queuedAt: null,
        startedAt: null, completedAt: null, usedAt: '2026-10-09T01:00:00Z', timeBasis: 'legacy-received' },
      events: [{ ...event(1, 'model_output', '旧单员工正文'), clientRunId: 'legacy-run' }],
    };
    mocks.scopedDetail.mockImplementation((_subscription, record) => record.source === 'client'
      ? { isError: true, error: new ApiError(404, 'unproven'), refetch: mocks.refetch }
      : { data: legacy, refetch: mocks.refetch });
    render(<ClientTaskMonitor taskId={task.id} subscriptionId="sub-1" />);
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client-legacy', recordId: task.id }, 10000);
    expect(screen.getByText('旧单员工正文')).toBeInTheDocument();
    expect(screen.getByText(/按任务原始雇佣关系/)).toHaveTextContent('归属未核实');
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: '任务监控' })).not.toBeInTheDocument();
  });
  it('unsupported legacy arrangements explain coverage without automatically requesting full task bodies', () => {
    mocks.scopedDetail.mockReturnValue({ isError: true, error: new ApiError(404, 'unproven'), refetch: mocks.refetch });
    render(<ClientTaskMonitor taskId="legacy-arrangement" subscriptionId="sub-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('旧多员工编排不提供员工级正文');
    expect(screen.getByRole('link', { name: '查看完整任务监控' })).toHaveAttribute('href', '/tasks?tab=monitoring&taskId=legacy-arrangement');
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])('scoped %s failures never switch to legacy or full task body endpoints', (status) => {
    mocks.scopedDetail.mockReturnValue({ isError: true, error: new ApiError(status, 'denied'), refetch: mocks.refetch });
    render(<ClientTaskMonitor taskId={task.id} subscriptionId="sub-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('没有访问权限');
    expect(mocks.scopedDetail.mock.calls.every(call => call[1].source === 'client')).toBe(true);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it('navigation from full monitoring to an employee deep link never fetches new text without its scope', () => {
    const { rerender } = render(<ClientTaskMonitor taskId="full-task" />);
    mocks.detail.mockClear();
    rerender(<ClientTaskMonitor taskId="scoped-task" subscriptionId="sub-1" />);
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.scopedDetail).toHaveBeenLastCalledWith('sub-1', { source: 'client', recordId: 'scoped-task' }, 10000);
  });
  it('keeps an unauthorized deep-link error visible without falling back to a row', () => {
    mocks.detail.mockReturnValue({ isError: true, refetch: mocks.refetch });
    render(<ClientTaskMonitor taskId="unauthorized-mirror" />);
    expect(mocks.detail).toHaveBeenLastCalledWith('unauthorized-mirror');
    expect(screen.getByRole('alert')).toHaveTextContent('没有访问权限');
    expect(taskRow()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('client monitor detail partitions', () => {
  it('keeps the reply empty state and translates metadata without rendering raw JSON', () => {
    const statePayload = JSON.stringify({ version: 1, reportedStatus: 'RUNNING', source: 'live', observedAt: '2026-10-10T01:00:00Z' });
    const recoveryPayload = JSON.stringify({ version: 1, reason: 'source-missing', checkedAt: '2026-10-10T01:00:00Z', source: 'local-history' });
    render(<ClientTaskMirrorDetailView detail={detail([
      event(1, 'monitor_state', statePayload), event(2, 'monitor_state', '{invalid state json}'),
      event(3, 'content_recovery', recoveryPayload), event(4, 'content_manifest', '{invalid manifest json}'),
    ])} />);
    expect(screen.getByRole('region', { name: '员工回复' })).toHaveTextContent('历史回复无法恢复：本地源内容不存在');
    expect(screen.getByText('最后上报状态，来源未核实')).toBeInTheDocument();
    expect(screen.getByText('客户端状态证据：执行中（实时上报）')).toBeInTheDocument();
    expect(screen.getAllByText('同步证据无效，未采用')).toHaveLength(2);
    for (const raw of [statePayload, recoveryPayload, '{invalid state json}', '{invalid manifest json}']) {
      expect(screen.queryByText(raw)).not.toBeInTheDocument();
    }
    expect(screen.getByText('任务事件 · 4').closest('details')).not.toHaveAttribute('open');
  });
  it('keeps runs, nodes and repeat participations separate, including nested-only events', () => {
    const run = clientTaskMonitorDetailFixture.runs![0];
    const participant = run.participations[0];
    const attributed = (id: string, text: string, clientRunId: string, participationId: string | null) => ({ ...event(Number(id), 'model_output', text, 'content:v1:same:0:1'), id, clientRunId, participationId });
    render(<ClientTaskMirrorDetailView detail={{ ...task, runs: [
      { ...run, participations: [participant, { ...participant, id: 'p-2', executionId: 'exec-2', nodeId: 'review' },
        { ...participant, id: 'p-3', executionId: 'exec-3', events: [{ ...attributed('4', '重试正文', 'run-1', 'p-3'), clientRunId: undefined, participationId: undefined }] }] },
      { ...run, id: 'db-run-2', clientRunId: 'run-2', participations: [] },
    ], events: [attributed('1', '研究正文', 'run-1', participant.id), attributed('2', '审核正文', 'run-1', 'p-2'), attributed('3', '新批次正文', 'run-2', null)] }} />);
    expect(within(screen.getByRole('region', { name: '参与执行 execution-1' })).getByText('研究正文')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '参与执行 exec-2' })).getByText('审核正文')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '参与执行 exec-3' })).getByText('重试正文')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '运行批次 run-2' })).getByText('新批次正文')).toBeInTheDocument();
    expect(screen.queryByText('研究正文审核正文')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '研究助手' }).every((link) => link.getAttribute('href') === '/my-employees/sub-1')).toBe(true);
  });
  it('deduplicates top-level and nested events and distinguishes occurrence from receipt', () => {
    const fixture = clientTaskMonitorDetailFixture;
    render(<ClientTaskMirrorDetailView detail={{ ...fixture, runs: [{ ...fixture.runs![0], participations: [{ ...fixture.runs![0].participations[0], events: fixture.events }] }] }} />);
    expect(screen.getAllByText('研究结果 第二段正文')).toHaveLength(1);
    expect(screen.getByText(/任务事件 · 3/)).toBeInTheDocument();
    expect(screen.getByText(/发生时间（UTC\+8）：.*9:00:10.*接收时间（UTC\+8）：.*10:00:00/)).toBeInTheDocument();
    expect(screen.queryByText(/正文时间近似/)).not.toBeInTheDocument();
  });
  it('leaves unproven legacy or contradictory event attribution explicitly unresolved', () => {
    const run = clientTaskMonitorDetailFixture.runs![0];
    render(<ClientTaskMirrorDetailView detail={{ ...task, runs: [run], events: [
      { ...event(1, 'model_output', '未知归属'), clientRunId: undefined },
      { ...event(2, 'model_output', '错误节点'), participationId: 'missing-participant' },
    ] }} />);
    const unresolved = screen.getByRole('region', { name: '历史归属未确认' });
    expect(within(unresolved).getByText('未知归属')).toBeInTheDocument();
    expect(within(unresolved).getByText('错误节点')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '参与执行 execution-1' })).queryByText('错误节点')).not.toBeInTheDocument();
    expect(screen.getByText(/未确认事件不会归到当前员工或节点/)).toBeInTheDocument();
  });
});
