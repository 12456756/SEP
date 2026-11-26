'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, Spinner } from '@/components/ui/feedback';
import { useLogin } from '@/features/auth/use-auth';
import { OAuthProviderButtons } from '@/features/auth/oauth-provider-buttons';
import { ApiError } from '@/lib/api-client';

const schema = z.object({
  email: z.string().email('请输入有效邮箱'),
  password: z.string().min(1, '请输入密码'),
});
type FormValues = z.infer<typeof schema>;

/**
 * useSearchParams() 会让整棵子树退出静态预渲染，Next 要求它必须被
 * Suspense 包住，否则 `next build` 在导出 /login 时直接失败。
 * 故把用到它的部分拆成 LoginForm，页面组件只负责套边界。
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<CenteredSpinner label="加载中…" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  // 访客在市场页点「登录后订阅」时带上，登录成功后跳回该员工详情。
  // 合法性校验（必须是站内路径）在 useLogin 里做。
  const redirect = useSearchParams().get('redirect');
  const reset = useSearchParams().get('reset');
  const login = useLogin(redirect);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  // 原先这里有个 console.log 把整个 values（含明文密码）打进控制台，已移除
  const onSubmit = (values: FormValues) => login.mutate(values);

  const serverError =
    login.error instanceof ApiError ? login.error.message : login.error ? '登录失败' : null;

  return (
    <div>
      <h2 className="text-2xl font-semibold text-gtext-primary">欢迎回来</h2>
      <p className="mt-1 text-sm text-gtext-secondary">登录后进入你的硅基员工工作台</p>
      {['success', 'synced', 'sync-pending'].includes(reset ?? '') && <p role="status" className="mt-3 text-sm text-gtext-secondary">
        {reset === 'sync-pending' ? 'SEP 密码已重置，算力平台密码同步中，后台将自动重试。请使用新密码登录 SEP。'
          : reset === 'synced' ? 'SEP 和算力平台密码已同步重置，请使用新密码登录。' : '密码已重置，请使用新密码登录。'}
      </p>}

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gtext-primary">邮箱</label>
          <Input type="email" autoComplete="username" placeholder="you@company.com" {...register('email')} />
          {errors.email && (
            <p className="mt-1 text-xs text-danger">
              {errors.email.message}
            </p>
          )}
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="block text-sm font-medium text-gtext-primary">密码</label>
            <Link href="/forgot-password" className="text-xs text-primary hover:underline">忘记密码？</Link>
          </div>
          <Input type="password" autoComplete="current-password" placeholder="••••••••" {...register('password')} />
          {errors.password && (
            <p className="mt-1 text-xs text-danger">{errors.password.message}</p>
          )}
        </div>

        {serverError && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger backdrop-blur-sm">
            {serverError}
          </div>
        )}

        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending && <Spinner />}
          登录
        </Button>

      <OAuthProviderButtons intent="LOGIN" disabled={login.isPending} />
      </form>

      <p className="mt-6 text-center text-sm text-gtext-secondary">
        还没有账号？{' '}
        <Link href="/register" className="font-medium text-primary hover:underline">
          注册
        </Link>
      </p>
    </div>
  );
}
