/**
 * 久坐 / 喝水提醒与按时段问候（T-M6-48，移植 CrossPet `break-reminders.js` 规则）。
 *
 * 纯函数便于确定性测试；真正的定时器与 TTS 播报在 main/index.ts。
 * 免打扰：23:00–07:00 与桌宠睡眠态一律不提醒；同一类提醒触发后重新计时。
 */
export const SIT_INTERVAL_MS = 60 * 60 * 1000;
export const WATER_INTERVAL_MS = 45 * 60 * 1000;
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 7;

export interface BreakReminderState {
  lastSitAt: number;
  lastWaterAt: number;
  lastSitFired: number;
  lastWaterFired: number;
}

export type BreakReminderKind = 'sit' | 'water';

export function createBreakReminderState(now: number): BreakReminderState {
  return { lastSitAt: now, lastWaterAt: now, lastSitFired: 0, lastWaterFired: 0 };
}

export function isQuietHours(date: Date): boolean {
  const hour = date.getHours();
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** 返回本次应触发的提醒（优先喝水），并推进状态；免打扰时只重置计时不返回。 */
export function dueReminder(state: BreakReminderState, now: number, options: {
  asleep: boolean;
  quiet?: boolean;
  sitIntervalMs?: number;
  waterIntervalMs?: number;
}): BreakReminderKind | null {
  const quiet = options.quiet ?? isQuietHours(new Date(now));
  if (options.asleep || quiet) {
    state.lastSitAt = now;
    state.lastWaterAt = now;
    return null;
  }
  if (now - state.lastWaterAt >= (options.waterIntervalMs ?? WATER_INTERVAL_MS)) {
    state.lastWaterAt = now;
    state.lastWaterFired = now;
    return 'water';
  }
  if (now - state.lastSitAt >= (options.sitIntervalMs ?? SIT_INTERVAL_MS)) {
    state.lastSitAt = now;
    state.lastSitFired = now;
    return 'sit';
  }
  return null;
}

export function reminderLine(kind: BreakReminderKind, characterName: string): string {
  return kind === 'water'
    ? `${characterName}提醒你：杯子空啦，喝口水再继续，我帮你盯着进度。`
    : `${characterName}提醒你：坐太久啦，起来走两步，肩膀放松一下。`;
}

/** 按时段首次见面问候（CrossPet greet_dawn…greet_night）。 */
export function greetingForHour(hour: number, characterName: string): string {
  if (hour >= 5 && hour < 9) return `早上好，${characterName}已经把今天的计划摆好了。`;
  if (hour >= 9 && hour < 12) return `上午好，${characterName}在这儿，有事随时喊我。`;
  if (hour >= 12 && hour < 14) return `中午啦，先吃饭，${characterName}帮你看着进度。`;
  if (hour >= 14 && hour < 18) return `下午好，${characterName}陪你把这阵忙完。`;
  if (hour >= 18 && hour < 23) return `晚上好，今天也辛苦啦，${characterName}在。`;
  return `这么晚还没睡？${characterName}陪你一会儿，别熬太久。`;
}
