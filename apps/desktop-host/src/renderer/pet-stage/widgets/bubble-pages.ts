/** 使用真实文本布局判据分页；不 trim、不插入标点，不拆 emoji 与组合字符。 */
export function paginateBubbleText(text: string, fits: (candidate: string) => boolean): string[] {
  const glyphs = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (entry) => entry.segment);
  const pages: string[] = [];
  let start = 0;
  while (start < glyphs.length) {
    let low = 1;
    let high = glyphs.length - start;
    let count = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(glyphs.slice(start, start + mid).join(''))) {
        count = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    // 舞台至少须容纳一个字；不能以丢字或无限循环掩盖无可用空间。
    if (count === 0) throw new RangeError('气泡文本区域无法容纳单个字符');
    pages.push(glyphs.slice(start, start + count).join(''));
    start += count;
  }
  return pages;
}

/** 每页逐字完成后再计阅读时间，约每秒六字，短页也保留基础停留。 */
export function bubblePageReadingMs(text: string): number {
  return Math.max(1_800, Array.from(text).length * 160);
}
