/** 季节种子表与季末成熟判断（T-M6-69）：冬季不种、季末不足成熟期不种、买种预算三约束。 */
import { describe, expect, it } from 'vitest';
import {
  canPlantBeforeSeasonEnd,
  DAYS_PER_SEASON,
  daysLeftInSeason,
  findSeedByName,
  MAX_SPEND_RATIO,
  seedBudget,
  seedForSeason,
  seedNameMatches,
  SEED_RESERVE_GOLD,
  SEED_TABLE,
} from './seed-table';

describe('seedForSeason', () => {
  it('春/夏/秋各有当季种子；冬季与未知季节为 null（不种）', () => {
    expect(seedForSeason('春')?.name).toBe('防风草种子');
    expect(seedForSeason('夏')?.name).toBe('辣椒种子');
    expect(seedForSeason('秋')?.name).toBe('小白菜种子');
    expect(seedForSeason('冬')).toBeNull();
    expect(seedForSeason('')).toBeNull();
    expect(seedForSeason('未知')).toBeNull();
  });

  it('表内数值与 RUNBOOK §3.5 初版一致（以游戏内商店为准）', () => {
    expect(SEED_TABLE.map((seed) => [seed.name, seed.price, seed.maturityDays])).toEqual([
      ['防风草种子', 20, 4],
      ['辣椒种子', 40, 5],
      ['小白菜种子', 50, 4],
    ]);
    expect(SEED_TABLE.find((seed) => seed.season === '夏')?.regrow).toBe(true);
  });
});

describe('daysLeftInSeason', () => {
  it('第 1 天剩 28 天、第 28 天剩 1 天（含当天）', () => {
    expect(DAYS_PER_SEASON).toBe(28);
    expect(daysLeftInSeason(1)).toBe(28);
    expect(daysLeftInSeason(28)).toBe(1);
  });

  it('越界与非法输入收敛到 [0, 28]，不产生 NaN', () => {
    expect(daysLeftInSeason(0)).toBe(28); // 钳到第 1 天
    expect(daysLeftInSeason(99)).toBe(1); // 钳到第 28 天
    expect(daysLeftInSeason(Number.NaN)).toBe(0);
  });
});

describe('canPlantBeforeSeasonEnd', () => {
  it('季内剩余天数 ≥ 成熟天数才可种', () => {
    expect(canPlantBeforeSeasonEnd('春', 24)).toBe(true); // 剩 5 天 ≥ 4
    expect(canPlantBeforeSeasonEnd('春', 25)).toBe(true); // 剩 4 天 = 4
    expect(canPlantBeforeSeasonEnd('春', 26)).toBe(false); // 剩 3 天 < 4
    expect(canPlantBeforeSeasonEnd('夏', 24)).toBe(true); // 夏种子 5 天，剩 5
    expect(canPlantBeforeSeasonEnd('夏', 25)).toBe(false); // 剩 4 < 5
  });

  it('冬季一律不种；季节不匹配的种子也不种', () => {
    expect(canPlantBeforeSeasonEnd('冬', 1)).toBe(false);
    const summer = seedForSeason('夏');
    expect(summer).not.toBeNull();
    if (summer !== null) expect(canPlantBeforeSeasonEnd('春', 1, summer)).toBe(false);
    expect(canPlantBeforeSeasonEnd('春', 1, null)).toBe(false);
  });
});

describe('seedBudget', () => {
  it('同时受空地数、保留 100g、单次 ≤ 60% 约束', () => {
    expect(SEED_RESERVE_GOLD).toBe(100);
    expect(MAX_SPEND_RATIO).toBe(0.6);
    // 640g、20g/颗、24 空地：60% 上限 384g → 19 颗；保留 100g 上限 540g → 27 颗；取小 19
    expect(seedBudget(640, 20, 24)).toBe(19);
    // 空地更少时以空地为上限
    expect(seedBudget(640, 20, 3)).toBe(3);
    // 夏种子 40g：60% = 384 → 9 颗
    expect(seedBudget(640, 40, 60)).toBe(9);
  });

  it('钱不够（必须留 100g）→ 0；非法输入 → 0', () => {
    expect(seedBudget(119, 20, 10)).toBe(0);
    expect(seedBudget(120, 20, 10)).toBe(1); // 120-100=20 → 1 颗，60% 也够
    expect(seedBudget(640, 0, 10)).toBe(0);
    expect(seedBudget(640, 20, 0)).toBe(0);
    expect(seedBudget(Number.NaN, 20, 10)).toBe(0);
    expect(seedBudget(640, Number.NaN, 10)).toBe(0);
    expect(seedBudget(640, 20, Number.NaN)).toBe(0);
    expect(seedBudget(-5, 20, 10)).toBe(0);
  });
});

describe('seedNameMatches / findSeedByName', () => {
  it('中文全名、英文别名（大小写不敏感）、带数量文本都能命中', () => {
    const parsnip = seedForSeason('春');
    expect(parsnip).not.toBeNull();
    if (parsnip === null) return;
    expect(seedNameMatches(parsnip, '防风草种子 x15')).toBe(true);
    expect(seedNameMatches(parsnip, 'Parsnip Seeds')).toBe(true);
    expect(seedNameMatches(parsnip, 'parsnipseeds')).toBe(true);
    expect(seedNameMatches(parsnip, '木材 x22')).toBe(false);
  });

  it('从背包文本反查种子；不是表内种子返回 null', () => {
    expect(findSeedByName('防风草种子 x15')?.season).toBe('春');
    expect(findSeedByName('Hot Pepper Seeds')?.season).toBe('夏');
    expect(findSeedByName('小白菜种子')?.season).toBe('秋');
    expect(findSeedByName('木材 x22')).toBeNull();
    expect(findSeedByName('')).toBeNull();
  });
});
