/** 桌宠控制宿主（T-M6-51）：召唤复用、夜间睡衣、驱动口 state/say/action 的定向投递。 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { createPetControlHost, matchPetViewForCharacter } from './pet-control-host';

interface Sent { agentId: string; channel: string; payload: Record<string, unknown> }

function makeHost(customEggs: Array<{ id: string; displayName: string }> = []) {
  const sent: Sent[] = [];
  const closed: string[] = [];
  const opened: Array<{ agentId: string; characterId: string }> = [];
  const windows = new Map<string, { agentId: string; characterId: string; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }>();
  const manager = {
    list: () => [...windows.values()],
    get: (agentId: string) => windows.get(agentId) ?? null,
    sendAgent: (agentId: string, channel: string, payload: Record<string, unknown> = {}) => { sent.push({ agentId, channel, payload }); },
    open: async (agentId: string, characterId: string) => {
      opened.push({ agentId, characterId });
      windows.set(agentId, { agentId, characterId, visible: true, bounds: { x: 0, y: 0, width: 400, height: 284 } });
      return { ok: true };
    },
    assemble: vi.fn(),
    close: (agentId: string) => { closed.push(agentId); windows.delete(agentId); return true; },
    dismissAll: () => 0,
  };
  const characters = [
    { id: 'crosspet-claude', displayName: 'Claude', voiceId: 'Arrogant_Miss', voiceRatePercent: 100, voicePitchMul: 1.1 },
    { id: 'crosspet-deepseek', displayName: 'DeepSeek', voiceId: 'qiaopi_mengmei', voiceRatePercent: 100, voicePitchMul: 1.2 },
    { id: 'crosspet-deepseek-pajamas', displayName: 'DeepSeek 睡衣', voiceId: 'qiaopi_mengmei', voiceRatePercent: 100, voicePitchMul: 1.2 },
  ];
  const voices: Array<{ text: string; characterId?: string; voiceId?: string }> = [];
  const asleep = new Set<string>();
  const host = createPetControlHost({
    manager: () => manager as never,
    characters: () => ({ list: () => characters, selected: () => characters[0], manifestOf: () => ({ ok: false, error: 'x' }) }) as never,
    crossPetCharacters: () => characters as never,
    customEggs: () => customEggs as never,
    getPrefs: () => ({ characterId: 'crosspet-claude' }) as never,
    switchDefaultCharacter: () => undefined,
    voice: () => ({ speak: (voice: { text: string; characterId?: string; voiceId?: string }) => { voices.push(voice); return { ok: true }; } }) as never,
    voiceBindings: () => ({ resolve: (id: string) => (id === 'crosspet-claude' ? 'Arwen' : undefined) }) as never,
    asleepAgents: asleep,
    openNotebook: () => undefined,
  });
  return { host, sent, opened, closed, voices, asleep };
}

afterEach(() => { vi.useRealTimers(); });

describe('pet-control-host', () => {
  it('召唤已存在角色只聚焦（channel 正确）；新角色开窗后集合', async () => {
    const { host, sent, opened } = makeHost();
    await host.summonPet('crosspet-claude');
    const first = opened[0]!;
    const again = await host.summonPet('crosspet-claude');
    expect(again).toEqual({ ok: true, agentId: first.agentId });
    expect(sent.at(-1)).toMatchObject({ agentId: first.agentId, channel: 'pet:summoned' });
    expect(opened).toHaveLength(1);
  });

  it('夜间 22:00–07:00 自动解析睡衣皮肤', () => {
    const { host } = makeHost();
    expect(host.nightOutfit('crosspet-deepseek', 23)).toBe('crosspet-deepseek-pajamas');
    expect(host.nightOutfit('crosspet-deepseek', 12)).toBe('crosspet-deepseek');
    expect(host.nightOutfit('crosspet-claude', 23)).toBe('crosspet-claude');
  });

  it('state 反映睡眠态；say 睡眠拒收、wake=true 叫醒并定向发 say；action 到点回 idle', async () => {
    vi.useFakeTimers();
    const { host, sent, voices, asleep, opened } = makeHost();
    await host.summonPet('crosspet-claude');
    const agentId = opened[0]!.agentId;
    asleep.add(agentId);
    expect(host.petControlApi.state(agentId)).toMatchObject({ sleeping: true, characterId: 'crosspet-claude' });
    expect(host.petControlApi.say(agentId, '醒醒', { scene: 'normal', wake: false })).toMatchObject({ ok: false });
    expect(sent.some((item) => item.channel === 'pet:say')).toBe(false);

    expect(host.petControlApi.say(agentId, '巡检完成', { scene: 'normal', wake: true })).toEqual({ ok: true });
    expect(asleep.has(agentId)).toBe(false);
    expect(sent.some((item) => item.agentId === agentId && item.channel === 'pet:wake')).toBe(true);
    expect(sent.at(-1)).toMatchObject({ agentId, channel: 'pet:say', payload: { text: '巡检完成' } });
    // 音色覆盖优先于角色默认
    expect(voices.at(-1)).toMatchObject({ characterId: 'crosspet-claude', voiceId: 'Arwen' });

    expect(host.petControlApi.action(agentId, 'happy_maid', 1_000)).toEqual({ ok: true });
    expect(sent.at(-1)).toMatchObject({ agentId, channel: 'pet:preview', payload: { action: 'happy_maid', clipId: null } });
    vi.advanceTimersByTime(1_100);
    expect(sent.at(-1)).toMatchObject({ channel: 'pet:preview', payload: { action: 'idle' } });
  });

  it('未知桌宠：state 返回 null，say/action 明确失败', () => {
    const { host } = makeHost();
    expect(host.petControlApi.state('ghost')).toBeNull();
    expect(host.petControlApi.say('ghost', 'x', { scene: 'normal', wake: true })).toMatchObject({ ok: false });
    expect(host.petControlApi.action('ghost', 'idle', 1000)).toMatchObject({ ok: false });
  });
});


describe('matchPetViewForCharacter（T-M6-54 夜间睡衣）', () => {
  it('基础角色在场直接命中；只开了睡衣变体时也能命中', () => {
    const views = [
      { agentId: 'a', characterId: 'crosspet-claude' },
      { agentId: 'b', characterId: 'crosspet-deepseek-pajamas' },
    ];
    const night = (id: string): string => (id === 'crosspet-deepseek' ? 'crosspet-deepseek-pajamas' : id);
    expect(matchPetViewForCharacter(views, 'crosspet-claude', night)?.agentId).toBe('a');
    expect(matchPetViewForCharacter(views, 'crosspet-deepseek', night)?.agentId).toBe('b');
    expect(matchPetViewForCharacter(views, 'custom-seal', night)).toBeUndefined();
  });
});


describe('summonEgg 自定义彩蛋（T-M6-54）', () => {
  it('CrossPet 无串门彩蛋时，userData 里 egg:true 的自定义角色也能被召唤', async () => {
    const { host, opened } = makeHost([{ id: 'custom-little-egg', displayName: '小鲸蛋' }]);
    const result = await host.summonEgg();
    expect(result).toMatchObject({ ok: true, characterId: 'custom-little-egg', name: '小鲸蛋' });
    expect(opened[0]?.characterId).toBe('custom-little-egg');
  });
});
