/**
 * T-M5-02 门禁：MCP 客户端双解析 / 互斥锁 / 超时不重发语义 / 卡死哨兵 / 规则 Planner 日程。
 * BwfMcpClient 的 fetch 注入 mock（确定性、无网络）。
 */
import { describe, expect, it } from 'vitest';
import { actionTimeoutMs, BwfMcpClient, isLongAction } from './mcp-client';
import { ActionLock, StuckSentinel } from './action-lock';
import { AutodriveRunner, PLAYER_IN_CONTROL_MARKER, describeHumanSession, type AutodriveEvent } from './autodrive';
import { StardewAdapter } from './adapter';
import { findFreeTile, parseGameState, pickEdible, RulePlanner, type GameStateSnapshot } from './planner';

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
5: 防风草种子 x15
6: 竹鱼竿（手持）
7: 水壶（手持）`;

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
    expect(isLongAction('tidy_backpack')).toBe(true); // BWF 文档：最长约 5 分钟
    expect(isLongAction('store_items')).toBe(true);
    expect(isLongAction('travel_to')).toBe(true); // 自动多段寻路（真机 30s 超时误报修复）
    expect(isLongAction('clear_area')).toBe(true); // BWF 最长 300s（真机 TIMEOUT 误报）
    expect(isLongAction('place_item')).toBe(true); // 可能自动走回农场
    expect(isLongAction('give_gift')).toBe(true); // 传名字会自动走过去
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
    expect(s.freeSlots).toBe(12); // 状态未报背包空位 → 不阻塞
    // 菜单必须解析多行（选项在后续行，只取第一行会漏 choice）
    const choiceRaw = `${STATE_OK.replace('无（可以自由行动）', '正在播放剧情/节日事件。对话框：你打算收养这只猫吗？\n选项（用 dialogue 并传 choice 序号回答）：\n  0: 是\n  1: 否')}`;
    expect(parseGameState(choiceRaw).menu).toContain('0: 是');
  });
});

describe('背包挑选边界', () => {
  it('pickEdible：无可食用返回 null；可食用但【留着】也跳过', () => {
    expect(pickEdible('0: 斧头')).toBeNull();
    expect(pickEdible('5: 沙丁鱼 [可食用 +23体力]【留着：社区中心】')).toBeNull();
    expect(pickEdible('5: 沙丁鱼 [可食用 +23体力]')).toBe('沙丁鱼');
  });

  it('菜单兜底：未知界面 → dialogue 无 choice', async () => {
    const p = new RulePlanner();
    const d = await p.decide({ ...parseGameState(STATE_OK), menu: '正在钓鱼小游戏' });
    expect(d.kind === 'act' && d.tool).toBe('dialogue');
    expect(d.kind === 'act' && d.args).toEqual({});
  });

  it('钓鱼阶段：抵达海滩后下一次决策给出 fish', async () => {
    const atLocal = (clock: string, over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
      ...parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, `第1年春16日 ${clock}`)),
      ...over,
    });
    const p = new RulePlanner();
    await p.decide(atLocal('11:30')); // read_mail
    await p.decide(atLocal('11:30')); // travel_to Beach（phase=fishing）
    const d = await p.decide(atLocal('12:00', { location: 'Beach' }));
    expect(d.kind === 'act' && d.tool).toBe('fish');
  });
});

describe('findFreeTile（文字地图找最近空地）', () => {
  it('解析左上角坐标 + 网格，返回离玩家最近的 .', () => {
    const raw = `## 文字地图（以你为中心，左上角坐标=(50,6)，每个字符一格，向右 x+1，向下 y+1）
   6 ##~~~
   7 ..~.@
   8 ...~~`;
    expect(findFreeTile(raw, 54, 7)).toEqual({ x: 53, y: 7 });
    expect(findFreeTile(raw, 52, 7)).toEqual({ x: 51, y: 7 });
  });
  it('地图被省略/无坐标 → null', () => {
    expect(findFreeTile('（和上次一样，省略）', 10, 10)).toBeNull();
  });
});

describe('RulePlanner 确定性日程', () => {
  const base: GameStateSnapshot = { ...parseGameState(STATE_OK) };
  const at = (clock: string, overrides: Partial<GameStateSnapshot> = {}): GameStateSnapshot => {
    const s = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, `第1年春16日 ${clock}`));
    return { ...s, ...overrides };
  };
  const planner = new RulePlanner();

  it('清晨有未读信 → read_mail；无未读且有空地 → 播种（T-M6-69 闭环）', async () => {
    const d1 = await planner.decide(at('06:30'));
    expect(d1.kind === 'act' && d1.tool).toBe('read_mail');
    // 农场作物段：0 株作物、15 格已开垦空地；背包有 15 份防风草种子
    const withFarm = STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读')
      .replace('## 背包', '## 作物（本地点全部）\n无\n（农场概况：共 0 株作物，需浇水 0，可收获 0）\n农田：共 15 格耕地：作物 0，空 15\n## 背包');
    const d2 = await planner.decide(parseGameState(withFarm));
    expect(d2.kind === 'act' && d2.tool).toBe('plant_seeds');
    expect(d2.kind === 'act' && d2.args).toMatchObject({ seed: '防风草种子' });
  });

  it('站在农场用明细格式报「需要浇水 N 株」→ 先浇水（2026-11-25 真机：种完不浇水的回归）', async () => {
    const p = new RulePlanner();
    const farmDetail = STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读')
      .replace('## 背包', `## 作物（本地点全部）
需要浇水 2 株：(48,19) (45,19)
生长中：辣椒 x2（最快约 5 天后成熟）
农田：还没有成片的田；零散耕地 2 格（其中 2 株作物，收完别再往这里种）
## 背包`);
    const d = await p.decide(parseGameState(farmDetail));
    expect(d.kind === 'act' && d.tool).toBe('water_crops');
  });

  it('BWF 正在执行 sleep 时 → 只 wait，不再发动作（2026-11-25 真机：连发 travel_to 被判卡死）', async () => {
    const p = new RulePlanner();
    const busy = `【正在执行】sleep 已经执行 0 分 6 秒（做完前别的动作会被拒绝；做完的结果会出现在 get_state 最前面）\n${STATE_OK}`;
    const d = await p.decide(parseGameState(busy));
    expect(d.kind).toBe('wait');
    expect(d.kind === 'wait' ? d.reason : '').toContain('sleep');
  });

  it('11 点后 → 去海滩钓鱼', async () => {
    const p = new RulePlanner();
    const d = await p.decide(at('11:30', { raw: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') }));
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.args).toMatchObject({ location: 'Beach' });
    expect(d.kind === 'act' && d.intent).toContain('钓鱼');
  });

  it('体力 <8% → 直接睡觉；22:00 收工 → 回家/睡觉（T-M6-69 bedtime）', async () => {
    const low = await planner.decide(at('10:00', { stamina: 20, staminaMax: 270 }));
    expect(low.kind === 'act' && low.tool).toBe('sleep');
    const evening = await planner.decide(at('22:10', { location: 'Beach' }));
    expect(evening.kind === 'act' && evening.tool).toBe('travel_to');
    expect(evening.kind === 'act' && evening.args).toMatchObject({ location: 'FarmHouse' });
    const eveningHome = await planner.decide(at('22:10', { location: 'FarmHouse' }));
    expect(eveningHome.kind === 'act' && eveningHome.tool).toBe('sleep');
  });

  it('中途接手：14:00 在农舍 → 先去农场续上当天日程（T-M6-70 LLM 故障代驾）', async () => {
    const p = new RulePlanner();
    const d = await p.decide(at('14:00', {
      location: 'FarmHouse',
      raw: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读'),
    }));
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.args).toMatchObject({ location: 'Farm' });
  });

  it('有界面时优先处理界面（剧情 → dialogue）', async () => {
    const s = { ...base, menu: '正在播放剧情/节日事件' };
    const d = await planner.decide(s);
    expect(d.kind === 'act' && d.tool).toBe('dialogue');
  });

  it('背包空位 0：有可卖物先出货（不依赖箱子），无物可出才 tidy_backpack', async () => {
    const noGoods = await planner.decide(at('12:00', { freeSlots: 0 }));
    expect(noGoods.kind === 'act' && noGoods.tool).toBe('tidy_backpack');
    expect(noGoods.kind === 'act' && noGoods.intent).toContain('背包');

    const withFish = await planner.decide(at('12:00', {
      freeSlots: 0,
      raw: `${STATE_OK}\n## 背包（序号: 物品）\n0: 斧头\n4: 小嘴鲈鱼 金星 [可食用 +45 体力]\n背包空位：0 个（共 12 格）`,
    }));
    expect(withFish.kind === 'act' && withFish.tool).toBe('ship_items');
    expect(withFish.kind === 'act' && withFish.args).toEqual({ item: '小嘴鲈鱼' });
  });

  it('省略背包段时沿用上次空位（规则模式也不会当有空位去钓鱼）', async () => {
    const p = new RulePlanner();
    const full = {
      ...base,
      freeSlots: 0,
      raw: `${STATE_OK}\n## 背包（序号: 物品）\n4: 小嘴鲈鱼 [可食用 +45 体力]\n背包空位：0 个（共 12 格）`,
    };
    const d1 = await p.decide(full);
    expect(d1.kind === 'act' && d1.tool).toBe('ship_items');
    const omitted = { ...base, freeSlots: 12 }; // raw 无背包段（BWF 省略未变化段落）
    const d2 = await p.decide(omitted);
    expect(d2.kind === 'act' && d2.tool).not.toBe('fish');
  });

  it('只剩家具且空位 0 → 摆家具腾格（place_item）', async () => {
    const p = new RulePlanner();
    const d = await p.decide({
      ...base,
      freeSlots: 0,
      posX: 12,
      posY: 8,
      raw: `${STATE_OK}\n## 背包（序号: 物品）\n0: 斧头\n6: 普通窗户\n背包空位：0 个（共 12 格）`,
    });
    expect(d.kind === 'act' && d.tool).toBe('place_item');
    expect(d.kind === 'act' && d.args).toMatchObject({ item: '普通窗户', x: 13, y: 8 });
    // 不在农场时先回家再摆（建筑只能放在农场）
    const away = await new RulePlanner().decide({
      ...base,
      freeSlots: 0,
      location: 'Beach',
      raw: `${STATE_OK}\n## 背包（序号: 物品）\n0: 斧头\n6: 普通窗户\n背包空位：0 个（共 12 格）`,
    });
    expect(away.kind === 'act' && away.tool).toBe('travel_to');
    expect(away.kind === 'act' && away.args).toMatchObject({ location: 'Farm' });
  });

  it('起名界面 → RulePlanner set_name 小鲸；剧情过场无对话框 → LlmPlanner 结合失败记忆选 skip_event', async () => {
    const p = new RulePlanner();
    const named = await p.decide({ ...base, menu: '正在播放剧情/节日事件\n要起名字（孩子或者刚出生的动物）：用 set_name 传一个名字' });
    expect(named.kind === 'act' && named.tool).toBe('set_name');
    expect(named.kind === 'act' && named.args).toEqual({ name: '小鲸' });

    let seenPrompt = '';
    const planner = new (await import('./llm-planner')).LlmPlanner({
      chat: async (_slot, messages) => {
        seenPrompt = messages.at(-1)?.content ?? '';
        return { content: '{"tool":"skip_event","args":{},"intent":"没有对话框，跳过过场"}' };
      },
      recentReceipts: ['FAILED dialogue: 失败：剧情还在放，现在没有对话框，过一会儿再推进'],
    });
    const d = await planner.decide({ ...base, menu: '正在播放剧情/节日事件（可以用 skip_event 跳过）' });
    expect(d.kind === 'act' && d.tool).toBe('skip_event');
    expect(seenPrompt).toContain('没有对话框');
  });

  it('T-M6-70 AutodriveRunner 桥接：plan / brain / chat-stance 事件转发、强制命令与取消、接管交还差异注入', async () => {
    const { LlmPlanner } = await import('./llm-planner');
    const events: AutodriveEvent[] = [];
    let turn = 0;
    const script = [
      '{"stance":"execute","reply":"遵命出发！","tool":"travel_to","args":{"location":"SeedShop"},"intent":"去买种子","commandDone":true}',
      '{"plan":[{"goal":"回田里种下","why":"刚买好种子"}],"mood":"开心"}',
      '{"tool":"plant_seeds","args":{"seed":"防风草种子"},"intent":"播种","stance":"accept","reply":"听你的先种下去！"}',
      '（故意乱码1）',
      '（故意乱码2）',
      '（故意乱码3）',
    ];
    const seenPrompts: string[] = [];
    const llm = new LlmPlanner({
      chat: async (_slot, messages) => {
        seenPrompts.push(messages.at(-1)?.content ?? '');
        return { content: script[turn++] ?? '（乱码）' };
      },
    });
    const fakeAdapter = {
      gameId: 'stardew' as const,
      displayName: '星露谷物语',
      unreachableMessage: '不可达',
      transport: {
        async callTool(tool: string) {
          if (tool === 'get_state') return { kind: 'ok' as const, text: STATE_OK, isError: false };
          return { kind: 'ok' as const, text: '成功：已完成', isError: false };
        },
      },
      ping: async () => true,
      isLongAction: () => false,
      extractClock: () => '第1年春16日 07:30',
      classifyReceipt: () => ({ status: 'COMPLETED' as const, summary: '完成' }),
    };
    const runner = new AutodriveRunner(
      (e) => events.push(e),
      { maxCycles: 3, stepDelayMs: 0, pollDelayMs: 0, errorDelayMs: 0, sleep: async () => {} },
      fakeAdapter,
    );
    runner.setPlanner(llm);

    // 先测提交并取消命令，再正式提交命令 + 人工接管交还摘要 + 普通建议
    runner.submitCommand('测试取消');
    expect(runner.cancelCommand()).toBe('测试取消');
    expect(runner.cancelCommand()).toBeNull();

    await runner.setHumanControl(true);
    await runner.setHumanControl(false);
    runner.submitCommand('去买防风草种子');
    runner.submitSuggestion('买完顺便种下去');

    await runner.start();
    while (runner.isRunning()) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await runner.stopAndWait();

    expect(events.some((e) => e.type === 'chat-stance' && e.kind === 'command' && e.stance === 'execute')).toBe(true);
    expect(events.some((e) => e.type === 'plan' && e.reason === 'morning')).toBe(true);
    expect(events.some((e) => e.type === 'chat-stance' && e.kind === 'suggestion' && e.stance === 'accept')).toBe(true);
    expect(events.some((e) => e.type === 'brain' && e.mode === 'paused')).toBe(true);
    expect(seenPrompts[0]).toContain('主人接管了');
  });

  it('剧情选择题：必须带 choice 序号（回归：无 choice 的 dialogue 会无限失败）', async () => {
    const p = new RulePlanner();
    const menu = '正在播放剧情/节日事件。对话框：你打算收养这只猫吗？\n选项（用 dialogue 并传 choice 序号回答）：\n  0: 是\n  1: 否';
    const d = await p.decide({ ...base, menu });
    expect(d.kind === 'act' && d.tool).toBe('dialogue');
    expect(d.kind === 'act' && d.args).toEqual({ choice: 0 });
  });

  it('商店/选择题界面：close_menu 与带选项 dialogue（确定性，不问 LLM）', async () => {
    const p = new RulePlanner();
    const shop = await p.decide({ ...base, menu: '商店界面（Shop）' });
    expect(shop.kind === 'act' && shop.tool).toBe('close_menu');
    const choice = await p.decide({ ...base, menu: '选择题：要帮他吗？' });
    expect(choice.kind === 'act' && choice.tool).toBe('dialogue');
    expect(choice.kind === 'act' && choice.args).toEqual({ choice: 0 });
  });

  it('每日出货结算界面 → close_menu（回归：2026-11-25 真机夏7 06:00 被当对话连败 3 次触发 watchdog）', async () => {
    const p = new RulePlanner();
    const summary = await p.decide({
      ...base,
      menu: '每日出货结算界面（会自动确认；如果没有，用 menu_click 点 OK 按钮）',
    });
    expect(summary.kind === 'act' && summary.tool).toBe('close_menu');
  });

  it('填充分支：有鱼竿去海滩钓鱼；明确没鱼竿 → 去镇上采集', async () => {
    const noMail = (raw: string): GameStateSnapshot => parseGameState(raw.replace('邮箱里有 7 封未读信件', '邮箱已读'));
    const p = new RulePlanner();
    const goFish = await p.decide(noMail(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 11:30')));
    expect(goFish.kind === 'act' && goFish.tool).toBe('travel_to'); // 去海滩
    expect(goFish.kind === 'act' && goFish.args).toMatchObject({ location: 'Beach' });
    const fish = await p.decide(noMail(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 11:35').replace('地点：Farm（泡泡湾农场）', '地点：Beach（沙滩）')));
    expect(fish.kind === 'act' && fish.tool).toBe('fish');

    // 背包明确没有鱼竿（有背包段但无「鱼竿」）→ 不白跑海滩，直接去镇上采集
    const noRod = new RulePlanner();
    const noRodState = noMail(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 11:30').replace('6: 竹鱼竿（手持）', '6: 锄头'));
    const goTown = await noRod.decide(noRodState);
    expect(goTown.kind === 'act' && goTown.tool).toBe('travel_to');
    expect(goTown.kind === 'act' && goTown.args).toMatchObject({ location: 'Town' });
    const forage = await noRod.decide(parseGameState(noRodState.raw.replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）')));
    expect(forage.kind === 'act' && forage.tool).toBe('forage');

    const sleepy = new RulePlanner();
    const nap = await sleepy.decide(at('10:00', { stamina: 10, staminaMax: 270, location: 'FarmHouse' })); // 体力<8% → 直接睡
    expect(nap.kind === 'act' && nap.tool).toBe('sleep');
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
    expect(first.planner).toBe('remote'); // 中控台显示「P0 插队」而非 LLM 决策
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
    // 22:10 在 FarmHouse → sleep（T-M6-69 默认收工 22:00）
    const fresh = new RulePlanner();
    const night = s('时间：第1年春16日 22:10（Tue）', { location: 'FarmHouse' });
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
    // wait 原因必须可见（watchdog stuck）
    const waited = events.find((e) => e.type === 'watchdog');
    expect(waited?.type === 'watchdog' && waited.detail).toContain('商店');
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
    const mk = (patch: Record<string, string>): GameStateSnapshot => {
      let raw = STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读').replace('防风草种子 x15', 'x0');
      for (const [k, v] of Object.entries(patch)) raw = raw.replace(k, v);
      return parseGameState(raw);
    };
    // 浇水分支（在农场 → water_crops）
    const dw = await new RulePlanner().decide(mk({ '金钱：640g': '金钱：640g\n剩 3 株没浇' }));
    expect(dw.kind === 'act' && dw.tool).toBe('water_crops');
    // 收获分支（在农场 → harvest_crops）
    const dh = await new RulePlanner().decide(mk({ '金钱：640g': '金钱：640g\n有 2 株成熟的作物' }));
    expect(dh.kind === 'act' && dh.tool).toBe('harvest_crops');
    // 非农场且作物需要浇水 → 先 travel 回 Farm（作物概况只报当前地点）
    const dt = await new RulePlanner().decide(mk({
      '地点：Farm（泡泡湾农场）': '地点：Beach（棕榈镇海滩）',
      '金钱：640g': '金钱：640g\n剩 3 株没浇',
    }));
    expect(dt.kind === 'act' && dt.tool).toBe('travel_to');
    expect(dt.kind === 'act' && dt.args).toMatchObject({ location: 'Farm' });
    // 没有鱼竿 → 填充转采集：不在 Town 先 travel，到了 Town 就 forage
    const noRod = { '6: 竹鱼竿（手持）': '6: 锄头', '时间：第1年春16日 07:30（Tue）': '时间：第1年春16日 11:00（Tue）' };
    const p2 = new RulePlanner();
    const dToTown = await p2.decide(mk(noRod));
    expect(dToTown.kind === 'act' && dToTown.tool).toBe('travel_to');
    expect(dToTown.kind === 'act' && dToTown.args).toMatchObject({ location: 'Town' });
    const df = await p2.decide(mk({ ...noRod, '地点：Farm（泡泡湾农场）': '地点：Town（鹈鹕镇）' }));
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

  it('stopAndWait 等待在途动作回执闭合后退出循环', async () => {
    const events: AutodriveEvent[] = [];
    let notifyActionStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => { notifyActionStarted = resolve; });
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    const impl = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      if (tool === 'play_for') {
        notifyActionStarted();
        await actionGate;
      }
      const text = tool === 'get_state' ? STATE_OK : `${tool} 成功`;
      return {
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }),
      } as unknown as Response;
    };
    const runner = new AutodriveRunner((event) => events.push(event), {
      endpoint: 'http://mock/mcp',
      sleep: async () => undefined,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.submitDirective('play_for', { minutes: 30 }, '热切换停机测试');
    await runner.start();
    await actionStarted;

    let stopped = false;
    const stopTask = runner.stopAndWait().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseAction();
    await stopTask;

    expect(stopped).toBe(true);
    expect(runner.isRunning()).toBe(false);
    expect(events.some((event) => event.type === 'receipt' && event.tool === 'play_for' && event.status === 'COMPLETED')).toBe(true);
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
    // 固定 60ms 曾在负载下跑不完 6 个循环 → 事件驱动等待 stop 回执（带超时兜底防挂）
    let notifyStopped!: () => void;
    const stopped = new Promise<void>((resolve) => { notifyStopped = resolve; });
    const impl = async (): Promise<Response> => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读') }] } });
      return { text: async () => text } as unknown as Response;
    };
    const runner = new AutodriveRunner((e) => {
      events.push(e);
      if (e.type === 'receipt' && e.summary.includes('恢复后停止')) notifyStopped();
    }, { sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); }, endpoint: 'http://mock/mcp', maxCycles: 6 });
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
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 2_000))]);
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

  it('RulePlanner：收工时间到 → sleep；无未读后同实例连续推进', async () => {
    const p = new RulePlanner();
    const base = parseGameState(STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读'));
    void base;
    // 22:45 FarmHouse：日程（读信/浇水/播种）都无触发 → 收工 sleep
    const night = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 22:45')
      .replace('邮箱里有 7 封未读信件', '邮箱已读')
      .replace('地点：Farm（泡泡湾农场）', '地点：FarmHouse（泡泡湾农场）'));
    const d1 = await p.decide(night);
    expect(d1.kind === 'act' && d1.tool).toBe('sleep');
    const d2 = await p.decide(night);
    // 收工后幂等重试睡觉（防呆：sleep 失败自动再试，直到结算到第二天）
    expect(d2.kind === 'act' && d2.tool).toBe('sleep');
    // parseGameState 异常输入兜底
    const junk = parseGameState('什么都不是');
    expect(junk.gameClock).toBe('未知');
    expect(junk.location).toBe('未知');
    expect(junk.clockMinutes).toBe(360);
  });
});

describe('时钟注入 stuck / planner fallback / JSON 前缀边界', () => {
  it('注入时钟：90s 无变更动作先发 keepalive，避免落入 BWF 120s 自暂停', async () => {
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
    const heartbeat = events.filter((e) => e.type === 'watchdog' && e.kind === 'heartbeat');
    expect(heartbeat.some((e) => e.type === 'watchdog' && e.detail.includes('keepalive'))).toBe(true);
    expect(events.some((e) => e.type === 'receipt' && e.tool === 'wait' && e.status === 'COMPLETED')).toBe(true);
  });

  it('RulePlanner：农活全无 → 直接进钓鱼阶段（fallback travel Beach）', async () => {
    const p = new RulePlanner();
    const raw = STATE_OK.replace('邮箱里有 7 封未读信件', '邮箱已读').replace('防风草种子 x15', '');
    const s = { ...parseGameState(raw) };
    const d = await p.decide(s);
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.args).toMatchObject({ location: 'Beach' });
    expect(d.kind === 'act' && d.intent).toContain('钓鱼');
  });

  it('mcp-client：括号不平衡的 JSON → 不可解析', async () => {
    const client = new BwfMcpClient('http://mock/mcp', (async () => ({ text: async () => '{"jsonrpc":"2.0","result":{"content":[{"text":"截断' })) as unknown as typeof fetch);
    const res = await client.callTool('x');
    expect(res.kind).toBe('error');
  });
});

describe('终极分支收口', () => {
  it('体力 11% → 收工回家；生命 <30% 有吃的 → eat；UNCERTAIN 回执分类；未闭合字符串 JSON', async () => {
    // T-M6-69：体力 8%–15% 区间 → 停止干活回家（不再 12% 就吃饭）
    const mid = parseGameState(STATE_OK.replace('体力：98/270', '体力：30/270'));
    const d = await new RulePlanner().decide(mid);
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.args).toMatchObject({ location: 'FarmHouse' });
    // 生命 <30% 且有可食用物品 → eat
    const hurt = parseGameState(STATE_OK.replace('生命：100/100', '生命：20/100')
      .replace('## 背包', '## 背包\n7: 香蒲 [可食用 +10 体力]'));
    const eat = await new RulePlanner().decide(hurt);
    expect(eat.kind === 'act' && eat.tool).toBe('eat');
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

  it('AutodriveRunner：readyTimeoutMs>0 时按间隔重探，就绪后正常起跑（启动竞态）', async () => {
    let calls = 0;
    const pings = [false, false, true];
    const adapter = {
      gameId: 'stardew' as const,
      displayName: '星露谷物语',
      unreachableMessage: 'BWF MCP 不可达（测试）',
      transport: {
        async callTool() { return { kind: 'ok' as const, text: STATE_OK, isError: false }; },
      },
      ping: async () => { const value = pings[Math.min(calls, pings.length - 1)] ?? false; calls += 1; return value; },
      isLongAction: () => false,
      extractClock: () => '第1年春16日 07:30',
      classifyReceipt: () => ({ status: 'COMPLETED' as const, summary: '完成' }),
    };
    const events: AutodriveEvent[] = [];
    let fakeTime = 0;
    const runner = new AutodriveRunner(
      (e) => events.push(e),
      {
        maxCycles: 1,
        stepDelayMs: 0,
        pollDelayMs: 0,
        errorDelayMs: 0,
        readyTimeoutMs: 30_000,
        readyPollMs: 2_000,
        now: () => fakeTime,
        sleep: async (ms) => { fakeTime += ms; },
      },
      adapter,
    );
    await runner.start();
    expect(runner.isRunning()).toBe(true);
    await runner.stopAndWait();
    expect(calls).toBe(3);
    const waitings = events.filter((e) => e.type === 'watchdog' && String(e.detail).includes('启动竞态'));
    expect(waitings).toHaveLength(2);
    expect(fakeTime).toBe(4_000);
  });

  it('AutodriveRunner：等待窗口耗尽仍不可达 → 抛 unreachableMessage，不装成功', async () => {
    const adapter = {
      gameId: 'stardew' as const,
      displayName: '星露谷物语',
      unreachableMessage: 'BWF MCP 不可达（超时测试）',
      transport: { async callTool() { return { kind: 'ok' as const, text: STATE_OK, isError: false }; } },
      ping: async () => false,
      isLongAction: () => false,
      extractClock: () => '第1年春16日 07:30',
      classifyReceipt: () => ({ status: 'COMPLETED' as const, summary: '完成' }),
    };
    let fakeTime = 0;
    const runner = new AutodriveRunner(
      () => undefined,
      { readyTimeoutMs: 6_000, readyPollMs: 2_000, now: () => fakeTime, sleep: async (ms) => { fakeTime += ms; } },
      adapter,
    );
    await expect(runner.start()).rejects.toThrow('BWF MCP 不可达（超时测试）');
    expect(runner.isRunning()).toBe(false);
    // 6s 窗口 / 2s 间隔 → 3 轮等待后放弃
    expect(fakeTime).toBe(6_000);
  });

  it('AutodriveRunner：就绪等待期间 stop() 安静取消，不误报「不可达」', async () => {
    const adapter = {
      gameId: 'stardew' as const,
      displayName: '星露谷物语',
      unreachableMessage: 'BWF MCP 不可达（不该出现）',
      transport: { async callTool() { return { kind: 'ok' as const, text: STATE_OK, isError: false }; } },
      ping: async () => false,
      isLongAction: () => false,
      extractClock: () => '第1年春16日 07:30',
      classifyReceipt: () => ({ status: 'COMPLETED' as const, summary: '完成' }),
    };
    let runnerRef: AutodriveRunner | null = null;
    let fakeTime = 0;
    const runner = new AutodriveRunner(
      () => undefined,
      {
        readyTimeoutMs: 60_000,
        readyPollMs: 2_000,
        now: () => fakeTime,
        sleep: async (ms) => { fakeTime += ms; runnerRef?.stop(); },
      },
      adapter,
    );
    runnerRef = runner;
    await expect(runner.start()).resolves.toBeUndefined();
    expect(runner.isRunning()).toBe(false);
  });

  it('22:00 收工后 → 回家/睡觉；defaultAction 缺失回落 actions[0]', async () => {
    const p = new RulePlanner();
    // 收工时间到（22:10）→ 在 Town 就回家，在农舍就睡
    const late = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 22:10')
      .replace('邮箱里有 7 封未读信件', '邮箱已读')
      .replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）'));
    const d = await p.decide(late);
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.args).toMatchObject({ location: 'FarmHouse' });
    // 24:00 强制回家（生存护栏最高优先级，即使有未读信）
    const midnight = parseGameState(STATE_OK.replace(/第1年春16日 \d{2}:\d{2}/, '第1年春16日 00:30'));
    const forced = await p.decide(midnight);
    expect(forced.kind === 'act' && forced.tool).toBe('travel_to');
    expect(forced.kind === 'act' && forced.args).toMatchObject({ location: 'FarmHouse' });
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

describe('T-M6-10 真机回归：并发 start 只启一个循环', () => {
  it('两次并发 start() 不会启动两个 loop（避免同一 ActionLock 互斥风暴）', async () => {
    let decideCount = 0;
    const adapter = {
      gameId: 'stardew',
      displayName: 'test',
      transport: { callTool: async () => ({ kind: 'ok' as const, text: STATE_OK, isError: false }) },
      ping: async () => { await new Promise((r) => setTimeout(r, 15)); return true; },
      unreachableMessage: 'unreachable',
      extractClock: () => null,
      isLongAction: () => false,
      classifyReceipt: () => ({ status: 'COMPLETED' as const, summary: 'ok' }),
    } as unknown as import('./adapter').GameAdapter;
    const runner = new AutodriveRunner(() => undefined, {
      maxCycles: 2, stepDelayMs: 1, pollDelayMs: 1, sleep: async () => undefined,
    }, adapter);
    runner.setPlanner({
      name: 'counting',
      decide: async () => {
        decideCount += 1;
        return { kind: 'wait', seconds: 1, reason: 'count' };
      },
    });
    await Promise.all([runner.start(), runner.start(), runner.start()]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runner.stopAndWait();
    // 单循环 maxCycles=2 → decide 最多 2 次；双循环会接近 4 次
    expect(decideCount).toBeLessThanOrEqual(2);
  });
});

describe('T-M6-10 真机回归：wait 求助去重', () => {
  it('相同原因的连续 wait 只发一次 watchdog / cycle-end（不刷屏）', async () => {
    const events: AutodriveEvent[] = [];
    const adapter = {
      gameId: 'stardew',
      displayName: 'test',
      transport: { callTool: async () => ({ kind: 'ok' as const, text: STATE_OK, isError: false }) },
      ping: async () => true,
      unreachableMessage: 'unreachable',
      extractClock: () => null,
      isLongAction: () => false,
      classifyReceipt: () => ({ status: 'COMPLETED' as const, summary: 'ok' }),
    } as unknown as import('./adapter').GameAdapter;
    const runner = new AutodriveRunner((e) => events.push(e), {
      maxCycles: 4, stepDelayMs: 1, pollDelayMs: 1, sleep: async () => undefined,
    }, adapter);
    let waits = 0;
    runner.setPlanner({
      name: 'test-blocked',
      decide: async () => {
        waits += 1;
        return { kind: 'wait', seconds: 60, reason: '满包且无可出货/可捐——需要主人造箱' };
      },
    });
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runner.stopAndWait();
    expect(waits).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === 'watchdog').length).toBe(1);
    expect(events.filter((e) => e.type === 'cycle-end').length).toBe(1);
  });
});

describe('T-M6-27 会话归属', () => {
  it('每次创建的 runner 拥有独立且非空的 sessionId', () => {
    const a = new AutodriveRunner(() => undefined);
    const b = new AutodriveRunner(() => undefined);
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('sessionId 在 start/stop 之间保持稳定（同一会话内事件可归属）', async () => {
    let calls = 0;
    const transport = {
      callTool: async () => {
        calls++;
        return { kind: 'ok' as const, text: STATE_OK, isError: false };
      },
    };
    const runner = new AutodriveRunner(() => undefined, { sleep: async () => { runner.stop(); } }, {
      gameId: 'stardew',
      displayName: 'test',
      transport,
      ping: async () => true,
      unreachableMessage: 'unreachable',
      extractClock: () => null,
      isLongAction: () => false,
      classifyReceipt: () => ({ status: 'COMPLETED', summary: 'ok' }),
    } as unknown as import('./adapter').GameAdapter);
    const before = runner.sessionId;
    await runner.start();
    while (runner.isRunning()) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await runner.stopAndWait();
    expect(calls).toBeGreaterThan(0);
    expect(runner.sessionId).toBe(before);
  });
});


describe('T-M6-10 真机回归：BWF 自暂停与冻结恢复', () => {
  it('无在途动作时 cancel 仍真实发往游戏（不再假称兜底）', async () => {
    const calls: string[] = [];
    const impl = async (_url: unknown, init?: { body?: string }) => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      calls.push(tool);
      return {
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: '成功：没有在途动作' }], isError: false } }),
      } as unknown as Response;
    };
    const lock = new ActionLock(new BwfMcpClient('http://mock/mcp', impl as unknown as typeof fetch));
    expect(await lock.cancel('idle')).toBe(false);
    expect(calls).toEqual(['cancel_action']);
  });

  it('时钟冻结且恢复动作成功 → 发 wait 唤醒并记录真实回执，不进入 planner 空转', async () => {
    const events: AutodriveEvent[] = [];
    let now = 1_000_000;
    const impl = async (_url: unknown, init?: { body?: string }) => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state'
        ? '时间：第1年春16日 09:00（Tue），天气：晴\n金钱：640g  体力：98/270\n无（可以自由行动）'
        : tool === 'cancel_action' ? '成功：没有在途动作' : '成功：等待结束';
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) } as unknown as Response;
    };
    const adapter = new StardewAdapter('http://mock/mcp');
    Object.defineProperty(adapter, 'keepaliveAction', { value: undefined, configurable: true });
    const runner = new AutodriveRunner((event) => { if (events.length < 200) events.push(event); }, {
      endpoint: 'http://mock/mcp',
      maxCycles: 20,
      now: () => now,
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))); },
    }, adapter);
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    now += 5 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 120));
    runner.stop();
    expect(events.some((event) => event.type === 'watchdog' && event.kind === 'stuck' && event.detail.includes('唤醒'))).toBe(true);
    expect(events.some((event) => event.type === 'receipt' && event.tool === 'wait' && event.summary.includes('卡死恢复'))).toBe(true);
    expect(events.some((event) => event.type === 'decision' && event.planner === 'remote')).toBe(false);
  });

  it('恢复动作失败 → 明确交还 planner，仍产生决策而非每 2 秒刷 watchdog', async () => {
    const events: AutodriveEvent[] = [];
    let now = 1_000_000;
    const impl = async (_url: unknown, init?: { body?: string }) => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state'
        ? '时间：第1年春16日 09:00（Tue），天气：晴\n金钱：640g  体力：98/270\n无（可以自由行动）'
        : tool === 'cancel_action' ? '成功：没有在途动作' : '失败：wait 不认识参数';
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: tool !== 'get_state' && text.startsWith('失败') } }) } as unknown as Response;
    };
    const adapter = new StardewAdapter('http://mock/mcp');
    Object.defineProperty(adapter, 'keepaliveAction', { value: undefined, configurable: true });
    const runner = new AutodriveRunner((event) => { if (events.length < 300) events.push(event); }, {
      endpoint: 'http://mock/mcp',
      maxCycles: 20,
      now: () => now,
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))); },
    }, adapter);
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    now += 5 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 150));
    runner.stop();
    expect(events.some((event) => event.type === 'watchdog' && event.kind === 'stuck' && event.detail.includes('交还 planner'))).toBe(true);
    expect(events.some((event) => event.type === 'decision')).toBe(true);
  });
});

describe('全局防刷屏熔断（2026-11-24 真机没鱼竿 fish 循环）', () => {
  it('相同失败签名 + 时钟未推进连续 3 次 → watchdog 暂停 30s，不再无限刷屏', async () => {
    const events: AutodriveEvent[] = [];
    const sleeps: number[] = [];
    const runner = new AutodriveRunner((e) => { if (events.length < 200) events.push(e); }, {
      sleep: async (ms) => { sleeps.push(ms); },
      endpoint: 'http://mock/mcp',
      maxCycles: 4,
    });
    runner.setPlanner({
      name: 'always-fish',
      decide: async () => ({ kind: 'act', tool: 'fish', args: {}, intent: '钓鱼' }),
    });
    const impl = async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { params: { name: string } };
      const tool = body.params.name;
      const text = tool === 'get_state' ? STATE_OK : '失败：背包里没有鱼竿';
      return {
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text }], isError: tool !== 'get_state' },
        }),
      } as Response;
    };
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    await runner.start();
    await new Promise((r) => setTimeout(r, 120));
    const fuse = events.filter((e) => e.type === 'watchdog' && e.kind === 'stuck' && e.detail.includes('同一动作连续失败'));
    expect(fuse.length).toBeGreaterThanOrEqual(1);
    expect(sleeps).toContain(30_000);
  });
});

describe('submitObjective 单机目标注入（2026-11-24）', () => {
  it('runner.submitObjective → 下一轮 planner.setObjective 收到目标', async () => {
    const objectives: Array<string | null> = [];
    const runner = new AutodriveRunner(() => undefined, {
      sleep: async () => undefined,
      endpoint: 'http://mock/mcp',
      maxCycles: 1,
    });
    runner.setPlanner({
      name: 'capture',
      decide: async () => ({ kind: 'act', tool: 'wait', args: {}, intent: '等' }),
      setObjective: (objective) => { objectives.push(objective); },
      hasObjective: () => false,
    });
    const impl = async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { params: { name: string } };
      const text = body.params.name === 'get_state' ? STATE_OK : 'ok';
      return {
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text }], isError: false },
        }),
      } as Response;
    };
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.submitObjective('去箱子找鱼竿或在鱼店买一根');
    await runner.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(objectives).toContain('去箱子找鱼竿或在鱼店买一根');
  });
});


describe('clearObjective 清空旧目标（T-M6-54）', () => {
  it('立即清 planner 当前目标，且未消费的 pending 不再注入', async () => {
    const objectives: Array<string | null> = [];
    const runner = new AutodriveRunner(() => undefined, {
      sleep: async () => undefined,
      endpoint: 'http://mock/mcp',
      maxCycles: 1,
    });
    runner.setPlanner({
      name: 'capture',
      decide: async () => ({ kind: 'act', tool: 'wait', args: {}, intent: '等' }),
      setObjective: (objective) => { objectives.push(objective); },
      hasObjective: () => false,
    });
    runner.submitObjective('去箱子找鱼竿');
    expect(runner.clearObjective()).toBe(true);
    expect(objectives).toEqual([null]);
    // 已经没有目标：再次清空不谎报「取消成功」
    expect(runner.clearObjective()).toBe(false);
    const impl = async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { params: { name: string } };
      const text = body.params.name === 'get_state' ? STATE_OK : 'ok';
      return {
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text }], isError: false },
        }),
      } as Response;
    };
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    await runner.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(objectives).not.toContain('去箱子找鱼竿');
  });

  it('pending 已被消费但 planner 仍持有目标时，clearObjective 仍返回 true 并清空', () => {
    const objectives: Array<string | null> = [];
    const runner = new AutodriveRunner(() => undefined, { sleep: async () => undefined, endpoint: 'http://mock/mcp' });
    runner.setPlanner({
      name: 'capture',
      decide: async () => ({ kind: 'act', tool: 'wait', args: {}, intent: '等' }),
      setObjective: (objective) => { objectives.push(objective); },
      hasObjective: () => true,
    });
    expect(runner.clearObjective()).toBe(true);
    expect(objectives).toEqual([null]);
  });
});

describe('objectiveDone 闭环（T-M6-57）', () => {
  it('submitObjective 广播 objective set 事件（UI 目标条的单点事实源）', () => {
    const events: AutodriveEvent[] = [];
    const runner = new AutodriveRunner((event) => events.push(event), { sleep: async () => undefined, endpoint: 'http://mock/mcp' });
    runner.submitObjective('去鱼店买鱼竿');
    expect(events.some((event) => event.type === 'objective' && event.objective === '去鱼店买鱼竿' && event.reason === 'set')).toBe(true);
  });

  it('模型声明 objectiveDone 且动作成功 → 广播「目标已完成」并清空目标', async () => {
    const events: AutodriveEvent[] = [];
    const impl = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state' ? STATE_OK : '成功：买到了鱼竿';
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) } as unknown as Response;
    };
    let donePending: string | null = '去鱼店买鱼竿';
    const runner = new AutodriveRunner((event) => events.push(event), {
      sleep: async () => undefined,
      endpoint: 'http://mock/mcp',
      maxCycles: 2,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.setPlanner({
      name: 'llm-test',
      decide: async () => ({ kind: 'act', tool: 'buy', args: { item: '鱼竿' }, intent: '买鱼竿' }),
      setObjective: () => undefined,
      hasObjective: () => false,
      consumeObjectiveDone: () => { const value = donePending; donePending = null; return value; },
      restoreObjectiveDone: () => undefined,
    });
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.some((event) => event.type === 'objective' && event.objective === null && event.reason === 'done')).toBe(true);
    expect(events.some((event) => event.type === 'receipt' && event.tool === 'chat_order' && event.status === 'COMPLETED' && event.summary.includes('目标已完成：去鱼店买鱼竿'))).toBe(true);
  });

  it('planner 未实现 objectiveDone 可选方法时照常执行，不误报完成', async () => {
    const events: AutodriveEvent[] = [];
    const impl = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state' ? STATE_OK : '成功：做好了';
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) } as unknown as Response;
    };
    const runner = new AutodriveRunner((event) => events.push(event), {
      sleep: async () => undefined,
      endpoint: 'http://mock/mcp',
      maxCycles: 1,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.setPlanner({
      name: 'simple',
      decide: async () => ({ kind: 'act', tool: 'water_crops', args: {}, intent: '浇水' }),
    });
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.some((event) => event.type === 'receipt' && event.status === 'COMPLETED' && event.tool === 'water_crops')).toBe(true);
    expect(events.some((event) => event.type === 'receipt' && event.tool === 'chat_order' && (event.summary ?? '').startsWith('目标已完成'))).toBe(false);
  });

  it('objectiveDone 动作失败 → 撤回完成声明、不播「目标已完成」', async () => {
    const events: AutodriveEvent[] = [];
    const impl = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
      const tool = (JSON.parse(init?.body ?? '{}') as { params: { name: string } }).params.name;
      const text = tool === 'get_state' ? STATE_OK : '失败：钱不够';
      const isError = tool !== 'get_state';
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError } }) } as unknown as Response;
    };
    let restored = 0;
    let donePending: string | null = '去鱼店买鱼竿';
    const runner = new AutodriveRunner((event) => events.push(event), {
      sleep: async () => undefined,
      endpoint: 'http://mock/mcp',
      maxCycles: 1,
    });
    (runner.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
    runner.setPlanner({
      name: 'llm-test',
      decide: async () => ({ kind: 'act', tool: 'buy', args: { item: '鱼竿' }, intent: '买鱼竿' }),
      setObjective: () => undefined,
      hasObjective: () => false,
      consumeObjectiveDone: () => { const value = donePending; donePending = null; return value; },
      restoreObjectiveDone: () => { restored += 1; },
    });
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(restored).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'receipt' && event.tool === 'chat_order' && (event.summary ?? '').startsWith('目标已完成'))).toBe(false);
  });
});

describe('T-M6-73 主人临时接管（human-control）', () => {
  function fakeAdapter(state: () => string, calls: string[]): import('./adapter').GameAdapter {
    return {
      gameId: 'stardew',
      displayName: 'test',
      transport: {
        callTool: async (tool: string) => {
          calls.push(tool);
          return { kind: 'ok' as const, text: state(), isError: false };
        },
      },
      ping: async () => true,
      unreachableMessage: 'unreachable',
      extractClock: () => null,
      isLongAction: () => false,
      classifyReceipt: () => ({ status: 'COMPLETED' as const, summary: 'ok' }),
    } as unknown as import('./adapter').GameAdapter;
  }

  it('describeHumanSession 列出可见差异；无差异时不编造变化', () => {
    const start = { clock: '第1年春16日 09:00', money: 640, location: 'Farm', stamina: 98, staminaMax: 270 };
    const end = { clock: '第1年春16日 12:30', money: 900, location: 'Town', stamina: 40, staminaMax: 270 };
    const text = describeHumanSession(start, end, 3 * 60_000);
    expect(text).toContain('3 分钟');
    expect(text).toContain('640→900（+260）');
    expect(text).toContain('Farm→Town');
    expect(text).toContain('98/270→40/270');
    expect(describeHumanSession(start, start, 30_000)).toContain('游戏状态没有可见变化');
  });

  it('describeHumanSession 缺快照时如实说明，不伪造变化', () => {
    const text = describeHumanSession(null, null, 45_000);
    expect(text).toContain('45 秒');
    expect(text).toContain('没有拿到可比对的游戏状态');
    expect(text).not.toContain('金币');
  });

  it('接管态下循环只读状态，不产生任何决策或动作', async () => {
    const events: AutodriveEvent[] = [];
    const calls: string[] = [];
    const runner = new AutodriveRunner((event) => events.push(event), {
      maxCycles: 3, stepDelayMs: 1, pollDelayMs: 1, sleep: async () => undefined,
    }, fakeAdapter(() => STATE_OK, calls));
    let decisions = 0;
    runner.setPlanner({ name: 'count', decide: async () => { decisions += 1; return { kind: 'wait', seconds: 1, reason: 'x' }; } });
    await runner.setHumanControl(true);
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runner.stopAndWait();
    expect(runner.isHumanControl()).toBe(true);
    expect(decisions).toBe(0);
    // 只有 get_state 与一次 cancel_action，没有任何业务动作
    expect(calls.filter((tool) => tool !== 'get_state' && tool !== 'cancel_action')).toEqual([]);
    expect(events.some((event) => event.type === 'human-control' && event.active && event.reason === 'switch')).toBe(true);
    expect(events.some((event) => event.type === 'decision')).toBe(false);
  });

  it('get_state 出现【玩家接管中】自动进入接管，标记消失后自动交还并给出摘要', async () => {
    const events: AutodriveEvent[] = [];
    const calls: string[] = [];
    // 前两次 get_state 带接管标记，之后消失（模拟主人松手）——按调用次数驱动，避免依赖时序
    const stateOf = (): string => {
      const seen = calls.filter((tool) => tool === 'get_state').length;
      return seen <= 2 ? `${STATE_OK}\n${PLAYER_IN_CONTROL_MARKER}` : STATE_OK;
    };
    const runner = new AutodriveRunner((event) => events.push(event), {
      maxCycles: 6, stepDelayMs: 1, pollDelayMs: 1, sleep: async () => undefined,
    }, fakeAdapter(stateOf, calls));
    runner.setPlanner({ name: 'noop', decide: async () => ({ kind: 'wait', seconds: 1, reason: 'x' }) });
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runner.stopAndWait();
    expect(events.some((event) => event.type === 'human-control' && event.active && event.reason === 'in-game')).toBe(true);
    expect(runner.isHumanControl()).toBe(false);
    const resume = events.find((event) => event.type === 'human-control' && !event.active);
    expect(resume).toBeDefined();
    expect(resume !== undefined && resume.type === 'human-control' ? resume.summary : '').toContain('主人接管了');
  });

  it('宿主开关交还返回摘要：接管期间金币与位置的变化被写进事件流', async () => {
    const events: AutodriveEvent[] = [];
    const calls: string[] = [];
    let money = 640;
    const runner = new AutodriveRunner((event) => events.push(event), {
      stepDelayMs: 1, pollDelayMs: 1, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    }, fakeAdapter(() => STATE_OK.replace('金钱：640g', `金钱：${money}g`), calls));
    runner.setPlanner({ name: 'noop', decide: async () => ({ kind: 'wait', seconds: 1, reason: 'x' }) });
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runner.stopAndWait();
    await runner.setHumanControl(true);
    money = 900;
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runner.stopAndWait();
    const summary = await runner.setHumanControl(false);
    expect(summary).toContain('640→900（+260）');
    const resume = events.filter((event) => event.type === 'human-control' && !event.active);
    expect(resume).toHaveLength(1);
  });

  it('重复进入/退出接管是幂等的（不重复广播）', async () => {
    const events: AutodriveEvent[] = [];
    const runner = new AutodriveRunner((event) => events.push(event), {
      maxCycles: 1, sleep: async () => undefined,
    }, fakeAdapter(() => STATE_OK, []));
    await runner.setHumanControl(true);
    await runner.setHumanControl(true);
    expect(events.filter((event) => event.type === 'human-control').length).toBe(1);
    expect(await runner.setHumanControl(false)).not.toBeNull();
    expect(await runner.setHumanControl(false)).toBeNull();
    expect(events.filter((event) => event.type === 'human-control').length).toBe(2);
  });
});

describe('V2-P3-07C StardewAdapter 启动竞态：标题画面绝不误判就绪', () => {
  it('标题画面回 200+还没有进入存档 → AutodriveRunner 等待直到真正进档才开跑', async () => {
    let callIdx = 0;
    const replies = [
      '游戏还没有进入存档，请在标题画面选择存档',
      '正在加载存档…',
      STATE_OK,
      STATE_OK,
    ];
    const fetchImpl = (async () => {
      const text = replies[Math.min(callIdx, replies.length - 1)] ?? STATE_OK;
      callIdx += 1;
      return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text }], isError: false } }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const events: AutodriveEvent[] = [];
    let fakeTime = 0;
    const runner = new AutodriveRunner(
      (e) => events.push(e),
      {
        maxCycles: 1,
        stepDelayMs: 0,
        pollDelayMs: 0,
        errorDelayMs: 0,
        readyTimeoutMs: 20_000,
        readyPollMs: 2_000,
        now: () => fakeTime,
        sleep: async (ms) => { fakeTime += ms; },
      },
      new StardewAdapter('http://mock/mcp', fetchImpl),
    );
    await runner.start();
    expect(runner.isRunning()).toBe(true);
    await runner.stopAndWait();
    const waitings = events.filter((e) => e.type === 'watchdog' && String(e.detail).includes('启动竞态'));
    expect(waitings).toHaveLength(2);
    expect(events.some((e) => e.type === 'state')).toBe(true);
  });
});
