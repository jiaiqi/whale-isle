import { describe, expect, it } from 'vitest';
import { BWF_OMITTED_MARKER, BWF_SPEND_OMITTED, BwfStateSectionCache } from './state-cache';

const FULL_FRAME = `时间：第1年春1日 06:00（Mon），天气：晴
【花钱建议】目前优先买防风草种子

## 位置
地点：Farm，室外，地图大小 80x65
你站在 (64,15)，面朝南

## 穿戴（背包里有更好的鞋子、戒指会自动换上）
鞋子：无；戒指：无

## 箱子（所有地点）
- Farm (64,13) 宝箱：防风草种子 x5、木材 x20

## 本地出口（travel_to 可以自动走多段路，下面只是本地点的直接出口）
- FarmHouse (64,14)
- Town (79,17)

## 作物（本地点全部）
需要浇水 2 株：(62,18) (63,18)
农田：主田 (62,18)-(66,21) 共20格

## 文字地图（以你为中心）
图例：@你 .可走 #不可走
  15   .@.`;

describe('BwfStateSectionCache（无状态规划器段省略自动水合）', () => {
  it('第 2 轮 BWF Once(...) 省略后自动从缓存恢复箱子、出口、穿戴、农田与图例', () => {
    const cache = new BwfStateSectionCache();
    expect(cache.needsFullWarmup(FULL_FRAME)).toBe(false);
    expect(cache.hydrate(FULL_FRAME)).toContain('- Farm (64,13) 宝箱');

    const omitted = `时间：第1年春1日 06:30（Mon），天气：晴
${BWF_SPEND_OMITTED}

## 位置
地点：Farm，室外，地图大小 80x65
你站在 (65,16)，面朝南

## 穿戴（背包里有更好的鞋子、戒指会自动换上）
（${BWF_OMITTED_MARKER}；要看就 get_state full=true）

## 箱子（所有地点）
（${BWF_OMITTED_MARKER}；要看就 get_state full=true）

## 本地出口（travel_to 可以自动走多段路，下面只是本地点的直接出口）
（${BWF_OMITTED_MARKER}；要看就 get_state full=true）

## 作物（本地点全部）
需要浇水 1 株：(62,18)
（${BWF_OMITTED_MARKER}；要看就 get_state full=true）

## 文字地图（以你为中心）
（${BWF_OMITTED_MARKER}；要看就 get_state full=true）
  16   .@.`;

    expect(cache.needsFullWarmup(omitted)).toBe(false);
    const hydrated = cache.hydrate(omitted);
    expect(hydrated).toContain('【花钱建议】目前优先买防风草种子');
    expect(hydrated).toContain('鞋子：无；戒指：无');
    expect(hydrated).toContain('- Farm (64,13) 宝箱：防风草种子 x5、木材 x20');
    expect(hydrated).toContain('- Town (79,17)');
    expect(hydrated).toContain('农田：主田 (62,18)-(66,21) 共20格');
    expect(hydrated).toContain('图例：@你 .可走 #不可走');
    expect(hydrated).toContain('需要浇水 1 株：(62,18)');
  });

  it('首轮即遇未缓存的省略段时精确触发 needsFullWarmup', () => {
    const cache = new BwfStateSectionCache();
    const coldOmitted = `## 位置\n地点：Town\n\n## 本地出口\n（${BWF_OMITTED_MARKER}）`;
    expect(cache.needsFullWarmup(coldOmitted)).toBe(true);
    cache.hydrate(`## 位置\n地点：Town\n\n## 本地出口\n- Farm (0,54)`);
    expect(cache.needsFullWarmup(coldOmitted)).toBe(false);
    cache.clear();
    expect(cache.needsFullWarmup(coldOmitted)).toBe(true);
  });
});
