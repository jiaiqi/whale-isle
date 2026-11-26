/**
 * Obsidian Tide 「聊天 · 小鲸」核心视图（从 App.tsx Strangler 拆出）
 * 保持原有 [data-chat-input] / [data-chat-send] / [data-event] / [data-decision-badge] 选择器，
 * 并接入四态 ReceiptChip 与未接线通道 StageBadge 诚实标注。
 */
import type { RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, Send, ShieldAlert, Target, Zap } from 'lucide-react';
import type { AutodriveEventView } from '../bridge';
import { GAME_STATUS_COLOR, decisionBadgeOf, statusLabel, toolLabel } from '../game-panel';
import { ReceiptChip, StageBadge } from '../v2/signature-widgets';
import { EmptyIllustration } from '../shell/empty-illustration';
import type { Tab } from '../shell/sidebar';

export const SLASH_COMMANDS = [
  { cmd: '/goto Beach', desc: '去某地（Beach / Town / Farm / Mine）' },
  { cmd: '/fish 5', desc: '钓鱼 5 次' },
  { cmd: '/forage', desc: '采集 / 翻垃圾桶' },
  { cmd: '/sleep', desc: '回家睡觉' },
  { cmd: '/state', desc: '播报当前状态' },
  { cmd: '/stop', desc: '停下当前动作' },
  { cmd: '/cancel', desc: '取消当前强制命令或目标' },
];

export function parseDirective(text: string): { tool: string; args: Record<string, unknown>; intent: string } | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const parts = t.slice(1).trim().split(/\s+/);
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
      return null;
  }
}

export function ChatAside(props: {
  running: boolean;
  latestState: AutodriveEventView | undefined;
  decisions: AutodriveEventView[];
  memoryStats: { nodes: number; edges: number; lastDay: string | null } | null;
  guidesCount: number;
  onSendCommand: (cmd: string) => void;
  onSelectTab: (tab: Tab) => void;
}): React.JSX.Element {
  const { running, latestState, decisions, memoryStats, guidesCount, onSendCommand, onSelectTab } = props;
  return (
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
            <button key={cmd} className="pill justify-center" style={{ fontSize: 10 }} onClick={() => onSendCommand(cmd)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="card px-3.5 py-3">
        <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>上下文</div>
        <button className="mb-1 flex w-full items-center justify-between text-[10.5px]" style={{ color: 'var(--text-2)' }} onClick={() => onSelectTab('memory')}>
          <span>记忆节点</span><span className="mono" style={{ color: 'var(--violet)' }}>{memoryStats?.nodes ?? 0}</span>
        </button>
        <button className="mb-1 flex w-full items-center justify-between text-[10.5px]" style={{ color: 'var(--text-2)' }} onClick={() => onSelectTab('stardew')}>
          <span>攻略专题</span><span className="mono" style={{ color: 'var(--green)' }}>{guidesCount}</span>
        </button>
        <button className="flex w-full items-center justify-between text-[10.5px]" style={{ color: 'var(--text-2)' }} onClick={() => onSelectTab('life')}>
          <span>V2 生命中枢</span><span className="mono" style={{ color: 'var(--blue)' }}>打开</span>
        </button>
      </div>
    </aside>
  );
}

export function ChatView(props: {
  events: AutodriveEventView[];
  objective: string | null;
  driveError: string | null;
  input: string;
  flowRef: RefObject<HTMLDivElement | null>;
  onInputChange: (next: string) => void;
  onSend: () => void;
  onSendText: (text: string) => void;
}): React.JSX.Element {
  const { events, objective, driveError, input, flowRef, onInputChange, onSend, onSendText } = props;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 px-5 py-2.5" style={{ borderBottom: '1px solid var(--stroke)' }}>
        <span className="pill pill-blue"><span className="pulse-dot" />星露谷共玩</span>
        <span className="pill" style={{ opacity: 0.78 }}>
          弹幕陪聊 <StageBadge stage="P3" label="未接实盘" />
        </span>
        <span className="pill" style={{ opacity: 0.78 }}>
          点歌台 <StageBadge stage="P3" label="未接线" />
        </span>
        <div className="flex-1" />
        <button className="pill pill-red" onClick={() => onSendText('大肥鱼')} title="0 token 雷区反射">
          <ShieldAlert size={11} /> 测试雷区
        </button>
      </div>
      <div ref={flowRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div className="stagger mx-auto max-w-3xl">
          {events.length === 0 && (
            <div className="card mt-10 px-6 py-8 text-center">
              <EmptyIllustration name="empty-chat" alt="小鲸在纸面码头待命" width={200} className="mb-3" />
              <p className="text-sm font-semibold">小鲸待命中</p>
              <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
                点右上「启动自动驾驶」接管星露谷（需游戏 + BWF Mod MCP 就绪）<br />
                直接说中文也行：<span className="mono" style={{ color: 'var(--blue)' }}>先去海滩钓鱼吧</span>
              </p>
            </div>
          )}
          {events.map((e, i) => <EventCard key={i} event={e} objectiveActive={objective !== null} />)}
        </div>
      </div>
      {driveError !== null && <div className="px-6 pb-1 text-xs" style={{ color: 'var(--red)' }} data-drive-error>{driveError}</div>}
      <div className="relative px-6 pb-4">
        {input.startsWith('/') && (
          <div className="absolute bottom-full left-6 right-6 mb-2 overflow-hidden rounded-xl" style={{ background: 'var(--bg-elev)', border: '1px solid var(--stroke-2)', boxShadow: 'var(--shadow-2)' }}>
            {SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(input.toLowerCase().split(' ')[0] ?? '')).map((c) => (
              <button key={c.cmd} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] hover:bg-[var(--surface-2)]" onClick={() => { onInputChange(c.cmd); }}>
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
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
            placeholder="和 小鲸 说话，或 /goto Beach、/fish 5、/sleep 指令插队……"
            className="flex-1 px-4 py-2.5 text-sm outline-none transition"
            style={{ borderRadius: 18, border: '1px solid var(--stroke-2)', background: 'var(--surface)', color: 'var(--text-1)' }}
          />
          <button data-chat-send onClick={onSend} className="btn-pill primary px-5">
            <Send size={12} />发送
          </button>
        </div>
      </div>
    </div>
  );
}

export function EventCard({ event, objectiveActive = false }: { event: AutodriveEventView; objectiveActive?: boolean }): React.JSX.Element {
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
  if (event.type === 'objective') {
    const meta: Record<'set' | 'replaced' | 'cancel' | 'done', { label: string; color: string; bg: string }> = {
      set: { label: '目标已开始', color: 'var(--violet)', bg: 'var(--violet-dim)' },
      replaced: { label: '目标被新指令替换', color: 'var(--amber)', bg: 'var(--amber-dim)' },
      cancel: { label: '目标已取消', color: 'var(--text-2)', bg: 'var(--surface-2)' },
      done: { label: '目标已完成', color: 'var(--green)', bg: 'var(--green-dim)' },
    };
    const reasonKey = event.reason === 'replaced' || event.reason === 'cancel' || event.reason === 'done' ? event.reason : 'set';
    const view = meta[reasonKey];
    return (
      <div data-event="objective" data-objective-reason={event.reason} className="mb-3 rounded-2xl px-3.5 py-2.5" style={{ border: `1px solid ${view.color}`, background: view.bg }}>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: view.color }}>
          <Target size={12} />{view.label}
        </div>
        {event.objective !== null && event.objective !== undefined && (
          <div className="mt-1 text-[11.5px]" style={{ color: 'var(--text-2)' }}>{event.objective}</div>
        )}
      </div>
    );
  }
  if (event.type === 'decision') {
    const badge = decisionBadgeOf(event, objectiveActive);
    return (
      <div data-event="decision" className="mb-3 rounded-2xl p-3" style={{ border: '1px solid var(--blue-line)', background: 'var(--blue-dim)' }}>
        <div className="mono flex flex-wrap items-center gap-1.5 text-[10px]" style={{ color: 'var(--blue)' }}>
          <span data-decision-badge={badge.kind} className="rounded px-1.5 py-px text-[9.5px] font-semibold" style={{ color: badge.color, background: badge.bg, border: `1px solid ${badge.color}` }}>{badge.label}</span>
          <span>{event.planner ?? 'planner'}</span>
        </div>
        <div className="mono mt-1 text-sm font-semibold" style={{ color: 'var(--text-1)' }}>{toolLabel(event.tool)}</div>
        <div className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>{event.intent}</div>
      </div>
    );
  }
  if (event.type === 'receipt' && (event.tool === 'chat_reply' || (typeof event.tool === 'string' && event.tool.startsWith('reflex_')))) {
    const isReflex = typeof event.tool === 'string' && event.tool.startsWith('reflex_');
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
    if (event.tool === 'chat_order') {
      const summaryText = event.summary ?? '';
      if (summaryText.startsWith('目标已完成')) {
        return (
          <div data-event="chat-order" data-order-done className="mb-3 rounded-2xl p-3" style={{ border: '1px solid var(--green-line)', background: 'var(--green-dim)' }}>
            <div className="mono flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--green)' }}><Target size={12} />目标已完成</div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>{summaryText.replace(/^目标已完成[:：]\s*/, '')}</div>
          </div>
        );
      }
      if (summaryText.startsWith('已取消多步目标') || summaryText.startsWith('收到新的单步指令')) {
        return (
          <div data-event="chat-order" className="mb-3 rounded-2xl p-3" style={{ border: '1px solid var(--stroke-2)', background: 'var(--surface-2)' }}>
            <div className="mono flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}><Target size={12} />目标已收尾</div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>{summaryText}</div>
          </div>
        );
      }
      const [tool, ...rest] = summaryText.split('｜');
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
        <div className="mono flex flex-wrap items-center gap-2 text-xs font-semibold" style={{ color: c.text }}>
          <ReceiptChip status={event.status} detail={event.summary} />
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
  if ((event as { type: string }).type === 'brain') {
    const b = event as unknown as { mode?: string; reason?: string };
    return (
      <div data-event="brain" className="mono mb-2 text-center text-[10px]" style={{ color: b.mode === 'rule-standin' ? 'var(--amber)' : 'var(--green)' }}>
        — {b.mode === 'rule-standin' ? '规则代驾中' : 'LLM 大脑已接管'}{b.reason ? `（${b.reason}）` : ''} —
      </div>
    );
  }
  if ((event as { type: string }).type === 'plan') {
    const p = event as unknown as { dayKey?: string; reason?: string; plan?: Array<{ goal: string }> };
    const goals = (p.plan ?? []).slice(0, 3).map((x) => x.goal).join('、');
    return (
      <div data-event="plan" className="mb-3 rounded-2xl p-3" style={{ border: '1px solid var(--violet-line)', background: 'var(--violet-dim)' }}>
        <div className="mono text-[10px] font-semibold" style={{ color: 'var(--violet)' }}>
          {p.reason === 'update' ? '计划修订' : '今日计划'} · {p.dayKey ?? ''}
        </div>
        <div className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>{goals || '已更新计划'}</div>
      </div>
    );
  }
  if ((event as { type: string }).type === 'insight') {
    const insEv = event as unknown as { action?: string; usedInsight?: string; insight?: { id?: string; claim?: string; verdict?: string } };
    const label = insEv.action === 'used' ? `遵循心得 ${insEv.usedInsight ?? ''}` : insEv.action === 'reflected' ? '夜间复盘更新心得' : '记录攻略心得';
    return (
      <div data-event="insight" className="mb-3 rounded-2xl p-2.5" style={{ border: '1px solid var(--green-line)', background: 'var(--green-dim)' }}>
        <div className="mono text-[10px] font-semibold" style={{ color: 'var(--green)' }}>
          {label} [{insEv.insight?.verdict ?? ''}]
        </div>
        <div className="mt-0.5 text-xs" style={{ color: 'var(--text-2)' }}>{insEv.insight?.claim ?? ''}</div>
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
