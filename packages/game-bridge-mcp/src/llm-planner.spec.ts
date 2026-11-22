/**
 * T-M6-01 完整版门禁：LLM Planner 决策协议 / 坏输出回落 / 白名单越权拦截 / 攻略检索。
 * T-M6-12 决策循环防抖门禁：单日失败预算与冷却 / dialogue 效果核验 / donate→bundle_info / 真纠错重问。
 * chat 全注入 mock（零网络）。真机病灶：同一冻结分钟 dialogue×191 / place_item×96 / donate_bundles×29。
 */
import { describe, expect, it } from 'vitest';
import { extractDecisionJson, festivalWindowOf, LlmPlanner, LLM_TOOL_WHITELIST, pickGuideContext, pickShippableItem } from './llm-planner';
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

  it('stage7 造箱：满格/已有箱/木材不足→null；木材够→craft；已试过→null', () => {
    const p = planner();
    expect(call(p, 7, withInv('4: 木材 x60', { freeSlots: 0 }))).toBeNull();
    expect(call(p, 7, withInv('4: 木材 x60\n5: 箱子'))).toBeNull();
    expect(call(p, 7, withInv('4: 木材 x10'))).toBeNull();
    const craft = call(p, 7, withInv('4: 木材 x60'));
    expect(craft?.kind === 'act' && craft.tool).toBe('craft');
    (p as unknown as StepPlanner).craftTried = true;
    expect(call(p, 7, withInv('4: 木材 x60'))).toBeNull();
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
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
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
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
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
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
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
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: ['FAILED place_item: 摆放位置不合适，最好的坐标 (30,40)'],
    });
    await suggested.decide(fullFurniture);
    expect((suggested as unknown as Internals).placeTarget).toEqual({ x: 30, y: 40 });

    const repeated = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
      recentReceipts: Array.from({ length: 6 }, () => 'FAILED place_item: 失败：(64,16) 被挡着'),
    });
    (repeated as unknown as Internals).pendingPlaceItem = '普通窗户';
    await repeated.decide(fullFurniture);
    expect((repeated as unknown as Internals).rejectedPlace.has('普通窗户')).toBe(true);

    const craftFail = new LlmPlanner({
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
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
      chat: async () => ({ content: '{"tool":"fish","args":{}}' }),
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
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
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
    expect(normal.kind === 'act' && normal.tool).toBe('water_crops');
    expect(asked).toBe(1);
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

  it('同一工具连续两次失败（非背包）→ 换规则日程，不重复死磕', async () => {
    let asked = 0;
    const planner = new LlmPlanner({
      chat: async () => { asked++; return { content: '{"tool":"fish","args":{}}' }; },
      recentReceipts: ['FAILED fish: 失败：这里没有水', 'FAILED fish: 失败：没有水钓不了'],
    });
    const d = await planner.decide(state());
    expect(d.kind === 'act' && d.tool).not.toBe('fish');
    expect(asked).toBe(0);
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
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
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
    const planner = new LlmPlanner({ chat: async () => ({ content: '{"tool":"fish","args":{}}' }), recentReceipts: receipts });
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
