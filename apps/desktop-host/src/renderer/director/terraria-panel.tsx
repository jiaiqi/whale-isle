/**
 * 泰拉瑞亚共玩面板（T-M7-T4，与星露谷统一于 T-M6-25）。
 * 只负责渲染与发 P0 插队指令；数据全部来自真实 autodrive 事件流，不造假的「实时指标」。
 * 区块与星露谷共用 game-panel.tsx（当前动作 / 回执时间线 / 指标 / 快捷指令 / 折叠诊断 / 连接引导）。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { AutodriveEventView } from './bridge';
import {
  GameConnectionBanner,
  GameCurrentActionCard,
  GameDiagnostics,
  GameGoalChain,
  GameMetricsCard,
  GameQualityCard,
  GameQuickCommands,
  GameReceiptTimeline,
  useGameEventView,
  useGameHealth,
  type ReceiptFilter,
} from './game-panel';

export interface TerrariaPanelProps {
  events: AutodriveEventView[];
  running: boolean;
}

const QUICK_COMMANDS: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['挖矿', 'mine', {}],
  ['跳跃', 'jump', {}],
  ['喝药', 'drink_potion', {}],
  ['撤退', 'flee', {}],
  ['插火把', 'torch', {}],
  ['守夜 10s', 'wait', { seconds: 10 }],
];

const GOALS = ['砍树攒木头', '搭掩体', '插火把', '天黑守夜', '低血喝药 / 岩浆跳出'] as const;

export function TerrariaPanel({ events, running }: TerrariaPanelProps): React.JSX.Element {
  const [filter, setFilter] = useState<ReceiptFilter>('all');
  const { latestState, lastDecision, receipts, decisions, watchdogs } = useGameEventView(events);
  const { report, probing, reprobe } = useGameHealth('terraria');

  const send = (tool: string, args: Record<string, unknown>, intent: string): void => {
    void window.directorBridge.autodriveDirective(tool, args, intent).then((res) => {
      toast(res.ok ? `已插队：${tool}` : `插队失败：${tool}`, { description: '泰拉瑞亚桥 P0 指令' });
    });
  };

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-5">
      <GameConnectionBanner gameId="terraria" report={report} probing={probing} onReprobe={reprobe} />

      <div className="mb-4 flex flex-wrap items-center gap-2 px-4 py-2.5" style={{ borderRadius: 'var(--r-xl)', border: '1px solid var(--stroke)', background: 'var(--surface)' }}>
        <span className="pill pill-blue">泰拉瑞亚 · 18090</span>
        <span className="pill">32 个可用动作</span>
        <span className="pill">离线也能行动（本地规则兜底）</span>
        <div className="flex-1" />
        <span className={`pill ${running ? 'pill-green' : ''}`} style={{ fontSize: 10 }}>
          {running ? '自动驾驶中' : '待命'}
        </span>
      </div>

      <div className="grid grid-cols-[1.18fr_0.98fr_0.84fr] gap-4">
        <section className="flex flex-col gap-3">
          <GameCurrentActionCard
            decision={lastDecision}
            metrics={[
              ['游戏时钟', latestState?.clock ?? '—'],
              ['生命 / 魔力', latestState?.stamina != null ? `${latestState.stamina}/${latestState.staminaMax ?? '—'}` : '—'],
              ['生物群系', latestState?.location ?? '—'],
            ]}
          />
          <GameGoalChain goals={GOALS} activeIndex={Math.min(decisions.length, GOALS.length - 1)} />
        </section>

        <GameReceiptTimeline
          receipts={receipts}
          filter={filter}
          onFilter={setFilter}
          emptyHint="游戏连接并启动自动驾驶后，这里会按时间线记录每一步动作与结果。"
        />

        <section className="flex flex-col gap-3">
          <GameMetricsCard
            rows={[
              ['回执总数', receipts.length],
              ['决策次数', decisions.length],
              ['看门狗事件', watchdogs.length],
              ['错误回执', receipts.filter((r) => r.status === 'ERROR' || r.status === 'FAILED').length],
            ]}
          />
          <GameQualityCard events={events} />
          <GameQuickCommands
            commands={QUICK_COMMANDS}
            onCommand={(tool, args) => send(tool, args, `主人快捷指令：${tool}`)}
          />
          <GameDiagnostics
            title="高级诊断"
            rows={[
              ['桥接方式', 'tModLoader 模组 (:18090)'],
              ['可用动作', '32 个白名单动作'],
              ['玩家接管', '按 F8 键 100ms 内释放控制权'],
              ['生存反射', '模组侧帧级岩浆 / 低血保护'],
            ]}
            notes={[
              '所有动作走模组真实回执；超时不重发（get_state 复核世界事实），卡死由看门狗兜底。',
              '踩坑与许可证结论见 docs/REFERENCE-terrariablind.md。',
            ]}
          />
        </section>
      </div>
    </div>
  );
}
