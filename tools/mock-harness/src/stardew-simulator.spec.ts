import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  StardewMcpSimulator,
  createSimulatorClient,
  type ScenarioId,
  type SimulatorClient,
} from './stardew-simulator';

/** [SIMULATION] T-M0-04 门禁：5 个标准剧本 + 互斥锁 + 接管时序 + 契约校验，3 秒内跑完 */

let sim: StardewMcpSimulator;
let client: SimulatorClient;

beforeEach(() => {
  sim = new StardewMcpSimulator('normal_farming');
});

afterEach(() => {
  client?.close();
  sim?.close();
});

async function start(scenario: ScenarioId): Promise<void> {
  sim = new StardewMcpSimulator(scenario);
  const url = await sim.start();
  client = createSimulatorClient(url);
}

describe('剧本 ① normal_farming（正常种地浇水）', () => {
  it('连续动作 COMPLETED 且体力按表结算', async () => {
    await start('normal_farming');
    const move = await client.act('move_to_tile', { x: 60, y: 19 });
    expect(move.status).toBe('COMPLETED');
    const water = await client.act('water_crops_batch');
    expect(water.status).toBe('COMPLETED');
    expect(water.gameStateSnapshot.staminaCurrent).toBe(200 - 5 - 20);
    const trash = await client.act('check_trash_can');
    expect(trash.status).toBe('COMPLETED');
  });

  it('动作互斥锁：在飞动作未结算时并发请求被拒', async () => {
    await start('normal_farming');
    const first = client.act('water_crops_batch');
    await expect(client.act('check_trash_can')).rejects.toThrow('ACTION_IN_FLIGHT');
    expect((await first).status).toBe('COMPLETED');
  });

  it('未知方法与坏 JSON 返回 JSON-RPC 错误', async () => {
    await start('normal_farming');
    const unknown = await client.raw({ method: 'stardew/nope' });
    expect((unknown.error as { code: number }).code).toBe(-32601);
    const broken = await client.raw({ method: 'stardew/act' });
    expect((broken.error as { code: number }).code).toBe(-32602);
    // 非 JSON 载荷 → -32700（直连原始 socket，绕过客户端序列化）
    const url = (sim as unknown as { wss: { address: () => { port: number } } }).wss.address();
    const bad = await new Promise<Record<string, unknown>>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${url.port}/mcp`);
      socket.on('open', () => socket.send('not-json'));
      socket.on('message', (data: unknown) => {
        socket.close();
        resolve(JSON.parse(String(data)) as Record<string, unknown>);
      });
    });
    expect((bad.error as { code: number }).code).toBe(-32700);
  });
});

describe('剧本 ② path_blocked（寻路卡石头）', () => {
  it('UNCERTAIN 两次后转 FAILED（防死循环）', async () => {
    await start('path_blocked');
    const first = await client.act('move_to_tile', { x: 64, y: 15 });
    expect(first.status).toBe('UNCERTAIN');
    expect(first.failureOrUncertainReason).toBe('PATH_BLOCKED_BY_STONE');
    const second = await client.act('move_to_tile', { x: 64, y: 15 });
    expect(second.status).toBe('UNCERTAIN');
    const third = await client.act('move_to_tile', { x: 64, y: 15 });
    expect(third.status).toBe('FAILED');
    expect(third.failureOrUncertainReason).toBe('PATH_BLOCKED_PERSISTENT');
  });

  it('未阻塞瓦片正常 COMPLETED', async () => {
    await start('path_blocked');
    expect((await client.act('move_to_tile', { x: 58, y: 20 })).status).toBe('COMPLETED');
  });
});

describe('剧本 ③ stamina_exhausted（体力耗尽）', () => {
  it('体力归零拒绝劳作，过夜恢复', async () => {
    await start('stamina_exhausted');
    const fail = await client.act('water_crops_batch');
    expect(fail.status).toBe('FAILED');
    expect(fail.failureOrUncertainReason).toBe('STAMINA_EXHAUSTED');
    const sleep = await client.act('go_to_sleep');
    expect(sleep.status).toBe('COMPLETED');
    expect(sleep.gameStateSnapshot.dayOfMonth).toBe(4);
    expect(sleep.gameStateSnapshot.staminaCurrent).toBe(270);
    expect(sleep.gameStateSnapshot.timeOfDay).toBe(600);
    // 过夜后恢复劳作
    expect((await client.act('water_crops_batch')).status).toBe('COMPLETED');
  });
});

describe('剧本 ④ player_takeover（键鼠一动即接管）', () => {
  it('在飞动作 <100ms 被中止，后续动作全部拒绝', async () => {
    await start('player_takeover');
    const inFlight = client.act('move_to_tile', { x: 55, y: 12 });
    const startedAt = performance.now();
    sim.setPhysicalInput(true);
    const aborted = await inFlight;
    const latencyMs = performance.now() - startedAt;
    expect(aborted.status).toBe('ABORTED_BY_HUMAN_TAKEOVER');
    expect(aborted.failureOrUncertainReason).toBe('PLAYER_PHYSICAL_INPUT_DETECTED');
    expect(aborted.gameStateSnapshot.isPlayerMovingPhysically).toBe(true);
    // 0.1s 接管铁律
    expect(latencyMs).toBeLessThan(100);
    const rejected = await client.act('water_crops_batch');
    expect(rejected.status).toBe('ABORTED_BY_HUMAN_TAKEOVER');
    // 交还控制权后恢复
    sim.setPhysicalInput(false);
    expect((await client.act('water_crops_batch')).status).toBe('COMPLETED');
  });
});

describe('剧本 ⑤ mine_low_hp（矿洞丝血）', () => {
  it('丝血强制撤退，进食回血后恢复作业', async () => {
    await start('mine_low_hp');
    const withdraw = await client.act('use_tool_on_tile');
    expect(withdraw.status).toBe('FAILED');
    expect(withdraw.failureOrUncertainReason).toBe('HEALTH_CRITICAL_WITHDRAW');
    const eat = await client.act('eat_food_for_stamina');
    expect(eat.status).toBe('COMPLETED');
    expect(eat.gameStateSnapshot.healthCurrent).toBe(100);
    expect((await client.act('use_tool_on_tile')).status).toBe('COMPLETED');
  });
});

describe('[SIMULATION] 门禁时序（ROADMAP：3 秒内跑完 5 剧本）', () => {
  it('五个剧本顺序执行总耗时 <3000ms', async () => {
    const scenarios = ['normal_farming', 'path_blocked', 'stamina_exhausted', 'player_takeover', 'mine_low_hp'] as const;
    const started = performance.now();
    for (const scenario of scenarios) {
      const s = new StardewMcpSimulator(scenario);
      const url = await s.start();
      const c = createSimulatorClient(url);
      await c.act('move_to_tile', scenario === 'path_blocked' ? { x: 64, y: 15 } : { x: 55, y: 10 });
      c.close();
      s.close();
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
