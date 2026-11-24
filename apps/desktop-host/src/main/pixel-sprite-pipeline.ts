/**
 * 星露谷精灵表后处理（T-M6-62 升级：多清晰度档位 1× / 2× / 4×）。
 *
 * 输入：AI 生成的 4×6 网格精灵图（行序 下/右/上/左，列序 待机+3 行走+动作+表情）。
 * 输出：
 *   - 1x 原版像素：96×128 PNG（每帧 16×32，最近邻缩放 + 24 色收敛，兼容旧版 64×128）；
 *   - 2x 精致像素：192×256 PNG（每帧 32×64，最近邻缩放 + 64 色收敛，保留像素锐度且五官发饰清晰）；
 *   - 4x 高清 Q 版：384×512 PNG（每帧 64×128，预乘 Alpha 区域平均下采样 + 全彩保留，细腻顺滑）。
 *
 * 铁律：
 *   - 四边连通洪水填充去白底（复用 image-pipeline，绝不全局删白）；
 *   - **整表统一等比缩放 + 每格脚底对齐**：以全部帧中最高的内容为单格高度基准，
 *     所有帧共用同一缩放系数，避免逐帧独立缩放导致走路时头忽大忽小/上下跳；
 *   - 1×/2× 像素档严格采用最近邻（Nearest-Neighbor），输出颜色只能是输入颜色的子集；
 *   - 4× 高清档采用预乘 Alpha 区域平均（Area/Box）下采样，避免锯齿断线和白边溢色；
 *   - 纯函数零 I/O，便于单测。
 */
import { contentBounds, keyWhiteBackground, type Bounds, type RawImage } from './image-pipeline';

export type SpriteTier = '1x' | '2x' | '4x';

export const SPRITE_COLS = 6;
export const SPRITE_ROWS = 4;
export const SPRITE_CELL_W = 16;
export const SPRITE_CELL_H = 32;
// 列序：0 待机 · 1-3 行走 · 4 动作（挥工具/抛竿/吃）· 5 表情（开心/生气/惊讶）
export const SPRITE_SHEET_W = SPRITE_COLS * SPRITE_CELL_W; // 96
export const SPRITE_SHEET_H = SPRITE_ROWS * SPRITE_CELL_H; // 128
/** 兼容早期 4 列（64×128）像素表：缺动作/表情列时回退待机 */
export const LEGACY_SPRITE_SHEET_W = 64;

export interface SpriteTierSpec {
  tier: SpriteTier;
  scale: 1 | 2 | 4;
  cellWidth: number;
  cellHeight: number;
  sheetWidth: number;
  sheetHeight: number;
  sampling: 'nearest' | 'area';
  /** null 表示全彩保留，不做中位切分调色板压缩 */
  maxColors: number | null;
  haloPasses: number;
  label: string;
  hint: string;
}

export const SPRITE_TIER_SPECS: Readonly<Record<SpriteTier, SpriteTierSpec>> = {
  '1x': {
    tier: '1x',
    scale: 1,
    cellWidth: 16,
    cellHeight: 32,
    sheetWidth: 96,
    sheetHeight: 128,
    sampling: 'nearest',
    maxColors: 24,
    haloPasses: 2,
    label: '1× 原版像素',
    hint: '96×128（每帧 16×32）· 24 色硬边像素，与原版农夫 1:1 密度',
  },
  '2x': {
    tier: '2x',
    scale: 2,
    cellWidth: 32,
    cellHeight: 64,
    sheetWidth: 192,
    sheetHeight: 256,
    sampling: 'nearest',
    maxColors: 64,
    haloPasses: 2,
    label: '2× 精致像素',
    hint: '192×256（每帧 32×64）· 64 色锐利像素，五官发饰清晰且贴合画风',
  },
  '4x': {
    tier: '4x',
    scale: 4,
    cellWidth: 64,
    cellHeight: 128,
    sheetWidth: 384,
    sheetHeight: 512,
    sampling: 'area',
    maxColors: null,
    haloPasses: 1,
    label: '4× 高清 Q 版',
    hint: '384×512（每帧 64×128）· 全彩平滑缩放，接近桌宠细腻质感',
  },
};

export interface SpriteSheetMeta {
  tier: SpriteTier;
  scale: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
}

export interface SpriteCellReport {
  row: number;
  col: number;
  empty: boolean;
  /** 源格内容包围盒（相对整图） */
  source: Bounds | null;
}

export interface SpriteSheetResult {
  sheet: RawImage;
  cells: SpriteCellReport[];
  emptyCells: number;
  tier: SpriteTier;
  cellWidth: number;
  cellHeight: number;
}

function makeImage(width: number, height: number): RawImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** 最近邻采样：目标像素 (x,y) 取源矩形内 floor(x*sw/dw) 处像素，绝不混合颜色。 */
export function nearestNeighborSample(
  source: RawImage,
  srcRect: Bounds,
  destWidth: number,
  destHeight: number,
): RawImage {
  const dest = makeImage(destWidth, destHeight);
  for (let y = 0; y < destHeight; y += 1) {
    const sy = srcRect.y + Math.min(srcRect.height - 1, Math.floor((y * srcRect.height) / destHeight));
    for (let x = 0; x < destWidth; x += 1) {
      const sx = srcRect.x + Math.min(srcRect.width - 1, Math.floor((x * srcRect.width) / destWidth));
      const srcIndex = (sy * source.width + sx) * 4;
      const destIndex = (y * destWidth + x) * 4;
      dest.data[destIndex] = source.data[srcIndex]!;
      dest.data[destIndex + 1] = source.data[srcIndex + 1]!;
      dest.data[destIndex + 2] = source.data[srcIndex + 2]!;
      dest.data[destIndex + 3] = source.data[srcIndex + 3]!;
    }
  }
  return dest;
}

/**
 * 预乘 Alpha 区域平均（Area/Box）下采样：专供 4× 高清 Q 版使用。
 * 按目标像素对应的源区域覆盖面积加权求平均，并用 Alpha 加权 RGB，
 * 避免透明背景黑/白边渗入轮廓，同时消除缩小后的锯齿断线与摩尔纹。
 */
export function areaDownsample(
  source: RawImage,
  srcRect: Bounds,
  destWidth: number,
  destHeight: number,
): RawImage {
  const dest = makeImage(destWidth, destHeight);
  const scaleX = srcRect.width / destWidth;
  const scaleY = srcRect.height / destHeight;
  for (let y = 0; y < destHeight; y += 1) {
    const sy0 = y * scaleY;
    const sy1 = (y + 1) * scaleY;
    const iy0 = Math.floor(sy0);
    const iy1 = Math.min(srcRect.height - 1, Math.floor(sy1 - 1e-6));
    for (let x = 0; x < destWidth; x += 1) {
      const sx0 = x * scaleX;
      const sx1 = (x + 1) * scaleX;
      const ix0 = Math.floor(sx0);
      const ix1 = Math.min(srcRect.width - 1, Math.floor(sx1 - 1e-6));
      let areaSum = 0;
      let alphaWeightSum = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let iy = iy0; iy <= iy1; iy += 1) {
        const wy = Math.min(iy + 1, sy1) - Math.max(iy, sy0);
        if (wy <= 0) continue;
        const rowOffset = (srcRect.y + iy) * source.width;
        for (let ix = ix0; ix <= ix1; ix += 1) {
          const wx = Math.min(ix + 1, sx1) - Math.max(ix, sx0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const srcIndex = (rowOffset + srcRect.x + ix) * 4;
          const a = source.data[srcIndex + 3]! / 255;
          const aw = weight * a;
          areaSum += weight;
          alphaWeightSum += aw;
          rSum += source.data[srcIndex]! * aw;
          gSum += source.data[srcIndex + 1]! * aw;
          bSum += source.data[srcIndex + 2]! * aw;
        }
      }
      const destIndex = (y * destWidth + x) * 4;
      if (areaSum <= 0 || alphaWeightSum <= 1e-5) {
        dest.data[destIndex + 3] = 0;
        continue;
      }
      const outAlpha = Math.round(Math.min(1, alphaWeightSum / areaSum) * 255);
      // 极低透明度的残影直接归零，保持轮廓干净
      if (outAlpha < 12) {
        dest.data[destIndex + 3] = 0;
        continue;
      }
      dest.data[destIndex] = Math.min(255, Math.round(rSum / alphaWeightSum));
      dest.data[destIndex + 1] = Math.min(255, Math.round(gSum / alphaWeightSum));
      dest.data[destIndex + 2] = Math.min(255, Math.round(bSum / alphaWeightSum));
      dest.data[destIndex + 3] = outAlpha;
    }
  }
  return dest;
}

/** 裁出源图中的一个网格单元（保持原始像素，不做缩放）。 */
function cropCell(source: RawImage, cellRect: Bounds): { image: RawImage; bounds: Bounds | null } {
  const image = makeImage(cellRect.width, cellRect.height);
  for (let y = 0; y < cellRect.height; y += 1) {
    for (let x = 0; x < cellRect.width; x += 1) {
      const srcIndex = ((cellRect.y + y) * source.width + (cellRect.x + x)) * 4;
      const destIndex = (y * cellRect.width + x) * 4;
      image.data[destIndex] = source.data[srcIndex]!;
      image.data[destIndex + 1] = source.data[srcIndex + 1]!;
      image.data[destIndex + 2] = source.data[srcIndex + 2]!;
      image.data[destIndex + 3] = source.data[srcIndex + 3]!;
    }
  }
  return { image, bounds: contentBounds(image) };
}

/**
 * 把一个格子的内容按「整表统一缩放系数」放进目标格：
 * 底边贴格底、水平居中；同时受全表最大高度与最大宽度双重约束，绝不左右裁切头发/耳朵/手臂。
 */
function placeCell(
  cell: { image: RawImage; bounds: Bounds | null },
  referenceHeight: number,
  referenceWidth: number,
  spec: SpriteTierSpec,
): RawImage {
  const out = makeImage(spec.cellWidth, spec.cellHeight);
  const bounds = cell.bounds;
  if (bounds === null) return out;
  // 2x/4x 留出 1-2px 安全水平边距，防止蓬松长发/发饰贴紧格子边缘
  const padX = spec.scale >= 4 ? 2 : spec.scale >= 2 ? 1 : 0;
  const maxContentW = Math.max(1, spec.cellWidth - padX * 2);
  // 全局同一缩放系数：同时确保最高帧不超格高、最宽帧不超格宽，零裁切且全表等比例不上下跳
  const scale = Math.min(
    spec.cellHeight / Math.max(1, referenceHeight),
    maxContentW / Math.max(1, referenceWidth),
  );
  const destW = Math.max(1, Math.min(spec.cellWidth, Math.round(bounds.width * scale)));
  const destH = Math.max(1, Math.min(spec.cellHeight, Math.round(bounds.height * scale)));
  const sampled = spec.sampling === 'area'
    ? areaDownsample(cell.image, bounds, destW, destH)
    : nearestNeighborSample(cell.image, bounds, destW, destH);
  const offsetX = Math.max(0, Math.round((spec.cellWidth - destW) / 2));
  const offsetY = spec.cellHeight - destH; // 脚底贴格底
  for (let y = 0; y < destH; y += 1) {
    for (let x = 0; x < destW; x += 1) {
      const srcIndex = (y * destW + x) * 4;
      const destIndex = ((offsetY + y) * spec.cellWidth + (offsetX + x)) * 4;
      out.data[destIndex] = sampled.data[srcIndex]!;
      out.data[destIndex + 1] = sampled.data[srcIndex + 1]!;
      out.data[destIndex + 2] = sampled.data[srcIndex + 2]!;
      out.data[destIndex + 3] = sampled.data[srcIndex + 3]!;
    }
  }
  return out;
}

/** 单格独立缩放（保留给外部单帧工具用；整表构建走 placeCell + 全局基准宽高）。 */
export function fitCellToSprite(
  source: RawImage,
  cellRect: Bounds,
  tier: SpriteTier = '1x',
): { image: RawImage; empty: boolean; contentBounds: Bounds | null } {
  const spec = SPRITE_TIER_SPECS[tier];
  const cell = cropCell(source, cellRect);
  if (cell.bounds === null) return { image: makeImage(spec.cellWidth, spec.cellHeight), empty: true, contentBounds: null };
  return { image: placeCell(cell, cell.bounds.height, cell.bounds.width, spec), empty: false, contentBounds: cell.bounds };
}

/** 一维内容投影的连续区间（含首尾）。间隔 ≤ mergeGap 的相邻区间合并，避免头发/工具被拆碎。 */
interface Span {
  start: number;
  end: number;
}

function projectionSpans(counts: number[], minCount: number, mergeGap: number): Span[] {
  const spans: Span[] = [];
  let start = -1;
  let last = -1;
  for (let index = 0; index < counts.length; index += 1) {
    if ((counts[index] ?? 0) > minCount) {
      if (start === -1) start = index;
      last = index;
    } else if (start !== -1 && index - last > mergeGap) {
      spans.push({ start, end: last });
      start = -1;
      last = -1;
    }
  }
  if (start !== -1) spans.push({ start, end: last });
  return spans;
}

/** 把区间数规整到 target：多则合并最近邻，少则均分最宽段；整行空白时按画布均分占位。 */
function normalizeSpans(spans: Span[], target: number, totalWidth: number): Span[] {
  const out = spans.map((span) => ({ ...span }));
  while (out.length > target) {
    let mergeIndex = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let index = 0; index < out.length - 1; index += 1) {
      const gap = out[index + 1]!.start - out[index]!.end;
      if (gap < bestGap) {
        bestGap = gap;
        mergeIndex = index;
      }
    }
    out.splice(mergeIndex, 2, { start: out[mergeIndex]!.start, end: out[mergeIndex + 1]!.end });
  }
  while (out.length < target) {
    if (out.length === 0) {
      for (let index = 0; index < target; index += 1) {
        const start = Math.round((index * totalWidth) / target);
        const end = Math.max(start, Math.round(((index + 1) * totalWidth) / target) - 1);
        out.push({ start, end });
      }
      break;
    }
    let widest = 0;
    for (let index = 1; index < out.length; index += 1) {
      if (out[index]!.end - out[index]!.start > out[widest]!.end - out[widest]!.start) widest = index;
    }
    const span = out[widest]!;
    // 只剩一整段且目标就是 6 列时，直接均分成 6 份，避免反复二分切出不均匀的格
    const parts = out.length === 1 && target === SPRITE_COLS ? target : 2;
    const width = span.end - span.start + 1;
    const replacements: Span[] = [];
    for (let part = 0; part < parts; part += 1) {
      const start = span.start + Math.round((part * width) / parts);
      const end = Math.max(start, span.start + Math.round(((part + 1) * width) / parts) - 1);
      replacements.push({ start, end });
    }
    out.splice(widest, 1, ...replacements);
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 完整流水线：去白底 → 4×6 网格切分 → 每格脚底对齐缩放 → 目标分辨率精灵表。
 * 直接修改传入的 raw（去白底），调用方应传副本。
 *
 * 切格不按画布均分：AI 出图的 6 列常有自己的列距/左边距，硬按画布切会把第 1 列切掉半只。
 * 这里按水平投影找 4 条角色带，再逐行按垂直投影聚类出 6 个角色；每格用全局统一缩放系数落格。
 */
export function buildStardewSpriteSheet(
  raw: RawImage,
  options?: { tier?: SpriteTier },
): SpriteSheetResult {
  const tier: SpriteTier = options?.tier ?? '1x';
  const spec = SPRITE_TIER_SPECS[tier];
  keyWhiteBackground(raw);
  if (contentBounds(raw) === null) throw new Error('图片没有可见内容（全透明/全白）');

  const rowCounts = new Array<number>(raw.height).fill(0);
  for (let y = 0; y < raw.height; y += 1) {
    for (let x = 0; x < raw.width; x += 1) {
      if (raw.data[(y * raw.width + x) * 4 + 3]! > 16) rowCounts[y] = (rowCounts[y] ?? 0) + 1;
    }
  }
  let rowBands = projectionSpans(rowCounts, 0, 4).filter((span) => span.end - span.start + 1 >= raw.height * 0.02);
  if (rowBands.length !== SPRITE_ROWS) {
    // 空行/缺行时仍保留固定 4 行槽位，绝不把两行内容挤成四行
    rowBands = Array.from({ length: SPRITE_ROWS }, (_, row) => ({
      start: Math.round((row * raw.height) / SPRITE_ROWS),
      end: Math.max(Math.round((row * raw.height) / SPRITE_ROWS), Math.round(((row + 1) * raw.height) / SPRITE_ROWS) - 1),
    }));
  }

  const sheet = makeImage(spec.sheetWidth, spec.sheetHeight);
  // 第一遍：逐行定位 6 个角色并裁格，找「整表最高与最宽内容」作为所有帧共用的缩放基准
  const crops: Array<{ row: number; col: number; image: RawImage; bounds: Bounds | null }> = [];
  let referenceHeight = 1;
  let referenceWidth = 1;
  for (let row = 0; row < SPRITE_ROWS; row += 1) {
    const band = rowBands[row]!;
    const colCounts = new Array<number>(raw.width).fill(0);
    for (let y = band.start; y <= band.end; y += 1) {
      for (let x = 0; x < raw.width; x += 1) {
        if (raw.data[(y * raw.width + x) * 4 + 3]! > 16) colCounts[x] = (colCounts[x] ?? 0) + 1;
      }
    }
    const minSpanWidth = Math.max(4, Math.round(raw.width * 0.01));
    const spans = normalizeSpans(
      projectionSpans(colCounts, 0, 2).filter((span) => span.end - span.start + 1 >= minSpanWidth),
      SPRITE_COLS,
      raw.width,
    );
    for (let col = 0; col < SPRITE_COLS; col += 1) {
      const span = spans[col]!;
      const cellRect: Bounds = {
        x: span.start,
        y: band.start,
        width: Math.max(1, span.end - span.start + 1),
        height: Math.max(1, band.end - band.start + 1),
      };
      const cell = cropCell(raw, cellRect);
      if (cell.bounds !== null) {
        referenceHeight = Math.max(referenceHeight, cell.bounds.height);
        referenceWidth = Math.max(referenceWidth, cell.bounds.width);
      }
      crops.push({ row, col, ...cell });
    }
  }
  // 第二遍：统一缩放系数落格，脚底对齐且绝不裁切左右边缘
  const cells: SpriteCellReport[] = [];
  let emptyCells = 0;
  for (const cell of crops) {
    const fitted = placeCell(cell, referenceHeight, referenceWidth, spec);
    const empty = cell.bounds === null;
    if (empty) emptyCells += 1;
    cells.push({ row: cell.row, col: cell.col, empty, source: cell.bounds });
    for (let y = 0; y < spec.cellHeight; y += 1) {
      for (let x = 0; x < spec.cellWidth; x += 1) {
        const srcIndex = (y * spec.cellWidth + x) * 4;
        const destIndex = ((cell.row * spec.cellHeight + y) * spec.sheetWidth + (cell.col * spec.cellWidth + x)) * 4;
        sheet.data[destIndex] = fitted.data[srcIndex]!;
        sheet.data[destIndex + 1] = fitted.data[srcIndex + 1]!;
        sheet.data[destIndex + 2] = fitted.data[srcIndex + 2]!;
        sheet.data[destIndex + 3] = fitted.data[srcIndex + 3]!;
      }
    }
  }
  // 先清轮廓外白晕，再按档位决定是否做调色板收敛（4x 高清 Q 版保留全彩渐变）
  cleanEdgeHalo(sheet, spec.haloPasses);
  if (spec.maxColors !== null) reducePalette(sheet, spec.maxColors);
  return {
    sheet,
    cells,
    emptyCells,
    tier,
    cellWidth: spec.cellWidth,
    cellHeight: spec.cellHeight,
  };
}

/**
 * 清理角色轮廓外侧的近白抗锯齿光晕：只删除「本身近白且 4 邻域有透明像素」的边缘像素，
 * 被深色描边包围的白围裙/白头饰不受影响。否则这些白晕会占满调色板，挤掉蓝发与肤色。
 */
export function cleanEdgeHalo(image: RawImage, passes = 2): number {
  let removed = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const clear: number[] = [];
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const index = (y * image.width + x) * 4;
        if (image.data[index + 3]! <= 0) continue;
        const r = image.data[index]!;
        const g = image.data[index + 1]!;
        const b = image.data[index + 2]!;
        const min = Math.min(r, g, b);
        const max = Math.max(r, g, b);
        if (min < 225 || max - min > 20) continue;
        const transparentNeighbor =
          (x > 0 && image.data[index - 4 + 3]! <= 0)
          || (x < image.width - 1 && image.data[index + 4 + 3]! <= 0)
          || (y > 0 && image.data[index - image.width * 4 + 3]! <= 0)
          || (y < image.height - 1 && image.data[index + image.width * 4 + 3]! <= 0);
        if (transparentNeighbor) clear.push(index);
      }
    }
    for (const index of clear) image.data[index + 3] = 0;
    removed += clear.length;
  }
  return removed;
}

/**
 * 调色板收敛（中位切分 / median cut）：确保每个色域都分到槽位；
 * 代表色取桶内出现最多的**原始颜色**，因此输出颜色始终是输入颜色的子集，绝不混出新色。
 */
interface PaletteEntry {
  rgb: [number, number, number];
  count: number;
}

export function reducePalette(image: RawImage, maxColors = 24): number {
  const counts = new Map<number, number>();
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3]! < 16) continue;
    const rgb = (image.data[index]! << 16) | (image.data[index + 1]! << 8) | image.data[index + 2]!;
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  if (counts.size <= maxColors) return counts.size;
  const initial: PaletteEntry[] = [...counts.entries()].map(([rgb, count]) => ({
    rgb: [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff],
    count,
  }));
  const buckets: PaletteEntry[][] = [initial];
  while (buckets.length < maxColors) {
    let target = -1;
    let targetRange = -1;
    let targetChannel = 0;
    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
      const bucket = buckets[bucketIndex]!;
      if (bucket.length < 2) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        let min = 255;
        let max = 0;
        for (const entry of bucket) {
          const value = entry.rgb[channel]!;
          if (value < min) min = value;
          if (value > max) max = value;
        }
        if (max - min > targetRange) {
          targetRange = max - min;
          target = bucketIndex;
          targetChannel = channel;
        }
      }
    }
    if (target === -1 || targetRange <= 0) break;
    const bucket = buckets[target]!;
    bucket.sort((a, b) => a.rgb[targetChannel]! - b.rgb[targetChannel]! || a.rgb[0] - b.rgb[0] || a.rgb[1] - b.rgb[1] || a.rgb[2] - b.rgb[2]);
    const total = bucket.reduce((sum, entry) => sum + entry.count, 0);
    let split = 1;
    let accumulated = bucket[0]!.count;
    while (split < bucket.length && accumulated < total / 2) {
      accumulated += bucket[split]!.count;
      split += 1;
    }
    split = Math.min(Math.max(1, split), bucket.length - 1);
    buckets.splice(target, 1, bucket.slice(0, split), bucket.slice(split));
  }
  // 代表色：桶内出现次数最多的原始颜色（保证是输入颜色的子集）
  const palette = buckets.map((bucket) => bucket.reduce((best, entry) => (entry.count > best.count ? entry : best)).rgb);
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3]! < 16) continue;
    const r = image.data[index]!;
    const g = image.data[index + 1]!;
    const b = image.data[index + 2]!;
    let best = palette[0]!;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const color of palette) {
      const dr = r - color[0];
      const dg = g - color[1];
      const db = b - color[2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = color;
      }
    }
    image.data[index] = best[0];
    image.data[index + 1] = best[1];
    image.data[index + 2] = best[2];
  }
  return palette.length;
}

/** 根据精灵表像素宽高识别档位与网格（支持 1×/2×/4× 的 6 列与旧版 4 列）。 */
export function detectSpriteSheetMeta(width: number, height: number): SpriteSheetMeta | null {
  if (height <= 0 || height % SPRITE_ROWS !== 0) return null;
  const cellHeight = height / SPRITE_ROWS;
  if (cellHeight % 2 !== 0) return null;
  const cellWidth = cellHeight / 2;
  if (width <= 0 || width % cellWidth !== 0) return null;
  const cols = width / cellWidth;
  if (cols !== 6 && cols !== 4) return null;
  const scale = cellWidth / SPRITE_CELL_W;
  if (scale !== 1 && scale !== 2 && scale !== 4) return null;
  const tier: SpriteTier = scale === 4 ? '4x' : scale === 2 ? '2x' : '1x';
  return { tier, scale, cols, rows: SPRITE_ROWS, cellWidth, cellHeight, width, height };
}

/** 直接从 PNG 二进制 IHDR 头读取宽高（零图像解码开销；非 PNG 返回 null）。 */
export function readPngDimensions(buffer: Uint8Array): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47
    || buffer[4] !== 0x0d || buffer[5] !== 0x0a || buffer[6] !== 0x1a || buffer[7] !== 0x0a
  ) return null;
  const width = ((buffer[16]! << 24) | (buffer[17]! << 16) | (buffer[18]! << 8) | buffer[19]!) >>> 0;
  const height = ((buffer[20]! << 24) | (buffer[21]! << 16) | (buffer[22]! << 8) | buffer[23]!) >>> 0;
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** 校验一张已生成的 1×/2×/4× 精灵表（支持 6 列及旧版 4 列）。 */
export function validateSpriteSheet(sheet: RawImage): { ok: boolean; error?: string; meta?: SpriteSheetMeta } {
  const meta = detectSpriteSheetMeta(sheet.width, sheet.height);
  if (meta === null) {
    return {
      ok: false,
      error: `精灵表尺寸必须是 96×128（1×）、192×256（2×）或 384×512（4×）（兼容 4 列旧图），实际 ${sheet.width}×${sheet.height}`,
    };
  }
  let opaque = 0;
  for (let index = 3; index < sheet.data.length; index += 4) {
    if (sheet.data[index]! > 16) opaque += 1;
  }
  if (opaque === 0) return { ok: false, error: '精灵表全透明' };
  return { ok: true, meta };
}

/** 供测试断言：目标图颜色集合必须是源图颜色集合的子集（最近邻不混色）。 */
export function colorSet(image: RawImage): Set<string> {
  const colors = new Set<string>();
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index]! <= 16) continue;
    colors.add(`${image.data[index - 3]},${image.data[index - 2]},${image.data[index - 1]}`);
  }
  return colors;
}
