/**
 * 图像后处理纯几何/像素算法（T-M6-53，在 Electron 主进程调用）。
 *
 * 输入统一为 RGBA（非预乘），与 canvas/nativeImage 的 BGRA 在宿主层转换。
 * 只负责确定性计算，不做 I/O，便于单测。
 */

export interface RawImage {
  width: number;
  height: number;
  /** RGBA，长度 = width*height*4 */
  data: Uint8ClampedArray;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WHITE = 245;

/** 近白判定：高亮 + 低彩度（避免把奶白/浅黄衣服当背景），alpha 已透明则忽略。 */
function isBackgroundWhite(data: Uint8ClampedArray, index: number, threshold: number): boolean {
  if (data[index + 3]! <= 0) return false;
  const r = data[index]!;
  const g = data[index + 1]!;
  const b = data[index + 2]!;
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  return min >= threshold - 12 && max - min <= 12;
}

/**
 * 纯白/近白底自动抠像：只从图像四边出发做边缘连通域洪水填充。
 * - 四角已有透明像素 → 视为透明图，直接跳过（透明保真，绝不二次抠）；
 * - 只删除与画布边缘连通的白色区域 → 白围裙、眼白、白龙等被角色轮廓包围的白色绝不被抠穿；
 * 返回被置透明的像素数。
 */
export function keyWhiteBackground(image: RawImage, threshold = WHITE): number {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0) return 0;
  const cornerIndexes = [0, width - 1, (height - 1) * width, height * width - 1];
  if (cornerIndexes.some((index) => data[index * 4 + 3]! <= 16)) return 0;

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const enqueue = (index: number): void => {
    if (visited[index] === 1) return;
    if (!isBackgroundWhite(data, index * 4, threshold)) return;
    visited[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }

  let removed = 0;
  let head = 0;
  while (head < queue.length) {
    const index = queue[head++]!;
    data[index * 4 + 3] = 0;
    removed += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  return removed;
}

/** 不透明像素包围盒（alpha > threshold）；全透明返回 null。 */
export function contentBounds(image: RawImage, alphaThreshold = 16): Bounds | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3]! <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface NormalizePlan {
  /** 整图缩放倍率 */
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  /** 缩放后整图在舞台上的左上角（可为负，宿主负责裁剪） */
  offsetX: number;
  offsetY: number;
  stageWidth: number;
  stageHeight: number;
  /** 内容高度（= stageHeight × heightRatio） */
  contentHeight: number;
}

/**
 * 90% 身高 + 脚底对齐：内容高度固定为舞台高度的 90%，底边落在 footlineRatio 处，水平居中。
 * 所有姿态用同一舞台尺寸，切换时不会大小跳变。
 */
export function planNormalize(
  bounds: Bounds,
  stageWidth = 640,
  stageHeight = 640,
  heightRatio = 0.9,
  footlineRatio = 0.97,
): NormalizePlan {
  if (bounds.width <= 0 || bounds.height <= 0) throw new Error('内容包围盒为空');
  const contentHeight = stageHeight * heightRatio;
  const scale = contentHeight / bounds.height;
  const centerX = bounds.x + bounds.width / 2;
  const bottom = bounds.y + bounds.height;
  return {
    scale,
    scaledWidth: Math.max(1, Math.round(bounds.width * scale)),
    scaledHeight: Math.round(bounds.height * scale),
    offsetX: Math.round(stageWidth / 2 - centerX * scale),
    offsetY: Math.round(stageHeight * footlineRatio - bottom * scale),
    stageWidth,
    stageHeight,
    contentHeight: Math.round(contentHeight),
  };
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 头像：从标准化舞台的头部区域取正方形（内容顶部起，高约内容高度 62%）。 */
export function planAvatarCrop(plan: NormalizePlan): CropRect {
  const contentTop = Math.round(plan.stageHeight * 0.97 - plan.contentHeight);
  const side = Math.max(1, Math.min(plan.stageWidth, Math.round(plan.contentHeight * 0.62)));
  const x = Math.max(0, Math.round(plan.stageWidth / 2 - side / 2));
  const y = Math.max(0, Math.min(plan.stageHeight - side, contentTop - Math.round(side * 0.04)));
  return { x, y, width: side, height: side };
}

/** 卡片：标准化舞台中央 2:3（256×384）裁切。 */
export function planPortraitCrop(plan: NormalizePlan): CropRect {
  const height = plan.stageHeight;
  const width = Math.max(1, Math.min(plan.stageWidth, Math.round(height * (2 / 3))));
  return { x: Math.round((plan.stageWidth - width) / 2), y: 0, width, height };
}

export interface BlitPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 缩放后整图在舞台内的可见区域（处理负偏移裁剪）。 */
export function planBlit(plan: NormalizePlan, scaledWidth: number, scaledHeight: number): BlitPlacement {
  const x = Math.max(0, plan.offsetX);
  const y = Math.max(0, plan.offsetY);
  const right = Math.min(plan.stageWidth, plan.offsetX + scaledWidth);
  const bottom = Math.min(plan.stageHeight, plan.offsetY + scaledHeight);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** idle 与 idle-blink 眼部区域差异比例（0..1）；用于「仅闭眼」防抖校验。 */
export function eyeRegionDiff(idle: RawImage, blink: RawImage): number {
  const width = Math.min(idle.width, blink.width);
  const height = Math.min(idle.height, blink.height);
  if (width === 0 || height === 0) return 0;
  const x0 = Math.floor(width * 0.25);
  const x1 = Math.floor(width * 0.75);
  const y0 = Math.floor(height * 0.08);
  const y1 = Math.floor(height * 0.42);
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 4;
      const dr = Math.abs(idle.data[offset]! - blink.data[offset]!);
      const dg = Math.abs(idle.data[offset + 1]! - blink.data[offset + 1]!);
      const db = Math.abs(idle.data[offset + 2]! - blink.data[offset + 2]!);
      const da = Math.abs(idle.data[offset + 3]! - blink.data[offset + 3]!);
      total += 1;
      if (dr + dg + db + da > 24) changed += 1;
    }
  }
  return total === 0 ? 0 : changed / total;
}

/**
 * idle-blink 仅闭眼规则：以 idle 为底，只把 blink 的眼部区域贴回，
 * 防止重绘导致发型/服装/轮廓漂移（上游「眼部区域防抖校验/贴回」）。
 */
export function enforceBlinkOnlyEyes(idle: RawImage, blink: RawImage): RawImage {
  const width = Math.min(idle.width, blink.width);
  const height = Math.min(idle.height, blink.height);
  const out: RawImage = { width, height, data: new Uint8ClampedArray(idle.data.subarray(0, width * height * 4)) };
  const x0 = Math.floor(width * 0.22);
  const x1 = Math.floor(width * 0.78);
  const y0 = Math.floor(height * 0.07);
  const y1 = Math.floor(height * 0.44);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 4;
      out.data[offset] = blink.data[offset]!;
      out.data[offset + 1] = blink.data[offset + 1]!;
      out.data[offset + 2] = blink.data[offset + 2]!;
      out.data[offset + 3] = blink.data[offset + 3]!;
    }
  }
  return out;
}

/** 姿态文件名 → 安全 id（保留中文/字母数字/下划线/连字符）。 */
export function sanitizePoseId(raw: string): string {
  const clean = raw.replace(/\.[A-Za-z0-9]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, 'pose');
  return clean.trim() === '' ? 'pose' : clean.trim();
}

export const NON_POSE_FILES = new Set(['avatar', 'portrait', 'portrait-card']);
