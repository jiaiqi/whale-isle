/**
 * 三游戏共玩页共享区块（T-M6-25）。
 *
 * 从星露谷（App.tsx 内联）与泰拉瑞亚（terraria-panel.tsx）抽出的同构区块：
 * 连接引导条 / 当前动作 / 目标链 / 回执时间线 / 实时指标 / 快捷指令 / 折叠式高级诊断。
 * 视觉与文案基线取自设计稿 design/stardew.html（conn-banner 三态 + details.diag 折叠）。
 *
 * 原则：区块只渲染真实数据——回执来自游戏侧真实回执，连接状态来自主进程只读探活，
 * 任何未连接/未就绪都如实展示引导，不显示虚假的「已连接」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, PlugZap, RefreshCw, Square } from 'lucide-react';
import { summarizeAutodriveQuality, formatRate } from '@workbench/game-bridge-mcp/metrics';
import type { AutodriveEventView, GameHealthView, GameId } from './bridge';

/** 回执状态色（语义色 token，深浅主题通用） */
export const GAME_STATUS_COLOR: Record<string, { bg: string; line: string; text: string }> = {
  COMPLETED: { bg: 'var(--green-dim)', line: 'var(--green)', text: 'var(--green)' },
  UNCERTAIN: { bg: 'var(--amber-dim)', line: 'var(--amber)', text: 'var(--amber)' },
  FAILED: { bg: 'var(--red-dim)', line: 'var(--red)', text: 'var(--red)' },
  ERROR: { bg: 'var(--red-dim)', line: 'var(--red)', text: 'var(--red)' },
  TIMEOUT: { bg: 'var(--violet-dim)', line: 'var(--violet)', text: 'var(--violet)' },
};

export const GAME_FULL_NAME: Record<GameId, string> = {
  stardew: '星露谷物语',
  terraria: '泰拉瑞亚',
  dst: '饥荒：联机版',
};

const GAME_STATUS_LABEL: Record<string, string> = {
  COMPLETED: '完成',
  UNCERTAIN: '不确定',
  FAILED: '失败',
  ERROR: '错误',
  TIMEOUT: '超时',
};

export type ReceiptFilter = 'all' | 'COMPLETED' | 'UNCERTAIN' | 'FAILED';

/** 只读探活轮询（主进程 game:health；不触发任何游戏动作）。面板不可见时可关停轮询。 */
export function useGameHealth(
  gameId: GameId,
  endpoint?: string,
  pollMs = 15_000,
  enabled = true,
): { report: GameHealthView | null; probing: boolean; reprobe: () => void } {
  const [report, setReport] = useState<GameHealthView | null>(null);
  const [probing, setProbing] = useState(false);

  const probe = useCallback(async (): Promise<void> => {
    setProbing(true);
    try {
      const res = await window.directorBridge.gameHealth(gameId, endpoint);
      setReport(res);
    } catch {
      setReport(null);
    } finally {
      setProbing(false);
    }
  }, [gameId, endpoint]);

  useEffect(() => {
    if (!enabled) return;
    void probe();
    const timer = setInterval(() => { void probe(); }, Math.max(3_000, pollMs));
    return () => clearInterval(timer);
  }, [probe, pollMs, enabled]);

  return { report, probing, reprobe: () => { void probe(); } };
}

/**
 * 连接状态与开箱引导条（设计稿 conn-banner）：
 *   online    —— 绿色：桥接在线且游戏侧就绪
 *   reachable —— 琥珀：能连上但游戏侧未就绪
 *   offline   —— 琥珀：连不上，给出人类可执行的启动指引
 */
export function GameConnectionBanner({
  gameId,
  report,
  probing,
  onReprobe,
}: {
  gameId: GameId;
  report: GameHealthView | null;
  probing: boolean;
  onReprobe: () => void;
}): React.JSX.Element {
  const name = GAME_FULL_NAME[gameId];
  const status = report?.status ?? 'unknown';
  const connected = status === 'online';

  return (
    <div
      data-game-conn-banner
      data-game-conn={status}
      className="mb-4 flex flex-wrap items-center gap-3 px-4 py-3"
      style={{
        borderRadius: 'var(--r-xl)',
        border: `1px solid ${connected ? 'var(--green-line)' : 'var(--amber-line)'}`,
        background: connected ? 'var(--green-dim)' : 'var(--amber-dim)',
      }}
    >
      <div className="min-w-0 flex-1">
        {connected ? (
          <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--green)' }}>
            <span className="pulse-dot" />《{name}》已连接
            <span className="truncate text-[11.5px] font-normal" style={{ color: 'var(--text-2)' }}>{report?.detail}</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--amber)' }}>
              <PlugZap size={14} />
              {status === 'reachable' ? `《${name}》已连上但游戏侧未就绪` : `等待连接到《${name}》`}
              {probing && <span className="text-[11px] font-normal" style={{ color: 'var(--text-2)' }}>探测中…</span>}
            </div>
            <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {report?.detail}
              {report?.error ? `（${report.error.slice(0, 120)}）` : ''}
            </div>
            <ol className="mt-1.5 flex list-decimal flex-col gap-0.5 pl-4 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {(report?.guidance ?? []).map((step) => <li key={step}>{step}</li>)}
            </ol>
          </>
        )}
      </div>
      <button
        data-game-reprobe
        className={`btn-pill ${connected ? 'ghost' : 'primary'} shrink-0`}
        onClick={onReprobe}
        disabled={probing}
      >
        <RefreshCw size={11} />{connected ? '刷新状态' : '重新探测连接'}
      </button>
    </div>
  );
}

/** 当前动作卡：工具名 + planner 来源 + 三格指标 */
export function GameCurrentActionCard({
  decision,
  metrics,
  idleHint = '等待自动驾驶启动（或点击右侧快捷指令）…',
}: {
  decision?: { tool?: string; intent?: string; planner?: string };
  metrics: Array<readonly [string, string]>;
  idleHint?: string;
}): React.JSX.Element {
  const isRemote = decision?.planner === 'remote';
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1.5 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
        <span>当前动作</span>
        <span className={`pill ${isRemote ? 'pill-amber' : 'pill-blue'}`} style={{ fontSize: 9 }}>
          {isRemote ? 'P0 插队' : decision?.planner ?? '待命'}
        </span>
      </div>
      <div className="mono text-base font-semibold" style={{ color: 'var(--blue)' }}>{decision?.tool ?? 'idle'}</div>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--text-2)' }}>{decision?.intent ?? idleHint}</p>
      <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
        {metrics.map(([k, v]) => (
          <div key={k} className="inset px-2 py-1.5">
            <div className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>{k}</div>
            <div className="mono mt-0.5 text-[10.5px]" style={{ color: 'var(--text-1)' }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 目标链（当前目标 + 进度序号高亮） */
export function GameGoalChain({ goals, activeIndex }: { goals: readonly string[]; activeIndex?: number }): React.JSX.Element {
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>当前目标链</div>
      {goals.map((goal, i) => {
        const active = activeIndex !== undefined && i === activeIndex;
        return (
          <div key={goal} className="mono flex items-center gap-2 py-1 text-[10.5px]" style={{ color: active ? 'var(--blue)' : 'var(--text-2)' }}>
            <span style={{ width: 5, height: 5, borderRadius: 99, background: active ? 'var(--blue)' : 'var(--text-3)' }} />
            {goal}
          </div>
        );
      })}
    </div>
  );
}

/** 回执时间线（真实回执 + 状态筛选；data-receipt 供 E2E 断言） */
export function GameReceiptTimeline({
  receipts,
  filter,
  onFilter,
  emptyHint = '游戏连接后，这里会按时间线记录每一步动作与结果。',
}: {
  receipts: AutodriveEventView[];
  filter: ReceiptFilter;
  onFilter: (next: ReceiptFilter) => void;
  emptyHint?: string;
}): React.JSX.Element {
  const filters: ReceiptFilter[] = ['all', 'COMPLETED', 'UNCERTAIN', 'FAILED'];
  return (
    <section className="card flex flex-col px-4 py-3.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="whitespace-nowrap text-[11px]" style={{ color: 'var(--text-2)' }}>执行记录与回执</span>
        <div className="flex flex-wrap justify-end gap-1">
          {filters.map((f) => (
            <button
              key={f}
              data-receipt-filter={f}
              className="rounded-full px-2 py-0.5 text-[10px]"
              style={{
                border: `1px solid ${filter === f ? 'var(--blue-line)' : 'var(--stroke)'}`,
                background: filter === f ? 'var(--blue-dim)' : 'var(--surface-2)',
                color: filter === f ? 'var(--blue)' : 'var(--text-2)',
              }}
              onClick={() => onFilter(f)}
            >
              {f === 'all' ? '全部' : GAME_STATUS_LABEL[f] ?? f}
            </button>
          ))}
        </div>
      </div>
      <div className="flex max-h-[56vh] flex-col gap-1.5 overflow-y-auto">
        {receipts.filter((r) => filter === 'all' || r.status === filter).slice(-40).reverse().map((r, i) => {
          const c = GAME_STATUS_COLOR[r.status ?? 'ERROR'] ?? GAME_STATUS_COLOR.ERROR!;
          return (
            <div key={i} data-receipt={r.status} className="border-l-2 py-1 pl-2.5 text-[11px]" style={{ borderColor: c.line }}>
              <span className="mono font-semibold" style={{ color: c.text }}>{r.status}</span>
              <span className="ml-1.5" style={{ color: 'var(--text-1)' }}>{r.tool}</span>
              <div className="mt-0.5 line-clamp-2 text-[10px]" style={{ color: 'var(--text-3)' }}>{r.summary}</div>
            </div>
          );
        })}
        {receipts.length === 0 && <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>{emptyHint}</span>}
      </div>
    </section>
  );
}

/** 实时指标（真实计数，不造假） */
export function GameMetricsCard({ rows, title = '实时指标' }: { rows: Array<readonly [string, string | number]>; title?: string }): React.JSX.Element {
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>{title}</div>
      {rows.map(([k, v]) => (
        <div key={String(k)} className="flex justify-between py-1 text-[10.5px]">
          <span style={{ color: 'var(--text-3)' }}>{k}</span>
          <span className="mono" style={{ color: 'var(--text-1)' }}>{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 自治质量（T-M6-35）：本会话真实回执派生，不估算。
 * 空集会显示「—」，避免把「还没有数据」显示成 0% 或 100%。
 */
export function GameQualityCard({ events }: { events: AutodriveEventView[] }): React.JSX.Element {
  const q = summarizeAutodriveQuality(events);
  return (
    <GameMetricsCard
      title="自治质量（本会话）"
      rows={[
        ['有效回执率', formatRate(q.successRate)],
        ['失败 / 错误率', formatRate(q.failureRate)],
        ['重复动作率', formatRate(q.repeatRate)],
        ['动作覆盖面', `${q.distinctTools} 种（最长连击 ${q.longestToolStreak}）`],
      ]}
    />
  );
}

/** 主人快捷插队（P0 指令）：key 的语义由各游戏面板决定（泰拉瑞亚/DST 是工具名，星露谷是聊天指令） */
export function GameQuickCommands({
  commands,
  onCommand,
  stopKey = 'cancel_action',
  stopLabel = '停下当前动作',
}: {
  commands: ReadonlyArray<readonly [string, string, Record<string, unknown>?]>;
  onCommand: (key: string, args: Record<string, unknown>) => void;
  stopKey?: string;
  stopLabel?: string;
}): React.JSX.Element {
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>快捷指令（P0 插队）</div>
      <div className="grid grid-cols-2 gap-1">
        {commands.map(([label, key, args]) => (
          <button
            key={key + label}
            data-game-quick={key}
            className="pill justify-center"
            style={{ fontSize: 10 }}
            onClick={() => onCommand(key, args ?? {})}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        data-game-quick={stopKey}
        className="pill mt-2 w-full justify-center"
        style={{ fontSize: 10 }}
        onClick={() => onCommand(stopKey, {})}
      >
        <Square size={11} /> {stopLabel}
      </button>
    </div>
  );
}

/** 折叠式高级诊断（默认收起；技术细节与许可证结论藏在这里，主界面保持清爽） */
export function GameDiagnostics({
  title = '高级诊断',
  rows,
  notes,
}: {
  title?: string;
  rows: Array<readonly [string, string]>;
  notes?: readonly string[];
}): React.JSX.Element {
  return (
    <details data-game-diagnostics className="card px-0 py-0" style={{ overflow: 'hidden' }}>
      <summary
        className="flex cursor-pointer items-center justify-between px-4 py-3 text-[11.5px] font-semibold"
        style={{ color: 'var(--text-2)', listStyle: 'none' }}
      >
        <span>{title}</span>
        <ChevronDown size={12} />
      </summary>
      <div className="px-4 pb-3.5 pt-2 text-[10.5px] leading-relaxed" style={{ borderTop: '1px dashed var(--stroke)', color: 'var(--text-2)' }}>
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 py-1">
            <span style={{ color: 'var(--text-3)' }}>{k}</span>
            <span className="mono text-right" style={{ color: 'var(--text-1)' }}>{v}</span>
          </div>
        ))}
        {notes?.map((note) => (
          <p key={note} className="mt-2" style={{ color: 'var(--text-3)' }}>{note}</p>
        ))}
      </div>
    </details>
  );
}

/** 从 autodrive 事件流派生三面板共用的视图数据 */
export function useGameEventView(events: AutodriveEventView[]): {
  latestState?: AutodriveEventView;
  lastDecision?: AutodriveEventView;
  receipts: AutodriveEventView[];
  decisions: AutodriveEventView[];
  watchdogs: AutodriveEventView[];
} {
  return useMemo(() => ({
    latestState: [...events].reverse().find((e) => e.type === 'state'),
    lastDecision: [...events].reverse().find((e) => e.type === 'decision'),
    receipts: events.filter((e) => e.type === 'receipt'),
    decisions: events.filter((e) => e.type === 'decision'),
    watchdogs: events.filter((e) => e.type === 'watchdog'),
  }), [events]);
}
