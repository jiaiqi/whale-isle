/**
 * 浸泡报告生成（T-M6-67）：`report.md` + `summary.json`。
 *
 * 纯函数：给定 DayRecord[] 与卡死列表，产出确定性 Markdown（同一输入 → 同一输出，可快照对比）。
 * 报告内容：总览（达标与否）、每日闭环表、失败签名 Top10、卡死清单（链接现场目录）、金币曲线。
 */
import {
  summarizeAutodriveQuality,
  type AutodriveQuality,
  type QualityEventLike,
} from '@workbench/game-bridge-mcp';
import { isDayLoopComplete, type DayRecord } from './day-tracker';
import type { StuckVerdict } from './stuck-detector';

export interface SoakRunOptions {
  days: number;
  onStuck: 'continue' | 'stop';
  maxHours: number;
  observerMs: number;
  endpoint: string;
}

export interface SoakLlmInfo {
  mode: 'llm' | 'rule';
  provider?: string;
  model?: string;
  /** 降级原因（缺环境变量 / --no-llm / 供应商预设未知…），写进报告开头 */
  degradedReason?: string;
}

export interface StuckEntry extends StuckVerdict {
  /** 相对 runDir 的现场目录 */
  dir: string;
}

export interface SignatureCount {
  signature: string;
  count: number;
}

export interface SoakTotals {
  days: number;
  requestedDays: number;
  loopCompleteDays: number;
  stuck: number;
  passedOutDays: number;
  forcedHomeDays: number;
  receipts: { completed: number; failed: number; timeout: number; uncertain: number; error: number; total: number };
  /** COMPLETED / 全部回执；无回执时为 null（不伪造 100%） */
  successRate: number | null;
  moneyStart: number | null;
  moneyEnd: number | null;
  moneyDelta: number | null;
}

export interface SoakSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  /** 现实时长（毫秒） */
  elapsedMs: number;
  interrupted: boolean;
  options: SoakRunOptions;
  llm: SoakLlmInfo;
  totals: SoakTotals;
  /** game-bridge-mcp metrics.ts 的质量指标（成功率/失败率/重复率/看门狗） */
  quality: AutodriveQuality;
  days: DayRecord[];
  failureSignatures: SignatureCount[];
  stucks: StuckEntry[];
  notes: string[];
  /** 运行判据：游戏日够数、0 卡死、无累晕、无 2:00 遣返 */
  pass: boolean;
  /** 未达标原因（人类可读，逐条） */
  reasons: string[];
}

export interface SummaryInput {
  runId: string;
  startedAt: number;
  endedAt: number;
  options: SoakRunOptions;
  llm: SoakLlmInfo;
  days: readonly DayRecord[];
  stucks: readonly StuckEntry[];
  failureCounts: ReadonlyMap<string, number>;
  interrupted: boolean;
  notes?: readonly string[];
  /** 全量事件（只取 type/tool/status 字段）；缺省时质量指标为空表 */
  events?: readonly QualityEventLike[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator <= 0 ? null : numerator / denominator;
}

export function buildSummary(input: SummaryInput): SoakSummary {
  const receipts = { completed: 0, failed: 0, timeout: 0, uncertain: 0, error: 0, total: 0 };
  for (const day of input.days) {
    receipts.completed += day.receipts.completed;
    receipts.failed += day.receipts.failed;
    receipts.timeout += day.receipts.timeout;
    receipts.uncertain += day.receipts.uncertain;
    receipts.error += day.receipts.error;
  }
  receipts.total = receipts.completed + receipts.failed + receipts.timeout + receipts.uncertain + receipts.error;

  const quality = summarizeAutodriveQuality(input.events ?? []);

  const first = input.days[0];
  const last = input.days[input.days.length - 1];
  const moneyStart = first === undefined ? null : first.moneyStart;
  const moneyEnd = last === undefined ? null : last.moneyEnd;

  const failureSignatures: SignatureCount[] = [...input.failureCounts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
    .slice(0, 10);

  const passedOutDays = input.days.filter((day) => day.passedOut).length;
  const forcedHomeDays = input.days.filter((day) => day.forcedHome2am).length;
  const loopCompleteDays = input.days.filter((day) => isDayLoopComplete(day)).length;

  const reasons: string[] = [];
  const incompleteDays = input.days.length - loopCompleteDays;
  if (input.days.length < input.options.days) {
    reasons.push(`游戏日不足：完成 ${input.days.length}/${input.options.days}`);
  }
  // 超时/中断时当天按「部分日」落账，不能算进达标天数
  if (incompleteDays > 0) reasons.push(`闭环不完整 ${incompleteDays} 天`);
  if (input.stucks.length > 0) reasons.push(`卡死 ${input.stucks.length} 次`);
  if (passedOutDays > 0) reasons.push(`累晕 ${passedOutDays} 天`);
  if (forcedHomeDays > 0) reasons.push(`2:00 遣返 ${forcedHomeDays} 天`);
  if (input.interrupted) reasons.push('运行被中断（未跑满计划游戏日）');

  const pass = input.days.length >= input.options.days
    && loopCompleteDays === input.days.length
    && input.stucks.length === 0
    && passedOutDays === 0
    && forcedHomeDays === 0
    && !input.interrupted;

  return {
    runId: input.runId,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    elapsedMs: Math.max(0, input.endedAt - input.startedAt),
    interrupted: input.interrupted,
    options: input.options,
    llm: input.llm,
    totals: {
      days: input.days.length,
      requestedDays: input.options.days,
      loopCompleteDays,
      stuck: input.stucks.length,
      passedOutDays,
      forcedHomeDays,
      receipts,
      successRate: ratio(receipts.completed, receipts.total),
      moneyStart,
      moneyEnd,
      moneyDelta: moneyStart === null || moneyEnd === null ? null : moneyEnd - moneyStart,
    },
    quality,
    days: [...input.days].map((day) => ({ ...day, loop: { ...day.loop }, na: { ...day.na }, receipts: { ...day.receipts } })),
    failureSignatures,
    stucks: [...input.stucks],
    notes: [...(input.notes ?? [])],
    pass,
    reasons,
  };
}

/** 退出码：0 达标；1 有卡死或闭环不达标（连接/参数错误由 CLI 直接返回 2） */
export function exitCodeFor(summary: Pick<SoakSummary, 'pass'>): 0 | 1 {
  return summary.pass ? 0 : 1;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function money(value: number | null): string {
  return value === null ? '—' : `${value}g`;
}

function minutesText(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

function check(value: boolean, na = false): string {
  if (na) return 'N/A';
  return value ? '✅' : '—';
}

/** 金币曲线内联 SVG（≥2 天才有意义；坐标保留 1 位小数，保证确定性输出） */
export function renderMoneySvg(days: readonly DayRecord[]): string {
  if (days.length < 2) return '';
  const width = 360;
  const height = 80;
  const pad = 8;
  const values = days.map((day) => day.moneyEnd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = pad + (index * (width - pad * 2)) / (values.length - 1);
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="金币曲线">`,
    `  <polyline fill="none" stroke="#2f81f7" stroke-width="2" points="${points.join(' ')}" />`,
    `  <text x="${pad}" y="12" font-size="10" fill="#666">${min}g → ${max}g</text>`,
    '</svg>',
  ].join('\n');
}

export function renderReport(summary: SoakSummary): string {
  const { totals, options, llm } = summary;
  const lines: string[] = [];

  lines.push(`# 星露谷真机浸泡报告（soak:real · ${summary.runId}）`, '');
  lines.push(`**结论：${summary.pass ? '✅ 达标' : '❌ 未达标'}**${summary.reasons.length > 0 ? ` —— ${summary.reasons.join('；')}` : ''}`, '');
  lines.push('> 口径：本报告来自真实 BWF（星露谷 + SMAPI）运行，属 `[REAL-DEVICE]` 证据；仿真/单测结果不得替代。', '');

  lines.push('## 运行信息', '');
  lines.push('| 项 | 值 |', '| --- | --- |');
  lines.push(`| 运行 ID | \`${summary.runId}\` |`);
  lines.push(`| 起止（本地时间） | ${summary.startedAt} → ${summary.endedAt}（现实 ${minutesText(summary.elapsedMs)}） |`);
  lines.push(`| 计划 / 实际游戏日 | ${options.days} / ${totals.days} |`);
  lines.push(`| BWF 端点 | \`${options.endpoint}\` |`);
  lines.push(`| 观察者间隔 | ${options.observerMs > 0 ? `${options.observerMs}ms` : '关闭'} |`);
  lines.push(`| 卡死策略 | ${options.onStuck}${options.maxHours > 0 ? ` · 现实上限 ${options.maxHours}h` : ''} |`);
  lines.push(`| 中断 | ${summary.interrupted ? '是（Ctrl+C / 上限 / 卡死即停）' : '否'} |`);
  lines.push(
    llm.mode === 'llm'
      ? `| LLM | 开（${llm.provider ?? '?'} / ${llm.model ?? '?'}） |`
      : `| LLM | 关（规则规划器${llm.degradedReason === undefined ? '' : `：${llm.degradedReason}`}） |`,
  );
  lines.push('');

  lines.push('## 总览', '');
  lines.push('| 指标 | 值 |', '| --- | --- |');
  lines.push(`| 游戏日 | ${totals.days}/${totals.requestedDays} |`);
  lines.push(`| 每日闭环完整 | ${totals.loopCompleteDays}/${totals.days} |`);
  lines.push(`| 卡死 | ${totals.stuck} |`);
  lines.push(`| 累晕 | ${totals.passedOutDays} |`);
  lines.push(`| 2:00 遣返 | ${totals.forcedHomeDays} |`);
  lines.push(
    `| 回执 | 完成 ${totals.receipts.completed} · 失败 ${totals.receipts.failed} · 超时 ${totals.receipts.timeout} · 不确定 ${totals.receipts.uncertain} · 错误 ${totals.receipts.error}（成功率 ${percent(totals.successRate)}） |`,
  );
  const { quality } = summary;
  lines.push(
    `| 质量（metrics.ts） | 成功率 ${percent(quality.successRate)} · 失败率 ${percent(quality.failureRate)} · `
    + `重复动作 ${percent(quality.repeatRate)} · 最长同工具 ${quality.longestToolStreak} 连 · 看门狗 ${quality.watchdogs} |`,
  );
  lines.push(`| 金币 | ${money(totals.moneyStart)} → ${money(totals.moneyEnd)}（Δ ${money(totals.moneyDelta)}） |`);
  lines.push('');

  lines.push('## 每日闭环', '');
  lines.push('| 日期 | 天气 | 金币 起→止 | 读信 | 浇水 | 收获 | 出货 | 买种 | 播种 | 2:00 前睡觉 | 卡死 | 累晕 | 遣返 | 回执 完成/失败/超时 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const day of summary.days) {
    const cells = [
      day.dayKey,
      day.weather === '' ? '—' : day.weather,
      `${money(day.moneyStart)} → ${money(day.moneyEnd)}`,
      check(day.loop.mail, day.na.mail === true),
      check(day.loop.water, day.na.water === true),
      check(day.loop.harvest, day.na.harvest === true),
      check(day.loop.ship),
      check(day.loop.buySeeds, day.na.buySeeds),
      check(day.loop.plant, day.na.plant),
      check(day.loop.sleptBefore2am),
      String(day.stuckCount),
      day.passedOut ? '是' : '—',
      day.forcedHome2am ? '是' : '—',
      `${day.receipts.completed}/${day.receipts.failed}/${day.receipts.timeout}`,
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  if (summary.days.length === 0) lines.push('| （无游戏日记录） | — | — | — | — | — | — | — | — | — | — | — | — | — |');
  lines.push('');
  lines.push('> `N/A` = 该日不适用（冬季/季末不买种不播种；或当天 get_state 证明没有未读信/需浇水/可收获/空地/种子），不算失败；`—` = 当天有机会但没有该动作的成功回执。', '');

  lines.push('## 失败签名 Top 10', '');
  if (summary.failureSignatures.length === 0) {
    lines.push('（本次运行没有失败回执）');
  } else {
    lines.push('| # | 签名（工具\\|原因\\|地点） | 次数 |', '| --- | --- | --- |');
    summary.failureSignatures.forEach((item, index) => {
      lines.push(`| ${index + 1} | \`${item.signature}\` | ${item.count} |`);
    });
  }
  lines.push('');

  lines.push('## 卡死清单', '');
  if (summary.stucks.length === 0) {
    lines.push('（本次运行没有触发卡死判定）');
  } else {
    lines.push('| # | 类型 | 时间 | 地点 | 详情 | 现场包 |', '| --- | --- | --- | --- | --- | --- |');
    summary.stucks.forEach((entry, index) => {
      const detail = entry.detail.replace(/\|/g, '\\|').slice(0, 160);
      lines.push(
        `| ${index + 1} | ${entry.kind} | ${new Date(entry.at).toISOString()} | ${entry.location} | ${detail} | [\`${entry.dir}/\`](${entry.dir.replace(/\\/g, '/')}/verdict.json) |`,
      );
    });
  }
  lines.push('');

  lines.push('## 金币曲线', '');
  if (summary.days.length === 0) {
    lines.push('（无数据）');
  } else {
    lines.push('| 日期 | 起始 | 结束 | Δ |', '| --- | --- | --- | --- |');
    for (const day of summary.days) {
      lines.push(`| ${day.dayKey} | ${money(day.moneyStart)} | ${money(day.moneyEnd)} | ${money(day.moneyEnd - day.moneyStart)} |`);
    }
    const svg = renderMoneySvg(summary.days);
    if (svg !== '') {
      lines.push('', '<details><summary>折线（内联 SVG）</summary>', '', svg, '', '</details>');
    }
  }
  lines.push('');

  if (summary.notes.length > 0) {
    lines.push('## 备注', '');
    for (const note of summary.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('---', '', `生成：soak:real（T-M6-67）· ${summary.endedAt}`, '');
  return lines.join('\n');
}
