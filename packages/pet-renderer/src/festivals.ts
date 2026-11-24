/**
 * 内置农历节日表 2025–2035（T-M6-63 从主进程 greeting-schedule 抽到共享包）。
 *
 * 主进程首见问候与渲染层 ambient 空闲池共用这份唯一事实源，避免两套农历表漂移；
 * 零外部依赖、零网络：只覆盖 2025–2035 的春节/端午/中秋三天，其余公历节日按日期窗口判断。
 */
export type FestivalKey =
  | 'fest_newyear'
  | 'fest_halloween'
  | 'fest_christmas'
  | 'fest_national'
  | 'fest_spring'
  | 'fest_lantern'
  | 'fest_dragonboat'
  | 'fest_midautumn';

/**
 * cny=春节初一；lantern 固定初一后 14 天；dragonboat=五月初五；midautumn=八月十五。
 * 已由 T-M6-55 的 greeting-schedule 单测锁定边界（初七命中、初八不命中）。
 */
export const LUNAR_TABLE: Readonly<Record<number, { cny: string; dragonboat: string; midautumn: string }>> = {
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
