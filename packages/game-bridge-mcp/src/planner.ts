/**
 * Planner 接口与规则实现（T-M5-02）。
 * 三实现可切换（ARCHITECTURE 三轨计划）：
 *   - RulePlanner：确定性日程（无需 LLM，7×24 可跑——当前默认）
 *   - LlmPlanner：model-gateway 驱动（用户配 key 后启用）
 *   - 远程指令信箱：人工插队 P0（Shell 聊天/WebUI）
 * 行为须匹配桌宠人格：决策结果附 intent（用于台词/情绪联动，persona-brain 消费）。
 */
import {
  inProgressGuard,
  scheduleDecision,
  shopBuyDecision,
  survivalDecision,
  type ScheduleContext,
  type ScheduleFacts,
  type ScheduleOptions,
  type ScheduleStep,
} from './rule-schedule';
import { hasToolInBag, parseFarmSummary, parseSeedInventory, parseWeekday, seedShopStatus, type FarmSummary } from './state-hints';

export interface GameStateSnapshot {
  raw: string;
  gameClock: string; // 「第1年春16日 06:00」
  clockMinutes: number; // 当日分钟
  stamina: number;
  staminaMax: number;
  money: number;
  location: string;
  menu: string; // 当前界面（空 = 自由行动）
  season: string;
  day: number;
  /** 背包剩余空位（真机 2026-11-22 教训：空位 0 时钓鱼必失败，必须先整理/出货） */
  freeSlots: number;
  /** 玩家当前格坐标（place_item 需要 x/y；拿不到时 -1） */
  posX: number;
  posY: number;
  /** 天气（T-M6-14）：「晴 / 下雨 / 刮风 / 雪」——雨天作物自动喝饱不用浇 */
  weather: string;
  /** 生命（T-M6-14）：矿洞/战斗后血线护栏用 */
  health: number;
  healthMax: number;
  /** 今日生日村民（T-M6-14 解析；生日送礼 8 倍好感属 T-M6-16 社交工单消费） */
  birthday: string | null;
  /** 今日节日名（T-M6-14）：「节日 无」→ null；BWF 另有「今天是X：建议参加…{起}-{止}」入场窗口提示行 */
  festival: string | null;
}

/** 雨天（含雷雨/雪天视同）：不用浇水，把时间花在别处 */
export function isRaining(state: Pick<GameStateSnapshot, 'weather'>): boolean {
  return /雨|雪/.test(state.weather);
}

export function parseGameState(raw: string): GameStateSnapshot {
  const clockM = /时间：(第\d+年[春夏秋冬]\d+日) (\d{2}):(\d{2})/.exec(raw);
  const staminaM = /体力：(\d+)\/(\d+)/.exec(raw);
  const healthM = /生命：(\d+)\/(\d+)/.exec(raw);
  const moneyM = /金钱：(\d+)g/.exec(raw);
  const locM = /地点：([^\s（，。]+)/.exec(raw);
  const menuM = /## 当前界面\n([\s\S]*?)(?=\n## |\n\n|$)/.exec(raw);
  const freeM = /背包空位：(\d+)\s*个/.exec(raw);
  const posM = /你站在 \((\d+),(\d+)\)/.exec(raw);
  const weatherM = /天气：([^，,\n]+)/.exec(raw);
  // 「今日：」行可能带生日括注（好感 8 倍说明），两个字段都限定在该行内解析，避免误吃别的「节日」字样
  const todayLine = /^.*今日：.*$/m.exec(raw)?.[0] ?? '';
  const seasonM = /第\d+年(春|夏|秋冬|秋|冬)?/.exec(clockM?.[1] ?? '');
  const dayM = /年[春夏秋冬](\d+)日/.exec(clockM?.[1] ?? '');
  const hh = Number(clockM?.[2] ?? '6');
  const mm = Number(clockM?.[3] ?? '0');
  const birthdayRaw = /生日 ([^（；;\n]+)/.exec(todayLine)?.[1]?.trim() ?? '无';
  const festivalRaw = /节日 (无|[^（；\n]+)/.exec(todayLine)?.[1]?.trim() ?? '无';
  return {
    raw,
    gameClock: clockM?.[0]?.slice(3) ?? '未知',
    clockMinutes: hh * 60 + mm,
    stamina: Number(staminaM?.[1] ?? 100),
    staminaMax: Number(staminaM?.[2] ?? 270),
    money: Number(moneyM?.[1] ?? 0),
    location: locM?.[1] ?? '未知',
    menu: (menuM?.[1] ?? '').trim(),
    season: seasonM?.[1] ?? '春',
    day: Number(dayM?.[1] ?? 1),
    freeSlots: Number(freeM?.[1] ?? 12), // 状态没报背包 → 视为有位置（不阻塞）
    posX: Number(posM?.[1] ?? -1),
    posY: Number(posM?.[2] ?? -1),
    weather: (weatherM?.[1] ?? '').trim(),
    health: Number(healthM?.[1] ?? 100),
    healthMax: Number(healthM?.[2] ?? 100),
    birthday: birthdayRaw === '' || birthdayRaw === '无' ? null : birthdayRaw,
    festival: festivalRaw === '' || festivalRaw === '无' ? null : festivalRaw,
  };
}

/**
 * 背包救援工具（T-M5-18，参考 BWF `GameActions.Tidy.cs` 与 feiyuos-stardew-ai-farmer LESSONS）：
 *   - 出货按「排除法 + 值钱线索」：工具/种子/肥料/鱼饵/炸弹/花束/吊坠/家具/任务物品绝不卖；
 *   - 背包满时优先 ship_items（有无箱子都能用，且能赚钱）；没有可卖物再 eat/trash 腾位；
 *   - ~~禁止满包 craft~~（2026-11-22 BWF GameActions.cs 源码实证推翻：BWF Craft 满包直接拒绝
 *     且不消耗材料「材料不够或背包满了」，feiyu「合成物掉地上」对 BWF 不适用——
 *     满包自救改为先腾一格（卖/扔低价值材料）再 craft Chest，见 llm-planner case 7）。
 */
const KEEP_TAG_RE = /【(?:留着|保留)[^】]*】/;
const NON_SELLABLE_RE = new RegExp(
  `${KEEP_TAG_RE.source}|种子|肥料|鱼饵|鱼钩|浮标|炸弹|花束|吊坠|^(?:斧头|锄头|喷壶|水壶|十字镐|镐子|镰刀|鱼竿|竹鱼竿|剑|刀)|窗户|椅子|桌子|床|灯|地毯|壁纸|地板|柜|架子|机器|熔炉|洒水器|稻草人|箱子|酒桶|罐头|火炉|壁炉|电视|沙发|盆栽`,
);
/** 值钱/可卖线索（真机教训：家具类 ship 会被 BWF 拒绝，优先挑鱼/采集/矿物） */
const SELLABLE_HINT_RE =
  /鱼|虾|蟹|蛤|牡蛎|海草|珊瑚|贝|鲤|鲈|鲱|鲷|鳗|沙丁|鳟|鲑|鳅|花|莓|韭|蕨|蘑菇|矿石|宝石|钻石|石英|水晶|煤|铜|铁|金/;
/** 工具/消耗品识别（最后手段垃圾化时保护） */
const ESSENTIAL_RE = /种子|肥料|鱼饵|鱼钩|浮标|炸弹|花束|吊坠|^(?:斧头|锄头|喷壶|水壶|十字镐|镐子|镰刀|鱼竿|竹鱼竿|剑|刀)/;

/** 从状态行提取干净物品名：剥标签、去数量（「沙丁鱼 x3 金星」→「沙丁鱼」） */
export function cleanItemName(text: string): string {
  return text
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s*x\d+\b/gi, ' ')
    .replace(/\s*(?:金星|银星|铱星)\s*/g, ' ')
    .replace(/[（(]手持[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 背包段逐行物品文本迭代器（序号: 物品）——救援/预留策略共用 */
export function* inventoryTexts(raw: string): Generator<string> {
  for (const line of raw.split('\n')) {
    const m = /^\d+:\s*(.+)$/.exec(line.trim());
    if (m) yield m[1] ?? '';
  }
}

function listShippable(raw: string): string[] {
  const scored: { name: string; score: number; order: number }[] = [];
  let order = 0;
  for (const text of inventoryTexts(raw)) {
    order++;
    if (NON_SELLABLE_RE.test(text)) continue;
    const name = cleanItemName(text);
    if (name === '') continue;
    const score = SELLABLE_HINT_RE.test(name) ? 2 : /\[可食用/.test(text) ? 1 : 0;
    scored.push({ name, score, order });
  }
  scored.sort((a, b) => b.score - a.score || b.order - a.order);
  return scored.map((s) => s.name);
}

/** 从状态背包段挑一个可出货物品（值钱线索优先；跳过工具/种子/家具/任务物品） */
export function pickShippableItem(raw: string): string | null {
  return listShippable(raw)[0] ?? null;
}

/** 全部候选（供救援阶梯跳过被 BWF 拒绝的单品） */
export function listShippableItems(raw: string): string[] {
  return listShippable(raw);
}

/** 挑一个可食用物品（`[可食用 +N 体力]` 标记；**跳过【留着】任务物品**——BWF 会拒绝） */
export function pickEdible(raw: string): string | null {
  return listEdibleItems(raw)[0] ?? null;
}

/** 全部可食用候选（救援阶梯跳过被 BWF 拒绝的单品） */
export function listEdibleItems(raw: string): string[] {
  const out: string[] = [];
  for (const text of inventoryTexts(raw)) {
    if (!/\[可食用/.test(text)) continue;
    if (KEEP_TAG_RE.test(text)) continue;
    const name = cleanItemName(text);
    if (name !== '') out.push(name);
  }
  return out.reverse(); // 最近捡的优先
}

/** 挑一件真垃圾（报纸/破眼镜/浮木/垃圾类；跳过任务物品）——只用于腾位，不卖钱 */
export function pickTrash(raw: string): string | null {
  let candidate: string | null = null;
  for (const text of inventoryTexts(raw)) {
    if (KEEP_TAG_RE.test(text)) continue;
    if (!/垃圾|报纸|破眼镜|浮木|破损|旧鞋|Joja可乐罐/.test(text)) continue;
    const name = cleanItemName(text);
    if (name !== '') candidate = name;
  }
  return candidate;
}

/** 最后手段：任何非工具、非任务、非消耗品的东西（宁可丢一件家具也别卡死） */
export function pickAnyNonEssential(raw: string, rejected?: ReadonlySet<string>): string | null {
  let candidate: string | null = null;
  for (const text of inventoryTexts(raw)) {
    if (KEEP_TAG_RE.test(text)) continue;
    if (ESSENTIAL_RE.test(text)) continue;
    if (/\[可食用/.test(text)) continue; // 能吃的留给 eat 阶段
    const name = cleanItemName(text);
    if (name !== '' && !(rejected?.has(name) ?? false)) candidate = name;
  }
  return candidate;
}

/**
 * 比家具更低的最后兜底：BWF 明确建议「能扔的不值钱的东西：鱼饵」时，允许丢消耗品换一格。
 * 只在不值钱物品也被拒绝（如贵重家具）后使用；仍不碰工具与任务物品。
 */
export function pickTrashableFallback(raw: string, rejected?: ReadonlySet<string>): string | null {
  let candidate: string | null = null;
  for (const text of inventoryTexts(raw)) {
    if (KEEP_TAG_RE.test(text)) continue;
    if (/^(?:斧头|锄头|喷壶|十字镐|镐子|镰刀|鱼竿|竹鱼竿|剑|刀)/.test(text)) continue;
    const name = cleanItemName(text);
    if (name === '' || (rejected?.has(name) ?? false)) continue;
    if (/鱼饵|种子|肥料|垃圾/.test(name)) candidate = name;
  }
  return candidate;
}

/** 家具关键词（背包只剩家具时的摆放腾格；reference BWF place_item） */
const FURNITURE_RE = /窗|桌|椅|床|灯|地毯|壁纸|地板|柜|架子|挂画|画|盆栽|装饰|沙发|电视|壁炉|火炉|浴缸|梳妆|镜子|屏风|雕像|鱼缸|水族箱|玩偶|抱枕|窗帘/;

/** 挑一件可摆放的家具（跳过任务物品/工具/可食用/耗材） */
export function pickFurnitureToPlace(raw: string, rejected?: ReadonlySet<string>): string | null {
  let candidate: string | null = null;
  for (const text of inventoryTexts(raw)) {
    if (KEEP_TAG_RE.test(text)) continue;
    if (ESSENTIAL_RE.test(text)) continue;
    if (/\[可食用/.test(text)) continue;
    if (!FURNITURE_RE.test(text)) continue;
    const name = cleanItemName(text);
    if (name !== '' && !(rejected?.has(name) ?? false)) candidate = name;
  }
  return candidate;
}

/** 背包扩容提示：`背包扩到 24 格：2000g` → { capacity, cost } */
export function parseBackpackUpgrade(raw: string): { capacity: number; cost: number } | null {
  const m = /背包扩到\s*(\d+)\s*格[：:]\s*(\d+)\s*g/.exec(raw);
  if (!m?.[1] || m[2] === undefined) return null;
  return { capacity: Number(m[1]), cost: Number(m[2]) };
}

/** 杂货店柜台背包交互点：`[BuyBackpack] [interact]：(7,18)` */
export function findBuyBackpackSpot(raw: string): { x: number; y: number } | null {
  const m = /\[BuyBackpack\][^\n]*?\((\d+)\s*,\s*(\d+)\)/.exec(raw);
  if (!m?.[1] || m[2] === undefined) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** 从 BWF 文字地图找最近的树/树桩/大树（T/t/R），返回世界坐标；找不到返回 null */
export function findNearestTree(raw: string, px: number, py: number): { x: number; y: number } | null {
  const section = /## 文字地图([\s\S]*?)(?=\n## |$)/.exec(raw)?.[1];
  if (section === undefined) return null;
  const origin = /左上角坐标=\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(section);
  if (origin?.[1] === undefined || origin[2] === undefined) return null;
  const x0 = Number(origin[1]);
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (const line of section.split('\n')) {
    const rowMatch = /^\s*(-?\d+)\s+(.*)$/.exec(line);
    if (rowMatch?.[1] === undefined || rowMatch[2] === undefined) continue;
    // 行首数字就是绝对 y（真机表头 origin=(55,6) 时首行标 6），不能再加 y0
    const y = Number(rowMatch[1]);
    const map = rowMatch[2];
    for (let i = 0; i < map.length; i += 1) {
      const ch = map[i];
      if (ch !== 'T' && ch !== 't' && ch !== 'R') continue;
      const x = x0 + i;
      const distance = Math.abs(x - px) + Math.abs(y - py);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x, y };
      }
    }
  }
  return best;
}

/** 背包里木材数量（Chest 配方需要 50） */
export function countWood(raw: string): number {
  for (const text of inventoryTexts(raw)) {
    if (!/木材/.test(text)) continue;
    const m = /x(\d+)/i.exec(text);
    return m?.[1] === undefined ? 1 : Number(m[1]);
  }
  return 0;
}

/**
 * 满包造箱自救的牺牲格（2026-11-22 用户指令「应该造箱子腾背包空间」）：
 * BWF GameActions.cs 实证——Craft 满包直接拒绝且不耗材（「材料不够或背包满了」），
 * 所以先 trash 整格低价值材料腾一格再 craft。优先 BWF 官方建议的「石头、泥土、杂物」；
 * 绝不碰木材本身（马上要用 50 木造箱）、【留着】、可食用（留给 eat 档）与家具（留给 place 档）。
 */
export function pickChestSacrifice(raw: string): string | null {
  let candidate: string | null = null;
  for (const text of inventoryTexts(raw)) {
    if (KEEP_TAG_RE.test(text)) continue;
    if (/木材/.test(text)) continue;
    if (ESSENTIAL_RE.test(text)) continue;
    if (/\[可食用/.test(text)) continue;
    if (FURNITURE_RE.test(text)) continue;
    const name = cleanItemName(text);
    if (name === '') continue;
    // BWF 拒扔贵重物时点名的低价值材料：石头、泥土、杂物——扔整格换一个箱子最划算
    if (/石头|石料|黏土|粘土|泥土|纤维|树液|树胶/.test(name)) return name;
    if (candidate === null && /垃圾|报纸|Joja|浮木|破/.test(name)) candidate = name;
  }
  return candidate;
}

/**
 * 满包全预留绝境的牺牲格（2026-11-22 真机现场实证：木材 x22<50 且全部非工具物品带【留着】，
 * pickChestSacrifice 被 KEEP_TAG 全挡 → 无牺牲格可用）：只在【留着】里挑**可再生**的——
 * 可食用鱼优先（天天钓得到，走 BWF eat force 还能回体力）；其次海边采集（牡蛎/蚌/蛤，
 * 海滩走一圈就有）走 trash force。绝不碰木材/石头（那是攒箱子的本钱）。
 * 没有可再生预留物 → null（保留到底部 wait 求助，此时背包全是工具+囤货，人手才解得开）。
 */
export function pickRenewableReserved(raw: string): { item: string; mode: 'eat' | 'trash' } | null {
  let trashCandidate: { item: string; mode: 'trash' } | null = null;
  for (const text of inventoryTexts(raw)) {
    if (!KEEP_TAG_RE.test(text)) continue;
    const name = cleanItemName(text);
    if (name === '') continue;
    if (/木材|石头/.test(name)) continue;
    if (/\[可食用/.test(text)) return { item: name, mode: 'eat' };
    if (trashCandidate === null && /牡蛎|蚌|蛤|贝壳|珊瑚/.test(name)) trashCandidate = { item: name, mode: 'trash' };
  }
  return trashCandidate;
}

/** 从文字地图找离玩家最近的空地 `.`（place_item 目标格；地图被省略时返回 null） */
export function findFreeTile(raw: string, posX: number, posY: number): { x: number; y: number } | null {
  const header = /左上角坐标=\((\d+),(\d+)\)/.exec(raw);
  if (!header?.[1] || header[2] === undefined) return null;
  const x0 = Number(header[1]);
  const y0 = Number(header[2]);
  const mapStart = raw.indexOf('## 文字地图');
  if (mapStart < 0) return null;
  let best: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of raw.slice(mapStart).split('\n').slice(1)) {
    const m = /^\s*(\d+)\s(\S.*)$/.exec(line);
    if (!m?.[1] || m[2] === undefined) continue;
    const y = Number(m[1]);
    const row = m[2];
    for (let index = 0; index < row.length; index++) {
      if (row[index] !== '.') continue;
      const x = x0 + index;
      const distance = Math.abs(x - posX) + Math.abs(y - posY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x, y };
      }
    }
  }
  return best;
}

/** 背包里是否已有箱子（Chest） */
export function hasChestItem(raw: string): boolean {
  for (const text of inventoryTexts(raw)) {
    if (KEEP_TAG_RE.test(text)) continue;
    // 中文物品名是「宝箱」不是「箱子」（真机 2026-11-23 春23：bag 里有宝箱却去砍树）
    if (/^(?:宝箱|箱子|木箱|Chest)/i.test(cleanItemName(text))) return true;
  }
  return false;
}

export type PlannerDecision =  | { kind: 'act'; tool: string; args: Record<string, unknown>; intent: string }
  | { kind: 'wait'; seconds: number; reason: string }
  | { kind: 'stop'; reason: string };

export interface Planner {
  readonly name: string;
  decide(state: GameStateSnapshot): Promise<PlannerDecision>;
  /** 可选：团队/主人下达的当前目标（不替代工具白名单与安全护栏；规则规划器可忽略） */
  setObjective?(objective: string | null): void;
  /** 可选：当前是否真的还有目标（宿主播报取消/替换前先核实，不报假状态） */
  hasObjective?(): boolean;
  /** 可选：动作成功收尾后确认目标达成（T-M6-57），返回已结束的目标文本 */
  consumeObjectiveDone?(): string | null;
  /** 可选：objectiveDone 动作失败时撤回「完成」声明，目标继续推进 */
  restoreObjectiveDone?(): void;
  /** 可选：编排器回执反馈（规则兜底据此做失败升级，避免离线模式死循环） */
  observeReceipt?(tool: string, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR', summary: string): void;
  /**
   * 可选：只读调试快照（冷却表 / rescueTried / avoidTools / objective）。
   * 供 soak:real 卡死现场包落盘；实现必须无副作用、不改变任何内部状态。
   */
  debugSnapshot?(): Record<string, unknown>;
}

/** 满包救援工具集合：只有这些工具的回执会推进规则模式的救援阶梯 */
const RESCUE_TOOLS = new Set([
  'tidy_backpack', 'ship_items', 'store_items', 'donate_bundles', 'craft', 'place_item', 'trash_item', 'interact',
]);

/**
 * 环境级失败：换模型/重试都不会消失（缺工具/缺材料/地点不对）。
 * 规则日程必须立刻绕开，否则「没鱼竿 → 规则日程又选 fish」会无限空转（2026-11-24 真机）。
 */
const ENV_FAIL_RE = /没有鱼竿|没有(?:能用的)?(?:镐|斧头|斧|锄头|锄|喷壶|工具)|需要先(?:拿到|装备|买)|材料不够|材料不足|这里没有箱子/;

/** 生存类工具：失败一次仍应重试（体力见底/菜单挡住），不参与「连败当日跳过」 */
const SURVIVAL_TOOLS: ReadonlySet<string> = new Set([
  'eat', 'sleep', 'travel_to', 'dialogue', 'close_menu', 'skip_event', 'set_name', 'wait',
]);

/**
 * 背包里是否有鱼竿（中文「鱼竿/钓竿」或英文 Rod 都认）。
 * 返回 null 表示状态里没有背包段（未知，不阻断日程）；false 才表示「明确没有鱼竿」。
 * 2026-11-24 真机：夏2日 Beach 没鱼竿仍反复 fish，靠这条前置检查在规则侧直接转采集。
 */
export function hasFishingRod(raw: string): boolean | null {
  const bagStart = raw.indexOf('## 背包');
  if (bagStart < 0) return null;
  const rest = raw.slice(bagStart + 4);
  const nextSection = rest.indexOf('\n## ');
  const bag = nextSection < 0 ? rest : rest.slice(0, nextSection);
  return /鱼竿|钓竿|Rod/i.test(bag);
}

/** 对话框/菜单优先处理表（BWF 语义：有界面时其他动作会被拒绝） */
function handleMenu(state: GameStateSnapshot): PlannerDecision | null {
  const menu = state.menu;
  if (menu === '' || /无（可以自由行动）/.test(menu)) return null;
  // 选择题必须先于剧情判断：BWF 的剧情选项文本里同样含「剧情」，但必须带 choice 序号（0 基）。
  if (/起名字|set_name/.test(menu)) {
    return { kind: 'act', tool: 'set_name', args: { name: '小鲸' }, intent: '给小家伙起名叫小鲸' };
  }
  if (/选项|选择题/.test(menu)) {
    const first = /(\d+)\s*[:：]/.exec(menu);
    const choice = first?.[1] === undefined ? 0 : Number(first[1]);
    return { kind: 'act', tool: 'dialogue', args: { choice }, intent: `做选择题（选项 ${choice}）` };
  }
  if (/剧情|节日事件/.test(menu)) return { kind: 'act', tool: 'dialogue', args: {}, intent: '推进剧情对话' };
  if (/商店|Shop/.test(menu)) return { kind: 'act', tool: 'close_menu', args: {}, intent: '关掉误开的商店界面' };
  // 每日出货结算界面（2026-11-25 真机夏7 06:00）：这是「确认提示」不是对话，`dialogue` 会报
  // 「现在没有对话框」连败三次并触发 watchdog；BWF 的 close_menu 语义就是关闭/确认提示。
  if (/出货结算|结算界面|结算画面/.test(menu)) {
    return { kind: 'act', tool: 'close_menu', args: {}, intent: '确认每日出货结算界面' };
  }
  return { kind: 'act', tool: 'dialogue', args: {}, intent: '推进当前界面' };
}

/**
 * RulePlanner：确定性日程（T-M6-69：无 LLM 也能独立完成每日闭环）。
 *
 * 决策顺序（RUNBOOK-M8-STARDEW §3.4）：
 *   1. 我们主动打开的商店界面 → 先买种（BWF 语义：buy 必须在已打开的商店里）
 *   2. 菜单/剧情/过场 → handleMenu
 *   3. 生存护栏：体力 <15% 回家、<8% 原地睡、≥24:00 强制回家睡、生命 <30%（沿用）
 *   4. 背包空位 0 → 有界救援阶梯（ship → donate → place/trash → tidy 一次 → wait 求助）
 *   5. 日程（rule-schedule.ts）：读信 → 浇水（雨天跳过）→ 收获 → 出货 → 购种 →
 *      播种/开垦 → 22:00 收工 → 钓鱼/采集填充（都被避开则 wait 求助）
 *
 * 与 RUNBOOK 的唯一次序差异：**有界面时先处理界面**。BWF 在界面打开时会拒绝其他动作，
 * 先走生存/日程只会连续 FAILED（真机 S03 教训）；无界面时生存护栏仍严格优先于日程。
 *
 * 体力 <8% → 原地睡（BWF sleep 自己走回农舍）；8%~15% → 回家再睡；22:00 收工可配置。
 */
export class RulePlanner implements Planner {
  readonly name = 'rule-schedule';
  private phase = 'farm-work';
  /** 日键（季节+日）：BWF 的 day 换季会回到 1，只比 day 会把春28→夏1 当成同一天 */
  private lastDayKey = '';
  /** 上次解析到的背包空位（BWF get_state 会省掉未变化段落，不能把「省略」当「有空位」） */
  private lastFreeSlots: number | null = null;
  private furniturePlaceTried = false;
  /** 满包救援阶梯（T-M6-10 真机：tidy 无箱子必败，连续失败会空转） */
  private rescueTried = new Set<string>();
  private lastRescueFail = '';
  /**
   * 工具级失败记忆（2026-11-24 真机死循环修复）：所有工具（不只满包救援工具）的失败都要记账。
   * LlmPlanner 的 repeated 护栏会把决策退回规则日程，规则若不知道 fish 刚失败就会继续 fish。
   */
  private readonly failStreak = new Map<string, number>();
  /** 当天避开不再尝试的工具（环境级失败一次即避开，普通失败连续两次避开；成功一次解除） */
  private readonly avoidTools = new Set<string>();
  /** 当天已完成的日程步骤（跨日重置；只认 COMPLETED 回执，N/A 不在此集合里） */
  private readonly dayDone = new Set<ScheduleStep>();
  /**
   * 最近一次在农场解析到的作物概况。BWF 的「作物」段只报当前地点，
   * 离开农场后（海滩/商店）必须沿用这份缓存才能决定要不要回去播种/开垦。
   */
  private lastFarm: FarmSummary | null = null;

  constructor(private readonly scheduleOptions: ScheduleOptions = {}) {}

  observeReceipt(tool: string, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR', summary: string): void {
    // T-M6-52：先记工具级失败——规则兜底也必须换做法，不能只记住满包救援工具。
    // 生存类工具（吃饭/睡觉/赶路/界面）失败一次不代表该放弃（体力见底、菜单挡住都需要重试），
    // 因此只对非生存类工具做「连败 ≥2 当日跳过」；生存类仍由各自分支的确定性兜底处理。
    if (status === 'COMPLETED') {
      this.failStreak.delete(tool);
      this.avoidTools.delete(tool);
      const step = COMPLETED_STEP_BY_TOOL[tool];
      if (step !== undefined) this.dayDone.add(step);
    } else {
      // 决策时乐观记的日程步骤遇到失败要撤销，允许当天换个时机重试
      const step = COMPLETED_STEP_BY_TOOL[tool];
      if (step !== undefined) this.dayDone.delete(step);
    }
    if ((status === 'FAILED' || status === 'ERROR' || status === 'TIMEOUT') && !SURVIVAL_TOOLS.has(tool)) {
      const streak = (this.failStreak.get(tool) ?? 0) + 1;
      this.failStreak.set(tool, streak);
      if (streak >= 2 || ENV_FAIL_RE.test(summary)) this.avoidTools.add(tool);
    }
    if (!RESCUE_TOOLS.has(tool)) return;
    if (status === 'COMPLETED') {
      this.rescueTried.clear();
      this.lastRescueFail = '';
      return;
    }
    this.lastRescueFail = `${tool}:${status}${summary === '' ? '' : `（${summary.slice(0, 60)}）`}`;
    this.rescueTried.add(tool);
  }

  /**
   * 只读调试快照（T-M6-67）：冷却表 / rescueTried / avoidTools / objective。
   * 现场包在卡死瞬间落盘，绝不改状态。RulePlanner 不消费 objective，固定为 null。
   */
  debugSnapshot(): Record<string, unknown> {
    const sortedObject = (map: Map<string, number>): Record<string, number> =>
      Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
    return {
      planner: this.name,
      phase: this.phase,
      dayKey: this.lastDayKey,
      objective: null,
      avoidTools: [...this.avoidTools].sort(),
      failStreak: sortedObject(this.failStreak),
      rescueTried: [...this.rescueTried].sort(),
      lastRescueFail: this.lastRescueFail,
      lastFreeSlots: this.lastFreeSlots,
      furniturePlaceTried: this.furniturePlaceTried,
      doneSteps: [...this.dayDone].sort(),
      lastFarm: this.lastFarm === null ? null : { ...this.lastFarm },
    };
  }

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    // 跨日（含换季）重置日程与失败记忆
    const dayKey = `${state.season}${state.day}`;
    if (this.lastDayKey !== dayKey) {
      this.lastDayKey = dayKey;
      this.phase = 'farm-work';
      this.dayDone.clear();
      this.rescueTried.clear();
      this.lastRescueFail = '';
      this.failStreak.clear();
      this.avoidTools.clear();
      this.furniturePlaceTried = false;
    }

    const context = this.buildContext(state);

    // 0) BWF 有长动作在执行（sleep 最长 7 分钟）：期间发什么都被拒，连发会把失败签名刷成卡死
    //    （2026-11-25 真机夏6 22:40：sleep 执行中连发 travel_to → repeat-failure）。等它做完再决策。
    const busy = inProgressGuard(state);
    if (busy !== null) {
      this.phase = 'wait';
      return busy;
    }

    // 1) 我们主动开的商店界面：先买种，别当误开界面 close_menu 掉
    const shopBuy = shopBuyDecision(context);
    if (shopBuy !== null) {
      this.phase = 'buy';
      return shopBuy;
    }

    // 2) 菜单/剧情/过场：BWF 有界面时拒绝其他动作，必须先处理
    const menu = handleMenu(state);
    if (menu !== null) {
      this.phase = 'menu';
      return menu;
    }

    // 3) 生存护栏（无界面时优先级最高）
    const survival = survivalDecision(state, context.edible, this.scheduleOptions);
    if (survival !== null) {
      this.phase = 'survival';
      return survival;
    }

    // 4) 背包塞满：任何采集/钓鱼都会失败（真机 2026-11-22 连续 FAILED fish 教训）。
    // 规则模式无回执上下文：优先出货（不依赖农场箱子，还能赚钱），没可卖的才整理。
    const rawHasSlots = /背包空位：\d+\s*个/.test(state.raw);
    if (rawHasSlots) this.lastFreeSlots = state.freeSlots;
    const effectiveSlots = rawHasSlots ? state.freeSlots : (this.lastFreeSlots ?? state.freeSlots);
    if (effectiveSlots > 0) {
      this.furniturePlaceTried = false;
      this.rescueTried.clear();
      this.lastRescueFail = '';
    }
    if (effectiveSlots <= 0) {
      const rescue = this.rescueDecision(state);
      if (rescue !== null) return rescue;
    }

    // 到达农场：今天的「看一眼作物」算完成，后续浇水/收获/播种按实际状态决定
    if (state.location === 'Farm') this.dayDone.add('visit');

    // 5) 日程
    const decision = scheduleDecision(context, this.scheduleOptions);
    if (decision !== null) {
      this.phase = decision.kind === 'act' ? decision.tool : 'wait';
      // 日程动作「决策即记一次」：规则模式不再靠内部 phase 推进，避免同一状态文本反复读信/浇水。
      // 真失败（FAILED/ERROR/TIMEOUT）由 observeReceipt 撤销，允许当天重试；出货故意不记（多批物品要多次出）。
      if (decision.kind === 'act') {
        const step = COMPLETED_STEP_BY_TOOL[decision.tool];
        if (step !== undefined && step !== 'ship') this.dayDone.add(step);
      }
      return decision;
    }
    this.phase = 'wait';
    return {
      kind: 'wait',
      seconds: 60,
      reason: '今天的日程都做完了：没有可浇/可收的作物，种子与空地也不满足条件，钓鱼采集都不可行——规则模式待命，不空转',
    };
  }

  /** 组装日程上下文（解析 + 农场概况缓存 + 商店营业时间） */
  private buildContext(state: GameStateSnapshot): ScheduleContext {
    const summary = parseFarmSummary(state.raw);
    if (state.location === 'Farm') this.lastFarm = summary;
    const farm = state.location === 'Farm' ? summary : (this.lastFarm ?? summary);
    const weekday = parseWeekday(state.raw);
    const shop = seedShopStatus(state.clockMinutes, weekday, state.festival);
    const facts: ScheduleFacts = {
      unreadMail: parseUnreadMail(state.raw),
      cropCount: farm.cropCount,
      needsWater: farm.needsWater,
      harvestable: farm.harvestable,
      emptyTilled: farm.emptyTilled,
      seeds: parseSeedInventory(state.raw),
      hasRod: hasFishingRod(state.raw),
      hasWateringCan: hasToolInBag(state.raw, /水壶|喷壶|Watering ?Can/i),
      hasHoe: hasToolInBag(state.raw, /锄头|Hoe/i),
      weekday,
      shopOpen: shop.open,
      festival: state.festival,
    };
    return {
      state,
      facts,
      avoidTools: this.avoidTools,
      done: this.dayDone,
      shippable: pickShippableItem(state.raw),
      edible: pickEdible(state.raw),
    };
  }

  /** 满包有界救援阶梯（T-M6-10 真机回归；行为与拆分前逐字一致） */
  private rescueDecision(state: GameStateSnapshot): PlannerDecision | null {
    // 最高优先：钱够且游戏提示可扩容 → 去皮埃尔买背包（一次性解决满包，真机 2026-11-23 实测）。
    const upgrade = parseBackpackUpgrade(state.raw);
    if (upgrade !== null && state.money >= upgrade.cost && !this.rescueTried.has('backpack_upgrade')) {
      if (state.location !== 'SeedShop') {
        return {
          kind: 'act',
          tool: 'travel_to',
          args: { location: 'SeedShop' },
          intent: `背包满了，钱够扩容（${upgrade.cost}g → ${upgrade.capacity} 格），去皮埃尔杂货店`,
        };
      }
      const spot = findBuyBackpackSpot(state.raw);
      if (spot !== null) {
        this.rescueTried.add('backpack_upgrade');
        return {
          kind: 'act',
          tool: 'interact',
          args: { x: spot.x, y: spot.y },
          intent: `买背包扩容（${upgrade.cost}g → ${upgrade.capacity} 格）`,
        };
      }
    }
    // 有可卖物优先出货（不依赖农场箱子，还能赚钱）。
    const item = pickShippableItem(state.raw);
    if (item !== null && !this.rescueTried.has('ship_items')) {
      return { kind: 'act', tool: 'ship_items', args: { item }, intent: `背包满了，先把${item}出货换米腾位置` };
    }
    // 只剩【留着】的收集包材料：donate_bundles 是唯一无损腾格途径（只试一次）。
    const hasReserved = /【留着/.test(state.raw);
    if (hasReserved && !this.rescueTried.has('donate_bundles')) {
      return { kind: 'act', tool: 'donate_bundles', args: {}, intent: '背包只剩收集包材料，去社区中心捐掉腾格（不卖不扔）' };
    }
    const furniture = pickFurnitureToPlace(state.raw);
    if (furniture !== null && (!this.rescueTried.has('place_item') || !this.rescueTried.has('trash_item'))) {
      if (!this.furniturePlaceTried && !this.rescueTried.has('place_item')) {
        this.furniturePlaceTried = true;
        if (state.location !== 'Farm') {
          return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: '回农场把家具摆出来腾个背包格' };
        }
        if (state.posX >= 0) {
          return { kind: 'act', tool: 'place_item', args: { item: furniture, x: state.posX + 1, y: state.posY, force: true }, intent: `把${furniture}摆到农场上腾位置` };
        }
      }
      if (!this.rescueTried.has('trash_item')) {
        return { kind: 'act', tool: 'trash_item', args: { item: furniture, force: true }, intent: `家具摆不下，只好忍痛丢掉${furniture}换一格` };
      }
    }
    // tidy 只试一次：BWF 在「农场没有箱子」时会直接失败，但世界箱子未必能从状态文本可靠判定，
    // 所以保留一次尝试；失败后由 rescueTried 记住，绝不重复空转。
    if (!this.rescueTried.has('tidy_backpack')) {
      return { kind: 'act', tool: 'tidy_backpack', args: { purpose: 'fish' }, intent: '背包塞得满满当当，先整理出空位再干活' };
    }
    // 无可出货 / 无可捐 / 无箱子：停止空转，明确求助（wait 不产生游戏动作）。
    return {
      kind: 'wait',
      seconds: 60,
      reason: `满包且农场无箱子、无可出货/可捐物品（${this.lastRescueFail || '首次判断'}）——需要主人造箱或手动腾格；规则模式暂停动作，不空转`,
    };
  }
}

/** COMPLETED 回执 → 当天日程步骤（只有这些工具算「闭环项完成」） */
const COMPLETED_STEP_BY_TOOL: Readonly<Record<string, ScheduleStep>> = {
  read_mail: 'mail',
  water_crops: 'water',
  harvest_crops: 'harvest',
  ship_items: 'ship',
  buy: 'buy',
  plant_seeds: 'plant',
  till_area: 'till',
  take_items: 'tool',
};

/** 未读信件数：`邮箱里有 7 封未读信件` → 7；没有该行视为 0（不读空信） */
function parseUnreadMail(raw: string): number {
  const match = /(\d+)\s*封未读信件/.exec(raw);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}
