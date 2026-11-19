import Link from "next/link";
import { ThemeLogo } from "@/components/ui/theme-logo";

const COLUMNS = [
  {
    title: "产品",
    links: [
      { label: "硅基人才市场", href: "/marketplace" },
      { label: "功能特性", href: "#features" },
      { label: "定价方案", href: "#pricing" },
      { label: "常见问题", href: "#faq" },
    ],
  },
  {
    title: "解决方案",
    links: [
      { label: "发现硅基员工", href: "#showcase" },
      { label: "完成企业订阅", href: "#pricing" },
      { label: "授权碳基成员", href: "#how" },
      { label: "开始团队协作", href: "/register" },
    ],
  },
  {
    title: "企业入口",
    links: [
      { label: "创建企业账号", href: "/register" },
      { label: "登录企业工作台", href: "/login" },
      { label: "浏览人才市场", href: "/marketplace" },
      { label: "查看使用流程", href: "#how" },
    ],
  },
  {
    title: "协作能力",
    links: [
      { label: "部门与成员授权", href: "#features" },
      { label: "企业知识库", href: "#features" },
      { label: "用量与执行记录", href: "#features" },
      { label: "余额与支付宝支付", href: "#faq" },
    ],
  },
] as const;

/** 页脚（PRD §7.10）。5 列布局：品牌 + 4 组导航。 */
export function SiteFooter() {
  return (
    <footer className="border-t border-glassline px-6 py-16">
      <div className="mx-auto max-w-7xl">
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:grid-cols-5">
          {/* 品牌列 */}
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <Link href="/" className="inline-flex items-center gap-2">
              <ThemeLogo width={32} height={32} />
              <span className="text-sm font-semibold text-gtext-primary">
                元机AI
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-gtext-muted">
              把 AI 能力包装成可招聘、可管理、可审计的硅基员工。
            </p>
          </div>

          {COLUMNS.map(({ title, links }) => (
            <nav key={title} aria-label={title}>
              <h2 className="mb-4 text-sm font-semibold text-gtext-primary">
                {title}
              </h2>
              <ul className="space-y-2.5">
                {links.map(({ label, href }) => (
                  <li key={label}>
                    <Link
                      href={href}
                      className="text-sm text-gtext-muted transition-colors hover:text-gtext-primary"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-14 flex flex-col-reverse items-center justify-between gap-4 border-t border-glassline pt-8 sm:flex-row">
          <p className="text-xs text-gtext-disabled">
            © {new Date().getFullYear()} 元机AI. All rights reserved.
          </p>
          <p className="text-xs text-gtext-muted">
            硅基员工与碳基团队的组织协作平台
          </p>
        </div>
      </div>
    </footer>
  );
}
