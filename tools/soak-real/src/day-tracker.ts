/**
 * 游戏日切分与每日闭环统计（T-M6-67）。
 *
 * 纯状态机：调用方喂 `AutodriveEvent`（跑动中的事件流）与 `get_state` 快照（观察者），
 * 这里不读系统时钟、不发请求、不落盘——所有时间戳由调用方传入，便于用假时钟单测。
 *
 * 口径（RUNBOOK §1.4）：
 *   - 每日闭环各项以「当天出现对应工具的 COMPLETED 回执」为准；
 *   - `water` 遇雨天自动记为完成（天气来自观察者快照）；
 *   - `buySeeds` / `plant` 在冬季或季末（距季末不足 4 天）记 N/A，报告单列、不算失败；
 *   - `passedOut` = 体力 ≤ 0，或状态文本出现真正的累晕事件措辞（「晕倒过一次」这类记忆/建议不算）；
 *   - `forcedHome2am` = 换日前最后时钟 ≥ 01:50 且当天没有 sleep COMPLETED。
 */
import type { AutodriveEvent } from '@workbench/game-bridge-mcp';

/** 星露谷一季 28 天，季节顺序固定 */
export /** 真正的累晕事件；BWF 的日记/建议里会出现「晕倒过一次」，不算当天累晕（2026-11-25 真机误判） */
const PASSED_OUT_TEXT_RE = /累晕了|累晕过去|晕倒了|晕了过去|体力耗尽[^。\n]{0,6}(晕|倒)|passed out/i;

const SEASONS = ['春', '夏', '秋', '冬'] as const;

/** 季末保守截断：seasonDay > 24 时当天不再买种/播种（成熟期按 4 天估，T-M6-69 换正式种子表） */
export const PLANTING_CUTOFF_DAY = 24;

export interface GameClock {
  year: number;
  season: string;
  day: number;
  hour: number;
  minute: number;
  /** 当日分钟：00:00 = 0，23:59 = 1439 */
  clockMinutes: number;
  /**
   * 星露谷日序分钟：06:00 起算，凌晨 00:00–01:59 记为 24:00+（同一天内单调递增）。
   * 用来判断「2:00 前睡觉」与「≥01:50 遣返」。
   */
  dayMinutes: number;
  /** 稳定的日键："Y1-春-16" */
  dayKey: string;
  /** 跨日单调分钟：用来判断 repeat-failure 期间游戏时间是否推进 */
  absoluteMinutes: number;
}

/** 解析 "第1年春16日 07:30"（parseGameState 的 gameClock 字段） */
export function parseGameClock(clock: string | null | undefined): GameClock | null {
  if (clock === null || clock === undefined || clock === '') return null;
  const match = /第(\d+)年([春夏秋冬])(\d+)日\s*(\d{1,2}):(\d{2})/.exec(clock);
  if (match === null) return null;
  const year = Number(match[1]);
  const season = match[2] ?? '';
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const seasonIndex = SEASONS.indexOf(season as (typeof SEASONS)[number]);
  const clockMinutes = hour * 60 + minute;
  const dayMinutes = clockMinutes >= 6 * 60 ? clockMinutes : clockMinutes + 24 * 60;
  const dateIndex = (year - 1) * 4 * 28 + seasonIndex * 28 + (day - 1);
  return {
    year,
    season,
    day,
    hour,
    minute,
    clockMinutes,
    dayMinutes,
    dayKey: `Y${year}-${season}-${day}`,
    absoluteMinutes: dateIndex * 24 * 60 + dayMinutes,
  };
}

export type LoopKey = 'mail' | 'water' | 'harvest' | 'ship' | 'buySeeds' | 'plant' | 'sleptBefore2am';

export interface DayLoop {
  mail: boolean;
  water: boolean;
  harvest: boolean;
  ship: boolean;
  buySeeds: boolean;
  plant: boolean;
  sleptBefore2am: boolean;
}

export interface DayReceipts {
  completed: number;
  failed: number;
  timeout: number;
  uncertain: number;
  error: number;
}

/**
 * 当天各闭环项「是否真的出现过可做的机会」。
 * 由调用方从 `get_state` 原文解析后传入（本模块保持纯状态机，不读文本、不猜）。
 * 全部为 false 且 sawFacts=true 时，说明当天状态确实没有该动作的机会 → 报告记 N/A，不算失败。
 */
export interface DayOpportunity {
  mail: boolean;
  water: boolean;
  harvest: boolean;
  buySeeds: boolean;
  plant: boolean;
}

export interface DayRecord {
  dayKey: string;
  season: string;
  /** 当天最后观测到的天气（观察者关闭时可能为空） */
  weather: string;
  moneyStart: number;
  moneyEnd: number;
  loop: DayLoop;
  /**
   * 不适用项：报告里显示 N/A，不算失败。
   * buySeeds/plant 的两类来源：① 冬季或季末（与机会无关，直接 N/A）；② 当天状态证明没有空地/没钱/没种子。
   * mail/water/harvest 只在「观察者拿到过状态且全天没有机会」时置位，观察者关闭时保持 undefined。
   */
  na: { buySeeds: boolean; plant: boolean; mail?: boolean; water?: boolean; harvest?: boolean };
  passedOut: boolean;
  forcedHome2am: boolean;
  stuckCount: number;
  receipts: DayReceipts;
}

/** 观察者 / 事件流喂给 DayTracker 的状态补丁 */
export interface StatePatch {
  clock: string | null;
  money?: number;
  stamina?: number;
  staminaMax?: number;
  weather?: string;
  location?: string;
  /** get_state 原文（用于「累晕」等非结构化线索） */
  raw?: string;
  /**
   * 当天该动作的机会（由调用方从 get_state 解析）。
   * 传 undefined 表示这次没拿到可解析的状态（观察者关闭或解析失败），不计入机会统计，
   * 避免「观察者关闭 → 全部 N/A → 空绿」。
   */
  opportunity?: Partial<DayOpportunity>;
}

interface MutableDay extends DayRecord {
  sawRain: boolean;
  slept: boolean;
  lastDayMinutes: number | null;
  /** 全天累计的机会（多次观测取并集） */
  opp: DayOpportunity;
  /** 是否至少拿到过一次可解析的状态；false 时不启用机会型 N/A */
  sawFacts: boolean;
}

function emptyLoop(): DayLoop {
  return { mail: false, water: false, harvest: false, ship: false, buySeeds: false, plant: false, sleptBefore2am: false };
}

function emptyReceipts(): DayReceipts {
  return { completed: 0, failed: 0, timeout: 0, uncertain: 0, error: 0 };
}

function newDay(clock: GameClock, money: number, weather: string): MutableDay {
  return {
    dayKey: clock.dayKey,
    season: clock.season,
    weather,
    moneyStart: money,
    moneyEnd: money,
    loop: emptyLoop(),
    na: { buySeeds: false, plant: false },
    passedOut: false,
    forcedHome2am: false,
    stuckCount: 0,
    receipts: emptyReceipts(),
    sawRain: false,
    slept: false,
    lastDayMinutes: null,
    opp: { mail: false, water: false, harvest: false, buySeeds: false, plant: false },
    sawFacts: false,
  };
}

/** 季节 / 季末 → 不买种不播种（报告记 N/A） */
export function isPlantingNA(season: string, day: number): boolean {
  return season === '冬' || day > PLANTING_CUTOFF_DAY;
}

/** 当天闭环是否完整（N/A 项视为通过；供报告与退出码使用） */
export function isDayLoopComplete(record: DayRecord): boolean {
  if (!record.loop.mail && record.na.mail !== true) return false;
  if (!record.loop.water && record.na.water !== true) return false;
  if (!record.loop.harvest && record.na.harvest !== true) return false;
  if (!record.loop.ship) return false;
  if (!record.loop.sleptBefore2am) return false;
  if (!record.na.buySeeds && !record.loop.buySeeds) return false;
  if (!record.na.plant && !record.loop.plant) return false;
  return true;
}

export class DayTracker {
  private current: MutableDay | null = null;
  private readonly records: DayRecord[] = [];
  /** 最近一次决策（buy 回执要看 args 里买的是不是种子） */
  private lastDecision: { tool: string; args: Record<string, unknown> } | null = null;

  /** 已完成的游戏日（不含进行中的当天） */
  get days(): readonly DayRecord[] {
    return this.records;
  }

  /** 进行中的当天（没有状态时为 null） */
  get today(): DayRecord | null {
    return this.current === null ? null : this.snapshot(this.current);
  }

  /**
   * 喂状态（事件流里的 state 事件或观察者的 get_state 快照）。
   * 返回「刚刚被切分完成的上一天」，没有跨日则返回 null。
   */
  observe(patch: StatePatch, _now: number): DayRecord | null {
    const clock = parseGameClock(patch.clock);
    if (clock === null) return null;
    let finalized: DayRecord | null = null;
    if (this.current === null) {
      this.current = newDay(clock, patch.money ?? 0, patch.weather ?? '');
    } else if (this.current.dayKey !== clock.dayKey) {
      finalized = this.finalize(this.current);
      this.records.push(finalized);
      const carryMoney = patch.money ?? this.current.moneyEnd;
      this.current = newDay(clock, carryMoney, patch.weather ?? '');
    }
    const day = this.current;
    if (patch.money !== undefined && Number.isFinite(patch.money)) day.moneyEnd = patch.money;
    if (patch.weather !== undefined && patch.weather !== '') {
      day.weather = patch.weather;
      if (/雨|雪/.test(patch.weather)) day.sawRain = true;
    }
    if (patch.stamina !== undefined && Number.isFinite(patch.stamina) && patch.stamina <= 0) day.passedOut = true;
    if (patch.raw !== undefined && PASSED_OUT_TEXT_RE.test(patch.raw)) day.passedOut = true;
    if (patch.opportunity !== undefined) {
      // 只有真正拿到可解析状态时才累计机会；多次观测取并集（一天里只要出现过一次机会就算有）
      day.sawFacts = true;
      const opp = patch.opportunity;
      if (opp.mail === true) day.opp.mail = true;
      if (opp.water === true) day.opp.water = true;
      if (opp.harvest === true) day.opp.harvest = true;
      if (opp.buySeeds === true) day.opp.buySeeds = true;
      if (opp.plant === true) day.opp.plant = true;
    }
    day.lastDayMinutes = clock.dayMinutes;
    return finalized;
  }

  /** 喂 runner 事件。返回「刚刚被切分完成的上一天」，没有跨日则返回 null。 */
  ingest(event: AutodriveEvent, now: number): DayRecord | null {
    switch (event.type) {
      case 'state':
        return this.observe({ clock: event.clock, money: event.money, stamina: event.stamina }, now);
      case 'decision':
        this.lastDecision = { tool: event.tool, args: event.args };
        return null;
      case 'receipt':
        this.ingestReceipt(event);
        return null;
      default:
        return null;
    }
  }

  /** 卡死计数（当天；没有当天时忽略） */
  markStuck(): void {
    if (this.current !== null) this.current.stuckCount += 1;
  }

  /** 收尾：把进行中的当天按已完成落账（运行结束/中断时调用） */
  finish(_now: number): DayRecord | null {
    if (this.current === null) return null;
    const record = this.finalize(this.current);
    this.current = null;
    this.records.push(record);
    return record;
  }

  private ingestReceipt(event: Extract<AutodriveEvent, { type: 'receipt' }>): void {
    const day = this.current;
    if (day === null) return;
    if (event.tool === 'autodrive') return; // 编排器汇总回执不计入每日统计
    switch (event.status) {
      case 'COMPLETED':
        day.receipts.completed += 1;
        this.markCompletedTool(day, event.tool, event.summary);
        break;
      case 'FAILED':
        day.receipts.failed += 1;
        break;
      case 'TIMEOUT':
        day.receipts.timeout += 1;
        break;
      case 'UNCERTAIN':
        day.receipts.uncertain += 1;
        break;
      case 'ERROR':
        day.receipts.error += 1;
        break;
    }
  }

  private markCompletedTool(day: MutableDay, tool: string, summary: string): void {
    switch (tool) {
      case 'read_mail':
        day.loop.mail = true;
        break;
      case 'water_crops':
        day.loop.water = true;
        break;
      case 'harvest_crops':
        day.loop.harvest = true;
        break;
      case 'ship_items':
        day.loop.ship = true;
        break;
      case 'plant_seeds':
        day.loop.plant = true;
        break;
      case 'buy': {
        // 回执只带文本；决策 args 里带 item。两条线索任一命中「种子」才算买种成功。
        const argsItem = this.lastDecision?.tool === 'buy' ? String(this.lastDecision.args.item ?? '') : '';
        if (/种子/.test(argsItem) || /种子/.test(summary)) day.loop.buySeeds = true;
        break;
      }
      case 'sleep':
        day.slept = true;
        // 02:00 之前（dayMinutes < 24:00）睡觉才算「2:00 前睡觉」
        day.loop.sleptBefore2am = day.lastDayMinutes === null || day.lastDayMinutes < 24 * 60;
        break;
      default:
        break;
    }
  }

  private finalize(day: MutableDay): DayRecord {
    const dayNumber = Number(day.dayKey.split('-').pop() ?? '1');
    const plantingNA = isPlantingNA(day.season, Number.isFinite(dayNumber) ? dayNumber : 1);
    if (day.sawRain) day.loop.water = true; // 雨天作物自动喝饱，不浇也算完成
    // 机会型 N/A：只在「拿到过状态」且「全天从未出现机会」时成立，观察者关闭时保持 undefined，
    // 避免把「没观测到」当成「没事可做」而刷出空绿。
    const noOpportunity = (had: boolean): boolean => day.sawFacts && !had;
    day.na = {
      buySeeds: plantingNA || noOpportunity(day.opp.buySeeds),
      plant: plantingNA || noOpportunity(day.opp.plant),
      ...(noOpportunity(day.opp.mail) ? { mail: true } : {}),
      ...(!day.sawRain && noOpportunity(day.opp.water) ? { water: true } : {}),
      ...(noOpportunity(day.opp.harvest) ? { harvest: true } : {}),
    };
    day.forcedHome2am = !day.slept && day.lastDayMinutes !== null && day.lastDayMinutes >= 23 * 60 + 50;
    return this.snapshot(day);
  }

  private snapshot(day: MutableDay): DayRecord {
    return {
      dayKey: day.dayKey,
      season: day.season,
      weather: day.weather,
      moneyStart: day.moneyStart,
      moneyEnd: day.moneyEnd,
      loop: { ...day.loop },
      na: { ...day.na },
      passedOut: day.passedOut,
      forcedHome2am: day.forcedHome2am,
      stuckCount: day.stuckCount,
      receipts: { ...day.receipts },
    };
  }
}
