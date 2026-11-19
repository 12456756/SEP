import type { Metadata } from "next";
import { PillNav } from "./_components/pill-nav";
import { SiteFooter } from "./_components/site-footer";
import { RevealBoot } from "./_components/reveal-boot";
import { AuroraBackground } from "@/components/ui/aurora-background";

/**
 * ⚠️ 故意不挂 PageTransition（P3.2 例外）：本组只有 `/` 一个路由，组内没有页间切换，
 * 过渡一致性诉求不适用；而落地页有自己的入场编排（RevealBoot + .reveal + .mock-in 逐条落位），
 * 再叠一层通用 mount-fade 会和 hero 动画打架。新增落地页子路由时再评估是否挂上。
 */

export const metadata: Metadata = {
  title: "元机AI · 让公司从个体提效到组织提效",
  description:
    "让公司从个体提效到组织提效：把 Agent、RPA、技能与 AI 应用包装成可订阅、可授权、可追踪的硅基员工，与碳基团队协同工作。",
};

/**
 * 官网落地页外壳（PRD §7）。
 *
 * 使用 AuroraBackground 组件自动响应主题切换。
 * min-h-dvh 保证短页面时下方不会露出 body 的浅色底。
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuroraBackground className="min-h-dvh">
      <RevealBoot />
      <PillNav />
      <main>{children}</main>
      <SiteFooter />
    </AuroraBackground>
  );
}
