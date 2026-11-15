/**
 * 主进程：鼠标穿透 / 拖拽 / 屏幕边界 IPC（T-M1-02）。
 *
 * 穿透策略（SPEC §3.1）：renderer 每 50ms 采样鼠标处 alpha，仅状态翻转时经
 * 'passthrough:set' 到这里 → win.setIgnoreMouseEvents(passthrough, { forward })。
 * 拖拽坐标一律 DIP（Electron 原生处理多屏异构 DPI）；边界为多屏合并 workArea。
 */
import { BrowserWindow } from 'electron';
export interface ScreenBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
export declare function computeScreenBounds(): ScreenBounds;
export interface PassthroughIpcOptions {
    getWindow(): BrowserWindow | null;
    /** PET_STAGE_E2E=1 时启用 test:force-alpha 中继（运行期安全锁：非测试模式不暴露） */
    testMode: boolean;
}
export declare function registerStageIpc(options: PassthroughIpcOptions): void;
//# sourceMappingURL=passthrough.d.ts.map