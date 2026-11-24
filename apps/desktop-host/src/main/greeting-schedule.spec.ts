/** 时段/节日首见登场（T-M6-55）：6 时段、8 节日（含农历边界）、首见去重与缺图回退。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimFirstMeeting,
  festivalsFor,
  fileGreetingStore,
  greetingKeysFor,
  readGreetingLog,
  resolveGreeting,
  timeSlotFor,
  ymd,
} from './greeting-schedule';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'greeting-'));
  dirs.push(dir);
  return dir;
}
const at = (iso: string, hour: number): Date => new Date(`${iso}T${`${hour}`.padStart(2, '0')}:00:00`);

describe('timeSlotFor：6 时段边界', () => {
  it.each([
    [5, 'greet_morning'], [10, 'greet_morning'],
    [11, 'greet_noon'], [13, 'greet_noon'],
    [14, 'greet_afternoon'], [17, 'greet_afternoon'],
    [18, 'greet_evening'], [22, 'greet_evening'],
    [23, 'greet_night'], [0, 'greet_night'], [1, 'greet_night'],
    [2, 'greet_dawn'], [4, 'greet_dawn'],
  ] as const)('%i 点 → %s', (hour, expected) => {
    expect(timeSlotFor(hour)).toBe(expected);
  });

  it('非法小时按 0 点处理（深夜），不抛错', () => {
    expect(timeSlotFor(Number.NaN)).toBe('greet_night');
  });
});

describe('festivalsFor：8 节日与农历边界', () => {
  it('公历节日：元旦/万圣/圣诞两天/国庆七天窗口', () => {
    expect(festivalsFor(at('2026-01-01', 9))).toContain('fest_newyear');
    expect(festivalsFor(at('2026-10-31', 20))).toContain('fest_halloween');
    expect(festivalsFor(at('2026-12-24', 20))).toContain('fest_christmas');
    expect(festivalsFor(at('2026-12-25', 20))).toContain('fest_christmas');
    expect(festivalsFor(at('2026-10-01', 9))).toContain('fest_national');
    expect(festivalsFor(at('2026-10-07', 9))).toContain('fest_national');
    expect(festivalsFor(at('2026-10-08', 9))).not.toContain('fest_national');
  });

  it('春节初一到初七（2026 除夕 02-16 不命中，初一 02-17 命中，初七 02-23 命中，初八不命中）', () => {
    expect(festivalsFor(at('2026-02-16', 9))).not.toContain('fest_spring');
    expect(festivalsFor(at('2026-02-17', 9))).toContain('fest_spring');
    expect(festivalsFor(at('2026-02-23', 9))).toContain('fest_spring');
    expect(festivalsFor(at('2026-02-24', 9))).not.toContain('fest_spring');
  });

  it('元宵 = 初一后 14 天（2026-03-03），端午/中秋表内命中', () => {
    expect(festivalsFor(at('2026-03-03', 20))).toContain('fest_lantern');
    expect(festivalsFor(at('2026-03-04', 20))).not.toContain('fest_lantern');
    expect(festivalsFor(at('2026-06-19', 12))).toContain('fest_dragonboat');
    expect(festivalsFor(at('2026-09-25', 20))).toContain('fest_midautumn');
    expect(festivalsFor(at('2026-09-26', 20))).not.toContain('fest_midautumn');
  });

  it('跨年表：2025 春节 01-29、2035 中秋 09-16 均命中', () => {
    expect(festivalsFor(at('2025-01-29', 9))).toContain('fest_spring');
    expect(festivalsFor(at('2035-09-16', 20))).toContain('fest_midautumn');
  });

  it('2031-10-01 国庆与中秋重合：两个节日都返回（按具体度排序，中秋在前）', () => {
    const list = festivalsFor(at('2031-10-01', 9));
    expect(list.indexOf('fest_midautumn')).toBeLessThan(list.indexOf('fest_national'));
  });

  it('表外年份不猜测农历节日，公历节日照常', () => {
    expect(festivalsFor(at('2040-02-17', 9))).not.toContain('fest_spring');
    expect(festivalsFor(at('2040-01-01', 9))).toContain('fest_newyear');
  });
});

describe('greetingKeysFor / resolveGreeting', () => {
  it('节日优先，其次时段；缺图回退 null', () => {
    const date = at('2026-12-25', 9);
    expect(greetingKeysFor(date)).toEqual(['fest_christmas', 'greet_morning']);
    const lines = { fest_christmas: ['圣诞快乐！'], greet_morning: ['早上好～'] };
    expect(resolveGreeting({ date, availablePoses: ['fest_christmas', 'greet_morning'], lines })).toEqual({
      key: 'fest_christmas', pose: 'fest_christmas', line: '圣诞快乐！',
    });
    // 只缺节日图 → 时段图顶上
    expect(resolveGreeting({ date, availablePoses: ['greet_morning'], lines })).toEqual({
      key: 'greet_morning', pose: 'greet_morning', line: '早上好～',
    });
    // 全缺 → null（调用方回退每日问候）
    expect(resolveGreeting({ date, availablePoses: ['idle'], lines })).toBeNull();
  });

  it('有图无台词也播图（line 为空串，绝不编造）', () => {
    const resolved = resolveGreeting({ date: at('2026-03-02', 15), availablePoses: ['greet_afternoon'], lines: {} });
    expect(resolved).toEqual({ key: 'greet_afternoon', pose: 'greet_afternoon', line: '' });
  });

  it('多条台词按 rng 随机轮换，不再写死第一句', () => {
    const lines = { greet_morning: ['早安一', '早安二', '早安三'] };
    expect(resolveGreeting({ date: at('2026-03-02', 9), availablePoses: ['greet_morning'], lines, rng: () => 0 })?.line).toBe('早安一');
    expect(resolveGreeting({ date: at('2026-03-02', 9), availablePoses: ['greet_morning'], lines, rng: () => 0.5 })?.line).toBe('早安二');
    expect(resolveGreeting({ date: at('2026-03-02', 9), availablePoses: ['greet_morning'], lines, rng: () => 0.99 })?.line).toBe('早安三');
  });
});

describe('首见去重：角色 id + 日期 + 键', () => {
  it('同一天同一键只触发一次；换角色/换键/换日重新触发', () => {
    const userDataDir = tempDir();
    const store = fileGreetingStore(userDataDir);
    expect(claimFirstMeeting(store, 'custom-a', '2026-12-25', 'fest_christmas')).toBe(true);
    expect(claimFirstMeeting(store, 'custom-a', '2026-12-25', 'fest_christmas')).toBe(false);
    expect(claimFirstMeeting(store, 'custom-b', '2026-12-25', 'fest_christmas')).toBe(true);
    expect(claimFirstMeeting(store, 'custom-a', '2026-12-25', 'greet_morning')).toBe(true);
    expect(claimFirstMeeting(store, 'custom-a', '2026-12-26', 'fest_christmas')).toBe(true);
    const raw = JSON.parse(readFileSync(join(userDataDir, 'pet-greetings.json'), 'utf8')) as { seen: Record<string, string> };
    expect(Object.keys(raw.seen)).toHaveLength(4);
  });

  it('坏文件/过期记录被安全忽略', () => {
    const userDataDir = tempDir();
    const path = join(userDataDir, 'pet-greetings.json');
    writeFileSync(path, '{not json', 'utf8');
    expect(readGreetingLog(userDataDir)).toEqual({ seen: {} });
  });

  it('ymd 使用本地日期，不跨时区漂移', () => {
    expect(ymd(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
    expect(ymd(new Date(2026, 11, 31, 23, 55))).toBe('2026-12-31');
  });
});
