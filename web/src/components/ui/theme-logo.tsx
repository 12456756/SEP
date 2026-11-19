import Image from 'next/image';
import { cn } from '@/lib/utils';

interface ThemeLogoProps {
  width?: number;
  height?: number;
  className?: string;
  priority?: boolean;
}

/**
 * 平台品牌 Logo。
 *
 * Logo 使用元机AI 蓝绿品牌资产，不随页面明暗主题切换，保证首页、登录页
 * 以及各个工作台中的品牌识别保持一致。
 */
export function ThemeLogo({
  width = 28,
  height = 28,
  className,
  priority = false,
}: ThemeLogoProps) {
  return (
    <span
      className={cn('relative block shrink-0 overflow-hidden rounded', className)}
      style={{ width, height }}
      aria-hidden="true"
    >
      <Image
        src="/yuanji-A-icon.svg"
        alt=""
        width={width}
        height={height}
        className="absolute inset-0 h-full w-full object-contain"
        priority={priority}
        unoptimized
      />
    </span>
  );
}
