/**
 * preload 桥（contextIsolation 开启）：renderer ↔ main 的唯一通道。
 * forceAlpha 仅在 PET_STAGE_E2E=1 时暴露（运行期安全锁）。
 */
import { contextBridge, ipcRenderer } from 'electron';
const TEST_MODE = process.env.PET_STAGE_E2E === '1';
contextBridge.exposeInMainWorld('petStage', {
    ready: true,
    setPassthrough: (state) => ipcRenderer.invoke('passthrough:set', state),
    getState: () => ipcRenderer.invoke('passthrough:get'),
    screenBounds: () => ipcRenderer.invoke('screen:bounds'),
    mousePoint: () => ipcRenderer.invoke('cursor:point'),
    winPosition: () => ipcRenderer.invoke('win:get-position'),
    dragTo: (x, y) => ipcRenderer.invoke('win:drag-to', x, y),
    appMeta: () => ipcRenderer.invoke('app:meta'),
    ...(TEST_MODE
        ? {
            forceAlpha: (alpha) => ipcRenderer.invoke('test:force-alpha', alpha),
            // main 中继 test:force-alpha → 转发为 renderer 可见的 CustomEvent
            onTestAlpha: (handler) => {
                ipcRenderer.on('pet-stage:test-alpha', (_event, alpha) => handler(alpha));
            },
        }
        : {}),
});
//# sourceMappingURL=index.js.map