/** 图像后处理纯算法（T-M6-53）：白底抠像、包围盒、90% 脚底对齐、头像/卡片裁切、眨眼差异。 */
import { describe, expect, it } from 'vitest';
import { contentBounds, enforceBlinkOnlyEyes, eyeRegionDiff, keyWhiteBackground, planAvatarCrop, planBlit, planNormalize, planPortraitCrop, sanitizePoseId, type RawImage } from './image-pipeline';

function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r; data[offset + 1] = g; data[offset + 2] = b; data[offset + 3] = a;
    }
  }
  return { width, height, data };
}

describe('keyWhiteBackground', () => {
  it('边缘连通的白底被抠掉；被角色包围的白眼白/白衣服保留', () => {
    // 7x7：白底 + 黑色轮廓环 + 中心白色（眼白/裙子）——中心不与边缘连通，必须保留
    const img = image(7, 7, (x, y) => {
      const borderRing = x >= 2 && x <= 4 && y >= 2 && y <= 4 && !(x === 3 && y === 3);
      if (borderRing) return [10, 10, 10, 255];
      if (x === 3 && y === 3) return [250, 250, 250, 255];
      return [255, 255, 255, 255];
    });
    const removed = keyWhiteBackground(img);
    expect(removed).toBeGreaterThan(0);
    expect(img.data[(0 * 7 + 0) * 4 + 3]).toBe(0);
    // 中心白色被黑环包围，保留不透明
    expect(img.data[(3 * 7 + 3) * 4 + 3]).toBe(255);
  });

  it('已透明图（四角有透明像素）直接跳过，不误抠内部白色', () => {
    const img = image(4, 4, () => [255, 255, 255, 255]);
    img.data[3] = 0; // 左上角透明 → 透明图
    expect(keyWhiteBackground(img)).toBe(0);
    expect(img.data[0]).toBe(255);
    expect(img.data[3]).toBe(0);
  });

  it('彩色浅色（奶白/浅黄）不当作白底', () => {
    const img = image(4, 1, (x) => (x < 2 ? [255, 250, 235, 255] : [10, 10, 10, 255]));
    expect(keyWhiteBackground(img)).toBe(0);
    expect(img.data[7]).toBe(255);
  });
});

describe('contentBounds', () => {
  it('返回不透明内容包围盒；全透明返回 null', () => {
    const img = image(10, 10, (x, y) => ((x >= 3 && x <= 6 && y >= 2 && y <= 8) ? [1, 2, 3, 255] : [0, 0, 0, 0]));
    expect(contentBounds(img)).toEqual({ x: 3, y: 2, width: 4, height: 7 });
    expect(contentBounds(image(5, 5, () => [0, 0, 0, 0]))).toBeNull();
  });
});

describe('planNormalize（90% 身高 + 脚底对齐）', () => {
  it('内容高度固定 90%，底边落在 97%，水平居中', () => {
    const plan = planNormalize({ x: 200, y: 100, width: 240, height: 440 }, 640, 640, 0.9, 0.97);
    expect(plan.contentHeight).toBe(576);
    expect(plan.scale).toBeCloseTo(576 / 440, 6);
    expect(plan.scaledHeight).toBe(576);
    // 内容中心 x：200+120=320 → 缩放后仍在舞台中心
    expect(plan.offsetX + (320) * plan.scale).toBeCloseTo(320, 0);
    // 内容底边：100+440=540 → 缩放后落在 0.97*640
    expect(plan.offsetY + (540) * plan.scale).toBeCloseTo(640 * 0.97, 0);
    expect(planBlit(plan, plan.scaledWidth, plan.scaledHeight).width).toBeGreaterThan(0);
  });

  it('空包围盒拒绝', () => {
    expect(() => planNormalize({ x: 0, y: 0, width: 0, height: 0 })).toThrow(/为空/);
  });
});

describe('裁剪计划与眨眼差异', () => {
  it('头像取头部正方形、卡片 2:3 居中', () => {
    const plan = planNormalize({ x: 220, y: 60, width: 200, height: 460 }, 640, 640, 0.9, 0.97);
    const avatar = planAvatarCrop(plan);
    expect(avatar.width).toBe(avatar.height);
    expect(avatar.width).toBeLessThanOrEqual(640);
    expect(avatar.x + avatar.width).toBeLessThanOrEqual(640);
    expect(avatar.y + avatar.height).toBeLessThanOrEqual(640);
    const portrait = planPortraitCrop(plan);
    expect(portrait.height).toBe(640);
    expect(portrait.width).toBe(427);
    expect(Math.abs(portrait.x * 2 + portrait.width - 640)).toBeLessThanOrEqual(1);
  });

  it('idle 与 idle-blink：仅眼部变化才算有效眨眼；完全不改差异为 0', () => {
    const base = image(100, 100, () => [100, 100, 100, 255]);
    const same = image(100, 100, () => [100, 100, 100, 255]);
    expect(eyeRegionDiff(base, same)).toBe(0);
    const blink = image(100, 100, (x, y) => ((y > 10 && y < 40 && x > 25 && x < 75) ? [0, 0, 0, 255] : [100, 100, 100, 255]));
    expect(eyeRegionDiff(base, blink)).toBeGreaterThan(0.5);
    // 眼部之外的变化不计入
    const bodyChange = image(100, 100, (x) => (x < 10 ? [255, 0, 0, 255] : [100, 100, 100, 255]));
    expect(eyeRegionDiff(base, bodyChange)).toBe(0);
  });

  it('idle-blink 仅闭眼：眼部取 blink，其余像素保持 idle', () => {
    const idle = image(100, 100, () => [100, 100, 100, 255]);
    const blink = image(100, 100, (x, y) => ((y > 10 && y < 40 && x > 25 && x < 75) ? [0, 0, 0, 255] : (x > 80 ? [255, 0, 0, 255] : [100, 100, 100, 255])));
    const merged = enforceBlinkOnlyEyes(idle, blink);
    // 眼部已闭（黑）
    expect(merged.data[(20 * 100 + 40) * 4]).toBe(0);
    // 眼部之外的「重绘漂移」被丢弃，保持 idle
    expect(merged.data[(20 * 100 + 90) * 4]).toBe(100);
    expect(eyeRegionDiff(idle, merged)).toBeGreaterThan(0.5);
  });

  it('pose id 清洗：去扩展名/非法字符/纯点', () => {
    expect(sanitizePoseId('idle-blink.webp')).toBe('idle-blink');
    expect(sanitizePoseId('待机 呼吸.webp')).toBe('待机 呼吸');
    expect(sanitizePoseId('a/b:c*.png')).toBe('a_b_c_');
    expect(sanitizePoseId('...')).toBe('pose');
    expect(sanitizePoseId('')).toBe('pose');
  });
});
