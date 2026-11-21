/**
 * Harness 面板（T-M6-02 Shell 第 4 页签）：ACP providers 卡 + 对话流 + 审批卡。
 * 事件源 = 主进程 agent-harness 单源多播（onHarnessEvent）。
 */
import { useEffect, useRef, useState } from 'react';

interface HarnessEventView {
  presetId: string;
  type: 'initialized' | 'session-started' | 'update' | 'permission' | 'auth-required' | 'error' | 'exit';
  sessionId?: string;
  block?: { type: string; text?: string };
  requestId?: number;
  toolName?: string;
  input?: Record<string, unknown>;
  message?: string;
  code?: number;
}

interface PresetInfo {
  id: string;
  label: string;
  command: string | null;
  authHint: string;
}

export function HarnessPanel(): React.JSX.Element {
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<HarnessEventView[]>([]);
  const [promptDraft, setPromptDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void window.directorBridge.harnessPresets().then((p) => setPresets(p));
    void window.directorBridge.harnessStatus().then((list) => {
      setRunning(new Set(list.filter((i) => i.running).map((i) => i.presetId)));
    });
    window.directorBridge.onHarnessEvent((event) => {
      setEvents((prev) => (prev.length >= 400 ? [...prev.slice(-399), event as HarnessEventView] : [...prev, event as HarnessEventView]));
    });
  }, []);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const start = async (id: string): Promise<void> => {
    setNotice(null);
    const res = await window.directorBridge.harnessStart(id);
    if (res.ok) {
      setRunning((prev) => new Set([...prev, id]));
      setNotice(`✓ ${id} 握手成功${res.authMethods?.length ? `（可选登录：${res.authMethods.slice(0, 2).join(' / ')}）` : ''}`);
    } else {
      setNotice(`⚠ ${id}：${res.error ?? '启动失败'}`);
    }
  };

  const stop = async (id: string): Promise<void> => {
    await window.directorBridge.harnessStop(id);
    setRunning((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const send = (id: string): void => {
    const text = (promptDraft[id] ?? '').trim();
    if (!text) return;
    setPromptDraft((d) => ({ ...d, [id]: '' }));
    void window.directorBridge.harnessPrompt(id, text).then((res) => {
      if (!res.ok) setNotice(`⚠ ${id}：${res.error}`);
    });
  };

  const resolvePermission = (e: HarnessEventView, outcome: 'allow' | 'always' | 'reject'): void => {
    void window.directorBridge.harnessPermission(e.presetId, e.requestId ?? -1, outcome);
    setEvents((prev) => [...prev, { ...e, type: 'update', block: { type: 'text', text: `——审批 ${outcome === 'reject' ? '已拒绝' : outcome === 'always' ? '已放行（本类）' : '已允许'}——` } }]);
  };

  const lastPermission = [...events].reverse().find((e) => e.type === 'permission');

  return (
    <div className="p-5 pb-10">
      <h2 className="text-sm font-semibold text-slate-300 mb-3">Agents（ACP v1）</h2>
      {notice && <div className="mb-3 text-xs text-sky-300 bg-sky-500/10 rounded-lg px-3 py-2">{notice}</div>}

      <div className="grid grid-cols-3 gap-3">
        {presets.map((p) => {
          const isRunning = running.has(p.id);
          return (
            <div key={p.id} data-provider={p.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{p.label}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${isRunning ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-500'}`}>
                  {isRunning ? '运行中' : '空闲'}
                </span>
              </div>
              <div className="text-[10px] text-slate-500 mt-1 font-mono">{p.command ?? '需安装'}</div>
              <div className="text-[10px] text-slate-600 mt-1">{p.authHint}</div>
              <div className="flex gap-2 mt-2">
                {isRunning ? (
                  <button onClick={() => void stop(p.id)} className="flex-1 rounded border border-rose-500/40 text-rose-300 text-xs py-1">
                    停止
                  </button>
                ) : (
                  <button onClick={() => void start(p.id)} className="flex-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-1 font-semibold">
                    启动握手
                  </button>
                )}
              </div>
              {isRunning && (
                <div className="flex gap-2 mt-2">
                  <input
                    value={promptDraft[p.id] ?? ''}
                    onChange={(e) => setPromptDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') send(p.id); }}
                    placeholder={`对 ${p.label} 说…`}
                    className="flex-1 min-w-0 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                  />
                  <button onClick={() => send(p.id)} className="rounded bg-sky-600 text-white text-xs px-3">发送</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {lastPermission && (
        <div data-harness-approval className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4">
          <div className="text-sm font-semibold text-amber-300">⚠ {lastPermission.presetId} 请求执行工具：{lastPermission.toolName}</div>
          <div className="text-[11px] font-mono text-slate-300 mt-1">{JSON.stringify(lastPermission.input ?? {}).slice(0, 200)}</div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => resolvePermission(lastPermission, 'allow')} className="rounded-full bg-emerald-600/80 text-white text-xs px-4 py-1.5">允许 (Y)</button>
            <button onClick={() => resolvePermission(lastPermission, 'always')} className="rounded-full bg-sky-600/80 text-white text-xs px-4 py-1.5">本类全过 (A)</button>
            <button onClick={() => resolvePermission(lastPermission, 'reject')} className="rounded-full bg-rose-600/80 text-white text-xs px-4 py-1.5">拒绝 (N)</button>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
        <h3 className="text-xs text-slate-400 font-semibold mb-2">事件流</h3>
        <div ref={flowRef} className="max-h-72 overflow-y-auto">
          {events.length === 0 && <div className="text-xs text-slate-600">启动 agent 并发送提示后，这里实时显示流式输出 / 审批请求。</div>}
          {events.map((e, i) => (
            <div key={i} data-harness-event={e.type} className="text-xs border-l-2 border-slate-700 pl-3 py-1 mb-1">
              <span className={`font-mono text-[10px] ${
                e.type === 'permission' ? 'text-amber-300' : e.type === 'auth-required' ? 'text-rose-300' : e.type === 'error' ? 'text-rose-300' : e.type === 'initialized' ? 'text-emerald-300' : 'text-slate-500'
              }`}>[{e.presetId}·{e.type}]</span>
              <span className="ml-2 text-slate-300">{e.block?.text ?? e.message ?? e.toolName ?? e.sessionId ?? ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
