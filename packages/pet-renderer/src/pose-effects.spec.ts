/** CrossPet 姿势动效（T-M6-48）：SVG 结构、每种动效的偏移与默认分支。 */
import { describe, expect, it } from 'vitest';
import { mergePoseEffects, normalizePoseEffect, poseEffectOffsets, poseEffectSvg, type PoseEffectKind } from './pose-effects';

const KINDS: PoseEffectKind[] = ['heart', 'steam', 'sparkle', 'note', 'zzz', 'anger', 'bubbles', 'celebrate', 'victory', 'priceDown', 'priceUp'];

describe('pose-effects', () => {
  it('每种动效都输出带 data-pose-effect 的独立 SVG', () => {
    for (const kind of KINDS) {
      const svg = poseEffectSvg(kind);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain(`data-pose-effect="${kind}"`);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg.endsWith('</svg>')).toBe(true);
    }
    expect(new Set(KINDS.map((kind) => poseEffectSvg(kind))).size).toBe(KINDS.length);
  });

  it('偏移表：多张动效错开；默认分支只给一张', () => {
    expect(poseEffectOffsets('heart')).toHaveLength(3);
    expect(poseEffectOffsets('steam')).toHaveLength(2);
    expect(poseEffectOffsets('sparkle')).toHaveLength(3);
    expect(poseEffectOffsets('zzz')[2]?.delayMs).toBeGreaterThan(poseEffectOffsets('zzz')[1]!.delayMs);
    expect(poseEffectOffsets('note')).toEqual([{ dx: 0, dy: -6, delayMs: 0 }]);
    expect(poseEffectOffsets('anger')).toEqual([{ dx: 0, dy: -6, delayMs: 0 }]);
  });
});


describe('自定义 character.json.fx（T-M6-54）', () => {
  it('CrossPet 具名动效归一：大小写/连字符/别名都可渲染，未知返回 null', () => {
    expect(normalizePoseEffect('bubbles')).toBe('bubbles');
    expect(normalizePoseEffect('Bubbles')).toBe('bubbles');
    expect(normalizePoseEffect('celebrate')).toBe('celebrate');
    expect(normalizePoseEffect('confetti')).toBe('celebrate');
    expect(normalizePoseEffect('price-down')).toBe('priceDown');
    expect(normalizePoseEffect('priceUp')).toBe('priceUp');
    expect(normalizePoseEffect('sparkle')).toBe('sparkle');
    expect(normalizePoseEffect('unknown-fx')).toBeNull();
    for (const kind of ['bubbles', 'celebrate', 'victory', 'priceDown', 'priceUp'] as const) {
      expect(poseEffectSvg(kind)).toContain(`data-pose-effect="${kind}"`);
    }
  });

  it('mergePoseEffects：自定义覆盖同名姿态，脏值丢弃且默认映射不丢', () => {
    const base = { pat: 'heart', proud: 'sparkle', idle: 'note' };
    const merged = mergePoseEffects(base, { proud: 'victory', thinking: 'bubbles', broken: 'nope', eat: 'celebrate' });
    expect(merged).toEqual({ pat: 'heart', proud: 'victory', idle: 'note', thinking: 'bubbles', eat: 'celebrate' });
    expect(mergePoseEffects(base, undefined)).toEqual(base);
    // 不改原对象
    expect(base.proud).toBe('sparkle');
  });
});
