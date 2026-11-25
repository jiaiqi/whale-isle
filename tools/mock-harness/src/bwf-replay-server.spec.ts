/**
 * BWF 同构回放服务（T-M6-68）：时钟改写、选择题闸门、自暂停冻结、JSON/SSE 双响应。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceClock,
  callMatchesArgs,
  formatClock,
  parseScenarioClock,
  rewriteClock,
  startBwfReplayServer,
  type ReplayServerHandle,
} from './bwf-replay-server';
import type { StuckScenario } from './stuck-scenario';

const SCENARIO: StuckScenario = {
  id: 'S99-replay-server',
  signature: 'fish|没有鱼竿|Beach',
  source: 'unit-test',
  initialState: '## 基本状态\n时间：第1年夏2日 07:10，天气：晴\n## 当前界面\n无（可以自由行动）\n## 位置\n地点：Beach（沙滩）\n',
  rules: [
    { tool: 'travel_to', receipt: { text: 'OK travel_to', isError: false }, advanceMinutes: 30 },
    { tool: 'wait', receipt: { text: 'OK wait', isError: false }, advanceMinutes: 10 },
    { tool: 'fish', receipt: { text: '失败：背包里没有鱼竿', isError: true } },
    { tool: '*', receipt: { text: '完成', isError: false }, advanceMinutes: 10 },
  ],
  expect: { maxCycles: 5, maxSameFailure: 1 },
};

const servers: ReplayServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(scenario: StuckScenario = SCENARIO, mode: 'json' | 'sse' = 'json'): Promise<ReplayServerHandle> {
  const server = await startBwfReplayServer(scenario, { responseMode: mode, now: () => 123 });
  servers.push(server);
  return server;
}

async function call(server: ReplayServerHandle, tool: string, args: Record<string, unknown> = {}): Promise<{
  text: string;
  isError: boolean;
}> {
  const response = await fetch(server.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await response.text();
  const jsonLine = raw.split('\n').find((line) => line.trimStart().startsWith('data:')) ?? raw;
  const payload = JSON.parse(jsonLine.trimStart().replace(/^data:\s*/, '')) as {
    result: { content: Array<{ type: string; text: string }>; isError: boolean };
  };
  return { text: payload.result.content[0]?.text ?? '', isError: payload.result.isError };
}

describe('时钟工具函数', () => {
  it('解析 / 格式化 / 改写锚点行', () => {
    const clock = parseScenarioClock(SCENARIO.initialState);
    expect(clock).toEqual({ year: 1, season: '夏', day: 2, minutes: 7 * 60 + 10 });
    expect(formatClock({ year: 2, season: '冬', day: 28, minutes: 6 * 60 })).toBe('时间：第2年冬28日 06:00');
    expect(rewriteClock('前言\n时间：第1年春1日 06:00\n后记', { year: 1, season: '春', day: 2, minutes: 7 * 60 }))
      .toBe('前言\n时间：第1年春2日 07:00\n后记');
    expect(rewriteClock('没有时钟行', clock!)).toBe('没有时钟行');
    expect(parseScenarioClock('没有时钟行')).toBeNull();
  });

  it('推进分钟：跨 24:00 换日、跨 28 日换季、跨年', () => {
    expect(advanceClock({ year: 1, season: '春', day: 3, minutes: 23 * 60 }, 90))
      .toEqual({ year: 1, season: '春', day: 4, minutes: 30 });
    expect(advanceClock({ year: 1, season: '春', day: 28, minutes: 6 * 60 }, 0))
      .toEqual({ year: 1, season: '春', day: 28, minutes: 6 * 60 });
    expect(advanceClock({ year: 1, season: '春', day: 28, minutes: 23 * 60 }, 120))
      .toEqual({ year: 1, season: '夏', day: 1, minutes: 60 });
    expect(advanceClock({ year: 1, season: '冬', day: 28, minutes: 23 * 60 }, 120))
      .toEqual({ year: 2, season: '春', day: 1, minutes: 60 });
    expect(advanceClock({ year: 1, season: '夏', day: 1, minutes: 6 * 60 }, -30))
      .toEqual({ year: 1, season: '夏', day: 1, minutes: 6 * 60 });
  });
});

describe('回放服务', () => {
  it('get_state 返回剧本原文；动作回执按规则推进时钟', async () => {
    const server = await start();
    expect(await call(server, 'get_state')).toEqual({ text: expect.stringContaining('时间：第1年夏2日 07:10'), isError: false });
    expect(await call(server, 'travel_to', { location: 'Town' })).toEqual({ text: 'OK travel_to', isError: false });
    expect(server.clock()?.minutes).toBe(7 * 60 + 40);
    const state = await call(server, 'get_state');
    expect(state.text).toContain('时间：第1年夏2日 07:40');
    expect(server.calls.map((entry) => entry.tool)).toEqual(['get_state', 'travel_to', 'get_state']);
    expect(server.calls.at(-1)?.at).toBe(123);
    expect(callMatchesArgs(server.calls[1]!, { tool: 'travel_to', args: { location: 'Town' } })).toBe(true);
    expect(callMatchesArgs(server.calls[1]!, { tool: 'travel_to', args: { location: 'Farm' } })).toBe(false);
  });

  it('失败回执 isError=true 且不推进时钟；未覆盖工具显性报错', async () => {
    const server = await start();
    expect(await call(server, 'fish')).toEqual({ text: '失败：背包里没有鱼竿', isError: true });
    expect(server.clock()?.minutes).toBe(7 * 60 + 10);
    const uncovered = await start({ ...SCENARIO, rules: [{ tool: 'wait', receipt: { text: 'OK', isError: false } }] });
    expect((await call(uncovered, 'fish')).isError).toBe(true);
    expect((await call(uncovered, 'fish')).text).toContain('未覆盖工具 fish');
  });

  it('选择题界面：dialogue 缺 choice 被拒；带 choice 推进并关闭界面', async () => {
    const choiceScenario: StuckScenario = {
      ...SCENARIO,
      initialState: `${SCENARIO.initialState}`
        .replace('## 当前界面\n无（可以自由行动）', '## 当前界面\n对话框：你打算收养这只猫吗？\n选项（用 dialogue 并传 choice 序号回答）：\n  0: 是\n  1: 否'),
      rules: [...SCENARIO.rules, { tool: 'dialogue', receipt: { text: 'OK dialogue', isError: false }, advanceMinutes: 5 }],
    };
    const server = await start(choiceScenario);
    const rejected = await call(server, 'dialogue');
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('choice');
    const accepted = await call(server, 'dialogue', { choice: 0 });
    expect(accepted).toEqual({ text: 'OK dialogue', isError: false });
    const after = await call(server, 'get_state');
    expect(after.text).toContain('无（可以自由行动）');
    expect(after.text).not.toContain('选项');
  });

  it('freezeUntilMutation：只读工具不解冻，变更动作解冻并推进时钟', async () => {
    const server = await start({ ...SCENARIO, freezeUntilMutation: true });
    const frozen = await call(server, 'get_state');
    expect(frozen.text).toContain('已暂停游戏');
    await call(server, 'list_chests');
    expect(server.clock()?.minutes).toBe(7 * 60 + 10);
    expect((await call(server, 'get_state')).text).toContain('已暂停游戏');
    await call(server, 'wait');
    expect(server.clock()?.minutes).toBe(7 * 60 + 20);
    expect((await call(server, 'get_state')).text).not.toContain('已暂停游戏');
  });

  it('SSE 形态返回 data: 行；坏 JSON 请求返回错误回执', async () => {
    const server = await start(SCENARIO, 'sse');
    const response = await fetch(server.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_state', arguments: {} } }),
    });
    const raw = await response.text();
    expect(raw).toContain('data:');
    expect(raw).toContain('第1年夏2日 07:10');
    const broken = await fetch(server.endpoint, { method: 'POST', body: '{oops' });
    expect(await broken.text()).toContain('不是合法 JSON');
  });
});
