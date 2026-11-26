/**
 * Tidepaper 空状态插画（Codex @illustrations 产出）。
 * 明暗两套 WebP 同时渲染，由 `:root.dark` 切换显示；尺寸用 max-width 控制，不抢正文。
 */
export type IllustrationName = 'empty-chat' | 'empty-memory' | 'game-offline' | 'live-offline' | 'halted';

export interface EmptyIllustrationProps {
  name: IllustrationName;
  alt: string;
  /** 最大显示宽度（px），高度按 4:3 自适应 */
  width?: number;
  className?: string;
}

const BASE = '../illustrations';

export function EmptyIllustration({ name, alt, width = 240, className }: EmptyIllustrationProps): React.JSX.Element {
  return (
    <span className={`wb-ill${className === undefined ? '' : ` ${className}`}`} style={{ maxWidth: width }}>
      <img className="wb-ill-light" src={`${BASE}/${name}-light.webp`} alt={alt} loading="lazy" draggable={false} />
      <img className="wb-ill-dark" src={`${BASE}/${name}-dark.webp`} alt={alt} loading="lazy" draggable={false} />
    </span>
  );
}
