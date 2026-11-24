/** 代码符号飘字（T-M6-55）：reading/searching 判定、颜色回退、3–5 粒子确定性生成。 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GLYPH_FILL, DEFAULT_GLYPH_TEXT, glyphColors, glyphParticles, glyphSymbols, isReadingOrSearchingPose } from './glyph-effects';

describe('isReadingOrSearchingPose', () => {
  it.each(['reading', 'searching', 'read_file', 'web_search', 'Reading'])('命中 %s', (pose) => {
    expect(isReadingOrSearchingPose(pose)).toBe(true);
  });
  it.each(['idle', 'happy', 'writing', 'running'])('不命中 %s', (pose) => {
    expect(isReadingOrSearchingPose(pose)).toBe(false);
  });
});

describe('glyphColors / glyphSymbols', () => {
  it('缺色回退默认填充；显式描边保留', () => {
    expect(glyphColors(null)).toEqual({ fill: DEFAULT_GLYPH_FILL, stroke: 'rgba(8,14,24,0.65)' });
    expect(glyphColors({ fill: '#ff8800', stroke: '#001122' })).toEqual({ fill: '#ff8800', stroke: '#001122' });
  });

  it('文本按空白/逗号切分；空文本回退代码符号表', () => {
    expect(glyphSymbols({ text: '<> {} / ' })).toEqual(['<>', '{}', '/']);
    expect(glyphSymbols({ text: '' })).toEqual(DEFAULT_GLYPH_TEXT.split(''));
    expect(glyphSymbols(null)).toHaveLength(DEFAULT_GLYPH_TEXT.length);
  });
});

describe('glyphParticles', () => {
  it('固定 rng 生成 3 个合法粒子（位置/尺寸/时长在边界内）', () => {
    const particles = glyphParticles({ text: '<>', fill: '#fff' }, () => 0.5, 3);
    expect(particles).toHaveLength(3);
    for (const particle of particles) {
      expect(particle.symbol).toBe('<>');
      expect(particle.leftPercent).toBeGreaterThanOrEqual(10);
      expect(particle.leftPercent).toBeLessThanOrEqual(86);
      expect(particle.sizePx).toBeGreaterThanOrEqual(12);
      expect(particle.sizePx).toBeLessThanOrEqual(20);
      expect(particle.durationMs).toBeGreaterThanOrEqual(2_600);
      expect(particle.durationMs).toBeLessThanOrEqual(4_000);
    }
  });

  it('未指定数量时按 rng 落在 3–5 之间', () => {
    expect(glyphParticles(null, () => 0)).toHaveLength(3);
    expect(glyphParticles(null, () => 0.99)).toHaveLength(5);
  });
});
