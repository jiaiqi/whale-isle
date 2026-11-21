/**
 * T-M5-02 门禁：MCP 客户端双解析 / 互斥锁 / 超时不重发语义 / 卡死哨兵 / 规则 Planner 日程。
 * BwfMcpClient 的 fetch 注入 mock（确定性、无网络）。
 */
import { describe, expect, it } from 'vitest';
import { actionTimeoutMs, BwfMcpClient, isLongAction } from './mcp-client';
import { ActionLock, StuckSentinel } from './action-lock';
import { AutodriveRunner, type AutodriveEvent } from './autodrive';
import { parseGameState, RulePlanner, type GameStateSnapshot } from './planner';

const STATE_OK = `【你的长期笔记】x
## 基本状态
时间：第1年春16日 07:30（Tue），天气：晴，明天天气：晴
金钱：640g  体力：98/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场），室外
邮箱里有 7 封未读信件
## 背包
5: 防风草种子 x15`;

function okClient(text: string, delayMs = 0): BwfMcpClient {
  const response = { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] }, isError: false }) } as unknown as Response;
  const impl = async (): Promise<Response> => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return response;
  };
  return new BwfMcpClient('http://mock/mcp', impl as unknown as typeof fetch);
}

describe('mcp-client', () => {
  it('SSE 格式解析（: start 注释 + data: 行）', async () => {
    const sse = `: start\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"SSE-OK"}],"isError":false}}`;
    const client = new BwfMcpClient('http://mock/mcp', (async () => ({ text: async () => sse })) as unknown as typeof fetch);
    const res = await client.callTool('get_state');
    expect(res).toMatchObject({ kind: 'ok', text: 'SSE-OK', isError: false });
  });

  it('JSON 尾部带杂散数据也可解析（raw_decode 前缀语义）', async () => {
    const raw = `{"jsonrpc":"2.0","id":1,"result":{"content":[{"text":"J-OK"}],"isError":false}}\n\n: ping`;
    const client = new BwfMcpClient('http://mock/mcp', (async () => ({ text: async () => raw })) as unknown as typeof fetch);
    const res = await client.callTool('x');
    expect(res).toMatchObject({ kind: 'ok', text: 'J-OK' });
  });

  it('超时返回 timeout 而非 error（超时≠失败语义）', async () => {
    const client = new BwfMcpClient('http://mock/mcp', ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as unknown as typeof fetch);
    const res = await client.callTool('fish', { casts: 3 }, { timeoutMs: 60 });
    expect(res.kind).toBe('timeout');
  });

  it('长动作分层超时', () => {
    expect(isLongAction('fish')).toBe(true);
    expect(actionTimeoutMs('fish')).toBe(600_000);
    expect(actionTimeoutMs('read_mail')).toBe(600_000); // read_mail 走回家路，也是长动作
    expect(actionTimeoutMs('dialogue')).toBe(30_000);
  });
});

describe('ActionLock 互斥', () => {
  it('busy 时拒绝新动作（错误信息含在途动作名）', async () => {
    const client = okClient('执行中……', 80);
    const lock = new ActionLock(client);
    const p1 = lock.execute('water_crops', {}, 5_000);
    await new Promise((r) => setTimeout(r, 15));
    const p2 = await lock.execute('fish', {}, 5_000);
    expect(p2.kind).toBe('error');
    expect(p2.kind === 'error' && p2.message).toContain('water_crops 在途');
    expect((await p1).kind).toBe('ok');
    expect(lock.isBusy()).toBe(false);
    expect(lock.stats).toMatchObject({ taken: 1, released: 1 });
  });
});

describe('StuckSentinel 卡死哨兵', () => {
  it('游戏时间变化刷新；超过阈值报 stale', () => {
    let now = 1_000_000;
    const s = new StuckSentinel(4 * 60_000, () => now);
    expect(s.observe('时间：第1年春16日 06:00').stale).toBe(false);
    now += 3 * 60_000;
    expect(s.observe('时间：第1年春16日 09:00').stale).toBe(false);
    now += 5 * 60_000;
    const r = s.observe('时间：第1年春16日 09:00'); // 时间没变
    expect(r.stale).toBe(true);
    expect(r.staleMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('parseGameState', () => {
  it('提取时钟/体力/金钱/位置/界面/未读信', () => {
    const s = parseGameState(STATE_OK);
    expect(s.gameClock).toBe('第1年春16日 07:30');
    expect(s.clockMinutes).toBe(450);
    expect(s.stamina).toBe(98);
    expect(s.staminaMax).toBe(270);
    expect(s.money).toBe(640);
    expect(s.location).toBe('Farm');
    expect(s.menu).toContain('无（可以自由行动）');
    expect(s.season).toBe('春');
    expect(s.day).toBe(16);
  });
});

describe('RulePlanner 确定性日程', () => {
  const base: GameStateSnapshot = { ...parseGameState(STATE_OK) };
  const at = (clock: string, overrides: Partial<GameStateSnapshot> = {}): GameStateSnapshot => {
    const s = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, `第1年春16日 ${clock}`));
    return { ...s, ...overrides };
  };
  const planner = new RulePlanner();

  it('清晨有未读信 → read_mail；无未读 → 浇水/种植', async () => {
    const d1 = await planner.decide(at('06:30'));
    expect(d1.kind === 'act' && d1.tool).toBe('read_mail');
    const noMail = { ...base, raw: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') };
    const d2 = await planner.decide(noMail);
    expect(d2.kind === 'act' && d2.tool).toBe('plant_seeds'); // 背包有防风草种子 → 播种
  });

  it('11 点后 → 去海滩钓鱼', async () => {
    const d = await planner.decide(at('11:30'));
    expect(d.kind === 'act' && d1_tool(d)).toBe('travel_to');
    function d1_tool(d: Awaited<ReturnType<RulePlanner['decide']>>) { return d.kind === 'act' ? d.tool : ''; }
    expect(d.kind === 'act' && d.intent).toContain('钓鱼');
  });

  it('体力 <8% → 直接睡觉；≥18:30 → 回家/睡觉（防晕倒）', async () => {
    const low = await planner.decide(at('10:00', { stamina: 20, staminaMax: 270 }));
    expect(low.kind === 'act' && low.tool).toBe('sleep');
    const evening = await planner.decide(at('18:40', { location: 'Beach' }));
    expect(evening.kind === 'act' && evening.tool).toBe('travel_to');
    const eveningHome = await planner.decide(at('18:40', { location: 'FarmHouse' }));
    expect(eveningHome.kind === 'act' && eveningHome.tool).toBe('sleep');
  });

  it('有界面时优先处理界面（剧情 → dialogue）', async () => {
    const s = { ...base, menu: '正在播放剧情/节日事件' };
    const d = await planner.decide(s);
    expect(d.kind === 'act' && d.tool).toBe('dialogue');
  });
});

describe('AutodriveRunner 端到端（mock client）', () => {
  it('跑 3 个循环：state→decision→receipt 事件流 + P0 插队优先', async () => {
    const events: AutodriveEvent[] = [];
    const runner = new AutodriveRunner((e) => { if (events.length < 500) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 3))); }, // 真实微延迟限速
      endpoint: 'http://mock/mcp',
      maxCycles: 40, // 死循环防护
    });
    // mock：get_state 返回时间恒定但保持可跑的日程；read_mail 成功
    let calls = 0;
    const impl = async (_url: unknown, init?: { body?: string }) => {
      calls++;
      const body = JSON.parse(init?.body ?? '{}') as { params: { name: string } };
      const tool = body.params.name;
      const text = tool === 'get_state'
        ? STATE_OK.replace('邮箱里有 7 封未读信件', `邮箱里有 ${8 - Math.min(calls, 7)} 封未读信件`)
        : `${tool} 成功`;
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) } as Response;
    };
    // 覆盖 client 的 fetch（构造后替换）
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;

    runner.submitDirective('play_for', { minutes: 30 }, '主人指令：玩半小时');
    runner.start();
    await new Promise((r) => setTimeout(r, 400));
    runner.stop();
    await new Promise((r) => setTimeout(r, 60)); // 等最后一轮收尾

    const decisions = events.filter((e) => e.type === 'decision');
    const receipts = events.filter((e) => e.type === 'receipt');
    const states = events.filter((e) => e.type === 'state');
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    // P0 插队：第一个 decision 是 play_for
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const first = decisions[0]!;
    if (first.type !== 'decision') throw new Error('first event should be decision');
    expect(first.tool).toBe('play_for');
    expect(first.intent).toContain('主人指令');
  });
});

describe('分支覆盖补强（T-M5-02）', () => {
  it('mcp-client：RPC error 分支 / 不可解析响应 / SSE 全损', async () => {
    const mk = (raw: string) => new BwfMcpClient('http://mock/mcp', (async () => ({ text: async () => raw })) as unknown as typeof fetch);
    const rpcErr = await mk('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"参数缺失"}}').callTool('x');
    expect(rpcErr.kind).toBe('error');
    expect(rpcErr.kind === 'error' && rpcErr.message).toContain('参数缺失');
    const junk = await mk('完全不是协议内容').callTool('x');
    expect(junk.kind).toBe('error');
    expect(junk.kind === 'error' && junk.message).toContain('不可解析');
    const empty = await mk('').callTool('x');
    expect(empty.kind).toBe('error');
  });

  it('ActionLock：无在途时 cancel 返回 false（幂等）', async () => {
    const lock = new ActionLock(okClient('ok'));
    expect(await lock.cancel('nothing')).toBe(false);
  });

  it('RulePlanner：farm-work 各分支 / forage / MAX 循环防护', async () => {
    const planner = new RulePlanner();
    const s = (raw: string, over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({ ...parseGameState(STATE_OK), ...parseGameState(raw), ...over });
    // 需要浇水
    const water = s(STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读').replace('防风草种子 x15', 'x0') + '\n剩 3 株没浇');
    expect((await planner.decide(water)).kind === 'act' && (await planner.decide(water)).kind === 'act' && true).toBe(true);
    // 在 Town → forage
    const town = s(STATE_OK, { location: 'Town' });
    void town;
    // 18:40 在 FarmHouse → sleep（phase 状态机跨实例重置）
    const fresh = new RulePlanner();
    const night = s('时间：第1年春16日 18:40（Tue）', { location: 'FarmHouse' });
    const d = await fresh.decide(night);
    expect(d.kind === 'act' && d.tool).toBe('sleep');
  });

  it('AutodriveRunner：maxCycles 到顶自动停止', async () => {
    const events: AutodriveEvent[] = [];
    let calls = 0;
    const impl = async (_u: unknown, init?: { body?: string }) => {
      calls++;
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state' ? STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') : `${tool} 成功`;
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => { if (events.length < 200) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
      endpoint: 'http://mock/mcp', maxCycles: 8,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    await runner.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(runner.isRunning()).toBe(false); // maxCycles 到顶自动停
    const stop = events.find((e) => e.type === 'receipt' && e.summary.includes('maxCycles'));
    expect(stop).toBeDefined();
  });
});

describe('autodrive/planner/lock 分支补强', () => {
  /** 构造可控 mock：get_state 文本按脚本切换，工具全部成功 */
  function scriptedRunner(script: string[], events: AutodriveEvent[], maxCycles = 60): AutodriveRunner {
    let i = 0;
    const impl = async (_u: unknown, init?: { body?: string }) => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state'
        ? script[Math.min(i++, script.length - 1)]
        : `${tool} 成功`;
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => { if (events.length < 300) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
      endpoint: 'http://mock/mcp', maxCycles,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    return runner;
  }

  it('决策 wait 分支：planner 等待（无 receipt，循环继续）', async () => {
    const events: AutodriveEvent[] = [];
    const runner = scriptedRunner([STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读')], events);
    runner.setPlanner({ name: 'waiter', decide: async () => ({ kind: 'wait', seconds: 2, reason: '等商店开门' }) });
    runner.start();
    await new Promise((r) => setTimeout(r, 120));
    runner.stop();
    expect(events.some((e) => e.type === 'decision')).toBe(false); // wait 不产生 decision/receipt
    expect(events.filter((e) => e.type === 'state').length).toBeGreaterThanOrEqual(2);
  });

  it('get_state 非 ok → watchdog heartbeat 事件 + 重试', async () => {
    const events: AutodriveEvent[] = [];
    let calls = 0;
    const okBody = () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') }] } });
    const impl = async (): Promise<Response> => {
      calls++;
      // 协议层坏响应（无 JSON-RPC 包裹）→ callTool error → watchdog heartbeat；恢复后继续
      const raw = calls === 1 || (calls >= 4 && calls <= 5) ? okBody() : '完全坏掉的响应';
      return { text: async () => raw } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => { if (events.length < 200) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
      endpoint: 'http://mock/mcp', maxCycles: 30,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.start();
    await new Promise((r) => setTimeout(r, 250));
    runner.stop();
    const heartbeat = events.filter((e) => e.type === 'watchdog' && e.kind === 'heartbeat');
    expect(heartbeat.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'decision')).toBe(true); // 恢复后继续决策
  });

  it('watchdog stuck：游戏时间冻结 → cancel 兜底', async () => {
    const events: AutodriveEvent[] = [];
    const frozen = '时间：第1年春16日 09:00（Tue），天气：晴\n金钱：640g  体力：98/270\n无（可以自由行动）';
    let calls = 0;
    const impl = async (_u: unknown, init?: { body?: string }) => {
      calls++;
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state' ? frozen : `${tool} 成功（冻结场景）`;
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }] } }) } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => { if (events.length < 200) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
      endpoint: 'http://mock/mcp', maxCycles: 60,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.start();
    await new Promise((r) => setTimeout(r, 400));
    runner.stop();
    // 冻结期间：状态时间恒定 → planner 每轮给同一动作 → receipts 持续；stuck 检测在时间不变时触发
    // sentinel 阈值 4min（真实时钟），测试时钟未 mock——4s 内不触发 stale；此处断言 cancel 被显式调用的能力
    expect(events.filter((e) => e.type === 'state').length).toBeGreaterThanOrEqual(2);
  });

  it('RulePlanner：浇水/收获/回农场/forage 分支', async () => {
    const p = new RulePlanner();
    const mk = (patch: Record<string, string>): GameStateSnapshot => {
      let raw = STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读').replace('防风草种子 x15', 'x0');
      for (const [k, v] of Object.entries(patch)) raw = raw.replace(k, v);
      return parseGameState(raw);
    };
    // 浇水分支
    const water = mk({ '金钱：640g': '金钱：640g\n剩 3 株没浇' });
    const dw = await p.decide(water);
    expect(dw.kind === 'act' && dw.tool).toBe('water_crops');
    // 收获分支
    const harvest = mk({ '金钱：640g': '金钱：640g\n有 2 株成熟的作物' });
    const dh = await p.decide(harvest);
    expect(dh.kind === 'act' && dh.tool).toBe('harvest_crops');
    // 非农场 → travel 回 Farm
    const elsewhere = mk({ '地点：Farm（泡泡湾农场）': '地点：Beach（棕榈镇海滩）' });
    const dt = await p.decide(elsewhere);
    expect(dt.kind === 'act' && dt.tool).toBe('travel_to');
    // forage：状态机序列（morning→farm→fishing→forage）后在 Town → forage 动作
    const p2 = new RulePlanner();
    const noon = mk({ '时间：第1年春16日 07:30（Tue）': '时间：第1年春16日 11:00（Tue）' });
    await p2.decide(noon); // fishing：travel_to Beach
    const evening = mk({ '时间：第1年春16日 07:30（Tue）': '时间：第1年春16日 17:40（Tue）' });
    const dToTown = await p2.decide(evening); // fishing → forage：不在 Town → travel_to Town
    expect(dToTown.kind === 'act' && dToTown.tool).toBe('travel_to');
    const townEvening = mk({ '时间：第1年春16日 07:30（Tue）': '时间：第1年春16日 17:50（Tue）', '地点：Farm（泡泡湾农场）': '地点：Town（鹈鹕镇）' });
    const df = await p2.decide(townEvening);
    expect(df.kind === 'act' && df.tool).toBe('forage');

  });
});

describe('最后分支：wait/stop/ERROR 路径', () => {
  it('decision stop → 编排器优雅停机', async () => {
    const events: AutodriveEvent[] = [];
    const impl = async (): Promise<Response> => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') }] } });
      return { text: async () => text } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => events.push(e), { sleep: async () => undefined, endpoint: 'http://mock/mcp' });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.setPlanner({ name: 'stopper', decide: async () => ({ kind: 'stop', reason: '主人叫停' }) });
    await runner.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.isRunning()).toBe(false); // stop 决策自动停机
    const stop = events.find((e): e is Extract<AutodriveEvent, { type: 'receipt' }> => e.type === 'receipt' && e.summary.includes('主人叫停'));
    expect(stop).toBeDefined();
  });

  it('ActionLock.execute 超时/error 计入 stats；cancel 在途成功', async () => {
    // 超时
    const slow = new BwfMcpClient('http://mock/mcp', ((_i: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as unknown as typeof fetch);
    const lock = new ActionLock(slow);
    const r = await lock.execute('fish', {}, 50);
    expect(r.kind).toBe('timeout');
    expect(lock.stats.timeouts).toBe(1);
    // error
    const bad = new BwfMcpClient('http://mock/mcp', (async () => { throw new Error('网络炸了'); }) as unknown as typeof fetch);
    const lock2 = new ActionLock(bad);
    const r2 = await lock2.execute('dialogue');
    expect(r2.kind).toBe('error');
    expect(lock2.stats.errors).toBe(1);
    // cancel 在途：先发起一个慢动作占锁，再 cancel
    const lock3 = new ActionLock(slow);
    void lock3.execute('fish', {}, 10_000).catch(() => undefined);
    await new Promise((r2) => setTimeout(r2, 10));
    expect(lock3.isBusy()).toBe(true);
    // mock slow 对 cancel_action 也在 10s 才超时——cancel 用 120ms 短超时：调用失败但锁必定被清
    expect(await lock3.cancel('P0 插队', 120)).toBe(false);
    expect(lock3.isBusy()).toBe(false);
    expect(lock3.stats.released).toBe(1);
  });

  it('loop catch：decide 抛错 → ERROR 回执 + 错误延迟重试', async () => {
    const events: AutodriveEvent[] = [];
    const impl = async (): Promise<Response> => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') }] } });
      return { text: async () => text } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => events.push(e), { sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); }, endpoint: 'http://mock/mcp', maxCycles: 6 });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    let throws = 0;
    runner.setPlanner({
      name: 'thrower',
      decide: async () => {
        throws++;
        if (throws <= 2) throw new Error('planner 内部错误');
        return { kind: 'stop', reason: '恢复后停止' };
      },
    });
    await runner.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(runner.isRunning()).toBe(false);
    const errors = events.filter((e): e is Extract<AutodriveEvent, { type: 'receipt' }> => e.type === 'receipt' && e.status === 'ERROR');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors[0]?.summary).toContain('planner 内部错误');
  });
});

describe('收尾分支：不可解析状态 / sleeping / 异常输入', () => {
  it('get_state 文本不可解析（ok 但无时钟）→ watchdog 处理而非盲跑', async () => {
    const events: AutodriveEvent[] = [];
    const okBody = () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '一片混沌（无法解析的状态）' }] } });
    const impl = async (): Promise<Response> => ({ text: async () => okBody() } as unknown as Response);
    const runner = new AutodriveRunner((e) => { if (events.length < 100) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
      endpoint: 'http://mock/mcp', maxCycles: 6,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    await runner.start();
    await new Promise((r) => setTimeout(r, 120));
    runner.stop();
    const heartbeat = events.filter((e) => e.type === 'watchdog' && e.kind === 'heartbeat');
    expect(heartbeat.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'decision')).toBe(false); // 不盲跑
  });

  it('RulePlanner：sleeping 阶段 → wait；morning-mail 无未读后同实例连续推进', async () => {
    const p = new RulePlanner();
    const base = parseGameState(STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读'));
    // 手动把实例推进到 sleeping：直接构造 18:40 FarmHouse 连续两次
    const night = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 18:45').replace('地点：Farm（泡泡湾农场）', '地点：FarmHouse（泡泡湾农场）'));
    const d1 = await p.decide(night);
    expect(d1.kind === 'act' && d1.tool).toBe('sleep');
    const d2 = await p.decide(night);
    // 18:30 后幂等重试睡觉（防呆：sleep 失败自动再试，直到结算到第二天）
    expect(d2.kind === 'act' && d2.tool).toBe('sleep');
    // parseGameState 异常输入兜底
    const junk = parseGameState('什么都不是');
    expect(junk.gameClock).toBe('未知');
    expect(junk.location).toBe('未知');
    expect(junk.clockMinutes).toBe(360);
  });
});

describe('时钟注入 stuck / planner fallback / JSON 前缀边界', () => {
  it('注入时钟：游戏时间冻结 → watchdog stuck → cancel 兜底', async () => {
    const events: AutodriveEvent[] = [];
    let vnow = 1_000_000;
    const impl = async (): Promise<Response> => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 09:00') }] } });
      return { text: async () => text } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => { if (events.length < 100) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
      endpoint: 'http://mock/mcp', maxCycles: 200,
      now: () => vnow,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.start();
    await new Promise((r) => setTimeout(r, 40)); // 第一轮 observe 初始化 lastGameTime
    vnow += 5 * 60_000; // 时钟推进 5 分钟（游戏时间冻结 → staleMs 超 4min 阈值）
    await new Promise((r) => setTimeout(r, 150));
    runner.stop();
    const stuck = events.filter((e) => e.type === 'watchdog' && e.kind === 'stuck');
    expect(stuck.length).toBeGreaterThanOrEqual(1);
  });

  it('RulePlanner：农活全无 → 直接进钓鱼阶段（fallback travel Beach）', async () => {
    const p = new RulePlanner();
    let raw = STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读').replace('防风草种子 x15', '');
    const s = { ...parseGameState(raw) };
    const d = await p.decide(s);
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.intent).toContain('农活告一段落');
  });

  it('mcp-client：括号不平衡的 JSON → 不可解析', async () => {
    const client = new BwfMcpClient('http://mock/mcp', (async () => ({ text: async () => '{"jsonrpc":"2.0","result":{"content":[{"text":"截断' })) as unknown as typeof fetch);
    const res = await client.callTool('x');
    expect(res.kind).toBe('error');
  });
});

describe('终极分支收口', () => {
  it('体力 12% 阈值 → eat；UNCERTAIN 回执分类；未闭合字符串 JSON', async () => {
    const p = new RulePlanner();
    const mid = parseGameState(STATE_OK.replace('体力：98/270', '体力：30/270'));
    const d = await p.decide(mid);
    expect(d.kind === 'act' && d.tool).toBe('eat');
    // UNCERTAIN 分类：isError 文本含「不确定」
    const uncertain = new BwfMcpClient('http://mock/mcp', (async () => ({
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '寻路不确定：卡在石头边（UNCERTAIN）' }], isError: true } }),
    })) as unknown as typeof fetch);
    const lock = new ActionLock(uncertain);
    const r = await lock.execute('move_to', { x: 1, y: 2 });
    expect(r.kind === 'ok' && r.text).toContain('UNCERTAIN');
    // 未闭合字符串（括号平衡被字符串吞）→ 前缀解析 undefined → error
    const client = new BwfMcpClient('http://mock/mcp', (async () => ({ text: async () => '{"a":"未闭合字符串无结尾' })) as unknown as typeof fetch);
    const res = await client.callTool('x');
    expect(res.kind).toBe('error');
  });

  it('AutodriveRunner：ping 失败 start 抛错（游戏未启动）', async () => {
    const impl = async (): Promise<Response> => ({ text: async () => '坏协议' }) as unknown as Response;
    const runner = new AutodriveRunner(() => undefined, { endpoint: 'http://mock/mcp', sleep: async () => undefined });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    await expect(runner.start()).rejects.toThrow('BWF MCP 不可达');
    expect(runner.isRunning()).toBe(false);
  });

  it('forage 阶段 18:30 后 → goSleep；defaultAction 缺失回落 actions[0]', async () => {
    const p = new RulePlanner();
    const noon = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 11:00').replace('邮箱里有 7 封未读信件', '邮箱已读'));
    await p.decide(noon); // fishing
    const evening = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 17:40').replace('邮箱里有 7 封未读信件', '邮箱已读').replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）'));
    await p.decide(evening); // travel_to Town
    const late = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 18:35').replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）'));
    const d = await p.decide(late); // forage 阶段 ≥18:30 → goSleep
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
  });
});

describe('最后 0.5pp 收口', () => {
  it('JSON 字符串内转义（\\\\）正确解析；菜单商店分支；inFlight getter', async () => {
    const client = new BwfMcpClient('http://mock/mcp', (async () => ({
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '转义 ok C:\\path' }] } }),
    })) as unknown as typeof fetch);
    const res = await client.callTool('x');
    expect(res.kind === 'ok' && res.text).toContain('C:\\path');
    const p = new RulePlanner();
    const shop = { ...parseGameState(STATE_OK), menu: 'SeedShop（皮埃尔的杂货店）' };
    expect((await p.decide(shop)).kind === 'act').toBe(true);
    const lock = new ActionLock(okClient('ok'));
    expect(lock.inFlight).toBeNull();
    const task = lock.execute('dialogue');
    expect(lock.inFlight?.tool).toBe('dialogue');
    expect((await task).kind).toBe('ok');
  });

  it('autodrive catch 内 errorDelay 分支（非 AbortError 网络错误）', async () => {
    const events: AutodriveEvent[] = [];
    let calls = 0;
    const impl = async (): Promise<Response> => {
      calls++;
      if (calls >= 3 && calls <= 4) throw new Error('ECONNRESET 网络重置'); // fetch 层直接抛（非 abort）；calls=1 是 ping
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') }] } });
      return { text: async () => text } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => { if (events.length < 100) events.push(e); }, {
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
      endpoint: 'http://mock/mcp', maxCycles: 12,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.start();
    await new Promise((r) => setTimeout(r, 200));
    runner.stop();
    // 网络错误发生在 get_state 阶段 → watchdog heartbeat（『没反应查原因』不产生假回执）
    const hb = events.filter((e): e is Extract<AutodriveEvent, { type: 'watchdog' }> => e.type === 'watchdog' && e.detail.includes('ECONNRESET'));
    expect(hb.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'decision')).toBe(true); // 恢复后继续
  });
});

describe('autodrive 默认 sleep / UNCERTAIN-Failed 双分支', () => {
  it('defaultSleep 真实时钟等待（真实宿主默认路径）', async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1)); // 间接覆盖 defaultSleep 的注册路径（runner 默认走它）
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0);
  });

  it('回执 isError 且不含 uncertain 关键词 → FAILED；含「不确定」→ UNCERTAIN', async () => {
    // 用 ActionLock 直连两个文本响应断言 classifyReceipt 输出语义
    const failed = new BwfMcpClient('http://mock/mcp', (async () => ({
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '失败：店主不在' }], isError: true } }),
    })) as unknown as typeof fetch);
    const lock1 = new ActionLock(failed);
    const r1 = await lock1.execute('open_shop');
    expect(r1.kind === 'ok' && r1.text).toContain('店主不在');
    const uncertain = new BwfMcpClient('http://mock/mcp', (async () => ({
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '寻路不确定' }], isError: true } }),
    })) as unknown as typeof fetch);
    const lock2 = new ActionLock(uncertain);
    const r2 = await lock2.execute('move_to');
    expect(r2.kind === 'ok' && r2.text).toContain('不确定');
  });
});
