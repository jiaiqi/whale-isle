/**
 * 时段 / 节日首见登场（T-M6-55）。
 *
 * CrossPet `character.json.lines` 支持 6 个时段键（greet_*）与 8 个节日键（fest_*）。
 * 本模块只做确定性判断，零网络依赖：
 *   - 6 时段按本地小时切分；
 *   - 8 节日含公历（元旦/万圣/圣诞/国庆）与农历（春节初一到初七/元宵/端午/中秋），
 *     农历使用内置 2025–2035 表（不引第三方历法库、不联网）；
 *   - 首见按「角色 id + 日期 + 键」持久化去重，节日姿态优先于时段姿态，
 *     缺图时返回 null 由调用方回退原有每日问候。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type GreetingSlot =
  | 'greet_morning'
  | 'greet_noon'
  | 'greet_afternoon'
  | 'greet_evening'
  | 'greet_night'
  | 'greet_dawn';

export type FestivalKey =
  | 'fest_newyear'
  | 'fest_halloween'
  | 'fest_christmas'
  | 'fest_national'
  | 'fest_spring'
  | 'fest_lantern'
  | 'fest_dragonboat'
  | 'fest_midautumn';

/** 6 时段（左闭右开；night 跨午夜 23:00–02:00）。 */
export const TIME_SLOTS: ReadonlyArray<{ key: GreetingSlot; startHour: number; endHour: number; label: string }> = [
  { key: 'greet_morning', startHour: 5, endHour: 11, label: '早晨' },
  { key: 'greet_noon', startHour: 11, endHour: 14, label: '中午' },
  { key: 'greet_afternoon', startHour: 14, endHour: 18, label: '下午' },
  { key: 'greet_evening', startHour: 18, endHour: 23, label: '傍晚' },
  { key: 'greet_night', startHour: 23, endHour: 2, label: '深夜' },
  { key: 'greet_dawn', startHour: 2, endHour: 5, label: '凌晨' },
];

export function timeSlotFor(hour: number): GreetingSlot {
  const normalized = Number.isFinite(hour) ? Math.floor(hour) : 0;
  if (normalized >= 23 || normalized < 2) return 'greet_night';
  if (normalized < 5) return 'greet_dawn';
  if (normalized < 11) return 'greet_morning';
  if (normalized < 14) return 'greet_noon';
  if (normalized < 18) return 'greet_afternoon';
  return 'greet_evening';
}

/**
 * 内置农历节日表 2025–2035（零外部依赖）。
 * cny=春节初一；lantern 固定初一后 14 天；dragonboat=五月初五；midautumn=八月十五。
 */
const LUNAR_TABLE: Readonly<Record<number, { cny: string; dragonboat: string; midautumn: string }>> = {
  2025: { cny: '2025-01-29', dragonboat: '2025-05-31', midautumn: '2025-10-06' },
  2026: { cny: '2026-02-17', dragonboat: '2026-06-19', midautumn: '2026-09-25' },
  2027: { cny: '2027-02-06', dragonboat: '2027-06-09', midautumn: '2027-09-15' },
  2028: { cny: '2028-01-26', dragonboat: '2028-05-28', midautumn: '2028-10-03' },
  2029: { cny: '2029-02-13', dragonboat: '2029-06-16', midautumn: '2029-09-22' },
  2030: { cny: '2030-02-03', dragonboat: '2030-06-05', midautumn: '2030-09-12' },
  2031: { cny: '2031-01-23', dragonboat: '2031-06-24', midautumn: '2031-10-01' },
  2032: { cny: '2032-02-11', dragonboat: '2032-06-12', midautumn: '2032-09-19' },
  2033: { cny: '2033-01-31', dragonboat: '2033-06-01', midautumn: '2033-09-08' },
  2034: { cny: '2034-02-19', dragonboat: '2034-06-20', midautumn: '2034-09-27' },
  2035: { cny: '2035-02-08', dragonboat: '2035-06-10', midautumn: '2035-09-16' },
};

/** 本地日期 → `YYYY-MM-DD`（不用 toISOString，避免时区漂移）。 */
export function ymd(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function utcDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
}

function addDays(iso: string, days: number): string {
  const date = utcDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 当天命中的节日（可能多个，如国庆与中秋重合）；顺序为「更具体 → 更宽泛」。 */
export function festivalsFor(date: Date): FestivalKey[] {
  const day = ymd(date);
  const monthDay = day.slice(5);
  const found: FestivalKey[] = [];
  const lunar = LUNAR_TABLE[date.getFullYear()];
  if (lunar !== undefined) {
    const springIndex = [0, 1, 2, 3, 4, 5, 6].findIndex((offset) => addDays(lunar.cny, offset) === day);
    if (springIndex >= 0) found.push('fest_spring');
    if (addDays(lunar.cny, 14) === day) found.push('fest_lantern');
    if (lunar.dragonboat === day) found.push('fest_dragonboat');
    if (lunar.midautumn === day) found.push('fest_midautumn');
  }
  if (monthDay === '01-01') found.push('fest_newyear');
  if (monthDay === '10-31') found.push('fest_halloween');
  if (monthDay === '12-24' || monthDay === '12-25') found.push('fest_christmas');
  if (day >= `${date.getFullYear()}-10-01` && day <= `${date.getFullYear()}-10-07`) found.push('fest_national');
  return found;
}

/** 首见候选顺序：今天的节日（多个依次）→ 当前时段。 */
export function greetingKeysFor(date: Date): Array<FestivalKey | GreetingSlot> {
  return [...festivalsFor(date), timeSlotFor(date.getHours())];
}

export interface GreetingResolution {
  key: FestivalKey | GreetingSlot;
  pose: string;
  /** lines 里该键的第一句；缺台词为空串（仍然播图，绝不编造台词） */
  line: string;
}

/**
 * 解析本次首见：只要「键同名姿态图」存在就播放；缺图返回 null（调用方回退每日问候）。
 */
export function resolveGreeting(input: {
  date: Date;
  availablePoses: readonly string[];
  lines: Readonly<Record<string, readonly string[]>>;
  rng?: () => number;
}): GreetingResolution | null {
  const poses = new Set(input.availablePoses);
  const pick = input.rng ?? Math.random;
  for (const key of greetingKeysFor(input.date)) {
    if (!poses.has(key)) continue;
    const pool = input.lines[key] ?? [];
    const index = pool.length <= 1 ? 0 : Math.min(pool.length - 1, Math.max(0, Math.floor(pick() * pool.length)));
    return { key, pose: key, line: pool[index] ?? '' };
  }
  return null;
}

// ───────────────────────── 首见去重（角色 id + 日期 + 键） ─────────────────────────

export interface GreetingLog {
  /** `${characterId}:${YYYY-MM-DD}:${key}` → 首次触发 ISO 时间 */
  seen: Record<string, string>;
}

const LOG_FILE = 'pet-greetings.json';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function greetingLogPath(userDataDir: string): string {
  return join(userDataDir, LOG_FILE);
}

export function greetingLogKey(characterId: string, day: string, key: string): string {
  return `${characterId}:${day}:${key}`;
}

export function readGreetingLog(userDataDir: string): GreetingLog {
  try {
    const path = greetingLogPath(userDataDir);
    if (!existsSync(path)) return { seen: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { seen?: unknown };
    if (typeof parsed.seen !== 'object' || parsed.seen === null) return { seen: {} };
    const now = Date.now();
    const seen: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.seen)) {
      if (typeof value !== 'string') continue;
      const at = Date.parse(value);
      if (Number.isNaN(at) || now - at > MAX_AGE_MS) continue;
      seen[key] = value;
    }
    return { seen };
  } catch {
    return { seen: {} };
  }
}

export function writeGreetingLog(userDataDir: string, log: GreetingLog): void {
  const path = greetingLogPath(userDataDir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/**
 * 首见判定 + 落盘（原子）：已见过返回 false；首次返回 true 并记录。
 * store 可注入（单测零宿主）。
 */
export function claimFirstMeeting(
  store: { read: () => GreetingLog; write: (log: GreetingLog) => void },
  characterId: string,
  day: string,
  key: string,
  now: Date = new Date(),
): boolean {
  const log = store.read();
  const id = greetingLogKey(characterId, day, key);
  if (log.seen[id] !== undefined) return false;
  log.seen[id] = now.toISOString();
  store.write(log);
  return true;
}

/** 默认文件存储（userData/pet-greetings.json）。 */
export function fileGreetingStore(userDataDir: string): { read: () => GreetingLog; write: (log: GreetingLog) => void } {
  return {
    read: () => readGreetingLog(userDataDir),
    write: (log) => writeGreetingLog(userDataDir, log),
  };
}
