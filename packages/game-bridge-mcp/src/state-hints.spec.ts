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
});
