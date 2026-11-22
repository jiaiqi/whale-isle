/**
 * LLM Planner（T-M6-01 完整版核心）：小鲸的「聪明大脑」——
 * get_state + 攻略摘要 → model-gateway（DeepSeek 等）→ JSON 工具决策。
 * 健壮性铁律：LLM 输出解析失败/超时/越权工具名 → 逐级回落（真纠错重问一次 → RulePlanner 兜底），
 * 绝不让坏输出卡死自动驾驶。
 * 决策协议（user 消息尾部约定）：
 *   只输出一行 JSON：{"tool":"动作名","args":{},"intent":"一句话人设化意图"}
 *
 * T-M6-12 决策循环防抖（真机 transcript 实证：同一冻结分钟内 dialogue×191 / place_item×96 /
 * trash_item×59 / donate_bundles×29 死循环）：
 *   - 单日失败预算：BWF 内置 AI 规则第 4 条「同一失败动作不重复超过两次」的跨轮持久化——
 *     只按「我上一条下发动作」的失败回执计数一次（从定长缓冲区数总数会在饱和后冻结，96 次同坐标复读的根因）；
 *   - dialogue 效果核验（Junimo 思想）：连续 N 次「推进成功」但界面文本一字未变 = 卡死 → skip_event/close_menu/求接管；
 *   - donate_bundles 失败按 BWF 回执提示自动查 bundle_info（当天一次），失败预算耗尽即冷却不再空转。
 */
import {
  RulePlanner,
  cleanItemName,
  countWood,
  findFreeTile,
  hasChestItem,
  listEdibleItems,
  listShippableItems,
  pickAnyNonEssential,
  pickFurnitureToPlace,
  pickTrash,
  pickTrashableFallback,
  type GameStateSnapshot,
  type Planner,
  type PlannerDecision,
} from './planner';

export { pickEdible, pickShippableItem, pickTrash } from './planner';

/** BWF 工具白名单（越权工具名一律拒绝——运行期安全锁） */
export const LLM_TOOL_WHITELIST = new Set([
  'get_state', 'get_guide', 'move_to', 'travel_to', 'use_tool', 'interact', 'place_item',
  'till_area', 'plant_seeds', 'water_crops', 'harvest_crops', 'clear_area', 'forage',
  'ship_items', 'store_items', 'list_chests', 'map_info', 'take_items', 'trash_item',
  'eat', 'use_item', 'open_shop', 'buy', 'sell', 'craft', 'dialogue', 'menu_click',
  'close_menu', 'read_mail', 'tidy_backpack', 'choose_profession', 'skip_event', 'leave_festival',
  'set_name', 'fish', 'care_animals', 'gift_info', 'give_gift', 'donate_museum', 'bundle_info',
  'donate_bundles', 'cook', 'check_crab_pots', 'fight', 'explore_mine', 'use_bomb',
  'upgrade_tool', 'crack_geodes', 'quest_board', 'special_orders', 'special_order_dropbox',
  'prize_machine', 'emote', 'perfection', 'pan', 'monster_goals', 'mastery',
  'mermaid_show', 'feed_parrot', 'collect_walnuts', 'repair_boat', 'joja', 'field_office',
  'grandpa', 'buy_animal', 'build', 'upgrade_house', 'sleep', 'wait', 'say', 'set_mode',
  'reserve_items', 'wait_chat', 'follow', 'propose', 'update_notes', 'cancel_action', 'play_for',
]);

export interface LlmPlannerDeps {
  /** model-gateway 的 chat 面最小形状（注入避免包反向依赖：game-bridge 不 import model-gateway） */
  chat(slot: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: { maxTokens?: number }): Promise<{ content: string }>;
  /** 攻略检索（guide-forager 主题文本，按状态线索选） */
  guides?: Record<string, string>;
  /** 最近回执上下文（编排器喂） */
  recentReceipts?: string[];
  /** 测试注入 */
  rng?: () => number;
}

const SYSTEM_TEMPLATE = (guidesHint: string) => `你是「小鲸」——一条住在主人桌面上的傲娇干饭蓝鲸女仆，此刻你正在替主人全自动游玩《星露谷物语》。
性格：嘴硬心软的傲娇；会认真干活但对"饭碗"（Token 余量）很敏感；偶尔冒失翻车时会心虚甩锅。像真实人类玩家一样：有目标、会规划、会记笔记、失败会换办法，不机械重复。
${guidesHint}
决策规则（严格遵守）：
1. 有界面打开时先处理界面（dialogue/close_menu/buy/skip_event）；剧情选择题必须带 choice；起名用 set_name。
2. 优先批量工具：water_crops / harvest_crops / till_area / plant_seeds / clear_area / forage，比一格一格高效。
3. 体力低于 20 不要干重活：吃东西或回家睡觉；23:00 前必须回家准备 sleep，绝不拖到凌晨。
4. 背包里标了【留着：…】的是任务/收集包材料：别吃、别卖、别扔；满包优先 tidy/ship，其次 place_item 家具、craft Chest、donate_bundles。
5. 工具失败时读原因并换做法，不要原样重复同一个失败动作超过两次；「最近回执」就是你的短期记忆。
6. 用 update_notes 记录长期目标与关键信息（农田坐标、商店时间、谁喜欢什么礼物）；笔记会一直出现在状态最前面，不用抄背包/箱子内容。
7. 身边有怪且会挨打时先 fight 清怪；生命低于 30% 且没回血食物先离开这张地图。
8. 农场要有规划：作物集中成片、新田挨着老田、机器/箱子集中放不堵门口；钱要花出去——按攻略优先买当季种子/背包/工具升级，留约 1000g 备用。
9. 攻略是参考不是命令；结合当前金钱、体力、天气、季节做取舍，优先能提高长期收入的行动。
10. 你只能调用白名单里的 BWF 工具；一次只做一个动作；args 键必须与工具真实参数一致。
11. 输出必须是一行 JSON：{"tool":"工具名","args":{参数},"intent":"一句话说明你想干什么（用小鲸的口吻）"}`;

/** 从 LLM 输出中宽松提取首个 JSON 对象（容忍 markdown 围栏/前后缀文本） */
export function extractDecisionJson(content: string): { tool: string; args: Record<string, unknown>; intent: string } | null {
  const start = content.indexOf('{');
  if (start < 0) return null;
  // 括号平衡扫描（复用 mcp-client 同款思路，但独立实现避免内部耦合）
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(content.slice(start, i + 1)) as { tool?: unknown; args?: unknown; intent?: unknown };
          if (typeof obj.tool !== 'string' || obj.tool.length === 0) return null;
          return {
            tool: obj.tool,
            args: (typeof obj.args === 'object' && obj.args !== null ? obj.args : {}) as Record<string, unknown>,
            intent: typeof obj.intent === 'string' ? obj.intent : '小鲸的下一步',
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 按状态线索挑攻略片段（Token 预算：≤1200 字） */
export function pickGuideContext(state: GameStateSnapshot, guides: Record<string, string> | undefined): string {
  if (!guides) return '';
  const keyHints: Array<[RegExp, string]> = [
    [/钓鱼|fish/i, '钓鱼'],
    [/矿|Mines|mine/i, '采矿'],
    [/节日|Festival/i, '节日'],
    [/婚礼|Marriage|好感/i, '结婚'],
    [/沙漠|Skull/i, '沙漠'],
    [/姜岛|Ginger/i, '姜岛'],
  ];
  for (const [re, topic] of keyHints) {
    if (re.test(state.raw) && guides[topic]) {
      return `\n可用攻略（${topic} 专题节选）：\n${guides[topic].slice(0, 1200)}\n`;
    }
  }
  return '';
}

/** 背包救援工具集合：只有这些工具失败才推进救援阶梯（fish/travel 失败不算） */
const RESCUE_STEP: ReadonlyMap<string, number> = new Map([
  ['tidy_backpack', 0],
  ['ship_items', 1],
  ['eat', 2],
  ['trash_item', 3],
  ['store_items', 4],
]);
const RESCUE_TOOLS: ReadonlySet<string> = new Set(RESCUE_STEP.keys());
/** 摆家具/箱子的相邻格尝试顺序（被挡住就换一个） */
const PLACE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2],
];
/** 同一工具单日失败预算（BWF Agent 规则 4：同一失败动作不重复超过两次）；place_item 允许把 6 个相邻格试完 */
const TOOL_FAIL_BUDGET_DEFAULT = 2;
const TOOL_FAIL_BUDGET: Readonly<Record<string, number>> = { place_item: PLACE_OFFSETS.length };
/** 生存护栏与只读信息工具不参与单日冷却（回家/睡觉/逃生口/查资料不能被预算卡死） */
const COOLDOWN_EXEMPT: ReadonlySet<string> = new Set([
  'travel_to', 'sleep', 'get_state', 'cancel_action', 'bundle_info',
]);
/** dialogue 效果核验阈值：同一界面文本连续推进 N 次没变化 → 判定卡死（真机玛妮剧情 191 次教训） */
const DIALOGUE_STUCK_LIMIT = 8;

/** 缓冲区尾部连续同工具失败回执数（重启/插队场景下没发过的失败也能被看见；饱和不影响「尾部」语义） */
function trailingFailedCount(recent: readonly string[], tool: string): number {
  const re = new RegExp(`^FAILED\\s+${tool}(?![\\w])`, 'i');
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (re.test(recent[i] ?? '')) count++;
    else break;
  }
  return count;
}

/** 从 place_item 失败回执里读 BWF 推荐坐标（「最好的坐标 (x,y)」/「放在 (x,y)」） */
function suggestedPlacementOf(receipt: string): { x: number; y: number } | null {
  const m = /(?:最好的坐标|放在)[^0-9]*[（(](\d+)\s*,\s*(\d+)/.exec(receipt);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** 从 BWF 失败回执里抠出被拒的单品名（「失败：普通窗户 不能出货」/「背包里没有“沙丁鱼 x3 金星”」） */
function failedItemOf(receipt: string): string {
  const noSuch =
    /(?:背包里没有|没有能扔的|没有可以吃的|没有可吃的)[“"]([^”"]+)[”"]/.exec(receipt);
  if (noSuch?.[1]) return cleanItemName(noSuch[1]);
  const trash = /失败：(?:\d+:)?(.+?)x\d+.*没有扔/.exec(receipt);
  if (trash?.[1]) return cleanItemName(trash[1]);
  const m =
    /失败：(.+?)\s*(?:不能出货|无法出货|不在背包|是社区中心|不能吃|吃不|会坏|一个能卖)/.exec(receipt);
  return cleanItemName(m?.[1] ?? '');
}

export class LlmPlanner implements Planner {
  readonly name = 'llm-xiaojing';
  private readonly fallback = new RulePlanner();
  private askCount = 0;
  /** 背包救援阶段（0 tidy → 1 ship → 2 eat → 3 trash → 4 store → 5 任意非必需品）：失败才前进 */
  private rescueStage = 0;
  private lastRescueFail = '';
  /** 上次解析到的背包空位；get_state 省略背包段时沿用，避免把「满」误判成「空」 */
  private lastFreeSlots: number | null = null;
  /** 被 BWF 拒绝过的单品（不能出货的家具/任务鱼等）——换下一个候选而不是换策略 */
  private readonly rejectedShip = new Set<string>();
  private readonly rejectedEat = new Set<string>();
  private readonly rejectedTrash = new Set<string>();
  private readonly rejectedPlace = new Set<string>();
  private placeTarget: { x: number; y: number } | null = null;
  private pendingPlaceItem: string | null = null;
  private craftTried = false;
  private chestPlaced = false;
  /** T-M6-12 单日防抖状态（跨日清零）：失败预算 / 已冷却工具 / 当天只查一次的信息工具 */
  private planDay = '';
  private readonly dayFails = new Map<string, number>();
  private readonly cooledTools = new Set<string>();
  private readonly dayInfoDone = new Set<string>();
  /** 我上一条下发动作（失败回执只按它结算一次，杜绝从定长缓冲区重复计数） */
  private lastIssued: string | null = null;
  /** 最近回执快照（rescueAction 内读 BWF 建议坐标 / 尾部失败计数用） */
  private lastRecent: readonly string[] = [];
  /** dialogue 效果核验：连续「推进成功但界面没变」计数与当时的界面文本 */
  private dialogueStreak = 0;
  private dialogueStreakMenu = '';

  constructor(private readonly deps: LlmPlannerDeps) {}

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    const decision = await this.decideCore(state);
    if (decision.kind === 'act') this.lastIssued = decision.tool;
    return decision;
  }

  private async decideCore(state: GameStateSnapshot): Promise<PlannerDecision> {
    this.askCount++;
    const recent = this.deps.recentReceipts ?? [];
    this.lastRecent = recent;
    // ── T-M6-12 单日失败预算结算（跨日清零；只认「我上一条下发动作」的最新失败回执，一次一条）──
    // BWF 对未变化段落会「（和上次一样，省略）」：wait/冻结后的快照可能没有时钟行，此时 day 会回落到
    // 默认 1——绝不能把省略快照当跨日（真机春19 donate 冷却被误清零、第三次捐空转的根因）。
    const hasClock = /时间：第\d+年[春夏秋冬]\d+日/.test(state.raw);
    const dayKey = hasClock ? `${state.season}${state.day}` : this.planDay;
    if (dayKey !== this.planDay) {
      this.planDay = dayKey;
      this.dayFails.clear();
      this.cooledTools.clear();
      this.dayInfoDone.clear();
    }
    const failedTool = /^FAILED\s+([^\s:：]+)/.exec(recent.at(-1) ?? '')?.[1] ?? '';
    if (this.lastIssued !== null && failedTool !== '' && failedTool === this.lastIssued) {
      const budget = TOOL_FAIL_BUDGET[failedTool] ?? TOOL_FAIL_BUDGET_DEFAULT;
      const fails = (this.dayFails.get(failedTool) ?? 0) + 1;
      this.dayFails.set(failedTool, fails);
      if (fails >= budget && !COOLDOWN_EXEMPT.has(failedTool)) this.cooledTools.add(failedTool);
    }
    this.lastIssued = null;

    // 菜单优先（确定性处理，不烧 LLM）
    const menu = state.menu;
    if (menu !== '' && !/无（可以自由行动）/.test(menu)) {
      // 剧情播放中但没有对话框：BWF 会拒绝 dialogue，此时用 skip_event 跳出过场，避免无限重试
      if (/剧情|节日事件/.test(menu) && /没有对话框|剧情还在放/.test(recent.at(-1) ?? '')) {
        return { kind: 'act', tool: 'skip_event', args: {}, intent: '过场没有对话框，跳过这段剧情' };
      }
      // dialogue 效果核验（真机：玛妮送宠剧情 191 次「推进成功」、界面文本从头到尾只有 2 种）：
      // 连续 N 次推进成功但界面一字未变 = 卡死，按逃生阶梯 skip_event → close_menu → 求主人接管
      const prevWasDialogue = /^OK\s+dialogue/i.test(recent.at(-1) ?? '');
      if (prevWasDialogue && menu === this.dialogueStreakMenu) this.dialogueStreak++;
      else this.dialogueStreak = prevWasDialogue ? 1 : 0;
      this.dialogueStreakMenu = menu;
      if (this.dialogueStreak >= DIALOGUE_STUCK_LIMIT) {
        const skipFailed = recent.some((r) => /^FAILED\s+skip_event/i.test(r));
        const closeFailed = recent.some((r) => /^FAILED\s+close_menu/i.test(r));
        if (skipFailed && closeFailed) {
          return { kind: 'wait', seconds: 30, reason: '剧情卡死了：skip_event 和关界面都失败，请主人按 F7 接管处理一下' };
        }
        if (skipFailed) return { kind: 'act', tool: 'close_menu', args: {}, intent: '跳不过去就先把界面关掉' };
        return { kind: 'act', tool: 'skip_event', args: {}, intent: '这段剧情推不动了，直接跳过（都推了好几遍啦！）' };
      }
      const menuDecision = await this.fallback.decide(state);
      if (menuDecision.kind === 'act' && this.cooledTools.has(menuDecision.tool)) {
        // 菜单处理工具今天已失败到冷却（如反复「没有对话框」）→ 换逃生口，两个都冷却才求助
        if (!this.cooledTools.has('close_menu')) {
          return { kind: 'act', tool: 'close_menu', args: {}, intent: '这个界面今天处理不动了，先关掉它' };
        }
        return { kind: 'wait', seconds: 30, reason: '界面卡死：dialogue/close_menu 都失败，请主人按 F7 接管看看' };
      }
      return menuDecision;
    }
    // 放置箱子成功 → 记住（本进程内不再重复 craft）
    if (recent.some((r) => /^OK\s+place_item|^COMPLETED\s+place_item/i.test(r) && /箱子|Chest/i.test(r))) this.chestPlaced = true;
    // 确定性护栏（真机 2026-11-22：小模型看得到「背包空位：0」却仍连续选 fish）：
    //   ① 背包满 → 整理；若整理本身也连续失败 → 升级为出货卖钱腾位置
    //   ② 同一工具连续两次失败 → 换规则日程，绝不死磕同一动作
    const failTools = recent
      .map((r) => /^FAILED\s+([^\s:：]+)/.exec(r)?.[1] ?? '')
      .filter((t) => t !== '');
    const tail2 = failTools.slice(-2);
    const repeated = tail2.length === 2 && tail2[0] === tail2[1];
    const rawHasSlots = /背包空位：\d+\s*个/.test(state.raw);
    if (rawHasSlots) this.lastFreeSlots = state.freeSlots;
    const effectiveSlots = rawHasSlots ? state.freeSlots : (this.lastFreeSlots ?? state.freeSlots);
    // 摆放失败轮换已并入 rescueAction case 6（T-M6-12）：按「单日失败计数 + 缓冲区尾部连续失败」
    // 取相邻格，取代旧的「从缓冲区数总数做 delta」——定长缓冲区饱和后 delta 恒为 0，真机 96 次同坐标复读的根因。
    // BWF「最好的坐标 (x,y)」建议仍然即时记忆（重启/插队场景下缓冲区里已有的失败建议也要能用上）：
    const lastReceipt = recent.at(-1) ?? '';
    if (/^FAILED\s+place_item/.test(lastReceipt)) {
      const suggested = suggestedPlacementOf(lastReceipt);
      if (suggested !== null) {
        this.placeTarget = suggested;
      } else if (trailingFailedCount(recent, 'place_item') >= PLACE_OFFSETS.length && this.pendingPlaceItem !== null) {
        // 重启/插队场景：缓冲区尾部一排无建议坐标的 place 失败（每条都真实试过一个相邻格）→
        // 这件家具今天摆不下了，直接拉黑 + 单日冷却（真机 96 次同坐标复读教训）
        this.rejectedPlace.add(this.pendingPlaceItem);
        this.pendingPlaceItem = null;
        this.cooledTools.add('place_item');
      }
    }

    // 确定性作息护栏（人类玩家纪律）：23:00 必须回家睡觉；体力 <8% 先吃/回家
    if (state.clockMinutes >= 23 * 60) {
      if (state.location !== 'FarmHouse') {
        return { kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '太晚了，先回家准备睡觉（绝不晕倒）' };
      }
      return { kind: 'act', tool: 'sleep', args: {}, intent: '23 点了，马上睡觉，明天再干' };
    }
    const staminaRatio = state.staminaMax > 0 ? state.stamina / state.staminaMax : 1;
    if (staminaRatio < 0.08) {
      const food = listEdibleItems(state.raw).find((name) => !this.rejectedEat.has(name));
      if (food !== undefined) return { kind: 'act', tool: 'eat', args: { item: food }, intent: `体力见底，先吃点${food}垫垫` };
      if (state.location !== 'FarmHouse') return { kind: 'act', tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '没吃的了，先回家睡觉' };
      return { kind: 'act', tool: 'sleep', args: {}, intent: '体力见底，直接睡觉' };
    }

    // 农场上有空位时顺手造/摆箱子（长期解法：之后 tidy 就能真正存东西）
    if (!this.chestPlaced && effectiveSlots > 0) {
      if (hasChestItem(state.raw)) {
        if (!this.cooledTools.has('place_item') && state.location === 'Farm' && state.posX >= 0) {
          const free = findFreeTile(state.raw, state.posX, state.posY);
          const offset = PLACE_OFFSETS[0] ?? [1, 0];
          return {
            kind: 'act',
            tool: 'place_item',
            args: { item: 'Chest', x: free?.x ?? state.posX + offset[0], y: free?.y ?? state.posY + offset[1], force: true },
            intent: '把箱子摆到农场，之后背包满就有地方存了',
          };
        }
      } else if (!this.craftTried && countWood(state.raw) >= 50 && (state.location === 'Farm' || state.location === 'FarmHouse')) {
        return { kind: 'act', tool: 'craft', args: { recipe: 'Chest' }, intent: '木材够 50，先造一个箱子备用' };
      }
    }
    const inventoryFull =
      effectiveSlots <= 0 ||
      /背包满|背包.{0,6}满|空位：?0|空位 0|装不下/.test(recent.slice(-2).join(' '));
    // 腾出空位 = 本次背包危机结束，救援阶段归零
    if (effectiveSlots > 0) {
      this.rescueStage = 0;
      this.lastRescueFail = '';
      this.rejectedShip.clear();
      this.rejectedEat.clear();
      this.rejectedTrash.clear();
    }
    if (inventoryFull) {
      // 救援阶梯（BWF Tidy.cs：农场没有箱子时 tidy/store 必失败；feiyu LESSONS：满包合成会掉地上）：
      //   tidy（purpose 按当前时段）→ ship（不依赖箱子，能赚钱）→ eat → trash → store → 任意非必需品
      const noChest = /没有箱子|craft Chest/.test(recent.slice(-3).join(' '));
      // 先把最近回执里所有「单品级拒绝」记进黑名单（哪怕失败的不是最后一条）
      for (const receipt of recent.slice(-4)) {
        const tool = /^FAILED\s+([^\s:：]+)/.exec(receipt)?.[1] ?? '';
        if (tool !== 'ship_items' && tool !== 'eat' && tool !== 'trash_item') continue;
        const item = failedItemOf(receipt);
        if (item === '') continue;
        if (tool === 'ship_items') this.rejectedShip.add(item);
        else if (tool === 'eat') this.rejectedEat.add(item);
        else this.rejectedTrash.add(item);
      }
      const lastFail = failTools.at(-1) ?? '';
      if (lastFail !== '' && lastFail !== this.lastRescueFail) {
        this.lastRescueFail = lastFail;
        const failedItem = failedItemOf(recent.at(-1) ?? '');
        if (lastFail === 'ship_items' && failedItem !== '') {
          // 家具等「不能出货」的单品：记住它，换下一个候选（不降级）
          this.rejectedShip.add(failedItem);
        } else if (lastFail === 'eat' && failedItem !== '') {
          this.rejectedEat.add(failedItem);
        } else if (lastFail === 'trash_item' && failedItem !== '') {
          // BWF 会拒绝扔贵重物（「普通窗户一个能卖 300g，没有扔」）→ 记住换下一个
          this.rejectedTrash.add(failedItem);
        } else if (lastFail === 'craft') {
          this.craftTried = true;
        } else if (RESCUE_TOOLS.has(lastFail)) {
          // 策略级失败：跃迁到「该工具之后」的阶梯（ship 失败 → eat；eat 失败 → trash…）
          this.rescueStage = Math.min(
            Math.max(this.rescueStage + 1, (RESCUE_STEP.get(lastFail) ?? 0) + 1),
            5,
          );
        }
      }
      const start = noChest ? Math.max(1, this.rescueStage) : this.rescueStage;
      for (let step = start; step <= 10; step++) {
        const decision = this.rescueAction(step, state);
        if (decision) {
          this.rescueStage = step;
          return decision;
        }
      }
      // 连鱼饵都不让扔/没有候选：别再空转，等主人处理（看门狗会把 wait 事件亮出来）
      return { kind: 'wait', seconds: 30, reason: '背包卡死：没有可卖/可吃/可扔的东西了，主人给我造个箱子吧' };
    }
    if (repeated) {
      return this.fallback.decide(state);
    }
    const guidesHint = pickGuideContext(state, this.deps.guides);
    const receipts = recent.slice(-3).map((r) => `- ${r}`).join('\n');
    const user = `当前游戏状态：\n${state.raw.slice(0, 4000)}\n\n最近回执：\n${receipts || '（刚开始）'}\n\n请决定下一步动作，只输出一行 JSON。`;

    // 真纠错重问（T-M6-12 修复：旧实现注释写着「带纠错提示重问」，实际只是原样重发，
    // 大概率得到同样的坏输出）：把上一条原始输出 + 具体错误原因追加进对话再问一次
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: SYSTEM_TEMPLATE(guidesHint) },
      { role: 'user', content: user },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const receipt = await this.deps.chat('STARDEW_GAME_PLANNER', messages, { maxTokens: 400 });
        const decision = extractDecisionJson(receipt.content);
        if (decision !== null && LLM_TOOL_WHITELIST.has(decision.tool)) {
          if (this.cooledTools.has(decision.tool)) {
            messages.push({ role: 'assistant', content: receipt.content });
            messages.push({
              role: 'user',
              content: `${decision.tool} 今天已经失败到冷却了，别再试它。换一个不同的做法，只输出一行 JSON。`,
            });
            continue;
          }
          return { kind: 'act', tool: decision.tool, args: decision.args, intent: decision.intent };
        }
        const reason = decision === null
          ? '上一条输出里没有解析出 {"tool":...} 一行 JSON（可能被截断或夹了解释文字）'
          : `"${decision.tool}" 不在 BWF 工具白名单里`;
        messages.push({ role: 'assistant', content: receipt.content });
        messages.push({
          role: 'user',
          content: `${reason}。重新决定下一步，只输出一行 JSON：{"tool":"白名单工具名","args":{参数},"intent":"一句话"}，不要任何解释。`,
        });
      } catch {
        /* 网络/网关错误 → 原样重试一次（消息不变），再坏就回落 */
      }
    }
    // LLM 两连失败 → 规则引擎兜底（自动驾驶绝不因大脑掉线而停摆）
    return this.fallback.decide(state);
  }

  /** 救援阶梯单步决策（无该步可用对象或工具已单日冷却时返回 null，调用方继续下一步） */
  private rescueAction(step: number, state: GameStateSnapshot): PlannerDecision | null {
    switch (step) {
      case 0: {
        if (this.cooledTools.has('tidy_backpack')) return null;
        const fishingTime = state.clockMinutes >= 11 * 60 && state.clockMinutes < 17 * 60 + 30;
        return {
          kind: 'act',
          tool: 'tidy_backpack',
          args: fishingTime ? { purpose: 'fish' } : {},
          intent: '背包塞得满满当当，先整理出空位（不然连鱼都没地方放啦）',
        };
      }
      case 1: {
        if (this.cooledTools.has('ship_items')) return null;
        const item = listShippableItems(state.raw).find((n) => !this.rejectedShip.has(n));
        if (item === undefined) return null;
        return {
          kind: 'act',
          tool: 'ship_items',
          args: { item },
          intent: `先把${item}出货换米——腾位置还能赚一笔`,
        };
      }
      case 2: {
        if (this.cooledTools.has('eat')) return null;
        const item = listEdibleItems(state.raw).find((n) => !this.rejectedEat.has(n));
        if (item === undefined) return null;
        return { kind: 'act', tool: 'eat', args: { item }, intent: `吃掉${item}腾一格，顺便回点体力` };
      }
      case 3: {
        if (this.cooledTools.has('trash_item')) return null;
        const item = pickTrash(state.raw);
        if (item === null) return null;
        return { kind: 'act', tool: 'trash_item', args: { item }, intent: `把这件没用的${item}扔掉腾位置` };
      }
      case 4:
        if (this.cooledTools.has('store_items')) return null;
        return { kind: 'act', tool: 'store_items', args: {}, intent: '把杂物存进箱子腾位置（箱子满了就只能先出货了）' };
      case 5: {
        // 家具之类卖不掉又不吃的非工具物品；贵重物被 BWF 拒绝时退到鱼饵/种子类
        if (this.cooledTools.has('trash_item')) return null;
        const item = pickAnyNonEssential(state.raw, this.rejectedTrash)
          ?? pickTrashableFallback(state.raw, this.rejectedTrash);
        if (item === null) return null;
        return { kind: 'act', tool: 'trash_item', args: { item }, intent: `实在腾不出位置，只好忍痛扔掉${item}了` };
      }
      case 6: {
        // 只剩家具：摆到农场腾格（BWF place_item）；不在农场先回去
        if (this.cooledTools.has('place_item')) return null;
        // 失败轮换依据：单日失败计数（每下发一次只记一条，绝不饱和）+ 缓冲区尾部连续失败（覆盖重启/插队场景）
        const fails = Math.max(this.dayFails.get('place_item') ?? 0, trailingFailedCount(this.lastRecent, 'place_item'));
        if (fails >= PLACE_OFFSETS.length) {
          // 6 个相邻格全试过仍放不下（墙饰/被挡死）→ 记住这件家具并单日冷却 place_item，换 force 丢弃兜底
          if (this.pendingPlaceItem !== null) this.rejectedPlace.add(this.pendingPlaceItem);
          this.pendingPlaceItem = null;
          this.cooledTools.add('place_item');
          return null;
        }
        const item = pickFurnitureToPlace(state.raw, this.rejectedPlace);
        if (item === null) return null;
        // 换了一件家具 → 上一件的建议坐标已过期
        if (this.pendingPlaceItem !== null && item !== this.pendingPlaceItem) this.placeTarget = null;
        if (state.location !== 'Farm') {
          return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: '回农场把家具摆出来腾个背包格' };
        }
        const free = state.posX >= 0 ? findFreeTile(state.raw, state.posX, state.posY) : null;
        const offset = PLACE_OFFSETS[Math.min(fails, PLACE_OFFSETS.length - 1)] ?? [1, 0];
        const x = this.placeTarget?.x ?? free?.x ?? (state.posX >= 0 ? state.posX + offset[0] : -1);
        const y = this.placeTarget?.y ?? free?.y ?? (state.posY >= 0 ? state.posY + offset[1] : -1);
        if (x < 0 || y < 0) return null;
        this.pendingPlaceItem = item;
        return { kind: 'act', tool: 'place_item', args: { item, x, y, force: true }, intent: `把${item}摆到农场上，腾出一个背包格` };
      }
      case 7: {
        // 木材 ≥50 且有空位时造箱子（满包 craft 会掉地上，必须有空格）
        if (this.cooledTools.has('craft') || this.craftTried || this.chestPlaced || state.freeSlots <= 0) return null;
        if (hasChestItem(state.raw)) return null;
        if (countWood(state.raw) < 50) return null;
        return { kind: 'act', tool: 'craft', args: { recipe: 'Chest' }, intent: '木材够 50，造个箱子用来整理背包' };
      }
      case 8: {
        // 背包里已有箱子 → 摆到农场；不在农场先回去
        if (this.cooledTools.has('place_item')) return null;
        if (!hasChestItem(state.raw)) return null;
        if (state.location !== 'Farm') return { kind: 'act', tool: 'travel_to', args: { location: 'Farm' }, intent: '回农场把箱子摆出来' };
        const fails = Math.max(this.dayFails.get('place_item') ?? 0, trailingFailedCount(this.lastRecent, 'place_item'));
        const free = state.posX >= 0 ? findFreeTile(state.raw, state.posX, state.posY) : null;
        const offset = PLACE_OFFSETS[Math.min(fails, PLACE_OFFSETS.length - 1)] ?? [1, 0];
        const x = free?.x ?? (state.posX >= 0 ? state.posX + offset[0] : -1);
        const y = free?.y ?? (state.posY >= 0 ? state.posY + offset[1] : -1);
        if (x < 0 || y < 0) return null;
        this.pendingPlaceItem = 'Chest';
        return { kind: 'act', tool: 'place_item', args: { item: 'Chest', x, y, force: true }, intent: '把箱子摆到农场，之后就能整理背包了' };
      }
      case 9: {
        // 家具实在摆不下（墙饰/被挡）时强制丢弃一件贵重物换一格
        // force 兜底刻意忽略 rejectedTrash：普通 trash 被拒的贵重家具正是这里要强删的对象
        if (this.cooledTools.has('trash_item')) return null;
        const item = pickAnyNonEssential(state.raw);
        if (item === null) return null;
        return { kind: 'act', tool: 'trash_item', args: { item, force: true }, intent: `家具摆不下，只好忍痛丢掉${item}换一格了` };
      }
      default: {
        // 10：只剩任务/收集包材料 → 去社区中心捐掉（【留着】的正确出路，腾出多格）。
        // BWF 拒捐时会提示「用 bundle_info 看看缺什么」：按提示查一次（当天一次），失败预算耗尽即冷却不再空转
        if (!/【留着[^】]*】/.test(state.raw)) return null;
        if (this.cooledTools.has('donate_bundles')) {
          if (!this.dayInfoDone.has('bundle_info')) {
            this.dayInfoDone.add('bundle_info');
            return { kind: 'act', tool: 'bundle_info', args: {}, intent: '收集包材料捐不了，查查到底还缺什么（BWF 提示的）' };
          }
          return null;
        }
        if ((this.dayFails.get('donate_bundles') ?? 0) >= 1 && !this.dayInfoDone.has('bundle_info')) {
          this.dayInfoDone.add('bundle_info');
          return { kind: 'act', tool: 'bundle_info', args: {}, intent: '第一次捐失败了，先看看收集包缺什么材料再捐' };
        }
        return { kind: 'act', tool: 'donate_bundles', args: {}, intent: '背包只剩收集包材料了，去社区中心捐掉换空位' };
      }
    }
  }

  get asks(): number {
    return this.askCount;
  }
}
