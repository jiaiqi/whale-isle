/**
 * DeepSeek / GLM 峰谷时段自动换装（T-M6-65，纯函数）。
 *
 * 规则（北京时间 UTC+8）：00:30–08:30 为优惠空闲时段（off-peak），08:30–次日 00:30 为高峰（peak）。
 * 只在跨越时段边界时触发一次换装；同一时段内用户手动换装不会被反复覆盖。
 */
export type PeakPeriod = 'peak' | 'off-peak';

export interface PeakPeriodResolution {
  period: PeakPeriod;
  /** 北京时间当日分钟数 0–1439 */
  minutesOfDay: number;
  /** 距离下一次峰谷切换的分钟数 */
  nextSwitchInMinutes: number;
}

/** 北京时间当日分钟（与运行机器时区无关）。 */
export function beijingMinutesOfDay(date: Date): number {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
}

/** 00:30–08:30 off-peak；其余 peak。 */
export function resolvePeakPeriod(date: Date): PeakPeriodResolution {
  const minutesOfDay = beijingMinutesOfDay(date);
  const offPeakStart = 30;
  const offPeakEnd = 8 * 60 + 30;
  const period: PeakPeriod = minutesOfDay >= offPeakStart && minutesOfDay < offPeakEnd ? 'off-peak' : 'peak';
  const nextSwitchInMinutes = period === 'off-peak'
    ? offPeakEnd - minutesOfDay
    : minutesOfDay < offPeakStart
      ? offPeakStart - minutesOfDay
      : 24 * 60 - minutesOfDay + offPeakStart;
  return { period, minutesOfDay, nextSwitchInMinutes };
}

/** DeepSeek / GLM 家族（crosspet-deepseek*、aboutme-glm、custom 名字含 deepseek 等）。 */
export function isPeakOutfitFamily(characterId: string): boolean {
  return /deepseek|glm/i.test(characterId);
}

export interface PeakOutfitPrefs {
  enabled: boolean;
  peakOutfitDay: string;
  peakOutfitOffPeak: string;
}

export interface PeakOutfitState {
  /** 上次观察到的时段；null=进程首次观察，不立即换装 */
  lastPeriod: PeakPeriod | null;
}

export interface PeakOutfitDecision {
  state: PeakOutfitState;
  /** 本次是否应自动换装 */
  apply: boolean;
  skinId: string | null;
  period: PeakPeriod;
  reason: string;
}

/**
 * 单次决策：跨边界 + 开关开启 + 当前角色属于 DeepSeek/GLM 才换装；否则只更新 lastPeriod。
 * 首次调用（lastPeriod=null）只记录，避免启动时覆盖用户手动皮肤。
 */
export function decidePeakOutfit(
  state: PeakOutfitState,
  date: Date,
  characterId: string,
  prefs: PeakOutfitPrefs,
): PeakOutfitDecision {
  const { period } = resolvePeakPeriod(date);
  const lastPeriod = state.lastPeriod;
  const nextState: PeakOutfitState = { lastPeriod: period };
  if (lastPeriod === null) return { state: nextState, apply: false, skinId: null, period, reason: '首次观察，仅记录时段' };
  if (lastPeriod === period) return { state: nextState, apply: false, skinId: null, period, reason: '同一时段内不覆盖手动换装' };
  if (!prefs.enabled) return { state: nextState, apply: false, skinId: null, period, reason: '峰谷换装开关已关闭' };
  if (!isPeakOutfitFamily(characterId)) return { state: nextState, apply: false, skinId: null, period, reason: '当前角色不属于 DeepSeek/GLM 家族' };
  const skinId = period === 'peak' ? prefs.peakOutfitDay : prefs.peakOutfitOffPeak;
  return {
    state: nextState,
    apply: skinId !== '',
    ...(skinId === '' ? { skinId: null } : { skinId }),
    period,
    reason: period === 'peak' ? '进入高峰时段 → 日常皮肤' : '进入优惠空闲时段 → 睡衣皮肤',
  };
}

/** 24 小时峰谷时间条（UI 用）：返回红色高峰段与绿色空闲段。 */
export const PEAK_SEGMENTS: ReadonlyArray<{ period: PeakPeriod; startMinute: number; endMinute: number; label: string }> = [
  { period: 'peak', startMinute: 0, endMinute: 30, label: '高峰 00:00–00:30' },
  { period: 'off-peak', startMinute: 30, endMinute: 510, label: '优惠空闲 00:30–08:30' },
  { period: 'peak', startMinute: 510, endMinute: 1_440, label: '高峰 08:30–00:30' },
];
