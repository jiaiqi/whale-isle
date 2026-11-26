/**
 * 智能多类型气泡布局、8 向连续融合 SVG 尾巴与 3 粒飘点纯函数（零 DOM）。
 *   - 感知角色位置、朝向、窗口贴边、障碍物（workCards / riceBowl）与脸身保护区；
 *   - 保留第 7 类 legacy（经典半透蓝玻泡）在角色右下角的原位风格与避障逻辑；
 *   - 单路径 SVG 闭合轮廓保证气泡与尾巴无缝衔接，上/下/左/右全方向自然生长；
 *   - 保留 computeBubbleLayout / rectsOverlap 向后兼容出口。
 */
import {
  estimateBubbleSize,
  resolveBubbleStyle,
  type BubbleKind,
  type BubbleMood,
  type BubbleTailKind,
} from './bubble-types';

export interface StageBox {
  width: number;
  height: number;
}

export interface BubbleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BubbleLayout {
  thought: BubbleRect;
  dialog: BubbleRect;
}

export type CharacterFacing = 'left' | 'right' | 'center';
export type ScreenEdgeHint = 'left' | 'right' | null;
export type BubbleTailDirection =
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'left'
  | 'right'
  | 'none';

export interface CharacterAnchor {
  xRatio: number;
  headYRatio: number;
  facing: CharacterFacing;
}

export interface BubbleStageContext {
  anchor?: Partial<CharacterAnchor>;
  edgeHint?: ScreenEdgeHint;
  occupied?: readonly BubbleRect[];
  fontScale?: number;
}

export interface ActiveBubbleItem {
  kind: BubbleKind;
  text: string;
  mood?: BubbleMood | null;
}

export interface PlacedBubble {
  kind: BubbleKind;
  mood?: BubbleMood | null;
  rect: BubbleRect;
  tail: BubbleTailDirection;
  side: 'left' | 'right' | 'center';
  maxLines: number;
}

export interface SmartBubbleLayout {
  items: Partial<Record<BubbleKind, PlacedBubble>>;
  ordered: PlacedBubble[];
  preferredSide: 'left' | 'right';
}

export interface BubbleShellGeometry {
  path: string;
  svgWidth: number;
  svgHeight: number;
  pad: number;
}

export interface CloudDot {
  cx: number;
  cy: number;
  r: number;
}

export const MAX_VISIBLE_BUBBLES = 3;

const DEFAULT_ANCHOR: CharacterAnchor = {
  xRatio: 0.5,
  headYRatio: 0.34,
  facing: 'center',
};

export function rectsOverlap(a: BubbleRect, b: BubbleRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inflateRect(rect: BubbleRect, gap: number): BubbleRect {
  return {
    x: rect.x - gap,
    y: rect.y - gap,
    width: rect.width + gap * 2,
    height: rect.height + gap * 2,
  };
}

function overlapsAny(rect: BubbleRect, list: readonly BubbleRect[], gap: number): boolean {
  const padded = gap > 0 ? inflateRect(rect, gap) : rect;
  for (const item of list) {
    if (rectsOverlap(padded, item)) return true;
  }
  return false;
}

function normalizeAnchor(raw?: Partial<CharacterAnchor>): CharacterAnchor {
  return {
    xRatio: Math.min(0.85, Math.max(0.15, raw?.xRatio ?? DEFAULT_ANCHOR.xRatio)),
    headYRatio: Math.min(0.65, Math.max(0.15, raw?.headYRatio ?? DEFAULT_ANCHOR.headYRatio)),
    facing: raw?.facing ?? DEFAULT_ANCHOR.facing,
  };
}

/** 根据屏边、角色朝向、角色偏位决策优先主侧（屏边避让优先级最高）。 */
export function resolvePreferredSide(context: BubbleStageContext = {}): 'left' | 'right' {
  if (context.edgeHint === 'right') return 'left';
  if (context.edgeHint === 'left') return 'right';
  const anchor = normalizeAnchor(context.anchor);
  if (anchor.facing === 'left') return 'left';
  if (anchor.facing === 'right') return 'right';
  if (anchor.xRatio > 0.56) return 'left';
  if (anchor.xRatio < 0.44) return 'right';
  return 'right';
}

/** 计算尾巴朝向：覆盖上/下/左/右 8 向，按气泡与角色头部的相对几何方位精确指向角色。 */
export function resolveTailDirection(
  kind: BubbleKind,
  rect: BubbleRect,
  anchorPx: { x: number; y: number },
  tailKindOverride?: BubbleTailKind,
): BubbleTailDirection {
  const tailKind = tailKindOverride ?? resolveBubbleStyle(kind).tailKind;
  if (tailKind === 'none') return 'none';
  const cx = rect.x + rect.width / 2;
  const bottom = rect.y + rect.height;
  if (bottom <= anchorPx.y + 18) {
    if (cx < anchorPx.x - 24) return 'bottom-right';
    if (cx > anchorPx.x + 24) return 'bottom-left';
    return 'bottom-center';
  }
  if (rect.y >= anchorPx.y + 38) {
    if (cx < anchorPx.x - 24) return 'top-right';
    if (cx > anchorPx.x + 24) return 'top-left';
    return 'top-center';
  }
  return cx >= anchorPx.x ? 'left' : 'right';
}

/**
 * 生成气泡 + 尾巴的单条闭合 SVG 外壳路径（无任何接缝与断开）。
 * 主体严格占用坐标 [pad .. pad + width] × [pad .. pad + height]，尾巴向外延伸至多 11px。
 */
export function buildBubbleShellPath(input: {
  width: number;
  height: number;
  radius: number;
  tail: BubbleTailDirection;
  tailKind: BubbleTailKind;
  pad?: number;
}): BubbleShellGeometry {
  const pad = input.pad ?? 14;
  const w = Math.max(28, Math.round(input.width));
  const h = Math.max(20, Math.round(input.height));
  const x0 = pad;
  const y0 = pad;
  const x1 = pad + w;
  const y1 = pad + h;
  const r = Math.max(4, Math.min(Math.round(input.radius), Math.floor(Math.min(w, h) / 2) - 1));
  const tail = input.tailKind === 'cloud' || input.tailKind === 'none' ? 'none' : input.tail;
  const isSharp = input.tailKind === 'sharp';
  const tailLen = isSharp ? 12 : 10;
  const bw = Math.min(9, Math.max(5, Math.floor((Math.min(w, h) - r * 2) * 0.25)));

  const seg: string[] = [`M ${x0 + r} ${y0}`];

  // 顶边（左 → 右）
  if (tail === 'top-left' || tail === 'top-center' || tail === 'top-right') {
    const safeMinX = x0 + r + bw + 3;
    const safeMaxX = x1 - r - bw - 3;
    const rawTx = tail === 'top-left'
      ? x0 + r + Math.min(24, Math.round(w * 0.22))
      : tail === 'top-right'
        ? x1 - r - Math.min(24, Math.round(w * 0.22))
        : Math.round((x0 + x1) / 2);
    const tx = Math.min(safeMaxX, Math.max(safeMinX, rawTx));
    const tilt = tail === 'top-left' ? -5 : tail === 'top-right' ? 5 : 0;
    const tipX = tx + tilt;
    const tipY = y0 - tailLen;
    if (tx - bw > x0 + r) seg.push(`L ${tx - bw} ${y0}`);
    if (isSharp) {
      seg.push(`Q ${tx - 3} ${y0}, ${tipX} ${tipY}`);
      seg.push(`Q ${tx + 3} ${y0}, ${tx + bw} ${y0}`);
    } else {
      seg.push(`Q ${tx - 3} ${y0}, ${tipX - 1.5} ${tipY + 1.5}`);
      seg.push(`Q ${tipX} ${tipY - 1}, ${tipX + 1.5} ${tipY + 1.5}`);
      seg.push(`Q ${tx + 3} ${y0}, ${tx + bw} ${y0}`);
    }
  }
  seg.push(`L ${x1 - r} ${y0}`);
  seg.push(`Q ${x1} ${y0}, ${x1} ${y0 + r}`);

  // 右边（上 → 下）
  if (tail === 'right') {
    const safeMinY = y0 + r + bw + 2;
    const safeMaxY = y1 - r - bw - 2;
    const ty = Math.min(safeMaxY, Math.max(safeMinY, Math.round((y0 + y1) / 2)));
    const tipX = x1 + tailLen;
    const tipY = ty + 3;
    if (ty - bw > y0 + r) seg.push(`L ${x1} ${ty - bw}`);
    if (isSharp) {
      seg.push(`Q ${x1} ${ty - 2}, ${tipX} ${tipY}`);
      seg.push(`Q ${x1} ${ty + 3}, ${x1} ${ty + bw}`);
    } else {
      seg.push(`Q ${x1} ${ty - 2}, ${tipX - 1.5} ${tipY - 1.5}`);
      seg.push(`Q ${tipX + 1} ${tipY}, ${tipX - 1.5} ${tipY + 1.5}`);
      seg.push(`Q ${x1} ${ty + 3}, ${x1} ${ty + bw}`);
    }
  }
  seg.push(`L ${x1} ${y1 - r}`);
  seg.push(`Q ${x1} ${y1}, ${x1 - r} ${y1}`);

  // 底边（右 → 左）
  if (tail === 'bottom-right' || tail === 'bottom-center' || tail === 'bottom-left') {
    const safeMinX = x0 + r + bw + 3;
    const safeMaxX = x1 - r - bw - 3;
    const rawTx = tail === 'bottom-left'
      ? x0 + r + Math.min(24, Math.round(w * 0.22))
      : tail === 'bottom-right'
        ? x1 - r - Math.min(24, Math.round(w * 0.22))
        : Math.round((x0 + x1) / 2);
    const tx = Math.min(safeMaxX, Math.max(safeMinX, rawTx));
    const tilt = tail === 'bottom-left' ? -5 : tail === 'bottom-right' ? 5 : 0;
    const tipX = tx + tilt;
    const tipY = y1 + tailLen;
    if (tx + bw < x1 - r) seg.push(`L ${tx + bw} ${y1}`);
    if (isSharp) {
      seg.push(`Q ${tx + 3} ${y1}, ${tipX} ${tipY}`);
      seg.push(`Q ${tx - 3} ${y1}, ${tx - bw} ${y1}`);
    } else {
      seg.push(`Q ${tx + 3} ${y1}, ${tipX + 1.5} ${tipY - 1.5}`);
      seg.push(`Q ${tipX} ${tipY + 1}, ${tipX - 1.5} ${tipY - 1.5}`);
      seg.push(`Q ${tx - 3} ${y1}, ${tx - bw} ${y1}`);
    }
  }
  seg.push(`L ${x0 + r} ${y1}`);
  seg.push(`Q ${x0} ${y1}, ${x0} ${y1 - r}`);

  // 左边（下 → 上）
  if (tail === 'left') {
    const safeMinY = y0 + r + bw + 2;
    const safeMaxY = y1 - r - bw - 2;
    const ty = Math.min(safeMaxY, Math.max(safeMinY, Math.round((y0 + y1) / 2)));
    const tipX = x0 - tailLen;
    const tipY = ty + 3;
    if (ty + bw < y1 - r) seg.push(`L ${x0} ${ty + bw}`);
    if (isSharp) {
      seg.push(`Q ${x0} ${ty + 3}, ${tipX} ${tipY}`);
      seg.push(`Q ${x0} ${ty - 2}, ${x0} ${ty - bw}`);
    } else {
      seg.push(`Q ${x0} ${ty + 3}, ${tipX + 1.5} ${tipY + 1.5}`);
      seg.push(`Q ${tipX - 1} ${tipY}, ${tipX + 1.5} ${tipY - 1.5}`);
      seg.push(`Q ${x0} ${ty - 2}, ${x0} ${ty - bw}`);
    }
  }
  seg.push(`L ${x0} ${y0 + r}`);
  seg.push(`Q ${x0} ${y0}, ${x0 + r} ${y0} Z`);

  return {
    path: seg.join(' '),
    svgWidth: w + pad * 2,
    svgHeight: h + pad * 2,
    pad,
  };
}

/** 生成精致的 3 颗递减思绪云粒（覆盖上/下/左/右全方向）。 */
export function buildThoughtCloudDots(input: {
  width: number;
  height: number;
  tail: BubbleTailDirection;
  pad?: number;
}): CloudDot[] {
  if (input.tail === 'none') return [];
  const pad = input.pad ?? 14;
  const w = Math.max(28, Math.round(input.width));
  const h = Math.max(20, Math.round(input.height));
  const x0 = pad;
  const y0 = pad;
  const x1 = pad + w;
  const y1 = pad + h;

  switch (input.tail) {
    case 'left':
      return [
        { cx: x0 - 4, cy: Math.round(y0 + h * 0.48), r: 4.1 },
        { cx: x0 - 9, cy: Math.round(y0 + h * 0.56), r: 2.8 },
        { cx: x0 - 12.5, cy: Math.round(y0 + h * 0.63), r: 1.7 },
      ];
    case 'right':
      return [
        { cx: x1 + 4, cy: Math.round(y0 + h * 0.48), r: 4.1 },
        { cx: x1 + 9, cy: Math.round(y0 + h * 0.56), r: 2.8 },
        { cx: x1 + 12.5, cy: Math.round(y0 + h * 0.63), r: 1.7 },
      ];
    case 'top-left':
      return [
        { cx: x0 + Math.min(26, Math.round(w * 0.25)), cy: y0 - 4, r: 4.1 },
        { cx: x0 + Math.min(20, Math.round(w * 0.19)), cy: y0 - 9, r: 2.8 },
        { cx: x0 + Math.min(15, Math.round(w * 0.14)), cy: y0 - 12.5, r: 1.7 },
      ];
    case 'top-right':
      return [
        { cx: x1 - Math.min(26, Math.round(w * 0.25)), cy: y0 - 4, r: 4.1 },
        { cx: x1 - Math.min(20, Math.round(w * 0.19)), cy: y0 - 9, r: 2.8 },
        { cx: x1 - Math.min(15, Math.round(w * 0.14)), cy: y0 - 12.5, r: 1.7 },
      ];
    case 'top-center':
      return [
        { cx: Math.round(x0 + w / 2), cy: y0 - 4, r: 4.1 },
        { cx: Math.round(x0 + w / 2), cy: y0 - 9, r: 2.8 },
        { cx: Math.round(x0 + w / 2), cy: y0 - 12.5, r: 1.7 },
      ];
    case 'bottom-left':
      return [
        { cx: x0 + Math.min(26, Math.round(w * 0.25)), cy: y1 + 4, r: 4.1 },
        { cx: x0 + Math.min(20, Math.round(w * 0.19)), cy: y1 + 9, r: 2.8 },
        { cx: x0 + Math.min(15, Math.round(w * 0.14)), cy: y1 + 12.5, r: 1.7 },
      ];
    case 'bottom-right':
      return [
        { cx: x1 - Math.min(26, Math.round(w * 0.25)), cy: y1 + 4, r: 4.1 },
        { cx: x1 - Math.min(20, Math.round(w * 0.19)), cy: y1 + 9, r: 2.8 },
        { cx: x1 - Math.min(15, Math.round(w * 0.14)), cy: y1 + 12.5, r: 1.7 },
      ];
    case 'bottom-center':
      return [
        { cx: Math.round(x0 + w / 2), cy: y1 + 4, r: 4.1 },
        { cx: Math.round(x0 + w / 2), cy: y1 + 9, r: 2.8 },
        { cx: Math.round(x0 + w / 2), cy: y1 + 12.5, r: 1.7 },
      ];
  }
}

function clampRect(
  rect: BubbleRect,
  stage: StageBox,
  margin: number,
  bottomLimit: number,
): BubbleRect {
  const width = Math.min(Math.max(24, Math.round(rect.width)), Math.max(24, stage.width - margin * 2));
  const maxH = Math.max(18, bottomLimit - margin);
  const height = Math.min(Math.max(18, Math.round(rect.height)), maxH);
  const maxX = Math.max(margin, stage.width - margin - width);
  const maxY = Math.max(margin, bottomLimit - height);
  return {
    x: Math.min(Math.max(Math.round(rect.x), margin), maxX),
    y: Math.min(Math.max(Math.round(rect.y), margin), maxY),
    width,
    height,
  };
}

function buildCandidates(
  kind: BubbleKind,
  size: { width: number; height: number },
  sideCompact: { width: number; height: number } | null,
  stage: StageBox,
  anchorPx: { x: number; y: number },
  preferred: 'left' | 'right',
  singleBubble: boolean,
  margin: number,
  bottomLimit: number,
): BubbleRect[] {
  const w = size.width;
  const h = size.height;
  const leftX = margin;
  const rightX = stage.width - margin - w;
  const centerX = Math.round((stage.width - w) / 2);
  const mainX = preferred === 'right' ? rightX : leftX;
  const oppX = preferred === 'right' ? leftX : rightX;
  const biasedCenterX = preferred === 'right'
    ? Math.round(anchorPx.x - w * 0.28)
    : Math.round(anchorPx.x - w * 0.72);
  const topY = margin;
  const sideUpperY = Math.max(margin, Math.round(anchorPx.y - h * 0.65));
  const nearHeadY = Math.max(margin, Math.round(anchorPx.y - h * 0.45));
  const lowerSideY = Math.max(margin, bottomLimit - h);
  const legacyBottom = stage.height > 150 ? Math.min(bottomLimit, stage.height - 35) : bottomLimit;
  const legacyLowerY = Math.max(margin, legacyBottom - h);

  let rawList: BubbleRect[];
  switch (kind) {
    case 'status':
      rawList = [
        { x: centerX, y: topY, width: w, height: h },
        { x: oppX, y: topY, width: w, height: h },
        { x: mainX, y: topY, width: w, height: h },
        { x: mainX, y: sideUpperY, width: w, height: h },
      ];
      break;
    case 'dialog':
      rawList = singleBubble
        ? [
            { x: biasedCenterX, y: topY, width: w, height: h },
            { x: mainX, y: topY, width: w, height: h },
            { x: oppX, y: topY, width: w, height: h },
            { x: mainX, y: sideUpperY, width: w, height: h },
            { x: oppX, y: sideUpperY, width: w, height: h },
          ]
        : [
            { x: mainX, y: topY, width: w, height: h },
            { x: biasedCenterX, y: topY, width: w, height: h },
            { x: mainX, y: sideUpperY, width: w, height: h },
            { x: oppX, y: topY, width: w, height: h },
            { x: oppX, y: sideUpperY, width: w, height: h },
          ];
      break;
    case 'legacy':
      rawList = [
        { x: rightX, y: legacyLowerY, width: w, height: h },
        { x: leftX, y: legacyLowerY, width: w, height: h },
        { x: rightX, y: sideUpperY, width: w, height: h },
        { x: leftX, y: sideUpperY, width: w, height: h },
      ];
      break;
    case 'thought':
      rawList = [
        { x: oppX, y: topY, width: w, height: h },
        { x: mainX, y: topY, width: w, height: h },
        { x: centerX, y: topY, width: w, height: h },
        { x: oppX, y: sideUpperY, width: w, height: h },
      ];
      break;
    case 'reaction':
      rawList = [
        { x: mainX, y: nearHeadY, width: w, height: h },
        { x: oppX, y: nearHeadY, width: w, height: h },
        { x: biasedCenterX, y: topY, width: w, height: h },
        { x: mainX, y: topY, width: w, height: h },
      ];
      break;
    case 'notice':
      rawList = [
        { x: centerX, y: topY, width: w, height: h },
        { x: oppX, y: topY, width: w, height: h },
        { x: leftX, y: lowerSideY, width: w, height: h },
        { x: rightX, y: lowerSideY, width: w, height: h },
      ];
      break;
    case 'hint':
      rawList = [
        { x: biasedCenterX, y: topY, width: w, height: h },
        { x: mainX, y: topY, width: w, height: h },
        { x: oppX, y: topY, width: w, height: h },
        { x: mainX, y: sideUpperY, width: w, height: h },
      ];
      break;
  }

  if (sideCompact !== null) {
    const cw = sideCompact.width;
    const ch = sideCompact.height;
    const cOppX = preferred === 'right' ? leftX : stage.width - margin - cw;
    const cMainX = preferred === 'right' ? stage.width - margin - cw : leftX;
    const cMidY = Math.max(margin, Math.round(anchorPx.y - 12));
    const cLowerY = Math.max(margin, bottomLimit - ch);
    if (kind === 'legacy') {
      const cRightX = stage.width - margin - cw;
      const cLegacyLowerY = Math.max(margin, legacyBottom - ch);
      rawList.unshift({ x: cRightX, y: cLegacyLowerY, width: cw, height: ch });
      rawList.push(
        { x: cRightX, y: cMidY, width: cw, height: ch },
        { x: cOppX, y: cLegacyLowerY, width: cw, height: ch },
        { x: cOppX, y: topY, width: cw, height: ch },
      );
    } else {
      const isPrimary = kind === 'dialog' || kind === 'reaction' || kind === 'hint';
      const [firstX, secondX] = isPrimary ? [cMainX, cOppX] : [cOppX, cMainX];
      rawList.push(
        { x: firstX, y: topY, width: cw, height: ch },
        { x: firstX, y: cMidY, width: cw, height: ch },
        { x: secondX, y: topY, width: cw, height: ch },
        { x: secondX, y: cMidY, width: cw, height: ch },
      );
    }
  }

  return rawList.map((r) => clampRect(r, stage, margin, bottomLimit));
}

function findGridSlot(
  size: { width: number; height: number },
  placed: readonly BubbleRect[],
  obstacles: readonly BubbleRect[],
  stage: StageBox,
  preferred: 'left' | 'right',
  margin: number,
  gap: number,
  bottomLimit: number,
): BubbleRect | null {
  const w = Math.min(size.width, Math.max(24, stage.width - margin * 2));
  const leftX = margin;
  const rightX = Math.max(margin, stage.width - margin - w);
  const centerX = Math.max(margin, Math.round((stage.width - w) / 2));
  const xs = preferred === 'right' ? [rightX, leftX, centerX] : [leftX, rightX, centerX];
  const all = [...placed, ...obstacles];
  const ys = [margin, ...all.map((p) => p.y + p.height + gap)];

  for (const y of ys) {
    if (y + 18 > bottomLimit) continue;
    const availH = bottomLimit - y;
    const h = Math.min(size.height, availH);
    if (h < 18) continue;
    for (const x of xs) {
      const candidate: BubbleRect = { x, y, width: w, height: h };
      if (!overlapsAny(candidate, placed, gap) && !overlapsAny(candidate, obstacles, 2)) return candidate;
    }
  }
  return null;
}

function sideOfRect(rect: BubbleRect, stageWidth: number): 'left' | 'right' | 'center' {
  const cx = rect.x + rect.width / 2;
  if (cx < stageWidth * 0.42) return 'left';
  if (cx > stageWidth * 0.58) return 'right';
  return 'center';
}

/**
 * 智能多类型气泡求解器：
 *   1. 去重并按语义优先级截取前 MAX_VISIBLE_BUBBLES（3 个）；
 *   2. 依序尝试「避开已有气泡+障碍物+脸身保护区」→「避开已有气泡+障碍物」→「垂直扫描/裁剪」；
 *   3. 极端矮/窄舞台降级为水平等宽分栏，数学保证 100% 在舞台内且两两不重叠。
 */
export function computeSmartBubbleLayout(
  stage: StageBox,
  active: readonly ActiveBubbleItem[],
  context: BubbleStageContext = {},
): SmartBubbleLayout {
  const safeStage: StageBox = {
    width: Math.max(80, Math.floor(stage.width)),
    height: Math.max(48, Math.floor(stage.height)),
  };
  const preferredSide = resolvePreferredSide(context);
  const anchor = normalizeAnchor(context.anchor);
  const anchorPx = {
    x: safeStage.width * anchor.xRatio,
    y: safeStage.height * anchor.headYRatio,
  };

  const dedup = new Map<BubbleKind, ActiveBubbleItem>();
  for (const item of active) {
    if (item.text.trim() !== '') dedup.set(item.kind, item);
  }
  const selected = [...dedup.values()]
    .sort((a, b) => resolveBubbleStyle(b.kind, b.mood).priority - resolveBubbleStyle(a.kind, a.mood).priority)
    .slice(0, MAX_VISIBLE_BUBBLES);

  if (selected.length === 0) {
    return { items: {}, ordered: [], preferredSide };
  }

  const margin = safeStage.width < 280 ? 4 : 6;
  const gap = safeStage.height < 140 ? 4 : 8;
  const bottomLimit = safeStage.height > 150 ? safeStage.height - 28 : safeStage.height - margin;
  const occupied = context.occupied ?? [];
  const singleBubble = selected.length === 1;
  const guardW = Math.round(safeStage.width * 0.28);
  const guardTop = Math.round(safeStage.height * Math.max(0.28, anchor.headYRatio - 0.06));
  const avatarGuard: BubbleRect | null = safeStage.width >= 300 && safeStage.height >= 180
    ? {
        x: Math.round(anchorPx.x - guardW / 2),
        y: guardTop,
        width: guardW,
        height: Math.max(36, bottomLimit - guardTop),
      }
    : null;
  const leftWingAvailW = avatarGuard === null ? 0 : avatarGuard.x - margin - 4;
  const rightWingAvailW = avatarGuard === null
    ? 0
    : safeStage.width - margin - (avatarGuard.x + avatarGuard.width + 4);
  const obstaclesWithAvatar = avatarGuard !== null ? [...occupied, avatarGuard] : occupied;

  const sized = selected.map((item) => ({
    item,
    style: resolveBubbleStyle(item.kind, item.mood),
    size: estimateBubbleSize({
      kind: item.kind,
      text: item.text,
      stage: safeStage,
      activeCount: selected.length,
      fontScale: context.fontScale,
      mood: item.mood,
    }),
  }));

  const placedRects: BubbleRect[] = [];
  let needHorizontalFallback = false;

  for (const entry of sized) {
    const isPrimary = entry.item.kind === 'dialog' || entry.item.kind === 'reaction' || entry.item.kind === 'hint';
    const targetSideW = entry.item.kind === 'legacy'
      ? rightWingAvailW
      : isPrimary
        ? (preferredSide === 'right' ? rightWingAvailW : leftWingAvailW)
        : (preferredSide === 'right' ? leftWingAvailW : rightWingAvailW);
    let sideCompact: { width: number; height: number } | null = null;
    if (avatarGuard !== null && targetSideW >= 104 && entry.size.width > targetSideW) {
      const est = estimateBubbleSize({
        kind: entry.item.kind,
        text: entry.item.text,
        stage: safeStage,
        activeCount: 1,
        fontScale: context.fontScale,
        mood: entry.item.mood,
        overrideWidth: targetSideW,
      });
      sideCompact = {
        width: est.width,
        height: Math.max(24, Math.min(Math.floor(safeStage.height * 0.44), est.height)),
      };
    }

    const candidates = buildCandidates(
      entry.item.kind,
      entry.size,
      sideCompact,
      safeStage,
      anchorPx,
      preferredSide,
      singleBubble,
      margin,
      bottomLimit,
    );

    const matchClear = candidates.find(
      (c) => !overlapsAny(c, placedRects, gap) && !overlapsAny(c, obstaclesWithAvatar, 2),
    );
    const matchBoth = matchClear ?? candidates.find(
      (c) => !overlapsAny(c, placedRects, gap) && !overlapsAny(c, occupied, 2),
    );
    const slotWithObstacles = matchBoth
      ?? (occupied.length > 0
        ? findGridSlot(entry.size, placedRects, occupied, safeStage, preferredSide, margin, gap, bottomLimit)
        : null);
    const matchPlaced = slotWithObstacles ?? candidates.find((c) => !overlapsAny(c, placedRects, gap));
    const slot = matchPlaced ?? findGridSlot(entry.size, placedRects, [], safeStage, preferredSide, margin, gap, bottomLimit);

    if (slot === null) {
      needHorizontalFallback = true;
      break;
    }
    placedRects.push(slot);
  }

  if (needHorizontalFallback) {
    placedRects.length = 0;
    const n = sized.length;
    const usableW = Math.max(24 * n, safeStage.width - margin * 2 - gap * (n - 1));
    const colW = Math.max(16, Math.floor(usableW / n));
    const maxColH = Math.max(18, safeStage.height - margin * 2);
    for (let i = 0; i < n; i += 1) {
      const h = Math.min(sized[i]!.size.height, maxColH);
      placedRects.push({
        x: margin + i * (colW + gap),
        y: margin,
        width: colW,
        height: h,
      });
    }
  }

  const items: Partial<Record<BubbleKind, PlacedBubble>> = {};
  const ordered: PlacedBubble[] = [];
  for (let i = 0; i < sized.length; i += 1) {
    const entry = sized[i]!;
    const kind = entry.item.kind;
    const rect = placedRects[i]!;
    const placed: PlacedBubble = {
      kind,
      ...(entry.item.mood !== undefined && entry.item.mood !== null ? { mood: entry.item.mood } : {}),
      rect,
      tail: resolveTailDirection(kind, rect, anchorPx, entry.style.tailKind),
      side: sideOfRect(rect, safeStage.width),
      maxLines: entry.style.maxLines,
    };
    items[kind] = placed;
    ordered.push(placed);
  }

  return { items, ordered, preferredSide };
}

/**
 * 向后兼容双轨布局纯函数：供仅查询默认 thought/dialog 矩形的调用方与单测使用。
 * 保证永远不重叠、在舞台内且为底部饭碗留出空间。
 */
export function computeBubbleLayout(stage: StageBox, context: BubbleStageContext = {}): BubbleLayout {
  const smart = computeSmartBubbleLayout(
    stage,
    [
      { kind: 'thought', text: '内心思考着接下来要做的事情和计划安排' },
      { kind: 'dialog', text: '这里是默认正式对话气泡区域，展示完整回复内容！' },
    ],
    context,
  );
  return {
    thought: smart.items.thought!.rect,
    dialog: smart.items.dialog!.rect,
  };
}
