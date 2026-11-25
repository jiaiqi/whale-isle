/**
 * 规则日程状态机（T-M6-69，RUNBOOK-M8-STARDEW §3.4）——从 RulePlanner 拆出的纯决策层。
 *
 * 设计原则：
 *   - **零依赖、零副作用**：只吃 ScheduleState + 已解析事实（ScheduleFacts）+ 当天完成集，
 *     返回一个动作；不 import planner（避免循环依赖），也不碰网络/时钟。
 *   - **优先级从高到低**：生存护栏 → 晨间（读信/浇水/收获）→ 出货 → 购种 → 播种/开垦
 *     → 收工（bedtime，默认 22:00）→ 填充（钓鱼/采集/求助）。
 *   - 菜单/满包救援仍留在 RulePlanner（需要它自己的救援阶梯状态），本模块只负责日程。
 *
 * 资源前置检查（RUNBOOK §3.4）：种子数、金币、体力、工具（鱼竿/锄头）、背包空位、
 * 皮埃尔营业时间、季末成熟期；任何一条不满足就跳过该步，绝不发注定失败的动作。
 */
import {
  canPlantBeforeSeasonEnd,
  seedBudget,
  seedForSeason,
  seedNameMatches,
  type SeedInfo,
} from './seed-table';

export type ScheduleStep = 'mail' | 'water' | 'harvest' | 'ship' | 'buy' | 'plant' | 'till' | 'visit' | 'tool';

/** 日程需要的最小状态面（GameStateSnapshot 结构兼容，避免跨文件类型耦合） */
export interface ScheduleState {
  raw: string;
  clockMinutes: number;
  stamina: number;
  staminaMax: number;
  health: number;
  healthMax: number;
  money: number;
  location: string;
  menu: string;
  season: string;
  day: number;
  weather: string;
  freeSlots: number;
  posX: number;
  posY: number;
}

export interface ScheduleSeedStack {
  name: string;
  count: number;
}

/** 已解析的环境事实（由 planner 用 state-hints 的解析器组装） */
export interface ScheduleFacts {
  unreadMail: number;
  cropCount: number | null;
  needsWater: number | null;
  harvestable: number | null;
  /** 已开垦空地；null = 当前地点没有农田信息（未知，不据此行动） */
  emptyTilled: number | null;
  seeds: readonly ScheduleSeedStack[];
  /** true=有鱼竿；false=明确没有；null=状态没背包段（未知） */
  hasRod: boolean | null;
  /** true=背包里有水壶；false=明确没有（真机 2026-11-25：水壶放在箱子 → 先取再浇）；null=未知 */
  hasWateringCan: boolean | null;
  /** true=背包里有锄头；false=明确没有（不开垦）；null=未知 */
  hasHoe: boolean | null;
  /** 1=周一 … 7=周日；null=状态里没有星期 */
  weekday: number | null;
  shopOpen: boolean;
  festival: string | null;
}

export interface ScheduleContext {
  state: ScheduleState;
  facts: ScheduleFacts;
  /** 当天已失败冷却的工具（RulePlanner.avoidTools） */
  avoidTools: ReadonlySet<string>;
  /** 当天已成功的日程步骤（跨日清空） */
  done: ReadonlySet<ScheduleStep>;
  /** 背包里第一个可出货物品（RulePlanner 用现有排除法挑） */
  shippable: string | null;
  /** 背包里第一个可食用物品（生存护栏用） */
  edible: string | null;
}

export interface ScheduleOptions {
  /** 收工时间（当日分钟，默认 22:00） */
  bedtimeMinutes?: number;
  /** 单次 till_area 上限（默认 15 格，避免把体力耗光） */
  tillMax?: number;
}

export type ScheduleDecision =
  | { kind: 'act'; tool: string; args: Record<string, unknown>; intent: string }
  | { kind: 'wait'; seconds: number; reason: string };

export const DEFAULT_BEDTIME_MINUTES = 22 * 60;
export const DEFAULT_TILL_MAX = 15;
/** 体力 <15% 停止干活回家；<8% 原地睡（沿用既有真机教训） */
export const STAMINA_GO_HOME_RATIO = 0.15;
export const STAMINA_SLEEP_RATIO = 0.08;
/** 没有空地时，只有体力 >40% 才开垦新田 */
export const TILL_MIN_STAMINA_RATIO = 0.4;
/** 午夜强制回家线（星露谷 24:00 = 换日前的最后一刻） */
export const MIDNIGHT_MINUTES = 24 * 60;
/**
 * 浇水工具在游戏里的名字：中文版是「喷壶」（2026-11-25 真机箱子清单：喷壶x1）。
 * take_items 必须用游戏内物品名，认错名字会被 BWF 判「箱子里都没有」，白白冷却一天。
 * 背包识别用宽松正则（水壶/喷壶都认），取回用确定名字。
 */
export const WATERING_CAN_ITEM = '喷壶';

/** 星露谷日序分钟：06:00 起算，凌晨 00:00–05:59 记为 24:00+（与 soak-real 的 dayMinutes 同口径） */
export function dayMinutesOf(clockMinutes: number): number {
  if (!Number.isFinite(clockMinutes)) return 0;
  return clockMinutes >= 6 * 60 ? clockMinutes : clockMinutes + 24 * 60;
}

function staminaRatio(state: ScheduleState): number {
  return state.staminaMax > 0 ? state.stamina / state.staminaMax : 1;
}

function healthRatio(state: ScheduleState): number {
  return state.healthMax > 0 ? state.health / state.healthMax : 1;
}

/** 雨天/雪天：作物自动喝饱，不浇水（雪天 Stardew 不会自动浇水，但户外也种不了；保守跳过） */
export function scheduleIsRaining(state: Pick<ScheduleState, 'weather'>): boolean {
  return /雨|雪/.test(state.weather);
}

/**
 * BWF 长动作执行中（sleep 最长 7 分钟、fish 数分钟）：`get_state` 顶部会写
 * 「【正在执行】<工具> 已经执行 … 做完前别的动作会被拒绝」。这时发任何动作都会被拒，
 * 连发还会把「失败」刷成卡死签名（2026-11-25 真机夏6 22:40：sleep 执行中连发 travel_to → repeat-failure）。
 * 返回 wait 让上层歇一会儿再取状态；没有执行中的动作返回 null。
 */
export function inProgressGuard(state: Pick<ScheduleState, 'raw'>): ScheduleDecision | null {
  if (!state.raw.includes('【正在执行】')) return null;
  const tool = /【正在执行】\s*([^\s（(，,]{1,24})/.exec(state.raw)?.[1] ?? '上一个动作';
  return {
    kind: 'wait',
    seconds: 15,
    reason: `BWF 正在执行「${tool}」，等它做完再决策（它结束前发动作必被拒绝）`,
  };
}

/** 体力/时间/血量护栏（优先级最高，任何阶段先判） */
export function survivalDecision(
  state: ScheduleState,
  edible: string | null,
  options: ScheduleOptions = {},
): ScheduleDecision | null {
  void options;
  const ratio = staminaRatio(state);
  // <8%：原地 sleep（BWF sleep 会自己走回农舍），绝不再硬撑
  if (ratio < STAMINA_SLEEP_RATIO) {
    return { kind: 'act', tool: 'sleep', args: {}, intent: '体力见底，马上睡觉（再也不收 50g 医疗费！）' };
  }
  // ≥24:00：强制回家睡（跨日前的最后一道线）
  if (dayMinutesOf(state.clockMinutes) >= MIDNIGHT_MINUTES) {
    return goHomeAndSleep(state, '已经过午夜了，必须马上回家睡觉（2:00 前不睡会晕倒扣钱）');
  }
  // <15%：停止干活回家（在农舍就直接睡）
  if (ratio < STAMINA_GO_HOME_RATIO) {
    return goHomeAndSleep(state, '体力不足 15%，收工回家休息（不冒险晕倒）');
  }
  // 生命 <30%：有吃的先吃，没吃的回家（沿用既有真机逻辑）
  if (healthRatio(state) < 0.3) {
    if (edible !== null) {
      return { kind: 'act', tool: 'eat', args: { item: edible }, intent: `血量见底了，先吃个${edible}回回血` };
    }
    if (state.location !== 'FarmHouse') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '血量危险又没吃的，先回家躲一躲' };
    }
    return { kind: 'act', tool: 'sleep', args: {}, intent: '血量见底，睡觉回血（明天又是好鲸）' };
  }
  return null;
}

function goHomeAndSleep(state: ScheduleState, intent: string): ScheduleDecision {
  if (state.location !== 'FarmHouse') {
    return { kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' }, intent };
  }
  return { kind: 'act', tool: 'sleep', args: {}, intent: '睡觉～晚安主人（自动结算）' };
}

function ownedSeedCount(seeds: readonly ScheduleSeedStack[], seed: SeedInfo): number {
  return seeds.reduce((sum, stack) => (seedNameMatches(seed, stack.name) ? sum + stack.count : sum), 0);
}

function avoided(avoidTools: ReadonlySet<string>, tool: string): boolean {
  return avoidTools.has(tool);
}

/** 去农场干活前先确认站对了地方（作物概况只报当前地点） */
function atFarmAction(state: ScheduleState, tool: string, args: Record<string, unknown>, intent: string): ScheduleDecision {
  if (state.location !== 'Farm') {
    return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: `先回农场：${intent}` };
  }
  return { kind: 'act', tool, args, intent };
}

/**
 * 日程主决策。返回 null 表示「今天该做的都做完了，也没有可填充的活动」——
 * RulePlanner 会落到底部 wait 求助（不产生游戏动作、不空转）。
 */
export function scheduleDecision(context: ScheduleContext, options: ScheduleOptions = {}): ScheduleDecision | null {
  const { state, facts } = context;
  const bedtime = options.bedtimeMinutes ?? DEFAULT_BEDTIME_MINUTES;
  const tillMax = options.tillMax ?? DEFAULT_TILL_MAX;
  const done = context.done;

  // 4) 晨间：读信 → 浇水（雨天跳过）→ 收获
  if (!done.has('mail') && facts.unreadMail > 0 && !avoided(context.avoidTools, 'read_mail')) {
    return { kind: 'act', tool: 'read_mail', args: {}, intent: `读信啦——有 ${facts.unreadMail} 封未读信件（说不定有鱼竿！）` };
  }
  // 作物概况只报当前地点：人在农舍时看不到作物，先去农场看一眼再决定浇不浇/收不收。
  // 收工前任何时刻都可以补这一次（T-M6-70：LLM 可能在中午/下午才把驾驶权交回规则层，
  // 必须能续上当天的浇水/收获，而不是等到第二天早上）；到点收工就不再绕路。
  // 其它地点不做这次绕路：真机里从海滩/镇上折返农场会打断当天的钓鱼/采集节奏，
  // 而农场概况一旦在农场读过就会缓存，日程后续步骤仍按缓存事实推进。
  if (!done.has('visit') && state.location === 'FarmHouse' && dayMinutesOf(state.clockMinutes) < bedtime) {
    return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: '先去农场看看作物（浇水/收获是每天的正事）' };
  }
  if (!done.has('water') && !scheduleIsRaining(state) && (facts.needsWater ?? 0) > 0
    && !avoided(context.avoidTools, 'water_crops')) {
    // 工具前置检查：背包里明确没有水壶 → 先从箱子取（BWF take_items 会自己找箱子/走过去），
    // 不让 water_crops 白白失败两次再冷却（2026-11-25 真机：水壶存在农场箱子里）。
    if (facts.hasWateringCan === false) {
      if (done.has('tool') || avoided(context.avoidTools, 'take_items')) {
        // 取不到就不硬浇：交给后续步骤，报告里如实缺「浇水」一项
      } else {
        return { kind: 'act', tool: 'take_items', args: { item: WATERING_CAN_ITEM }, intent: '浇水前先把喷壶从箱子里取回来' };
      }
    } else {
      return atFarmAction(state, 'water_crops', {}, `给 ${facts.needsWater} 株作物浇水——今天浇了才算长一天`);
    }
  }
  if (!done.has('harvest') && (facts.harvestable ?? 0) > 0 && !avoided(context.avoidTools, 'harvest_crops')) {
    return atFarmAction(state, 'harvest_crops', {}, '收获成熟的作物！');
  }

  // 5) 出货：背包里有可卖物就放进出货箱（每成功一次物品减少，天然收敛）
  if (context.shippable !== null && !avoided(context.avoidTools, 'ship_items')) {
    return { kind: 'act', tool: 'ship_items', args: { item: context.shippable }, intent: `把${context.shippable}放进出货箱换米` };
  }

  // 6) 购种：营业中 + 季内能成熟 + 钱够 + 有已开垦空地 + 背包种子 < 空地数
  const buy = buySeedsDecision(context);
  if (buy !== null) return buy;

  // 7) 播种：有当季种子且有已开垦空地；没有空地且体力 >40% 才开垦（有上限）
  const plant = plantDecision(context);
  if (plant !== null) return plant;
  const till = tillDecision(context, tillMax);
  if (till !== null) return till;

  // 9) 收工：bedtime（默认 22:00）回家睡觉。放在填充前——到点就不再接新活。
  if (dayMinutesOf(state.clockMinutes) >= bedtime) {
    return goHomeAndSleep(state, `到收工时间了（${Math.floor(bedtime / 60)}:00），回家睡觉`);
  }

  // 8) 填充：有鱼竿钓鱼，否则采集；都被避开 → 求助（wait 不产生游戏动作）
  return fillDecision(context);
}

function buySeedsDecision(context: ScheduleContext): ScheduleDecision | null {
  const { state } = context;
  if (context.done.has('buy') || avoided(context.avoidTools, 'buy')) return null;
  const intent = buySeedsIntent(context);
  if (intent === null) return null;
  if (state.location !== 'SeedShop') {
    return {
      kind: 'act',
      tool: 'travel_to',
      args: { location: 'SeedShop' },
      intent: `去皮埃尔杂货店买 ${intent.count} 份${intent.seed.name}`,
    };
  }
  // 到了店里但还没开商店界面 → open_shop（BWF 语义：buy 必须在已打开的商店里）
  if (!/商店|Shop/.test(state.menu)) {
    if (avoided(context.avoidTools, 'open_shop')) return null;
    return {
      kind: 'act',
      tool: 'open_shop',
      args: {},
      intent: `打开皮埃尔的商店（买 ${intent.count} 份${intent.seed.name}）`,
    };
  }
  return buyAction(intent.seed, intent.count);
}

function buyAction(seed: SeedInfo, count: number): ScheduleDecision {
  return {
    kind: 'act',
    tool: 'buy',
    args: { item: seed.name, count },
    intent: `买 ${count} 份${seed.name}（留足 100g，最多花金币的 60%）`,
  };
}

/**
 * 购种意图（只做资源前置检查，不关心位置/界面）：
 * 营业中 + 当季种子季末前能成熟 + 有已开垦空地 + 背包种子 < 空地 + 预算够。
 * RulePlanner 用它判断「这个商店界面是不是我们主动开的」——是就先买，别当误开界面关掉。
 */
export function buySeedsIntent(context: ScheduleContext): { seed: SeedInfo; count: number } | null {
  const { state, facts } = context;
  if (!facts.shopOpen) return null;
  const seed = seedForSeason(state.season);
  if (seed === null || !canPlantBeforeSeasonEnd(state.season, state.day, seed)) return null;
  if (facts.emptyTilled === null || facts.emptyTilled <= 0) return null;
  const owned = ownedSeedCount(facts.seeds, seed);
  if (owned >= facts.emptyTilled) return null;
  const count = seedBudget(state.money, seed.price, facts.emptyTilled - owned);
  if (count <= 0) return null;
  return { seed, count };
}

/** 已打开的商店界面里直接买种（RulePlanner 在 handleMenu 之前调用） */
export function shopBuyDecision(context: ScheduleContext): ScheduleDecision | null {
  if (!/商店|Shop/.test(context.state.menu)) return null;
  if (context.done.has('buy') || avoided(context.avoidTools, 'buy')) return null;
  const intent = buySeedsIntent(context);
  return intent === null ? null : buyAction(intent.seed, intent.count);
}

function plantDecision(context: ScheduleContext): ScheduleDecision | null {
  const { state, facts } = context;
  if (context.done.has('plant') || avoided(context.avoidTools, 'plant_seeds')) return null;
  const seed = seedForSeason(state.season);
  if (seed === null || !canPlantBeforeSeasonEnd(state.season, state.day, seed)) return null;
  const owned = ownedSeedCount(facts.seeds, seed);
  if (owned <= 0) return null;
  if (facts.emptyTilled === null || facts.emptyTilled <= 0) return null;
  return atFarmAction(state, 'plant_seeds', { seed: seed.name, max: Math.min(owned, facts.emptyTilled) },
    `播种 ${Math.min(owned, facts.emptyTilled)} 格${seed.name}（季末前能成熟）`);
}

function tillDecision(context: ScheduleContext, tillMax: number): ScheduleDecision | null {
  const { state, facts } = context;
  if (context.done.has('till') || avoided(context.avoidTools, 'till_area')) return null;
  // 只有「明确没有已开垦空地」才开垦；未知（不在农场/状态没农田段）不动手
  if (facts.emptyTilled !== 0) return null;
  // 工具前置检查：明确没有锄头 → 开垦必然失败，干脆不开
  if (facts.hasHoe === false) return null;
  if (staminaRatio(state) <= TILL_MIN_STAMINA_RATIO) return null;
  const seed = seedForSeason(state.season);
  if (seed === null || !canPlantBeforeSeasonEnd(state.season, state.day, seed)) return null;
  // 种子还没种完就先种，别急着扩大农场
  if (ownedSeedCount(facts.seeds, seed) > 0) return null;
  // 开垦后至少要买得起一颗种子，否则白耗体力
  if (seedBudget(state.money, seed.price, 1) < 1) return null;
  return atFarmAction(state, 'till_area', { count: tillMax }, `没有空地了，先开垦最多 ${tillMax} 格新田（体力还够）`);
}

function fillDecision(context: ScheduleContext): ScheduleDecision | null {
  const { state, facts } = context;
  const canFish = facts.hasRod !== false && !avoided(context.avoidTools, 'fish');
  if (canFish && state.freeSlots > 0) {
    if (state.location !== 'Beach') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'Beach' }, intent: '去海滩钓鱼赚米！' };
    }
    return { kind: 'act', tool: 'fish', args: { casts: 5 }, intent: '钓鱼赚米！这可是正经的生产活动（傲娇）' };
  }
  if (!avoided(context.avoidTools, 'forage')) {
    if (state.location !== 'Town') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'Town' }, intent: '去镇上采集/翻垃圾桶（小鲸的侦察行动）' };
    }
    return { kind: 'act', tool: 'forage', args: {}, intent: '采集时间～顺便翻翻垃圾桶' };
  }
  return {
    kind: 'wait',
    seconds: 60,
    reason: '钓鱼和采集都被判定不可行（没鱼竿/背包满/连续失败）——需要主人看看工具或背包；规则模式暂停动作，不空转',
  };
}
