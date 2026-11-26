import { describe, expect, it } from 'vitest';
import { CoopRuntimeV1 } from './coop-runtime';

describe('CoopRuntimeV1 · V2-P2-09C 宿主联机身份绑定（host/farmhand 双租约互不抢占）', () => {
  const HOST_BODY = { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' } as const;
  const FARMHAND_BODY = { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' } as const;

  function setup(): CoopRuntimeV1 {
    const runtime = new CoopRuntimeV1({ now: () => 30_000 });
    runtime.createRoom({ roomId: 'room-p209c', gameId: 'stardew', sharedGoal: '农场分工' });
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

  it('host 与 farmhand 各持一份身体绑定，租约视图按屏分列', () => {
    const runtime = setup();
    const views = runtime.bodyLeaseViews();
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      uniqueMultiplayerID: '1001', screenId: 0, role: 'host', participantId: 'human-host', controlOwner: 'human',
    });
    expect(views[1]).toMatchObject({
      uniqueMultiplayerID: '2002', screenId: 1, role: 'farmhand', participantId: 'ai-xiaojing', controlOwner: 'ai',
    });
    expect(runtime.snapshot().bodyLeases).toHaveLength(2);
  });

  it('人类在 host 身体的操作不夺走 farmhand 身体的 AI 租约（双租约互不抢占）', () => {
    const runtime = setup();
    // 人类接管的是 host 身体
    const takeover = runtime.detectHumanTakeover({ uniqueMultiplayerID: '1001' });
    expect(takeover.takenOver).toBe(false);
    expect(takeover.reason).toContain('人类成员');
    // farmhand 身体的 AI 租约仍然是 AI 持有
    expect(runtime.controlLeaseOf('ai-xiaojing')?.owner).toBe('ai');
    expect(runtime.controlLeaseOf('ai-xiaojing')?.canAiAct()).toBe(true);
  });

  it('人类在 farmhand 身体操作 → 只接管该 farmhand 的 AI 租约，不影响 host 侧', () => {
    const runtime = setup();
    const takeover = runtime.detectHumanTakeover({ uniqueMultiplayerID: '2002' });
    expect(takeover.takenOver).toBe(true);
    expect(takeover.participantId).toBe('ai-xiaojing');
    expect(runtime.controlLeaseOf('ai-xiaojing')?.owner).toBe('human');
    // host 侧的租约不受影响
    expect(runtime.controlLeaseOf('human-host')?.owner).toBe('human');
    expect(runtime.bodyLeaseViews().find((v) => v.role === 'farmhand')?.controlOwner).toBe('human');
  });

  it('拿不到身体标识时不判定接管（不误抢 AI 控制权）', () => {
    const runtime = setup();
    const noBody = runtime.detectHumanTakeover({});
    expect(noBody.takenOver).toBe(false);
    expect(noBody.reason).toContain('未提供身体标识');
    const unknownBody = runtime.detectHumanTakeover({ uniqueMultiplayerID: '9999' });
    expect(unknownBody.takenOver).toBe(false);
    expect(unknownBody.reason).toContain('未找到身体');
    expect(runtime.controlLeaseOf('ai-xiaojing')?.owner).toBe('ai');
  });

  it('动作路由：只能写入自己绑定的身体，跨身体写入被拒', () => {
    const runtime = setup();
    const own = runtime.routeActionToBody({ participantId: 'ai-xiaojing', targetUniqueMultiplayerID: '2002' });
    expect(own.allowed).toBe(true);
    const cross = runtime.routeActionToBody({ participantId: 'ai-xiaojing', targetUniqueMultiplayerID: '1001' });
    expect(cross.allowed).toBe(false);
    expect(cross.reason).toContain('跨身体写入');
  });

  it('未绑定身体的成员不得接收控制动作', () => {
    const runtime = new CoopRuntimeV1({ now: () => 31_000 });
    runtime.createRoom({ roomId: 'room-nobind', sharedGoal: '未绑定' });
    runtime.joinParticipant({
      participantId: 'ai-unbound',
      kind: 'ai',
      characterId: 'char_xiaojing',
      displayName: '未绑定小鲸',
    });
    const result = runtime.routeActionToBody({ participantId: 'ai-unbound', targetUniqueMultiplayerID: '3003' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('未绑定游戏内身体');
  });

  it('被人类接管后 AI 的动作路由立即失效', () => {
    const runtime = setup();
    expect(runtime.routeActionToBody({ participantId: 'ai-xiaojing', targetUniqueMultiplayerID: '2002' }).allowed).toBe(true);
    runtime.detectHumanTakeover({ uniqueMultiplayerID: '2002' });
    const after = runtime.routeActionToBody({ participantId: 'ai-xiaojing', targetUniqueMultiplayerID: '2002' });
    expect(after.allowed).toBe(false);
    expect(after.reason).toContain('控制租约未就绪');
  });

  it('绑定冲突显式抛错：同一身体或同一屏幕不能被两个成员占用', () => {
    const runtime = setup();
    expect(() => runtime.joinParticipant({
      participantId: 'ai-duplicate',
      kind: 'ai',
      characterId: 'char_seal',
      displayName: '海豹',
      bodyBinding: FARMHAND_BODY,
    })).toThrow(/2002 已被成员 ai-xiaojing 绑定/);
    expect(() => runtime.joinParticipant({
      participantId: 'ai-same-screen',
      kind: 'ai',
      characterId: 'char_seal',
      displayName: '海豹',
      bodyBinding: { screenId: 1, uniqueMultiplayerID: '3003', role: 'farmhand' },
    })).toThrow(/屏幕 1 已被成员 ai-xiaojing 绑定/);
  });

  it('改绑自身身体允许（换屏/换身体），但不能抢占他人身体', () => {
    const runtime = setup();
    const rebound = runtime.claimBodyBinding('ai-xiaojing', { screenId: 2, uniqueMultiplayerID: '4004', role: 'farmhand' });
    expect(rebound.screenId).toBe(2);
    expect(runtime.participantOfBody('4004')?.participantId).toBe('ai-xiaojing');
    expect(runtime.participantOfBody('2002')).toBeNull();
    expect(() => runtime.claimBodyBinding('ai-xiaojing', HOST_BODY)).toThrow(/1001 已被成员 human-host 绑定/);
  });

  it('participantOfBody 精确解析身体到参与者，未绑定返回 null', () => {
    const runtime = setup();
    expect(runtime.participantOfBody('1001')?.participantId).toBe('human-host');
    expect(runtime.participantOfBody('2002')?.participantId).toBe('ai-xiaojing');
    expect(runtime.participantOfBody('5555')).toBeNull();
  });

  it('未知成员绑身体 / 下发动作都显式拒绝，不静默建档', () => {
    const runtime = setup();
    expect(() => runtime.claimBodyBinding('ghost', FARMHAND_BODY)).toThrow(/成员未加入联机房间：ghost/);
    const routed = runtime.routeActionToBody({ participantId: 'ghost', targetUniqueMultiplayerID: '2002' });
    expect(routed.allowed).toBe(false);
    expect(routed.reason).toContain('成员不存在：ghost');
  });
});
