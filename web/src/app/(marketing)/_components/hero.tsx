import Link from "next/link";
import { ArrowRight, Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { HeroDownloadMenu } from "./hero-download-menu";

/**
 * Hero 里的工作台示意图（CSS + 内联 JSX，不用截图）。
 *
 * 内容对齐**当前真实产品**，不是占位文案：
 *   · 侧栏用企业端 shell 的真实导航项（原来写的「工作台 / 市场」两个路由已经不存在）
 *   · 指标沿用真实仪表盘 MetricCard 的口径：硅基员工 / 本月对话 / 本月算力（元）
 *   · 任务行的状态词取自 task-execution-narration.ts —— 那里定的规矩是
 *     「措辞一律写成员工在汇报工作，主语是人不是节点」。原来这里挂的是
 *     Agent / Skill / RPA 技术标签 + 在线小圆点，读起来像流程引擎的节点列表，
 *     正好是那份文件明确不要的写法。
 *   · 员工名用市场上真实在架的岗位名，不用「营销助理」这种泛化占位
 */
function DashboardMockup() {
  return (
    <div className="glass-hero overflow-hidden">
      {/* 假标题栏 */}
      <div className="flex items-center gap-1.5 border-b border-glassline px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-gdanger/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-gwarning/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-gsuccess/70" />
        <span className="ml-3 text-xs text-gtext-muted">
          工作台 · 元机AI
        </span>
      </div>

      <div className="flex min-h-0">
        {/* 侧栏 —— 与企业端真实导航一致 */}
        <aside className="flex w-[7.5rem] shrink-0 flex-col gap-0.5 border-r border-glassline p-3 sm:w-36">
          {[
            { label: "仪表盘", active: true },
            { label: "我的硅基员工", active: false },
            { label: "任务", active: false },
            { label: "技能库", active: false },
            { label: "算力余额", active: false },
          ].map(({ label, active }) => (
            <div
              key={label}
              className={`truncate rounded-glass-sm px-2 py-2 text-xs ${
                active
                  ? "bg-gbrand/20 font-medium text-gbrand-text"
                  : "text-gtext-muted"
              }`}
            >
              {label}
            </div>
          ))}
        </aside>

        {/* 主区 */}
        <main className="min-w-0 flex-1 p-4">
          {/* 指标行 —— 口径同真实仪表盘 */}
          <div className="mb-3 grid grid-cols-3 gap-2">
            {[
              { label: "硅基员工", val: "14", detail: "6 位正在活跃", d: "mock-d1" },
              { label: "本月对话", val: "1,284", detail: "+38% 较上月", d: "mock-d2" },
              { label: "本月算力", val: "¥21.40", detail: "+12% 较上月", d: "mock-d3" },
            ].map(({ label, val, detail, d }) => (
              <div key={label} className={`glass-card mock-in ${d} p-3`}>
                <div className="text-[10px] text-gtext-muted">{label}</div>
                <div className="mt-1 text-lg font-bold leading-none text-gtext-primary">
                  {val}
                </div>
                <div className="mt-1.5 text-[10px] text-gsuccess">{detail}</div>
              </div>
            ))}
          </div>

          {/* 任务执行 —— 员工在汇报工作，不是节点在跑 */}
          <div className="glass-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-glassline px-3 py-2.5">
              <span className="text-xs font-medium text-gtext-secondary">
                任务 · 双十一退货工单清理
              </span>
              <span className="text-[10px] text-gtext-muted">第 2/3 步</span>
            </div>

            {/* 进行中：脉冲点 + 会长的进度条 */}
            <div className="mock-in mock-d4 border-b border-[rgba(255,255,255,0.10)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gbrand/20">
                    <Bot className="h-3 w-3 text-gbrand-text" aria-hidden />
                  </span>
                  <span className="truncate text-xs text-gtext-primary">
                    电商售后与退货专员
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium text-gbrand-text">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-gbrand-text opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-gbrand-text" />
                  </span>
                  正在工作
                </span>
              </div>
              <p className="mt-1.5 pl-8 text-[10px] text-gtext-muted">
                正在核对 38 条退货工单
              </p>
              <div className="mt-1.5 ml-8 h-1 overflow-hidden rounded-full bg-glass-2">
                <div className="mock-bar h-full rounded-full bg-gbrand-text" />
              </div>
            </div>

            {/* 已交付 / 候场中 */}
            {[
              {
                name: "商品内容与详情页策划",
                status: "已交付",
                tone: "text-gsuccess",
                detail: "重写了 12 个商品详情页",
                d: "mock-d5",
              },
              {
                name: "电商投放优化师",
                status: "候场中",
                tone: "text-gtext-muted",
                detail: "等上一步的退货数据",
                d: "mock-d6",
              },
            ].map(({ name, status, tone, detail, d }) => (
              <div
                key={name}
                className={`mock-in ${d} border-b border-[rgba(255,255,255,0.10)] px-3 py-2.5 last:border-0`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gbrand/20">
                      <Bot className="h-3 w-3 text-gbrand-text" aria-hidden />
                    </span>
                    <span className="truncate text-xs text-gtext-primary">
                      {name}
                    </span>
                  </div>
                  <span className={`shrink-0 text-[10px] font-medium ${tone}`}>
                    {status}
                  </span>
                </div>
                <p className="mt-1.5 pl-8 text-[10px] text-gtext-muted">
                  {detail}
                </p>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Hero 区（PRD §7.2）。
 * 纯服务器组件，动画由 CSS 类驱动，不需要 'use client'。
 */
export function Hero() {
  return (
    <section
      aria-label="产品介绍"
      className="relative z-20 flex min-h-[34rem] items-center pt-32 pb-20 sm:min-h-[38rem] lg:min-h-[min(52rem,100svh)] lg:pt-36 lg:pb-24"
    >
      {/* Aurora 背景 blobs */}
      <div className="aurora-layer" aria-hidden>
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
      </div>
      {/* Grid 叠加 */}
      <div
        className="aurora-grid pointer-events-none absolute inset-0 z-0"
        aria-hidden
      />

      <div className="relative z-10 mx-auto w-full max-w-[1360px] px-6">
        {/*
          左右不再对半分。文案收窄、示意图放大到 1.15fr —— 首屏的说服力来自
          「看见产品长什么样」，不是来自多读两行字。
        */}
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          {/* 左侧文案 */}
          <div className="text-center lg:text-left">
            {/* 更新角标 */}
            <div className="animate-fade-up mb-8 inline-flex items-center gap-2">
              <Badge variant="glass">
                <span className="flex h-1.5 w-1.5 shrink-0">
                  <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-gsuccess opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-gsuccess" />
                </span>
                硅基员工 × 碳基团队
              </Badge>
            </div>

            <h1 className="animate-fade-up-d1 mb-8 text-[clamp(2.25rem,10vw,2.5rem)] font-bold leading-[1.12] tracking-[-0.03em] text-gtext-primary lg:text-[clamp(2.5rem,4.6vw,4.25rem)]">
              {/*
                渐变只落在「组织提效」四个字上。

                原来两行各自套 `gradient-text-glass inline-block`，于是同一条
                `#1f2937 → #ec4899 → #f97316` 的 ramp 各跑一遍：第一行 8 字盒子宽，
                「让公司从」还在深灰；第二行盒子窄，ramp 被压缩，「到」就已经是粉的了。
                两行同一横向位置颜色对不上，看起来像没对齐而不像刻意。

                现在整句用纯色，只把落点那个词染成品牌色 —— 一句话里只强调一处，
                对比反而更强，也不再有两条 ramp 对不齐的问题。
              */}
              让公司从个体提效
              <br />
              到
              <span className="gradient-text-accent">组织提效</span>
            </h1>

            {/*
              原来这里还有一个「查看任务演示」按钮，href="#demo" 指向右侧的
              mockup 容器 —— 而那个容器是 `hidden lg:block`：
                · 桌面端目标本来就在同一屏内，点了页面几乎不动，像坏了
                · 移动端目标 display:none，锚点跳转什么也不会发生
              两种尺寸下都是空按钮，删掉。真要放演示入口，得先有一个真的
              录屏或可交互 demo 页可跳。
            */}
            <div className="animate-fade-up-d3 flex flex-wrap items-start justify-center gap-3 lg:justify-start">
              <Link
                href="/marketplace"
                className="group inline-flex items-center gap-2 rounded-glass-pill bg-gbrand px-6 py-3 text-sm font-semibold text-white shadow-glass-md transition-all hover:bg-gbrand-hover hover:shadow-glass-lg"
              >
                浏览硅基人才市场
                <ArrowRight
                  className="h-4 w-4 transition-transform group-hover:translate-x-1"
                  aria-hidden
                />
              </Link>
              <HeroDownloadMenu />
            </div>

          </div>

          {/* 右侧 3D Mockup */}
          <div className="hero-mockup hidden lg:block">
            <DashboardMockup />
          </div>
        </div>
      </div>
    </section>
  );
}
