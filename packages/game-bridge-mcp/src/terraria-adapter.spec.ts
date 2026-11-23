/**
 * T-M7-T3~T6 门禁：泰拉瑞亚适配器的契约映射 / 回执分类 / 超时≠失败 /
 * UNCERTAIN 冷却 / 接管挂起 / 单日失败预算 / 工具白名单越权。
 * 全部用注入式 fetch 与假时钟，不依赖真机与网络。
 */
import { describe, expect, it } from 'vitest';
import {
  TerrariaActionReceiptSchema,
  TerrariaStateSnapshotSchema,
  type GameBridgeReceiptStatus,
  type TerrariaStateSnapshot,
} from '@workbench/shared-protocol';
import { gameAdapters } from './adapter';
import {
  TerrariaAdapter,
  TerrariaBridgeClient,
  TerrariaRulePlanner,
  TERRARIA_TOOL_WHITELIST,
  classifyTerrariaReceipt,
  extractTerrariaClock,
  isTerrariaToolAllowed,
  parseTerrariaState,
} from './terraria-adapter';

function makeState(overrides: {
  dayPhase?: TerrariaStateSnapshot['clock']['dayPhase'];
  hp?: number;
  lavaNearby?: boolean;
  boss?: boolean;
} = {}): TerrariaStateSnapshot {
  return TerrariaStateSnapshotSchema.parse({
    schemaVersion: 1,
    capturedAt: 1_000,
    clock: { dayCount: 3, isDay: overrides.dayPhase !== 'night', dayPhase: overrides.dayPhase ?? 'day', timeText: '07:30 AM', hardMode: false },
    player: {
      hp: overrides.hp ?? 200, hpMax: 200, mana: 90, manaMax: 100,
      position: { x: 100, y: 80 }, facing: 'right', buffs: [],
      inventory: [{ slot: 0, itemName: 'Pickaxe', stack: 1 }], selectedSlot: 0,
    },
    world: { biome: 'Forest', events: [], downedBosses: [] },
    nearby: {
      tiles: { originX: 95, originY: 75, width: 11, height: 5, legend: {}, rows: ['...........'] },
      npcs: overrides.boss
        ? [{ name: 'Eye of Cthulhu', hp: 1000, hpMax: 1000, position: { x: 102, y: 78 }, isHostile: true, isBoss: true }]
        : [],
      items: [],
    },
    danger: { lavaNearby: overrides.lavaNearby ?? false, fallingDanger: false, threatLevel: overrides.lavaNearby ? 'critical' : 'safe' },
    control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
  });
}

function receiptText(status: GameBridgeReceiptStatus, reason?: string, actionId = '11111111-1111-4111-8111-111111111111'): string {
  return JSON.stringify(TerrariaActionReceiptSchema.parse({
    actionId, tool: 'mine', gameId: 'terraria', status,
    ...(reason ? { reason } : {}), startedAt: 1, completedAt: 2,
  }));
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type MockHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const toFetch = (handler: MockHandler): typeof fetch =>
  (async (input: string | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;

/** PlannerDecision 是判别联合：act 才有 tool，wait/stop 才有 reason */
const toolOf = (d: { kind: string; tool?: string }): string | undefined => (d.kind === 'act' ? d.tool : undefined);
const reasonOf = (d: { kind: string; reason?: string }): string | undefined => d.reason;

function plannerState(overrides: Parameters<typeof makeState>[0] = {}) {
  const snap = makeState(overrides);
  return parseTerrariaState(JSON.stringify(snap));
}

describe('TerrariaAdapter（结构化快照映射 / 时钟 / 长动作表 / 白名单 / 探活）', () => {
  it('gameId / 白名单规模 / 长动作表 / 不可达文案', () => {
    const adapter = new TerrariaAdapter();
    expect(adapter.gameId).toBe('terraria');
    expect(adapter.displayName).toBe('泰拉瑞亚');
    expect(TERRARIA_TOOL_WHITELIST.length).toBeGreaterThanOrEqual(30);
    expect(adapter.toolWhitelist).toBe(TERRARIA_TOOL_WHITELIST);
    expect(adapter.isLongAction('mine')).toBe(true);
    expect(adapter.isLongAction('build_shelter')).toBe(true);
    expect(adapter.isLongAction('say')).toBe(false);
    expect(adapter.unreachableMessage).toContain('18090');
  });

  it('parseState 把结构化 JSON 无损映射为编排器状态；extractClock 取 dayCount+昼夜', () => {
    const adapter = new TerrariaAdapter();
    const raw = JSON.stringify(makeState({ hp: 45, dayPhase: 'dusk' }));
    const state = adapter.parseState(raw);
    expect(state.gameClock).toContain('第 3 天');
    expect(state.day).toBe(3);
    expect(state.health).toBe(45);
    expect(state.healthMax).toBe(200);
    expect(state.stamina).toBe(90); // mana → stamina 槽位
    expect(state.posX).toBe(100);
    expect(state.money).toBe(0);
    expect(state.freeSlots).toBe(39);
    expect(adapter.extractClock(raw)).toBe('day-3-day-dusk');
    expect(extractTerrariaClock('not json')).toBeNull();
  });

  it('ping 走 GET /health；不通/非 JSON 返回 false', async () => {
    const okAdapter = new TerrariaAdapter('http://x:18090', toFetch((url) => {
      expect(url).toBe('http://x:18090/health');
      return jsonResponse({ ok: true, gameId: 'terraria', bridgeVersion: '1', gameVersion: '1.4.4.9', control: 'AI_AUTOPILOT' });
    }));
    expect(await okAdapter.ping()).toBe(true);
    const badAdapter = new TerrariaAdapter('http://x:18090', toFetch(() => jsonResponse({}, 503)));
    expect(await badAdapter.ping()).toBe(false);
  });

  it('模块加载已把 terraria 工厂登记进全局注册表', () => {
    expect(gameAdapters.has('terraria')).toBe(true);
    expect(gameAdapters.create('terraria', { endpoint: 'http://x:1' })).toBeInstanceOf(TerrariaAdapter);
  });
});

describe('classifyTerrariaReceipt（结构化四态 + 超时独立成态）', () => {
  it('COMPLETED / UNCERTAIN / FAILED 按 status 分类，reason 透出', () => {
    expect(classifyTerrariaReceipt({ text: receiptText('COMPLETED'), kind: 'ok', isError: false, tool: 'mine' }).status).toBe('COMPLETED');
    const uncertain = classifyTerrariaReceipt({ text: receiptText('UNCERTAIN', 'PATH_BLOCKED_PERSISTENT'), kind: 'ok', isError: true, tool: 'mine' });
    expect(uncertain.status).toBe('UNCERTAIN');
    expect(uncertain.summary).toContain('PATH_BLOCKED_PERSISTENT');
    const failed = classifyTerrariaReceipt({ text: receiptText('FAILED', 'BOSS_LOW_HP_RETREAT'), kind: 'ok', isError: true, tool: 'mine' });
    expect(failed.status).toBe('FAILED');
    expect(failed.summary).toContain('BOSS_LOW_HP_RETREAT');
  });

  it('接管映射为 FAILED，但 summary 保留 ABORTED_BY_HUMAN_TAKEOVER 显式字样', () => {
    const c = classifyTerrariaReceipt({ text: receiptText('ABORTED_BY_HUMAN_TAKEOVER', 'PLAYER_PHYSICAL_INPUT_DETECTED'), kind: 'ok', isError: true, tool: 'mine' });
    expect(c.status).toBe('FAILED');
    expect(c.summary).toContain('ABORTED_BY_HUMAN_TAKEOVER');
    expect(c.summary).toContain('PLAYER_PHYSICAL_INPUT_DETECTED');
  });

  it('timeout ≠ failed；error 透出消息；非 JSON 回落文本分类', () => {
    expect(classifyTerrariaReceipt({ text: '', kind: 'timeout', isError: false, tool: 'mine' })).toMatchObject({ status: 'TIMEOUT' });
    expect(classifyTerrariaReceipt({ text: '', kind: 'error', isError: false, tool: 'mine', errorMessage: '连接被拒' }).summary).toBe('连接被拒');
    expect(classifyTerrariaReceipt({ text: 'UNCERTAIN 石头挡路', kind: 'ok', isError: true, tool: 'move_to' }).status).toBe('UNCERTAIN');
    expect(classifyTerrariaReceipt({ text: '成功：挖到矿', kind: 'ok', isError: false, tool: 'mine' })).toMatchObject({ status: 'COMPLETED' });
  });
});

describe('TerrariaBridgeClient（两段式协议 / 超时 / 白名单）', () => {
  it('POST /act 受理 → 轮询 /action_status → 结构化 COMPLETED 回执', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const calls: string[] = [];
    const client = new TerrariaBridgeClient('http://x:18090', toFetch((url, init) => {
      calls.push(url);
      if (url.endsWith('/act')) {
        const body = JSON.parse(String(init?.body)) as { actionId: string; tool: string };
        expect(body).toMatchObject({ actionId: id, tool: 'mine' });
        return jsonResponse({ accepted: true, actionId: id });
      }
      if (url.includes('/action_status')) return jsonResponse({ actionId: id, running: true });
      throw new Error(`unexpected ${url}`);
    }), { pollIntervalMs: 1, maxWaitMs: 20, idFactory: () => id, now: () => 0, sleep: async () => undefined });
    // 第一次轮询 running=true，第二次给回执
    let poll = 0;
    const clientWithReceipt = new TerrariaBridgeClient('http://x:18090', toFetch((url) => {
      if (url.endsWith('/act')) return jsonResponse({ accepted: true, actionId: id });
      poll++;
      return jsonResponse(poll < 2 ? { actionId: id, running: true } : { actionId: id, running: false, receipt: JSON.parse(receiptText('COMPLETED')) });
    }), { pollIntervalMs: 1, maxWaitMs: 100, idFactory: () => id, now: () => 0, sleep: async () => undefined });
    void client; void calls;
    const result = await clientWithReceipt.callTool('mine');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(classifyTerrariaReceipt({ text: result.text, kind: 'ok', isError: result.isError, tool: 'mine' }).status).toBe('COMPLETED');
  });

  it('busy（ACTION_IN_FLIGHT）作为 error 返回，不误报动作失败也不重发', async () => {
    const client = new TerrariaBridgeClient('http://x:18090', toFetch(() => jsonResponse({ accepted: false, reason: 'ACTION_IN_FLIGHT' })), { idFactory: () => '33333333-3333-4333-8333-333333333333' });
    const result = await client.callTool('mine');
    expect(result).toMatchObject({ kind: 'error', message: 'ACTION_IN_FLIGHT' });
  });

  it('超时返回 kind=timeout（绝不写 FAILED），分类后仍为 TIMEOUT', async () => {
    let t = 0;
    const client = new TerrariaBridgeClient('http://x:18090', toFetch((url) => {
      if (url.endsWith('/act')) return jsonResponse({ accepted: true, actionId: '44444444-4444-4444-8444-444444444444' });
      return jsonResponse({ actionId: '44444444-4444-4444-8444-444444444444', running: true }); // 永远在途
    }), { pollIntervalMs: 1, maxWaitMs: 30, now: () => (t += 10), sleep: async () => undefined, idFactory: () => '44444444-4444-4444-8444-444444444444' });
    const result = await client.callTool('mine');
    expect(result.kind).toBe('timeout');
    expect(classifyTerrariaReceipt({ text: '', kind: result.kind, isError: false, tool: 'mine' }).status).toBe('TIMEOUT');
  });

  it('白名单越权：连 HTTP 请求都不发，直接 TOOL_NOT_IN_WHITELIST', async () => {
    let called = 0;
    const client = new TerrariaBridgeClient('http://x:18090', toFetch(() => { called++; return jsonResponse({}); }));
    expect(isTerrariaToolAllowed('grant_admin')).toBe(false);
    expect(isTerrariaToolAllowed('set_time')).toBe(false);
    expect(await client.callTool('grant_admin')).toMatchObject({ kind: 'error' });
    expect((await client.callTool('grant_admin') as { message?: string }).message).toContain('TOOL_NOT_IN_WHITELIST');
    expect(called).toBe(0);
  });
});

describe('TerrariaRulePlanner（零 token 兜底 + UNCERTAIN 冷却 + 接管 + 单日预算）', () => {
  it('白天建设链：砍树 → 掩体 → 火把 → 挖矿；夜里守夜', async () => {
    const planner = new TerrariaRulePlanner({ now: () => 1_000 });
    const day = plannerState();
    expect(toolOf(await planner.decide(day))).toBe('mine'); // gather
    expect(toolOf(await planner.decide(day))).toBe('build_shelter');
    expect(toolOf(await planner.decide(day))).toBe('torch');
    const night = plannerState({ dayPhase: 'night' });
    expect(toolOf(await planner.decide(night))).toBe('wait');
  });

  it('低血喝药 / 岩浆跳跃 / Boss 撤退三条 P0 反射', async () => {
    const planner = new TerrariaRulePlanner({ now: () => 1_000 });
    expect(toolOf(await planner.decide(plannerState({ hp: 40 })))).toBe('drink_potion');
    expect(toolOf(await planner.decide(plannerState({ lavaNearby: true })))).toBe('jump');
    expect(toolOf(await planner.decide(plannerState({ boss: true })))).toBe('flee');
  });

  it('UNCERTAIN 冷却：同一工具短时间内不重试，超过冷却窗口才恢复', async () => {
    let t = 1_000;
    const planner = new TerrariaRulePlanner({ now: () => t, uncertainCooldownMs: 5_000 });
    const state = plannerState();
    for (let i = 0; i < 3; i++) await planner.decide(state); // 推进到 work 阶段，候选为 mine
    expect(toolOf(await planner.decide(state))).toBe('mine');
    planner.noteReceipt('mine', 'UNCERTAIN');
    expect(planner.isCoolingDown('mine')).toBe(true);
    expect((await planner.decide(state)).kind).toBe('wait'); // 冷却期间不重发 mine
    t += 5_001;
    expect(planner.isCoolingDown('mine')).toBe(false);
    expect(toolOf(await planner.decide(state))).toBe('mine'); // 冷却结束后恢复
  });

  it('接管：ABORTED 回执后 AI 挂起等待交还（静默 reacquire）', async () => {
    let t = 1_000;
    const planner = new TerrariaRulePlanner({ now: () => t, takeoverHoldMs: 8_000 });
    planner.noteReceipt('mine', 'ABORTED_BY_HUMAN_TAKEOVER');
    const held = await planner.decide(plannerState());
    expect(held.kind).toBe('wait');
    expect(reasonOf(held)).toContain('接管');
    t += 8_001;
    expect((await planner.decide(plannerState())).kind).toBe('act');
  });

  it('单日失败预算：同工具当日失败 3 次后当日不再选择它', async () => {
    const planner = new TerrariaRulePlanner({ now: () => 1_000, maxFailuresPerDay: 3 });
    const state = plannerState();
    for (let i = 0; i < 3; i++) await planner.decide(state); // 到 work 阶段
    for (let i = 0; i < 3; i++) planner.noteReceipt('mine', 'FAILED', 3);
    expect(planner.failuresToday('mine', 3)).toBe(3);
    expect((await planner.decide(state)).kind).toBe('wait');
    // 次日预算归零后重新可用
    const nextDay = parseTerrariaState(JSON.stringify(TerrariaStateSnapshotSchema.parse({
      ...JSON.parse(state.raw) as TerrariaStateSnapshot,
      clock: { dayCount: 4, isDay: true, dayPhase: 'day', timeText: '07:30 AM', hardMode: false },
    })));
    expect(toolOf(await planner.decide(nextDay))).toBe('mine');
  });

  it('规划器产出的工具全部落在白名单内', async () => {
    const planner = new TerrariaRulePlanner({ now: () => 1_000 });
    const states = [plannerState(), plannerState({ hp: 40 }), plannerState({ lavaNearby: true }), plannerState({ boss: true }), plannerState({ dayPhase: 'night' })];
    for (const s of states) {
      const d = await planner.decide(s);
      if (d.kind === 'act') expect(isTerrariaToolAllowed(d.tool)).toBe(true);
    }
  });
});
