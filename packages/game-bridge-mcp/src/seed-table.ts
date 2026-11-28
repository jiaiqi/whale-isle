/**
 * 季节种子表与季末成熟判断（T-M6-69，RUNBOOK-M8-STARDEW §3.5）。
 *
 * 无 LLM 时的规则日程只种「当季、且能在季末前成熟」的种子；冬季不种（只钓鱼/采集）。
 * 数值是手册初版值，**以游戏内商店为准**（价格/成熟天数随游戏版本可能变化，改这里即可）。
 *
 * 口径：
 *   - 一季 28 天；第 1 天播种、成熟天数 d 的作物在第 1+d-1 天可收（星露谷过夜生长），
 *     所以「季内剩余天数 = 28 - day + 1」且要求 `剩余天数 ≥ 成熟天数`；
 *   - 买种预算：保留 ≥ 100g，单次花费 ≤ 金币 × 60%，数量不超过已开垦空地格数。
 */
export type Season = '春' | '夏' | '秋' | '冬';

export interface SeedInfo {
  season: Season;
  /** 中文物品名（BWF buy / plant_seeds 直接可用） */
  name: string;
  /** 英文名（BWF 与攻略文本也会出现） */
  aliases: readonly string[];
  price: number;
  maturityDays: number;
  /** 可重复收获（辣椒）：收完留在地里继续长 */
  regrow: boolean;
  /** 单次收获的基础售价（普通品质，金币）；0 表示表内未收录 */
  sellPrice?: number;
  /** 收获后可继续生长的间隔天数（regrow 为 true 时有效） */
  regrowDays?: number;
  /** 加工产物（小桶/木桶/腌菜罐）与售价；未收录则省略 */
  processed?: { name: string; sellPrice: number };
}

export const DAYS_PER_SEASON = 28;
/** 买种后至少保留的金币（RUNBOOK §3.4：保留 ≥100g） */
export const SEED_RESERVE_GOLD = 100;
/** 单次买种最多花掉金币的 60% */
export const MAX_SPEND_RATIO = 0.6;

/**
 * 初版种子表（RUNBOOK §3.5）。价格/成熟天数以游戏内商店为准。
 * 只列每种季节一种「便宜、稳定」的作物；需要更多作物时在这里加，日程会自动取第一条。
 */
export const SEED_TABLE: readonly SeedInfo[] = Object.freeze([
  { season: '春', name: '防风草种子', aliases: ['Parsnip Seeds', 'ParsnipSeeds'], price: 20, maturityDays: 4, regrow: false, sellPrice: 35, processed: { name: '腌防风草', sellPrice: 78 } },
  { season: '夏', name: '辣椒种子', aliases: ['Hot Pepper Seeds', 'HotPepperSeeds'], price: 40, maturityDays: 5, regrow: true, sellPrice: 40, regrowDays: 3, processed: { name: '腌辣椒', sellPrice: 90 } },
  { season: '秋', name: '小白菜种子', aliases: ['Bok Choy Seeds', 'BokChoySeeds'], price: 50, maturityDays: 4, regrow: false, sellPrice: 80, processed: { name: '腌小白菜', sellPrice: 180 } },
]);

/** 当季种子；冬季或未知季节返回 null（不种） */
export function seedForSeason(season: string): SeedInfo | null {
  return SEED_TABLE.find((seed) => seed.season === season) ?? null;
}

/** 季内剩余天数（含当天）：第 1 天 = 28，第 28 天 = 1；非法输入按 0 处理 */
export function daysLeftInSeason(day: number): number {
  if (!Number.isFinite(day)) return 0;
  const clamped = Math.min(DAYS_PER_SEASON, Math.max(1, Math.floor(day)));
  return DAYS_PER_SEASON - clamped + 1;
}

/**
 * 今天种下去还能不能在本季内成熟（冬季一律 false）。
 * `seed` 省略时取当季种子。
 */
export function canPlantBeforeSeasonEnd(season: string, day: number, seed: SeedInfo | null = seedForSeason(season)): boolean {
  if (seed === null || seed.season !== season) return false;
  return daysLeftInSeason(day) >= seed.maturityDays;
}

/**
 * 本次最多买几颗：同时受「空地数」「保留 100g」「单次 ≤ 金币 60%」约束。
 * 返回 0 表示不该买（钱不够 / 没空地）。
 */
export function seedBudget(money: number, price: number, emptyTiles: number): number {
  if (!Number.isFinite(money) || !Number.isFinite(price) || !Number.isFinite(emptyTiles)) return 0;
  if (price <= 0 || emptyTiles <= 0) return 0;
  const safeMoney = Math.max(0, Math.floor(money));
  if (safeMoney < price + SEED_RESERVE_GOLD) return 0;
  const spendCap = Math.floor(safeMoney * MAX_SPEND_RATIO);
  const reserveCap = safeMoney - SEED_RESERVE_GOLD;
  const affordable = Math.floor(Math.min(spendCap, reserveCap) / price);
  return Math.max(0, Math.min(Math.floor(emptyTiles), affordable));
}

/** 文本是否指这颗种子（中文全名或英文别名，做包含匹配以兼容「防风草种子 x15」） */
export function seedNameMatches(seed: SeedInfo, text: string): boolean {
  if (text.includes(seed.name)) return true;
  const lower = text.toLowerCase();
  return seed.aliases.some((alias) => lower.includes(alias.toLowerCase()));
}

/** 从任意物品文本反查种子表条目；不是表内种子返回 null */
export function findSeedByName(text: string): SeedInfo | null {
  return SEED_TABLE.find((seed) => seedNameMatches(seed, text)) ?? null;
}

/**
 * 单株作物的经济事实（T3，2026-11-28）：只用表内已知数据算，缺字段就不猜。
 *
 * - `grossPerHarvest`：一次收获的毛收入（普通品质售价）
 * - `harvestsInSeason`：季内还能收几次（含首次；regrow 按间隔累加）
 * - `netPerSeason`：一株一季的净收益（毛收入 × 次数 − 种子价）
 * - `goldPerDay`：摊到每天（成熟期 + 后续间隔），便于横向比较
 *
 * 只陈述数字事实，不代表「应该种哪个」。
 */
export interface CropEconomics {
  seedName: string;
  seedPrice: number;
  maturityDays: number;
  grossPerHarvest: number | null;
  harvestsInSeason: number;
  netPerSeason: number | null;
  goldPerDay: number | null;
}

export function cropEconomics(seed: SeedInfo, day: number): CropEconomics {
  const left = daysLeftInSeason(day);
  const base: CropEconomics = {
    seedName: seed.name,
    seedPrice: seed.price,
    maturityDays: seed.maturityDays,
    grossPerHarvest: seed.sellPrice ?? null,
    harvestsInSeason: 0,
    netPerSeason: null,
    goldPerDay: null,
  };
  if (left < seed.maturityDays) return base;

  // 首次收获后：regrow 作物按 regrowDays 继续收，否则只收一次
  const regrowGap = seed.regrow ? (seed.regrowDays ?? seed.maturityDays) : 0;
  const firstHarvestDay = seed.maturityDays;
  let harvests = 1;
  if (regrowGap > 0) {
    const extra = Math.floor((left - firstHarvestDay) / regrowGap);
    harvests += Math.max(0, extra);
  }
  const gross = seed.sellPrice ?? null;
  const net = gross === null ? null : gross * harvests - seed.price;
  // 摊到「首次成熟 + 每次间隔」的等效天数上，便于跨作物比较
  const spanDays = regrowGap > 0
    ? firstHarvestDay + Math.max(0, harvests - 1) * regrowGap
    : firstHarvestDay;
  const perDay = net === null || spanDays <= 0 ? null : net / spanDays;
  return {
    ...base,
    harvestsInSeason: harvests,
    netPerSeason: net,
    goldPerDay: perDay === null ? null : Math.round(perDay * 10) / 10,
  };
}

/** 一行可注入 prompt 的经济事实；缺数据时不编造数字。 */
export function formatCropEconomics(seed: SeedInfo, day: number): string | null {
  const eco = cropEconomics(seed, day);
  if (eco.goldPerDay === null) return null;
  const regrowNote = seed.regrow && seed.regrowDays !== undefined ? `，收后每 ${seed.regrowDays} 天再收` : '';
  const processedNote = seed.processed === undefined ? '' : `；加工成${seed.processed.name}可卖 ${seed.processed.sellPrice}g`;
  return `${eco.seedName}：种子 ${eco.seedPrice}g，${eco.maturityDays} 天成熟${regrowNote}；本季还能收 ${eco.harvestsInSeason} 次，一株净收益约 ${eco.netPerSeason}g（约 ${eco.goldPerDay}g/天${processedNote}）`;
}
