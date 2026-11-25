/**
 * T-M6-01 完整版门禁：LLM Planner 决策协议 / 坏输出回落 / 白名单越权拦截 / 攻略检索。
 * T-M6-12 决策循环防抖门禁：单日失败预算与冷却 / dialogue 效果核验 / donate→bundle_info / 真纠错重问。
 * chat 全注入 mock（零网络）。真机病灶：同一冻结分钟 dialogue×191 / place_item×96 / donate_bundles×29。
 */
import { describe, expect, it } from 'vitest';
import { extractDecisionJson, festivalWindowOf, LlmPlanner, LLM_TOOL_WHITELIST, MAX_OBJECTIVE_ROUNDS, pickGuideContext, pickPrematureReservedEdible, pickShippableItem } from './llm-planner';
import { countWood, hasChestItem, isRaining, parseGameState, pickFurnitureToPlace, RulePlanner, type GameStateSnapshot } from './planner';

const STATE_OK = `时间：第1年春16日 07:30（Tue），天气：晴
金钱：640g  体力：98/270
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场）
邮箱里有 7 封未读信件`;

/** 真机 2026-11-22 现场原样：背包空位 0，钓鱼连续 FAILED */
const STATE_FULL = `${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）')}
## 背包（序号: 物品）
0: 斧头
11: 小嘴鲈鱼 [可食用 +25 体力]
背包空位：0 个（共 12 格）`;

const state = (): GameStateSnapshot => parseGameState(STATE_OK);

describe('extractDecisionJson', () => {
  it('纯 JSON / markdown 围栏 / 前后缀文本 三形态全解析', () => {
    expect(extractDecisionJson('{"tool":"read_mail","args":{},"intent":"读信"}')).toMatchObject({ tool: 'read_mail' });
    expect(extractDecisionJson('```json\n{"tool":"fish","args":{"casts":5},"intent":"钓鱼"}\n```')).toMatchObject({ tool: 'fish', args: { casts: 5 } });
    expect(extractDecisionJson('小鲸想了一下：{"tool":"sleep","args":{}} 就这么办！')).toMatchObject({ tool: 'sleep' });
    expect(extractDecisionJson('{"tool":"say","args":{"text":"quote: \\"hi\\""},"intent":"escaped"}'))
      .toMatchObject({ tool: 'say', args: { text: 'quote: "hi"' } });
  });

  it('坏输出返回 null：无 JSON / 缺 tool / 截断', () => {
    expect(extractDecisionJson('我就想睡觉不输出 JSON')).toBeNull();
    expect(extractDecisionJson('{"args":{},"intent":"x"}')).toBeNull();
    expect(extractDecisionJson('{"tool":"fish","args":{"casts":')).toBeNull();
    expect(extractDecisionJson('{"tool": bad json }')).toBeNull(); // JSON.parse 抛错也须吞掉
  });
});

describe('白名单与攻略检索', () => {
  it('常用工具在白名单；危险/未知工具不在', () => {
    for (const t of ['read_mail', 'fish', 'sleep', 'travel_to', 'get_state']) expect(LLM_TOOL_WHITELIST.has(t)).toBe(true);
    expect(LLM_TOOL_WHITELIST.has('exec')).toBe(false);
    expect(LLM_TOOL_WHITELIST.has('rm_rf')).toBe(false);
  });

  it('状态含钓鱼线索 → 钓鱼攻略节选；无线索 → 空', () => {    const guides = { 钓鱼: '钓鱼攻略正文'.repeat(200), 采矿: '采矿攻略' };
    const s = { ...state(), raw: state().raw + '去海边钓鱼（fish）' };
    const ctx = pickGuideContext(s, guides);
    expect(ctx).toContain('钓鱼 专题节选');
    expect(ctx.length).toBeLessThanOrEqual(1200 + 60);
    const noHint = pickGuideContext(state(), guides);
    expect(noHint).toBe('');
  });
});

describe('LLM Planner adapter seam', () => {
  it('uses the adapter game slot, tool whitelist, system prompt, and rule fallback', async () => {
    const calls: Array<{ slot: string; system: string }> = [];
    const fallback = {
      name: 'terraria-rule',
      decide: async () => ({ kind: 'act' as const, tool: 'mine', args: { target: 'tree' }, intent: '规则兜底' }),
    };
    const planner = new LlmPlanner({
      slot: 'TERRARIA_GAME_PLANNER',
      systemPrompt: '泰拉瑞亚专属提示',
      toolWhitelist: ['mine'],
      fallbackPlanner: fallback,
      chat: async (slot, messages) => {
        calls.push({ slot, system: messages[0]?.content ?? '' });
        return { content: '{"tool":"mine","args":{"target":"tree"},"intent":"砍树"}' };
      },
    });
    expect(await planner.decide(state())).toMatchObject({ kind: 'act', tool: 'mine', intent: '砍树' });
    expect(calls).toEqual([{ slot: 'TERRARIA_GAME_PLANNER', system: '泰拉瑞亚专属提示' }]);

    let retries = 0;
    const invalid = new LlmPlanner({
      slot: 'DST_GAME_PLANNER',
      systemPrompt: 'DST 专属提示',
      toolWhitelist: ['gather'],
      fallbackPlanner: { name: 'dst-rule', decide: async () => ({ kind: 'act', tool: 'gather', args: {}, intent: 'DST 兜底' }) },
      chat: async () => { retries++; return { content: '{"tool":"fish","args":{}}' }; },
    });
    expect(await invalid.decide(state())).toMatchObject({ kind: 'act', tool: 'gather', intent: '规则兜底：DST 兜底' });
    expect(retries).toBe(2);
    expect(invalid.asks).toBe(1);
  });

  it('systemPrompt 支持惰性求值：角色热切换后下一次决策即使用新角色名', async () => {
    let who = '蓝蓝';
    const systems: string[] = [];
    const planner = new LlmPlanner({
      systemPrompt: () => `你是${who}，正在替主人游玩《泰拉瑞亚》。`,
      toolWhitelist: ['mine'],
      chat: async (_slot, messages) => {
        systems.push(messages[0]?.content ?? '');
        return { content: '{"tool":"mine","args":{},"intent":"挖矿"}' };
      },
    });
    await planner.decide(state());
    who = '小克';
    await planner.decide(state());
    expect(systems).toEqual([
      '你是蓝蓝，正在替主人游玩《泰拉瑞亚》。',
      '你是小克，正在替主人游玩《泰拉瑞亚》。',
    ]);
  });

  it('retries adapter gateway errors and then falls back to its rule planner', async () => {
    const slots: string[] = [];
    const planner = new LlmPlanner({
      systemPrompt: 'DST 专属提示',
      toolWhitelist: ['gather'],
      fallbackPlanner: { name: 'dst-offline', decide: async () => ({ kind: 'act', tool: 'gather', args: {}, intent: '离线规则' }) },
      chat: async (slot) => {
        slots.push(slot);
        throw new Error('gateway offline');
      },
    });
    expect(await planner.decide(state())).toMatchObject({ kind: 'act', tool: 'gather', intent: '规则兜底：离线规则' });
    expect(slots).toEqual(['STARDEW_GAME_PLANNER', 'STARDEW_GAME_PLANNER']);
  });

  it('public setters update the active slot, guides, and recent receipt snapshot', async () => {
    let captured: { slot: string; system: string; user: string } | undefined;
    const planner = new LlmPlanner({
      chat: async (slot, messages) => {
        captured = { slot, system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' };
        return { content: '{"tool":"fish","args":{},"intent":"试一次"}' };
      },
    });
    planner.setSlot('STARDEW_GAME_PLANNER');
    planner.setGuides({ 钓鱼: '攻略注入测试' });
    planner.setRecentReceipts(['OK fish: 上一轮回执']);
    await planner.decide({ ...state(), raw: `${state().raw}\n钓鱼 fish` });
    expect(captured?.slot).toBe('STARDEW_GAME_PLANNER');
    expect(captured?.system).toContain('攻略注入测试');
    expect(captured?.user).toContain('OK fish: 上一轮回执');
  });
});

describe('pickShippableItem（出货目标挑选）', () => {
  it('跳过工具与「留着」任务物品；取最后一条并剥离标签', () => {
    const raw = `## 背包（序号: 物品）
0: 斧头
1: 黄水仙【留着：社区中心"春季采集"要交】
4: 绿藻 [可食用 +13 体力]
7: 小嘴鲈鱼 金星 [可食用 +45 体力]
背包空位：0 个（共 12 格）`;
    expect(pickShippableItem(raw)).toBe('小嘴鲈鱼');
  });
  it('只有工具/任务物品 → null（升级路径改走 store_items）', () => {
    expect(pickShippableItem('0: 斧头\n1: 锄头\n2: 黄水仙【留着】')).toBeNull();
    expect(pickShippableItem('没有背包段')).toBeNull();
  });
});

describe('背包装备解析助手（furniture / wood / chest）', () => {
  it('countWood / hasChestItem / pickFurnitureToPlace 边界', () => {
    const raw = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
6: 普通窗户
7: 黄水仙【留着：社区中心“春季采集”要交】
8: 木材 x60
10: 箱子`;
    expect(countWood(raw)).toBe(60);
    expect(countWood('0: 斧头')).toBe(0);
    expect(hasChestItem(raw)).toBe(true);
    expect(hasChestItem('6: 普通窗户')).toBe(false);
    expect(pickFurnitureToPlace(raw)).toBe('普通窗户');
    expect(pickFurnitureToPlace('7: 黄水仙【留着】')).toBeNull();
    expect(pickFurnitureToPlace('8: 木材 x60')).toBeNull();
  });
});

describe('T-M6-10 真机回归：LLM 输出参数归一化与低空位', () => {
  it('item 被 LLM 包成数组/JSON 字符串时压成标量', () => {
    const arrayArg = extractDecisionJson('{"tool":"ship_items","args":{"item":["湿透的报纸"]},"intent":"扔报纸"}');
    expect(arrayArg?.args.item).toBe('湿透的报纸');
    const jsonString = extractDecisionJson('{"tool":"ship_items","args":{"item":"[\\"湿透的报纸\\"]"},"intent":"扔报纸"}');
    expect(jsonString?.args.item).toBe('湿透的报纸');
    const objectArg = extractDecisionJson('{"tool":"ship_items","args":{"item":{"name":"湿透的报纸"}},"intent":"扔报纸"}');
    expect(objectArg?.args.item).toBe('湿透的报纸');
  });

  it('参数键对齐 BWF schema：items→item、对象 map、craft.item→recipe、take_items 数组', () => {
    const shipArray = extractDecisionJson('{"tool":"ship_items","args":{"items":["湿透的报纸"]},"intent":"把报纸出货"}');
    expect(shipArray?.args).toEqual({ item: '湿透的报纸' });
    // 真机 2026-11-23：LLM 发 {"items":{"湿透的报纸":1,...}}，BWF 回执原样回显整段 JSON
    const shipMap = extractDecisionJson('{"tool":"ship_items","args":{"items":{"湿透的报纸":1,"浮木":1}},"intent":"把杂物出货"}');
    expect(shipMap?.args).toEqual({ item: '湿透的报纸' });
    const take = extractDecisionJson('{"tool":"take_items","args":{"items":["铁锭","煤炭"]},"intent":"把材料取回来"}');
    expect(take?.args).toEqual({ items: '铁锭,煤炭' });
    const takeMap = extractDecisionJson('{"tool":"take_items","args":{"items":{"铁锭":5}},"intent":"取回铁锭"}');
    expect(takeMap?.args).toEqual({ items: '铁锭' });
    const takeScalar = extractDecisionJson('{"tool":"take_items","args":{"items":"铁锭"},"intent":"取回铁锭"}');
    expect(takeScalar?.args).toEqual({ items: '铁锭' });
    const craft = extractDecisionJson('{"tool":"craft","args":{"item":"Chest"},"intent":"制作宝箱"}');
    expect(craft?.args).toEqual({ recipe: 'Chest' });
    const plant = extractDecisionJson('{"tool":"plant_seeds","args":{"seeds":["防风草种子"],"x1":1,"y1":2},"intent":"播种"}');
    expect(plant?.args).toEqual({ seed: '防风草种子', x1: 1, y1: 2 });
  });

  it('空对象/坏 JSON 不伪造参数（宁可少传也不把 JSON 原样发给 BWF）', () => {
    const emptyMap = extractDecisionJson('{"tool":"ship_items","args":{"items":{}},"intent":"出货"}');
    expect(emptyMap?.args.item).toBeUndefined();
    expect(emptyMap?.args.items).toBeUndefined();
    const broken = extractDecisionJson('{"tool":"ship_items","args":{"item":"[坏掉]"},"intent":"出货"}');
    expect(broken?.args.item).toBe('[坏掉]');
  });

  it('攒木计划 + 文字地图有树 → 用 use_tool axe 定向砍树（不再空 clear_area）', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    (planner as unknown as { chestGathering: boolean }).chestGathering = true;
    const withMap = `${STATE_OK}
## 背包（序号: 物品）
5: 木材 x22【留着：社区中心“建筑”要交】
背包空位：2 个（共 24 格）
## 文字地图（以你为中心，左上角坐标=(-2,0)，每个字符一格）
   0  ##T##
   1  #.@.T`;
    const d = await planner.decide(parseGameState(withMap));
    expect(d.kind).toBe('act');
    if (d.kind === 'act') {
      expect(d.tool).toBe('use_tool');
      expect(d.args).toMatchObject({ tool: 'axe', x: 0, y: 0, times: 10 });
    }
  });

  it('真机春23 现场：包里有箱子 + 仅 1 空位 → 先摆箱（大脑想钓鱼也不许）', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const raw = `${STATE_OK}
你站在 (70,14)，面朝下
## 背包（序号: 物品）
0: 斧头
5: 木材 x6【留着：社区中心“建筑”要交】
18: 宝箱
背包空位：1 个（共 24 格）。快满了：出农场前先 tidy_backpack purpose=（mine/fish/town）把用不上的存进箱子`;
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind).toBe('act');
    expect(d.kind === 'act' ? d.tool : '').toBe('place_item');
    if (d.kind === 'act') expect(d.args).toMatchObject({ item: 'Chest' });
  });

  it('0 空位 + 包里有箱子：摆箱本身腾格，不应先去砍树/钓鱼', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    (planner as unknown as { chestGathering: boolean }).chestGathering = true;
    const raw = `${STATE_OK}
你站在 (70,14)，面朝下
## 背包（序号: 物品）
18: 宝箱
背包空位：0 个（共 24 格）`;
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind).toBe('act');
    expect(d.kind === 'act' ? d.tool : '').toBe('place_item');
  });

  it('摆箱回执后满包 → tidy_backpack 存进农场箱子（真机链条闭环）', async () => {
    const receipts = ['COMPLETED place_item: 成功：已在 (70,15) 放置/种下 宝箱'];
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
    const raw = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
5: 木材 x6
背包空位：0 个（共 24 格）`;
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind).toBe('act');
    expect(d.kind === 'act' ? d.tool : '').toBe('tidy_backpack');
    expect((planner as unknown as { chestPlaced: boolean }).chestPlaced).toBe(true);
  });

  it('农场清无可清 → 改道森林一次；森林也空 → 放弃今天造箱（不空转）', async () => {
    const receipts = ['COMPLETED clear_area: 成功：区域内没有可以清理的东西'];
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
    (planner as unknown as { chestGathering: boolean }).chestGathering = true;
    const raw = `${STATE_OK}
你站在 (70,14)，面朝下
## 背包（序号: 物品）
5: 木材 x6
背包空位：2 个（共 24 格）`;
    const d1 = await planner.decide(parseGameState(raw));
    expect(d1.kind === 'act' && d1.tool).toBe('travel_to');
    expect(d1.kind === 'act' && d1.args).toMatchObject({ location: 'Forest' });
    // 到了森林、森林也清无可清 → 放弃，不再反复 clear_area
    const forest = parseGameState(raw.replace('地点：Farm（泡泡湾农场）', '地点：Forest（森林）'));
    const d2 = await planner.decide(forest);
    expect(d2.kind).toBe('act');
    expect(d2.kind === 'act' ? d2.tool : '').not.toBe('clear_area');
    expect((planner as unknown as { chestGathering: boolean }).chestGathering).toBe(false);
  });

  it('攒木时人在第三地点 → 先回农场；在森林清场只试一次', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    (planner as unknown as { chestGathering: boolean }).chestGathering = true;
    const town = parseGameState(`${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）')}
你站在 (20,10)，面朝下
## 背包（序号: 物品）
5: 木材 x6
背包空位：2 个（共 24 格）`);
    const d1 = await planner.decide(town);
    expect(d1.kind === 'act' && d1.tool).toBe('travel_to');
    expect(d1.kind === 'act' && d1.args).toMatchObject({ location: 'Farm' });

    const forestPlanner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    (forestPlanner as unknown as { chestGathering: boolean }).chestGathering = true;
    const forest = parseGameState(`${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Forest（森林）')}
你站在 (30,20)，面朝下
## 背包（序号: 物品）
5: 木材 x6
背包空位：2 个（共 24 格）`);
    const f1 = await forestPlanner.decide(forest);
    expect(f1.kind === 'act' && f1.tool).toBe('clear_area');
    // 森林只清一次：同状态再决定时不再 clear_area（forestGatherTried 已置位）
    const f2 = await forestPlanner.decide(forest);
    expect(f2.kind === 'act');
    expect(f2.kind === 'act' ? f2.tool : '').not.toBe('clear_area');
  });

  it('包里有箱子但人在镇上 → 先回农场摆箱', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const raw = `${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Town（鹈鹕镇）')}
你站在 (20,10)，面朝下
## 背包（序号: 物品）
18: 宝箱
背包空位：1 个（共 24 格）`;
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.args).toMatchObject({ location: 'Farm' });
  });

  it('clear_area 无物可清（COMPLETED）→ 退出攒木计划，不再无限重试', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED tidy_backpack: 失败：农场上没有箱子。先 craft Chest（50 木材）',
        'COMPLETED clear_area: 成功：区域内没有可以清理的东西',
      ],
    });
    const state = parseGameState(STATE_FULL.replace('背包空位：0 个', '背包空位：1 个'));
    const d = await planner.decide(state);
    expect(d.kind).toBe('act');
    expect(d.kind === 'act' ? d.tool : '').not.toBe('clear_area');
    expect((planner as unknown as { chestGathering: boolean }).chestGathering).toBe(false);
  });

  it('craft 因「背包满放不下」失败 → 腾格后仍会重试造箱（不当天放弃）', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED craft: 失败：背包满了，宝箱 做出来放不下（材料够）：先空出一格',
      ],
    });
    // 满包状态先走救援腾格
    const full = parseGameState(STATE_FULL.replace(/5: 木材 x\d+/, '5: 木材 x60'));
    const first = await planner.decide(full);
    expect(first.kind).toBe('act');
    // 腾出一格 + 木材≥50 → 应重新 craft，而不是彻底放弃
    const freed = parseGameState(STATE_FULL.replace(/5: 木材 x\d+/, '5: 木材 x60').replace('背包空位：0 个', '背包空位：1 个'));
    const next = await planner.decide(freed);
    // 木材判定依赖真实背包行；至少必须仍在造箱链上（去农场/砍树/造箱），而不是放弃去钓鱼
    expect(next.kind).toBe('act');
    expect(['craft', 'travel_to', 'clear_area']).toContain(next.kind === 'act' ? next.tool : '');
    if (next.kind === 'act' && next.tool === 'travel_to') expect(next.args.location).toBe('Farm');
  });

  it('满包无箱子且木材<50 → 腾出格后进入砍树攒木计划（不再只 ship 续命）', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：农场上没有箱子。先 craft Chest（50 木材）'],
    });
    // 满包：先走救援把可卖的出货（STATE_FULL 的小嘴鲈鱼）
    const full = parseGameState(STATE_FULL.replace('木材 x', '木材 x'));
    const first = await planner.decide(full);
    expect(first.kind === 'act' && first.tool).toBe('ship_items');
    // 腾出一格后：应去农场砍树攒木材，而不是继续钓鱼
    const freed = parseGameState(STATE_FULL
      .replace('背包空位：0 个', '背包空位：2 个')
      .replace('## 附近物体', '## 附近物体'));
    const second = await planner.decide(freed);
    expect(second.kind === 'act' && second.tool).toBe('travel_to');
    expect(second.kind === 'act' && second.args.location).toBe('Farm');
  });

  it('只剩 1 格且回执已报「拿不下」→ 不再钓鱼，先救援腾格', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked += 1; return { content: '{"tool":"fish","args":{}}' }; },
      recentReceipts: ['COMPLETED fish: 成功：钓到 1 次…（背包满了，再钓拿不下的会掉在地上）'],
    });
    const oneSlot = parseGameState(`${STATE_OK}
## 背包（序号: 物品）
0: 斧头
5: 木材 x22
背包空位：1 个（共 24 格）`);
    const d = await planner.decide(oneSlot);
    expect(d.kind).toBe('act');
    expect(d.kind === 'act' ? d.tool : '').not.toBe('fish');
    expect(asked).toBeGreaterThanOrEqual(0);
  });
});

describe('LlmPlanner 救援阶梯单步（rescueAction 分支矩阵）', () => {
  type StepPlanner = { rescueAction(step: number, state: GameStateSnapshot): import('./planner').PlannerDecision | null; craftTried: boolean };
  const call = (planner: LlmPlanner, step: number, state: GameStateSnapshot) =>
    (planner as unknown as StepPlanner).rescueAction(step, state);
  const planner = (): LlmPlanner => new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
  const withInv = (lines: string, over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => parseGameState(`${STATE_OK}
## 背包（序号: 物品）
${lines}
背包空位：${over.freeSlots ?? 2} 个（共 12 格）`);

  it('stage6 家具：不在农场→travel；无坐标→null；农场有坐标→place_item', () => {
    const p = planner();
    const inv = '0: 斧头\n6: 普通窗户';
    const beach = call(p, 6, { ...withInv(inv), location: 'Beach', posX: 5, posY: 5 });
    expect(beach?.kind === 'act' && beach.tool).toBe('travel_to');
    const noPos = call(p, 6, { ...withInv(inv), location: 'Farm', posX: -1, posY: -1 });
    expect(noPos).toBeNull();
    const farm = call(p, 6, { ...withInv(inv), location: 'Farm', posX: 10, posY: 10 });
    expect(farm?.kind === 'act' && farm.tool).toBe('place_item');
  });

  it('stage7 造箱：满格纯木材→null（无牺牲格）；满格有石料→force 扔腾位；已有箱→null；有空位→craft', () => {
    const p = planner();
    // 真机卡死现场修复（2026-11-22 用户指令）：满包 + 无箱 + 木材够 + 只有木材可牺牲 → 无解保留 wait 求助
    expect(call(p, 7, withInv('4: 木材 x60', { freeSlots: 0 }))).toBeNull();
    expect(call(p, 7, withInv('4: 木材 x60\n5: 箱子'))).toBeNull();
    // 满包但有石料（BWF 官方建议的低价值材料）→ force 扔整格腾位给 craft
    const sacrifice = call(p, 7, withInv('4: 木材 x60\n5: 石头 x37', { freeSlots: 0 }));
    expect(sacrifice?.kind === 'act' && sacrifice.tool).toBe('trash_item');
    expect(sacrifice?.kind === 'act' && sacrifice.args).toMatchObject({ item: '石头', force: true });
    // 木材本身绝不作为牺牲格（未预留的【留着】黄水仙也不在可再生名单 → null）
    expect(call(p, 7, withInv('4: 木材 x60\n5: 黄水仙【留着：社区中心“春季采集”要交】', { freeSlots: 0 }))).toBeNull();
    // 有空位 → 直接 craft（原行为保留）
    const craft = call(p, 7, withInv('4: 木材 x60'));
    expect(craft?.kind === 'act' && craft.tool).toBe('craft');
    (p as unknown as StepPlanner).craftTried = true;
    expect(call(p, 7, withInv('4: 木材 x60'))).toBeNull();
  });

  it('stage7/12 真机现场二（木材 x22<50 + 满包全【留着】预留）：7 只进攒木不牺牲；12 才 force 吃预留鱼', () => {
    const inv = [
      '0: 斧头',
      '5: 木材 x22【留着：社区中心“建筑”要交】',
      '6: 牡蛎【留着：社区中心“蟹笼”要交】',
      '7: 石头 x14【留着：社区中心“建筑”要交】',
      '9: 沙丁鱼 金星 [可食用 +23体力]【留着：社区中心“海鱼”要交】',
      '11: 蚌【留着：社区中心“蟹笼”要交】',
    ].join('\n');
    // 满包全预留：case 7 不再牺牲（可再生牺牲排在捐赠之后的 case 12），只置攒木模式
    const p7 = planner();
    expect(call(p7, 7, withInv(inv, { freeSlots: 0 }))).toBeNull();
    expect((p7 as unknown as { chestGathering: boolean }).chestGathering).toBe(true);
    // case 12：可食用预留鱼优先 force 吃（攒箱本钱木材/石头不动）
    const p12 = planner();
    const eatFish = call(p12, 12, withInv(inv, { freeSlots: 0 }));
    expect(eatFish?.kind === 'act' && eatFish.tool).toBe('eat');
    expect(eatFish?.kind === 'act' && eatFish.args).toMatchObject({ item: '沙丁鱼', force: true });
    // 可食用预留吃光后 → 海边采集（首个命中牡蛎）走 trash force
    const invNoFish = inv.replace(/9: 沙丁鱼[^\n]*\n/, '');
    const trashShell = call(p12, 12, withInv(invNoFish, { freeSlots: 0 }));
    expect(trashShell?.kind === 'act' && trashShell.tool).toBe('trash_item');
    expect(trashShell?.kind === 'act' && trashShell.args).toMatchObject({ item: '牡蛎', force: true });
    // 木材不足 + 有空位 → case 7 进攒木模式（交给主流程 chestGathering 分支去砍树）
    const gathering = planner();
    expect(call(gathering, 7, withInv(inv, { freeSlots: 1 }))).toBeNull();
    expect((gathering as unknown as { chestGathering: boolean }).chestGathering).toBe(true);
  });

  it('stage8 摆箱：无箱→null；不在农场→travel；农场→place_item', () => {
    const p = planner();
    expect(call(p, 8, withInv('4: 木材 x10'))).toBeNull();
    const beach = call(p, 8, { ...withInv('4: 箱子'), location: 'Beach', posX: 5, posY: 5 });
    expect(beach?.kind === 'act' && beach.tool).toBe('travel_to');
    const farm = call(p, 8, { ...withInv('4: 箱子'), location: 'Farm', posX: 8, posY: 8 });
    expect(farm?.kind === 'act' && farm.tool).toBe('place_item');
  });

  it('stage9 强制丢弃；stage10 收集包捐赠', () => {
    const p = planner();
    const force = call(p, 9, withInv('6: 普通窗户'));
    expect(force?.kind === 'act' && force.tool).toBe('trash_item');
    expect(force?.kind === 'act' && force.args).toMatchObject({ force: true });
    expect(call(p, 9, withInv('0: 斧头'))).toBeNull();
    expect(call(p, 10, withInv('6: 普通窗户'))).toBeNull();
    const donate = call(p, 10, withInv('7: 黄水仙【留着：社区中心“春季采集”要交】'));
    expect(donate?.kind === 'act' && donate.tool).toBe('donate_bundles');
  });
});

describe('LlmPlanner 决策链', () => {
  it('正常链路：LLM 输出合法决策 → act 直出（含人设 intent）', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"water_crops","args":{},"intent":"浇水中！才不是为了主人呢"}' }),
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).toBe('water_crops');
    expect(d.kind === 'act' && d.intent).toContain('才不是为了主人');
    expect(planner.asks).toBe(1);
  });

  it('越权工具名 → 拒绝重问 → 仍坏 → RulePlanner 兜底', async () => {
    let n = 0;
    const planner = new LlmPlanner({
      chat: async () => {
        n++;
        return { content: '{"tool":"exec_shell","args":{"cmd":"rm -rf"}}' }; // 越权两次
      },
    });
    const d = await planner.decide(state());
    expect(n).toBe(2); // 重问了一次
    // 兜底走 RulePlanner 日程：morning-mail 有未读 → read_mail
    expect(d.kind === 'act' && d.tool).toBe('read_mail');
    expect(planner.asks).toBe(1);
  });

  it('chat 抛错（网关/网络）→ 重试 → 兜底不卡死', async () => {
    const planner = new LlmPlanner({ chat: async () => { throw new Error('ECONNRESET'); } });
    const d = await planner.decide(state());
    expect(d.kind).toBe('act');
  });

  it('菜单打开时绕过 LLM（确定性处理不烧 token）', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
    });
    const withMenu = { ...state(), menu: '正在播放剧情/节日事件' };
    await planner.decide(withMenu);
    expect(asked).toBe(0);
  });

  it('背包空位 0 → 确定性 tidy_backpack，不烧 token（真机连续 FAILED fish 修复）', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
    });
    const full = parseGameState(STATE_FULL);
    expect(full.freeSlots).toBe(0);
    const d = await planner.decide(full);
    expect(d.kind === 'act' && d.tool).toBe('tidy_backpack');
    expect(d.kind === 'act' && d.intent).toContain('背包');
    expect(asked).toBe(0);
    expect(planner.asks).toBe(1); // 只计数，未走 LLM
  });

  it('回执显示背包满（状态未解析出空位）→ 同样整理', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED fish: 失败：背包满了，再钓拿不下的会掉在地上'],
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).toBe('tidy_backpack');
  });

  it('状态省略背包段 + 最近 tidy 失败「没有箱子」→ 仍进入救援（不钓鱼）', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：农场上没有箱子。先 craft Chest（50 木材），再 place_item 放在农场上'],
    });
    const noSlotsLine = STATE_FULL.replace('背包空位：0 个（共 12 格）', '');
    const d = await planner.decide(parseGameState(noSlotsLine));
    expect(d.kind).toBe('act');
    expect(d.kind === 'act' ? d.tool : '').not.toBe('fish');
    expect(d.kind === 'act' ? d.tool : '').toBe('ship_items');
  });

  it('农场没有箱子（tidy 必失败）→ 直接出货，不再浪费一轮 tidy', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：农场上没有箱子。先 craft Chest（50 木材），再 place_item 放在农场上'],
    });
    const d = await planner.decide(parseGameState(STATE_FULL));
    expect(d.kind === 'act' && d.tool).toBe('ship_items');
    expect(d.kind === 'act' && d.args).toEqual({ item: '小嘴鲈鱼' });
  });

  it('出货也失败 → 吃一个腾位 → 再失败 → 扔垃圾（阶梯降级）', async () => {
    const raw = `${STATE_FULL}
9: 破损的眼镜 [垃圾]`;
    const shipFail = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED tidy_backpack: 失败：农场上没有箱子',
        'FAILED ship_items: 失败：出货箱满了',
      ],
    });
    const eat = await shipFail.decide(parseGameState(raw));
    expect(eat.kind === 'act' && eat.tool).toBe('eat');
    expect(eat.kind === 'act' && eat.args).toEqual({ item: '小嘴鲈鱼' });

    const eatFail = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED ship_items: 失败：出货箱满了',
        'FAILED eat: 失败：吃不下了',
      ],
    });
    const trash = await eatFail.decide(parseGameState(raw));
    expect(trash.kind === 'act' && trash.tool).toBe('trash_item');
    expect(trash.kind === 'act' && trash.args).toEqual({ item: '破损的眼镜' });
  });

  it('贵重家具被拒扔 → 记住并退到鱼饵（BWF「一个能卖 300g，没有扔」）', async () => {
    const raw = `${STATE_FULL}
6: 普通窗户
11: 鱼饵 x25`;
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED trash_item: 失败：6:普通窗户x1 一个能卖 300g，没有扔。能扔的不值钱的东西：11:鱼饵x25',
        'FAILED store_items: 失败：这里没有箱子',
      ],
    });
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind === 'act' && d.tool).toBe('trash_item');
    expect(d.kind === 'act' && d.args).toEqual({ item: '鱼饵' });
  });

  it('get_state 省略背包段（未变化）→ 沿用上次空位 0，不误判为有空位', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：农场上没有箱子'],
    });
    const d1 = await planner.decide(parseGameState(STATE_FULL)); // 建立 lastFreeSlots=0
    expect(d1.kind === 'act' && d1.tool).toBe('ship_items');
    const noSlotsLine = STATE_FULL.replace('背包空位：0 个（共 12 格）', '');
    const d2 = await planner.decide(parseGameState(noSlotsLine)); // 省略背包空位行
    expect(d2.kind === 'act' && d2.tool).toBe('ship_items');
  });

  it('手持家具被拒扔（名字带“（手持）”）→ 记住并终止空转（wait + 原因）', async () => {
    const raw = `${STATE_FULL}
6: 普通窗户（手持）`;
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED trash_item: 失败：背包里没有能扔的“普通窗户（手持）”（工具、武器、任务物品不能扔）。名字相近的：普通窗户',
        'FAILED store_items: 失败：这里没有箱子',
      ],
    });
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind).toBe('act');
    expect(d.kind === 'act' && d.tool).toBe('travel_to'); // 不在农场 → 先回农场再摆
    expect(d.kind === 'act' && d.args).toEqual({ location: 'Farm' });
  });

  it('只剩家具：摆到农场腾格（place_item 带坐标）→ 摆失败按 BWF 建议坐标重试', async () => {
    const raw = `${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Farm（泡泡湾农场）').replace('邮箱里有 7 封未读信件', '')}
## 背包（序号: 物品）
0: 斧头
6: 普通窗户
## 位置
你站在 (10,10)，面朝右
背包空位：0 个（共 12 格）`;
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => { throw new Error('brain offline'); }, recentReceipts: receipts });
    const s0 = parseGameState(raw);
    expect(s0.posX).toBe(10);
    const d1 = await planner.decide(s0); // 无箱子 → ship 无候选 → store
    expect(d1.kind === 'act' && d1.tool).toBe('store_items');
    receipts.push('FAILED store_items: 失败：这里没有箱子');
    const d2 = await planner.decide(s0); // 升级到任意非必需品 → 先尝试扔（会被 BWF 拒）
    expect(d2.kind === 'act' && d2.tool).toBe('trash_item');
    receipts.push('FAILED trash_item: 失败：6:普通窗户x1 一个能卖 300g，没有扔。能扔的不值钱的东西：无');
    const d3 = await planner.decide(s0); // 拒扔后 → place_item 家具
    expect(d3.kind === 'act' && d3.tool).toBe('place_item');
    expect(d3.kind === 'act' && d3.args).toMatchObject({ item: '普通窗户', x: 11, y: 10 });
    receipts.push('FAILED place_item: 摆放位置不合适，最好的坐标 (30,40)');
    const d4 = await planner.decide(s0); // 按 BWF 建议坐标重试
    expect(d4.kind === 'act' && d4.tool).toBe('place_item');
    expect(d4.kind === 'act' && d4.args).toMatchObject({ x: 30, y: 40 });
  });

  it('农场有空位且木材 ≥50 → 顺手造箱子（Chest）；已有箱子则先摆出来', async () => {
    const woodRaw = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
4: 木材 x60
## 位置
你站在 (20,20)，面朝右
背包空位：3 个（共 12 格）`;
    const craft = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const d1 = await craft.decide(parseGameState(woodRaw));
    expect(d1.kind === 'act' && d1.tool).toBe('craft');
    expect(d1.kind === 'act' && d1.args).toEqual({ recipe: 'Chest' });

    const chestRaw = woodRaw.replace('4: 木材 x60', '4: 箱子');
    const place = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const d2 = await place.decide(parseGameState(chestRaw));
    expect(d2.kind === 'act' && d2.tool).toBe('place_item');
    expect(d2.kind === 'act' && d2.args).toMatchObject({ item: 'Chest', x: 21, y: 20 });
  });

  it('只有家具时不在农场 → 先 travel_to Farm', async () => {
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => { throw new Error('brain offline'); }, recentReceipts: receipts });
    const full = parseGameState(`${STATE_OK}
## 背包（序号: 物品）
0: 斧头
6: 普通窗户
## 位置
你站在 (30,10)，面朝右
背包空位：0 个（共 12 格）`);
    await planner.decide(full); // store
    receipts.push('FAILED store_items: 失败：这里没有箱子');
    await planner.decide(full); // trash 窗户
    receipts.push('FAILED trash_item: 失败：6:普通窗户x1 一个能卖 300g，没有扔');
    const beach = parseGameState(`${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Beach（沙滩）')}
## 背包（序号: 物品）
0: 斧头
6: 普通窗户
## 位置
你站在 (30,10)，面朝右
背包空位：0 个（共 12 格）`);
    const d = await planner.decide(beach);
    expect(d.kind === 'act' && d.tool).toBe('travel_to');
    expect(d.kind === 'act' && d.args).toEqual({ location: 'Farm' });
  });

  it('家具摆不下且普通丢弃被拒 → 第 10 级 force 丢弃兜底', async () => {
    const raw = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
6: 普通窗户
背包空位：0 个（共 12 格）`;
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => { throw new Error('brain offline'); }, recentReceipts: receipts });
    const s0 = parseGameState(raw);
    const d1 = await planner.decide(s0); // store
    expect(d1.kind === 'act' && d1.tool).toBe('store_items');
    receipts.push('FAILED store_items: 失败：这里没有箱子');
    const d2 = await planner.decide(s0); // 普通 trash 窗户（会被拒）
    expect(d2.kind === 'act' && d2.tool).toBe('trash_item');
    expect(d2.kind === 'act' && d2.args).toEqual({ item: '普通窗户' });
    receipts.push('FAILED trash_item: 失败：6:普通窗户x1 一个能卖 300g，没有扔');
    const d3 = await planner.decide(s0); // 摆不了（无坐标）→ force 丢弃
    expect(d3.kind === 'act' && d3.tool).toBe('trash_item');
    expect(d3.kind === 'act' && d3.args).toEqual({ item: '普通窗户', force: true });
  });

  it('摆放建议坐标/连续失败拒绝/造箱失败/最终 wait 分支', async () => {
    type Internals = { pendingPlaceItem: string | null; rejectedPlace: Set<string>; placeTarget: { x: number; y: number } | null };
    const fullFurniture = parseGameState(`${STATE_OK}
## 背包（序号: 物品）
0: 斧头
6: 普通窗户
## 位置
你站在 (64,15)，面朝右
背包空位：0 个（共 12 格）`);

    const suggested = new LlmPlanner({
      chat: async () => { throw new Error('brain offline'); },
      recentReceipts: ['FAILED place_item: 摆放位置不合适，最好的坐标 (30,40)'],
    });
    await suggested.decide(fullFurniture);
    expect((suggested as unknown as Internals).placeTarget).toEqual({ x: 30, y: 40 });

    const repeated = new LlmPlanner({
      chat: async () => { throw new Error('brain offline'); },
      recentReceipts: Array.from({ length: 6 }, () => 'FAILED place_item: 失败：(64,16) 被挡着'),
    });
    (repeated as unknown as Internals).pendingPlaceItem = '普通窗户';
    await repeated.decide(fullFurniture);
    expect((repeated as unknown as Internals).rejectedPlace.has('普通窗户')).toBe(true);

    const craftFail = new LlmPlanner({
      chat: async () => { throw new Error('brain offline'); },
      recentReceipts: ['FAILED craft: 失败：缺少木材'],
    });
    const wood = parseGameState(`${STATE_OK}
## 背包（序号: 物品）
0: 斧头
4: 木材 x60
背包空位：0 个（共 12 格）`);
    await craftFail.decide(wood);
    expect((craftFail as unknown as { craftTried: boolean }).craftTried).toBe(true);

    const dead = new LlmPlanner({
      chat: async () => { throw new Error('brain offline'); },
      recentReceipts: [
        'FAILED tidy_backpack: 失败：农场上没有箱子',
        'FAILED trash_item: 失败：背包里没有不值钱的东西可扔',
        'FAILED store_items: 失败：这里没有箱子',
      ],
    });
    const onlyTools = parseGameState(`${STATE_OK}
## 背包（序号: 物品）
0: 斧头
1: 锄头
背包空位：0 个（共 12 格）`);
    const waited = await dead.decide(onlyTools);
    expect(waited.kind).toBe('wait');
    expect(waited.kind === 'wait' && waited.reason).toContain('背包卡死');
  });

  it('满包造箱自救全链（2026-11-22 用户指令；真机 06:10 死循环回归）：卖石腾格保木材 → craft → 摆箱 → 恢复正常日程', async () => {
    const raw0 = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
4: 木材 x60
5: 石头 x37
## 位置
你站在 (64,15)，面朝右
背包空位：0 个（共 12 格）`;
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
    // ① 满包 + 造箱计划（木材 ≥50 无箱）→ 出货跳过木材、卖石头腾格（还赚一笔）
    const d1 = await planner.decide(parseGameState(raw0));
    expect(d1.kind === 'act' && d1.tool).toBe('ship_items');
    expect(d1.kind === 'act' && d1.args).toMatchObject({ item: '石头' });
    // ② 石头卖掉 → 空位 1 → craft Chest（BWF 满包拒绝语义：腾格后才放行；无地点要求）
    receipts.push('COMPLETED ship_items: 出货 石头 x37');
    const raw1 = raw0.replace('5: 石头 x37\n', '').replace('背包空位：0 个', '背包空位：1 个');
    const d2 = await planner.decide(parseGameState(raw1));
    expect(d2.kind === 'act' && d2.tool).toBe('craft');
    // ③ craft 成功 → 箱子入包 → 在农场直接摆箱
    receipts.push('COMPLETED craft: 制作了 1 个 箱子');
    const raw2 = raw1.replace('## 位置', '5: 箱子\n## 位置');
    const d3 = await planner.decide(parseGameState(raw2));
    expect(d3.kind === 'act' && d3.tool).toBe('place_item');
    // ④ 摆箱成功 → chestPlaced 置位、救援归零 → 恢复 LLM 正常决策（死锁解除）
    receipts.push('COMPLETED place_item: 已把 箱子 放在 (65,15)');
    const raw3 = raw2.replace('5: 箱子\n', '').replace('背包空位：0 个', '背包空位：1 个');
    const d4 = await planner.decide(parseGameState(raw3));
    expect(d4.kind === 'act' && d4.tool).toBe('fish');
    expect((planner as unknown as { chestPlaced: boolean }).chestPlaced).toBe(true);
  });

  it('真机现场二全链（大脑驱动版，2026-11-22 用户指令「卡死让 AI 判断」）：结构双败→救援问询→大脑自选捐赠→吃预留鱼→砍树→craft→place', async () => {
    const invAll = `## 背包（序号: 物品）
0: 斧头
1: 锄头
2: 喷壶（水 24/40）
3: 十字镐
4: 镰刀
5: 木材 x22【留着：社区中心“建筑”要交】
6: 牡蛎【留着：社区中心“蟹笼”要交】
7: 石头 x14【留着：社区中心“建筑”要交】
8: 竹鱼竿（手持）
9: 沙丁鱼 金星 [可食用 +23体力]【留着：社区中心“海鱼”要交】
10: 太阳鱼 金星 [可食用 +23体力]【留着：社区中心“河鱼”要交】
11: 蚌【留着：社区中心“蟹笼”要交】
## 位置
你站在 (64,15)，面朝右
背包空位：0 个（共 12 格）`;
    const receipts: string[] = [
      'FAILED tidy_backpack: 失败：农场上没有箱子。先 craft Chest（50 木材），再 place_item 放在农场上',
      'FAILED store_items: 失败：这里没有箱子',
    ];
    // 大脑脚本（救援问询与正常流程共用同一个 chat）：无损捐赠先试 → 查缺料 → 再捐 →
    // 可再生牺牲（吃预留鱼）→ 摆箱后回到正常日程。
    // 注意：clear_area 砍树与 craft/place 由确定性分支直接下发（不烧 token），脚本不占位。
    const brainScript = [
      '{"tool":"donate_bundles","args":{},"intent":"先试试无损的：把预留材料捐了"}',
      '{"tool":"bundle_info","args":{},"intent":"捐失败了，查查缺什么"}',
      '{"tool":"donate_bundles","args":{},"intent":"再试一次捐"}',
      '{"tool":"eat","args":{"item":"沙丁鱼","force":true},"intent":"捐赠无门，吃条预留鱼腾格（回头再钓）"}',
      '{"tool":"fish","args":{},"intent":"箱子摆好了，继续钓鱼"}',
    ];
    let call = 0;
    const p = new LlmPlanner({
      chat: async () => {
        const next = brainScript[Math.min(call++, brainScript.length - 1)] ?? '';
        return { content: next };
      },
      recentReceipts: receipts,
    });
    const s0 = parseGameState(`${STATE_OK}\n${invAll}`);
    // ①②③ 救援问询：大脑自选 donate → bundle_info → donate（每次结构双败先问大脑）
    const d1 = await p.decide(s0);
    expect(d1.kind === 'act' && d1.tool).toBe('donate_bundles');
    receipts.push('FAILED donate_bundles: 失败：背包里没有能交给已解锁收集包的材料（用 bundle_info 看看缺什么）');
    const d2 = await p.decide(s0);
    expect(d2.kind === 'act' && d2.tool).toBe('bundle_info');
    receipts.push('COMPLETED bundle_info: 【工艺室(Crafts Room)】 海鱼：已交 0/5 河鱼：已交 0/5 蟹笼：已交 0/3 建筑：已交 0/3');
    const d3 = await p.decide(s0);
    expect(d3.kind === 'act' && d3.tool).toBe('donate_bundles');
    // ④ 捐赠二次失败 → 单日预算冷却；问询继续：大脑自选可再生牺牲（吃预留鱼 force）
    receipts.push('FAILED donate_bundles: 失败：背包里没有能交给已解锁收集包的材料');
    const d4 = await p.decide(s0);
    expect(d4.kind === 'act' && d4.tool).toBe('eat');
    expect(d4.kind === 'act' && d4.args).toMatchObject({ item: '沙丁鱼', force: true });
    // ⑤ 鱼吃掉 → 空位 1 → 无箱子且木材<50：直接进入攒木计划（2026-11-23 真机要求「没箱子就造」）
    receipts.push('COMPLETED eat: 吃了 沙丁鱼，体力 180 → 203');
    const s1 = `${STATE_OK}\n${invAll.replace(/9: 沙丁鱼[^\n]*\n/, '').replace('背包空位：0 个', '背包空位：1 个')}`;
    const d5 = await p.decide(parseGameState(s1));
    expect(d5.kind === 'act' && d5.tool).toBe('clear_area');
    expect(d5.kind === 'act' && d5.args).toMatchObject({ include_trees: true });
    // ⑥ 砍树攒木
    const d6 = await p.decide(parseGameState(s1));
    expect(d6.kind === 'act' && d6.tool).toBe('clear_area');
    // ⑦ 砍树攒到 60 木 → 大脑 craft
    receipts.push('COMPLETED clear_area: 清完了周围，捡到 木材 x38');
    const d7 = await p.decide(parseGameState(`${s1.replace('木材 x22', '木材 x60')}`));
    expect(d7.kind === 'act' && d7.tool).toBe('craft');
    // ⑧ craft 成功 → 箱子入包满格 → 确定性 case 8 摆箱（机械步骤不烧 token）
    receipts.push('COMPLETED craft: 制作了 1 个 箱子');
    const d8 = await p.decide(parseGameState(`${s1.replace('木材 x22', '木材 x10').replace('11: 蚌【留着：社区中心“蟹笼”要交】', '11: 箱子')}`));
    expect(d8.kind === 'act' && d8.tool).toBe('place_item');
    // ⑨ 摆箱成功 → chestPlaced + 大脑恢复正常决策（死锁解除）
    receipts.push('COMPLETED place_item: 已把 箱子 放在 (65,15)');
    const d9 = await p.decide(parseGameState(s1.replace('木材 x22', '木材 x10')));
    // 箱子已摆好：死锁解除，回到正常日程（读信/浇水/钓鱼都算正常）
    expect(d9.kind).toBe('act');
    expect(['fish', 'read_mail', 'water_crops', 'travel_to']).toContain(d9.kind === 'act' ? d9.tool : '');
    expect((p as unknown as { chestPlaced: boolean }).chestPlaced).toBe(true);
    // 救援问询烧了 4 次 token（donate/bundle_info/donate/吃鱼）——如实计入饭碗
    expect((p as unknown as { asks: number }).asks).toBeGreaterThanOrEqual(4);
  });

  it('只剩【留着】收集包材料 → donate_bundles（任务物品的正确出路）', async () => {
    const raw = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
5: 沙丁鱼 金星 [可食用 +23体力]【留着：社区中心“海鱼”要交】
6: 石头【留着：社区中心“建筑”要交】
7: 黄水仙【留着：社区中心“春季采集”要交】
## 位置
你站在 (64,15)，面朝右
背包空位：0 个（共 12 格）`;
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => { throw new Error('brain offline'); }, recentReceipts: receipts });
    const s0 = parseGameState(raw);
    const d1 = await planner.decide(s0); // 无箱子 → store
    expect(d1.kind === 'act' && d1.tool).toBe('store_items');
    receipts.push('FAILED store_items: 失败：这里没有箱子');
    const d = await planner.decide(s0); // 阶梯全部无效 → donate_bundles
    expect(d.kind === 'act' && d.tool).toBe('donate_bundles');
    expect(d.kind === 'act' && d.intent).toContain('社区中心');
  });

  it('作息护栏：23:00 回家/睡觉；体力 <8% 吃或回家睡（先于背包救援）', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const lateBeach = parseGameState(`${STATE_OK.replace('第1年春16日 07:30', '第1年春16日 23:10').replace('地点：Farm（泡泡湾农场）', '地点：Beach（沙滩）')}`);
    const d1 = await planner.decide(lateBeach);
    expect(d1.kind === 'act' && d1.tool).toBe('travel_to');
    expect(d1.kind === 'act' && d1.args).toEqual({ location: 'FarmHouse' });
    const lateHome = parseGameState(`${STATE_OK.replace('第1年春16日 07:30', '第1年春16日 23:10').replace('地点：Farm（泡泡湾农场）', '地点：FarmHouse（农舍）')}`);
    const d2 = await planner.decide(lateHome);
    expect(d2.kind === 'act' && d2.tool).toBe('sleep');

    const weak = parseGameState(`${STATE_OK.replace('体力：98/270', '体力：10/270')}
## 背包（序号: 物品）
5: 沙丁鱼 [可食用 +23 体力]`);
    const d3 = await planner.decide(weak);
    expect(d3.kind === 'act' && d3.tool).toBe('eat');
    const weakNoFood = parseGameState(`${STATE_OK.replace('体力：98/270', '体力：10/270').replace('地点：Farm（泡泡湾农场）', '地点：Beach（沙滩）')}`);
    const d4 = await planner.decide(weakNoFood);
    expect(d4.kind === 'act' && d4.tool).toBe('travel_to');
    const weakHome = parseGameState(`${STATE_OK.replace('体力：98/270', '体力：10/270').replace('地点：Farm（泡泡湾农场）', '地点：FarmHouse（农舍）')}`);
    const d5 = await planner.decide(weakHome);
    expect(d5.kind === 'act' && d5.tool).toBe('sleep');
  });

  it('腾出空位后救援阶段归零：恢复 LLM 正常决策', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"water_crops","args":{},"intent":"浇水"}' }; },
      recentReceipts: ['FAILED tidy_backpack: 失败：农场上没有箱子'],
    });
    const rescue = await planner.decide(parseGameState(STATE_FULL));
    expect(rescue.kind === 'act' && rescue.tool).toBe('ship_items');
    const freed = parseGameState(STATE_FULL.replace('背包空位：0 个', '背包空位：2 个'));
    const normal = await planner.decide(freed);
    // 无箱子且木材<50：腾出空位后先去农场攒木造箱（2026-11-23 用户要求），而非直接恢复浇水
    expect(normal.kind === 'act' && normal.tool).toBe('travel_to');
    expect(normal.kind === 'act' && normal.args.location).toBe('Farm');
    expect(asked).toBe(0);
  });

  it('出货候选排序：鱼/采集优先于家具（真机「普通窗户不能出货」教训）', () => {
    const raw = `${STATE_OK}
## 背包（序号: 物品）
5: 沙丁鱼 x3 金星 [可食用 +23体力]
6: 普通窗户
背包空位：0 个（共 12 格）`;
    expect(pickShippableItem(raw)).toBe('沙丁鱼');
  });

  it('被 BWF 拒绝的单品会被记住并换下一个，不降级策略', async () => {
    const raw = `${STATE_FULL}
6: 普通窗户`;
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: [
        'FAILED tidy_backpack: 失败：农场上没有箱子',
        'FAILED ship_items: 失败：普通窗户 不能出货',
      ],
    });
    const d = await planner.decide(parseGameState(raw));
    expect(d.kind === 'act' && d.tool).toBe('ship_items');
    expect(d.kind === 'act' && d.args).toEqual({ item: '小嘴鲈鱼' });
  });

  it('整理连续两次失败 + 背包满 → 升级为出货 ship_items（带具体物品名）', async () => {
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：箱子也满了', 'FAILED tidy_backpack: 失败：真的塞不下'],
    });
    const d = await planner.decide(parseGameState(STATE_FULL));
    expect(d.kind === 'act' && d.tool).toBe('ship_items');
    // ship_items 契约要求 item 必填：从背包挑最近捡的鱼（跳过工具）
    expect(d.kind === 'act' && d.args).toEqual({ item: '小嘴鲈鱼' });
  });

  it('整理连续失败但没有可出货物品 → store_items（无参也安全）', async () => {
    const toolsOnly = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
1: 锄头
2: 喷壶（水 39/40）
3: 黄水仙【留着：社区中心"春季采集"要交】
背包空位：0 个（共 12 格）`;
    const planner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED tidy_backpack: 失败：箱子也满了', 'FAILED tidy_backpack: 失败：真的塞不下'],
    });
    const d = await planner.decide(parseGameState(toolsOnly));
    expect(d.kind === 'act' && d.tool).toBe('store_items');
  });

  it('同一工具连续两次失败（非背包）→ 先问大脑换做法，护栏拒绝重复后回落规则日程', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
      recentReceipts: ['FAILED fish: 失败：这里没有水', 'FAILED fish: 失败：没有水钓不了'],
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).not.toBe('fish');
    // 连续失败不再静默回落规则：先问一次大脑（两次输出都被「禁止重复 fish」护栏拒绝，再走规则兜底）
    expect(asked).toBe(2);
  });
});

describe('救援问询护栏（2026-11-22 用户指令「卡死让 AI 判断」：判断归大脑，机制归护栏）', () => {
  const stuckRaw = () => parseGameState(`${STATE_OK}
## 背包（序号: 物品）
0: 斧头
5: 木材 x22【留着：社区中心“建筑”要交】
9: 沙丁鱼 金星 [可食用 +23体力]【留着：社区中心“海鱼”要交】
背包空位：0 个（共 12 格）`);
  const stuckReceipts = (): string[] => [
    'FAILED tidy_backpack: 失败：农场上没有箱子。先 craft Chest（50 木材），再 place_item 放在农场上',
    'FAILED store_items: 失败：这里没有箱子',
  ];

  it('大脑选了今天已冷却的动作 → 拒绝并带原因重问，换合法动作后放行', async () => {
    const script = [
      '{"tool":"water_crops","args":{},"intent":"热身（让换日重置先发生）"}',
      '{"tool":"tidy_backpack","args":{},"intent":"再整理一次"}',
      '{"tool":"ship_items","args":{"item":"沙丁鱼"},"intent":"冷却了就换出货"}',
    ];
    let call = 0;
    const receipts = stuckReceipts();
    const p = new LlmPlanner({
      chat: async () => {
        const next = script[Math.min(call++, script.length - 1)] ?? '';
        return { content: next };
      },
      recentReceipts: receipts,
    });
    // 先热身一跳（非满包正常决策）让换日重置发生——否则 decide 开头会清掉注入的冷却标记
    await p.decide(parseGameState(`${STATE_OK}\n## 背包（序号: 物品）\n0: 斧头\n背包空位：2 个（共 12 格）`));
    (p as unknown as { cooledTools: Set<string> }).cooledTools.add('tidy_backpack');
    const d = await p.decide(stuckRaw());
    expect(d.kind === 'act' && d.tool).toBe('ship_items');
    expect(call).toBe(3); // 热身 1 + 冷却拒绝 1 + 重问放行 1
  });

  it('大脑原样重复刚失败的动作（同工具同物品）→ 拒绝重问；同工具换物品放行', async () => {
    const receipts = [
      ...stuckReceipts(),
      'FAILED trash_item: 失败：6:普通窗户x1 一个能卖 300g，没有扔',
    ];
    const script = [
      '{"tool":"trash_item","args":{"item":"普通窗户","force":true},"intent":"再扔一次窗户"}',
      '{"tool":"trash_item","args":{"item":"石头","force":true},"intent":"换扔不值钱的石头"}',
    ];
    let call = 0;
    const p = new LlmPlanner({
      chat: async () => {
        const next = script[Math.min(call++, script.length - 1)] ?? '';
        return { content: next };
      },
      recentReceipts: receipts,
    });
    const d = await p.decide(stuckRaw());
    expect(d.kind === 'act' && d.tool).toBe('trash_item');
    expect(d.kind === 'act' && d.args).toMatchObject({ item: '石头' });
    expect(call).toBe(2);
  });

  it('大脑两次坏输出（非白名单工具 + 无法解析）→ 回落确定性阶梯', async () => {
    const receipts = stuckReceipts();
    const p = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"rm_rf","args":{}}' }),
      recentReceipts: receipts,
    });
    const d = await p.decide(stuckRaw());
    // 白名单拒绝重问仍是坏输出 → consult 放弃 → 确定性阶梯接管：无损优先先 donate（case 10）
    expect(d.kind === 'act' && d.tool).toBe('donate_bundles');
  });
});

describe('T-M6-12 决策循环防抖（真机死循环回归）', () => {
  /** 玛妮送宠剧情现场：界面文本从头到尾只有 2 种，真机被 dialogue「推进成功」×191 */
  const EVENT_MENU = '正在播放剧情/节日事件（可以用 skip_event 跳过）。剧情中出现对话时用 dialogue 推进。 对话框（玛妮）：你看见这只猫了吗？ （用 dialogue 不带参数继续/关闭对话）';
  const OK_DIALOGUE = 'OK dialogue: 成功：对话已推进。当前界面：正在播放剧情/节日事件';
  const fullFurnitureFarm = (): GameStateSnapshot => parseGameState(`${STATE_OK.replace('地点：Farm（泡泡湾农场）', '地点：Farm（泡泡湾农场）').replace('邮箱里有 7 封未读信件', '')}
## 背包（序号: 物品）
0: 斧头
6: 普通窗户
## 位置
你站在 (64,15)，面朝右
背包空位：0 个（共 12 格）`);

  it('place_item 六个相邻格轮换不复读同一坐标；预算耗尽 → 单日冷却 → force 丢弃兜底（96 次同坐标复读回归）', async () => {
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => { throw new Error('brain offline'); }, recentReceipts: receipts });
    const s = fullFurnitureFarm();
    await planner.decide(s); // store_items
    receipts.push('FAILED store_items: 失败：这里没有箱子');
    await planner.decide(s); // trash 普通窗户（会被 BWF 拒）
    receipts.push('FAILED trash_item: 失败：6:普通窗户x1 一个能卖 300g，没有扔');
    const coords: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const d = await planner.decide(s);
      expect(d.kind === 'act' && d.tool).toBe('place_item');
      if (d.kind !== 'act') throw new Error('unreachable');
      coords.push(`${String(d.args.x)},${String(d.args.y)}`);
      receipts.push(`FAILED place_item: 失败：(${String(d.args.x)},${String(d.args.y)}) 被挡着，放不了普通窗户`);
    }
    // 六次尝试坐标两两不同（真机 96 次全部 (65,15) 的反例）
    expect(new Set(coords).size).toBe(6);
    // 第 7 次：单日预算（6 格）耗尽 → place_item 冷却 → 阶梯降级到 force 丢弃
    const fallbackDecision = await planner.decide(s);
    expect(fallbackDecision.kind === 'act' && fallbackDecision.tool).toBe('trash_item');
    expect(fallbackDecision.kind === 'act' && fallbackDecision.args).toEqual({ item: '普通窗户', force: true });
  });

  it('重启/插队场景：缓冲区尾部一排 place 失败 → 直接拉黑该家具 + 冷却（不依赖本进程计数）', async () => {
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
    const s = fullFurnitureFarm();
    await planner.decide(s);
    receipts.push('FAILED store_items: 失败：这里没有箱子');
    await planner.decide(s);
    receipts.push('FAILED trash_item: 失败：6:普通窗户x1 一个能卖 300g，没有扔');
    await planner.decide(s); // place_item 第一次
    receipts.push(...Array.from({ length: 6 }, () => 'FAILED place_item: 失败：(64,16) 被挡着，放不了普通窗户'));
    const d = await planner.decide(s);
    // 摆放已单日冷却：不再选 place_item，直接 force 丢弃兜底
    expect(d.kind === 'act' && d.tool).toBe('trash_item');
    expect(d.kind === 'act' && d.args).toEqual({ item: '普通窗户', force: true });
  });

  it('dialogue 效果核验：同一界面文本连续推进 8 次不变 → skip_event（191 次循环回归）', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
      recentReceipts: [OK_DIALOGUE],
    });
    const s = { ...state(), menu: EVENT_MENU };
    for (let i = 0; i < 7; i++) {
      const d = await planner.decide(s);
      expect(d.kind === 'act' && d.tool).toBe('dialogue');
    }
    const stuck = await planner.decide(s);
    expect(stuck.kind === 'act' && stuck.tool).toBe('skip_event');
    expect(stuck.kind === 'act' && stuck.intent).toContain('推不动');
    expect(asked).toBe(0); // 全程确定性处理，不烧 token
  });

  it('skip_event 也失败 → close_menu；两个逃生口都失败 → wait 求主人接管', async () => {
    const closePlanner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED skip_event: 失败：现在没在放剧情', ...Array.from({ length: 7 }, () => OK_DIALOGUE)],
    });
    const s = { ...state(), menu: EVENT_MENU };
    for (let i = 0; i < 7; i++) await closePlanner.decide(s);
    const d = await closePlanner.decide(s);
    expect(d.kind === 'act' && d.tool).toBe('close_menu');

    const deadPlanner = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED skip_event: 失败：现在没在放剧情', 'FAILED close_menu: 失败：现在没有打开的界面', ...Array.from({ length: 6 }, () => OK_DIALOGUE)],
    });
    for (let i = 0; i < 7; i++) await deadPlanner.decide(s);
    const dead = await deadPlanner.decide(s);
    expect(dead.kind).toBe('wait');
    expect(dead.kind === 'wait' && dead.reason).toContain('F7');
  });

  it('donate_bundles 失败 → bundle_info 查缺料（当天一次）→ 再失败 → 冷却 → wait；跨日预算重置', async () => {
    const raw = `${STATE_OK}
## 背包（序号: 物品）
0: 斧头
5: 黄水仙【留着：社区中心“春季采集”要交】
6: 石头【留着：社区中心“建筑”要交】
## 位置
你站在 (64,15)，面朝右
背包空位：0 个（共 12 格）`;
    const receipts: string[] = ['FAILED tidy_backpack: 失败：农场上没有箱子'];
    const planner = new LlmPlanner({ chat: async () => { throw new Error('brain offline'); }, recentReceipts: receipts });
    const s = parseGameState(raw);
    await planner.decide(s); // store_items
    receipts.push('FAILED store_items: 失败：这里没有箱子');
    const donate = await planner.decide(s); // 只剩【留着】 → donate_bundles
    expect(donate.kind === 'act' && donate.tool).toBe('donate_bundles');
    receipts.push('FAILED donate_bundles: 失败：背包里没有能交给已解锁收集包的材料（用 bundle_info 看看缺什么）');
    const info = await planner.decide(s); // BWF 提示 → 查一次缺料
    expect(info.kind === 'act' && info.tool).toBe('bundle_info');
    receipts.push('OK bundle_info: 成功：春季采集：黄水仙×1；建筑：石头×99');
    const retry = await planner.decide(s); // 再试一次 donate（预算 2）
    expect(retry.kind === 'act' && retry.tool).toBe('donate_bundles');
    receipts.push('FAILED donate_bundles: 失败：背包里没有能交给已解锁收集包的材料');
    const cooled = await planner.decide(s); // 冷却 + bundle_info 已查过 → 不再空转
    expect(cooled.kind).toBe('wait');
    expect(cooled.kind === 'wait' && cooled.reason).toContain('背包卡死');
    // 省略快照回归（真机根因）：wait 后 BWF 会「（和上次一样，省略）」，时钟行缺失时 day 回落 1——
    // 绝不能把省略快照当跨日，否则单日冷却被误清空、donate 第三次空转
    const elided = await planner.decide(parseGameState(raw.replace('时间：第1年春16日 07:30（Tue），天气：晴', '（和上次一样，省略）')));
    expect(elided.kind).toBe('wait'); // 冷却仍在
    // 真跨日重置：新的一天预算与冷却清零，donate 重新可用
    const nextDay = parseGameState(raw.replace('第1年春16日', '第1年春17日'));
    const fresh = await planner.decide(nextDay);
    expect(fresh.kind === 'act' && fresh.tool).toBe('donate_bundles');
  });

  it('真纠错重问：坏输出 + 具体原因追加进对话再问（不再是原样重发）', async () => {
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const bad = '我觉得今天应该去钓鱼，但是我不太想输出 JSON。';
    const planner = new LlmPlanner({
      chat: async (_slot, messages) => {
        calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
        return { content: calls.length === 1 ? bad : '{"tool":"water_crops","args":{},"intent":"浇水"}' };
      },
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).toBe('water_crops');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(4); // system + user + 原始坏输出 + 纠错指令
    expect(calls[1]?.[2]).toMatchObject({ role: 'assistant', content: bad });
    expect(calls[1]?.[3]?.content).toContain('没有解析出');
  });

  it('越权工具名 → 纠错消息点名白名单；LLM 选到单日冷却工具 → 提示换做法', async () => {
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const planner = new LlmPlanner({
      chat: async (_slot, messages) => {
        calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
        return { content: calls.length === 1 ? '{"tool":"exec_shell","args":{}}' : '{"tool":"sleep","args":{}}' };
      },
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).toBe('sleep');
    expect(calls[1]?.[3]?.content).toContain('不在 BWF 工具白名单里');

    const switchCalls: Array<Array<{ role: string; content: string }>> = [];
    const cool = new LlmPlanner({
      chat: async (_slot, messages) => {
        switchCalls.push(messages.map((m) => ({ role: m.role, content: m.content })));
        return { content: switchCalls.length === 1 ? '{"tool":"fish","args":{}}' : '{"tool":"forage","args":{}}' };
      },
    });
    // 冷却发生在真实流程的 decide 中段（planDay 已锚定），直接注入要先把日锚设好，否则首个 decide 会当跨日清零
    (cool as unknown as { planDay: string; cooledTools: Set<string> }).planDay = '春16';
    (cool as unknown as { planDay: string; cooledTools: Set<string> }).cooledTools.add('fish');
    const switched = await cool.decide(state());
    expect(switched.kind === 'act' && switched.tool).toBe('forage');
    expect(switchCalls[1]?.[3]?.content).toContain('冷却');
  });
});

describe('T-M6-14 状态感知升级（天气/生命/生日/节日）', () => {
  const FESTIVAL_HINT = '今天是花舞节：建议参加（节日上打招呼加好感，主活动有奖励）。先 get_guide topic=节日 看这个节日做什么，9:00-14:00 之间用 festival enter 入场 → greet → start。节日当天镇上商店都关门；不参加的话这段时间别走 Forest（travel_to 会拦下）';
  const IN_FESTIVAL_MENU = '你在节日里：时间停止，移动和干活的工具都不能用。用 leave_festival 离开节日回去继续干活（对话框打开时先用 dialogue 说完）。';

  it('festivalWindowOf：从 BWF 提示行抠 9:00-14:00 窗口；无提示行 → null', () => {
    expect(festivalWindowOf(FESTIVAL_HINT)).toEqual({ start: 540, end: 840 });
    expect(festivalWindowOf('今天没有节日，普通状态文本')).toBeNull();
    expect(festivalWindowOf('')).toBeNull();
  });

  it('parseGameState：天气/生命/生日/节日 四字段真机格式全解析', () => {
    const raw = `时间：第1年春20日 16:00（Sat），天气：下雨，明天天气：刮风
金钱：2790g  体力：180/270  生命：100/100  今日运气：+0.03
今日：生日 谢恩（生日当天送最爱的礼物好感 8 倍，不受每周 2 次限制）；节日 无`;
    const s = parseGameState(raw);
    expect(s.weather).toBe('下雨');
    expect(s.health).toBe(100);
    expect(s.healthMax).toBe(100);
    expect(s.birthday).toBe('谢恩');
    expect(s.festival).toBeNull();
    expect(isRaining(s)).toBe(true);
    expect(isRaining(parseGameState('时间：第1年春16日 07:30（Tue），天气：晴'))).toBe(false);
    const festDay = parseGameState('今日：生日 无；节日 花舞节（9:00-14:00）');
    expect(festDay.birthday).toBeNull();
    expect(festDay.festival).toBe('花舞节');
  });

  it('RulePlanner 雨天免浇：状态写着要浇但下雨 → 跳过浇水直接走日程', async () => {
    const rainy = parseGameState(`时间：第1年春20日 07:00（Sat），天气：下雨
金钱：100g  体力：270/270  生命：100/100
今日：生日 无；节日 无
## 背包（序号: 物品）
0: 斧头
背包空位：10 个（共 12 格）`);
    const rule = new RulePlanner();
    const d = await rule.decide(rainy);
    expect(d.kind === 'act' && d.tool).not.toBe('water_crops');
    const sunny = parseGameState(rainy.raw.replace('天气：下雨', '天气：晴') + '\n剩 3 株没浇');
    expect(sunny.weather).toBe('晴');
  });

  it('RulePlanner 生命 <30% 撤退：有吃的吃，没吃的回家', async () => {
    const hurt = parseGameState(`时间：第1年春20日 12:00（Sat），天气：晴
金钱：100g  体力：200/270  生命：20/100
## 背包（序号: 物品）
5: 沙丁鱼 [可食用 +23 体力]
背包空位：5 个（共 12 格）`);
    const rule = new RulePlanner();
    const d = await rule.decide(hurt);
    expect(d.kind === 'act' && d.tool).toBe('eat');
    const noFood = parseGameState(hurt.raw.replace('5: 沙丁鱼 [可食用 +23 体力]', '0: 斧头').replace('地点：', '') + '\n## 位置\n地点：Mine（矿洞）');
    const rule2 = new RulePlanner();
    const d2 = await rule2.decide(noFood);
    expect(d2.kind === 'act' && d2.tool).toBe('travel_to');
    expect(d2.kind === 'act' && d2.args).toEqual({ location: 'FarmHouse' });
  });

  it('LlmPlanner 节日入场：窗口内确定性 enter 一次；同日不重复、窗外不盲试', async () => {
    const base = `时间：第1年春24日 10:00（Sat），天气：晴
金钱：100g  体力：270/270  生命：100/100
${FESTIVAL_HINT}
今日：生日 无；节日 花舞节
## 当前界面
无（可以自由行动）`;
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const s = parseGameState(base);
    const d1 = await planner.decide(s);
    expect(d1.kind === 'act' && d1.tool).toBe('festival');
    expect(d1.kind === 'act' && d1.args).toEqual({ action: 'enter' });
    // 同日再决策：入场已试过 → 不再 enter（回落 LLM/日程）
    const d2 = await planner.decide(s);
    expect(d2.kind === 'act' && d2.args).not.toEqual({ action: 'enter' });
    // 窗外（16:00 > 14:00）从头也不入场
    const late = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const lateState = parseGameState(base.replace('10:00', '16:00').replace('9:00-14:00', '9:00-14:00'));
    const d3 = await late.decide(lateState);
    expect(d3.kind === 'act' && d3.tool).not.toBe('festival');
  });

  it('节日场内状态机：greet 一次 → start 一次 → leave 兜底；主活动进行中直接 start', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const inFest = { ...state(), menu: IN_FESTIVAL_MENU };
    const g = await planner.decide(inFest);
    expect(g.kind === 'act' && g.tool).toBe('festival');
    expect(g.kind === 'act' && g.args).toEqual({ action: 'greet' });
    const st = await planner.decide(inFest);
    expect(st.kind === 'act' && st.args).toEqual({ action: 'start' });
    const lv = await planner.decide(inFest);
    expect(lv.kind === 'act' && lv.tool).toBe('leave_festival');

    const running = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const d = await running.decide({ ...state(), menu: '节日主活动进行中：用 festival start 接着参加（会自动过对白、捡彩蛋或钓鱼）。' });
    expect(d.kind === 'act' && d.args).toEqual({ action: 'start' });
  });

  it('节日里对话框打开时先 dialogue（BWF 提示「先用 dialogue 说完」），不抢节日动作', async () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const d = await planner.decide({ ...state(), menu: `${IN_FESTIVAL_MENU} 对话框（刘易斯）：大家节日快乐！` });
    expect(d.kind === 'act' && d.tool).toBe('dialogue');
  });

  it('LlmPlanner 生命护栏：血线 <30% 先吃/回家（先于日程与背包救援）', async () => {
    const hurtRaw = `${STATE_OK.replace('体力：98/270', '体力：200/270').replace('天气：晴', '天气：晴')}
生命：20/100
## 背包（序号: 物品）
5: 沙丁鱼 [可食用 +23 体力]`;
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    const d = await planner.decide(parseGameState(hurtRaw));
    expect(d.kind === 'act' && d.tool).toBe('eat');
    expect(d.kind === 'act' && d.args).toEqual({ item: '沙丁鱼' });
    const noFood = parseGameState(hurtRaw.replace('地点：Farm（泡泡湾农场）', '地点：Mine（矿洞）').replace('5: 沙丁鱼 [可食用 +23 体力]', '0: 斧头'));
    const d2 = await planner.decide(noFood);
    expect(d2.kind === 'act' && d2.tool).toBe('travel_to');
    expect(d2.kind === 'act' && d2.args).toEqual({ location: 'FarmHouse' });
  });

  it('跨日重置节日一次性状态：春24 入场后，春25 提示仍在窗口 → 可再入场', async () => {
    const base = `时间：第1年春24日 10:00（Sat），天气：晴
金钱：100g  体力：270/270  生命：100/100
${FESTIVAL_HINT}
今日：生日 无；节日 花舞节`;
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    await planner.decide(parseGameState(base));
    const nextDay = parseGameState(base.replace('第1年春24日', '第1年夏1日').replace('花舞节', '夏威夷宴会').replace('花舞节：建议参加', '夏威夷宴会：建议参加'));
    const d = await planner.decide(nextDay);
    expect(d.kind === 'act' && d.tool).toBe('festival');
    expect(d.kind === 'act' && d.args).toEqual({ action: 'enter' });
  });
});

describe('T-M6-15 死锁自主解（为未解锁收集包过早预留）', () => {
  /** 真机春20 现场：全部鱼为锁着的鱼缸包预留，背包 0 空位 */
  const LOCKED_BAG = `${STATE_OK.replace('邮箱里有 7 封未读信件', '')}
## 背包（序号: 物品）
0: 斧头
5: 沙丁鱼 铱星 [可食用 +23体力]【留着：社区中心“海鱼”要交】
6: 太阳鱼 金星 [可食用 +23体力]【留着：社区中心“河鱼”要交】
7: 石头 x14【留着：社区中心“建筑”要交】
背包空位：0 个（共 12 格）`;
  const BUNDLE_SNAPSHOT = 'OK bundle_info: 成功：【工艺室(Crafts Room)】   春季采集：已交 1/4，可选材料：野山葵 x1、韭葱 x1、蒲公英 x1   构造（建筑）：石头 x99';

  it('pickPrematureReservedEdible：包名不在已解锁清单 → 过早预留；可食用优先，材料类兜底', () => {
    // 海鱼/河鱼没出现在 bundle_info（鱼缸未解锁）→ 沙丁鱼是过早预留；建筑在清单里 → 石头不动
    expect(pickPrematureReservedEdible(LOCKED_BAG, BUNDLE_SNAPSHOT)).toBe('沙丁鱼');
    // 鱼缸已解锁（快照里提到海鱼）→ 沙丁鱼的预留是合理的 → 只剩河鱼可撤
    expect(pickPrematureReservedEdible(LOCKED_BAG, `${BUNDLE_SNAPSHOT} 鱼缸（Fish Tank）：海鱼 沙丁鱼`)).toBe('太阳鱼');
    // 全部预留都合理 → 不动
    expect(pickPrematureReservedEdible(LOCKED_BAG, '【工艺室】建筑 石头 【鱼缸】海鱼 沙丁鱼 河鱼 太阳鱼')).toBeNull();
  });

  it('救援阶梯 step 11：死锁 + 快照在手 → 撤一件过早预留（每天一次）并重进 eat 档', async () => {
    type Internals = {
      bundleSnapshot: string; unreserveTried: boolean; rescueStage: number; nextRescueStage: number | null;
      cooledTools: Set<string>; dayInfoDone: Set<string>;
    };
    const receipts: string[] = [
      'FAILED tidy_backpack: 失败：农场上没有箱子',
      'FAILED store_items: 失败：这里没有箱子',
      'FAILED donate_bundles: 失败：背包里没有能交给已解锁收集包的材料',
      BUNDLE_SNAPSHOT,
      'FAILED donate_bundles: 失败：背包里没有能交给已解锁收集包的材料',
    ];
    const planner = new LlmPlanner({ chat: async () => { throw new Error('brain offline'); }, recentReceipts: receipts });
    const s = parseGameState(LOCKED_BAG);
    const internals = planner as unknown as Internals;
    // 前置：查过缺料、donate 已冷却、阶梯停在 10 档之后
    await planner.decide(s);
    expect(internals.bundleSnapshot).toContain('工艺室'); // decide 捕获了 bundle_info 快照
    internals.cooledTools = new Set(['donate_bundles']);
    internals.dayInfoDone.add('bundle_info');
    internals.rescueStage = 11;
    const unreserve = await planner.decide(s);
    expect(unreserve.kind === 'act' && unreserve.tool).toBe('reserve_items');
    expect(unreserve.kind === 'act' && unreserve.args).toEqual({ remove: '沙丁鱼' });
    expect(internals.unreserveTried).toBe(true);
    expect(internals.rescueStage).toBe(2); // 撤完重进 eat 档
    // BWF 撤预留即时生效：下一状态沙丁鱼标签消失（当天不再二次撤预留）→ eat 档把它吃掉腾位
    const untagged = parseGameState(LOCKED_BAG.replace('【留着：社区中心“海鱼”要交】', ''));
    receipts.push('OK reserve_items: 成功：不再留着 沙丁鱼');
    const eat = await planner.decide(untagged);
    expect(eat.kind === 'act' && eat.tool).toBe('eat');
    expect(eat.kind === 'act' && eat.args).toEqual({ item: '沙丁鱼' });
  });
});

describe('T-M6-39 团队黑板动态注入', () => {
  it('每轮注入 ≤300 字摘要与当前 objective；personaPrompt 替换角色段', async () => {
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const planner = new LlmPlanner({
      personaPrompt: '你是泡芙——软萌柴犬队友。',
      contextProvider: () => `目标：建鸡舍\n${'长'.repeat(400)}`,
      chat: async (_slot, messages) => {
        seen.push(messages);
        return { content: '{"tool":"fish","args":{"casts":2},"intent":"钓鱼"}' };
      },
    });
    planner.setObjective('去海滩钓 5 条鱼');
    const decision = await planner.decide(state());
    expect(decision).toMatchObject({ kind: 'act', tool: 'fish' });
    const first = seen[0]!;
    expect(first[0]?.content).toContain('泡芙');
    expect(first[1]?.content).toContain('团队协作黑板');
    expect(first[1]?.content).toContain('当前目标：去海滩钓 5 条鱼');
    expect(first[1]?.content.length).toBeLessThan(4_500);
    planner.setObjective('   ');
    await planner.decide(state());
    expect(seen[1]?.[1]?.content).not.toContain('当前目标：');
  });

  it('contextProvider 抛异常/返回空串时不污染规划', async () => {
    const planner = new LlmPlanner({
      contextProvider: () => { throw new Error('board down'); },
      chat: async () => ({ content: '{"tool":"read_mail","args":{},"intent":"读信"}' }),
    });
    expect(await planner.decide(state())).toMatchObject({ kind: 'act', tool: 'read_mail' });
    const empty = new LlmPlanner({
      contextProvider: () => '   ',
      chat: async () => ({ content: '{"tool":"read_mail","args":{},"intent":"读信"}' }),
    });
    expect(await empty.decide(state())).toMatchObject({ kind: 'act', tool: 'read_mail' });
  });
});

describe('连续失败换做法（2026-11-24 真机「没鱼竿 → fish 无限失败」死循环修复）', () => {
  const BEACH_NOON = `## 基本状态
时间：第1年夏2日 11:10（Mon），天气：晴，明天天气：晴
金钱：19519g  体力：270/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Beach（沙滩），室外
## 背包（序号: 物品）
0: 斧头（手持）
1: 竹鱼竿（手持）
背包空位：20 个（共 24 格）
`;

  it('连续 FAILED fish → 问大脑换做法：拒绝重复 fish 后接受替代动作', async () => {
    const systems: string[] = [];
    const planner = new LlmPlanner({
      chat: async (_slot, messages) => {
        systems.push(messages[1]?.content ?? '');
        return {
          content: systems.length === 1
            ? '{"tool":"fish","args":{}}'
            : '{"tool":"forage","args":{},"intent":"没鱼竿，先去采集"}',
        };
      },
      recentReceipts: [
        'FAILED fish: 失败：背包里没有鱼竿（第二天早上上海边找威利 Willy 会送你一根，或者在鱼店 FishShop 买）',
        'FAILED fish: 失败：背包里没有鱼竿',
      ],
    });
    const decision = await planner.decide(parseGameState(BEACH_NOON));
    expect(decision.kind === 'act' && decision.tool).toBe('forage');
    expect(systems).toHaveLength(2); // 第一次坚持 fish 被护栏拒绝，第二次换做法
    expect(systems[0]).toContain('已失败到冷却');
  });

  it('observeReceipt 转发给规则兜底：没鱼竿后规则日程也不再选 fish', async () => {
    const planner = new LlmPlanner({
      chat: async () => { throw new Error('brain offline'); },
      recentReceipts: [],
    });
    const beach = parseGameState(BEACH_NOON);
    const first = await planner.decide(beach); // 规则：已在海滩 → 钓鱼
    expect(first.kind === 'act' && first.tool).toBe('fish');
    planner.observeReceipt('fish', 'FAILED', '失败：背包里没有鱼竿');
    const third = await planner.decide(beach); // 规则已学到失败 → 转采集（先去镇上）
    expect(third.kind === 'act' && third.tool).toBe('travel_to');
    expect(third.kind === 'act' && third.args).toMatchObject({ location: 'Town' });
  });
});

describe('多游戏适配器路径的连败防护', () => {
  it('连续 FAILED 后问大脑换做法（systemPrompt 路径）', async () => {
    const planner = new LlmPlanner({
      systemPrompt: '你是泰拉瑞亚规划器，只输出一行 JSON。',
      chat: async () => ({ content: '{"tool":"forage","args":{},"intent":"换个办法采集"}' }),
      recentReceipts: ['FAILED fish: 失败：这里没有水', 'FAILED fish: 失败：这里没有水'],
    });
    const state = parseGameState(`## 基本状态
时间：第1年夏2日 11:10（Mon），天气：晴
金钱：100g  体力：100/100  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Beach（沙滩），室外
## 背包（序号: 物品）
0: 斧头（手持）
背包空位：5 个（共 12 格）
`);
    const decision = await planner.decide(state);
    expect(decision.kind === 'act' && decision.tool).toBe('forage');
    // 成功回执解除咨询冷却（覆盖 observeReceipt 的 COMPLETED 分支）
    planner.observeReceipt('fish', 'COMPLETED', '钓到一条鱼');
  });
});

describe('规则兜底冷却拦截（2026-11-24）', () => {
  it('兜底动作已冷却 → wait 求助，不原样发出', async () => {
    const beach = parseGameState(`## 基本状态
时间：第1年夏2日 11:10（Mon），天气：晴
金钱：100g  体力：270/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Beach（沙滩），室外
## 背包（序号: 物品）
0: 斧头（手持）
1: 竹鱼竿（手持）
背包空位：20 个（共 24 格）
`);
    const planner = new LlmPlanner({
      chat: async () => { throw new Error('brain offline'); },
      recentReceipts: ['FAILED fish: 失败：背包里没有鱼竿', 'FAILED fish: 失败：背包里没有鱼竿'],
    });
    const first = await planner.decide(beach); // 规则想 fish，但今天已冷却 → wait 求助
    expect(first.kind).toBe('wait');
    expect(first.kind === 'wait' ? first.reason : '').toContain('已冷却');
  });
});

describe('规则兜底透传（覆盖非 act 早退分支）', () => {
  it('兜底返回 wait 时原样透传，不套「规则兜底」前缀', async () => {
    const planner = new LlmPlanner({
      chat: async () => { throw new Error('offline'); },
      fallbackPlanner: { name: 'wait-rule', decide: async () => ({ kind: 'wait', seconds: 5, reason: '等一会儿' }) },
    });
    const d = await planner.decide(state());
    expect(d).toMatchObject({ kind: 'wait', seconds: 5, reason: '等一会儿' });
  });
});


describe('多步目标生命周期（T-M6-54：跨日/完成/最大轮数）', () => {
  const capturePlanner = (reply: string): { planner: LlmPlanner; prompts: string[] } => {
    const prompts: string[] = [];
    const planner = new LlmPlanner({
      chat: async (_slot, messages) => {
        prompts.push(messages[1]?.content ?? '');
        return { content: reply };
      },
    });
    return { planner, prompts };
  };

  it('决策 JSON objectiveDone:true → 立即清空目标，后续 prompt 不再注入', async () => {
    expect(extractDecisionJson('{"tool":"read_mail","args":{},"objectiveDone":true}')).toMatchObject({ objectiveDone: true });
    expect(extractDecisionJson('{"tool":"read_mail","args":{},"objectiveDone":false}')?.objectiveDone).toBeUndefined();
    const { planner, prompts } = capturePlanner('{"tool":"read_mail","args":{},"intent":"读完了","objectiveDone":true}');
    planner.setObjective('把邮箱里的信读完');
    expect(planner.hasObjective()).toBe(true);
    await planner.decide(state());
    expect(prompts[0]).toContain('主人当前目标：把邮箱里的信读完');
    expect(prompts[0]).toContain('objectiveDone');
    expect(prompts[0]).toContain('动作回执成功后目标才算完成');
    expect(planner.hasObjective()).toBe(false);
    await planner.decide(state());
    expect(prompts[1]).not.toContain('主人当前目标');
    expect((planner as unknown as { objective: string | null }).objective).toBeNull();
  });

  it('objectiveDone 需真实回执确认：成功 consume 一次，失败 restore 继续推进', async () => {
    const { planner } = capturePlanner('{"tool":"buy","args":{},"intent":"买鱼竿","objectiveDone":true}');
    planner.setObjective('去鱼店买鱼竿');
    await planner.decide(state());
    expect(planner.hasObjective()).toBe(false);
    expect(planner.consumeObjectiveDone()).toBe('去鱼店买鱼竿');
    expect(planner.consumeObjectiveDone()).toBeNull();

    planner.setObjective('去鱼店买鱼竿');
    await planner.decide(state());
    planner.restoreObjectiveDone();
    expect(planner.hasObjective()).toBe(true);
    expect(planner.consumeObjectiveDone()).toBeNull();
    // 新目标覆盖旧目标时，未确认的完成声明作废
    const second = capturePlanner('{"tool":"buy","args":{},"intent":"买鱼竿","objectiveDone":true}').planner;
    second.setObjective('去鱼店买鱼竿');
    await second.decide(state());
    second.setObjective('改去矿洞');
    expect(second.consumeObjectiveDone()).toBeNull();
  });

  it('环境提示注入 user prompt：无鱼竿/打烊/低空位/箱子摘要', async () => {
    let captured = '';
    const planner = new LlmPlanner({
      chat: async (_slot, messages) => {
        captured = messages[1]?.content ?? '';
        return { content: '{"tool":"travel_to","args":{"location":"FishShop"},"intent":"去鱼店买鱼竿"}' };
      },
      recentReceipts: ['COMPLETED list_chests: Farm 箱子1：鱼竿 x1、木材 x50'],
    });
    const raw = `时间：第1年春16日 18:20（Tue），天气：晴
## 背包
5: 防风草种子 x15
背包空位：1 个（共 12 格）`;
    await planner.decide({ ...state(), raw, clockMinutes: 18 * 60 + 20 });
    expect(captured).toContain('环境提示（已确证的前置事实，别白撞）');
    expect(captured).toContain('背包没有鱼竿');
    expect(captured).toContain('17:00 已打烊');
    expect(captured).toContain('背包只剩 1 个空位');
    expect(captured).toContain('Farm 箱子1：鱼竿 x1、木材 x50');
  });

  it(`推进超过 ${MAX_OBJECTIVE_ROUNDS} 轮自动清空，防旧目标无限驱动`, async () => {
    const { planner, prompts } = capturePlanner('{"tool":"fish","args":{},"intent":"钓鱼"}');
    planner.setObjective('钓到 5 条鱼');
    for (let i = 0; i < MAX_OBJECTIVE_ROUNDS; i++) await planner.decide(state());
    expect(prompts.at(-1)).toContain('主人当前目标：钓到 5 条鱼');
    await planner.decide(state());
    expect(prompts.at(-1)).not.toContain('主人当前目标');
    expect((planner as unknown as { objectiveRounds: number }).objectiveRounds).toBe(0);
  });

  it('跨日重置清空目标（昨天的目标不延续到今天）', async () => {
    const { planner, prompts } = capturePlanner('{"tool":"fish","args":{},"intent":"钓鱼"}');
    planner.setObjective('去鱼店买鱼竿');
    await planner.decide(state());
    expect(prompts.at(-1)).toContain('主人当前目标：去鱼店买鱼竿');
    const nextDay = parseGameState(STATE_OK.replace('第1年春16日', '第2年春17日'));
    await planner.decide(nextDay);
    expect(prompts.at(-1)).not.toContain('主人当前目标');
    expect((planner as unknown as { objective: string | null }).objective).toBeNull();
  });

  it('setObjective(null/空白) 与全新目标都会重置轮数', () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }) });
    planner.setObjective('目标 A');
    (planner as unknown as { objectiveRounds: number }).objectiveRounds = 12;
    planner.setObjective(null);
    expect((planner as unknown as { objectiveRounds: number }).objectiveRounds).toBe(0);
    planner.setObjective('目标 B');
    expect((planner as unknown as { objectiveRounds: number }).objectiveRounds).toBe(0);
  });
});
