/**
 * 主进程：鼠标穿透 / 拖拽 / 屏幕边界 IPC（T-M1-02）。
 *
 * 穿透策略（SPEC §3.1）：renderer 每 50ms 采样鼠标处 alpha，仅状态翻转时经
 * 'passthrough:set' 到这里 → win.setIgnoreMouseEvents(passthrough, { forward })。
 * 拖拽坐标一律 DIP（Electron 原生处理多屏异构 DPI）；边界为多屏合并 workArea。
 */
import { BrowserWindow, ipcMain, screen } from 'electron';

export interface ScreenBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function computeScreenBounds(): ScreenBounds {
  const displays = screen.getAllDisplays();
  const areas = displays.map((display) => display.workArea);
  if (areas.length === 0) {
    const primary = screen.getPrimaryDisplay().workArea;
    return { minX: primary.x, minY: primary.y, maxX: primary.x + primary.width, maxY: primary.y + primary.height };
  }
  return {
    minX: Math.min(...areas.map((a) => a.x)),
    minY: Math.min(...areas.map((a) => a.y)),
    maxX: Math.max(...areas.map((a) => a.x + a.width)),
    maxY: Math.max(...areas.map((a) => a.y + a.height)),
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

  // T-M6-19：同时给「工作区边界」与「窗口左上角可达边界」（扣掉窗口自身尺寸）——
  // 甩抛物理必须用 windowBounds，否则重力/惯性会把窗口整个推出屏幕下沿
  ipcMain.handle('screen:bounds', () => {
    const work = computeScreenBounds();
    const win = options.getWindow();
    const wb = win && !win.isDestroyed() ? win.getBounds() : null;
    if (!wb) return { ...work, windowBounds: work };
    return {
      ...work,
      windowBounds: {
        minX: work.minX,
        minY: work.minY,
        maxX: Math.max(work.minX, work.maxX - wb.width),
        maxY: Math.max(work.minY, work.maxY - wb.height),
      },
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
    const bounds = computeScreenBounds();
    // 拖拽边界夹紧（多屏合并 workArea）
    const clampedX = Math.min(Math.max(Math.round(x), bounds.minX), Math.max(bounds.minX, bounds.maxX - win.getBounds().width));
    const clampedY = Math.min(Math.max(Math.round(y), bounds.minY), Math.max(bounds.minY, bounds.maxY - win.getBounds().height));
    win.setPosition(clampedX, clampedY);
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
