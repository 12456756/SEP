'use client';

import { useState } from 'react';
import { Check, Loader2, LockKeyhole } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useChangePassword } from '@/features/user/use-user';
import { ApiError } from '@/lib/api-client';

const schema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码至少 8 位'),
  confirmPassword: z.string().min(1, '请确认新密码'),
}).refine((value) => value.newPassword === value.confirmPassword, {
  path: ['confirmPassword'],
  message: '两次输入的密码不一致',
});

type FormValues = z.infer<typeof schema>;

export default function SecurityPasswordPage() {
  const changePassword = useChangePassword();
  const [success, setSuccess] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = form.handleSubmit((values) => {
    setSuccess(false);
    changePassword.mutate(
      { currentPassword: values.currentPassword, newPassword: values.newPassword },
      { onSuccess: () => { form.reset(); setSuccess(true); } },
    );
  });
  const error = changePassword.error instanceof ApiError ? changePassword.error.message : '修改密码失败，请稍后重试';

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">登录密码</h1>
        <p className="mt-1 text-sm text-fg-muted">修改密码后，其他设备的登录会话会被撤销，本设备会保持登录。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><LockKeyhole className="h-5 w-5" />修改密码</CardTitle>
          <CardDescription>请使用至少 8 位的新密码，并避免与其他网站重复。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            {([
              ['currentPassword', '当前密码'],
              ['newPassword', '新密码'],
              ['confirmPassword', '确认新密码'],
            ] as const).map(([name, label]) => (
              <div key={name}>
                <label className="mb-1.5 block text-sm font-medium text-foreground" htmlFor={name}>{label}</label>
                <Input id={name} type="password" autoComplete={name === 'currentPassword' ? 'current-password' : 'new-password'} {...form.register(name)} error={Boolean(form.formState.errors[name])} errorMessage={form.formState.errors[name]?.message} />
              </div>
            ))}
            {changePassword.error && <p role="alert" className="text-sm text-danger">{error}</p>}
            {success && <p role="status" className={`flex items-center gap-1 text-sm ${changePassword.data?.computePasswordSync === 'PENDING' ? 'text-amber-700 dark:text-amber-400' : 'text-success'}`}><Check className="h-4 w-4 shrink-0" />{changePassword.data?.message ?? '密码已修改，其他设备已退出'}</p>}
            <Button type="submit" disabled={changePassword.isPending}>
              {changePassword.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存新密码
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
