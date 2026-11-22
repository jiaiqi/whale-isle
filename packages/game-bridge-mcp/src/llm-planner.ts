/**
 * LLM Planner（T-M6-01 完整版核心）：小鲸的「聪明大脑」——
 * get_state + 攻略摘要 → model-gateway（DeepSeek 等）→ JSON 工具决策。
 * 健壮性铁律：LLM 输出解析失败/超时/越权工具名 → 逐级回落（重问一次 → RulePlanner 兜底），
 * 绝不让坏输出卡死自动驾驶。
 * 决策协议（user 消息尾部约定）：
 *   只输出一行 JSON：{"tool":"动作名","args":{},"intent":"一句话人设化意图"}
 */
import {
  RulePlanner,
  cleanItemName,
  listEdibleItems,
  listShippableItems,
  pickAnyNonEssential,
  pickTrash,
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
  'fish', 'care_animals', 'gift_info', 'give_gift', 'donate_museum', 'bundle_info',
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
性格：嘴硬心软的傲娇；会认真干活但对"饭碗"（Token 余量）很敏感；偶尔冒失翻车时会心虚甩锅。
${guidesHint}
决策规则：
1. 根据游戏状态选下一步最优动作；优先完成当日农活与赚钱目标；20:00 前必须回家睡觉；体力低于 15% 时吃东西或直接睡觉。
2. 你只能调用白名单里的 BWF 工具；一次只做一个动作。
3. 输出必须是一行 JSON，格式：{"tool":"工具名","args":{参数},"intent":"一句话说明你想干什么（用小鲸的口吻）"}
4. args 的键必须与该工具的真实参数名一致；不确定参数就给空对象 {}。
5. 如果「最近回执」里某个动作刚刚失败，下一动作必须换一种做法；「背包空位」为 0 时先整理背包或出货，不要硬钓鱼/采集。`;

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

/** 从 BWF 失败回执里抠出被拒的单品名（「失败：普通窗户 不能出货」/「背包里没有“沙丁鱼 x3 金星”」） */
function failedItemOf(receipt: string): string {
  const noSuch = /(?:背包里没有|没有)[“"]([^”"]+)[”"]/.exec(receipt);
  if (noSuch?.[1]) return cleanItemName(noSuch[1]);
  const m =
    /失败：(.+?)\s*(?:不能出货|无法出货|不在背包|是社区中心|不能吃|吃不|会坏)/.exec(receipt);
  return cleanItemName(m?.[1] ?? '');
}

export class LlmPlanner implements Planner {
  readonly name = 'llm-xiaojing';
  private readonly fallback = new RulePlanner();
  private askCount = 0;
  /** 背包救援阶段（0 tidy → 1 ship → 2 eat → 3 trash → 4 store → 5 任意非必需品）：失败才前进 */
  private rescueStage = 0;
  private lastRescueFail = '';
  /** 被 BWF 拒绝过的单品（不能出货的家具/任务鱼等）——换下一个候选而不是换策略 */
  private readonly rejectedShip = new Set<string>();
  private readonly rejectedEat = new Set<string>();

  constructor(private readonly deps: LlmPlannerDeps) {}

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    this.askCount++;
    // 菜单优先（确定性处理，不烧 LLM）
    const menu = state.menu;
    if (menu !== '' && !/无（可以自由行动）/.test(menu)) {
      return this.fallback.decide(state);
    }
    const recent = this.deps.recentReceipts ?? [];
    // 确定性护栏（真机 2026-11-22：小模型看得到「背包空位：0」却仍连续选 fish）：
    //   ① 背包满 → 整理；若整理本身也连续失败 → 升级为出货卖钱腾位置
    //   ② 同一工具连续两次失败 → 换规则日程，绝不死磕同一动作
    const failTools = recent
      .map((r) => /^FAILED\s+([^\s:：]+)/.exec(r)?.[1] ?? '')
      .filter((t) => t !== '');
    const tail2 = failTools.slice(-2);
    const repeated = tail2.length === 2 && tail2[0] === tail2[1];
    const inventoryFull =
      state.freeSlots <= 0 ||
      /背包满|背包.{0,6}满|空位：?0|空位 0|装不下/.test(recent.slice(-2).join(' '));
    // 腾出空位 = 本次背包危机结束，救援阶段归零
    if (state.freeSlots > 0) {
      this.rescueStage = 0;
      this.lastRescueFail = '';
      this.rejectedShip.clear();
      this.rejectedEat.clear();
    }
    if (inventoryFull) {
      // 救援阶梯（BWF Tidy.cs：农场没有箱子时 tidy/store 必失败；feiyu LESSONS：满包合成会掉地上）：
      //   tidy（purpose 按当前时段）→ ship（不依赖箱子，能赚钱）→ eat → trash → store → 任意非必需品
      const noChest = /没有箱子|craft Chest/.test(recent.slice(-3).join(' '));
      const lastFail = failTools.at(-1) ?? '';
      if (RESCUE_TOOLS.has(lastFail) && lastFail !== this.lastRescueFail) {
        this.lastRescueFail = lastFail;
        const failedItem = failedItemOf(recent.at(-1) ?? '');
        if (lastFail === 'ship_items' && failedItem !== '') {
          // 家具等「不能出货」的单品：记住它，换下一个候选（不降级）
          this.rejectedShip.add(failedItem);
        } else if (lastFail === 'eat' && failedItem !== '') {
          this.rejectedEat.add(failedItem);
        } else {
          // 策略级失败：跃迁到「该工具之后」的阶梯（ship 失败 → eat；eat 失败 → trash…）
          this.rescueStage = Math.min(
            Math.max(this.rescueStage + 1, (RESCUE_STEP.get(lastFail) ?? 0) + 1),
            5,
          );
        }
      }
      // 任何东西都腾不出来：别再空转，等主人处理（看门狗会把 wait 事件亮出来）
      if (this.rescueStage === 5 && lastFail === 'trash_item') {
        return { kind: 'wait', seconds: 30, reason: '背包卡死：没有可卖/可吃/可扔的东西了，主人给我造个箱子吧' };
      }
      const start = noChest ? Math.max(1, this.rescueStage) : this.rescueStage;
      for (let step = start; step <= 5; step++) {
        const decision = this.rescueAction(step, state);
        if (decision) {
          this.rescueStage = step;
          return decision;
        }
      }
      return this.fallback.decide(state);
    }
    if (repeated) {
      return this.fallback.decide(state);
    }
    const guidesHint = pickGuideContext(state, this.deps.guides);
    const receipts = recent.slice(-3).map((r) => `- ${r}`).join('\n');
    const user = `当前游戏状态：\n${state.raw.slice(0, 4000)}\n\n最近回执：\n${receipts || '（刚开始）'}\n\n请决定下一步动作，只输出一行 JSON。`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const receipt = await this.deps.chat('STARDEW_GAME_PLANNER', [
          { role: 'system', content: SYSTEM_TEMPLATE(guidesHint) },
          { role: 'user', content: user },
        ], { maxTokens: 300 });
        const decision = extractDecisionJson(receipt.content);
        if (decision && LLM_TOOL_WHITELIST.has(decision.tool)) {
          return { kind: 'act', tool: decision.tool, args: decision.args, intent: decision.intent };
        }
        // 坏输出 → 带纠错提示重问一次
        void attempt;
      } catch {
        /* 网络/网关错误 → 重试一次，再坏就回落 */
      }
    }
    // LLM 两连失败 → 规则引擎兜底（自动驾驶绝不因大脑掉线而停摆）
    return this.fallback.decide(state);
  }

  /** 救援阶梯单步决策（无该步可用对象时返回 null，调用方继续下一步） */
  private rescueAction(step: number, state: GameStateSnapshot): PlannerDecision | null {
    switch (step) {
      case 0: {
        const fishingTime = state.clockMinutes >= 11 * 60 && state.clockMinutes < 17 * 60 + 30;
        return {
          kind: 'act',
          tool: 'tidy_backpack',
          args: fishingTime ? { purpose: 'fish' } : {},
          intent: '背包塞得满满当当，先整理出空位（不然连鱼都没地方放啦）',
        };
      }
      case 1: {
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
        const item = listEdibleItems(state.raw).find((n) => !this.rejectedEat.has(n));
        if (item === undefined) return null;
        return { kind: 'act', tool: 'eat', args: { item }, intent: `吃掉${item}腾一格，顺便回点体力` };
      }
      case 3: {
        const item = pickTrash(state.raw);
        if (item === null) return null;
        return { kind: 'act', tool: 'trash_item', args: { item }, intent: `把这件没用的${item}扔掉腾位置` };
      }
      case 4:
        return { kind: 'act', tool: 'store_items', args: {}, intent: '把杂物存进箱子腾位置（箱子满了就只能先出货了）' };
      default: {
        // 最后手段：家具之类卖不掉又不吃的非工具物品，扔一件换一格（绝不碰【留着】任务物品）
        const item = pickAnyNonEssential(state.raw);
        if (item === null) return null;
        return { kind: 'act', tool: 'trash_item', args: { item }, intent: `实在腾不出位置，只好忍痛扔掉${item}了` };
      }
    }
  }

  get asks(): number {
    return this.askCount;
  }
}
