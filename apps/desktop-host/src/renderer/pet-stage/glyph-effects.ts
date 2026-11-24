/**
 * 工作跟随时读文件/搜索的代码符号飘字（T-M6-55）。
 *
 * 只在 reading / searching 类姿态出现时生成 3–5 个符号粒子；颜色取 `character.json.glyph`
 * 的 fill/stroke，文本取 glyph.text（缺省用通用代码符号）。省电模式由调用方直接不启用。
 * 纯函数（注入 rng）→ 可确定性单测。
 */
export interface GlyphConfig {
  fill?: string;
  stroke?: string;
  text?: string;
}

export interface GlyphParticle {
  symbol: string;
  /** 横向位置（舞台百分比 8–88） */
  leftPercent: number;
  /** 起始纵向偏移（px，舞台基准 260 高） */
  bottomPx: number;
  delayMs: number;
  durationMs: number;
  sizePx: number;
  rotateDeg: number;
}

export const DEFAULT_GLYPH_TEXT = '<>{}[]/;=+';
export const DEFAULT_GLYPH_FILL = '#8cc8ff';

/** reading / searching（含 CrossPet 的 read_file / web_search 变体）命中。 */
export function isReadingOrSearchingPose(pose: string): boolean {
  const value = pose.toLowerCase();
  return value.includes('reading') || value.includes('searching') || value.includes('read_file') || value.includes('web_search');
}

export function glyphColors(config: GlyphConfig | null | undefined): { fill: string; stroke: string } {
  const fill = (config?.fill ?? '').trim();
  const stroke = (config?.stroke ?? '').trim();
  return {
    fill: fill === '' ? DEFAULT_GLYPH_FILL : fill,
    stroke: stroke === '' ? 'rgba(8,14,24,0.65)' : stroke,
  };
}

export function glyphSymbols(config: GlyphConfig | null | undefined): string[] {
  const raw = (config?.text ?? '').trim();
  const tokens = raw.split(/[\s,，|]+/).map((token) => token.trim()).filter((token) => token !== '');
  if (tokens.length > 0) return tokens;
  return DEFAULT_GLYPH_TEXT.split('');
}

/** 生成 3–5 个缓慢上浮粒子（位置/延迟/时长都带抖动，避免整齐得像动画模板）。 */
export function glyphParticles(
  config: GlyphConfig | null | undefined,
  rng: () => number = Math.random,
  count?: number,
): GlyphParticle[] {
  const symbols = glyphSymbols(config);
  const total = Math.min(5, Math.max(3, Math.round(count ?? 3 + rng() * 2)));
  const picked: GlyphParticle[] = [];
  for (let index = 0; index < total; index += 1) {
    picked.push({
      symbol: symbols[Math.floor(rng() * symbols.length) % symbols.length]!,
      leftPercent: Math.round(10 + rng() * 76),
      bottomPx: Math.round(70 + rng() * 90),
      delayMs: Math.round(rng() * 900),
      durationMs: Math.round(2_600 + rng() * 1_400),
      sizePx: Math.round(12 + rng() * 8),
      rotateDeg: Math.round(-14 + rng() * 28),
    });
  }
  return picked;
}
