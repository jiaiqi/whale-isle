/**
 * 对话→游戏指令解析（T-M6-17 用户指令：聊天下单小鲸要真的去做，不能只回复）。
 *
 * 双层解析（确定性优先）：
 *   ①关键词直译——零 token、毫秒级，覆盖最高频的家常指令（去某地/钓鱼/睡觉/采集/读信…）；
 *     带「疑问/回忆不接单」防误触发（「昨天在海滩钓鱼了吗」绝不能接单去钓鱼）；
 *   ②LLM 指令解析——带当前游戏状态上下文，把「把斧子还给罗宾」这类需要状态填参的
 *     自然语言解析成白名单工具调用；解析不出动作 → 返回 null（纯聊天，不动手）。
 *
 * 2026-11-24 扩展两种接单形态（真机「去找鱼竿」只回复不执行）：
 *   a) 单步原子动作（一个工具就能完成）→ submitDirective 立即插队；
 *   b) 多步目标（找鱼竿/攒钱买鸡舍/买种子）→ submitObjective 交给 planner 持续驱动，
 *      可带 firstTool 首步动作立刻执行。
 * 与回话的契约：调用方先解析指令、再生成回话——回话 system 注入「已接单」ack，
 * 保证小鲸嘴里说的和她马上要做的一致（说到做到）。
 */
import { extractJsonObject, LLM_TOOL_WHITELIST, type GameStateSnapshot } from '@workbench/game-bridge-mcp';

/** 单步原子动作：一个工具立刻可完成 */
export interface ChatDirective {
  kind: 'act';
  tool: string;
  args: Record<string, unknown>;
  intent: string;
  /** 'keyword'（确定性直译）| 'llm'（状态感知解析）——日志与接单卡展示用 */
  source: 'keyword' | 'llm';
}

/** 多步目标：需要连续多个动作才能完成，交给 planner 持续驱动直到完成/被替换 */
export interface ChatObjective {
  kind: 'objective';
  objective: string;
  /** 可选首步动作：接到目标后立刻执行，之后由 planner 继续推进目标 */
  firstTool?: string;
  firstArgs?: Record<string, unknown>;
  intent: string;
  source: 'llm';
}

export type ChatOrder = ChatDirective | ChatObjective;

/** 关键词表内的指令（kind 由 resolveKeywordDirective 统一补齐） */
type KeywordDirective = Omit<ChatDirective, 'kind'>;

/** 疑问/回忆/反问不接单：这些是「问」，不是「做」（关键词层的防误触发闸门） */
const NOT_AN_ORDER_RE = /吗[？?]?$|呢[？?]?$|有没有|是不是|能不能|可不可以|昨天|上次|刚才|为什么|什么时候|怎么(样|做)|多少/;

/** 关键词直译表：高频家常指令零 token 接单（LLM 兜其余） */
const KEYWORD_DIRECTIVES: KeywordDirective[] = [
  { source: 'keyword', tool: 'travel_to', args: { location: 'Beach' }, intent: '去海滩' },
  { source: 'keyword', tool: 'travel_to', args: { location: 'Farm' }, intent: '去农场' },
  { source: 'keyword', tool: 'travel_to', args: { location: 'Town' }, intent: '去镇上' },
  { source: 'keyword', tool: 'travel_to', args: { location: 'Mine' }, intent: '去矿洞' },
  { source: 'keyword', tool: 'travel_to', args: { location: 'CommunityCenter' }, intent: '去社区中心' },
  { source: 'keyword', tool: 'travel_to', args: { location: 'FarmHouse' }, intent: '回家' },
  { source: 'keyword', tool: 'fish', args: {}, intent: '钓鱼' },
  { source: 'keyword', tool: 'tidy_backpack', args: {}, intent: '整理背包腾位置' },
  { source: 'keyword', tool: 'water_crops', args: {}, intent: '给作物浇水' },
  { source: 'keyword', tool: 'harvest_crops', args: {}, intent: '收获成熟的作物' },
  { source: 'keyword', tool: 'forage', args: {}, intent: '采集地上的东西' },
  { source: 'keyword', tool: 'read_mail', args: {}, intent: '读信' },
  { source: 'keyword', tool: 'quest_board', args: {}, intent: '看看告示板的任务' },
  { source: 'keyword', tool: 'donate_bundles', args: {}, intent: '把收集包材料捐给社区中心' },
  { source: 'keyword', tool: 'sleep', args: {}, intent: '回家睡觉' },
  { source: 'keyword', tool: 'craft', args: { recipe: 'Chest' }, intent: '造一个箱子放杂物' },
];

/** 关键词 → 触发正则（按表序匹配第一个命中；「疑问/回忆」直接不接单走 LLM 复核） */
const KEYWORD_PATTERNS: Array<{ directive: KeywordDirective; re: RegExp }> = [
  { directive: KEYWORD_DIRECTIVES[0] as KeywordDirective, re: /(去|到|回|先去).{0,4}(海滩|海边|Beach)/i },
  { directive: KEYWORD_DIRECTIVES[1] as KeywordDirective, re: /(去|到|回|先去).{0,4}(农场|田里|Farm)(?!House)/i },
  { directive: KEYWORD_DIRECTIVES[2] as KeywordDirective, re: /(去|到|回|逛逛?|先去).{0,4}(镇上|镇里|鹈鹕镇|Town)/i },
  { directive: KEYWORD_DIRECTIVES[3] as KeywordDirective, re: /(去|下|回|先去).{0,4}(矿洞|矿|Mine)/i },
  { directive: KEYWORD_DIRECTIVES[4] as KeywordDirective, re: /(去|到|回|先去).{0,4}(社区中心|社区|CommunityCenter)/i },
  { directive: KEYWORD_DIRECTIVES[5] as KeywordDirective, re: /回.{0,2}家|FarmHouse|回房|回屋|睡觉前|先回家/i },
  { directive: KEYWORD_DIRECTIVES[6] as KeywordDirective, re: /钓鱼|钓一(竿|会|会儿)|甩竿|fish/i },
  { directive: KEYWORD_DIRECTIVES[15] as KeywordDirective, re: /(造|做|合成|craft).{0,4}(箱|Chest)/i },
  { directive: KEYWORD_DIRECTIVES[7] as KeywordDirective, re: /(整理|清理|清空|收拾).{0,3}背包|背包.{0,4}满|腾.{0,3}(位置|空位|地方|格子)/ },
  { directive: KEYWORD_DIRECTIVES[8] as KeywordDirective, re: /浇水|浇一(下|遍)|灌溉/ },
  { directive: KEYWORD_DIRECTIVES[9] as KeywordDirective, re: /(收获|收一(下|遍)|收菜|收作物)/ },
  { directive: KEYWORD_DIRECTIVES[10] as KeywordDirective, re: /(采集|捡(东西|一捡|一下)|捡点)/ },
  { directive: KEYWORD_DIRECTIVES[11] as KeywordDirective, re: /(读|看).{0,2}信|邮箱|收信/ },
  { directive: KEYWORD_DIRECTIVES[12] as KeywordDirective, re: /(看|查|接).{0,3}(任务|委托|告示板|公告)/ },
  { directive: KEYWORD_DIRECTIVES[13] as KeywordDirective, re: /(捐|交).{0,4}(收集包|社区中心|礼包|bundle)/i },
  { directive: KEYWORD_DIRECTIVES[14] as KeywordDirective, re: /(睡觉|睡吧|去睡|休息一下)/ },
];

/** 一款游戏的「聊天→动作」指令档案（M7 多游戏：新游戏提供自己的表，默认星露谷行为不变） */
export interface DirectiveProfile {
  gameName: string;
  keywords: ReadonlyArray<{ directive: KeywordDirective; re: RegExp }>;
  /** 工具与参数说明原文（进 system prompt；严禁臆造参数） */
  toolDoc: string;
  /** 运行时安全锁：白名单外工具一律拒收 */
  whitelist: ReadonlySet<string>;
}

/** 星露谷默认档案（原有 15 条关键词 + BWF 工具说明，真机行为零变化） */
export const STARDEW_DIRECTIVE_PROFILE: DirectiveProfile = {
  gameName: '星露谷物语',
  keywords: KEYWORD_PATTERNS,
  toolDoc: `移动：travel_to {"location":"Beach|Town|Farm|FarmHouse|Mine|CommunityCenter|Mountain|Saloon|FishShop|Forest|Desert"}
农活：water_crops / harvest_crops / forage / clear_area {x1,y1,x2,y2|radius} / till_area / plant_seeds {"seed"}
钓鱼：fish {"casts":1-20}；背包：tidy_backpack {"purpose":"mine|fish|farm|town"} / list_chests {"item"?}（查所有箱子里的东西，可带 item 过滤）/ take_items {"items":[...],"from"?} / ship_items {"item"} / store_items / trash_item {"item",count?,force?}
交互：interact {"npc"|"x","y"}；送礼：give_gift {"npc","item"}（先用状态里的名字，别猜）；读信 read_mail；任务 quest_board {"accept":true}；睡觉 sleep；吃饭 eat {"item"}；制作 craft {"recipe"}；摆放 place_item {"item"}；购买 open_shop/buy {"item","count"}（鱼竿在 FishShop 的威利处买）；出售 sell {"item"}；社区中心 bundle_info / donate_bundles；矿洞 explore_mine {"levels"}；战斗 fight。`,
  whitelist: LLM_TOOL_WHITELIST,
};

/**
 * 取消当前多步目标（仅当确实有目标时由调用方消费）：
 * 「算了」「取消目标」「不用了」「别找了」等整句短指令，避免误伤普通聊天。
 */
const CANCEL_OBJECTIVE_RE = /^(?:(?:算了|取消(?:当前)?(?:多步)?(?:目标|任务|计划)?|停止(?:当前)?(?:目标|任务|计划)?|结束(?:当前)?(?:目标|任务|计划)?|放弃(?:当前)?(?:目标|任务)?|不找了|不用了|不要了|别做了|别找了|停下来|停)[，,。.!！?？\s]*)+$/;

export function isCancelDirective(text: string): boolean {
  return CANCEL_OBJECTIVE_RE.test(text.trim());
}

/** 确定性直译：命中返回指令；「疑问/回忆」文本返回 null（交给 LLM 层复核，绝不误接单） */
export function resolveKeywordDirective(text: string, profile: DirectiveProfile = STARDEW_DIRECTIVE_PROFILE): ChatDirective | null {
  if (NOT_AN_ORDER_RE.test(text)) return null;
  const hit = profile.keywords.find((k) => k.re.test(text));
  return hit === undefined ? null : { ...hit.directive, kind: 'act', intent: `主人指令：${hit.directive.intent}` };
}

/** LLM 指令解析 system：与游戏规划器同一套白名单语义 + 状态填参提示 + 两种接单形态 */
export function buildDirectiveSystemPrompt(profile: DirectiveProfile = STARDEW_DIRECTIVE_PROFILE, characterName = '小鲸'): string {
  return `你是「${characterName}」的指令解析器：判断主人刚说的话是不是要${characterName}在《${profile.gameName}》里执行的动作或目标。
只输出一行 JSON，两种形态二选一：
a) 单步原子动作（一个工具就能完成，如「去钓鱼」「浇水」「回家」）：
   {"tool":"工具名","args":{参数},"intent":"一句话说明"}
b) 多步目标（需要连续多个动作才能完成，如「去找鱼竿」「攒钱买鸡舍」「去买夏季种子」）：
   {"tool":"","objective":"主人要求的具体目标","firstTool":"可选的首步工具名","firstArgs":{首步参数},"intent":"一句话说明"}
   示例：「去找鱼竿」→ {"tool":"","objective":"找到或买一根鱼竿（先查箱子 list_chests，没有就去 FishShop 买）","firstTool":"list_chests","firstArgs":{},"intent":"去箱子找鱼竿"}
- 不是动作/目标（闲聊、提问、感想、角色扮演）→ 只输出 {"tool":"","args":{},"intent":""}。
可用的工具与参数（严禁臆造）：
${profile.toolDoc}
args 里的物品/人名一律照抄「当前游戏状态」里的原文。宁可解析不成也不要猜参数。`;
}

/** LLM 指令解析 user：原话 + 当前游戏状态节选（有状态才能填对参数） */
export function buildDirectiveUserPrompt(text: string, state: Pick<GameStateSnapshot, 'raw'>): string {
  return `主人对你说：「${text}」

当前游戏状态（节选）：
${state.raw.slice(0, 3500)}

判断并按约定只输出一行 JSON。`;
}

/**
 * 解析 LLM 输出：
 * - tool 非空 + 白名单内 → 单步动作（白名单外一律拒收，运行期安全锁）；
 * - tool 为空 + objective 非空 → 多步目标（firstTool 必须过白名单，否则只保留目标）；
 * - 其余 → null（纯聊天，不动手）。
 */
export function parseDirectiveResponse(content: string, profile: DirectiveProfile = STARDEW_DIRECTIVE_PROFILE): ChatOrder | null {
  const obj = extractJsonObject(content);
  if (obj === null) return null;
  const tool = typeof obj.tool === 'string' ? obj.tool.trim() : '';
  const intent = typeof obj.intent === 'string' && obj.intent.trim() !== '' ? obj.intent.trim() : '';
  if (tool === '') {
    const objective = typeof obj.objective === 'string' ? obj.objective.trim().slice(0, 300) : '';
    if (objective === '') return null;
    const firstRaw = typeof obj.firstTool === 'string' ? obj.firstTool.trim() : '';
    const firstTool = firstRaw !== '' && profile.whitelist.has(firstRaw) ? firstRaw : undefined;
    const firstArgs = firstTool !== undefined && typeof obj.firstArgs === 'object' && obj.firstArgs !== null
      ? (obj.firstArgs as Record<string, unknown>)
      : undefined;
    return {
      kind: 'objective',
      objective,
      ...(firstTool !== undefined ? { firstTool } : {}),
      ...(firstArgs !== undefined ? { firstArgs } : {}),
      intent: intent === '' ? objective : intent,
      source: 'llm',
    };
  }
  if (!profile.whitelist.has(tool)) return null;
  const args = typeof obj.args === 'object' && obj.args !== null ? (obj.args as Record<string, unknown>) : {};
  return { kind: 'act', tool, args, intent: intent === '' ? '主人指令' : intent, source: 'llm' };
}
