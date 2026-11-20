'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { ThemeLogo } from '@/components/ui/theme-logo';
import { useAuthStore, defaultHomeFor } from '@/lib/auth-store';
import { CartButton } from '@/components/cart-button';

/**
 * 人才市场顶栏。市场是**公开**的（未登录可浏览），
 * 未登录时显示登录/注册入口，已登录时显示回控制台的入口。
 *
 * 只在 `(market)` 路由组内使用，那里外层挂了 `theme-glass`，
 * 所以这里可以直接用 glass 令牌（glassline / gtext-* / glass-N）。
 */
export function MarketHeader() {
  const { token, user, enterprise, hydrated } = useAuthStore();
  const loggedIn = hydrated && Boolean(token);

  return (
    <header className="sticky top-0 z-30 border-b border-glassline bg-glass-1 backdrop-blur-glass-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link href="/marketplace" className="flex items-center gap-2.5">
            <ThemeLogo priority />
            <span className="text-sm font-semibold text-gtext-primary">
              元机AI人才市场
            </span>
          </Link>

          <Link
            href="/"
            className="hidden text-[13px] text-gtext-secondary transition-colors hover:text-gtext-primary sm:block"
          >
            回首页
          </Link>
        </div>

        <nav className="flex items-center gap-2">
          {loggedIn ? (
            <>
              <CartButton />
              <Link
                href={defaultHomeFor(user, enterprise)}
                className={cn(buttonVariants({ variant: 'glass', size: 'sm' }))}
              >
                {enterprise ? enterprise.name : '控制台'}
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className={cn(buttonVariants({ variant: 'glass', size: 'sm' }))}
              >
                登录
              </Link>
              <Link
                href="/register"
                className={cn(buttonVariants({ variant: 'glass-primary', size: 'sm' }))}
              >
                免费注册
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
