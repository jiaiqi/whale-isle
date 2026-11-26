import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, isAllBlack, isRedPage, pixelAt } from './png-decode';

/** 构造一个 PNG（colorType 2 RGB / 6 RGBA），用于验证解码器 */
function buildPng(width: number, height: number, fill: [number, number, number], colorType: 2 | 6 = 2): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc(height * (1 + width * channels));
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    raw[pos] = 0; // filter = None
    pos += 1;
    for (let x = 0; x < width; x += 1) {
      raw[pos] = fill[0];
      raw[pos + 1] = fill[1];
      raw[pos + 2] = fill[2];
      if (channels === 4) raw[pos + 3] = 255;
      pos += channels;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 构造可调 IHDR 字段的 PNG，专门用于验证解码器的**拒绝分支**。
 * 只写合法 chunk 结构，字段越界由被测代码负责抛错。
 */
function buildRawPng(
  options: {
    width?: number;
    height?: number;
    bitDepth?: number;
    colorType?: number;
    interlace?: number;
    /** 每行的 filter 字节；缺省全 0（None） */
    filters?: number[];
    /** 只写入前 N 行，用于构造「像素数据长度不足」 */
    forceRawRows?: number;
  } = {},
): Buffer {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const colorType = options.colorType ?? 2;
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rows = options.forceRawRows ?? height;
  const raw = Buffer.alloc(rows * (1 + stride));
  for (let y = 0; y < rows; y += 1) {
    raw[y * (1 + stride)] = options.filters?.[y] ?? 0;
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = options.bitDepth ?? 8;
  ihdr[9] = colorType;
  ihdr[12] = options.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('decodePng', () => {
  it('解出纯红 PNG 的尺寸与像素', () => {
    const image = decodePng(buildPng(4, 4, [204, 0, 0]));
    expect(image.width).toBe(4);
    expect(image.height).toBe(4);
    expect(image.channels).toBe(3);
    expect(pixelAt(image, 0, 0)).toEqual([204, 0, 0]);
    expect(pixelAt(image, 3, 3)).toEqual([204, 0, 0]);
  });

  it('支持 RGBA（colorType 6）', () => {
    const image = decodePng(buildPng(2, 2, [10, 20, 30], 6));
    expect(image.channels).toBe(4);
    expect(pixelAt(image, 1, 1)).toEqual([10, 20, 30]);
  });

  it('非 PNG 数据显式报错，不返回猜测结果', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/PNG/);
  });

  it('像素坐标越界显式报错', () => {
    const image = decodePng(buildPng(2, 2, [1, 2, 3]));
    expect(() => pixelAt(image, 2, 0)).toThrow(/越界/);
    expect(() => pixelAt(image, 0, -1)).toThrow(/越界/);
  });

  it('不支持的位深 / 隔行 / 颜色类型 / 行过滤器都显式报错', () => {
    expect(() => decodePng(buildRawPng({ bitDepth: 16 }))).toThrow(/bitDepth=16/);
    expect(() => decodePng(buildRawPng({ interlace: 1 }))).toThrow(/隔行/);
    expect(() => decodePng(buildRawPng({ colorType: 0 }))).toThrow(/colorType=0/);
    expect(() => decodePng(buildRawPng({ height: 2, filters: [0, 9] }))).toThrow(/未知 PNG filter=9/);
  });

  it('结构不完整或像素数据不足时显式报错', () => {
    // 只有签名、无 IHDR/IDAT
    expect(() => decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toThrow(/不完整/);
    // IHDR 声明 4x4 但 IDAT 只给一行
    expect(() => decodePng(buildRawPng({ width: 4, height: 4, forceRawRows: 1 }))).toThrow(/长度不足/);
  });

  it('5 种行过滤器都能还原出原始像素（None/Sub/Up/Average/Paeth）', () => {
    // 每行用不同 filter 编码同一张图，解码后必须逐像素等于原图
    const width = 3;
    const height = 5;
    const channels = 3;
    const pixels = Buffer.alloc(width * height * channels);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 37 + 11) & 0xff;
    const stride = width * channels;
    const raw = Buffer.alloc(height * (1 + stride));
    for (let y = 0; y < height; y += 1) {
      const filter = y; // 0..4
      raw[y * (1 + stride)] = filter;
      for (let x = 0; x < stride; x += 1) {
        const value = pixels[y * stride + x] ?? 0;
        const a = x >= channels ? pixels[y * stride + x - channels] ?? 0 : 0;
        const b = y === 0 ? 0 : pixels[(y - 1) * stride + x] ?? 0;
        const c = y === 0 || x < channels ? 0 : pixels[(y - 1) * stride + x - channels] ?? 0;
        const predictor = filter === 0 ? 0
          : filter === 1 ? a
            : filter === 2 ? b
              : filter === 3 ? (a + b) >> 1
                : paeth(a, b, c);
        raw[y * (1 + stride) + 1 + x] = (value - predictor) & 0xff;
      }
    }
    const image = decodePng(wrapRaw({ width, height, colorType: 2, raw }));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * stride + x * channels;
        expect(pixelAt(image, x, y)).toEqual([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
      }
    }
  });
});

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 把已经编码好的 raw（含每行 filter 字节）包成 PNG 容器 */
function wrapRaw(input: { width: number; height: number; colorType: number; raw: Buffer }): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(input.width, 0);
  ihdr.writeUInt32BE(input.height, 4);
  ihdr[8] = 8;
  ihdr[9] = input.colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(input.raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('isAllBlack / isRedPage', () => {
  it('全黑图与红图分别判对', () => {
    expect(isAllBlack(decodePng(buildPng(4, 4, [0, 0, 0])))).toBe(true);
    expect(isAllBlack(decodePng(buildPng(4, 4, [204, 0, 0])))).toBe(false);
    expect(isRedPage(decodePng(buildPng(4, 4, [204, 0, 0])))).toBe(true);
    expect(isRedPage(decodePng(buildPng(4, 4, [0, 0, 0])))).toBe(false);
    expect(isRedPage(decodePng(buildPng(4, 4, [200, 200, 200])))).toBe(false);
  });
});
