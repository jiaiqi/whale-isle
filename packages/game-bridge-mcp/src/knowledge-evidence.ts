/**
 * V2-P4-04B/D：证据规范化、知识生命周期与真实状态前置条件。Envoy 仅提供材料，鲸屿保持权威。
 * 原创实现，仅吸收 Envoy「派生证据、确定性摘要、编辑回退」思想，不复制 Python 内核。
 */
import { createHash } from 'node:crypto';
import {
  EvidencePackSchema, GameKnowledgeItemSchema, KnowledgeApplicabilitySchema,
  type EvidencePack, type GameKnowledgeItem, type KnowledgeApplicability,
  type KnowledgeMaterial, type KnowledgeUnitState, type MaterialChunk, type PlayReceipt,
} from '@workbench/shared-protocol';
import { detectRuntimeContextFromState, evaluateGuideCompatibility, parseGuideProvenance } from './guide-library';

export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

/** 对 JSON 键排序，保留数组顺序；不接受 undefined/非有限数，避免不同序列化器悄悄改变摘要。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) throw new Error('摘要输入必须为有限 JSON 值');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

/** 排除墙钟和机器上的绝对路径，来源标题/许可/读取器版本与参数仍受摘要保护。 */
export function evidencePackDigest(pack: Omit<EvidencePack, 'digest' | 'packId'>): string {
  const { originUri: _originUri, ...stableSource } = pack.source;
  return sha256(canonicalJson({
    materialId: pack.materialId, materialSha256: pack.materialSha256,
    sourceRevision: pack.sourceRevision, extraction: pack.extraction,
    chunks: pack.chunks, parameters: pack.parameters, source: stableSource,
  }));
}

export function buildEvidencePack(input: {
  material: KnowledgeMaterial; chunks: MaterialChunk[]; extraction: EvidencePack['extraction'];
  topic: string; sourceType: GameKnowledgeItem['sourceType']; readerVersion: string;
  context?: Pick<EvidencePack['parameters'], 'gameVersion' | 'modContext' | 'applicability'>;
}): EvidencePack {
  const { material } = input;
  const body: Omit<EvidencePack, 'digest' | 'packId'> = {
    materialId: material.materialId, materialSha256: material.sha256,
    sourceRevision: material.sourceRevision, extraction: input.extraction,
    chunks: input.chunks, capturedAt: material.readAt,
    source: {
      title: material.title, originUri: material.originUri, licenseScope: material.licenseScope,
      ...(material.licenseNote ? { licenseNote: material.licenseNote } : {}), readerVersion: input.readerVersion,
    },
    parameters: { topic: input.topic, sourceType: input.sourceType, ...input.context },
  };
  const digest = evidencePackDigest(body);
  return EvidencePackSchema.parse({ ...body, digest, packId: `pack_${digest}` });
}

export function verifyEvidencePack(pack: EvidencePack): boolean {
  const parsed = EvidencePackSchema.safeParse(pack);
  return parsed.success && pack.digest === evidencePackDigest(parsed.data) && pack.packId === `pack_${pack.digest}`;
}

/** 原文行定位：要求片段逐字连续匹配；不匹配就不造行号，留待人工复核。 */
export function locateSourceText(materialText: string, quote: string): MaterialChunk['locator'] | null {
  const index = materialText.indexOf(quote);
  if (quote.length === 0 || index < 0) return null;
  const startLine = materialText.slice(0, index).split('\n').length;
  return { kind: 'text', startLine, endLine: startLine + quote.split('\n').length - 1 };
}

export function candidatesFromEvidence(pack: EvidencePack, materialText: string): GameKnowledgeItem[] {
  if (!verifyEvidencePack(pack)) throw new Error('Evidence Pack 摘要不匹配');
  const provenance = parseGuideProvenance(materialText, pack.parameters.topic);
  return pack.chunks.filter((chunk) => chunk.origin === 'source').map((chunk) => {
    const knowledgeId = `kn_${sha256(canonicalJson([provenance.gameId, pack.parameters.topic, chunk.text]))}`;
    return GameKnowledgeItemSchema.parse({
      knowledgeId, gameId: provenance.gameId, gameVersion: pack.parameters.gameVersion ?? provenance.gameVersion,
      modContext: pack.parameters.modContext ?? provenance.modContext, applicability: pack.parameters.applicability ?? [],
      topic: pack.parameters.topic, claim: chunk.text,
      sourceType: pack.parameters.sourceType, sourceUri: pack.source.originUri, sourceTitle: pack.source.title,
      retrievedAt: pack.capturedAt, confidence: pack.extraction === 'complete' ? 0.5 : 0,
      status: 'unverified', unitState: 'candidate', evidenceLevel: 'unverified',
      evidenceRefs: [{
        evidenceId: `ev_${sha256(canonicalJson([pack.digest, chunk.chunkId, chunk.locator]))}`,
        materialId: pack.materialId, locator: chunk.locator, sourceRevision: pack.sourceRevision,
        materialSha256: pack.materialSha256, extraction: pack.extraction, capturedAt: pack.capturedAt,
      }],
      knownLimitations: pack.extraction === 'complete' ? [] : ['证据抽取不完整，待人工复核'],
    });
  });
}

const TRANSITIONS: Record<KnowledgeUnitState, readonly KnowledgeUnitState[]> = {
  candidate: ['verified', 'archived'], verified: ['candidate', 'promoted', 'archived'],
  promoted: ['candidate', 'archived'], archived: ['candidate'],
};

/** verified 必须有实际核对过的定位；不提供自动 promoted 的入口。 */
export function transitionKnowledge(item: GameKnowledgeItem, next: KnowledgeUnitState, sourceChecked = false): GameKnowledgeItem {
  if (!TRANSITIONS[item.unitState].includes(next)) throw new Error(`非法知识状态迁移：${item.unitState} → ${next}`);
  if (next === 'verified' && (!sourceChecked || item.evidenceRefs.length === 0 || item.evidenceRefs.some((ref) => ref.extraction !== 'complete'))) {
    throw new Error('证据不存在或定位未复核，不能升 verified');
  }
  return { ...item, unitState: next };
}

/** 只回退本条生命周期，不覆盖事实五态；仓储负责保留旧版本。 */
export function reviseKnowledge(item: GameKnowledgeItem, claim: string): GameKnowledgeItem {
  return GameKnowledgeItemSchema.parse({ ...item, claim, unitState: 'candidate', evidenceLevel: 'unverified', confidence: 0,
    evidenceRefs: item.evidenceRefs.map((ref) => ({ ...ref, extraction: 'partial' })) });
}

export function invalidateMaterialEvidence(item: GameKnowledgeItem, materialId: string, missing: boolean): GameKnowledgeItem {
  return {
    ...item, unitState: 'candidate', evidenceLevel: 'unverified', confidence: 0,
    evidenceRefs: item.evidenceRefs.map((ref) => ref.materialId === materialId ? { ...ref, extraction: missing ? 'failed' : 'partial' } : ref),
  };
}

/** 仅做声明的前置条件核对，不是游戏策略树。未声明版本/未知条件一律 uncertain。 */
export function assessKnowledge(item: GameKnowledgeItem, raw: string | null, now: string): KnowledgeApplicability {
  const ctx = detectRuntimeContextFromState(raw ?? '');
  const compatibility = evaluateGuideCompatibility(item, ctx);
  const calendar = /时间：第\d+年([春夏秋冬])(\d+)日/.exec(raw ?? '');
  const season = calendar?.[1];
  const day = calendar?.[2] ? Number(calendar[2]) : undefined;
  const location = /地点[:：]\s*([^，\n]+)/.exec(raw ?? '')?.[1];
  const matchedConditions: string[] = [], unsatisfiedConditions: string[] = [], unverifiableConditions: string[] = [];
  for (const condition of item.applicability) {
    const seasonCondition = /^([春夏秋冬])季?$/.exec(condition);
    const dayCondition = /^第?(\d+)日$/.exec(condition);
    const weatherCondition = /^天气[:：](.+)$/.exec(condition);
    const locationCondition = /^地点[:：](.+)$/.exec(condition);
    let match: boolean | undefined;
    if (seasonCondition && season) match = seasonCondition[1] === season;
    else if (dayCondition && day) match = Number(dayCondition[1]) === day;
    else if (weatherCondition) {
      const weather = /(?:，|^)天气[:：]([^，\n]+)/m.exec(raw ?? '')?.[1]?.trim();
      if (weather) match = weather === weatherCondition[1]?.trim();
    } else if (locationCondition && location) match = location === locationCondition[1]?.trim();
    if (match === undefined) unverifiableConditions.push(condition);
    else (match ? matchedConditions : unsatisfiedConditions).push(condition);
  }
  const reasons = [...compatibility.warnings];
  let status: KnowledgeApplicability['status'] = compatibility.status;
  if (!raw) { status = 'uncertain'; reasons.push('游戏状态不可读：BWF 不可达或尚未进入存档'); }
  else if (unsatisfiedConditions.length > 0) status = 'not-applicable';
  else if (unverifiableConditions.length > 0) { status = 'uncertain'; reasons.push('适用条件无法从真实状态判定'); }
  if (item.evidenceRefs.length === 0 || item.evidenceRefs.some((ref) => ref.extraction !== 'complete')) {
    status = 'uncertain'; reasons.push('证据缺失或抽取不完整');
  }
  if (item.unitState === 'archived' || item.status === 'rejected' || (item.expiresAt && Date.parse(item.expiresAt) <= Date.parse(now))) {
    status = 'uncertain'; reasons.push('知识已归档、被反证或过期');
  }
  return KnowledgeApplicabilitySchema.parse({
    knowledgeId: item.knowledgeId, status, executable: status === 'compatible',
    versionMatch: !item.gameVersion ? 'not-declared' : !ctx.gameVersion || compatibility.versionMatch === 'unknown' ? 'unreadable' : compatibility.versionMatch,
    modMatch: item.modContext.length === 0 ? 'not-declared' : !ctx.installedMods ? 'unreadable' : compatibility.modMatch,
    matchedConditions, unsatisfiedConditions, unverifiableConditions, reasons, missingMods: compatibility.missingMods,
    runtimeGameVersion: ctx.gameVersion, runtimeSeason: season, runtimeDay: day, runtimeLocation: location,
    ...(raw ? { stateDigest: sha256(raw) } : {}), assessedAt: now,
  });
}

/** 可疑/不确定不晋升；明确失败记反证；只调整可信度，不自动晋升知识生命周期。 */
export function applyPlayReceipt(item: GameKnowledgeItem, receipt: PlayReceipt): GameKnowledgeItem {
  if (receipt.knowledgeId !== item.knowledgeId) throw new Error('回执不属于当前知识');
  if (receipt.suspicious || receipt.receiptStatus === 'UNCERTAIN') return item;
  const success = receipt.receiptStatus === 'COMPLETED' && receipt.stateChanged;
  return { ...item,
    confidence: Math.max(0, Math.min(1, item.confidence + (success ? 0.1 : -0.1))),
    evidenceLevel: receipt.evidenceLevel,
    status: success ? 'partially-verified' : item.status,
    contradictoryEvidence: success ? item.contradictoryEvidence : [...item.contradictoryEvidence, receipt.summary],
  };
}

/**
 * V2-P4-01：筛选并格式化知识库条目供 LlmPlanner 在自主游玩时参考（Voyager/Reflexion 思想）。
 * - 优先呈现已验证/实玩有效的兼容知识（含适用条件与置信度）；
 * - 显式保留被反证/失败的知识警告（避免重复踩坑）；
 * - 跳过已归档与全部证据失效的条目，严格控制上下文字符预算。
 */
export function formatKnowledgeUnitsForPlanner(
  units: readonly GameKnowledgeItem[],
  stateRaw: string,
  now: string,
  options: { gameId?: string; maxItems?: number } = {},
): string {
  const gameId = options.gameId ?? 'stardew';
  const maxItems = options.maxItems ?? 6;
  if (units.length === 0 || maxItems <= 0) return '';

  const location = /地点[:：]\s*([^（\n，,]+)/.exec(stateRaw)?.[1]?.trim().toLowerCase() ?? '';
  const season = /时间：第\d+年([春夏秋冬])/.exec(stateRaw)?.[1] ?? '';
  const stateLower = stateRaw.toLowerCase();

  const candidates: Array<{ line: string; score: number }> = [];
  for (const unit of units) {
    if (unit.gameId !== gameId || unit.unitState === 'archived') continue;
    if (unit.evidenceRefs.length > 0 && unit.evidenceRefs.every((ref) => ref.extraction === 'failed')) continue;

    const isRefuted = unit.status === 'rejected' || unit.contradictoryEvidence.length > 0;
    const isVerified = unit.unitState === 'promoted'
      || unit.unitState === 'verified'
      || unit.status === 'partially-verified'
      || unit.confidence >= 0.6;
    if (!isVerified && !isRefuted) continue;

    const applicability = assessKnowledge(unit, stateRaw || null, now);
    if (applicability.status === 'not-applicable' && !isRefuted) continue;

    let score = unit.unitState === 'promoted' ? 40 : unit.unitState === 'verified' ? 30 : isRefuted ? 25 : 15;
    score += Math.round(unit.confidence * 10);
    const haystack = `${unit.topic} ${unit.claim} ${unit.applicability.join(' ')}`.toLowerCase();
    if (location !== '' && haystack.includes(location)) score += 12;
    if (season !== '' && haystack.includes(season)) score += 6;
    if (unit.topic !== '' && stateLower.includes(unit.topic.toLowerCase())) score += 8;
    if (applicability.status === 'compatible') score += 10;

    const tag = isRefuted ? '已反证/避坑' : unit.unitState === 'promoted' ? '已晋升' : unit.unitState === 'verified' ? '已核对' : '实玩有效';
    const pct = Math.round(unit.confidence * 100);
    const caution = applicability.status !== 'compatible' && applicability.reasons.length > 0
      ? `（注意：${applicability.reasons[0]}）`
      : '';
    const pitfall = isRefuted && unit.contradictoryEvidence.length > 0
      ? `｜反例：${unit.contradictoryEvidence.at(-1)!.slice(0, 80)}`
      : '';
    candidates.push({
      line: `- [${tag} ${pct}%] ${unit.topic}：${unit.claim.slice(0, 140)}${caution}${pitfall}`,
      score,
    });
  }

  if (candidates.length === 0) return '';
  candidates.sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  let chars = 0;
  for (const item of candidates.slice(0, maxItems)) {
    if (chars + item.line.length > 1200) break;
    lines.push(item.line);
    chars += item.line.length + 1;
  }
  return lines.join('\n');
}
