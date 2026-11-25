/**
 * T-M6-67 报告生成：总览、每日表、失败签名 Top10、卡死清单、金币曲线；确定性输出。
 */
import { describe, expect, it } from 'vitest';
import type { DayRecord } from './day-tracker';
import type { StuckEntry } from './report';
import { buildSummary, exitCodeFor, renderMoneySvg, renderReport } from './report';

const START = Date.UTC(2026, 4, 1, 6, 0, 0);
const END = Date.UTC(2026, 4, 1, 7, 30, 0);

function makeDay(dayKey: string, overrides: Partial<DayRecord> = {}): DayRecord {
  return {
    dayKey,
    season: '春',
    weather: '晴',
    moneyStart: 640,
    moneyEnd: 900,
    loop: { mail: true, water: true, harvest: true, ship: true, buySeeds: true, plant: true, sleptBefore2am: true },
    na: { buySeeds: false, plant: false },
    passedOut: false,
    forcedHome2am: false,
    stuckCount: 0,
    receipts: { completed: 10, failed: 1, timeout: 0, uncertain: 0, error: 0 },
    ...overrides,
  };
}

const STUCK: StuckEntry = {
  kind: 'repeat-failure',
  signature: 'fish|背包里没有鱼竿|Beach',
  detail: '同一失败签名 3 次｜含竖线',
  at: START + 60_000,
  location: 'Beach',
  clock: '第1年春16日 10:00',
  dir: 'stuck/01-repeat-failure',
};

function summaryOf(
  days: DayRecord[],
  stucks: StuckEntry[] = [],
  failureCounts = new Map<string, number>(),
  events: Array<{ type: string; tool?: string; status?: string }> = [],
): ReturnType<typeof buildSummary> {
  return buildSummary({
    runId: '20260501-060000',
    startedAt: START,
    endedAt: END,
    options: { days: 2, onStuck: 'continue', maxHours: 0, observerMs: 30_000, endpoint: 'http://127.0.0.1:18080/mcp' },
    llm: { mode: 'rule', degradedReason: '缺少环境变量 WHALE_SOAK_API_KEY，自动降级 --no-llm' },
    days,
    stucks,
    failureCounts,
    interrupted: false,
    notes: ['观察者已关闭'],
    events,
  });
}

describe('buildSummary', () => {
  it('汇总回执、金币、闭环与卡死原因', () => {
    const days = [makeDay('Y1-春-16'), makeDay('Y1-春-17', { moneyStart: 900, moneyEnd: 1200, passedOut: true })];
    const failures = new Map<string, number>([
      ['fish|背包里没有鱼竿|Beach', 4],
      ['water_crops|没有喷壶|Farm', 1],
    ]);
    const events = [
      { type: 'decision', tool: 'fish' },
      { type: 'decision', tool: 'fish' },
      { type: 'decision', tool: 'water_crops' },
      { type: 'receipt', tool: 'fish', status: 'FAILED' },
      { type: 'receipt', tool: 'fish', status: 'FAILED' },
      { type: 'receipt', tool: 'water_crops', status: 'COMPLETED' },
      { type: 'watchdog' },
    ];
    const summary = summaryOf(days, [STUCK], failures, events);
    expect(summary.quality).toMatchObject({
      decisions: 3,
      receipts: 3,
      completed: 1,
      failed: 2,
      distinctTools: 2,
      longestToolStreak: 2,
      watchdogs: 1,
    });
    expect(summary.quality.repeatRate).toBeCloseTo(1 / 3, 5);
    expect(summary.totals).toMatchObject({
      days: 2,
      requestedDays: 2,
      loopCompleteDays: 2,
      stuck: 1,
      passedOutDays: 1,
      forcedHomeDays: 0,
      moneyStart: 640,
      moneyEnd: 1200,
      moneyDelta: 560,
    });
    expect(summary.totals.receipts).toEqual({ completed: 20, failed: 2, timeout: 0, uncertain: 0, error: 0, total: 22 });
    expect(summary.totals.successRate).toBeCloseTo(20 / 22, 5);
    expect(summary.failureSignatures[0]).toEqual({ signature: 'fish|背包里没有鱼竿|Beach', count: 4 });
    expect(summary.pass).toBe(false);
    expect(summary.reasons).toEqual(expect.arrayContaining([expect.stringContaining('卡死 1 次'), expect.stringContaining('累晕 1 天')]));
  });

  it('全部达标时 pass=true 且没有原因', () => {
    const summary = summaryOf([makeDay('Y1-春-16'), makeDay('Y1-春-17')]);
    expect(summary.pass).toBe(true);
    expect(summary.reasons).toEqual([]);
    expect(exitCodeFor(summary)).toBe(0);
  });

  it('游戏日不足、中断、2:00 遣返都会写进原因；空数据不伪造金币', () => {
    const summary = buildSummary({
      runId: 'r',
      startedAt: START,
      endedAt: END,
      options: { days: 3, onStuck: 'stop', maxHours: 2, observerMs: 0, endpoint: 'http://x/mcp' },
      llm: { mode: 'llm', provider: 'deepseek-official', model: 'deepseek-chat' },
      days: [makeDay('Y1-春-16', { forcedHome2am: true })],
      stucks: [],
      failureCounts: new Map(),
      interrupted: true,
    });
    expect(summary.totals.moneyStart).toBe(640);
    expect(summary.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('游戏日不足：完成 1/3'),
      expect.stringContaining('2:00 遣返 1 天'),
      expect.stringContaining('运行被中断'),
    ]));
    expect(exitCodeFor(summary)).toBe(1);

    const empty = buildSummary({
      runId: 'r2', startedAt: START, endedAt: END,
      options: { days: 1, onStuck: 'continue', maxHours: 0, observerMs: 30_000, endpoint: 'http://x/mcp' },
      llm: { mode: 'rule', degradedReason: '--no-llm' },
      days: [], stucks: [], failureCounts: new Map(), interrupted: false,
    });
    expect(empty.totals.moneyStart).toBeNull();
    expect(empty.totals.moneyDelta).toBeNull();
    expect(empty.totals.successRate).toBeNull();
    expect(empty.notes).toEqual([]);
  });

  it('部分日（超时留下的当天残片）不算达标', () => {
    const partial = makeDay('Y1-春-16', {
      loop: { mail: true, water: false, harvest: false, ship: false, buySeeds: false, plant: false, sleptBefore2am: false },
    });
    const summary = buildSummary({
      runId: 'r-partial', startedAt: START, endedAt: END,
      options: { days: 1, onStuck: 'continue', maxHours: 0.001, observerMs: 0, endpoint: 'http://x/mcp' },
      llm: { mode: 'rule', degradedReason: '--no-llm' },
      days: [partial], stucks: [], failureCounts: new Map(), interrupted: false,
    });
    expect(summary.totals.loopCompleteDays).toBe(0);
    expect(summary.pass).toBe(false);
    expect(summary.reasons).toContain('闭环不完整 1 天');
  });

  it('失败签名最多列 10 条并按次数降序', () => {
    const failures = new Map<string, number>();
    for (let index = 0; index < 12; index += 1) failures.set(`sig-${String(index).padStart(2, '0')}`, index + 1);
    const summary = summaryOf([makeDay('Y1-春-16')], [], failures);
    expect(summary.failureSignatures).toHaveLength(10);
    expect(summary.failureSignatures[0]?.signature).toBe('sig-11');
    expect(summary.failureSignatures[9]?.signature).toBe('sig-02');
  });
});

describe('renderReport', () => {
  it('包含总览、每日表（含 N/A）、失败签名、卡死清单、金币曲线与备注', () => {
    const days = [
      makeDay('Y1-春-16'),
      makeDay('Y1-春-17', { na: { buySeeds: true, plant: true }, loop: { ...makeDay('x').loop, buySeeds: false, plant: false }, weather: '下雨' }),
      makeDay('Y1-春-18', { passedOut: true, forcedHome2am: true }),
    ];
    const summary = summaryOf(days, [STUCK], new Map([['fish|背包里没有鱼竿|Beach', 3]]));
    const markdown = renderReport(summary);
    expect(markdown).toContain('# 星露谷真机浸泡报告（soak:real · 20260501-060000）');
    expect(markdown).toContain('**结论：❌ 未达标**');
    expect(markdown).toContain('| LLM | 关（规则规划器：缺少环境变量 WHALE_SOAK_API_KEY，自动降级 --no-llm） |');
    expect(markdown).toContain('| 质量（metrics.ts） |');
    expect(markdown).toContain('## 每日闭环');
    expect(markdown).toContain('| Y1-春-17 | 下雨 |');
    expect(markdown).toContain('N/A');
    expect(markdown).toContain('`fish|背包里没有鱼竿|Beach`');
    expect(markdown).toContain('## 卡死清单');
    expect(markdown).toContain('[`stuck/01-repeat-failure/`](stuck/01-repeat-failure/verdict.json)');
    expect(markdown).toContain('含竖线'); // 竖线已转义，不破坏表格
    expect(markdown).toContain('## 金币曲线');
    expect(markdown).toContain('<polyline');
    expect(markdown).toContain('- 观察者已关闭');
    expect(markdown).toContain('`[REAL-DEVICE]`');
  });

  it('达标报告写「✅ 达标」；空数据给出占位行', () => {
    const pass = summaryOf([makeDay('Y1-春-16'), makeDay('Y1-春-17')]);
    const good = renderReport(pass);
    expect(good).toContain('**结论：✅ 达标**');
    expect(good).toContain('| LLM | 关（规则规划器：缺少环境变量 WHALE_SOAK_API_KEY，自动降级 --no-llm） |');

    const empty = buildSummary({
      runId: 'r3', startedAt: START, endedAt: END,
      options: { days: 1, onStuck: 'continue', maxHours: 0, observerMs: 0, endpoint: 'http://x/mcp' },
      llm: { mode: 'llm', provider: 'deepseek-official', model: 'deepseek-chat' },
      days: [], stucks: [], failureCounts: new Map(), interrupted: false,
    });
    const markdown = renderReport(empty);
    expect(markdown).toContain('| LLM | 开（deepseek-official / deepseek-chat） |');
    expect(markdown).toContain('（无游戏日记录）');
    expect(markdown).toContain('成功率 — · 失败率 — · 重复动作 —');
    expect(markdown).toContain('（本次运行没有失败回执）');
    expect(markdown).toContain('（本次运行没有触发卡死判定）');
    expect(markdown).toContain('（无数据）');
  });

  it('同一输入渲染两次完全一致（可快照）', () => {
    const summary = summaryOf([makeDay('Y1-春-16'), makeDay('Y1-春-17')]);
    expect(renderReport(summary)).toBe(renderReport(summary));
  });
});

describe('renderMoneySvg', () => {
  it('少于 2 天不画折线', () => {
    expect(renderMoneySvg([])).toBe('');
    expect(renderMoneySvg([makeDay('Y1-春-16')])).toBe('');
  });

  it('≥2 天输出内联 SVG，标注最小/最大金币', () => {
    const svg = renderMoneySvg([
      makeDay('Y1-春-16', { moneyEnd: 100 }),
      makeDay('Y1-春-17', { moneyEnd: 400 }),
      makeDay('Y1-春-18', { moneyEnd: 250 }),
    ]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('100g → 400g');
    expect(svg).toContain('<polyline');
    expect((svg.match(/,/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
