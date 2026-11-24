/**
 * T-M6-60 托盘宿主纯函数单测（Node 环境，不启动 Electron）。
 * 覆盖 macOS 顶部、Win11 底部、溢出区全 0、多屏负坐标/高 DPI 夹紧、
 * 250ms 失焦/点击防抖、深浅主题图标选择与关闭即隐藏/真正退出语义。
 */
import { describe, expect, it } from 'vitest';
import {
  computePopoverBounds,
  createPopoverToggleGuard,
  isTrayBoundsUnavailable,
  resolvePopoverEdge,
  shouldHideDirectorOnClose,
  shouldQuitOnAllWindowsClosed,
  trayIconFilenames,
  POPOVER_BLUR_GUARD_MS,
  POPOVER_SIZE,
} from './tray-host';

const MAC_DISPLAY = { x: 0, y: 0, width: 1440, height: 900 };
const MAC_WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };
const WIN_DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const WIN_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

describe('computePopoverBounds', () => {
  it('macOS 顶部菜单栏：托盘正下方 6px，水平居中', () => {
    const bounds = computePopoverBounds({
      trayBounds: { x: 800, y: 0, width: 24, height: 24 },
      cursorPoint: { x: 812, y: 12 },
      workArea: MAC_WORK_AREA,
      displayBounds: MAC_DISPLAY,
      popoverSize: POPOVER_SIZE,
      platform: 'darwin',
    });
    expect(resolvePopoverEdge({ x: 800, y: 0, width: 24, height: 24 }, MAC_DISPLAY)).toBe('top');
    expect(bounds).toEqual({ x: 632, y: 30, width: 360, height: 500 });
  });

  it('Windows 11 底部任务栏：托盘正上方 8px', () => {
    const bounds = computePopoverBounds({
      trayBounds: { x: 900, y: 1048, width: 24, height: 24 },
      cursorPoint: { x: 912, y: 1060 },
      workArea: WIN_WORK_AREA,
      displayBounds: WIN_DISPLAY,
      popoverSize: POPOVER_SIZE,
      platform: 'win32',
    });
    expect(resolvePopoverEdge({ x: 900, y: 1048, width: 24, height: 24 }, WIN_DISPLAY)).toBe('bottom');
    expect(bounds).toEqual({ x: 732, y: 540, width: 360, height: 500 });
  });

  it('Windows 11 图标折叠进 ^ 溢出区（bounds 全 0）：回退光标所在工作区右下角，绝不弹到 (0,0)', () => {
    expect(isTrayBoundsUnavailable({ x: 0, y: 0, width: 0, height: 0 })).toBe(true);
    const bounds = computePopoverBounds({
      trayBounds: { x: 0, y: 0, width: 0, height: 0 },
      cursorPoint: { x: 1600, y: 900 },
      workArea: WIN_WORK_AREA,
      displayBounds: WIN_DISPLAY,
      popoverSize: POPOVER_SIZE,
      platform: 'win32',
    });
    expect(bounds).toEqual({ x: 1552, y: 532, width: 360, height: 500 });
    expect(bounds.x + bounds.width <= WIN_WORK_AREA.x + WIN_WORK_AREA.width - 8).toBe(true);
    expect(bounds.y + bounds.height <= WIN_WORK_AREA.y + WIN_WORK_AREA.height - 8).toBe(true);
  });

  it('多屏负坐标：副屏左上角为负，浮窗严格夹紧在该屏 workArea 内', () => {
    const display = { x: -1920, y: 0, width: 1920, height: 1080 };
    const workArea = { x: -1920, y: 25, width: 1920, height: 1055 };
    const bounds = computePopoverBounds({
      trayBounds: { x: -30, y: 0, width: 24, height: 24 },
      cursorPoint: { x: -18, y: 12 },
      workArea,
      displayBounds: display,
      popoverSize: POPOVER_SIZE,
      platform: 'darwin',
    });
    // 居中会越出右边界（-198），夹紧到 -1920+1920-360 = -360
    expect(bounds).toEqual({ x: -360, y: 30, width: 360, height: 500 });
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);

    const fallback = computePopoverBounds({
      trayBounds: { x: 0, y: 0, width: 0, height: 0 },
      cursorPoint: { x: -100, y: 100 },
      workArea,
      displayBounds: display,
      popoverSize: POPOVER_SIZE,
      platform: 'win32',
    });
    expect(fallback.x).toBe(-1920 + 1920 - 360 - 8);
    expect(fallback.y).toBe(25 + 1055 - 500 - 8);
  });

  it('Windows 125%/150% DPI：按 DIP 工作区夹紧，不越界', () => {
    // 1920×1080 物理屏 @125% → 1536×864 DIP；任务栏 40 DIP
    const display = { x: 0, y: 0, width: 1536, height: 864 };
    const workArea = { x: 0, y: 0, width: 1536, height: 824 };
    const bounds = computePopoverBounds({
      trayBounds: { x: 1480, y: 800, width: 24, height: 24 },
      cursorPoint: { x: 1492, y: 812 },
      workArea,
      displayBounds: display,
      popoverSize: { width: 360, height: 500 },
      platform: 'win32',
    });
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
  });
});

describe('createPopoverToggleGuard', () => {
  it('失焦隐藏后 250ms 内的托盘点击被忽略，超过阈值才允许重开', () => {
    expect(POPOVER_BLUR_GUARD_MS).toBe(250);
    const guard = createPopoverToggleGuard();
    guard.markHidden(1_000);
    expect(guard.onTrayClick(1_100, false)).toBe('ignore');
    expect(guard.onTrayClick(1_249, false)).toBe('ignore');
    expect(guard.onTrayClick(1_250, false)).toBe('show');
    // 浮窗仍可见时点击 = 主动关闭
    expect(guard.onTrayClick(2_000, true)).toBe('hide');
  });

  it('没有失焦记录时首次点击直接打开', () => {
    const guard = createPopoverToggleGuard();
    expect(guard.onTrayClick(10_000, false)).toBe('show');
  });
});

describe('双端图标选择', () => {
  it('macOS 固定 Template 文件，交给 Electron 自动合并 @2x 并反色', () => {
    expect(trayIconFilenames('darwin', true)).toEqual({ primary: 'trayTemplate.png', highDpi: 'trayTemplate@2x.png' });
    expect(trayIconFilenames('darwin', false)).toEqual({ primary: 'trayTemplate.png', highDpi: 'trayTemplate@2x.png' });
  });

  it('Win11 深色任务栏用浅色图标，浅色任务栏用深色图标', () => {
    expect(trayIconFilenames('win32', true).primary).toBe('tray-win-light.png');
    expect(trayIconFilenames('win32', false).primary).toBe('tray-win-dark.png');
  });
});

describe('常驻后台生命周期语义', () => {
  it('非退出时关中控台只隐藏；真正退出才允许销毁', () => {
    expect(shouldHideDirectorOnClose(false)).toBe(true);
    expect(shouldHideDirectorOnClose(true)).toBe(false);
    expect(shouldQuitOnAllWindowsClosed(false)).toBe(false);
    expect(shouldQuitOnAllWindowsClosed(true)).toBe(true);
  });
});
