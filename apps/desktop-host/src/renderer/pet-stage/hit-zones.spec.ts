/** 剪影部位分区（T-M6-64）：相对高度 0–0.35 head / 0.35–0.55 face / 0.55–1 body，越界夹紧。 */
import { describe, expect, it } from 'vitest';
import { resolveHitZone } from './hit-zones';

describe('resolveHitZone', () => {
  const top = 100;
  const bottom = 300; // 高度 200

  it('三段比例边界（0.35 / 0.55）', () => {
    expect(resolveHitZone(100, top, bottom)).toBe('head');
    expect(resolveHitZone(169, top, bottom)).toBe('head'); // 0.345
    expect(resolveHitZone(170, top, bottom)).toBe('face'); // 0.35
    expect(resolveHitZone(209, top, bottom)).toBe('face'); // 0.545
    expect(resolveHitZone(210, top, bottom)).toBe('body'); // 0.55
    expect(resolveHitZone(300, top, bottom)).toBe('body');
  });

  it('包围盒外夹到最近档；非法包围盒/NaN 回 body 不抛错', () => {
    expect(resolveHitZone(0, top, bottom)).toBe('head');
    expect(resolveHitZone(9999, top, bottom)).toBe('body');
    expect(resolveHitZone(150, 300, 100)).toBe('body');
    expect(resolveHitZone(Number.NaN, top, bottom)).toBe('body');
    expect(resolveHitZone(150, Number.NaN, bottom)).toBe('body');
  });
});
