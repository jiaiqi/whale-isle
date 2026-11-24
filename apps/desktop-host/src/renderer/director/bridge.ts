/**
 * preload directorBridge 的 renderer 侧类型（T-dir-01）。
 * 明文 key 只上行；渲染进程永远只见掩码（运行期安全锁）。
 */
import type {
  CoopSpeakerEvent,
  McpEndpoint,
  PetWindowView,
  TeamBlackboardSnapshot,
  TeamCommsMessage,
  TeamGoal,
  TeamPlan,
} from '@workbench/shared-protocol';

export const GAME_OPTIONS = [
  { id: 'stardew', label: '星露谷物语', shortLabel: '星露谷' },
  { id: 'terraria', label: '泰拉瑞亚', shortLabel: '泰拉瑞亚' },
  { id: 'dst', label: '饥荒 DST', shortLabel: '饥荒 DST' },
] as const;

export type GameId = (typeof GAME_OPTIONS)[number]['id'];

/** 当前会话标识（T-M6-27）：主进程在每次重建 runner 时推进 generation 并签发 sessionId */
export interface AutodriveSessionView {
  sessionId?: string;
  gameId?: GameId;
  generation: number;
}

/**
 * 事件是否属于「当前会话」（T-M6-27）。
 * 规则（任一不满足即丢弃）：
 *   ① 联机端点事件（带 agentId）不进单会话页；
 *   ② generation 低于当前值 → 旧会话迟到事件；
 *   ③ sessionId 已知且不一致 → 异会话；
 *   ④ gameId 已知且与当前选中游戏不一致 → 切走后的残留。
 */
export function isCurrentSessionEvent(
  event: AutodriveEventView,
  current: AutodriveSessionView,
  activeGame: GameId,
): boolean {
  if (event.agentId !== undefined) return false;
  if (event.generation !== undefined && event.generation < current.generation) return false;
  if (event.sessionId !== undefined && current.sessionId !== undefined && event.sessionId !== current.sessionId) return false;
  if (event.gameId !== undefined && event.gameId !== activeGame) return false;
  return true;
}

export interface CharacterSummary {
  id: string;
  displayName: string;
  builtin: boolean;
  licenseScope: string;
  voiceId: string;
  /** 来源包 id（aboutme-pets / crosspet-*）；主条只展示 9 角色，CrossPet 由召唤/跟随使用 */
  packId?: string;
}

/** 联机端点视图（主进程 coop:endpoints） */
/** aboutme-pets 角色包商店视图（主进程 pet:pack-catalog） */
export interface LaunchStatusView {
  gameId: GameId;
  detected: boolean;
  executable: string | null;
  /** T-M6-47：泰拉瑞亚客户端与桥接 Mod、DST 集群目录 */
  clientExecutable?: string | null;
  bridge?: { detected: boolean; path: string | null; detail: string };
  clusterRoot?: string;
  detail: string;
  agents: Array<{ agentId: string; profileDir: string; ready: boolean }>;
}

export interface DstWizardStatusView {
  clusterDir: string;
  tokenSaved: boolean;
  overridesSaved: boolean;
  sidecarEntry: string;
  sidecarAvailable: boolean;
  agents: Array<{ id: string; routingId: string; characterId: string }>;
}
export interface PetPackCatalogItem {
  slug: string;
  catalogId: string;
  displayName: string;
  personaPrompt: string;
  voiceId: string;
  installed: boolean;
  actionCount: number;
  audioClipCount: number;
}
export interface PetPackImportProgress {
  phase: 'catalog' | 'manifest' | 'sprite' | 'audio' | 'character' | 'pack-done';
  packId: string;
  completed: number;
  total: number;
  message: string;
}

export interface CoopEndpointView {
  id: string;
  displayName: string;
  gameId: GameId;
  endpoint: string;
  characterId: string;
  routingId: string;
  enabled: boolean;
  running: boolean;
  error: string | null;
  characterName: string;
}

export interface ProviderVaultResponse {
  ok: boolean;
  error?: string;
  mask?: string;
  models?: string[];
  /** Console（原 Zen）清单元数据：免费档 chat / 决策协议模型 */
  freeModels?: string[];
  decisionModels?: string[];
  latencyMs?: number;
  /** check-balance：可读余额文案 + 原始响应前 300 字 */
  text?: string;
  raw?: string;
}

export interface ImportProviderPreview {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  keyMask: string;
  matchedBuiltin: boolean;
}

export interface ImportScanView {
  ok: boolean;
  error?: string;
  source: 'magpie' | 'ccswitch' | 'file';
  detectedPath: string;
  items: ImportProviderPreview[];
}

export interface ImportedProviderMeta {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  isFullUrl: boolean;
  models: string[];
  matchedBuiltin: boolean;
  action: 'create' | 'update' | 'skip';
  keyMask: string;
}

export interface ImportApplyView {
  ok: boolean;
  error?: string;
  items: ImportedProviderMeta[];
}

export interface BrainApplyView {
  ok: boolean;
  mode: 'rule' | 'llm';
  llmReady: boolean;
  providers: string[];
  missingKeys: string[];
  error?: string;
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

export interface GameHealthView {
  gameId: GameId;
  endpoint: string;
  /** online=桥接在线且游戏侧就绪；reachable=能连上但未就绪；offline=连不上 */
  status: 'online' | 'reachable' | 'offline';
  ok: boolean;
  latencyMs: number;
  detail: string;
  error?: string;
  guidance: string[];
  checkedAt: number;
}

export interface AutodriveEventView {
  type: 'state' | 'decision' | 'receipt' | 'watchdog' | 'cycle-end' | 'user' | 'objective';
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
  /** T-M6-57 目标生命周期事件 */
  objective?: string | null;
  reason?: 'set' | 'replaced' | 'cancel' | 'done';
  /** 主进程单调序号：刷新水合时去重（同一事件不插两次卡） */
  seq?: number;
  /** T-M6-27 会话归属：单例 autodrive 事件带 sessionId/gameId/generation；联机端点事件带 agentId */
  sessionId?: string;
  gameId?: GameId;
  generation?: number;
  agentId?: string;
}

export interface DirectorBridge {
  saveProviderKey(providerId: string, plainKey: string): Promise<ProviderVaultResponse>;
  providerKeyMask(providerId: string): Promise<ProviderVaultResponse>;
  copyProviderKey(providerId: string): Promise<ProviderVaultResponse>;
  checkProviderBalance(providerId: string): Promise<ProviderVaultResponse>;
  openKeyConsole(url: string): Promise<{ ok: boolean; error?: string }>;
  discoverModels(args: { providerId: string; baseUrl: string; protocol?: 'openai' | 'anthropic' }): Promise<ProviderVaultResponse>;
  testProviderChat(args: { providerId: string; baseUrl: string; modelId: string; protocol?: 'openai' | 'anthropic'; decision?: boolean }): Promise<ProviderVaultResponse>;
  providerImportPickFile(): Promise<{ ok: boolean; path?: string; error?: string }>;
  providerImportScan(args: { source: 'magpie' | 'ccswitch' | 'file'; filePath?: string }): Promise<ImportScanView>;
  providerImportApply(args: { source: 'magpie' | 'ccswitch' | 'file'; filePath?: string; selectedIds: string[]; policy: 'skip' | 'overwrite' }): Promise<ImportApplyView>;
  autodriveStart(gameId?: GameId): Promise<{ ok: boolean; error?: string }>;
  autodriveStop(): Promise<{ ok: boolean }>;
  autodriveObjectiveStatus(): Promise<{ ok: boolean; objective: string | null }>;
  autodriveClearObjective(): Promise<{ ok: boolean; had?: boolean; objective?: string }>;
  autodriveStatus(): Promise<{ running: boolean; gameId?: GameId; sessionId?: string; generation?: number; events?: AutodriveEventView[] }>;
  autodriveDirective(tool: string, args: Record<string, unknown>, intent: string, expectedSessionId?: string): Promise<{ ok: boolean; error?: string }>;
  onAutodriveEvent(handler: (event: AutodriveEventView) => void): void;
  // 三游戏桥接探活（T-M6-25）：只读探测 18080/18090/18100
  gameHealth(gameId: GameId, endpoint?: string): Promise<GameHealthView>;
  // DST 状态快照（T-M7-D5 面板补齐 /state 注入）
  gameDstState(): Promise<{ ok: boolean; snapshot?: import('@workbench/shared-protocol').DstStateSnapshot; error?: string }>;
  harnessPresets(): Promise<HarnessPresetInfo[]>;
  harnessStart(presetId: string): Promise<{ ok: boolean; error?: string; authMethods?: string[] }>;
  harnessPrompt(presetId: string, text: string): Promise<{ ok: boolean; error?: string; sessionId?: string }>;
  harnessPermission(presetId: string, requestId: number, outcome: 'allow' | 'always' | 'reject'): Promise<{ ok: boolean }>;
  harnessStop(presetId: string): Promise<{ ok: boolean }>;
  harnessStatus(): Promise<HarnessStatusInfo[]>;
  onHarnessEvent(handler: (event: HarnessEventMsg) => void): void;
  // T-M6-31 外部插件
  pluginList(): Promise<Array<{ id: string; name: string; version: string; description: string; enabled: boolean; tools: string[]; error?: string }>>;
  pluginToggle(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  pluginTools(): Promise<Array<{ name: string; pluginId: string; policy: 'allow' | 'ask' | 'deny'; description: string }>>;
  pluginInvoke(name: string, args?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  pluginApprove(name: string): Promise<{ ok: boolean; error?: string }>;
  pluginErrors(): Promise<Array<{ id: string; error: string; phase: string }>>;
  pluginClearErrors(): Promise<void>;
  onPluginEvent(handler: (event: { event: string; payload: unknown }) => void): void;
  // T-M6-37 直播最小链路
  liveIngest(raw: unknown): Promise<{ status: string; reason?: string }>;
  liveReplay(): Promise<number>;
  liveSnapshot(): Promise<Record<string, unknown>>;
  liveHistory(): Promise<Array<{ tier: string; at: number; events: Array<{ eventId: string; eventType: string; nickname: string; text: string; priority: string }> }>>;
  liveClear(): Promise<void>;
  onLiveBatch(handler: (batch: unknown) => void): void;
  petsManifest(): Promise<{ ok: boolean; manifest?: unknown; error?: string }>;
  petsPreview(action: string, clipId: string | null): Promise<{ ok: boolean }>;
  /** T-M6-45 随包素材目录（1,040 动作 / 11 槽位 / 皮肤彩蛋 / 字体） */
  petStudioCatalog(): Promise<import('@workbench/shared-protocol').PetStudioCatalog>;
  petPacksRoot(): Promise<string>;
  /** T-M6-48 友谊 / 小本子 / 互聊 / 多宠召唤 */
  friendRecord(characterId: string, action: 'pat' | 'poke' | 'chat' | 'cowork' | 'cofinish'): Promise<unknown>;
  friendNotebook(characterId: string): Promise<{
    characterId: string;
    stats: { points: number; dailyGained: number; quarterHearts: number; hearts: number; tier: string; pats: number; pokes: number; rounds: number; cowork: number; cofinish: number } | null;
    notes: Array<{ id: number; text: string; createdAt: number }>;
    banter: Array<{ id: number; aName: string; aText: string; bName: string; bText: string; createdAt: number }>;
  }>;
  friendNoteAdd(characterId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  friendWipe(): Promise<{ ok: boolean }>;
  friendPairChat(): Promise<{ ok: boolean; aName?: string; aText?: string; bName?: string; bText?: string; error?: string }>;
  friendGreeting(characterId: string): Promise<string>;
  friendMeet(characterId: string): Promise<string>;
  petSummon(characterId: string): Promise<{ ok: boolean; agentId?: string; error?: string }>;
  petAssemble(): Promise<{ ok: boolean; windows: unknown[] }>;
  petDismiss(): Promise<{ ok: boolean; closed: number }>;
  petEggSummon(): Promise<{ ok: boolean; agentId?: string; characterId?: string; name?: string; error?: string }>;
  /** T-M6-49 跨 AI 工作跟随 */
  workFollowStatus(): Promise<import('@workbench/shared-protocol').WorkFollowStatus>;
  workFollowIngest(event: unknown): Promise<{ ok: boolean; error?: string }>;
  workFollowMode(mode: 'single' | 'multi'): Promise<import('@workbench/shared-protocol').WorkFollowStatus>;
  /** T-M6-58：本机 CLI 钩子安装与自检 */
  workFollowCliStatus(): Promise<Array<{ source: string; label: string; detected: boolean; mode: 'json' | 'manual'; installed: boolean; configPath: string; snippet: string; error?: string }>>;
  workFollowCliInstall(source: string): Promise<{ ok: boolean; mode: 'json' | 'manual'; installed?: boolean; snippet?: string; backupPath?: string; error?: string }>;
  workFollowCliUninstall(source: string): Promise<{ ok: boolean; mode: 'json' | 'manual'; installed?: boolean; snippet?: string; backupPath?: string; error?: string }>;
  workFollowCliSnippet(source: string): Promise<{ ok: boolean; snippet: string }>;
  workFollowSelfTest(): Promise<{ ok: boolean; elapsedMs: number; error?: string }>;
  onWorkFollowUpdate(handler: (status: import('@workbench/shared-protocol').WorkFollowStatus) => void): () => void;
  onOpenPetNotebook(handler: () => void): void;
  /** T-M6-53 创作中心 / 验收台 */
  pathForFile(file: File): string;
  creatorPoseTiers(): Promise<{ tiers: Array<{ id: 'A' | 'B' | 'C' | 'MEME'; label: string; count: number; poses: Array<{ id: string; hint: string }> }>; locks: Array<{ id: string; label: string; reference: string; traits: string }> }>;
  creatorCompileCharacter(input: unknown): Promise<{ ok: boolean; prompt: string }>;
  creatorCompileEgg(input: unknown): Promise<{ ok: boolean; prompt: string }>;
  creatorPickImages(): Promise<{ ok: boolean; paths?: string[] }>;
  creatorPickFolder(): Promise<{ ok: boolean; folder?: string }>;
  creatorImport(input: unknown): Promise<{ ok: boolean; id?: string; poses?: string[]; avatar?: string; portrait?: string; warnings?: string[]; error?: string }>;
  creatorGenerateEggLines(input: unknown): Promise<{ ok: boolean; lines?: Record<string, string[]>; error?: string }>;
  creatorImageGenProviders(descriptors: unknown): Promise<{ ok: boolean; detected?: number; configured?: number; codex?: { detected: boolean; backend: 'codex-imagegen' | 'codex-exec' | null; loggedIn: boolean; installHint: string; loginHint: string }; providers?: Array<{ id: string; name: string; protocol: 'openai' | 'gemini' | 'codex-cli'; baseUrl: string; models: string[] }> }>;
  creatorGenerateBatch(input: unknown): Promise<{ ok: boolean; jobId?: string; items?: Array<{ pose: string; status: string; file?: string; error?: string }>; error?: string }>;
  creatorRegenerateOne(input: unknown): Promise<{ ok: boolean; jobId?: string; item?: { pose: string; status: string; file?: string; error?: string }; error?: string }>;
  creatorCommitDraft(input: unknown): Promise<{ ok: boolean; id?: string; poses?: string[]; warnings?: string[]; error?: string }>;
  onCreatorGenProgress(handler: (progress: { jobId: string; pose: string; status: 'queued' | 'generating' | 'done' | 'failed'; index: number; total: number; dataUrl?: string; file?: string; error?: string }) => void): () => void;
  creatorListCustom(): Promise<Array<{ id: string; name: string; poses: string[] }>>;
  /** T-M6-62：星露谷像素表生成与外观同步 */
  creatorCompileStardewSprite(input: { name: string; traits?: string }): Promise<{ ok: boolean; prompt: string }>;
  creatorGenerateStardewSprite(input: unknown): Promise<{ ok: boolean; dataUrl?: string; emptyCells?: number; error?: string }>;
  creatorStardewSpriteGet(characterId: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  stardewAvatarState(): Promise<{ enabled: boolean; modsDir: string | null; modInstalled: boolean; modCompiled: boolean; syncedCharacterId: string | null; syncedDisplayName: string | null; syncedSpriteReady: boolean }>;
  stardewAvatarSetEnabled(next: boolean): Promise<{ enabled: boolean; modsDir: string | null; modInstalled: boolean; modCompiled: boolean; syncedCharacterId: string | null; syncedDisplayName: string | null; syncedSpriteReady: boolean }>;
  onStardewAvatarChanged(handler: () => void): () => void;
  stardewAvatarInstall(): Promise<{ ok: boolean; error?: string; compiled?: boolean }>;
  stardewAvatarUninstall(): Promise<{ ok: boolean; error?: string }>;
  stardewAvatarSyncNow(): Promise<{ ok: boolean; error?: string; sprite?: boolean }>;
  stardewAvatarApplyCharacter(characterId: string): Promise<{ ok: boolean; error?: string; sprite?: boolean }>;
  customList(): Promise<{ entries: Array<{ id: string; characterId: string; name: string; poses: string[]; reactTo: string | string[]; outfit: string; actionCount: number }>; errors: string[] }>;
  customGet(id: string): Promise<{ ok: boolean; id?: string; name?: string; poses?: string[]; data?: unknown; error?: string }>;
  customSave(id: string, input: unknown): Promise<{ ok: boolean; error?: string }>;
  customRename(id: string, name: string): Promise<{ ok: boolean; error?: string }>;
  customClone(input: { builtinId: string; newId: string; displayName?: string }): Promise<{ ok: boolean; characterId?: string; error?: string }>;
  customReload(): Promise<{ ok: boolean }>;
  acceptanceCatalog(): Promise<{
    scenarios: Array<{ id: string; label: string; description: string }>;
    character: { name: string; id: string; available: string[]; fallbacks: Array<{ requested: string; pose: string; status: 'ok' | 'fallback' | 'missing'; reason: string }> };
    paused: boolean;
    guides?: boolean;
    carousel?: boolean;
  }>;
  acceptancePause(paused: boolean): Promise<{ ok: boolean; paused: boolean }>;
  acceptancePose(pose: string): Promise<{ ok: boolean; pose?: string; fallback?: boolean }>;
  acceptanceCarousel(on: boolean, intervalMs?: number): Promise<{ ok: boolean; on?: boolean; poses?: string[]; intervalMs?: number; error?: string }>;
  acceptanceGuides(on: boolean): Promise<{ ok: boolean; on?: boolean }>;
  acceptanceRun(scenarioId: string): Promise<{ ok: boolean; result?: { scenarioId: string; label: string; status: 'completed' | 'failed'; steps: number; note: string }; error?: string }>;
  acceptanceRunAll(): Promise<{ ok: boolean; results: Array<{ scenarioId: string; label: string; status: 'completed' | 'failed'; steps: number; note: string }> }>;
  acceptanceReport(): Promise<{ ok: boolean; markdown?: string }>;
  onOpenCreator(handler: () => void): void;
  onOpenBench(handler: () => void): void;
  // T-M6-20 桌宠缩放（中控台滑块）——主进程按脚底锚点改窗口尺寸
  prefsGet(): Promise<{ scale: number; dragBehavior: 'stick' | 'glide' | 'gravity'; characterId?: string; mcpEndpointId?: string; powerSaverEnabled?: boolean; shortcutHideEnabled?: boolean; autoHideFullscreen?: boolean; sfxEnabled?: boolean; sfxVolume?: number; followFrontApp?: boolean }>;
  prefsSet(update: { scale?: number; dragBehavior?: 'stick' | 'glide' | 'gravity'; characterId?: string; powerSaverEnabled?: boolean; shortcutHideEnabled?: boolean; autoHideFullscreen?: boolean; sfxEnabled?: boolean; sfxVolume?: number; followFrontApp?: boolean }): Promise<unknown>;
  // T-M6-21 多角色
  characterList(): Promise<CharacterSummary[]>;
  characterSelect(id: string): Promise<{ ok: boolean; error?: string }>;
  petPackCatalog(): Promise<PetPackCatalogItem[]>;
  petPackImport(input?: { all?: boolean; packSlugs?: string[] }): Promise<{ ok: boolean; error?: string; imported?: string[]; failed?: Array<{ slug: string; error: string }>; catalog?: PetPackCatalogItem[] }>;
  onPetPackImportProgress(handler: (progress: PetPackImportProgress) => void): () => void;
  // T-M6-22 多桌宠联机端点池
  coopEndpoints(): Promise<CoopEndpointView[]>;
  coopStart(id: string): Promise<{ ok: boolean; error?: string }>;
  coopStop(id: string): Promise<{ ok: boolean }>;
  coopEndpointsSave(endpoints: McpEndpoint[]): Promise<{ ok: boolean; error?: string; endpoints?: CoopEndpointView[] }>;
  coopBlackboardGet(): Promise<{ snapshot: TeamBlackboardSnapshot; messages: TeamCommsMessage[] }>;
  coopGoalSet(goal: TeamGoal): Promise<{ ok: boolean; error?: string; goal?: TeamGoal }>;
  coopChatSend(input: { text: string; mentions?: string[] }): Promise<{ ok: boolean; error?: string; route?: string; fallback?: boolean }>;
  coopHuddleStart(input?: { goalTitle?: string; reason?: string; note?: string }): Promise<{ ok: boolean; error?: string; fallback?: boolean; rounds?: number; plan?: TeamPlan }>;
  coopLaunchStatus(): Promise<LaunchStatusView[]>;
  coopLaunchHuman(gameId: GameId): Promise<{ ok: boolean; error?: string; pid?: number; aiPorts?: number[] }>;
  coopLaunchAi(agentId: string): Promise<{ ok: boolean; error?: string; pid?: number; profileModsDir?: string; port?: number; note?: string }>;
  /** T-M6-47 DST 向导：token 只上行，状态只回布尔 */
  coopDstStatus(): Promise<DstWizardStatusView>;
  coopDstSaveToken(token: string): Promise<{ ok: boolean; error?: string }>;
  coopHelpRequest(input: { agentId: string; reason: string }): Promise<{ ok: boolean; error?: string; mode?: string; helperAgentId?: string; fallback?: boolean }>;
  onCoopBlackboardUpdate(handler: (payload: { snapshot: TeamBlackboardSnapshot; messages: TeamCommsMessage[] }) => void): () => void;
  onCoopCommsMessage(handler: (message: TeamCommsMessage) => void): () => void;
  onCoopSpeaker(handler: (event: CoopSpeakerEvent) => void): () => void;
  // T-M6-38 多桌宠窗口
  petWindowOpen(agentId: string, characterId?: string): Promise<{ ok: boolean; error?: string; window?: PetWindowView }>;
  petWindowClose(agentId: string): Promise<{ ok: boolean }>;
  petWindowList(): Promise<PetWindowView[]>;
  petWindowPrefsSet(agentId: string, update: { scale?: number; locked?: boolean; characterId?: string }): Promise<unknown>;
  onPetWindowListChanged(handler: (list: PetWindowView[]) => void): () => void;
  // T-M6-60 托盘快捷浮窗：真实动作全部回落既有主进程能力
  petWindowsVisible(visible: boolean): Promise<{ ok: boolean; visible: boolean; count: number; error?: string }>;
  petSleepAll(asleep: boolean): Promise<{ ok: boolean; asleep: boolean; count: number; error?: string }>;
  petSleepStatus(): Promise<{ ok: boolean; asleep: boolean; count: number }>;
  petDockAll(): Promise<{ ok: boolean; docked: number; error?: string }>;
  openDirector(): Promise<{ ok: boolean }>;
  openBench(): Promise<{ ok: boolean }>;
  appQuit(): Promise<{ ok: boolean }>;
  hidePopover(): Promise<{ ok: boolean }>;
  copyText(text: string): Promise<boolean>;
  /** PET_STAGE_E2E=1 才暴露：E2E 打开/隐藏/读取浮窗坐标。 */
  trayPopoverTest?(action: 'open' | 'hide' | 'bounds'): Promise<{ ok: boolean; bounds?: unknown; visible?: boolean }>;
  riceFeed(grains: number): Promise<{ ok: boolean; balance: number }>;
  riceStatus(): Promise<import('@workbench/shared-protocol').RiceBowlStatus>;
  brainApplyConfig(config: import('@workbench/shared-protocol').BrainRuntimeConfig): Promise<BrainApplyView>;
  plannerSwitch(mode: 'rule' | 'llm'): Promise<{ ok: boolean; error?: string; mode?: string }>;
  plannerStatus(): Promise<{ mode: string; llmReady: boolean }>;
  chatSay(text: string): Promise<{ ok: boolean; error?: string; reply?: string; reflex?: boolean }>;
  guidesLoad(): Promise<{ ok: boolean; error?: string; topics?: string[] }>;
  voiceSpeak(text: string, scene: 'normal' | 'inner' | 'p0'): Promise<{ ok: boolean; error?: string }>;
  /** T-M6-33 实际语音后端：mcode=角色音色链 / say=系统语音兜底 / unsupported=平台未适配 */
  voiceBackend(): Promise<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string }>;
  voiceConfigGet(): Promise<{ enabled: boolean; innerVoice: boolean; volume: number; ratePercent: number; voice: string; pitchMul: number }>;
  voiceConfigSet(patch: { enabled?: boolean; innerVoice?: boolean; volume?: number; ratePercent?: number; voice?: string; pitchMul?: number; voiceId?: string }): Promise<{ enabled: boolean; innerVoice: boolean; volume: number; ratePercent: number; voice: string; pitchMul: number; voiceId: string }>;
  voiceCatalog(): Promise<{
    voices: Array<{ id: string; label: string; desc: string }>;
    modes: Array<{ id: string; label: string; emotion: string; pitch: number; speed: number; volume: number }>;
    currentVoiceId: string;
  }>;
  voiceAudition(voiceId: string, mode: string, text?: string): Promise<{ ok: boolean; error?: string }>;
  /** T-M6-46 语音中心：每角色声线绑定（覆盖优先，落 voice-bindings.json） */
  voiceCharacterBindings(): Promise<Array<{ characterId: string; displayName: string; voiceId: string; defaultVoiceId: string; overridden: boolean }>>;
  voiceCharacterBind(characterId: string, voiceId: string): Promise<{ ok: boolean; error?: string }>;
  memoryQuery(query: string): Promise<{
    ok: boolean;
    context: string;
    hits: Array<{ text: string; score: number; type: string }>;
    totalNodes: number;
  }>;
  memoryDiary(day?: string): Promise<{ ok: boolean; day?: string; text?: string; error?: string }>;
  memoryStats(): Promise<{ nodes: number; edges: number; lastDay: string | null }>;
  memoryWipe(): Promise<{ ok: boolean }>;
  memoryGraph(): Promise<import('@workbench/shared-protocol').MemoryGraphView>;
  memoryPin(id: string, pinned: boolean): Promise<{ ok: boolean }>;
  webuiInfo(): Promise<{ ok: boolean; port: number; token: string }>;
  // 星露谷 Mod 管理（T-M6-06）
  modsState(): Promise<ModsStateView>;
  // BWF 游戏内 HUD 开关（T-M6-16）：默认关闭；applied=运行时已生效 / needsGameRestart=旧 DLL 需换补丁版 / gameOffline=游戏没开
  modsSetBwfHud(value: boolean): Promise<{
    ok: boolean; showHud?: boolean; applied?: boolean; needsGameRestart?: boolean; gameOffline?: boolean; error?: string;
  }>;
  modsSetDir(dir: string): Promise<ModsOpView>;
  modsScan(): Promise<ModsOpView>;
  modsToggle(folderName: string, enabled: boolean): Promise<ModsOpView>;
  modsInstallZip(): Promise<ModsOpView & { folderName?: string }>;
  modsOpenDir(): Promise<{ ok: boolean; error?: string }>;
}

/** Mod 条目视图（契约 StardewModInfo 的渲染层镜像） */
export interface ModInfoView {
  folderName: string;
  uniqueId: string;
  name: string;
  author: string;
  version: string;
  description: string;
  enabled: boolean;
  contentType: string;
  minimumApiVersion: string;
  parseError: string;
}

export interface ModsSnapshotView {
  modsDir: string;
  exists: boolean;
  mods: ModInfoView[];
  smapiVersion: string;
  scannedAt: number;
}

export interface ModsStateView {
  ok: boolean;
  configured?: boolean;
  /** BWF 游戏内 HUD 当前偏好（T-M6-16，默认 false 不显示） */
  bwfShowHud?: boolean;
  candidates?: Array<{ path: string; exists: boolean }>;
  snapshot?: ModsSnapshotView | null;
  error?: string;
}

export interface ModsOpView {
  ok: boolean;
  error?: string;
  snapshot?: ModsSnapshotView;
}

declare global {
  interface Window {
    directorBridge: DirectorBridge;
  }
}
