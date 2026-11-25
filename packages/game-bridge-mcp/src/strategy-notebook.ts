/**
 * 经验心得本与个人游戏知识库（T-M6-72 §4B.3 #5 + V2-P2-01 攻略学习闭环增强）：
 *   - 按存档分文件：<notesDir>/<saveName>.json，Zod 校验并向后兼容 v1 存档文件；
 *   - 支持来源类型、游戏版本、Mod 条件、置信度（0..1）、验证状态（unverified..rejected）、已知局限与反例；
 *   - 容量上限 200 条：优先淘汰 refuted 且久未引用，其次淘汰 hits 最低；
 *   - 支持实玩验证升置信度 / 失败反例衰减置信度 + 版本兼容性批量审计 + Top N 检索注入 prompt。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GameKnowledgeItemSchema,
  GameKnowledgeSourceTypeSchema,
  GameKnowledgeStatusSchema,
  type GameKnowledgeItem,
  type GameKnowledgeSourceType,
  type GameKnowledgeStatus,
  type GameRuntimeContext,
} from '@workbench/shared-protocol';
import { z } from 'zod';
import { evaluateGuideCompatibility } from './guide-library';

export const MAX_NOTEBOOK_INSIGHTS = 200;

export const InsightVerdictSchema = z.enum(['adopt', 'defer', 'reject', 'refuted']);
export type InsightVerdict = z.infer<typeof InsightVerdictSchema>;

export const StrategyInsightSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1).max(120),
  claim: z.string().min(1).max(200),
  when: z.string().max(160).default('通用'),
  verdict: InsightVerdictSchema,
  why: z.string().min(1).max(240),
  evidence: z.array(z.string().max(200)).max(12).default([]),
  createdDay: z.string().min(1),
  updatedDay: z.string().min(1),
  hits: z.number().int().min(0).default(0),
  lastHitDay: z.string().optional(),
  // V2-P2-01（Blueprint 17 §7.3 对齐扩展，全部带默认值/optional 保持 v1 文件兼容）
  gameId: z.string().min(1).default('stardew'),
  gameVersion: z.string().min(1).max(32).optional(),
  modContext: z.array(z.string().min(1).max(60)).max(12).default([]),
  sourceType: GameKnowledgeSourceTypeSchema.default('experience'),
  sourceUri: z.string().min(1).max(300).optional(),
  sourceTitle: z.string().min(1).max(120).optional(),
  retrievedAt: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).default(0.55),
  applicability: z.array(z.string().min(1).max(120)).max(12).default([]),
  knownLimitations: z.array(z.string().min(1).max(160)).max(12).default([]),
  contradictoryEvidence: z.array(z.string().min(1).max(200)).max(12).default([]),
  status: GameKnowledgeStatusSchema.default('unverified'),
  verifiedCount: z.number().int().min(0).default(0),
  refutedCount: z.number().int().min(0).default(0),
});

export type StrategyInsight = z.infer<typeof StrategyInsightSchema>;

export const StrategyNotebookFileSchema = z.object({
  version: z.literal(1).default(1),
  saveName: z.string().min(1).default('default'),
  lastReflectedDay: z.string().default(''),
  tomorrowHint: z.string().default(''),
  insights: z.array(StrategyInsightSchema).default([]),
});

export type StrategyNotebookFile = z.infer<typeof StrategyNotebookFileSchema>;

export interface LlmInsightDraft {
  id?: string;
  source: string;
  claim: string;
  when?: string;
  verdict: InsightVerdict;
  why: string;
  evidence?: string;
  gameId?: string;
  gameVersion?: string;
  modContext?: string[];
  sourceType?: GameKnowledgeSourceType;
  sourceUri?: string;
  sourceTitle?: string;
  retrievedAt?: string;
  confidence?: number;
  applicability?: string[];
  knownLimitations?: string[];
  contradictoryEvidence?: string[];
  status?: GameKnowledgeStatus;
}

export function extractSaveNameFromState(raw: string): string | null {
  const farmLoc = /地点：Farm（([^）\n]+)）/.exec(raw)?.[1]?.trim();
  if (farmLoc !== undefined && farmLoc !== '') return farmLoc;
  const noteFarm = /【你的长期笔记】([^（\s，。；：\n]{2,20}农场)/.exec(raw)?.[1]?.trim();
  if (noteFarm !== undefined && noteFarm !== '') return noteFarm;
  return null;
}

export function sanitizeSaveFileName(saveName: string): string {
  const cleaned = saveName
    .replace(/\.\./g, '')
    .replace(/[/\\:*?"<>|\s\x00-\x1f]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned === '' ? 'default' : cleaned;
}

function tokenizeText(text: string): Set<string> {
  const tokens = new Set<string>();
  const norm = text.toLowerCase().replace(/[，。！？；：、,.!?;:"'()（）[\]#\s]+/g, ' ');
  for (const word of norm.split(' ')) {
    if (word === '') continue;
    if (/^[\x00-\x7F]+$/.test(word)) {
      tokens.add(word);
    } else {
      for (let i = 0; i < word.length - 1; i++) tokens.add(word.slice(i, i + 2));
      tokens.add(word);
    }
  }
  return tokens;
}

function dayRank(dayKey: string): number {
  const m = /([春夏秋冬])\s*(\d+)/.exec(dayKey);
  if (m?.[1] === undefined || m[2] === undefined) return 0;
  const sIdx = ['春', '夏', '秋', '冬'].indexOf(m[1]);
  return (sIdx >= 0 ? sIdx * 100 : 0) + Number(m[2]);
}

function round2(val: number): number {
  return Math.round(Math.max(0, Math.min(1, val)) * 100) / 100;
}

function defaultConfidenceForVerdict(verdict: InsightVerdict): number {
  if (verdict === 'adopt') return 0.7;
  if (verdict === 'defer') return 0.5;
  return 0.2;
}

function defaultStatusForVerdict(verdict: InsightVerdict): GameKnowledgeStatus {
  if (verdict === 'adopt') return 'partially-verified';
  if (verdict === 'defer') return 'unverified';
  return 'rejected';
}

function pushUniqueBounded(target: string[], additions: readonly string[], maxLen: number, cap = 12): void {
  for (const raw of additions) {
    const clean = raw.trim().slice(0, maxLen);
    if (clean === '' || target.includes(clean)) continue;
    target.push(clean);
    if (target.length > cap) target.shift();
  }
}

function cloneInsight(item: StrategyInsight): StrategyInsight {
  return {
    ...item,
    evidence: [...item.evidence],
    modContext: [...item.modContext],
    applicability: [...item.applicability],
    knownLimitations: [...item.knownLimitations],
    contradictoryEvidence: [...item.contradictoryEvidence],
  };
}

/** 转换为 Blueprint 17 §7.3 标准 `GameKnowledgeItem` 结构 */
export function toGameKnowledgeItem(insight: StrategyInsight): GameKnowledgeItem {
  const latestEvidence = insight.evidence[insight.evidence.length - 1];
  const applicability = insight.applicability.length > 0
    ? [...insight.applicability]
    : (insight.when !== '' ? [insight.when] : []);
  return GameKnowledgeItemSchema.parse({
    knowledgeId: insight.id,
    gameId: insight.gameId,
    ...(insight.gameVersion === undefined ? {} : { gameVersion: insight.gameVersion }),
    modContext: [...insight.modContext],
    topic: insight.source,
    claim: insight.claim,
    sourceType: insight.sourceType,
    ...(insight.sourceUri === undefined ? {} : { sourceUri: insight.sourceUri }),
    ...(insight.sourceTitle === undefined ? {} : { sourceTitle: insight.sourceTitle }),
    retrievedAt: insight.retrievedAt ?? insight.createdDay,
    ...(latestEvidence === undefined ? {} : { evidenceSummary: latestEvidence }),
    confidence: insight.confidence,
    applicability,
    knownLimitations: [...insight.knownLimitations],
    contradictoryEvidence: [...insight.contradictoryEvidence],
    status: insight.status,
  });
}

export class StrategyNotebook {
  private saveName: string;
  private lastReflectedDay = '';
  private tomorrowHint = '';
  private insights: StrategyInsight[] = [];
  private seq = 0;

  constructor(
    private readonly options: {
      notesDir?: string;
      saveName?: string;
      maxInsights?: number;
      initialInsights?: Array<Partial<StrategyInsight> & Pick<StrategyInsight, 'id' | 'source' | 'claim' | 'verdict' | 'why' | 'createdDay' | 'updatedDay'>>;
    } = {},
  ) {
    this.saveName = sanitizeSaveFileName(options.saveName ?? 'default');
    if (options.initialInsights !== undefined) {
      for (const item of options.initialInsights) {
        const parsed = StrategyInsightSchema.safeParse(item);
        if (parsed.success) this.insights.push(parsed.data);
      }
      this.syncSeq();
    } else if (options.notesDir !== undefined) {
      this.loadFromDisk();
    }
  }

  private syncSeq(): void {
    for (const item of this.insights) {
      const m = /^ins-(\d+)$/.exec(item.id);
      if (m?.[1] !== undefined) this.seq = Math.max(this.seq, Number(m[1]));
    }
  }

  get maxInsights(): number {
    return this.options.maxInsights ?? MAX_NOTEBOOK_INSIGHTS;
  }

  getSaveName(): string {
    return this.saveName;
  }

  filePath(): string | null {
    if (this.options.notesDir === undefined) return null;
    return join(this.options.notesDir, `${this.saveName}.json`);
  }

  /** 按存档切换或首次识别到真实存档名时绑定到对应 JSON 文件 */
  bindSave(rawSaveName: string): void {
    const next = sanitizeSaveFileName(rawSaveName);
    if (next === this.saveName) return;
    const prevWasDefault = this.saveName === 'default' && this.insights.length === 0 && this.lastReflectedDay === '';
    this.saveName = next;
    if (this.options.notesDir === undefined) return;
    const path = this.filePath();
    if (path !== null && existsSync(path)) {
      this.loadFromDisk();
    } else if (!prevWasDefault) {
      this.insights = [];
      this.lastReflectedDay = '';
      this.tomorrowHint = '';
      this.seq = 0;
    }
  }

  loadFromDisk(): void {
    const path = this.filePath();
    if (path === null || !existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const parsed = StrategyNotebookFileSchema.safeParse(raw);
      if (!parsed.success) return;
      this.saveName = sanitizeSaveFileName(parsed.data.saveName || this.saveName);
      this.lastReflectedDay = parsed.data.lastReflectedDay;
      this.tomorrowHint = parsed.data.tomorrowHint;
      this.insights = parsed.data.insights;
      this.syncSeq();
    } catch {
      /* 损坏的心得文件安全退回空本，绝不阻断决策 */
    }
  }

  saveToDisk(): void {
    const path = this.filePath();
    if (path === null) return;
    mkdirSync(dirname(path), { recursive: true });
    const payload: StrategyNotebookFile = {
      version: 1,
      saveName: this.saveName,
      lastReflectedDay: this.lastReflectedDay,
      tomorrowHint: this.tomorrowHint,
      insights: this.insights,
    };
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, path);
  }

  list(): StrategyInsight[] {
    return this.insights.map(cloneInsight);
  }

  listKnowledgeItems(): GameKnowledgeItem[] {
    return this.insights.map(toGameKnowledgeItem);
  }

  size(): number {
    return this.insights.length;
  }

  getTomorrowHint(): string {
    return this.tomorrowHint;
  }

  setTomorrowHint(hint: string): void {
    this.tomorrowHint = hint.trim().slice(0, 240);
    this.saveToDisk();
  }

  hasReflectedDay(dayKey: string): boolean {
    return this.lastReflectedDay !== '' && this.lastReflectedDay === dayKey;
  }

  markReflectedDay(dayKey: string, tomorrowHint?: string): void {
    this.lastReflectedDay = dayKey;
    if (tomorrowHint !== undefined && tomorrowHint.trim() !== '') {
      this.tomorrowHint = tomorrowHint.trim().slice(0, 240);
    }
    this.saveToDisk();
  }

  /** 新增或更新心得（受 Zod 校验、溯源/置信度合并与 200 条淘汰上限约束） */
  upsert(dayKey: string, draft: LlmInsightDraft): StrategyInsight {
    const cleanClaim = draft.claim.trim().slice(0, 200);
    const cleanSource = draft.source.trim().slice(0, 120) || '游戏经验';
    const cleanWhy = draft.why.trim().slice(0, 240);
    const cleanWhen = (draft.when ?? '通用').trim().slice(0, 160) || '通用';
    const cleanEvidence = draft.evidence?.trim().slice(0, 200);

    const existing = draft.id !== undefined
      ? this.insights.find((item) => item.id === draft.id)
      : this.insights.find((item) => item.claim === cleanClaim && item.source === cleanSource);

    if (existing !== undefined) {
      existing.verdict = draft.verdict;
      existing.why = cleanWhy;
      if (cleanWhen !== '通用' || existing.when === '') existing.when = cleanWhen;
      existing.updatedDay = dayKey;
      if (draft.gameId !== undefined && draft.gameId.trim() !== '') existing.gameId = draft.gameId.trim();
      if (draft.gameVersion !== undefined && draft.gameVersion.trim() !== '') existing.gameVersion = draft.gameVersion.trim().slice(0, 32);
      if (draft.modContext !== undefined) pushUniqueBounded(existing.modContext, draft.modContext, 60);
      if (draft.sourceType !== undefined) existing.sourceType = draft.sourceType;
      if (draft.sourceUri !== undefined && draft.sourceUri.trim() !== '') existing.sourceUri = draft.sourceUri.trim().slice(0, 300);
      if (draft.sourceTitle !== undefined && draft.sourceTitle.trim() !== '') existing.sourceTitle = draft.sourceTitle.trim().slice(0, 120);
      if (draft.confidence !== undefined) existing.confidence = round2(draft.confidence);
      if (draft.status !== undefined) existing.status = draft.status;
      else if (draft.verdict === 'refuted' || draft.verdict === 'reject') existing.status = 'rejected';
      else if (draft.verdict === 'adopt' && existing.status === 'unverified') existing.status = 'partially-verified';
      if (draft.applicability !== undefined) pushUniqueBounded(existing.applicability, draft.applicability, 120);
      if (draft.knownLimitations !== undefined) pushUniqueBounded(existing.knownLimitations, draft.knownLimitations, 160);
      if (draft.contradictoryEvidence !== undefined) pushUniqueBounded(existing.contradictoryEvidence, draft.contradictoryEvidence, 200);
      if (cleanEvidence !== undefined && cleanEvidence !== '') pushUniqueBounded(existing.evidence, [cleanEvidence], 200);
      this.saveToDisk();
      return cloneInsight(existing);
    }

    this.seq += 1;
    const entry = StrategyInsightSchema.parse({
      id: `ins-${this.seq}`,
      source: cleanSource,
      claim: cleanClaim,
      when: cleanWhen,
      verdict: draft.verdict,
      why: cleanWhy,
      evidence: cleanEvidence !== undefined && cleanEvidence !== '' ? [cleanEvidence] : [],
      createdDay: dayKey,
      updatedDay: dayKey,
      hits: 0,
      ...(draft.gameId === undefined ? {} : { gameId: draft.gameId }),
      ...(draft.gameVersion === undefined ? {} : { gameVersion: draft.gameVersion }),
      ...(draft.modContext === undefined ? {} : { modContext: draft.modContext }),
      ...(draft.sourceType === undefined ? {} : { sourceType: draft.sourceType }),
      ...(draft.sourceUri === undefined ? {} : { sourceUri: draft.sourceUri }),
      ...(draft.sourceTitle === undefined ? {} : { sourceTitle: draft.sourceTitle }),
      ...(draft.retrievedAt === undefined ? {} : { retrievedAt: draft.retrievedAt }),
      confidence: draft.confidence === undefined ? defaultConfidenceForVerdict(draft.verdict) : round2(draft.confidence),
      ...(draft.applicability === undefined ? {} : { applicability: draft.applicability }),
      ...(draft.knownLimitations === undefined ? {} : { knownLimitations: draft.knownLimitations }),
      ...(draft.contradictoryEvidence === undefined ? {} : { contradictoryEvidence: draft.contradictoryEvidence }),
      status: draft.status ?? defaultStatusForVerdict(draft.verdict),
    });
    this.insights.push(entry);
    this.evictIfNeeded();
    this.saveToDisk();
    return cloneInsight(entry);
  }

  /** 按真实动作回执更新置信度、验证计数、反例与已知局限 */
  recordVerificationOutcome(params: {
    id: string;
    dayKey: string;
    succeeded: boolean;
    evidence: string;
    failureCondition?: string;
    runtimeContext?: Partial<GameRuntimeContext>;
  }): StrategyInsight | null {
    const found = this.insights.find((item) => item.id === params.id.trim());
    if (found === undefined) return null;

    found.updatedDay = params.dayKey;
    const compat = evaluateGuideCompatibility(
      { gameVersion: found.gameVersion, modContext: found.modContext },
      params.runtimeContext,
    );

    if (params.succeeded) {
      found.verifiedCount += 1;
      found.confidence = round2(Math.min(0.98, found.confidence + 0.15));
      pushUniqueBounded(found.evidence, [params.evidence], 200);
      if (compat.status === 'outdated') {
        found.status = 'outdated';
      } else if (found.verifiedCount >= 2 && found.confidence >= 0.75) {
        found.status = 'verified';
      } else {
        found.status = 'partially-verified';
      }
      if (found.verdict === 'defer' && found.confidence >= 0.7) found.verdict = 'adopt';
    } else {
      found.refutedCount += 1;
      found.confidence = round2(Math.max(0.05, found.confidence - 0.25));
      pushUniqueBounded(found.contradictoryEvidence, [params.evidence], 200);
      if (params.failureCondition !== undefined) {
        pushUniqueBounded(found.knownLimitations, [params.failureCondition], 160);
      }
      if (compat.status === 'outdated') {
        found.status = 'outdated';
        pushUniqueBounded(found.knownLimitations, compat.warnings, 160);
      } else if (found.confidence <= 0.25 || found.refutedCount >= 2) {
        found.status = 'rejected';
        found.verdict = 'refuted';
      } else if (found.status === 'verified') {
        found.status = 'partially-verified';
      }
    }

    this.saveToDisk();
    return cloneInsight(found);
  }

  /** 结合当前游戏版本与已装 Mod 对整本知识做兼容性体检 */
  auditVersionCompatibility(runtimeContext: Partial<GameRuntimeContext>, dayKey: string): StrategyInsight[] {
    const affected: StrategyInsight[] = [];
    for (const item of this.insights) {
      const compat = evaluateGuideCompatibility(
        { gameVersion: item.gameVersion, modContext: item.modContext },
        runtimeContext,
      );
      if (compat.status === 'outdated') {
        item.status = 'outdated';
        item.confidence = Math.min(item.confidence, 0.35);
        item.updatedDay = dayKey;
        pushUniqueBounded(item.knownLimitations, compat.warnings, 160);
        affected.push(cloneInsight(item));
      } else if (compat.status === 'mod-mismatch') {
        item.confidence = Math.min(item.confidence, 0.4);
        item.updatedDay = dayKey;
        pushUniqueBounded(item.knownLimitations, compat.warnings, 160);
        affected.push(cloneInsight(item));
      }
    }
    if (affected.length > 0) this.saveToDisk();
    return affected;
  }

  /** 超出上限时按规则淘汰：先淘汰 refuted 且久未引用，再淘汰 hits 最低 */
  private evictIfNeeded(): void {
    const limit = this.maxInsights;
    if (this.insights.length <= limit) return;
    while (this.insights.length > limit) {
      let victimIdx = 0;
      for (let i = 1; i < this.insights.length; i++) {
        if (compareEvictionPriority(this.insights[i]!, this.insights[victimIdx]!) < 0) {
          victimIdx = i;
        }
      }
      this.insights.splice(victimIdx, 1);
    }
  }

  /** 决策引用某条心得（usedInsight）时 hits + 1 */
  recordHit(id: string, dayKey: string): StrategyInsight | null {
    const cleanId = id.trim();
    const found = this.insights.find((item) => item.id === cleanId);
    if (found === undefined) return null;
    found.hits += 1;
    found.lastHitDay = dayKey;
    this.saveToDisk();
    return cloneInsight(found);
  }

  /** 按季节、地点、当日计划、置信度与版本/Mod 兼容度检索 Top N 相关心得 */
  retrieve(query: {
    season: string;
    location: string;
    dayPlanText?: string;
    stateRaw?: string;
    runtimeContext?: Partial<GameRuntimeContext>;
    limit?: number;
  }): StrategyInsight[] {
    if (this.insights.length === 0) return [];
    const limit = query.limit ?? 5;
    const qText = `${query.season} ${query.location} ${query.dayPlanText ?? ''} ${(query.stateRaw ?? '').slice(0, 600)}`;
    const qTokens = tokenizeText(qText);

    const scored = this.insights.map((item, idx) => {
      const docText = `${item.source} ${item.claim} ${item.when} ${item.why} ${item.applicability.join(' ')}`;
      const docTokens = tokenizeText(docText);
      let hitsCount = 0;
      for (const t of qTokens) if (docTokens.has(t)) hitsCount += 1;
      const lexical = qTokens.size > 0 ? hitsCount / Math.max(1, Math.min(qTokens.size, docTokens.size)) : 0;
      const verdictBias = item.verdict === 'adopt' ? 0.25 : item.verdict === 'defer' ? 0.1 : -0.05;
      const statusBias = item.status === 'verified' ? 0.15
        : item.status === 'partially-verified' ? 0.05
          : item.status === 'outdated' ? -0.25
            : item.status === 'rejected' ? -0.35 : 0;
      const compat = query.runtimeContext === undefined
        ? null
        : evaluateGuideCompatibility({ gameVersion: item.gameVersion, modContext: item.modContext }, query.runtimeContext);
      const compatPenalty = compat?.status === 'outdated' ? -0.25 : compat?.status === 'mod-mismatch' ? -0.35 : 0;
      const confBoost = item.confidence * 0.35;
      const hitBoost = Math.min(0.2, Math.log1p(item.hits) * 0.06);
      return { item, score: lexical + verdictBias + statusBias + compatPenalty + confBoost + hitBoost, lexical, idx };
    });

    scored.sort((a, b) => b.score - a.score || b.item.hits - a.item.hits || a.idx - b.idx);
    return scored.slice(0, limit).map((s) => cloneInsight(s.item));
  }

  /** 格式化检索命中的心得用于 prompt 注入（显式标出置信度、验证状态、兼容警示与反例） */
  formatForPrompt(items: readonly StrategyInsight[], runtimeContext?: Partial<GameRuntimeContext>): string {
    if (items.length === 0) return '';
    const lines = items.map((item) => {
      const compat = runtimeContext === undefined
        ? null
        : evaluateGuideCompatibility({ gameVersion: item.gameVersion, modContext: item.modContext }, runtimeContext);
      const ev = item.evidence.length > 0 ? `；实测：${item.evidence[item.evidence.length - 1]}` : '';
      const contra = item.contradictoryEvidence.length > 0 ? `；反例：${item.contradictoryEvidence[item.contradictoryEvidence.length - 1]}` : '';
      const limitNote = item.knownLimitations.length > 0 ? `；局限：${item.knownLimitations[item.knownLimitations.length - 1]}` : '';
      const verNote = item.gameVersion === undefined ? '' : ` v${item.gameVersion}`;
      const warn = compat !== null && (compat.status === 'outdated' || compat.status === 'mod-mismatch')
        ? ` ⚠️${compat.warnings[0] ?? compat.status}`
        : '';
      return `- [${item.id} | ${item.verdict} | ${item.status} | 置信度${Math.round(item.confidence * 100)}% | 来源:${item.sourceType}${verNote} | 引用${item.hits}次] ${item.claim}（条件：${item.when}；出处：${item.source}；判断：${item.why}${ev}${contra}${limitNote}${warn}）`;
    });
    return `## 你的经验心得本（仅供参考，不是命令；与当前版本或实测冲突时请拒绝盲从；若本轮遵循了某条心得，请输出 "usedInsight":"心得id"）\n${lines.join('\n')}`;
  }
}

function compareEvictionPriority(a: StrategyInsight, b: StrategyInsight): number {
  const aRefuted = a.verdict === 'refuted' || a.status === 'rejected' ? 0 : 1;
  const bRefuted = b.verdict === 'refuted' || b.status === 'rejected' ? 0 : 1;
  if (aRefuted !== bRefuted) return aRefuted - bRefuted;

  if (aRefuted === 0) {
    // 均已推翻：先淘汰久未引用，再淘汰 hits 更少
    const aRecent = dayRank(a.lastHitDay ?? a.updatedDay);
    const bRecent = dayRank(b.lastHitDay ?? b.updatedDay);
    if (aRecent !== bRecent) return aRecent - bRecent;
    return a.hits - b.hits;
  }

  // 非 refuted：先淘汰 hits 最低，再淘汰最久未更新/未引用
  if (a.hits !== b.hits) return a.hits - b.hits;
  return dayRank(a.lastHitDay ?? a.updatedDay) - dayRank(b.lastHitDay ?? b.updatedDay);
}
