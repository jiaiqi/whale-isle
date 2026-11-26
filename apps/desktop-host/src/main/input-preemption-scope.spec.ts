/**
 * ADR-004 回归（V2-P3-03）：
 * 星露谷 AI 自主模式下注入一次用户物理输入事件，断言
 *   - GameCharacterControlLease 完全不受影响（保持 T-M6-73）
 *   - 同一设备的 ComputerUseLease 被 ≤1s 撤销
 * 同时验证执行器自身注入的合成事件不会误伤桌面租约，P0 急停会同时撤销两者。
 */
import { describe, expect, it } from 'vitest';
import { GameCharacterControlLease } from '@workbench/game-bridge-mcp';
import { ComputerUseLeaseManager, HumanInputMonitor } from '@workbench/runtime-core';

describe('[SIMULATION] ADR-004 输入抢占作用域：游戏租约 ≠ 桌面租约', () => {
  it('星露谷 AI 自主运行时注入用户输入：游戏租约保持 AI，ComputerUseLease 被撤销', () => {
    let clock = 10_000;
    let idleSeconds = 60;

    const gameLease = new GameCharacterControlLease({
      characterId: 'char_xiaojing',
      gameId: 'stardew',
      sessionId: 'stardew-e2e-session',
      now: () => clock,
    });
    expect(gameLease.acquireAi('星露谷 AI 自主游玩')).toMatchObject({ ok: true });
    expect(gameLease.owner).toBe('ai');
    expect(gameLease.canAiAct()).toBe(true);

    const computerLeases = new ComputerUseLeaseManager({ now: () => clock, humanOverrideHoldMs: 2_000 });
    const desktop = computerLeases.acquireLease({
      deviceId: 'host-primary',
      holderId: 'agent-xiaojing',
      characterId: 'char_xiaojing',
      purpose: 'Computer Use：整理桌面',
      ttlMs: 60_000,
    });
    expect(desktop.ok).toBe(true);

    const monitor = new HumanInputMonitor({
      readIdleSeconds: () => idleSeconds,
      onHumanInput: () => {
        computerLeases.notifyHumanInput('host-primary', '用户物理键鼠输入（ADP-004 回归）');
      },
      now: () => clock,
    });

    // 用户真的动了鼠标：idle 归零 → 只撤销桌面租约
    idleSeconds = 0;
    expect(monitor.pollOnce()).toMatchObject({ humanInput: true, idleSeconds: 0 });

    expect(computerLeases.listActive()).toHaveLength(0);
    expect(computerLeases.validateLease(desktop.lease!.leaseId).reason).toBe('LEASE_NOT_FOUND');
    expect(computerLeases.listHumanOverrides()).toEqual(['host-primary']);

    // 关键断言：游戏角色租约纹丝不动（T-M6-73）
    expect(gameLease.owner).toBe('ai');
    expect(gameLease.canAiAct()).toBe(true);
    expect(gameLease.snapshot()).toMatchObject({ owner: 'ai', gameId: 'stardew', characterId: 'char_xiaojing' });

    // 执行器自己合成的键鼠事件被排除，不会误判成用户输入
    clock += 3_000;
    expect(computerLeases.listHumanOverrides()).toEqual([]);
    const reacquired = computerLeases.acquireLease({
      deviceId: 'host-primary',
      holderId: 'agent-xiaojing',
      characterId: 'char_xiaojing',
      purpose: 'Computer Use：继续整理',
      ttlMs: 60_000,
    });
    expect(reacquired.ok).toBe(true);
    monitor.noteSyntheticInput(clock);
    idleSeconds = 0;
    expect(monitor.pollOnce()).toMatchObject({ humanInput: false, reason: 'synthetic_excluded' });
    expect(computerLeases.validateLease(reacquired.lease!.leaseId).ok).toBe(true);
    expect(gameLease.owner).toBe('ai');

    // P0 急停同时撤销两种租约
    gameLease.emergencyStop('P0 急停');
    const revoked = computerLeases.emergencyHalt('P0 急停');
    expect(revoked).toBe(1);
    expect(gameLease.owner).toBe('halted');
    expect(gameLease.canAiAct()).toBe(false);
    expect(computerLeases.listActive()).toHaveLength(0);
    expect(computerLeases.isHalted()).toBe(true);
  });
});
