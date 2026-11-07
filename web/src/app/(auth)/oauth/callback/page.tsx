'use client';

import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { CenteredSpinner } from '@/components/ui/feedback';
import { tryRefresh } from '@/lib/api-client';
import { useAuthStore, defaultHomeFor } from '@/lib/auth-store';

export default function OAuthCallbackPage() {
  return <Suspense fallback={<CenteredSpinner label="正在完成登录…" />}><OAuthCallback /></Suspense>;
}

function OAuthCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get('status');
  const intent = params.get('intent');
  const reason = params.get('reason');
  const setHydrated = useAuthStore((s) => s.setHydrated);

  useEffect(() => {
    let cancelled = false;
    if (status !== 'success') return;
    void tryRefresh().then((ok) => {
      if (cancelled) return;
      setHydrated();
      if (ok) {
        const state = useAuthStore.getState();
        router.replace(intent === 'LINK' ? '/settings/security/identities' : defaultHomeFor(state.user, state.enterprise));
      }
    });
    return () => { cancelled = true; };
  }, [intent, router, setHydrated, status]);

  if (status === 'success') return <CenteredSpinner label="登录成功，正在进入平台…" />;
  const message = getCallbackMessage(status, intent, reason);
  const backHref = reason === 'oauth_not_registered' ? '/register' : '/login';
  return (
    <div className="space-y-4 text-center">
      <h2 className="text-2xl font-semibold text-gtext-primary">无法完成登录</h2>
      <p className="text-sm text-gtext-secondary">{message}</p>
      <div className="flex justify-center gap-4">
        <Link href={backHref} className="text-sm font-medium text-primary hover:underline">
          {reason === 'oauth_not_registered' ? '返回注册页' : '返回登录页'}
        </Link>
        {intent === 'INVITATION' && (
          <span className="text-xs text-gtext-muted">请使用浏览器返回邀请页重试</span>
        )}
      </div>
    </div>
  );
}

function getCallbackMessage(
  status: string | null,
  intent: string | null,
  reason: string | null,
): string {
  if (status === 'cancelled') return '你已取消第三方登录。';
  if (reason === 'enterprise_suspended') return '所属企业已被冻结，暂无法登录平台服务，请联系平台管理员。';
  if (reason === 'account_exists') return '该第三方账号已注册，请返回登录页直接登录。';
  if (reason === 'oauth_not_registered') return '该第三方账号尚未注册，请先完成注册。';
  if (intent === 'INVITATION' && reason === 'invitation_email_mismatch') {
    return '第三方账号与邀请邮箱不匹配，请使用邀请邮箱对应的账号。';
  }
  if (intent === 'INVITATION' && reason === 'account_conflict') {
    return '邀请邮箱已有账号，请先使用邮箱密码登录，再回到邀请链接接受邀请。';
  }
  if (intent === 'INVITATION' && reason === 'invitation_invalid') {
    return '邀请链接已失效，请联系企业管理员重新生成邀请。';
  }
  return '第三方登录未完成，请重新尝试。';
}
