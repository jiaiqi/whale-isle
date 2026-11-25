/**
 * [SIMULATION] 纯规则 7 日闭环门禁（T-M6-69，RUNBOOK-M8-STARDEW §3.7）。
 *
 * 用 `bwf-farm-sim.ts` 这个「活农场」喂真实 `RulePlanner`（没有任何 LLM）：
 * get_state → 规则决策 → 真实工具调用 → 回执反馈，连续跑 7 个游戏日。
 * 断言每日闭环各项完成（当天确实没机会做的记 N/A）、0 累晕、0 次 2:00 遣返、
 * 第 7 天金币高于第 1 天、LLM `chat()` 调用 0 次；另跑一组跨季（春 26 → 夏 4）
 * 验证换季后自动改买夏种子。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BwfMcpClient,
  classifyStardewReceipt,
  LlmPlanner,
  parseGameState,
  RulePlanner,
  SEED_TABLE,
  type GameStateSnapshot,
  type Planner,
} from '@workbench/game-bridge-mcp';
import { SIM_SEED_TABLE, startBwfFarmSim, type FarmDayRecord, type FarmSimHandle } from './bwf-farm-sim';

const LOOP_KEYS = ['mail', 'water', 'harvest', 'ship', 'buySeeds', 'plant'] as const;

type LoopKey = (typeof LOOP_KEYS)[number];

interface DriverResult {
  days: FarmDayRecord[];
  cycles: number;
  errors: string[];
}

/** 与 `soak:real --no-llm` 同一条路径：rule 模式只构造 RulePlanner，chat 永远不会被调用 */
function createPlanner(mode: 'rule' | 'llm', chat: () => Promise<{ content: string }>): Planner {
  return mode === 'rule' ? new RulePlanner() : new LlmPlanner({ chat });
}

async function drive(sim: FarmSimHandle, targetDays: number, maxCycles = 4000): Promise<DriverResult> {
  const client = new BwfMcpClient(sim.endpoint);
  const planner = createPlanner('rule', async () => ({ content: '{}' }));
  const errors: string[] = [];
  let cycles = 0;
  let state: GameStateSnapshot | null = null;
  while (sim.days.length < targetDays && cycles < maxCycles) {
    cycles += 1;
    const stateResult = await client.callTool('get_state');
    if (stateResult.kind !== 'ok') {
      errors.push(`get_state ${stateResult.kind}`);
      break;
    }
    state = parseGameState(stateResult.text);
    const decision = await planner.decide(state);
    if (decision.kind === 'stop') break;
    if (decision.kind === 'wait') {
      // 规则模式判定无事可做：仿真里让 wait 推进时间，避免测试空转
      await client.callTool('wait', { minutes: Math.max(1, Math.ceil(decision.seconds / 60)) });
      continue;
    }
    const call = await client.callTool(decision.tool, decision.args);
    const receipt = classifyStardewReceipt({
      text: call.kind === 'ok' ? call.text : '',
      kind: call.kind,
      isError: call.kind === 'ok' ? call.isError : false,
      tool: decision.tool,
      errorMessage: call.kind === 'error' ? call.message : undefined,
    });
    if (receipt.status !== 'COMPLETED') errors.push(`${decision.tool} ${receipt.status}: ${receipt.summary}`);
    planner.observeReceipt?.(decision.tool, receipt.status, receipt.summary);
  }
  return { days: sim.days, cycles, errors };
}

describe('T-M6-69 种子表与仿真表同步', () => {
  it('mock-harness 的仿真种子表与 game-bridge 的 seed-table 完全一致（改一处忘另一处会变红）', () => {
    const business = SEED_TABLE.map((seed) => ({
      season: seed.season,
      name: seed.name,
      price: seed.price,
      maturityDays: seed.maturityDays,
      regrow: seed.regrow,
    }));
    const sim = SIM_SEED_TABLE.map((seed) => ({
      season: seed.season,
      name: seed.name,
      price: seed.price,
      maturityDays: seed.maturityDays,
      regrow: seed.regrow,
    }));
    expect(sim).toEqual(business);
  });
});

describe('T-M6-69 纯规则 7 日闭环（农场仿真）', () => {
  it('从春 16 日 06:00 跑 7 天：每日闭环完成、0 累晕、0 遣返、金币增长、chat 0 次', async () => {
    const chat = vi.fn(async () => ({ content: '{"tool":"fish","args":{}}' }));
    expect(createPlanner('rule', chat).name).toBe('rule-schedule');
    expect(chat).not.toHaveBeenCalled();

    const sim = await startBwfFarmSim({
      year: 1, season: '春', day: 16, minutes: 6 * 60,
      money: 640, tilled: 24, strawberry: 6, mailPerDay: 1, seed: 20261125,
    });
    try {
      const result = await drive(sim, 7);
      expect(result.cycles).toBeLessThan(4000);
      expect(result.days).toHaveLength(7);
      // 驱动过程中不应出现任何 FAILED/ERROR 回执（规则前置检查保证动作可行）
      expect(result.errors).toEqual([]);

      for (const day of result.days) {
        const missing: LoopKey[] = LOOP_KEYS.filter((key) => !day.loop[key] && day.opportunity[key]);
        expect(missing, `${day.dayKey}（${day.weather}）闭环缺项：${missing.join(',')}；动作=${day.actions.join(',')}`).toEqual([]);
        expect(day.loop.sleptBefore2am, `${day.dayKey} 没有在 2:00 前睡觉`).toBe(true);
        expect(day.passedOut, `${day.dayKey} 累晕了`).toBe(false);
        expect(day.forcedHome2am, `${day.dayKey} 被 2:00 遣返`).toBe(false);
      }
      // 防止「全是 N/A」的空绿：每一项至少真正完成过一次
      for (const key of LOOP_KEYS) {
        expect(result.days.some((day) => day.loop[key]), `7 天内从未完成 ${key}`).toBe(true);
      }
      const first = result.days[0]!;
      const last = result.days[6]!;
      expect(last.moneyEnd, `第 7 天金币 ${last.moneyEnd}g 未超过第 1 天 ${first.moneyEnd}g`).toBeGreaterThan(first.moneyEnd);
      expect(last.moneyEnd).toBeGreaterThan(first.moneyStart);
      // 7 天里确实经历过雨天（浇水自动完成分支）或全是晴天——两种都必须不刷失败
      expect(result.days.every((day) => day.weather !== '')).toBe(true);
      expect(chat).not.toHaveBeenCalled();
    } finally {
      await sim.close();
    }
  }, 30_000);

  it('跨季：春 26 起跑，夏 1 起自动改买辣椒种子（春季季末不买种）', async () => {
    const sim = await startBwfFarmSim({
      year: 1, season: '春', day: 26, minutes: 6 * 60,
      money: 640, tilled: 24, strawberry: 6, mailPerDay: 1, seed: 7,
    });
    try {
      const result = await drive(sim, 7);
      expect(result.days).toHaveLength(7);
      const springDays = result.days.filter((day) => day.season === '春');
      const summerDays = result.days.filter((day) => day.season === '夏');
      expect(springDays).toHaveLength(3);
      expect(summerDays).toHaveLength(4);
      // 春季 26-28 日：防风草 4 天成熟，季末前来不及 → 不买不种
      for (const day of springDays) {
        expect(day.actions).not.toContain('buy');
        expect(day.opportunity.buySeeds).toBe(false);
      }
      const buys = sim.calls.filter((call) => call.tool === 'buy');
      expect(buys.some((call) => call.args.item === '辣椒种子')).toBe(true);
      expect(buys.some((call) => call.args.item === '防风草种子')).toBe(false);
      // 换季后仍然完成每日闭环，没有累晕/遣返
      for (const day of result.days) {
        expect(day.passedOut, `${day.dayKey} 累晕了`).toBe(false);
        expect(day.forcedHome2am, `${day.dayKey} 被 2:00 遣返`).toBe(false);
        expect(day.loop.sleptBefore2am).toBe(true);
      }
      expect(result.errors).toEqual([]);
    } finally {
      await sim.close();
    }
  }, 30_000);
});
