/** 友谊 / 小本子账本（T-M6-48）：每日上限、跨日重置、心数与档位、留言/互聊、隐私擦除。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAILY_CAP, FriendshipStore, POINTS_PER_HEART, quarterHeartsOf, tierOf } from './friendship';

const stores: FriendshipStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): FriendshipStore {
  const store = new FriendshipStore(':memory:');
  stores.push(store);
  return store;
}

const T0 = new Date('2026-11-24T10:00:00+08:00').getTime();
const T1 = new Date('2026-11-25T10:00:00+08:00').getTime();

describe('friendship 规则', () => {
  it('心数/档位换算：1 心 = 40 分，1/4 心 = 10 分，10 心上限', () => {
    expect(quarterHeartsOf(0)).toBe(0);
    expect(quarterHeartsOf(9)).toBe(0);
    expect(quarterHeartsOf(10)).toBe(1);
    expect(quarterHeartsOf(POINTS_PER_HEART)).toBe(4);
    expect(quarterHeartsOf(10_000)).toBe(40);
    expect(tierOf(0)).toBe('stranger');
    expect(tierOf(4)).toBe('familiar');
    expect(tierOf(20)).toBe('friend');
    expect(tierOf(36)).toBe('best');
  });

  it('每日上限 15 分：pat 3 分 ×6 只涨 15，计数仍累加；跨日重置', () => {
    const store = makeStore();
    for (let i = 0; i < 6; i += 1) store.addPoints('aboutme-dsh', 'pat', T0);
    const capped = store.get('aboutme-dsh', T0);
    expect(capped).toMatchObject({ points: DAILY_CAP, dailyGained: DAILY_CAP, pats: 6 });
    const next = store.addPoints('aboutme-grok', 'cowork', T1);
    expect(next).toMatchObject({ points: 4, dailyGained: 4 });
    expect(store.get('aboutme-dsh', T1)?.dailyGained).toBe(0);
  });

  it('未知动作/空角色拒绝；cofinish 与 cowork 分别计数', () => {
    const store = makeStore();
    expect(() => store.addPoints('', 'pat', T0)).toThrow(/角色 id/);
    store.addPoints('a', 'cowork', T0);
    const stats = store.addPoints('a', 'cofinish', T0);
    expect(stats).toMatchObject({ cowork: 1, cofinish: 1, points: 10 });
  });

  it('留言裁剪与倒序、互聊记录、隐私擦除只清三表', () => {
    const store = makeStore();
    store.addNote('a', '  今天一起钓到 12 条鱼！ ');
    store.addNote('a', 'x'.repeat(400));
    const notes = store.listNotes('a');
    expect(notes[0]?.text.length).toBe(280);
    expect(notes[1]?.text).toBe('今天一起钓到 12 条鱼！');
    const banter = store.addBanter({ aId: 'a', aName: '小鲸', aText: '我钓到鱼了', bId: 'b', bName: '蓝蓝', bText: '我收拾好了' }, T0);
    expect(store.listBanter()[0]).toMatchObject({ aName: '小鲸', bName: '蓝蓝' });
    expect(banter.aText).toBe('我钓到鱼了');
    store.addPoints('a', 'pat', T0);
    store.wipe();
    expect(store.list()).toEqual([]);
    expect(store.listNotes('a')).toEqual([]);
    expect(store.listBanter()).toEqual([]);
  });

  it('文件库持久化：关库重开仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'friendship-')); dirs.push(dir);
    const path = join(dir, 'friendship.sqlite');
    const first = new FriendshipStore(path);
    first.addPoints('aboutme-kimi', 'cofinish', T0);
    first.addNote('aboutme-kimi', '谢谢你今天陪我');
    first.close();
    const second = new FriendshipStore(path);
    stores.push(second);
    expect(second.get('aboutme-kimi', T0)?.points).toBe(6);
    expect(second.listNotes('aboutme-kimi')[0]?.text).toBe('谢谢你今天陪我');
  });
});

describe('friendship 边界', () => {
  it('空留言/超长留言/互聊裁剪与 limit、缺失角色返回 null、chat 计入 rounds', () => {
    const store = makeStore();
    expect(() => store.addNote('a', '   ')).toThrow(/不能为空/);
    store.addNote('a', '一');
    store.addNote('a', '二');
    store.addNote('a', '三');
    expect(store.listNotes('a', 2)).toHaveLength(2);
    expect(store.get('nobody')).toBeNull();
    const stats = store.addPoints('a', 'chat', T0);
    expect(stats.rounds).toBe(1);
    store.addBanter({ aId: 'a', aName: ' 小鲸 ', aText: 'x'.repeat(400), bId: 'b', bName: '蓝蓝', bText: '好' }, T0);
    store.addBanter({ aId: 'a', aName: '小鲸', aText: '第二句', bId: 'b', bName: '蓝蓝', bText: '嗯' }, T0);
    const banter = store.listBanter(1);
    expect(banter).toHaveLength(1);
    expect(banter[0]?.aText).toBe('第二句');
    expect(store.list()).toHaveLength(1);
  });

  it('关闭后再调用抛错（不静默成功）', () => {
    const store = new FriendshipStore(':memory:');
    store.close();
    expect(() => store.list()).toThrow();
  });
});
