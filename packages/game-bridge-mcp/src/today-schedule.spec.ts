import { describe, expect, it } from 'vitest';
import {
  buildTodayScheduleFacts,
  isSeasonEndDay,
  parseActionableQuests,
  parseTodayBirthday,
  parseTodayFestival,
} from './today-schedule';

const RAW = `时间：第1年夏28日 06:00（Sun），天气：晴，明天天气：晴
金钱：771g  体力：263/270  生命：120/120  今日运气：+0.09
今日：生日 无；节日 月光水母之舞（Beach，22:00-00:00(次日)）
农场类型：标准农场

## 任务
- 养殖动物：建造一个鸡舍。
- 乔迪的请求：带给乔迪一株花椰菜。。怎么交：带着花椰菜用 give_gift npc=Jodi 交给乔迪（会先算交任务，不算送礼）
- 镇长的"短裤"：找到并交还镇长刘易斯的紫色短裤。。怎么交：先 travel_to AnimalShop，到了 interact x=13 y=7 捡起来
- 深入地底？：抵达矿场地底。`;

describe('今日安排事实（V2-P4-01）', () => {
  it('解析今日节日名称、地点与时间窗', () => {
    const festival = parseTodayFestival(RAW);
    expect(festival).not.toBeNull();
    expect(festival?.name).toBe('月光水母之舞');
    expect(festival?.location).toBe('Beach');
    expect(festival?.window).toBe('22:00-00:00(次日)');
  });

  it('无节日与无生日时返回空', () => {
    expect(parseTodayFestival('今日：生日 无；节日 无')).toBeNull();
    expect(parseTodayBirthday('今日：生日 无；节日 无')).toBeNull();
    expect(parseTodayBirthday('今日：生日 潘姆；节日 无')).toBe('潘姆');
  });

  it('只挑带交付方式的任务，纯目标类不混入', () => {
    const quests = parseActionableQuests(RAW);
    expect(quests).toHaveLength(2);
    // 游戏原文的目标行含描述，标题保留原文更利于模型判断
    expect(quests[0]?.title).toContain('乔迪的请求');
    expect(quests[0]?.how).toContain('give_gift');
    expect(quests[1]?.title).toContain('镇长的');
    expect(quests.map((q) => q.title)).not.toContain('养殖动物');
    expect(quests.map((q) => q.title)).not.toContain('深入地底？');
  });

  it('事实段落包含节日、任务、季末与天气，且无事实时不塞空段', () => {
    const facts = buildTodayScheduleFacts({ raw: RAW, season: '夏', day: 28, weather: '晴' });
    expect(facts).toContain('今日节日：月光水母之舞');
    expect(facts).toContain('22:00-00:00(次日)');
    expect(facts).toContain('乔迪的请求');
    expect(facts).toContain('夏季最后一天');
    expect(facts).toContain('今日天气：晴');

    const none = buildTodayScheduleFacts({
      raw: '今日：生日 无；节日 无', season: '春', day: 3, weather: '',
    });
    expect(none).toBe('');
  });

  it('季末判定为每月 28 日及以后', () => {
    expect(isSeasonEndDay('夏', 27)).toBe(false);
    expect(isSeasonEndDay('夏', 28)).toBe(true);
    expect(isSeasonEndDay('秋', 28)).toBe(true);
  });
});
