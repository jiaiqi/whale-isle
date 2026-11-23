/**
 * T-M6-39：TeamBlackboard 确定性单测。
 * 覆盖区域软锁抢占/续租/过期、版本递增、Prompt 摘要 ≤300 字符与 @ 过滤。
 */
import { describe, expect, it } from 'vitest';
import type { TeamCommsMessage } from '@workbench/shared-protocol';
import { TeamBlackboard } from './team-blackboard';

function message(overrides: Partial<TeamCommsMessage> & Pick<TeamCommsMessage, 'id' | 'fromAgentId' | 'fromName' | 'text'>): TeamCommsMessage {
  return {
    ts: 100,
    fromRole: 'ai',
    mentions: [],
    kind: 'chat',
    ...overrides,
  };
}

describe('TeamBlackboard', () => {
  it('区域软锁：同 owner 续租，不同 owner 被拒，释放后可用', () => {
    let now = 1_000;
    const board = new TeamBlackboard({ now: () => now });
    const first = board.tryAcquireZone('a', ' 农场 南区 ', 5_000);
    expect(first.ok).toBe(true);
    expect(first.lock?.zone).toBe('农场 南区');
    expect(board.tryAcquireZone('b', '农场 南区', 5_000)).toMatchObject({ ok: false, lock: { ownerAgentId: 'a' } });
    now = 2_000;
    const renewed = board.tryAcquireZone('a', '农场 南区', 5_000);
    expect(renewed.ok).toBe(true);
    expect(renewed.lock?.expiresAt).toBe(7_000);
    expect(board.releaseZone('b', '农场 南区')).toBe(false);
    expect(board.releaseZone('a', '农场 南区')).toBe(true);
    expect(board.snapshot().zoneLocks).toEqual([]);
  });

  it('过期租约自动释放并递增版本', () => {
    let now = 1_000;
    const board = new TeamBlackboard({ now: () => now });
    board.tryAcquireZone('a', '矿洞 12 层', 1_000);
    const version = board.snapshot().version;
    now = 2_000;
    const snapshot = board.snapshot();
    expect(snapshot.zoneLocks).toEqual([]);
    expect(board.tryAcquireZone('b', '矿洞 12 层', 3_000).ok).toBe(true);
    expect(board.snapshot().version).toBeGreaterThan(version);
  });

  it('Prompt 摘要 ≤300 字符，只注入目标、分工和最近 2 条点名消息', () => {
    const board = new TeamBlackboard({
      now: () => 1_000,
      initialGoal: {
        id: 'g1',
        title: '凑钱建鸡舍',
        gameId: 'stardew',
        metrics: [{ label: '金币', current: 2_640, target: 4_000, unit: 'g', source: 'manual' }],
        deadline: '',
        status: 'active',
      },
    });
    board.upsertAssignment({ agentId: 'a', displayName: '小鲸', role: 'ai', task: '钓鱼', zone: '海滩', status: 'working', progressNote: '', updatedAt: 1 });
    board.upsertAssignment({ agentId: 'b', displayName: '泡芙', role: 'ai', task: '砍树', zone: '农场', status: 'working', progressNote: '', updatedAt: 1 });
    for (let i = 0; i < 5; i++) {
      board.appendMessage(message({ id: `m${i}`, fromAgentId: i % 2 === 0 ? 'a' : 'b', fromName: i % 2 === 0 ? '小鲸' : '泡芙', text: `消息${i}-${'长'.repeat(80)}`, mentions: i === 0 ? [] : ['@全队'] }));
    }
    board.appendMessage(message({ id: 'self', fromAgentId: 'a', fromName: '小鲸', text: '自己说的不应注入', mentions: ['a'] }));
    const summary = board.formatCompactPromptSummary('a');
    expect([...summary].length).toBeLessThanOrEqual(300);
    expect(summary).toContain('目标：凑钱建鸡舍');
    expect(summary).toContain('小鲸');
    expect(summary).toContain('泡芙=砍树[农场]');
    expect(summary).not.toContain('消息0');
    expect(summary).toContain('消息1');
    expect(summary).toContain('消息3');
    expect(summary).not.toContain('消息4'); // 自己说的不注入
    expect(summary).not.toContain('自己说的不应注入');

    const longBoard = new TeamBlackboard({ initialGoal: { id: 'g', title: '极长目标'.repeat(200), gameId: 'stardew', metrics: [], deadline: '', status: 'active' } });
    expect([...longBoard.formatCompactPromptSummary('a')].length).toBeLessThanOrEqual(300);
  });

  it('黑板 mutation 递增 version 并通知订阅者；订阅异常不影响其他订阅者', () => {
    const board = new TeamBlackboard({ now: () => 1_000 });
    const versions: number[] = [];
    board.onSnapshot(() => { throw new Error('bad listener'); });
    board.onSnapshot((snapshot) => versions.push(snapshot.version));
    board.setGoal({ id: 'g', title: '建鸡舍', gameId: 'stardew', metrics: [], deadline: '', status: 'active' });
    board.upsertAssignment({ agentId: 'a', displayName: '小鲸', role: 'ai', task: '钓鱼', zone: '海滩', status: 'working', progressNote: '', updatedAt: 1 });
    expect(versions).toEqual([1, 2]);
  });


  it('目标/分工/商量/消息的局部更新与空值兜底', () => {
    let now = 5_000;
    const board = new TeamBlackboard({ now: () => now, maxMessages: 10 });
    expect(board.formatCompactPromptSummary('a')).toContain('目标：暂无');
    expect(board.formatCompactPromptSummary('a')).toContain('分工：暂无');
    board.patchGoal({ title: '新目标', status: 'active' });
    board.setAssignmentStatus('missing', 'working');
    expect(board.removeAssignment('missing').version).toBeGreaterThan(0);
    board.setAssignmentStatus('a', 'working');
    expect(board.snapshot().assignments).toEqual([]);
    board.applyPlan('p1', [{ agentId: 'a', task: '钓鱼' }]);
    board.applyPlan('p2', [{ agentId: 'a', displayName: '小鲸', task: '砍树', zone: '农场' }]);
    expect(board.snapshot().assignments[0]).toMatchObject({ displayName: '小鲸', task: '砍树', zone: '农场' });
    board.applyPlan('p3', [{ agentId: 'b', task: '采矿' }]);
    expect(board.snapshot().assignments.find((item) => item.agentId === 'b')).toMatchObject({ displayName: 'b', role: 'ai', zone: '' });
    board.setHuddleState({ active: true });
    expect(board.snapshot().huddleState.active).toBe(true);
    board.setAssignmentStatus('a', 'need_help', '背包满');
    expect(board.snapshot().assignments.find((item) => item.agentId === 'a')?.progressNote).toBe('背包满');
    now += 1;
    board.setAssignmentStatus('a', 'working');
    expect(board.snapshot().assignments.find((item) => item.agentId === 'a')?.status).toBe('working');
    expect(board.removeAssignment('a').version).toBeGreaterThan(0);
    board.onSnapshot(() => undefined);

    for (let i = 0; i < 12; i++) {
      board.appendMessage(message({ id: `overflow-${i}`, fromAgentId: 'b', fromName: '泡芙', text: `消息${i}`, mentions: ['@全队'] }));
    }
    expect(board.recentMessages()).toHaveLength(10);
    expect(board.recentMessages()[0]?.text).toBe('消息2');
    board.appendMessage(message({ id: 'to-self', fromAgentId: 'b', fromName: '泡芙', text: '直接点名', mentions: ['a'] }));
    expect(board.formatCompactPromptSummary('a')).toContain('直接点名');
  });

  it('区域锁拒绝空区域/空 agent；releaseAgentZones 无锁返回 0', () => {
    const board = new TeamBlackboard();
    expect(board.tryAcquireZone('a', '   ', 1_000)).toMatchObject({ ok: false, reason: '区域为空' });
    expect(board.tryAcquireZone(' ', '农场', 1_000)).toMatchObject({ ok: false, reason: 'agentId 为空' });
    expect(board.releaseAgentZones('a')).toBe(0);
  });

  it('applyPlan 写入分工并在释放时只清 owner 自己的锁', () => {
    const board = new TeamBlackboard({ now: () => 1_000 });
    board.applyPlan('p1', [{ agentId: 'a', displayName: '小鲸', task: '钓鱼', zone: '海滩' }]);
    expect(board.snapshot().assignments[0]).toMatchObject({ agentId: 'a', task: '钓鱼', status: 'idle' });
    board.tryAcquireZone('a', '海滩', 10_000);
    board.tryAcquireZone('b', '农场', 10_000);
    expect(board.releaseAgentZones('a')).toBe(1);
    expect(board.snapshot().zoneLocks.map((lock) => lock.ownerAgentId)).toEqual(['b']);
  });
});
