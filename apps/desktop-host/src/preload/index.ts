/**
 * preload 桥（contextIsolation 开启）：renderer ↔ main 的唯一通道。
 * forceAlpha 仅在 PET_STAGE_E2E=1 时暴露（运行期安全锁）。
 */
import { contextBridge, ipcRenderer } from 'electron';

const TEST_MODE = process.env.PET_STAGE_E2E === '1';

/**
 * 中控台桥（T-dir-01，Magpie 交互思想）：供应商凭据/模型发现只经主进程。
 * 明文 key 只上行、永不下行——渲染进程拿到的只有掩码。
 */
contextBridge.exposeInMainWorld('directorBridge', {
  saveProviderKey: (providerId: string, plainKey: string): Promise<{ ok: boolean; error?: string; mask?: string }> =>
    ipcRenderer.invoke('providers:save-key', providerId, plainKey),
  providerKeyMask: (providerId: string): Promise<{ ok: boolean; error?: string; mask?: string }> =>
    ipcRenderer.invoke('providers:key-mask', providerId),
  discoverModels: (args: { providerId: string; baseUrl: string }): Promise<{ ok: boolean; error?: string; models?: string[] }> =>
    ipcRenderer.invoke('providers:discover-models', args),
  testProviderChat: (args: { providerId: string; baseUrl: string; modelId: string }): Promise<{ ok: boolean; error?: string; latencyMs?: number }> =>
    ipcRenderer.invoke('providers:test-chat', args),
  // autodrive（T-M5-02）：启停/插队/事件订阅（事件经桥中继为 CustomEvent）
  autodriveStart: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('autodrive:start'),
  autodriveStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('autodrive:stop'),
  autodriveStatus: (): Promise<{ running: boolean }> => ipcRenderer.invoke('autodrive:status'),
  autodriveDirective: (tool: string, args: Record<string, unknown>, intent: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('autodrive:directive', tool, args, intent),
  onAutodriveEvent: (handler: (event: unknown) => void) => {
    ipcRenderer.on('autodrive:event', (_e, event) => handler(event));
  },
});

contextBridge.exposeInMainWorld('petStage', {
  ready: true,
  setPassthrough: (state: 'passthrough' | 'interactive') => ipcRenderer.invoke('passthrough:set', state),
  getState: (): Promise<'passthrough' | 'interactive'> => ipcRenderer.invoke('passthrough:get'),
  screenBounds: () => ipcRenderer.invoke('screen:bounds'),
  mousePoint: () => ipcRenderer.invoke('cursor:point'),
  winPosition: (): Promise<[number, number] | null> => ipcRenderer.invoke('win:get-position'),
  dragTo: (x: number, y: number): Promise<[number, number] | null> => ipcRenderer.invoke('win:drag-to', x, y),
  appMeta: () => ipcRenderer.invoke('app:meta'),
  ...(TEST_MODE
    ? {
        forceAlpha: (alpha: number) => ipcRenderer.invoke('test:force-alpha', alpha),
        // main 中继 test:force-alpha → 转发为 renderer 可见的 CustomEvent
        onTestAlpha: (handler: (alpha: number) => void) => {
          ipcRenderer.on('pet-stage:test-alpha', (_event, alpha: number) => handler(alpha));
        },
      }
    : {}),
});
