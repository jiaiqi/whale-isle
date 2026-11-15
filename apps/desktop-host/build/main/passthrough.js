/**
 * 主进程：鼠标穿透 / 拖拽 / 屏幕边界 IPC（T-M1-02）。
 *
 * 穿透策略（SPEC §3.1）：renderer 每 50ms 采样鼠标处 alpha，仅状态翻转时经
 * 'passthrough:set' 到这里 → win.setIgnoreMouseEvents(passthrough, { forward })。
 * 拖拽坐标一律 DIP（Electron 原生处理多屏异构 DPI）；边界为多屏合并 workArea。
 */
import { BrowserWindow, ipcMain, screen } from 'electron';
export function computeScreenBounds() {
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
export function registerStageIpc(options) {
    let current = 'passthrough';
    ipcMain.handle('passthrough:set', (_event, state) => {
        const win = options.getWindow();
        if (!win || win.isDestroyed())
            return false;
        current = state === 'interactive' ? 'interactive' : 'passthrough';
        win.setIgnoreMouseEvents(current === 'passthrough', { forward: current === 'passthrough' });
        return true;
    });
    ipcMain.handle('passthrough:get', () => current);
    ipcMain.handle('screen:bounds', () => computeScreenBounds());
    ipcMain.handle('cursor:point', () => screen.getCursorScreenPoint());
    ipcMain.handle('win:get-position', () => {
        const win = options.getWindow();
        return win && !win.isDestroyed() ? win.getPosition() : null;
    });
    ipcMain.handle('win:drag-to', (_event, x, y) => {
        const win = options.getWindow();
        if (!win || win.isDestroyed())
            return null;
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
        ipcMain.handle('test:force-alpha', (event, alpha) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            win?.webContents.send('pet-stage:test-alpha', alpha);
            return true;
        });
    }
}
//# sourceMappingURL=passthrough.js.map