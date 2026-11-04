'use client';

import { useEffect, useRef, useState } from 'react';
import { Apple, Download, Monitor } from 'lucide-react';
import type { ClientArtifact, ClientPlatform } from '@/config/client-releases';
import { useClientRelease } from '@/config/use-client-release';

const PLATFORM_ICONS: Record<ClientPlatform, typeof Apple> = {
  'macos-arm64': Apple,
  'macos-x64': Apple,
  'windows-x64': Monitor,
};

function detectPlatform(): ClientPlatform {
  if (typeof navigator === 'undefined') return 'macos-arm64';
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('win')) return 'windows-x64';
  if (userAgent.includes('mac')) return 'macos-arm64';
  return 'windows-x64';
}

function artifactDescription(artifact: ClientArtifact) {
  return `${artifact.minimumOsVersion} · ${artifact.architecture}`;
}

export function HeroDownloadMenu() {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<ClientPlatform>(() => detectPlatform());
  const { release, loading } = useClientRelease();
  const containerRef = useRef<HTMLDivElement>(null);
  const canHoverRef = useRef(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const updateHoverCapability = () => {
      canHoverRef.current = mediaQuery.matches && navigator.maxTouchPoints === 0;
    };

    updateHoverCapability();
    mediaQuery.addEventListener('change', updateHoverCapability);
    return () => mediaQuery.removeEventListener('change', updateHoverCapability);
  }, []);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="relative z-20"
      onPointerEnter={(event) => {
        if (canHoverRef.current && event.pointerType === 'mouse') setOpen(true);
      }}
      onPointerLeave={(event) => {
        const focusIsInside = containerRef.current?.contains(document.activeElement);
        if (canHoverRef.current && event.pointerType === 'mouse' && !focusIsInside) {
          setOpen(false);
        }
      }}
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => canHoverRef.current ? true : !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="group inline-flex min-h-12 items-center gap-2 rounded-glass-pill border border-gbrand/30 bg-glass-2 px-5 py-3 text-sm font-semibold text-gtext-primary backdrop-blur-glass-sm transition-all hover:border-gbrand/60 hover:bg-gbrand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gbrand-ring focus-visible:ring-offset-2 focus-visible:ring-offset-gbg-canvas"
      >
        <Download className="h-4 w-4 text-gbrand-text" aria-hidden />
        下载客户端
      </button>

      {open && (
        <div className="absolute left-0 top-full w-[min(25rem,calc(100vw-3rem))] pt-3">
        <div
          role="menu"
          aria-label="选择客户端版本"
          className="overflow-hidden rounded-glass-xl border border-glassline bg-gbg-raised p-2 text-left shadow-glass-xl backdrop-blur-glass-md"
        >
          <div className="px-3 pb-2 pt-2">
            <p className="text-sm font-semibold text-gtext-primary">选择客户端版本</p>
          </div>

          <div className="space-y-1">
            {release ? release.artifacts.map((artifact) => {
              const Icon = PLATFORM_ICONS[artifact.platform];
              const selected = artifact.platform === platform;
              const hasDownload = Boolean(artifact.url);

              return (
                <a
                  key={artifact.platform}
                  href={artifact.url ?? undefined}
                  download={artifact.url ? artifact.fileName : undefined}
                  role="menuitem"
                  aria-disabled={!hasDownload}
                  onMouseEnter={() => setPlatform(artifact.platform)}
                  onFocus={() => setPlatform(artifact.platform)}
                  onClick={(event) => {
                    if (!hasDownload) event.preventDefault();
                  }}
                  className={`flex items-center gap-3 rounded-glass-md px-3 py-3 transition-colors ${
                    selected ? 'bg-gbrand/10' : 'hover:bg-glass-2'
                  } ${hasDownload ? '' : 'cursor-not-allowed opacity-65'}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-glass-sm border border-glassline bg-glass-2 text-gbrand-text">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gtext-primary">{artifact.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-gtext-muted">{artifactDescription(artifact)}</span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-gbrand-text">
                    {hasDownload ? '下载' : '准备中'}
                  </span>
                </a>
              );
            }) : (
              <p role="status" className="px-3 py-4 text-sm text-gtext-muted">
                {loading ? '正在读取客户端版本…' : '客户端下载信息暂不可用'}
              </p>
            )}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
