/**
 * 攻略库切块、来源/版本/Mod 兼容检查与按需检索（T-M6-72 §4B.3 #1 + V2-P2-01 攻略学习闭环）：
 *   - 解析攻略头部/YAML frontmatter 与章节级游戏版本/Mod 元数据（GuideProvenance）；
 *   - 按 ## / ### 切分为 {topic, sectionId, title, headingPath, summary(≤80字), text(≤2000字), provenance}；
 *   - 结合当前 GameRuntimeContext 评估兼容状态（compatible | uncertain | outdated | mod-mismatch），旧版本/缺 Mod 明确降权并标示不确定；
 *   - 每轮只把 ≤800 字的相关索引放进 prompt，LLM 通过宿主侧伪工具 read_guide{topic, section} 按需读全文。
 */
import {
  GameKnowledgeSourceTypeSchema,
  type GameRuntimeContext,
  type GuideCompatibilityReport,
  type GuideProvenance,
} from '@workbench/shared-protocol';

export const MAX_GUIDE_SECTION_CHARS = 2000;
export const MAX_GUIDE_SUMMARY_CHARS = 80;
export const MAX_GUIDE_INDEX_CHARS = 800;

export interface GuideSection {
  topic: string;
  sectionId: string;
  title: string;
  headingPath: string;
  summary: string;
  text: string;
  provenance: GuideProvenance;
}

const SKIP_BOILERPLATE_TITLES = new Set(['History', 'Gallery', 'References', 'Trivia']);

function extractMetadataBlock(raw: string): string {
  const htmlHeader = /<!--([\s\S]*?)-->/.exec(raw);
  const yamlHeader = /^---\s*\n([\s\S]*?)\n---/.exec(raw.trimStart());
  return [htmlHeader?.[1] ?? '', yamlHeader?.[1] ?? ''].filter((s) => s !== '').join('\n');
}

function parseModList(rawValue: string): string[] {
  const normalized = rawValue.trim();
  if (normalized === '' || /^(?:none|vanilla|无|原版)$/i.test(normalized)) return [];
  return normalized
    .replace(/^\[|\]$/g, '')
    .split(/[,，;；]+/)
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s !== '' && !/^(?:none|vanilla|无|原版)$/i.test(s));
}

function normalizeVersionToken(versionRaw: string | undefined): string | undefined {
  if (versionRaw === undefined) return undefined;
  const trimmed = versionRaw.trim();
  if (trimmed === '') return undefined;
  const verMatch = /v?(\d+\.\d+(?:\.\d+)?)/i.exec(trimmed);
  if (verMatch?.[1] !== undefined) return verMatch[1];
  const majorOnly = /^v?(\d+)$/i.exec(trimmed);
  return majorOnly?.[1];
}

function majorMinorOf(version: string): string | null {
  const m = /(\d+\.\d+)/.exec(version);
  if (m?.[1] !== undefined) return m[1];
  const single = /^v?(\d+)$/i.exec(version.trim());
  return single?.[1] ?? null;
}

/** 从攻略注释头或 YAML frontmatter 解析来源、游戏版本与 Mod 依赖（不遗漏溯源字段） */
export function parseGuideProvenance(markdown: string, fallbackTopic: string): GuideProvenance {
  const block = extractMetadataBlock(markdown);
  let gameId = 'stardew';
  let sourceType: GuideProvenance['sourceType'] = 'wiki';
  let sourceTitle: string | undefined;
  let sourceUri: string | undefined;
  let gameVersion: string | undefined;
  let modContext: string[] = [];
  let retrievedAt: string | undefined;
  let pageTitle: string | undefined;

  for (const line of block.split('\n')) {
    const m = /^\s*([a-zA-Z0-9_-]+)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'gameid' && val !== '') gameId = val;
    else if (key === 'sourcetype') {
      const parsed = GameKnowledgeSourceTypeSchema.safeParse(val.toLowerCase());
      if (parsed.success) sourceType = parsed.data;
    } else if (key === 'sourceuri' && val !== '') sourceUri = val;
    else if (key === 'sourcetitle' && val !== '') sourceTitle = val;
    else if (key === 'pagetitle' && val !== '') pageTitle = val;
    else if (key === 'source' && val !== '') {
      const urlInParens = /[（(](https?:\/\/[^）)\s]+)[）)]/.exec(val);
      if (urlInParens?.[1] !== undefined && sourceUri === undefined) sourceUri = urlInParens[1];
      const titleClean = val.replace(/[（(]https?:\/\/[^）)]+[）)]/g, '').trim();
      if (titleClean !== '' && sourceTitle === undefined) sourceTitle = titleClean;
    } else if ((key === 'gameversion' || key === 'version') && val !== '') {
      gameVersion = normalizeVersionToken(val) ?? val;
    } else if (key === 'modcontext' || key === 'mods') {
      modContext = parseModList(val);
    } else if ((key === 'fetchedat' || key === 'retrievedat') && val !== '') {
      retrievedAt = val;
    }
  }

  return {
    gameId,
    sourceType,
    sourceTitle: sourceTitle ?? pageTitle ?? fallbackTopic,
    ...(sourceUri === undefined ? {} : { sourceUri }),
    ...(gameVersion === undefined ? {} : { gameVersion }),
    modContext,
    ...(retrievedAt === undefined ? {} : { retrievedAt }),
  };
}

function inferSectionProvenance(base: GuideProvenance, title: string, body: string): GuideProvenance {
  const probe = `${title}\n${body.slice(0, 400)}`;
  let gameVersion = base.gameVersion;
  if (gameVersion === undefined) {
    const verMatch = /(?:Stardew(?:\s+Valley)?\s+v?|版本\s*|仅限[^\n]{0,12}?|v)(\d+\.\d+(?:\.\d+)?)/i.exec(probe);
    if (verMatch?.[1] !== undefined) gameVersion = verMatch[1];
  }
  let modContext = base.modContext;
  if (modContext.length === 0) {
    const modMatch = /(?:Requires?\s+Mods?|依赖\s*Mods?|需安装\s*Mods?)\s*[:：]\s*([^\n。；]+)/i.exec(probe);
    if (modMatch?.[1] !== undefined) modContext = parseModList(modMatch[1]);
  }
  return {
    ...base,
    ...(gameVersion === undefined ? {} : { gameVersion }),
    modContext: [...modContext],
  };
}

/** 从实时游戏状态文本尝试提取当前版本与已装 Mod 列表 */
export function detectRuntimeContextFromState(raw: string): Partial<GameRuntimeContext> {
  const result: Partial<GameRuntimeContext> = {};
  const verMatch = /(?:游戏版本|Version|StardewVersion)\s*[:：]\s*v?(\d+\.\d+(?:\.\d+)?)/i.exec(raw);
  if (verMatch?.[1] !== undefined) result.gameVersion = verMatch[1];
  const modMatch = /(?:已装\s*Mods?|已安装\s*Mods?|InstalledMods)\s*[:：]\s*([^\n]+)/i.exec(raw);
  if (modMatch?.[1] !== undefined) result.installedMods = parseModList(modMatch[1]);
  return result;
}

/** 评估攻略与当前运行版本 / 已装 Mod 的兼容性 */
export function evaluateGuideCompatibility(
  provenance: Pick<GuideProvenance, 'gameVersion' | 'modContext'>,
  runtimeContext?: Partial<GameRuntimeContext>,
): GuideCompatibilityReport {
  const warnings: string[] = [];
  const provVer = normalizeVersionToken(provenance.gameVersion);
  const ctxVer = normalizeVersionToken(runtimeContext?.gameVersion);

  let versionMatch: GuideCompatibilityReport['versionMatch'] = 'unknown';
  if (provVer !== undefined && ctxVer !== undefined) {
    const pMM = majorMinorOf(provVer);
    const cMM = majorMinorOf(ctxVer);
    if (pMM !== null && cMM !== null && pMM === cMM) {
      versionMatch = 'match';
    } else {
      versionMatch = 'mismatch';
      warnings.push(`旧版本或跨版本攻略（攻略适用 v${provVer} ≠ 当前游戏 v${ctxVer}），适用性不确定，请勿直接当成当前事实`);
    }
  } else if (provVer === undefined && ctxVer !== undefined) {
    warnings.push(`该攻略未标注游戏版本（当前 v${ctxVer}），执行前请结合实况核验`);
  }

  const requiredMods = provenance.modContext ?? [];
  let modMatch: GuideCompatibilityReport['modMatch'] = 'match';
  const missingMods: string[] = [];
  if (requiredMods.length > 0) {
    if (runtimeContext?.installedMods === undefined) {
      modMatch = 'unknown';
      warnings.push(`该攻略依赖 Mod（${requiredMods.join(', ')}），请先确认当前存档已安装对应 Mod`);
    } else {
      const installedLower = new Set(runtimeContext.installedMods.map((m) => m.trim().toLowerCase()));
      for (const req of requiredMods) {
        if (!installedLower.has(req.trim().toLowerCase())) missingMods.push(req);
      }
      if (missingMods.length > 0) {
        modMatch = 'missing-mods';
        warnings.push(`攻略依赖未安装 Mod（缺少：${missingMods.join(', ')}），不可直接套用`);
      }
    }
  }

  let status: GuideCompatibilityReport['status'];
  if (versionMatch === 'mismatch') status = 'outdated';
  else if (modMatch === 'missing-mods') status = 'mod-mismatch';
  else if (versionMatch === 'unknown' || modMatch === 'unknown') status = 'uncertain';
  else status = 'compatible';

  return { status, versionMatch, modMatch, missingMods, warnings };
}

function cleanGuideText(raw: string): string {
  return raw
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/m, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[\[File:[^\]]+\]\]/gi, '')
    .replace(/<\/?references\s*\/?>/gi, '')
    .replace(/^\s*(?:TOC right|Category:[^\n]*|[a-z]{2}:[^\n]+|\}\})\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeBody(body: string, fallbackTitle: string): string {
  const lines = body
    .split('\n')
    .map((line) => line.replace(/[*_`#>]/g, '').trim())
    .filter((line) =>
      line !== ''
      && !line.startsWith(':*For ')
      && !line.startsWith(':*See also')
      && !line.startsWith('! ')
      && !/^NPC(?:\s+NPC)*$/i.test(line));
  const picked = (lines[0] ?? fallbackTitle).replace(/\s+/g, ' ').trim();
  if (picked.length <= MAX_GUIDE_SUMMARY_CHARS) return picked;
  return `${picked.slice(0, MAX_GUIDE_SUMMARY_CHARS - 1)}…`;
}

function clampSectionText(heading: string, body: string): string {
  const combined = heading === '' ? body : `${heading}\n\n${body}`;
  if (combined.length <= MAX_GUIDE_SECTION_CHARS) return combined;
  const suffix = '\n…（本节过长已截断）';
  return `${combined.slice(0, MAX_GUIDE_SECTION_CHARS - suffix.length)}${suffix}`;
}

/** 按 ## / ### 切分单篇攻略 Markdown 并提取每节来源/版本/Mod 元数据 */
export function splitGuideMarkdown(topic: string, markdown: string): GuideSection[] {
  const baseProvenance = parseGuideProvenance(markdown, topic);
  const cleanedDoc = cleanGuideText(markdown);
  if (cleanedDoc === '') return [];

  const lines = cleanedDoc.split('\n');
  const rawChunks: Array<{ level: 2 | 3; title: string; h2: string; bodyLines: string[] }> = [];
  let currentH2 = '';
  let active: { level: 2 | 3; title: string; h2: string; bodyLines: string[] } | null = null;
  const preamble: string[] = [];

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h2?.[1] !== undefined) {
      if (active !== null) rawChunks.push(active);
      currentH2 = h2[1].trim();
      active = { level: 2, title: currentH2, h2: currentH2, bodyLines: [] };
      continue;
    }
    if (h3?.[1] !== undefined) {
      if (active !== null) rawChunks.push(active);
      const title = h3[1].trim();
      active = { level: 3, title, h2: currentH2 || topic, bodyLines: [] };
      continue;
    }
    if (active !== null) active.bodyLines.push(line);
    else if (!/^#\s+/.test(line)) preamble.push(line);
  }
  if (active !== null) rawChunks.push(active);

  const usedIds = new Map<string, number>();
  const nextSectionId = (baseTitle: string): string => {
    const cleanBase = baseTitle.replace(/\s+/g, ' ').trim() || topic;
    const prev = usedIds.get(cleanBase) ?? 0;
    usedIds.set(cleanBase, prev + 1);
    return prev === 0 ? cleanBase : `${cleanBase} (${prev + 1})`;
  };

  const result: GuideSection[] = [];
  for (const chunk of rawChunks) {
    const body = chunk.bodyLines.join('\n').trim();
    if (body.length < 15 || SKIP_BOILERPLATE_TITLES.has(chunk.title)) continue;
    const sectionId = nextSectionId(chunk.title);
    const headingPath = chunk.level === 3 && chunk.h2 !== chunk.title ? `${chunk.h2} / ${chunk.title}` : chunk.title;
    const headingPrefix = chunk.level === 2 ? `## ${chunk.title}` : `### ${chunk.title}`;
    result.push({
      topic,
      sectionId,
      title: chunk.title,
      headingPath,
      summary: summarizeBody(body, chunk.title),
      text: clampSectionText(headingPrefix, body),
      provenance: inferSectionProvenance(baseProvenance, chunk.title, body),
    });
  }

  if (result.length === 0) {
    const body = preamble.join('\n').trim() || cleanedDoc;
    if (body !== '') {
      result.push({
        topic,
        sectionId: '总览',
        title: topic,
        headingPath: topic,
        summary: summarizeBody(body, topic),
        text: clampSectionText(`## ${topic}`, body),
        provenance: inferSectionProvenance(baseProvenance, topic, body),
      });
    }
  }
  return result;
}

const TOPIC_HINTS: Array<{ topic: string; pattern: RegExp }> = [
  { topic: '开局前几周', pattern: /第1年春|初期|开局|入门|新手/i },
  { topic: '四季作物收益', pattern: /农|作物|种子|耕地|浇水|收获|春|夏|秋|Farm|Parsnip|Melon|Pumpkin|Strawberry/i },
  { topic: '社区中心收集包', pattern: /社区中心|收集包|bundle|献祭|留着/i },
  { topic: '赚钱路线', pattern: /金币|赚钱|出货|酿酒|酒桶|罐头|工匠|ship|Artisan|Keg/i },
  { topic: '工具升级', pattern: /铁匠|升级|铜锭|铁锭|金锭|工具|斧头|镐子|喷壶|水壶|锄头|tool/i },
  { topic: '钓鱼', pattern: /钓|鱼竿|鱼饵|海滩|Beach|River|fish/i },
  { topic: '采矿', pattern: /矿|Mines|mine|怪物|战斗|石头|铜矿|铁矿/i },
  { topic: '节日', pattern: /节日|Festival|复活节|花舞|夏威夷|万灵/i },
  { topic: '结婚', pattern: /结婚|好感|礼物|送礼|Birthday|Marriage/i },
  { topic: '沙漠', pattern: /沙漠|Skull|Desert|巴士/i },
  { topic: '姜岛', pattern: /姜岛|Ginger|核桃/i },
  { topic: '农场类型', pattern: /农场类型|标准农场|海滩农场|森林农场|Farm/i },
];

export class GuideLibrary {
  private sectionsByTopic = new Map<string, GuideSection[]>();

  constructor(initialGuides: Record<string, string> = {}) {
    this.setGuides(initialGuides);
  }

  setGuides(guides: Record<string, string>): void {
    const next = new Map<string, GuideSection[]>();
    for (const topic of Object.keys(guides).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      const content = guides[topic];
      if (typeof content !== 'string' || content.trim() === '') continue;
      const parsed = splitGuideMarkdown(topic, content);
      if (parsed.length > 0) next.set(topic, parsed);
    }
    this.sectionsByTopic = next;
  }

  topics(): string[] {
    return [...this.sectionsByTopic.keys()];
  }

  sectionsOf(topic: string): GuideSection[] {
    return [...(this.sectionsByTopic.get(topic) ?? [])];
  }

  allSections(): GuideSection[] {
    const all: GuideSection[] = [];
    for (const list of this.sectionsByTopic.values()) all.push(...list);
    return all;
  }

  /** 解析宿主侧 read_guide{topic, section} 请求（不发游戏、不进锁） */
  readSection(
    topicInput: string,
    sectionInput?: string,
  ): { ok: true; section: GuideSection } | { ok: false; error: string; availableSections: string[] } {
    const cleanTopic = topicInput.trim();
    const matchedTopic = this.resolveTopicName(cleanTopic);
    if (matchedTopic === null) {
      return {
        ok: false,
        error: `未找到专题「${cleanTopic || '空'}」`,
        availableSections: this.topics().map((t) => `${t}（${this.sectionsByTopic.get(t)?.length ?? 0} 节）`),
      };
    }
    const list = this.sectionsByTopic.get(matchedTopic) ?? [];
    const cleanSection = (sectionInput ?? '').trim();
    if (cleanSection === '') {
      const first = list[0];
      return first !== undefined
        ? { ok: true, section: first }
        : { ok: false, error: `专题「${matchedTopic}」暂无小节`, availableSections: [] };
    }
    const lower = cleanSection.toLowerCase();
    const exact = list.find((s) => s.sectionId === cleanSection || s.title === cleanSection)
      ?? list.find((s) => s.sectionId.toLowerCase() === lower || s.title.toLowerCase() === lower)
      ?? list.find((s) =>
        s.sectionId.toLowerCase().includes(lower)
        || s.title.toLowerCase().includes(lower)
        || s.headingPath.toLowerCase().includes(lower));
    if (exact !== undefined) return { ok: true, section: exact };
    return {
      ok: false,
      error: `专题「${matchedTopic}」下没有匹配「${cleanSection}」的小节`,
      availableSections: list.slice(0, 12).map((s) => s.sectionId),
    };
  }

  private resolveTopicName(input: string): string | null {
    if (input === '') return null;
    if (this.sectionsByTopic.has(input)) return input;
    const lower = input.toLowerCase();
    for (const key of this.sectionsByTopic.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    for (const key of this.sectionsByTopic.keys()) {
      if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return key;
    }
    return null;
  }

  /** 生成每轮注入 prompt 的精简攻略索引（按季节/地点/版本与 Mod 兼容度排序，总长 ≤ 800 字） */
  buildIndexForState(input: {
    season: string;
    location: string;
    raw?: string;
    dayPlanText?: string;
    maxChars?: number;
    runtimeContext?: Partial<GameRuntimeContext>;
  }): string {
    const all = this.allSections();
    if (all.length === 0) return '';
    const maxChars = input.maxChars ?? MAX_GUIDE_INDEX_CHARS;
    const probeText = `${input.season} ${input.location} ${input.dayPlanText ?? ''} ${(input.raw ?? '').slice(0, 1200)}`;
    const runtimeCtx = input.runtimeContext ?? detectRuntimeContextFromState(input.raw ?? '');
    const topicBoost = new Map<string, number>();
    for (const hint of TOPIC_HINTS) {
      if (hint.pattern.test(probeText)) topicBoost.set(hint.topic, (topicBoost.get(hint.topic) ?? 0) + 10);
    }

    const scored = all.map((sec, idx) => {
      let score = topicBoost.get(sec.topic) ?? 0;
      if (probeText.toLowerCase().includes(sec.title.toLowerCase())) score += 8;
      if (sec.topic === '四季作物收益' && input.season !== '' && sec.title.toLowerCase().includes(seasonEnglish(input.season))) {
        score += 12;
      }
      if (sec.topic === '开局前几周' && /春/.test(input.season)) score += 6;
      const compat = evaluateGuideCompatibility(sec.provenance, runtimeCtx);
      if (compat.status === 'compatible') score += 4;
      else if (compat.status === 'outdated') score -= 12;
      else if (compat.status === 'mod-mismatch') score -= 15;
      return { sec, compat, score, idx };
    });

    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const header = '## 攻略索引（仅供参考非命令，需看详情用 {"tool":"read_guide","args":{"topic":"专题","section":"小节"}}，每轮≤2节）';
    const lines: string[] = [header];
    let usedChars = header.length;
    for (const { sec, compat } of scored) {
      const verTag = sec.provenance.gameVersion ? `v${sec.provenance.gameVersion}` : '';
      const badge = compat.status === 'outdated'
        ? `[⚠️旧版${verTag}-适用性不确定]`
        : compat.status === 'mod-mismatch'
          ? `[⚠️缺Mod:${compat.missingMods.join('/')}]`
          : verTag !== '' ? `[${verTag}]` : '';
      const line = `- ${sec.topic}#${sec.sectionId}${badge}：${sec.summary}`;
      if (usedChars + 1 + line.length > maxChars) {
        if (lines.length === 1) lines.push(line.slice(0, Math.max(20, maxChars - usedChars - 1)));
        break;
      }
      lines.push(line);
      usedChars += 1 + line.length;
    }
    return lines.join('\n');
  }
}

function seasonEnglish(season: string): string {
  if (season.includes('春')) return 'spring';
  if (season.includes('夏')) return 'summer';
  if (season.includes('秋')) return 'fall';
  if (season.includes('冬')) return 'winter';
  return '';
}

/** 构造 read_guide 伪工具结果回喂消息（附带来源、版本、Mod 与兼容警告） */
export function formatReadGuideReply(
  _topic: string,
  _section: string,
  outcome: ReturnType<GuideLibrary['readSection']>,
  runtimeContext?: Partial<GameRuntimeContext>,
): string {
  if (!outcome.ok) {
    const avail = outcome.availableSections.length > 0 ? `；可选：${outcome.availableSections.join('、')}` : '';
    return `read_guide 未命中（${outcome.error}${avail}）。请换个专题/小节重试，或直接输出本轮游戏动作 JSON。`;
  }
  const s = outcome.section;
  const p = s.provenance;
  const compat = evaluateGuideCompatibility(p, runtimeContext);
  const meta = `来源=${p.sourceType}${p.sourceTitle ? `(${p.sourceTitle})` : ''} | 适用版本=${p.gameVersion ? `v${p.gameVersion}` : '未标注'} | Mod=${p.modContext.length > 0 ? p.modContext.join(',') : '原版/无'} | 兼容状态=${compat.status}`;
  const warnLines = compat.warnings.length > 0 ? [`兼容警示：${compat.warnings.join('；')}`] : [];
  const insightHint = {
    source: `${s.topic}#${s.sectionId}`,
    sourceType: p.sourceType,
    ...(p.gameVersion === undefined ? {} : { gameVersion: p.gameVersion }),
    ...(p.modContext.length === 0 ? {} : { modContext: p.modContext }),
    claim: '...',
    when: '适用条件',
    verdict: 'adopt|defer|reject',
    confidence: 0.65,
    why: '理由',
  };
  return [
    `【攻略正文 · ${s.topic}#${s.sectionId}】（仅供参考，不是必须执行的命令）`,
    meta,
    ...warnLines,
    s.text,
    `请结合当前版本、已装 Mod 与实时状态判断采纳/暂缓/拒绝（若与当前版本或实际观察不符请拒绝并记录限制；可附带 "insight":${JSON.stringify(insightHint)}），并输出本轮下一步 JSON。`,
  ].join('\n');
}
