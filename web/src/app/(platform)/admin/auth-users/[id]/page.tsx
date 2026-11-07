'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  KeyRound,
  LogOut,
  MailCheck,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import {
  useAdminAuthUser,
  useAdminAuthUserEvents,
  useDisableAdminAuthUser,
  useEnableAdminAuthUser,
  useForceEmailVerification,
  useForceLogoutAdminAuthUser,
  useForcePasswordReset,
  type AdminAuthUserDetail,
} from '@/features/admin/use-admin-auth';

export default function AdminAuthUserDetailPage({
  params: paramsPromise,
}: {
  params: Promise<{ id: string }>;
}) {
  const params = use(paramsPromise);
  return <AdminAuthUserDetailContent userId={params.id} />;
}

export function AdminAuthUserDetailContent({ userId }: { userId: string }) {
  const user = useAdminAuthUser(userId);
  const events = useAdminAuthUserEvents(userId);
  const [reason, setReason] = useState('平台安全策略要求');
  const [resetMessage, setResetMessage] = useState('');
  const disable = useDisableAdminAuthUser(userId);
  const enable = useEnableAdminAuthUser(userId);
  const logoutAll = useForceLogoutAdminAuthUser(userId);
  const verify = useForceEmailVerification(userId);
  const reset = useForcePasswordReset(userId);

  if (user.isLoading) return <CenteredSpinner />;
  if (user.isError || !user.data)
    return (
      <EmptyState
        title="用户认证详情加载失败"
        description="用户不存在或管理员会话已失效。"
      />
    );
  const detail = user.data;
  const isLifecycleStatus =
    detail.status === 'CLOSURE_PENDING' || detail.status === 'CLOSED';
  const canManageAuthentication = detail.status === 'ACTIVE';
  const run = (fn: () => void) => {
    if (window.confirm('确认执行此安全操作？')) fn();
  };
  const requestPasswordReset = () => {
    setResetMessage('');
    reset.mutate({}, {
      onSuccess: (result) => {
        const message = typeof result === 'object' && result !== null && 'message' in result
          ? String(result.message)
          : '重置密码邮件已发送';
        setResetMessage(message);
      },
    });
  };

  return (
    <div className="space-y-6">
      <Link
        href="/admin/auth-users"
        className="inline-flex items-center gap-2 text-sm text-fg-muted hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        返回认证用户
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-fg-muted">平台管理 / 认证中心</p>
          <h1 className="mt-1 text-2xl font-semibold">
            {detail.name || '未命名用户'}
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            {detail.email} · {detail.id}
          </p>
        </div>
        <StatusBadge status={detail.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            管理员操作
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {!isLifecycleStatus &&
              (detail.status === 'DISABLED' ? (
                <Button
                  onClick={() => run(() => enable.mutate({}))}
                  disabled={enable.isPending}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  解禁账号
                </Button>
              ) : (
                <Button
                  variant="glass-danger"
                  onClick={() => run(() => disable.mutate({ reason }))}
                  disabled={disable.isPending}
                >
                  <Ban className="mr-2 h-4 w-4" />
                  禁用账号
                </Button>
              ))}
            <Button
              variant="outline"
              onClick={() => run(() => logoutAll.mutate({}))}
              disabled={isLifecycleStatus || logoutAll.isPending}
            >
              <LogOut className="mr-2 h-4 w-4" />
              退出全部设备
            </Button>
            <Button
              variant="outline"
              onClick={() => run(() => verify.mutate({}))}
              disabled={isLifecycleStatus || verify.isPending}
            >
              <MailCheck className="mr-2 h-4 w-4" />
              要求重新验证邮箱
            </Button>
            <Button
              variant="outline"
              onClick={() => run(requestPasswordReset)}
              disabled={!canManageAuthentication || reset.isPending}
            >
              <KeyRound className="mr-2 h-4 w-4" />
              {reset.isPending ? '正在发送重置邮件…' : '强制重置密码'}
            </Button>
          </div>
          <p className="text-sm text-fg-muted">用户会收到设置新密码的邮件；邮件请求成功后，该用户的全部登录设备会退出。管理员不会接触用户密码。</p>
          {resetMessage && <p role="status" className="text-sm text-success">{resetMessage}，用户的全部登录设备已退出。</p>}
          {reset.error && <p role="alert" className="text-sm text-danger">{reset.error instanceof Error ? reset.error.message : '重置密码邮件发送失败，请稍后重试'}</p>}
          {!isLifecycleStatus && detail.status !== 'DISABLED' && (
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="禁用原因"
            />
          )}
          {isLifecycleStatus && (
            <p className="text-sm text-fg-muted">
              生命周期状态由注销流程管理，运营端不能启用、禁用或修改认证状态。
            </p>
          )}
          {detail.status === 'DISABLED' && (
            <p className="text-sm text-fg-muted">账号已禁用，解禁后才能发送密码重置邮件。</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>认证凭据</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {detail.authCredentials.map((credential) => (
              <div
                key={credential.type}
                className="rounded-lg border border-glassline p-3"
              >
                <div className="font-medium">{credential.type}</div>
                <div className="mt-1 text-fg-muted">
                  失败次数：{credential.failedCount} · 最近使用：
                  {credential.lastUsedAt
                    ? new Date(credential.lastUsedAt).toLocaleString('zh-CN')
                    : '暂无'}
                </div>
                {credential.lockedUntil && (
                  <div className="text-destructive">
                    锁定至：
                    {new Date(credential.lockedUntil).toLocaleString('zh-CN')}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>第三方身份</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {detail.authIdentities.length ? (
              detail.authIdentities.map((identity) => (
                <div
                  key={identity.id}
                  className="rounded-lg border border-glassline p-3"
                >
                  <div className="font-medium">{identity.provider}</div>
                  <div className="mt-1 text-fg-muted">
                    账号：{identity.providerAccountId}
                  </div>
                  <div className="text-fg-muted">
                    邮箱：{identity.providerEmail || 'Provider 未提供'}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-fg-muted">未绑定第三方身份</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>有效会话（{detail.authSessions.length}）</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-glassline text-left text-fg-muted">
                <th className="p-4">类型</th>
                <th className="p-4">会话</th>
                <th className="p-4">最近活跃</th>
                <th className="p-4">过期时间</th>
              </tr>
            </thead>
            <tbody>
              {detail.authSessions.map((session) => (
                <tr key={session.id} className="border-b border-glassline/60">
                  <td className="p-4">{session.type}</td>
                  <td className="p-4 font-mono text-xs">{session.id}</td>
                  <td className="p-4 text-fg-muted">
                    {session.lastUsedAt
                      ? new Date(session.lastUsedAt).toLocaleString('zh-CN')
                      : '暂无'}
                  </td>
                  <td className="p-4 text-fg-muted">
                    {new Date(session.expiresAt).toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>认证事件</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {events.isLoading ? (
            <CenteredSpinner />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-glassline text-left text-fg-muted">
                  <th className="p-4">时间</th>
                  <th className="p-4">事件</th>
                  <th className="p-4">结果</th>
                  <th className="p-4">方式</th>
                  <th className="p-4">IP</th>
                </tr>
              </thead>
              <tbody>
                {(events.data ?? []).map((event) => (
                  <tr key={event.id} className="border-b border-glassline/60">
                    <td className="p-4 text-fg-muted">
                      {new Date(event.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="p-4">{event.action}</td>
                    <td className="p-4">
                      {event.success ? (
                        <Badge>成功</Badge>
                      ) : (
                        <Badge variant="glass-danger">失败</Badge>
                      )}
                    </td>
                    <td className="p-4">{event.provider || '—'}</td>
                    <td className="p-4 text-fg-muted">
                      {event.ipAddress || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: AdminAuthUserDetail['status'] }) {
  if (status === 'DISABLED')
    return <Badge variant="glass-danger">已禁用</Badge>;
  if (status === 'CLOSURE_PENDING')
    return <Badge variant="glass-warning">注销待生效</Badge>;
  if (status === 'CLOSED') return <Badge variant="glass-danger">已注销</Badge>;
  return <Badge>正常</Badge>;
}
