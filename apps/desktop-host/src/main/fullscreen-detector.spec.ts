import { describe, expect, it } from 'vitest';
import { detectFullscreenForDisplay, intersectionArea, parseFullscreenRect } from './fullscreen-detector';

const displayA = { displayId: 'A', bounds: { x: 0, y: 0, width: 1440, height: 900 } };
const displayB = { displayId: 'B', bounds: { x: 1440, y: 0, width: 1920, height: 1080 } };

describe('detectFullscreenForDisplay', () => {
  it('仅覆盖 A 屏的全屏窗口只隐藏 A，不影响 B', () => {
    const full = { bounds: { x: 0, y: 0, width: 1440, height: 900 } };
    expect(detectFullscreenForDisplay(displayA, [full])).toMatchObject({ hidden: true, coveredRatio: 1 });
    expect(detectFullscreenForDisplay(displayB, [full]).hidden).toBe(false);
  });
  it('带 displayId 的窗口精确过滤；覆盖不足 95% 不隐藏', () => {
    expect(detectFullscreenForDisplay(displayB, [{ displayId: 'A', bounds: { x: 0, y: 0, width: 1440, height: 900 } }]).hidden).toBe(false);
    expect(detectFullscreenForDisplay(displayA, [{ bounds: { x: 100, y: 100, width: 1000, height: 700 } }])).toMatchObject({ hidden: false });
  });
  it('多个窗口中任一覆盖即隐藏；尺寸为 0 安全返回', () => {
    expect(detectFullscreenForDisplay(displayA, [
      { bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { bounds: { x: 0, y: 0, width: 1440, height: 900 } },
    ]).hidden).toBe(true);
    expect(detectFullscreenForDisplay({ displayId: 'X', bounds: { x: 0, y: 0, width: 0, height: 0 } }, []).hidden).toBe(false);
  });
  it('面积相交与 AppleScript 矩形解析边界', () => {
    expect(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(25);
    expect(parseFullscreenRect('0, 0, 1440, 900')).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(parseFullscreenRect('')).toBeNull();
    expect(parseFullscreenRect('1,2,3')).toBeNull();
    expect(parseFullscreenRect('0,0,0,900')).toBeNull();
  });
});
