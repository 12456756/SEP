'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  User,
  Building2,
  Shield,
  Link2,
  MonitorSmartphone,
  Activity,
  KeyRound,
  Users,
  Plug,
  CreditCard,
  Cpu,
  Image,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/settings/profile', label: '个人资料', icon: User },
  { href: '/settings/models', label: '模型偏好', icon: Cpu },
  { href: '/settings/media', label: '图片配置', icon: Image },
  { href: '/settings/billing', label: '账单与套餐', icon: CreditCard },
  { href: '/settings/organization', label: '企业信息', icon: Building2 },
  { href: '/settings/security', label: '安全策略', icon: Shield },
  { href: '/settings/security/identities', label: '第三方账号', icon: Link2 },
  { href: '/settings/security/sessions', label: '登录设备', icon: MonitorSmartphone },
  { href: '/settings/security/events', label: '认证活动', icon: Activity },
  { href: '/settings/security/password', label: '登录密码', icon: KeyRound },
  { href: '/account-closure', label: '注销账号', icon: Shield },
  { href: '/settings/roles', label: '角色权限', icon: Users },
  { href: '/settings/integrations', label: '集成与 Webhook', icon: Plug },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen min-w-0 flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full min-w-0 shrink-0 border-b border-border bg-sidebar px-3 py-3 md:w-56 md:border-b-0 md:border-r md:py-6">
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-fg-muted md:mb-4">
          设置
        </p>
        <nav aria-label="设置导航" className="flex gap-1 overflow-x-auto md:block md:space-y-0.5">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-fg-muted hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <main className="min-w-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
