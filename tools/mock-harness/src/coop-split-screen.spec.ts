/**
 * [SIMULATION] `V2-P2-09F` 分屏 farmhand 沙盒剧本骨架回归。
 *
 * 把确定性事件流喂给真实的 `CoopRuntimeV1`，验证：
 *   ① host 屏输入不抢 farmhand 屏的 AI 租约；
 *   ② farmhand 屏输入接管该屏并中止在飞动作（`ABORTED_BY_HUMAN_TAKEOVER`）；
 *   ③ 缺身体标识的输入不判定接管。
 *
 * 【BLOCKED】真实屏幕标识来源是打过补丁的 BWF（`V2-P2-09D`，需 owner 完成分屏前置）；
 * 本回归通过 ≠ 真机分屏可用，严禁记为 `[REAL-DEVICE]`。
 */
import { describe, expect, it } from 'vitest';
import { CoopRuntimeV1 } from '@workbench/game-bridge-mcp';
import {
  SPLIT_SCREEN_SCENARIOS,
  runSplitScreenScenario,
  type SplitScreenHarnessHandlers,
} from './coop-split-screen';

interface TakeoverResult {
  takenOver: boolean;
  participantId?: string;
  reason: string;
  abortedReceipts: Array<{ actionId: string; status: string; uniqueMultiplayerID: string; screenId: number }>;
}

function wireScenario(scenarioId: string): { runtime: CoopRuntimeV1; results: unknown[] } {
  const scenario = SPLIT_SCREEN_SCENARIOS.find((s) => s.scenarioId === scenarioId);
  if (scenario === undefined) throw new Error(`剧本不存在：${scenarioId}`);
  const runtime = new CoopRuntimeV1({ now: () => 50_000 });
  runtime.createRoom({ roomId: `room-${scenarioId}`, gameId: 'stardew', sharedGoal: scenario.title });
  for (const instance of scenario.instances) {
    runtime.joinParticipant({
      participantId: instance.role === 'host' ? 'human-host' : 'ai-xiaojing',
      kind: instance.role === 'host' ? 'human' : 'ai',
      characterId: instance.role === 'host' ? 'farmer-host' : 'char_xiaojing',
      displayName: instance.role === 'host' ? '人类房主' : '小鲸',
    });
  }
  const handlers: SplitScreenHarnessHandlers = {
    bindBody: ({ instance, participantId }) => {
      runtime.claimBodyBinding(participantId, {
        screenId: instance.screenId,
        uniqueMultiplayerID: instance.uniqueMultiplayerID,
        role: instance.role,
      });
    },
    beginAction: (input) => runtime.beginBodyAction(input),
    finishAction: (input) => runtime.finishBodyAction(input.actionId, input.status),
    humanInput: (input) => runtime.detectHumanTakeover(input),
  };
  const results = runSplitScreenScenario(
    scenario,
    { host: 'human-host', farmhandAi: 'ai-xiaojing' },
    handlers,
  );
  return { runtime, results };
}

describe('[SIMULATION] V2-P2-09F 分屏 farmhand 沙盒剧本骨架', () => {
  it('host 屏输入不抢 farmhand 屏租约，farmhand 动作正常完成', () => {
    const { runtime, results } = wireScenario('split-host-input-no-takeover');
    const takeover = results.find((r): r is TakeoverResult =>
      typeof r === 'object' && r !== null && 'takenOver' in r);
    expect(takeover?.takenOver).toBe(false);
    expect(takeover?.reason).toContain('无需接管');
    expect(runtime.controlLeaseOf('ai-xiaojing')?.owner).toBe('ai');
    expect(runtime.inFlightActionViews()).toHaveLength(0);
    expect(runtime.bodyLeaseViews().find((v) => v.role === 'farmhand')?.controlOwner).toBe('ai');
  });

  it('farmhand 屏一动：接管该屏 AI、中止在飞动作并产出按身体的 ABORTED 回执', () => {
    const { runtime, results } = wireScenario('split-farmhand-input-takeover-abort');
    const takeover = results.find((r): r is TakeoverResult =>
      typeof r === 'object' && r !== null && 'takenOver' in r);
    expect(takeover?.takenOver).toBe(true);
    expect(takeover?.participantId).toBe('ai-xiaojing');
    expect(takeover?.abortedReceipts).toHaveLength(1);
    expect(takeover?.abortedReceipts[0]).toMatchObject({
      actionId: 'act-scn2',
      status: 'ABORTED_BY_HUMAN_TAKEOVER',
      uniqueMultiplayerID: '2002',
      screenId: 1,
    });
    // 中止后再补 finish 是诚实报错，不伪造 COMPLETED
    const lateFinish = results.at(-1) as { ok: boolean; error?: string };
    expect(lateFinish.ok).toBe(false);
    expect(lateFinish.error).toContain('在飞动作不存在');
    expect(runtime.bodyLeaseViews().find((v) => v.role === 'farmhand')?.controlOwner).toBe('human');
    expect(runtime.bodyLeaseViews().find((v) => v.role === 'host')?.controlOwner).toBe('human');
  });

  it('输入缺身体标识：不判定接管，farmhand 动作照跑照结', () => {
    const { runtime, results } = wireScenario('split-input-without-body-identity');
    const takeover = results.find((r): r is TakeoverResult =>
      typeof r === 'object' && r !== null && 'takenOver' in r);
    expect(takeover?.takenOver).toBe(false);
    expect(takeover?.reason).toContain('未提供身体标识');
    expect(runtime.controlLeaseOf('ai-xiaojing')?.owner).toBe('ai');
    expect(runtime.inFlightActionViews()).toHaveLength(0);
  });

  it('剧本骨架自身确定性：同一剧本跑两次结果一致', () => {
    const first = wireScenario('split-farmhand-input-takeover-abort');
    const second = wireScenario('split-farmhand-input-takeover-abort');
    expect(first.results).toEqual(second.results);
    expect(first.runtime.snapshot()).toEqual(second.runtime.snapshot());
  });
});
