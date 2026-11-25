/** 规则日程状态机（T-M6-69）：每条优先级分支 + 生存护栏 + 商店营业/雨天/午夜等边界。 */
import { describe, expect, it } from 'vitest';
import {
  buySeedsIntent,
  dayMinutesOf,
  DEFAULT_BEDTIME_MINUTES,
  DEFAULT_TILL_MAX,
  inProgressGuard,
  MIDNIGHT_MINUTES,
  scheduleDecision,
  scheduleIsRaining,
  shopBuyDecision,
  STAMINA_GO_HOME_RATIO,
  STAMINA_SLEEP_RATIO,
  survivalDecision,
  type ScheduleContext,
  type ScheduleFacts,
  type ScheduleState,
  type ScheduleStep,
} from './rule-schedule';

function state(over: Partial<ScheduleState> = {}): ScheduleState {
  return {
    raw: '',
    clockMinutes: 8 * 60,
    stamina: 270,
    staminaMax: 270,
    health: 100,
    healthMax: 100,
    money: 640,
    location: 'Farm',
    menu: '',
    season: '春',
    day: 16,
    weather: '晴',
    freeSlots: 12,
    posX: 64,
    posY: 15,
    ...over,
  };
}

function facts(over: Partial<ScheduleFacts> = {}): ScheduleFacts {
  return {
    unreadMail: 0,
    cropCount: null,
    needsWater: null,
    harvestable: null,
    emptyTilled: null,
    seeds: [],
    hasRod: true,
    hasWateringCan: true,
    hasHoe: true,
    weekday: 2,
    shopOpen: true,
    festival: null,
    ...over,
  };
}

function context(
  stateOver: Partial<ScheduleState> = {},
  factsOver: Partial<ScheduleFacts> = {},
  extra: Partial<Pick<ScheduleContext, 'avoidTools' | 'done' | 'shippable' | 'edible'>> = {},
): ScheduleContext {
  return {
    state: state(stateOver),
    facts: facts(factsOver),
    avoidTools: new Set<string>(),
    done: new Set<ScheduleStep>(),
    shippable: null,
    edible: null,
    ...extra,
  };
}

describe('时间口径', () => {
  it('dayMinutesOf：06:00 起算，凌晨记为 24:00+', () => {
    expect(dayMinutesOf(6 * 60)).toBe(360);
    expect(dayMinutesOf(5 * 60 + 59)).toBe(5 * 60 + 59 + 24 * 60);
    expect(dayMinutesOf(30)).toBe(24 * 60 + 30);
    expect(dayMinutesOf(Number.NaN)).toBe(0);
    expect(MIDNIGHT_MINUTES).toBe(24 * 60);
    expect(DEFAULT_BEDTIME_MINUTES).toBe(22 * 60);
    expect(DEFAULT_TILL_MAX).toBe(15);
  });

  it('雨天/雪天跳过浇水', () => {
    expect(scheduleIsRaining({ weather: '下雨' })).toBe(true);
    expect(scheduleIsRaining({ weather: '雪' })).toBe(true);
    expect(scheduleIsRaining({ weather: '晴' })).toBe(false);
    expect(scheduleIsRaining({ weather: '刮风' })).toBe(false);
  });
});

describe('survivalDecision 生存护栏', () => {
  it('体力 <8% → 原地 sleep（农舍/野外都一样）', () => {
    expect(STAMINA_SLEEP_RATIO).toBe(0.08);
    const d = survivalDecision(state({ stamina: 20, location: 'Beach' }), null);
    expect(d).toMatchObject({ kind: 'act', tool: 'sleep' });
  });

  it('体力 8%–15% → 回家；在农舍直接睡', () => {
    expect(STAMINA_GO_HOME_RATIO).toBe(0.15);
    expect(survivalDecision(state({ stamina: 30, location: 'Farm' }), null)).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' },
    });
    expect(survivalDecision(state({ stamina: 30, location: 'FarmHouse' }), null)).toMatchObject({
      kind: 'act', tool: 'sleep',
    });
  });

  it('≥24:00 强制回家睡（优先级高于一切日程）', () => {
    expect(survivalDecision(state({ clockMinutes: 30, location: 'Beach' }), null)).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' },
    });
    expect(survivalDecision(state({ clockMinutes: 30, location: 'FarmHouse' }), null)).toMatchObject({
      kind: 'act', tool: 'sleep',
    });
    // 23:30 还没到强制线：正常日程（体力充足时返回 null）
    expect(survivalDecision(state({ clockMinutes: 23 * 60 + 30 }), null)).toBeNull();
  });

  it('生命 <30%：有吃的先吃，没吃的回家/睡觉', () => {
    expect(survivalDecision(state({ health: 20 }), '香蒲')).toMatchObject({ kind: 'act', tool: 'eat', args: { item: '香蒲' } });
    expect(survivalDecision(state({ health: 20, location: 'Beach' }), null)).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' },
    });
    expect(survivalDecision(state({ health: 20, location: 'FarmHouse' }), null)).toMatchObject({ kind: 'act', tool: 'sleep' });
  });

  it('一切正常 → null；体力/生命上限为 0 时不误报', () => {
    expect(survivalDecision(state(), null)).toBeNull();
    expect(survivalDecision(state({ staminaMax: 0, stamina: 0, healthMax: 0, health: 0 }), null)).toBeNull();
  });
});

describe('scheduleDecision 日程优先级', () => {
  it('① 未读信 → read_mail（任何地点）', () => {
    const d = scheduleDecision(context({ location: 'Beach' }, { unreadMail: 3 }));
    expect(d).toMatchObject({ kind: 'act', tool: 'read_mail' });
    expect(d?.kind === 'act' ? d.intent : '').toContain('3 封未读');
  });

  it('② 在农舍 → 先去农场看作物（收工前任何时刻都补这一次，T-M6-70 中途接手）', () => {
    expect(scheduleDecision(context({ location: 'FarmHouse', clockMinutes: 8 * 60 }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'Farm' },
    });
    // 中午/下午被 LLM 交回驾驶权：同样先去农场，才能续上当天的浇水/收获
    expect(scheduleDecision(context({ location: 'FarmHouse', clockMinutes: 14 * 60 }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'Farm' },
    });
    // 到收工时间就不再绕路，直接回家睡觉
    expect(scheduleDecision(context({ location: 'FarmHouse', clockMinutes: 22 * 60 + 10 }))).toMatchObject({
      kind: 'act', tool: 'sleep',
    });
    expect(scheduleDecision(context({ location: 'Farm' }))).not.toMatchObject({ tool: 'travel_to', args: { location: 'Farm' } });
    // 今天已经看过（done 里有 visit）→ 不再来回跑
    expect(scheduleDecision(context({ location: 'FarmHouse' }, {}, { done: new Set<ScheduleStep>(['visit']) })))
      .not.toMatchObject({ tool: 'travel_to', args: { location: 'Farm' } });
  });

  it('③ 需要浇水 → water_crops；不在农场先回去；雨天跳过', () => {
    expect(scheduleDecision(context({ location: 'Farm' }, { needsWater: 3 }))).toMatchObject({
      kind: 'act', tool: 'water_crops',
    });
    expect(scheduleDecision(context({ location: 'Beach' }, { needsWater: 3 }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'Farm' },
    });
    // 雨天：不浇水，直接进入填充（去海滩钓鱼）
    const rainy = scheduleDecision(context({ location: 'Farm', weather: '下雨' }, { needsWater: 3 }));
    expect(rainy).toMatchObject({ kind: 'act', tool: 'travel_to', args: { location: 'Beach' } });
    // water_crops 被避开 → 也不浇
    const avoided = scheduleDecision(context({ location: 'Farm' }, { needsWater: 3 }, { avoidTools: new Set(['water_crops']) }));
    expect(avoided).not.toMatchObject({ tool: 'water_crops' });
  });

  it('③b 工具前置：背包没有喷壶 → 先从箱子 take_items，取过就跳过浇水；没有锄头不开垦', () => {
    const noCan = scheduleDecision(context({ location: 'Farm' }, { needsWater: 2, hasWateringCan: false }));
    // 物品名必须用游戏内叫法「喷壶」（2026-11-25 真机：说「水壶」会被 BWF 判箱子里没有）
    expect(noCan).toMatchObject({ kind: 'act', tool: 'take_items', args: { item: '喷壶' } });
    // 取过了（done=tool）仍没有喷壶 → 不再反复取，也不硬浇，继续当天其它日程
    const afterFetch = scheduleDecision(context({ location: 'Farm' }, { needsWater: 2, hasWateringCan: false },
      { done: new Set<ScheduleStep>(['tool']) }));
    expect(afterFetch).not.toMatchObject({ tool: 'water_crops' });
    expect(afterFetch).not.toMatchObject({ tool: 'take_items' });
    // 状态没背包段（未知）→ 照常浇水，不误判为没水壶
    expect(scheduleDecision(context({ location: 'Farm' }, { needsWater: 2, hasWateringCan: null })))
      .toMatchObject({ kind: 'act', tool: 'water_crops' });
    // 没有锄头 → 不开垦
    expect(scheduleDecision(context({ location: 'Farm' }, { emptyTilled: 0, hasHoe: false })))
      .not.toMatchObject({ tool: 'till_area' });
  });

  it('④ 有成熟作物 → harvest_crops（不在农场先回去）', () => {
    expect(scheduleDecision(context({ location: 'Farm' }, { harvestable: 2 }))).toMatchObject({
      kind: 'act', tool: 'harvest_crops',
    });
    expect(scheduleDecision(context({ location: 'Town' }, { harvestable: 2 }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'Farm' },
    });
  });

  it('⑤ 背包有可卖物 → ship_items（优先于买种/播种）', () => {
    expect(scheduleDecision(context({}, { emptyTilled: 5, seeds: [{ name: '防风草种子', count: 5 }] }, { shippable: '鲈鱼' })))
      .toMatchObject({ kind: 'act', tool: 'ship_items', args: { item: '鲈鱼' } });
  });

  it('⑥ 购种：营业中 + 季末能熟 + 空地 + 预算 → 去皮埃尔；在店先 open_shop；界面已开直接 buy', () => {
    const buy = scheduleDecision(context({ location: 'Farm' }, { emptyTilled: 5, shopOpen: true }));
    expect(buy).toMatchObject({ kind: 'act', tool: 'travel_to', args: { location: 'SeedShop' } });

    const atShop = scheduleDecision(context({ location: 'SeedShop' }, { emptyTilled: 5, shopOpen: true }));
    expect(atShop).toMatchObject({ kind: 'act', tool: 'open_shop' });

    const inShop = scheduleDecision(context({ location: 'SeedShop', menu: '商店界面（Shop）' }, { emptyTilled: 5, shopOpen: true }));
    expect(inShop).toMatchObject({ kind: 'act', tool: 'buy', args: { item: '防风草种子', count: 5 } });

    // 周三 / 17:00 后：商店没开 → 绝不白跑（shopOpen=false）
    for (const weekday of [null, 3]) {
      const closed = scheduleDecision(context({ location: 'Farm', clockMinutes: 18 * 60 }, { emptyTilled: 5, shopOpen: false, weekday }));
      expect(closed).not.toMatchObject({ tool: 'travel_to', args: { location: 'SeedShop' } });
      expect(closed).not.toMatchObject({ tool: 'buy' });
    }
  });

  it('buySeedsIntent 前置检查：季末熟不了 / 没空地 / 种子够了 / 未知空地 / 钱不够 → null', () => {
    expect(buySeedsIntent(context({}, { emptyTilled: 5 }))).not.toBeNull();
    expect(buySeedsIntent(context({ day: 26 }, { emptyTilled: 5 }))).toBeNull(); // 剩 3 天 < 4
    expect(buySeedsIntent(context({ season: '冬' }, { emptyTilled: 5 }))).toBeNull();
    expect(buySeedsIntent(context({}, { emptyTilled: 0 }))).toBeNull();
    expect(buySeedsIntent(context({}, { emptyTilled: null }))).toBeNull();
    expect(buySeedsIntent(context({}, { emptyTilled: 3, seeds: [{ name: '防风草种子', count: 3 }] }))).toBeNull();
    expect(buySeedsIntent(context({ money: 110 }, { emptyTilled: 5 }))).toBeNull();
    expect(buySeedsIntent(context({}, { emptyTilled: 5, shopOpen: false }))).toBeNull();
    // 已有 2 份种子、5 格空地 → 再买 3 份
    expect(buySeedsIntent(context({}, { emptyTilled: 5, seeds: [{ name: '防风草种子', count: 2 }] })))
      .toMatchObject({ count: 3 });
  });

  it('购种已做过 / open_shop 被避开 → 不再折腾商店', () => {
    expect(scheduleDecision(context({ location: 'Farm' }, { emptyTilled: 5 }, { done: new Set<ScheduleStep>(['buy']) })))
      .not.toMatchObject({ tool: 'travel_to', args: { location: 'SeedShop' } });
    expect(scheduleDecision(context({ location: 'SeedShop' }, { emptyTilled: 5 }, { avoidTools: new Set(['open_shop']) })))
      .not.toMatchObject({ tool: 'open_shop' });
  });

  it('shopBuyDecision：我们主动开的商店界面先买；界面不是商店 / 无购种需求 → null', () => {
    expect(shopBuyDecision(context({ menu: '商店界面（Shop）' }, { emptyTilled: 5 }))).toMatchObject({
      kind: 'act', tool: 'buy',
    });
    expect(shopBuyDecision(context({ menu: '无（可以自由行动）' }, { emptyTilled: 5 }))).toBeNull();
    expect(shopBuyDecision(context({ menu: '商店界面（Shop）' }, { emptyTilled: 0 }))).toBeNull();
    expect(shopBuyDecision(context({ menu: '商店界面（Shop）' }, { emptyTilled: 5 }, { avoidTools: new Set(['buy']) }))).toBeNull();
  });

  it('⑦ 播种：有种子 + 有已开垦空地 → plant_seeds（数量 = min(种子, 空地)）；不在农场先回去', () => {
    expect(scheduleDecision(context({ location: 'Farm' }, { emptyTilled: 4, seeds: [{ name: '防风草种子', count: 10 }] })))
      .toMatchObject({ kind: 'act', tool: 'plant_seeds', args: { seed: '防风草种子', max: 4 } });
    expect(scheduleDecision(context({ location: 'Beach' }, { emptyTilled: 4, seeds: [{ name: '防风草种子', count: 10 }] })))
      .toMatchObject({ kind: 'act', tool: 'travel_to', args: { location: 'Farm' } });
    // 没种子 / 季末熟不了 → 不种
    expect(scheduleDecision(context({}, { emptyTilled: 4, seeds: [] }))).not.toMatchObject({ tool: 'plant_seeds' });
    expect(scheduleDecision(context({ day: 26 }, { emptyTilled: 4, seeds: [{ name: '防风草种子', count: 10 }] })))
      .not.toMatchObject({ tool: 'plant_seeds' });
  });

  it('⑧ 开垦：只有「明确没有已开垦空地」+ 体力 >40% + 没种子 + 买得起才开垦（有上限）', () => {
    const till = scheduleDecision(context({ location: 'Farm' }, { emptyTilled: 0 }));
    expect(till).toMatchObject({ kind: 'act', tool: 'till_area', args: { count: DEFAULT_TILL_MAX } });
    expect(scheduleDecision(context({ location: 'Farm' }, { emptyTilled: 0 }), { tillMax: 8 }))
      .toMatchObject({ kind: 'act', tool: 'till_area', args: { count: 8 } });
    // 体力 ≤40% 不动手
    expect(scheduleDecision(context({ stamina: 100 }, { emptyTilled: 0 }))).not.toMatchObject({ tool: 'till_area' });
    // 还有种子没种完 / 空地未知 / 还有空地 / 钱不够买一颗种子 → 不开垦
    expect(scheduleDecision(context({}, { emptyTilled: 0, seeds: [{ name: '防风草种子', count: 2 }] })))
      .not.toMatchObject({ tool: 'till_area' });
    expect(scheduleDecision(context({}, { emptyTilled: null }))).not.toMatchObject({ tool: 'till_area' });
    expect(scheduleDecision(context({}, { emptyTilled: 3 }))).not.toMatchObject({ tool: 'till_area' });
    expect(scheduleDecision(context({ money: 110 }, { emptyTilled: 0 }))).not.toMatchObject({ tool: 'till_area' });
    // 冬季没有当季种子 → 不为了「以后」白开垦
    expect(scheduleDecision(context({ season: '冬' }, { emptyTilled: 0 }))).not.toMatchObject({ tool: 'till_area' });
  });

  it('⑨ 收工：22:00 回家/睡觉；可配置 bedtime', () => {
    expect(scheduleDecision(context({ location: 'Beach', clockMinutes: 22 * 60 + 10 }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' },
    });
    expect(scheduleDecision(context({ location: 'FarmHouse', clockMinutes: 22 * 60 + 10 }))).toMatchObject({
      kind: 'act', tool: 'sleep',
    });
    expect(scheduleDecision(context({ location: 'FarmHouse', clockMinutes: 18 * 60 + 10 }), { bedtimeMinutes: 18 * 60 }))
      .toMatchObject({ kind: 'act', tool: 'sleep' });
    // 未到收工时间 → 继续填充
    expect(scheduleDecision(context({ location: 'Farm', clockMinutes: 21 * 60 }))).toMatchObject({ kind: 'act', tool: 'travel_to' });
  });

  it('⑩ 填充：有鱼竿去海滩 fish；明确没鱼竿去镇上 forage；都不可行 → wait 求助', () => {
    expect(scheduleDecision(context({ location: 'Farm' }, { hasRod: true }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'Beach' },
    });
    expect(scheduleDecision(context({ location: 'Beach' }, { hasRod: true }))).toMatchObject({
      kind: 'act', tool: 'fish', args: { casts: 5 },
    });
    expect(scheduleDecision(context({ location: 'Farm' }, { hasRod: false }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'Town' },
    });
    expect(scheduleDecision(context({ location: 'Town' }, { hasRod: false }))).toMatchObject({ kind: 'act', tool: 'forage' });
    // 背包满 → 不钓鱼，转采集
    expect(scheduleDecision(context({ location: 'Beach', freeSlots: 0 }, { hasRod: true }))).toMatchObject({
      kind: 'act', tool: 'travel_to', args: { location: 'Town' },
    });
    const wait = scheduleDecision(context({ location: 'Town', freeSlots: 0 }, { hasRod: false },
      { avoidTools: new Set(['forage']) }));
    expect(wait).toMatchObject({ kind: 'wait' });
    expect(wait?.kind === 'wait' ? wait.reason : '').toContain('钓鱼和采集');
  });

  it('中途接手（T-M6-70）：14:00 在农场 → 直接续上当天的浇水/收获', () => {
    expect(scheduleDecision(context({ location: 'Farm', clockMinutes: 14 * 60 }, { needsWater: 5, harvestable: 2 })))
      .toMatchObject({ kind: 'act', tool: 'water_crops' });
    expect(scheduleDecision(context({ location: 'Farm', clockMinutes: 14 * 60 }, { needsWater: 0, harvestable: 2 })))
      .toMatchObject({ kind: 'act', tool: 'harvest_crops' });
    // 农活都做完 → 按当天剩余时间继续出货/购种/播种/填充，而不是等第二天
    expect(scheduleDecision(context({ location: 'Farm', clockMinutes: 14 * 60 }, { emptyTilled: 4 }, { shippable: '鲈鱼' })))
      .toMatchObject({ kind: 'act', tool: 'ship_items' });
  });

  it('当天已完成的步骤不重复做（done 集合跨日由 planner 清空）', () => {
    const done = new Set<ScheduleStep>(['mail', 'water', 'harvest']);
    const d = scheduleDecision(context({ location: 'Farm' }, { unreadMail: 5, needsWater: 3, harvestable: 2 }, { done }));
    expect(d).toMatchObject({ kind: 'act', tool: 'travel_to', args: { location: 'Beach' } });
  });

  it('BWF 长动作执行中（【正在执行】）→ 只等待，不抢着发动作（2026-11-25 真机 sleep 中连发 travel_to 被判卡死）', () => {
    expect(inProgressGuard(state({ raw: '## 基本状态\n时间：第1年夏6日 22:40（Sat）' }))).toBeNull();
    const busy = inProgressGuard(state({
      raw: '【正在执行】sleep 已经执行 0 分 6 秒（做完前别的动作会被拒绝；做完的结果会出现在 get_state 最前面）\n## 基本状态',
    }));
    expect(busy).toMatchObject({ kind: 'wait' });
    expect(busy?.kind === 'wait' ? busy.reason : '').toContain('sleep');
    // 解析不出工具名也不许把整段文案塞进提示
    const unknown = inProgressGuard(state({ raw: '【正在执行】' }));
    expect(unknown?.kind === 'wait' ? unknown.reason : '').toContain('上一个动作');
  });
});
