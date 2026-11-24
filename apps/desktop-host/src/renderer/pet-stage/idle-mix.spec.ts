/** idleActions 混播（T-M6-55）：只从真实存在的姿态里选，自定义权重高于内置氛围池。 */
import { describe, expect, it } from 'vitest';
import { pickIdleMix } from './idle-mix';

describe('pickIdleMix', () => {
  it('自定义动作缺图时忽略；有图时优先按权重进入轮盘', () => {
    const pick = pickIdleMix({
      idleActions: ['stretch', 'missing-pose'],
      available: ['stretch', 'idle', 'sparkle'],
      ambientIds: ['sparkle'],
      rng: () => 0,
    });
    expect(pick).toEqual({ id: 'stretch', kind: 'custom-idle' });
  });

  it('rng 末端落到内置氛围动作（权重 2:1）', () => {
    const pick = pickIdleMix({
      idleActions: ['stretch'],
      available: ['stretch', 'sparkle'],
      ambientIds: ['sparkle'],
      rng: () => 0.999,
    });
    expect(pick).toEqual({ id: 'sparkle', kind: 'ambient' });
  });

  it('没有自定义动作时纯内置；没有氛围池时纯自定义；全空返回 null', () => {
    expect(pickIdleMix({ idleActions: [], available: ['a', 'b'], ambientIds: ['a', 'b'], rng: () => 0.4 })).toEqual({ id: 'a', kind: 'ambient' });
    expect(pickIdleMix({ idleActions: ['x'], available: ['x'], ambientIds: [], rng: () => 0.4 })).toEqual({ id: 'x', kind: 'custom-idle' });
    expect(pickIdleMix({ idleActions: [], available: [], ambientIds: [] })).toBeNull();
  });

  it('去重且忽略空白 id', () => {
    const pick = pickIdleMix({ idleActions: ['  ', 'stretch', 'stretch'], available: ['stretch'], ambientIds: ['stretch'], rng: () => 0.5 });
    expect(pick?.kind).toBe('custom-idle');
  });

  it('rng=1 边界（浮点累加末端）仍返回合法结果', () => {
    const pick = pickIdleMix({ idleActions: ['stretch'], available: ['stretch', 'sparkle'], ambientIds: ['sparkle'], rng: () => 1 });
    expect(pick).toEqual({ id: 'sparkle', kind: 'ambient' });
  });
});
