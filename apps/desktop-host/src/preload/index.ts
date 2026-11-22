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
  // harness（T-M6-02）：ACP agents 统管
  harnessPresets: (): Promise<Array<{ id: string; label: string; command: string | null; authHint: string }>> =>
    ipcRenderer.invoke('harness:presets'),
  harnessStart: (presetId: string): Promise<{ ok: boolean; error?: string; authMethods?: string[] }> =>
    ipcRenderer.invoke('harness:start', presetId),
  harnessPrompt: (presetId: string, text: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> =>
    ipcRenderer.invoke('harness:prompt', presetId, text),
  harnessPermission: (presetId: string, requestId: number, outcome: 'allow' | 'always' | 'reject'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('harness:permission', presetId, requestId, outcome),
  harnessStop: (presetId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('harness:stop', presetId),
  harnessStatus: (): Promise<Array<{ presetId: string; label: string; running: boolean; sessions: string[] }>> =>
    ipcRenderer.invoke('harness:status'),
  onHarnessEvent: (handler: (event: unknown) => void) => {
    ipcRenderer.on('harness:event', (_e, event) => handler(event));
  },
  // pets 动作库（T-M5-16，D16）：manifest + 预览
  petsManifest: (): Promise<{ ok: boolean; manifest?: unknown; error?: string }> => ipcRenderer.invoke('pets:manifest'),
  petsPreview: (action: string, clipId: string | null): Promise<{ ok: boolean }> => ipcRenderer.invoke('pets:preview', action, clipId),
  // 饭碗档位（D16）：投喂与余额查询（autodrive 扣米在主进程）
  riceFeed: (grains: number): Promise<{ ok: boolean; balance: number }> => ipcRenderer.invoke('rice:feed', grains),
  riceStatus: (): Promise<{ balance: number }> => ipcRenderer.invoke('rice:status'),
  // LLM 大脑（T-M6-01 完整版）
  plannerSwitch: (mode: 'rule' | 'llm'): Promise<{ ok: boolean; error?: string; mode?: string }> => ipcRenderer.invoke('planner:switch', mode),
  plannerStatus: (): Promise<{ mode: string; llmReady: boolean }> => ipcRenderer.invoke('planner:status'),
  chatSay: (text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }> => ipcRenderer.invoke('chat:say', text),
  guidesLoad: (): Promise<{ ok: boolean; error?: string; topics?: string[] }> => ipcRenderer.invoke('guides:load'),
  // 语音（D11 第一版：macOS say 引擎）
  voiceSpeak: (text: string, scene: 'normal' | 'inner' | 'p0'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('voice:speak', { text, scene }),
  voiceConfigGet: (): Promise<{ enabled: boolean; innerVoice: boolean; volume: number; ratePercent: number; voice: string; pitchMul: number }> =>
    ipcRenderer.invoke('voice:config:get'),
  voiceConfigSet: (patch: { enabled?: boolean; innerVoice?: boolean; volume?: number; ratePercent?: number; voice?: string; pitchMul?: number; voiceId?: string }): Promise<{ enabled: boolean; innerVoice: boolean; volume: number; ratePercent: number; voice: string; pitchMul: number; voiceId: string }> =>
    ipcRenderer.invoke('voice:config:set', patch),
  voiceCatalog: (): Promise<{
    voices: Array<{ id: string; label: string; desc: string }>;
    modes: Array<{ id: string; label: string; emotion: string; pitch: number; speed: number; volume: number }>;
    currentVoiceId: string;
  }> => ipcRenderer.invoke('voice:catalog'),
  voiceAudition: (voiceId: string, mode: string, text?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('voice:audition', voiceId, mode, text),
  // 记忆图谱（T-M5-04）
  memoryQuery: (query: string): Promise<{
    ok: boolean;
    context: string;
    hits: Array<{ text: string; score: number; type: string }>;
    totalNodes: number;
  }> => ipcRenderer.invoke('memory:query', query),
  memoryDiary: (day?: string): Promise<{ ok: boolean; day?: string; text?: string; error?: string }> =>
    ipcRenderer.invoke('memory:diary', day),
  memoryStats: (): Promise<{ nodes: number; edges: number; lastDay: string | null }> =>
    ipcRenderer.invoke('memory:stats'),
  memoryWipe: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('memory:wipe'),
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
  // T-M5-16：动作库预览中继（main → pet-stage 窗）
  onPetPreview: (handler: (detail: { action: string; clipId: string | null }) => void) => {
    ipcRenderer.on('pet:preview', (_e, detail: { action: string; clipId: string | null }) => handler(detail));
  },
  onPetRice: (handler: (detail: { level: string; balance: number }) => void) => {
    ipcRenderer.on('pet:rice', (_e, detail: { level: string; balance: number }) => handler(detail));
  },
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
