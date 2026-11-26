/**
 * 工作台 Shell v5「Obsidian Tide」（V2-P1-05 Strangler 重构版）：
 * - 分组插件导航 + 顶栏（⌘K / 三态主题 system·dark·light / 语音·主脑·游戏驱动）
 * - 置顶常驻 ControlOwnershipHud（实时连接 CharacterCore 急停 F8 / 接管 F9 / 睡眠 F10）
 * - 核心域页面模块化拆出：ChatView / GameWorkspaceView / LifeConsoleView
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  Activity, Brain, Hand, Monitor, Moon, OctagonAlert, Play, Radio, Rocket, RotateCcw,
  ShieldAlert, Sparkles, Square, Volume2, VolumeX, Wheat,
} from 'lucide-react';
import {
  ModelProviderConfigSchema,
  type BrowserComputerSnapshot,
  type CharacterCoreSnapshot,
  type DiningProfilePreset,
  type ModelProviderConfig,
  type WorkbenchRoleSlot,
} from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import {
  GAME_OPTIONS,
  isCurrentSessionEvent,
  type AutodriveEventView,
  type CharacterSummary,
  type GameId,
} from './bridge';
import { ProvidersPanel } from './providers-panel';
import { HarnessPanel } from './harness-panel';
import { VoiceCenterPanel } from './voice-center-panel';
import { MemoryPanel } from './memory-panel';
import { ObsPanel } from './obs-panel';
import { PluginsPanel } from './plugins-panel';
import { PetStudioPanel } from './pet-studio';
import { CoopPanel } from './coop-panel';
import { toolLabel, useGameHealth, type ReceiptFilter } from './game-panel';
import { NAV_GROUPS, Sidebar, type Tab } from './shell/sidebar';
import { Topbar, type ThemeMode, type ThemeSkin, type TideAccent } from './shell/topbar';
import { CommandPalette, type CommandAction } from './shell/command-palette';
import { ControlOwnershipHud, type ComputerLeaseView } from './v2/signature-widgets';
import { ChatAside, ChatView, parseDirective } from './views/chat-view';
import { GameWorkspaceView, type AvatarSyncViewState } from './views/stardew-view';
import { LifeConsoleView } from './views/life-console-view';

const NAV_FLAT = NAV_GROUPS.flatMap((g) => g.items);

interface AppProps {
  profiles: DiningProfilePreset[];
  slotLabels: Record<WorkbenchRoleSlot, string>;
  providers: ModelProviderConfig[];
  store: DirectorStore;
  storeKey: string;
}

/** 历史水合：主进程环形缓冲 + 已收到的实时事件按 seq 去重（刷新不丢对话、不重复插卡） */
export function mergeHydrated(history: AutodriveEventView[], live: AutodriveEventView[]): AutodriveEventView[] {
  const seen = new Set<number>();
  const merged: AutodriveEventView[] = [];
  for (const e of [...history, ...live]) {
    if (e.seq !== undefined) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
    }
    merged.push(e);
  }
  return merged.slice(-500);
}

const DEFAULT_PLUGIN_IDS = [...new Set([
  ...NAV_FLAT.map((item) => item.id),
  ...GAME_OPTIONS.map((game) => game.id),
  'mods',
])];

function readPlugins(): Set<string> {
  try {
    const raw = localStorage.getItem('wb-plugins-v4');
    if (raw === null) return new Set(DEFAULT_PLUGIN_IDS);
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set(DEFAULT_PLUGIN_IDS);
  }
}

function isGameId(value: string | null): value is GameId {
  return value !== null && GAME_OPTIONS.some((game) => game.id === value);
}

function isTabEnabled(tab: Tab, enabledPlugins: Set<string>): boolean {
  if (tab === 'coop' || tab === 'life') return true;
  if (tab === 'stardew') return GAME_OPTIONS.some((game) => enabledPlugins.has(game.id)) || enabledPlugins.has('mods');
  return enabledPlugins.has(tab);
}

function initialTab(): Tab {
  const saved = localStorage.getItem('wb-tab');
  if (saved === 'terraria' || saved === 'dst' || saved === 'mods') return 'stardew';
  return saved !== null && NAV_FLAT.some((item) => item.id === saved) ? saved as Tab : 'chat';
}

function initialThemeMode(): ThemeMode {
  const saved = localStorage.getItem('wb-theme');
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  return 'light';
}

function initialSkin(): ThemeSkin {
  const saved = localStorage.getItem('wb-skin');
  if (saved === 'tidepaper' || saved === 'obsidian-tide' || saved === 'tide-deep') return saved;
  return 'tidepaper';
}

function initialAccent(): TideAccent {
  const saved = localStorage.getItem('wb-accent');
  if (saved === 'coral' || saved === 'sea' || saved === 'whale' || saved === 'kelp' || saved === 'plum') return saved;
  return 'coral';
}

/** ADR-004：把 P3-03 的 BrowserComputerSnapshot 映射为 HUD 的桌面租约视图；读取失败时返回 null 显示未接入 */
function buildComputerLeaseView(snapshot: BrowserComputerSnapshot): ComputerLeaseView {
  const deviceId = 'host-primary';
  const lease = snapshot.activeLeases.find((item) => item.deviceId === deviceId);
  const humanOverride = snapshot.humanOverrideDevices.includes(deviceId);
  const pendingHandoffs = snapshot.pendingHandoffs.filter((item) => item.status === 'awaiting_human').length;
  const inputMode = snapshot.inputExecutor.mode;
  const base = { humanOverride, inputMode, pendingHandoffs, halted: snapshot.halted };

  if (humanOverride) {
    return {
      ...base,
      state: 'preempted',
      label: '人类优先',
      detail: '检测到用户物理输入 ≤1s，桌面租约已退回人类',
      holderId: null,
    };
  }
  if (snapshot.halted) {
    return { ...base, state: 'halted', label: '已急停锁定', detail: 'P0 急停已撤销桌面租约' };
  }
  if (lease?.status === 'preempted_by_human') {
    return { ...base, state: 'preempted', label: `人类已抢占 · ${lease.holderId}`, detail: lease.purpose, holderId: lease.holderId };
  }
  if (lease?.status === 'halted') {
    return { ...base, state: 'halted', label: '已急停锁定', detail: lease.purpose, holderId: lease.holderId };
  }
  if (lease?.status === 'active') {
    return {
      ...base,
      state: 'held',
      label: `${lease.holderKind === 'human' ? '人类持有' : 'AI 持有'} · ${lease.holderId}`,
      detail: lease.purpose,
      holderId: lease.holderId,
      purpose: lease.purpose,
    };
  }
  if (snapshot.inputExecutor.permission === 'denied') {
    return { ...base, state: 'permission_denied', label: '权限未授予', detail: 'OS 输入权限被拒绝，桌面租约不可用' };
  }
  return { ...base, state: 'free', label: '空闲 · 无人持有', detail: '当前没有桌面键鼠租约' };
}

export function App({ profiles, slotLabels, providers, store, storeKey }: AppProps): React.JSX.Element {
  void storeKey;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [activeGame, setActiveGame] = useState<GameId>(() => {
    const savedGame = localStorage.getItem('wb-game');
    if (isGameId(savedGame)) return savedGame;
    const legacyTab = localStorage.getItem('wb-tab');
    return legacyTab === 'terraria' || legacyTab === 'dst' ? legacyTab : 'stardew';
  });
  const [gameSubtab, setGameSubtab] = useState<'monitor' | 'mods'>(() => {
    const savedSubtab = localStorage.getItem('wb-game-subtab');
    if (savedSubtab === 'monitor' || savedSubtab === 'mods') return savedSubtab;
    return localStorage.getItem('wb-tab') === 'mods' ? 'mods' : 'monitor';
  });
  const [events, setEvents] = useState<AutodriveEventView[]>([]);
  const [running, setRunning] = useState(false);
  const [humanControl, setHumanControl] = useState(false);
  const [brain, setBrain] = useState<{ mode: string; llmReady: boolean }>({ mode: 'rule', llmReady: false });
  const [dayPlan, setDayPlan] = useState<{ dayKey: string; items: Array<{ goal: string; why: string; status: string }>; mood?: string; updateWhy?: string } | null>(null);
  const [insights, setInsights] = useState<Array<{ id: string; source: string; claim: string; when: string; verdict: string; why: string; hits: number; updatedDay: string }>>([]);
  const [mainModelId, setMainModelId] = useState('');
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [characterId, setCharacterId] = useState('blue-whale-maid');
  const [notebookSignal, setNotebookSignal] = useState(0);
  const [creatorSignal, setCreatorSignal] = useState(0);
  const [creatorTab, setCreatorTab] = useState<'char' | 'egg' | 'import' | 'pixel' | undefined>(undefined);
  const [benchSignal, setBenchSignal] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [voiceBackend, setVoiceBackend] = useState<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  /** V2-P3-05：顶栏启动自动驾驶时，若星露谷未运行，是否直接代启动（持久化到 localStorage） */
  const [stardewAutoLaunch, setStardewAutoLaunch] = useState<boolean>(() => localStorage.getItem('wb-stardew-auto-launch') === '1');
  const [launchPromptOpen, setLaunchPromptOpen] = useState(false);
  const [launchingGame, setLaunchingGame] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [skin, setSkin] = useState<ThemeSkin>(initialSkin);
  const [accent, setAccent] = useState<TideAccent>(initialAccent);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true,
  );
  const [plugins, setPlugins] = useState<Set<string>>(readPlugins);
  const [rice, setRice] = useState(0);
  const [riceCap, setRiceCap] = useState(500_000);
  const [memoryStats, setMemoryStats] = useState<{ nodes: number; edges: number; lastDay: string | null } | null>(null);
  const [guides, setGuides] = useState<string[]>([]);
  const [chatFilter, setChatFilter] = useState<ReceiptFilter>('all');
  const [bwfHud, setBwfHud] = useState(false);
  const [bwfPort, setBwfPort] = useState(18088);
  const [editingBwfPort, setEditingBwfPort] = useState(false);
  const [bwfPortDraft, setBwfPortDraft] = useState('18088');
  const [avatarSync, setAvatarSync] = useState<AvatarSyncViewState | null>(null);
  const [objective, setObjective] = useState<string | null>(null);

  // V2 内核与 CharacterCore 实时快照（ControlOwnershipHud & V2 生命中枢单点数据源）
  const [v2Snapshot, setV2Snapshot] = useState<CharacterCoreSnapshot | null>(null);
  const [autoSnap, setAutoSnap] = useState<BrowserComputerSnapshot | null>(null);
  const [asleep, setAsleep] = useState(false);
  const [hudBusy, setHudBusy] = useState(false);

  const refreshV2Snapshot = useCallback(async (): Promise<void> => {
    try {
      const snap = await window.directorBridge.v2CharacterSnapshot();
      setV2Snapshot(snap);
    } catch {
      // 主进程未就绪时保持上次状态，绝不伪造默认值
    }
  }, []);

  // ADR-004：人类物理输入窗口只有 ≤1s 抢占 + 2s 保持，HUD 必须用更高频率轮询才看得见
  const refreshAutoSnapshot = useCallback(async (): Promise<void> => {
    try {
      setAutoSnap(await window.directorBridge.v2AutoSnapshot());
    } catch {
      // P3-03 快照不可用时保持上次状态
    }
  }, []);

  const refreshAvatarSync = useCallback(async (): Promise<void> => {
    try { setAvatarSync(await window.directorBridge.stardewAvatarState()); } catch { setAvatarSync(null); }
  }, []);

  const flowRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{ sessionId?: string; gameId?: GameId; generation: number }>({ generation: -1 });
  const activeGameRef = useRef<GameId>(activeGame);
  useEffect(() => { activeGameRef.current = activeGame; }, [activeGame]);
  const acceptEvent = (event: AutodriveEventView): boolean =>
    isCurrentSessionEvent(event, sessionRef.current, activeGameRef.current);

  const stardewHealth = useGameHealth('stardew', undefined, 15_000, tab === 'stardew' && activeGame === 'stardew');

  useEffect(() => { void refreshAvatarSync(); }, [refreshAvatarSync]);
  useEffect(() => window.directorBridge.onStardewAvatarChanged(() => { void refreshAvatarSync(); }), [refreshAvatarSync]);

  useEffect(() => {
    void refreshV2Snapshot();
    void refreshAutoSnapshot();
    void window.directorBridge.petSleepStatus().then((s) => setAsleep(s.asleep)).catch(() => undefined);
    const timer = setInterval(() => {
      void refreshV2Snapshot();
    }, 5000);
    const autoTimer = setInterval(() => {
      void refreshAutoSnapshot();
    }, 1000);
    return () => {
      clearInterval(timer);
      clearInterval(autoTimer);
    };
  }, [refreshV2Snapshot, refreshAutoSnapshot]);

  useEffect(() => {
    window.directorBridge.onAutodriveEvent((event) => {
      if (!acceptEvent(event)) return;
      setEvents((prev) => (prev.length >= 500 ? [...prev.slice(-499), event] : [...prev, event]));
      if (event.type === 'state' || event.type === 'decision' || event.type === 'receipt') setRunning(true);
      if (event.type === 'human-control') {
        setHumanControl(event.active === true);
        void refreshV2Snapshot();
      }
      if ((event as { type: string }).type === 'brain') {
        const nextMode = (event as unknown as { mode?: string }).mode;
        if (typeof nextMode === 'string') setBrain((prev) => ({ ...prev, mode: nextMode }));
      }
      if ((event as { type: string }).type === 'plan') {
        const p = event as unknown as { dayKey?: string; plan?: Array<{ goal: string; why: string; status: string }>; mood?: string; updateWhy?: string };
        if (typeof p.dayKey === 'string' && Array.isArray(p.plan)) {
          setDayPlan({ dayKey: p.dayKey, items: p.plan, ...(p.mood === undefined ? {} : { mood: p.mood }), ...(p.updateWhy === undefined ? {} : { updateWhy: p.updateWhy }) });
        }
      }
      if ((event as { type: string }).type === 'insight') {
        const insEv = event as unknown as { insights?: Array<{ id: string; source: string; claim: string; when: string; verdict: string; why: string; hits: number; updatedDay: string }> };
        if (Array.isArray(insEv.insights)) setInsights(insEv.insights);
      }
    });
    void window.directorBridge.autodriveStatus().then((s) => {
      sessionRef.current = { sessionId: s.sessionId, gameId: s.gameId, generation: s.generation ?? -1 };
      setRunning(s.running);
      setHumanControl(s.humanControl === true);
      if (s.running && s.gameId !== undefined) setActiveGame(s.gameId);
      const history = (s.events ?? []).filter(acceptEvent);
      if (history.length > 0) setEvents((prev) => mergeHydrated(history, prev));
    });
    void window.directorBridge.plannerStatus().then((s) => {
      setBrain(s);
      const ext = s as unknown as {
        dayPlan?: { dayKey: string; items: Array<{ goal: string; why: string; status: string }>; mood?: string; updateWhy?: string } | null;
        insights?: Array<{ id: string; source: string; claim: string; when: string; verdict: string; why: string; hits: number; updatedDay: string }>;
      };
      if (ext.dayPlan !== undefined && ext.dayPlan !== null) setDayPlan(ext.dayPlan);
      if (Array.isArray(ext.insights)) setInsights(ext.insights);
    });
    const refreshCharacters = (): void => {
      void window.directorBridge.characterList()
        .then((list) => setCharacters(list.filter((character) => !(character.packId ?? '').startsWith('crosspet-'))))
        .catch(() => setCharacters([]));
    };
    refreshCharacters();
    window.addEventListener('pet:characters-changed', refreshCharacters);
    window.directorBridge.onOpenPetNotebook(() => { setTab('pet'); setNotebookSignal((v) => v + 1); });
    window.directorBridge.onOpenCreator(() => { setTab('pet'); setCreatorSignal((v) => v + 1); });
    window.directorBridge.onOpenBench(() => { setTab('pet'); setBenchSignal((v) => v + 1); });
    void window.directorBridge.prefsGet().then((p) => {
      if (typeof p.characterId === 'string') setCharacterId(p.characterId);
    }).catch(() => undefined);
    void window.directorBridge.voiceConfigGet().then((c) => setVoiceOn(c.enabled));
    void window.directorBridge.voiceBackend().then(setVoiceBackend).catch(() => setVoiceBackend(null));
    void window.directorBridge.riceStatus().then((r) => { setRice(r.balance); setRiceCap(r.budget); });
    void window.directorBridge.modsState().then((s) => {
      if (s.bwfShowHud === true) setBwfHud(true);
      if (typeof s.bwfMcpPort === 'number') {
        setBwfPort(s.bwfMcpPort);
        setBwfPortDraft(String(s.bwfMcpPort));
      }
    });
    void Promise.all([
      store.getConfig<DiningProfilePreset[]>('diningProfiles'),
      store.getConfig<string>('activeDiningProfile'),
      store.getConfig<Record<string, { activeVariant?: number; variants?: ModelProviderConfig['variants']; models?: Array<{ id: string; enabled: boolean; caps: string[] }>; enabled?: boolean }>>('providerOverrides'),
      store.getConfig<Array<{ id: string; name: string; protocol: 'openai' | 'anthropic'; variants: ModelProviderConfig['variants']; models: Array<{ id: string; enabled: boolean; caps: string[] }>; enabled: boolean }>>('customProviders'),
    ]).then(([storedProfiles, activeId, overrides, customProviders]) => {
      const list = storedProfiles !== undefined && storedProfiles.length > 0 ? storedProfiles : profiles;
      const chosen = list.find((p) => p.profileId === activeId) ?? list[0];
      if (chosen === undefined) return;
      setMainModelId(chosen.roleBindings.MAIN_PERSONA_BRAIN ?? '');
      const builtin = providers.map((provider) => {
        const o = overrides?.[provider.id];
        if (o === undefined) return provider;
        const variants = o.variants ?? provider.variants;
        const activeVariant = variants[o.activeVariant ?? 0] ?? variants[0];
        const discoveredModels = o.models !== undefined
          ? o.models.map((m) => ({
            id: m.id,
            supportsReasoningThink: m.caps.includes('reason'),
            supportsVision: m.caps.includes('vision'),
            supportsToolCalling: !m.caps.includes('tts') && !m.caps.includes('svc'),
          }))
          : provider.discoveredModels;
        const parsed = ModelProviderConfigSchema.safeParse({
          ...provider,
          variants,
          protocol: activeVariant?.protocol ?? provider.protocol,
          activeRegion: activeVariant?.region ?? provider.activeRegion,
          activePlanType: activeVariant?.planType ?? provider.activePlanType,
          discoveredModels,
        });
        return parsed.success ? parsed.data : provider;
      });
      const custom = (customProviders ?? []).map((c) => ModelProviderConfigSchema.parse({
        id: c.id,
        name: c.name,
        category: 'AGGREGATOR_LLM',
        protocol: c.protocol,
        activeRegion: c.variants[0]?.region ?? 'GLOBAL',
        activePlanType: c.variants[0]?.planType ?? 'PAY_AS_YOU_GO',
        variants: c.variants,
        apiKeyMaskedOrRef: '',
        activeModelId: c.models.find((m) => m.enabled)?.id ?? '',
        discoveredModels: c.models.map((m) => ({
          id: m.id,
          supportsReasoningThink: m.caps.includes('reason'),
          supportsVision: m.caps.includes('vision'),
          supportsToolCalling: !m.caps.includes('tts') && !m.caps.includes('svc'),
        })),
      }));
      const merged = [...builtin, ...custom].filter((p) =>
        overrides?.[p.id]?.enabled !== false && (customProviders ?? []).find((c) => c.id === p.id)?.enabled !== false,
      );
      void window.directorBridge.brainApplyConfig({ profile: chosen, providerModels: {}, providers: merged }).then((r) => {
        setBrain({ mode: r.mode, llmReady: r.llmReady });
        setMainModelId(chosen.roleBindings.MAIN_PERSONA_BRAIN ?? '');
      });
    });
    void window.directorBridge.memoryStats().then((m) => setMemoryStats(m));
    void window.directorBridge.guidesLoad().then((g) => { if (g.ok) setGuides(g.topics ?? []); });
    void window.directorBridge.autodriveObjectiveStatus().then((status) => setObjective(status.objective)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshV2Snapshot]);

  useEffect(() => {
    if (!running) return;
    const refreshStatus = (): void => {
      void window.directorBridge.autodriveStatus().then((status) => {
        setRunning(status.running);
        setHumanControl(status.humanControl === true);
        if (status.sessionId !== undefined) {
          sessionRef.current = { sessionId: status.sessionId, gameId: status.gameId, generation: status.generation ?? sessionRef.current.generation };
        }
        if (status.running && status.gameId !== undefined) setActiveGame(status.gameId);
      }).catch(() => undefined);
    };
    refreshStatus();
    const timer = setInterval(refreshStatus, 3000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, tab]);

  useEffect(() => {
    const refresh = (): void => {
      void window.directorBridge.riceStatus().then((r) => { setRice(r.balance); setRiceCap(r.budget); });
      void window.directorBridge.memoryStats().then((m) => setMemoryStats(m));
    };
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem('wb-tab', tab);
    localStorage.setItem('wb-game', activeGame);
    localStorage.setItem('wb-game-subtab', gameSubtab);
  }, [tab, activeGame, gameSubtab]);

  // 三态主题监听与根节点同步
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const listener = (ev: MediaQueryListEvent): void => setSystemDark(ev.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);

  const resolvedTheme: 'dark' | 'light' = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
    document.documentElement.dataset.skin = skin;
    document.documentElement.dataset.accent = accent;
    localStorage.setItem('wb-theme', themeMode);
    localStorage.setItem('wb-skin', skin);
    localStorage.setItem('wb-accent', accent);
  }, [resolvedTheme, themeMode, skin, accent]);

  useEffect(() => {
    localStorage.setItem('wb-plugins-v4', JSON.stringify([...plugins]));
    if (!isTabEnabled(tab, plugins)) {
      const first = NAV_FLAT.find((item) => isTabEnabled(item.id, plugins));
      if (first !== undefined) setTab(first.id);
    }
    if (tab === 'stardew') {
      const firstEnabledGame = GAME_OPTIONS.find((game) => plugins.has(game.id));
      if (gameSubtab === 'mods' && !plugins.has('mods')) setGameSubtab('monitor');
      else if (gameSubtab === 'mods' && activeGame !== 'stardew') setActiveGame('stardew');
      else if (gameSubtab === 'monitor' && firstEnabledGame === undefined && plugins.has('mods')) setGameSubtab('mods');
      else if (gameSubtab === 'monitor' && firstEnabledGame !== undefined && !plugins.has(activeGame)) setActiveGame(firstEnabledGame.id);
    }
  }, [plugins, tab, activeGame, gameSubtab]);

  useEffect(() => {
    const onBrain = (e: Event): void => {
      const detail = (e as CustomEvent<{ mode: string; llmReady: boolean; mainModelId?: string }>).detail;
      if (detail !== undefined) {
        setBrain({ mode: detail.mode, llmReady: detail.llmReady });
        if (typeof detail.mainModelId === 'string') setMainModelId(detail.mainModelId);
      }
    };
    window.addEventListener('wb:brain', onBrain);
    return () => window.removeEventListener('wb:brain', onBrain);
  }, []);

  useEffect(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'objective') {
        setObjective(event.objective ?? null);
        break;
      }
    }
  }, [events]);

  // 控制权真实操作（ControlOwnershipHud + F8/F9/F10）
  const emergencyHalt = useCallback(async (reason = '控制台紧急停止 F8'): Promise<void> => {
    setHudBusy(true);
    try {
      await window.directorBridge.v2EmergencyHalt(reason);
      if (running) {
        await window.directorBridge.autodriveStop();
        setRunning(false);
        setHumanControl(false);
      }
      await refreshV2Snapshot();
      toast.error('P0 急停已触发：所有动作、音频混音与自主决策已锁定');
    } finally {
      setHudBusy(false);
    }
  }, [running, refreshV2Snapshot]);

  const resumeAutonomous = useCallback(async (): Promise<void> => {
    setHudBusy(true);
    try {
      if (running && humanControl) {
        const res = await window.directorBridge.autodriveSetHumanControl(false);
        setHumanControl(res.humanControl);
      }
      await window.directorBridge.v2Resume('autonomous');
      await refreshV2Snapshot();
      toast.success('已恢复 AI 自主托管模式');
    } finally {
      setHudBusy(false);
    }
  }, [running, humanControl, refreshV2Snapshot]);

  const toggleTakeover = useCallback(async (): Promise<void> => {
    setHudBusy(true);
    try {
      const currentlyTakeover =
        v2Snapshot?.activityState.halted !== true &&
        (humanControl || v2Snapshot?.activityState.controlMode === 'manual_takeover');
      const wantTakeover = !currentlyTakeover;
      if (running) {
        const res = await window.directorBridge.autodriveSetHumanControl(wantTakeover);
        if (!res.ok) {
          toast.error('接管开关失败，请查看主进程日志');
          return;
        }
        setHumanControl(res.humanControl);
      }
      await window.directorBridge.v2Resume(wantTakeover ? 'manual_takeover' : 'autonomous');
      await refreshV2Snapshot();
      toast(wantTakeover ? '人类已接管控制权（F9）：AI 停止写入动作' : '已交还控制权给 AI（F9）');
    } finally {
      setHudBusy(false);
    }
  }, [humanControl, running, v2Snapshot?.activityState.controlMode, refreshV2Snapshot]);

  const toggleSleep = useCallback(async (): Promise<void> => {
    setHudBusy(true);
    try {
      const next = !asleep;
      const res = await window.directorBridge.petSleepAll(next);
      setAsleep(res.asleep);
      await window.directorBridge.v2SelectActivity({
        mode: next ? 'resting' : 'companion',
        reason: next ? 'F10 切换睡眠安静模式' : 'F10 唤醒小鲸',
        source: 'user_command',
      }).catch(() => undefined);
      await refreshV2Snapshot();
      toast(next ? '已进入睡眠安静模式（F10）' : '已唤醒小鲸（F10）');
    } finally {
      setHudBusy(false);
    }
  }, [asleep, refreshV2Snapshot]);

  // 全局快捷键：⌘K / F8 / F9 / F10
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen((v) => !v);
        return;
      }
      if (e.key === 'F8' || (e.shiftKey && e.key === 'Escape')) {
        e.preventDefault();
        void emergencyHalt(e.key === 'F8' ? '快捷键 F8 急停' : '快捷键 Shift+Esc 急停');
        return;
      }
      const target = e.target as HTMLElement | null;
      const inInput = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (inInput) return;
      if (e.key === 'F9') {
        e.preventDefault();
        void toggleTakeover();
      } else if (e.key === 'F10') {
        e.preventDefault();
        void toggleSleep();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [emergencyHalt, toggleTakeover, toggleSleep]);

  /**
   * V2-P3-05：等待星露谷真正就绪（主进程 MCP get_state 应答）。
   * 未安装 / 启动失败 / 超时都如实 toast，绝不把「进程起来了」当成「已就绪」。
   */
  const waitForStardewReady = useCallback(async (): Promise<boolean> => {
    try {
      const first = await window.directorBridge.stardewLaunch();
      if (first.state === 'ready') return true;
      if (first.state === 'not_installed' || first.state === 'failed') {
        toast.error(first.message || '《星露谷物语》启动失败', { description: first.hint || undefined });
        return false;
      }
      const deadline = Date.now() + Math.max(10_000, first.timeoutMs + 10_000);
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const next = await window.directorBridge.stardewLaunchStatus();
        if (next.state === 'ready') return true;
        if (next.state === 'not_installed' || next.state === 'failed' || next.state === 'timeout') {
          toast.error(next.message || '《星露谷物语》未能就绪', { description: next.hint || undefined });
          return false;
        }
      }
      toast.error('等待《星露谷物语》就绪超时');
      return false;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '《星露谷物语》启动失败');
      return false;
    }
  }, []);

  const launchStardewOnly = async (): Promise<void> => {
    setLaunchingGame(true);
    toast('正在启动《星露谷物语》…');
    const ok = await waitForStardewReady();
    setLaunchingGame(false);
    if (ok) toast.success('《星露谷物语》已就绪');
  };

  const start = async (): Promise<void> => {
    setDriveError(null);
    // 星露谷需要游戏 + BWF MCP 在线才能接管；未运行先给出「先启动游戏」选择。
    if (activeGame === 'stardew') {
      const health = await window.directorBridge.gameHealth('stardew').catch(() => null);
      if (health?.status !== 'online') {
        if (!stardewAutoLaunch) {
          setLaunchPromptOpen(true);
          return;
        }
        setLaunchingGame(true);
        const ready = await waitForStardewReady();
        setLaunchingGame(false);
        if (!ready) return;
      }
    }
    const res = await window.directorBridge.autodriveStart(activeGame);
    if (res.ok) {
      setRunning(true);
      void window.directorBridge.autodriveStatus().then((status) => {
        if (status.sessionId !== undefined) {
          sessionRef.current = { sessionId: status.sessionId, gameId: status.gameId ?? activeGame, generation: status.generation ?? -1 };
        }
      }).catch(() => undefined);
      await refreshV2Snapshot();
      const gameName = GAME_OPTIONS.find((game) => game.id === activeGame)?.label ?? '当前游戏';
      toast.success(`自动驾驶已启动：接管${gameName}`);
    } else {
      setDriveError(res.error ?? '启动失败');
      toast.error(res.error ?? '启动失败');
    }
  };

  const stop = async (): Promise<void> => {
    await window.directorBridge.autodriveStop();
    setRunning(false);
    setHumanControl(false);
    await refreshV2Snapshot();
    toast('自动驾驶已停止：控制权交还主人');
  };

  const selectGame = (gameId: GameId): void => {
    if (running || !plugins.has(gameId)) return;
    setActiveGame(gameId);
    setGameSubtab('monitor');
    setEvents([]);
    sessionRef.current = { ...sessionRef.current, gameId };
  };

  const selectCharacter = async (id: string): Promise<void> => {
    if (id === characterId) return;
    const result = await window.directorBridge.characterSelect(id);
    if (!result.ok) { toast.error(result.error ?? '角色切换失败'); return; }
    setCharacterId(id);
    if (avatarSync?.enabled === true && avatarSync.modInstalled) {
      void window.directorBridge.stardewAvatarSyncNow()
        .then((sync) => { if (sync.ok) void refreshAvatarSync(); })
        .catch(() => undefined);
    }
    await refreshV2Snapshot();
    const selected = characters.find((character) => character.id === id);
    toast.success(`已切换陪伴角色：${selected?.displayName ?? id}`);
  };

  const switchBrain = async (): Promise<void> => {
    const next = brain.mode === 'llm' ? 'rule' : 'llm';
    const res = await window.directorBridge.plannerSwitch(next);
    if (res.ok) {
      setBrain((b) => ({ ...b, mode: res.mode ?? next }));
      toast(next === 'llm' ? '已切换至 LLM 大脑' : '已切回规则日程（0 token 兜底）');
    } else {
      setDriveError(res.error ?? '切换失败');
      toast.error(res.error ?? '切换失败');
    }
  };

  const toggleVoice = async (): Promise<void> => {
    const next = await window.directorBridge.voiceConfigSet({ enabled: !voiceOn });
    setVoiceOn(next.enabled);
    toast(next.enabled ? '语音已开启' : '已静音：仅字幕与云朵气泡');
  };

  const toggleBwfHud = async (): Promise<void> => {
    const next = !bwfHud;
    setBwfHud(next);
    const res = await window.directorBridge.modsSetBwfHud(next);
    if (!res.ok) { setBwfHud(!next); toast.error(res.error ?? 'HUD 开关保存失败'); return; }
    if (res.gameOffline === true) toast(`已保存：HUD ${next ? '显示' : '关闭'}（游戏没在跑，开游戏后自动生效）`);
    else if (res.needsGameRestart === true) toast.warning('已保存，但游戏内还是旧版 Mod——重启一次游戏后生效');
    else toast.success(`游戏内 MCP 提示已${next ? '打开' : '关闭'}（即时生效）`);
  };

  const saveBwfPort = async (): Promise<void> => {
    const nextPort = Number(bwfPortDraft.trim());
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
      toast.error('端口必须是 1024–65535 之间的整数');
      return;
    }
    const res = await window.directorBridge.modsSetBwfPort(nextPort);
    if (!res.ok) { toast.error(res.error ?? '端口保存失败'); return; }
    setBwfPort(nextPort);
    setEditingBwfPort(false);
    stardewHealth.reprobe();
    if (res.configSynced === true) toast.success(`已将工作台与 BWF Mod 端口改为 :${nextPort}（重启星露谷后生效）`);
    else toast.warning(`已保存工作台端口 :${nextPort}（${res.warning ?? '请手动核对 BWF config.json'}）`);
  };

  const toggleAvatarSync = async (): Promise<void> => {
    const next = !(avatarSync?.enabled ?? false);
    const state = await window.directorBridge.stardewAvatarSetEnabled(next);
    setAvatarSync(state);
    if (next && !state.modInstalled) toast('已开启同步：还需要点「安装 Mod」把 WhaleIsleAvatar 装进星露谷 Mods 目录');
    else toast(next ? '已开启：切桌宠/换肤会实时写进星露谷' : '已关闭：游戏内保持当前外观，不再随桌宠切换');
  };

  const toggleAvatarLiveliness = async (): Promise<void> => {
    const next = !(avatarSync?.liveliness ?? true);
    const state = await window.directorBridge.stardewAvatarSetLiveliness(next);
    setAvatarSync(state);
    toast(next ? '已开启角色灵动动画' : '已关闭角色灵动动画');
  };

  const installAvatarMod = async (): Promise<void> => {
    const wasUpdate = avatarSync?.modNeedsUpdate === true;
    const result = await window.directorBridge.stardewAvatarInstall();
    if (!result.ok) { toast.error(result.error ?? '安装失败'); return; }
    if (result.compiled === false) toast.error(result.error ?? 'Mod 文件已复制但 DLL 未编译');
    else toast.success(wasUpdate ? 'WhaleIsleAvatar Mod 已升级到最新版' : 'WhaleIsleAvatar Mod 已安装到星露谷 Mods 目录');
    await refreshAvatarSync();
  };

  const uninstallAvatarMod = async (): Promise<void> => {
    if (!window.confirm('从星露谷 Mods 目录移除 WhaleIsleAvatar？游戏内会恢复原版外观，需重启游戏后完全生效。')) return;
    const result = await window.directorBridge.stardewAvatarUninstall();
    if (!result.ok) { toast.error(result.error ?? '卸载失败'); return; }
    toast.success('已移除 WhaleIsleAvatar');
    await refreshAvatarSync();
  };

  const syncAvatarNow = async (): Promise<void> => {
    const result = await window.directorBridge.stardewAvatarSyncNow();
    if (!result.ok) { toast.error(result.error ?? '同步失败'); return; }
    toast.success(result.sprite === true ? '已把当前角色精灵表写入星露谷' : '已写入当前角色原版外观预设');
    await refreshAvatarSync();
  };

  const cancelObjective = async (): Promise<void> => {
    const result = await window.directorBridge.autodriveClearObjective();
    if (!result.ok) { toast.error('取消失败：主进程未响应'); return; }
    if (result.had === false) toast('当前没有正在推进的多步目标');
    else toast.success('已取消多步目标，大脑回到日常节奏');
  };

  const feedRice = async (): Promise<void> => {
    const res = await window.directorBridge.riceFeed(5000);
    setRice(res.balance);
    toast(`已投喂 +5,000 粒米（余额 ${res.balance.toLocaleString()} 粒）`);
  };

  const sendText = (text: string): void => {
    const t = text.trim();
    if (t === '') return;
    const directive = parseDirective(t);
    if (directive) {
      void window.directorBridge.autodriveDirective(directive.tool, directive.args, directive.intent, sessionRef.current.sessionId)
        .then((res) => { if (!res.ok) toast.error(res.error ?? '插队失败'); });
      setEvents((prev) => [...prev, { type: 'decision', tool: directive.tool, intent: directive.intent, planner: 'remote' }]);
      toast(`已插队：${toolLabel(directive.tool)}`);
      return;
    }
    setEvents((prev) => [...prev, { type: 'user', summary: t }]);
    void window.directorBridge.chatSay(t).then((res) => {
      if (!res.ok) {
        setEvents((prev) => [...prev, { type: 'receipt', status: 'ERROR', tool: 'chat', summary: res.error ?? '主脑未回' }]);
      }
    });
  };

  const send = (): void => { sendText(input); setInput(''); };

  const latestState = [...events].reverse().find((e) => e.type === 'state');
  const decisions = events.filter((e) => e.type === 'decision');
  const currentNav = NAV_FLAT.find((item) => item.id === tab);
  const currentGame = GAME_OPTIONS.find((game) => game.id === activeGame) ?? GAME_OPTIONS[0]!;
  const currentTitle = tab === 'stardew'
    ? gameSubtab === 'mods' ? 'Mod 管理' : `${currentGame.shortLabel}共玩`
    : currentNav?.label ?? '工作台';
  const isPluginEnabled = (id: Tab): boolean => isTabEnabled(id, plugins);
  const gameEnabled = Object.fromEntries(GAME_OPTIONS.map((game) => [game.id, plugins.has(game.id)])) as Record<GameId, boolean>;

  const paletteActions = useMemo<CommandAction[]>(() => {
    const pages: CommandAction[] = NAV_FLAT
      .filter((item) => isTabEnabled(item.id, plugins))
      .map((item) => ({ id: `page:${item.id}`, label: item.label, group: '页面', icon: item.icon, run: () => setTab(item.id) }));
    const actions: CommandAction[] = [
      { id: 'act:halt', label: '急停全部动作与混音', group: '控制权', icon: OctagonAlert, hint: 'F8', run: () => void emergencyHalt('命令面板急停') },
      { id: 'act:takeover', label: humanControl || v2Snapshot?.activityState.controlMode === 'manual_takeover' ? '交还控制权给 AI' : '人工接管控制权', group: '控制权', icon: Hand, hint: 'F9', run: () => void toggleTakeover() },
      { id: 'act:sleep', label: asleep ? '唤醒小鲸' : '进入睡眠安静模式', group: '控制权', icon: Moon, hint: 'F10', run: () => void toggleSleep() },
      { id: 'act:life', label: '打开 V2 生命中枢', group: '页面', icon: Sparkles, hint: '12域', run: () => setTab('life') },
      { id: 'act:drive', label: running ? '停止自动驾驶' : '启动自动驾驶', group: '全局动作', icon: running ? Square : Play, hint: '当前游戏', run: () => void (running ? stop() : start()) },
      { id: 'act:launch-stardew', label: launchingGame ? '正在启动星露谷…' : '启动星露谷', group: '全局动作', icon: Rocket, hint: 'SMAPI', run: () => void launchStardewOnly() },
      { id: 'act:brain', label: brain.mode === 'llm' ? '切换规则日程' : '切换 LLM 大脑', group: '全局动作', icon: Brain, hint: brain.mode, run: () => void switchBrain() },
      { id: 'act:voice', label: voiceOn ? '静音语音' : '开启语音', group: '全局动作', icon: voiceOn ? VolumeX : Volume2, run: () => void toggleVoice() },
      { id: 'act:feed', label: '投喂 5,000 粒米', group: '全局动作', icon: Wheat, hint: '饭碗', run: () => void feedRice() },
      { id: 'act:theme', label: resolvedTheme === 'dark' ? '切到晨雾浅色模式' : '切到夜潮深色模式', group: '主题', icon: RotateCcw, run: () => setThemeMode(resolvedTheme === 'dark' ? 'light' : 'dark') },
      { id: 'act:theme-sys', label: '主题跟随系统浅深色', group: '主题', icon: Monitor, hint: 'system', run: () => setThemeMode('system') },
      { id: 'act:skin-tidepaper', label: '外观切换：潮汐纸 Tidepaper', group: '主题', icon: Sparkles, run: () => setSkin('tidepaper') },
      { id: 'act:skin-obsidian', label: '外观切换：曜潮 Obsidian Tide', group: '主题', icon: Sparkles, run: () => setSkin('obsidian-tide') },
      { id: 'act:skin-deep', label: '外观切换：深海屿光 Tide Deep', group: '主题', icon: Sparkles, run: () => setSkin('tide-deep') },
      { id: 'act:fish', label: '插队：钓鱼', group: '快捷指令', icon: Radio, hint: '/fish 5', run: () => sendText('/fish 5') },
      { id: 'act:sleep-game', label: '插队：回家睡觉', group: '快捷指令', icon: Radio, hint: '/sleep', run: () => sendText('/sleep') },
      { id: 'act:state', label: '播报当前状态', group: '快捷指令', icon: Activity, hint: '/state', run: () => sendText('/state') },
      { id: 'act:spray', label: '测试雷区反射（大肥鱼）', group: '快捷指令', icon: ShieldAlert, hint: '0 token', run: () => sendText('大肥鱼') },
    ];
    return [...pages, ...actions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, running, humanControl, asleep, v2Snapshot?.activityState.controlMode, brain.mode, voiceOn, resolvedTheme, launchingGame]);

  return (
    <div
      className={`wb-shell${tab === 'chat' ? ' has-aside' : ''} h-screen w-screen`}
      data-theme={resolvedTheme}
      data-theme-mode={themeMode}
      data-skin={skin}
      data-accent={accent}
    >
      <div className="ambient" />
      <Sidebar
        tab={tab}
        onSelect={setTab}
        running={running}
        rice={rice}
        riceCap={riceCap}
        onFeed={() => void feedRice()}
        onOpenCommandPalette={() => setCmdkOpen(true)}
        isPluginEnabled={isPluginEnabled}
        characters={characters}
        characterId={characterId}
        onSelectCharacter={(id) => void selectCharacter(id)}
        presenceSummary={`${v2Snapshot?.activityState.mode ?? 'companion'} · ${v2Snapshot?.emotion.label ?? '平静'}`}
        badges={{
          memory: memoryStats !== null ? `${memoryStats.nodes} 节点` : undefined,
          life: v2Snapshot?.activityState.halted ? '急停' : undefined,
        }}
      />
      <Topbar
        group={currentNav?.group ?? '工作台'}
        title={currentTitle}
        voiceOn={voiceOn}
        voiceBackend={voiceBackend}
        brainMode={brain.mode}
        llmReady={brain.llmReady}
        mainModelId={mainModelId}
        gameId={activeGame}
        gameEnabled={gameEnabled}
        running={running}
        theme={resolvedTheme}
        themeMode={themeMode}
        skin={skin}
        accent={accent}
        onOpenCommandPalette={() => setCmdkOpen(true)}
        onToggleVoice={() => void toggleVoice()}
        onSwitchBrain={() => {
          if (brain.mode !== 'llm' && !brain.llmReady) setTab('providers');
          else void switchBrain();
        }}
        onSelectGame={selectGame}
        onToggleDrive={() => void (running ? stop() : start())}
        onToggleTheme={() => setThemeMode(resolvedTheme === 'dark' ? 'light' : 'dark')}
        onSelectSystemTheme={() => setThemeMode('system')}
        onSelectSkin={setSkin}
        onSelectAccent={setAccent}
      />

      <ControlOwnershipHud
        displayName={v2Snapshot?.identity.displayName ?? '小鲸'}
        characterId={v2Snapshot?.identity.characterId ?? 'char_xiaojing'}
        expression={v2Snapshot?.activityState.expression ?? 'idle'}
        activityMode={v2Snapshot?.activityState.mode ?? 'companion'}
        controlMode={v2Snapshot?.activityState.controlMode ?? 'autonomous'}
        halted={v2Snapshot?.activityState.halted ?? false}
        running={running}
        humanControl={humanControl}
        brainMode={brain.mode}
        asleep={asleep}
        busy={hudBusy}
        computerLease={autoSnap === null ? null : buildComputerLeaseView(autoSnap)}
        onEmergencyHalt={() => void emergencyHalt('ControlOwnershipHud 急停')}
        onToggleTakeover={() => void toggleTakeover()}
        onResumeAutonomous={() => void resumeAutonomous()}
        onToggleSleep={() => void toggleSleep()}
        onOpenLifeConsole={() => setTab('life')}
      />

      {tab === 'chat' && (
        <ChatAside
          running={running}
          latestState={latestState}
          decisions={decisions}
          memoryStats={memoryStats}
          guidesCount={guides.length}
          onSendCommand={sendText}
          onSelectTab={setTab}
        />
      )}

      <main className="wb-main">
        {tab === 'chat' && (
          <ChatView
            events={events}
            objective={objective}
            driveError={driveError}
            input={input}
            flowRef={flowRef}
            onInputChange={setInput}
            onSend={send}
            onSendText={sendText}
          />
        )}
        {tab === 'life' && (
          <div className="h-full overflow-y-auto">
            <LifeConsoleView snapshot={v2Snapshot} onSnapshotChanged={refreshV2Snapshot} />
          </div>
        )}
        {tab === 'memory' && <div className="h-full overflow-y-auto"><MemoryPanel /></div>}
        {tab === 'voice' && (
          <div className="h-full overflow-y-auto px-6 py-5">
            <VoiceCenterPanel
              characters={characters}
              characterId={characterId}
              onSelectCharacter={(id) => void selectCharacter(id)}
            />
          </div>
        )}
        {tab === 'pet' && (
          <div className="h-full overflow-y-auto px-6 py-5">
            <PetStudioPanel
              events={events}
              running={running}
              characters={characters}
              characterId={characterId}
              onSelectCharacter={(id) => void selectCharacter(id)}
              openNotebookSignal={notebookSignal}
              openCreatorSignal={creatorSignal}
              {...(creatorTab === undefined ? {} : { openCreatorTab: creatorTab })}
              openBenchSignal={benchSignal}
              providers={providers}
              store={store}
              onOpenProviders={() => setTab('providers')}
            />
          </div>
        )}
        {tab === 'coop' && <CoopPanel />}
        {tab === 'stardew' && (
          <GameWorkspaceView
            activeGame={activeGame}
            gameSubtab={gameSubtab}
            gameEnabled={gameEnabled}
            modsEnabled={plugins.has('mods')}
            events={events}
            running={running}
            brainMode={brain.mode}
            guidesCount={guides.length}
            objective={objective}
            chatFilter={chatFilter}
            bwfHud={bwfHud}
            bwfPort={bwfPort}
            editingBwfPort={editingBwfPort}
            bwfPortDraft={bwfPortDraft}
            avatarSync={avatarSync}
            dayPlan={dayPlan}
            insights={insights}
            stardewHealth={stardewHealth}
            sessionId={sessionRef.current.sessionId}
            onSelectGame={selectGame}
            onSetGameSubtab={setGameSubtab}
            onSetChatFilter={setChatFilter}
            onToggleBwfHud={() => void toggleBwfHud()}
            onSetEditingBwfPort={setEditingBwfPort}
            onSetBwfPortDraft={setBwfPortDraft}
            onSaveBwfPort={() => void saveBwfPort()}
            onToggleAvatarSync={() => void toggleAvatarSync()}
            onToggleAvatarLiveliness={() => void toggleAvatarLiveliness()}
            onInstallAvatarMod={() => void installAvatarMod()}
            onUninstallAvatarMod={() => void uninstallAvatarMod()}
            onSyncAvatarNow={() => void syncAvatarNow()}
            onOpenPixelCreator={() => { setCreatorTab('pixel'); setTab('pet'); setCreatorSignal((v) => v + 1); }}
            onCancelObjective={() => void cancelObjective()}
            onSendText={sendText}
          />
        )}
        {tab === 'obs' && <div className="h-full overflow-y-auto"><ObsPanel rice={rice} riceCap={riceCap} events={events} /></div>}
        {tab === 'harness' && <div className="h-full overflow-y-auto"><HarnessPanel /></div>}
        {tab === 'providers' && (
          <div className="h-full overflow-y-auto">
            <ProvidersPanel profiles={profiles} slotLabels={slotLabels} providers={providers} store={store} />
          </div>
        )}
        {tab === 'plugins' && (
          <div className="h-full overflow-y-auto">
            <PluginsPanel
              enabled={plugins}
              onToggle={(id, enabled) => setPlugins((prev) => {
                const next = new Set(prev);
                if (enabled) next.add(id); else next.delete(id);
                if (next.size === 0) {
                  toast.error('至少保留一个插件，否则工作台没有任何页面可展示');
                  return prev;
                }
                return next;
              })}
            />
          </div>
        )}
      </main>

      {launchPromptOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center px-6"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          data-stardew-launch-prompt
        >
          <div className="card w-full max-w-[440px] px-5 py-4" role="dialog" aria-modal="true" aria-label="启动星露谷物语">
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-1)' }}>《星露谷物语》还没启动</h3>
            <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
              启动自动驾驶需要游戏与 BWF MCP 在线。可以现在由鲸屿代你启动（优先 SMAPI，确保 Mod 被加载），
              也可以先去游戏标题画面手动选择存档。
            </p>
            <label className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-2)' }}>
              <input
                type="checkbox"
                data-stardew-auto-launch
                checked={stardewAutoLaunch}
                onChange={(event) => {
                  const next = event.target.checked;
                  setStardewAutoLaunch(next);
                  localStorage.setItem('wb-stardew-auto-launch', next ? '1' : '0');
                }}
              />
              以后自动启动（记住这个选择）
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                data-stardew-launch-cancel-prompt
                className="btn-pill ghost"
                onClick={() => setLaunchPromptOpen(false)}
              >
                取消
              </button>
              <button
                data-stardew-launch-confirm
                className="btn-pill primary"
                disabled={launchingGame}
                onClick={() => {
                  setLaunchPromptOpen(false);
                  void (async () => {
                    setLaunchingGame(true);
                    const ready = await waitForStardewReady();
                    setLaunchingGame(false);
                    if (ready) await start();
                  })();
                }}
              >
                <Rocket size={11} />{launchingGame ? '启动中…' : '先启动游戏'}
              </button>
            </div>
          </div>
        </div>
      )}

      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} actions={paletteActions} onSay={sendText} />
      <Toaster
        theme={resolvedTheme}
        position="bottom-right"
        toastOptions={{ className: 'wb-toast-item', style: { border: '1px solid transparent' } }}
      />
    </div>
  );
}
