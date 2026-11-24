/**
 * 星露谷像素表后处理（T-M6-62）。
 *
 * 输入：AI 生成的 4×4 网格像素风精灵图（行序 下/右/上/左，列序 待机+3 行走帧）。
 * 输出：64×128 PNG（每帧 16×32），供 SMAPI Mod 直接加载。
 *
 * 铁律：
 *   - 四边连通洪水填充去白底（复用 image-pipeline，绝不全局删白）；
 *   - 每格内容独立「脚底对齐」：内容底边贴格底、水平居中；
 *   - **最近邻（Nearest-Neighbor）整数采样**：输出颜色只能是输入颜色的子集，
 *     绝不用双线性/双三次插值（像素风一模糊就废）；
 *   - 纯函数零 I/O，便于单测。
 */
import { contentBounds, keyWhiteBackground, type Bounds, type RawImage } from './image-pipeline';

export const SPRITE_COLS = 4;
export const SPRITE_ROWS = 4;
export const SPRITE_CELL_W = 16;
export const SPRITE_CELL_H = 32;
export const SPRITE_SHEET_W = SPRITE_COLS * SPRITE_CELL_W; // 64
export const SPRITE_SHEET_H = SPRITE_ROWS * SPRITE_CELL_H; // 128

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

/** 源格内容 → 16×32 目标格：等比缩放到能放下，底边贴格底、水平居中。 */
export function fitCellToSprite(
  source: RawImage,
  cellRect: Bounds,
): { image: RawImage; empty: boolean; contentBounds: Bounds | null } {
  const cellImage: RawImage = {
    width: cellRect.width,
    height: cellRect.height,
    data: new Uint8ClampedArray(cellRect.width * cellRect.height * 4),
  };
  for (let y = 0; y < cellRect.height; y += 1) {
    for (let x = 0; x < cellRect.width; x += 1) {
      const srcIndex = ((cellRect.y + y) * source.width + (cellRect.x + x)) * 4;
      const destIndex = (y * cellRect.width + x) * 4;
      cellImage.data[destIndex] = source.data[srcIndex]!;
      cellImage.data[destIndex + 1] = source.data[srcIndex + 1]!;
      cellImage.data[destIndex + 2] = source.data[srcIndex + 2]!;
      cellImage.data[destIndex + 3] = source.data[srcIndex + 3]!;
    }
  }
  const bounds = contentBounds(cellImage);
  if (bounds === null) return { image: makeImage(SPRITE_CELL_W, SPRITE_CELL_H), empty: true, contentBounds: null };
  const scale = Math.min(SPRITE_CELL_W / bounds.width, SPRITE_CELL_H / bounds.height);
  const destW = Math.max(1, Math.round(bounds.width * scale));
  const destH = Math.max(1, Math.round(bounds.height * scale));
  const sampled = nearestNeighborSample(cellImage, bounds, destW, destH);
  const out = makeImage(SPRITE_CELL_W, SPRITE_CELL_H);
  const offsetX = Math.round((SPRITE_CELL_W - destW) / 2);
  const offsetY = SPRITE_CELL_H - destH; // 脚底贴格底
  for (let y = 0; y < destH; y += 1) {
    for (let x = 0; x < destW; x += 1) {
      const srcIndex = (y * destW + x) * 4;
      const destIndex = ((offsetY + y) * SPRITE_CELL_W + (offsetX + x)) * 4;
      out.data[destIndex] = sampled.data[srcIndex]!;
      out.data[destIndex + 1] = sampled.data[srcIndex + 1]!;
      out.data[destIndex + 2] = sampled.data[srcIndex + 2]!;
      out.data[destIndex + 3] = sampled.data[srcIndex + 3]!;
    }
  }
  return { image: out, empty: false, contentBounds: bounds };
}

/**
 * 完整流水线：去白底 → 4×4 网格切分 → 每格脚底对齐最近邻缩放 → 64×128。
 * 直接修改传入的 raw（去白底），调用方应传副本。
 */
export function buildStardewSpriteSheet(raw: RawImage): SpriteSheetResult {
  keyWhiteBackground(raw);
  const bounds = contentBounds(raw);
  if (bounds === null) throw new Error('图片没有可见内容（全透明/全白）');
  const gridW = Math.floor(bounds.width / SPRITE_COLS);
  const gridH = Math.floor(bounds.height / SPRITE_ROWS);
  if (gridW < 4 || gridH < 4) throw new Error(`图片内容太小（${bounds.width}×${bounds.height}），无法切成 4×4 网格`);
  const sheet = makeImage(SPRITE_SHEET_W, SPRITE_SHEET_H);
  const cells: SpriteCellReport[] = [];
  let emptyCells = 0;
  for (let row = 0; row < SPRITE_ROWS; row += 1) {
    for (let col = 0; col < SPRITE_COLS; col += 1) {
      const cellRect: Bounds = {
        x: bounds.x + col * gridW,
        y: bounds.y + row * gridH,
        width: gridW,
        height: gridH,
      };
      const fitted = fitCellToSprite(raw, cellRect);
      if (fitted.empty) emptyCells += 1;
      cells.push({ row, col, empty: fitted.empty, source: fitted.contentBounds });
      for (let y = 0; y < SPRITE_CELL_H; y += 1) {
        for (let x = 0; x < SPRITE_CELL_W; x += 1) {
          const srcIndex = (y * SPRITE_CELL_W + x) * 4;
          const destIndex = ((row * SPRITE_CELL_H + y) * SPRITE_SHEET_W + (col * SPRITE_CELL_W + x)) * 4;
          sheet.data[destIndex] = fitted.image.data[srcIndex]!;
          sheet.data[destIndex + 1] = fitted.image.data[srcIndex + 1]!;
          sheet.data[destIndex + 2] = fitted.image.data[srcIndex + 2]!;
          sheet.data[destIndex + 3] = fitted.image.data[srcIndex + 3]!;
        }
      }
    }
  }
  return { sheet, cells, emptyCells };
}

/** 校验一张已生成的 64×128 像素表（供宿主写入前复核）。 */
export function validateSpriteSheet(sheet: RawImage): { ok: boolean; error?: string } {
  if (sheet.width !== SPRITE_SHEET_W || sheet.height !== SPRITE_SHEET_H) {
    return { ok: false, error: `像素表必须是 ${SPRITE_SHEET_W}×${SPRITE_SHEET_H}，实际 ${sheet.width}×${sheet.height}` };
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

