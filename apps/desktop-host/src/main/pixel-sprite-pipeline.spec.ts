/** 星露谷像素表后处理（T-M6-62）：64×128 尺寸、4×4 脚底对齐、最近邻不混色、去白底。 */
import { describe, expect, it } from 'vitest';
import { buildStardewSpriteSheet, colorSet, fitCellToSprite, nearestNeighborSample, validateSpriteSheet, SPRITE_CELL_H, SPRITE_CELL_W, SPRITE_SHEET_H, SPRITE_SHEET_W } from './pixel-sprite-pipeline';
import type { RawImage } from './image-pipeline';

function makeImage(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = fill[0]; data[index + 1] = fill[1]; data[index + 2] = fill[2]; data[index + 3] = fill[3];
  }
  return { width, height, data };
}

function setPixel(image: RawImage, x: number, y: number, rgba: [number, number, number, number]): void {
  const index = (y * image.width + x) * 4;
  image.data[index] = rgba[0]; image.data[index + 1] = rgba[1]; image.data[index + 2] = rgba[2]; image.data[index + 3] = rgba[3];
}

function pixelAt(image: RawImage, x: number, y: number): [number, number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!, image.data[index + 3]!];
}

/** 造一张 256×256 白底 4×4 网格图：每格中心一个 32×32 纯色块（行=方向色，列=帧色变体）。 */
function gridImage(): RawImage {
  const image = makeImage(256, 256, [255, 255, 255, 255]);
  const rowColors: Array<[number, number, number, number]> = [
    [220, 40, 40, 255], [40, 200, 60, 255], [40, 80, 220, 255], [220, 200, 40, 255],
  ];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const base = rowColors[row]!;
      const color: [number, number, number, number] = [base[0], base[1], Math.min(255, base[2] + col * 10), 255];
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          setPixel(image, col * 64 + 16 + x, row * 64 + 16 + y, color);
        }
      }
    }
  }
  return image;
}

describe('nearestNeighborSample', () => {
  it('输出颜色是输入颜色子集（绝不插值混色）', () => {
    const source = makeImage(4, 4);
    setPixel(source, 0, 0, [255, 0, 0, 255]);
    setPixel(source, 1, 0, [0, 0, 255, 255]);
    setPixel(source, 0, 1, [0, 255, 0, 255]);
    setPixel(source, 1, 1, [255, 255, 0, 255]);
    const dest = nearestNeighborSample(source, { x: 0, y: 0, width: 2, height: 2 }, 7, 7);
    const srcColors = colorSet(source);
    for (const color of colorSet(dest)) expect(srcColors.has(color)).toBe(true);
    expect(dest.width).toBe(7);
    expect(dest.height).toBe(7);
  });

  it('缩小采样取最近像素：2×2 → 1×1 取左上', () => {
    const source = makeImage(2, 2);
    setPixel(source, 0, 0, [10, 20, 30, 255]);
    setPixel(source, 1, 0, [200, 0, 0, 255]);
    setPixel(source, 0, 1, [0, 200, 0, 255]);
    setPixel(source, 1, 1, [0, 0, 200, 255]);
    const dest = nearestNeighborSample(source, { x: 0, y: 0, width: 2, height: 2 }, 1, 1);
    expect(pixelAt(dest, 0, 0)).toEqual([10, 20, 30, 255]);
  });
});

describe('fitCellToSprite', () => {
  it('内容脚底贴格底、水平居中；空格子全透明', () => {
    const source = makeImage(64, 64);
    // 内容在格子上半部：32×16 块
    for (let y = 8; y < 24; y += 1) for (let x = 16; x < 48; x += 1) setPixel(source, x, y, [255, 0, 0, 255]);
    const fitted = fitCellToSprite(source, { x: 0, y: 0, width: 64, height: 64 });
    expect(fitted.empty).toBe(false);
    // 底边贴格底：最后一行中心像素不透明
    expect(pixelAt(fitted.image, SPRITE_CELL_W / 2, SPRITE_CELL_H - 1)[3]).toBe(255);
    // 顶行（内容之上）透明
    expect(pixelAt(fitted.image, SPRITE_CELL_W / 2, 0)[3]).toBe(0);
    const empty = fitCellToSprite(makeImage(64, 64), { x: 0, y: 0, width: 64, height: 64 });
    expect(empty.empty).toBe(true);
    expect(colorSet(empty.image).size).toBe(0);
  });
});

describe('buildStardewSpriteSheet', () => {
  it('白底 4×4 网格 → 64×128，行=方向色、列=帧色，白底被抠掉', () => {
    const result = buildStardewSpriteSheet(gridImage());
    expect(result.sheet.width).toBe(SPRITE_SHEET_W);
    expect(result.sheet.height).toBe(SPRITE_SHEET_H);
    expect(result.emptyCells).toBe(0);
    // 第 0 行（朝下）中心像素偏红；第 2 行（朝上）偏蓝
    const down = pixelAt(result.sheet, SPRITE_CELL_W / 2, SPRITE_CELL_H / 2);
    expect(down[0]).toBeGreaterThan(180);
    expect(down[2]).toBeLessThan(120);
    const up = pixelAt(result.sheet, SPRITE_CELL_W / 2, 2 * SPRITE_CELL_H + SPRITE_CELL_H / 2);
    expect(up[2]).toBeGreaterThan(180);
    // 白色背景全部被抠成透明
    expect(pixelAt(result.sheet, 0, 0)[3]).toBe(0);
    // 颜色集合不含白色
    expect(colorSet(result.sheet).has('255,255,255')).toBe(false);
  });

  it('全白/全透明输入如实报错', () => {
    expect(() => buildStardewSpriteSheet(makeImage(128, 128, [255, 255, 255, 255]))).toThrow('没有可见内容');
    expect(() => buildStardewSpriteSheet(makeImage(128, 128))).toThrow('没有可见内容');
  });

  it('中间行缺内容 → 这些格标记 empty 而不是编造像素', () => {
    const image = makeImage(256, 256, [255, 255, 255, 255]);
    // 第 0 行与第 3 行有内容（撑满 4 列），中间两行留空
    for (const row of [0, 3]) {
      for (let col = 0; col < 4; col += 1) {
        for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
          setPixel(image, col * 64 + 16 + x, row * 64 + 16 + y, [50, 50, 200, 255]);
        }
      }
    }
    const result = buildStardewSpriteSheet(image);
    expect(result.cells.filter((cell) => cell.row === 1 || cell.row === 2).every((cell) => cell.empty)).toBe(true);
    expect(result.cells.filter((cell) => cell.row === 0 || cell.row === 3).every((cell) => !cell.empty)).toBe(true);
    expect(result.emptyCells).toBe(8);
  });
});

describe('validateSpriteSheet', () => {
  it('尺寸不符/全透明拒绝；合法通过', () => {
    expect(validateSpriteSheet(makeImage(32, 64)).ok).toBe(false);
    expect(validateSpriteSheet(makeImage(SPRITE_SHEET_W, SPRITE_SHEET_H)).ok).toBe(false);
    const ok = makeImage(SPRITE_SHEET_W, SPRITE_SHEET_H);
    setPixel(ok, 0, 0, [1, 2, 3, 255]);
    expect(validateSpriteSheet(ok).ok).toBe(true);
  });
});
