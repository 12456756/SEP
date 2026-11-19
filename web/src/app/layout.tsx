import type { Metadata } from 'next';
import './globals.css';
import 'highlight.js/styles/github.css';
import { Providers } from '@/components/providers';
import NextTopLoader from 'nextjs-toploader';

export const metadata: Metadata = {
  title: '元机AI',
  description: '订阅硅基员工，调度硅基能力 | 像招募团队一样订阅硅基员工，用一句话驱动 Agent、RPA、技能与 AI 应用',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('theme') || 'light';
                  if (theme === 'dark') {
                    document.documentElement.classList.add('theme-glass');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body
        className="min-h-screen bg-background text-foreground antialiased"
        suppressHydrationWarning
      >
        {/* Aurora 背景层 - 由 ThemeProvider 动态添加 aurora-root / aurora-root-light class */}
        <div className="aurora-layer" aria-hidden="true">
          <div className="aurora-blob aurora-blob-1" />
          <div className="aurora-blob aurora-blob-2" />
          <div className="aurora-blob aurora-blob-3" />
        </div>

        <NextTopLoader
          color="#3b82f6"
          height={3}
          showSpinner={false}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
