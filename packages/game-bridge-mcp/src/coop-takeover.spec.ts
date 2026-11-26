import { describe, expect, it } from 'vitest';
import { CoopRuntimeV1 } from './coop-runtime';

describe('CoopRuntimeV1 · V2-P2-09E 按屏接管与 ABORTED_BY_HUMAN_TAKEOVER 回执', () => {
  const HOST_BODY = { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' } as const;
  const FARMHAND_BODY = { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' } as const;

  function setup(): CoopRuntimeV1 {
    const runtime = new CoopRuntimeV1({ now: () => 40_000 });
    runtime.createRoom({ roomId: 'room-p209e', gameId: 'stardew', sharedGoal: '农场分工' });
    runtime.joinParticipant({
      participantId: 'human-host',
      kind: 'human',
      characterId: 'farmer-host',
      displayName: '人类房主',
      bodyBinding: HOST_BODY,
    });
    runtime.joinParticipant({
      participantId: 'ai-xiaojing',
      kind: 'ai',
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      mcpPort: 18089,
      bodyBinding: FARMHAND_BODY,
    });
    return runtime;
  }

  it('登记在飞动作：先过路由门禁，再落到自己绑定的身体上并进快照', () => {
    const runtime = setup();
    const begun = runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'water_crops_batch',
      actionId: 'act-water-1',
    });
    expect(begun.ok).toBe(true);
    expect(begun.action).toMatchObject({
      actionId: 'act-water-1',
      uniqueMultiplayerID: '2002',
      screenId: 1,
      tool: 'water_crops_batch',
    });
    expect(runtime.inFlightActionViews()).toHaveLength(1);
    expect(runtime.snapshot().inFlightActions).toHaveLength(1);
  });

  it('路由不通过的动作不能登记（跨身体 / 未绑定成员）', () => {
    const runtime = setup();
    const cross = runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '1001',
      tool: 'move_to_tile',
    });
    expect(cross.ok).toBe(false);
    expect(cross.error).toContain('跨身体写入');
    expect(runtime.inFlightActionViews()).toHaveLength(0);
  });

  it('同一身体的动作互斥锁：第二个动作在第一个结束前被拒绝', () => {
    const runtime = setup();
    expect(runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'move_to_tile',
      actionId: 'act-a',
    }).ok).toBe(true);
    const second = runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'water_crops_batch',
      actionId: 'act-b',
    });
    expect(second.ok).toBe(false);
    expect(second.error).toContain('动作互斥锁');
    // 结束后可以登记下一个
    expect(runtime.finishBodyAction('act-a', 'COMPLETED').ok).toBe(true);
    expect(runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'water_crops_batch',
      actionId: 'act-b',
    }).ok).toBe(true);
  });

  it('finish 只接受真实回执三态；未知 actionId 如实报错', () => {
    const runtime = setup();
    runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'move_to_tile',
      actionId: 'act-a',
    });
    const done = runtime.finishBodyAction('act-a', 'UNCERTAIN');
    expect(done).toMatchObject({ ok: true, status: 'UNCERTAIN' });
    expect(runtime.inFlightActionViews()).toHaveLength(0);
    const missing = runtime.finishBodyAction('act-ghost', 'COMPLETED');
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('在飞动作不存在：act-ghost');
  });

  it('人类在 farmhand 身体一动 → 该身体在飞动作被中止并产出按身体的 ABORTED 回执', () => {
    const runtime = setup();
    runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'water_crops_batch',
      actionId: 'act-water-9',
    });
    const takeover = runtime.detectHumanTakeover({ uniqueMultiplayerID: '2002', reason: '主人按了手柄方向键' });
    expect(takeover.takenOver).toBe(true);
    expect(takeover.abortedReceipts).toHaveLength(1);
    expect(takeover.abortedReceipts[0]).toMatchObject({
      actionId: 'act-water-9',
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      screenId: 1,
      tool: 'water_crops_batch',
      status: 'ABORTED_BY_HUMAN_TAKEOVER',
      reason: '主人按了手柄方向键',
      startedAt: 40_000,
      abortedAt: 40_000,
    });
    // 中止后动作已从登记表移除，补 finish 会得到诚实报错而不是成功
    expect(runtime.inFlightActionViews()).toHaveLength(0);
    const lateFinish = runtime.finishBodyAction('act-water-9', 'COMPLETED');
    expect(lateFinish.ok).toBe(false);
    expect(lateFinish.error).toContain('在飞动作不存在');
  });

  it('接管只中止该身体的动作：host 身体上的动作不受 farmhand 接管影响', () => {
    const runtime = setup();
    runtime.beginBodyAction({
      participantId: 'human-host',
      uniqueMultiplayerID: '1001',
      tool: 'move_to_tile',
      actionId: 'act-host-1',
    });
    runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'water_crops_batch',
      actionId: 'act-ai-1',
    });
    const takeover = runtime.detectHumanTakeover({ uniqueMultiplayerID: '2002' });
    expect(takeover.takenOver).toBe(true);
    expect(takeover.abortedReceipts).toHaveLength(1);
    expect(takeover.abortedReceipts[0]?.actionId).toBe('act-ai-1');
    // host 身体的动作还在，且由人类正常 finish
    expect(runtime.inFlightActionViews().map((a) => a.actionId)).toEqual(['act-host-1']);
    expect(runtime.finishBodyAction('act-host-1', 'COMPLETED').ok).toBe(true);
  });

  it('未接管 / 该身体无在飞动作时，abortedReceipts 为空数组而不是 undefined', () => {
    const runtime = setup();
    const noBody = runtime.detectHumanTakeover({});
    expect(noBody.abortedReceipts).toEqual([]);
    const idle = runtime.detectHumanTakeover({ uniqueMultiplayerID: '2002' });
    expect(idle.takenOver).toBe(true);
    expect(idle.abortedReceipts).toEqual([]);
  });

  it('被接管后 AI 无法再在该身体登记新动作，直到控制权交还', () => {
    const runtime = setup();
    runtime.detectHumanTakeover({ uniqueMultiplayerID: '2002' });
    const after = runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'move_to_tile',
    });
    expect(after.ok).toBe(false);
    expect(after.error).toContain('控制租约未就绪');
  });

  it('createRoom 重置时清空在飞动作登记', () => {
    const runtime = setup();
    runtime.beginBodyAction({
      participantId: 'ai-xiaojing',
      uniqueMultiplayerID: '2002',
      tool: 'move_to_tile',
      actionId: 'act-a',
    });
    runtime.createRoom({ roomId: 'room-reset', sharedGoal: '重开' });
    expect(runtime.inFlightActionViews()).toHaveLength(0);
    expect(runtime.snapshot().inFlightActions).toHaveLength(0);
  });
});
