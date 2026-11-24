/**
 * 工作台 Shell v4「曜石 · 演进版」：分组插件导航 + 顶栏 ⌘K/主题/三开关 + 饭碗 footer。
 * 交互全部走真实 IPC（autodrive/memory/mods/voice/harness/providers）；页面按设计稿分区。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Toaster, toast } from 'sonner';
import {
  Activity, Brain, ChevronRight, Monitor, Play, Radio, RotateCcw, Send, ShieldAlert,
  Square, Volume2, VolumeX, Wheat, Zap,
} from 'lucide-react';
import { ModelProviderConfigSchema, type DiningProfilePreset, type ModelProviderConfig, type WorkbenchRoleSlot } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import { GAME_OPTIONS, isCurrentSessionEvent, type AutodriveEventView, type CharacterSummary, type GameId } from './bridge';
import { ProvidersPanel } from './providers-panel';
import { HarnessPanel } from './harness-panel';
import { VoiceCenterPanel } from './voice-center-panel';
import { ModsPanel } from './mods-panel';
import { MemoryPanel } from './memory-panel';
import { ObsPanel } from './obs-panel';
import { PluginsPanel } from './plugins-panel';
import { PetStudioPanel } from './pet-studio';
import { CoopPanel } from './coop-panel'; // T-M6-22 多桌宠联机端点
import { TerrariaPanel } from './terraria-panel';
import { DstPanel, type DstPanelEvent } from './dst-panel';
import {
  GAME_STATUS_COLOR,
  GameConnectionBanner,
  GameCurrentActionCard,
  GameDiagnostics,
  GameGoalChain,
  GameMetricsCard,
  GameQualityCard,
  GameQuickCommands,
  GameReceiptTimeline,
  statusLabel,
  toolLabel,
  useGameHealth,
  type ReceiptFilter,
} from './game-panel';
import { NAV_GROUPS, Sidebar, type Tab } from './shell/sidebar';
import { Topbar } from './shell/topbar';
import { CommandPalette, type CommandAction } from './shell/command-palette';

const NAV_FLAT = NAV_GROUPS.flatMap((g) => g.items);
const SLASH_COMMANDS = [
  { cmd: '/goto Beach', desc: '去某地（Beach / Town / Farm / Mine）' },
  { cmd: '/fish 5', desc: '钓鱼 5 次' },
  { cmd: '/forage', desc: '采集 / 翻垃圾桶' },
  { cmd: '/sleep', desc: '回家睡觉' },
  { cmd: '/state', desc: '播报当前状态' },
  { cmd: '/stop', desc: '停下当前动作' },
];

function parseDirective(text: string): { tool: string; args: Record<string, unknown>; intent: string } | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const parts = t.slice(1).split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const rest = parts.slice(1);
  switch (cmd) {
    case 'goto':
      return { tool: 'travel_to', args: { location: rest[0] ?? 'Farm' }, intent: `主人指令：去 ${rest[0] ?? 'Farm'}` };
    case 'stop':
      return { tool: 'cancel_action', args: {}, intent: '主人指令：停下当前动作' };
    case 'sleep':
      return { tool: 'sleep', args: {}, intent: '主人指令：回家睡觉' };
    case 'fish':
      return { tool: 'fish', args: { casts: Number(rest[0] ?? 5) || 5 }, intent: '主人指令：钓鱼' };
    case 'state':
      return { tool: 'get_state', args: {}, intent: '主人指令：播报状态' };
    case 'forage':
      return { tool: 'forage', args: {}, intent: '主人指令：去采集' };
    default:
      return { tool: cmd, args: {}, intent: `主人指令：${cmd}` };
  }
}

/** 星露谷目标链与快捷指令（三游戏共玩页共用区块的数据源） */
const STARDEW_GOALS = ['读信 / 浇水 / 播种', '11:00 海滩钓鱼', '17:30 镇上采集', '18:30 前回家', '睡觉防晕倒'] as const;
const STARDEW_QUICK: ReadonlyArray<readonly [string, string]> = [
  ['钓鱼', '/fish 5'],
  ['去海滩', '/goto Beach'],
  ['睡觉', '/sleep'],
  ['汇报状态', '/state'],
];

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
  // 联机协作是核心内置页：旧 localStorage 插件集合没有 coop 时也必须可见
  if (tab === 'coop') return true;
  if (tab === 'stardew') return GAME_OPTIONS.some((game) => enabledPlugins.has(game.id)) || enabledPlugins.has('mods');
  return enabledPlugins.has(tab);
}

function initialTab(): Tab {
  const saved = localStorage.getItem('wb-tab');
  if (saved === 'terraria' || saved === 'dst' || saved === 'mods') return 'stardew';
  return saved !== null && NAV_FLAT.some((item) => item.id === saved) ? saved as Tab : 'chat';
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
  const [brain, setBrain] = useState<{ mode: string; llmReady: boolean }>({ mode: 'rule', llmReady: false });
  const [mainModelId, setMainModelId] = useState('');
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [characterId, setCharacterId] = useState('blue-whale-maid');
  // 桌宠右键「小本子」→ 每次自增，切到桌宠工坊 Tab 3
  const [notebookSignal, setNotebookSignal] = useState(0);
  const [creatorSignal, setCreatorSignal] = useState(0);
  const [benchSignal, setBenchSignal] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  // T-M6-33：实际语音后端（mcode / say / unsupported），顶栏如实展示，避免把 say 当角色 TTS
  const [voiceBackend, setVoiceBackend] = useState<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('wb-theme') === 'light' ? 'light' : 'dark'));
  const [plugins, setPlugins] = useState<Set<string>>(readPlugins);
  const [rice, setRice] = useState(0);
  const [riceCap, setRiceCap] = useState(500_000);
  const [memoryStats, setMemoryStats] = useState<{ nodes: number; edges: number; lastDay: string | null } | null>(null);
  const [guides, setGuides] = useState<string[]>([]);
  const [chatFilter, setChatFilter] = useState<ReceiptFilter>('all');
  // 桌宠工坊 / 语音中心的分页签状态由各自面板内聚（T-M6-46）
  // BWF 游戏内左上角 MCP 提示 HUD（T-M6-16 用户指令）：默认关闭；契约 StardewModsConfig.bwfShowHud
  const [bwfHud, setBwfHud] = useState(false);
  const flowRef = useRef<HTMLDivElement | null>(null);
  // T-M6-27 会话归属：只消费当前 autodrive 会话的事件。
  //  - 联机端点事件（带 agentId）不进单机会话页
  //  - 旧 generation / 异 sessionId / 异 gameId 的迟到事件一律丢弃
  const sessionRef = useRef<{ sessionId?: string; gameId?: GameId; generation: number }>({ generation: -1 });
  const activeGameRef = useRef<GameId>(activeGame);
  useEffect(() => { activeGameRef.current = activeGame; }, [activeGame]);
  const acceptEvent = (event: AutodriveEventView): boolean =>
    isCurrentSessionEvent(event, sessionRef.current, activeGameRef.current);
  // 三游戏桥接探活（T-M6-25）：星露谷页的连接引导条（只读探活，不触发任何游戏动作；页签不可见时停轮询）
  const stardewHealth = useGameHealth('stardew', undefined, 15_000, tab === 'stardew' && activeGame === 'stardew');

  useEffect(() => {
    window.directorBridge.onAutodriveEvent((event) => {
      if (!acceptEvent(event)) return;
      setEvents((prev) => (prev.length >= 500 ? [...prev.slice(-499), event] : [...prev, event]));
      // 事件即代表正在跑（外部启动/重启后 UI 不落后）
      if (event.type === 'state' || event.type === 'decision' || event.type === 'receipt') setRunning(true);
    });
    void window.directorBridge.autodriveStatus().then((s) => {
      // 先记录会话再水合：历史事件同样按当前会话过滤
      sessionRef.current = { sessionId: s.sessionId, gameId: s.gameId, generation: s.generation ?? -1 };
      setRunning(s.running);
      if (s.running && s.gameId !== undefined) setActiveGame(s.gameId);
      const history = (s.events ?? []).filter(acceptEvent);
      if (history.length > 0) setEvents((prev) => mergeHydrated(history, prev));
    });
    void window.directorBridge.plannerStatus().then((s) => setBrain(s));
    // T-M6-48：主条只展示 9 角色（+内置小鲸）；CrossPet 的 30 个角色由召唤/彩蛋/跨 AI 跟随单独使用
    const refreshCharacters = (): void => {
      void window.directorBridge.characterList()
        .then((list) => setCharacters(list.filter((character) => !(character.packId ?? '').startsWith('crosspet-'))))
        .catch(() => setCharacters([]));
    };
    refreshCharacters();
    window.addEventListener('pet:characters-changed', refreshCharacters);
    window.directorBridge.onOpenPetNotebook(() => {
      setTab('pet');
      setNotebookSignal((value) => value + 1);
    });
    window.directorBridge.onOpenCreator(() => {
      setTab('pet');
      setCreatorSignal((value) => value + 1);
    });
    window.directorBridge.onOpenBench(() => {
      setTab('pet');
      setBenchSignal((value) => value + 1);
    });
    void window.directorBridge.prefsGet().then((p) => {
      if (typeof p.characterId === 'string') setCharacterId(p.characterId);
    }).catch(() => undefined);
    void window.directorBridge.voiceConfigGet().then((c) => setVoiceOn(c.enabled));
    void window.directorBridge.voiceBackend().then(setVoiceBackend).catch(() => setVoiceBackend(null));
    void window.directorBridge.riceStatus().then((r) => { setRice(r.balance); setRiceCap(r.budget); });
    // BWF HUD 偏好水合（T-M6-16）：主进程 mods:state 顺带触发一次自愈推送
    void window.directorBridge.modsState().then((s) => { if (s.bwfShowHud === true) setBwfHud(true); });
    // 启动即把 Dexie 里的单一配置 + 服务商清单/模型启停同步给主进程
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
          // 冷启动也还原选中变体的 Region/Plan（否则同协议不同胶囊的供应商会退回默认项）
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
  }, []);

  useEffect(() => {
    if (!running) return;
    const refreshStatus = (): void => {
      void window.directorBridge.autodriveStatus().then((status) => {
        setRunning(status.running);
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

  // 侧栏碗/记忆 badge 低频轮询（回执扣米与换日写日记不是推送式，15s 足够）
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

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('wb-theme', theme);
  }, [theme]);

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
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const start = async (): Promise<void> => {
    setDriveError(null);
    const res = await window.directorBridge.autodriveStart(activeGame);
    if (res.ok) {
      setRunning(true);
      // T-M6-27：启动后立刻同步新会话标识，后续 P0 指令才带上正确的 expectedSessionId
      void window.directorBridge.autodriveStatus().then((status) => {
        if (status.sessionId !== undefined) {
          sessionRef.current = { sessionId: status.sessionId, gameId: status.gameId ?? activeGame, generation: status.generation ?? -1 };
        }
      }).catch(() => undefined);
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
    toast('自动驾驶已停止：控制权交还主人');
  };

  const selectGame = (gameId: GameId): void => {
    if (running || !plugins.has(gameId)) return;
    setActiveGame(gameId);
    setGameSubtab('monitor');
    setEvents([]);
    // T-M6-27：游戏切换后旧会话的迟到事件不再进入本页（主进程 generation 也会随之推进）
    sessionRef.current = { ...sessionRef.current, gameId };
  };

  const selectCharacter = async (id: string): Promise<void> => {
    if (id === characterId) return;
    const result = await window.directorBridge.characterSelect(id);
    if (!result.ok) {
      toast.error(result.error ?? '角色切换失败');
      return;
    }
    setCharacterId(id);
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

  /** BWF 游戏内左上角 MCP 提示 HUD（T-M6-16）：默认关闭；主进程持久化 + /settings 运行时下发 */
  const toggleBwfHud = async (): Promise<void> => {
    const next = !bwfHud;
    setBwfHud(next);
    const res = await window.directorBridge.modsSetBwfHud(next);
    if (!res.ok) {
      setBwfHud(!next);
      toast.error(res.error ?? 'HUD 开关保存失败');
      return;
    }
    if (res.gameOffline === true) toast(`已保存：HUD ${next ? '显示' : '关闭'}（游戏没在跑，开游戏后自动生效）`);
    else if (res.needsGameRestart === true) toast.warning('已保存，但游戏内还是旧版 Mod——重启一次游戏后生效');
    else toast.success(`游戏内 MCP 提示已${next ? '打开' : '关闭'}（即时生效）`);
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
      // T-M6-27：带上当前会话；若 UI 在等待期间被切走，主进程会拒绝而不是误发到新游戏
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

  const send = (): void => {
    sendText(input);
    setInput('');
  };

  const latestState = [...events].reverse().find((e) => e.type === 'state');
  const receipts = events.filter((e) => e.type === 'receipt');
  const decisions = events.filter((e) => e.type === 'decision');
  const watchdog = events.filter((e) => e.type === 'watchdog');
  const lastDecision = decisions[decisions.length - 1];
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
      { id: 'act:drive', label: running ? '停止自动驾驶' : '启动自动驾驶', group: '全局动作', icon: running ? Square : Play, hint: '当前游戏', run: () => void (running ? stop() : start()) },
      { id: 'act:brain', label: brain.mode === 'llm' ? '切换规则日程' : '切换 LLM 大脑', group: '全局动作', icon: Brain, hint: brain.mode, run: () => void switchBrain() },
      { id: 'act:voice', label: voiceOn ? '静音语音' : '开启语音', group: '全局动作', icon: voiceOn ? VolumeX : Volume2, run: () => void toggleVoice() },
      { id: 'act:feed', label: '投喂 5,000 粒米', group: '全局动作', icon: Wheat, hint: '饭碗', run: () => void feedRice() },
      { id: 'act:theme', label: theme === 'dark' ? '切到浅色主题' : '切到深色主题', group: '全局动作', icon: RotateCcw, run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
      { id: 'act:fish', label: '插队：钓鱼', group: '快捷指令', icon: Radio, hint: '/fish 5', run: () => sendText('/fish 5') },
      { id: 'act:sleep', label: '插队：回家睡觉', group: '快捷指令', icon: Radio, hint: '/sleep', run: () => sendText('/sleep') },
      { id: 'act:state', label: '播报当前状态', group: '快捷指令', icon: Activity, hint: '/state', run: () => sendText('/state') },
      { id: 'act:spray', label: '测试雷区反射（大肥鱼）', group: '快捷指令', icon: ShieldAlert, hint: '0 token', run: () => sendText('大肥鱼') },
    ];
    return [...pages, ...actions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, running, brain.mode, voiceOn, theme]);

  return (
    <div className={`wb-shell${tab === 'chat' ? ' has-aside' : ''} h-screen w-screen`} data-theme={theme}>
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
        badges={{ memory: memoryStats !== null ? `${memoryStats.nodes} 节点` : undefined }}
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
        theme={theme}
        onOpenCommandPalette={() => setCmdkOpen(true)}
        onToggleVoice={() => void toggleVoice()}
        onSwitchBrain={() => {
          if (brain.mode !== 'llm' && !brain.llmReady) setTab('providers');
          else void switchBrain();
        }}
        onSelectGame={selectGame}
        onToggleDrive={() => void (running ? stop() : start())}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      />

      {tab === 'chat' && (
        <aside className="wb-aside">
          <div className="card mb-3 px-3.5 py-3">
            <div className="mb-1.5 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
              <span>get_state 摘要</span>
              <span className={`pill ${running ? 'pill-green' : ''}`} style={{ fontSize: 9 }}>{running ? '运行中' : '待命'}</span>
            </div>
            <div className="mono space-y-1 text-[10.5px]" style={{ color: 'var(--text-2)' }}>
              <div>时间 · {latestState?.clock ?? '—'}</div>
              <div>地点 · {latestState?.location ?? '—'}</div>
              <div>金钱 · {latestState?.money != null ? `${latestState.money}g` : '—'}</div>
            </div>
            {latestState?.stamina != null && latestState.staminaMax != null && (
              <div className="mt-2">
                <div className="mono mb-1 flex justify-between text-[9.5px]" style={{ color: 'var(--text-3)' }}>
                  <span>体力</span><span>{latestState.stamina}/{latestState.staminaMax}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full" style={{ background: 'var(--inset)' }}>
                  <i className="block h-full" style={{ width: `${Math.round((latestState.stamina / latestState.staminaMax) * 100)}%`, background: 'linear-gradient(90deg,var(--green),var(--blue))' }} />
                </div>
              </div>
            )}
          </div>

          <div className="card mb-3 px-3.5 py-3">
            <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>动作时间线</div>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {decisions.slice(-5).reverse().map((d, i) => (
                <div key={i} className="mono rounded px-1.5 py-1 text-[10px]" style={{ background: 'var(--inset)', color: 'var(--text-2)' }}>
                  <span style={{ color: d.planner === 'remote' ? 'var(--amber)' : 'var(--blue)' }}>{toolLabel(d.tool)}</span>
                  <span className="ml-1" style={{ color: 'var(--text-3)' }}>{(d.intent ?? '').slice(0, 26)}</span>
                </div>
              ))}
              {decisions.length === 0 && <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>尚无决策</span>}
            </div>
          </div>

          <div className="card mb-3 px-3.5 py-3">
            <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>快捷 P0</div>
            <div className="grid grid-cols-2 gap-1">
              {([['钓鱼', '/fish 5'], ['回农场', '/goto Farm'], ['睡觉', '/sleep'], ['停下', '/stop']] as const).map(([label, cmd]) => (
                <button key={cmd} className="pill justify-center" style={{ fontSize: 10 }} onClick={() => sendText(cmd)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="card px-3.5 py-3">
            <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>上下文</div>
            <button className="mb-1 flex w-full items-center justify-between text-[10.5px]" style={{ color: 'var(--text-2)' }} onClick={() => setTab('memory')}>
              <span>记忆节点</span><span className="mono" style={{ color: 'var(--violet)' }}>{memoryStats?.nodes ?? 0}</span>
            </button>
            <button className="flex w-full items-center justify-between text-[10.5px]" style={{ color: 'var(--text-2)' }} onClick={() => setTab('providers')}>
              <span>攻略专题</span><span className="mono" style={{ color: 'var(--green)' }}>{guides.length}</span>
            </button>
          </div>
        </aside>
      )}

      <main className="wb-main">
        {tab === 'chat' && (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-1.5 px-5 py-2.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
              <span className="pill pill-blue"><span className="pulse-dot" />星露谷共玩</span>
              <span className="pill" style={{ opacity: 0.55 }}>弹幕陪聊</span>
              <span className="pill" style={{ opacity: 0.55 }}>点歌台</span>
              <div className="flex-1" />
              <button className="pill pill-red" onClick={() => sendText('大肥鱼')} title="0 token 雷区反射">
                <ShieldAlert size={11} /> 测试雷区
              </button>
            </div>
            <div ref={flowRef} className="flex-1 overflow-y-auto px-6 py-4">
              <div className="stagger mx-auto max-w-3xl">
                {events.length === 0 && (
                  <div className="card mt-10 px-6 py-8 text-center">
                    <Radio size={22} className="floaty mx-auto mb-3" style={{ color: 'var(--blue)' }} />
                    <p className="text-sm font-semibold">小鲸待命中</p>
                    <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
                      点右上「启动自动驾驶」接管星露谷（需游戏 + BWF Mod MCP 就绪）<br />
                      直接说中文也行：<span className="mono" style={{ color: 'var(--blue)' }}>先去海滩钓鱼吧</span>
                    </p>
                  </div>
                )}
                {events.map((e, i) => <EventCard key={i} event={e} />)}
              </div>
            </div>
            {driveError !== null && <div className="px-6 pb-1 text-xs" style={{ color: 'var(--red)' }} data-drive-error>{driveError}</div>}
            <div className="relative px-6 pb-4">
              {input.startsWith('/') && (
                <div className="absolute bottom-full left-6 right-6 mb-2 overflow-hidden rounded-xl" style={{ background: 'var(--bg-elev)', border: '1px solid var(--stroke-2)', boxShadow: 'var(--shadow-2)' }}>
                  {SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(input.toLowerCase().split(' ')[0] ?? '')).map((c) => (
                    <button key={c.cmd} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] hover:bg-[var(--surface-2)]" onClick={() => { setInput(c.cmd); }}>
                      <span className="mono" style={{ color: 'var(--blue)' }}>{c.cmd}</span>
                      <span style={{ color: 'var(--text-3)' }}>{c.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="mx-auto flex max-w-3xl gap-2">
                <input
                  data-chat-input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                  placeholder="和 小鲸 说话，或 /goto Beach、/fish 5、/sleep 指令插队……"
                  className="flex-1 px-4 py-2.5 text-sm outline-none transition"
                  style={{ borderRadius: 18, border: '1px solid var(--stroke-2)', background: 'var(--surface)', color: 'var(--text-1)' }}
                />
                <button data-chat-send onClick={send} className="btn-pill primary px-5">
                  <Send size={12} />发送
                </button>
              </div>
            </div>
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
              openBenchSignal={benchSignal}
              providers={providers}
              store={store}
              onOpenProviders={() => setTab('providers')}
            />
          </div>
        )}

        {tab === 'coop' && <CoopPanel />}

        {tab === 'stardew' && (
          <section data-game-panel data-active-game={activeGame} data-active-subtab={gameSubtab} className="h-full overflow-y-auto">
            <header className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-2 px-6 pb-2 pt-4">
              <div className="seg-tabs" role="tablist" aria-label="选择共玩游戏">
                {GAME_OPTIONS.map((game) => (
                  <button
                    key={game.id}
                    type="button"
                    role="tab"
                    data-game-select={game.id}
                    data-selected={activeGame === game.id ? 'true' : 'false'}
                    aria-selected={activeGame === game.id}
                    disabled={!gameEnabled[game.id]}
                    title={gameEnabled[game.id] ? game.label : `请先在「插件与权限」启用${game.label}`}
                    className={`seg-tab${activeGame === game.id ? ' on' : ''}`}
                    onClick={() => selectGame(game.id)}
                  >
                    {game.shortLabel}
                  </button>
                ))}
              </div>
              {activeGame === 'stardew' && plugins.has('mods') && (
                <div className="seg-tabs" role="tablist" aria-label="星露谷页面">
                  <button
                    type="button"
                    role="tab"
                    data-game-subtab="monitor"
                    aria-selected={gameSubtab === 'monitor'}
                    className={`seg-tab${gameSubtab === 'monitor' ? ' on' : ''}`}
                    onClick={() => setGameSubtab('monitor')}
                  >共玩监控</button>
                  <button
                    type="button"
                    role="tab"
                    data-game-subtab="mods"
                    aria-selected={gameSubtab === 'mods'}
                    className={`seg-tab${gameSubtab === 'mods' ? ' on' : ''}`}
                    onClick={() => setGameSubtab('mods')}
                  >Mod 管理</button>
                </div>
              )}
            </header>
            {gameSubtab === 'mods' && activeGame === 'stardew' && plugins.has('mods') && (
              <div data-mods-page className="mx-auto max-w-[1320px] px-6 pb-6"><ModsPanel /></div>
            )}
            {gameSubtab === 'monitor' && activeGame === 'terraria' && plugins.has('terraria') && (
              <div className="mx-auto max-w-[1320px] px-6 py-3"><TerrariaPanel events={events} running={running} /></div>
            )}
            {gameSubtab === 'monitor' && activeGame === 'dst' && plugins.has('dst') && (
              <div className="mx-auto max-w-[1320px] px-6 py-3">
                <DstPanel
                  bridge={{
                    dstState: () => window.directorBridge.gameDstState(),
                    dstStart: () => window.directorBridge.autodriveStart('dst'),
                    dstStop: () => window.directorBridge.autodriveStop(),
                    dstDirective: (tool, args, intent) => window.directorBridge.autodriveDirective(tool, args, intent, sessionRef.current.sessionId),
                    onDstEvent: (handler) => window.directorBridge.onAutodriveEvent((event) => {
                      if (event.type === 'state' || event.type === 'decision' || event.type === 'receipt' || event.type === 'watchdog') handler(event as DstPanelEvent);
                    }),
                  }}
                  endpoint="http://127.0.0.1:18100"
                />
              </div>
            )}
            {gameSubtab === 'monitor' && activeGame === 'stardew' && plugins.has('stardew') && (
              <div className="mx-auto max-w-[1320px] px-6 py-3">
            <GameConnectionBanner gameId="stardew" report={stardewHealth.report} probing={stardewHealth.probing} onReprobe={stardewHealth.reprobe} />
            <div className="card mb-4 flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="pill pill-violet"><Brain size={11} />{brain.mode === 'llm' ? '智能决策' : '本地规则兜底'}</span>
              <span className="pill">78 个可用动作</span>
              <span className="pill pill-amber">30 粒米 / 回执</span>
              <span className="pill pill-green">攻略 {guides.length} 专题</span>
              <button
                data-bwf-hud={bwfHud ? 'on' : 'off'}
                onClick={() => void toggleBwfHud()}
                title="游戏画面左上角的 MCP 提示信息（连接/思考/执行状态）——默认关闭不显示"
                className={`pill cursor-pointer${bwfHud ? ' pill-green' : ''}`}
              >
                <Monitor size={11} />游戏内提示 {bwfHud ? '开' : '关'}
              </button>
              <div className="flex-1" />
              <span className={`pill ${running ? 'pill-green' : ''}`} style={{ fontSize: 10 }}>{running ? '自动驾驶中' : '待命'}</span>
            </div>

            <div className="grid grid-cols-[1.18fr_0.98fr_0.84fr] gap-4">
              <section className="flex flex-col gap-3">
                <GameCurrentActionCard
                  decision={lastDecision}
                  metrics={[
                    ['时间', latestState?.clock ?? '—'],
                    ['体力', latestState?.stamina != null ? `${latestState.stamina}/${latestState.staminaMax ?? '—'}` : '—'],
                    ['金钱', latestState?.money != null ? `${latestState.money}g` : '—'],
                  ]}
                  idleHint="等待自动驾驶启动…"
                />
                <GameGoalChain goals={STARDEW_GOALS} activeIndex={0} />
              </section>

              <GameReceiptTimeline
                receipts={receipts}
                filter={chatFilter}
                onFilter={(next) => setChatFilter(next)}
                emptyHint="游戏连接后，这里会按时间线记录每一步动作与结果。"
              />

              <section className="flex flex-col gap-3">
                <GameMetricsCard
                  rows={[
                    ['回执总数', receipts.length],
                    ['决策次数', decisions.length],
                    ['看门狗事件', watchdog.length],
                    ['攻略专题', guides.length],
                  ]}
                />
                <GameQualityCard events={events} />
                <GameQuickCommands
                  commands={STARDEW_QUICK}
                  onCommand={(key) => sendText(key)}
                  stopKey="/stop"
                />
                <GameDiagnostics
                  title="高级诊断"
                  rows={[
                    ['桥接方式', 'BWF Mod 本机服务 (:18080)'],
                    ['可用动作', '78 个白名单动作'],
                    ['卡死策略', '大脑救援问询 + 离线阶梯兜底'],
                    ['直写工具', '默认关闭（运行期安全锁）'],
                  ]}
                  notes={[
                    '所有动作走 BWF MCP 回执，超时不重发、卡死由看门狗接管；审计写 JSONL。',
                    '结论与许可证见 docs/REFERENCE-dsh-stardew-blind-whale-farmer.md。',
                  ]}
                />
              </section>
            </div>
              </div>
            )}
          </section>
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

      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} actions={paletteActions} />
      <Toaster
        theme={theme}
        position="bottom-right"
        toastOptions={{ style: { background: 'var(--surface-solid)', color: 'var(--text-1)', border: '1px solid var(--stroke-2)' } }}
      />
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="flex justify-between py-1 text-xs">
      <span style={{ color: 'var(--text-3)' }}>{k}</span>
      <span className="mono" style={{ color: 'var(--text-1)' }}>{v}</span>
    </div>
  );
}

function EventCard({ event }: { event: AutodriveEventView }): React.JSX.Element {
  if (event.type === 'user') {
    return (
      <div data-event="user" className="mb-3 flex justify-end">
        <div
          className="max-w-[72%] px-4 py-2.5 text-[13px]"
          style={{
            borderRadius: 18,
            background: 'linear-gradient(135deg, rgba(10,132,255,0.20), rgba(10,132,255,0.10))',
            border: '1px solid var(--blue-line)',
            color: 'var(--text-1)',
          }}
        >
          {event.summary}
        </div>
      </div>
    );
  }
  if (event.type === 'decision' && event.tool === 'think') {
    return (
      <div
        data-event="think"
        className="mb-3 rounded-[18px] p-3"
        style={{
          background: 'linear-gradient(135deg, rgba(191,90,242,0.14), rgba(191,90,242,0.05))',
          border: '1.5px dashed rgba(191,90,242,0.42)',
          backdropFilter: 'blur(16px)',
        }}
      >
        <div className="mono flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--violet)' }}>
          <Brain size={11} />内心戏 · {event.intent?.slice(0, 80)}
        </div>
      </div>
    );
  }
  if (event.type === 'decision') {
    return (
      <div data-event="decision" className="mb-3 rounded-2xl p-3" style={{ border: '1px solid var(--blue-line)', background: 'var(--blue-dim)' }}>
        <div className="mono text-[10px]" style={{ color: 'var(--blue)' }}>
          {event.planner === 'remote' ? 'P0 插队' : `决策 · ${event.planner ?? 'planner'}`}
        </div>
        <div className="mono mt-1 text-sm font-semibold" style={{ color: 'var(--text-1)' }}>{toolLabel(event.tool)}</div>
        <div className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>{event.intent}</div>
      </div>
    );
  }
  if (event.type === 'receipt' && (event.tool === 'chat_reply' || event.tool === 'reflex_spray')) {
    const isReflex = event.tool === 'reflex_spray';
    return (
      <div data-event="chat" className="mb-3 flex items-start gap-2.5">
        <div
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          style={{
            background: 'linear-gradient(135deg, rgba(120,170,255,0.95), rgba(90,110,240,0.85))',
            color: '#fff',
            boxShadow: '0 2px 8px rgba(60,110,255,0.35)',
          }}
        >
          鲸
        </div>
        <div className="max-w-[78%]">
          <div className="mono mb-1 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-3)' }}>
            <span style={{ color: 'var(--text-2)' }}>小鲸</span>
            {isReflex && (
              <span className="rounded px-1 py-px text-[9px]" style={{ background: 'var(--red-dim)', color: 'var(--red)' }}>
                炸毛反射 · 0 token
              </span>
            )}
          </div>
          <div
            className="wb-md px-3.5 py-2.5 text-[13px] leading-relaxed"
            style={{
              borderRadius: '4px 16px 16px 16px',
              background: isReflex ? 'var(--red-dim)' : 'var(--surface)',
              border: `1px solid ${isReflex ? 'var(--red-line)' : 'var(--stroke-2)'}`,
              backdropFilter: 'blur(14px)',
              color: 'var(--text-1)',
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.summary ?? ''}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }
  if (event.type === 'receipt') {
    // T-M6-17 接单卡：聊天下单成功 → 琥珀卡展示「接单 → 工具｜意图」，与她的回话气泡紧邻
    if (event.tool === 'chat_order') {
      const [tool, ...rest] = (event.summary ?? '').split('｜');
      return (
        <div data-event="chat-order" className="mb-3 rounded-2xl p-3" style={{ border: '1px solid var(--amber-line)', background: 'var(--amber-dim)' }}>
          <div className="mono flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--amber)' }}>
            <Zap size={12} />接单——马上就去做
            <span style={{ color: 'var(--text-3)' }}>{toolLabel(tool)}</span>
          </div>
          <div className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>{rest.join('｜') || event.summary}</div>
        </div>
      );
    }
    const c = GAME_STATUS_COLOR[event.status ?? 'ERROR'] ?? GAME_STATUS_COLOR.ERROR!;
    return (
      <div data-event="receipt" className="mb-3 rounded-2xl p-3" style={{ border: `1px solid ${c.line}`, background: c.bg }}>
        <div className="mono flex items-center gap-2 text-xs font-semibold" style={{ color: c.text }}>
          <span>{statusLabel(event.status)}</span>
          <span style={{ color: 'var(--text-3)' }}>{toolLabel(event.tool)}</span>
        </div>
        <div className="mt-1 line-clamp-3 text-xs" style={{ color: 'var(--text-2)' }}>{event.summary}</div>
      </div>
    );
  }
  if (event.type === 'state') {
    return (
      <div data-event="state" className="mono mb-2 text-center text-[10px]" style={{ color: 'var(--text-3)' }}>
        {event.clock} · {event.location} · {event.stamina}/{event.staminaMax} · {event.money}g
      </div>
    );
  }
  if (event.type === 'watchdog') {
    return (
      <div data-event="watchdog" className="mb-3 rounded-2xl p-2.5" style={{ border: '1px solid var(--amber-line)', background: 'var(--amber-dim)' }}>
        <div className="mono text-[10px]" style={{ color: 'var(--amber)' }}>{event.kind === 'stuck' ? '卡死哨兵' : '心跳'}</div>
        <div className="mt-0.5 text-xs" style={{ color: 'var(--text-2)' }}>{event.detail}</div>
      </div>
    );
  }
  return <div data-event="cycle-end" className="mono mb-1 text-center text-[10px]" style={{ color: 'var(--text-3)' }}>— 间步 {Math.round((event.delayMs ?? 0) / 1000)}s —</div>;
}
