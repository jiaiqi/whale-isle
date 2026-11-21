/**
 * Shell 主壳（T-M6-01 最小版）：页签 = 插件面板路由。
 *   聊天（autodrive 事件流 + 指令插队）｜星露谷监控｜供应商配置
 * 事件源 = 主进程 autodrive-host 单源多播（onAutodriveEvent）。
 */
import { useEffect, useRef, useState } from 'react';
import type { DiningProfilePreset, ModelProviderConfig, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import type { AutodriveEventView } from './bridge';
import { ProvidersPanel } from './providers-panel';
import { HarnessPanel } from './harness-panel';
import { PetsPanel } from './pets-panel';

type Tab = 'chat' | 'stardew' | 'providers' | 'harness' | 'pets';

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: '聊天 · 小鲸' },
  { id: 'stardew', label: '星露谷监控' },
  { id: 'providers', label: '供应商配置' },
  { id: 'harness', label: 'Harness · Agents' },
  { id: 'pets', label: '动作库' },
];

/** 简单指令解析（Shell 聊天框 → P0 插队；T-M6-01 完整版接 persona-brain 闲聊路由） */
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
  const [driveError, setDriveError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const flowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.directorBridge.onAutodriveEvent((event) => {
      setEvents((prev) => (prev.length >= 500 ? [...prev.slice(-499), event] : [...prev, event]));
    });
    void window.directorBridge.autodriveStatus().then((s) => setRunning(s.running));
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

  const send = (): void => {
    const text = input.trim();
    if (text === '') return;
    const directive = parseDirective(text);
    if (directive) {
      void window.directorBridge.autodriveDirective(directive.tool, directive.args, directive.intent);
      setEvents((prev) => [...prev, { type: 'decision', tool: directive.tool, intent: directive.intent, planner: 'remote' }]);
    } else {
      // 普通聊天：T-M6-01 完整版路由 persona-brain；最小版先入本地回显
      setEvents((prev) => [...prev, { type: 'decision', tool: 'chat', intent: `主人说：${text}（LLM 路由接入后小鲸会回话）`, planner: 'local' }]);
    }
    setInput('');
  };

  const latestState = [...events].reverse().find((e) => e.type === 'state');
  const receipts = events.filter((e) => e.type === 'receipt');

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100 font-sans overflow-hidden">
      <header className="flex items-center gap-3 px-5 h-12 border-b border-slate-800 bg-slate-950/90">
        <span className="text-sm font-bold text-sky-300">🐋 大肥鱼工作台</span>
        <nav className="flex gap-1 ml-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              data-tab={t.id}
              data-active={tab === t.id ? 'true' : 'false'}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                tab === t.id ? 'bg-sky-500/15 text-sky-300 font-semibold' : 'text-slate-400 hover:bg-slate-800/60'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          data-autodrive-toggle
          onClick={() => void (running ? stop() : start())}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
            running ? 'border-rose-500/60 bg-rose-500/10 text-rose-300' : 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {running ? '■ 停止自动驾驶' : '▶ 启动自动驾驶'}
        </button>
      </header>

      {driveError && (
        <div className="px-5 py-2 text-xs text-rose-300 bg-rose-500/10 border-b border-rose-500/30" data-drive-error>
          {driveError}
        </div>
      )}

      {tab === 'chat' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div ref={flowRef} className="flex-1 overflow-y-auto px-6 py-4">
            <div className="max-w-3xl mx-auto">
              {events.length === 0 && (
                <div className="text-xs text-slate-500 mt-8 text-center leading-relaxed">
                  小鲸待命中。点右上「启动自动驾驶」接管星露谷（需游戏 + BWF Mod MCP 18080 已就绪）。<br />
                  可输入指令插队：<span className="font-mono text-slate-400">/goto Beach · /fish 5 · /sleep · /stop</span>
                </div>
              )}
              {events.map((e, i) => (
                <EventCard key={i} event={e} />
              ))}
            </div>
          </div>
          <div className="px-6 pb-4">
            <div className="max-w-3xl mx-auto flex gap-2">
              <input
                data-chat-input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                placeholder="和 小鲸 说话，或 /goto Beach、/fish 5、/sleep、/stop 指令插队……"
                className="flex-1 rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2.5 text-sm outline-none focus:border-sky-500/60"
              />
              <button data-chat-send onClick={send} className="rounded-xl bg-sky-600 hover:bg-sky-500 px-5 text-sm font-semibold">
                发送
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'stardew' && (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="max-w-4xl mx-auto grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h3 className="text-xs text-slate-400 font-semibold mb-3">当前状态（get_state 摘要）</h3>
              <KV k="游戏时间" v={latestState?.clock ?? '—'} />
              <KV k="位置" v={latestState?.location ?? '—'} />
              <KV k="金钱" v={latestState?.money != null ? `${latestState.money}g` : '—'} />
              <KV k="体力" v={latestState?.stamina != null ? `${latestState.stamina}/${latestState.staminaMax}` : '—'} />
              <div className="mt-4 text-xs text-slate-400 font-semibold mb-2">回执统计</div>
              <KV k="COMPLETED" v={String(receipts.filter((r) => r.status === 'COMPLETED').length)} />
              <KV k="FAILED / UNCERTAIN" v={String(receipts.filter((r) => r.status === 'FAILED' || r.status === 'UNCERTAIN').length)} />
              <KV k="TIMEOUT / ERROR" v={String(receipts.filter((r) => r.status === 'TIMEOUT' || r.status === 'ERROR').length)} />
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 overflow-y-auto max-h-[70vh]">
              <h3 className="text-xs text-slate-400 font-semibold mb-3">回执时间线</h3>
              {receipts.slice(-30).reverse().map((r, i) => (
                <div key={i} className="text-xs border-l-2 border-slate-700 pl-3 py-1.5 mb-1" data-receipt={r.status}>
                  <span className={`font-mono font-semibold ${
                    r.status === 'COMPLETED' ? 'text-emerald-400' : r.status === 'UNCERTAIN' ? 'text-violet-400' : r.status === 'TIMEOUT' || r.status === 'ERROR' ? 'text-rose-400' : 'text-amber-400'
                  }`}>{r.status}</span>
                  <span className="text-slate-300 ml-2">{r.tool}</span>
                  <div className="text-slate-500 mt-0.5 line-clamp-2">{r.summary}</div>
                </div>
              ))}
              {receipts.length === 0 && <div className="text-xs text-slate-600">尚无回执——启动自动驾驶后这里会出现真实执行记录。</div>}
            </div>
          </div>
        </div>
      )}

      {tab === 'providers' && (
        <div className="flex-1 overflow-y-auto">
          <ProvidersPanel profiles={profiles} slotLabels={slotLabels} providers={providers} store={store} />
        </div>
      )}

      {tab === 'harness' && (
        <div className="flex-1 overflow-y-auto">
          <HarnessPanel />
        </div>
      )}

      {tab === 'pets' && (
        <div className="flex-1 overflow-y-auto">
          <PetsPanel />
        </div>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="flex justify-between text-xs py-1">
      <span className="text-slate-500">{k}</span>
      <span className="font-mono text-slate-200">{v}</span>
    </div>
  );
}

function EventCard({ event }: { event: AutodriveEventView }): React.JSX.Element {
  if (event.type === 'decision') {
    return (
      <div data-event="decision" className="max-w-3xl mx-auto mb-3 rounded-xl border border-sky-500/25 bg-sky-500/5 p-3">
        <div className="text-[10px] text-sky-300 font-mono">{event.planner === 'remote' ? 'P0 插队' : `决策 · ${event.planner ?? 'planner'}`}</div>
        <div className="text-sm font-mono text-sky-200 mt-1">{event.tool}</div>
        <div className="text-xs text-slate-300 mt-1">{event.intent}</div>
      </div>
    );
  }
  if (event.type === 'receipt') {
    const color =
      event.status === 'COMPLETED' ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300'
      : event.status === 'UNCERTAIN' ? 'border-violet-500/25 bg-violet-500/5 text-violet-300'
      : event.status === 'TIMEOUT' ? 'border-amber-500/25 bg-amber-500/5 text-amber-300'
      : 'border-rose-500/25 bg-rose-500/5 text-rose-300';
    return (
      <div data-event="receipt" className={`max-w-3xl mx-auto mb-3 rounded-xl border p-3 ${color}`}>
        <div className="flex items-center gap-2 text-xs font-mono font-semibold">
          <span>{event.status}</span>
          <span className="text-slate-400">{event.tool}</span>
        </div>
        <div className="text-xs mt-1 line-clamp-3 opacity-80">{event.summary}</div>
      </div>
    );
  }
  if (event.type === 'state') {
    return (
      <div data-event="state" className="max-w-3xl mx-auto mb-2 text-[10px] text-slate-500 font-mono text-center">
        {event.clock} · {event.location} · {event.stamina}/{event.staminaMax} · {event.money}g
      </div>
    );
  }
  if (event.type === 'watchdog') {
    return (
      <div data-event="watchdog" className="max-w-3xl mx-auto mb-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-2.5">
        <div className="text-[10px] text-amber-300 font-mono">{event.kind === 'stuck' ? '卡死哨兵' : '心跳'}</div>
        <div className="text-xs text-amber-200/80 mt-0.5">{event.detail}</div>
      </div>
    );
  }
  return <div data-event="cycle-end" className="max-w-3xl mx-auto mb-1 text-[10px] text-slate-600 text-center font-mono">— 间步 {Math.round((event.delayMs ?? 0) / 1000)}s —</div>;
}
