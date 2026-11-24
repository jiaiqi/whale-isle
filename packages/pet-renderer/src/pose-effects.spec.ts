/** CrossPet 姿势动效（T-M6-48）：SVG 结构、每种动效的偏移与默认分支。 */
import { describe, expect, it } from 'vitest';
import { poseEffectOffsets, poseEffectSvg, type PoseEffectKind } from './pose-effects';

const KINDS: PoseEffectKind[] = ['heart', 'steam', 'sparkle', 'note', 'zzz', 'anger'];

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
