/**
 * 按桌宠所在 display 判定全屏遮挡（T-M6-44，纯函数可注入）。
 * 只有全屏窗口覆盖当前桌宠 display 的 >=95% 面积时才隐藏；其他屏全屏不影响本屏桌宠。
 */
export interface RectLike { x: number; y: number; width: number; height: number }
export interface DisplayLike { displayId: string; bounds: RectLike }
export interface FullscreenWindowLike { bounds: RectLike; displayId?: string | null }

export interface FullscreenDecision {
  hidden: boolean;
  coveredRatio: number;
  window?: FullscreenWindowLike;
}

export function intersectionArea(a: RectLike, b: RectLike): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

export function detectFullscreenForDisplay(
  display: DisplayLike,
  windows: readonly FullscreenWindowLike[],
  threshold = 0.95,
): FullscreenDecision {
  const area = Math.max(0, display.bounds.width) * Math.max(0, display.bounds.height);
  if (area <= 0) return { hidden: false, coveredRatio: 0 };
  let best: FullscreenDecision = { hidden: false, coveredRatio: 0 };
  for (const window of windows) {
    if (window.displayId !== undefined && window.displayId !== null && window.displayId !== display.displayId) continue;
    const ratio = Math.min(1, intersectionArea(display.bounds, window.bounds) / area);
    if (ratio > best.coveredRatio) best = { hidden: ratio >= threshold, coveredRatio: ratio, window };
  }
  return best;
}

/** 解析 AppleScript 返回的 "x,y,w,h"；空串/坏数据返回 null。 */
export function parseFullscreenRect(raw: string): RectLike | null {
  const parts = raw.trim().split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = parts as [number, number, number, number];
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
