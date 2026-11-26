import { describe, expect, it } from 'vitest';
import { CoopRuntimeV1, evaluateCoopModsCompatibility } from './coop-runtime';

describe('CoopRuntimeV1（V2-P2-08：星露谷人机联机分工、任务板、资源锁、Mod 兼容与断线恢复）', () => {
  it('人机独立控制租约与全局急停隔离', () => {
    let clock = 10_000;
    const runtime = new CoopRuntimeV1({ now: () => clock });
    const room = runtime.createRoom({
      roomId: 'room-farm-1',
      gameId: 'stardew',
      sharedGoal: '完成春季社区中心收集包',
    });
    expect(room.status).toBe('preparing');

    const human = runtime.joinParticipant({
      participantId: 'human-host',
      kind: 'human',
      characterId: 'farmer-host',
      displayName: '人类房主',
    });
    const ai = runtime.joinParticipant({
      participantId: 'ai-xiaojing',
      kind: 'ai',
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      mcpPort: 18089,
    });
    expect(human.controlOwner).toBe('human');
    expect(ai.controlOwner).toBe('ai');
    expect(runtime.snapshot().status).toBe('active');

    // 人类自身控制租约不影响 AI 控制独立游戏角色
    expect(runtime.controlLeaseOf('human-host')?.owner).toBe('human');
    expect(runtime.controlLeaseOf('ai-xiaojing')?.canAiAct()).toBe(true);
    expect(runtime.controlLeaseOf('unknown')).toBeNull();

    runtime.emergencyHaltAll('联机测试急停');
    expect(runtime.controlLeaseOf('ai-xiaojing')?.owner).toBe('halted');
    expect(runtime.snapshot().status).toBe('paused');
  });

  it('Task Board 全生命周期、资源冲突阻塞、任务交接与真实回执（UNCERTAIN 不标完成）', () => {
    let clock = 20_000;
    const runtime = new CoopRuntimeV1({ now: () => clock });
    runtime.createRoom({ roomId: 'room-tb', sharedGoal: '种地与下矿分工' });
    runtime.joinParticipant({ participantId: 'human', kind: 'human', characterId: 'host', displayName: '房主' });
    runtime.joinParticipant({ participantId: 'ai-1', kind: 'ai', characterId: 'char_xiaojing', displayName: '小鲸' });
    runtime.joinParticipant({ participantId: 'ai-2', kind: 'ai', characterId: 'char_guest', displayName: '海豹' });

    expect(() => runtime.proposeTask({ title: 'Bad', goal: 'Bad', ownerId: 'ghost' })).toThrow('未加入');
    expect(runtime.acceptTask('missing').ok).toBe(false);
    expect(runtime.startTask('missing').ok).toBe(false);
    expect(runtime.handoffTask('missing', 'ai-1').ok).toBe(false);
    expect(runtime.reportTaskOutcome('missing', 'COMPLETED', 'ok').ok).toBe(false);

    const t1 = runtime.proposeTask({
      taskId: 'task-water',
      title: '给防风草浇水',
      goal: 'Farm 东区浇水 12 格',
      ownerId: 'ai-1',
      resourceLocks: ['zone:farm-east', 'chest:tools'],
    });
    expect(t1.status).toBe('proposed');
    expect(runtime.acceptTask('task-water').ok).toBe(true);
    expect(runtime.startTask('task-water').ok).toBe(true);

    // 另一任务尝试争抢同一资源锁时拒绝启动且回滚自身局部锁
    const tConflict = runtime.proposeTask({
      taskId: 'task-conflict',
      title: '搬空工具箱',
      goal: '访问 chest:tools',
      ownerId: 'ai-2',
      resourceLocks: ['zone:south-exit', 'chest:tools'],
    });
    expect(runtime.acceptTask(tConflict.taskId).ok).toBe(true);
    const conflictStart = runtime.startTask(tConflict.taskId);
    expect(conflictStart.ok).toBe(false);
    expect(conflictStart.error).toContain('资源冲突');
    // 确认局部预锁 zone:south-exit 已被原子回滚释放
    expect(runtime.checkResourceAccess('human', 'zone:south-exit', 'use').allowed).toBe(true);

    // 交接任务释放旧锁并移交新成员
    const handoff = runtime.handoffTask('task-water', 'ai-2', '小鲸去钓鱼了');
    expect(handoff.ok).toBe(true);
    expect(handoff.task?.ownerId).toBe('ai-2');
    expect(handoff.task?.status).toBe('accepted');
    expect(runtime.startTask('task-water').ok).toBe(true);

    // UNCERTAIN 回执进入 blocked 而不伪造 completed
    const uncertain = runtime.reportTaskOutcome('task-water', 'UNCERTAIN', '水壶可能没水导致半数未浇');
    expect(uncertain.task?.status).toBe('blocked');

    // COMPLETED / FAILED 均释放锁并写终态
    const t2 = runtime.proposeTask({ title: '采集野葱', goal: '煤矿森林南侧', ownerId: 'ai-1' });
    runtime.acceptTask(t2.taskId);
    runtime.startTask(t2.taskId);
    expect(runtime.reportTaskOutcome(t2.taskId, 'COMPLETED', '采集 5 根').task?.status).toBe('completed');

    const t3 = runtime.proposeTask({ title: '下矿找铜', goal: '矿洞 10 层', ownerId: 'ai-1' });
    runtime.acceptTask(t3.taskId);
    runtime.startTask(t3.taskId);
    expect(runtime.reportTaskOutcome(t3.taskId, 'FAILED', '体力不足撤退').task?.status).toBe('failed');
  });

  it('ResourceReservation：防误卖人类保留作物、他人占用拦截与 TTL 自动过期', () => {
    let clock = 50_000;
    const runtime = new CoopRuntimeV1({ now: () => clock });
    runtime.createRoom({ sharedGoal: '留种防误卖保护' });
    runtime.joinParticipant({ participantId: 'human', kind: 'human', characterId: 'host', displayName: '房主' });
    runtime.joinParticipant({ participantId: 'ai-1', kind: 'ai', characterId: 'char_xiaojing', displayName: '小鲸' });

    expect(
      runtime.reserveResource({
        resourceKey: 'crop:ancient_fruit',
        ownerId: 'human',
        intent: 'sell_forbidden',
        ttlMs: 10_000,
        reason: '准备放种子机酿酒',
      }).ok,
    ).toBe(true);

    // AI 与房主本人对该资源的出售均被门禁强拦截
    const sellBlocked = runtime.checkResourceAccess('ai-1', 'crop:ancient_fruit', 'sell');
    expect(sellBlocked.allowed).toBe(false);
    expect(sellBlocked.reason).toContain('禁售');
    expect(runtime.checkResourceAccess('human', 'crop:ancient_fruit', 'sell').allowed).toBe(false);
    expect(runtime.checkResourceAccess('human', 'crop:ancient_fruit', 'use').allowed).toBe(true);
    expect(runtime.checkResourceAccess('ai-1', 'crop:ancient_fruit', 'use').allowed).toBe(false);
    expect(runtime.releaseResource('ai-1', 'crop:ancient_fruit')).toBe(false);

    // TTL 过期后自动释放
    clock += 11_000;
    expect(runtime.checkResourceAccess('ai-1', 'crop:ancient_fruit', 'sell').allowed).toBe(true);
  });

  it('evaluateCoopModsCompatibility：检出缺失 BWF 阻塞、版本冲突与 AvatarSync 外观提醒', () => {
    const okHost = [
      { uniqueId: 'WhaleIsle.BlindWhaleFarmer', name: 'BlindWhaleFarmer', version: '1.2.0', enabled: true, contentType: 'SMAPI' },
      { uniqueId: 'WhaleIsle.AvatarSync', name: 'Whale Isle Avatar Sync', version: '0.3.0-dev.1', enabled: true, contentType: 'SMAPI' },
      { uniqueId: 'Pathoschild.Automate', name: 'Automate', version: '2.1.0', enabled: true, contentType: 'SMAPI' },
      { uniqueId: 'SMAPI.ConsoleCommands', name: 'Console Commands', version: '4.1.0', enabled: true, contentType: 'SMAPI' },
    ];
    const okReport = evaluateCoopModsCompatibility({ hostMods: okHost, peerMods: okHost });
    expect(okReport.compatible).toBe(true);
    expect(okReport.canStartCoop).toBe(true);
    expect(okReport.bwfReady).toBe(true);
    expect(okReport.avatarSyncReady).toBe(true);

    const mismatchedPeer = [
      { uniqueId: 'WhaleIsle.BlindWhaleFarmer', name: 'BlindWhaleFarmer', version: '1.2.0', enabled: false, contentType: 'SMAPI' },
      { uniqueId: 'Pathoschild.Automate', name: 'Automate', version: '2.0.0', enabled: true, contentType: 'SMAPI' },
      { uniqueId: 'Extra.PeerMod', name: 'PeerOnly', version: '1.0.0', enabled: true, contentType: 'SMAPI' },
    ];
    const badReport = evaluateCoopModsCompatibility({
      hostMods: [
        ...okHost,
        { uniqueId: 'Host.OnlyMod', name: 'HostOnly', version: '1.0.0', enabled: true, contentType: 'SMAPI' },
        { uniqueId: 'Toggle.Mod', name: 'ToggleMod', version: '1.0.0', enabled: true, contentType: 'SMAPI' },
      ],
      peerMods: [
        ...mismatchedPeer,
        { uniqueId: 'Toggle.Mod', name: 'ToggleMod', version: '1.0.0', enabled: false, contentType: 'SMAPI' },
      ],
    });
    expect(badReport.compatible).toBe(false);
    expect(badReport.canStartCoop).toBe(false);
    expect(badReport.bwfReady).toBe(false);
    expect(badReport.avatarSyncReady).toBe(false);
    expect(badReport.warnings.some((w) => w.includes('AvatarSync'))).toBe(true);
    expect(badReport.mismatches.some((m) => m.kind === 'version_mismatch')).toBe(true);
    expect(badReport.mismatches.some((m) => m.kind === 'missing_on_peer')).toBe(true);
    expect(badReport.mismatches.some((m) => m.kind === 'missing_on_host')).toBe(true);
    expect(badReport.mismatches.some((m) => m.kind === 'disabled_mismatch')).toBe(true);
  });

  it('断线检测、宽限期保活与重连恢复（及宽限超时自动释放锁防死锁）', () => {
    let clock = 100_000;
    const runtime = new CoopRuntimeV1({
      now: () => clock,
      heartbeatTimeoutMs: 5_000,
      gracePeriodMs: 10_000,
    });
    runtime.createRoom({ roomId: 'room-rec', sharedGoal: '掉线恢复回归' });
    runtime.joinParticipant({ participantId: 'human', kind: 'human', characterId: 'host', displayName: '房主' });
    runtime.joinParticipant({ participantId: 'ai-1', kind: 'ai', characterId: 'char_xiaojing', displayName: '小鲸' });

    const task = runtime.proposeTask({
      taskId: 't-rec',
      title: '矿洞挖矿',
      goal: '20 层挖铁',
      ownerId: 'ai-1',
      resourceLocks: ['zone:mines-20'],
    });
    runtime.acceptTask(task.taskId);
    runtime.startTask(task.taskId);

    // 1) 人类保持心跳，AI 心跳超时进入宽限期：AI 租约暂停，任务与锁暂时保留等待重连
    clock += 3_000;
    expect(runtime.recordHeartbeat('human')).toBe(true);
    clock += 3_000;
    const tick1 = runtime.tickRecovery();
    expect(tick1.disconnectedIds).toEqual(['ai-1']);
    expect(runtime.controlLeaseOf('ai-1')?.owner).toBe('paused');
    expect(runtime.snapshot().status).toBe('reconnecting');
    expect(runtime.checkResourceAccess('human', 'zone:mines-20', 'use').allowed).toBe(false);

    // 宽限期内重连：恢复 connected、租约世代递增淘汰旧指令、房间恢复 active
    const prevGen = runtime.controlLeaseOf('ai-1')!.snapshot().generation;
    const recOk = runtime.reconnectParticipant('ai-1');
    expect(recOk.ok).toBe(true);
    expect(recOk.participant?.reconnectAttempts).toBe(1);
    expect(runtime.controlLeaseOf('ai-1')!.snapshot().generation).toBeGreaterThan(prevGen);
    expect(runtime.snapshot().status).toBe('active');
    expect(runtime.reconnectParticipant('ghost').ok).toBe(false);

    // 2) 人类心跳保活，AI 再次掉线超过宽限期 → offline + 自动释放锁 + running 任务转 blocked 防死锁
    expect(runtime.recordHeartbeat('human')).toBe(true);
    expect(runtime.recordHeartbeat('ghost')).toBe(false);
    runtime.markDisconnected('ai-1', '进程崩溃');
    clock += 11_000;
    expect(runtime.recordHeartbeat('human')).toBe(true);
    const tick2 = runtime.tickRecovery();
    expect(tick2.timedOutIds).toEqual(['ai-1']);
    expect(runtime.snapshot().status).toBe('active');
    expect(runtime.snapshot().tasks.find((t) => t.taskId === 't-rec')?.status).toBe('blocked');
    expect(runtime.checkResourceAccess('human', 'zone:mines-20', 'use').allowed).toBe(true);
    expect(runtime.handoffTask('t-rec', 'ai-1').ok).toBe(false); // offline 成员不可接手
    expect(runtime.startTask('t-rec').ok).toBe(false); // offline 成员不可启动任务
    expect(runtime.markDisconnected('ghost')).toBeNull();

    // 直接在未 createRoom 的默认实例上 joinParticipant + 急停后禁止 startTask + recordCompatReport
    const direct = new CoopRuntimeV1({ now: () => clock });
    direct.joinParticipant({ participantId: 'ai-solo', kind: 'ai', characterId: 'char_xiaojing', displayName: 'Solo' });
    const soloTask = direct.proposeTask({ title: '浇水', goal: '农场', ownerId: 'ai-solo' });
    direct.acceptTask(soloTask.taskId);
    direct.emergencyHaltAll('急停阻断启动');
    expect(direct.startTask(soloTask.taskId).ok).toBe(false);
    expect(direct.acceptTask(soloTask.taskId, 'missing-member').ok).toBe(false);
    const sampleCompat = evaluateCoopModsCompatibility({
      hostMods: [{ uniqueId: 'WhaleIsle.BlindWhaleFarmer', name: 'BWF', version: '1.0.0', enabled: true, contentType: 'SMAPI' }],
      peerMods: [{ uniqueId: 'WhaleIsle.BlindWhaleFarmer', name: 'BWF', version: '1.0.0', enabled: true, contentType: 'SMAPI' }],
      hostModsDir: '/host/Mods',
      peerModsDir: '/peer/Mods',
    });
    direct.recordCompatReport(sampleCompat);
    expect(direct.snapshot().lastCompatReport?.hostModsDir).toBe('/host/Mods');
  });
});
