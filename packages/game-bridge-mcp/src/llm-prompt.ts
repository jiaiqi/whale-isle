/**
 * LLM 全权决策模式的 Prompt 组装、JSON 解析与 BWF 参数归一化（T-M6-70 §4.2–§4.6）。
 *
 * 原则：
 *   - 生存风险（体力、距 02:00 剩余时间、生命、背包空位）以醒目段落提醒，绝不在代码里替模型改动作；
 *   - 失败记忆（归一化签名、连败次数、时钟停滞秒数）显式写入上下文并要求换做法；
 *   - 主人的 `/自然语言` 强制命令排在当日计划之前，只允许 execute / infeasible（带具体原因）；
 *   - 普通聊天消息作为主人建议注入，模型按人设输出 accept / modify / decline + reply。
 */
import {
  GameKnowledgeSourceTypeSchema,
  GameKnowledgeStatusSchema,
} from '@workbench/shared-protocol';
import { cleanItemName, inventoryTexts, type GameStateSnapshot } from './planner';
import { parsePlanUpdate, type DayPlanUpdate } from './day-plan';
import { InsightVerdictSchema, type LlmInsightDraft } from './strategy-notebook';

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
  'festival',
]);

/** 只收单数 item 的 BWF 工具（schema required: item）；LLM 偶尔发 items 数组/对象 */
const SINGLE_ITEM_TOOLS = new Set(['ship_items', 'trash_item', 'place_item', 'eat', 'buy', 'sell', 'give_gift']);

function firstItemName(value: unknown): unknown {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' || typeof item === 'number') ?? value[0];
    return firstItemName(first);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ['name', 'itemName', 'item', 'id']) {
      if (typeof record[key] === 'string') return record[key];
    }
    const keys = Object.keys(record);
    if (keys.length > 0) return keys[0] ?? value;
    return undefined;
  }
  return normalizeToolArg(value);
}

/** 把 LLM 常见的「数组/对象包一层」参数压成 BWF 期望的标量 */
export function normalizeToolArg(value: unknown): unknown {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' || typeof item === 'number') ?? value[0];
    return normalizeToolArg(first);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      try {
        return normalizeToolArg(JSON.parse(trimmed) as unknown);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ['name', 'itemName', 'item', 'id']) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return value;
}

export function normalizeToolArgs(args: Record<string, unknown>, tool = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = normalizeToolArg(value);
  if (SINGLE_ITEM_TOOLS.has(tool) && out['item'] === undefined) {
    const source = args['items'] ?? args['itemName'] ?? args['name'];
    if (source !== undefined) {
      const name = firstItemName(source);
      if (name !== undefined) out['item'] = name;
      delete out['items'];
      delete out['itemName'];
      delete out['name'];
    }
  }
  if (tool === 'take_items') {
    const source = args['items'] ?? args['item'];
    if (Array.isArray(source)) {
      out['items'] = source.map((value) => String(firstItemName(value))).filter((value) => value !== '').join(',');
      delete out['item'];
    } else if (typeof source === 'object' && source !== null) {
      out['items'] = Object.keys(source).join(',');
      delete out['item'];
    } else if (source !== undefined && out['items'] === undefined) {
      out['items'] = normalizeToolArg(source);
      delete out['item'];
    }
  }
  if (tool === 'plant_seeds' && out['seed'] === undefined) {
    const source = args['seeds'] ?? args['item'];
    if (source !== undefined) {
      out['seed'] = firstItemName(source);
      delete out['seeds'];
      delete out['item'];
    }
  }
  if (tool === 'craft' && out['recipe'] === undefined) {
    const source = args['recipeName'] ?? args['item'] ?? args['name'];
    if (source !== undefined) {
      out['recipe'] = firstItemName(source);
      delete out['recipeName'];
      delete out['item'];
      delete out['name'];
    }
  }
  return out;
}

/** 从 LLM 输出中宽松提取首个 JSON 对象（容忍 markdown 围栏/前后缀文本与 <think> 块） */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const source = stripped.includes('{') ? stripped : content;
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
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
          const obj = JSON.parse(source.slice(start, i + 1)) as unknown;
          return typeof obj === 'object' && obj !== null && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export type SuggestionStance = 'accept' | 'modify' | 'decline';
export type CommandStance = 'execute' | 'infeasible';
export type ChatStanceValue = SuggestionStance | CommandStance;

export interface ParsedAutonomousDecision {
  tool?: string;
  args: Record<string, unknown>;
  intent: string;
  objectiveDone?: boolean;
  commandDone?: boolean;
  planUpdate?: DayPlanUpdate;
  insight?: LlmInsightDraft;
  usedInsight?: string;
  stance?: string;
  reply?: string;
  reason?: string;
  alternative?: string;
}

function parseStringListField(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  return list;
}

function parseInsightField(raw: unknown): LlmInsightDraft | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const claim = typeof rec['claim'] === 'string' ? rec['claim'].trim() : '';
  const why = typeof rec['why'] === 'string' ? rec['why'].trim() : '';
  const verdict = InsightVerdictSchema.safeParse(typeof rec['verdict'] === 'string' ? rec['verdict'].trim().toLowerCase() : '');
  if (claim === '' || why === '' || !verdict.success) return undefined;
  const source = typeof rec['source'] === 'string' && rec['source'].trim() !== '' ? rec['source'].trim() : '游戏攻略分析';
  const when = typeof rec['when'] === 'string' && rec['when'].trim() !== '' ? rec['when'].trim() : undefined;
  const evidence = typeof rec['evidence'] === 'string' && rec['evidence'].trim() !== '' ? rec['evidence'].trim() : undefined;
  const sourceType = typeof rec['sourceType'] === 'string'
    ? GameKnowledgeSourceTypeSchema.safeParse(rec['sourceType'].trim().toLowerCase())
    : null;
  const status = typeof rec['status'] === 'string'
    ? GameKnowledgeStatusSchema.safeParse(rec['status'].trim().toLowerCase())
    : null;
  const gameVersion = typeof rec['gameVersion'] === 'string' && rec['gameVersion'].trim() !== '' ? rec['gameVersion'].trim() : undefined;
  const modContext = parseStringListField(rec['modContext']);
  const confidence = typeof rec['confidence'] === 'number' && Number.isFinite(rec['confidence']) && rec['confidence'] >= 0 && rec['confidence'] <= 1
    ? rec['confidence']
    : undefined;
  const applicability = parseStringListField(rec['applicability']);
  const knownLimitations = parseStringListField(rec['knownLimitations']);
  const contradictoryEvidence = parseStringListField(rec['contradictoryEvidence']);
  return {
    source,
    claim,
    ...(when === undefined ? {} : { when }),
    verdict: verdict.data,
    why,
    ...(evidence === undefined ? {} : { evidence }),
    ...(sourceType?.success ? { sourceType: sourceType.data } : {}),
    ...(status?.success ? { status: status.data } : {}),
    ...(gameVersion === undefined ? {} : { gameVersion }),
    ...(modContext === undefined ? {} : { modContext }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(applicability === undefined ? {} : { applicability }),
    ...(knownLimitations === undefined ? {} : { knownLimitations }),
    ...(contradictoryEvidence === undefined ? {} : { contradictoryEvidence }),
  };
}

/** 保持向后兼容的决策提取函数（要求非空 tool） */
export function extractDecisionJson(
  content: string,
): { tool: string; args: Record<string, unknown>; intent: string; objectiveDone?: boolean } | null {
  const obj = extractJsonObject(content);
  if (obj === null) return null;
  if (typeof obj['tool'] !== 'string' || obj['tool'].trim().length === 0) return null;
  const tool = obj['tool'].trim();
  const rawArgs = typeof obj['args'] === 'object' && obj['args'] !== null && !Array.isArray(obj['args'])
    ? (obj['args'] as Record<string, unknown>)
    : {};
  return {
    tool,
    args: normalizeToolArgs(rawArgs, tool),
    intent: typeof obj['intent'] === 'string' && obj['intent'].trim() !== '' ? obj['intent'].trim() : '小鲸的下一步',
    ...(obj['objectiveDone'] === true ? { objectiveDone: true } : {}),
  };
}

/** 解析 T-M6-70 全权决策输出（兼容仅输出 infeasible 无 tool 的强制命令答复） */
export function parseAutonomousDecision(content: string): ParsedAutonomousDecision | null {
  const obj = extractJsonObject(content);
  if (obj === null) return null;
  const tool = typeof obj['tool'] === 'string' && obj['tool'].trim() !== '' ? obj['tool'].trim() : undefined;
  const stance = typeof obj['stance'] === 'string' && obj['stance'].trim() !== '' ? obj['stance'].trim().toLowerCase() : undefined;
  if (tool === undefined && stance === undefined) return null;
  const rawArgs = typeof obj['args'] === 'object' && obj['args'] !== null && !Array.isArray(obj['args'])
    ? (obj['args'] as Record<string, unknown>)
    : {};
  const planUpdate = obj['planUpdate'] !== undefined ? parsePlanUpdate(obj['planUpdate']) : null;
  const reply = typeof obj['reply'] === 'string' && obj['reply'].trim() !== '' ? obj['reply'].trim() : undefined;
  const reason = typeof obj['reason'] === 'string' && obj['reason'].trim() !== '' ? obj['reason'].trim() : undefined;
  const alternative = typeof obj['alternative'] === 'string' && obj['alternative'].trim() !== ''
    ? obj['alternative'].trim()
    : undefined;
  const insight = obj['insight'] !== undefined ? parseInsightField(obj['insight']) : undefined;
  const usedInsight = typeof obj['usedInsight'] === 'string' && obj['usedInsight'].trim() !== ''
    ? obj['usedInsight'].trim()
    : undefined;
  return {
    ...(tool === undefined ? {} : { tool }),
    args: tool === undefined ? rawArgs : normalizeToolArgs(rawArgs, tool),
    intent: typeof obj['intent'] === 'string' && obj['intent'].trim() !== '' ? obj['intent'].trim() : (reply ?? '小鲸的下一步'),
    ...(obj['objectiveDone'] === true ? { objectiveDone: true } : {}),
    ...(obj['commandDone'] === true ? { commandDone: true } : {}),
    ...(planUpdate === null ? {} : { planUpdate }),
    ...(insight === undefined ? {} : { insight }),
    ...(usedInsight === undefined ? {} : { usedInsight }),
    ...(stance === undefined ? {} : { stance }),
    ...(reply === undefined ? {} : { reply }),
    ...(reason === undefined ? {} : { reason }),
    ...(alternative === undefined ? {} : { alternative }),
  };
}

/** 保持导出的纯辅助函数（供外部/单测复用） */
export function festivalWindowOf(raw: string): { start: number; end: number } | null {
  const m = /今天是[^：]+：建议参加[^\n]*?(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2}) 之间用 festival enter/.exec(raw);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return end > start ? { start, end } : null;
}

export function pickPrematureReservedEdible(raw: string, bundleSnapshot: string): string | null {
  let fallback: string | null = null;
  for (const text of inventoryTexts(raw)) {
    const tag = /【留着：[^】]*[“"]([^”"]+)[”"][^】]*】/.exec(text);
    if (tag?.[1] === undefined) continue;
    if (bundleSnapshot.includes(tag[1])) continue;
    const name = cleanItemName(text);
    if (name === '') continue;
    if (/\[可食用/.test(text)) return name;
    if (fallback === null) fallback = name;
  }
  return fallback;
}

/** 按状态线索挑攻略片段（T-M6-72 前沿用现有节选逻辑，≤1200 字） */
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
    const text = guides[topic];
    if (re.test(state.raw) && text !== undefined && text !== '') {
      return `\n## 攻略参考（${topic} 专题节选，仅供参考，是否采纳由你结合当前局面判断）\n${text.slice(0, 1200)}\n`;
    }
  }
  return '';
}

/** 失败原因模板归一化（与 soak-real stuck-detector 口径一致） */
export function normalizeFailureSignature(tool: string, summary: string, location: string): string {
  const cleanSummary = summary
    .replace(/^(?:FAILED|ERROR|TIMEOUT|UNCERTAIN)\s+[^\s:：]+\s*[:：]\s*/i, '')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/[（(]\s*-?\d+\s*,\s*-?\d+\s*[）)]/g, '(坐标)')
    .replace(/[“"「『][^”"」』\n]{1,24}[”"」』]/g, '〈物品〉')
    .replace(/金星|银星|铱星/g, '')
    .replace(/\d+/g, '#')
    .replace(/[，。；、,;.!！?？]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const cleanLoc = location.replace(/[（(].*$/, '').trim() || '未知';
  return `${tool}|${cleanSummary || '未知原因'}|${cleanLoc}`;
}

/** 距凌晨 02:00 强制昏倒剩余的游戏分钟数（00:00–05:59 按深夜算，06:00–23:59 按当日算） */
export function minutesUntil2am(clockMinutes: number): number {
  if (clockMinutes < 6 * 60) return Math.max(0, 2 * 60 - clockMinutes);
  return Math.max(0, 26 * 60 - clockMinutes);
}

/** 醒目生存提醒段（§4.6 #4：只提醒风险，绝不强制替模型改动作） */
export function buildSurvivalReminder(state: GameStateSnapshot, effectiveFreeSlots: number): string {
  const staminaPct = state.staminaMax > 0 ? Math.round((state.stamina / state.staminaMax) * 100) : 100;
  const healthPct = state.healthMax > 0 ? Math.round((state.health / state.healthMax) * 100) : 100;
  const remainMin = minutesUntil2am(state.clockMinutes);
  const hours = Math.floor(remainMin / 60);
  const mins = remainMin % 60;
  const warnings: string[] = [];
  if (staminaPct <= 15) warnings.push(`⚠️ 体力仅剩 ${staminaPct}%（继续耗体可能累晕扣钱并次日体力减半）`);
  if (remainMin <= 180) warnings.push(`⚠️ 距 02:00 强制昏倒只剩 ${remainMin} 分钟（可提前回 FarmHouse 睡觉，或自行承担风险）`);
  if (healthPct <= 30) warnings.push(`⚠️ 生命值危险（${healthPct}%），小心被击倒丢物品`);
  if (effectiveFreeSlots <= 0) warnings.push('⚠️ 背包空位为 0（钓鱼/采集/满包合成可能失败或掉落，建议先整理、出货、捐赠或腾格）');

  return [
    '## 生存与资源提醒（仅作风险提示，具体行动完全由你自主决定）',
    `- 体力：${state.stamina}/${state.staminaMax}（${staminaPct}%） | 生命：${state.health}/${state.healthMax}（${healthPct}%）`,
    `- 距 02:00 昏倒剩余游戏时间：${hours}小时${mins}分（共 ${remainMin} 分钟） | 背包空位：${effectiveFreeSlots} 格`,
    ...(warnings.length > 0 ? warnings : []),
  ].join('\n');
}

export interface FailureMemoryContext {
  lastSignature: string | null;
  streak: number;
  lastSummary: string;
  clockStallSec: number;
}

export function buildFailureMemorySection(memory: FailureMemoryContext, recentReceipts: readonly string[]): string {
  let sig = memory.lastSignature;
  let streak = memory.streak;
  let lastSummary = memory.lastSummary;

  if (sig === null && recentReceipts.length > 0) {
    for (let i = recentReceipts.length - 1; i >= 0; i--) {
      const line = recentReceipts[i] ?? '';
      const m = /^(FAILED|ERROR|TIMEOUT|UNCERTAIN)\s+([^\s:：]+)\s*[:：]\s*(.*)$/i.exec(line);
      if (m?.[2] !== undefined) {
        sig = `${m[2]}|${(m[3] ?? '').trim().slice(0, 60)}`;
        lastSummary = (m[3] ?? '').trim();
        streak = 1;
        break;
      }
    }
  }

  if (sig === null && memory.clockStallSec < 60) return '';
  const lines = ['## 失败与停滞记忆（短期记忆）'];
  if (sig !== null) {
    lines.push(`- 最近失败签名：\`${sig}\`（连续失败 ${Math.max(1, streak)} 次${lastSummary === '' ? '' : `，详情：${lastSummary.slice(0, 120)}`}）`);
    lines.push('- 上次这样做失败了，请认真核对前置条件，**换个做法**，不要原样重复刚失败的动作！');
  }
  if (memory.clockStallSec >= 60) {
    lines.push(`- 游戏时钟已停滞现实 ${memory.clockStallSec} 秒：检查是否卡在界面/对话框，或换可推进时间的动作。`);
  }
  return `\n\n${lines.join('\n')}`;
}

export interface MandatoryCommandCheck {
  ok: true;
  acknowledged?: true;
  commandDone?: true;
  infeasible?: {
    reply: string;
    reason: string;
    alternative?: string;
    decision: { kind: 'act'; tool: string; args: Record<string, unknown>; intent: string } | { kind: 'wait'; seconds: number; reason: string };
  };
}

/** 校验强制命令约束：只接受 execute（带白名单工具）或带具体 reason 的 infeasible */
export function validateMandatoryCommandDecision(
  parsed: ParsedAutonomousDecision | null,
  acknowledged: boolean,
  allowedTools: ReadonlySet<string>,
): MandatoryCommandCheck | { ok: false; error: string } {
  if (parsed === null) return { ok: false, error: '输出不是合法 JSON' };
  if (parsed.stance === 'decline' || parsed.stance === 'modify') {
    return { ok: false, error: `强制命令禁止输出 stance="${parsed.stance}" 拒绝或打折` };
  }
  if (parsed.stance === 'infeasible') {
    if (parsed.reason === undefined || parsed.reason.trim() === '') {
      return { ok: false, error: '判定 infeasible 时必须提供具体的 reason 说明为什么完全不可行' };
    }
    const reply = parsed.reply ?? `主人，这个做不到呀：${parsed.reason}${parsed.alternative === undefined ? '' : `（不如：${parsed.alternative}）`}`;
    const decision = parsed.tool !== undefined && allowedTools.has(parsed.tool)
      ? { kind: 'act' as const, tool: parsed.tool, args: parsed.args, intent: parsed.intent }
      : { kind: 'wait' as const, seconds: 2, reason: `强制命令不可行：${parsed.reason}` };
    return {
      ok: true,
      infeasible: {
        reply,
        reason: parsed.reason,
        ...(parsed.alternative === undefined ? {} : { alternative: parsed.alternative }),
        decision,
      },
    };
  }
  if (!acknowledged && parsed.stance !== 'execute') {
    return { ok: false, error: '尚未对强制命令表态（必须显式输出 stance="execute" 或 "infeasible"）' };
  }
  if (parsed.tool === undefined || !allowedTools.has(parsed.tool)) {
    return { ok: false, error: parsed.tool === undefined ? 'execute 缺少要执行的 tool' : `工具 "${parsed.tool}" 不在白名单内` };
  }
  return {
    ok: true,
    ...(!acknowledged ? { acknowledged: true as const } : {}),
    ...(parsed.commandDone === true ? { commandDone: true as const } : {}),
  };
}

export function buildAdapterDecisionMessages(params: {
  systemPrompt: string;
  stateRaw: string;
  recentReceipts: readonly string[];
  lastFailSignature: string | null;
  extraContext: string;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const receipts = params.recentReceipts.slice(-3).map((r) => `- ${r}`).join('\n') || '（刚开始）';
  const failSection = params.lastFailSignature !== null ? `\n\n最近失败：${params.lastFailSignature}——读原因换做法，别原样重试。` : '';
  const extra = params.extraContext === '' ? '' : `\n\n${params.extraContext}`;
  return [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: `当前游戏状态：\n${params.stateRaw.slice(0, 4000)}\n\n最近回执：\n${receipts}${failSection}${extra}\n\n请决定下一步动作，只输出一行 JSON。` },
  ];
}

export function buildMorningPlanMessages(params: {
  personaPrompt?: string;
  guidesHint: string;
  insightsText?: string;
  tomorrowHint?: string;
  state: GameStateSnapshot;
}): Array<{ role: 'system' | 'user'; content: string }> {
  const persona = params.personaPrompt?.trim() || '你是「小鲸」——一条住在主人桌面上的傲娇干饭蓝鲸女仆';
  const extraParts = [
    params.guidesHint.trim(),
    params.insightsText?.trim() ?? '',
    params.tomorrowHint !== undefined && params.tomorrowHint.trim() !== '' ? `昨日复盘给今天的建议：${params.tomorrowHint.trim()}` : '',
  ].filter((x) => x !== '');
  const system = `${persona}，此刻你正在替主人全自动游玩《星露谷物语》。
新的一天刚起床，请根据当前季节、日期、天气、金钱、农场、攻略与经验心得，自主制定今天的游玩计划（2～5 条目标 + 理由 + 今日心情）。
${extraParts.join('\n\n')}
只输出一行 JSON：{"plan":[{"goal":"今日目标","why":"这么安排的理由"}],"mood":"一句话人设心情"}`;
  const user = `当前晨间状态：\n${params.state.raw.slice(0, 3500)}\n\n请制定今日计划，只输出一行 JSON。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface DecisionPromptParams {
  personaPrompt?: string;
  guidesHint: string;
  insightsText?: string;
  state: GameStateSnapshot;
  effectiveFreeSlots: number;
  environmentHints: string;
  recentReceipts: readonly string[];
  dayPlanText: string;
  failureMemory: FailureMemoryContext;
  mandatoryCommand: { text: string; acknowledged: boolean } | null;
  pendingSuggestion: { text: string; stampedClock: string } | null;
  handoverSummary: string | null;
  teamAndObjectiveText: string;
  allowedTools: ReadonlySet<string>;
}

export function buildAutonomousDecisionMessages(
  params: DecisionPromptParams,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const persona = params.personaPrompt?.trim() || '你是「小鲸」——一条住在主人桌面上的傲娇干饭蓝鲸女仆';
  const system = `${persona}，此刻你正在替主人全自动游玩《星露谷物语》。
你拥有完全的自主决策权：每天干什么、先做什么后做什么、要不要采纳攻略或主人的普通建议，全部由你结合当前游戏状态、性格与经验自己决定。
核心操作准则：
1. 当前界面非空时（对话框/商店/结算/过场），优先用 dialogue（选择题必带 choice 序号）、buy、close_menu、set_name 或 skip_event 处理界面。
2. 优先使用高效批量工具（water_crops / harvest_crops / till_area / plant_seeds / clear_area / forage / tidy_backpack / ship_items）。雨天户外作物自动浇水。
3. 只能调用白名单内的 BWF 工具：${[...params.allowedTools].join(', ')}；一次只做一个动作，args 键名须匹配工具真实参数。若需要先查攻略详情，可先调用宿主直读伪工具 {"tool":"read_guide","args":{"topic":"专题","section":"小节"}}（每轮最多 2 节，不推游戏时间）。攻略与心得仅供参考而非命令，若与当前游戏版本、已装 Mod 或实况不符须拒绝盲执行，可附带 "insight":{"source":"专题#小节","sourceType":"wiki","gameVersion":"1.6","claim":"结论","when":"条件","verdict":"adopt|defer|reject","confidence":0.65,"knownLimitations":["限制"],"why":"理由"}；若遵循了已有心得，请附带 "usedInsight":"心得id"。
4. 输出必须是一行合法 JSON：
{"tool":"工具名","args":{参数},"intent":"人设口吻的一句话意图"，可选字段："planUpdate":{"why":"修订理由","done":["已完成项"],"add":[{"goal":"新目标","why":"理由"}]},"insight":{...},"usedInsight":"ins-1","reply":"回复主人的话","stance":"accept|modify|decline|execute|infeasible","reason":"不可行原因","alternative":"替代方案","commandDone":true,"objectiveDone":true}`;

  const sections: string[] = [];

  // 1) 主人强制命令（排在当日计划之前）
  if (params.mandatoryCommand !== null) {
    if (!params.mandatoryCommand.acknowledged) {
      sections.push(`## 主人的强制命令（最高优先级，必须执行，排在当日计划之前）
命令：「/${params.mandatoryCommand.text}」
严格要求：
- 这是主人的 \`/\` 强制命令，**严禁以个人心情、偏好或原定计划拒绝**（禁止输出 stance="decline" 或 "modify"）！
- 你只能二选一表态：
  1) 执行：输出 \`"stance":"execute"\`、\`"reply":"人设口吻领命"\`、\`"tool":"本步工具"\`、\`"args":{...}\`、\`"intent":"..."\`（若本步完成后命令即彻底达成，加 \`"commandDone":true\`）；
  2) 完全不可行（商店未开门/缺前置物品/工具不存在/游戏规则不允许）：输出 \`"stance":"infeasible"\`、\`"reason":"具体不可行原因（必填）"\`、\`"alternative":"可行替代建议（可选）"\`、\`"reply":"如实告知主人"\`。`);
    } else {
      sections.push(`## 主人的强制命令（执行中，优先于当日计划，直至完成或 /cancel）
命令：「/${params.mandatoryCommand.text}」
请继续推进该命令；本轮动作完成后若命令已彻底达成请附带 \`"commandDone":true\`；若途中发现客观上完全不可行，输出 \`"stance":"infeasible"\` 与具体 \`"reason"\`（必填）及 \`"reply"\`。`);
    }
  }

  // 2) 当日计划
  sections.push(`## 当日计划\n${params.dayPlanText}`);

  // 3) 交还差异摘要（T-M6-73）
  if (params.handoverSummary !== null && params.handoverSummary.trim() !== '') {
    sections.push(`## 主人刚刚临时介入并交还了控制权\n${params.handoverSummary}`);
  }

  // 4) 当前状态 + 环境提示 + 最近回执
  const receiptsText = params.recentReceipts.slice(-5).map((r) => `- ${r}`).join('\n') || '（刚开始）';
  sections.push(`## 当前游戏状态\n${params.state.raw.slice(0, 4000)}${
    params.environmentHints === '' ? '' : `\n\n环境事实提示：${params.environmentHints}`
  }\n\n## 最近回执\n${receiptsText}`);

  // 5) 生存提醒段
  sections.push(buildSurvivalReminder(params.state, params.effectiveFreeSlots));

  // 6) 失败记忆段
  const failSection = buildFailureMemorySection(params.failureMemory, params.recentReceipts);
  if (failSection !== '') sections.push(failSection.trim());

  // 7) 攻略索引 + 相关经验心得（T-M6-72）
  if (params.guidesHint.trim() !== '') sections.push(params.guidesHint.trim());
  if (params.insightsText !== undefined && params.insightsText.trim() !== '') sections.push(params.insightsText.trim());

  // 8) 主人普通聊天建议 + 团队/目标上下文
  if (params.pendingSuggestion !== null) {
    sections.push(`## 主人说（于 ${params.pendingSuggestion.stampedClock} 发来，属沟通建议，做不做由你判断）
主人说：「${params.pendingSuggestion.text}」
请在本轮 JSON 中额外输出 \`"stance":"accept" | "modify" | "decline"\` 与 \`"reply":"用你的人设口吻回复主人并说明理由"\`，并据此输出本轮 \`tool\`。`);
  }
  if (params.teamAndObjectiveText.trim() !== '') {
    sections.push(params.teamAndObjectiveText.trim());
  }

  sections.push('请自主决定下一步动作，只输出一行 JSON。');

  return [
    { role: 'system', content: system },
    { role: 'user', content: sections.join('\n\n') },
  ];
}
