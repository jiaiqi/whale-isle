/** 环境障碍摘要（T-M6-57）：商店打烊/无鱼竿/低空位/箱子摘要 + ≤240 字上限。 */
import { describe, expect, it } from 'vitest';
import {
  extractEnvironmentHints,
  hasToolInBag,
  parseFarmSummary,
  parseSeedInventory,
  parseWeekday,
  seedShopStatus,
} from './state-hints';

const STATE = `时间：第1年春16日 07:30（Tue），天气：晴
金钱：640g  体力：98/270  生命：100/100
## 背包
5: 防风草种子 x15
6: 木材 x22
背包空位：2 个（共 12 格）`;

describe('extractEnvironmentHints', () => {
  it('早上 8:30：鱼店未开门 + 无鱼竿 + 只剩 2 格', () => {
    const hints = extractEnvironmentHints(STATE, 8 * 60 + 30, []);
    expect(hints).toContain('背包没有鱼竿');
    expect(hints).toContain('list_chests');
    expect(hints).toContain('09:00 才开门');
    expect(hints).toContain('背包只剩 2 个空位');
  });

  it('17:00 后提醒打烊；10:00 营业时间不提醒', () => {
    expect(extractEnvironmentHints(STATE, 18 * 60, [])).toContain('17:00 已打烊');
    expect(extractEnvironmentHints(STATE, 10 * 60, [])).not.toContain('打烊');
    expect(extractEnvironmentHints(STATE, 10 * 60, [])).not.toContain('才开门');
  });

  it('背包有鱼竿不提醒；状态省略背包段时绝不断言「没有鱼竿」', () => {
    expect(extractEnvironmentHints(STATE.replace('木材 x22', '竹鱼竿（手持）'), 10 * 60, [])).not.toContain('没有鱼竿');
    const noBackpack = '时间：第1年春16日 10:00\n## 位置\n地点：Farm';
    expect(extractEnvironmentHints(noBackpack, 10 * 60, [])).not.toContain('没有鱼竿');
    expect(extractEnvironmentHints(noBackpack, 10 * 60, [])).not.toContain('空位');
  });

  it('空位 3 格不告警；0 格告警', () => {
    expect(extractEnvironmentHints(STATE.replace('背包空位：2', '背包空位：3'), 10 * 60, [])).not.toContain('空位');
    expect(extractEnvironmentHints(STATE.replace('背包空位：2', '背包空位：0'), 10 * 60, [])).toContain('只剩 0 个空位');
  });

  it('取最后一条 list_chests 成功回执摘要（COMPLETED/OK 两种前缀）', () => {
    const receipts = [
      'COMPLETED list_chests: 旧箱子：石头 x9',
      'FAILED list_chests: 附近没有箱子',
      'COMPLETED list_chests: Farm 箱子1：鱼竿 x1、木材 x50',
    ];
    const hints = extractEnvironmentHints(STATE, 10 * 60, receipts);
    expect(hints).toContain('Farm 箱子1：鱼竿 x1、木材 x50');
    expect(hints).not.toContain('旧箱子');
    expect(extractEnvironmentHints(STATE, 10 * 60, ['OK list_chests: 箱子A：蟹笼 x2'])).toContain('箱子A：蟹笼 x2');
    expect(extractEnvironmentHints(STATE, 10 * 60, ['COMPLETED buy: 买了种子'])).not.toContain('刚查到的箱子');
    // 成功前缀但摘要为空 → 跳过，不生成空箱子提示
    expect(extractEnvironmentHints(STATE, 10 * 60, ['COMPLETED list_chests:   '])).not.toContain('刚查到的箱子');
  });

  it('总长 ≤240 字（注入预算硬上限）', () => {
    const huge = `${STATE}\n${'COMPLETED list_chests: ' + '箱子：' + '物品'.repeat(200)}`;
    const hints = extractEnvironmentHints(huge, 18 * 60, [huge.split('\n').pop() ?? '']);
    expect(hints.length).toBeLessThanOrEqual(240);
  });

  it('空状态/无回执返回空串（不编造）', () => {
    expect(extractEnvironmentHints('', Number.NaN, [])).toBe('');
  });
});

describe('T-M6-69 规则日程解析器', () => {
  const BAG = `## 背包（序号: 物品）
0: 斧头（手持）
1: 竹鱼竿
2: 防风草种子 x15
3: 辣椒种子 [种子] x4
4: 古代种子【留着：博物馆】
5: 木材 x22
背包空位：19 个（共 24 格）`;

  it('parseSeedInventory：只取种子堆（含 [种子] 标记），跳过【留着】与数量 0', () => {
    expect(parseSeedInventory(BAG)).toEqual([
      { name: '防风草种子', count: 15 },
      { name: '辣椒种子', count: 4 },
    ]);
    expect(parseSeedInventory(BAG.replace('x15', 'x0'))).toEqual([{ name: '辣椒种子', count: 4 }]);
    // 没有背包段 → 空数组（未知，不当「没有种子」）
    expect(parseSeedInventory('## 位置\n地点：Farm')).toEqual([]);
  });

  it('parseFarmSummary：真机「农场概况 + 农田」格式', () => {
    const raw = `## 作物（本地点全部）
（农场概况：共 30 株作物，需浇水 24，可收获 6）
农田：共 60 格耕地：作物 30，长成的野菜 0 个（蒲公英 0），空 30`;
    expect(parseFarmSummary(raw)).toEqual({ cropCount: 30, needsWater: 24, harvestable: 6, emptyTilled: 30 });
  });

  it('parseFarmSummary：站在农场时的明细格式（2026-11-25 真机浸泡发现）', () => {
    // 真机原文：住农场时没有「（农场概况：…）」总览行，只有明细
    const raw = `## 作物（本地点全部）
需要浇水 2 株：(48,19) (45,19)
生长中：辣椒 x2（最快约 5 天后成熟）
农田：还没有成片的田；零散耕地 2 格（其中 2 株作物，收完别再往这里种）`;
    expect(parseFarmSummary(raw)).toEqual({ cropCount: null, needsWater: 2, harvestable: null, emptyTilled: 0 });
    // 零散耕地有空位（2 格、其中 1 株作物）→ 空地 1
    expect(parseFarmSummary(raw.replace('（其中 2 株作物', '（其中 1 株作物')))
      .toMatchObject({ emptyTilled: 1 });
    // 可收获明细行
    expect(parseFarmSummary('可收获 3 株：(10,4) (11,4) (12,4)')).toMatchObject({ harvestable: 3 });
    // 「（可收获）」图例没数字，不能被当成 0 株
    expect(parseFarmSummary('（可收获）interact 或 harvest_crops')).toMatchObject({ harvestable: null });
  });

  it('parseFarmSummary：旧剧本措辞兼容；没有农田段 → 空地 null（不猜）', () => {
    const legacy = '剩 3 株没浇\n有 2 株成熟的作物';
    expect(parseFarmSummary(legacy)).toMatchObject({ needsWater: 3, harvestable: 2, emptyTilled: null });
    expect(parseFarmSummary('空耕地：7 格')).toMatchObject({ emptyTilled: 7 });
    expect(parseFarmSummary('')).toEqual({ cropCount: null, needsWater: null, harvestable: null, emptyTilled: null });
  });

  it('hasToolInBag：水壶/锄头识别，没有背包段返回 null（未知）', () => {
    expect(hasToolInBag(BAG, /水壶|Watering ?Can/i)).toBe(false);
    expect(hasToolInBag(`${BAG}\n6: 水壶（手持）`, /水壶/)).toBe(true);
    expect(hasToolInBag(`${BAG}\n7: 锄头（手持）`, /锄头|Hoe/i)).toBe(true);
    expect(hasToolInBag('## 位置\n地点：Farm', /水壶/)).toBeNull();
  });

  it('parseWeekday：英文/中文星期都能识别；没有则 null', () => {
    expect(parseWeekday('时间：第1年春16日 07:30（Tue），天气：晴')).toBe(2);
    expect(parseWeekday('时间：第1年夏1日 07:30（周三）')).toBe(3);
    expect(parseWeekday('时间：第1年夏1日 07:30（Sun）')).toBe(7);
    expect(parseWeekday('时间：第1年夏1日 07:30')).toBeNull();
    expect(parseWeekday('')).toBeNull();
  });

  it('seedShopStatus：9:00–17:00 营业，周三/节日下午不营业', () => {
    expect(seedShopStatus(10 * 60, 2, null)).toEqual({ open: true, reason: 'open' });
    expect(seedShopStatus(8 * 60 + 59, 2, null)).toEqual({ open: false, reason: 'before-hours' });
    expect(seedShopStatus(17 * 60, 2, null)).toEqual({ open: false, reason: 'after-hours' });
    expect(seedShopStatus(10 * 60, 3, null)).toEqual({ open: false, reason: 'wednesday' });
    expect(seedShopStatus(10 * 60, 2, '复活节')).toEqual({ open: false, reason: 'festival' });
    // 状态没报星期 → 只按时间判断，不臆断周三
    expect(seedShopStatus(10 * 60, null, null)).toEqual({ open: true, reason: 'open' });
    expect(seedShopStatus(Number.NaN, 2, null)).toEqual({ open: false, reason: 'before-hours' });
  });

  it('在 FarmHouse 室内且有农活/种子时给出 travel_to(Farm) 与礼物箱坐标提示', () => {
    const house = '时间：第1年春1日 06:00（Mon）\n## 位置\n地点：FarmHouse（鲸屿农场）\n附近物件：- 礼物箱（里面有：防风草种子x15） [interact 打开]：(3,7)\n## 背包\n1: 防风草种子 x15';
    const hints = extractEnvironmentHints(house, 6 * 60, []);
    expect(hints).toContain('travel_to({"location":"Farm"})');
    expect(hints).toContain('interact({"x":3,"y":7})');
    const emptyFarm = '时间：第1年春1日 06:10（Mon）\n## 位置\n地点：Farm\n## 背包\n1: 防风草种子 x15';
    expect(extractEnvironmentHints(emptyFarm, 6 * 60 + 10, [])).toContain('x1,y1,x2,y2');
    expect(extractEnvironmentHints('时间：第1年春1日 06:00（Mon）\n## 位置\n地点：Farm', 6 * 60, [])).not.toContain('在屋里');
  });

  it('白天低体力不再建议 sleep（真机 2026-11-28 秋8 06:50 睡掉整白天）', () => {
    const daytimeLowStamina = `时间：第1年秋8日 06:50（Mon）
金钱：1125g  体力：20/270  生命：120/120
## 位置
地点：Farm
## 背包（序号: 物品）
0: 斧头（手持）
1: 木材 x30
背包空位：5 个（共 12 格）`;
    const day = extractEnvironmentHints(daytimeLowStamina, 6 * 60 + 50, []);
    expect(day).toContain('别调 eat');
    expect(day).toContain('白天');
    expect(day).toContain('sleep 会把整天睡掉');
    expect(day).not.toContain('或 sleep({"force":true})');
    // 白天通用提示：sleep 会跳过整天
    expect(day).toContain('sleep 会跳过整天');

    // 深夜体力低 + 无食物：允许收工睡觉
    const nightLowStamina = daytimeLowStamina.replace('第1年秋8日 06:50', '第1年秋8日 23:30');
    const night = extractEnvironmentHints(nightLowStamina, 23 * 60 + 30, []);
    expect(night).toContain('sleep({"force":true})');
  });

  it('限时门槛（几点出门）给 wait 方案而不是只说改日再来（真机 2026-11-28 秋9）', () => {
    const stateRaw = '时间：第1年秋9日 09:00（Wed）\n## 位置\n地点：Forest';
    const timed = [
      'FAILED move_to: 失败：找不到通往(13,7)的路（要穿过玛妮的房门，得先和玛妮有 2 心好感才能进。玛妮按今天的日程 10:00 出门去皮埃尔的杂货店（SeedShop），到时候再找（wait 可以写 until=10:00））',
    ];
    const hints = extractEnvironmentHints(stateRaw, 9 * 60, timed);
    expect(hints).toContain('这扇门是限时的');
    expect(hints).toContain('10:00');
    expect(hints).toContain('wait');
    // 限时门槛不该退化成「改日再来」
    expect(hints).not.toContain('改日再来');
  });

  it('反复撞同一扇好感门时点名门槛（真机 2026-11-28 秋9 玛妮卧室）', () => {
    const stateRaw = '时间：第1年秋9日 09:10（Wed）\n## 位置\n地点：Forest';
    const receipts = [
      'FAILED interact: 失败：移动被打断：有界面打开了（DialogueBox），请先处理界面。当前界面：\n对话框：只有玛妮的好朋友才能进入她的卧室。\n（用 dialogue 不带参数继续/关闭对话）',
      'COMPLETED dialogue: 成功：对话已推进。当前界面：无（可以自由行动）',
      'FAILED move_to: 失败：移动被打断：有界面打开了（DialogueBox），请先处理界面。当前界面：',
    ];
    const hints = extractEnvironmentHints(stateRaw, 9 * 60 + 10, receipts);
    expect(hints).toContain('好感/剧情/时间门槛');
    expect(hints).toContain('玛妮');

    // 普通对话打断（不是拒绝对话）给的是核对界面，不是门槛结论
    const plain = [
      'FAILED interact: 失败：移动被打断：有界面打开了（DialogueBox），请先处理界面。当前界面：\n对话框：你好呀。',
    ];
    const plainHints = extractEnvironmentHints(stateRaw, 9 * 60 + 10, plain);
    expect(plainHints).toContain('先 get_state 确认真实界面');
    expect(plainHints).not.toContain('好感/剧情/时间门槛');
  });

  it('当季作物收益事实进入环境提示；季末来不及成熟时不给数字', () => {
    const autumnEarly = '时间：第1年秋2日 08:00（Tue）\n## 位置\n地点：Farm';
    const h = extractEnvironmentHints(autumnEarly, 8 * 60, []);
    expect(h).toContain('当季作物收益');
    expect(h).toContain('小白菜种子');
    expect(h).toContain('g/天');

    // 秋 27 日：剩 2 天，来不及成熟 → 不给收益数字
    const autumnLate = '时间：第1年秋27日 08:00（Tue）\n## 位置\n地点：Farm';
    expect(extractEnvironmentHints(autumnLate, 8 * 60, [])).not.toContain('当季作物收益');

    // 冬季：表内无作物 → 不给
    const winter = '时间：第1年冬5日 08:00（Tue）\n## 位置\n地点：Farm';
    expect(extractEnvironmentHints(winter, 8 * 60, [])).not.toContain('当季作物收益');
  });

  it('同一地点来回折返时陈述往返事实（真机 2026-11-28 秋8）', () => {
    const stateRaw = '时间：第1年秋8日 10:00（Tue）\n## 位置\n地点：Town';
    const receipts = [
      'COMPLETED travel_to: 成功：已到达 Farm',
      'COMPLETED travel_to: 成功：已到达 Town',
      'COMPLETED travel_to: 成功：已到达 Farm',
    ];
    const hints = extractEnvironmentHints(stateRaw, 10 * 60, receipts);
    expect(hints).toContain('Farm → Town → Farm');
    expect(hints).toContain('折返');
    // 单次单向移动不该提示
    const oneWay = extractEnvironmentHints(stateRaw, 10 * 60, ['COMPLETED travel_to: 成功：已到达 Farm']);
    expect(oneWay).not.toContain('折返');
  });

  it('无箱且木材不足50时阻止 tidy_backpack/craft(Chest)；低体力真实区分有无[可食用]食物与未读邮件', () => {
    const farmNoChestLowWood = `时间：第1年春1日 08:20（Mon）
金钱：500g  体力：30/270  生命：100/100
邮箱里有 2 封未读信件：邮箱在 Farm 的 (68,16)
## 位置
地点：Farm
## 背包（序号: 物品）
0: 斧头（手持）
1: 木材 x18
背包空位：2 个（共 12 格）
## 箱子（所有地点）
无`;
    const h1 = extractEnvironmentHints(farmNoChestLowWood, 8 * 60 + 20, []);
    expect(h1).toContain('read_mail');
    expect(h1).toContain('别调 eat');
    expect(h1).toContain('木材 18/50');
    expect(h1).toContain('别调 tidy_backpack');

    const withEdible = farmNoChestLowWood.replace('1: 木材 x18', '1: 木材 x55\n2: 韭葱 [可食用 +40 体力] x1');
    const h2 = extractEnvironmentHints(withEdible, 8 * 60 + 20, []);
    expect(h2).toContain('eat({"item":"韭葱"})');
    expect(h2).toContain('木材已有 55/50');

    const wateredFarm = '时间：第1年春1日 08:10（Mon）\n## 位置\n地点：Farm\n## 作物（本地点全部）\n生长中：防风草 x15（最快约 4 天后成熟）\n农田：共 15 格耕地：作物 15，空 0';
    expect(extractEnvironmentHints(wateredFarm, 8 * 60 + 10, [])).toContain('0 株待浇水');
    const summaryWatered = '时间：第1年春1日 08:10（Mon）\n## 位置\n地点：Farm\n## 作物\n（农场概况：共 15 株作物，需浇水 0，可收获 0）';
    expect(extractEnvironmentHints(summaryWatered, 8 * 60 + 10, [])).toContain('0 株待浇水');
    const unwateredFarm = '时间：第1年春1日 08:10（Mon）\n## 位置\n地点：Farm\n## 作物（本地点全部）\n需要浇水 3 株：(62,18)\n生长中：防风草 x15（最快约 4 天后成熟）';
    expect(extractEnvironmentHints(unwateredFarm, 8 * 60 + 10, [])).not.toContain('0 株待浇水');
  });

  it('跨季/深夜/节日/升级职业/起名与低血线提示准确不误报', () => {
    const midnight = '时间：第1年夏1日 00:40（Mon）\n生命：20/100\n## 位置\n地点：Farm\n枯死作物 9 株（可用镰刀清除）：(62,18)';
    const hMidnight = extractEnvironmentHints(midnight, 40, []);
    expect(hMidnight).toContain('立刻 sleep');
    expect(hMidnight).not.toContain('09:00 才开门');
    expect(hMidnight).toContain('枯死作物');
    expect(hMidnight).toContain('生命仅 20/100');

    const fest = '时间：第1年春13日 09:00\n你正在节日里：时间不走，普通工具不能用';
    expect(extractEnvironmentHints(fest, 9 * 60, [])).toContain('festival');

    const prof = '升级了，需要选择职业（用 choose_profession，left 或 right）';
    expect(extractEnvironmentHints(prof, 6 * 60, [])).toContain('choose_profession');

    const naming = '要起名字：用 set_name 传一个名字';
    expect(extractEnvironmentHints(naming, 6 * 60, [])).toContain('set_name');

    const day28 = '时间：第1年春28日 07:00（Sun）\n## 位置\n地点：Town';
    expect(extractEnvironmentHints(day28, 7 * 60, [])).toContain('季末第28天');

    const wed = '时间：第1年春3日 09:30（Wed）\n## 位置\n地点：Farm';
    expect(extractEnvironmentHints(wed, 9 * 60 + 30, [])).toContain('JojaMart');

    const guildLocked = extractEnvironmentHints('时间：第1年夏2日 14:00\n## 位置\n地点：Mountain', 14 * 60, [
      'FAILED travel_to: 门锁着进不去 AdventureGuild：信件提示「仅限货真价实的冒险者」',
    ]);
    expect(guildLocked).toContain('勿再进 AdventureGuild');
    expect(guildLocked.length).toBeLessThanOrEqual(240);

    const missingCan = extractEnvironmentHints(
      '时间：第1年夏2日 07:00\n## 位置\n地点：Farm\n需要浇水 4 株：(62,18)\n## 背包\n0: 十字镐（手持）',
      7 * 60,
      ['FAILED water_crops: 没有水壶'],
    );
    expect(missingCan).toContain('喷壶');
    expect(missingCan.length).toBeLessThanOrEqual(240);

    const missingPick = extractEnvironmentHints(
      '时间：第1年夏2日 11:00\n## 位置\n地点：Mine\n## 背包\n0: 喷壶（手持）',
      11 * 60,
      ['FAILED explore_mine: 没有镐子'],
    );
    expect(missingPick).toContain('十字镐');

    const shipInteract = extractEnvironmentHints('时间：第1年夏2日 18:00\n## 位置\n地点：Farm', 18 * 60, [
      'COMPLETED interact: 这是出货箱，交互没有反应',
    ]);
    expect(shipInteract).toContain('ship_items');

    const stuckMine = extractEnvironmentHints('时间：第1年夏17日 08:10\n## 位置\n地点：UndergroundMine21', 8 * 60 + 10, [
      'FAILED explore_mine: 这一层找不到楼梯，也没有能走到的石头了',
    ]);
    expect(stuckMine).toContain('travel_to({"location":"Mine"})');

    const unreachable = extractEnvironmentHints('时间：第1年夏6日 14:00\n## 位置\n地点：AnimalShop', 14 * 60, [
      'FAILED interact: 走不到(13,7) 旁边',
    ]);
    expect(unreachable).toContain('立刻换目标');

    const lowHpReservedOnly = extractEnvironmentHints(
      '时间：第1年夏18日 15:40\n生命：43/115\n## 位置\n地点：UndergroundMine25\n## 背包\n0: 葡萄 【留着】[可食用 +15]',
      15 * 60 + 40,
      ['FAILED fight: 生命只剩 43/115'],
    );
    expect(lowHpReservedOnly).toContain('别 eat/fight');
    expect(lowHpReservedOnly.length).toBeLessThanOrEqual(240);

    const bagFullMine = extractEnvironmentHints(
      '时间：第1年夏21日 14:30\n## 位置\n地点：UndergroundMine31',
      14 * 60 + 30,
      ['FAILED explore_mine: 停下原因：背包满了，地上的 紫水晶 捡不起来'],
    );
    expect(bagFullMine).toContain('tidy_backpack');

    const lateOutdoor = extractEnvironmentHints('时间：第1年夏22日 23:10\n## 位置\n地点：Town', 23 * 60 + 10, []);
    expect(lateOutdoor).toContain('避免 02:00 晕倒');

    const boulderLoop = extractEnvironmentHints('时间：第1年夏22日 14:10\n## 位置\n地点：Mine', 14 * 60 + 10, [
      'COMPLETED use_tool: 对 (27,8) 使用 十字镐 1 次，目标从“圆石”变为“圆石”',
      'FAILED interact: 当前界面： 对话框：你的十字镐不够坚硬，无法敲开它。',
    ]);
    expect(boulderLoop).toContain('大圆石');
  });
});
