/**
 * pose-skin 命中几何（T-M6-51）。
 *
 * `<img>` 以 `object-fit: contain` 缩放，透明区域必须按「实际绘制矩形」采样，
 * 不能用元素框直接等比映射。把这段几何拆成纯函数便于确定性测试。
 */

export interface ContainRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** 计算 natural 尺寸图片在 box 内 contain 后的绘制矩形（居中）。 */
export function poseContainRect(boxWidth: number, boxHeight: number, naturalWidth: number, naturalHeight: number): ContainRect {
  if (naturalWidth <= 0 || naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height, scale };
}

/** 舞台坐标 → 图片 natural 像素坐标；落在 letterbox 黑边外返回 null（视为透明）。 */
export function poseSamplePoint(
  boxWidth: number,
  boxHeight: number,
  naturalWidth: number,
  naturalHeight: number,
  pointX: number,
  pointY: number,
): { sx: number; sy: number } | null {
  const rect = poseContainRect(boxWidth, boxHeight, naturalWidth, naturalHeight);
  if (rect.scale === 0) return null;
  if (pointX < rect.x || pointY < rect.y || pointX > rect.x + rect.width || pointY > rect.y + rect.height) return null;
  return {
    sx: Math.min(naturalWidth - 1, Math.max(0, (pointX - rect.x) / rect.scale)),
    sy: Math.min(naturalHeight - 1, Math.max(0, (pointY - rect.y) / rect.scale)),
  };
}
