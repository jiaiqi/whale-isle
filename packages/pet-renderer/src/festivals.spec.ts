/** 共享农历/公历节日表（T-M6-63）：2025–2035 边界、跨年与未知年份安全。 */
import { describe, expect, it } from 'vitest';
import { festivalsFor, ymd } from './festivals';

const at = (iso: string, hour = 9): Date => new Date(`${iso}T${`${hour}`.padStart(2, '0')}:00:00`);

describe('ymd', () => {
  it('使用本地日期，不因 UTC 偏移跨日', () => {
    expect(ymd(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
    expect(ymd(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });
});

describe('festivalsFor：公历节日', () => {
  it('元旦/万圣/圣诞两天/国庆七天', () => {
    expect(festivalsFor(at('2026-01-01'))).toContain('fest_newyear');
    expect(festivalsFor(at('2026-10-31'))).toContain('fest_halloween');
    expect(festivalsFor(at('2026-12-24'))).toContain('fest_christmas');
    expect(festivalsFor(at('2026-12-25'))).toContain('fest_christmas');
    expect(festivalsFor(at('2026-12-26'))).not.toContain('fest_christmas');
    expect(festivalsFor(at('2026-10-01'))).toContain('fest_national');
    expect(festivalsFor(at('2026-10-07'))).toContain('fest_national');
    expect(festivalsFor(at('2026-10-08'))).not.toContain('fest_national');
  });
});

describe('festivalsFor：农历节日 2025–2035', () => {
  it.each([
    [2025, '2025-01-29', '2025-05-31', '2025-10-06'],
    [2026, '2026-02-17', '2026-06-19', '2026-09-25'],
    [2027, '2027-02-06', '2027-06-09', '2027-09-15'],
    [2028, '2028-01-26', '2028-05-28', '2028-10-03'],
    [2029, '2029-02-13', '2029-06-16', '2029-09-22'],
    [2030, '2030-02-03', '2030-06-05', '2030-09-12'],
    [2031, '2031-01-23', '2031-06-24', '2031-10-01'],
    [2032, '2032-02-11', '2032-06-12', '2032-09-19'],
    [2033, '2033-01-31', '2033-06-01', '2033-09-08'],
    [2034, '2034-02-19', '2034-06-20', '2034-09-27'],
    [2035, '2035-02-08', '2035-06-10', '2035-09-16'],
  ])('%i 年春节/端午/中秋命中', (_year, cny, dragonboat, midautumn) => {
    expect(festivalsFor(at(cny))).toContain('fest_spring');
    expect(festivalsFor(at(dragonboat))).toContain('fest_dragonboat');
    expect(festivalsFor(at(midautumn))).toContain('fest_midautumn');
  });

  it('春节初七命中、初八不命中；元宵为初一后第 14 天', () => {
    expect(festivalsFor(at('2026-02-23'))).toContain('fest_spring');
    expect(festivalsFor(at('2026-02-24'))).not.toContain('fest_spring');
    expect(festivalsFor(at('2026-03-03'))).toContain('fest_lantern');
  });

  it('表外年份（2040）不抛错，只保留公历节日', () => {
    expect(festivalsFor(at('2040-01-01'))).toEqual(['fest_newyear']);
    expect(festivalsFor(at('2040-02-12'))).toEqual([]);
  });
});
