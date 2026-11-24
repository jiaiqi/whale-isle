/**
 * 托盘图标生成器（T-M6-60）。
 *
 * 单一事实源：鲸鱼造型直接取自 `src/shared/brand.ts` 的 `whaleMarkPaths()`，
 * 不手绘第二套 SVG；输出全部是透明 PNG（无外部图像库，Windows 构建机也能复现）：
 *   - macOS：trayTemplate.png 18×18 + trayTemplate@2x.png 36×36（黑色 + alpha，Template 自动反色）
 *   - Win11：tray-win-dark.png 32×32（深色鲸，浅色任务栏用）
 *           tray-win-light.png 32×32（浅色鲸，深色任务栏用）
 *
 * 运行：pnpm exec tsx apps/desktop-host/scripts/generate-tray-icons.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { whaleMarkPaths } from '../src/shared/brand';

interface Point {
  x: number;
  y: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const outDir = join(appRoot, 'assets', 'brand');

/** 把 SVG path 里的 M/C/L/Z（鲸鱼标记只用到这三种曲线）拍平成多边形。 */
export function flattenSvgPath(d: string, curveSegments = 28): Point[][] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const polygons: Point[][] = [];
  let current: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let index = 0;
  const number = (): number => Number(tokens[index++] ?? 0);

  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') {
      if (current.length > 0) polygons.push(current);
      cursor = { x: number(), y: number() };
      start = { ...cursor };
      current = [{ ...cursor }];
    } else if (command === 'C') {
      const c1 = { x: number(), y: number() };
      const c2 = { x: number(), y: number() };
      const end = { x: number(), y: number() };
      for (let step = 1; step <= curveSegments; step += 1) {
        const t = step / curveSegments;
        const mt = 1 - t;
        current.push({
          x: mt ** 3 * cursor.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * end.x,
          y: mt ** 3 * cursor.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * end.y,
        });
      }
      cursor = end;
    } else if (command === 'L') {
      cursor = { x: number(), y: number() };
      current.push({ ...cursor });
    } else if (command === 'Z' || command === 'z') {
      if (current.length > 0) {
        if (current[0] !== undefined && (current[current.length - 1]!.x !== start.x || current[current.length - 1]!.y !== start.y)) {
          current.push({ ...start });
        }
        polygons.push(current);
        current = [];
      }
      cursor = { ...start };
    }
  }
  if (current.length > 0) polygons.push(current);
  return polygons;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function insidePolygons(point: Point, polygons: Point[][]): boolean {
  let winding = 0;
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % polygon.length]!;
      if (a.y <= point.y) {
        if (b.y > point.y && (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y) > 0) winding += 1;
      } else if (b.y <= point.y && (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y) < 0) {
        winding -= 1;
      }
    }
  }
  return winding !== 0;
}

function boundsOf(polygons: Point[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const point of polygon) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

interface IconShape {
  body: Point[][];
  band: Point[];
  eye: { cx: number; cy: number; r: number };
  scale: number;
  offsetX: number;
  offsetY: number;
}

function buildShape(size: number): IconShape {
  const mark = whaleMarkPaths();
  const body = [...flattenSvgPath(mark.body), ...flattenSvgPath(mark.tail)];
  const band = flattenSvgPath(mark.band)[0] ?? [];
  const bbox = boundsOf(body);
  const pad = size <= 18 ? 1.2 : 2.4;
  const scale = Math.min((size - pad * 2) / (bbox.maxX - bbox.minX), (size - pad * 2) / (bbox.maxY - bbox.minY));
  return {
    body,
    band,
    eye: mark.eye,
    scale,
    offsetX: (size - (bbox.maxX - bbox.minX) * scale) / 2 - bbox.minX * scale,
    offsetY: (size - (bbox.maxY - bbox.minY) * scale) / 2 - bbox.minY * scale,
  };
}

const SUPERSAMPLE = 4;

/** 4×4 超采样栅格化：鲸身 + 尾鳍 + 头带实心，眼睛挖空（Template 也保留眼神）。 */
function renderRgba(size: number, color: Rgb): Buffer {
  const shape = buildShape(size);
  const pixels = Buffer.alloc(size * size * 4);
  const bandHalfWidth = 0.95;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const source: Point = {
            x: (px + (sx + 0.5) / SUPERSAMPLE - shape.offsetX) / shape.scale,
            y: (py + (sy + 0.5) / SUPERSAMPLE - shape.offsetY) / shape.scale,
          };
          const inBody = insidePolygons(source, shape.body);
          const inBand = shape.band.length > 1 && shape.band.some((point, i) => {
            if (i === 0) return false;
            return distanceToSegment(source, shape.band[i - 1]!, point) <= bandHalfWidth;
          });
          const inEye = Math.hypot(source.x - shape.eye.cx, source.y - shape.eye.cy) <= shape.eye.r;
          if ((inBody || inBand) && !inEye) covered += 1;
        }
      }
      const alpha = Math.round((covered / (SUPERSAMPLE * SUPERSAMPLE)) * 255);
      const index = (py * size + px) * 4;
      pixels[index] = color.r;
      pixels[index + 1] = color.g;
      pixels[index + 2] = color.b;
      pixels[index + 3] = alpha;
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng(size: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEMPLATE_COLOR: Rgb = { r: 0, g: 0, b: 0 };
const WIN_DARK_COLOR: Rgb = { r: 11, g: 27, b: 43 };
const WIN_LIGHT_COLOR: Rgb = { r: 245, g: 245, b: 247 };

export function generateTrayIcons(dir = outDir): string[] {
  mkdirSync(dir, { recursive: true });
  const outputs: Array<[string, number, Rgb]> = [
    ['trayTemplate.png', 18, TEMPLATE_COLOR],
    ['trayTemplate@2x.png', 36, TEMPLATE_COLOR],
    ['tray-win-dark.png', 32, WIN_DARK_COLOR],
    ['tray-win-light.png', 32, WIN_LIGHT_COLOR],
  ];
  const written: string[] = [];
  for (const [name, size, color] of outputs) {
    const file = join(dir, name);
    writeFileSync(file, encodePng(size, renderRgba(size, color)));
    written.push(file);
  }
  return written;
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  for (const file of generateTrayIcons()) console.log(`tray icon ✓ ${file}`);
}
