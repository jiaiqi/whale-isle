/** [M7] DST adapter 局部门禁：统一协议映射 / 契约解析 / 四态分类 / 卡死时钟 / 零 token 规则护栏。 */
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { gameAdapters } from './adapter';
import {
  classifyDstReceipt,
  DST_TOOL_WHITELIST,
  DstAdapter,
  DstBridgeTransport,
  DstRulePlanner,
  extractDstClock,
  parseDstState,
} from './dst-adapter';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    capturedAt: 1_700_000_000_000,
    clock: { cycle: 3, phase: 'dusk', phaseProgress: 0.8, season: 'autumn', isRaining: false },
    player: {
      character: 'wilson',
      health: { current: 150, max: 150 },
      hunger: { current: 60, max: 100 },
      sanity: { current: 120, max: 150 },
      temperature: 18,
      moisture: 0,
      position: { x: 12, z: -8 },
      inventory: [{ itemName: 'berries', count: 2, equipped: false }],
    },
    nearby: { entities: [], campfires: [{ position: { x: 11, z: -9 }, fuelPercent: 0.8 }] },
    threats: [],
    control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
    ...overrides,
  };
}

function stateFrom(s: ReturnType<typeof snapshot>) {
  return parseDstState(JSON.stringify(s));
}

interface FakeOptions {
  statusMode?: 'complete' | 'running' | 'busy' | 'complete-after-first';
  health?: { ok: boolean };
}

async function startFake(options: FakeOptions = {}): Promise<{ base: string; close: () => void; polls: () => number }> {
  let polls = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };
    if (url.pathname === '/state') return reply(200, snapshot());
    if (url.pathname === '/health') return reply(200, options.health ?? { ok: true, gameId: 'dst', bridgeVersion: 'x', control: 'AI_AUTOPILOT' });
    if (url.pathname === '/act') {
      req.resume();
      return reply(200, options.statusMode === 'busy' ? { accepted: false, reason: 'ACTION_IN_FLIGHT' } : { accepted: true });
    }
    if (url.pathname === '/cancel') { req.resume(); return reply(200, { cancelled: true }); }
    if (url.pathname === '/action_status') {
      polls++;
      if (options.statusMode === 'running' || (options.statusMode === 'complete-after-first' && polls === 1)) {
        return reply(200, { actionId: url.searchParams.get('id'), running: true });
      }
      return reply(200, {
        actionId: url.searchParams.get('id'),
        running: false,
        receipt: {
          actionId: url.searchParams.get('id'), tool: 'gather', gameId: 'dst', status: 'COMPLETED',
          reason: 'GATHERED', startedAt: Date.now() - 10, completedAt: Date.now(),
        },
      });
    }
    return reply(404, { error: 'NOT_FOUND' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return { base: `http://127.0.0.1:${addr.port}`, close: () => server.close(), polls: () => polls };
}

describe('DstAdapter（GameAdapter 契约）', () => {
  it('模块加载即注册 dst；长动作表 / 白名单 / 不可达提示 / ping 全部就位', async () => {
    expect(gameAdapters.has('dst')).toBe(true);
    expect(gameAdapters.list()).toContain('dst');
    const adapter = gameAdapters.create('dst', { endpoint: 'http://127.0.0.1:19999' });
    expect(adapter).toBeInstanceOf(DstAdapter);
    expect(adapter.gameId).toBe('dst');
    expect(adapter.displayName).toContain('饥荒');
    expect(adapter.toolWhitelist?.length).toBeGreaterThanOrEqual(28);
    expect(DST_TOOL_WHITELIST).toContain('place_campfire');
    expect(adapter.isLongAction('gather')).toBe(true);
    expect(adapter.isLongAction('eat')).toBe(false);
    expect(adapter.unreachableMessage).toContain('19999');
    expect(adapter.unreachableMessage).toContain('cluster_token.txt');
    expect(await adapter.ping()).toBe(false);
  });

  it('parseState 映射结构化快照；extractClock 不含 capturedAt（卡死哨兵可触发）', () => {
    const s = snapshot();
    const state = parseDstState(JSON.stringify(s));
    expect(state.gameClock).toContain('第3轮');
    expect(state.gameClock).toContain('黄昏');
    expect(state.gameClock).not.toContain('未知');
    expect(state.clockMinutes).toBeGreaterThan(18 * 60);
    expect(state.health).toBe(150);
    expect(state.location).toBe('X12 Z-8');
    expect(state.weather).toBe('晴');
    expect(extractDstClock(JSON.stringify(s))).toBe('3|dusk|0.80|autumn');
    // capturedAt 变化但游戏时钟不变 → 摘要不变（哨兵据此判定卡死）
    expect(extractDstClock(JSON.stringify(snapshot({ capturedAt: 1_800_000_000_000 })))).toBe('3|dusk|0.80|autumn');
    expect(extractDstClock(JSON.stringify(snapshot({ clock: { ...s.clock, cycle: 4 } })))).toBe('4|dusk|0.80|autumn');
    expect(extractDstClock('not-json')).toBeNull();
  });

  it('四态分类 + 超时≠失败 + 错误 + 文本兜底', () => {
    const receipt = (status: string, reason = '') => JSON.stringify({
      actionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tool: 'gather', gameId: 'dst',
      status, reason, startedAt: 1, completedAt: 2,
    });
    expect(classifyDstReceipt({ text: receipt('COMPLETED', 'GATHERED'), kind: 'ok', isError: false, tool: 'gather' }))
      .toMatchObject({ status: 'COMPLETED', summary: expect.stringContaining('GATHERED') });
    expect(classifyDstReceipt({ text: receipt('FAILED', 'NO_TARGET'), kind: 'ok', isError: true, tool: 'gather' }).status).toBe('FAILED');
    expect(classifyDstReceipt({ text: receipt('UNCERTAIN'), kind: 'ok', isError: true, tool: 'work' }).status).toBe('UNCERTAIN');
    expect(classifyDstReceipt({ text: receipt('ABORTED_BY_HUMAN_TAKEOVER'), kind: 'ok', isError: true, tool: 'gather' }))
      .toMatchObject({ status: 'FAILED', summary: expect.stringContaining('不重发') });
    expect(classifyDstReceipt({ text: '', kind: 'timeout', isError: false, tool: 'gather', errorMessage: '' }).status).toBe('TIMEOUT');
    expect(classifyDstReceipt({ text: '', kind: 'error', isError: false, tool: 'gather', errorMessage: '连接断了' }).summary).toContain('连接断了');
    expect(classifyDstReceipt({ text: 'UNCERTAIN 老版本 mod', kind: 'ok', isError: true, tool: 'work' }).status).toBe('UNCERTAIN');
    expect(classifyDstReceipt({ text: 'done', kind: 'ok', isError: false, tool: 'work' }).status).toBe('COMPLETED');
  });
});

describe('DstBridgeTransport（统一桥接协议映射）', () => {
  it('get_state / act / action_status 轮询 / cancel 全链路', async () => {
    const fake = await startFake({ statusMode: 'complete-after-first' });
    try {
      const transport = new DstBridgeTransport(fake.base, fetch, 5);
      const state = await transport.callTool('get_state');
      expect(state.kind).toBe('ok');
      expect(JSON.parse(state.kind === 'ok' ? state.text : '{}')).toMatchObject({ schemaVersion: 1, clock: { cycle: 3 } });

      const act = await transport.callTool('gather', { item: 'berries' }, { timeoutMs: 1_000 });
      expect(act.kind).toBe('ok');
      expect(fake.polls()).toBeGreaterThanOrEqual(2); // 首次 running、二次 receipt
      expect(act.kind === 'ok' && act.isError).toBe(false);
      expect(act.kind === 'ok' ? act.text : '').toContain('COMPLETED');

      const cancel = await transport.callTool('cancel_action');
      expect(cancel.kind).toBe('ok');
      expect(await transport.ping()).toBe(true);
    } finally {
      fake.close();
    }
  });

  it('busy → ACTION_IN_FLIGHT 错误；永久 running → timeout（不伪造 FAILED）', async () => {
    const busy = await startFake({ statusMode: 'busy' });
    try {
      const result = await new DstBridgeTransport(busy.base).callTool('gather', {}, { timeoutMs: 500 });
      expect(result).toMatchObject({ kind: 'error', message: 'ACTION_IN_FLIGHT' });
    } finally { busy.close(); }

    const stuck = await startFake({ statusMode: 'running' });
    try {
      const result = await new DstBridgeTransport(stuck.base, fetch, 5).callTool('move_to', {}, { timeoutMs: 60 });
      expect(result.kind).toBe('timeout');
    } finally { stuck.close(); }
  });

  it('T-M6-40 agentId：/state?agentId、/act body、/cancel?agentId 都带逻辑玩家路由', async () => {
    const seen: Array<{ path: string; agentId: string | null }> = [];
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let bodyAgent: string | null = null;
        if (chunks.length > 0) {
          try { bodyAgent = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { agentId?: unknown }).agentId ?? '') || null; } catch { bodyAgent = null; }
        }
        seen.push({ path: url.pathname, agentId: url.searchParams.get('agentId') ?? bodyAgent });
        const reply = (status: number, body: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (url.pathname === '/state') return reply(200, snapshot());
        if (url.pathname === '/act') return reply(200, { accepted: true, actionId: '66666666-6666-4666-8666-666666666666' });
        if (url.pathname === '/action_status') {
          return reply(200, {
            running: false,
            receipt: { actionId: url.searchParams.get('id'), tool: 'gather', gameId: 'dst', status: 'COMPLETED', reason: 'OK', startedAt: 1, completedAt: 2 },
          });
        }
        if (url.pathname === '/cancel') return reply(200, { cancelled: true });
        return reply(404, {});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr !== 'object') throw new Error('no address');
    try {
      const transport = new DstBridgeTransport(`http://127.0.0.1:${addr.port}`, fetch, 5, 'alice');
      await transport.callTool('get_state');
      await transport.callTool('gather', {}, { timeoutMs: 200 });
      await transport.callTool('cancel_action');
      expect(seen).toEqual([
        { path: '/state', agentId: 'alice' },
        { path: '/act', agentId: 'alice' },
        { path: '/action_status', agentId: null },
        { path: '/cancel', agentId: 'alice' },
      ]);
    } finally {
      server.close();
    }
  });

  it('ping 只接受 ok=true 且 gameId=dst 的健康响应', async () => {
    const fake = await startFake({ health: { ok: false } as never });
    try {
      expect(await new DstBridgeTransport(fake.base).ping()).toBe(false);
    } finally { fake.close(); }
  });
});

describe('DstRulePlanner（零 token 兜底护栏）', () => {
  const planner = new DstRulePlanner();
  const decide = async (s: ReturnType<typeof snapshot>) => {
    planner.observe(s as never);
    return planner.decide(stateFrom(s));
  };

  it('玩家接管 → wait，不做任何动作', async () => {
    const decision = await decide(snapshot({ control: { authority: 'HUMAN_TAKEOVER_ACTIVE', isPlayerMovingPhysically: true } }));
    expect(decision.kind).toBe('wait');
  });

  it('猎犬：血少先撤，血够迎战', async () => {
    const threat = [{ kind: 'hound', count: 3, directionText: '西北' }];
    const flee = await decide(snapshot({ threats: threat, player: { ...snapshot().player, health: { current: 30, max: 150 } } }));
    expect(flee).toMatchObject({ kind: 'act', tool: 'move_to', args: { awayFrom: 'hound' } });
    const fight = await decide(snapshot({ threats: threat }));
    expect(fight).toMatchObject({ kind: 'act', tool: 'attack', args: { target: 'hound' } });
  });

  it('饥饿：有食物吃，没食物采浆果；血线告急优先进食', async () => {
    const hungry = { ...snapshot().player, hunger: { current: 20, max: 100 } };
    expect(await decide(snapshot({ player: hungry }))).toMatchObject({ kind: 'act', tool: 'eat' });
    const noFood = { ...hungry, inventory: [] };
    expect(await decide(snapshot({ player: noFood }))).toMatchObject({ kind: 'act', tool: 'gather', args: { item: 'berries' } });
    const lowHp = { ...snapshot().player, health: { current: 20, max: 150 } };
    expect(await decide(snapshot({ player: lowHp }))).toMatchObject({ kind: 'act', tool: 'eat' });
  });

  it('黄昏/夜晚火堆将熄 → add_fuel 或 place_campfire；理智低 → 采花', async () => {
    const lowFire = snapshot({ nearby: { entities: [], campfires: [{ position: { x: 1, z: 2 }, fuelPercent: 0.1 }] } });
    expect(await decide(lowFire)).toMatchObject({ kind: 'act', tool: 'add_fuel' });
    const noFireNoFuel = snapshot({
      nearby: { entities: [], campfires: [] },
      player: { ...snapshot().player, inventory: [] },
    });
    expect(await decide(noFireNoFuel)).toMatchObject({ kind: 'act', tool: 'place_campfire' });
    const lowSanity = snapshot({
      player: { ...snapshot().player, sanity: { current: 20, max: 150 } },
      clock: { ...snapshot().clock, phase: 'day' },
    });
    expect(await decide(lowSanity)).toMatchObject({ kind: 'act', tool: 'gather', args: { item: 'flower' } });
  });

  it('状态平稳 → wait；快照损坏 → wait（绝不盲跑）', async () => {
    expect(await decide(snapshot())).toMatchObject({ kind: 'wait' });
    const fresh = new DstRulePlanner();
    const decision = await fresh.decide({ ...stateFrom(snapshot()), raw: 'not-json' });
    expect(decision.kind).toBe('wait');
  });
});
