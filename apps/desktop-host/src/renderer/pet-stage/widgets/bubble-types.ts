/**
 * 桌宠气泡语义类型、数据驱动情绪变体表、随包字体注册表与自适应尺寸纯函数（零 DOM）。
 * 与 Q 版像素蓝鲸女仆 × Tidepaper 潮汐纸视觉体系对齐，禁止使用彩色 Emoji 图标。
 */
import type { PetBubbleFontId, PetBubbleKind, PetBubbleMood } from '@workbench/shared-protocol';

export type BubbleKind = PetBubbleKind;
export type BubbleMood = PetBubbleMood;
export type BubbleFontId = PetBubbleFontId;
export type BubbleTailKind = 'pointer' | 'cloud' | 'sharp' | 'soft' | 'none';

export const ALL_BUBBLE_KINDS: readonly BubbleKind[] = [
  'thought',
  'dialog',
  'status',
  'notice',
  'reaction',
  'hint',
  'legacy',
] as const;

export const ALL_BUBBLE_MOODS: readonly BubbleMood[] = [
  'happy',
  'angry',
  'sleepy',
  'surprised',
  'thinking',
  'coquettish',
  'shy',
] as const;

export const ALL_BUBBLE_FONT_IDS: readonly BubbleFontId[] = [
  'shangshou-gummy',
  'handwriting',
  'rounded',
  'formal',
] as const;

export interface BubbleVisualTheme {
  kind: BubbleKind;
  label: string;
  priority: number;
  defaultTtlMs: number;
  tailKind: BubbleTailKind;
  fontSizePx: number;
  lineHeight: number;
  paddingX: number;
  paddingY: number;
  maxLines: number;
  radiusPx: number;
  fillStart: string;
  fillEnd: string;
  strokeColor: string;
  strokeWidth: number;
  strokeDasharray?: string;
  borderLeftAccentColor?: string;
  color: string;
  dropShadow: string;
  fontWeight?: number;
  tabularNums?: boolean;
  backdropFilter?: string;
  animationName: string;
  iconSvg: string;
}

export interface BubbleMoodTheme {
  mood: BubbleMood;
  label: string;
  tailKind: BubbleTailKind;
  fillStart: string;
  fillEnd: string;
  strokeColor: string;
  strokeWidth: number;
  strokeDasharray?: string;
  color: string;
  dropShadow: string;
  fontWeight?: number;
  animationName: string;
  iconSvg: string;
}

export interface ResolvedBubbleStyle extends BubbleVisualTheme {
  mood?: BubbleMood;
  moodLabel?: string;
}

export interface BubbleFontDefinition {
  id: BubbleFontId;
  category: 'default' | 'handwriting' | 'rounded' | 'formal';
  label: string;
  family: string;
  fileUrl: string;
  format: 'truetype' | 'woff2';
  fallbackStack: string;
  license: string;
  source: string;
}

const THEMES: Record<BubbleKind, BubbleVisualTheme> = {
  reaction: {
    kind: 'reaction',
    label: '即时反应',
    priority: 7,
    defaultTtlMs: 6_000,
    tailKind: 'sharp',
    fontSizePx: 13,
    lineHeight: 1.42,
    paddingX: 11,
    paddingY: 7,
    maxLines: 4,
    radiusPx: 14,
    fillStart: 'rgba(255,248,244,0.97)',
    fillEnd: 'rgba(255,234,224,0.96)',
    strokeColor: '#eb6b4b',
    strokeWidth: 2,
    color: '#381a14',
    dropShadow: 'drop-shadow(2px 3px 0px rgba(235,107,75,0.34)) drop-shadow(0px 4px 10px rgba(40,14,10,0.22))',
    fontWeight: 600,
    animationName: 'whaleBubbleBurst',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="#eb6b4b" aria-hidden="true"><path d="M8 1l1.7 4.3L14 7l-4.3 1.7L8 13l-1.7-4.3L2 7l4.3-1.7Z"/></svg>',
  },
  dialog: {
    kind: 'dialog',
    label: '正式对话',
    priority: 6,
    defaultTtlMs: 10_000,
    tailKind: 'pointer',
    fontSizePx: 13.5,
    lineHeight: 1.48,
    paddingX: 13,
    paddingY: 9,
    maxLines: 6,
    radiusPx: 16,
    fillStart: 'rgba(248,252,255,0.96)',
    fillEnd: 'rgba(232,244,255,0.94)',
    strokeColor: 'rgba(56,138,224,0.82)',
    strokeWidth: 1.6,
    color: '#152842',
    dropShadow: 'drop-shadow(0px 5px 14px rgba(15,38,68,0.24))',
    backdropFilter: 'blur(8px)',
    animationName: 'whaleBubblePop',
    iconSvg: '',
  },
  legacy: {
    kind: 'legacy',
    label: '经典蓝玻',
    priority: 5,
    defaultTtlMs: 10_000,
    tailKind: 'pointer',
    fontSizePx: 13,
    lineHeight: 1.55,
    paddingX: 12,
    paddingY: 9,
    maxLines: 4,
    radiusPx: 16,
    fillStart: 'rgba(20,56,104,0.74)',
    fillEnd: 'rgba(13,35,68,0.80)',
    strokeColor: 'rgba(56,162,255,0.80)',
    strokeWidth: 1.5,
    color: '#eff7ff',
    dropShadow: 'drop-shadow(0px 6px 16px rgba(4,16,38,0.44))',
    backdropFilter: 'blur(12px) saturate(1.4)',
    animationName: 'whaleBubblePop',
    iconSvg: '',
  },
  notice: {
    kind: 'notice',
    label: '系统通知',
    priority: 4,
    defaultTtlMs: 8_000,
    tailKind: 'none',
    fontSizePx: 12.5,
    lineHeight: 1.45,
    paddingX: 12,
    paddingY: 7,
    maxLines: 4,
    radiusPx: 12,
    fillStart: 'rgba(24,34,54,0.93)',
    fillEnd: 'rgba(18,26,42,0.91)',
    strokeColor: 'rgba(255,204,112,0.65)',
    strokeWidth: 1.2,
    borderLeftAccentColor: '#ffc857',
    color: '#fff4dd',
    dropShadow: 'drop-shadow(0px 5px 14px rgba(8,14,28,0.36))',
    backdropFilter: 'blur(10px)',
    animationName: 'whaleBubblePop',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#ffc857" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2a3.5 3.5 0 0 0-3.5 3.5v2.7L3 10.5h10l-1.5-2.3V5.5A3.5 3.5 0 0 0 8 2Z"/><path d="M6.5 12.5a1.5 1.5 0 0 0 3 0"/></svg>',
  },
  thought: {
    kind: 'thought',
    label: '内心戏',
    priority: 3,
    defaultTtlMs: 12_000,
    tailKind: 'cloud',
    fontSizePx: 12,
    lineHeight: 1.48,
    paddingX: 11,
    paddingY: 8,
    maxLines: 5,
    radiusPx: 19,
    fillStart: 'rgba(66,44,112,0.88)',
    fillEnd: 'rgba(46,29,84,0.85)',
    strokeColor: 'rgba(214,184,255,0.86)',
    strokeWidth: 1.5,
    strokeDasharray: '4.5 3',
    color: '#f6eeff',
    dropShadow: 'drop-shadow(0px 5px 13px rgba(24,12,52,0.30))',
    backdropFilter: 'blur(8px)',
    animationName: 'whaleBubblePop',
    iconSvg: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="#e4cbff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 11.5h7a2.5 2.5 0 0 0 .3-4.98A3.5 3.5 0 0 0 5 5.8a2.7 2.7 0 0 0-.5 5.7Z"/></svg>',
  },
  hint: {
    kind: 'hint',
    label: '互动提示',
    priority: 2,
    defaultTtlMs: 9_000,
    tailKind: 'soft',
    fontSizePx: 12.5,
    lineHeight: 1.46,
    paddingX: 11,
    paddingY: 8,
    maxLines: 3,
    radiusPx: 16,
    fillStart: 'rgba(235,248,255,0.95)',
    fillEnd: 'rgba(218,240,255,0.93)',
    strokeColor: 'rgba(94,178,238,0.75)',
    strokeWidth: 1.5,
    color: '#143554',
    dropShadow: 'drop-shadow(0px 4px 12px rgba(18,52,86,0.22))',
    backdropFilter: 'blur(6px)',
    animationName: 'whaleBubblePop',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#2d8ad4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10c1.3-1.2 2.7-1.2 4 0s2.7 1.2 4 0 2.2-1.2 3 0"/><path d="M8 3.2l.8 1.9 1.9.8-1.9.8L8 8.6l-.8-1.9-1.9-.8 1.9-.8Z"/></svg>',
  },
  status: {
    kind: 'status',
    label: '状态播报',
    priority: 1,
    defaultTtlMs: 16_000,
    tailKind: 'none',
    fontSizePx: 11.5,
    lineHeight: 1.35,
    paddingX: 11,
    paddingY: 5,
    maxLines: 2,
    radiusPx: 99,
    fillStart: 'rgba(13,36,56,0.90)',
    fillEnd: 'rgba(10,28,46,0.88)',
    strokeColor: 'rgba(72,209,196,0.68)',
    strokeWidth: 1.2,
    color: '#d9f7f4',
    dropShadow: 'drop-shadow(0px 4px 10px rgba(6,20,36,0.32))',
    tabularNums: true,
    backdropFilter: 'blur(8px)',
    animationName: 'whaleBubblePop',
    iconSvg: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="rgba(72,209,196,0.24)"/><circle cx="8" cy="8" r="2.7" fill="#48d1c4"/></svg>',
  },
};

/**
 * 数据驱动情绪样式映射表（7 种情绪统一由本表配置，禁止条件分支堆砌）。
 * 保持蓝鲸女仆 × Tidepaper 高对比柔彩风格与统一连续边框语言。
 */
export const BUBBLE_MOOD_THEMES: Readonly<Record<BubbleMood, BubbleMoodTheme>> = {
  happy: {
    mood: 'happy',
    label: '开心',
    tailKind: 'soft',
    fillStart: 'rgba(255,250,238,0.97)',
    fillEnd: 'rgba(255,238,204,0.95)',
    strokeColor: '#eca12c',
    strokeWidth: 1.8,
    color: '#4a2b06',
    dropShadow: 'drop-shadow(0px 5px 14px rgba(236,161,44,0.28))',
    fontWeight: 600,
    animationName: 'whaleMoodBounce',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="#eca12c" aria-hidden="true"><path d="M8 1.5l1.5 3.8 3.8 1.5-3.8 1.5L8 12.1 6.5 8.3 2.7 6.8l3.8-1.5Z"/><circle cx="13" cy="12.5" r="1.2"/></svg>',
  },
  angry: {
    mood: 'angry',
    label: '生气',
    tailKind: 'sharp',
    fillStart: 'rgba(255,244,242,0.98)',
    fillEnd: 'rgba(255,221,214,0.96)',
    strokeColor: '#e04838',
    strokeWidth: 2,
    color: '#4c130e',
    dropShadow: 'drop-shadow(2px 3px 0px rgba(224,72,56,0.34)) drop-shadow(0px 4px 12px rgba(76,19,14,0.22))',
    fontWeight: 700,
    animationName: 'whaleMoodShake',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#e04838" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 5c1.6 0 2.5-.9 2.5-2.5M13 5c-1.6 0-2.5-.9-2.5-2.5M3 11c1.6 0 2.5.9 2.5 2.5M13 11c-1.6 0-2.5.9-2.5 2.5"/></svg>',
  },
  sleepy: {
    mood: 'sleepy',
    label: '困倦',
    tailKind: 'cloud',
    fillStart: 'rgba(31,42,76,0.91)',
    fillEnd: 'rgba(21,30,56,0.89)',
    strokeColor: 'rgba(148,178,242,0.85)',
    strokeWidth: 1.5,
    strokeDasharray: '4 3',
    color: '#e1ecff',
    dropShadow: 'drop-shadow(0px 5px 14px rgba(12,18,38,0.40))',
    animationName: 'whaleMoodDrift',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#b6ceff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.8 2.6a4.8 4.8 0 1 0 3.6 7.8 3.9 3.9 0 0 1-3.6-7.8Z"/><path d="M11 3.2h2.2l-2 2.4h2.2"/></svg>',
  },
  surprised: {
    mood: 'surprised',
    label: '惊讶',
    tailKind: 'sharp',
    fillStart: 'rgba(255,253,240,0.98)',
    fillEnd: 'rgba(255,243,194,0.96)',
    strokeColor: '#e88b1a',
    strokeWidth: 2,
    color: '#3e2505',
    dropShadow: 'drop-shadow(0px 5px 14px rgba(232,139,26,0.32))',
    fontWeight: 700,
    animationName: 'whaleMoodPop',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#e88b1a" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 2.5v6.5M6 12.2v.6M10.5 3.5l-.6 5.5M9.7 12v.6"/></svg>',
  },
  thinking: {
    mood: 'thinking',
    label: '思考',
    tailKind: 'cloud',
    fillStart: 'rgba(238,246,254,0.96)',
    fillEnd: 'rgba(218,233,248,0.94)',
    strokeColor: '#4f85c9',
    strokeWidth: 1.5,
    strokeDasharray: '4.5 3',
    color: '#173052',
    dropShadow: 'drop-shadow(0px 5px 12px rgba(23,48,82,0.22))',
    animationName: 'whaleMoodFloat',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#4f85c9" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 8.2a1.4 1.4 0 1 1 1.4-1.4c0 1.4-1.4 2.2-2.8 2.2a2.8 2.8 0 0 1 0-5.6 4.1 4.1 0 0 1 4.1 4.1c0 2.5-1.9 4.5-4.4 4.8"/></svg>',
  },
  coquettish: {
    mood: 'coquettish',
    label: '撒娇',
    tailKind: 'soft',
    fillStart: 'rgba(255,244,250,0.97)',
    fillEnd: 'rgba(255,224,240,0.95)',
    strokeColor: '#e86ea2',
    strokeWidth: 1.7,
    color: '#541835',
    dropShadow: 'drop-shadow(0px 5px 14px rgba(232,110,162,0.28))',
    fontWeight: 600,
    animationName: 'whaleMoodWiggle',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="#e86ea2" aria-hidden="true"><path d="M8 13.4s-4.8-3-4.8-6.4A2.8 2.8 0 0 1 8 5.2 2.8 2.8 0 0 1 12.8 7c0 3.4-4.8 6.4-4.8 6.4Z"/></svg>',
  },
  shy: {
    mood: 'shy',
    label: '害羞',
    tailKind: 'soft',
    fillStart: 'rgba(255,245,244,0.97)',
    fillEnd: 'rgba(255,226,222,0.95)',
    strokeColor: '#e98480',
    strokeWidth: 1.6,
    color: '#521e1e',
    dropShadow: 'drop-shadow(0px 5px 12px rgba(233,132,128,0.26))',
    animationName: 'whaleMoodShy',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#e98480" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 9.5l1.6-2.8M5.2 9.5l1.6-2.8M9.2 9.5l1.6-2.8M11.9 9.5l1.6-2.8"/></svg>',
  },
};

/** 事件触发源 → 情绪查表（数据驱动）。 */
export const TRIGGER_TO_MOOD: Readonly<Record<string, BubbleMood>> = {
  greeting: 'happy',
  happy: 'happy',
  reflex: 'angry',
  grudge: 'angry',
  shake: 'angry',
  sleep: 'sleepy',
  bump: 'surprised',
  egg: 'surprised',
  decision: 'thinking',
  poke: 'coquettish',
  coax: 'shy',
};

export function moodForTrigger(trigger: string): BubbleMood | undefined {
  return TRIGGER_TO_MOOD[trigger];
}

export const BUBBLE_FONTS: Readonly<Record<BubbleFontId, BubbleFontDefinition>> = {
  'shangshou-gummy': {
    id: 'shangshou-gummy',
    category: 'default',
    label: '上首软糖体（默认）',
    family: 'ShangShouGummy',
    fileUrl: 'whale-pet://fonts/%E4%B8%8A%E9%A6%96%E8%BD%AF%E7%B3%96%E4%BD%93.ttf',
    format: 'truetype',
    fallbackStack: '"ShangShouGummy","ZCOOLKuaiLe","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif',
    license: 'DEV_ONLY_NON_COMMERCIAL（dsh-pet 随附字体，本地自用）',
    source: 'assets/pet-packs/fonts/上首软糖体.ttf',
  },
  handwriting: {
    id: 'handwriting',
    category: 'handwriting',
    label: '龙藏体（手写感）',
    family: 'WhaleBubbleHandwriting',
    fileUrl: './fonts/long-cang.woff2',
    format: 'woff2',
    fallbackStack: '"WhaleBubbleHandwriting","Kaiti SC","STKaiti","KaiTi","PingFang SC","Microsoft YaHei",cursive,serif',
    license: 'SIL Open Font License 1.1（允许商用与随包分发）',
    source: 'Google Fonts ofl/longcang（apps/desktop-host/assets/fonts/long-cang.woff2）',
  },
  rounded: {
    id: 'rounded',
    category: 'rounded',
    label: '站酷快乐体（圆体）',
    family: 'WhaleBubbleRounded',
    fileUrl: './fonts/zcool-kuaile.woff2',
    format: 'woff2',
    fallbackStack: '"WhaleBubbleRounded","ShangShouGummy","Hiragino Maru Gothic ProN","PingFang SC","Microsoft YaHei",rounded,sans-serif',
    license: 'SIL Open Font License 1.1（允许商用与随包分发）',
    source: 'Google Fonts ofl/zcoolkuaile（apps/desktop-host/assets/fonts/zcool-kuaile.woff2）',
  },
  formal: {
    id: 'formal',
    category: 'formal',
    label: '站酷小薇体（正式体）',
    family: 'WhaleBubbleFormal',
    fileUrl: './fonts/zcool-xiaowei.woff2',
    format: 'woff2',
    fallbackStack: '"WhaleBubbleFormal","Songti SC","Noto Serif SC","SimSun","PingFang SC","Microsoft YaHei",serif',
    license: 'SIL Open Font License 1.1（允许商用与随包分发）',
    source: 'Google Fonts ofl/zcoolxiaowei（apps/desktop-host/assets/fonts/zcool-xiaowei.woff2）',
  },
};

export function bubbleFontDefinition(fontId: BubbleFontId = 'shangshou-gummy'): BubbleFontDefinition {
  return BUBBLE_FONTS[fontId];
}

export function bubbleFontStack(fontId: BubbleFontId = 'shangshou-gummy'): string {
  return bubbleFontDefinition(fontId).fallbackStack;
}

export function buildBubbleFontFacesCss(): string {
  const blocks: string[] = [];
  for (const id of ['handwriting', 'rounded', 'formal'] as const) {
    const def = BUBBLE_FONTS[id];
    blocks.push(
      `@font-face{font-family:'${def.family}';src:url('${def.fileUrl}') format('${def.format}');font-display:swap;}`,
    );
  }
  return blocks.join('');
}

export function bubbleTheme(kind: BubbleKind): BubbleVisualTheme {
  return THEMES[kind];
}

export function resolveBubbleStyle(kind: BubbleKind, mood?: BubbleMood | null): ResolvedBubbleStyle {
  const base = THEMES[kind];
  if (mood === undefined || mood === null) return base;
  const moodTheme = BUBBLE_MOOD_THEMES[mood];
  return {
    ...base,
    mood,
    moodLabel: moodTheme.label,
    tailKind: base.tailKind === 'none' ? 'none' : moodTheme.tailKind,
    fillStart: moodTheme.fillStart,
    fillEnd: moodTheme.fillEnd,
    strokeColor: moodTheme.strokeColor,
    strokeWidth: moodTheme.strokeWidth,
    ...(moodTheme.strokeDasharray !== undefined ? { strokeDasharray: moodTheme.strokeDasharray } : {}),
    color: moodTheme.color,
    dropShadow: moodTheme.dropShadow,
    fontWeight: moodTheme.fontWeight ?? base.fontWeight,
    animationName: moodTheme.animationName,
    iconSvg: moodTheme.iconSvg,
  };
}

export function bubbleWidthBudget(
  kind: BubbleKind,
  stageWidth: number,
  activeCount: number,
): { minWidth: number; maxWidth: number } {
  const safeWidth = Math.max(80, Math.floor(stageWidth));
  let rawMax: number;
  if (kind === 'legacy') {
    rawMax = activeCount <= 1
      ? Math.min(Math.floor(safeWidth * 0.54), 220)
      : Math.min(Math.floor(safeWidth * 0.45), 192);
  } else if (activeCount <= 1) {
    rawMax = kind === 'reaction'
      ? Math.min(Math.floor(safeWidth * 0.68), 288)
      : kind === 'thought' || kind === 'status'
        ? Math.min(Math.floor(safeWidth * 0.80), 336)
        : Math.min(Math.floor(safeWidth * 0.90), 376);
  } else if (activeCount === 2) {
    rawMax = kind === 'reaction'
      ? Math.min(Math.floor(safeWidth * 0.52), 212)
      : kind === 'dialog' || kind === 'notice' || kind === 'thought'
        ? Math.min(Math.floor(safeWidth * 0.82), 344)
        : Math.min(Math.floor(safeWidth * 0.56), 240);
  } else {
    rawMax = kind === 'dialog' || kind === 'notice'
      ? Math.min(Math.floor(safeWidth * 0.94), 380)
      : kind === 'thought' || kind === 'hint'
        ? Math.min(Math.floor(safeWidth * 0.72), 300)
        : Math.min(Math.floor(safeWidth * 0.54), 228);
  }
  const maxWidth = Math.max(48, Math.min(rawMax, safeWidth - 8));
  // 状态条还需预留图标、gap 与双侧 padding，避免 clear_area 等短状态被挤成窄列。
  const rawMin = kind === 'status' ? 120 : kind === 'reaction' ? 76 : 104;
  return { minWidth: Math.min(rawMin, maxWidth), maxWidth };
}

function measureTextUnits(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    units += text.charCodeAt(i) <= 0x7f ? 0.58 : 1.04;
  }
  return Math.max(1, units);
}

export function estimateBubbleSize(input: {
  kind: BubbleKind;
  text: string;
  stage: { width: number; height: number };
  activeCount: number;
  fontScale?: number;
  mood?: BubbleMood | null;
  overrideWidth?: number;
}): { width: number; height: number; lines: number } {
  const theme = resolveBubbleStyle(input.kind, input.mood);
  const scale = Math.min(1.6, Math.max(0.7, input.fontScale ?? 1));
  const fontSize = theme.fontSizePx * scale;
  const { minWidth, maxWidth } = bubbleWidthBudget(input.kind, input.stage.width, input.activeCount);
  const extraWidth = theme.paddingX * 2 + (theme.iconSvg !== '' ? 19 : 0) + 6;
  const textUnits = measureTextUnits(input.text.trim());
  const naturalWidth = Math.ceil(textUnits * fontSize + extraWidth);
  const width = input.overrideWidth !== undefined
    ? Math.max(48, Math.round(input.overrideWidth))
    : Math.min(maxWidth, Math.max(minWidth, naturalWidth));
  const contentWidth = Math.max(fontSize, width - extraWidth);
  const unitsPerLine = Math.max(1, contentWidth / fontSize);
  const lines = Math.min(theme.maxLines, Math.max(1, Math.ceil(textUnits / unitsPerLine)));
  const heightRatio = input.activeCount <= 1
    ? 0.54
    : input.activeCount === 2
      ? 0.42
      : (input.kind === 'dialog' || input.kind === 'reaction' ? 0.44 : 0.36);
  const maxHeight = Math.max(24, Math.floor(Math.max(40, input.stage.height) * heightRatio));
  const computedHeight = Math.ceil(lines * fontSize * theme.lineHeight + theme.paddingY * 2 + 6);
  const height = input.overrideWidth !== undefined
    ? computedHeight
    : Math.min(maxHeight, computedHeight);
  return { width, height, lines };
}
