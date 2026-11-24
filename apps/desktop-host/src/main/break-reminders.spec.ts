/** 久坐/喝水提醒与问候（T-M6-48）：免打扰时段、睡眠态、计时推进与台词。 */
import { describe, expect, it } from 'vitest';
import { createBreakReminderState, dueReminder, greetingForHour, isQuietHours, QUIET_END_HOUR, QUIET_START_HOUR, reminderLine, SIT_INTERVAL_MS, WATER_INTERVAL_MS } from './break-reminders';

const NOON = new Date('2026-11-24T12:00:00').getTime();

describe('break-reminders', () => {
  it('免打扰 23:00–07:00', () => {
    expect(isQuietHours(new Date('2026-11-24T23:00:00'))).toBe(true);
    expect(isQuietHours(new Date('2026-11-24T06:59:00'))).toBe(true);
    expect(isQuietHours(new Date('2026-11-24T07:00:00'))).toBe(false);
    expect(isQuietHours(new Date('2026-11-24T22:59:00'))).toBe(false);
    expect(QUIET_START_HOUR).toBe(23);
    expect(QUIET_END_HOUR).toBe(7);
  });

  it('喝水先于久坐；触发后重新计时；睡眠/免打扰只重置不触发', () => {
    const state = createBreakReminderState(NOON);
    expect(dueReminder(state, NOON + WATER_INTERVAL_MS, { asleep: false, quiet: false })).toBe('water');
    expect(dueReminder(state, NOON + WATER_INTERVAL_MS + 1000, { asleep: false, quiet: false })).toBeNull();
    expect(dueReminder(state, NOON + WATER_INTERVAL_MS + SIT_INTERVAL_MS + 2000, { asleep: false, quiet: false })).toBe('water');
    const sleeping = createBreakReminderState(NOON);
    expect(dueReminder(sleeping, NOON + 10 * SIT_INTERVAL_MS, { asleep: true, quiet: false })).toBeNull();
    expect(sleeping.lastSitAt).toBe(NOON + 10 * SIT_INTERVAL_MS);
    const quiet = createBreakReminderState(NOON);
    expect(dueReminder(quiet, NOON + 10 * SIT_INTERVAL_MS, { asleep: false, quiet: true })).toBeNull();
  });

  it('自定义间隔与台词/问候按时段', () => {
    const state = createBreakReminderState(NOON);
    expect(dueReminder(state, NOON + 5_000, { asleep: false, quiet: false, sitIntervalMs: 1_000, waterIntervalMs: 99_000 })).toBe('sit');
    expect(reminderLine('water', '蓝蓝')).toContain('喝口水');
    expect(reminderLine('sit', '蓝蓝')).toContain('走两步');
    expect(greetingForHour(6, '小鲸')).toContain('早上好');
    expect(greetingForHour(12, '小鲸')).toContain('中午');
    expect(greetingForHour(20, '小鲸')).toContain('晚上好');
    expect(greetingForHour(2, '小鲸')).toContain('这么晚');
  });
});
