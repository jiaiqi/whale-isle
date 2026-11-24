import { describe, expect, it } from 'vitest';
import { pointInBounds, resolveAltPeekTargets } from './global-alt-peek';

const bounds = { x: 100, y: 100, width: 400, height: 284 };
describe('global alt peek', () => {
  it('只在 Alt 按下且鼠标在 bounds 内时命中，多窗独立', () => {
    const windows = [
      { agentId: 'a', bounds },
      { agentId: 'b', bounds: { x: 600, y: 100, width: 400, height: 284 } },
    ];
    expect(resolveAltPeekTargets(windows, { x: 200, y: 200 }, true)).toEqual(['a']);
    expect(resolveAltPeekTargets(windows, { x: 200, y: 200 }, false)).toEqual([]);
    expect(resolveAltPeekTargets(windows, { x: 700, y: 200 }, true)).toEqual(['b']);
  });
  it('边界半开、负坐标与空白区', () => {
    expect(pointInBounds({ x: 100, y: 100 }, bounds)).toBe(true);
    expect(pointInBounds({ x: 500, y: 100 }, bounds)).toBe(false);
    expect(pointInBounds({ x: 99, y: 100 }, bounds)).toBe(false);
    expect(pointInBounds({ x: -150, y: 0 }, { x: -200, y: 0, width: 100, height: 100 })).toBe(true);
  });
});
