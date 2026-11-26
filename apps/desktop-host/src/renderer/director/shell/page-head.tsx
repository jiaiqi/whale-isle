/**
 * 统一页头（Tidepaper v3.1）：eyebrow / 衬线 h1 / 描述 / 右侧 actions / 可选 meta 芯片行。
 * 页面容器使用 `.wb-page` 保持 1440 最大宽度与 26/28 的内边距节奏。
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface PageHeadProps {
  eyebrow: string;
  eyebrowIcon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
  /** 去掉底部外边距（用于自带 padding 的页内页头） */
  compact?: boolean;
}

export function PageHead({
  eyebrow,
  eyebrowIcon: EyebrowIcon,
  title,
  description,
  actions,
  meta,
  className,
  compact = false,
}: PageHeadProps): React.JSX.Element {
  return (
    <header className={`page-head${compact ? ' page-head-compact' : ''}${className === undefined ? '' : ` ${className}`}`}>
      <div className="t">
        <div className="eyebrow">
          {EyebrowIcon !== undefined && <EyebrowIcon size={11} />}
          <span>{eyebrow}</span>
        </div>
        <h1>{title}</h1>
        {description !== undefined && <p>{description}</p>}
        {meta !== undefined && <div className="meta">{meta}</div>}
      </div>
      {actions !== undefined && <div className="actions">{actions}</div>}
    </header>
  );
}

export function PageShell({ children, wide = false }: { children: ReactNode; wide?: boolean }): React.JSX.Element {
  return <div className={`wb-page${wide ? ' wide' : ''}`}>{children}</div>;
}
