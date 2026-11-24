/**
 * 空闲动作场景化过滤器（T-M6-63，纯函数，零 DOM）。
 *
 * 目标：让 aboutme-pets 的「吃早餐/午餐/晚餐、节日时节、余额」动画精准登场，
 * 而不是在随机池里乱播：
 *   - 三餐仅在自己的时段进入空闲池，命中权重 ×3；
 *   - 节日/季节动作只在对应节日或季节保留（权重 ×5），其余一律剔除；
 *   - 余额动作用于赛博饭碗档位反馈，绝不进入日常随机池。
 */
import { festivalsFor, type FestivalKey } from '@workbench/pet-renderer/festivals';

export interface AmbientClipLike {
  clipId: string;
  category?: string;
  weight?: number;
}

export interface WeightedClip<T> {
  clip: T;
  weight: number;
}

interface MealWindow {
  keyword: string;
  startMinute: number;
  endMinute: number;
}

/** 三餐窗口（左闭右开，分钟）；其余时段剔除，避免下午三点吃早餐。 */
export const MEAL_WINDOWS: readonly MealWindow[] = [
  { keyword: '早餐', startMinute: 6 * 60 + 30, endMinute: 9 * 60 + 30 },
  { keyword: '午餐', startMinute: 11 * 60 + 30, endMinute: 13 * 60 + 30 },
  { keyword: '晚餐', startMinute: 17 * 60 + 30, endMinute: 20 * 60 + 30 },
];

/** 节日关键词（按 clipId 子串匹配；一个动作可命中多个）。 */
export const FESTIVAL_CLIP_PATTERNS: Readonly<Record<FestivalKey, RegExp>> = {
  fest_spring: /福字|红包|饺子|舞狮|年糕|烟花/,
  fest_lantern: /汤圆|孔明灯/,
  fest_dragonboat: /粽子/,
  fest_midautumn: /中秋|月饼/,
  fest_newyear: /元旦|新年/,
  fest_halloween: /万圣|南瓜|幽灵/,
  fest_christmas: /圣诞/,
  fest_national: /国庆/,
};

/** 季节关键词（月份区间；不匹配当月即剔除）。 */
const SEASON_RULES: ReadonlyArray<{ pattern: RegExp; months: readonly number[] }> = [
  { pattern: /雪人/, months: [12, 1, 2] },
  { pattern: /落叶/, months: [9, 10, 11] },
];

const BALANCE_CATEGORY = '余额';

export function isBalanceClip(clip: AmbientClipLike): boolean {
  return clip.category === BALANCE_CATEGORY || clip.clipId.startsWith('余额-') || clip.clipId.includes('余额');
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function mealMultiplier(clipId: string, minute: number): number | null {
  for (const window of MEAL_WINDOWS) {
    if (!clipId.includes(window.keyword)) continue;
    return minute >= window.startMinute && minute < window.endMinute ? 3 : null;
  }
  return 1;
}

/**
 * 节日权重判定：
 *   - 数字 = 保留并乘该倍数；
 *   - 'drop' = 命中节日/季节关键词但不是今天 → 剔除；
 *   - null = 与节日/季节无关 → 普通动作。
 */
function festivalMultiplier(clipId: string, today: readonly FestivalKey[], month: number): number | 'drop' | null {
  const matched: FestivalKey[] = [];
  for (const [key, pattern] of Object.entries(FESTIVAL_CLIP_PATTERNS) as Array<[FestivalKey, RegExp]>) {
    if (pattern.test(clipId)) matched.push(key);
  }
  let seasonal = false;
  for (const rule of SEASON_RULES) {
    if (!rule.pattern.test(clipId)) continue;
    seasonal = true;
    if (!rule.months.includes(month)) return 'drop';
  }
  if (matched.length === 0) return seasonal ? 5 : null;
  // 命中当天任一节日 → 保留并 ×5；只命中别的节日 → 剔除
  for (const key of matched) {
    if (today.includes(key)) return 5;
  }
  return 'drop';
}

/**
 * 按日期过滤空闲池：返回保留动作及最终权重（已乘时段/节日倍数）。
 * 非三餐、非节日、非季节的动作原样保留（权重不变）。
 */
export function filterAmbientClips<T extends AmbientClipLike>(
  clips: readonly T[],
  date: Date,
): Array<WeightedClip<T>> {
  const minute = minuteOfDay(date);
  const today = festivalsFor(date);
  const month = date.getMonth() + 1;
  const out: Array<WeightedClip<T>> = [];
  for (const clip of clips) {
    if (isBalanceClip(clip)) continue;
    const baseWeight = clip.weight ?? 10;
    const meal = mealMultiplier(clip.clipId, minute);
    if (meal === null) continue;
    if (meal > 1) {
      out.push({ clip, weight: baseWeight * meal });
      continue;
    }
    const isFestivalCategory = clip.category === '时节';
    const festival = festivalMultiplier(clip.clipId, today, month);
    if (festival === 'drop') continue;
    if (festival === null) {
      // category=时节 但关键词表无法判定的动作同样剔除：宁可少播，也不在非节日乱播
      if (isFestivalCategory) continue;
      out.push({ clip, weight: baseWeight });
      continue;
    }
    out.push({ clip, weight: baseWeight * festival });
  }
  return out;
}

export type RiceLevel = 'starving' | 'hungry' | 'ok' | 'full' | 'fed_buff';

/** 饭碗余额档位 → 6 个余额动画的优先顺序（真实素材名，绝不临时编造）。 */
export const BALANCE_CLIP_BY_LEVEL: Readonly<Record<RiceLevel, readonly string[]>> = {
  fed_buff: ['余额-钱袋满溢', '余额-金袋叮当', '余额-钱袋如常'],
  full: ['余额-金袋叮当', '余额-钱袋满溢', '余额-钱袋如常'],
  ok: ['余额-钱袋如常', '余额-金袋叮当', '余额-数金皱眉'],
  hungry: ['余额-数金皱眉', '余额-袋空如洗', '余额-分文不剩'],
  starving: ['余额-分文不剩', '余额-袋空如洗', '余额-数金皱眉'],
};

/** 档位未知时按剩余比例兜底（与饭碗 5 档阈值一致）。 */
export function riceLevelFromRatio(ratio: number): RiceLevel {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  if (clamped >= 0.8) return 'fed_buff';
  if (clamped >= 0.55) return 'full';
  if (clamped >= 0.3) return 'ok';
  if (clamped >= 0.12) return 'hungry';
  return 'starving';
}

/**
 * 饭碗档位 → 应播放的余额 clipId；找不到返回 null（调用方保持安静，绝不假装播放）。
 * `riceLevel` 传入未知字符串时按 `ratio` 推导，避免 IPC 版本差异导致崩溃。
 */
export function pickBalanceClipId(
  clips: ReadonlyArray<{ clipId: string }>,
  riceLevel: string,
  ratio: number,
): string | null {
  const level = (['starving', 'hungry', 'ok', 'full', 'fed_buff'] as const).includes(riceLevel as RiceLevel)
    ? riceLevel as RiceLevel
    : riceLevelFromRatio(ratio);
  const ids = new Set(clips.map((clip) => clip.clipId));
  for (const candidate of BALANCE_CLIP_BY_LEVEL[level]) {
    if (ids.has(candidate)) return candidate;
  }
  // 素材命名带后缀（如「余额-钱袋满溢 v2」）时允许前缀命中，仍按优先级顺序
  for (const candidate of BALANCE_CLIP_BY_LEVEL[level]) {
    const hit = clips.find((clip) => clip.clipId.startsWith(candidate));
    if (hit !== undefined) return hit.clipId;
  }
  return null;
}
