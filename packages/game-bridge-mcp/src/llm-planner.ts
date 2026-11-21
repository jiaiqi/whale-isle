/**
 * LLM Planner（T-M6-01 完整版核心）：小鲸的「聪明大脑」——
 * get_state + 攻略摘要 → model-gateway（DeepSeek 等）→ JSON 工具决策。
 * 健壮性铁律：LLM 输出解析失败/超时/越权工具名 → 逐级回落（重问一次 → RulePlanner 兜底），
 * 绝不让坏输出卡死自动驾驶。
 * 决策协议（user 消息尾部约定）：
 *   只输出一行 JSON：{"tool":"动作名","args":{},"intent":"一句话人设化意图"}
 */
import type { GameStateSnapshot, Planner, PlannerDecision } from './planner';
import { RulePlanner } from './planner';

/** BWF 工具白名单（越权工具名一律拒绝——运行期安全锁） */
export const LLM_TOOL_WHITELIST = new Set([
  'get_state', 'get_guide', 'move_to', 'travel_to', 'use_tool', 'interact', 'place_item',
  'till_area', 'plant_seeds', 'water_crops', 'harvest_crops', 'clear_area', 'forage',
  'ship_items', 'store_items', 'list_chests', 'map_info', 'take_items', 'trash_item',
  'eat', 'use_item', 'open_shop', 'buy', 'sell', 'craft', 'dialogue', 'menu_click',
  'close_menu', 'read_mail', 'choose_profession', 'skip_event', 'leave_festival',
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
4. args 的键必须与该工具的真实参数名一致；不确定参数就给空对象 {}。`;

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

export class LlmPlanner implements Planner {
  readonly name = 'llm-xiaojing';
  private readonly fallback = new RulePlanner();
  private askCount = 0;

  constructor(private readonly deps: LlmPlannerDeps) {}

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    this.askCount++;
    // 菜单优先（确定性处理，不烧 LLM）
    const menu = state.menu;
    if (menu !== '' && !/无（可以自由行动）/.test(menu)) {
      return this.fallback.decide(state);
    }
    const guidesHint = pickGuideContext(state, this.deps.guides);
    const receipts = (this.deps.recentReceipts ?? []).slice(-3).map((r) => `- ${r}`).join('\n');
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

  get asks(): number {
    return this.askCount;
  }
}
