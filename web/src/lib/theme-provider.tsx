'use client';

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const themeListeners = new Set<() => void>();

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
}

function subscribeToTheme(onChange: () => void): () => void {
  themeListeners.add(onChange);
  window.addEventListener('storage', onChange);

  return () => {
    themeListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function setStoredTheme(theme: Theme) {
  localStorage.setItem('theme', theme);
  themeListeners.forEach((listener) => listener());
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // useSyncExternalStore 的 server snapshot 固定为 light，避免读取 localStorage
  // 导致 AuroraBackground 等依赖主题的组件发生 hydration mismatch。
  const theme = useSyncExternalStore(subscribeToTheme, getStoredTheme, () => 'light' as Theme);

  useEffect(() => {
    const root = document.documentElement;

    // dark 主题使用 theme-glass 类，light 主题移除该类
    if (theme === 'dark') {
      root.classList.add('theme-glass');
    } else {
      root.classList.remove('theme-glass');
    }
  }, [theme]);

  const toggleTheme = () => {
    setStoredTheme(theme === 'dark' ? 'light' : 'dark');
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
