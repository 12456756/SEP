'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, Link2, Loader2, Mail, Plus, RotateCw, Search, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import { toast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api-client';
import {
  useInvitations,
  useCreateInvitation,
  useResendInvitation,
  useRevokeInvitation,
} from './use-enterprise';
import { flattenDepts } from './flatten-depts';
import type {
  CreatedInvitation,
  Department,
  EnterpriseInvitation,
  InvitationStatus,
} from '@/lib/types';
import { InvitationCreateDtoSchema } from '../../../../backend/src/shared';

const STATUS_META: Record<
  InvitationStatus,
  { label: string; variant: 'glass' | 'glass-success' | 'glass-warning' | 'glass-danger' }
> = {
  PENDING: { label: '待接受', variant: 'glass-warning' },
  ACCEPTED: { label: '已加入', variant: 'glass-success' },
  EXPIRED: { label: '已过期', variant: 'glass' },
  REVOKED: { label: '已撤回', variant: 'glass-danger' },
};

const ROLE_LABEL: Record<string, string> = {
  ENTERPRISE_ADMIN: '企业管理员',
  MEMBER: '普通成员',
};

function InviteLinkReveal({
  invitation,
  onClose,
}: {
  invitation: CreatedInvitation;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showLink, setShowLink] = useState(invitation.emailStatus !== 'SENT');
  const url = invitation.invitationUrl;
  const emailMessage = {
    SENT: {
      title: '邀请邮件已发送',
      description: '邮件服务器已接收发送请求。若对方暂未收到，可检查垃圾邮件；也可以复制下方链接备用。',
    },
    FAILED: {
      title: '邀请已创建，邮件发送失败',
      description: invitation.emailError || '请稍后重试发送，或复制下方链接转达。',
    },
    NOT_CONFIGURED: {
      title: '邀请已创建，邮件服务未配置',
      description: '请联系平台管理员配置邮件服务，也可以复制下方链接转达。',
    },
    SENDING: { title: '邀请邮件发送中', description: '邮件发送请求正在处理。' },
    UNKNOWN: { title: '邀请已创建', description: '邮件发送记录未知，可复制下方链接备用。' },
  }[invitation.emailStatus];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 非 HTTPS 或未授权剪贴板时会抛错，此时链接仍可手动选中复制
      toast.error('复制失败，请手动选中链接复制');
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:w-full">
        <DialogHeader>
          <DialogTitle>{emailMessage.title}</DialogTitle>
          <DialogDescription className="break-all">
            {emailMessage.description} 收件人：<span className="font-medium">{invitation.email}</span>
          </DialogDescription>
        </DialogHeader>

        {showLink ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
            <code className="max-h-24 min-w-0 flex-1 overflow-y-auto break-all font-mono text-xs">{url}</code>
            <Button size="sm" variant="ghost" onClick={copy} className="shrink-0" title="复制邀请链接">
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setShowLink(true)}>
            <Link2 className="h-4 w-4" /> 查看备用链接
          </Button>
        )}

        <p className="break-all text-xs text-fg-muted">
          该链接仅对 {invitation.email} 有效，转发给他人也无法使用。
          有效期至 {new Date(invitation.expiresAt).toLocaleString('zh-CN')}。
        </p>

        <DialogFooter>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({
  depts,
  onClose,
  onCreated,
}: {
  depts: Department[];
  onClose: () => void;
  onCreated: (inv: CreatedInvitation) => void;
}) {
  const createInvitation = useCreateInvitation();
  const flatDepts = flattenDepts(depts);

  const [form, setForm] = useState({
    email: '',
    role: 'MEMBER' as 'ENTERPRISE_ADMIN' | 'MEMBER',
    departmentId: '',
    position: '',
  });
  const [formError, setFormError] = useState('');

  const submit = () => {
    const parsed = InvitationCreateDtoSchema.safeParse({
      email: form.email.trim(),
      role: form.role,
      departmentId: form.departmentId || undefined,
      position: form.position.trim() || undefined,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? '请检查邀请信息');
      return;
    }
    setFormError('');
    createInvitation.mutate(
      parsed.data,
      {
        onSuccess: (inv) => {
          onClose();
          onCreated(inv);
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : '邀请失败'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !createInvitation.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:w-full">
        <DialogHeader>
          <DialogTitle>邀请成员</DialogTitle>
          <DialogDescription>发送邮件邀请，对方通过邮件中的链接设置密码并加入企业。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium">邮箱 *</label>
            <Input
              type="email"
              placeholder="member@company.com"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              autoFocus
            />
            <p className="mt-1 text-xs text-fg-muted">
              链接与该邮箱绑定，只有用这个邮箱才能接受邀请。
            </p>
          </div>
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}

          <div>
            <label className="mb-1 block text-xs font-medium">角色</label>
            <select
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              value={form.role}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  role: e.target.value as 'ENTERPRISE_ADMIN' | 'MEMBER',
                }))
              }
            >
              <option value="MEMBER">普通成员</option>
              <option value="ENTERPRISE_ADMIN">企业管理员</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">部门</label>
            <select
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              value={form.departmentId}
              onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
            >
              <option value="">不分配部门</option>
              {flatDepts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">职位</label>
            <Input
              placeholder="可选，如：高级工程师"
              value={form.position}
              onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={createInvitation.isPending}>
            取消
          </Button>
          <Button onClick={submit} disabled={createInvitation.isPending}>
            {createInvitation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              发送邀请邮件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InvitationPanel({ depts }: { depts: Department[] }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<InvitationStatus | ''>('');
  const [role, setRole] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const PAGE_SIZE = 20;
  const { data: result, isLoading } = useInvitations(status || undefined, {
    page,
    pageSize: PAGE_SIZE,
    search: search.trim() || undefined,
    role: (role || undefined) as EnterpriseInvitation['role'] | undefined,
    departmentId: departmentId || undefined,
  });
  const invitations = (Array.isArray(result) ? result : result?.items ?? []) as EnterpriseInvitation[];
  const revokeInvitation = useRevokeInvitation();
  const resendInvitation = useResendInvitation();

  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [resending, setResending] = useState<EnterpriseInvitation | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const pendingCount = invitations.filter((i) => i.status === 'PENDING').length;

  const handleRevoke = (inv: EnterpriseInvitation) => {
    revokeInvitation.mutate(inv.id, {
      onSuccess: () => toast.success(`已撤回对 ${inv.email} 的邀请`),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : '撤回失败'),
    });
  };

  const handleResend = () => {
    if (!resending) return;
    resendInvitation.mutate(resending.id, {
      onSuccess: (invitation) => {
        setResending(null);
        setCreated(invitation);
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : '重发失败'),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-fg-muted">
          {pendingCount > 0 ? `${pendingCount} 条邀请待接受` : '暂无待接受的邀请'}
        </p>
        <Button size="sm" onClick={() => setInviting(true)} disabled={revokeInvitation.isPending || resendInvitation.isPending}>
          <Plus className="h-4 w-4" /> 邀请成员
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-fg-muted" />
          <Input aria-label="搜索邀请" placeholder="搜索邮箱或职位" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="pl-9" />
        </div>
        <select aria-label="按邀请状态筛选" value={status} onChange={(event) => { setStatus(event.target.value as InvitationStatus | ''); setPage(1); }} className="h-10 rounded-md border border-border bg-background px-3 text-sm">
          <option value="">全部状态</option>
          <option value="PENDING">待接受</option>
          <option value="ACCEPTED">已加入</option>
          <option value="EXPIRED">已过期</option>
          <option value="REVOKED">已撤回</option>
        </select>
        <select aria-label="按邀请角色筛选" value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }} className="h-10 rounded-md border border-border bg-background px-3 text-sm">
          <option value="">全部角色</option>
          <option value="ENTERPRISE_ADMIN">企业管理员</option>
          <option value="DEPT_MANAGER">部门负责人</option>
          <option value="MEMBER">普通成员</option>
        </select>
        <select aria-label="按邀请部门筛选" value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setPage(1); }} className="h-10 rounded-md border border-border bg-background px-3 text-sm">
          <option value="">全部部门</option>
          {flattenDepts(depts).map((department) => <option key={department.id} value={department.id}>{department.label}</option>)}
        </select>
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-fg-muted">加载中…</p>
      ) : invitations.length === 0 ? (
        <EmptyState
          icon={<Mail className="h-8 w-8" />}
          title="还没有发出邀请"
          description="发送邀请邮件后，对方可以自行设置密码并加入企业。"
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-background">
          <table className="w-full min-w-[1000px] table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-[90px]" />
              <col className="w-[190px]" />
              <col className="w-[110px]" />
              <col className="w-[90px]" />
              <col className="w-[130px]" />
              <col className="w-[90px]" />
            </colgroup>
            <thead className="border-b border-border bg-muted/40">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-fg-muted">邮箱</th>
                <th className="px-4 py-3 text-left font-medium text-fg-muted">状态</th>
                <th className="px-4 py-3 text-left font-medium text-fg-muted">邮件</th>
                <th className="px-4 py-3 text-left font-medium text-fg-muted">角色</th>
                <th className="px-4 py-3 text-left font-medium text-fg-muted">部门</th>
                <th className="px-4 py-3 text-left font-medium text-fg-muted">有效期</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invitations.map((inv) => {
                const meta = STATUS_META[inv.status];
                return (
                  <tr
                    key={inv.id}
                    className={`hover:bg-muted/30 ${inv.status === 'PENDING' ? '' : 'opacity-60'}`}
                  >
                    <td className="break-all px-4 py-3 font-medium">{inv.email}</td>
                    <td className="px-4 py-3">
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-fg-muted">
                      {inv.emailStatus === 'SENT'
                        ? `已发送${inv.emailSentAt ? ` · ${formatDistanceToNow(new Date(inv.emailSentAt), { addSuffix: true, locale: zhCN })}` : ''}`
                        : inv.emailStatus === 'FAILED'
                          ? inv.emailError || '发送失败'
                          : inv.emailStatus === 'NOT_CONFIGURED'
                            ? '邮件服务未配置'
                            : inv.emailStatus === 'SENDING'
                              ? '发送中'
                              : '发送记录未知'}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {ROLE_LABEL[inv.role] ?? inv.role}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {inv.department?.name ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-fg-muted">
                      {inv.status === 'ACCEPTED' && inv.acceptedAt
                        ? `已于 ${formatDistanceToNow(new Date(inv.acceptedAt), {
                            addSuffix: true,
                            locale: zhCN,
                          })}加入`
                        : inv.status === 'PENDING'
                          ? `${formatDistanceToNow(new Date(inv.expiresAt), {
                              addSuffix: true,
                              locale: zhCN,
                            })}过期`
                          : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        {inv.status !== 'ACCEPTED' && (
                          <button
                            title={inv.emailLastAttemptAt && now - new Date(inv.emailLastAttemptAt).getTime() < 60_000
                              ? `请稍后重试（${Math.ceil((60_000 - (now - new Date(inv.emailLastAttemptAt).getTime())) / 1000)} 秒）`
                              : '重新发送邀请邮件'}
                            onClick={() => setResending(inv)}
                            disabled={revokeInvitation.isPending || resendInvitation.isPending || Boolean(inv.emailLastAttemptAt && now - new Date(inv.emailLastAttemptAt).getTime() < 60_000)}
                            className="rounded p-1.5 text-fg-muted hover:bg-muted hover:text-fg disabled:opacity-50"
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {inv.status === 'PENDING' && (
                          <button
                            title="撤回邀请"
                            onClick={() => handleRevoke(inv)}
                            disabled={revokeInvitation.isPending || resendInvitation.isPending}
                            className="rounded p-1.5 text-fg-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!Array.isArray(result) && result && result.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-fg-muted">
          <span>共 {result.total} 条邀请 · 第 {result.page} / {result.totalPages} 页</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
              <ChevronLeft className="h-4 w-4" /> 上一页
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage((value) => Math.min(result.totalPages, value + 1))} disabled={page >= result.totalPages}>
              下一页 <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <p className="flex items-start gap-1.5 text-xs text-fg-muted">
        <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          邀请邮件发送成功表示邮件服务器已接收，不代表已送达或已阅读。重新发送会让旧链接立即失效。
        </span>
      </p>

      {inviting && (
        <InviteDialog
          depts={depts}
          onClose={() => setInviting(false)}
          onCreated={setCreated}
        />
      )}

      {created && (
        <InviteLinkReveal invitation={created} onClose={() => setCreated(null)} />
      )}

      {resending && (
        <Dialog open onOpenChange={(open) => !open && !resendInvitation.isPending && setResending(null)}>
          <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:w-full">
            <DialogHeader>
              <DialogTitle>重新发送邀请？</DialogTitle>
              <DialogDescription className="break-all">
                将向 {resending.email} 发送新链接，有效期重置为 7 天；原链接会立即失效。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResending(null)} disabled={resendInvitation.isPending}>取消</Button>
              <Button onClick={handleResend} disabled={resendInvitation.isPending}>
                {resendInvitation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                确认重发
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
