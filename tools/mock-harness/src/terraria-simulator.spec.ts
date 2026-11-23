import { afterEach, describe, expect, it } from 'vitest';
import type { GameBridgeReceipt, GameBridgeReceiptStatus } from '@workbench/shared-protocol';
import {
  TerrariaSimulator,
  createTerrariaSimClient,
  type TerrariaScenarioId,
  type TerrariaSimClient,
} from './terraria-simulator';

/** [SIMULATION] T-M7-T1 门禁：5 剧本 + 互斥锁 + 超时≠失败 + 接管时序，全部 3 秒内跑完 */

let sim: TerrariaSimulator | null = null;
let baseUrl = '';

afterEach(() => {
  sim?.close();
  sim = null;
});

async function start(
  scenario: TerrariaScenarioId,
  opts?: { actionDelayMs?: number; now?: () => number },
): Promise<TerrariaSimClient> {
  sim = new TerrariaSimulator(scenario, opts);
  baseUrl = await sim.start();
  return createTerrariaSimClient(baseUrl);
}

/** 轮询 action_status 直到拿到回执（收到 receipt 即返回；绝不按"客户端超时"改写状态） */
async function waitReceipt(client: TerrariaSimClient, actionId: string, timeoutMs = 1_500): Promise<GameBridgeReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await client.status(actionId);
    if (s.receipt) return s.receipt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`action_status 超时未出回执：${actionId}`);
}

async function runAction(client: TerrariaSimClient, tool: string, args: Record<string, unknown> = {}): Promise<GameBridgeReceipt> {
  const accepted = await client.act(tool, args);
  expect(accepted.accepted).toBe(true);
  if (!accepted.actionId) throw new Error('受理回执缺少 actionId');
  return waitReceipt(client, accepted.actionId);
}

describe('剧本 ① normal_mining（正常挖矿 + 走位）', () => {
  it('挖矿/走位 COMPLETED 且快照经契约校验、位置按步推进', async () => {
    const client = await start('normal_mining');
    const health = await client.health();
    expect(health).toMatchObject({ ok: true, gameId: 'terraria', gameVersion: '1.4.4.9' });
    const state = await client.state();
    expect(state.player.position).toEqual({ x: 120, y: 80 });

    const mine = await runAction(client, 'mine', { x: 122, y: 81 });
    expect(mine.status).toBe('COMPLETED');
    expect(mine.tool).toBe('mine');
    // 富快照走 GET /state（action_status 的 receipt 按契约是 GameBridgeReceiptSchema 基形，不含 snapshot）
    expect((await client.state()).schemaVersion).toBe(1);

    const move = await runAction(client, 'move_to', { dx: 2, dy: 0 });
    expect(move.status).toBe('COMPLETED');
    expect((await client.state()).player.position.x).toBe(122);
  });

  it('回执时间注入式确定性：同一假时钟两次运行 startedAt/completedAt 完全一致', async () => {
    const fixed = () => 1_000_000;
    const c1 = await start('normal_mining', { now: fixed });
    const r1 = await runAction(c1, 'mine');
    sim?.close();
    const c2 = await start('normal_mining', { now: fixed });
    const r2 = await runAction(c2, 'mine');
    expect(r1.startedAt).toBe(1_000_000);
    expect(r2.startedAt).toBe(r1.startedAt);
    expect(r2.completedAt).toBe(r1.completedAt);
  });
});

describe('剧本 ② cave_stuck（洞穴卡死）', () => {
  it('UNCERTAIN ×2 → FAILED(PATH_BLOCKED_PERSISTENT)，防死循环', async () => {
    const client = await start('cave_stuck');
    const first = await runAction(client, 'mine', { x: 122, y: 201 });
    expect(first.status).toBe('UNCERTAIN');
    expect(first.reason).toBe('PATH_BLOCKED_BY_STONE');
    const second = await runAction(client, 'mine', { x: 122, y: 201 });
    expect(second.status).toBe('UNCERTAIN');
    const third = await runAction(client, 'mine', { x: 122, y: 201 });
    expect(third.status).toBe('FAILED');
    expect(third.reason).toBe('PATH_BLOCKED_PERSISTENT');
    // 失败后计数归零：下一轮重新给两次 UNCERTAIN 机会（可恢复而非永久死锁）
    expect((await runAction(client, 'mine')).status).toBe('UNCERTAIN');
  });
});

describe('剧本 ③ lava_survival（岩浆生存反射中断）', () => {
  it('在飞挖矿被生存反射打断 → UNCERTAIN(LAVA_ESCAPE_TRIGGERED)，逃生动作 COMPLETED', async () => {
    const client = await start('lava_survival', { actionDelayMs: 150 });
    const accepted = await client.act('mine', { x: 120, y: 205 });
    expect(accepted.actionId).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20)); // 让服务端进入在飞窗口
    sim!.triggerSurvivalReflex();
    const interrupted = await waitReceipt(client, accepted.actionId!);
    expect(interrupted.status).toBe('UNCERTAIN');
    expect(interrupted.reason).toBe('LAVA_ESCAPE_TRIGGERED');
    expect((await client.state()).danger.lavaNearby).toBe(true);

    const jump = await runAction(client, 'jump');
    expect(jump.status).toBe('COMPLETED');
    const potion = await runAction(client, 'drink_potion');
    expect(potion.status).toBe('COMPLETED');
    // 自动反射路径：非逃生动作即使未被主动打断也不假装完成
    const auto = await runAction(client, 'mine');
    expect(auto.status).toBe('UNCERTAIN');
    expect(auto.reason).toBe('LAVA_ESCAPE_TRIGGERED');
  });
});

describe('剧本 ④ player_takeover（F8 玩家接管）', () => {
  it('在飞动作 <100ms ABORTED，后续动作立即 ABORTED，交还后恢复', async () => {
    const client = await start('player_takeover', { actionDelayMs: 250 });
    const accepted = await client.act('mine', { x: 121, y: 82 });
    const actionId = accepted.actionId!;
    await new Promise((resolve) => setTimeout(resolve, 20)); // 确保服务端已进入在飞窗口
    const startedAt = performance.now();
    sim!.setPhysicalInput(true); // setPhysicalInput 同步写回执，无额外等待
    const aborted = await waitReceipt(client, actionId);
    const latencyMs = performance.now() - startedAt;
    expect(aborted.status).toBe('ABORTED_BY_HUMAN_TAKEOVER');
    expect(aborted.reason).toBe('PLAYER_PHYSICAL_INPUT_DETECTED');
    expect((await client.state()).control.isPlayerMovingPhysically).toBe(true);
    expect(latencyMs).toBeLessThan(100);

    const rejected = await runAction(client, 'mine');
    expect(rejected.status).toBe('ABORTED_BY_HUMAN_TAKEOVER');
    sim!.setPhysicalInput(false);
    expect((await runAction(client, 'mine')).status).toBe('COMPLETED');
  });
});

describe('剧本 ⑤ boss_low_hp（Boss 低血撤退）', () => {
  it('非撤退动作 FAILED，喝药回血 + 撤退 COMPLETED', async () => {
    const client = await start('boss_low_hp');
    const state = await client.state();
    expect(state.player.hp).toBe(45);
    expect(state.nearby.npcs[0]?.isBoss).toBe(true);

    const greedy = await runAction(client, 'mine');
    expect(greedy.status).toBe('FAILED');
    expect(greedy.reason).toBe('BOSS_LOW_HP_RETREAT');

    const potion = await runAction(client, 'drink_potion');
    expect(potion.status).toBe('COMPLETED');
    expect((await client.state()).player.hp).toBe(130);
    const flee = await runAction(client, 'flee');
    expect(flee.status).toBe('COMPLETED');
  });
});

describe('统一协议护栏', () => {
  it('互斥锁：在飞期间重复 POST /act → accepted=false, ACTION_IN_FLIGHT', async () => {
    const client = await start('normal_mining', { actionDelayMs: 600 }); // 全量并行负载下留足在飞窗口
    const first = await client.act('mine');
    expect(first.accepted).toBe(true);
    const second = await client.act('jump');
    expect(second).toMatchObject({ accepted: false, reason: 'ACTION_IN_FLIGHT' });
    expect((await waitReceipt(client, first.actionId!)).status).toBe('COMPLETED');
  });

  it('超时 ≠ 失败：客户端放弃轮询后服务端仍独立结算为 COMPLETED', async () => {
    const client = await start('normal_mining', { actionDelayMs: 400 }); // 客户端 30ms 放弃时动作必须仍在途
    const accepted = await client.act('mine');
    const id = accepted.actionId!;
    const nominalClientTimeoutMs = 30; // 模拟客户端 30ms 超时放弃
    await new Promise((resolve) => setTimeout(resolve, nominalClientTimeoutMs));
    expect((await client.status(id)).running).toBe(true); // 放弃时仍在途
    await new Promise((resolve) => setTimeout(resolve, 100)); // 客户端已超时，服务端继续结算
    const final = await waitReceipt(client, id);
    expect(final.status).toBe('COMPLETED'); // 绝不因客户端超时写成 FAILED
    expect((await client.status(id)).running).toBe(false);
  });

  it('POST /cancel 取消在飞动作 → UNCERTAIN(CANCELLED_BY_HOST)，非 FAILED', async () => {
    const client = await start('normal_mining', { actionDelayMs: 200 });
    const accepted = await client.act('mine');
    expect(await client.cancel()).toEqual({ cancelled: true });
    expect(await client.cancel()).toEqual({ cancelled: false }); // 幂等
    const receipt = await waitReceipt(client, accepted.actionId!);
    expect(receipt.status).toBe('UNCERTAIN');
    expect(receipt.reason).toBe('CANCELLED_BY_HOST');
  });

  it('无效请求 400 + INVALID_REQUEST；未知接口 404', async () => {
    await start('normal_mining');
    // 直连 fetch 覆盖坏请求与未知路由（客户端封装始终发合法请求）
    const bad = await fetch(`${baseUrl}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'mine' }), // 缺 actionId → Schema 拒绝
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ accepted: false, reason: 'INVALID_REQUEST' });
    const missing = await fetch(`${baseUrl}/action_status`); // 缺 id 查询参数
    expect(missing.status).toBe(400);
    const unknown = await fetch(`${baseUrl}/nope`);
    expect(unknown.status).toBe(404);
  });
});

describe('[SIMULATION] 门禁时序（5 剧本顺序执行总耗时 <3000ms）', () => {
  it('五个剧本全部跑通且总耗时 <3000ms', async () => {
    const scenarios: TerrariaScenarioId[] = [
      'normal_mining', 'cave_stuck', 'lava_survival', 'player_takeover', 'boss_low_hp',
    ];
    const started = performance.now();
    for (const scenario of scenarios) {
      const client = await start(scenario);
      const first = await runAction(client, scenario === 'boss_low_hp' ? 'drink_potion' : 'mine');
      expect(['COMPLETED', 'UNCERTAIN', 'FAILED']).toContain(first.status as GameBridgeReceiptStatus);
      sim?.close();
      sim = null;
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
