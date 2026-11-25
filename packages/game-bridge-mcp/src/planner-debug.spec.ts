/**
 * T-M6-67：RulePlanner / LlmPlanner 的只读 debugSnapshot()（soak:real 卡死现场包用）。
 */
import { describe, expect, it } from 'vitest';
import { LlmPlanner } from './llm-planner';
import { RulePlanner } from './planner';

function makeLlmPlanner(): LlmPlanner {
  return new LlmPlanner({
    chat: async () => ({ content: '{"tool":"wait","args":{},"intent":"等一下"}' }),
    slot: 'STARDEW_GAME_PLANNER',
  });
}

describe('RulePlanner.debugSnapshot', () => {
  it('未运行时给出空冷却表与默认阶段', () => {
    const snapshot = new RulePlanner().debugSnapshot();
    expect(snapshot).toMatchObject({
      planner: 'rule-schedule',
      phase: 'farm-work',
      objective: null,
      avoidTools: [],
      failStreak: {},
      rescueTried: [],
      lastRescueFail: '',
      lastFreeSlots: null,
      furniturePlaceTried: false,
    });
  });

  it('失败回执后冷却表与救援阶梯可读', () => {
    const planner = new RulePlanner();
    planner.observeReceipt('fish', 'FAILED', '背包里没有鱼竿');
    planner.observeReceipt('tidy_backpack', 'FAILED', '这里没有箱子');
    const snapshot = planner.debugSnapshot();
    expect(snapshot['avoidTools']).toEqual(['fish', 'tidy_backpack']);
    expect(snapshot['failStreak']).toEqual({ fish: 1, tidy_backpack: 1 });
    expect(snapshot['rescueTried']).toEqual(['tidy_backpack']);
    expect(String(snapshot['lastRescueFail'])).toContain('tidy_backpack:FAILED');
  });

  it('快照只读：连续两次调用结果一致，不改变规划器行为', async () => {
    const planner = new RulePlanner();
    const first = JSON.stringify(planner.debugSnapshot());
    const second = JSON.stringify(planner.debugSnapshot());
    expect(first).toBe(second);
    const decision = await planner.decide({
      raw: '## 基本状态\n时间：第1年春16日 07:00\n## 当前界面\n无（可以自由行动）',
      gameClock: '第1年春16日 07:00',
      clockMinutes: 7 * 60,
      stamina: 270,
      staminaMax: 270,
      money: 100,
      location: 'Farm',
      menu: '',
      season: '春',
      day: 16,
      freeSlots: 5,
      posX: 1,
      posY: 1,
      weather: '晴',
      health: 100,
      healthMax: 100,
      birthday: null,
      festival: null,
    });
    expect(['act', 'wait', 'stop']).toContain(decision.kind);
  });
});

describe('LlmPlanner.debugSnapshot', () => {
  it('带 objective、槽位与规则兜底快照', () => {
    const planner = makeLlmPlanner();
    planner.setObjective('去海滩钓鱼');
    planner.observeReceipt('fish', 'FAILED', '背包里没有鱼竿');
    const snapshot = planner.debugSnapshot();
    expect(snapshot['planner']).toBe('llm-xiaojing');
    expect(snapshot['slot']).toBe('STARDEW_GAME_PLANNER');
    expect(snapshot['objective']).toBe('去海滩钓鱼');
    expect(snapshot['cooledTools']).toEqual([]);
    expect(snapshot['dayFails']).toEqual({});
    expect(snapshot['rejected']).toEqual({ ship: [], eat: [], trash: [], place: [] });
    expect(snapshot['fallback']).toMatchObject({ planner: 'rule-schedule', avoidTools: ['fish'] });
  });

  it('没有槽位时 slot 为 null；目标清空后 objective 为 null', () => {
    const planner = new LlmPlanner({ chat: async () => ({ content: '{}' }) });
    expect(planner.debugSnapshot()['slot']).toBeNull();
    planner.setObjective('买鱼竿');
    expect(planner.debugSnapshot()['objective']).toBe('买鱼竿');
    planner.setObjective(null);
    expect(planner.debugSnapshot()['objective']).toBeNull();
  });
});
