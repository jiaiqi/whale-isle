/**
 * 桌宠气泡语义类型、视觉主题令牌与内容自适应尺寸估算纯函数（零 DOM）。
 * 与 Q 版像素蓝鲸女仆 × Tidepaper 潮汐纸视觉体系对齐，禁止使用彩色 Emoji 图标。
 */
import type { PetBubbleKind } from '@workbench/shared-protocol';

export type BubbleKind = PetBubbleKind;
export type BubbleTailKind = 'pointer' | 'cloud' | 'sharp' | 'soft' | 'none';

export const ALL_BUBBLE_KINDS: readonly BubbleKind[] = [
  'thought',
  'dialog',
  'status',
  'notice',
  'reaction',
  'hint',
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
  background: string;
  border: string;
  borderLeftAccent?: string;
  color: string;
  borderRadius: string;
  boxShadow: string;
  tailFill: string;
  tailStroke: string;
  fontWeight?: number;
  tabularNums?: boolean;
  backdropFilter?: string;
  animationName: string;
  iconSvg: string;
}

const THEMES: Record<BubbleKind, BubbleVisualTheme> = {
  reaction: {
    kind: 'reaction',
    label: '即时反应',
    priority: 6,
    defaultTtlMs: 6_000,
    tailKind: 'sharp',
    fontSizePx: 13,
    lineHeight: 1.42,
    paddingX: 11,
    paddingY: 7,
    maxLines: 3,
    background: 'linear-gradient(145deg, rgba(255,248,244,0.96), rgba(255,236,226,0.95))',
    border: '2px solid #eb6b4b',
    color: '#381a14',
    borderRadius: '14px 14px 14px 6px',
    boxShadow: '2px 3px 0 rgba(235,107,75,0.32), 0 6px 16px rgba(40,14,10,0.22)',
    tailFill: '#fff2ec',
    tailStroke: '#eb6b4b',
    fontWeight: 600,
    animationName: 'whaleBubbleBurst',
    iconSvg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="#eb6b4b" aria-hidden="true"><path d="M8 1l1.7 4.3L14 7l-4.3 1.7L8 13l-1.7-4.3L2 7l4.3-1.7Z"/></svg>',
  },
  dialog: {
    kind: 'dialog',
    label: '正式对话',
    priority: 5,
    defaultTtlMs: 10_000,
    tailKind: 'pointer',
    fontSizePx: 13.5,
    lineHeight: 1.48,
    paddingX: 13,
    paddingY: 9,
    maxLines: 5,
    background: 'linear-gradient(155deg, rgba(247,251,255,0.96), rgba(232,244,255,0.94))',
    border: '1.5px solid rgba(56,138,224,0.75)',
    color: '#152842',
    borderRadius: '16px',
    boxShadow: '0 6px 20px rgba(15,38,68,0.24), inset 0 1px 0 rgba(255,255,255,0.95)',
    tailFill: '#edf6ff',
    tailStroke: 'rgba(56,138,224,0.82)',
    backdropFilter: 'blur(8px)',
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
    paddingX: 11,
    paddingY: 7,
    maxLines: 3,
    background: 'linear-gradient(135deg, rgba(24,34,54,0.92), rgba(18,26,42,0.90))',
    border: '1px solid rgba(255,204,112,0.60)',
    borderLeftAccent: '3px solid #ffc857',
    color: '#fff4dd',
    borderRadius: '12px',
    boxShadow: '0 6px 18px rgba(8,14,28,0.36)',
    tailFill: '#182236',
    tailStroke: 'rgba(255,204,112,0.60)',
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
    maxLines: 4,
    background: 'linear-gradient(145deg, rgba(64,42,108,0.86), rgba(44,28,82,0.82))',
    border: '1.5px dashed rgba(212,182,255,0.84)',
    color: '#f6eeff',
    borderRadius: '20px 20px 22px 14px',
    boxShadow: '0 5px 18px rgba(24,12,52,0.30), inset 0 1px 0 rgba(255,255,255,0.14)',
    tailFill: 'rgba(58,36,98,0.84)',
    tailStroke: 'rgba(212,182,255,0.78)',
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
    background: 'linear-gradient(145deg, rgba(235,248,255,0.94), rgba(218,240,255,0.92))',
    border: '1.5px solid rgba(94,178,238,0.70)',
    color: '#143554',
    borderRadius: '16px',
    boxShadow: '0 5px 16px rgba(18,52,86,0.20)',
    tailFill: '#e1f3ff',
    tailStroke: 'rgba(94,178,238,0.75)',
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
    paddingX: 10,
    paddingY: 5,
    maxLines: 2,
    background: 'rgba(13,34,54,0.88)',
    border: '1px solid rgba(72,209,196,0.62)',
    color: '#d9f7f4',
    borderRadius: '999px',
    boxShadow: '0 4px 14px rgba(6,20,36,0.32)',
    tailFill: '#0d2236',
    tailStroke: 'rgba(72,209,196,0.62)',
    tabularNums: true,
    backdropFilter: 'blur(8px)',
    animationName: 'whaleBubblePop',
    iconSvg: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="rgba(72,209,196,0.24)"/><circle cx="8" cy="8" r="2.7" fill="#48d1c4"/></svg>',
  },
};

export function bubbleTheme(kind: BubbleKind): BubbleVisualTheme {
  return THEMES[kind];
}

export function bubbleWidthBudget(
  kind: BubbleKind,
  stageWidth: number,
  activeCount: number,
): { minWidth: number; maxWidth: number } {
  const safeWidth = Math.max(80, Math.floor(stageWidth));
  let rawMax: number;
  if (activeCount <= 1) {
    rawMax = kind === 'reaction'
      ? Math.min(Math.floor(safeWidth * 0.62), 260)
      : kind === 'thought' || kind === 'status'
        ? Math.min(Math.floor(safeWidth * 0.70), 296)
        : Math.min(Math.floor(safeWidth * 0.76), 320);
  } else if (activeCount === 2) {
    rawMax = kind === 'reaction'
      ? Math.min(Math.floor(safeWidth * 0.50), 212)
      : kind === 'dialog' || kind === 'notice'
        ? Math.min(Math.floor(safeWidth * 0.60), 252)
        : Math.min(Math.floor(safeWidth * 0.46), 196);
  } else {
    rawMax = Math.min(Math.floor(safeWidth * 0.52), 220);
  }
  const maxWidth = Math.max(48, Math.min(rawMax, safeWidth - 8));
  const rawMin = kind === 'status' ? 88 : kind === 'reaction' ? 76 : 104;
  return { minWidth: Math.min(rawMin, maxWidth), maxWidth };
}

function measureTextUnits(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    units += text.charCodeAt(i) <= 0x7f ? 0.58 : 1;
  }
  return Math.max(1, units);
}

export function estimateBubbleSize(input: {
  kind: BubbleKind;
  text: string;
  stage: { width: number; height: number };
  activeCount: number;
  fontScale?: number;
}): { width: number; height: number; lines: number } {
  const theme = bubbleTheme(input.kind);
  const scale = Math.min(1.6, Math.max(0.7, input.fontScale ?? 1));
  const fontSize = theme.fontSizePx * scale;
  const { minWidth, maxWidth } = bubbleWidthBudget(input.kind, input.stage.width, input.activeCount);
  const extraWidth = theme.paddingX * 2 + (theme.iconSvg !== '' ? 19 : 0) + 6;
  const textUnits = measureTextUnits(input.text.trim());
  const naturalWidth = Math.ceil(textUnits * fontSize + extraWidth);
  const width = Math.min(maxWidth, Math.max(minWidth, naturalWidth));
  const contentWidth = Math.max(fontSize, width - extraWidth);
  const unitsPerLine = Math.max(1, contentWidth / fontSize);
  const lines = Math.min(theme.maxLines, Math.max(1, Math.ceil(textUnits / unitsPerLine)));
  const heightRatio = input.activeCount <= 1 ? 0.42 : input.activeCount === 2 ? 0.28 : 0.26;
  const maxHeight = Math.max(24, Math.floor(Math.max(40, input.stage.height) * heightRatio));
  const height = Math.min(maxHeight, Math.ceil(lines * fontSize * theme.lineHeight + theme.paddingY * 2 + 4));
  return { width, height, lines };
}
