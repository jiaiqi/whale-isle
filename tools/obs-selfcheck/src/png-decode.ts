/**
 * 最小 PNG 解码（item 4 / `V2-P3-02` OBS 浏览器源静态红页自检配套）。
 *
 * 为什么自己解：OBS 的 `GetSourceScreenshot` 返回 base64 PNG，
 * 探针必须读出中心像素才能判定「渲染全黑」还是「渲染出红页」，
 * 而仓库里没有引入图像处理依赖（避免为一个自检工具拖进一整个解码库）。
 *
 * 支持范围（足够覆盖 OBS 截图；超范围一律**显式抛错**，绝不返回猜测值）：
 * - 8 bit / 非隔行
 * - colorType 2（RGB，3 通道）与 6（RGBA，4 通道）
 * - 5 种行过滤器（None / Sub / Up / Average / Paeth）
 */
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  /** 每行 `width * channels` 字节，row-major */
  data: Buffer;
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG 数据（签名不匹配）');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8) throw new Error(`暂不支持 bitDepth=${bitDepth}`);
      if (interlace !== 0) throw new Error('暂不支持隔行 PNG');
      if (colorType !== 2 && colorType !== 6) throw new Error(`暂不支持 colorType=${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) {
    throw new Error('PNG 结构不完整');
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    throw new Error('PNG 像素数据长度不足');
  }
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = prev === null || x < channels ? 0 : prev[x - channels];
      const value = line[x];
      let result: number;
      if (filter === 0) result = value;
      else if (filter === 1) result = value + a;
      else if (filter === 2) result = value + b;
      else if (filter === 3) result = value + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else {
        throw new Error(`未知 PNG filter=${filter}`);
      }
      cur[x] = result & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** 取某点 RGB（越界抛错，不返回猜测值） */
export function pixelAt(image: DecodedPng, x: number, y: number): [number, number, number] {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new Error(`像素坐标越界：(${x},${y}) 超出 ${image.width}x${image.height}`);
  }
  const idx = y * image.width * image.channels + x * image.channels;
  return [image.data[idx] ?? 0, image.data[idx + 1] ?? 0, image.data[idx + 2] ?? 0];
}

/** 整幅图是否全黑（本机 OBS 硬件加速缺陷的判据） */
export function isAllBlack(image: DecodedPng): boolean {
  return image.data.every((value) => value === 0);
}

/** 是否接近纯红（#c00 → RGB 204,0,0） */
export function isRedPage(image: DecodedPng): boolean {
  const [r, g, b] = pixelAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2));
  return r > 120 && g < 80 && b < 80;
}
