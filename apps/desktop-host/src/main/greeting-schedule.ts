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
import { festivalsFor, ymd, type FestivalKey } from '@workbench/pet-renderer/festivals';

// T-M6-63：农历表迁到 @workbench/pet-renderer/festivals，主进程与渲染层共用；此处保留原导出面。
export { festivalsFor, ymd, type FestivalKey };

export type GreetingSlot =
  | 'greet_morning'
  | 'greet_noon'
  | 'greet_afternoon'
  | 'greet_evening'
  | 'greet_night'
  | 'greet_dawn';

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
