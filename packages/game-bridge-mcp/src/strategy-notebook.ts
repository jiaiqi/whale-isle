/**
 * 经验心得本（T-M6-72 §4B.3 #5）：
 *   - 按存档分文件：<notesDir>/<saveName>.json，Zod 校验；
 *   - 字段：id, source, claim, when, verdict(adopt|defer|reject|refuted), why, evidence[], createdDay, updatedDay, hits；
 *   - 容量上限 200 条：优先淘汰 refuted 且久未引用，其次淘汰 hits 最低；
 *   - 支持按季节、地点、当日计划检索 Top 5 注入 prompt，引用 usedInsight 时 hits+1 并持久化。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

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
      initialInsights?: StrategyInsight[];
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
    return this.insights.map((item) => ({ ...item, evidence: [...item.evidence] }));
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

  /** 新增或更新心得（受 Zod 校验与 200 条淘汰上限约束） */
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
      if (cleanEvidence !== undefined && cleanEvidence !== '' && !existing.evidence.includes(cleanEvidence)) {
        existing.evidence.push(cleanEvidence);
        if (existing.evidence.length > 12) existing.evidence.shift();
      }
      this.saveToDisk();
      return { ...existing, evidence: [...existing.evidence] };
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
    });
    this.insights.push(entry);
    this.evictIfNeeded();
    this.saveToDisk();
    return { ...entry, evidence: [...entry.evidence] };
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
    return { ...found, evidence: [...found.evidence] };
  }

  /** 按季节、地点、当日计划、适用条件检索 Top N 相关心得 */
  retrieve(query: {
    season: string;
    location: string;
    dayPlanText?: string;
    stateRaw?: string;
    limit?: number;
  }): StrategyInsight[] {
    if (this.insights.length === 0) return [];
    const limit = query.limit ?? 5;
    const qText = `${query.season} ${query.location} ${query.dayPlanText ?? ''} ${(query.stateRaw ?? '').slice(0, 600)}`;
    const qTokens = tokenizeText(qText);

    const scored = this.insights.map((item, idx) => {
      const docText = `${item.source} ${item.claim} ${item.when} ${item.why}`;
      const docTokens = tokenizeText(docText);
      let hitsCount = 0;
      for (const t of qTokens) if (docTokens.has(t)) hitsCount += 1;
      const lexical = qTokens.size > 0 ? hitsCount / Math.max(1, Math.min(qTokens.size, docTokens.size)) : 0;
      const verdictBias = item.verdict === 'adopt' ? 0.25 : item.verdict === 'defer' ? 0.1 : -0.05;
      const hitBoost = Math.min(0.2, Math.log1p(item.hits) * 0.06);
      return { item, score: lexical + verdictBias + hitBoost, lexical, idx };
    });

    scored.sort((a, b) => b.score - a.score || b.item.hits - a.item.hits || a.idx - b.idx);
    return scored.slice(0, limit).map((s) => ({ ...s.item, evidence: [...s.item.evidence] }));
  }

  /** 格式化检索命中的心得用于 prompt 注入 */
  formatForPrompt(items: readonly StrategyInsight[]): string {
    if (items.length === 0) return '';
    const lines = items.map((item) => {
      const ev = item.evidence.length > 0 ? `；实测：${item.evidence[item.evidence.length - 1]}` : '';
      return `- [${item.id} | ${item.verdict} | 引用${item.hits}次] ${item.claim}（条件：${item.when}；出处：${item.source}；判断：${item.why}${ev}）`;
    });
    return `## 你的经验心得本（供参考；若本轮遵循了某条心得，请输出 "usedInsight":"心得id"）\n${lines.join('\n')}`;
  }
}

function compareEvictionPriority(a: StrategyInsight, b: StrategyInsight): number {
  const aRefuted = a.verdict === 'refuted' ? 0 : 1;
  const bRefuted = b.verdict === 'refuted' ? 0 : 1;
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
