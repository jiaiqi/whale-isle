/**
 * 姿势动效 SVG（T-M6-48，思路参考 CrossPet `app/web/effects.js`，原创 TS 实现）。
 *
 * CrossPet 用 CSS/SVG 在角色周围飘心/冒蒸汽/闪星星；这里改成纯函数返回 SVG 片段，
 * 由 pet-stage 渲染层挂到桌宠头顶（`data-pose-effect`），随动作切换自动替换/清理。
 * 无外部依赖、无动画定时器（动画交给 CSS keyframes），可单测断言产出结构。
 */
export type PoseEffectKind = 'heart' | 'steam' | 'sparkle' | 'note' | 'zzz' | 'anger' | 'bubbles' | 'celebrate' | 'victory' | 'priceDown' | 'priceUp';

const GLYPHS: Record<PoseEffectKind, string> = {
  heart: '<path d="M12 21s-7.5-4.6-9.4-9A5.2 5.2 0 0 1 12 6.7 5.2 5.2 0 0 1 21.4 12C19.5 16.4 12 21 12 21Z" fill="#ff5d8f"/>',
  steam: '<path d="M8 16c-2.2-1.5-2.6-4.4-1-6.2M12 15c-2.4-2-1.8-5.6.6-7M16 16c2.2-1.5 2.6-4.4 1-6.2" stroke="#c9d6e4" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  sparkle: '<path d="M12 2.8 14 9l6.2 2-6.2 2-2 6.2-2-6.2L4 11l6-2 2-6.2Z" fill="#ffd166"/>',
  note: '<path d="M9 18V8l8-2v10" stroke="#8ecaff" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="7.2" cy="18.2" r="2.2" fill="#8ecaff"/><circle cx="15.2" cy="16.2" r="2.2" fill="#8ecaff"/>',
  zzz: '<path d="M5 9h4l-4 5h4M13 6h4l-4 5h4M11 15h3l-3 4h3" stroke="#b39ddb" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  anger: '<path d="M8 7c1.6 1 2.4 2 3 3.4M16 7c-1.6 1-2.4 2-3 3.4M9 17c2-1.2 4-1.2 6 0" stroke="#ff6b6b" stroke-width="2" fill="none" stroke-linecap="round"/>',
  bubbles: '<circle cx="8" cy="15" r="3.4" fill="none" stroke="#8ecaff" stroke-width="1.5"/><circle cx="15" cy="10" r="2.3" fill="none" stroke="#8ecaff" stroke-width="1.4"/><circle cx="18" cy="16" r="1.5" fill="#8ecaff" opacity=".7"/>',
  celebrate: '<path d="M5 20 9 8l10 3-6 9H5Z" fill="#ffd166" opacity=".85"/><path d="M15 4v3M19 6l-2 2M21 11l-3-1M4 7l2 2M2 12l3-1" stroke="#ff8fab" stroke-width="1.7" stroke-linecap="round"/>',
  victory: '<path d="M8 4h8v4a4 4 0 0 1-8 0V4Z" fill="#ffd166"/><path d="M8 5H5v2a3 3 0 0 0 3 3M16 5h3v2a3 3 0 0 1-3 3M12 12v4M9 20h6M10 16h4v4h-4z" stroke="#ffd166" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  priceDown: '<path d="M12 4v11M8 11l4 4 4-4" stroke="#34c759" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="20" r="2" fill="#34c759"/>',
  priceUp: '<path d="M12 20V9M8 13l4-4 4 4" stroke="#ff453a" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="4" r="2" fill="#ff453a"/>',
};

/** CrossPet `character.json.fx` 的具名动效 → 内置 SVG 动效；未识别返回 null（不画空壳）。 */
const EFFECT_ALIASES: Record<string, PoseEffectKind> = {
  heart: 'heart', steam: 'steam', sparkle: 'sparkle', note: 'note', zzz: 'zzz', anger: 'anger',
  bubble: 'bubbles', bubbles: 'bubbles',
  celebrate: 'celebrate', confetti: 'celebrate',
  victory: 'victory', win: 'victory',
  pricedown: 'priceDown', 'price-down': 'priceDown',
  priceup: 'priceUp', 'price-up': 'priceUp',
};

export function normalizePoseEffect(kind: string): PoseEffectKind | null {
  const key = kind.trim().toLowerCase();
  return EFFECT_ALIASES[key] ?? null;
}

/** 合并默认动效与角色自定义 fx（只接受可渲染的具名动效，脏数据不影响默认表现）。 */
export function mergePoseEffects(base: Record<string, string>, fx: Record<string, string> | undefined): Record<string, string> {
  const merged = { ...base };
  for (const [pose, raw] of Object.entries(fx ?? {})) {
    const kind = normalizePoseEffect(raw);
    if (kind !== null) merged[pose] = kind;
  }
  return merged;
}

export function poseEffectSvg(kind: PoseEffectKind): string {
  return `<svg data-pose-effect="${kind}" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">${GLYPHS[kind]}</svg>`;
}

/** 动效在头顶的水平错位（避免多张动效完全重叠）。 */
export function poseEffectOffsets(kind: PoseEffectKind): Array<{ dx: number; dy: number; delayMs: number }> {
  switch (kind) {
    case 'heart':
      return [{ dx: -18, dy: 0, delayMs: 0 }, { dx: 4, dy: -10, delayMs: 180 }, { dx: 20, dy: 4, delayMs: 360 }];
    case 'steam':
      return [{ dx: -14, dy: 2, delayMs: 0 }, { dx: 12, dy: -4, delayMs: 220 }];
    case 'sparkle':
    case 'celebrate':
    case 'victory':
    case 'priceDown':
    case 'priceUp':
      return [{ dx: -20, dy: -4, delayMs: 0 }, { dx: 0, dy: -14, delayMs: 120 }, { dx: 18, dy: -2, delayMs: 260 }];
    case 'bubbles':
      return [{ dx: -16, dy: -2, delayMs: 0 }, { dx: 2, dy: -12, delayMs: 260 }, { dx: 18, dy: 2, delayMs: 520 }];
    case 'zzz':
      return [{ dx: 6, dy: -6, delayMs: 0 }, { dx: 18, dy: -18, delayMs: 420 }, { dx: 30, dy: -30, delayMs: 840 }];
    default:
      return [{ dx: 0, dy: -6, delayMs: 0 }];
  }
}
