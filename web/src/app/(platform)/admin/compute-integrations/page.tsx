'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, RotateCw, Search, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useComputeIntegrations, useComputeIntegrationRecords, usePrepareComputeIntegration, useRetryComputeIntegration } from '@/features/compute-integration/use-compute-integration';
import { ConnectionStatus, connectionStatusLabel } from '@/features/compute-integration/connection-status';
import type { ComputeIntegrationView } from 'shared/compute-integration.dto';
import { computeIntegrationErrorMessages } from 'shared/compute-integration.dto';

const recordLabels: Record<string, string> = { BLOCKED: '未接通', PENDING: '待处理', RUNNING: '处理中', SUCCEEDED: '完成',
  PROVISION: '开户', SETTLEMENT: '结算', TRANSFER: '划转', LOCAL_CONFIRMED: '本地已确认', UNPAID: '未结清', COMMITTED: '已同步' };

export default function ComputeIntegrationsPage() {
  const [page, setPage] = useState(1);
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<ComputeIntegrationView | null>(null);
  const [recordInput, setRecordInput] = useState('');
  const [recordKeyword, setRecordKeyword] = useState('');
  const [recordStatus, setRecordStatus] = useState('ALL');
  const query = useComputeIntegrations(page, keyword);
  const records = useComputeIntegrationRecords(selected?.enterpriseId ?? null, recordKeyword, recordStatus);
  const prepare = usePrepareComputeIntegration();
  const retry = useRetryComputeIntegration();
  const current = query.data?.items.find(item => item.enterpriseId === selected?.enterpriseId) ?? selected;
  return <div className="min-w-0 space-y-5 p-4 md:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">企业算力连接</h1>
      <Button variant="outline" size="icon" title="刷新" aria-label="刷新" onClick={() => query.refetch()} disabled={query.isFetching}><RefreshCw className="h-4 w-4" /></Button>
    </header>
    <form className="flex max-w-lg gap-2" onSubmit={event => { event.preventDefault(); setKeyword(input.trim()); setPage(1); }}>
      <Input aria-label="搜索企业" placeholder="企业名称或编号" value={input} maxLength={100} onChange={event => setInput(event.target.value)} />
      <Button type="submit" variant="outline" size="icon" title="搜索" aria-label="搜索"><Search className="h-4 w-4" /></Button>
    </form>
    {query.error ? <p role="alert" className="text-sm text-destructive">{query.error.message}</p> : query.isLoading ? <p role="status" className="text-sm text-muted-foreground">加载中...</p> : <>
      <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b text-muted-foreground"><tr>
        {['企业', '调用方式', '开户状态', '凭证', '待同步', ''].map((label, index) => <th key={index} className="px-3 py-3 font-medium">{label}</th>)}
      </tr></thead><tbody className="divide-y divide-border">{query.data?.items.map(item => <tr key={item.enterpriseId}>
        <td className="max-w-[240px] px-3 py-4"><div className="break-words font-medium">{item.enterpriseName}</div><div className="mt-1 break-all text-xs text-muted-foreground">{item.enterpriseId}</div></td>
        <td className="px-3 py-4">企业专属 Key</td><td className="px-3 py-4">{connectionStatusLabel(item)}</td>
        <td className="px-3 py-4">{item.credentials.filter(key => key.configured).length}/3</td><td className="px-3 py-4">{item.pendingJobs}</td>
        <td className="px-3 py-4"><Button size="icon" variant="ghost" title="查看连接详情" aria-label={`查看${item.enterpriseName}连接详情`} onClick={() => { setSelected(item); setRecordInput(''); setRecordKeyword(''); setRecordStatus('ALL'); }}><Settings2 className="h-4 w-4" /></Button></td>
      </tr>)}</tbody></table></div>
      {!query.data?.items.length && <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的企业</p>}
      <footer className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>共 {query.data?.total ?? 0} 家企业 · 第 {page} 页</span><div className="flex gap-2">
        <Button size="icon" variant="outline" title="上一页" aria-label="上一页" disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="icon" variant="outline" title="下一页" aria-label="下一页" disabled={page * 20 >= (query.data?.total ?? 0)} onClick={() => setPage(value => value + 1)}><ChevronRight className="h-4 w-4" /></Button>
      </div></footer>
    </>}
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent aria-describedby={undefined} className="max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle className="break-words pr-5 leading-6">{current?.enterpriseName} · 算力连接</DialogTitle></DialogHeader>
      {current && <>
        <ConnectionStatus value={current} />
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={prepare.isPending || current.status === 'READY' || current.status === 'PENDING'} onClick={() => prepare.mutate(current.enterpriseId, {
          onSuccess: value => { setSelected(value); toast.success('开户任务已保存'); }, onError: error => toast.error(error.message),
        })}>开通企业连接</Button><Button variant="outline" disabled={records.isFetching} onClick={() => records.refetch()}><RefreshCw className="mr-2 h-4 w-4" />刷新记录</Button></div>
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setRecordKeyword(recordInput.trim()); }}>
          <Input className="min-w-0 flex-1 basis-40" aria-label="搜索业务编号" placeholder="业务编号" value={recordInput} maxLength={128} onChange={event => setRecordInput(event.target.value)} />
          <select aria-label="同步状态" value={recordStatus} onChange={event => setRecordStatus(event.target.value)} className="h-10 rounded-md border border-input bg-background px-2 text-sm">
            <option value="ALL">全部状态</option><option value="PENDING">待处理</option><option value="FAILED">异常</option><option value="SUCCEEDED">完成</option>
          </select><Button type="submit" variant="outline" size="icon" title="筛选记录" aria-label="筛选记录"><Search className="h-4 w-4" /></Button>
        </form>
        {records.isLoading ? <p className="text-sm text-muted-foreground">加载同步记录...</p> : records.error ? <p role="alert" className="text-sm text-destructive">{records.error.message}</p> : <div className="space-y-4">
          <h2 className="text-sm font-semibold">最近同步操作</h2>
          {records.data?.passwordSync && <div className="border-b pb-3 text-sm">
            <p>登录密码同步 · {records.data.passwordSync.status === 'SYNCED' ? '已同步' : '同步中'} · v{records.data.passwordSync.version}</p>
            {records.data.passwordSync.lastErrorMessage && <p className="mt-1 break-words text-amber-700 dark:text-amber-400">{records.data.passwordSync.lastErrorMessage}</p>}
          </div>}
          {records.data?.jobs.length ? records.data.jobs.map(job => <div key={job.id} className="border-b pb-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span>{recordLabels[job.kind] ?? job.kind} · {recordLabels[job.status] ?? job.status}</span><span className="text-muted-foreground">已尝试 {job.attempts} 次</span></div><p className="mt-1 break-all text-xs text-muted-foreground">{job.businessId}</p>{job.lastErrorCode && <p className="mt-1 text-amber-700 dark:text-amber-400">{computeIntegrationErrorMessages[job.lastErrorCode] ?? `同步待恢复 · ${job.lastErrorCode}`}</p>}
            <Button className="mt-2" variant="ghost" size="icon" aria-label={`重试${job.businessId}`} title={current.connected ? '重试原操作' : '算力平台接口尚未接通'} disabled={!current.connected || retry.isPending || !['BLOCKED', 'PENDING'].includes(job.status)} onClick={() => retry.mutate(job.id, { onSuccess: () => toast.success('原操作已进入待处理状态'), onError: error => toast.error(error.message) })}><RotateCw className="h-4 w-4" /></Button>
          </div>) : <p className="text-sm text-muted-foreground">暂无同步操作</p>}
          <h2 className="text-sm font-semibold">执行费用</h2>{records.data?.executions?.length ? records.data.executions.map(row => <p key={row.id} className="break-all text-sm">{row.id} · {row.feeStatus === 'FINAL' ? `已确认 ¥${row.grossCny}` : '费用待确认'}</p>) : <p className="text-sm text-muted-foreground">暂无新模式执行记录</p>}
          <h2 className="text-sm font-semibold">结算记录</h2>{records.data?.settlements.length ? records.data.settlements.map(row => <p key={row.id} className="break-all text-sm">{row.executionId} · ¥{row.grossCny} · 免费 ¥{row.freeCny} · 付费 ¥{row.paidCny} · 欠费 ¥{row.unpaidCny} · {recordLabels[row.status] ?? row.status}</p>) : <p className="text-sm text-muted-foreground">暂无新模式结算记录</p>}
          <h2 className="text-sm font-semibold">划转记录</h2>{records.data?.transfers.length ? records.data.transfers.map(row => <p key={row.id} className="break-all text-sm">{row.direction === 'credit_compute' ? '转入' : '退回'} ¥{row.amountCny} · {recordLabels[row.status] ?? row.status} · {row.businessId}</p>) : <p className="text-sm text-muted-foreground">暂无新模式划转记录</p>}
          <h2 className="text-sm font-semibold">对账记录</h2>{records.data?.reconciliations?.length ? records.data.reconciliations.map(row => <p key={row.id} className="break-all text-sm">{row.businessId} · 水位 {row.sequence} · {row.status === 'MATCHED' ? '一致' : `差异 ¥${row.differenceCny}`}</p>) : <p className="text-sm text-muted-foreground">尚未获取远端账务快照</p>}
        </div>}
      </>}
    </DialogContent></Dialog>
  </div>;
}
