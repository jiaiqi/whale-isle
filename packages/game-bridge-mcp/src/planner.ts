/**
 * Planner 接口与规则实现（T-M5-02）。
 * 三实现可切换（ARCHITECTURE 三轨计划）：
 *   - RulePlanner：确定性日程（无需 LLM，7×24 可跑——当前默认）
 *   - LlmPlanner：model-gateway 驱动（用户配 key 后启用）
 *   - 远程指令信箱：人工插队 P0（Shell 聊天/WebUI）
 * 行为须匹配桌宠人格：决策结果附 intent（用于台词/情绪联动，persona-brain 消费）。
 */

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
  `${KEEP_TAG_RE.source}|种子|肥料|鱼饵|鱼钩|浮标|炸弹|花束|吊坠|^(?:斧头|锄头|喷壶|十字镐|镐子|镰刀|鱼竿|竹鱼竿|剑|刀)|窗户|椅子|桌子|床|灯|地毯|壁纸|地板|柜|架子|机器|熔炉|洒水器|稻草人|箱子|酒桶|罐头|火炉|壁炉|电视|沙发|盆栽`,
);
/** 值钱/可卖线索（真机教训：家具类 ship 会被 BWF 拒绝，优先挑鱼/采集/矿物） */
const SELLABLE_HINT_RE =
  /鱼|虾|蟹|蛤|牡蛎|海草|珊瑚|贝|鲤|鲈|鲱|鲷|鳗|沙丁|鳟|鲑|鳅|花|莓|韭|蕨|蘑菇|矿石|宝石|钻石|石英|水晶|煤|铜|铁|金/;
/** 工具/消耗品识别（最后手段垃圾化时保护） */
const ESSENTIAL_RE = /种子|肥料|鱼饵|鱼钩|浮标|炸弹|花束|吊坠|^(?:斧头|锄头|喷壶|十字镐|镐子|镰刀|鱼竿|竹鱼竿|剑|刀)/;

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
  /** 可选：编排器回执反馈（规则兜底据此做失败升级，避免离线模式死循环） */
  observeReceipt?(tool: string, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR', summary: string): void;
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
  return { kind: 'act', tool: 'dialogue', args: {}, intent: '推进当前界面' };
}

/**
 * RulePlanner：确定性日程（摸鱼/认真双态的规则化表达，人格化台词由 intent 承载）。
 * 日程（按游戏时钟）：
 *   06:00-07:00  读信（有未读）→ 出门
 *   07:00-11:00  农活：浇水（有作物）→ 收获 → 种植
 *   11:00-17:30  海边钓鱼（赚米）
 *   17:30-18:30  采集/翻垃圾桶（小鲸摸鱼时刻）
 *   >=18:30      回家 → 睡觉（防晕倒——历史教训：Joja 医疗费 50g）
 * 体力 <12% → 吃东西；体力 <8% 且无食物 → 直接睡觉。
 */
export class RulePlanner implements Planner {
  readonly name = 'rule-schedule';
  private phase: 'morning-mail' | 'farm-work' | 'fishing' | 'forage' = 'farm-work';
  private lastPhaseDay = -1;
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

  observeReceipt(tool: string, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR', summary: string): void {
    // T-M6-52：先记工具级失败——规则兜底也必须换做法，不能只记住满包救援工具。
    // 生存类工具（吃饭/睡觉/赶路/界面）失败一次不代表该放弃（体力见底、菜单挡住都需要重试），
    // 因此只对非生存类工具做「连败 ≥2 当日跳过」；生存类仍由各自分支的确定性兜底处理。
    if (status === 'COMPLETED') {
      this.failStreak.delete(tool);
      this.avoidTools.delete(tool);
    } else if ((status === 'FAILED' || status === 'ERROR' || status === 'TIMEOUT') && !SURVIVAL_TOOLS.has(tool)) {
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

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    const menu = handleMenu(state);
    if (menu) return menu;

    // 跨日重置日程
    const dayKey = `${state.season}${state.day}`;
    if (this.lastPhaseDay !== state.day) {
      this.lastPhaseDay = state.day;
      this.phase = 'morning-mail';
      this.rescueTried.clear();
      this.lastRescueFail = '';
      this.failStreak.clear();
      this.avoidTools.clear();
    }
    void dayKey;

    const staminaRatio = state.stamina / state.staminaMax;
    if (staminaRatio < 0.08) {
      return { kind: 'act', tool: 'sleep', args: {}, intent: '体力见底，回家睡觉（再也不收 50g 医疗费！）' };
    }
    if (staminaRatio < 0.12 && state.clockMinutes < 18 * 60) {
      return { kind: 'act', tool: 'eat', args: {}, intent: '体力不足先吃点东西垫垫' };
    }
    // 生命护栏（T-M6-14）：矿洞/战斗后血线 <30% 先回血或回家（真机提示词第 7 条的确定性兜底）
    const healthRatio = state.healthMax > 0 ? state.health / state.healthMax : 1;
    if (healthRatio < 0.3) {
      const food = pickEdible(state.raw);
      if (food !== null) return { kind: 'act', tool: 'eat', args: { item: food }, intent: `血量见底了，先吃个${food}回回血` };
      if (state.location !== 'FarmHouse') {
        return { kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '血量危险又没吃的，先回家躲一躲' };
      }
      return { kind: 'act', tool: 'sleep', args: {}, intent: '血量见底，睡觉回血（明天又是好鲸）' };
    }
    if (state.clockMinutes >= 18 * 60 + 30) {
      return this.goSleep(state);
    }
    // 背包塞满：任何采集/钓鱼都会失败（真机 2026-11-22 连续 FAILED fish 教训）。
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

    switch (this.phase) {
      case 'morning-mail': {
        if (/(\d+) 封未读信件/.test(state.raw)) {
          const tool = { kind: 'act' as const, tool: 'read_mail', args: {}, intent: '读信啦——说不定有鱼竿！（7 封未读）' };
          this.phase = 'farm-work';
          return tool;
        }
        this.phase = 'farm-work';
        return this.farmWork(state);
      }
      case 'farm-work':
        return this.farmWork(state);
      case 'fishing':
        if (state.clockMinutes >= 17 * 60 + 30) {
          this.phase = 'forage';
          return this.forage(state);
        }
        // 没鱼竿 / fish 已连败冷却：重试 fish 毫无意义，转采集（规则兜底的安全替代，不空转）
        if (this.fishingUnavailable(state)) {
          this.phase = 'forage';
          return this.forage(state);
        }
        return { kind: 'act', tool: 'fish', args: { casts: 5 }, intent: '钓鱼赚米！这可是正经的生产活动（傲娇）' };
      case 'forage':
        // 18:30 后的睡觉切换由上方全局规则统一处理，这里只做傍晚采集
        return this.forage(state);
    }
  }

  /** 今天还能不能钓鱼：明确没鱼竿（背包段存在且无鱼竿）或 fish 已在失败冷却 → 不能 */
  private fishingUnavailable(state: GameStateSnapshot): boolean {
    return this.avoidTools.has('fish') || hasFishingRod(state.raw) === false;
  }

  private farmWork(state: GameStateSnapshot): PlannerDecision {
    if (state.clockMinutes >= 11 * 60) {
      this.phase = 'fishing';
      // 今天钓鱼已不可行（没鱼竿）：直接转采集，别白跑海滩
      if (this.fishingUnavailable(state)) return this.forage(state);
      return { kind: 'act', tool: 'travel_to', args: { location: 'Beach' }, intent: '上午农活干完，去海滩钓鱼！' };
    }
    if (!isRaining(state) && /剩 \d+ 株没浇|需要浇水/.test(state.raw)) {
      return { kind: 'act', tool: 'water_crops', args: {}, intent: '给作物浇水——今天浇了才算长一天' };
    }
    if (/成熟的作物/.test(state.raw)) {
      return { kind: 'act', tool: 'harvest_crops', args: {}, intent: '收获成熟的作物！' };
    }
    if (/防风草种子|种子 x\d+/.test(state.raw)) {
      return { kind: 'act', tool: 'plant_seeds', args: { seed: '防风草种子' }, intent: '播种防风草（海滩农场沙地注意洒水器无效）' };
    }
    if (state.location !== 'Farm' && state.location !== 'FarmHouse') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: '回农场继续干活' };
    }
    // 没有明确农活 → 直接进入钓鱼阶段（没鱼竿则转采集）
    this.phase = 'fishing';
    if (this.fishingUnavailable(state)) return this.forage(state);
    return { kind: 'act', tool: 'travel_to', args: { location: 'Beach' }, intent: '农活告一段落，海滩钓鱼去～' };
  }

  private forage(state: GameStateSnapshot): PlannerDecision {
    // 采集也失败（背包满/地点不对）：回农场干徒手活；clear_area 也失败就明确求助，绝不空转
    if (this.avoidTools.has('forage')) {
      if (state.location !== 'Farm' && state.location !== 'FarmHouse') {
        return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: '采集也不顺利，先回农场看看有什么能干' };
      }
      if (!this.avoidTools.has('clear_area')) {
        return { kind: 'act', tool: 'clear_area', args: {}, intent: '钓鱼采集都干不了，先把农场清一清' };
      }
      return { kind: 'wait', seconds: 60, reason: '钓鱼/采集/清地都失败了——需要主人看看是不是缺工具（鱼竿/斧头）或背包满了' };
    }
    if (state.location !== 'Town') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'Town' }, intent: '傍晚去镇上翻垃圾桶（侦察！才不是摸鱼）' };
    }
    return { kind: 'act', tool: 'forage', args: {}, intent: '采集时间～顺便翻翻垃圾桶（小鲸的侦察行动）' };
  }

  private goSleep(_state: GameStateSnapshot): PlannerDecision {
    if (_state.location !== 'FarmHouse') {
      return { kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '回家！绝不晕倒（Joja 医疗费 50g 的教训）' };
    }
    return { kind: 'act', tool: 'sleep', args: {}, intent: '睡觉～晚安主人（自动结算）' };
  }
}
