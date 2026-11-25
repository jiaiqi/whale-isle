/**
 * [SIMULATION] 多日活农场仿真（T-M6-69，RUNBOOK-M8-STARDEW §3.6）。
 *
 * 与 `bwf-replay-server.ts`（按剧本只读回放）不同：这里是**活的世界**——日期、时钟、金币、
 * 体力、背包、农田、天气都会随工具调用真实变化。用它把真实 `RulePlanner` 放进一个
 * 会过夜、会生长、会结算的农场里跑多天，验证「无 LLM 也能完成每日闭环」。
 *
 * 复用 `startBwfHttpServer`（JSON/SSE 双形态、端口分配、坏请求体）与 `advanceClock` 同口径的
 * 换日规则；get_state 文本按真机 BWF 1.1.27 的段落与措辞拼装（以 RUNBOOK §0.2 / 真机现场为准）。
 *
 * 边界：mock-harness 运行期源码只许依赖 shared-protocol（dependency-cruiser），
 * 所以种子表在这里**复制一份**并标注同步来源；`rule-7day.spec.ts`（spec 可 import 业务包）
 * 会断言两份种子表一致，改一处忘另一处会立刻变红。
 */
import { startBwfHttpServer, type ReplayCall } from './bwf-replay-server';

export type SimSeason = '春' | '夏' | '秋' | '冬';
export type SimLocation = 'FarmHouse' | 'Farm' | 'Beach' | 'Town' | 'SeedShop';

const SEASONS: readonly SimSeason[] = ['春', '夏', '秋', '冬'];
const DAYS_PER_SEASON = 28;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const BAG_CAPACITY = 24;
/** 常驻工具占的背包格（真机背包里工具各占一格） */
const TOOLS = ['斧头', '锄头', '喷壶', '竹鱼竿'] as const;
const START_MINUTES = 6 * 60;
/** 游戏内 02:00 = 日序 26:00（06:00 起算） */
const FORCED_SLEEP_DAY_MINUTES = 26 * 60;

const LOCATION_LABEL: Readonly<Record<SimLocation, string>> = {
  FarmHouse: 'FarmHouse（农舍）',
  Farm: 'Farm（泡泡湾农场）',
  Beach: 'Beach（沙滩）',
  Town: 'Town（鹈鹕镇）',
  SeedShop: 'SeedShop（皮埃尔的杂货店）',
};
const LOCATION_POS: Readonly<Record<SimLocation, { x: number; y: number }>> = {
  FarmHouse: { x: 12, y: 8 },
  Farm: { x: 64, y: 15 },
  Beach: { x: 32, y: 6 },
  Town: { x: 40, y: 20 },
  SeedShop: { x: 22, y: 14 },
};

/**
 * 种子表副本（与 `packages/game-bridge-mcp/src/seed-table.ts` 同步；数值以游戏内商店为准）。
 * `sell` 是仿真用的出货价（真机由游戏决定），只用于让 7 日金币趋势有可比性。
 */
export interface SimSeed {
  season: SimSeason;
  name: string;
  cropName: string;
  price: number;
  maturityDays: number;
  regrow: boolean;
  sell: number;
}

export const SIM_SEED_TABLE: readonly SimSeed[] = Object.freeze([
  { season: '春', name: '防风草种子', cropName: '防风草', price: 20, maturityDays: 4, regrow: false, sell: 35 },
  { season: '夏', name: '辣椒种子', cropName: '辣椒', price: 40, maturityDays: 5, regrow: true, sell: 40 },
  { season: '秋', name: '小白菜种子', cropName: '小白菜', price: 50, maturityDays: 4, regrow: false, sell: 60 },
]);

/** 初始农场自带的重复收获作物（草莓）：保证每天都有「浇水 + 收获 + 出货」可做 */
const STRAWBERRY: SimSeed = { season: '春', name: '草莓种子', cropName: '草莓', price: 100, maturityDays: 4, regrow: true, sell: 60 };

export function simSeedForSeason(season: string): SimSeed | null {
  return SIM_SEED_TABLE.find((seed) => seed.season === season) ?? null;
}

function simDaysLeft(day: number): number {
  const clamped = Math.min(DAYS_PER_SEASON, Math.max(1, Math.floor(day)));
  return DAYS_PER_SEASON - clamped + 1;
}

function findSimSeedByItem(name: string): SimSeed | null {
  const all = [STRAWBERRY, ...SIM_SEED_TABLE];
  return all.find((seed) => seed.name === name) ?? null;
}

interface Crop {
  seed: SimSeed;
  /** 已生长天数（可收获时 >= 需求天数） */
  growth: number;
  /** 本次收获需要生长到的天数（regrow 收完后变小） */
  need: number;
  watered: boolean;
  ready: boolean;
}

interface Tile {
  crop: Crop | null;
}

export interface SimBagStack {
  name: string;
  count: number;
}

export interface FarmSimSnapshot {
  year: number;
  season: SimSeason;
  day: number;
  weekday: number;
  minutes: number;
  dayMinutes: number;
  weather: string;
  money: number;
  stamina: number;
  staminaMax: number;
  health: number;
  healthMax: number;
  location: SimLocation;
  menu: string;
  unreadMail: number;
  bag: SimBagStack[];
  freeSlots: number;
  pendingShipping: number;
  /** 农田：耕地总格数 / 空地（已开垦无作物）/ 作物数 / 需浇水 / 可收获 */
  tilled: number;
  emptyTilled: number;
  crops: number;
  needsWater: number;
  harvestable: number;
}

export interface FarmLoopFlags {
  mail: boolean;
  water: boolean;
  harvest: boolean;
  ship: boolean;
  buySeeds: boolean;
  plant: boolean;
  sleptBefore2am: boolean;
}

export interface FarmDayRecord {
  dayKey: string;
  season: SimSeason;
  day: number;
  weekday: number;
  weather: string;
  moneyStart: number;
  moneyEnd: number;
  loop: FarmLoopFlags;
  /** 当天「本来有机会做」的闭环项；没有机会 = N/A（报告里不算失败） */
  opportunity: { mail: boolean; water: boolean; harvest: boolean; ship: boolean; buySeeds: boolean; plant: boolean };
  passedOut: boolean;
  forcedHome2am: boolean;
  actions: string[];
}

export interface FarmSimOptions {
  /** 确定性随机种子（天气/钓鱼结果） */
  seed?: number;
  year?: number;
  season?: SimSeason;
  day?: number;
  minutes?: number;
  money?: number;
  stamina?: number;
  staminaMax?: number;
  /** 初始已开垦空地（无作物） */
  tilled?: number;
  /** 初始已成熟的草莓株数（重复收获，保证每天有活干） */
  strawberry?: number;
  /** farm 可开垦上限（till_area 超过后返回「没有更多可开垦的地」） */
  arableCap?: number;
  /** 每天早上新增的未读信件（默认 1；0 表示不投递） */
  mailPerDay?: number;
  /** 覆盖天气计划（第 1 天起），用于定向测试；省略时按 seed 确定性生成 */
  weatherPlan?: readonly string[];
  /** 初始背包附加物品（测试满包/出货线索用） */
  extraItems?: Readonly<Record<string, number>>;
  responseMode?: 'json' | 'sse';
}

export interface FarmSimHandle {
  endpoint: string;
  calls: ReplayCall[];
  snapshot(): FarmSimSnapshot;
  /** 已结束的每一天（换日时落盘） */
  days: FarmDayRecord[];
  /** 当前这一天的实时记录（未结束也可见） */
  currentDay(): FarmDayRecord;
  close(): Promise<void>;
}

/** 确定性伪随机（xorshift 变体）：同样的 seed/日期永远得到同样的天气与鱼获 */
function hash32(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    let x = Math.imul(value | 0, 0x9e3779b1) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0;
    h = (h ^ x) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

function seasonIndex(season: string): number {
  const index = SEASONS.indexOf(season as SimSeason);
  return index < 0 ? 0 : index;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function ceilHalf(count: number): number {
  return Math.ceil(Math.max(0, count) / 2);
}

class FarmSim {
  private year: number;
  private season: SimSeason;
  private day: number;
  private minutes: number;
  private money: number;
  private stamina: number;
  private readonly staminaMax: number;
  private health = 100;
  private readonly healthMax = 100;
  private location: SimLocation = 'FarmHouse';
  private menu = '';
  private unreadMail: number;
  private readonly mailPerDay: number;
  private readonly bag = new Map<string, number>();
  private tiles: Tile[] = [];
  private pendingShipping = 0;
  private readonly arableCap: number;
  private readonly seed: number;
  private readonly weatherPlan: readonly string[] | undefined;
  readonly days: FarmDayRecord[] = [];
  private dayStartMoney: number;
  private dayFlags: FarmLoopFlags;
  private dayOpportunity: FarmDayRecord['opportunity'];
  private dayActions: string[] = [];
  private passedOut = false;
  private forcedHome2am = false;
  private fishCounter = 0;

  constructor(options: FarmSimOptions = {}) {
    this.year = options.year ?? 1;
    this.season = options.season ?? '春';
    this.day = options.day ?? 16;
    this.minutes = options.minutes ?? START_MINUTES;
    this.money = options.money ?? 640;
    this.staminaMax = options.staminaMax ?? 270;
    this.stamina = options.stamina ?? this.staminaMax;
    this.unreadMail = options.mailPerDay ?? 1;
    this.mailPerDay = options.mailPerDay ?? 1;
    this.arableCap = options.arableCap ?? 60;
    this.seed = options.seed ?? 20261125;
    this.weatherPlan = options.weatherPlan;
    this.dayStartMoney = this.money;
    this.dayFlags = FarmSim.emptyLoop();
    this.dayOpportunity = { mail: false, water: false, harvest: false, ship: false, buySeeds: false, plant: false };

    for (const tool of TOOLS) this.bag.set(tool, 1);
    for (const [name, count] of Object.entries(options.extraItems ?? {})) {
      if (count > 0) this.bag.set(name, count);
    }
    const tilled = Math.max(0, Math.floor(options.tilled ?? 24));
    for (let i = 0; i < tilled; i += 1) this.tiles.push({ crop: null });
    const strawberries = Math.max(0, Math.floor(options.strawberry ?? 6));
    for (let i = 0; i < strawberries; i += 1) {
      this.tiles.push({ crop: { seed: STRAWBERRY, growth: STRAWBERRY.maturityDays, need: STRAWBERRY.maturityDays, watered: true, ready: true } });
    }
  }

  private static emptyLoop(): FarmLoopFlags {
    return { mail: false, water: false, harvest: false, ship: false, buySeeds: false, plant: false, sleptBefore2am: false };
  }

  // ───────────────────────── 时间 / 天气 ─────────────────────────

  private dayMinutes(): number {
    return this.minutes >= START_MINUTES ? this.minutes : this.minutes + 24 * 60;
  }

  private weekday(): number {
    // 星露谷第 1 天是周一：春 16 日 = 周二（与真机 get_state 一致）
    return ((this.day - 1) % 7) + 1;
  }

  weatherForDay(offset: number): string {
    if (this.weatherPlan !== undefined) {
      const planned = this.weatherPlan[offset];
      if (planned !== undefined) return planned;
    }
    const index = this.dateIndex() + offset;
    const roll = hash32(this.seed, index) % 100;
    if (this.season === '冬') return roll < 35 ? '雪' : '晴';
    if (roll < 20) return '下雨';
    if (roll < 30) return '刮风';
    return '晴';
  }

  private dateIndex(): number {
    return seasonIndex(this.season) * DAYS_PER_SEASON + (this.day - 1);
  }

  private isWetDay(): boolean {
    return /雨|雪/.test(this.weatherForDay(0));
  }

  private advance(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.minutes += Math.round(minutes);
    while (this.minutes >= 24 * 60) {
      this.minutes -= 24 * 60;
      // 跨过 24:00 不换日（星露谷凌晨仍是同一天），到 02:00 由 checkForced 处理
    }
  }

  private spendStamina(cost: number): boolean {
    this.stamina = Math.max(0, this.stamina - Math.max(0, Math.round(cost)));
    if (this.stamina <= 0) {
      this.passedOut = true;
      return false;
    }
    return true;
  }

  private checkForced(): string | null {
    if (this.passedOut) {
      const before = this.dayKey();
      this.rollDay('passedOut');
      return `累晕了……好心人把你送回家（${before} 提前结束，扣了 100g）`;
    }
    if (this.dayMinutes() >= FORCED_SLEEP_DAY_MINUTES) {
      this.forcedHome2am = true;
      this.rollDay('forced');
      return '已经凌晨 2:00，你坚持不住倒头就睡（被扣了 100g 医药费）';
    }
    return null;
  }

  // ───────────────────────── 背包 / 农田 ─────────────────────────

  private freeSlots(): number {
    const items = [...this.bag.keys()].filter((name) => (this.bag.get(name) ?? 0) > 0);
    return Math.max(0, BAG_CAPACITY - items.length);
  }

  private addItem(name: string, count: number): boolean {
    if (count <= 0) return true;
    const exists = (this.bag.get(name) ?? 0) > 0;
    if (!exists && this.freeSlots() <= 0) return false;
    this.bag.set(name, (this.bag.get(name) ?? 0) + count);
    return true;
  }

  private takeItem(name: string, count: number): number {
    const have = this.bag.get(name) ?? 0;
    const taken = Math.min(have, Math.max(0, count));
    if (taken <= 0) return 0;
    if (have - taken <= 0) this.bag.delete(name);
    else this.bag.set(name, have - taken);
    return taken;
  }

  private itemCount(name: string): number {
    return this.bag.get(name) ?? 0;
  }

  private emptyTiles(): number {
    return this.tiles.filter((tile) => tile.crop === null).length;
  }

  private cropTiles(): Crop[] {
    return this.tiles.flatMap((tile) => (tile.crop === null ? [] : [tile.crop]));
  }

  private needsWaterCount(): number {
    return this.cropTiles().filter((crop) => !crop.watered).length;
  }

  private harvestableCount(): number {
    return this.cropTiles().filter((crop) => crop.ready).length;
  }

  /** 可出货物品（工具/种子不算） */
  private shippableItems(): SimBagStack[] {
    return [...this.bag.entries()]
      .filter(([name, count]) => count > 0 && !TOOLS.includes(name as (typeof TOOLS)[number]) && !/种子$/.test(name))
      .map(([name, count]) => ({ name, count }));
  }

  private sellPrice(name: string): number {
    const seed = [STRAWBERRY, ...SIM_SEED_TABLE].find((item) => item.cropName === name);
    return seed?.sell ?? 25;
  }

  // ───────────────────────── 一天结束：结算 / 生长 / 换日 ─────────────────────────

  private dayKey(): string {
    return `Y${this.year}-${this.season}${this.day}`;
  }

  private finalizeDay(): void {
    this.money += this.pendingShipping;
    this.pendingShipping = 0;
    const record: FarmDayRecord = {
      dayKey: this.dayKey(),
      season: this.season,
      day: this.day,
      weekday: this.weekday(),
      weather: this.weatherForDay(0),
      moneyStart: this.dayStartMoney,
      moneyEnd: this.money,
      loop: { ...this.dayFlags },
      opportunity: { ...this.dayOpportunity },
      passedOut: this.passedOut,
      forcedHome2am: this.forcedHome2am,
      actions: [...this.dayActions],
    };
    if (this.isWetDay()) record.loop.water = true;
    this.days.push(record);
  }

  private growCrops(): void {
    for (const tile of this.tiles) {
      const crop = tile.crop;
      if (crop === null) continue;
      if (crop.watered) {
        crop.growth += 1;
        if (crop.growth >= crop.need) crop.ready = true;
      }
      crop.watered = false;
    }
  }

  private rollDay(reason: 'sleep' | 'forced' | 'passedOut'): void {
    if (reason === 'sleep') this.dayFlags.sleptBefore2am = this.dayMinutes() < FORCED_SLEEP_DAY_MINUTES;
    this.finalizeDay();
    this.growCrops();

    if (reason !== 'sleep') this.money = Math.max(0, this.money - 100);
    this.day += 1;
    if (this.day > DAYS_PER_SEASON) {
      this.day = 1;
      const index = seasonIndex(this.season);
      if (index >= SEASONS.length - 1) {
        this.season = '春';
        this.year += 1;
      } else {
        this.season = SEASONS[index + 1] ?? '春';
      }
      // 换季：非当季作物枯萎（星露谷规则），地块保留为已开垦空地
      for (const tile of this.tiles) {
        if (tile.crop !== null && tile.crop.seed.season !== this.season) tile.crop = null;
      }
    }
    this.minutes = START_MINUTES;
    this.location = 'FarmHouse';
    this.menu = '';
    this.stamina = this.staminaMax;
    this.health = this.healthMax;
    this.unreadMail += this.mailPerDay;
    this.passedOut = false;
    this.forcedHome2am = false;
    this.dayStartMoney = this.money;
    this.dayFlags = FarmSim.emptyLoop();
    this.dayOpportunity = { mail: false, water: false, harvest: false, ship: false, buySeeds: false, plant: false };
    this.dayActions = [];
    this.fishCounter = 0;
    if (this.isWetDay()) for (const crop of this.cropTiles()) crop.watered = true;
  }

  // ───────────────────────── 工具实现 ─────────────────────────

  private shopOpen(): boolean {
    if (this.weekday() === 3) return false;
    const dm = this.dayMinutes();
    return dm >= 9 * 60 && dm < 17 * 60;
  }

  private canMature(seed: SimSeed): boolean {
    return seed.season === this.season && simDaysLeft(this.day) >= seed.maturityDays;
  }

  private buySeedsOpportunity(): boolean {
    const seed = simSeedForSeason(this.season);
    if (seed === null || !this.shopOpen() || !this.canMature(seed)) return false;
    if (this.emptyTiles() <= 0) return false;
    const owned = this.itemCount(seed.name);
    if (owned >= this.emptyTiles()) return false;
    return this.money >= seed.price + 100;
  }

  private plantOpportunity(): boolean {
    const seed = simSeedForSeason(this.season);
    if (seed === null || !this.canMature(seed)) return false;
    return this.itemCount(seed.name) > 0 && this.emptyTiles() > 0;
  }

  private observeOpportunities(): void {
    if (this.unreadMail > 0) this.dayOpportunity.mail = true;
    if (this.needsWaterCount() > 0 && !this.isWetDay()) this.dayOpportunity.water = true;
    if (this.harvestableCount() > 0) this.dayOpportunity.harvest = true;
    if (this.shippableItems().length > 0) this.dayOpportunity.ship = true;
    if (this.buySeedsOpportunity()) this.dayOpportunity.buySeeds = true;
    if (this.plantOpportunity()) this.dayOpportunity.plant = true;
  }

  private travelMinutes(target: SimLocation): number {
    if (this.location === target) return 0;
    if (this.location === 'Beach' || target === 'Beach') return 30;
    return 20;
  }

  private moveTo(target: SimLocation, minutes: number): void {
    this.advance(minutes);
    this.location = target;
  }

  call(tool: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
    this.observeOpportunities();
    if (tool === 'get_state') return { text: this.stateText() };
    this.dayActions.push(tool);
    const result = this.dispatch(tool, args);
    const forced = this.checkForced();
    if (forced !== null) {
      return { text: `${result.text}（${forced}）`, isError: result.isError === true };
    }    return result;
  }

  private dispatch(tool: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
    switch (tool) {
      case 'read_mail': return this.doReadMail();
      case 'travel_to': return this.doTravel(args);
      case 'water_crops': return this.doWater();
      case 'harvest_crops': return this.doHarvest();
      case 'ship_items': return this.doShip(args);
      case 'buy': return this.doBuy(args);
      case 'open_shop': return this.doOpenShop();
      case 'close_menu': this.menu = ''; this.advance(5); return { text: '已关闭界面' };
      case 'plant_seeds': return this.doPlant(args);
      case 'till_area': return this.doTill(args);
      case 'fish': return this.doFish(args);
      case 'forage': return this.doForage();
      case 'eat': return this.doEat(args);
      case 'sleep': return this.doSleep();
      case 'wait': this.advance(typeof args.minutes === 'number' ? args.minutes : 10); return { text: '等待了一会儿' };
      case 'tidy_backpack': this.advance(10); return { text: '整理了背包' };
      case 'list_chests': return { text: '农场里还没有箱子' };
      case 'clear_area': this.advance(30); return { text: '清理了一下周围（仿真：没有可清理的东西）' };
      default:
        return { text: `失败：农场仿真不支持工具 ${tool}`, isError: true };
    }
  }

  private doReadMail(): { text: string; isError?: boolean } {
    const count = this.unreadMail;
    this.unreadMail = 0;
    this.advance(10);
    this.spendStamina(2);
    this.dayFlags.mail = true;
    return { text: count > 0 ? `读完 ${count} 封信` : '邮箱里没有未读信件' };
  }

  private doTravel(args: Record<string, unknown>): { text: string; isError?: boolean } {
    const location = typeof args.location === 'string' ? args.location : '';
    const known: readonly SimLocation[] = ['FarmHouse', 'Farm', 'Beach', 'Town', 'SeedShop'];
    if (!known.includes(location as SimLocation)) {
      return { text: `失败：不知道地点 ${location}`, isError: true };
    }
    const target = location as SimLocation;
    this.moveTo(target, this.travelMinutes(target));
    this.spendStamina(3);
    return { text: `已到达 ${LOCATION_LABEL[target]}` };
  }

  private doWater(): { text: string; isError?: boolean } {
    if (this.location !== 'Farm') return { text: '失败：必须在农场才能浇水', isError: true };
    const crops = this.cropTiles().filter((crop) => !crop.watered);
    for (const crop of crops) crop.watered = true;
    this.advance(30);
    this.spendStamina(ceilHalf(crops.length) + 2);
    this.dayFlags.water = true;
    return { text: crops.length > 0 ? `浇了 ${crops.length} 株作物` : '没有需要浇水的作物' };
  }

  private doHarvest(): { text: string; isError?: boolean } {
    if (this.location !== 'Farm') return { text: '失败：必须在农场才能收获', isError: true };
    const harvested = new Map<string, number>();
    for (const tile of this.tiles) {
      const crop = tile.crop;
      if (crop === null || !crop.ready) continue;
      if (!this.addItem(crop.seed.cropName, 1)) {
        return { text: '失败：背包满了，装不下收获物', isError: true };
      }
      harvested.set(crop.seed.cropName, (harvested.get(crop.seed.cropName) ?? 0) + 1);
      if (crop.seed.regrow) {
        crop.growth = 0;
        crop.need = Math.max(1, crop.seed.maturityDays - 1);
        crop.ready = false;
        crop.watered = false;
      } else {
        tile.crop = null;
      }
    }
    const total = [...harvested.values()].reduce((sum, count) => sum + count, 0);
    this.advance(30);
    this.spendStamina(ceilHalf(total) + 2);
    if (total > 0) this.dayFlags.harvest = true;
    const detail = [...harvested.entries()].map(([name, count]) => `${name} x${count}`).join('、');
    return { text: total > 0 ? `收获 ${total} 个：${detail}` : '没有可收获的作物' };
  }

  private doShip(args: Record<string, unknown>): { text: string; isError?: boolean } {
    const item = typeof args.item === 'string' ? args.item : '';
    const count = typeof args.count === 'number' ? Math.max(1, Math.floor(args.count)) : this.itemCount(item);
    const shipped = this.takeItem(item, count);
    if (shipped <= 0) return { text: `失败：背包里没有 ${item}`, isError: true };
    const value = this.sellPrice(item) * shipped;
    this.pendingShipping += value;
    this.advance(10);
    this.spendStamina(2);
    this.dayFlags.ship = true;
    return { text: `把 ${item} x${shipped} 放进了出货箱（今晚结算 ${value}g）` };
  }

  private doBuy(args: Record<string, unknown>): { text: string; isError?: boolean } {
    if (!/商店|Shop/.test(this.menu)) return { text: '失败：没有打开商店界面（先 open_shop）', isError: true };
    if (!this.shopOpen()) return { text: '失败：皮埃尔的杂货店现在不营业（9:00-17:00，周三休息）', isError: true };
    const item = typeof args.item === 'string' ? args.item : '';
    const seed = findSimSeedByItem(item);
    if (seed === null) return { text: `失败：商店里没有 ${item}`, isError: true };
    if (seed.season !== this.season) return { text: `失败：${item} 不是当季种子`, isError: true };
    const count = Math.max(1, Math.floor(typeof args.count === 'number' ? args.count : 1));
    const cost = seed.price * count;
    if (this.money < cost + 100) return { text: `失败：钱不够（需要 ${cost + 100}g 含预留）`, isError: true };
    if (!this.addItem(seed.name, count)) return { text: '失败：背包满了装不下种子', isError: true };
    this.money -= cost;
    this.advance(5);
    this.dayFlags.buySeeds = true;
    return { text: `买了 ${item} x${count}，花了 ${cost}g` };
  }

  private doOpenShop(): { text: string; isError?: boolean } {
    if (this.location !== 'SeedShop') return { text: '失败：不在皮埃尔的杂货店', isError: true };
    if (!this.shopOpen()) return { text: '失败：皮埃尔的杂货店现在不营业（9:00-17:00，周三休息）', isError: true };
    this.menu = '商店界面（Shop）';
    this.advance(5);
    return { text: '打开了皮埃尔的商店' };
  }

  private doPlant(args: Record<string, unknown>): { text: string; isError?: boolean } {
    if (this.location !== 'Farm') return { text: '失败：必须在农场才能播种', isError: true };
    const seedName = typeof args.seed === 'string' ? args.seed : '';
    const seed = findSimSeedByItem(seedName);
    if (seed === null) return { text: `失败：不认识种子 ${seedName}`, isError: true };
    if (!this.canMature(seed)) return { text: `失败：${seedName} 在本季结束前成熟不了`, isError: true };
    const owned = this.itemCount(seed.name);
    if (owned <= 0) return { text: `失败：背包里没有 ${seedName}`, isError: true };
    const empty = this.emptyTiles();
    const requested = typeof args.max === 'number' ? args.max : (typeof args.count === 'number' ? args.count : owned);
    const planted = Math.min(owned, empty, Math.max(1, Math.floor(requested)));
    if (planted <= 0) return { text: '失败：没有已开垦的空地', isError: true };
    this.takeItem(seed.name, planted);
    let left = planted;
    for (const tile of this.tiles) {
      if (left <= 0) break;
      if (tile.crop !== null) continue;
      tile.crop = { seed, growth: 0, need: seed.maturityDays, watered: false, ready: false };
      left -= 1;
    }
    this.advance(30);
    this.spendStamina(Math.ceil(planted / 3) + 2);
    this.dayFlags.plant = true;
    return { text: `种下了 ${planted} 株${seed.cropName}` };
  }

  private doTill(args: Record<string, unknown>): { text: string; isError?: boolean } {
    if (this.location !== 'Farm') return { text: '失败：必须在农场才能开垦', isError: true };
    const available = Math.max(0, this.arableCap - this.tiles.length);
    if (available <= 0) {
      this.advance(10);
      return { text: '没有更多可开垦的地了（农场这块地已经开满了）' };
    }
    const requested = Math.max(1, Math.floor(typeof args.count === 'number' ? args.count : 15));
    const tilled = Math.min(available, requested);
    for (let i = 0; i < tilled; i += 1) this.tiles.push({ crop: null });
    this.advance(60);
    this.spendStamina(tilled * 2);
    return { text: `开垦了 ${tilled} 格新田` };
  }

  private doFish(args: Record<string, unknown>): { text: string; isError?: boolean } {
    if (this.location !== 'Beach') return { text: '失败：必须在海滩才能钓鱼', isError: true };
    if (this.itemCount('竹鱼竿') <= 0) return { text: '失败：背包里没有鱼竿', isError: true };
    if (this.freeSlots() <= 0) return { text: '失败：背包满了，钓上来的鱼装不下', isError: true };
    const casts = Math.max(1, Math.floor(typeof args.casts === 'number' ? args.casts : 5));
    const caught = new Map<string, number>();
    for (let i = 0; i < Math.min(casts, 3); i += 1) {
      this.fishCounter += 1;
      const roll = hash32(this.seed, this.dateIndex(), this.fishCounter) % 3;
      const fish = roll === 0 ? '鲷鱼' : '沙丁鱼';
      if (this.addItem(fish, 1)) caught.set(fish, (caught.get(fish) ?? 0) + 1);
    }
    this.advance(casts * 12);
    this.spendStamina(casts + 2);
    const total = [...caught.values()].reduce((sum, count) => sum + count, 0);
    const detail = [...caught.entries()].map(([name, count]) => `${name} x${count}`).join('、');
    return { text: total > 0 ? `钓到 ${total} 条鱼：${detail}` : '这次没钓到鱼' };
  }

  private doForage(): { text: string; isError?: boolean } {
    if (this.location !== 'Town') return { text: '失败：镇上才有可采集的东西', isError: true };
    if (!this.addItem('韭葱', 2)) return { text: '失败：背包满了', isError: true };
    this.advance(30);
    this.spendStamina(4);
    return { text: '采集到 韭葱 x2' };
  }

  private doEat(args: Record<string, unknown>): { text: string; isError?: boolean } {
    const item = typeof args.item === 'string' ? args.item : '';
    if (this.takeItem(item, 1) <= 0) return { text: `失败：背包里没有 ${item}`, isError: true };
    this.stamina = Math.min(this.staminaMax, this.stamina + 40);
    this.health = Math.min(this.healthMax, this.health + 20);
    this.advance(5);
    return { text: `吃了 ${item}，恢复了体力` };
  }

  private doSleep(): { text: string; isError?: boolean } {
    const night = this.dayKey();
    this.rollDay('sleep');
    return { text: `睡了一觉（${night} 结束），${this.dayKey()} 06:00 醒来` };
  }

  // ───────────────────────── get_state 文本（真机 BWF 同格式） ─────────────────────────

  snapshot(): FarmSimSnapshot {
    return {
      year: this.year,
      season: this.season,
      day: this.day,
      weekday: this.weekday(),
      minutes: this.minutes,
      dayMinutes: this.dayMinutes(),
      weather: this.weatherForDay(0),
      money: this.money,
      stamina: this.stamina,
      staminaMax: this.staminaMax,
      health: this.health,
      healthMax: this.healthMax,
      location: this.location,
      menu: this.menu,
      unreadMail: this.unreadMail,
      bag: [...this.bag.entries()].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
      freeSlots: this.freeSlots(),
      pendingShipping: this.pendingShipping,
      tilled: this.tiles.length,
      emptyTilled: this.emptyTiles(),
      crops: this.cropTiles().length,
      needsWater: this.needsWaterCount(),
      harvestable: this.harvestableCount(),
    };
  }

  currentDay(): FarmDayRecord {
    return {
      dayKey: this.dayKey(),
      season: this.season,
      day: this.day,
      weekday: this.weekday(),
      weather: this.weatherForDay(0),
      moneyStart: this.dayStartMoney,
      moneyEnd: this.money + this.pendingShipping,
      loop: { ...this.dayFlags },
      opportunity: { ...this.dayOpportunity },
      passedOut: this.passedOut,
      forcedHome2am: this.forcedHome2am,
      actions: [...this.dayActions],
    };
  }

  private stateText(): string {
    const snap = this.snapshot();
    const hh = Math.floor(snap.minutes / 60);
    const mm = snap.minutes % 60;
    const weekday = WEEKDAYS[snap.weekday - 1] ?? 'Mon';
    const lines: string[] = [];
    lines.push('## 基本状态');
    lines.push(`时间：第${snap.year}年${snap.season}${snap.day}日 ${pad(hh)}:${pad(mm)}（${weekday}），天气：${snap.weather}，明天天气：${this.weatherForDay(1)}`);
    lines.push(`金钱：${snap.money}g  体力：${snap.stamina}/${snap.staminaMax}  生命：${snap.health}/${snap.healthMax}`);
    lines.push('## 当前界面');
    lines.push(snap.menu === '' ? '无（可以自由行动）' : snap.menu);
    lines.push('## 位置');
    const pos = LOCATION_POS[snap.location];
    lines.push(`地点：${LOCATION_LABEL[snap.location]}，${snap.location === 'FarmHouse' || snap.location === 'SeedShop' ? '室内' : '室外'}`);
    lines.push(`你站在 (${pos.x},${pos.y})`);
    if (snap.unreadMail > 0) lines.push(`邮箱里有 ${snap.unreadMail} 封未读信件`);
    if (snap.location === 'SeedShop' && !this.shopOpen()) {
      lines.push(this.weekday() === 3
        ? '皮埃尔的杂货店今天周三休息（营业时间 9:00-17:00）'
        : '皮埃尔的杂货店现在不营业（营业时间 9:00-17:00）');
    }
    lines.push('## 背包（序号: 物品）');
    let slot = 0;
    for (const tool of TOOLS) {
      if (this.itemCount(tool) <= 0) continue;
      lines.push(`${slot}: ${tool}${tool === '竹鱼竿' ? '（手持）' : ''}`);
      slot += 1;
    }
    for (const [name, count] of this.bag.entries()) {
      if ((TOOLS as readonly string[]).includes(name) || count <= 0) continue;
      lines.push(`${slot}: ${name}${count > 1 ? ` x${count}` : ''}`);
      slot += 1;
    }
    lines.push(`背包空位：${snap.freeSlots} 个（共 ${BAG_CAPACITY} 格）`);
    if (snap.location === 'Farm') {
      lines.push('## 作物（本地点全部）');
      lines.push(`（农场概况：共 ${snap.crops} 株作物，需浇水 ${snap.needsWater}，可收获 ${snap.harvestable}）`);
      lines.push(`农田：共 ${snap.tilled} 格耕地：作物 ${snap.crops}，空 ${snap.emptyTilled}`);
      if (snap.crops === 0) lines.push('无');
    }
    return lines.join('\n');
  }
}

/**
 * 启动农场仿真（活世界）。返回的 endpoint 直接喂给 `new StardewAdapter(endpoint)` /
 * `new BwfMcpClient(endpoint)`。
 */
export async function startBwfFarmSim(options: FarmSimOptions = {}): Promise<FarmSimHandle> {
  const sim = new FarmSim(options);
  const calls: ReplayCall[] = [];
  const server = await startBwfHttpServer(({ tool, args }) => sim.call(tool, args), {
    responseMode: options.responseMode,
    onCall: (call) => calls.push(call),
  });
  return {
    endpoint: server.endpoint,
    calls,
    snapshot: () => sim.snapshot(),
    days: sim.days,
    currentDay: () => sim.currentDay(),
    close: server.close,
  };
}
