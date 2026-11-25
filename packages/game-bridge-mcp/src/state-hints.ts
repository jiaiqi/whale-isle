/**
 * 结构化环境障碍摘要（T-M6-57）。
 *
 * 中小模型在真机上常白撞两轮才发现「商店没开门 / 背包没鱼竿 / 快满了」。
 * 这里把 get_state 与最近回执里**已确证**的高价值前置事实提炼成 ≤240 字，
 * 每轮注入 LlmPlanner user prompt；纯函数、零网络、缺证据绝不编造。
 */
const MAX_HINTS_CHARS = 240;

function backpackSection(raw: string): string | null {
  const match = /## 背包[^\n]*\n([\s\S]*?)(?=\n## |\n\n|$)/.exec(raw);
  return match?.[1] ?? null;
}

/** 背包里的种子堆（T-M6-69 规则日程的「种子数」前置检查） */
export interface SeedStack {
  /** 干净物品名（「防风草种子」） */
  name: string;
  count: number;
}

/** 作物/农田概况（T-M6-69）：缺字段用 null，绝不用 0 冒充「没有」 */
export interface FarmSummary {
  /** 本地点作物总株数 */
  cropCount: number | null;
  /** 需要浇水的株数 */
  needsWater: number | null;
  /** 可收获的株数 */
  harvestable: number | null;
  /** 已开垦空地格数（有耕地信息时才有值） */
  emptyTilled: number | null;
}

/** 去皮埃尔杂货店（SeedShop）营业状态 */
export interface ShopStatus {
  open: boolean;
  reason: 'open' | 'before-hours' | 'after-hours' | 'wednesday' | 'festival';
}

const SEED_SHOP_OPEN_MINUTES = 9 * 60;
const SEED_SHOP_CLOSE_MINUTES = 17 * 60;

/** 背包行文本 → 干净物品名（去标签/品质/数量/手持标记；与 planner.cleanItemName 同口径） */
function cleanStackText(text: string): string {
  return text
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s*x\d+\b/gi, ' ')
    .replace(/\s*(?:金星|银星|铱星)\s*/g, ' ')
    .replace(/[（(]手持[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析背包里的种子堆：`[种子]` 标记或名字含「种子 / Seeds」都算。
 * 带【留着】的任务/收集包种子跳过（不能拿去种）。状态没有背包段 → 空数组。
 */
export function parseSeedInventory(raw: string): SeedStack[] {
  const bag = backpackSection(raw);
  if (bag === null) return [];
  const out: SeedStack[] = [];
  for (const line of bag.split('\n')) {
    const match = /^\s*\d+:\s*(.+)$/.exec(line);
    if (match?.[1] === undefined) continue;
    const text = match[1];
    if (/【留着/.test(text)) continue;
    if (!/\[种子\]|种子|Seeds?/i.test(text)) continue;
    const name = cleanStackText(text);
    if (name === '') continue;
    const countMatch = /x(\d+)/i.exec(text);
    const count = countMatch?.[1] === undefined ? 1 : Number(countMatch[1]);
    if (count <= 0) continue;
    out.push({ name, count });
  }
  return out;
}

/**
 * 解析「作物」段概况。真机 BWF 1.1.27 有**两种**格式：
 *   - 不在农场时只有一行总览：`（农场概况：共 15 株作物，需浇水 3，可收获 2）`
 *   - 在农场时是明细（2026-11-25 真机浸泡发现，缺这条导致种完不浇水）：
 *     `需要浇水 2 株：(48,19) (45,19)`
 *     `生长中：辣椒 x2（最快约 5 天后成熟）`
 *     `可收获 2 株：…` / `枯死作物 1 株（可用镰刀清除）：…` / `空耕地 3 格（可播种）：…`
 * 旧剧本里可能只有 `剩 3 株没浇` / `有 2 株成熟的作物`，一并兼容。
 */
export function parseFarmSummary(raw: string): FarmSummary {
  const summary = /共\s*(\d+)\s*株作物[，,]\s*需浇水\s*(\d+)[，,]\s*可收获\s*(\d+)/.exec(raw);
  // 在农场的明细格式：数字在「株」前面（「需要浇水 2 株」而不是「需浇水 2」）
  const detailWater = /需要浇水\s*(\d+)\s*株/.exec(raw);
  const detailHarvest = /可收获\s*(\d+)\s*株(?!\s*[）)])/.exec(raw);
  const legacyWater = /剩\s*(\d+)\s*株没浇/.exec(raw);
  const legacyHarvest = /有\s*(\d+)\s*株成熟的作物/.exec(raw);
  const tilled = /共\s*(\d+)\s*格耕地[^\n]*?空\s*(\d+)/.exec(raw)
    ?? /零散耕地\s*(\d+)\s*格(?:（其中\s*(\d+)\s*株作物[^）]*）)?/.exec(raw)
    ?? /空耕地[：:]?\s*(\d+)\s*格/.exec(raw);
  const needsWater = summary?.[2] ?? detailWater?.[1] ?? legacyWater?.[1];
  const harvestable = summary?.[3] ?? detailHarvest?.[1] ?? legacyHarvest?.[1];
  // 零散耕地：总数减「其中 N 株作物」才是空地（真机 2026-11-25：种完 2 株后「零散耕地 2 格（其中 2 株作物）」）
  let emptyTilled: number | null;
  if (tilled === null) {
    emptyTilled = null;
  } else if (tilled[1] !== undefined && tilled[2] !== undefined && /共\s*\d+\s*格耕地/.test(tilled[0])) {
    emptyTilled = Number(tilled[2]);
  } else {
    const total = Number(tilled[1]);
    const occupied = tilled[2] === undefined ? 0 : Number(tilled[2]);
    emptyTilled = Math.max(0, total - occupied);
  }
  return {
    cropCount: summary?.[1] === undefined ? null : Number(summary[1]),
    needsWater: needsWater === undefined ? null : Number(needsWater),
    harvestable: harvestable === undefined ? null : Number(harvestable),
    emptyTilled,
  };
}

/**
 * 背包里是否有某类工具（水壶/锄头）。null = 状态没有背包段（未知，不阻断行程），
 * false = 明确没有（真机 2026-11-25：存档里水壶放在箱子，背包没有 → 浇水连败两次）。
 */
export function hasToolInBag(raw: string, pattern: RegExp): boolean | null {
  const bag = backpackSection(raw);
  if (bag === null) return null;
  return pattern.test(bag);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/** 状态时钟行里的星期 → 1(周一)…7(周日)；没有则 null（不猜） */
export function parseWeekday(raw: string): number | null {
  const clockLine = /^.*时间：第\d+年[春夏秋冬]\d+日.*$/m.exec(raw)?.[0] ?? '';
  for (let index = 0; index < WEEKDAYS.length; index += 1) {
    if (clockLine.includes(WEEKDAYS[index] ?? '')) return index + 1;
  }
  for (let index = 0; index < WEEKDAYS_ZH.length; index += 1) {
    if (clockLine.includes(WEEKDAYS_ZH[index] ?? '')) return index + 1;
  }
  return null;
}

/**
 * 皮埃尔杂货店营业判断（RUNBOOK §3.4）：9:00–17:00，周三休息，节日休息。
 * 状态里没有星期（weekday=null）时只按营业时间判断，不臆断周三。
 * 社区中心修好后皮埃尔每天营业，这里仍按经典规则保守处理（少跑一趟不亏）。
 */
export function seedShopStatus(clockMinutes: number, weekday: number | null, festival: string | null): ShopStatus {
  if (festival !== null && festival !== '') return { open: false, reason: 'festival' };
  if (weekday === 3) return { open: false, reason: 'wednesday' };
  if (!Number.isFinite(clockMinutes) || clockMinutes < SEED_SHOP_OPEN_MINUTES) return { open: false, reason: 'before-hours' };
  if (clockMinutes >= SEED_SHOP_CLOSE_MINUTES) return { open: false, reason: 'after-hours' };
  return { open: true, reason: 'open' };
}

function clockLabel(minutes: number): string {
  const hh = `${Math.floor(minutes / 60) % 24}`.padStart(2, '0');
  const mm = `${Math.round(minutes % 60)}`.padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 从最近回执里取最后一条 list_chests 成功摘要（不含正文隐私，只是物品清单）。 */
function latestChestSummary(receipts: readonly string[]): string {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index] ?? '';
    const match = /^(?:OK|COMPLETED)\s+list_chests\s*[:：]?\s*([\s\S]*)$/i.exec(receipt.trim());
    if (match?.[1] === undefined) continue;
    const summary = match[1].replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
    if (summary !== '') return summary;
  }
  return '';
}

/**
 * @param stateRaw 最近一次 get_state 原文（BWF 文本）
 * @param clockMinutes 游戏内分钟数（6:00 = 360）
 * @param recentReceipts 最近回执（`COMPLETED tool: summary`）
 */
export function extractEnvironmentHints(
  stateRaw: string,
  clockMinutes: number,
  recentReceipts: readonly string[],
): string {
  const facts: string[] = [];
  const backpack = backpackSection(stateRaw);
  if (backpack !== null && !/鱼竿/.test(backpack)) {
    facts.push('背包没有鱼竿：先查箱子 list_chests，没有再去鱼店买（09:00-17:00）');
  }
  const free = /背包空位：(\d+)/.exec(stateRaw);
  if (free?.[1] !== undefined) {
    const slots = Number(free[1]);
    if (slots <= 2) facts.push(`背包只剩 ${slots} 个空位：先整理/出货再进货`);
  }
  if (Number.isFinite(clockMinutes)) {
    if (clockMinutes < 9 * 60) {
      facts.push(`现在 ${clockLabel(clockMinutes)}，鱼店和皮埃尔 09:00 才开门，别白跑`);
    } else if (clockMinutes >= 17 * 60) {
      facts.push(`现在 ${clockLabel(clockMinutes)}，鱼店和皮埃尔 17:00 已打烊，别白跑`);
    }
  }
  const chest = latestChestSummary(recentReceipts);
  if (chest !== '') facts.push(`刚查到的箱子：${chest.slice(0, 80)}`);
  const text = facts.join('；');
  return text.length > MAX_HINTS_CHARS ? `${text.slice(0, MAX_HINTS_CHARS - 1)}…` : text;
}
