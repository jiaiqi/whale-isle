/**
 * 每晚复盘与经验验证（T-M6-72 §4B.3 #4）：
 *   - 在决定 sleep 前（或 24:00 后首轮决策时）每天触发一次（换日键保证幂等）；
 *   - 汇总当天计划完成度、回执成功/失败统计、金币变化、失败签名 Top 3 与相关心得；
 *   - 让 LLM 审视并新增或修订心得（如 defer→adopt / refuted）与明日打算（喂给次日晨间计划）；
 *   - 复盘期 LLM 故障或输出乱码时静默跳过，绝不阻断睡觉或游戏推进。
 */
import {
  GameKnowledgeSourceTypeSchema,
  GameKnowledgeStatusSchema,
} from '@workbench/shared-protocol';
import type { DayPlanSnapshot } from './day-plan';
import { extractJsonObject, normalizeFailureSignature } from './llm-prompt';
import {
  InsightVerdictSchema,
  type LlmInsightDraft,
  type StrategyInsight,
  type StrategyNotebook,
} from './strategy-notebook';

export interface ReceiptRecord {
  tool: string;
  status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR';
  summary: string;
}

export interface DayExecutionSummary {
  dayKey: string;
  dayPlan: DayPlanSnapshot | null;
  startMoney: number | null;
  endMoney: number;
  receiptTotal: number;
  completedCount: number;
  failedCount: number;
  topFailures: Array<{ signature: string; count: number }>;
  relatedInsights: StrategyInsight[];
}

export interface ParsedReflectionResult {
  updates: LlmInsightDraft[];
  tomorrowHint?: string;
}

/** 从当日回执流聚合成功/失败数与失败签名 Top 3 */
export function summarizeReceiptsForReflection(
  receipts: readonly ReceiptRecord[],
  locationFallback = '未知',
): Pick<DayExecutionSummary, 'receiptTotal' | 'completedCount' | 'failedCount' | 'topFailures'> {
  let completedCount = 0;
  let failedCount = 0;
  const failMap = new Map<string, number>();

  for (const r of receipts) {
    if (r.status === 'COMPLETED') {
      completedCount += 1;
    } else {
      failedCount += 1;
      const sig = normalizeFailureSignature(r.tool, r.summary, locationFallback);
      failMap.set(sig, (failMap.get(sig) ?? 0) + 1);
    }
  }

  const topFailures = [...failMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([signature, count]) => ({ signature, count }));

  return {
    receiptTotal: receipts.length,
    completedCount,
    failedCount,
    topFailures,
  };
}

export function buildNightlyReflectionMessages(params: {
  personaPrompt?: string;
  summary: DayExecutionSummary;
}): Array<{ role: 'system' | 'user'; content: string }> {
  const persona = params.personaPrompt?.trim() || '你是「小鲸」——一条住在主人桌面上的傲娇干饭蓝鲸女仆';
  const s = params.summary;
  const moneyDelta = s.startMoney === null
    ? `${s.endMoney}g`
    : `${s.startMoney}g → ${s.endMoney}g（${s.endMoney - s.startMoney >= 0 ? '+' : ''}${s.endMoney - s.startMoney}g）`;
  const planLines = s.dayPlan === null || s.dayPlan.items.length === 0
    ? '（今日未生成计划）'
    : s.dayPlan.items.map((item) => `- [${item.status}] ${item.goal}`).join('\n');
  const failLines = s.topFailures.length === 0
    ? '（今日无失败记录）'
    : s.topFailures.map((f) => `- ${f.signature}（${f.count} 次）`).join('\n');
  const insightLines = s.relatedInsights.length === 0
    ? '（当前心得本为空，若今天发现了实战规律也可新增 1～2 条）'
    : s.relatedInsights.map((ins) => {
      const contra = ins.contradictoryEvidence.length > 0 ? `；反例：${ins.contradictoryEvidence[ins.contradictoryEvidence.length - 1]}` : '';
      const ver = ins.gameVersion === undefined ? '' : ` v${ins.gameVersion}`;
      return `- ${ins.id} [${ins.verdict}/${ins.status} 置信度${Math.round(ins.confidence * 100)}%${ver}] ${ins.claim}（条件：${ins.when}；理由：${ins.why}${contra}）`;
    }).join('\n');

  const system = `${persona}，今天准备休息收工了，请简短复盘今天的《星露谷》游玩实绩：
1. 判断现有心得今天是否被实测验证、受版本/Mod 限制或被推翻（可以把 defer 改为 adopt 并提升 confidence/status，或因失败改为 refuted/rejected 并写入 knownLimitations 与 contradictoryEvidence），也可总结新的经验条目。
2. 给出 1 句明天的首要打算（tomorrowHint），供明早起床定计划时参考。
只输出一行合法 JSON：
{"updates":[{"id":"已有心得id(新增则省略)","source":"复盘或专题名","sourceType":"experience|wiki|community|user|official|video","gameVersion":"1.6","modContext":[],"claim":"结论","when":"适用条件","verdict":"adopt|defer|reject|refuted","status":"verified|partially-verified|unverified|outdated|rejected","confidence":0.75,"why":"判断理由","evidence":"今日实测数据","knownLimitations":["局限条件"],"contradictoryEvidence":["失败反例"]}],"tomorrowHint":"明天的打算"}`;

  const user = [
    `日期：${s.dayKey}`,
    `金币变化：${moneyDelta}`,
    `执行统计：共 ${s.receiptTotal} 步（成功 ${s.completedCount} / 未完成 ${s.failedCount}）`,
    `今日计划：\n${planLines}`,
    `失败签名 Top 3：\n${failLines}`,
    `待复盘心得：\n${insightLines}`,
    '请总结复盘 JSON（无新增改动 updates 可为 []）。',
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function parseReflectionResult(content: string): ParsedReflectionResult | null {
  const obj = extractJsonObject(content);
  if (obj === null) return null;

  const updates: LlmInsightDraft[] = [];
  if (Array.isArray(obj['updates'])) {
    for (const raw of obj['updates']) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const rec = raw as Record<string, unknown>;
      const claim = typeof rec['claim'] === 'string' ? rec['claim'].trim() : '';
      const why = typeof rec['why'] === 'string' ? rec['why'].trim() : '';
      const verdictRes = InsightVerdictSchema.safeParse(typeof rec['verdict'] === 'string' ? rec['verdict'].trim().toLowerCase() : '');
      if (claim === '' || why === '' || !verdictRes.success) continue;
      const id = typeof rec['id'] === 'string' && rec['id'].trim() !== '' ? rec['id'].trim() : undefined;
      const source = typeof rec['source'] === 'string' && rec['source'].trim() !== '' ? rec['source'].trim() : '每晚复盘';
      const when = typeof rec['when'] === 'string' && rec['when'].trim() !== '' ? rec['when'].trim() : undefined;
      const evidence = typeof rec['evidence'] === 'string' && rec['evidence'].trim() !== '' ? rec['evidence'].trim() : undefined;
      const sourceTypeRes = typeof rec['sourceType'] === 'string'
        ? GameKnowledgeSourceTypeSchema.safeParse(rec['sourceType'].trim().toLowerCase())
        : null;
      const statusRes = typeof rec['status'] === 'string'
        ? GameKnowledgeStatusSchema.safeParse(rec['status'].trim().toLowerCase())
        : null;
      const gameVersion = typeof rec['gameVersion'] === 'string' && rec['gameVersion'].trim() !== '' ? rec['gameVersion'].trim() : undefined;
      const modContext = Array.isArray(rec['modContext'])
        ? rec['modContext'].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
        : undefined;
      const confidence = typeof rec['confidence'] === 'number' && Number.isFinite(rec['confidence']) && rec['confidence'] >= 0 && rec['confidence'] <= 1
        ? rec['confidence']
        : undefined;
      const knownLimitations = Array.isArray(rec['knownLimitations'])
        ? rec['knownLimitations'].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
        : undefined;
      const contradictoryEvidence = Array.isArray(rec['contradictoryEvidence'])
        ? rec['contradictoryEvidence'].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
        : undefined;
      updates.push({
        ...(id === undefined ? {} : { id }),
        source,
        claim,
        ...(when === undefined ? {} : { when }),
        verdict: verdictRes.data,
        why,
        ...(evidence === undefined ? {} : { evidence }),
        ...(sourceTypeRes?.success ? { sourceType: sourceTypeRes.data } : {}),
        ...(statusRes?.success ? { status: statusRes.data } : {}),
        ...(gameVersion === undefined ? {} : { gameVersion }),
        ...(modContext === undefined ? {} : { modContext }),
        ...(confidence === undefined ? {} : { confidence }),
        ...(knownLimitations === undefined ? {} : { knownLimitations }),
        ...(contradictoryEvidence === undefined ? {} : { contradictoryEvidence }),
      });
    }
  }

  const tomorrowHint = typeof obj['tomorrowHint'] === 'string' && obj['tomorrowHint'].trim() !== ''
    ? obj['tomorrowHint'].trim().slice(0, 240)
    : undefined;

  if (!Array.isArray(obj['updates']) && tomorrowHint === undefined) return null;
  return {
    updates,
    ...(tomorrowHint === undefined ? {} : { tomorrowHint }),
  };
}

/** 运行单日一次的夜间复盘（幂等：同 dayKey 不重复触发；出错或乱码跳过且不抛异常） */
export async function runNightlyReflection(params: {
  dayKey: string;
  notebook: StrategyNotebook;
  summary: DayExecutionSummary;
  personaPrompt?: string;
  slot: string;
  chat: (
    slot: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts?: { maxTokens?: number },
  ) => Promise<{ content: string }>;
  onCountAsk?: () => void;
}): Promise<{ ran: boolean; updated: StrategyInsight[]; tomorrowHint?: string }> {
  if (params.notebook.hasReflectedDay(params.dayKey)) {
    return { ran: false, updated: [] };
  }
  const messages = buildNightlyReflectionMessages({
    ...(params.personaPrompt === undefined ? {} : { personaPrompt: params.personaPrompt }),
    summary: params.summary,
  });
  try {
    params.onCountAsk?.();
    const res = await params.chat(params.slot, messages, { maxTokens: 1600 });
    const parsed = parseReflectionResult(res.content);
    if (parsed === null) {
      params.notebook.markReflectedDay(params.dayKey);
      return { ran: true, updated: [] };
    }
    const updated: StrategyInsight[] = [];
    for (const draft of parsed.updates) {
      updated.push(params.notebook.upsert(params.dayKey, draft));
    }
    params.notebook.markReflectedDay(params.dayKey, parsed.tomorrowHint);
    return {
      ran: true,
      updated,
      ...(parsed.tomorrowHint === undefined ? {} : { tomorrowHint: parsed.tomorrowHint }),
    };
  } catch {
    params.notebook.markReflectedDay(params.dayKey);
    return { ran: true, updated: [] };
  }
}
