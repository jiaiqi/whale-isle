/**
 * 星露谷像素表后处理（T-M6-62）。
 *
 * 输入：AI 生成的 4×4 网格像素风精灵图（行序 下/右/上/左，列序 待机+3 行走帧）。
 * 输出：96×128 PNG（每帧 16×32，兼容旧版 64×128），供 SMAPI Mod 直接加载。
 *
 * 铁律：
 *   - 四边连通洪水填充去白底（复用 image-pipeline，绝不全局删白）；
 *   - **整表统一等比缩放 + 每格脚底对齐**：以全部帧中最高的内容为 32px 基准，
 *     所有帧共用同一缩放系数，避免逐帧独立缩放导致走路时头忽大忽小/上下跳；
 *   - **最近邻（Nearest-Neighbor）整数采样**：输出颜色只能是输入颜色的子集，
 *     绝不用双线性/双三次插值（像素风一模糊就废）；
 *   - 纯函数零 I/O，便于单测。
 */
import { contentBounds, keyWhiteBackground, type Bounds, type RawImage } from './image-pipeline';

export const SPRITE_COLS = 6;
export const SPRITE_ROWS = 4;
export const SPRITE_CELL_W = 16;
export const SPRITE_CELL_H = 32;
// 列序：0 待机 · 1-3 行走 · 4 动作（挥工具/抛竿/吃）· 5 表情（开心/生气/惊讶）
export const SPRITE_SHEET_W = SPRITE_COLS * SPRITE_CELL_W; // 96
export const SPRITE_SHEET_H = SPRITE_ROWS * SPRITE_CELL_H; // 128
/** 兼容早期 4 列（64×128）像素表：缺动作/表情列时回退待机 */
export const LEGACY_SPRITE_SHEET_W = 64;

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
 * 把一个格子的内容按「整表基准高度」缩放后放进 16×32 目标格：
 * 底边贴格底、水平居中；宽度超出 16px 时居中裁两侧。
 */
function placeCell(
  cell: { image: RawImage; bounds: Bounds | null },
  referenceHeight: number,
): RawImage {
  const out = makeImage(SPRITE_CELL_W, SPRITE_CELL_H);
  const bounds = cell.bounds;
  if (bounds === null) return out;
  // 全局同一缩放系数：最高的一帧刚好 32px，其余帧按真实比例变矮，不逐帧拉伸
  const scale = SPRITE_CELL_H / Math.max(1, referenceHeight);
  const destW = Math.max(1, Math.round(bounds.width * scale));
  const destH = Math.max(1, Math.min(SPRITE_CELL_H, Math.round(bounds.height * scale)));
  const sampled = nearestNeighborSample(cell.image, bounds, destW, destH);
  const cropX = Math.max(0, Math.round((destW - SPRITE_CELL_W) / 2)); // destW>16 时居中裁两侧
  const offsetX = Math.max(0, Math.round((SPRITE_CELL_W - destW) / 2)); // destW<16 时居中留透明边
  const offsetY = SPRITE_CELL_H - destH; // 脚底贴格底
  for (let y = 0; y < destH; y += 1) {
    for (let x = 0; x < SPRITE_CELL_W; x += 1) {
      const srcX = x + cropX;
      if (srcX >= destW) continue;
      const srcIndex = (y * destW + srcX) * 4;
      const destIndex = ((offsetY + y) * SPRITE_CELL_W + (offsetX + x)) * 4;
      out.data[destIndex] = sampled.data[srcIndex]!;
      out.data[destIndex + 1] = sampled.data[srcIndex + 1]!;
      out.data[destIndex + 2] = sampled.data[srcIndex + 2]!;
      out.data[destIndex + 3] = sampled.data[srcIndex + 3]!;
    }
  }
  return out;
}

/** 单格独立缩放（保留给外部单帧工具用；整表构建走 placeCell + 全局基准高度）。 */
export function fitCellToSprite(
  source: RawImage,
  cellRect: Bounds,
): { image: RawImage; empty: boolean; contentBounds: Bounds | null } {
  const cell = cropCell(source, cellRect);
  if (cell.bounds === null) return { image: makeImage(SPRITE_CELL_W, SPRITE_CELL_H), empty: true, contentBounds: null };
  return { image: placeCell(cell, cell.bounds.height), empty: false, contentBounds: cell.bounds };
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
 * 完整流水线：去白底 → 4×6 网格切分 → 每格脚底对齐最近邻缩放 → 96×128。
 * 直接修改传入的 raw（去白底），调用方应传副本。
 *
 * 切格不按画布均分：AI 出图的 6 列常有自己的列距/左边距（真机实测列心 182px、列距 235px，
 * 而 1536 画布均分是 128px/256px），硬按画布切会把第 1 列切掉半只。这里改为：
 *   - 行：按水平投影找 4 条角色带（找不到 4 条就回落画布均分，保住「空行」语义）；
 *   - 列：逐行按垂直投影聚类出 6 个角色，多则合并最近邻、少则均分最宽段；
 *   - 每格再用内容包围盒做统一比例缩放 + 脚底对齐。
 */
export function buildStardewSpriteSheet(raw: RawImage): SpriteSheetResult {
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

  const sheet = makeImage(SPRITE_SHEET_W, SPRITE_SHEET_H);
  // 第一遍：逐行定位 6 个角色并裁格，找「整表最高内容」作为所有帧共用的缩放基准
  const crops: Array<{ row: number; col: number; image: RawImage; bounds: Bounds | null }> = [];
  let referenceHeight = 1;
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
      if (cell.bounds !== null) referenceHeight = Math.max(referenceHeight, cell.bounds.height);
      crops.push({ row, col, ...cell });
    }
  }
  // 第二遍：统一缩放系数落格，脚底对齐
  const cells: SpriteCellReport[] = [];
  let emptyCells = 0;
  for (const cell of crops) {
    const fitted = placeCell(cell, referenceHeight);
    const empty = cell.bounds === null;
    if (empty) emptyCells += 1;
    cells.push({ row: cell.row, col: cell.col, empty, source: cell.bounds });
    for (let y = 0; y < SPRITE_CELL_H; y += 1) {
      for (let x = 0; x < SPRITE_CELL_W; x += 1) {
        const srcIndex = (y * SPRITE_CELL_W + x) * 4;
        const destIndex = ((cell.row * SPRITE_CELL_H + y) * SPRITE_SHEET_W + (cell.col * SPRITE_CELL_W + x)) * 4;
        sheet.data[destIndex] = fitted.data[srcIndex]!;
        sheet.data[destIndex + 1] = fitted.data[srcIndex + 1]!;
        sheet.data[destIndex + 2] = fitted.data[srcIndex + 2]!;
        sheet.data[destIndex + 3] = fitted.data[srcIndex + 3]!;
      }
    }
  }
  // 缩到 16×32 后：先清轮廓外白晕，再收敛抗锯齿中间色（与星露谷原版色板密度一致）
  cleanEdgeHalo(sheet, 2);
  reducePalette(sheet, 24);
  return { sheet, cells, emptyCells };
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
 * 调色板收敛（中位切分 / median cut）：AI 出图缩到 16×32 后每种颜色只剩几个像素、
 * 抗锯齿产生上千种近似色，按「出现次数取前 N」会把蓝发/肤色挤掉（真机教训）。
 * 中位切分按颜色空间分区，确保每个色域都分到槽位；代表色取桶内出现最多的**原始颜色**，
 * 因此输出颜色始终是输入颜色的子集，绝不混出新色。透明像素不参与。
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

/** 校验一张已生成的 96×128（或旧版 64×128）像素表（供宿主写入前复核）。 */
export function validateSpriteSheet(sheet: RawImage): { ok: boolean; error?: string } {
  const legal = (sheet.width === SPRITE_SHEET_W || sheet.width === LEGACY_SPRITE_SHEET_W) && sheet.height === SPRITE_SHEET_H;
  if (!legal) {
    return { ok: false, error: `像素表必须是 ${SPRITE_SHEET_W}×${SPRITE_SHEET_H}（或旧版 ${LEGACY_SPRITE_SHEET_W}×${SPRITE_SHEET_H}），实际 ${sheet.width}×${sheet.height}` };
  }
  let opaque = 0;
  for (let index = 3; index < sheet.data.length; index += 4) {
    if (sheet.data[index]! > 16) opaque += 1;
  }
  if (opaque === 0) return { ok: false, error: '像素表全透明' };
  return { ok: true };
}

/** 供测试断言：目标图颜色集合必须是源图颜色集合的子集（最近邻不混色）。 */
export function colorSet(image: RawImage): Set<string> {
  const colors = new Set<string>();
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3]! <= 16) continue;
    colors.add(`${image.data[index]},${image.data[index + 1]},${image.data[index + 2]}`);
  }
  return colors;
}

