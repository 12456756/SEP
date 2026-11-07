'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  useCurrentEnterpriseDeletion, useEnterpriseDeletionJob, useEnterpriseDeletionPreview,
  useRetryEnterpriseDeletion, useStartEnterpriseDeletion,
} from './enterprise-deletion-hooks';
import type { EnterpriseDeletionPhase, EnterpriseDeletionStatus } from './enterprise-deletion-api';

const phaseLabels: Record<EnterpriseDeletionPhase, string> = {
  PREPARE: '准备删除', DATABASE: '清理企业数据', FILES: '清理企业文件', DONE: '清理完成',
};
const statusLabels: Record<EnterpriseDeletionStatus, string> = {
  PENDING: '等待执行', RUNNING: '正在执行', FAILED: '执行失败', COMPLETED: '已完成',
};

interface EnterpriseDeletionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enterpriseId: string;
  enterpriseName: string;
  onCompleted?: () => void;
}

export function EnterpriseDeletionDialog(props: EnterpriseDeletionDialogProps) {
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    {props.open && <DeletionContent key={props.enterpriseId} {...props} />}
  </Dialog>;
}

function DeletionContent({ enterpriseId, enterpriseName, onOpenChange, onCompleted }: EnterpriseDeletionDialogProps) {
  const qc = useQueryClient();
  const [confirmName, setConfirmName] = useState('');
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);
  const notified = useRef(false);
  const current = useCurrentEnterpriseDeletion(enterpriseId, true);
  const jobId = submittedJobId ?? current.data?.id ?? null;
  const job = useEnterpriseDeletionJob(jobId, true);
  const activeJob = job.data ?? current.data;
  const preview = useEnterpriseDeletionPreview(enterpriseId, current.isSuccess && !current.isFetching && !current.data && !submittedJobId);
  const start = useStartEnterpriseDeletion();
  const retry = useRetryEnterpriseDeletion();
  const pending = start.isPending || retry.isPending;
  const completed = activeJob?.status === 'COMPLETED';
  const failed = activeJob?.status === 'FAILED';
  const running = activeJob?.status === 'PENDING' || activeJob?.status === 'RUNNING';
  const confirmationName = preview.data?.enterpriseName ?? enterpriseName;
  const isMatching = confirmName === confirmationName;
  const mutationError = start.error ?? retry.error;

  useEffect(() => {
    if (!completed || notified.current) return;
    notified.current = true;
    void qc.invalidateQueries({ queryKey: ['admin', 'enterprises'] });
    toast.success('企业已永久删除', `${enterpriseName} 的数据与文件已清理完成`);
    onCompleted?.();
  }, [completed, enterpriseName, onCompleted, qc]);

  const submit = async () => {
    if (!isMatching || !preview.data || !current.isSuccess || current.isFetching || activeJob) return;
    try {
      const created = await start.mutateAsync({ enterpriseId, confirmName });
      setSubmittedJobId(created.id);
    } catch { /* Mutation errors are displayed in the dialog. */ }
  };

  return <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl">
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2 pr-5"><Trash2 className="h-5 w-5 shrink-0 text-danger" />永久删除企业</DialogTitle>
      <DialogDescription>此操作不可恢复。企业余额会被删除且不会自动退款，用户个人账号及个人余额保留。</DialogDescription>
    </DialogHeader>
    {current.isPending && <p role="status" className="text-sm text-fg-muted">正在检查删除状态...</p>}
    {current.isError && !activeJob && <div role="alert" className="space-y-2 text-sm text-danger"><p>无法检查现有删除任务：{current.error.message}</p><Button variant="outline" size="sm" onClick={() => void current.refetch()}><RotateCcw className="h-4 w-4" />重新加载</Button></div>}
    {current.isSuccess && !activeJob && <>
      {preview.isPending && <p role="status" className="text-sm text-fg-muted">正在加载删除预览...</p>}
      {preview.isError && <div role="alert" className="space-y-2 text-sm text-danger"><p>预览加载失败：{preview.error.message}</p><Button variant="outline" size="sm" onClick={() => void preview.refetch()}><RotateCcw className="h-4 w-4" />重新加载</Button></div>}
      {preview.data && <div className="space-y-4 text-sm">
        <p className="break-words font-medium">将永久删除「{confirmationName}」及以下企业数据：</p>
        <dl className="grid grid-cols-2 gap-3 border-y border-border py-3 sm:grid-cols-3">
          {[
            ['企业余额', `¥${preview.data.balance.toFixed(2)}`], ['冻结金额', `¥${preview.data.frozenAmount.toFixed(2)}`],
            ['算力专款', `¥${preview.data.computeReservedCNY.toFixed(2)}`], ['企业成员关系', preview.data.memberCount],
            ['订阅', preview.data.subscriptionCount], ['知识库', preview.data.knowledgeBaseCount], ['文档', preview.data.documentCount],
            ['任务', preview.data.taskCount], ['运行中任务', preview.data.runningTaskCount], ['待处理订单', preview.data.pendingOrderCount],
          ].map(([label, value]) => <div key={label}><dt className="text-fg-muted">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}
        </dl>
        {preview.data.warnings.length > 0 && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-warning"><div className="mb-1 flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 shrink-0" />删除前提示</div><ul className="list-disc space-y-1 break-words pl-5">{preview.data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        <div className="space-y-2"><label htmlFor="enterprise-deletion-confirm-name" className="block break-words font-medium">输入企业全名确认：{confirmationName}</label><Input id="enterprise-deletion-confirm-name" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} autoComplete="off" disabled={pending} /></div>
      </div>}
    </>}
    {activeJob && <div role="status" aria-live="polite" className="space-y-3 border-y border-border py-4 text-sm">
      <div className="flex items-center gap-2 font-medium">{completed ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" /> : running ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" /> : <AlertTriangle className="h-5 w-5 shrink-0 text-danger" />}{statusLabels[activeJob.status]}：{phaseLabels[activeJob.phase]}</div>
      <p className="text-fg-muted">尝试次数：{activeJob.attempts}</p>
      {running && <p className="text-fg-muted">关闭窗口后任务仍会继续，可再次从删除入口查看进度。</p>}
      {failed && <p className="break-words text-danger">{activeJob.error || '删除失败，可重试继续清理。'}</p>}
    </div>}
    {job.isError && <div role="alert" className="space-y-2 text-sm text-danger"><p>进度更新失败：{job.error.message}</p><Button variant="outline" size="sm" onClick={() => void job.refetch()}><RotateCcw className="h-4 w-4" />刷新进度</Button></div>}
    {mutationError && <p role="alert" className="break-words text-sm text-danger">操作失败：{mutationError.message}</p>}
    <DialogFooter>
      <Button variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>{activeJob ? '关闭' : '取消'}</Button>
      {failed ? <Button variant="danger" loading={retry.isPending} onClick={() => retry.mutate(activeJob!.id)}><RotateCcw className="h-4 w-4" />重试删除</Button> : !activeJob && <Button variant="danger" disabled={!isMatching || pending || !preview.data || !current.isSuccess || current.isFetching} loading={start.isPending} onClick={() => void submit()}><Trash2 className="h-4 w-4" />确认永久删除</Button>}
    </DialogFooter>
  </DialogContent>;
}
