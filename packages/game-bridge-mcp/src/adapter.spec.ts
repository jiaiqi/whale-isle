/**
 * T-M7-02 门禁：多游戏适配器 seam。
 * 断言：① 星露谷分类/包装行为零变化；② 注册表可注入新游戏；③ 假新游戏 adapter
 * 能驱动同一 AutodriveRunner（parseState / extractClock / classifyReceipt / ping 全部走钩子）。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyStardewReceipt,
  GameAdapterRegistry,
  gameAdapters,
  humanizeBwfReceipt,
  isStardewWorldReadyText,
  StardewAdapter,
  normalizeBwfEndpoint,
  type GameAdapter,
  type GameBridgeTransport,
} from './adapter';
import { AutodriveRunner, type AutodriveEvent } from './autodrive';
import { DstAdapter } from './dst-adapter';
import { TerrariaAdapter } from './terraria-adapter';
import type { GameStateSnapshot } from './planner';

const RPC_OK = (text: string) =>
  ({ text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) }) as unknown as Response;

function makeFakeAdapter(overrides: Partial<GameAdapter> = {}): GameAdapter {
  const transport: GameBridgeTransport = {
    async callTool(tool) {
      return { kind: 'ok', text: tool === 'get_state' ? '{"dayCount":3,"phase":"day"}' : `${tool} done`, isError: false };
    },
  };
  return {
    gameId: 'terraria',
    displayName: '泰拉瑞亚（测试假适配器）',
    transport,
    ping: async () => true,
    unreachableMessage: '泰拉瑞亚桥不可达（18090）',
    parseState: (raw: string): GameStateSnapshot => {
      const day = (JSON.parse(raw) as { dayCount: number }).dayCount;
      return {
        raw,
        gameClock: `第 ${day} 天`,
        clockMinutes: 480,
        stamina: 100,
        staminaMax: 100,
        money: 0,
        location: 'Forest',
        menu: '',
        season: '',
        day,
        freeSlots: 10,
        posX: 0,
        posY: 0,
        weather: '',
        health: 100,
        healthMax: 100,
        birthday: null,
        festival: null,
      };
    },
    extractClock: (text: string) => /"dayCount":(\d+)/.exec(text)?.[1] ?? null,
    isLongAction: (tool: string) => tool === 'mine',
    classifyReceipt: ({ text, kind, isError, tool }) => ({
      status: kind === 'ok' && !isError ? 'COMPLETED' : 'FAILED',
      summary: `${tool}:${text}`,
    }),
    toolWhitelist: ['get_state', 'mine'],
    ...overrides,
  };
}

describe('classifyStardewReceipt（星露谷四态原样迁移）', () => {
  it('timeout / error / isError(UNCERTAIN|FAILED) / ok 四路分类不变', () => {
    expect(classifyStardewReceipt({ text: '', kind: 'timeout', isError: false, tool: 'fish' })).toMatchObject({ status: 'TIMEOUT' });
    expect(classifyStardewReceipt({ text: '', kind: 'error', isError: false, tool: 'fish', errorMessage: '网络断了' }).summary)
      .toBe('网络断了客户端错误');
    expect(classifyStardewReceipt({ text: 'x', kind: 'error', isError: false, tool: 'fish' }).summary).toBe('x');
    expect(classifyStardewReceipt({ text: 'UNCERTAIN 石头挡路', kind: 'ok', isError: true, tool: 'move_to' }).status).toBe('UNCERTAIN');
    expect(classifyStardewReceipt({ text: '失败：没鱼饵', kind: 'ok', isError: true, tool: 'fish' }).status).toBe('FAILED');
    expect(classifyStardewReceipt({ text: '成功：钓到鱼', kind: 'ok', isError: false, tool: 'fish' }).status).toBe('COMPLETED');
  });

  it('节日没有主活动属确定结论，不因措辞含“可能”误判 UNCERTAIN', () => {
    // 夏28 真机原文：月光水母之舞由 BWF 判定刘易斯不问是否开始
    const noMain = classifyStardewReceipt({
      text: '失败：刘易斯没有问要不要开始（可能还没到时间，或者这个节日没有主活动）。展览会、万灵节没有要他宣布的主活动，逛完 festival leave',
      kind: 'ok',
      isError: true,
      tool: 'festival',
    });
    expect(noMain.status).toBe('FAILED');
    expect(noMain.summary).toContain('没有主活动');

    // 真正不确定的仍需保留 UNCERTAIN
    expect(classifyStardewReceipt({ text: 'UNCERTAIN 状态未知', kind: 'ok', isError: true, tool: 'move_to' }).status).toBe('UNCERTAIN');
    expect(classifyStardewReceipt({ text: '失败：可能卡在界面里了', kind: 'ok', isError: true, tool: 'wait' }).status).toBe('UNCERTAIN');
  });
});

describe('humanizeBwfReceipt（回执人话化，2026-11-23 用户反馈）', () => {
  it('\\uXXXX 转义还原 + JSON 数组转自然语言', () => {
    const raw = '失败：背包里没有“[\\"\\u6E7F\\u900F\\u7684\\u62A5\\u7EB8\\"]”。背包里能用的有：斧头、锄头';
    expect(humanizeBwfReceipt(raw)).toContain('背包里没有“湿透的报纸”');
    expect(humanizeBwfReceipt(raw)).not.toContain('\\u6E7F');
  });

  it('JSON 对象 map 转物品列表', () => {
    const raw = '失败：背包里没有“{"\\u6E7F\\u900F\\u7684\\u62A5\\u7EB8":1,"\\u6D6E\\u6728":1,"\\u868C":2}”';
    expect(humanizeBwfReceipt(raw)).toContain('背包里没有“湿透的报纸、浮木、蚌”');
  });

  it('英文工具名补中文，英文保留在括号里且不套娃', () => {
    const raw = '失败：农场上没有箱子。先 craft Chest（50 木材），再 place_item 放在农场上';
    const once = humanizeBwfReceipt(raw);
    expect(once).toContain('先制作宝箱（craft Chest）（50 木材）');
    expect(once).toContain('再摆放物品（place_item）放在农场上');
    expect(humanizeBwfReceipt(once)).toBe(once);
  });

  it('非法 JSON / 普通回执保持原样（绝不猜）', () => {
    expect(humanizeBwfReceipt('成功：钓到 1 条鱼')).toBe('成功：钓到 1 条鱼');
    expect(humanizeBwfReceipt('“{坏掉的 json}”')).toBe('“{坏掉的 json}”');
  });

  it('classifyStardewReceipt 的 summary 已人话化（失败回执不再显示原始 JSON）', () => {
    const summary = classifyStardewReceipt({
      text: '失败：背包里没有“["\\u6E7F\\u900F\\u7684\\u62A5\\u7EB8"]”。背包里能用的有：斧头',
      kind: 'ok',
      isError: true,
      tool: 'ship_items',
    }).summary;
    expect(summary).toContain('湿透的报纸');
    expect(summary).not.toContain('\\u6E7F');
    expect(summary).not.toContain('["');
  });
});

describe('StardewAdapter（原样包装 BwfMcpClient）', () => {
  it('时钟提取 / 长动作表 / ping / 不可达文案全部保持星露谷语义', async () => {
    const adapter = new StardewAdapter('http://mock/mcp', (async () => RPC_OK('时间：第1年春16日 07:30')) as unknown as typeof fetch);
    expect(adapter.extractClock('时间：第1年春16日 07:30')).toBe('时间：第1年春16日 07:30');
    expect(adapter.extractClock('无时钟')).toBeNull();
    expect(adapter.isLongAction('fish')).toBe(true);
    expect(adapter.isLongAction('dialogue')).toBe(false);
    expect(await adapter.ping()).toBe(true);
    expect(new StardewAdapter().unreachableMessage).toContain('BWF MCP 不可达（18080）');
    expect(new StardewAdapter('http://x:1/mcp').unreachableMessage).toContain('http://x:1/mcp');
  });
});

describe('adapter 专属攻略与规则规划器', () => {
  it('保持星露谷攻略主题，并给 Terraria/DST 返回各自规则规划器', () => {
    const stardew = new StardewAdapter();
    const terraria = new TerrariaAdapter();
    const dst = new DstAdapter();
    expect(stardew.guideTopics).toContain('钓鱼');
    expect(stardew.createRulePlanner?.().name).toBe('rule-schedule');
    expect(terraria.createRulePlanner?.().name).toBe('terraria-rule-zero-token');
    expect(dst.createRulePlanner?.().name).toBe('dst-rule-zero-token');
    expect(terraria.toolWhitelist).toContain('mine');
    expect(dst.toolWhitelist).toContain('gather');
  });
});

describe('GameAdapterRegistry', () => {
  it('默认在册星露谷；未注册 gameId 报错；可注册新游戏工厂', () => {
    expect(gameAdapters.list()).toContain('stardew');
    expect(gameAdapters.has('stardew')).toBe(true);
    const local = new GameAdapterRegistry();
    expect(() => local.create('dst')).toThrow('未注册的游戏适配器：dst');
    local.register('dst', () => makeFakeAdapter({ gameId: 'dst' }));
    expect(local.has('dst')).toBe(true);
    expect(local.list()).toContain('dst');
    expect(local.create('dst').gameId).toBe('dst');
  });
});

describe('假新游戏适配器驱动同一编排器（T-M7-02 seam 证明）', () => {
  it('state/decision/receipt 全部走 adapter 钩子，runner 无需感知游戏类型', async () => {
    const events: AutodriveEvent[] = [];
    let notifyReceipt!: () => void;
    const gotReceipt = new Promise<void>((resolve) => { notifyReceipt = resolve; });
    const adapter = makeFakeAdapter();
    const runner = new AutodriveRunner((e) => {
      events.push(e);
      if (e.type === 'receipt' && e.tool === 'mine') notifyReceipt();
    }, {
      endpoint: 'http://fake',
      maxCycles: 1,
      sleep: async () => undefined,
    }, adapter);
    expect(runner.adapter).toBe(adapter);
    expect(runner.client).toBe(adapter.transport);
    runner.submitDirective('mine', { x: 1 }, '测试指令');
    await runner.start();
    await Promise.race([gotReceipt, new Promise((r) => setTimeout(r, 2_000))]);
    runner.stop();

    const state = events.find((e) => e.type === 'state');
    if (!state || state.type !== 'state') throw new Error('missing state event');
    expect(state.clock).toBe('第 3 天');
    const receipt = events.find((e) => e.type === 'receipt' && e.tool === 'mine');
    if (!receipt || receipt.type !== 'receipt') throw new Error('missing receipt event');
    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.summary).toContain('mine:mine done');
  });

  it('adapter.ping=false 时 start() 抛 adapter 自己的不可达提示', async () => {
    const adapter = makeFakeAdapter({ ping: async () => false });
    const runner = new AutodriveRunner(() => undefined, { endpoint: 'http://fake' }, adapter);
    await expect(runner.start()).rejects.toThrow('泰拉瑞亚桥不可达（18090）');
  });

  it('adapter.extractClock 注入卡死哨兵（JSON 时钟也刷新，不再只认星露谷正则）', async () => {
    let now = 1_000_000;
    const adapter = makeFakeAdapter();
    const runner = new AutodriveRunner(() => undefined, { now: () => now }, adapter);
    expect(runner.sentinel.observe('{"dayCount":3}').stale).toBe(false);
    now += 5 * 60_000;
    expect(runner.sentinel.observe('{"dayCount":4}').stale).toBe(false); // 时钟变了 → 不 stale
    now += 5 * 60_000;
    expect(runner.sentinel.observe('{"dayCount":4}').stale).toBe(true); // 时钟冻结 → stale
  });
});

describe('normalizeBwfEndpoint（真机 2026-11-25：localhost 优先解析 ::1，BWF 只注册 IPv4 前缀会 404）', () => {
  it('localhost 换成本机回环 IP，其它主机名原样保留', () => {
    expect(normalizeBwfEndpoint('http://localhost:18088/mcp')).toBe('http://127.0.0.1:18088/mcp');
    expect(normalizeBwfEndpoint('http://127.0.0.1:18088/mcp')).toBe('http://127.0.0.1:18088/mcp');
    expect(normalizeBwfEndpoint('http://192.168.1.9:18088/mcp')).toBe('http://192.168.1.9:18088/mcp');
  });

  it('适配器内部用规范化后的端点（报错文案也带 IP，便于排查）', () => {
    const adapter = new StardewAdapter('http://localhost:18088/mcp');
    expect(adapter.unreachableMessage).toContain('127.0.0.1:18088');
    expect(adapter.unreachableMessage).not.toContain('localhost');
  });
});

describe('V2-P3-07C StardewAdapter.ping() 世界就绪硬化', () => {
  it('isStardewWorldReadyText：标题画面与读档过渡提示均返回 false，世界状态返回 true', () => {
    expect(isStardewWorldReadyText('游戏还没有进入存档（在标题画面）')).toBe(false);
    expect(isStardewWorldReadyText('请玩家先读取存档')).toBe(false);
    expect(isStardewWorldReadyText('正在加载存档，请稍候')).toBe(false);
    expect(isStardewWorldReadyText('当前位于 TitleMenu')).toBe(false);
    expect(isStardewWorldReadyText('时间：第1年春1日 06:00')).toBe(true);
    expect(isStardewWorldReadyText('')).toBe(true);
  });

  it('ping() 拒绝 HTTP 200 + 标题画面提示与 isError=true，只有真实进入存档才返回 true', async () => {
    const makeRes = (text: string, isError = false) =>
      ({ text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError } }) }) as unknown as Response;

    const titleAdapter = new StardewAdapter('http://mock/mcp', (async () => makeRes('游戏还没有进入存档，请先进入存档')) as unknown as typeof fetch);
    expect(await titleAdapter.ping()).toBe(false);

    const errAdapter = new StardewAdapter('http://mock/mcp', (async () => makeRes('时间：第1年春1日 06:00', true)) as unknown as typeof fetch);
    expect(await errAdapter.ping()).toBe(false);

    const offlineAdapter = new StardewAdapter('http://mock/mcp', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(await offlineAdapter.ping()).toBe(false);

    const readyAdapter = new StardewAdapter('http://mock/mcp', (async () => makeRes('时间：第1年春1日 06:00', false)) as unknown as typeof fetch);
    expect(await readyAdapter.ping()).toBe(true);
  });
});
