import { describe, expect, it } from 'vitest';
import { createInteractionState, DIZZY_ACTIONS, dockedPosition, dockEdgeFor, headPat, levelOf, recordShake, setAsleep, shouldBlockWhileAsleep, shouldEnterPowerSaver } from './interaction';

describe('pet interaction state machine', () => {
  it('甩动累积 4 档，摸头清零', () => {
    const s = createInteractionState();
    let now = 0;
    expect(recordShake(s, 1, now)).toBe(0);
    for (let i = 0; i < 12; i++) { now += 80; recordShake(s, i % 2 === 0 ? -1 : 1, now); }
    expect(s.level).toBe(4);
    expect(new Set(Object.values(DIZZY_ACTIONS)).size).toBe(5);
    expect(levelOf(12)).toBe(4);
    expect(headPat(s)).toBe(0);
  });
  it('睡眠阻断 ambient/thought/rice/work，允许梦话与唤醒', () => {
    const s = createInteractionState();
    setAsleep(s, true);
    expect(shouldBlockWhileAsleep(s, 'ambient')).toBe(true);
    expect(shouldBlockWhileAsleep(s, 'thought')).toBe(true);
    expect(shouldBlockWhileAsleep(s, 'rice')).toBe(true);
    expect(shouldBlockWhileAsleep(s, 'work')).toBe(true);
    expect(shouldBlockWhileAsleep(s, 'sleep-talk')).toBe(false);
    expect(shouldBlockWhileAsleep(s, 'wake')).toBe(false);
    setAsleep(s, false);
    expect(shouldBlockWhileAsleep(s, 'ambient')).toBe(false);
  });
  it('贴边左右判定与探出位置', () => {
    expect(dockEdgeFor({ x: 0, width: 400 }, { x: 0, width: 1440 })).toBe('left');
    expect(dockEdgeFor({ x: 1040, width: 400 }, { x: 0, width: 1440 })).toBe('right');
    expect(dockEdgeFor({ x: 400, width: 400 }, { x: 0, width: 1440 })).toBeNull();
    expect(dockedPosition('left', { y: 100, width: 400 }, { x: 0, width: 1440 })).toEqual({ x: -220, y: 100 });
    expect(dockedPosition('right', { y: 100, width: 400 }, { x: 0, width: 1440 })).toEqual({ x: 1260, y: 100 });
  });
  it('闲置 30s 才进入省电', () => {
    expect(shouldEnterPowerSaver(0, 29_999, true)).toBe(false);
    expect(shouldEnterPowerSaver(0, 30_000, true)).toBe(true);
    expect(shouldEnterPowerSaver(0, 99_999, false)).toBe(false);
  });
});

describe('interaction 边界补强', () => {
  it('静止输入不累积、超过 900ms 衰减、等级上限与左右边界', () => {
    const s = createInteractionState();
    expect(recordShake(s, 0, 10)).toBe(0);
    s.dizzy = 12;
    recordShake(s, 1, 2_000);
    expect(s.level).toBe(3);
    s.dizzy = 20;
    s.lastDirection = -1;
    recordShake(s, 1, 2_100);
    expect(s.dizzy).toBe(14);
    expect(levelOf(1)).toBe(0);
    expect(levelOf(2)).toBe(1);
    expect(levelOf(5)).toBe(2);
    expect(levelOf(8)).toBe(3);
    expect(dockEdgeFor({ x: 17, width: 200 }, { x: 0, width: 1000 })).toBeNull();
  });
});
