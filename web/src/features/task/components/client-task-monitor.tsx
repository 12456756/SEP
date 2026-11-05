'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronLeft, ChevronRight, Monitor, RefreshCw, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner } from '@/components/ui/feedback';
import { EmployeeUsageBody } from '@/features/employee/employee-usage-records';
import { ApiError } from '@/lib/api-client';
import { useEmployeeUsageDetail } from '@/features/employee/use-employee-usage';
import {
  CLIENT_TASK_STATUS_LABELS,
  useClientTaskMirror,
  useClientTaskMirrors,
  useClientTaskMirrorFilterOptions,
  type ClientTaskMirror,
  type ClientTaskMirrorDetail,
  type ClientTaskMirrorListOptions,
  type ClientTaskMirrorSort,
  type ClientTaskSubscriptionOption,
} from '../use-client-task-mirrors';
import { validatedStateEvidence } from '../client-task-content';
import { ClientTaskContentView as EventContent, ClientTaskEvidence } from '../client-task-content-view';

const labels: Record<string, string> = { ...CLIENT_TASK_STATUS_LABELS, UNKNOWN: '状态未知' };
const taskTypes: Record<string, string> = { conversation: '对话', workflow: '工作流', arrangement: '编排', task: '任务' };
const sorts: Record<ClientTaskMirrorSort, string> = {
  activityAt_desc: '业务时间 · 最新',
  queuedAt_desc: '排队时间 · 最新', queuedAt_asc: '排队时间 · 最早',
  startedAt_desc: '开始时间 · 最新', startedAt_asc: '开始时间 · 最早',
  updatedAt_desc: '更新时间 · 最新', updatedAt_asc: '更新时间 · 最早',
};
const controlClass = 'h-9 w-full min-w-0 rounded border border-glassline bg-gbg-deep px-2 text-xs text-gtext-primary';
const variant = (status: string) => status === 'COMPLETED' ? 'glass-success'
  : status === 'FAILED' || status === 'CANCELLED' || status === 'INTERRUPTED' ? 'glass-danger' : status === 'UNKNOWN' ? 'glass-warning' : 'glass-info';

function formatTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function employeeName(value: ClientTaskSubscriptionOption) {
  return value.subscriptionName || value.employeeName || '员工名称未知';
}

function EmployeeLink({ employee }: { employee: ClientTaskSubscriptionOption }) {
  return employee.subscriptionId
    ? <Link className="break-words text-gbrand-text hover:underline" href={`/my-employees/${encodeURIComponent(employee.subscriptionId)}`}>{employeeName(employee)}</Link>
    : <span>员工归属未知</span>;
}

/** Full authorized task detail; employee-scoped usage must use its scoped endpoint instead. */
export function ClientTaskMirrorDetailView({ detail }: { detail: ClientTaskMirrorDetail }) {
  const runs = detail.runs ?? [];
  // Nested events prove their parent relation. Preserve contradictory metadata as unresolved.
  const allEvents = new Map((detail.events ?? []).map((event) => [event.id, event]));
  const contradictoryIds = new Set<string>();
  for (const run of runs) for (const participation of run.participations) {
    for (const event of participation.events ?? []) {
      const existing = allEvents.get(event.id);
      if ((event.clientRunId && event.clientRunId !== run.clientRunId)
        || (event.participationId && event.participationId !== participation.id)
        || (existing?.clientRunId && existing.clientRunId !== run.clientRunId)
        || (existing?.participationId && existing.participationId !== participation.id)) contradictoryIds.add(event.id);
      allEvents.set(event.id, { ...event, clientRunId: event.clientRunId ?? run.clientRunId, participationId: event.participationId ?? participation.id });
    }
  }
  const events = [...allEvents.values()];
  const proven = events.filter((event) => !contradictoryIds.has(event.id) && runs.some((run) => run.clientRunId === event.clientRunId
    && (!event.participationId || run.participations.some((participant) => participant.id === event.participationId))));
  const provenIds = new Set(proven.map((event) => event.id));
  const unresolved = events.filter((event) => !provenIds.has(event.id));

  return <div className="min-w-0 space-y-4 text-xs text-gtext-muted">
    <details><summary className="cursor-pointer">任务诊断</summary><p>类型：{taskTypes[detail.taskType] ?? detail.taskType} · 客户端：{detail.clientVersion ?? '版本未知'} · 运行：{detail.clientRunId}</p><p>排队：{formatTime(detail.queuedAt)} · 开始：{formatTime(detail.startedAt)} · 更新时间（UTC+8）：{formatTime(detail.updatedAt)}</p></details>
    {(!runs.length || runs.some((run) => run.protocolVersion < 2) || unresolved.length > 0) && <details className="text-gwarning"><summary className="cursor-pointer">历史记录归属覆盖有限</summary>未确认事件不会归到当前员工或节点。</details>}
    {runs.map((run, index) => <section key={run.id} aria-label={`运行批次 ${run.clientRunId}`} className="min-w-0 border-t border-glassline pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-all font-medium text-gtext-primary">运行批次 {index + 1} · {run.clientRunId}</h3>
        <Badge variant={variant(run.status)}>{labels[run.status] ?? run.status}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><EmployeeLink employee={run} /><span>排队：{formatTime(run.queuedAt)}</span><span>开始：{formatTime(run.startedAt)}</span><span>结束：{formatTime(run.completedAt)}</span></div>
      <ClientTaskEvidence events={proven} status={run.status} clientRunId={run.clientRunId} />
      {(!run.participations.length || proven.some((event) => event.clientRunId === run.clientRunId && !event.participationId)) && <EventContent status={run.status} events={proven.filter((event) => event.clientRunId === run.clientRunId && !event.participationId)} />}
      {run.participations.map((participant) => <section key={participant.id} aria-label={`参与执行 ${participant.executionId}`} className="mt-4 min-w-0 border-t border-glassline pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="break-words font-medium text-gtext-secondary">{participant.title || '参与执行'}{participant.nodeId ? ` · 节点 ${participant.nodeId}` : ''}</h4>
          <Badge variant={variant(participant.status)}>{labels[participant.status] ?? participant.status}</Badge>
        </div>
        <p className="mt-2 break-all">执行：{participant.executionId} · <EmployeeLink employee={participant} /> · 模型：{participant.modelId ?? '未知'}</p>
        <p className="mt-1">开始：{formatTime(participant.startedAt)} · 结束：{formatTime(participant.completedAt)}</p>
        <ClientTaskEvidence events={proven} status={participant.status} clientRunId={run.clientRunId} participationId={participant.id} />
        <EventContent status={participant.status} events={proven.filter((event) => event.clientRunId === run.clientRunId && event.participationId === participant.id)} />
      </section>)}
    </section>)}
    {unresolved.length > 0 && <section aria-label="历史归属未确认" className="border-t border-glassline pt-4"><h3 className="text-gtext-secondary">历史归属未确认</h3><EventContent status={runs.length ? undefined : detail.status} events={unresolved} /></section>}
    {!runs.length && <ClientTaskEvidence events={events} status={detail.status} clientRunId={detail.clientRunId} />}
    {!events.length && !runs.length && <EventContent status={detail.status} events={[]} />}
    {detail.errorSummary && <p className="break-words text-gdanger">{detail.errorSummary}</p>}
  </div>;
}

function ScopedTaskDetail({ id, subscriptionId }: { id: string; subscriptionId: string }) {
  const query = useEmployeeUsageDetail(subscriptionId, { source: 'client', recordId: id }, 10000);
  if (query.isLoading) return <CenteredSpinner label="正在读取事件…" />;
  if (query.isError && query.error instanceof ApiError && query.error.status === 404) {
    return <LegacyScopedTaskDetail id={id} subscriptionId={subscriptionId} />;
  }
  if (query.isError) return <div role="alert" className="space-y-2 py-3 text-sm text-gdanger">
    <p>事件读取失败，请稍后重试。记录可能不存在或没有访问权限。</p>
    <Button variant="glass" size="sm" onClick={() => void query.refetch()}><RefreshCw className="h-3.5 w-3.5" />重试详情</Button>
  </div>;
  return query.data?.source === 'client' ? <><h3 className="mb-3 break-words text-sm text-gtext-primary">{query.data.task.title}</h3><EmployeeUsageBody subscriptionId={subscriptionId} detail={query.data} showMonitorLink={false} /></> : null;
}

function LegacyScopedTaskDetail({ id, subscriptionId }: { id: string; subscriptionId: string }) {
  const query = useEmployeeUsageDetail(subscriptionId, { source: 'client-legacy', recordId: id }, 10000);
  if (query.isLoading) return <CenteredSpinner label="正在读取旧记录…" />;
  if (query.isError) return <div role="alert" className="space-y-2 py-3 text-sm text-gdanger">
    {query.error instanceof ApiError && query.error.status === 404 ? <>
      <p>当前记录无法按单个员工读取。旧多员工编排不提供员工级正文。</p>
      <Link className="inline-flex text-gbrand-text underline" href={`/tasks?${new URLSearchParams({ tab: 'monitoring', taskId: id })}`}>查看完整任务监控</Link>
    </> : <p>事件读取失败，请稍后重试。记录可能不存在或没有访问权限。</p>}
    <Button variant="glass" size="sm" onClick={() => void query.refetch()}><RefreshCw className="h-3.5 w-3.5" />重试详情</Button>
  </div>;
  return query.data?.source === 'client-legacy' ? <><h3 className="mb-3 break-words text-sm text-gtext-primary">{query.data.task.title}</h3><EmployeeUsageBody subscriptionId={subscriptionId} detail={query.data} showMonitorLink={false} /></> : null;
}

function FullTaskDetail({ id }: { id: string }) {
  const query = useClientTaskMirror(id);
  if (query.isLoading) return <CenteredSpinner label="正在读取事件…" />;
  if (query.isError) return <div role="alert" className="space-y-2 py-3 text-sm text-gdanger">
    <p>事件读取失败，请稍后重试。记录可能不存在或没有访问权限。</p>
    <Button variant="glass" size="sm" onClick={() => void query.refetch()}><RefreshCw className="h-3.5 w-3.5" />重试详情</Button>
  </div>;
  return query.data ? <><h3 className="mb-3 break-words text-sm text-gtext-primary">{query.data.title}</h3><ClientTaskMirrorDetailView detail={query.data} /></> : null;
}

function TaskDetail({ id, subscriptionId }: { id: string; subscriptionId?: string }) {
  return subscriptionId ? <ScopedTaskDetail key={subscriptionId} id={id} subscriptionId={subscriptionId} /> : <FullTaskDetail id={id} />;
}

function Row({ task, open, toggle, now, subscriptionId }: { task: ClientTaskMirror; open: boolean; toggle: () => void; now: number; subscriptionId?: string }) {
  const heartbeat = task.lastHeartbeatAt ? Date.parse(task.lastHeartbeatAt) : NaN;
  const heartbeatAge = Math.max(0, Math.floor((now - heartbeat) / 1000));
  const stale = Number.isFinite(heartbeat) && ['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED'].includes(task.status) && now - heartbeat > 60000;
  const subscriptions = task.subscriptionSummary?.subscriptions ?? [];
  const evidence = validatedStateEvidence(task.stateEvidence, task.status);
  const timeLabels = { event: '业务发生', started: '任务开始', queued: '任务排队', received: '云端接收（业务时间未核实）' };
  return <>
    <button type="button" onClick={toggle} aria-expanded={open} className="grid w-full grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-3 border-b border-glassline py-4 text-left hover:bg-gbg-deep/40 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.65fr)_auto_1rem]">
      <span className="min-w-0"><span className="block break-words text-sm font-medium text-gtext-primary">{task.title}</span>
        <span className="mt-1 block break-words text-xs text-gtext-muted">发起人：{task.user?.name ?? '未知'} · {task.activityTimeSource ? timeLabels[task.activityTimeSource] : '业务时间未核实'}（UTC+8）：{formatTime(task.activityAt)}</span>
        {(task.activity || task.currentStep) && <span className="mt-1 block break-words text-xs text-gtext-secondary">{task.activity || task.currentStep}</span>}
        {stale && <span className="mt-1 block text-[11px] text-gtext-muted" title="最近 60 秒未收到心跳，不代表任务状态改变">心跳延迟 · {heartbeatAge} 秒未收到</span>}
        <span className="mt-1 block break-words text-[11px] text-gtext-muted sm:hidden">{subscriptions.length ? subscriptions.map(employeeName).join('、') : '员工归属未确认'}{task.subscriptionSummary?.coverage === 'limited' ? ' · 旧记录归属未核实' : ''}</span>
      </span>
      <span className="hidden min-w-0 text-xs text-gtext-secondary sm:block">{subscriptions.length ? subscriptions.map((employee) => <span key={employee.subscriptionId} className="block break-words">{employeeName(employee)}{employee.legacy ? ' · 旧记录归属未核实' : ` · ${employee.executionCount} 次执行`}</span>) : '员工归属未确认'}
        {task.subscriptionSummary?.coverage === 'limited' && <span className="mt-1 block text-[11px] text-gtext-muted">旧记录归属未核实</span>}
      </span>
      <span className="text-right"><Badge variant={variant(task.status)}>{labels[task.status] ?? labels.UNKNOWN}</Badge>
        <span className="mt-1 block text-[11px] text-gtext-muted">{evidence ? evidence.source === 'live' ? '实时上报' : evidence.source === 'local-run' ? '本地运行记录' : '历史快照' : '来源未核实'}</span>
        {evidence?.progress !== undefined && <span className="mt-1 block text-xs tabular-nums text-gtext-secondary">{Math.round(evidence.progress)}%</span>}
        {evidence?.runEndedAt && ['PAUSED', 'INTERRUPTED'].includes(task.status) && <span className="mt-1 block text-[11px] text-gtext-muted">停止：{formatTime(evidence.runEndedAt)}</span>}
      </span>
      {open ? <ChevronDown className="h-4 w-4 text-gtext-muted" /> : <ChevronRight className="h-4 w-4 text-gtext-muted" />}
    </button>
    {open && <div className="min-w-0 border-b border-glassline bg-gbg-deep/25 px-3 py-4 sm:px-6"><TaskDetail id={task.id} subscriptionId={subscriptionId} /></div>}
  </>;
}

const controlKeys = ['q', 'monitorSubscriptionId', 'userId', 'taskType', 'from', 'to', 'statuses', 'sort', 'page', 'view'] as const;
const urlChangeEvent = 'sep-client-monitor-url';
function subscribeUrl(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(urlChangeEvent, onChange);
  return () => { window.removeEventListener('popstate', onChange); window.removeEventListener(urlChangeEvent, onChange); };
}
function readUrl() { return window.location.search; }
function readServerUrl() { return ''; }
function readFilters(search: string): ClientTaskMirrorListOptions {
  const params = new URLSearchParams(search);
  const statuses = params.get('statuses')?.split(',').filter((status) => Object.hasOwn(CLIENT_TASK_STATUS_LABELS, status)).join(',');
  const sort = params.get('sort');
  const from = validUrlTime(params.get('from'));
  const requestedTo = validUrlTime(params.get('to'));
  const to = from && requestedTo && Date.parse(requestedTo) <= Date.parse(from) ? undefined : requestedTo;
  return {
    q: params.get('q') || undefined, subscriptionId: params.get('monitorSubscriptionId') || undefined,
    userId: params.get('userId') || undefined, taskType: params.get('taskType') || undefined,
    from, to, statuses: statuses || undefined,
    sort: sort && Object.hasOwn(sorts, sort) ? sort as ClientTaskMirrorSort : 'activityAt_desc',
  };
}
function validUrlTime(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
function localTime(value?: string) {
  return value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16) : '';
}
function dateFilter(value: string) {
  if (!value) return undefined;
  const date = new Date(`${value}+08:00`);
  if (!Number.isFinite(date.getTime())) throw new Error('请输入有效的 UTC+8 时间');
  return date.toISOString();
}

export function ClientTaskMonitor({ taskId, subscriptionId }: { taskId?: string; subscriptionId?: string } = {}) {
  const search = useSyncExternalStore(subscribeUrl, readUrl, readServerUrl);
  const params = new URLSearchParams(search);
  // The parent still treats subscriptionId as a legacy fixed-scope deep link. Keep the
  // mutable employee selection in monitorSubscriptionId in the URL, subscriptionId in API queries.
  const scopeSubscriptionId = subscriptionId || params.get('scopeSubscriptionId') || params.get('subscriptionId') || undefined;
  const filters = readFilters(search);
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const [selected, setSelected] = useState<string>();
  const [dismissedTaskId, setDismissedTaskId] = useState<string>();
  const linkedId = taskId || params.get('taskId') || undefined;
  const linkedTaskId = dismissedTaskId !== linkedId ? linkedId : undefined;
  const [searchText, setSearchText] = useState(filters.q ?? '');
  const [previousQ, setPreviousQ] = useState(filters.q);
  const [dateDraft, setDateDraft] = useState({ from: localTime(filters.from), to: localTime(filters.to) });
  const [dateKey, setDateKey] = useState(`${filters.from}|${filters.to}`);
  const [filterError, setFilterError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const navigationKey = `${scopeSubscriptionId}|${linkedId}`;
  const [previousNavigation, setPreviousNavigation] = useState(navigationKey);
  const [previousSearch, setPreviousSearch] = useState(search);
  if (previousSearch !== search) { setPreviousSearch(search); setSelected(undefined); }
  if (previousNavigation !== navigationKey) {
    setPreviousNavigation(navigationKey); setSelected(undefined); setDismissedTaskId(undefined);
  }
  if (previousQ !== filters.q) { setPreviousQ(filters.q); setSearchText(filters.q ?? ''); }
  if (dateKey !== `${filters.from}|${filters.to}`) {
    setDateKey(`${filters.from}|${filters.to}`); setDateDraft({ from: localTime(filters.from), to: localTime(filters.to) }); setFilterError('');
  }
  const limit = 50;
  const query = useClientTaskMirrors(true, { page, limit, view: 'history', ...filters, scopeSubscriptionId });
  const options = useClientTaskMirrorFilterOptions({ ...filters, view: 'history', scopeSubscriptionId });
  const result = query.data;

  function writeFilters(next: ClientTaskMirrorListOptions, nextPage = 1, replace = false) {
    const nextParams = new URLSearchParams(window.location.search);
    controlKeys.forEach((key) => nextParams.delete(key));
    for (const [key, value] of Object.entries(next)) {
      if (value && key !== 'scopeSubscriptionId') nextParams.set(key === 'subscriptionId' ? 'monitorSubscriptionId' : key, String(value));
    }
    if (scopeSubscriptionId) { nextParams.set('scopeSubscriptionId', scopeSubscriptionId); nextParams.set('subscriptionId', scopeSubscriptionId); }
    nextParams.set('view', 'history');
    if (nextPage > 1) nextParams.set('page', String(nextPage));
    window.history[replace ? 'replaceState' : 'pushState'](null, '', `${window.location.pathname}?${nextParams}${window.location.hash}`);
    window.dispatchEvent(new Event(urlChangeEvent));
    setSelected(undefined);
  }
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (searchText.trim() === (filters.q ?? '')) return;
    const timer = window.setTimeout(() => {
      // Read the current URL so a pending search cannot undo a newer dropdown or scope change.
      const current = readFilters(window.location.search);
      writeFilters({ ...current, q: searchText.trim() || undefined });
    }, 300);
    return () => window.clearTimeout(timer);
    // writeFilters is scoped to the current immutable employee entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, filters.q, scopeSubscriptionId, search]);
  const updateFilter = (key: keyof ClientTaskMirrorListOptions, value: string) => writeFilters({ ...filters, [key]: value || undefined });
  function updateDates(next: typeof dateDraft) {
    setDateDraft(next);
    try {
      const from = dateFilter(next.from), to = dateFilter(next.to);
      if (from && to && Date.parse(to) <= Date.parse(from)) throw new Error('结束时间必须晚于开始时间');
      setFilterError(''); writeFilters({ ...filters, from, to });
    } catch (error) { setFilterError(error instanceof Error ? error.message : '时间筛选无效'); }
  }
  function quickDates(days: number) {
    const shanghai = new Date(now + 8 * 3600000);
    const end = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + 1) - 8 * 3600000;
    updateDates({ from: localTime(new Date(end - days * 86400000).toISOString()), to: localTime(new Date(end).toISOString()) });
  }
  const selectedFilters = Object.entries(filters).filter(([key, value]) => value && key !== 'sort');
  const filterNames: Record<string, string> = { q: '标题', subscriptionId: '员工', userId: '成员', taskType: '类型', statuses: '状态', from: '时间起点', to: '时间终点' };
  function filterValue(key: string, value: string) {
    if (key === 'statuses') return value.split(',').map((status) => labels[status]).join('、');
    if (key === 'subscriptionId') return options.data?.subscriptions.find((employee) => employee.subscriptionId === value)?.subscriptionName || value;
    if (key === 'userId') return options.data?.users.find((user) => user.id === value)?.name || value;
    if (key === 'taskType') return taskTypes[value] ?? value;
    if (key === 'from' || key === 'to') return formatTime(value);
    return value;
  }
  return <section className="glass-card overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-glassline px-4 py-3 sm:px-5">
      <div><h2 className="flex items-center gap-2 text-sm font-medium text-gtext-primary"><Monitor className="h-4 w-4 text-gbrand-text" />客户端任务监控</h2>
        {(result || options.data?.scopeTotal !== undefined) && <p className="mt-1 text-xs text-gtext-muted">{result ? `结果 ${result.total} 条` : ''}{result && options.data?.scopeTotal !== undefined ? ' · ' : ''}{options.data?.scopeTotal !== undefined ? `权限范围 ${options.data.scopeTotal} 条` : ''}</p>}
        {scopeSubscriptionId && <p className="mt-1 text-xs text-gtext-muted">固定员工范围：{options.data?.subscriptions.find((employee) => employee.subscriptionId === scopeSubscriptionId)?.subscriptionName || scopeSubscriptionId}</p>}
      </div>
      <Button variant="glass" size="sm" disabled={query.isFetching || options.isFetching} onClick={() => { void query.refetch(); void options.refetch(); }}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
    </div>
    <div className="px-4 sm:px-5">
      <div className="space-y-3 border-b border-glassline py-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <label className="min-w-0 text-xs text-gtext-muted">搜索任务标题<input aria-label="搜索任务标题" className={controlClass} placeholder="搜索任务标题…" value={searchText} onChange={(event) => setSearchText(event.target.value)} /></label>
          <label className="min-w-0 text-xs text-gtext-muted">硅基员工<select aria-label="员工筛选" className={controlClass} value={filters.subscriptionId ?? ''} onChange={(event) => updateFilter('subscriptionId', event.target.value)}>
            <option value="">全部员工</option>{filters.subscriptionId && !options.data?.subscriptions.some((item) => item.subscriptionId === filters.subscriptionId) && <option value={filters.subscriptionId}>已选员工</option>}
            {options.data?.subscriptions.map((item) => <option key={item.subscriptionId} value={item.subscriptionId}>{employeeName(item)}{item.legacy ? ' · 旧记录归属未核实' : ''}</option>)}
          </select></label>
          <label className="min-w-0 text-xs text-gtext-muted">任务状态<select aria-label="任务状态" className={controlClass} value={filters.statuses ?? ''} onChange={(event) => updateFilter('statuses', event.target.value)}>
            <option value="">全部状态</option>{filters.statuses?.includes(',') && <option value={filters.statuses}>{filterValue('statuses', filters.statuses)}</option>}
            {Object.entries(CLIENT_TASK_STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}{options.data?.counts.byStatus?.[status] !== undefined ? ` · ${options.data.counts.byStatus[status]}` : ''}</option>)}
          </select></label>
        </div>
        <div className="space-y-3 border-t border-glassline/70 pt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="min-w-0 text-xs text-gtext-muted">发起成员<select aria-label="成员筛选" className={controlClass} value={filters.userId ?? ''} onChange={(event) => updateFilter('userId', event.target.value)}><option value="">全部成员</option>{filters.userId && !options.data?.users.some((item) => item.id === filters.userId) && <option value={filters.userId}>已选成员</option>}{options.data?.users.map((item) => <option key={item.id} value={item.id}>{item.name ?? '名称未知'}</option>)}</select></label>
            <label className="min-w-0 text-xs text-gtext-muted">任务类型<select aria-label="任务类型筛选" className={controlClass} value={filters.taskType ?? ''} onChange={(event) => updateFilter('taskType', event.target.value)}><option value="">全部类型</option>{filters.taskType && !options.data?.taskTypes.includes(filters.taskType) && <option value={filters.taskType}>{taskTypes[filters.taskType] ?? filters.taskType}</option>}{options.data?.taskTypes.map((item) => <option key={item} value={item}>{taskTypes[item] ?? item}</option>)}</select></label>
            <label className="min-w-0 text-xs text-gtext-muted">排序<select aria-label="任务排序" className={controlClass} value={filters.sort} onChange={(event) => updateFilter('sort', event.target.value)}>{Object.entries(sorts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
          <div className="grid gap-3 border-t border-glassline/70 pt-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-end">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-gtext-muted">时间范围（UTC+8）</span>
              {[[1, '今天'], [7, '近 7 天'], [30, '近 30 天']].map(([days, label]) => <Button key={days} variant="glass" size="sm" onClick={() => quickDates(Number(days))}>{label}</Button>)}
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <label className="min-w-0 text-xs text-gtext-muted">起始时间（含）<input aria-label="时间范围起点" className={controlClass} type="datetime-local" value={dateDraft.from} onChange={(event) => updateDates({ ...dateDraft, from: event.target.value })} /></label>
              <label className="min-w-0 text-xs text-gtext-muted">结束时间（不含）<input aria-label="时间范围终点" className={controlClass} type="datetime-local" value={dateDraft.to} onChange={(event) => updateDates({ ...dateDraft, to: event.target.value })} /></label>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gtext-muted">
          {selectedFilters.map(([key, value]) => <button key={key} type="button" className="inline-flex max-w-full items-center gap-1 rounded border border-glassline px-2 py-1" aria-label={`移除${filterNames[key]}筛选`} onClick={() => { if (key === 'q') setSearchText(''); updateFilter(key as keyof ClientTaskMirrorListOptions, ''); }}><span className="break-all">{filterNames[key]}：{filterValue(key, String(value))}</span><X className="h-3 w-3 shrink-0" /></button>)}
          <Button variant="ghost" size="sm" aria-label="重置筛选" onClick={() => { setSearchText(''); setDateDraft({ from: '', to: '' }); setFilterError(''); writeFilters({ sort: 'activityAt_desc' }); }}><RotateCcw className="h-3.5 w-3.5" />清空筛选</Button>
          {filterError && <p role="alert" className="text-gdanger">{filterError}</p>}
          {options.isError && <div role="alert" className="flex items-center gap-2 text-gdanger">筛选选项读取失败<Button variant="ghost" size="sm" onClick={() => void options.refetch()}>重试选项</Button></div>}
        </div>
      </div>
      {linkedTaskId && <section aria-label="指定任务详情" className="border-b border-glassline py-4">
        <div className="mb-3 flex items-center justify-between gap-2"><div><h2 className="break-all text-sm text-gtext-secondary">指定任务详情 · {linkedTaskId}</h2><p className="mt-1 text-xs text-gtext-muted">详情保留固定员工权限范围，独立于下方列表筛选。</p></div><Button variant="ghost" size="sm" aria-label="关闭指定任务详情" onClick={() => { setDismissedTaskId(linkedTaskId); const next = new URLSearchParams(window.location.search); next.delete('taskId'); window.history.replaceState(null, '', `${window.location.pathname}?${next}`); window.dispatchEvent(new Event(urlChangeEvent)); }}><X className="h-4 w-4" /></Button></div>
        <TaskDetail key={`${scopeSubscriptionId}:${linkedTaskId}`} id={linkedTaskId} subscriptionId={scopeSubscriptionId} />
      </section>}
      {result?.legacy && <p className="py-2 text-xs text-gtext-muted">服务端尚未支持完整分页，目前仅显示最近最多 100 条记录；筛选覆盖可能有限。</p>}
      {query.isLoading ? <CenteredSpinner label="正在读取客户端任务…" /> : query.isError ? <div className="space-y-3 py-8 text-sm text-gdanger" role="alert"><p>客户端任务监控暂时不可用，请稍后重试。</p><Button variant="glass" size="sm" onClick={() => void query.refetch()}>重试</Button>{page > 1 && <Button variant="glass" size="sm" onClick={() => writeFilters(filters, page - 1)}>返回上一页</Button>}</div> : result?.items.length ? result.items.map((task) => <Row key={`${scopeSubscriptionId}:${task.id}`} task={task} now={now} subscriptionId={scopeSubscriptionId} open={selected === task.id && linkedTaskId !== task.id} toggle={() => setSelected((id) => id === task.id ? undefined : task.id)} />) : <div className="py-10 text-center text-sm text-gtext-muted">{selectedFilters.length ? '当前筛选无匹配任务' : '暂无已同步的客户端任务'}</div>}
      {result && !query.isError && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-glassline py-3 text-xs text-gtext-muted"><span>第 {page} 页 · 每页 {limit} 条</span><div className="flex gap-2"><Button variant="glass" size="sm" disabled={page <= 1} onClick={() => writeFilters(filters, page - 1)} aria-label="上一页"><ChevronLeft className="h-4 w-4" /></Button><Button variant="glass" size="sm" disabled={!result.hasNextPage} onClick={() => writeFilters(filters, page + 1)} aria-label="下一页"><ChevronRight className="h-4 w-4" /></Button></div></div>}
    </div>
  </section>;
}
