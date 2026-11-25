/**
 * [SIMULATION] 卡死回归剧本门禁（T-M6-68）。
 *
 * 每个 `scenarios/stuck/*.json` 一条 it：用 BWF 同构回放服务喂真实 `AutodriveRunner`
 * （生产编排循环 + 真实 RulePlanner / LlmPlanner），断言剧本的 expect。
 * 这些剧本是从真机卡死现场转来的永久回归——回退对应修复时必须变红（证据见 ROADMAP T-M6-68）。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AutodriveRunner,
  LlmPlanner,
  RulePlanner,
  StardewAdapter,
  type AutodriveEvent,
  type Planner,
  type PlannerDecision,
} from '@workbench/game-bridge-mcp';
import { callMatchesArgs, startBwfReplayServer, type ReplayCall } from './bwf-replay-server';
import { loadScenarios, plannerModeOf, type StuckScenario } from './stuck-scenario';

const SCENARIO_DIR = fileURLToPath(new URL('../scenarios/stuck', import.meta.url));

/** 包一层记录规划器决策（wait/stop 决策不会以工具调用形式出现，只有这样才能断言「求助」） */
class RecordingPlanner implements Planner {
  readonly decisions: PlannerDecision[] = [];

  constructor(private readonly inner: Planner) {}

  get name(): string {
    return this.inner.name;
  }

  async decide(state: Parameters<Planner['decide']>[0]): Promise<PlannerDecision> {
    const decision = await this.inner.decide(state);
    this.decisions.push(decision);
    return decision;
  }

  setObjective(objective: string | null): void {
    this.inner.setObjective?.(objective);
  }

  hasObjective(): boolean {
    return this.inner.hasObjective?.() ?? false;
  }

  consumeObjectiveDone(): string | null {
    return this.inner.consumeObjectiveDone?.() ?? null;
  }

  restoreObjectiveDone(): void {
    this.inner.restoreObjectiveDone?.();
  }

  observeReceipt(
    tool: string,
    status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR',
    summary: string,
  ): void {
    this.inner.observeReceipt?.(tool, status, summary);
  }

  debugSnapshot(): Record<string, unknown> {
    return this.inner.debugSnapshot?.() ?? {};
  }
}

/** 假 chat()：按剧本顺序吐出录制输出，吐完返回不可解析内容（覆盖 LLM 失败分支） */
function scriptedChat(script: readonly string[]): () => Promise<{ content: string }> {
  let index = 0;
  return async () => {
    const content = script[index] ?? '（小鲸走神了，没想出下一步）';
    index += 1;
    return { content };
  };
}

interface ScenarioResult {
  calls: ReplayCall[];
  decisions: PlannerDecision[];
  maxSameFailure: number;
  clockAdvanced: boolean;
}

async function runScenario(scenario: StuckScenario, responseMode: 'json' | 'sse' = 'json'): Promise<ScenarioResult> {
  const server = await startBwfReplayServer(scenario, { responseMode });
  const startClock = server.clock();
  const receipts: string[] = [];
  const mode = plannerModeOf(scenario);

  let llm: LlmPlanner | null = null;
  let inner: Planner;
  if (mode === 'idle') {
    inner = { name: 'idle-wait', decide: async () => ({ kind: 'wait', seconds: 5, reason: '剧本 idle：等待变更动作恢复时钟' }) };
  } else if (mode === 'llm') {
    llm = new LlmPlanner({
      chat: scriptedChat(scenario.llmScript ?? []),
      recentReceipts: [],
      fallbackPlanner: new RulePlanner(),
    });
    inner = llm;
  } else {
    inner = new RulePlanner();
  }
  const planner = new RecordingPlanner(inner);

  // 注入假时钟：sleep 推进它，让「90s 无变更 → keepalive」等真实时间逻辑可在毫秒内确定性触发
  let fakeNow = 0;
  const onEvent = (event: AutodriveEvent): void => {
    if (event.type !== 'receipt' || event.tool === 'autodrive') return;
    receipts.push(`${event.status} ${event.tool}: ${event.summary}`);
    if (receipts.length > 60) receipts.splice(0, receipts.length - 60);
    llm?.setRecentReceipts([...receipts]);
  };

  const runner = new AutodriveRunner(onEvent, {
    maxCycles: scenario.expect.maxCycles,
    stepDelayMs: 0,
    errorDelayMs: 0,
    pollDelayMs: 0,
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
  }, new StardewAdapter(server.endpoint));
  runner.setPlanner(planner);

  try {
    await runner.start();
    // start() 是「点火即返回」：必须等 maxCycles 自然停机，不能立刻 stopAndWait（会截断第一轮）
    const deadline = Date.now() + 15_000;
    while (runner.isRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await runner.stopAndWait();
  } finally {
    await server.close();
  }

  const failCounts = new Map<string, number>();
  for (const call of server.calls) {
    if (!call.isError) continue;
    failCounts.set(call.tool, (failCounts.get(call.tool) ?? 0) + 1);
  }
  const maxSameFailure = Math.max(0, ...failCounts.values());
  const endClock = server.clock();
  const clockAdvanced = startClock !== null && endClock !== null
    && (endClock.year !== startClock.year || endClock.season !== startClock.season
      || endClock.day !== startClock.day || endClock.minutes > startClock.minutes);

  return { calls: server.calls, decisions: planner.decisions, maxSameFailure, clockAdvanced };
}

/** 剧本观察到的全部动作：真实工具调用 + 规划器决策（wait/stop 也计入，避免「求助」不可断言） */
function observedActions(result: ScenarioResult): Set<string> {
  const actions = new Set(result.calls.map((call) => call.tool));
  for (const decision of result.decisions) {
    actions.add(decision.kind === 'act' ? decision.tool : decision.kind === 'wait' ? 'wait' : 'stop');
  }
  return actions;
}

const scenarios = loadScenarios(SCENARIO_DIR);

describe('T-M6-68 卡死回归剧本（真机现场 → 永久回归）', () => {
  it(`剧本目录至少 6 个且 id 唯一（实际 ${String(scenarios.length)} 个）`, () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
    for (const scenario of scenarios) expect(scenario.signature).toContain('|');
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}：${scenario.signature}`, async () => {
      const result = await runScenario(scenario);
      const actions = observedActions(result);
      const detail = `calls=${result.calls.map((call) => `${call.tool}${call.isError ? '✗' : '✓'}`).join(',')}；决策=${result.decisions.map((d) => (d.kind === 'act' ? d.tool : d.kind)).join(',')}`;

      expect(result.maxSameFailure, `同一工具失败次数超限（${scenario.expect.maxSameFailure}）：${detail}`)
        .toBeLessThanOrEqual(scenario.expect.maxSameFailure);

      if (scenario.expect.mustCallOneOf !== undefined) {
        const hit = scenario.expect.mustCallOneOf.some((tool) => actions.has(tool));
        expect(hit, `期望出现 ${scenario.expect.mustCallOneOf.join('/')} 之一：${detail}`).toBe(true);
      }
      if (scenario.expect.clockMustAdvance === true) {
        expect(result.clockAdvanced, `游戏时钟必须推进：${detail}`).toBe(true);
      }
      for (const expected of scenario.expect.mustCallWithArgs ?? []) {
        const hit = result.calls.some((call) => callMatchesArgs(call, expected));
        expect(hit, `期望真实调用 ${expected.tool} ${JSON.stringify(expected.args)}：${detail}`).toBe(true);
      }
    }, 20_000);
  }

  it('SSE 响应形态同样可被 BWF 客户端解析（S03 剧本重跑）', async () => {
    const scenario = scenarios.find((item) => item.id.startsWith('S03'));
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const result = await runScenario(scenario, 'sse');
    expect(result.calls.some((call) => call.tool === 'dialogue' && !call.isError)).toBe(true);
    expect(result.maxSameFailure).toBeLessThanOrEqual(scenario.expect.maxSameFailure);
  }, 20_000);
});
