'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { CenteredSpinner } from '@/components/ui/feedback';
import { useConfirmEmailChange } from '@/features/auth/use-auth';
import { useAuthStore } from '@/lib/auth-store';

export default function VerifyEmailChangePage() {
  return (
    <Suspense fallback={<CenteredSpinner label="正在确认…" />}>
      <VerifyEmailChangeInner />
    </Suspense>
  );
}

function VerifyEmailChangeInner() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const role = useAuthStore((state) => state.user?.role);
  const confirm = useConfirmEmailChange();

  useEffect(() => {
    if (token) confirm.mutate(token);
  }, [token]);

  return (
    <div className="text-center">
      <h2 className="text-2xl font-semibold text-gtext-primary">确认新邮箱</h2>
      <p className="mt-3 text-sm text-gtext-secondary">
        {confirm.isPending
          ? '正在确认…'
          : confirm.isSuccess
            ? '邮箱已修改成功。'
            : '确认链接无效或已过期。'}
      </p>
      {confirm.isSuccess && (
        <button
          className="mt-6 text-sm text-primary hover:underline"
          onClick={() => router.replace(role === 'ADMIN' ? '/admin/account' : '/settings/profile')}
        >
          返回个人设置
        </button>
      )}
    </div>
  );
}
