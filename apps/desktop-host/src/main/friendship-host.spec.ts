/** 友谊宿主（T-M6-48）：互聊串行播报 + memory 写入、提醒免打扰、笔记本视图、隐私擦除。 */
import { describe, expect, it, vi } from 'vitest';
import { FriendshipStore } from '@workbench/local-store/friendship';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { createFriendshipHost } from './friendship-host';

const NOW = new Date('2026-11-24T12:00:00').getTime();

function makeHost(options: {
  speak?: (id: string, text: string) => void;
  remember?: (text: string) => void;
  now?: () => number;
  customCharacter?: (characterId: string) => { milestones?: Array<{ id: string; at?: number; text?: string }>; notebook?: { title?: string; entries?: string[]; notes?: string[]; sign?: string } } | null;
} = {}) {
  const store = new FriendshipStore(':memory:');
  const host = createFriendshipHost({
    userDataDir: '/tmp/whale-isle-test',
    store,
    now: options.now ?? (() => NOW),
    characters: () => [
      { id: 'aboutme-dsh', displayName: '蓝蓝' },
      { id: 'aboutme-grok', displayName: '小魔女' },
    ],
    ...options,
  });
  return { host, store };
}

describe('friendship host', () => {
  it('互聊：至少两只桌宠；串行播报 A→B 并写入 memory 与互聊记录', () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const remembered: string[] = [];
    const { host } = makeHost({ speak: (id, text) => spoken.push(`${id}:${text}`), remember: (text) => remembered.push(text) });
    expect(host.pairChat(['aboutme-dsh'])).toMatchObject({ ok: false });
    const result = host.pairChat(['aboutme-dsh', 'aboutme-grok']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.aName).toBe('蓝蓝');
      expect(result.bName).toBe('小魔女');
    }
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('aboutme-dsh:');
    vi.advanceTimersByTime(1_200);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]).toContain('aboutme-grok:');
    expect(remembered[0]).toContain('闲时互聊');
    expect(host.notebook('aboutme-dsh').banter).toHaveLength(1);
    vi.useRealTimers();
  });

  it('提醒：免打扰时段与睡眠态返回 null，正常时段给出真实文案', () => {
    const { host } = makeHost();
    expect(host.tickReminders(NOW, true)).toBeNull();
    const reminder = host.tickReminders(NOW + 46 * 60 * 1000, false);
    expect(reminder?.kind).toBe('water');
    expect(reminder?.text).toContain('蓝蓝');

    const lateHost = makeHost().host;
    const late = new Date('2026-11-24T23:30:00').getTime();
    expect(lateHost.tickReminders(late, false)).toBeNull();
  });

  it('笔记本视图与擦除、问候按时段', () => {
    const { host } = makeHost();
    host.record('pat', 'aboutme-dsh');
    host.addNote('aboutme-dsh', '今天一起钓鱼');
    const view = host.notebook('aboutme-dsh');
    expect(view.stats).toMatchObject({ pats: 1, points: 3 });
    expect(view.notes[0]?.text).toBe('今天一起钓鱼');
    expect(host.greeting('aboutme-dsh', 8)).toContain('早上好');
    host.wipe();
    expect(host.notebook('aboutme-dsh').stats).toBeNull();
    expect(host.notebook('aboutme-dsh').notes).toEqual([]);
  });

  it('每日首次见面问候只返回一次；次日重新问候', () => {
    let clock = NOW;
    const { host } = makeHost({ now: () => clock });
    expect(host.meetGreeting('aboutme-dsh', 8)).toContain('早上好');
    expect(host.meetGreeting('aboutme-dsh', 8)).toBe('');
    clock = NOW + 24 * 60 * 60 * 1000;
    expect(host.meetGreeting('aboutme-dsh', 8)).toContain('早上好');
    expect(host.meetGreeting('', 8)).toBe('');
    // 隐私擦除同时清掉「今天已问候」，下次见面重新问候
    host.wipe();
    expect(host.meetGreeting('aboutme-dsh', 8)).toContain('早上好');
  });

  it('未知角色不写库；坏 store 写入降级为 null', () => {
    const { host } = makeHost();
    expect(host.record('pat', '')).toBeNull();
    expect(host.notebook('nobody').stats).toBeNull();
  });

  it('自定义角色：milestones 的 {h} 用当前小时替换，notebook entries/notes/sign 覆盖通用文案', () => {
    const { host } = makeHost({
      now: () => new Date('2026-11-24T15:30:00').getTime(),
      customCharacter: (characterId) => (characterId === 'custom-seal'
        ? {
          milestones: [
            { id: 'first', at: 1, text: '第一次一起干活' },
            { id: 'hour', at: 0, text: '{h} 点了，该喝水啦' },
            { id: 'blank', at: 0, text: '   ' },
            { id: 'no-id', at: 5, text: '{h} 点打卡' },
          ],
          notebook: { title: '海豹本子', entries: ['今天很乖'], notes: ['{h}:00 记得收衣服'], sign: '—— 小海豹 {h} 点留' },
        }
        : null),
    });
    const view = host.notebook('custom-seal');
    expect(view.milestones).toEqual([
      { id: 'first', at: 1, text: '第一次一起干活' },
      { id: 'hour', at: 0, text: '15 点了，该喝水啦' },
      { id: 'no-id', at: 5, text: '15 点打卡' },
    ]);
    expect(view.notebookTitle).toBe('海豹本子');
    expect(view.notebookEntries).toEqual(['今天很乖', '15:00 记得收衣服']);
    expect(view.notebookSign).toBe('—— 小海豹 15 点留');
    // 缺项回落：通用角色没有任何自定义里程碑/小本子文本
    const generic = host.notebook('aboutme-dsh');
    expect(generic.milestones).toEqual([]);
    expect(generic.notebookEntries).toEqual([]);
    expect(generic.notebookSign).toBe('');
  });

  it('customCharacter 抛错时不影响通用小本子', () => {
    const { host } = makeHost({ customCharacter: () => { throw new Error('坏 character.json'); } });
    expect(host.notebook('aboutme-dsh').notebookEntries).toEqual([]);
    expect(host.notebook('aboutme-dsh').notes).toEqual([]);
  });
});
