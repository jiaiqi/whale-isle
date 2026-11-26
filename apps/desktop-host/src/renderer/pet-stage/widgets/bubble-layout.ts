/**
 * 智能多类型气泡布局纯函数：
 *   - 感知角色位置、朝向、窗口贴边与舞台障碍物（workCards / riceBowl）；
 *   - 根据同屏数量动态放大气泡尺寸，突破旧版 220px 狭窄上限；
 *   - 三阶段防重叠求解 + 极矮/窄舞台水平分栏兜底，保证几何 100% 不重叠且不越界；
 *   - 保留 computeBubbleLayout / rectsOverlap 向后兼容出口。
 */
import {
  bubbleTheme,
  estimateBubbleSize,
  type BubbleKind,
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
export type BubbleTailDirection = 'bottom-left' | 'bottom-right' | 'bottom-center' | 'left' | 'right' | 'none';

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
}

export interface PlacedBubble {
  kind: BubbleKind;
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

/** 计算尾巴朝向：根据气泡相对角色头部的几何方位精确指向角色。 */
export function resolveTailDirection(
  kind: BubbleKind,
  rect: BubbleRect,
  anchorPx: { x: number; y: number },
): BubbleTailDirection {
  if (bubbleTheme(kind).tailKind === 'none') return 'none';
  const cx = rect.x + rect.width / 2;
  const bottom = rect.y + rect.height;
  if (bottom <= anchorPx.y + 18) {
    if (cx < anchorPx.x - 24) return 'bottom-right';
    if (cx > anchorPx.x + 24) return 'bottom-left';
    return 'bottom-center';
  }
  return cx >= anchorPx.x ? 'left' : 'right';
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
    rawList.push(
      { x: cOppX, y: topY, width: cw, height: ch },
      { x: cOppX, y: cMidY, width: cw, height: ch },
      { x: cMainX, y: cMidY, width: cw, height: ch },
    );
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
 *   2. 依序尝试「避开已有气泡+障碍物」→「仅避开已有气泡」→「垂直扫描/裁剪」；
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

  // 去重保留最新同类型气泡，过滤空串
  const dedup = new Map<BubbleKind, ActiveBubbleItem>();
  for (const item of active) {
    if (item.text.trim() !== '') dedup.set(item.kind, item);
  }
  const selected = [...dedup.values()]
    .sort((a, b) => bubbleTheme(b.kind).priority - bubbleTheme(a.kind).priority)
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
  const sideAvailW = avatarGuard === null
    ? 0
    : preferredSide === 'right'
      ? avatarGuard.x - margin - 4
      : safeStage.width - margin - (avatarGuard.x + avatarGuard.width + 4);
  const obstaclesWithAvatar = avatarGuard !== null ? [...occupied, avatarGuard] : occupied;

  const sized = selected.map((item) => ({
    item,
    size: estimateBubbleSize({
      kind: item.kind,
      text: item.text,
      stage: safeStage,
      activeCount: selected.length,
      fontScale: context.fontScale,
    }),
  }));

  const placedRects: BubbleRect[] = [];
  let needHorizontalFallback = false;

  for (const entry of sized) {
    let sideCompact: { width: number; height: number } | null = null;
    if (avatarGuard !== null && sideAvailW >= 104 && entry.size.width > sideAvailW) {
      const est = estimateBubbleSize({
        kind: entry.item.kind,
        text: entry.item.text,
        stage: { width: Math.ceil(sideAvailW / 0.65), height: safeStage.height },
        activeCount: 1,
        fontScale: context.fontScale,
      });
      sideCompact = {
        width: Math.min(sideAvailW, est.width),
        height: Math.max(24, Math.min(Math.floor(safeStage.height * 0.38), est.height)),
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
    const kind = sized[i]!.item.kind;
    const rect = placedRects[i]!;
    const placed: PlacedBubble = {
      kind,
      rect,
      tail: resolveTailDirection(kind, rect, anchorPx),
      side: sideOfRect(rect, safeStage.width),
      maxLines: bubbleTheme(kind).maxLines,
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
