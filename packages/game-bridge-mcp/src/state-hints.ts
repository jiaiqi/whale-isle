/**
 * 结构化环境障碍摘要（T-M6-57）。
 *
 * 中小模型在真机上常白撞两轮才发现「商店没开门 / 背包没鱼竿 / 快满了」。
 * 这里把 get_state 与最近回执里**已确证**的高价值前置事实提炼成 ≤240 字，
 * 每轮注入 LlmPlanner user prompt；纯函数、零网络、缺证据绝不编造。
 */
import { canPlantBeforeSeasonEnd, formatCropEconomics, SEED_TABLE } from './seed-table';

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

/** 从背包提取可食用（未标【留着】）的食物名 */
function listEdibleNames(bag: string): string[] {
  const out: string[] = [];
  for (const line of bag.split('\n')) {
    const match = /^\s*\d+:\s*(.+)$/.exec(line);
    if (match?.[1] === undefined) continue;
    const text = match[1];
    if (!/\[可食用/.test(text) || /【(?:留着|保留)/.test(text)) continue;
    const name = cleanStackText(text);
    if (name !== '') out.push(name);
  }
  return out.reverse();
}

function parseWoodCount(bag: string | null): number | null {
  if (bag === null) return null;
  let total = 0;
  for (const line of bag.split('\n')) {
    if (!/^\s*\d+:\s*(?:木材|Wood)(?=\s|$|x\d)/i.test(line)) continue;
    const cnt = /x(\d+)/i.exec(line);
    total += cnt?.[1] === undefined ? 1 : Number(cnt[1]);
  }
  return total;
}

function chestSectionPresent(raw: string): 'has-chest' | 'empty' | 'unknown' {
  const chestSec = /##\s*箱子[^\n]*\n([\s\S]*?)(?=\n## |\n\n|$)/.exec(raw)?.[1];
  if (chestSec !== undefined) {
    if (/和上次 get_state 一样/.test(chestSec)) return 'unknown';
    return /[-\d].*(?:箱|Chest)/i.test(chestSec) ? 'has-chest' : 'empty';
  }
  if (/附近物体|附近物件/.test(raw)) {
    return /(?:箱子|宝箱|Chest)\s*[:：(（]/.test(raw) ? 'has-chest' : 'empty';
  }
  return 'unknown';
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
  const urgent: string[] = [];
  const normal: string[] = [];
  const bag = backpackSection(stateRaw);
  const chest = latestChestSummary(recentReceipts);
  const free = /背包空位：(\d+)/.exec(stateRaw);
  const staminaM = /体力：(\d+)\/(\d+)/.exec(stateRaw);
  const healthM = /生命：(\d+)\/(\d+)/.exec(stateRaw);

  if (/需要选择职业（用 choose_profession/.test(stateRaw)) {
    urgent.push('升级选职业弹窗：对照左右描述选 choose_profession({"side":"left"}) 或 "right"');
  } else if (/用 set_name 传一个名字/.test(stateRaw)) {
    urgent.push('起名弹窗：直接 set_name({"name":"小鲸宝"})');
  } else if (/奖券机的界面|PrizeTicketMenu/.test(stateRaw)) {
    urgent.push('奖券机界面：用 prize_machine({}) 兑奖或 close_menu({}) 离开');
  } else if (/钓鱼宝箱|拿取物品的界面/.test(stateRaw)) {
    urgent.push('开箱拿物界面：用 close_menu({}) 收下物品');
  } else if (/（读完用 close_menu 关闭/.test(stateRaw)) {
    urgent.push('信件界面：读完用 close_menu({}) 关闭收下附件');
  }

  if (/你正在节日里：时间不走|节日主活动(?:已经开始了|进行中)/.test(stateRaw)) {
    urgent.push('节日进行中：用 festival({"action":"greet"}) 聊天 / festival({"action":"start"}) 进主活动，或 festival({"action":"leave"}) 离开');
  } else if (/今天是[^\n]+用 festival enter 入场/.test(stateRaw)) {
    normal.push('今日有节日（时段内镇上商店关门）：参加用 festival({"action":"enter"})');
  }

  if (/地点：FarmHouse\b/.test(stateRaw) && Number.isFinite(clockMinutes) && clockMinutes >= 6 * 60 && clockMinutes < 22 * 60) {
    const giftMatch = /礼物箱[^\n]*?\((\d+)\s*,\s*(\d+)\)/.exec(stateRaw);
    const hasSeeds = parseSeedInventory(stateRaw).length > 0;
    if (giftMatch?.[1] !== undefined && giftMatch[2] !== undefined) {
      urgent.push(`屋里礼物箱在 (${giftMatch[1]},${giftMatch[2]})：直接 interact({"x":${giftMatch[1]},"y":${giftMatch[2]}}) 领种子（别传 target）`);
    } else if (hasSeeds) {
      urgent.push('种子已到手且屋里无礼物箱：直接 travel_to({"location":"Farm"}) 出门');
    }
    const farm = parseFarmSummary(stateRaw);
    const hasFarmWork = (farm.needsWater ?? 0) > 0 || (farm.harvestable ?? 0) > 0 || (farm.emptyTilled ?? 0) > 0 || hasSeeds;
    if (hasFarmWork && giftMatch !== null) urgent.push('屋里且外头有农活：用 travel_to({"location":"Farm"}) 出门');
  }

  const mailM = /邮箱里有\s*(\d+)\s*封未读信件/.exec(stateRaw);
  if (mailM?.[1] !== undefined) {
    urgent.push(`有 ${mailM[1]} 封未读信：直接 read_mail({})`);
  }

  const last3Receipts = recentReceipts.slice(-3).join('\n');

  if (/(?:仅限货真价实的冒险者|进不去\s*AdventureGuild|AdventureGuild[^\n]*进不去)/.test(`${last3Receipts}\n${stateRaw}`)) {
    urgent.push('公会门未开（需杀10史莱姆次日开）：勿再进 AdventureGuild，有信件先 close_menu({})');
  }

  if (bag !== null && !/[喷水]壶|Watering ?Can/i.test(bag)) {
    const farmSummary = /地点：Farm\b/.test(stateRaw) ? parseFarmSummary(stateRaw) : null;
    if ((farmSummary?.needsWater ?? 0) > 0 || /water_crops[\s\S]*没有水壶|没有水壶/.test(last3Receipts)) {
      urgent.push('背包缺“喷壶”（真名非“水壶”）：先 list_chests({}) 查箱再 take_items 取“喷壶”');
    }
  }

  if (bag !== null && !/十字镐|镐子|Pickaxe/i.test(bag)) {
    if (/地点：.*Mine/i.test(stateRaw) || /explore_mine[\s\S]*没有镐子|没有镐子/.test(last3Receipts)) {
      urgent.push('背包缺“十字镐”（真名非“镐子”）：下矿先回箱子取“十字镐”');
    }
  }

  if (bag !== null && !/锄头|Hoe/i.test(bag) && /till_area[\s\S]*没有锄头|没有锄头/.test(last3Receipts)) {
    urgent.push('背包缺“锄头”：先 list_chests({}) 查箱取“锄头”');
  }

  if (/这一层找不到楼梯，也没有能走到的石头了/.test(last3Receipts)) {
    urgent.push('本矿层无楼梯且无可达石头：立刻 travel_to({"location":"Mine"}) 重下电梯或离开');
  }

  if (/(?:走不到\([^)]+\)\s*旁边|穿过[^\n]*房门[^\n]*好感)/.test(last3Receipts)) {
    urgent.push('目标不可达/缺房门好感：立刻换目标，别反复 interact/move_to 原坐标');
  }

  if (/背包满了，地上的[\s\S]*捡不起来/.test(last3Receipts)) {
    urgent.push('背包0空位无法捡矿：先回 Farm 调 tidy_backpack({"purpose":"mine"}) 或存/出货腾格');
  }

  if (/还没认识[^\n]*先用\s*interact/.test(last3Receipts)) {
    urgent.push('还没认识该村民：先调 interact({"npc":"村民名"}) 打招呼再送礼');
  }

  if (/(?:圆石\s*\(\s*\d+\s*,\s*\d+\s*\)|你的十字镐不够坚硬|从“圆石”变为“圆石”)/.test(last3Receipts)) {
    urgent.push('大圆石当前镐等级敲不开、clear_area 也清不动：立刻放弃圆石/矮人路线，改做别的');
  }

  if (/地点：Farm\b/.test(stateRaw)) {
    const farm = parseFarmSummary(stateRaw);
    const hasDeadCrops = /枯死作物\s*[1-9]\d*\s*株/.test(stateRaw);
    const hasCropLines = /生长中：[^\n]*?x\d+|农田：[^\n]*?作物\s*[1-9]\d*|可收获\s*[1-9]\d*\s*株/.test(stateRaw);
    const anyCropOnFarm = (farm.cropCount ?? 0) > 0 || hasCropLines;
    const allWatered = (farm.needsWater === 0 || (farm.needsWater === null && anyCropOnFarm))
      && !/需要浇水\s*[1-9]\d*\s*株/.test(stateRaw);
    const lastReceipt = recentReceipts[recentReceipts.length - 1] ?? '';
    const justConfirmedNoWater = /water_crops\s*[:：].*(?:这里(?:（Farm）)?没有需要浇水的作物|还剩\s*0\s*株没浇)/.test(lastReceipt);
    if (hasDeadCrops) {
      urgent.push('田里有枯死作物（保留已耕土）：先 clear_area({"radius":6}) 或镰刀清除再播种');
    } else if (!anyCropOnFarm && (farm.emptyTilled ?? 0) === 0 && parseSeedInventory(stateRaw).length > 0) {
      urgent.push('农场暂无耕地：有杂物先 clear_area({"radius":5})，首次开垦须给矩形 x1,y1,x2,y2（如 {"x1":62,"y1":18,"x2":66,"y2":20}）');
    } else if ((anyCropOnFarm && allWatered) || (justConfirmedNoWater && farm.needsWater === null)) {
      urgent.push('农场当前 0 株待浇水（今日已浇透，直接把浇水计划标 done，勿重复 water_crops，忽略未解锁的 IslandWest）');
    }
  }

  if (healthM?.[1] !== undefined && healthM[2] !== undefined) {
    const hp = Number(healthM[1]);
    const hpMax = Number(healthM[2]);
    if (hpMax > 0 && hp / hpMax <= 0.43) {
      const edibles = bag !== null ? listEdibleNames(bag) : [];
      if (edibles.length > 0) {
        urgent.push(`生命仅 ${hp}/${hpMax}：先 eat({"item":"${edibles[0]}"}) 回血`);
      } else {
        urgent.push(`生命仅 ${hp}/${hpMax} 且无非【留着】回血食物：别 eat/fight，立刻 travel_to 撤离`);
      }
    }
  }

  if (staminaM?.[1] !== undefined && staminaM[2] !== undefined && bag !== null) {
    const stamina = Number(staminaM[1]);
    if (stamina <= 50) {
      const edibles = listEdibleNames(bag);
      if (edibles.length > 0) {
        urgent.push(`体力仅 ${stamina}：可 eat({"item":"${edibles[0]}"})${edibles.length > 1 ? ` 等(${edibles.slice(1, 2).join('、')})` : ''}`);
      } else {
        // 真机 2026-11-28 秋8：06:50 就调了 sleep({"force":true}) 把整白天睡掉。
        // sleep 会跳过整天，凌晨/深夜才是它的位置；白天体力低应先做零耗体事或找吃的。
        const earlyDay = Number.isFinite(clockMinutes) && clockMinutes >= 6 * 60 && clockMinutes < 17 * 60;
        urgent.push(earlyDay
          ? `体力仅 ${stamina} 且无[可食用]食物，别调 eat！现在是白天（${clockLabel(clockMinutes)}），sleep 会把整天睡掉：先做零耗体事（town/forest forage 找大葱韭葱、找未认识村民 interact、read_mail、整理箱子），或去商店买吃的`
          : `体力仅 ${stamina} 且无[可食用]食物，别调 eat！做零耗体事（town/forest forage 或找未认识村民 interact），或 sleep({"force":true}) 收工`);
      }
    }
  }

  if (free?.[1] !== undefined && Number(free[1]) <= 3) {
    const slots = Number(free[1]);
    if (/地点：Farm\b/.test(stateRaw) && chest === '') {
      const chestStatus = chestSectionPresent(stateRaw);
      const wood = parseWoodCount(bag);
      if (chestStatus === 'empty' && wood !== null && wood < 50) {
        urgent.push(`剩 ${slots} 格、无箱且木材 ${wood}/50：别调 tidy_backpack 或 craft(Chest)，先 ship_items 或 axe 砍树`);
      } else if (chestStatus === 'empty' && wood !== null && wood >= 50) {
        urgent.push(`剩 ${slots} 格且木材已有 ${wood}/50：可 craft({"recipe":"Chest"}) 再 place_item({"item":"Chest"})`);
      } else if (slots <= 2) {
        urgent.push(`农场仅剩 ${slots} 格：可用 ship_items 出货，或满 50 木材造箱`);
      }
    } else if (slots <= 2) {
      normal.push(`背包只剩 ${slots} 个空位：先整理/出货再进货`);
    }
  }

  if (Number.isFinite(clockMinutes)) {
    const weekday = parseWeekday(stateRaw);
    // 真机 2026-11-28 秋8：06:50 调了 sleep({"force":true})，把整白天睡掉、当天空手结束。
    // sleep 跳过整天，白天（06:00–17:00）用它等于白丢一整天，深夜才是它的位置。
    if (clockMinutes >= 6 * 60 && clockMinutes < 17 * 60) {
      normal.push(`现在是白天 ${clockLabel(clockMinutes)}：sleep 会跳过整天，白天别收工，做点能推进的事`);
    }
    if (clockMinutes < 6 * 60) {
      urgent.push(`深夜 ${clockLabel(clockMinutes)}（距 02:00 晕倒仅 ${Math.max(0, 120 - clockMinutes)} 分）：立刻 sleep({}) 回家睡觉`);
    } else if (clockMinutes >= 22 * 60 + 45 && !/地点：FarmHouse\b/.test(stateRaw)) {
      urgent.push(`已 ${clockLabel(clockMinutes)}，在外别恋战：早点 travel_to("FarmHouse") + sleep 避免 02:00 晕倒扣钱`);
    } else if (weekday === 3 && clockMinutes >= 8 * 60 && clockMinutes < 22 * 60) {
      normal.push('今天周三皮埃尔杂货店歇业，买种子改去 JojaMart（09:00-23:00）');
    } else if (clockMinutes < 9 * 60) {
      normal.push(`现在 ${clockLabel(clockMinutes)}，鱼店和皮埃尔 09:00 才开门，别白跑`);
    } else if (clockMinutes >= 17 * 60) {
      normal.push(`现在 ${clockLabel(clockMinutes)}，鱼店和皮埃尔 17:00 已打烊，别白跑`);
    }
  }

  if (/时间：第\d+年[春夏秋冬]28日/.test(stateRaw)) {
    normal.push('今日季末第28天：单季未熟作物明早枯死，勿再买当季新品');
  }

  // T3 经济事实（2026-11-28）：只在「当前季节有表内作物」且「确认该买种子/能播种」时给出，
  // 只陈述单株净收益与收获次数，不指定该种哪个（AI-first 红线）。
  const seasonM = /时间：第\d+年(春|夏|秋|冬)\d+日/.exec(stateRaw);
  const dayM = /时间：第\d+年[春夏秋冬](\d+)日/.exec(stateRaw);
  if (seasonM?.[1] !== undefined && dayM?.[1] !== undefined) {
    const season = seasonM[1];
    const day = Number(dayM[1]);
    const seed = SEED_TABLE.find((s) => s.season === season);
    if (seed !== undefined && canPlantBeforeSeasonEnd(season, day, seed)) {
      const eco = formatCropEconomics(seed, day);
      if (eco !== null) normal.push(`当季作物收益（普通品质、单株）：${eco}`);
    }
  }
  if (/【花钱建议】[\s\S]*背包扩到 24 格/.test(stateRaw)) {
    normal.push('满 2000g 可去 SeedShop interact 柜台背包扩到 24 格');
  }
  if (/可以捐给博物馆/.test(stateRaw)) {
    normal.push('有可捐矿物/古物（08:00-18:00 可 donate_museum）');
  }
  if (/用 donate_bundles/.test(stateRaw)) {
    normal.push('背包有收集包材料（可 donate_bundles）');
  }

  if (/是(?:出货箱|宝箱)[^\n]*(?:交互没有反应|不用\s*interact)|interact[\s\S]*(?:出货箱|是宝箱)/.test(last3Receipts)) {
    normal.push('出货用 ship_items、存取箱用 take_items/store_items，勿对箱子调 interact');
  }
  if (/(?:箱子里没有符合的东西|哪个箱子里都没有)/.test(last3Receipts)) {
    normal.push('多箱查找先 list_chests({}) 看全览坐标；1.6工具名 喷壶/十字镐/竹鱼竿');
  }

  // 真机 2026-11-28 秋9：interact(13,7) 撞「只有玛妮的好朋友才能进她的卧室」对话框 →
  // dialogue 关掉 → 再 move_to/interact 又被同一个对话框打断，连续 11 次失败。
  // 这类「再次靠近就重新弹同一句拒绝对话」的门是硬前置（好感/剧情/时间），当场无法绕过。
  const blockedDoor = /(?:有界面打开了|移动被打断)[\s\S]{0,40}对话框[\s\S]{0,80}?(?:只有|才能|得先)/.test(last3Receipts)
    || /(?:只有[^。\n]{0,20}(?:好朋友|朋友|好感)|得先和[^。\n]{0,20}好感)[^。\n]{0,10}(?:才能|才可)/.test(last3Receipts);
  if (blockedDoor) {
    const door = /对话框[：:]\s*([^\n]{1,40})/.exec(last3Receipts)?.[1]?.trim() ?? '';
    // 回执若已给出「几点出门/wait until=X」这类**限时**预兆，门槛是会自己消失的，
    // 不能只说「改日再来」（真机 2026-11-28 秋9：玛妮 10:00 出门，模型仍先去撞门）。
    const timed = /(\d{1,2}:\d{2})[^。\n]{0,20}出门|wait[^。\n]{0,12}until\s*=\s*(\d{1,2}:\d{2})/.exec(last3Receipts);
    const at = timed?.[1] ?? timed?.[2] ?? '';
    if (at !== '') {
      urgent.push(`这扇门是限时的：回执说 ${at} 之后就能进（现在还没到）。先去别处做事，或 wait({"until":"${at}"})，不要继续在门口换坐标试探`);
    } else {
      normal.push(`靠近就被同一句对话挡住${door === '' ? '' : `（「${door.slice(0, 30)}」）`}：这属好感/剧情/时间门槛，当场再试不会变，换个目标或改日再来`);
    }
  } else if (/(?:移动被打断|有界面打开了)[\s\S]{0,30}DialogueBox/.test(last3Receipts)) {
    // 刚 dialogue 完又被说「有界面打开」：界面状态需以 get_state 为准，别在怀疑中反复重试同一坐标。
    normal.push('刚关过对话又报「有界面打开」：先 get_state 确认真实界面，再决定是否重试同一坐标');
  }

  // 真机 2026-11-28 秋8：Farm → Town → Farm → Town 连续往返（travelPingPong 3 次），
  // 每次都是「去下一件事」而没把当前地图的事收尾。这里只陈述往返事实。
  const travelDests = recentReceipts
    .filter((r) => /^COMPLETED\s+travel_to\s*[:：]/.test(r))
    .slice(-4)
    .map((r) => /已到达\s*([A-Za-z]+)/.exec(r)?.[1] ?? '')
    .filter((d) => d !== '');
  if (travelDests.length >= 3) {
    const back = travelDests.slice(-3);
    if (back[0] === back[2] && back[0] !== back[1]) {
      normal.push(`最近在 ${back.join(' → ')} 之间来回：同一地点两次折返通常说明前一处的事没做完就走了`);
    }
  }

  if (bag !== null && !/鱼竿/.test(bag)) {
    normal.push('背包没有鱼竿(竹鱼竿)：先查箱子 list_chests，没有再去鱼店买（09:00-17:00）');
  }

  if (chest !== '') {
    normal.push(`刚查到的箱子：${chest.slice(0, 80)}`);
  }

  const text = [...urgent, ...normal].join('；');
  return text.length > MAX_HINTS_CHARS ? `${text.slice(0, MAX_HINTS_CHARS - 1)}…` : text;
}
