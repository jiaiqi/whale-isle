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
}

declare global {
  interface Window {
    directorBridge: DirectorBridge;
  }
}
