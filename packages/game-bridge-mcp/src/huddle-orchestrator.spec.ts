/**
 * T-M6-39：HuddleOrchestrator 硬护栏单测。
 * 覆盖：2 轮收敛、3 轮强制收敛、5 分钟自动冷却、预算耗尽本地降级、手动强触发。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TeamPlan } from '@workbench/shared-protocol';
import { activeSnapshot, HuddleOrchestrator, type HuddleBrain, type HuddleParticipant } from './huddle-orchestrator';
import { TeamBlackboard } from './team-blackboard';

const participants: HuddleParticipant[] = [
  { agentId: 'a', displayName: '小鲸', personaPrompt: '傲娇', stateText: '海滩/体力80', priority: 1 },
  { agentId: 'b', displayName: '泡芙', personaPrompt: '软萌', stateText: '农场/体力50', priority: 2 },
];

const plan: TeamPlan = {
  id: 'plan-1',
  title: '建鸡舍',
  summary: '小鲸钓鱼，泡芙砍树',
  assignments: [
    { agentId: 'a', displayName: '小鲸', task: '钓鱼凑钱', zone: '海滩' },
    { agentId: 'b', displayName: '泡芙', task: '砍 150 木材', zone: '农场' },
  ],
};

function makeBrain(convergenceQueue: Array<Awaited<ReturnType<HuddleBrain['converge']>>>): HuddleBrain & { propose: ReturnType<typeof vi.fn>; converge: ReturnType<typeof vi.fn> } {
  return {
    propose: vi.fn(async ({ participant }: { participant: HuddleParticipant }) => ({ text: `${participant.displayName}提议干活`, tokensUsed: 10 })),
    converge: vi.fn(async () => convergenceQueue.shift() ?? { text: '仍未收敛' }),
  };
}

function setup(brain: HuddleBrain, options: Partial<ConstructorParameters<typeof HuddleOrchestrator>[0]> = {}): {
  board: TeamBlackboard;
  huddle: HuddleOrchestrator;
  nowRef: { value: number };
} {
  let now = 1_000_000;
  const nowRef = { value: now };
  const board = new TeamBlackboard({
    now: () => nowRef.value,
    initialGoal: { id: 'g', title: '建鸡舍', gameId: 'stardew', metrics: [], deadline: '', status: 'active' },
  });
  const huddle = new HuddleOrchestrator({
    blackboard: board,
    participants: () => participants,
    brain,
    now: () => nowRef.value,
    ...options,
  });
  return { board, huddle, nowRef };
}

describe('HuddleOrchestrator', () => {
  it('Round 2 形成 TeamPlan 就立即写入黑板、下发 directive 并进入 5 分钟冷却', async () => {
    const brain = makeBrain([{ text: '分工定了', plan }]);
    const dispatch = vi.fn(async () => undefined);
    const { board, huddle } = setup(brain, { dispatch });
    const result = await huddle.trigger({ reason: '新目标', manual: true });
    expect(result).toMatchObject({ ok: true, fallback: false, rounds: 2 });
    expect(brain.propose).toHaveBeenCalledTimes(2);
    expect(brain.converge).toHaveBeenCalledTimes(1);
    expect(board.snapshot().assignments.map((item) => item.task)).toEqual(['钓鱼凑钱', '砍 150 木材']);
    expect(board.snapshot().huddleState.active).toBe(false);
    expect(dispatch).toHaveBeenCalledWith(plan);

    const blocked = await huddle.trigger({ reason: '自动求助' });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('冷却');
    const forced = await huddle.trigger({ reason: '主人点名', manual: true });
    expect(forced.ok).toBe(true);
  });

  it('Round 2 未收敛时最多进入 Round 3，并由最高优先级角色拍板', async () => {
    const brain = makeBrain([{ text: '还差一点' }, { text: '泡芙拍板', plan }]);
    const { board, huddle } = setup(brain);
    const result = await huddle.trigger({ reason: '冲突', manual: true });
    expect(result.rounds).toBe(3);
    expect(brain.converge).toHaveBeenCalledTimes(2);
    expect(brain.converge.mock.calls[1]?.[0]).toMatchObject({ chair: { agentId: 'b' } });
    expect(board.snapshot().assignments).toHaveLength(2);
  });

  it('Round 3 仍未收敛时本地规则降级，不无限加轮也不阻塞', async () => {
    const brain = makeBrain([{ text: '未定' }, { text: '还没定' }]);
    const { board, huddle } = setup(brain, { maxRounds: 3 });
    const result = await huddle.trigger({ reason: '僵局', manual: true });
    expect(result).toMatchObject({ ok: true, fallback: true, rounds: 3 });
    expect(brain.converge).toHaveBeenCalledTimes(2);
    expect(board.snapshot().assignments).toHaveLength(2);
    expect(board.snapshot().huddleState.active).toBe(false);
  });

  it('token 预算耗尽立即降级为本地分工，不再调用 LLM', async () => {
    const brain = makeBrain([{ text: '不可达', plan }]);
    const { board, huddle } = setup(brain, { tokenBudget: 500, remainingTokens: () => 0 });
    const result = await huddle.trigger({ reason: '预算不足', manual: true });
    expect(result).toMatchObject({ ok: true, fallback: true });
    expect(brain.propose).not.toHaveBeenCalled();
    expect(brain.converge).not.toHaveBeenCalled();
    expect(board.snapshot().assignments).toHaveLength(2);
  });

  it('LLM 调用异常也会降级本地分工，active 状态必定复位', async () => {
    const brain: HuddleBrain = {
      propose: vi.fn().mockRejectedValue(new Error('gateway down')),
      converge: vi.fn(),
    };
    const { board, huddle } = setup(brain);
    const result = await huddle.trigger({ reason: '异常', manual: true });
    expect(result.fallback).toBe(true);
    expect(huddle.isRunning()).toBe(false);
    expect(board.snapshot().huddleState.active).toBe(false);
  });


  it('无人可协商 / maxRounds=2 未收敛 / 空白 goalTitle 都走明确分支', async () => {
    const empty = new HuddleOrchestrator({
      blackboard: new TeamBlackboard(),
      participants: () => [],
      brain: makeBrain([]),
      now: () => 1_000,
    });
    expect(await empty.trigger({ reason: '没人', manual: true })).toMatchObject({ ok: false, reason: expect.stringContaining('没有可参与') });

    const brain = makeBrain([{ text: '未收敛' }]);
    const { board, huddle } = setup(brain, { maxRounds: 2 });
    const result = await huddle.trigger({ reason: '两轮', goalTitle: '   ', manual: true });
    expect(result).toMatchObject({ ok: true, fallback: true, rounds: 2 });
    expect(board.snapshot().goal.title).toBe('建鸡舍');
    expect(brain.converge).toHaveBeenCalledTimes(1);
  });

  it('Round 1 产物超预算时立即本地降级，并保留已有分工', async () => {
    const brain = makeBrain([]);
    brain.propose.mockImplementation(async ({ participant }: { participant: HuddleParticipant }) => ({ text: '很长'.repeat(300), tokensUsed: 1_000 }));
    const { board, huddle } = setup(brain, { tokenBudget: 500 });
    board.upsertAssignment({ agentId: 'a', displayName: '小鲸', role: 'ai', task: '已有钓鱼任务', zone: '海滩', status: 'working', progressNote: '', updatedAt: 1 });
    const result = await huddle.trigger({ reason: '超预算', manual: true });
    expect(result).toMatchObject({ ok: true, fallback: true, rounds: 1 });
    expect(board.snapshot().assignments.find((item) => item.agentId === 'a')?.task).toBe('已有钓鱼任务');
    expect(brain.converge).not.toHaveBeenCalled();
  });

  it('Round 2 后超预算同样降级；dispatch 抛错不破坏已提交计划', async () => {
    const brain = makeBrain([{ text: '未收敛', tokensUsed: 600 }]);
    brain.propose.mockImplementation(async () => ({ text: '提议', tokensUsed: 800 }));
    const onError = vi.fn();
    const dispatch = vi.fn(async () => { throw new Error('runner offline'); });
    const { board, huddle } = setup(brain, { tokenBudget: 2_000, dispatch, onError });
    const result = await huddle.trigger({ reason: '后超预算', manual: true });
    expect(result).toMatchObject({ ok: true, fallback: true, rounds: 2 });
    expect(board.snapshot().assignments).toHaveLength(2);
    expect(onError).toHaveBeenCalled();

    const brain2 = makeBrain([{ text: '成', plan: { ...plan, summary: '' } }]);
    const speak = vi.fn(async () => { throw new Error('voice down'); });
    const dispatch2 = vi.fn(async () => { throw new Error('runner down'); });
    const onError2 = vi.fn();
    const ctx = setup(brain2, { speak, dispatch: dispatch2, onError: onError2 });
    const result2 = await ctx.huddle.trigger({ reason: '语音失败', manual: true, goalTitle: '建鸡舍' });
    expect(result2).toMatchObject({ ok: true, fallback: false, rounds: 2 });
    expect(onError2).toHaveBeenCalled();
    expect(ctx.board.snapshot().assignments).toHaveLength(2);
  });

  it('无 speak / 空台词 / 默认构造参数均可安全运行', async () => {
    const brain = makeBrain([{ text: '', plan: { ...plan, summary: '' } }]);
    const board = new TeamBlackboard({ initialGoal: { id: 'g', title: '建鸡舍', gameId: 'stardew', metrics: [], deadline: '', status: 'active' } });
    const huddle = new HuddleOrchestrator({ blackboard: board, participants: () => participants, brain });
    const result = await huddle.trigger({ reason: '默认', manual: true });
    expect(result.ok).toBe(true);
    expect(activeSnapshot(board).goal.title).toBe('建鸡舍');
  });

  it('并发 trigger 只允许一场，第二场被拒绝且不产生额外 proposal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const brain: HuddleBrain = {
      propose: vi.fn(async () => {
        await gate;
        return { text: '提议', tokensUsed: 1 };
      }),
      converge: vi.fn(async () => ({ text: '成', plan })),
    };
    const { huddle } = setup(brain);
    const first = huddle.trigger({ reason: '第一场', manual: true });
    const second = await huddle.trigger({ reason: '第二场', manual: true });
    expect(second.ok).toBe(false);
    release();
    expect((await first).ok).toBe(true);
    expect(brain.propose).toHaveBeenCalledTimes(2);
  });
});
