/**
 * preload directorBridge 的 renderer 侧类型（T-dir-01）。
 * 明文 key 只上行；渲染进程永远只见掩码（运行期安全锁）。
 */
export interface ProviderVaultResponse {
  ok: boolean;
  error?: string;
  mask?: string;
  models?: string[];
  latencyMs?: number;
}

export interface HarnessPresetInfo {
  id: string; label: string; command: string | null; authHint: string;
}
export interface HarnessStatusInfo {
  presetId: string; label: string; running: boolean; sessions: string[];
}
export interface HarnessEventMsg {
  presetId: string;
  type: 'initialized' | 'session-started' | 'update' | 'permission' | 'turn-complete' | 'auth-required' | 'error' | 'exit';
  sessionId?: string; block?: { type: string; text?: string };
  requestId?: number; toolName?: string; input?: Record<string, unknown>;
  message?: string; code?: number;
}

export interface DirectorBridge {
  saveProviderKey(providerId: string, plainKey: string): Promise<ProviderVaultResponse>;
  providerKeyMask(providerId: string): Promise<ProviderVaultResponse>;
  discoverModels(args: { providerId: string; baseUrl: string }): Promise<ProviderVaultResponse>;
  testProviderChat(args: { providerId: string; baseUrl: string; modelId: string }): Promise<ProviderVaultResponse>;
}

export interface AutodriveEventView {
  type: 'state' | 'decision' | 'receipt' | 'watchdog' | 'cycle-end';
  clock?: string;
  stamina?: number;
  staminaMax?: number;
  money?: number;
  location?: string;
  planner?: string;
  tool?: string;
  args?: Record<string, unknown>;
  intent?: string;
  status?: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR';
  summary?: string;
  kind?: 'stuck' | 'heartbeat';
  detail?: string;
  delayMs?: number;
}

export interface HarnessPresetInfo {
  id: string; label: string; command: string | null; authHint: string;
}
export interface HarnessStatusInfo {
  presetId: string; label: string; running: boolean; sessions: string[];
}
export interface HarnessEventMsg {
  presetId: string;
  type: 'initialized' | 'session-started' | 'update' | 'permission' | 'turn-complete' | 'auth-required' | 'error' | 'exit';
  sessionId?: string; block?: { type: string; text?: string };
  requestId?: number; toolName?: string; input?: Record<string, unknown>;
  message?: string; code?: number;
}

export interface DirectorBridge {
  saveProviderKey(providerId: string, plainKey: string): Promise<ProviderVaultResponse>;
  providerKeyMask(providerId: string): Promise<ProviderVaultResponse>;
  discoverModels(args: { providerId: string; baseUrl: string }): Promise<ProviderVaultResponse>;
  testProviderChat(args: { providerId: string; baseUrl: string; modelId: string }): Promise<ProviderVaultResponse>;
  autodriveStart(): Promise<{ ok: boolean; error?: string }>;
  autodriveStop(): Promise<{ ok: boolean }>;
  autodriveStatus(): Promise<{ running: boolean }>;
  autodriveDirective(tool: string, args: Record<string, unknown>, intent: string): Promise<{ ok: boolean }>;
  onAutodriveEvent(handler: (event: AutodriveEventView) => void): void;
  harnessPresets(): Promise<HarnessPresetInfo[]>;
  harnessStart(presetId: string): Promise<{ ok: boolean; error?: string; authMethods?: string[] }>;
  harnessPrompt(presetId: string, text: string): Promise<{ ok: boolean; error?: string; sessionId?: string }>;
  harnessPermission(presetId: string, requestId: number, outcome: 'allow' | 'always' | 'reject'): Promise<{ ok: boolean }>;
  harnessStop(presetId: string): Promise<{ ok: boolean }>;
  harnessStatus(): Promise<HarnessStatusInfo[]>;
  onHarnessEvent(handler: (event: HarnessEventMsg) => void): void;
  petsManifest(): Promise<{ ok: boolean; manifest?: unknown; error?: string }>;
  petsPreview(action: string, clipId: string | null): Promise<{ ok: boolean }>;
  riceFeed(grains: number): Promise<{ ok: boolean; balance: number }>;
  riceStatus(): Promise<{ balance: number }>;
  plannerSwitch(mode: 'rule' | 'llm'): Promise<{ ok: boolean; error?: string; mode?: string }>;
  plannerStatus(): Promise<{ mode: string; llmReady: boolean }>;
  chatSay(text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }>;
  guidesLoad(): Promise<{ ok: boolean; error?: string; topics?: string[] }>;
  voiceSpeak(text: string, scene: 'normal' | 'inner' | 'p0'): Promise<{ ok: boolean; error?: string }>;
  voiceConfigGet(): Promise<{ enabled: boolean; innerVoice: boolean; volume: number; ratePercent: number; voice: string; pitchMul: number }>;
  voiceConfigSet(patch: { enabled?: boolean; innerVoice?: boolean; volume?: number; ratePercent?: number; voice?: string; pitchMul?: number; voiceId?: string }): Promise<{ enabled: boolean; innerVoice: boolean; volume: number; ratePercent: number; voice: string; pitchMul: number; voiceId: string }>;
  voiceCatalog(): Promise<{
    voices: Array<{ id: string; label: string; desc: string }>;
    modes: Array<{ id: string; label: string; emotion: string; pitch: number; speed: number; volume: number }>;
    currentVoiceId: string;
  }>;
  voiceAudition(voiceId: string, mode: string, text?: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    directorBridge: DirectorBridge;
  }
}
