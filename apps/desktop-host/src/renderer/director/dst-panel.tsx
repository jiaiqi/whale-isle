/**
 * 饥荒联机版（DST）共玩面板（T-M7-D5，与星露谷统一于 T-M6-25）。
 * 区块与星露谷共用 game-panel.tsx（当前动作 / 回执时间线 / 指标 / 快捷指令 / 折叠诊断 / 连接引导）。
 * 真机前置提示：cluster_token.txt（Klei 账号）与 pair_token 必须由人类配置，UI 只展示状态不伪造证据。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flame, Play, ShieldAlert, Square, Utensils } from 'lucide-react';
import type { DstStateSnapshot } from '@workbench/shared-protocol';
import {
  GameConnectionBanner,
  GameDiagnostics,
  GameQuickCommands,
  GameReceiptTimeline,
  useGameHealth,
  type ReceiptFilter,
} from './game-panel';

export interface DstPanelEvent {
  type: 'state' | 'decision' | 'receipt' | 'watchdog';
  clock?: string;
  tool?: string;
  status?: string;
  summary?: string;
  detail?: string;
  at?: number;
}

export interface DstPanelBridge {
  /** GET /state（主进程注入；过 DstStateSnapshotSchema 契约校验） */
  dstState?(): Promise<{ ok: boolean; snapshot?: DstStateSnapshot; error?: string }>;
  dstStart?(): Promise<{ ok: boolean; error?: string }>;
  dstStop?(): Promise<{ ok: boolean }>;
  dstDirective?(tool: string, args: Record<string, unknown>, intent: string): Promise<{ ok: boolean; error?: string }>;
  onDstEvent?(handler: (event: DstPanelEvent) => void): void;
}

export interface DstPanelProps {
  bridge: DstPanelBridge;
  endpoint?: string;
  clusterDir?: string;
  pairTokenConfigured?: boolean;
  pollMs?: number;
}

const QUICK_COMMANDS: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['进食', 'eat', {}],
  ['添柴', 'add_fuel', {}],
  ['采集浆果', 'gather', { item: 'berries' }],
];

/** 快捷指令 → 意图文案（回执里给主人看的一句话） */
const DST_INTENT: Record<string, string> = {
  eat: '进食回血',
  add_fuel: '火堆添柴',
  gather: '采集浆果',
  cancel_action: '停止当前动作',
};

function ratio(current: number | undefined, max: number | undefined): number {
  if (current === undefined || max === undefined || max <= 0) return 0;
  return Math.max(0, Math.min(1, current / max));
}

function Meter({ label, current, max, color }: { label: string; current?: number; max?: number; color: string }): React.JSX.Element {
  const percent = Math.round(ratio(current, max) * 100);
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between text-[10.5px]" style={{ color: 'var(--text-2)' }}>
        <span>{label}</span>
        <span className="mono">{Math.round(current ?? 0)}/{Math.round(max ?? 0)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, background: color }} />
      </div>
    </div>
  );
}

const PHASE_TEXT: Record<string, string> = { day: '白天', dusk: '黄昏', night: '夜晚' };
const SEASON_TEXT: Record<string, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

export function DstPanel({
  bridge,
  endpoint = 'http://127.0.0.1:18100',
  clusterDir = '',
  pairTokenConfigured = false,
  pollMs = 2000,
}: DstPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DstStateSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [events, setEvents] = useState<DstPanelEvent[]>([]);
  const [filter, setFilter] = useState<ReceiptFilter>('all');
  const flowRef = useRef<HTMLDivElement | null>(null);
  const { report, probing, reprobe } = useGameHealth('dst');

  const load = useCallback(async () => {
    if (!bridge.dstState) {
      setNotice('状态接口未接线：主进程未注入 game:dst-state');
      return;
    }
    const res = await bridge.dstState();
    if (res.ok && res.snapshot) {
      setSnapshot(res.snapshot);
      setNotice(null);
    } else if (res.error) {
      setNotice(`状态未上报：${res.error}`);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, Math.max(500, pollMs));
    bridge.onDstEvent?.((event) => {
      setEvents((prev) => (prev.length >= 200 ? [...prev.slice(-199), event] : [...prev, event]));
    });
    return () => clearInterval(timer);
  }, [load, pollMs, bridge]);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const act = async (label: string, task: () => Promise<{ ok: boolean; error?: string }>) => {
    setNotice(null);
    const res = await task();
    setNotice(res.ok ? `${label} 已下发` : `${label} 失败：${res.error ?? '未知错误'}`);
  };

  const toggleAutodrive = async () => {
    if (running) {
      const res = await (bridge.dstStop?.() ?? Promise.resolve({ ok: false }));
      if (res.ok) setRunning(false);
      setNotice(res.ok ? 'DST 自动驾驶已停止' : '停止失败');
    } else {
      const res = await (bridge.dstStart?.() ?? Promise.resolve({ ok: false, error: '未接线' }));
      if (res.ok) setRunning(true);
      setNotice(res.ok ? 'DST 自动驾驶已启动' : `启动失败：${res.error ?? '未知错误'}`);
    }
  };

  const directive = (tool: string, args: Record<string, unknown>, intent: string) =>
    act(intent, async () => bridge.dstDirective?.(tool, args, intent) ?? { ok: false, error: '未接线' });

  const player = snapshot?.player;
  const campfire = snapshot?.nearby.campfires[0];
  const threats = snapshot?.threats ?? [];
  const takeover = snapshot?.control.authority === 'HUMAN_TAKEOVER_ACTIVE' || snapshot?.control.isPlayerMovingPhysically === true;
  const receipts = events
    .filter((event) => event.type === 'receipt')
    .map((event) => ({
      type: 'receipt' as const,
      tool: event.tool,
      status: event.status as 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR' | undefined,
      summary: event.summary ?? event.detail,
    }));

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-5">
      <GameConnectionBanner gameId="dst" report={report} probing={probing} onReprobe={reprobe} />

      <header className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">饥荒联机版 DST 共玩</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            服务器侧权威模组（all-clients）+ 本地桥 {endpoint} ｜ 653007 localhost QueryServer 通道
          </p>
        </div>
        <span className={`pill ${running ? 'pill-green' : ''}`} style={{ fontSize: 10 }}>
          {running ? '自动驾驶中' : '待命'}
        </span>
      </header>

      {notice !== null && (
        <div className="card mb-3 px-3.5 py-2 text-xs" style={{ color: takeover ? 'var(--amber)' : 'var(--text-2)' }}>{notice}</div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-3">
        <div className="card px-3.5 py-3">
          <div className="mb-2 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
            <span>生存状态</span>
            <span className="mono">
              {snapshot ? `第${snapshot.clock.cycle}轮 ${PHASE_TEXT[snapshot.clock.phase] ?? snapshot.clock.phase} ${SEASON_TEXT[snapshot.clock.season] ?? snapshot.clock.season}` : '未上报'}
            </span>
          </div>
          <Meter label="生命" current={player?.health.current} max={player?.health.max} color="var(--red)" />
          <Meter label="饥饿" current={player?.hunger.current} max={player?.hunger.max} color="var(--amber)" />
          <Meter label="理智" current={player?.sanity.current} max={player?.sanity.max} color="var(--violet)" />
          <div className="mt-2 flex flex-wrap gap-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
            <span className="pill">温度 {player?.temperature?.toFixed(1) ?? '--'}</span>
            <span className="pill">坐标 {player ? `${player.position.x.toFixed(1)}, ${player.position.z.toFixed(1)}` : '--'}</span>
            <span className="pill">{snapshot?.clock.isRaining === true ? '下雨' : '晴'}</span>
          </div>
        </div>

        <div className="card px-3.5 py-3">
          <div className="mb-2 text-[11px]" style={{ color: 'var(--text-2)' }}>环境威胁与火堆</div>
          <div className="mb-2 flex flex-wrap gap-1">
            {threats.length === 0 && <span className="pill">暂无威胁</span>}
            {threats.map((t) => (
              <span key={t.kind} className="pill pill-red"><ShieldAlert size={11} />{t.kind}×{t.count} {t.directionText}</span>
            ))}
          </div>
          <div className="mb-2 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-2)' }}>
            <Flame size={12} style={{ color: 'var(--amber)' }} />
            附近火堆燃料 {campfire ? `${Math.round(campfire.fuelPercent * 100)}%` : '无'}
          </div>
          <div className="mb-2 text-[10.5px]" style={{ color: 'var(--text-2)' }}>
            背包 {player?.inventory.map((it) => `${it.itemName}×${it.count}`).join('、') || '空'}
          </div>
          <div className="text-[10.5px]" style={{ color: takeover ? 'var(--amber)' : 'var(--text-3)' }}>
            控制权 {takeover ? '人类接管（AI 挂起）' : 'AI 自动驾驶'}
          </div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-[1fr_1.1fr] gap-3">
        <div className="card px-3.5 py-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px]" style={{ color: 'var(--text-2)' }}>自动驾驶</div>
            <button className="btn-pill primary px-4" onClick={() => void toggleAutodrive()}>
              {running ? <Square size={11} /> : <Play size={11} />}{running ? '停止' : '启动'}
            </button>
          </div>
          <GameQuickCommands
            commands={QUICK_COMMANDS}
            onCommand={(tool, args) => directive(tool, args, DST_INTENT[tool] ?? `主人快捷指令：${tool}`)}
          />
        </div>

        <GameReceiptTimeline
          receipts={receipts}
          filter={filter}
          onFilter={setFilter}
          emptyHint="连接并启动后，这里会按时间线记录每一步动作与结果。"
        />
      </div>

      <GameDiagnostics
        title="高级诊断与真机前置"
        rows={[
          ['桥接方式', 'Lua 权威模组 + 本地桥 (:18100)'],
          ['同步节拍', '2s 状态 tick + 0.25s 动作层'],
          ['可用动作', '30 个白名单动作'],
          ['接管机制', '客户端操作自动暂停托管'],
          ['集群目录', clusterDir || '未配置'],
          ['配对 token', pairTokenConfigured ? '已配置' : '未配置（模组侧留空时自主待机）'],
        ]}
        notes={[
          'DST 专用服需 Klei 账号生成的 cluster_token.txt；本面板不提供绕过路径。',
          '合规结论与降级策略见 docs/REFERENCE-dst-ai-companion.md。',
        ]}
      />

      <div className="card mt-3 px-3.5 py-3">
        <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>事件流</div>
        <div ref={flowRef} className="max-h-56 overflow-y-auto">
          {events.length === 0 && <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>暂无事件（等待模组上报 /v1/tick）</div>}
          {events.map((event, i) => (
            <div key={i} className="mb-1 flex gap-2 text-[10.5px]">
              <span className="mono" style={{ color: 'var(--text-3)' }}>{event.type}</span>
              <span style={{ color: event.status === 'FAILED' ? 'var(--red)' : 'var(--text-2)' }}>
                {event.tool ?? event.clock ?? event.detail ?? ''} {event.summary ?? ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
        <Utensils size={11} /> 快捷指令由主人直接插队（P0），执行结果以模组真实回执为准。
      </div>
    </div>
  );
}
