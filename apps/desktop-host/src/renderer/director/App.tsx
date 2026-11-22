/**
 * 工作台 Shell（设计稿 v3「曜石」还原）：Apple 三原则 + 光影七层 + lucide 图标。
 * 左侧插件导航｜顶栏（面包屑/语音/大脑/自动驾驶）｜内容区六面板路由。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Activity, AudioLines, Brain, ChevronRight, Cpu, Fish, MessageSquare,
  Play, Radio, Send, Sliders, Sprout, Square, Terminal, Volume2, VolumeX, Wheat,
} from 'lucide-react';
import type { DiningProfilePreset, ModelProviderConfig, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import type { AutodriveEventView } from './bridge';
import { ProvidersPanel } from './providers-panel';
import { HarnessPanel } from './harness-panel';
import { PetsPanel } from './pets-panel';
import { VoicePanel } from './voice-panel';
import { VoiceStudioPanel } from './voice-studio-panel';

type Tab = 'chat' | 'stardew' | 'pets' | 'voice' | 'studio' | 'harness' | 'providers';

const NAV: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: '聊天 · 小鲸', icon: MessageSquare },
  { id: 'stardew', label: '星露谷共玩', icon: Sprout },
  { id: 'pets', label: '动作库', icon: Fish },
  { id: 'voice', label: '音色库', icon: AudioLines },
  { id: 'studio', label: '声音工坊', icon: Sliders },
  { id: 'harness', label: 'Harness · Agents', icon: Terminal },
  { id: 'providers', label: '供应商配置', icon: Cpu },
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

export function App({ profiles, slotLabels, providers, store, storeKey }: AppProps): React.JSX.Element {
  void storeKey;
  const [tab, setTab] = useState<Tab>('chat');
  const [events, setEvents] = useState<AutodriveEventView[]>([]);
  const [running, setRunning] = useState(false);
  const [brain, setBrain] = useState<{ mode: string; llmReady: boolean }>({ mode: 'rule', llmReady: false });
  const [voiceOn, setVoiceOn] = useState(true);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const flowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.directorBridge.onAutodriveEvent((event) => {
      setEvents((prev) => (prev.length >= 500 ? [...prev.slice(-499), event] : [...prev, event]));
    });
    void window.directorBridge.autodriveStatus().then((s) => setRunning(s.running));
    void window.directorBridge.plannerStatus().then((s) => setBrain(s));
    void window.directorBridge.voiceConfigGet().then((c) => setVoiceOn(c.enabled));
  }, []);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const start = async (): Promise<void> => {
    setDriveError(null);
    const res = await window.directorBridge.autodriveStart();
    if (res.ok) {
      setRunning(true);
      setEvents((prev) => [...prev, { type: 'receipt', status: 'COMPLETED', summary: '自动驾驶启动——小鲸接管星露谷', tool: 'autodrive' }]);
    } else {
      setDriveError(res.error ?? '启动失败');
    }
  };

  const stop = async (): Promise<void> => {
    await window.directorBridge.autodriveStop();
    setRunning(false);
    setEvents((prev) => [...prev, { type: 'receipt', status: 'COMPLETED', summary: '自动驾驶已停止', tool: 'autodrive' }]);
  };

  const switchBrain = async (): Promise<void> => {
    const next = brain.mode === 'llm' ? 'rule' : 'llm';
    const res = await window.directorBridge.plannerSwitch(next);
    if (res.ok) {
      setBrain((b) => ({ ...b, mode: res.mode ?? next }));
      if (next === 'llm') {
        void window.directorBridge.guidesLoad().then((g) => {
          if (g.ok) setEvents((prev) => [...prev, { type: 'receipt', status: 'COMPLETED', tool: 'brain', summary: `LLM 大脑接管（攻略注入：${(g.topics ?? []).length} 专题）` }]);
        });
      } else {
        setEvents((prev) => [...prev, { type: 'receipt', status: 'COMPLETED', tool: 'brain', summary: '切回规则日程大脑' }]);
      }
    } else {
      setDriveError(res.error ?? '切换失败');
    }
  };

  const toggleVoice = async (): Promise<void> => {
    const next = await window.directorBridge.voiceConfigSet({ enabled: !voiceOn });
    setVoiceOn(next.enabled);
  };

  const send = (): void => {
    const text = input.trim();
    if (text === '') return;
    const directive = parseDirective(text);
    if (directive) {
      void window.directorBridge.autodriveDirective(directive.tool, directive.args, directive.intent);
      setEvents((prev) => [...prev, { type: 'decision', tool: directive.tool, intent: directive.intent, planner: 'remote' }]);
    } else {
      // 用户气泡右对齐；回话由主进程广播 chat_reply 事件（不本地重复插卡）
      setEvents((prev) => [...prev, { type: 'user', summary: text }]);
      void window.directorBridge.chatSay(text).then((res) => {
        if (!res.ok) {
          setEvents((prev) => [...prev, { type: 'receipt', status: 'ERROR', tool: 'chat', summary: res.error ?? '主脑未回' }]);
        }
      });
    }
    setInput('');
  };

  const latestState = [...events].reverse().find((e) => e.type === 'state');
  const receipts = events.filter((e) => e.type === 'receipt');
  const currentTab = NAV.find((n) => n.id === tab);

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--text-1)' }}>
      <div className="ambient" />
      <header
        className="relative z-10 flex h-12 items-center gap-3 px-4"
        style={{ borderBottom: '1px solid var(--stroke)', background: 'color-mix(in srgb, var(--bg) 40%, transparent)', backdropFilter: 'blur(24px)' }}
      >
        <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-3)' }}>
          <span>工作台</span>
          <ChevronRight size={12} />
          <b className="font-semibold" style={{ color: 'var(--text-1)' }}>{currentTab?.label}</b>
        </div>
        <div className="flex-1" />
        <button
          data-voice-toggle
          onClick={() => void toggleVoice()}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
          style={{ border: `1px solid ${voiceOn ? 'var(--green-line)' : 'var(--stroke)'}`, background: voiceOn ? 'var(--green-dim)' : 'transparent', color: voiceOn ? 'var(--green)' : 'var(--text-3)' }}
        >
          {voiceOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
          {voiceOn ? '语音开' : '语音关'}
        </button>
        <button
          data-brain-toggle
          onClick={() => void switchBrain()}
          disabled={!brain.llmReady}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
          style={
            brain.mode === 'llm'
              ? { border: '1px solid var(--violet-line)', background: 'var(--violet-dim)', color: 'var(--violet)' }
              : { border: '1px solid var(--stroke)', background: 'var(--surface-2)', color: 'var(--text-2)' }
          }
        >
          <Brain size={13} />
          {brain.mode === 'llm' ? 'LLM 大脑' : '规则日程'}
        </button>
        <button
          data-autodrive-toggle
          onClick={() => void (running ? stop() : start())}
          className="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold"
          style={
            running
              ? { border: '1px solid var(--red-line)', background: 'var(--red-dim)', color: 'var(--red)' }
              : { border: '1px solid var(--green-line)', background: 'var(--green-dim)', color: 'var(--green)' }
          }
        >
          {running ? <Square size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
          {running ? '停止自动驾驶' : '启动自动驾驶'}
        </button>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1">
        <aside
          className="flex w-[232px] shrink-0 flex-col"
          style={{ borderRight: '1px solid var(--stroke)', background: 'color-mix(in srgb, var(--bg) 55%, transparent)', backdropFilter: 'blur(24px)' }}
        >
          <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" fill="var(--blue)" opacity=".28" />
              <path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" stroke="var(--blue)" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="17.5" cy="10.5" r="1" fill="var(--blue)" />
            </svg>
            <span className="text-sm font-semibold">大肥鱼工作台</span>
            <span className="mono ml-auto" style={{ color: 'var(--text-3)' }}>v0.3</span>
          </div>

          <div className="px-4 pb-1.5 text-[10.5px] font-semibold" style={{ color: 'var(--text-3)' }}>插件</div>
          <nav className="px-2.5">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  data-tab={item.id}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => setTab(item.id)}
                  className="mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-xs transition"
                  style={active ? { background: 'var(--blue-dim)', color: 'var(--blue)', fontWeight: 600 } : { color: 'var(--text-2)' }}
                >
                  <Icon size={14} strokeWidth={1.75} />
                  {item.label}
                  {item.id === 'stardew' && running && <span className="ml-auto"><span className="pulse-dot" /></span>}
                </button>
              );
            })}
          </nav>

          <div className="flex-1" />
          <div className="px-4 pb-4 pt-3 text-xs" style={{ borderTop: '1px solid var(--stroke)', color: 'var(--text-2)' }}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Wheat size={13} style={{ color: 'var(--amber)' }} />赛博饭碗</span>
              <b className="mono" style={{ color: 'var(--amber)' }}>12,480</b>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Activity size={13} />事件</span>
              <span className="mono" style={{ color: 'var(--text-3)' }}>{events.length}</span>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden">
          {tab === 'chat' && (
            <div className="flex h-full flex-col">
              <div ref={flowRef} className="flex-1 overflow-y-auto px-6 py-4">
                <div className="stagger mx-auto max-w-3xl">
                  {events.length === 0 && (
                    <div className="card mt-10 px-6 py-8 text-center">
                      <Radio size={22} className="floaty mx-auto mb-3" style={{ color: 'var(--blue)' }} />
                      <p className="text-sm font-semibold">小鲸待命中</p>
                      <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
                        点右上「启动自动驾驶」接管星露谷（需游戏 + BWF Mod MCP 就绪）<br />
                        指令插队：<span className="mono" style={{ color: 'var(--blue)' }}>/goto Beach · /fish 5 · /sleep · /stop</span>
                      </p>
                    </div>
                  )}
                  {events.map((e, i) => <EventCard key={i} event={e} />)}
                </div>
              </div>
              {driveError && <div className="px-6 pb-1 text-xs" style={{ color: 'var(--red)' }} data-drive-error>{driveError}</div>}
              <div className="px-6 pb-4">
                <div className="mx-auto flex max-w-3xl gap-2">
                  <input
                    data-chat-input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                    placeholder="和 小鲸 说话，或 /goto Beach、/fish 5、/sleep、/stop 指令插队……"
                    className="flex-1 px-4 py-2.5 text-sm outline-none transition"
                    style={{ borderRadius: 18, border: '1px solid var(--stroke-2)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <button data-chat-send onClick={send} className="flex items-center gap-1.5 rounded-full px-5 text-sm font-semibold" style={{ background: 'var(--blue)', color: '#fff' }}>
                    <Send size={12} />发送
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === 'stardew' && (
            <div className="h-full overflow-y-auto px-6 py-5">
              <div className="stagger mx-auto grid max-w-4xl grid-cols-2 gap-4">
                <section className="card p-4">
                  <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
                    <Sprout size={14} style={{ color: 'var(--green)' }} />当前状态 · get_state 摘要
                  </h3>
                  <KV k="游戏时间" v={latestState?.clock ?? '—'} />
                  <KV k="位置" v={latestState?.location ?? '—'} />
                  <KV k="金钱" v={latestState?.money != null ? `${latestState.money}g` : '—'} />
                  <KV k="体力" v={latestState?.stamina != null ? `${latestState.stamina}/${latestState.staminaMax}` : '—'} />
                  <div className="mb-2 mt-4 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>回执统计</div>
                  <KV k="COMPLETED" v={String(receipts.filter((r) => r.status === 'COMPLETED').length)} />
                  <KV k="FAILED / UNCERTAIN" v={String(receipts.filter((r) => r.status === 'FAILED' || r.status === 'UNCERTAIN').length)} />
                  <KV k="TIMEOUT / ERROR" v={String(receipts.filter((r) => r.status === 'TIMEOUT' || r.status === 'ERROR').length)} />
                </section>
                <section className="card max-h-[70vh] overflow-y-auto p-4">
                  <h3 className="mb-3 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>回执时间线</h3>
                  {receipts.slice(-30).reverse().map((r, i) => {
                    const c = STATUS_COLOR[r.status ?? 'ERROR'] ?? STATUS_COLOR.ERROR!;
                    return (
                      <div key={i} data-receipt={r.status} className="mb-1.5 border-l-2 py-1 pl-3 text-xs" style={{ borderColor: c.line }}>
                        <span className="mono font-semibold" style={{ color: c.text }}>{r.status}</span>
                        <span className="ml-2" style={{ color: 'var(--text-1)' }}>{r.tool}</span>
                        <div className="mt-0.5 line-clamp-2" style={{ color: 'var(--text-3)' }}>{r.summary}</div>
                      </div>
                    );
                  })}
                  {receipts.length === 0 && <div className="text-xs" style={{ color: 'var(--text-3)' }}>尚无回执——启动自动驾驶后这里会出现真实执行记录。</div>}
                </section>
              </div>
            </div>
          )}

          {tab === 'pets' && <div className="h-full overflow-y-auto"><PetsPanel /></div>}
          {tab === 'voice' && <div className="h-full overflow-y-auto"><VoicePanel /></div>}
          {tab === 'studio' && <div className="h-full overflow-y-auto"><VoiceStudioPanel /></div>}
          {tab === 'harness' && <div className="h-full overflow-y-auto"><HarnessPanel /></div>}
          {tab === 'providers' && (
            <div className="h-full overflow-y-auto">
              <ProvidersPanel profiles={profiles} slotLabels={slotLabels} providers={providers} store={store} />
            </div>
          )}
        </main>
      </div>
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
  // 内心戏云朵（设计稿 L2）：chat/think 类决策与 planner=local 的意图 → 紫云朵卡
  // 用户消息（本地合成事件）：右对齐蓝渐变气泡（设计稿 .bub.me）
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
  // 内心戏云朵（设计稿 L2）：think 决策意图 → 紫云朵 dashed 卡
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
