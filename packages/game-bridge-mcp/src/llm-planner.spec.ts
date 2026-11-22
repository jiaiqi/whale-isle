/**
 * T-M6-01 完整版门禁：LLM Planner 决策协议 / 坏输出回落 / 白名单越权拦截 / 攻略检索。
 * chat 全注入 mock（零网络）。
 */
import { describe, expect, it } from 'vitest';
import { extractDecisionJson, LlmPlanner, LLM_TOOL_WHITELIST, pickGuideContext, pickShippableItem } from './llm-planner';
import { countWood, hasChestItem, parseGameState, pickFurnitureToPlace, type GameStateSnapshot } from './planner';

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
