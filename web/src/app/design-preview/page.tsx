import type { Metadata } from 'next';
import { AuroraBackground } from '@/components/ui/aurora-background';
import { Phase1Demos } from './phase1-demos';

export const metadata: Metadata = {
  title: 'Design Preview · Glassmorphism 令牌总览',
  description: 'Phase 0 验收页：全部设计令牌与玻璃层级色卡',
};

/* ─────────────────────────────────────────────────────────────────────────────
   本页是 Phase 0 的验收页，不是产品页面。
   目的：把 globals.css 里全部 `--g*` / `--glass-*` / `--surface-*` 令牌渲染成
   可肉眼比对的色卡，确认层级从 glass-hero → glass-elevated 是单调递增的。
   任何令牌改动后都应该回到这个页面复查一遍。
   ───────────────────────────────────────────────────────────────────────────── */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-16">
      <h2 className="mb-1 text-xl font-semibold text-gtext-primary">{title}</h2>
      {hint && <p className="mb-5 text-sm text-gtext-muted">{hint}</p>}
      {!hint && <div className="mb-5" />}
      {children}
    </section>
  );
}

/** 纯色令牌色卡。value 直接写死一份用于标注，方便对照 globals.css。 */
function Swatch({
  varName,
  value,
  label,
  note,
}: {
  varName: string;
  value: string;
  label: string;
  note?: string;
}) {
  return (
    <div className="glass-card p-3">
      <div
        className="mb-3 h-16 w-full rounded-glass-sm border border-glassline"
        style={{ background: `var(${varName})` }}
      />
      <div className="text-sm font-medium text-gtext-primary">{label}</div>
      <code className="mt-0.5 block font-mono text-[11px] text-gtext-muted">
        {varName}
      </code>
      <code className="block font-mono text-[11px] text-gtext-muted">{value}</code>
      {note && <div className="mt-1 text-[11px] text-gbrand-text">{note}</div>}
    </div>
  );
}

export default function DesignPreviewPage() {
  return (
    <AuroraBackground grid className="min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-16">
        {/* ── 页头 ───────────────────────────────────────────────────────── */}
        <header className="mb-16">
          <div className="glass-pill mb-6 inline-flex items-center gap-2 px-4 py-1.5 text-xs text-gtext-secondary">
            <span className="h-1.5 w-1.5 rounded-full bg-gbrand" />
            Phase 0 · 设计令牌验收
          </div>
          <h1 className="mb-3 text-4xl font-bold tracking-tight">
            <span className="gradient-text-glass">Glassmorphism 令牌总览</span>
          </h1>
          <p className="max-w-2xl text-gtext-secondary">
            全部令牌定义在 <code className="font-mono text-gbrand-text">globals.css</code> 的{' '}
            <code className="font-mono text-gbrand-text">.theme-glass</code> 作用域内，
            不污染 <code className="font-mono text-gbrand-text">:root</code>。
            浅色主题的 20+ 页面不受影响。
          </p>
        </header>

        {/* ── 1. 画布底色 ────────────────────────────────────────────────── */}
        <Section
          title="1 · 画布底色"
          hint="深蓝紫画布，为冷色 blob 提供纵深。三级用于页面外层 / 标准画布 / 抬升区。"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Swatch varName="--gbg-deep" value="#0a0a1a" label="Deep · 最外层" />
            <Swatch varName="--gbg-canvas" value="#0f0f2d" label="Canvas · 标准画布" />
            <Swatch varName="--gbg-raised" value="#13132e" label="Raised · 抬升区" />
          </div>
        </Section>

        {/* ── 2. 品牌色 ──────────────────────────────────────────────────── */}
        <Section
          title="2 · 品牌色（Indigo 系）"
          hint="关键约束：填充与文字必须取不同值。白字压在 #4f46e5 上是 6.29:1 达 AA；但 #4f46e5 当文字压在画布上只有 2.96:1，不合规 —— 文字/链接一律用 #818cf8（6.25:1）。"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Swatch
              varName="--gbrand"
              value="#4f46e5"
              label="Brand · 仅填充"
              note="白字 6.29:1 · AA"
            />
            <Swatch
              varName="--gbrand-text"
              value="#818cf8"
              label="Brand Text · 文字/链接"
              note="on canvas 6.25:1 · AA"
            />
            <Swatch varName="--gbrand-hover" value="#5850ec" label="Brand Hover · 填充" note="白字 5.56:1 · AA" />
            <Swatch varName="--gbrand-text-hover" value="#a5b4fc" label="Text Hover" note="9.35:1 · AAA" />
            <Swatch
              varName="--gbrand-subtle"
              value="rgba(129,140,248,.14)"
              label="Brand Subtle · 底纹"
            />
          </div>

          {/* 对比度实测对照：同一段文字，两种品牌色 */}
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="surface-solid p-5">
              <div className="mb-2 text-xs text-gtext-muted">
                ✅ 正确：文字用 --gbrand-text
              </div>
              <p style={{ color: 'var(--gbrand-text)' }} className="text-base">
                订阅硅基员工，调度硅基能力
              </p>
            </div>
            <div className="surface-solid p-5">
              <div className="mb-2 text-xs text-gtext-muted">
                ❌ 错误：文字用 --gbrand（2.96:1，不达 AA）
              </div>
              <p style={{ color: 'var(--gbrand)' }} className="text-base">
                订阅硅基员工，调度硅基能力
              </p>
            </div>
          </div>
        </Section>

        {/* ── 3. 装饰球 ──────────────────────────────────────────────────── */}
        <Section
          title="3 · 背景装饰球（Blob）"
          hint="冷色系紫 → 蓝 → 青三段分级。当前页面已启用前 3 枚（性能上限）。"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Swatch varName="--blob-violet" value="#7c3aed" label="Violet · 主" note="已启用" />
            <Swatch varName="--blob-blue" value="#2563eb" label="Blue · 次" note="已启用" />
            <Swatch varName="--blob-cyan" value="#0891b2" label="Cyan · 点缀" note="已启用" />
            <Swatch varName="--blob-indigo" value="#4f46e5" label="Indigo · 备用" />
            <Swatch varName="--blob-pink" value="#db2777" label="Pink · 纵深" />
          </div>
        </Section>

        {/* ── 4. 玻璃层级（核心验收项）───────────────────────────────────── */}
        <Section
          title="4 · 玻璃层级（核心验收项）"
          hint="从上到下透明度递增、blur 递增、阴影递增。肉眼应能明确区分 5 级 —— 若两张卡看起来一样，就是令牌没拉开。"
        >
          <div className="space-y-4">
            <div className="glass-hero p-6">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <span className="text-base font-semibold text-gtext-primary">
                  .glass-hero
                </span>
                <code className="font-mono text-xs text-gtext-muted">
                  glass-1 (5%) · blur 28px · shadow-xl · radius 32px
                </code>
              </div>
              <p className="text-sm text-gtext-secondary">
                Hero 展示级，最通透。整屏最多出现一次。
              </p>
            </div>

            <div className="glass-card glass-card-interactive p-6">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <span className="text-base font-semibold text-gtext-primary">
                  .glass-card
                </span>
                <code className="font-mono text-xs text-gtext-muted">
                  glass-2 (8%) · blur 16px · shadow-md · radius 16px
                </code>
              </div>
              <p className="text-sm text-gtext-secondary">
                标准卡片。加 <code className="font-mono">.glass-card-interactive</code>{' '}
                获得 hover 上浮 —— 把鼠标移上来看看。
              </p>
            </div>

            <div className="glass-elevated p-6">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <span className="text-base font-semibold text-gtext-primary">
                  .glass-elevated
                </span>
                <code className="font-mono text-xs text-gtext-muted">
                  glass-4 (16%) · blur 24px · shadow-lg · radius 24px
                </code>
              </div>
              <p className="text-sm text-gtext-secondary">
                Modal / 抽屉。最不透明，因为它要压住下面的全部内容。
              </p>
            </div>

            <div className="glass-accent p-6">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <span className="text-base font-semibold text-gtext-primary">
                  .glass-accent
                </span>
                <code className="font-mono text-xs text-gtext-muted">
                  glass-accent-2 · 品牌描边 · blur 16px
                </code>
              </div>
              <p className="text-sm text-gtext-secondary">
                冷调品牌卡，用于强调区块（定价推荐位、CTA）。
              </p>
            </div>

            <div className="glass-nav rounded-glass-lg p-6">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <span className="text-base font-semibold text-gtext-primary">
                  .glass-nav
                </span>
                <code className="font-mono text-xs text-gtext-muted">
                  glass-2 · blur 20px · 仅右描边
                </code>
              </div>
              <p className="text-sm text-gtext-secondary">
                侧栏 / 顶栏。默认只有 border-right，此处补了圆角便于展示。
              </p>
            </div>
          </div>
        </Section>

        {/* ── 5. 三种表面的取舍（性能红线）──────────────────────────────── */}
        <Section
          title="5 · 三种表面的取舍（性能红线）"
          hint="backdrop-filter 在滚动容器里每帧重算，必掉帧。列表 >20 行、表格、长表单一律不许用真玻璃。"
        >
          <div className="grid gap-4 md:grid-cols-3">
            <div className="glass-card p-5">
              <div className="mb-2 text-sm font-semibold text-gtext-primary">
                .glass-card
              </div>
              <div className="mb-3 text-xs text-gtext-muted">真 backdrop-filter</div>
              <p className="text-sm text-gtext-secondary">
                ✅ 卡片、导航、Modal
                <br />
                ❌ 滚动容器内、长列表
              </p>
              <div className="mt-3 text-[11px] text-gwarning">GPU 成本：高</div>
            </div>

            <div className="fake-glass p-5">
              <div className="mb-2 text-sm font-semibold text-gtext-primary">
                .fake-glass
              </div>
              <div className="mb-3 text-xs text-gtext-muted">纯渐变，无 blur</div>
              <p className="text-sm text-gtext-secondary">
                ✅ 聊天气泡、列表项
                <br />
                视觉接近，肉眼几乎难分
              </p>
              <div className="mt-3 text-[11px] text-gsuccess">GPU 成本：零</div>
            </div>

            <div className="surface-solid p-5">
              <div className="mb-2 text-sm font-semibold text-gtext-primary">
                .surface-solid
              </div>
              <div className="mb-3 text-xs text-gtext-muted">完全实心</div>
              <p className="text-sm text-gtext-secondary">
                ✅ 表格、长表单
                <br />
                文字对比度最可控
              </p>
              <div className="mt-3 text-[11px] text-gsuccess">GPU 成本：零</div>
            </div>
          </div>

          {/* 实心表面行 hover 演示 */}
          <div className="surface-solid mt-4 overflow-hidden">
            <div className="border-b border-solid-border px-5 py-3 text-xs font-medium text-gtext-muted">
              .surface-solid-row · hover 演示（表格行的正确做法）
            </div>
            {['数据分析专员', '合同审核专员', '财务对账专员'].map((name) => (
              <div
                key={name}
                className="surface-solid-row flex items-center justify-between border-b border-solid-border px-5 py-3 text-sm transition-colors last:border-b-0"
              >
                <span className="text-gtext-primary">{name}</span>
                <span className="text-gtext-muted">工作中</span>
              </div>
            ))}
          </div>
        </Section>

        {/* ── 6. Blur 阶 ─────────────────────────────────────────────────── */}
        <Section
          title="6 · Blur 阶"
          hint="28px 是性能上限，不要新增更大的值。每张卡都真实应用了对应的 backdrop-filter。"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {[
              { name: 'xs', v: '12px', use: 'Tooltip' },
              { name: 'sm', v: '16px', use: '标准卡片' },
              { name: 'md', v: '20px', use: '导航 / hover' },
              { name: 'lg', v: '24px', use: 'Modal' },
              { name: 'xl', v: '28px', use: 'Hero · 上限' },
            ].map((b) => (
              <div
                key={b.name}
                className="rounded-glass-md border border-glassline p-4"
                style={{
                  background: 'var(--glass-2)',
                  backdropFilter: `blur(${b.v}) saturate(160%)`,
                  WebkitBackdropFilter: `blur(${b.v}) saturate(160%)`,
                }}
              >
                <div className="text-sm font-medium text-gtext-primary">{b.name}</div>
                <code className="block font-mono text-[11px] text-gtext-muted">
                  {b.v}
                </code>
                <div className="mt-1 text-[11px] text-gtext-muted">{b.use}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── 7. 圆角 / 阴影 ─────────────────────────────────────────────── */}
        <Section title="7 · 圆角与阴影">
          <div className="mb-4 grid grid-cols-3 gap-4 md:grid-cols-6">
            {[
              { n: 'sm', v: '8px' },
              { n: 'md', v: '12px' },
              { n: 'lg', v: '16px' },
              { n: 'xl', v: '24px' },
              { n: '2xl', v: '32px' },
              { n: '3xl', v: '40px' },
            ].map((r) => (
              <div key={r.n} className="text-center">
                <div
                  className="mb-2 h-20 w-full border border-glassline bg-glass-2"
                  style={{ borderRadius: `var(--gradius-${r.n})` }}
                />
                <div className="text-xs text-gtext-primary">{r.n}</div>
                <code className="font-mono text-[11px] text-gtext-muted">{r.v}</code>
              </div>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            {(['sm', 'md', 'lg', 'xl'] as const).map((s) => (
              <div
                key={s}
                className="rounded-glass-lg border border-glassline bg-solid p-5"
                style={{ boxShadow: `var(--glass-shadow-${s})` }}
              >
                <div className="text-sm text-gtext-primary">shadow-{s}</div>
                <div className="mt-1 text-[11px] text-gtext-muted">
                  {s === 'sm' ? '无 inset' : '含内高光 inset'}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── 8. 文字层级 ────────────────────────────────────────────────── */}
        <Section
          title="8 · 文字层级"
          hint="四级白色不透明度。disabled 级别刻意不达 AA —— 它只用于禁用态，不承载信息。"
        >
          <div className="surface-solid space-y-3 p-6">
            <p className="text-lg text-gtext-primary">
              Primary 95% · 标题与正文主体
            </p>
            <p className="text-base text-gtext-secondary">
              Secondary 72% · 描述文字、副标题
            </p>
            <p className="text-sm text-gtext-muted">
              Muted 48% · 元信息、时间戳、辅助说明
            </p>
            <p className="text-sm text-gtext-disabled">
              Disabled 26% · 禁用态，不承载信息
            </p>
          </div>
        </Section>

        {/* ── 9. 语义色 ──────────────────────────────────────────────────── */}
        <Section
          title="9 · 语义色（深底调校版）"
          hint="浅色主题的语义色在深底上会发闷，这里整体提亮一档。"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Swatch varName="--gsuccess" value="#34d399" label="Success" />
            <Swatch varName="--gwarning" value="#fbbf24" label="Warning" />
            <Swatch varName="--gdanger" value="#f87171" label="Danger" />
            <Swatch varName="--ginfo" value="#60a5fa" label="Info" />
          </div>
        </Section>

        {/* ── 10. 渐变与光效 ─────────────────────────────────────────────── */}
        <Section title="10 · 渐变与光效">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="glass-card p-6">
              <div className="mb-3 text-sm text-gtext-muted">.gradient-text-glass</div>
              <div className="gradient-text-glass text-3xl font-bold">
                元机AI
              </div>
            </div>

            <div className="glass-card gradient-border rounded-glass-lg p-6">
              <div className="mb-3 text-sm text-gtext-muted">.gradient-border</div>
              <p className="text-sm text-gtext-secondary">
                mask-composite 双层遮罩，只保留 1px 边缘渐变。用于定价推荐卡。
              </p>
            </div>

            <div className="glass-card glow-brand p-6">
              <div className="mb-3 text-sm text-gtext-muted">.glow-brand</div>
              <p className="text-sm text-gtext-secondary">品牌辉光，用于主 CTA。</p>
            </div>

            <div className="glass-card glow-success p-6">
              <div className="mb-3 text-sm text-gtext-muted">.glow-success</div>
              <p className="text-sm text-gtext-secondary">成功态辉光，用于任务完成。</p>
            </div>

            <div
              className="rounded-glass-lg p-6 md:col-span-2"
              style={{ background: 'var(--ggradient-brand)' }}
            >
              <div className="text-sm font-medium text-white/80">
                --ggradient-brand
              </div>
              <code className="font-mono text-xs text-white/60">
                135deg · #818cf8 → #a78bfa → #22d3ee
              </code>
            </div>

            <div
              className="rounded-glass-lg p-6 md:col-span-2"
              style={{ background: 'var(--ggradient-accent)' }}
            >
              <div className="text-sm font-medium text-white/80">--ggradient-accent</div>
              <code className="font-mono text-xs text-white/60">
                135deg · #7c3aed → #db2777
              </code>
            </div>
          </div>
        </Section>

        {/* ── 11. 降级与偏好 ─────────────────────────────────────────────── */}
        <Section
          title="11 · 降级与无障碍偏好"
          hint="这些行为无法在页面上直接看到，需要在系统设置里切换后回来复查。"
        >
          <div className="surface-solid divide-y divide-solid-border">
            {[
              {
                q: '@supports (backdrop-filter)',
                a: '不支持时（Firefox <103）回落到 92%~96% 不透明实心背景，不出现半透明白块。',
              },
              {
                q: 'prefers-reduced-motion: reduce',
                a: 'blob 动画停在初始位置，全部过渡压到 0.01ms。',
              },
              {
                q: 'prefers-contrast: more',
                a: '描边提亮、玻璃填充加重，文字提到接近纯白。',
              },
              {
                q: 'prefers-reduced-transparency: reduce',
                a: '全部玻璃退化为实心表面，backdrop-filter 关闭。',
              },
              {
                q: 'max-width: 768px',
                a: '移动端 blur 半径整体下调一档（20px → 16px 等），减少移动 GPU 压力。',
              },
            ].map((row) => (
              <div key={row.q} className="px-5 py-4">
                <code className="font-mono text-xs text-gbrand-text">{row.q}</code>
                <p className="mt-1 text-sm text-gtext-secondary">{row.a}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Phase 1：原子组件玻璃化验收 ─────────────────────────────────── */}
        <Section
          title="12 · Phase 1 原子组件"
          hint="Shadcn 组件的玻璃形态。API 不变，通过 variant / glass prop 选择性开启，现有浅色页面不受影响。"
        >
          <Phase1Demos />
        </Section>

        <footer className="border-t border-glassline pt-8 text-sm text-gtext-muted">
          令牌定义：
          <code className="font-mono text-gbrand-text">web/src/app/globals.css</code>
          {' · '}
          Tailwind 映射：
          <code className="font-mono text-gbrand-text">web/tailwind.config.ts</code>
          {' · '}
          设计规格：
          <code className="font-mono text-gbrand-text">docs/plans/PRD-frontend.md</code>
        </footer>
      </div>
    </AuroraBackground>
  );
}
