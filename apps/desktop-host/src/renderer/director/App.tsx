/**
 * 工作台 Shell v4「曜石 · 演进版」：分组插件导航 + 顶栏 ⌘K/主题/三开关 + 饭碗 footer。
 * 交互全部走真实 IPC（autodrive/memory/mods/voice/harness/providers）；页面按设计稿分区。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Toaster, toast } from 'sonner';
import {
  Activity, Brain, ChevronRight, Play, Radio, RotateCcw, Send, ShieldAlert,
  Sprout, Square, Volume2, VolumeX, Wheat, Zap,
} from 'lucide-react';
import type { DiningProfilePreset, ModelProviderConfig, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import type { AutodriveEventView } from './bridge';
import { ProvidersPanel } from './providers-panel';
import { HarnessPanel } from './harness-panel';
import { PetsPanel } from './pets-panel';
import { VoicePanel } from './voice-panel';
import { VoiceStudioPanel } from './voice-studio-panel';
import { ModsPanel } from './mods-panel';
import { MemoryPanel } from './memory-panel';
import { ObsPanel } from './obs-panel';
import { PluginsPanel } from './plugins-panel';
import { PetStagePanel } from './pet-stage-panel';
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

const STATUS_COLOR: Record<string, { bg: string; line: string; text: string }> = {
  COMPLETED: { bg: 'var(--green-dim)', line: 'var(--green-line)', text: 'var(--green)' },
  UNCERTAIN: { bg: 'var(--violet-dim)', line: 'var(--violet-line)', text: 'var(--violet)' },
  TIMEOUT: { bg: 'var(--amber-dim)', line: 'var(--amber-line)', text: 'var(--amber)' },
  FAILED: { bg: 'var(--red-dim)', line: 'var(--red-line)', text: 'var(--red)' },
  ERROR: { bg: 'var(--red-dim)', line: 'var(--red-line)', text: 'var(--red)' },
};

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

function readPlugins(): Set<string> {
  try {
    const raw = localStorage.getItem('wb-plugins-v4');
    if (raw === null) return new Set(NAV_FLAT.map((n) => n.id));
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set(NAV_FLAT.map((n) => n.id));
  }
}

export function App({ profiles, slotLabels, providers, store, storeKey }: AppProps): React.JSX.Element {
  void storeKey;
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('wb-tab') as Tab | null;
    return saved !== null && NAV_FLAT.some((n) => n.id === saved) ? saved : 'chat';
  });
  const [events, setEvents] = useState<AutodriveEventView[]>([]);
  const [running, setRunning] = useState(false);
  const [brain, setBrain] = useState<{ mode: string; llmReady: boolean }>({ mode: 'rule', llmReady: false });
  const [voiceOn, setVoiceOn] = useState(true);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('wb-theme') === 'light' ? 'light' : 'dark'));
  const [plugins, setPlugins] = useState<Set<string>>(readPlugins);
  const [rice, setRice] = useState(0);
  const [riceCap, setRiceCap] = useState(500_000);
  const [memoryStats, setMemoryStats] = useState<{ nodes: number; edges: number; lastDay: string | null } | null>(null);
  const [guides, setGuides] = useState<string[]>([]);
  const [chatFilter, setChatFilter] = useState<'all' | 'COMPLETED' | 'FAILED'>('all');
  const [voiceTab, setVoiceTab] = useState<'library' | 'studio'>('library');
  const [petTab, setPetTab] = useState<'stage' | 'library'>('stage');
  const flowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.directorBridge.onAutodriveEvent((event) => {
      setEvents((prev) => (prev.length >= 500 ? [...prev.slice(-499), event] : [...prev, event]));
      // 事件即代表正在跑（外部启动/重启后 UI 不落后）
      if (event.type === 'state' || event.type === 'decision' || event.type === 'receipt') setRunning(true);
    });
    void window.directorBridge.autodriveStatus().then((s) => {
      setRunning(s.running);
      const history = s.events ?? [];
      if (history.length > 0) setEvents((prev) => mergeHydrated(history, prev));
    });
    void window.directorBridge.plannerStatus().then((s) => setBrain(s));
    void window.directorBridge.voiceConfigGet().then((c) => setVoiceOn(c.enabled));
    void window.directorBridge.riceStatus().then((r) => { setRice(r.balance); setRiceCap(r.budget); });
    // 启动即把 Dexie 里的真实套餐/槽位同步给主进程（否则会一直用兜底 DELUXE）
    void Promise.all([
      store.getConfig<DiningProfilePreset[]>('diningProfiles'),
      store.getConfig<string>('activeDiningProfile'),
      store.getConfig<Record<string, { activeModelId?: string }>>('providerOverrides'),
    ]).then(([storedProfiles, activeId, overrides]) => {
      const list = storedProfiles !== undefined && storedProfiles.length > 0 ? storedProfiles : profiles;
      const chosen = list.find((p) => p.profileId === activeId) ?? list[0];
      if (chosen === undefined) return;
      const providerModels = Object.fromEntries(
        Object.entries(overrides ?? {})
          .map(([id, o]) => [id, o.activeModelId ?? ''] as const)
          .filter(([, model]) => model !== ''),
      );
      void window.directorBridge.brainApplyConfig({ profile: chosen, providerModels }).then((r) => {
        setBrain({ mode: r.mode, llmReady: r.llmReady });
      });
    });
    void window.directorBridge.memoryStats().then((m) => setMemoryStats(m));
    void window.directorBridge.guidesLoad().then((g) => { if (g.ok) setGuides(g.topics ?? []); });
  }, []);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, tab]);

  // 侧栏碗/记忆 badge 低频轮询（回执扣米与换日写日记不是推送式，15s 足够）
  useEffect(() => {
    const refresh = (): void => {
      void window.directorBridge.riceStatus().then((r) => { setRice(r.balance); setRiceCap(r.budget); });
    // 启动即把 Dexie 里的真实套餐/槽位同步给主进程（否则会一直用兜底 DELUXE）
    void Promise.all([
      store.getConfig<DiningProfilePreset[]>('diningProfiles'),
      store.getConfig<string>('activeDiningProfile'),
      store.getConfig<Record<string, { activeModelId?: string }>>('providerOverrides'),
    ]).then(([storedProfiles, activeId, overrides]) => {
      const list = storedProfiles !== undefined && storedProfiles.length > 0 ? storedProfiles : profiles;
      const chosen = list.find((p) => p.profileId === activeId) ?? list[0];
      if (chosen === undefined) return;
      const providerModels = Object.fromEntries(
        Object.entries(overrides ?? {})
          .map(([id, o]) => [id, o.activeModelId ?? ''] as const)
          .filter(([, model]) => model !== ''),
      );
      void window.directorBridge.brainApplyConfig({ profile: chosen, providerModels }).then((r) => {
        setBrain({ mode: r.mode, llmReady: r.llmReady });
      });
    });
      void window.directorBridge.memoryStats().then((m) => setMemoryStats(m));
    };
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem('wb-tab', tab);
  }, [tab]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('wb-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('wb-plugins-v4', JSON.stringify([...plugins]));
    if (!plugins.has(tab)) {
      const first = NAV_FLAT.find((n) => plugins.has(n.id));
      if (first !== undefined) setTab(first.id);
    }
  }, [plugins, tab]);

  useEffect(() => {
    const onBrain = (e: Event): void => {
      const detail = (e as CustomEvent<{ mode: string; llmReady: boolean }>).detail;
      if (detail !== undefined) setBrain({ mode: detail.mode, llmReady: detail.llmReady });
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
    const res = await window.directorBridge.autodriveStart();
    if (res.ok) {
      setRunning(true);
      toast.success('自动驾驶已启动：小鲸接管星露谷');
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
      void window.directorBridge.autodriveDirective(directive.tool, directive.args, directive.intent);
      setEvents((prev) => [...prev, { type: 'decision', tool: directive.tool, intent: directive.intent, planner: 'remote' }]);
      toast(`已插队：${directive.tool}`);
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
  const currentNav = NAV_FLAT.find((n) => n.id === tab);
  const isPluginEnabled = (id: string | Tab): boolean => plugins.has(id);

  const paletteActions = useMemo<CommandAction[]>(() => {
    const pages: CommandAction[] = NAV_FLAT
      .filter((n) => plugins.has(n.id))
      .map((n) => ({ id: `page:${n.id}`, label: n.label, group: '页面', icon: n.icon, run: () => setTab(n.id) }));
    const actions: CommandAction[] = [
      { id: 'act:drive', label: running ? '停止自动驾驶' : '启动自动驾驶', group: '全局动作', icon: running ? Square : Play, hint: '星露谷', run: () => void (running ? stop() : start()) },
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
        badges={{ memory: memoryStats !== null ? `${memoryStats.nodes} 节点` : undefined }}
      />
      <Topbar
        group={currentNav?.group ?? '工作台'}
        title={currentNav?.label ?? '工作台'}
        voiceOn={voiceOn}
        brainMode={brain.mode}
        llmReady={brain.llmReady}
        running={running}
        theme={theme}
        onOpenCommandPalette={() => setCmdkOpen(true)}
        onToggleVoice={() => void toggleVoice()}
        onSwitchBrain={() => void switchBrain()}
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
                  <span style={{ color: d.planner === 'remote' ? 'var(--amber)' : 'var(--blue)' }}>{d.tool}</span>
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
            <header className="mb-4 flex items-end justify-between">
              <div>
                <h1 className="text-xl font-semibold">声音工坊与音色库</h1>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>5 音色 × 5 情感试听 · TTS 调音台 · RVC 实验室（:18790）</p>
              </div>
              <div className="seg-tabs">
                <button className={`seg-tab${voiceTab === 'library' ? ' on' : ''}`} onClick={() => setVoiceTab('library')}>音色库</button>
                <button className={`seg-tab${voiceTab === 'studio' ? ' on' : ''}`} onClick={() => setVoiceTab('studio')}>声音工坊</button>
              </div>
            </header>
            {voiceTab === 'library' ? <VoicePanel bare /> : <VoiceStudioPanel bare />}
          </div>
        )}

        {tab === 'pet' && (
          <div className="h-full overflow-y-auto px-6 py-5">
            <header className="mb-4 flex items-end justify-between">
              <div>
                <h1 className="text-xl font-semibold">桌宠舞台与动作库</h1>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>透明舞台 · 双轨气泡 · 114 动作全量预览</p>
              </div>
              <div className="seg-tabs">
                <button className={`seg-tab${petTab === 'stage' ? ' on' : ''}`} onClick={() => setPetTab('stage')}>透明舞台</button>
                <button className={`seg-tab${petTab === 'library' ? ' on' : ''}`} onClick={() => setPetTab('library')}>动作库</button>
              </div>
            </header>
            {petTab === 'stage' ? <PetStagePanel events={events} running={running} /> : <PetsPanel />}
          </div>
        )}

        {tab === 'stardew' && (
          <div className="mx-auto max-w-[1320px] px-6 py-5">
            <div className="card mb-4 flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="pill pill-violet"><Brain size={11} />{brain.mode === 'llm' ? 'LlmPlanner' : 'RulePlanner'}</span>
              <span className="pill">白名单 75 工具</span>
              <span className="pill pill-amber">30 粒米 / 回执</span>
              <span className="pill pill-green">guide-forager {guides.length} 专题</span>
              <div className="flex-1" />
              <span className={`pill ${running ? 'pill-green' : ''}`} style={{ fontSize: 10 }}>{running ? '自动驾驶中' : '待命'}</span>
            </div>

            <div className="grid grid-cols-[1.2fr_0.95fr_0.85fr] gap-4">
              <section className="flex flex-col gap-3">
                <div className="card px-4 py-3.5">
                  <div className="mb-1.5 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
                    <span>当前动作</span>
                    <span className={`pill ${lastDecision?.planner === 'remote' ? 'pill-amber' : 'pill-blue'}`} style={{ fontSize: 9 }}>
                      {lastDecision?.planner === 'remote' ? 'P0 插队' : lastDecision?.planner ?? 'planner'}
                    </span>
                  </div>
                  <div className="mono text-base font-semibold" style={{ color: 'var(--blue)' }}>{lastDecision?.tool ?? 'idle'}</div>
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--text-2)' }}>{lastDecision?.intent ?? '等待自动驾驶启动…'}</p>
                  <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                    {[['时间', latestState?.clock ?? '—'], ['体力', latestState?.stamina != null ? `${latestState.stamina}/${latestState.staminaMax ?? '—'}` : '—'], ['金钱', latestState?.money != null ? `${latestState.money}g` : '—']].map(([k, v]) => (
                      <div key={k} className="inset px-2 py-1.5">
                        <div className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>{k}</div>
                        <div className="mono mt-0.5 text-[10.5px]" style={{ color: 'var(--text-1)' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card px-4 py-3.5">
                  <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>今日目标链</div>
                  {['读信 / 浇水 / 播种', '11:00 海滩钓鱼', '17:30 镇上采集', '18:30 前回家', '睡觉防晕倒'].map((g, i) => (
                    <div key={g} className="mono flex items-center gap-2 py-1 text-[10.5px]" style={{ color: i === 0 ? 'var(--blue)' : 'var(--text-2)' }}>
                      <span style={{ width: 5, height: 5, borderRadius: 99, background: i === 0 ? 'var(--blue)' : 'var(--text-3)' }} />
                      {g}
                    </div>
                  ))}
                </div>
              </section>

              <section className="card flex flex-col px-4 py-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: 'var(--text-2)' }}>回执时间线</span>
                  <div className="seg-tabs" style={{ transform: 'scale(0.88)', transformOrigin: 'right' }}>
                    {(['all', 'COMPLETED', 'FAILED'] as const).map((f) => (
                      <button key={f} className={`seg-tab${chatFilter === f ? ' on' : ''}`} onClick={() => setChatFilter(f)}>{f === 'all' ? '全部' : f}</button>
                    ))}
                  </div>
                </div>
                <div className="flex max-h-[56vh] flex-col gap-1.5 overflow-y-auto">
                  {receipts.filter((r) => chatFilter === 'all' || r.status === chatFilter).slice(-40).reverse().map((r, i) => {
                    const c = STATUS_COLOR[r.status ?? 'ERROR'] ?? STATUS_COLOR.ERROR!;
                    return (
                      <div key={i} data-receipt={r.status} className="border-l-2 py-1 pl-2.5 text-[11px]" style={{ borderColor: c.line }}>
                        <span className="mono font-semibold" style={{ color: c.text }}>{r.status}</span>
                        <span className="ml-1.5" style={{ color: 'var(--text-1)' }}>{r.tool}</span>
                        <div className="mt-0.5 line-clamp-2 text-[10px]" style={{ color: 'var(--text-3)' }}>{r.summary}</div>
                      </div>
                    );
                  })}
                  {receipts.length === 0 && <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>尚无回执——启动自动驾驶后这里出现真实执行记录。</span>}
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <div className="card px-4 py-3.5">
                  <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>实时指标</div>
                  {[['回执总数', receipts.length], ['决策次数', decisions.length], ['看门狗事件', watchdog.length], ['攻略专题', guides.length]].map(([k, v]) => (
                    <div key={String(k)} className="flex justify-between py-1 text-[10.5px]">
                      <span style={{ color: 'var(--text-3)' }}>{k}</span>
                      <span className="mono" style={{ color: 'var(--text-1)' }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
                <div className="card px-4 py-3.5">
                  <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>CheatBridge 与审计</div>
                  <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                    直写类工具默认关闭（运行期安全锁）。所有动作走 BWF MCP 回执，超时不重发、卡死由看门狗接管。
                  </p>
                  <span className="pill pill-amber mt-2" style={{ fontSize: 9 }}>审计 JSONL · 只读预览</span>
                </div>
                <div className="card px-4 py-3.5">
                  <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>快捷指令</div>
                  <div className="grid grid-cols-2 gap-1">
                    {([['钓鱼', '/fish 5'], ['去海滩', '/goto Beach'], ['睡觉', '/sleep'], ['停下', '/stop']] as const).map(([l, c]) => (
                      <button key={c} className="pill justify-center" style={{ fontSize: 10 }} onClick={() => sendText(c)}>{l}</button>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        {tab === 'mods' && <div className="h-full overflow-y-auto"><ModsPanel /></div>}
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
        <div className="mono mt-1 text-sm font-semibold" style={{ color: 'var(--text-1)' }}>{event.tool}</div>
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
    const c = STATUS_COLOR[event.status ?? 'ERROR'] ?? STATUS_COLOR.ERROR!;
    return (
      <div data-event="receipt" className="mb-3 rounded-2xl p-3" style={{ border: `1px solid ${c.line}`, background: c.bg }}>
        <div className="mono flex items-center gap-2 text-xs font-semibold" style={{ color: c.text }}>
          <span>{event.status}</span>
          <span style={{ color: 'var(--text-3)' }}>{event.tool}</span>
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
