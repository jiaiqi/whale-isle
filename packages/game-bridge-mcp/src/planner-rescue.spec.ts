/**
 * T-M6-10 真机回归修复：规则模式满包有界救援阶梯。
 * 现场：春21日 08:30、背包空位 0、全是【留着】收集包材料、农场无箱子 →
 * 旧逻辑反复 tidy_backpack FAILED（时间冻结、动作空转）。
 */
import { describe, expect, it } from 'vitest';
import { findNearestTree, hasChestItem, parseGameState, RulePlanner } from './planner';

const FULL_RESERVED = `## 基本状态
时间：第1年春21日 08:30（Sun），天气：晴，明天天气：晴
金钱：2890g  体力：270/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Farm（泡泡湾农场），室外
## 背包（序号: 物品）
0: 斧头（手持）
1: 锄头
5: 木材 x22【留着：社区中心“建筑”要交】
7: 石头 x14【留着：社区中心“建筑”要交】
10: 太阳鱼 金星 [可食用 +23体力]【留着：社区中心“河鱼”要交】
背包空位：0 个（共 12 格）
## 附近物体
- 出货箱：(3,4)
`;

const FULL_WITH_SHIPPABLE = FULL_RESERVED.replace(
  '10: 太阳鱼 金星 [可食用 +23体力]【留着：社区中心“河鱼”要交】',
  '10: 沙丁鱼 x3',
);

const UPGRADE_LINE = '背包扩到 24 格：2000g，皮埃尔杂货店（SeedShop）柜台上的背包，interact 它';
const FULL_UPGRADE = FULL_RESERVED.replace('## 附近物体', `${UPGRADE_LINE}\n## 附近物体`);
const FULL_UPGRADE_SHOP = FULL_UPGRADE
  .replace('地点：Farm（泡泡湾农场），室外', '地点：SeedShop（皮埃尔的杂货店），室内')
  .replace('- 出货箱：(3,4)', '- 可交互地图格[BuyBackpack] [interact]：(7,18)');

describe('findNearestTree（文字地图定向砍树）', () => {
  it('按左上角坐标换算并返回最近的树', () => {
    const raw = `## 文字地图（以你为中心，左上角坐标=(-2,0)，每个字符一格）
   0  ##T##
   1  #.@.T
`;
    expect(findNearestTree(raw, 0, 1)).toEqual({ x: 0, y: 0 });
  });

  it('没有地图/没有树返回 null', () => {
    expect(findNearestTree('## 位置\n地点：Farm', 0, 0)).toBeNull();
    expect(findNearestTree('## 文字地图\n左上角坐标=(0,0)\n0  ....', 0, 0)).toBeNull();
    // 地图段存在但缺左上角坐标 / 行内容不是地图字符 → 不猜
    expect(findNearestTree('## 文字地图\n0  T', 0, 0)).toBeNull();
    expect(findNearestTree('## 文字地图\n左上角坐标=(0,0)\n附近没有树', 0, 0)).toBeNull();
  });

  it('多棵树按玩家坐标取最近（负坐标也正确换算）', () => {
    const raw = `## 文字地图（以你为中心，左上角坐标=(-3,-2)，每个字符一格）
  -2  T....T
  -1  ..@...
   0  ...t..`;
    // 世界坐标：树 (-3,-2) 与 (2,-2)；玩家 (-2,-1)
    expect(findNearestTree(raw, -2, -1)).toEqual({ x: -3, y: -2 });
    const nearRight = `## 文字地图（以你为中心，左上角坐标=(10,5)，每个字符一格）
   5  T....T
   6  ..@...`;
    expect(findNearestTree(nearRight, 12, 6)).toEqual({ x: 10, y: 5 });
  });

  it('hasChestItem 识别中文「宝箱」（真机背包名，非「箱子」）', () => {
    expect(hasChestItem('18: 宝箱')).toBe(true);
    expect(hasChestItem('18: 宝箱【留着】')).toBe(false);
    expect(hasChestItem('18: 普通箱子')).toBe(false);
  });
});

describe('RulePlanner 满包救援阶梯（真机回归 T-M6-10）', () => {
  it('满包全是【留着】：先 donate_bundles，不再直接 tidy', async () => {
    const planner = new RulePlanner();
    const decision = await planner.decide(parseGameState(FULL_RESERVED));
    expect(decision.kind).toBe('act');
    if (decision.kind === 'act') {
      expect(decision.tool).toBe('donate_bundles');
      expect(decision.intent).toContain('收集包');
    }
  });

  it('donate 失败后只尝试一次 tidy；再失败则 wait 求助，不再空转', async () => {
    const planner = new RulePlanner();
    const state = parseGameState(FULL_RESERVED);
    expect((await planner.decide(state)).kind).toBe('act');

    planner.observeReceipt?.('donate_bundles', 'FAILED', '没有可交的收集包');
    const second = await planner.decide(state);
    expect(second.kind).toBe('act');
    if (second.kind === 'act') expect(second.tool).toBe('tidy_backpack');

    planner.observeReceipt?.('tidy_backpack', 'FAILED', '失败：农场上没有箱子');
    const third = await planner.decide(state);
    expect(third.kind).toBe('wait');
    if (third.kind === 'wait') {
      expect(third.reason).toContain('主人');
      expect(third.reason).toContain('不空转');
      expect(third.seconds).toBeGreaterThan(0);
    }

    // 再下一轮仍是 wait（不会重新尝试 donate/tidy）
    const fourth = await planner.decide(state);
    expect(fourth.kind).toBe('wait');
  });

  it('有可卖物时优先 ship_items（不依赖箱子）', async () => {
    const planner = new RulePlanner();
    const decision = await planner.decide(parseGameState(FULL_WITH_SHIPPABLE));
    expect(decision.kind).toBe('act');
    if (decision.kind === 'act') expect(decision.tool).toBe('ship_items');
  });

  it('腾出空位后清空救援记忆', async () => {
    const planner = new RulePlanner();
    const full = parseGameState(FULL_RESERVED);
    await planner.decide(full);
    planner.observeReceipt?.('donate_bundles', 'FAILED', '没有可交的收集包');
    await planner.decide(full);
    planner.observeReceipt?.('tidy_backpack', 'FAILED', '没有箱子');
    expect((await planner.decide(full)).kind).toBe('wait');

    // 背包空位恢复 → 下一轮回到正常日程（不再是 wait）
    const free = parseGameState(FULL_RESERVED.replace('背包空位：0 个', '背包空位：3 个'));
    const decision = await planner.decide(free);
    expect(decision.kind).toBe('act');
    expect(decision.kind === 'act' ? decision.tool : '').not.toBe('donate_bundles');
  });

  it('钱够且提示可扩容：先去 SeedShop', async () => {
    const planner = new RulePlanner();
    const decision = await planner.decide(parseGameState(FULL_UPGRADE));
    expect(decision.kind).toBe('act');
    if (decision.kind === 'act') {
      expect(decision.tool).toBe('travel_to');
      expect(decision.args.location).toBe('SeedShop');
      expect(decision.intent).toContain('扩容');
    }
  });

  it('到店后按 [BuyBackpack] 坐标 interact；失败后不再重复', async () => {
    const planner = new RulePlanner();
    const state = parseGameState(FULL_UPGRADE_SHOP);
    const first = await planner.decide(state);
    expect(first.kind).toBe('act');
    if (first.kind === 'act') {
      expect(first.tool).toBe('interact');
      expect(first.args).toMatchObject({ x: 7, y: 18 });
    }
    planner.observeReceipt?.('interact', 'FAILED', '钱不够');
    const second = await planner.decide(state);
    expect(second.kind === 'act' ? second.tool : '').not.toBe('interact');
  });

  it('钱不够扩容：不触发购买路径', async () => {
    const planner = new RulePlanner();
    const poor = FULL_UPGRADE.replace('金钱：2890g', '金钱：500g');
    const decision = await planner.decide(parseGameState(poor));
    expect(decision.kind === 'act' ? decision.tool : '').not.toBe('travel_to');
    expect(decision.kind === 'act' ? decision.tool : '').not.toBe('interact');
  });

  it('扩容选择菜单：dialogue choice 0（购买）', async () => {
    const planner = new RulePlanner();
    const withMenu = FULL_UPGRADE_SHOP.replace(
      '无（可以自由行动）',
      '对话框：背包升级：24格\n选项（用 dialogue 并传 choice 序号回答）：\n  0: 购买（2000 金）\n  1: 以后再说',
    );
    const decision = await planner.decide(parseGameState(withMenu));
    expect(decision.kind).toBe('act');
    if (decision.kind === 'act') {
      expect(decision.tool).toBe('dialogue');
      expect(decision.args.choice).toBe(0);
    }
  });
});

describe('工具级失败记忆（2026-11-24 真机「没鱼竿 → fish 无限失败」死循环修复）', () => {
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

  it('环境级失败（没鱼竿）一次即绕开 fish：规则日程转采集，不再重复空转', async () => {
    const planner = new RulePlanner();
    const state = parseGameState(BEACH_NOON);
    const goBeach = await planner.decide(state); // 11:00 后农活收尾 → 去海滩
    expect(goBeach.kind === 'act' && goBeach.tool).toBe('travel_to');
    const fish = await planner.decide(state); // 到海滩进入钓鱼阶段
    expect(fish.kind === 'act' && fish.tool).toBe('fish');
    planner.observeReceipt('fish', 'FAILED', '失败：背包里没有鱼竿（第二天早上上海边找威利 Willy 会送你一根，或者在鱼店 FishShop 买）');
    const next = await planner.decide(state);
    expect(next.kind === 'act' && next.tool).not.toBe('fish');
    expect(next.kind === 'act' && next.tool).toBe('travel_to'); // 转采集：先去镇上
  });

  it('普通失败连续两次才绕开 fish（一次失败仍按日程继续）', async () => {
    const planner = new RulePlanner();
    const state = parseGameState(BEACH_NOON);
    await planner.decide(state); // 11:00 后农活收尾 → 去海滩，phase=fishing
    planner.observeReceipt('fish', 'FAILED', '失败：鱼跑掉了');
    const stillFish = await planner.decide(state);
    expect(stillFish.kind === 'act' && stillFish.tool).toBe('fish');
    planner.observeReceipt('fish', 'FAILED', '失败：鱼又跑掉了');
    const avoided = await planner.decide(state);
    expect(avoided.kind === 'act' && avoided.tool).not.toBe('fish');
  });
});

describe('采集/清地兜底不空转（失败记忆链）', () => {
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

  it('采集也连败 → 回农场清地；清地也连败 → 明确求助（wait 不空转）', async () => {
    const planner = new RulePlanner();
    const beach = parseGameState(BEACH_NOON);
    await planner.decide(beach); // 热身：首轮 decide 会触发跨日重置，先让它过去
    planner.observeReceipt('fish', 'FAILED', '失败：背包里没有鱼竿');
    planner.observeReceipt('forage', 'FAILED', '失败：这里没有可以采集的东西');
    planner.observeReceipt('forage', 'FAILED', '失败：这里没有可以采集的东西');
    const toFarm = await planner.decide(beach);
    expect(toFarm.kind === 'act' && toFarm.tool).toBe('travel_to');
    expect(toFarm.kind === 'act' && toFarm.args).toMatchObject({ location: 'Farm' });
    const atFarm = parseGameState(BEACH_NOON.replace('地点：Beach（沙滩），室外', '地点：Farm（泡泡湾农场），室外'));
    const clear = await planner.decide(atFarm);
    expect(clear.kind === 'act' && clear.tool).toBe('clear_area');
    planner.observeReceipt('clear_area', 'FAILED', '失败：这里没有可以清理的东西');
    planner.observeReceipt('clear_area', 'FAILED', '失败：这里没有可以清理的东西');
    const giveUp = await planner.decide(atFarm);
    expect(giveUp.kind).toBe('wait');
  });
});

describe('生存类工具不参与当日避让', () => {
  it('sleep 连续失败仍按作息重试（不被 failStreak 跳过）', async () => {
    const planner = new RulePlanner();
    const late = parseGameState(`## 基本状态
时间：第1年夏2日 23:10（Mon），天气：晴
金钱：100g  体力：100/100  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：FarmHouse（农舍），室内
## 背包（序号: 物品）
0: 斧头（手持）
背包空位：5 个（共 12 格）
`);
    planner.observeReceipt('sleep', 'FAILED', '失败：还没到睡觉时间');
    planner.observeReceipt('sleep', 'FAILED', '失败：还没到睡觉时间');
    const d = await planner.decide(late);
    expect(d.kind === 'act' && d.tool).toBe('sleep');
  });
});

describe('hasFishingRod 未知态不阻断日程', () => {
  it('状态里没有背包段（null）→ 规则照常钓鱼，不误判为没鱼竿', async () => {
    const planner = new RulePlanner();
    const noBag = parseGameState(`## 基本状态
时间：第1年夏2日 11:10（Mon），天气：晴
金钱：100g  体力：100/100  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：Beach（沙滩），室外
`);
    await planner.decide(noBag); // 农活收尾 → 去海滩
    const d = await planner.decide(noBag);
    expect(d.kind === 'act' && d.tool).toBe('fish');
  });
});
