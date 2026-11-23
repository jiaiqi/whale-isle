/**
 * 主进程：鼠标穿透 / 拖拽 / 屏幕边界 IPC（T-M1-02）。
 *
 * 穿透策略（SPEC §3.1）：renderer 每 50ms 采样鼠标处 alpha，仅状态翻转时经
 * 'passthrough:set' 到这里 → win.setIgnoreMouseEvents(passthrough, { forward })。
 * 拖拽坐标一律 DIP（Electron 原生处理多屏异构 DPI）；位置约束按每块屏幕工作区分别计算。
 */
import { BrowserWindow, ipcMain, screen } from 'electron';
import {
  boundingRect,
  clampWindowPosition,
  windowPlacementRegions,
  type DisplayWorkArea,
  type Rect,
} from './display-region';

export interface ScreenBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function getDisplayWorkAreas(): DisplayWorkArea[] {
  const displays = screen.getAllDisplays();
  const sources = displays.length > 0 ? displays : [screen.getPrimaryDisplay()];
  return sources.map((display) => ({
    displayId: String(display.id),
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
  }));
}

function boundsOf(rect: Rect): ScreenBounds {
  return {
    minX: rect.x,
    minY: rect.y,
    maxX: rect.x + rect.width - 1,
    maxY: rect.y + rect.height - 1,
  };
}

export function computeScreenBounds(): ScreenBounds {
  const areas = getDisplayWorkAreas();
  const union = boundingRect(areas);
  return {
    minX: union.x,
    minY: union.y,
    // This hull is informational only. Placement uses the original work-area union.
    maxX: union.x + union.width,
    maxY: union.y + union.height,
  };
}

export interface PassthroughIpcOptions {
  getWindow(): BrowserWindow | null;
  /** PET_STAGE_E2E=1 时启用 test:force-alpha 中继（运行期安全锁：非测试模式不暴露） */
  testMode: boolean;
}

export function registerStageIpc(options: PassthroughIpcOptions): void {
  let current: 'passthrough' | 'interactive' = 'passthrough';
  /** 右键菜单/设置浮层期间强制交互：alpha 探针不得把窗口切成穿透（否则菜单点不到） */
  let forceInteractive = false;
  const applyState = (): void => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return;
    const passthrough = !forceInteractive && current === 'passthrough';
    win.setIgnoreMouseEvents(passthrough, { forward: passthrough });
  };
  ipcMain.handle('passthrough:force', (_event, on: boolean) => {
    forceInteractive = on === true;
    applyState();
    return true;
  });

  ipcMain.handle('passthrough:set', (_event, state: 'passthrough' | 'interactive') => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return false;
    current = state === 'interactive' ? 'interactive' : 'passthrough';
    applyState();
    return true;
  });

  ipcMain.handle('passthrough:get', () => current);

  // The overall hull remains useful to callers, but physics receives the active
  // display's feasible window-origin region so a throw cannot enter a screen gap.
  ipcMain.handle('screen:bounds', () => {
    const work = computeScreenBounds();
    const win = options.getWindow();
    if (!win || win.isDestroyed()) {
      const primary = screen.getPrimaryDisplay();
      return { ...work, displayId: String(primary.id), windowBounds: work };
    }

    const windowBounds = win.getBounds();
    const regions = windowPlacementRegions(getDisplayWorkAreas(), windowBounds.width, windowBounds.height);
    const display = screen.getDisplayMatching(windowBounds);
    const placement = clampWindowPosition(
      regions,
      windowBounds.x,
      windowBounds.y,
      String(display.id),
    );
    const activeRegion = regions[placement.index];
    return {
      ...work,
      displayId: placement.displayId ?? String(display.id),
      windowBounds: activeRegion ? boundsOf(activeRegion) : work,
    };
  });

  ipcMain.handle('cursor:point', () => screen.getCursorScreenPoint());

  ipcMain.handle('win:get-position', () => {
    const win = options.getWindow();
    return win && !win.isDestroyed() ? win.getPosition() : null;
  });

  ipcMain.handle('win:drag-to', (_event, x: number, y: number) => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return null;
    const size = win.getBounds();
    const regions = windowPlacementRegions(getDisplayWorkAreas(), size.width, size.height);
    const placement = clampWindowPosition(regions, x, y);
    if (placement.displayId === null) {
      const hull = computeScreenBounds();
      const fallbackX = Math.min(Math.max(Math.round(x), hull.minX), Math.max(hull.minX, hull.maxX - size.width));
      const fallbackY = Math.min(Math.max(Math.round(y), hull.minY), Math.max(hull.minY, hull.maxY - size.height));
      win.setPosition(fallbackX, fallbackY);
      return win.getPosition();
    }
    win.setPosition(Math.round(placement.x), Math.round(placement.y));
    return win.getPosition();
  });

  ipcMain.handle('app:meta', () => ({
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    testMode: options.testMode,
  }));

  if (options.testMode) {
    // E2E 中继：preload forceAlpha → renderer probe.force
    ipcMain.handle('test:force-alpha', (event, alpha: number) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.webContents.send('pet-stage:test-alpha', alpha);
      return true;
    });
  }
}
