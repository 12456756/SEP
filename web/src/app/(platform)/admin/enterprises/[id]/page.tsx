'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  useEnterpriseDetail,
  useCreditAdjustment,
  useRefundDeposit,
  useSuspendEnterprise,
  useResumeEnterprise,
} from '@/features/admin/use-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { EnterpriseDetail } from '@/features/admin/admin-api';
import { toast } from '@/components/ui/toast';
import { SUBSCRIPTION_STATUS_LABEL, SUBSCRIPTION_STATUS_STYLE } from '@/lib/utils';
import {
  Building2,
  Users,
  Bot,
  DollarSign,
  ArrowLeft,
  Plus,
  Minus,
  Lock,
  Unlock,
  Trash2,
} from 'lucide-react';
import { EnterpriseDeletionDialog } from '@/features/admin/enterprise-deletion-dialog';
import { RefundDepositDtoSchema } from 'shared/refund-deposit.dto';

/**
 * 钱包流水类型的中文名与配色。
 *
 * 用玻璃底 + 品牌色文字，不用 bg-green-100 这类硬编码浅色 —— 后者在深色主题下破版。
 */
const WALLET_TX_LABEL: Record<string, string> = {
  DEPOSIT: '充值',
  CONSUME: '消费',
  REFUND: '退款',
  ADJUSTMENT: '人工调整',
  FREEZE: '冻结',
  UNFREEZE: '解冻',
  COMPUTE_RESERVE: '划入算力专款',
  COMPUTE_RELEASE: '专款划回',
};

const WALLET_TX_TONE: Record<string, string> = {
  DEPOSIT: 'border border-glassline bg-glass-2 text-gsuccess',
  CONSUME: 'border border-glassline bg-glass-2 text-gwarning',
  REFUND: 'border border-glassline bg-glass-2 text-gneon-blue',
  ADJUSTMENT: 'border border-glassline bg-glass-2 text-gneon-purple',
  FREEZE: 'border border-glassline bg-glass-2 text-gtext-secondary',
  UNFREEZE: 'border border-glassline bg-glass-2 text-gtext-secondary',
  COMPUTE_RESERVE: 'border border-glassline bg-glass-2 text-gneon-green',
  COMPUTE_RELEASE: 'border border-glassline bg-glass-2 text-gtext-secondary',
};

export default function EnterpriseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const enterpriseId = params.id as string;

  const { data: enterprise, isLoading, error } = useEnterpriseDetail(enterpriseId);
  const creditAdjustment = useCreditAdjustment();
  const refundDeposit = useRefundDeposit();
  const suspendEnterprise = useSuspendEnterprise();
  const resumeEnterprise = useResumeEnterprise();

  const [activeTab, setActiveTab] = useState<'members' | 'subscriptions' | 'transactions'>(
    'members',
  );

  // Credit dialog state
  const [creditDialogOpen, setCreditDialogOpen] = useState(false);
  const [creditType, setCreditType] = useState<'RECHARGE' | 'DEDUCT'>('RECHARGE');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNote, setCreditNote] = useState('');
  const [refundTransaction, setRefundTransaction] = useState<EnterpriseDetail['transactions'][number] | null>(null);
  const [refundMode, setRefundMode] = useState<'all' | 'partial'>('all');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');

  // Suspend dialog state
  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [deletionDialogOpen, setDeletionDialogOpen] = useState(false);

  const isSuspended = enterprise?.metadata?.suspended === true;

  const handleCreditAdjustment = async () => {
    const amount = parseFloat(creditAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('请输入有效的金额');
      return;
    }

    if (!creditNote.trim()) {
      toast.error('请输入备注');
      return;
    }

    try {
      await creditAdjustment.mutateAsync({
        id: enterpriseId,
        data: {
          amount,
          type: creditType,
          note: creditNote,
        },
      });
      toast.success(
        `${creditType === 'RECHARGE' ? '充值' : '扣减'}成功`,
        `${enterprise?.name ?? '企业'} ${creditType === 'RECHARGE' ? '入账' : '扣减'} ¥${amount.toFixed(2)}`,
      );
      setCreditDialogOpen(false);
      setCreditAmount('');
      setCreditNote('');
    } catch (err) {
      toast.error('操作失败', err instanceof Error ? err.message : '请稍后重试');
    }
  };

  const handleSuspend = async () => {
    if (!suspendReason.trim()) {
      toast.error('请输入冻结原因');
      return;
    }

    try {
      await suspendEnterprise.mutateAsync({
        id: enterpriseId,
        data: { reason: suspendReason },
      });
      toast.success('企业已冻结', `${enterprise?.name ?? '该企业'} 的成员将无法继续使用`);
      setSuspendDialogOpen(false);
      setSuspendReason('');
    } catch (err) {
      toast.error('冻结失败', err instanceof Error ? err.message : '请稍后重试');
    }
  };

  const handleResume = async () => {
    try {
      await resumeEnterprise.mutateAsync(enterpriseId);
      toast.success('企业已解冻');
    } catch (err) {
      toast.error('解冻失败', err instanceof Error ? err.message : '请稍后重试');
    }
  };

  const refundValue = refundMode === 'all'
    ? refundTransaction?.refundableAmount ?? 0 : Number(refundAmount);
  const validRefund = !!refundTransaction &&
    RefundDepositDtoSchema.safeParse({ amount: refundValue, reason: refundReason }).success &&
    refundValue <= refundTransaction.refundableAmount && refundValue <= (enterprise?.balance ?? 0);

  const handleRefund = async () => {
    if (!refundTransaction) return;
    const amount = refundValue;
    if (!validRefund) {
      toast.error('请输入有效的退款金额', `最多可退 ¥${refundTransaction.refundableAmount.toFixed(2)}`);
      return;
    }
    try {
      await refundDeposit.mutateAsync({
        enterpriseId,
        transactionId: refundTransaction.id,
        data: { amount, reason: refundReason.trim() || undefined },
      });
      toast.success('退款成功', `已退还 ¥${amount.toFixed(2)}`);
      setRefundTransaction(null);
      setRefundAmount('');
      setRefundReason('');
    } catch (err) {
      toast.error('退款失败', err instanceof Error ? err.message : '请刷新后重试');
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center text-fg-muted">加载中...</div>
      </div>
    );
  }

  if (error || !enterprise) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center text-danger">
          加载失败: {(error as Error)?.message || '企业不存在'}
        </div>
      </div>
    );
  }

  // 钱包余额（元）。原先读 enterprise.computeAccount?.balance —— 已废弃字段。
  const balance = enterprise.balance ?? 0;
  const transactions = enterprise.transactions ?? [];

  return (
    <div className="container mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/admin/enterprises')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 break-words text-2xl font-bold">
              {enterprise.name}
              {isSuspended && (
                <Badge className="bg-danger text-white">已冻结</Badge>
              )}
            </h1>
            {enterprise.description && (
              <p className="text-fg-muted mt-1">{enterprise.description}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCreditType('RECHARGE');
              setCreditAmount('');
              setCreditNote('');
              setCreditDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            充值
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCreditType('DEDUCT');
              setCreditAmount('');
              setCreditNote('');
              setCreditDialogOpen(true);
            }}
          >
            <Minus className="h-4 w-4 mr-2" />
            扣减
          </Button>

          {isSuspended ? (
            <Button variant="secondary" size="sm" onClick={() => setResumeDialogOpen(true)}>
              <Unlock className="h-4 w-4 mr-2" />
              解冻
            </Button>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setSuspendDialogOpen(true)}>
              <Lock className="h-4 w-4 mr-2" />
              冻结
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={() => setDeletionDialogOpen(true)}>
            <Trash2 className="h-4 w-4" />
            永久删除
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">算力余额</CardTitle>
            <DollarSign className="h-4 w-4 text-fg-muted" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">¥{balance.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">成员数量</CardTitle>
            <Users className="h-4 w-4 text-fg-muted" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{enterprise.members.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">在册员工</CardTitle>
            <Bot className="h-4 w-4 text-fg-muted" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{enterprise.subscriptions.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="space-y-4">
        <div className="flex gap-2 border-b border-border">
          <button
            className={`px-4 py-2 font-medium ${
              activeTab === 'members'
                ? 'border-b-2 border-primary text-primary'
                : 'text-fg-muted hover:text-foreground'
            }`}
            onClick={() => setActiveTab('members')}
          >
            成员
          </button>
          <button
            className={`px-4 py-2 font-medium ${
              activeTab === 'subscriptions'
                ? 'border-b-2 border-primary text-primary'
                : 'text-fg-muted hover:text-foreground'
            }`}
            onClick={() => setActiveTab('subscriptions')}
          >
            雇佣关系
          </button>
          <button
            className={`px-4 py-2 font-medium ${
              activeTab === 'transactions'
                ? 'border-b-2 border-primary text-primary'
                : 'text-fg-muted hover:text-foreground'
            }`}
            onClick={() => setActiveTab('transactions')}
          >
            交易记录
          </button>
        </div>

        {activeTab === 'members' && (
          <Card variant="solid">
            <CardHeader>
              <CardTitle>企业成员 ({enterprise.members.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-fg-muted">
                    <th className="px-5 py-2 text-left font-medium">用户</th>
                    <th className="px-5 py-2 text-left font-medium">角色</th>
                    <th className="px-5 py-2 text-left font-medium">部门</th>
                    <th className="px-5 py-2 text-left font-medium">系统角色</th>
                  </tr>
                </thead>
                <tbody>
                  {enterprise.members.map((member) => (
                    <tr key={member.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-3">
                        <div>
                          <div className="font-medium">
                            {member.user.name || member.user.email}
                          </div>
                          {member.user.name && (
                            <div className="text-xs text-fg-muted">
                              {member.user.email}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <Badge className="bg-muted text-foreground">{member.role}</Badge>
                      </td>
                      <td className="px-5 py-3">{member.department?.name || '-'}</td>
                      <td className="px-5 py-3">
                        <Badge className="bg-primary text-white">{member.user.role}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {activeTab === 'subscriptions' && (
          <Card variant="solid">
            <CardHeader>
              <CardTitle>雇佣关系 ({enterprise.subscriptions.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-fg-muted">
                    <th className="px-5 py-2 text-left font-medium">称呼</th>
                    <th className="px-5 py-2 text-left font-medium">员工</th>
                    <th className="px-5 py-2 text-left font-medium">版本</th>
                    <th className="px-5 py-2 text-left font-medium">状态</th>
                    <th className="px-5 py-2 text-left font-medium">雇佣时间</th>
                  </tr>
                </thead>
                <tbody>
                  {enterprise.subscriptions.map((sub) => (
                    <tr key={sub.id} className="border-b border-border last:border-0">
                      {/* 未自定义称呼时回落到员工名 */}
                      <td className="px-5 py-3 font-medium">{sub.name ?? sub.employee.name}</td>
                      <td className="px-5 py-3">{sub.employee.name}</td>
                      <td className="px-5 py-3 font-mono text-xs">{sub.templateVersion}</td>
                      <td className="px-5 py-3">
                        <Badge className={SUBSCRIPTION_STATUS_STYLE[sub.status] ?? ''}>
                          {SUBSCRIPTION_STATUS_LABEL[sub.status] ?? sub.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-fg-muted">
                        {new Date(sub.createdAt).toLocaleString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {activeTab === 'transactions' && (
          <Card variant="solid">
            <CardHeader>
              <CardTitle>
                交易记录 ({transactions.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!transactions.length ? (
                <div className="text-center py-8 text-fg-muted">暂无交易记录</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-fg-muted">
                      <th className="px-5 py-2 text-left font-medium">类型</th>
                      <th className="px-5 py-2 text-right font-medium">金额</th>
                      <th className="px-5 py-2 text-left font-medium">说明</th>
                      <th className="px-5 py-2 text-left font-medium">时间</th>
                      <th className="px-5 py-2 text-left font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => (
                      <tr key={tx.id} className="border-b border-border last:border-0">
                        <td className="px-5 py-3">
                          <Badge className={WALLET_TX_TONE[tx.type] ?? 'bg-muted text-foreground'}>
                            {WALLET_TX_LABEL[tx.type] ?? tx.type}
                          </Badge>
                        </td>
                        <td
                          className={`px-5 py-3 text-right font-mono ${
                            tx.amount > 0 ? 'text-gsuccess' : 'text-gdanger'
                          }`}
                        >
                          {tx.amount > 0 ? '+' : ''}
                          ¥{tx.amount.toFixed(2)}
                        </td>
                        <td className="px-5 py-3">{tx.description || '-'}</td>
                        <td className="px-5 py-3 text-fg-muted">
                          {new Date(tx.createdAt).toLocaleString('zh-CN')}
                        </td>
                        <td className="px-5 py-3">
                          {tx.type === 'DEPOSIT' && tx.refundableAmount > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setRefundTransaction(tx);
                                setRefundMode('all');
                                setRefundAmount('');
                                setRefundReason('');
                              }}
                            >
                              退款
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Suspend Warning */}
      {isSuspended && enterprise.metadata?.suspendReason && (
        <Card className="border-danger">
          <CardHeader>
            <CardTitle className="text-danger">冻结信息</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-fg-muted">冻结原因:</span>
                <p className="mt-1">{enterprise.metadata.suspendReason}</p>
              </div>
              {enterprise.metadata.suspendedAt && (
                <div>
                  <span className="text-fg-muted">冻结时间:</span>
                  <p className="mt-1">
                    {new Date(enterprise.metadata.suspendedAt).toLocaleString('zh-CN')}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!refundTransaction} onOpenChange={(open) => !open && setRefundTransaction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>充值退款</DialogTitle>
            <DialogDescription>仅退还该笔充值尚未使用的余额，已消费金额不支持在线退款。</DialogDescription>
          </DialogHeader>
          {refundTransaction && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/40 p-3">
                <span className="text-fg-muted">原充值金额</span><span className="text-right font-mono">¥{Math.abs(refundTransaction.amount).toFixed(2)}</span>
                <span className="text-fg-muted">已退款金额</span><span className="text-right font-mono">¥{refundTransaction.refundedAmount.toFixed(2)}</span>
                <span className="text-fg-muted">当前可退款</span><span className="text-right font-mono font-semibold">¥{refundTransaction.refundableAmount.toFixed(2)}</span>
                <span className="text-fg-muted">企业当前余额</span><span className="text-right font-mono">¥{balance.toFixed(2)}</span>
              </div>
              <div className="space-y-2">
                <p className="font-medium">退款金额</p>
                <label className="flex items-center gap-2">
                  <input type="radio" name="refund-mode" checked={refundMode === 'all'} onChange={() => setRefundMode('all')} />
                  退还全部可退余额 ¥{refundTransaction.refundableAmount.toFixed(2)}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="refund-mode" checked={refundMode === 'partial'} onChange={() => setRefundMode('partial')} />
                  退还部分金额
                </label>
                {refundMode === 'partial' && (
                  <Input type="number" min="0.01" max={refundTransaction.refundableAmount} step="0.01" value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} placeholder="请输入退款金额" />
                )}
              </div>
              <div className="space-y-2">
                <label className="font-medium" htmlFor="refund-reason">退款原因（选填）</label>
                <textarea id="refund-reason" className="w-full resize-none rounded border border-border px-3 py-2" rows={3} maxLength={200} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} placeholder="可填写退款说明" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRefundTransaction(null)}>取消</Button>
            <Button onClick={handleRefund} disabled={!validRefund || refundDeposit.isPending}>
              {refundDeposit.isPending ? '处理中...' : '确认退款'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit Dialog */}
      {creditDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>
                {creditType === 'RECHARGE' ? '充值算力' : '扣减算力'}
              </CardTitle>
              <p className="text-sm text-fg-muted mt-1">
                当前余额: ¥{balance.toFixed(2)}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  variant={creditType === 'RECHARGE' ? 'primary' : 'secondary'}
                  onClick={() => setCreditType('RECHARGE')}
                  className="flex-1"
                >
                  充值
                </Button>
                <Button
                  variant={creditType === 'DEDUCT' ? 'primary' : 'secondary'}
                  onClick={() => setCreditType('DEDUCT')}
                  className="flex-1"
                >
                  扣减
                </Button>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">金额（元）</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="请输入金额"
                  value={creditAmount}
                  onChange={(e) => setCreditAmount(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">备注</label>
                <textarea
                  className="w-full px-3 py-2 border border-border rounded resize-none"
                  placeholder="请输入操作备注"
                  value={creditNote}
                  onChange={(e) => setCreditNote(e.target.value)}
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setCreditDialogOpen(false)}
                >
                  取消
                </Button>
                <Button
                  onClick={handleCreditAdjustment}
                  disabled={creditAdjustment.isPending}
                >
                  {creditAdjustment.isPending ? '处理中...' : '确认'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Suspend Dialog */}
      {suspendDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>冻结企业</CardTitle>
              <p className="text-sm text-fg-muted mt-1">
                冻结后该企业将无法使用平台服务
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">冻结原因</label>
                <textarea
                  className="w-full px-3 py-2 border border-border rounded resize-none"
                  placeholder="请输入冻结原因"
                  value={suspendReason}
                  onChange={(e) => setSuspendReason(e.target.value)}
                  rows={4}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setSuspendDialogOpen(false)}
                >
                  取消
                </Button>
                <Button
                  variant="danger"
                  onClick={handleSuspend}
                  disabled={suspendEnterprise.isPending}
                >
                  {suspendEnterprise.isPending ? '处理中...' : '确认冻结'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={resumeDialogOpen}
        onOpenChange={setResumeDialogOpen}
        title="解冻企业"
        description={`确认要解冻企业「${enterprise?.name}」吗？解冻后企业将恢复正常使用。`}
        confirmText="确认解冻"
        cancelText="取消"
        variant="default"
        loading={resumeEnterprise.isPending}
        onConfirm={handleResume}
      />
      <EnterpriseDeletionDialog open={deletionDialogOpen} onOpenChange={setDeletionDialogOpen} enterpriseId={enterpriseId} enterpriseName={enterprise.name} onCompleted={() => router.push('/admin/enterprises')} />
    </div>
  );
}
