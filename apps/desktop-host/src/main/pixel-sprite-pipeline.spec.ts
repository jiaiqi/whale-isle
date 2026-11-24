/** 星露谷像素表后处理（T-M6-62）：96×128 尺寸、4×6 统一缩放脚底对齐、最近邻不混色、去白底。 */
import { describe, expect, it } from 'vitest';
import { buildStardewSpriteSheet, cleanEdgeHalo, colorSet, fitCellToSprite, nearestNeighborSample, reducePalette, validateSpriteSheet, SPRITE_CELL_H, SPRITE_CELL_W, SPRITE_SHEET_H, SPRITE_SHEET_W } from './pixel-sprite-pipeline';
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

/** 造一张 384×256 白底 4×6 网格图：每格中心一个 32×32 纯色块（行=方向色，列=帧色变体）。 */
function gridImage(): RawImage {
  const image = makeImage(384, 256, [255, 255, 255, 255]);
  const rowColors: Array<[number, number, number, number]> = [
    [220, 40, 40, 255], [40, 200, 60, 255], [40, 80, 220, 255], [220, 200, 40, 255],
  ];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 6; col += 1) {
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
    // 高度撑满：底边与顶行中心都不透明（角色与原版帧同高 32px）
    expect(pixelAt(fitted.image, SPRITE_CELL_W / 2, SPRITE_CELL_H - 1)[3]).toBe(255);
    expect(pixelAt(fitted.image, SPRITE_CELL_W / 2, 0)[3]).toBe(255);
    // 瘦高内容（8×32）宽度不足 16 → 居中留透明边，不拉伸变形
    const thin = makeImage(64, 64);
    for (let y = 16; y < 48; y += 1) for (let x = 28; x < 36; x += 1) setPixel(thin, x, y, [0, 200, 0, 255]);
    const thinFit = fitCellToSprite(thin, { x: 0, y: 0, width: 64, height: 64 });
    expect(pixelAt(thinFit.image, 0, SPRITE_CELL_H / 2)[3]).toBe(0); // 左侧透明边
    expect(pixelAt(thinFit.image, SPRITE_CELL_W / 2, SPRITE_CELL_H / 2)[3]).toBe(255); // 中心有内容
    const empty = fitCellToSprite(makeImage(64, 64), { x: 0, y: 0, width: 64, height: 64 });
    expect(empty.empty).toBe(true);
    expect(colorSet(empty.image).size).toBe(0);
  });
});

describe('buildStardewSpriteSheet', () => {
  it('白底 4×6 网格 → 96×128，行=方向色、列=帧色，白底被抠掉', () => {
    const result = buildStardewSpriteSheet(gridImage());
    expect(result.sheet.width).toBe(SPRITE_SHEET_W);
    expect(SPRITE_SHEET_W).toBe(96); // 4×6：动作/表情列
    expect(result.sheet.height).toBe(SPRITE_SHEET_H);
    expect(result.emptyCells).toBe(0);
    // 第 0 行（朝下）中心像素偏红；第 2 行（朝上）偏蓝
    const down = pixelAt(result.sheet, SPRITE_CELL_W / 2, SPRITE_CELL_H / 2);
    expect(down[0]).toBeGreaterThan(180);
    expect(down[2]).toBeLessThan(120);
    const up = pixelAt(result.sheet, SPRITE_CELL_W / 2, 2 * SPRITE_CELL_H + SPRITE_CELL_H / 2);
    expect(up[2]).toBeGreaterThan(180);
    // 高度撑满：row0 col0 帧的顶行与底行中心都不透明
    expect(pixelAt(result.sheet, SPRITE_CELL_W / 2, 0)[3]).toBe(255);
    expect(pixelAt(result.sheet, SPRITE_CELL_W / 2, SPRITE_CELL_H - 1)[3]).toBe(255);
    // 颜色集合不含白色（白底已被洪水填充抠除）
    expect(colorSet(result.sheet).has('255,255,255')).toBe(false);
  });

  it('不同高度的帧共用整表缩放：矮帧不会被单独拉高（走路不上下跳）', () => {
    const image = makeImage(384, 256, [255, 255, 255, 255]);
    // 每个格子都铺满整格宽度，保证 contentBounds 覆盖整张图（行/列切割不偏移）
    const heights = [64, 32, 16, 4, 4, 4];
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const h = row === 0 ? heights[col]! : 4;
        for (let y = 64 - h; y < 64; y += 1) {
          for (let x = 0; x < 64; x += 1) setPixel(image, col * 64 + x, row * 64 + y, [60, 60, 200, 255]);
        }
      }
    }
    const result = buildStardewSpriteSheet(image);
    expect(result.emptyCells).toBe(0);
    // 最高帧 64px → 32px，其余帧按同一系数：32→16、16→8
    expect(pixelAt(result.sheet, SPRITE_CELL_W / 2, 0)[3]).toBe(255);
    const secondX = SPRITE_CELL_W + SPRITE_CELL_W / 2;
    expect(pixelAt(result.sheet, secondX, SPRITE_CELL_H - 16 - 1)[3]).toBe(0); // 32→16：顶部 16px 透明
    expect(pixelAt(result.sheet, secondX, SPRITE_CELL_H - 16)[3]).toBe(255); // 底边对齐
    const thirdX = 2 * SPRITE_CELL_W + SPRITE_CELL_W / 2;
    expect(pixelAt(result.sheet, thirdX, SPRITE_CELL_H - 8 - 1)[3]).toBe(0); // 16→8：顶部 24px 透明
    expect(pixelAt(result.sheet, thirdX, SPRITE_CELL_H - 8)[3]).toBe(255);
  });

  it('按整张画布均分切格：每格自带留白也不会切掉第一列或让后续列漂移', () => {
    const image = makeImage(384, 256, [255, 255, 255, 255]);
    // 每格中心 8×8 色块，列/行颜色都不同，四周留 28px 白边
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const color: [number, number, number, number] = [40 + col * 30, 60 + row * 40, 200 - col * 20, 255];
        for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) setPixel(image, col * 64 + 28 + x, row * 64 + 28 + y, color);
      }
    }
    const result = buildStardewSpriteSheet(image);
    expect(result.emptyCells).toBe(0);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const pixel = pixelAt(result.sheet, col * SPRITE_CELL_W + SPRITE_CELL_W / 2, row * SPRITE_CELL_H + SPRITE_CELL_H / 2);
        expect(pixel).toEqual([40 + col * 30, 60 + row * 40, 200 - col * 20, 255]);
      }
    }
  });

  it('AI 列距/左边距与画布不均分时，按内容投影定位 6 列（第一列不被切半）', () => {
    const image = makeImage(384, 256, [255, 255, 255, 255]);
    const centers = [55, 105, 155, 205, 255, 305]; // 列距 50，画布均分是 64
    for (let row = 0; row < 4; row += 1) {
      centers.forEach((center, col) => {
        const color: [number, number, number, number] = [30 + col * 35, 80 + row * 30, 210 - col * 20, 255];
        for (let y = 0; y < 20; y += 1) for (let x = 0; x < 20; x += 1) setPixel(image, center - 10 + x, row * 64 + 22 + y, color);
      });
    }
    const result = buildStardewSpriteSheet(image);
    expect(result.emptyCells).toBe(0);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const pixel = pixelAt(result.sheet, col * SPRITE_CELL_W + SPRITE_CELL_W / 2, row * SPRITE_CELL_H + SPRITE_CELL_H / 2);
        expect(pixel).toEqual([30 + col * 35, 80 + row * 30, 210 - col * 20, 255]);
      }
    }
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
    expect(result.emptyCells).toBe(12); // 2 行空 × 6 列
  });
});

describe('cleanEdgeHalo', () => {
  it('只清轮廓外的近白光晕，被深色描边包围的白围裙保留', () => {
    const image = makeImage(16, 16);
    // 6×6 白块：两轮后只留中心 2×2（外围都属于「贴着透明」的白晕）
    for (let y = 5; y < 11; y += 1) for (let x = 5; x < 11; x += 1) setPixel(image, x, y, [250, 248, 246, 255]);
    cleanEdgeHalo(image, 2);
    expect(pixelAt(image, 5, 5)[3]).toBe(0);
    expect(pixelAt(image, 8, 8)[3]).toBe(255);
    // 深色描边包围的白块：白色不与透明相邻，必须保留
    const apron = makeImage(16, 16);
    for (let y = 4; y < 12; y += 1) for (let x = 4; x < 12; x += 1) setPixel(apron, x, y, [20, 20, 40, 255]);
    for (let y = 6; y < 10; y += 1) for (let x = 6; x < 10; x += 1) setPixel(apron, x, y, [250, 248, 246, 255]);
    cleanEdgeHalo(apron, 2);
    expect(pixelAt(apron, 7, 7)[3]).toBe(255);
  });
});

describe('reducePalette', () => {
  it('颜色过多时收敛到上限，且每种输出色都来自原图（不混新色）', () => {
    const image = makeImage(32, 32);
    const originals = new Set<string>();
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const rgba: [number, number, number, number] = [(x * 8) % 256, (y * 8) % 256, (x * y * 3) % 256, 255];
        originals.add(`${rgba[0]},${rgba[1]},${rgba[2]}`);
        setPixel(image, x, y, rgba);
      }
    }
    expect(originals.size).toBeGreaterThan(16);
    reducePalette(image, 16);
    const reduced = colorSet(image);
    expect(reduced.size).toBeLessThanOrEqual(16);
    for (const color of reduced) expect(originals.has(color)).toBe(true);
  });

  it('颜色数不超过上限时原样返回', () => {
    const image = makeImage(4, 4);
    setPixel(image, 0, 0, [1, 2, 3, 255]);
    setPixel(image, 1, 0, [4, 5, 6, 255]);
    expect(reducePalette(image, 8)).toBe(2);
    expect(colorSet(image).size).toBe(2);
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
