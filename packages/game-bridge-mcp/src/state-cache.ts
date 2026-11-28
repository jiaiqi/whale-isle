/**
 * BWF `Observer.Once(...)` 省略段本地水合缓存：
 * BWF 1.1.27 会把 10 分钟内未变化的「穿戴 / 箱子 / 本地出口 / 图例 / 农田 / 花钱建议」
 * 折叠为 `（和上次 get_state 一样，没变化，省略；要看就 get_state full=true）`。
 * 而 LlmPlanner 每轮都是无状态单轮请求，一旦折叠就会在后续回合丢失出口/箱子/农田视野，
 * 本缓存自动把最近一次非省略内容回填进本次 state 原文，零多余游戏开销且不误改真实数值。
 */

export const BWF_OMITTED_MARKER = '和上次 get_state 一样，没变化，省略';
export const BWF_SPEND_OMITTED = '【花钱建议】和上次一样，省略';

function extractLocationKey(raw: string): string {
  const m = /^地点：([^\s（，。\n]+)/m.exec(raw);
  return m?.[1]?.trim() || '未知';
}

/** 按 `## 标题` 分段（保留前缀段），保持原顺序 */
function splitSections(raw: string): { prefix: string; sections: Array<{ header: string; body: string }> } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const prefixLines: string[] = [];
  const sections: Array<{ header: string; bodyLines: string[] }> = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      sections.push({ header: line, bodyLines: [] });
    } else if (sections.length === 0) {
      prefixLines.push(line);
    } else {
      sections[sections.length - 1]!.bodyLines.push(line);
    }
  }

  return {
    prefix: prefixLines.join('\n'),
    sections: sections.map((s) => ({ header: s.header, body: s.bodyLines.join('\n') })),
  };
}

function sectionCacheKey(header: string, locationKey: string): string | null {
  if (/^##\s*穿戴/.test(header)) return 'wear';
  if (/^##\s*箱子/.test(header)) return 'chests';
  if (/^##\s*本地出口/.test(header)) return `exits:${locationKey}`;
  return null;
}

export class BwfStateSectionCache {
  private readonly cache = new Map<string, string>();

  clear(): void {
    this.cache.clear();
  }

  /** 是否存在 BWF 已折叠但本缓存尚无底稿的关键段（需要补拉一次 `get_state full=true`） */
  needsFullWarmup(raw: string): boolean {
    if (!raw.includes(BWF_OMITTED_MARKER)) return false;
    const locationKey = extractLocationKey(raw);
    const { sections } = splitSections(raw);
    for (const sec of sections) {
      const key = sectionCacheKey(sec.header, locationKey);
      if (key !== null && sec.body.includes(BWF_OMITTED_MARKER) && !this.cache.has(key)) {
        return true;
      }
      if (/^##\s*作物/.test(sec.header) && sec.body.includes(BWF_OMITTED_MARKER) && !this.cache.has(`fields:${locationKey}`)) {
        return true;
      }
      if (/^##\s*文字地图/.test(sec.header) && sec.body.includes(BWF_OMITTED_MARKER) && !this.cache.has('legend')) {
        return true;
      }
    }
    return false;
  }

  /** 吸收有效段并回填当前帧中被 `Once(...)` 省略的段落 */
  hydrate(raw: string): string {
    if (raw.trim() === '') return raw;
    const locationKey = extractLocationKey(raw);
    const { prefix, sections } = splitSections(raw);

    let nextPrefix = prefix;
    if (prefix.includes(BWF_SPEND_OMITTED)) {
      const cachedSpend = this.cache.get('spend');
      if (cachedSpend !== undefined) {
        nextPrefix = nextPrefix.replace(BWF_SPEND_OMITTED, cachedSpend);
      }
    } else {
      const spendMatch = /^【花钱建议】[^\n]*$/m.exec(prefix);
      if (spendMatch !== null) this.cache.set('spend', spendMatch[0]);
    }

    const hydratedSections = sections.map((sec) => {
      const key = sectionCacheKey(sec.header, locationKey);
      if (key !== null) {
        if (sec.body.includes(BWF_OMITTED_MARKER)) {
          const cached = this.cache.get(key);
          if (cached !== undefined) return `${sec.header}\n${cached}`;
          return `${sec.header}\n${sec.body}`;
        }
        const trimmed = sec.body.replace(/\n+$/, '');
        if (trimmed !== '') this.cache.set(key, sec.body);
        return `${sec.header}\n${sec.body}`;
      }

      if (/^##\s*文字地图/.test(sec.header)) {
        const lines = sec.body.split('\n');
        const nextLines = lines.map((line) => {
          if (line.includes(BWF_OMITTED_MARKER)) {
            return this.cache.get('legend') ?? line;
          }
          if (line.startsWith('图例：')) this.cache.set('legend', line);
          return line;
        });
        return `${sec.header}\n${nextLines.join('\n')}`;
      }

      if (/^##\s*作物/.test(sec.header)) {
        const fieldKey = `fields:${locationKey}`;
        const lines = sec.body.split('\n');
        const nextLines = lines.map((line) => {
          if (line.includes(BWF_OMITTED_MARKER)) {
            return this.cache.get(fieldKey) ?? line;
          }
          if (line.startsWith('农田：')) this.cache.set(fieldKey, line);
          return line;
        });
        return `${sec.header}\n${nextLines.join('\n')}`;
      }

      return sec.body === '' ? sec.header : `${sec.header}\n${sec.body}`;
    });

    const parts = [nextPrefix, ...hydratedSections].filter((p, idx) => idx === 0 ? p !== '' : true);
    return parts.join('\n');
  }
}
