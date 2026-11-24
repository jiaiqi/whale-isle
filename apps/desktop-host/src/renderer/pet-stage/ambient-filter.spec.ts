/** 空闲动作场景过滤器（T-M6-63）：三餐时段、节日/季节提权与剔除、余额映射与隔离。 */
import { describe, expect, it } from 'vitest';
import { filterAmbientClips, pickBalanceClipId, riceLevelFromRatio, BALANCE_CLIP_BY_LEVEL } from './ambient-filter';

const clip = (clipId: string, category = '小动作', weight = 10) => ({ clipId, category, weight });

describe('filterAmbientClips：三餐时段', () => {
  const breakfast = clip('吃早餐', '吃什么');
  const lunch = clip('吃午餐', '吃什么');
  const dinner = clip('吃晚餐', '吃什么');

  it('早餐只在 06:30–09:30 进入空闲池并 ×3', () => {
    expect(filterAmbientClips([breakfast], new Date(2026, 2, 2, 6, 29))).toEqual([]);
    expect(filterAmbientClips([breakfast], new Date(2026, 2, 2, 6, 30))).toEqual([{ clip: breakfast, weight: 30 }]);
    expect(filterAmbientClips([breakfast], new Date(2026, 2, 2, 9, 29))).toEqual([{ clip: breakfast, weight: 30 }]);
    expect(filterAmbientClips([breakfast], new Date(2026, 2, 2, 9, 30))).toEqual([]);
  });

  it('午餐 11:30–13:30、晚餐 17:30–20:30，其余时段剔除', () => {
    expect(filterAmbientClips([lunch], new Date(2026, 2, 2, 11, 30))).toHaveLength(1);
    expect(filterAmbientClips([lunch], new Date(2026, 2, 2, 13, 30))).toEqual([]);
    expect(filterAmbientClips([dinner], new Date(2026, 2, 2, 17, 30))).toHaveLength(1);
    expect(filterAmbientClips([dinner], new Date(2026, 2, 2, 20, 30))).toEqual([]);
    expect(filterAmbientClips([dinner], new Date(2026, 2, 2, 12, 0))).toEqual([]);
  });

  it('非三餐普通动作原样保留（权重不变）', () => {
    const dance = clip('优雅女仆舞', '玩耍', 10);
    expect(filterAmbientClips([dance], new Date(2026, 2, 2, 12, 0))).toEqual([{ clip: dance, weight: 10 }]);
  });
});

describe('filterAmbientClips：节日与季节', () => {
  it('春节当天饺子/红包 ×5；中秋动作在春节被剔除', () => {
    const spring = new Date(2026, 1, 17, 10, 0);
    const dumpling = clip('包饺子', '时节');
    const moon = clip('中秋赏月吃月饼', '时节');
    expect(filterAmbientClips([dumpling], spring)).toEqual([{ clip: dumpling, weight: 50 }]);
    expect(filterAmbientClips([moon], spring)).toEqual([]);
  });

  it('中秋当天月饼 ×5，春节动作剔除；元宵/端午/万圣/圣诞/国庆各自命中', () => {
    const midautumn = new Date(2026, 8, 25, 20, 0);
    expect(filterAmbientClips([clip('中秋赏月吃月饼', '时节')], midautumn)).toEqual([{ clip: expect.objectContaining({ clipId: '中秋赏月吃月饼' }), weight: 50 }]);
    expect(filterAmbientClips([clip('包饺子', '时节')], midautumn)).toEqual([]);
    expect(filterAmbientClips([clip('吃汤圆', '吃喝')], new Date(2026, 2, 3, 9, 0))).toEqual([{ clip: expect.objectContaining({ clipId: '吃汤圆' }), weight: 50 }]);
    expect(filterAmbientClips([clip('包粽子', '时节')], new Date(2026, 5, 19, 9, 0))).toHaveLength(1);
    expect(filterAmbientClips([clip('南瓜灯', '时节')], new Date(2026, 9, 31, 9, 0))).toHaveLength(1);
    expect(filterAmbientClips([clip('圣诞树', '时节')], new Date(2026, 11, 25, 9, 0))).toHaveLength(1);
    expect(filterAmbientClips([clip('国庆出游', '时节')], new Date(2026, 9, 3, 9, 0))).toHaveLength(1);
  });

  it('冬季雪人只在 12–2 月保留；秋季落叶只在 9–11 月保留；未知时节动作平时剔除', () => {
    expect(filterAmbientClips([clip('堆雪人', '小动作')], new Date(2026, 0, 10, 9, 0))).toHaveLength(1);
    expect(filterAmbientClips([clip('堆雪人', '小动作')], new Date(2026, 6, 10, 9, 0))).toEqual([]);
    expect(filterAmbientClips([clip('扫落叶', '小动作')], new Date(2026, 9, 10, 9, 0))).toHaveLength(1);
    expect(filterAmbientClips([clip('扫落叶', '小动作')], new Date(2026, 4, 10, 9, 0))).toEqual([]);
    expect(filterAmbientClips([clip('春游', '时节')], new Date(2026, 3, 1, 9, 0))).toEqual([]);
  });
});

describe('filterAmbientClips：余额隔离', () => {
  it('余额分类与「余额-」命名一律不进入日常空闲池', () => {
    const pool = [clip('余额-钱袋满溢', '余额'), clip('余额-分文不剩', '小动作'), clip('优雅女仆舞', '玩耍')];
    const out = filterAmbientClips(pool, new Date(2026, 2, 2, 12, 0));
    expect(out.map((entry) => entry.clip.clipId)).toEqual(['优雅女仆舞']);
  });
});

describe('pickBalanceClipId：6 档余额动画映射', () => {
  const all = [
    '余额-钱袋满溢', '余额-金袋叮当', '余额-钱袋如常',
    '余额-数金皱眉', '余额-袋空如洗', '余额-分文不剩',
  ].map((clipId) => ({ clipId }));

  it.each([
    ['fed_buff', '余额-钱袋满溢'],
    ['full', '余额-金袋叮当'],
    ['ok', '余额-钱袋如常'],
    ['hungry', '余额-数金皱眉'],
    ['starving', '余额-分文不剩'],
  ] as const)('%s → %s', (level, expected) => {
    expect(pickBalanceClipId(all, level, 0.5)).toBe(expected);
  });

  it('优先级首选缺失时按顺序回退；没有任何余额素材返回 null', () => {
    expect(pickBalanceClipId([{ clipId: '余额-袋空如洗' }, { clipId: '余额-分文不剩' }], 'hungry', 0.2)).toBe('余额-袋空如洗');
    expect(pickBalanceClipId([{ clipId: '奔跑' }], 'hungry', 0.2)).toBeNull();
    expect(pickBalanceClipId([{ clipId: '余额-钱袋满溢 v2' }], 'fed_buff', 0.9)).toBe('余额-钱袋满溢 v2');
  });

  it('未知档位按比例兜底；BALANCE_CLIP_BY_LEVEL 覆盖 5 档 × 6 种素材', () => {
    expect(pickBalanceClipId(all, 'weird', 0.9)).toBe('余额-钱袋满溢');
    expect(pickBalanceClipId(all, 'weird', 0.05)).toBe('余额-分文不剩');
    expect(new Set(Object.values(BALANCE_CLIP_BY_LEVEL).flat()).size).toBe(6);
    expect(riceLevelFromRatio(Number.NaN)).toBe('starving');
  });
});
