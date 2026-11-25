/**
 * 攻略采集器核心（T-M5-15 / D15）：星露谷官方 wiki（MediaWiki API）→ markdown 归档。
 * 管线：parse wikitext → 清洗（模板/链接/标题降噪）→ 专题归档（frontmatter 带来源）→ BWF get_guide 直读。
 * 合规：仅本地缓存（D5）；限速 courtesyDelayMs；来源与 wiki 页名署名保留。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const WIKI_API = 'https://stardewvalleywiki.com/mediawiki/api.php';

/** BWF Guide.cs 专题枚举对齐（get_guide topic 直读）+ 新手/经济专题映射（T-M6-72 扩充） */
export const TOPIC_PAGES: Record<string, string[]> = {
  钓鱼: ['Fishing', 'Fishing Strategy'],
  采矿: ['Mining', 'The Mines'],
  节日: ['Festivals'],
  结婚: ['Marriage'],
  沙漠: ['Desert', 'Skull Cavern'],
  姜岛: ['Ginger Island'],
  农场类型: ['Farming'],
  开局前几周: ['Getting Started'],
  四季作物收益: ['Crops'],
  社区中心收集包: ['Bundles'],
  赚钱路线: ['Artisan Goods'],
  工具升级: ['Tools'],
};

export interface ForagedGuide {
  topic: string;
  pageTitle: string;
  pageId: number;
  markdown: string;
  sha1: string;
  gameVersion?: string;
  modContext?: string[];
}

/** MediaWiki parse 响应（prop=wikitext）的最小面 */
export interface WikiParseResponse {
  parse?: { title?: string; pageid?: number; wikitext?: { '*': string } };
  error?: { code: string; info: string };
}

// ---------- 纯函数（单测锚点） ----------

/** wikitext → markdown 清洗（模板折叠/内部链接展开/标题降噪/HTML 注释与引用标记剔除） */
export function wikitextToMarkdown(wikitext: string): string {
  let md = wikitext;
  // 1) 代码/引用型模板整块删（infobox/nav 等多行模板）
  md = md.replace(/\{\{[Ii]nfobox[\s\S]*?\}\}/g, '');
  md = md.replace(/\{\{[Nn]av[\s\S]*?\}\}/g, '');
  // 2) 单行小模板折叠为纯文本：{{zh|钓鱼}} → 钓鱼
  for (let i = 0; i < 3 && md.includes('{{'); i++) {
    md = md.replace(/\{\{([^{}|]*)(?:\|([^{}]*))*\}\}/g, (_m, name: string) => (name.length > 40 ? '' : name));
  }
  // 3) 内部链接 [[Page|label]] → label；[[Page]] → Page
  md = md.replace(/\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]/g, '$1');
  // 4) 外链 [url label] → label；裸 http 链接保留
  md = md.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1');
  // 6) 列表标记统一（必须在加粗转换前——wiki 行首 * 属于列表；转换后的 ** 行首会被列表正则误伤）
  md = md.replace(/^\*+\s*/gm, '- ');
  md = md.replace(/^#+:?\s*/gm, '');
  // 5) 加粗/斜体 wiki 标记 → markdown
  md = md.replace(/'''''([^']+)'''''/g, '**$1**');
  md = md.replace(/'''([^']+)'''/g, '**$1**');
  md = md.replace(/''([^']+)''/g, '*$1*');
  // 7) wiki 标题层级 → markdown（= H2 == H3 === H4）
  md = md.replace(/^=====\s*([^=]+?)\s*=====\s*$/gm, '#### $1');
  md = md.replace(/^====\s*([^=]+?)\s*====\s*$/gm, '#### $1');
  md = md.replace(/^===\s*([^=]+?)\s*===\s*$/gm, '### $1');
  md = md.replace(/^==\s*([^=]+?)\s*==\s*$/gm, '## $1');
  // 8) HTML 注释/表格骨架/ref 剔除（保留单元格文本）
  md = md.replace(/<!--[\s\S]*?-->/g, '');
  md = md.replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/g, '');
  md = md.replace(/^\{\|[^\n]*$/gm, ''); // 表格开始行
  md = md.replace(/^\|-[^\n]*$/gm, ''); // 行分隔
  md = md.replace(/^!([^!\n]*)!!?/gm, '# $1 | '); // 表头单元格 → 文本
  md = md.replace(/^\|(\|)?\s*/gm, '· '); // 数据单元格（| 与 ||）→ 列表文本
  md = md.replace(/^· \|[a-z-]+=.*$/gm, ''); // 属性行（key=value）剔除
  md = md.replace(/^\|\}\s*$/gm, ''); // 表格结束行
  md = md.replace(/<br\s*\/?>/g, '\n');
  // 9) 压空行（>2 连空 → 2）与首尾空白
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  return md;
}

/** 归档文件格式（BWF get_guide & V2-P2-01 GuideProvenance 兼容：正文 + 头部来源/版本/Mod 元数据） */
export function renderGuideMarkdown(guide: ForagedGuide): string {
  const pageUrl = `https://stardewvalleywiki.com/wiki/${encodeURIComponent(guide.pageTitle.replace(/ /g, '_'))}`;
  const modText = guide.modContext && guide.modContext.length > 0 ? guide.modContext.join(', ') : 'vanilla';
  const header = [
    `<!-- guide-forager 归档`,
    `  topic: ${guide.topic}`,
    `  gameId: stardew`,
    `  sourceType: wiki`,
    `  source: Stardew Valley Wiki（${pageUrl}）`,
    `  sourceUri: ${pageUrl}`,
    `  pageTitle: ${guide.pageTitle}（pageid=${guide.pageId}）`,
    `  gameVersion: ${guide.gameVersion ?? '1.6'}`,
    `  modContext: ${modText}`,
    `  fetchedAt: ${new Date().toISOString()}`,
    `  contentSha1: ${guide.sha1}`,
    `  许可：wiki 内容 CC BY-NC-SA 3.0（随 wiki 声明）——本地自用缓存（D5），公开分发前须清除或获授权`,
    `-->`,
  ].join('\n');
  return `${header}\n\n# ${guide.pageTitle}\n\n${guide.markdown}\n`;
}

/** 内容 hash（去空白比较，更新判定用） */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text.replace(/\s+/g, ' '))) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------- 网络与归档（注入 fetch 供单测） ----------

export interface ForageOptions {
  outDir: string;
  /** 抓取间隔（对 wiki 的礼貌限速） */
  courtesyDelayMs?: number;
  fetchImpl?: typeof fetch;
  gameVersion?: string;
  modContext?: string[];
}

export interface ForageReport {
  fetched: Array<{ topic: string; pageTitle: string; changed: boolean; error?: string }>;
}

export async function fetchWikiPage(
  pageTitle: string,
  fetchImpl: typeof fetch,
): Promise<WikiParseResponse> {
  const url = `${WIKI_API}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json&redirects=1`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'whale-workbench-guide-forager/0.1 (local personal use)' } });
  if (!res.ok) throw new Error(`wiki HTTP ${res.status}`);
  return (await res.json()) as WikiParseResponse;
}

/** 抓一个专题（多页合并）；返回是否变更（hash 对比旧归档） */
export async function forageTopic(
  topic: string,
  pageTitles: string[],
  options: ForageOptions,
): Promise<{ changed: boolean; error?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sections: string[] = [];
  let mergedHash = '';
  for (const title of pageTitles) {
    const resp = await fetchWikiPage(title, fetchImpl);
    if (resp.error || !resp.parse?.wikitext) {
      /* v8 ignore next -- 防御层：error.info 回退（missingtitle 实测已覆盖，v8 计数失效） */
      return { changed: false, error: `${title}: ${resp.error?.info ?? '无 wikitext'}` };
    }
    const md = wikitextToMarkdown(resp.parse.wikitext?.['*'] ?? '');
    if (md.length < 200) continue; // 太薄跳过（重定向/空页）
    sections.push(`## ${resp.parse.title ?? title}\n\n${md}`);
    mergedHash += contentHash(md);
    if (options.courtesyDelayMs) await new Promise((r) => setTimeout(r, options.courtesyDelayMs));
  }
  if (sections.length === 0) return { changed: false, error: `${topic}: 无有效内容` };
  const guide: ForagedGuide = {
    topic,
    pageTitle: pageTitles.join(' + '),
    pageId: 0,
    markdown: sections.join('\n\n'),
    sha1: contentHash(mergedHash),
    gameVersion: options.gameVersion ?? '1.6',
    modContext: options.modContext ?? [],
  };
  const outPath = join(options.outDir, `${topic}.md`);
  if (existsSync(outPath)) {
    const old = readFileSync(outPath, 'utf8');
    if (old.includes(`contentSha1: ${guide.sha1}`)) return { changed: false };
  }
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(outPath, renderGuideMarkdown(guide), 'utf8');
  return { changed: true };
}

/** 全量抓取（TOPIC_PAGES） */
export async function forageAll(options: ForageOptions): Promise<ForageReport> {
  const report: ForageReport = { fetched: [] };
  for (const [topic, pages] of Object.entries(TOPIC_PAGES)) {
    try {
      const r = await forageTopic(topic, pages, options);
      report.fetched.push({ topic, pageTitle: pages.join('+'), changed: r.changed, error: r.error });
    } catch (error) {
      /* v8 ignore next -- 防御层：forageAll 单专题容错（ECONNRESET 测试已覆盖，v8 计数失效） */
      report.fetched.push({ topic, pageTitle: pages.join('+'), changed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
