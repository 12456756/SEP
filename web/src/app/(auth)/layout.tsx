import { ThemeToggle } from '@/components/ui/theme-toggle';
import { ThemeLogo } from '@/components/ui/theme-logo';
import { AuroraBackground } from '@/components/ui/aurora-background';
import { PageTransition } from '@/components/ui/page-transition';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuroraBackground blobs={2} className="relative flex min-h-screen">
      {/* 主题切换按钮 - 右上角固定 */}
      <div className="fixed right-6 top-6 z-50">
        <ThemeToggle />
      </div>

      {/* Brand panel */}
      <div className="hidden w-1/2 flex-col justify-between p-12 lg:flex">
        <div className="flex items-center gap-2.5">
          <ThemeLogo width={40} height={40} priority />
          <span className="text-xl font-semibold tracking-tight text-gtext-primary">元机AI</span>
        </div>

        {/* 中间内容区 - 垂直居中 */}
        <div className="max-w-lg space-y-6">
          <h1 className="text-5xl font-bold leading-tight text-gtext-primary">
            订阅硅基员工<br />调度硅基能力
          </h1>
          <p className="text-lg leading-relaxed text-gtext-secondary">
            像招募团队一样订阅硅基员工，用一句话驱动 Agent、RPA、技能与 AI 应用，把重复工作交给硅基劳动力。
          </p>
        </div>

        <div className="text-sm text-gtext-tertiary">© 2026 元机AI</div>
      </div>

      {/* Form panel - 玻璃态卡片 */}
      <div className="flex w-full items-center justify-center px-6 lg:w-1/2">
        <div className="w-full max-w-md rounded-2xl border border-border/50 bg-card/80 p-8 shadow-glass backdrop-blur-xl">
          {/* 左侧品牌栏跨 login/register/join 保持不变，只有右侧表单随路由切换淡入 */}
          <PageTransition className="">{children}</PageTransition>
        </div>
      </div>
    </AuroraBackground>
  );
}
