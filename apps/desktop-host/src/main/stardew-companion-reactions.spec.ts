import { describe, expect, it } from 'vitest';
import { createStardewCompanionReactions, characterGameReply } from './stardew-companion-reactions';

describe('stardew companion reactions', () => {
  it('体力/生命/宵禁/满包在同日仅边缘触发一次，恢复或换日后重置', () => {
    let clockMs = 1_000;
    const reactions = createStardewCompanionReactions({ now: () => clockMs });

    const low = reactions.onEvent({
      type: 'state', clock: '第1年春16日 23:35', stamina: 20, staminaMax: 270, money: 500, location: 'Mine', health: 25, healthMax: 100, freeSlots: 0,
    }, { characterId: 'blue-whale-maid', voiceEnabled: true });
    expect(low.map((r) => r.bubble?.text)).toEqual([
      expect.stringContaining('体力只剩'),
      expect.stringContaining('生命值告急'),
      expect.stringContaining('凌晨两点'),
      expect.stringContaining('背包满啦'),
    ]);
    expect(low[1]?.speech).toEqual({ text: expect.stringContaining('生命值告急'), scene: 'p0' });

    // 同日重复状态不刷屏
    const repeat = reactions.onEvent({
      type: 'state', clock: '第1年春16日 23:40', stamina: 18, staminaMax: 270, money: 500, location: 'Mine', health: 20, healthMax: 100, freeSlots: 0,
    }, { characterId: 'blue-whale-maid', voiceEnabled: true });
    expect(repeat).toEqual([]);

    // 换日后重新触发
    const nextDay = reactions.onEvent({
      type: 'state', clock: '第1年春17日 23:35', stamina: 10, staminaMax: 270, money: 500, location: 'Farm', health: 90, healthMax: 100, freeSlots: 5,
    }, { characterId: 'blue-whale-maid', voiceEnabled: false });
    expect(nextDay.some((r) => r.bubble?.text.includes('体力只剩'))).toBe(true);
    expect(nextDay.every((r) => r.speech === undefined)).toBe(true);
  });

  it('里程碑完成、失败/不确定与卡死均遵守冷却与角色口吻', () => {
    let clockMs = 100_000;
    const reactions = createStardewCompanionReactions({ now: () => clockMs, milestoneCooldownMs: 30_000, stuckCooldownMs: 45_000 });

    const harvest = reactions.onEvent({
      type: 'receipt', tool: 'harvest_crops', status: 'COMPLETED', summary: '成功收获 12 棵草莓',
    }, { characterId: 'blue-whale-maid', voiceEnabled: true });
    expect(harvest).toHaveLength(1);
    expect(harvest[0]?.bubble?.mood).toBe('happy');
    expect(harvest[0]?.speech?.text).toContain('丰收');

    // 冷却期内普通完成与失败不再连续弹气泡
    clockMs += 5_000;
    expect(reactions.onEvent({
      type: 'receipt', tool: 'donate_bundles', status: 'COMPLETED', summary: '完成',
    }, { characterId: 'blue-whale-maid', voiceEnabled: true })).toEqual([]);

    // 过冷却期后触发失败气泡与卡死语音
    clockMs += 30_000;
    const fail = reactions.onEvent({
      type: 'receipt', tool: 'explore_mine', status: 'FAILED', summary: '背包里没有武器',
    }, { characterId: 'blue-whale-maid', voiceEnabled: true });
    expect(fail[0]?.bubble?.mood).toBe('angry');
    expect(fail[0]?.speech).toBeUndefined();

    clockMs += 35_000;
    const rawBoxFail = reactions.onEvent({
      type: 'receipt',
      tool: 'travel_to',
      status: 'FAILED',
      summary: '失败：移动被打断：有界面打开了（DialogueBox），请先处理界面。当前界面：\n对话框：你收到了种子',
    }, { characterId: 'blue-whale-maid', voiceEnabled: true });
    expect(rawBoxFail[0]?.bubble?.text).toBe('没做顺：有个弹窗挡住了');
    expect(rawBoxFail[0]?.bubble?.text).not.toContain('DialogueBox');

    const stuck = reactions.onEvent({
      type: 'watchdog', kind: 'stuck', detail: '连续失败 3 次',
    }, { characterId: 'blue-whale-maid', voiceEnabled: true });
    expect(stuck[0]?.bubble?.text).toContain('卡住');
    expect(stuck[0]?.speech?.text).toContain('卡住');
    expect(reactions.onEvent({ type: 'watchdog', kind: 'stuck', detail: 'still stuck' }, { voiceEnabled: true })).toEqual([]);

    // 角色口吻差异 + 回落中性台词
    expect(characterGameReply('aboutme-gpt', 'fish')).toContain('符合预期');
    expect(characterGameReply('unknown-role', 'uncertain')).toBe('这次没成功，我换个办法再来。');
  });

  it('接管交还变化与新学会心得可触发温和反馈', () => {
    let clockMs = 200_000;
    const reactions = createStardewCompanionReactions({ now: () => clockMs });

    expect(reactions.onEvent({
      type: 'human-control', active: false, reason: 'resume', summary: '主人接管了 6 秒：游戏状态没有可见变化。',
    }, { voiceEnabled: true })).toEqual([]);

    const handover = reactions.onEvent({
      type: 'human-control', active: false, reason: 'resume', summary: '主人接管了 20 秒：金币 100→320（+220）。',
    }, { voiceEnabled: true });
    expect(handover[0]?.bubble?.text).toContain('+220');
    expect(handover[0]?.speech?.text).toContain('欢迎回来');

    const learned = reactions.onInsight({ action: 'learned', claim: '下雨天不需要浇水' }, { voiceEnabled: true });
    expect(learned[0]?.bubble?.text).toContain('下雨天不需要浇水');
    expect(reactions.onInsight({ action: 'used', claim: 'ignored' }, { voiceEnabled: true })).toEqual([]);
  });
});
