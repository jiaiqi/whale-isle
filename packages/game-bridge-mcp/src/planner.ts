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
}

export function parseGameState(raw: string): GameStateSnapshot {
  const clockM = /时间：(第\d+年[春夏秋冬]\d+日) (\d{2}):(\d{2})/.exec(raw);
  const staminaM = /体力：(\d+)\/(\d+)/.exec(raw);
  const moneyM = /金钱：(\d+)g/.exec(raw);
  const locM = /地点：([^\s（，。]+)/.exec(raw);
  const menuM = /## 当前界面\n(.+)/.exec(raw);
  const freeM = /背包空位：(\d+)\s*个/.exec(raw);
  const seasonM = /第\d+年(春|夏|秋冬|秋|冬)?/.exec(clockM?.[1] ?? '');
  const dayM = /年[春夏秋冬](\d+)日/.exec(clockM?.[1] ?? '');
  const hh = Number(clockM?.[2] ?? '6');
  const mm = Number(clockM?.[3] ?? '0');
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
  };
}

/**
 * 背包救援工具（T-M5-18，参考 BWF `GameActions.Tidy.cs` 与 feiyuos-stardew-ai-farmer LESSONS）：
 *   - 出货按「排除法 + 值钱线索」：工具/种子/肥料/鱼饵/炸弹/花束/吊坠/家具/任务物品绝不卖；
 *   - 背包满时优先 ship_items（有无箱子都能用，且能赚钱）；没有可卖物再 eat/trash 腾位；
 *   - **禁止满包 craft**（feiyu LESSONS：合成物会掉地上，反而卡死）。
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
    .replace(/\s+/g, ' ')
    .trim();
}

function* inventoryTexts(raw: string): Generator<string> {
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
export function pickAnyNonEssential(raw: string): string | null {
  let candidate: string | null = null;
  for (const text of inventoryTexts(raw)) {
    if (KEEP_TAG_RE.test(text)) continue;
    if (ESSENTIAL_RE.test(text)) continue;
    if (/\[可食用/.test(text)) continue; // 能吃的留给 eat 阶段
    const name = cleanItemName(text);
    if (name !== '') candidate = name;
  }
  return candidate;
}

export type PlannerDecision =  | { kind: 'act'; tool: string; args: Record<string, unknown>; intent: string }
  | { kind: 'wait'; seconds: number; reason: string }
  | { kind: 'stop'; reason: string };

export interface Planner {
  readonly name: string;
  decide(state: GameStateSnapshot): Promise<PlannerDecision>;
}

/** 对话框/菜单优先处理表（BWF 语义：有界面时其他动作会被拒绝） */
function handleMenu(state: GameStateSnapshot): PlannerDecision | null {
  const menu = state.menu;
  if (menu === '' || /无（可以自由行动）/.test(menu)) return null;
  if (/剧情|节日事件/.test(menu)) return { kind: 'act', tool: 'dialogue', args: {}, intent: '推进剧情对话' };
  if (/商店|Shop/.test(menu)) return { kind: 'act', tool: 'close_menu', args: {}, intent: '关掉误开的商店界面' };
  if (/选择题|选择/.test(menu)) return { kind: 'act', tool: 'dialogue', args: { choice: 1 }, intent: '做选择题' };
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

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    const menu = handleMenu(state);
    if (menu) return menu;

    // 跨日重置日程
    const dayKey = `${state.season}${state.day}`;
    if (this.lastPhaseDay !== state.day) {
      this.lastPhaseDay = state.day;
      this.phase = 'morning-mail';
    }
    void dayKey;

    const staminaRatio = state.stamina / state.staminaMax;
    if (staminaRatio < 0.08) {
      return { kind: 'act', tool: 'sleep', args: {}, intent: '体力见底，回家睡觉（再也不收 50g 医疗费！）' };
    }
    if (staminaRatio < 0.12 && state.clockMinutes < 18 * 60) {
      return { kind: 'act', tool: 'eat', args: {}, intent: '体力不足先吃点东西垫垫' };
    }
    if (state.clockMinutes >= 18 * 60 + 30) {
      return this.goSleep(state);
    }
    // 背包塞满：任何采集/钓鱼都会失败（真机 2026-11-22 连续 FAILED fish 教训）。
    // 规则模式无回执上下文：优先出货（不依赖农场箱子，还能赚钱），没可卖的才整理。
    if (state.freeSlots <= 0) {
      const item = pickShippableItem(state.raw);
      if (item !== null) {
        return { kind: 'act', tool: 'ship_items', args: { item }, intent: `背包满了，先把${item}出货换米腾位置` };
      }
      return { kind: 'act', tool: 'tidy_backpack', args: { purpose: 'fish' }, intent: '背包塞得满满当当，先整理出空位再干活' };
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
        return { kind: 'act', tool: 'fish', args: { casts: 5 }, intent: '钓鱼赚米！这可是正经的生产活动（傲娇）' };
      case 'forage':
        // 18:30 后的睡觉切换由上方全局规则统一处理，这里只做傍晚采集
        return this.forage(state);
    }
  }

  private farmWork(state: GameStateSnapshot): PlannerDecision {
    if (state.clockMinutes >= 11 * 60) {
      this.phase = 'fishing';
      return { kind: 'act', tool: 'travel_to', args: { location: 'Beach' }, intent: '上午农活干完，去海滩钓鱼！' };
    }
    if (/剩 \d+ 株没浇|需要浇水/.test(state.raw)) {
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
    // 没有明确农活 → 直接进入钓鱼阶段
    this.phase = 'fishing';
    return { kind: 'act', tool: 'travel_to', args: { location: 'Beach' }, intent: '农活告一段落，海滩钓鱼去～' };
  }

  private forage(state: GameStateSnapshot): PlannerDecision {
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
