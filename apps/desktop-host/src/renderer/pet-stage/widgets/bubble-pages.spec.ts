import { describe, expect, it } from 'vitest';
import { bubblePageReadingMs, paginateBubbleText } from './bubble-pages';

describe('真实容量气泡分页', () => {
  it('逐页连接保持中英、emoji、换行和空白原样', () => {
    const full = '今天🐳先整理背包\n再去Farm，  确认回执。';
    const pages = paginateBubbleText(full, (text) => Array.from(text).length <= 5);
    expect(pages.join('')).toBe(full);
    expect(pages.every((page) => Array.from(page).length <= 5)).toBe(true);
    expect(pages.some((page) => page.includes('🐳'))).toBe(true);
  });
  it('分页不会拆开 ZWJ emoji 或组合音标', () => {
    const full = '鲸👩‍🌾e\u0301鱼';
    const pages = paginateBubbleText(full, (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length <= 1);
    expect(pages).toEqual(['鲸', '👩‍🌾', 'e\u0301', '鱼']);
    expect(pages.join('')).toBe(full);
  });
  it('按注入的真实宽度判据而非固定字数分页', () => {
    const width = (text: string): number => Array.from(text).reduce((sum, glyph) => sum + (glyph === 'W' ? 3 : 1), 0);
    const pages = paginateBubbleText('WWiiWiiii', (text) => width(text) <= 6);
    expect(pages).toEqual(['WW', 'iiWi', 'iii']);
  });
  it('空文本和恰好一页不会制造空白尾页', () => {
    expect(paginateBubbleText('', () => true)).toEqual([]);
    expect(paginateBubbleText('一整页', () => true)).toEqual(['一整页']);
  });
  it('单字不适配时明确报告布局不可用', () => {
    expect(() => paginateBubbleText('字', () => false)).toThrow(RangeError);
  });
  it('长文本分页判据调用保持二分预算', () => {
    let calls = 0;
    const pages = paginateBubbleText('鲸'.repeat(1_000), (text) => { calls += 1; return text.length <= 100; });
    expect(pages).toHaveLength(10);
    expect(calls).toBeLessThan(100);
  });
  it('阅读停留覆盖短页与长页且 emoji 只计一个字', () => {
    expect(bubblePageReadingMs('🐳')).toBe(1_800);
    expect(bubblePageReadingMs('鲸'.repeat(50))).toBe(8_000);
  });
});
