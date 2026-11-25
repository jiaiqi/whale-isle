/**
 * T-M5-15 门禁：wikitext 清洗/归档/hash 确定性（离线 fixture，零网络）+ 真机抓取集成开关测试。
 */
import { describe, expect, it } from 'vitest';
import {
  contentHash, forageAll, forageTopic, renderGuideMarkdown, TOPIC_PAGES, wikitextToMarkdown,
  type WikiParseResponse,
} from './forage';

const WIKITEXT_SAMPLE = `<!-- 注释剔除 -->
{{Infobox skill
|name = Fishing
|time = varies
}}
'''钓鱼'''（Fishing）是在[[Fishing Poles|鱼竿]]上使用技巧的[[Skills|技能]]。

== 经验与等级 ==
经验按钓到的[[鱼]]的难度与质量计算。''完美的''抛竿会有额外加成。
{{zh|抛竿完美度}}影响起跳条速度。

=== 训练 ===
* 在[[Willy]]的商店购买训练用鱼竿
* [[Fishing Strategy|钓鱼策略]]页面提供全年鱼表
{| class="wikitable"
|-
! 名称 !! 季节
|-
| [[Sardine]] || 春秋冬<ref>Reference text</ref>
|}

[https://example.com External Label] 裸链 https://example.org 保留。

===== 深水区 =====
离岸越远鱼越大。

==== 全年鱼表 ====
{| class="wikitable"
|-
! 名称 !! 季节 !! 时间
|-
| [[Sardine]] || 春秋冬 || 6:00-19:00<ref>参考注释</ref>
|-
| [[Tuna]] || 夏冬 || 6:00-19:00
|}

钓鱼升级经验公式：base × difficulty，完美抛竿额外 2.4 倍。
使用[[Fish Pond|鱼塘]可以繁殖稀有鱼。
 trainer note: 其他补充段落，包含足够的正文长度以超过归档最小阈值两百字。
 该段落为清洗管线集成样本，覆盖表格、链接、加粗、列表、标题五种 wiki 结构。`;

const parseFixture = (text: string, title = 'Fishing'): WikiParseResponse => ({
  parse: { title, pageid: 1517, wikitext: { '*': text } },
});

const fetchOk = (text: string, title = 'Fishing'): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => parseFixture(text, title) })) as unknown as typeof fetch;

describe('wikitextToMarkdown', () => {
  it('模板折叠/链接展开/标题层级/表格降噪/注释与 ref 剔除', () => {
    const md = wikitextToMarkdown(WIKITEXT_SAMPLE);
    expect(md).not.toContain('{{Infobox');
    expect(md).not.toContain('<!--');
    expect(md).not.toContain('<ref');
    expect(md).toContain('**钓鱼**');           // ''' → **
    expect(md).toContain('*完美的*');             // '' → *
    expect(md).toContain('鱼竿');                 // [[Fishing Poles|鱼竿]] → 鱼竿
    expect(md).toContain('## 经验与等级');         // == → ##
    expect(md).toContain('### 训练');             // === → ###
    expect(md).toContain('#### 深水区');          // ===== → ####（层级收敛）
    expect(md).toContain('- 在Willy的商店');      // * 列表
    expect(md).toContain('· Sardine');           // 表格单元格降噪
    expect(md).toContain('External Label');       // 外链标签保留
    expect(md).toContain('https://example.org'); // 裸链保留
    expect(md).not.toMatch(/\n{3,}/);            // 空行压缩
  });
});

describe('renderGuideMarkdown / contentHash', () => {
  it('frontmatter 来源署名 + sha1 + 正文；hash 对空白不敏感、对内容敏感', () => {
    const guide = { topic: '钓鱼', pageTitle: 'Fishing', pageId: 1517, markdown: '正文', sha1: contentHash('正文') };
    const md = renderGuideMarkdown(guide);
    expect(md).toContain('guide-forager 归档');
    expect(md).toContain('gameId: stardew');
    expect(md).toContain('sourceType: wiki');
    expect(md).toContain('gameVersion: 1.6');
    expect(md).toContain('modContext: vanilla');
    expect(md).toContain('source: Stardew Valley Wiki');
    expect(md).toContain(`contentSha1: ${guide.sha1}`);
    expect(md).toContain('# Fishing');
    expect(md).toContain('本地自用缓存（D5）');
    expect(contentHash('a  b\nc')).toBe(contentHash('a b c'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });
});

describe('forageTopic / forageAll（离线注入 fetch）', () => {
  it('有效内容抓取→归档→二次同内容不变更（hash 去重）', async () => {
    const dir = `/tmp/gf-test-${Date.now()}`;
    const fetch = fetchOk(WIKITEXT_SAMPLE);
    const r1 = await forageTopic('钓鱼', ['Fishing'], { outDir: dir, fetchImpl: fetch });
    expect(r1.changed).toBe(true);
    const r2 = await forageTopic('钓鱼', ['Fishing'], { outDir: dir, fetchImpl: fetch });
    expect(r2.changed).toBe(false); // hash 命中不重写
    const r3 = await forageTopic('钓鱼', ['Fishing'], { outDir: dir, fetchImpl: fetchOk(WIKITEXT_SAMPLE + '\n新内容') });
    expect(r3.changed).toBe(true);
  });

  it('太薄内容（<200 字）跳过 → 无有效内容错误', async () => {
    const dir = `/tmp/gf-test-thin-${Date.now()}`;
    const r = await forageTopic('钓鱼', ['Redirect'], { outDir: dir, fetchImpl: fetchOk('short') });
    expect(r.changed).toBe(false);
    expect(r.error).toContain('无有效内容');
  });

  it('wiki error 响应 → 透传错误信息', async () => {
    const fetchErr = (async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 'missingtitle', info: '页面不存在' } }) })) as unknown as typeof fetch;
    const r = await forageTopic('钓鱼', ['Ghost'], { outDir: '/tmp/gf-err', fetchImpl: fetchErr });
    expect(r.changed).toBe(false);
    expect(r.error).toContain('页面不存在');
  });

  it('forageAll：TOPIC_PAGES 全部专题全跑 + 报告条数一致', async () => {
    const dir = `/tmp/gf-test-all-${Date.now()}`;
    const r = await forageAll({ outDir: dir, fetchImpl: fetchOk(WIKITEXT_SAMPLE) });
    const topicCount = Object.keys(TOPIC_PAGES).length;
    expect(topicCount).toBeGreaterThanOrEqual(12);
    expect(r.fetched).toHaveLength(topicCount);
    expect(Object.keys(TOPIC_PAGES)).toContain('钓鱼');
    expect(Object.keys(TOPIC_PAGES)).toContain('开局前几周');
    expect(Object.keys(TOPIC_PAGES)).toContain('四季作物收益');
    expect(r.fetched.every((f) => typeof f.changed === 'boolean')).toBe(true);
  });
});

describe('forageAll 容错与真实 fetch 路径', () => {
  it('某专题抛错不影响其余（catch 分支）+ fetch 非 ok → HTTP 错误', async () => {
    // fetchImpl 直接抛 → forageAll catch 收编为 error 字段
    const throwingFetch = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const r = await forageAll({ outDir: '/tmp/gf-throw', fetchImpl: throwingFetch });
    expect(r.fetched).toHaveLength(Object.keys(TOPIC_PAGES).length);
    expect(r.fetched.every((f) => f.error?.includes('ECONNRESET'))).toBe(true);
    // fetch 返回 !ok → wiki HTTP 错误
    const notOk = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    const r2 = await forageAll({ outDir: '/tmp/gf-403', fetchImpl: notOk });
    expect(r2.fetched.every((f) => f.error?.includes('wiki HTTP 403'))).toBe(true);
  });

  it('courtesyDelayMs=0 快速路径（不等待）', async () => {
    const dir = `/tmp/gf-fast-${Date.now()}`;
    const t0 = Date.now();
    await forageAll({ outDir: dir, fetchImpl: fetchOk(WIKITEXT_SAMPLE), courtesyDelayMs: 0 });
    expect(Date.now() - t0).toBeLessThan(2000); // 零延迟快速完成
  });
});

describe('forage 残余分支：双页混合（薄页跳过+厚页采用+延迟走真）', () => {
  it('专题内一薄一厚：薄页 continue、厚页采用；courtesyDelayMs 走真 setTimeout', async () => {
    const dir = `/tmp/gf-mixed-${Date.now()}`;
    const pages = ['Thin', 'Thick'];
    const impl = (async (url: string | Request | URL) => {
      const u = String(url);
      const title = u.includes('Thin') ? 'Thin' : 'Thick';
      const text = title === 'Thin' ? '太短' : WIKITEXT_SAMPLE;
      return { ok: true, status: 200, json: async () => parseFixture(text, title) };
    }) as unknown as typeof fetch;
    const r = await forageTopic('钓鱼', pages, { outDir: dir, fetchImpl: impl, courtesyDelayMs: 10 });
    expect(r.changed).toBe(true);
    const archived = (await import('node:fs')).readFileSync(`${dir}/钓鱼.md`, 'utf8');
    expect(archived).toContain('## Thick');
    expect(archived).not.toContain('## Thin'); // 薄页被 continue
  });
});

describe('forage 四残分支真测（46/133/142/144）', () => {
  it('超长模板名（>40）折叠为空；无 delay falsy；无 wikitext 抛错前 continue；无 title 回退页名', async () => {
    // 46 行：长名模板折叠为空串
    const longTpl = '{{' + 'x'.repeat(60) + '|param}}';
    const md = wikitextToMarkdown(`正文起头。${longTpl}结尾。`);
    expect(md).not.toContain('x'.repeat(60));
    // 142/144 行：parse 无 wikitext 键 → resp.parse.wikitext?.['*'] null → md='' → 薄页 continue → 无有效内容
    const noWikitext = (async () => ({ ok: true, status: 200, json: async () => ({ parse: { title: 'X', pageid: 1 } }) })) as unknown as typeof fetch;
    const r = await forageTopic('钓鱼', ['X'], { outDir: '/tmp/gf-nwt', fetchImpl: noWikitext });
    expect(r.error).toContain('无 wikitext');
    // 144 行：parse.title 缺失 → 回退传入页名
    const noTitle = (async () => ({ ok: true, status: 200, json: async () => ({ parse: { pageid: 2, wikitext: { '*': WIKITEXT_SAMPLE } } }) })) as unknown as typeof fetch;
    const dir = `/tmp/gf-nt-${Date.now()}`;
    await forageTopic('钓鱼', ['FallbackName'], { outDir: dir, fetchImpl: noTitle });
    const archived = (await import('node:fs')).readFileSync(`${dir}/钓鱼.md`, 'utf8');
    expect(archived).toContain('## FallbackName');
  });
});
