import { describe, expect, it } from 'vitest';
import { createInteractionState, DIZZY_ACTIONS, dockedPosition, dockEdgeFor, headPat, levelOf, recordShake, setAsleep, settleWorkGrudge, shouldBlockWhileAsleep, shouldEnterPowerSaver } from './interaction';

describe('pet interaction state machine', () => {
  it('甩动累积 4 档；level≥3 第一次摸头降到 2 并提示 coaxed，第二次彻底原谅', () => {
    const s = createInteractionState();
    let now = 0;
    expect(recordShake(s, 1, now)).toBe(0);
    for (let i = 0; i < 12; i++) { now += 80; recordShake(s, i % 2 === 0 ? -1 : 1, now); }
    expect(s.level).toBe(4);
    expect(new Set(Object.values(DIZZY_ACTIONS)).size).toBe(5);
    expect(levelOf(12)).toBe(4);
    expect(headPat(s)).toEqual({ level: 2, stage: 'coaxed' });
    expect(s.coaxStep).toBe(1);
    expect(headPat(s)).toEqual({ level: 0, stage: 'forgiven' });
    expect(s.dizzy).toBe(0);
  });
  it('没生气时摸头返回 normal，不误报原谅', () => {
    const s = createInteractionState();
    expect(headPat(s)).toEqual({ level: 0, stage: 'normal' });
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

  it('工作态晃动只记仇不眩晕，返回对应反应键；静止输入也返回反应键', () => {
    const s = createInteractionState();
    let now = 0;
    expect(recordShake(s, 0, now, 'work')).toBe('shakeWork');
    recordShake(s, 1, now, 'work');
    for (let i = 0; i < 5; i++) { now += 80; recordShake(s, i % 2 === 0 ? -1 : 1, now, 'work'); }
    expect(s.workGrudge).toBe(5);
    expect(s.dizzy).toBe(0);
    expect(s.level).toBe(0);
    expect(recordShake(s, 0, now, 'ask')).toBe('shakeAsk');
    expect(recordShake(s, 0, now, 'multi')).toBe('shakeMulti');
    // 久未晃：工作记仇也自然衰减
    recordShake(s, 1, now + 1_000, 'work');
    expect(s.workGrudge).toBe(4);
  });

  it('settleWorkGrudge：>=8 红温 / >=5 鼓脸 / >=2 不耐烦 / 其余 null，并同步生气档位', () => {
    const cases: Array<[number, string | null, number]> = [
      [8, 'workRedhot', 4],
      [5, 'workPuffed', 3],
      [2, 'workAnnoyed', 2],
      [1, null, 0],
    ];
    for (const [grudge, expected, level] of cases) {
      const s = createInteractionState();
      s.workGrudge = grudge;
      expect(settleWorkGrudge(s)).toBe(expected);
      expect(s.workGrudge).toBe(0);
      if (expected !== null) expect(s.level).toBe(level);
    }
    // 已有更高眩晕档时不降级
    const s = createInteractionState();
    s.dizzy = 14;
    s.level = 4;
    s.workGrudge = 2;
    expect(settleWorkGrudge(s)).toBe('workAnnoyed');
    expect(s.level).toBe(4);
  });

  it('level 2 摸头直接清零并返回 forgiven（之前生气）', () => {
    const s = createInteractionState();
    s.dizzy = 6;
    s.level = 2;
    expect(headPat(s)).toEqual({ level: 0, stage: 'forgiven' });
  });
});
