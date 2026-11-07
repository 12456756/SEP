'use client';

import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Check, KeyRound, Loader2, MailCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { useRequestEmailChange, useRequestEmailVerification } from '@/features/auth/use-auth';
import { useChangePassword, useMe } from '@/features/user/use-user';
import { ApiError } from '@/lib/api-client';

const passwordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码至少 8 位'),
  confirmPassword: z.string().min(1, '请确认新密码'),
}).refine((value) => value.newPassword === value.confirmPassword, {
  path: ['confirmPassword'],
  message: '两次输入的密码不一致',
});

type PasswordValues = z.infer<typeof passwordSchema>;

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return fallback;
}

export default function AdminAccountSettingsPage() {
  const profile = useMe();
  const changePassword = useChangePassword();
  const requestEmailChange = useRequestEmailChange();
  const requestEmailVerification = useRequestEmailVerification();
  const [newEmail, setNewEmail] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  if (profile.isLoading) return <CenteredSpinner label="正在读取账号信息…" />;
  if (profile.isError || !profile.data) {
    return <div className="p-6"><EmptyState title="账号信息加载失败" description="请稍后重试或重新登录。" /></div>;
  }

  const emailVerified = Boolean(profile.data.emailVerifiedAt);
  const onPasswordSubmit = form.handleSubmit((values) => {
    setPasswordSaved(false);
    changePassword.mutate(
      { currentPassword: values.currentPassword, newPassword: values.newPassword },
      { onSuccess: () => { form.reset(); setPasswordSaved(true); } },
    );
  });

  function submitEmailChange() {
    setEmailMessage('');
    requestEmailChange.mutate(newEmail.trim(), {
      onSuccess: ({ message }) => {
        setEmailMessage(message);
        setNewEmail('');
      },
    });
  }

  function sendVerificationEmail() {
    setEmailMessage('');
    requestEmailVerification.mutate(undefined, {
      onSuccess: ({ message }) => setEmailMessage(message),
    });
  }

  const passwordError = changePassword.error
    ? errorMessage(changePassword.error, '修改密码失败，请稍后重试')
    : '';
  const emailError = requestEmailChange.error || requestEmailVerification.error;

  return (
    <div className="max-w-3xl space-y-6 p-6">
      <header>
        <p className="text-sm text-fg-muted">管理后台 / 账号设置</p>
        <h1 className="mt-1 text-2xl font-semibold">账号设置</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>登录邮箱</CardTitle>
          <CardDescription>此邮箱用于登录和账号安全验证，与系统通知邮箱分开管理。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
            <MailCheck className="h-5 w-5 text-fg-muted" />
            <span className="min-w-0 flex-1 break-all text-sm font-medium">{profile.data.email}</span>
            <Badge variant={emailVerified ? 'default' : 'secondary'}>
              {emailVerified ? '已验证' : '未验证'}
            </Badge>
          </div>

          {emailVerified ? (
            <div className="space-y-3">
              <label htmlFor="new-login-email" className="block text-sm font-medium">修改登录邮箱</label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="new-login-email"
                  aria-label="新的登录邮箱"
                  className="min-w-[220px] flex-1"
                  type="email"
                  autoComplete="email"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  placeholder="新的邮箱地址"
                  disabled={requestEmailChange.isPending}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={submitEmailChange}
                  disabled={!newEmail.trim() || requestEmailChange.isPending}
                >
                  {requestEmailChange.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  发送确认邮件
                </Button>
              </div>
              <p className="text-xs text-fg-muted">确认邮件会发送到新邮箱，点击邮件中的链接后才会生效。</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-fg-muted">验证当前邮箱后，才能申请修改登录邮箱。</p>
              <Button
                type="button"
                variant="outline"
                onClick={sendVerificationEmail}
                disabled={requestEmailVerification.isPending}
              >
                {requestEmailVerification.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                发送验证邮件
              </Button>
            </div>
          )}
          {emailMessage && <p role="status" className="text-sm text-success">{emailMessage}</p>}
          {emailError && <p role="alert" className="text-sm text-danger">{errorMessage(emailError, '邮件发送失败，请稍后重试')}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" />登录密码</CardTitle>
          <CardDescription>新密码至少 8 位；修改成功后其他设备会退出，本设备保持登录。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onPasswordSubmit} className="max-w-xl space-y-4">
            {([
              ['currentPassword', '当前密码', 'current-password'],
              ['newPassword', '新密码', 'new-password'],
              ['confirmPassword', '确认新密码', 'new-password'],
            ] as const).map(([name, label, autoComplete]) => (
              <div key={name}>
                <label htmlFor={name} className="mb-1.5 block text-sm font-medium">{label}</label>
                <Input
                  id={name}
                  type="password"
                  autoComplete={autoComplete}
                  {...form.register(name)}
                  error={Boolean(form.formState.errors[name])}
                  errorMessage={form.formState.errors[name]?.message}
                />
              </div>
            ))}
            {passwordError && <p role="alert" className="text-sm text-danger">{passwordError}</p>}
            {passwordSaved && <p role="status" className="flex items-center gap-1 text-sm text-success"><Check className="h-4 w-4" />密码已修改，其他设备已退出。</p>}
            <div className="flex flex-wrap items-center gap-4">
              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                保存新密码
              </Button>
              <Link href="/forgot-password" className="text-sm text-primary hover:underline">忘记当前密码？</Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
