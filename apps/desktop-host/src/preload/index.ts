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
  copyProviderKey: (providerId: string): Promise<{ ok: boolean; error?: string; mask?: string }> =>
    ipcRenderer.invoke('providers:copy-key', providerId),
  checkProviderBalance: (providerId: string): Promise<{ ok: boolean; error?: string; text?: string; raw?: string }> =>
    ipcRenderer.invoke('providers:check-balance', providerId),
  discoverModels: (args: { providerId: string; baseUrl: string; protocol?: 'openai' | 'anthropic' }): Promise<{ ok: boolean; error?: string; models?: string[] }> =>
    ipcRenderer.invoke('providers:discover-models', args),
  testProviderChat: (args: { providerId: string; baseUrl: string; modelId: string; protocol?: 'openai' | 'anthropic'; decision?: boolean }): Promise<{ ok: boolean; error?: string; latencyMs?: number }> =>
    ipcRenderer.invoke('providers:test-chat', args),
  openKeyConsole: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('providers:open-external', url),
  providerImportPickFile: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('providers:import-pick-file'),
  providerImportScan: (args: { source: 'magpie' | 'ccswitch' | 'file'; filePath?: string }): Promise<unknown> =>
    ipcRenderer.invoke('providers:import-scan', args),
  providerImportApply: (args: { source: 'magpie' | 'ccswitch' | 'file'; filePath?: string; selectedIds: string[]; policy: 'skip' | 'overwrite' }): Promise<unknown> =>
    ipcRenderer.invoke('providers:import-apply', args),
  // autodrive（T-M5-02）：启停/插队/事件订阅（事件经桥中继为 CustomEvent）
  autodriveStart: (gameId?: 'stardew' | 'terraria' | 'dst'): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('autodrive:start', gameId),
  autodriveStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('autodrive:stop'),
  autodriveStatus: (): Promise<{ running: boolean; gameId?: 'stardew' | 'terraria' | 'dst'; sessionId?: string; generation?: number; events?: unknown[] }> => ipcRenderer.invoke('autodrive:status'),
  // T-M6-27：expectedSessionId 用于拒绝来自已切换会话的迟到指令（可选，省略保持兼容）
  autodriveDirective: (tool: string, args: Record<string, unknown>, intent: string, expectedSessionId?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('autodrive:directive', tool, args, intent, expectedSessionId),
  onAutodriveEvent: (handler: (event: unknown) => void) => {
    ipcRenderer.on('autodrive:event', (_e, event) => handler(event));
  },
  // 三游戏桥接探活（T-M6-25）：只读探测 18080/18090/18100，返回 online/reachable/offline 三态
  gameHealth: (gameId: 'stardew' | 'terraria' | 'dst', endpoint?: string): Promise<unknown> =>
    ipcRenderer.invoke('game:health', gameId, endpoint),
  // DST 状态快照（补齐 T-M7-D5 面板缺失的 /state 注入）
  gameDstState: (): Promise<unknown> => ipcRenderer.invoke('game:dst-state'),
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
  // T-M6-31：外部插件生产链路（发现/启停/工具/审批/错误）
  pluginList: (): Promise<unknown> => ipcRenderer.invoke('plugin:list'),
  pluginToggle: (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('plugin:toggle', id, enabled),
  pluginTools: (): Promise<Array<{ name: string; pluginId: string; policy: 'allow' | 'ask' | 'deny'; description: string }>> =>
    ipcRenderer.invoke('plugin:tools'),
  pluginInvoke: (name: string, args?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('plugin:invoke', name, args ?? {}),
  pluginApprove: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('plugin:approve', name),
  pluginErrors: (): Promise<Array<{ id: string; error: string; phase: string }>> => ipcRenderer.invoke('plugin:errors'),
  pluginClearErrors: (): Promise<void> => ipcRenderer.invoke('plugin:clear-errors'),
  onPluginEvent: (handler: (event: { event: string; payload: unknown }) => void): void => {
    ipcRenderer.on('plugin:event', (_e, event) => handler(event));
  },
  // T-M6-37 直播最小链路（[SIMULATION] 回放 + 真实 hub 管线）
  liveIngest: (raw: unknown): Promise<{ status: string; reason?: string }> => ipcRenderer.invoke('live:ingest', raw),
  liveReplay: (): Promise<number> => ipcRenderer.invoke('live:replay'),
  liveSnapshot: (): Promise<unknown> => ipcRenderer.invoke('live:snapshot'),
  liveHistory: (): Promise<unknown> => ipcRenderer.invoke('live:history'),
  liveClear: (): Promise<void> => ipcRenderer.invoke('live:clear'),
  onLiveBatch: (handler: (batch: unknown) => void): void => {
    ipcRenderer.on('live:batch', (_e, batch) => handler(batch));
  },
  onHarnessEvent: (handler: (event: unknown) => void) => {
    ipcRenderer.on('harness:event', (_e, event) => handler(event));
  },
  // pets 动作库（T-M5-16，D16）：manifest + 预览
  petsManifest: (): Promise<{ ok: boolean; manifest?: unknown; error?: string }> => ipcRenderer.invoke('pets:manifest'),
  petsPreview: (action: string, clipId: string | null): Promise<{ ok: boolean }> => ipcRenderer.invoke('pets:preview', action, clipId),
  // 饭碗档位（D16）：投喂与余额查询（autodrive 扣米在主进程）
  riceFeed: (grains: number): Promise<{ ok: boolean; balance: number }> => ipcRenderer.invoke('rice:feed', grains),
  riceStatus: (): Promise<{ balance: number; budget: number; consumedToday: number; level: string }> => ipcRenderer.invoke('rice:status'),
  // T-M6-21 多角色注册表（切换由主进程写 prefs + 广播桌宠窗重载）
  characterList: (): Promise<Array<{ id: string; displayName: string; builtin: boolean; licenseScope: string; voiceId: string }>> => ipcRenderer.invoke('pet:character-list'),
  characterSelect: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('pet:character-select', id),
  // T-M6-22 多桌宠联机 agent 池
  coopEndpoints: (): Promise<unknown> => ipcRenderer.invoke('coop:endpoints'),
  coopStart: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('coop:start', id),
  coopStop: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('coop:stop', id),
  coopEndpointsSave: (endpoints: unknown[]): Promise<{ ok: boolean; error?: string; endpoints?: unknown[] }> =>
    ipcRenderer.invoke('coop:endpoints-save', endpoints),
  coopBlackboardGet: (): Promise<{ snapshot: unknown; messages: unknown[] }> => ipcRenderer.invoke('coop:blackboard-get'),
  coopGoalSet: (goal: unknown): Promise<{ ok: boolean; error?: string; goal?: unknown }> => ipcRenderer.invoke('coop:goal-set', goal),
  coopChatSend: (input: { text: string; mentions?: string[] }): Promise<{ ok: boolean; error?: string; route?: string; fallback?: boolean }> =>
    ipcRenderer.invoke('coop:chat-send', input),
  coopHuddleStart: (input?: { goalTitle?: string; reason?: string; note?: string }): Promise<{ ok: boolean; error?: string; fallback?: boolean; rounds?: number }> =>
    ipcRenderer.invoke('coop:huddle-start', input),
  coopLaunchStatus: (): Promise<unknown> => ipcRenderer.invoke('coop:launch-status'),
  coopLaunchHuman: (gameId: string): Promise<{ ok: boolean; error?: string; pid?: number }> => ipcRenderer.invoke('coop:launch-human', gameId),
  coopLaunchAi: (agentId: string): Promise<{ ok: boolean; error?: string; pid?: number; profileModsDir?: string; port?: number }> => ipcRenderer.invoke('coop:launch-ai', agentId),
  coopHelpRequest: (input: { agentId: string; reason: string }): Promise<{ ok: boolean; error?: string; mode?: string; helperAgentId?: string; fallback?: boolean }> =>
    ipcRenderer.invoke('coop:help-request', input),
  onCoopBlackboardUpdate: (handler: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => handler(payload);
    ipcRenderer.on('coop:blackboard-update', listener);
    return () => ipcRenderer.removeListener('coop:blackboard-update', listener);
  },
  onCoopCommsMessage: (handler: (message: unknown) => void): (() => void) => {
    const listener = (_e: unknown, message: unknown): void => handler(message);
    ipcRenderer.on('coop:comms-message', listener);
    return () => ipcRenderer.removeListener('coop:comms-message', listener);
  },
  // T-M6-38 多桌宠窗口（agentId 级独立坐标/缩放/锁定）
  petWindowOpen: (agentId: string, characterId?: string): Promise<{ ok: boolean; error?: string; window?: unknown }> =>
    ipcRenderer.invoke('pet:window-open', agentId, characterId),
  petWindowClose: (agentId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('pet:window-close', agentId),
  petWindowList: (): Promise<Array<{ agentId: string; characterId: string; visible: boolean; locked: boolean; bounds: { x: number; y: number; width: number; height: number } }>> =>
    ipcRenderer.invoke('pet:window-list'),
  petWindowPrefsSet: (agentId: string, update: { scale?: number; locked?: boolean; characterId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('pet:window-prefs-set', agentId, update),
  onPetWindowListChanged: (handler: (list: unknown) => void): (() => void) => {
    const listener = (_e: unknown, list: unknown): void => handler(list);
    ipcRenderer.on('pet:window-list-changed', listener);
    return () => ipcRenderer.removeListener('pet:window-list-changed', listener);
  },
  petPackCatalog: (): Promise<unknown> => ipcRenderer.invoke('pet:pack-catalog'),
  petPackImport: (input?: { all?: boolean; packSlugs?: string[] }): Promise<unknown> => ipcRenderer.invoke('pet:pack-import', input),
  onPetPackImportProgress: (handler: (progress: unknown) => void): (() => void) => {
    const listener = (_e: unknown, progress: unknown): void => handler(progress);
    ipcRenderer.on('pet:pack-import-progress', listener);
    return () => ipcRenderer.removeListener('pet:pack-import-progress', listener);
  },
  onCoopSpeaker: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_e: unknown, event: unknown): void => handler(event);
    ipcRenderer.on('coop:speaker', listener);
    return () => ipcRenderer.removeListener('coop:speaker', listener);
  },
  // 桌宠桌面偏好（T-M6-20 缩放滑块 / T-M6-19 拖拽手感）
  prefsGet: (): Promise<unknown> => ipcRenderer.invoke('pet:prefs-get'),
  prefsSet: (update: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('pet:prefs-set', update),
  // 运行时大脑配置（Dexie 套餐/槽位 → 主进程 gateway；不含任何密钥）
  brainApplyConfig: (config: unknown): Promise<unknown> => ipcRenderer.invoke('brain:apply-config', config),
  // LLM 大脑（T-M6-01 完整版）
  plannerSwitch: (mode: 'rule' | 'llm'): Promise<{ ok: boolean; error?: string; mode?: string }> => ipcRenderer.invoke('planner:switch', mode),
  plannerStatus: (): Promise<{ mode: string; llmReady: boolean }> => ipcRenderer.invoke('planner:status'),
  chatSay: (text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }> => ipcRenderer.invoke('chat:say', text),
  guidesLoad: (): Promise<{ ok: boolean; error?: string; topics?: string[] }> => ipcRenderer.invoke('guides:load'),
  // 语音（D11 第一版：macOS say 引擎）
  voiceSpeak: (text: string, scene: 'normal' | 'inner' | 'p0'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('voice:speak', { text, scene }),
  // T-M6-33：实际语音后端（mcode / say / unsupported），界面如实展示
  voiceBackend: (): Promise<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string }> =>
    ipcRenderer.invoke('voice:backend'),
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
  // 星露谷 Mod 管理（T-M6-06）：只经主进程读写玩家 Mods 目录
  modsState: (): Promise<unknown> => ipcRenderer.invoke('mods:state'),
  // BWF 游戏内 HUD 开关（T-M6-16）：默认关闭；主进程持久化 + /settings 运行时下发
  modsSetBwfHud: (value: boolean): Promise<{
    ok: boolean; showHud?: boolean; applied?: boolean; needsGameRestart?: boolean; gameOffline?: boolean; error?: string;
  }> => ipcRenderer.invoke('mods:set-bwf-hud', value),
  modsSetDir: (dir: string): Promise<unknown> => ipcRenderer.invoke('mods:set-dir', dir),
  modsScan: (): Promise<unknown> => ipcRenderer.invoke('mods:scan'),
  modsToggle: (folderName: string, enabled: boolean): Promise<unknown> => ipcRenderer.invoke('mods:toggle', folderName, enabled),
  modsInstallZip: (): Promise<unknown> => ipcRenderer.invoke('mods:install-zip'),
  modsOpenDir: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('mods:open-dir'),
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
  memoryGraph: (): Promise<unknown> => ipcRenderer.invoke('memory:graph'),
  memoryPin: (id: string, pinned: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('memory:pin', id, pinned),
  webuiInfo: (): Promise<{ ok: boolean; port: number; token: string }> => ipcRenderer.invoke('webui:info'),
});

contextBridge.exposeInMainWorld('petStage', {
  ready: true,
  setPassthrough: (state: 'passthrough' | 'interactive') => ipcRenderer.invoke('passthrough:set', state),
  forceInteractive: (on: boolean): Promise<boolean> => ipcRenderer.invoke('passthrough:force', on),
  getState: (): Promise<'passthrough' | 'interactive'> => ipcRenderer.invoke('passthrough:get'),
  screenBounds: () => ipcRenderer.invoke('screen:bounds'),
  mousePoint: () => ipcRenderer.invoke('cursor:point'),
  winPosition: (): Promise<[number, number] | null> => ipcRenderer.invoke('win:get-position'),
  dragTo: (x: number, y: number): Promise<[number, number] | null> => ipcRenderer.invoke('win:drag-to', x, y),
  // T-M6-19：桌宠桌面偏好（位置/缩放/拖拽手感/角色/联机端点）文件 KV
  prefsGet: (): Promise<unknown> => ipcRenderer.invoke('pet:prefs-get'),
  prefsSet: (update: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('pet:prefs-set', update),
  // T-M6-38：按 agentId 隔离的窗口坐标/缩放/锁定
  windowPrefsGet: (agentId: string): Promise<unknown> => ipcRenderer.invoke('pet:window-prefs-get', agentId),
  windowPrefsSet: (agentId: string, update: { scale?: number; locked?: boolean; characterId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('pet:window-prefs-set', agentId, update),
  pokeLine: (agentId: string): Promise<{ ok: boolean; characterId?: string; line?: string }> => ipcRenderer.invoke('pet:poke-line', agentId),
  dockWindow: (agentId: string, edge: 'left' | 'right' | null): Promise<unknown> =>
    edge === null ? ipcRenderer.invoke('pet:window-undock', agentId) : ipcRenderer.invoke('pet:window-dock', agentId, edge),
  clearDock: (agentId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('pet:window-clear-dock', agentId),
  setPeek: (active: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('pet:peek', active),
  onGlobalPrefsChanged: (handler: (prefs: unknown) => void): (() => void) => {
    const listener = (_e: unknown, prefs: unknown): void => handler(prefs);
    ipcRenderer.on('pet:global-prefs-changed', listener);
    return () => ipcRenderer.removeListener('pet:global-prefs-changed', listener);
  },
  onWindowPrefsChanged: (handler: (prefs: { scale: number; locked: boolean; characterId: string }) => void): void => {
    ipcRenderer.on('pet:window-prefs-changed', (_e, prefs) => handler(prefs));
  },
  onCoopSpeaker: (handler: (event: { activeAgentId: string | null; speakerName: string; state: 'speaking' | 'idle'; voiceId?: string }) => void): void => {
    ipcRenderer.on('coop:speaker', (_e, event) => handler(event));
  },
  onSpeechResult: (handler: (event: { agentId: string; speakerName: string; status: 'completed' | 'failed' | 'timeout' | 'interrupted' }) => void): () => void => {
    const listener = (_e: unknown, event: { agentId: string; speakerName: string; status: 'completed' | 'failed' | 'timeout' | 'interrupted' }): void => handler(event);
    ipcRenderer.on('pet:speech-result', listener);
    return () => ipcRenderer.removeListener('pet:speech-result', listener);
  },
  onPetAction: (handler: (event: { agentId: string; action: string }) => void): void => {
    ipcRenderer.on('pet:action', (_e, event) => handler(event));
  },
  onPetBubble: (handler: (event: { agentId: string; text: string; kind?: 'thought' | 'dialog' }) => void): void => {
    ipcRenderer.on('pet:bubble', (_e, event) => handler(event));
  },
  onPetState: (handler: (event: { agentId: string; state?: unknown }) => void): void => {
    ipcRenderer.on('pet:state', (_e, event) => handler(event));
  },
  onScaleChanged: (handler: (scale: number) => void): void => {
    ipcRenderer.on('pet:scale-changed', (_e, scale: number) => handler(scale));
  },
  // T-M6-21 多角色：manifest 与切换事件
  characterManifest: (id: string): Promise<{ ok: boolean; manifest?: unknown; error?: string }> =>
    ipcRenderer.invoke('pet:character-manifest', id),
  onCharacterChanged: (handler: (character: { id: string; anchorRatio: number }) => void): void => {
    ipcRenderer.on('pet:character-changed', (_e, c: { id: string; anchorRatio: number }) => handler(c));
  },
  // T-M1-05 改版：桌宠窗自拉饭碗余额（默认隐藏 / hover 显示 / 饿态亮灯）
  riceStatus: (): Promise<{ balance: number; budget: number; consumedToday: number; level: string }> =>
    ipcRenderer.invoke('rice:status'),
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
        testGlobalAltPeek: (point: { x: number; y: number }, altDown: boolean) => ipcRenderer.invoke('test:alt-peek', point, altDown),
        testFullscreenApply: (rect: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.invoke('test:fullscreen-apply', rect),
        // main 中继 test:force-alpha → 转发为 renderer 可见的 CustomEvent
        onTestAlpha: (handler: (alpha: number) => void) => {
          ipcRenderer.on('pet-stage:test-alpha', (_event, alpha: number) => handler(alpha));
        },
      }
    : {}),
});
