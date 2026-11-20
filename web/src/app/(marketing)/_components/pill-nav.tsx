'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { ThemeLogo } from '@/components/ui/theme-logo';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '#features', label: '产品能力' },
  { href: '/marketplace', label: '元机AI人才市场' },
  { href: '#pricing', label: '定价' },
  { href: '#faq', label: '常见问题' },
] as const;

/**
 * 悬浮胶囊导航（PRD §7.1）。
 * 滚动超过 24px 后通过 data-scrolled 让 .glass-pill 换成更实的深色底，
 * 避免内容滚到导航下方时文字互相干扰。
 */
export function PillNav() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll(); // 处理刷新后停在页面中间的情况
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // 移动端菜单展开时锁滚动，收起时恢复
  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  return (
    <>
      <header className="fixed left-1/2 top-4 z-50 w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 sm:top-6">
        <nav
          aria-label="主导航"
          data-scrolled={scrolled}
          className="glass-pill flex items-center justify-between gap-4 px-4 py-2.5 sm:px-6"
        >
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-glass-sm"
          >
            <ThemeLogo width={28} height={28} />
            <span className="text-sm font-semibold text-gtext-primary">
              元机AI
            </span>
          </Link>

          {/* 桌面端链接 */}
          <ul className="hidden items-center gap-7 md:flex">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="text-sm text-gtext-secondary transition-colors hover:text-gtext-primary"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden shrink-0 items-center gap-2 md:flex">
            <Link
              href="/login"
              className="rounded-glass-sm px-3 py-1.5 text-sm text-gtext-secondary transition-colors hover:bg-glass-2 hover:text-gtext-primary"
            >
              登录
            </Link>
            <Link
              href="/register"
              className="rounded-glass-pill bg-gbrand px-4 py-1.5 text-sm font-medium text-white shadow-glass-sm transition-colors hover:bg-gbrand-hover"
            >
              免费试用
            </Link>
          </div>

          {/* 移动端汉堡 */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? '关闭菜单' : '打开菜单'}
            className="flex h-9 w-9 items-center justify-center rounded-glass-sm text-gtext-secondary transition-colors hover:bg-glass-2 hover:text-gtext-primary md:hidden"
          >
            {menuOpen ? (
              <X className="h-5 w-5" aria-hidden />
            ) : (
              <Menu className="h-5 w-5" aria-hidden />
            )}
          </button>
        </nav>

        {/* 移动端展开面板 */}
        <div
          id="mobile-nav"
          hidden={!menuOpen}
          className="glass-elevated mt-2 overflow-hidden p-2 md:hidden"
        >
          <ul className="flex flex-col">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-glass-sm px-4 py-3 text-sm text-gtext-secondary transition-colors hover:bg-glass-2 hover:text-gtext-primary"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2 border-t border-glassline pt-2">
            <Link
              href="/login"
              onClick={() => setMenuOpen(false)}
              className="flex-1 rounded-glass-sm px-4 py-2.5 text-center text-sm text-gtext-secondary transition-colors hover:bg-glass-2 hover:text-gtext-primary"
            >
              登录
            </Link>
            <Link
              href="/register"
              onClick={() => setMenuOpen(false)}
              className="flex-1 rounded-glass-pill bg-gbrand px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-gbrand-hover"
            >
              免费试用
            </Link>
          </div>
        </div>
      </header>

      {/* 移动端菜单遮罩 —— 点击空白收起 */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-gbg-deep/60 md:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden
        />
      )}
    </>
  );
}
