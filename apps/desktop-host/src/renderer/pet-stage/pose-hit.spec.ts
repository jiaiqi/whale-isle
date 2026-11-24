/** pose-skin <img> 命中几何（T-M6-51）：contain 绘制矩形映射与 letterbox 透明区判定。 */
import { describe, expect, it } from 'vitest';
import { poseContainRect, poseSamplePoint } from './pose-hit';

describe('poseContainRect', () => {
  it('竖图在 400×260 舞台内居中：保持比例、上下不留边、左右 letterbox', () => {
    const rect = poseContainRect(400, 260, 616, 640);
    expect(rect.scale).toBeCloseTo(260 / 640, 6);
    expect(rect.height).toBeCloseTo(260, 6);
    expect(rect.width).toBeCloseTo(616 * (260 / 640), 6);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.x * 2 + rect.width).toBeCloseTo(400, 6);
  });

  it('横图在方框内左右贴边、上下留边', () => {
    const rect = poseContainRect(400, 400, 640, 360);
    expect(rect.width).toBeCloseTo(400, 6);
    expect(rect.height).toBeCloseTo(225, 6);
    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.y).toBeCloseTo(87.5, 6);
  });

  it('非法尺寸安全返回零矩形', () => {
    expect(poseContainRect(0, 260, 640, 360)).toEqual({ x: 0, y: 0, width: 0, height: 0, scale: 0 });
    expect(poseContainRect(400, 260, 0, 0).scale).toBe(0);
  });
});

describe('poseSamplePoint', () => {
  it('中心点映射到 natural 中心', () => {
    const point = poseSamplePoint(400, 260, 616, 640, 200, 130);
    expect(point?.sx).toBeCloseTo(308, 5);
    expect(point?.sy).toBeCloseTo(320, 5);
  });

  it('左右 letterbox 区域返回 null（透明，不拦截点击）', () => {
    expect(poseSamplePoint(400, 260, 616, 640, 10, 130)).toBeNull();
    expect(poseSamplePoint(400, 260, 616, 640, 390, 130)).toBeNull();
  });

  it('边界点夹紧到 natural 有效像素内', () => {
    const rect = poseContainRect(400, 260, 616, 640);
    const topLeft = poseSamplePoint(400, 260, 616, 640, rect.x, rect.y);
    expect(topLeft).toEqual({ sx: 0, sy: 0 });
    const bottomRight = poseSamplePoint(400, 260, 616, 640, rect.x + rect.width, rect.y + rect.height);
    expect(bottomRight?.sx).toBeLessThanOrEqual(615);
    expect(bottomRight?.sy).toBeLessThanOrEqual(639);
  });
});
