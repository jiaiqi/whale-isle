/**
 * T-M6-67 每日闭环统计：跨日切分、雨天浇水豁免、2:00 遣返、累晕、冬季/季末 N/A、金币曲线。
 */
import { describe, expect, it } from 'vitest';
import type { AutodriveEvent } from '@workbench/game-bridge-mcp';
import {
  DayTracker,
  isDayLoopComplete,
  isPlantingNA,
  parseGameClock,
  PLANTING_CUTOFF_DAY,
} from './day-tracker';

function receipt(tool: string, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR', summary = '完成'): AutodriveEvent {
  return { type: 'receipt', tool, status, summary };
}

function decision(tool: string, args: Record<string, unknown> = {}): AutodriveEvent {
  return { type: 'decision', planner: 'rule', tool, args, intent: '测试' };
}

const DAY16 = '第1年春16日 07:00';
const DAY17 = '第1年春17日 06:00';

describe('parseGameClock', () => {
  it('解析年/季/日/时分与跨日单调分钟', () => {
    const clock = parseGameClock(DAY16);
    expect(clock).toMatchObject({ year: 1, season: '春', day: 16, hour: 7, minute: 0, dayKey: 'Y1-春-16' });
    expect(clock?.clockMinutes).toBe(7 * 60);
    expect(clock?.dayMinutes).toBe(7 * 60);
  });

  it('凌晨 00:00–01:59 记作 24:00+（同日单调）', () => {
    const late = parseGameClock('第1年春16日 23:50');
    const midnight = parseGameClock('第1年春16日 00:10');
    expect(late?.dayMinutes).toBe(23 * 60 + 50);
    expect(midnight?.dayMinutes).toBe(24 * 60 + 10);
    expect(midnight!.absoluteMinutes).toBeGreaterThan(late!.absoluteMinutes);
  });

  it('绝对分钟跨季单调递增', () => {
    const spring = parseGameClock('第1年春28日 07:00');
    const summer = parseGameClock('第1年夏1日 07:00');
    expect(summer!.absoluteMinutes).toBeGreaterThan(spring!.absoluteMinutes);
  });

  it('非法输入返回 null', () => {
    expect(parseGameClock(null)).toBeNull();
    expect(parseGameClock('')).toBeNull();
    expect(parseGameClock('未知')).toBeNull();
    expect(parseGameClock('第1年X16日 07:00')).toBeNull();
  });
});

describe('isPlantingNA / isDayLoopComplete', () => {
  it('冬季或季末不买种不播种', () => {
    expect(isPlantingNA('冬', 3)).toBe(true);
    expect(isPlantingNA('春', PLANTING_CUTOFF_DAY)).toBe(false);
    expect(isPlantingNA('春', PLANTING_CUTOFF_DAY + 1)).toBe(true);
  });

  it('闭环完整 = 五项必需 + 买种/播种（N/A 视为通过）', () => {
    const full = {
      dayKey: 'Y1-春-16', season: '春', weather: '晴', moneyStart: 0, moneyEnd: 0,
      loop: { mail: true, water: true, harvest: true, ship: true, buySeeds: true, plant: true, sleptBefore2am: true },
      na: { buySeeds: false, plant: false }, passedOut: false, forcedHome2am: false, stuckCount: 0,
      receipts: { completed: 7, failed: 0, timeout: 0, uncertain: 0, error: 0 },
    };
    expect(isDayLoopComplete(full)).toBe(true);
    expect(isDayLoopComplete({ ...full, loop: { ...full.loop, harvest: false } })).toBe(false);
    for (const key of ['mail', 'water', 'ship', 'sleptBefore2am'] as const) {
      expect(isDayLoopComplete({ ...full, loop: { ...full.loop, [key]: false } }), key).toBe(false);
    }
    expect(isDayLoopComplete({ ...full, loop: { ...full.loop, buySeeds: false, plant: false }, na: { buySeeds: true, plant: true } })).toBe(true);
    expect(isDayLoopComplete({ ...full, loop: { ...full.loop, buySeeds: false } })).toBe(false);
    expect(isDayLoopComplete({ ...full, loop: { ...full.loop, plant: false } })).toBe(false);
  });
});

describe('DayTracker 日切分', () => {
  it('同一天内不落账，跨日返回上一天记录', () => {
    const tracker = new DayTracker();
    expect(tracker.observe({ clock: DAY16, money: 640, weather: '晴' }, 0)).toBeNull();
    expect(tracker.days).toHaveLength(0);
    expect(tracker.observe({ clock: '第1年春16日 18:00', money: 900 }, 1)).toBeNull();
    const finalized = tracker.observe({ clock: DAY17, money: 900, weather: '晴' }, 2);
    expect(finalized).not.toBeNull();
    expect(finalized?.dayKey).toBe('Y1-春-16');
    expect(finalized?.moneyStart).toBe(640);
    expect(finalized?.moneyEnd).toBe(900);
    expect(tracker.days).toHaveLength(1);
    expect(tracker.today?.dayKey).toBe('Y1-春-17');
  });

  it('每个闭环项由对应工具的 COMPLETED 回执点亮', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 100 }, 0);
    tracker.ingest(receipt('read_mail', 'COMPLETED'), 1);
    tracker.ingest(receipt('water_crops', 'COMPLETED'), 2);
    tracker.ingest(receipt('harvest_crops', 'COMPLETED'), 3);
    tracker.ingest(receipt('ship_items', 'COMPLETED'), 4);
    tracker.ingest(decision('buy', { item: '防风草种子' }), 5);
    tracker.ingest(receipt('buy', 'COMPLETED', '买到了防风草种子 x5'), 6);
    tracker.ingest(receipt('plant_seeds', 'COMPLETED'), 7);
    const day = tracker.finish(8);
    expect(day?.loop).toMatchObject({
      mail: true, water: true, harvest: true, ship: true, buySeeds: true, plant: true,
    });
  });

  it('买种也认回执文本里的「种子」；失败回执不计入完成项', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 100 }, 0);
    tracker.ingest(receipt('buy', 'COMPLETED', '买到了辣椒种子'), 1);
    tracker.ingest(receipt('read_mail', 'FAILED', '邮箱是空的'), 2);
    const day = tracker.finish(3);
    expect(day?.loop.buySeeds).toBe(true);
    expect(day?.loop.mail).toBe(false);
    expect(day?.receipts).toMatchObject({ completed: 1, failed: 1 });
  });

  it('雨天自动记为浇水完成', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 100, weather: '下雨' }, 0);
    const day = tracker.observe({ clock: DAY17, money: 100 }, 1);
    expect(day?.weather).toBe('下雨');
    expect(day?.loop.water).toBe(true);
  });

  it('02:00 之前睡觉算达标，01:30 睡觉不算', () => {
    const early = new DayTracker();
    early.observe({ clock: '第1年春16日 22:00', money: 0 }, 0);
    early.ingest(receipt('sleep', 'COMPLETED', '晚安'), 1);
    expect(early.finish(2)?.loop.sleptBefore2am).toBe(true);

    const late = new DayTracker();
    late.observe({ clock: '第1年春16日 01:30', money: 0 }, 0);
    late.ingest(receipt('sleep', 'COMPLETED', '晚安'), 1);
    const day = late.finish(2);
    expect(day?.loop.sleptBefore2am).toBe(false);
    expect(day?.forcedHome2am).toBe(false); // 已经睡了，不算遣返
  });

  it('换日前最后时钟 ≥01:50 且没睡 → 2:00 遣返', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: '第1年春16日 23:00', money: 0 }, 0);
    tracker.observe({ clock: '第1年春16日 01:55', money: 0 }, 1);
    const day = tracker.observe({ clock: DAY17, money: 0 }, 2);
    expect(day?.forcedHome2am).toBe(true);
    expect(day?.loop.sleptBefore2am).toBe(false);
  });

  it('体力归零或文本含「累晕」→ passedOut', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 0, stamina: 0 }, 0);
    expect(tracker.today?.passedOut).toBe(true);

    const text = new DayTracker();
    text.observe({ clock: DAY16, money: 0, raw: '你累晕了，被送回家' }, 0);
    expect(text.today?.passedOut).toBe(true);
  });

  it('日记/建议里的「晕倒过一次」不算当天累晕（真机误判回归）', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 0, raw: '日：种15防风草→浇水→沙滩找威利领鱼竿。晕倒过一次，睡前必须回家！' }, 0);
    expect(tracker.today?.passedOut).toBe(false);
    tracker.observe({ clock: DAY16, money: 0, raw: '你晕倒了，被送回家' }, 1);
    expect(tracker.today?.passedOut).toBe(true);
    tracker.observe({ clock: DAY16, money: 0, raw: '体力耗尽，你晕了过去' }, 2);
    expect(tracker.today?.passedOut).toBe(true);
  });

  it('冬季与季末记 N/A（报告单列，不算失败）', () => {
    const winter = new DayTracker();
    winter.observe({ clock: '第1年冬5日 07:00', money: 0 }, 0);
    const winterDay = winter.finish(1);
    expect(winterDay?.na).toEqual({ buySeeds: true, plant: true });

    const seasonEnd = new DayTracker();
    seasonEnd.observe({ clock: '第1年夏26日 07:00', money: 0 }, 0);
    expect(seasonEnd.finish(1)?.na).toEqual({ buySeeds: true, plant: true });
  });

  it('状态证明全天没有机会 → 五项记 N/A，只做过的出货与睡觉仍算达标', () => {
    const tracker = new DayTracker();
    tracker.observe({
      clock: DAY16,
      money: 500,
      raw: '（农场概况：共 0 株作物，需浇水 0，可收获 0）',
      opportunity: { mail: false, water: false, harvest: false, buySeeds: false, plant: false },
    }, 0);
    tracker.ingest(receipt('ship_items', 'COMPLETED', '已把 海草 放进出货箱'), 1);
    tracker.ingest(receipt('sleep', 'COMPLETED', '晚安主人'), 2);
    const day = tracker.finish(3);
    expect(day?.na).toMatchObject({ mail: true, water: true, harvest: true, buySeeds: true, plant: true });
    expect(isDayLoopComplete(day!)).toBe(true);
  });

  it('没有观测到状态时不做机会型 N/A（避免空绿）', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 500 }, 0);
    tracker.ingest(receipt('ship_items', 'COMPLETED', '已把 海草 放进出货箱'), 1);
    tracker.ingest(receipt('sleep', 'COMPLETED', '晚安主人'), 2);
    const day = tracker.finish(3);
    expect(day?.na.mail).toBeUndefined();
    expect(day?.na.water).toBeUndefined();
    expect(day?.na.harvest).toBeUndefined();
    expect(isDayLoopComplete(day!)).toBe(false);
  });

  it('当天只要出现过一次机会就不记 N/A', () => {
    const tracker = new DayTracker();
    tracker.observe({
      clock: DAY16,
      money: 500,
      opportunity: { mail: false, water: false, harvest: false, buySeeds: false, plant: false },
    }, 0);
    tracker.observe({ clock: '第1年春16日 12:00', money: 500, opportunity: { harvest: true } }, 1);
    tracker.ingest(receipt('sleep', 'COMPLETED', '晚安主人'), 2);
    const day = tracker.finish(3);
    expect(day?.na.harvest).toBeUndefined();
    expect(day?.na.mail).toBe(true);
    expect(day?.loop.harvest).toBe(false);
    expect(isDayLoopComplete(day!)).toBe(false);
  });

  it('雨天 water 不记 N/A（自动记为完成）', () => {
    const tracker = new DayTracker();
    tracker.observe({
      clock: DAY16,
      money: 0,
      weather: '下雨',
      opportunity: { water: false },
    }, 0);
    const day = tracker.finish(1);
    expect(day?.na.water).toBeUndefined();
    expect(day?.loop.water).toBe(true);
  });

  it('回执计数区分完成/失败/超时/不确定/错误；autodrive 汇总不计', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 0 }, 0);
    tracker.ingest(receipt('a', 'COMPLETED'), 1);
    tracker.ingest(receipt('b', 'FAILED'), 2);
    tracker.ingest(receipt('c', 'TIMEOUT'), 3);
    tracker.ingest(receipt('d', 'UNCERTAIN'), 4);
    tracker.ingest(receipt('e', 'ERROR'), 5);
    tracker.ingest(receipt('chop_tree', 'COMPLETED', '砍了一棵树'), 5);
    tracker.ingest(receipt('autodrive', 'COMPLETED'), 6);
    const day = tracker.finish(7);
    expect(day?.receipts).toEqual({ completed: 2, failed: 1, timeout: 1, uncertain: 1, error: 1 });
  });

  it('卡死计数挂到当天；没有当天状态时忽略', () => {
    const tracker = new DayTracker();
    tracker.markStuck();
    tracker.observe({ clock: DAY16, money: 0 }, 0);
    tracker.markStuck();
    tracker.markStuck();
    expect(tracker.today?.stuckCount).toBe(2);
  });

  it('没有状态时 finish 返回 null；无法解析的时钟不建日', () => {
    const tracker = new DayTracker();
    expect(tracker.finish(0)).toBeNull();
    expect(tracker.observe({ clock: '未知', money: 0 }, 0)).toBeNull();
    expect(tracker.today).toBeNull();
  });

  it('决策事件被记住供 buy 判定，其他事件类型直接忽略', () => {
    const tracker = new DayTracker();
    tracker.observe({ clock: DAY16, money: 0 }, 0);
    tracker.ingest(decision('buy', { item: ['防风草种子'] }), 1);
    tracker.ingest(receipt('buy', 'COMPLETED', '买好了'), 2);
    tracker.ingest({ type: 'watchdog', kind: 'heartbeat', detail: 'x' }, 3);
    tracker.ingest({ type: 'cycle-end', delayMs: 10 }, 4);
    expect(tracker.finish(5)?.loop.buySeeds).toBe(true);
  });
});
