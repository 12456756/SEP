import type { Metadata } from 'next';
import { MarketHeader } from '@/components/shell/market-header';
import { AuroraBackground } from '@/components/ui/aurora-background';
import { PageTransition } from '@/components/ui/page-transition';

export const metadata: Metadata = {
  title: '元机AI人才市场 — 元机AI',
  description: '浏览、筛选、订阅 AI 硅基员工，涵盖人事、销售、财务、技术等职能。',
};

/**
 * 人才市场路由组布局。
 * - 对未登录用户**完全开放**（无 AuthGate）
 * - 使用 AuroraBackground 自动响应主题切换
 * - main 不限宽，由子页面自己决定最大宽度
 */
export default function MarketLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuroraBackground className="min-h-dvh">
      <MarketHeader />
      <main className="mx-auto max-w-7xl px-6 py-8">
        <PageTransition className="">{children}</PageTransition>
      </main>
    </AuroraBackground>
  );
}
