/** 峰谷时段与自动换装（T-M6-65）：北京时间边界、跨午夜、仅边界触发一次。 */
import { describe, expect, it } from 'vitest';
import { beijingMinutesOfDay, decidePeakOutfit, isPeakOutfitFamily, PEAK_SEGMENTS, resolvePeakPeriod, type PeakOutfitPrefs, type PeakOutfitState } from './peak-schedule';

const utc = (iso: string): Date => new Date(iso);
const prefs: PeakOutfitPrefs = { enabled: true, peakOutfitDay: 'crosspet-deepseek', peakOutfitOffPeak: 'crosspet-deepseek-pajamas' };

describe('resolvePeakPeriod：UTC+8 边界', () => {
  it('00:30–08:30 为 off-peak，08:30–00:30 为 peak', () => {
    expect(resolvePeakPeriod(utc('2026-01-01T16:29:00Z'))).toMatchObject({ period: 'peak', minutesOfDay: 29 });
    expect(resolvePeakPeriod(utc('2026-01-01T16:30:00Z'))).toMatchObject({ period: 'off-peak', minutesOfDay: 30 });
    expect(resolvePeakPeriod(utc('2026-01-02T00:29:00Z'))).toMatchObject({ period: 'off-peak', minutesOfDay: 8 * 60 + 29 });
    expect(resolvePeakPeriod(utc('2026-01-02T00:30:00Z'))).toMatchObject({ period: 'peak', minutesOfDay: 8 * 60 + 30 });
    expect(resolvePeakPeriod(utc('2026-01-02T15:59:00Z'))).toMatchObject({ period: 'peak', minutesOfDay: 23 * 60 + 59 });
  });

  it('nextSwitchInMinutes 跨午夜正确', () => {
    expect(resolvePeakPeriod(utc('2026-01-01T16:00:00Z')).nextSwitchInMinutes).toBe(30); // 00:00 → 00:30
    expect(resolvePeakPeriod(utc('2026-01-01T16:30:00Z')).nextSwitchInMinutes).toBe(480); // 00:30 → 08:30
    expect(resolvePeakPeriod(utc('2026-01-02T15:00:00Z')).nextSwitchInMinutes).toBe(90); // 23:00 → 次日 00:30
    expect(beijingMinutesOfDay(utc('2026-01-02T04:00:00Z'))).toBe(12 * 60);
  });

  it('24h 时间条覆盖全天且首尾相接', () => {
    expect(PEAK_SEGMENTS[0]?.startMinute).toBe(0);
    expect(PEAK_SEGMENTS.at(-1)?.endMinute).toBe(1_440);
    for (let index = 1; index < PEAK_SEGMENTS.length; index += 1) {
      expect(PEAK_SEGMENTS[index]?.startMinute).toBe(PEAK_SEGMENTS[index - 1]?.endMinute);
    }
  });
});

describe('isPeakOutfitFamily', () => {
  it('只认 DeepSeek / GLM', () => {
    expect(isPeakOutfitFamily('crosspet-deepseek-pajamas')).toBe(true);
    expect(isPeakOutfitFamily('aboutme-glm')).toBe(true);
    expect(isPeakOutfitFamily('custom-my-glm')).toBe(true);
    expect(isPeakOutfitFamily('crosspet-claude')).toBe(false);
    expect(isPeakOutfitFamily('blue-whale-maid')).toBe(false);
  });
});

describe('decidePeakOutfit：仅跨边界触发一次', () => {
  it('首次观察只记录，不覆盖用户当前皮肤', () => {
    const state: PeakOutfitState = { lastPeriod: null };
    const decision = decidePeakOutfit(state, utc('2026-01-01T17:00:00Z'), 'crosspet-deepseek', prefs);
    expect(decision.apply).toBe(false);
    expect(decision.state.lastPeriod).toBe('off-peak');
    expect(decision.reason).toContain('首次观察');
  });

  it('同一时段内反复调用不换装；跨入 peak 换日常、跨入 off-peak 换睡衣', () => {
    let state: PeakOutfitState = { lastPeriod: 'off-peak' };
    const same = decidePeakOutfit(state, utc('2026-01-01T17:30:00Z'), 'crosspet-deepseek', prefs);
    expect(same.apply).toBe(false);
    expect(same.reason).toContain('同一时段');

    const toPeak = decidePeakOutfit(state, utc('2026-01-02T01:00:00Z'), 'crosspet-deepseek', prefs);
    expect(toPeak).toMatchObject({ apply: true, skinId: 'crosspet-deepseek', period: 'peak' });
    state = toPeak.state;

    const again = decidePeakOutfit(state, utc('2026-01-02T02:00:00Z'), 'crosspet-deepseek', prefs);
    expect(again.apply).toBe(false);

    const toOffPeak = decidePeakOutfit(state, utc('2026-01-01T17:00:00Z'), 'crosspet-deepseek', prefs);
    expect(toOffPeak).toMatchObject({ apply: true, skinId: 'crosspet-deepseek-pajamas', period: 'off-peak' });
  });

  it('开关关闭/非 DeepSeek-GLM/空皮肤均不换装，但仍更新时段', () => {
    const peak = utc('2026-01-02T02:00:00Z');
    const offState: PeakOutfitState = { lastPeriod: 'off-peak' };
    expect(decidePeakOutfit(offState, peak, 'crosspet-deepseek', { ...prefs, enabled: false })).toMatchObject({ apply: false, state: { lastPeriod: 'peak' } });
    expect(decidePeakOutfit(offState, peak, 'crosspet-claude', prefs)).toMatchObject({ apply: false, skinId: null });
    expect(decidePeakOutfit(offState, peak, 'crosspet-glm', { ...prefs, peakOutfitDay: '' })).toMatchObject({ apply: false, skinId: null });
  });
});
