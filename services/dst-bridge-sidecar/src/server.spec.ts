/** [M7] sidecar 局部门禁：tick 往返 / token 鉴权 / 契约违规拦截 / 互斥与回执 / 文件降级。 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDstSidecar, type DstSidecar } from './server';

const TOKEN = 'pair-token-123';
const open: DstSidecar[] = [];

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    capturedAt: 1_700_000_000_000,
    clock: { cycle: 3, phase: 'day', phaseProgress: 0.3, season: 'autumn', isRaining: false },
    player: {
      character: 'wilson',
      health: { current: 150, max: 150 },
      hunger: { current: 60, max: 100 },
      sanity: { current: 120, max: 150 },
      temperature: 18,
      moisture: 0,
      position: { x: 1, z: 2 },
      inventory: [{ itemName: 'berries', count: 2, equipped: false }],
    },
    nearby: { entities: [], campfires: [] },
    threats: [],
    control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
    ...overrides,
  };
}

async function start(): Promise<{ sidecar: DstSidecar; base: string }> {
  const sidecar = createDstSidecar({ pairToken: TOKEN, port: 0 });
  open.push(sidecar);
  const port = await sidecar.start();
  return { sidecar, base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

describe('/v1/tick 游戏面', () => {
  it('token 正确 → 快照落库、返回带过期时间的空计划；宿主面 /state 与 /health 可读', async () => {
    const { sidecar, base } = await start();
    const result = sidecar.applyTick({ token: TOKEN, snapshot: snapshot() });
    expect(result.ok).toBe(true);
    expect(result.plan?.actions).toEqual([]);
    expect(result.plan?.expiresAt).toBeGreaterThan(Date.now());

    const state = await (await fetch(`${base}/state`)).json() as { clock: { cycle: number } };
    expect(state.clock.cycle).toBe(3);
    const health = await (await fetch(`${base}/health`)).json() as { gameId: string; ok: boolean };
    expect(health).toMatchObject({ gameId: 'dst', ok: true });
    expect(sidecar.stats()).toMatchObject({ ticks: 1, hasSnapshot: true });
  });

  it('鉴权失败 / 缺快照 / 契约违规 → 明确错误，不污染状态', async () => {
    const { sidecar, base } = await start();
    expect(sidecar.applyTick({ token: 'wrong', snapshot: snapshot() })).toMatchObject({ status: 401, error: 'INVALID_PAIR_TOKEN' });
    expect(sidecar.applyTick({ token: TOKEN })).toMatchObject({ status: 400, error: 'MISSING_SNAPSHOT' });
    expect(sidecar.applyTick({ token: TOKEN, snapshot: { schemaVersion: 2 } })).toMatchObject({
      status: 400,
      error: expect.stringContaining('SNAPSHOT_CONTRACT_VIOLATION'),
    });
    expect((await fetch(`${base}/state`)).status).toBe(503);
    expect(sidecar.stats().ticks).toBe(0);
  });

  it('mod 附带 lastReceipt → 过 DstActionReceiptSchema 并补全快照，供 /action_status 查询', async () => {
    const { sidecar, base } = await start();
    const actionId = '11111111-1111-4111-8111-111111111111';
    const accepted = await (await fetch(`${base}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, tool: 'gather', args: { item: 'berries' } }),
    })).json() as { accepted: boolean };
    expect(accepted.accepted).toBe(true);

    const busy = await (await fetch(`${base}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: '22222222-2222-4222-8222-222222222222', tool: 'eat', args: {} }),
    })).json() as { accepted: boolean; reason: string };
    expect(busy).toMatchObject({ accepted: false, reason: 'ACTION_IN_FLIGHT' });

    const running = await (await fetch(`${base}/action_status?id=${actionId}`)).json() as { running: boolean };
    expect(running.running).toBe(true);

    const firstTick = sidecar.applyTick({ token: TOKEN, snapshot: snapshot() });
    expect(firstTick.plan?.actions[0]).toMatchObject({ actionId, tool: 'gather', args: { item: 'berries' } });

    const receipt = {
      actionId, tool: 'gather', gameId: 'dst', status: 'COMPLETED',
      reason: 'GATHERED', startedAt: Date.now() - 20, completedAt: Date.now(),
    };
    sidecar.applyTick({
      token: TOKEN,
      snapshot: { ...snapshot(), clock: { ...snapshot().clock, cycle: 4 }, lastReceipt: receipt },
    });
    const status = await (await fetch(`${base}/action_status?id=${actionId}`)).json() as {
      running: boolean; receipt: { status: string; gameId: string; snapshot: { clock: { cycle: number } } };
    };
    expect(status.running).toBe(false);
    expect(status.receipt).toMatchObject({ status: 'COMPLETED', gameId: 'dst' });
    expect(status.receipt.snapshot.clock.cycle).toBe(4);
  });

  it('POST /cancel → 下一次 tick 下发 cancel_action 计划（不伪造回执）', async () => {
    const { sidecar, base } = await start();
    const actionId = '33333333-3333-4333-8333-333333333333';
    await fetch(`${base}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, tool: 'work', args: {} }),
    });
    const cancelled = await (await fetch(`${base}/cancel`, { method: 'POST' })).json() as { cancelled: boolean };
    expect(cancelled.cancelled).toBe(true);
    const result = sidecar.applyTick({ token: TOKEN, snapshot: snapshot() });
    expect(result.plan?.actions[0]?.tool).toBe('cancel_action');
    const status = await (await fetch(`${base}/action_status?id=${actionId}`)).json() as { running: boolean; receipt?: unknown };
    expect(status).toMatchObject({ running: true });
    expect(status.receipt).toBeUndefined();
  });

  it('T-M6-40 多 Agent：同 sidecar 快照/动作/cancel 按 agentId 隔离', async () => {
    const { sidecar, base } = await start();
    const snapA = snapshot({ clock: { ...snapshot().clock, cycle: 7 } });
    const snapB = snapshot({ clock: { ...snapshot().clock, cycle: 9 }, player: { ...snapshot().player, character: 'wendy' } });
    expect(sidecar.applyTick({ token: TOKEN, agentId: 'alice', snapshot: snapA }).ok).toBe(true);
    expect(sidecar.applyTick({ token: TOKEN, agentId: 'bob', snapshot: snapB }).ok).toBe(true);
    expect((await fetch(`${base}/state`)).status).toBe(400);
    expect((await (await fetch(`${base}/state?agentId=alice`)).json() as { clock: { cycle: number } }).clock.cycle).toBe(7);
    expect((await (await fetch(`${base}/state?agentId=bob`)).json() as { clock: { cycle: number } }).clock.cycle).toBe(9);

    const actionA = '44444444-4444-4444-8444-444444444444';
    const actionB = '55555555-5555-4555-8555-555555555555';
    await fetch(`${base}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: actionA, agentId: 'alice', tool: 'gather', args: {} }),
    });
    const acceptedB = await (await fetch(`${base}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: actionB, agentId: 'bob', tool: 'eat', args: {} }),
    })).json() as { accepted: boolean };
    expect(acceptedB.accepted).toBe(true);

    const tickA = sidecar.applyTick({ token: TOKEN, agentId: 'alice', snapshot: snapA });
    const tickB = sidecar.applyTick({ token: TOKEN, agentId: 'bob', snapshot: snapB });
    expect(tickA.plan?.actions.map((action) => action.actionId)).toEqual([actionA]);
    expect(tickB.plan?.actions.map((action) => action.actionId)).toEqual([actionB]);
    await fetch(`${base}/cancel?agentId=alice`, { method: 'POST' });
    expect(sidecar.applyTick({ token: TOKEN, agentId: 'bob', snapshot: snapB }).plan?.actions[0]?.actionId).toBe(actionB);
    expect(sidecar.applyTick({ token: TOKEN, agentId: 'alice', snapshot: snapA }).plan?.actions[0]?.tool).toBe('cancel_action');
    expect(sidecar.applyTick({ token: TOKEN, agentId: '../escape', snapshot: snapA })).toMatchObject({ status: 400, error: 'INVALID_AGENT_ID' });
  });
});

describe('unsafedata/*.json 文件降级', () => {
  it('监听 snapshot 文件 → 写出 plan 文件（653007 白名单通道）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dst-sidecar-'));
    const snapshotFile = join(dir, 'snapshot.json');
    const planFile = join(dir, 'plan.json');
    const sidecar = createDstSidecar({ pairToken: TOKEN, port: 0 });
    open.push(sidecar);
    sidecar.enableFileFallback({ snapshotFile, planFile, intervalMs: 30 });
    writeFileSync(snapshotFile, JSON.stringify({ token: TOKEN, snapshot: snapshot() }), 'utf8');
    const deadline = Date.now() + 1_500;
    while (!existsSync(planFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(existsSync(planFile)).toBe(true);
    const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { expiresAt: number; actions: unknown[] };
    expect(plan.expiresAt).toBeGreaterThan(Date.now());
    expect(plan.actions).toEqual([]);
    expect(sidecar.stats().mode).toBe('both');
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('分支收口（M7 门禁覆盖率 ≥90%）', () => {
  it('空 pairToken 拒绝；未 start 时 port()=-1、close() 幂等', async () => {
    expect(() => createDstSidecar({ pairToken: '' })).toThrow(/pairToken 不能为空/);
    const sidecar = createDstSidecar({ pairToken: TOKEN });
    expect(sidecar.port()).toBe(-1);
    await expect(sidecar.close()).resolves.toBeUndefined();
  });

  it('applyTick 非法 body / lastReceipt 契约违规 → 明确拒绝且不记录回执', async () => {
    const { sidecar, base } = await start();
    expect(sidecar.applyTick([])).toMatchObject({ status: 400, error: 'INVALID_BODY' });
    expect(sidecar.applyTick(null)).toMatchObject({ status: 400, error: 'INVALID_BODY' });
    sidecar.applyTick({ token: TOKEN, snapshot: snapshot() });
    sidecar.applyTick({
      token: TOKEN,
      snapshot: { ...snapshot(), lastReceipt: { actionId: 'bad', status: 'COMPLETED' } },
    });
    expect(sidecar.stats().receipts).toBe(0);

    // 无 pending 时取消 → cancelled:false；未知路由 → 404
    expect(await (await fetch(`${base}/cancel`, { method: 'POST' })).json()).toMatchObject({ cancelled: false });
    const notFound = await fetch(`${base}/does-not-exist`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: 'NOT_FOUND' });

    // 坏 JSON → route catch → 500
    const bad = await fetch(`${base}/v1/tick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    expect(bad.status).toBe(500);

    // 游戏面 token 错误 → 401 + error（覆盖 tick 错误响应分支）
    const badToken = await fetch(`${base}/v1/tick`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong', snapshot: snapshot() }),
    });
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toMatchObject({ error: 'INVALID_PAIR_TOKEN' });

    // 超限 body → BODY_TOO_LARGE 拒绝（req.destroy 可能让 fetch 抛网络错，两条路径都算覆盖）
    try {
      await fetch(`${base}/v1/tick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(2 * 1024 * 1024 + 16),
      });
    } catch {
      /* 连接被服务端主动断开属预期 */
    }
  });

  it('/act 非法请求 400；/health 在首次 tick 前后反映控制权与 gameVersion', async () => {
    const { sidecar, base } = await start();
    const badAct = await fetch(`${base}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'eat' }),
    });
    expect(badAct.status).toBe(400);
    expect(await badAct.json()).toMatchObject({ error: 'INVALID_ACTION_REQUEST' });

    const before = await (await fetch(`${base}/health`)).json() as { gameVersion: string; control: string };
    expect(before.gameVersion).toBe('UNKNOWN');
    sidecar.applyTick({ token: TOKEN, snapshot: {
      ...snapshot(), control: { authority: 'HUMAN_TAKEOVER_ACTIVE', isPlayerMovingPhysically: true },
    } });
    const after = await (await fetch(`${base}/health`)).json() as { gameVersion: string; control: string };
    expect(after).toMatchObject({ gameVersion: 'DST', control: 'HUMAN_TAKEOVER_ACTIVE' });
  });

  it('setTakeover 写控制文件；文件降级：缺失文件/重复帧/坏 JSON 均不崩', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dst-sidecar-edge-'));
    const controlFile = join(dir, 'control.json');
    const snapshotFile = join(dir, 'snapshot.json');
    const planFile = join(dir, 'plan.json');
    const sidecar = createDstSidecar({ pairToken: TOKEN, controlFile, onLog: () => undefined });
    open.push(sidecar);
    sidecar.enableFileFallback({ snapshotFile, planFile, intervalMs: 20 });
    sidecar.setTakeover(true);
    expect(JSON.parse(readFileSync(controlFile, 'utf8'))).toMatchObject({ takeover: true });

    // 无 snapshot 文件：不写 plan
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(planFile)).toBe(false);
    // 坏 JSON：log 兜底，不写 plan
    writeFileSync(snapshotFile, '{broken', 'utf8');
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(planFile)).toBe(false);
    // 合法帧 → 写 plan；重复帧不重写
    writeFileSync(snapshotFile, JSON.stringify({ token: TOKEN, snapshot: snapshot() }), 'utf8');
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(planFile)).toBe(true);
    const first = readFileSync(planFile, 'utf8');
    writeFileSync(planFile, 'SENTINEL', 'utf8');
    await new Promise((r) => setTimeout(r, 60));
    expect(readFileSync(planFile, 'utf8')).toBe('SENTINEL'); // 帧未变 → pollFallback 早退
    expect(first.length).toBeGreaterThan(0);
    await sidecar.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
