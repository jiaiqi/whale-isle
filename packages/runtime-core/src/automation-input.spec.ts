import { describe, expect, it } from 'vitest';
import { HumanInputMonitor } from './human-input-monitor';
import { ComputerInputExecutor } from './input-executor';
import { ComputerUseLeaseManager } from './automation-security';
import { DeterministicBrowserRunner, planDeterministicBrowserTask } from './browser-runner';

function makeMonitor(options: {
  idle: () => number;
  now: () => number;
  onHumanInput?: (info: { idleSeconds: number; at: number }) => void;
}) {
  let tick: (() => void) | null = null;
  let cleared = false;
  const monitor = new HumanInputMonitor({
    readIdleSeconds: options.idle,
    onHumanInput: options.onHumanInput ?? (() => undefined),
    now: options.now,
    setTimer: (handler) => {
      tick = handler;
      return 'handle';
    },
    clearTimer: () => {
      cleared = true;
      tick = null;
    },
  });
  return {
    monitor,
    tick: () => tick?.(),
    wasCleared: () => cleared,
  };
}

describe('[SIMULATION] V2-P3-03 用户物理输入检测（powerMonitor idle 轮询 + 合成事件排除）', () => {
  it('idle ≤1s 触发一次抢占回调，连续输入按最小间隔去重', () => {
    let clock = 10_000;
    const signals: Array<{ idleSeconds: number; at: number }> = [];
    let idle = 30;
    const { monitor, tick, wasCleared } = makeMonitor({ idle: () => idle, now: () => clock, onHumanInput: (info) => signals.push(info) });

    expect(monitor.pollOnce()).toMatchObject({ humanInput: false, reason: 'no_recent_activity', idleSeconds: 30 });
    idle = 1;
    expect(monitor.pollOnce()).toMatchObject({ humanInput: true, reason: 'idle_active', idleSeconds: 1 });
    expect(signals).toHaveLength(1);

    clock += 500;
    expect(monitor.pollOnce()).toMatchObject({ humanInput: false, reason: 'idle_active' });
    clock += 600;
    expect(monitor.pollOnce().humanInput).toBe(true);
    expect(signals).toHaveLength(2);

    monitor.start();
    expect(monitor.isRunning()).toBe(true);
    monitor.start(); // 幂等
    tick();
    expect(monitor.status().polls).toBeGreaterThanOrEqual(4);
    monitor.stop();
    monitor.stop();
    expect(wasCleared()).toBe(true);
    expect(monitor.isRunning()).toBe(false);
  });

  it('执行器自身注入的合成事件在排除窗口内不触发人类抢占', () => {
    let clock = 1_000;
    let idle = 0;
    const signals: number[] = [];
    const { monitor } = makeMonitor({ idle: () => idle, now: () => clock, onHumanInput: ({ at }) => signals.push(at) });

    monitor.noteSyntheticInput(clock);
    expect(monitor.pollOnce()).toMatchObject({ humanInput: false, reason: 'synthetic_excluded' });
    expect(monitor.status().syntheticExcluded).toBe(1);
    expect(signals).toHaveLength(0);

    clock += 2_001;
    idle = 1;
    expect(monitor.pollOnce().humanInput).toBe(true);
    expect(signals).toEqual([clock]);
    expect(monitor.status().lastHumanInputAt).toBe(clock);
    expect(monitor.status().lastSyntheticAt).toBe(1_000);
  });

  it('idle 读取失败或返回非法值时安全返回 read_failed，不误判为用户输入', () => {
    let clock = 0;
    let mode: 'throw' | 'nan' | 'ok' = 'throw';
    const { monitor } = makeMonitor({
      idle: () => {
        if (mode === 'throw') throw new Error('powerMonitor unavailable');
        if (mode === 'nan') return Number.NaN;
        return 0;
      },
      now: () => clock,
    });
    expect(monitor.pollOnce()).toMatchObject({ humanInput: false, reason: 'read_failed', idleSeconds: null });
    mode = 'nan';
    expect(monitor.pollOnce().reason).toBe('read_failed');
    mode = 'ok';
    clock = 5_000;
    expect(monitor.pollOnce()).toMatchObject({ humanInput: true, idleSeconds: 0 });
    expect(monitor.status().detected).toBe(1);
  });
});

describe('[SIMULATION] V2-P3-03c OS 输入执行器：默认 dry-run、逐动作校验租约、权限不足如实拒绝', () => {
  it('默认关闭时只记录意图，不要求租约也不注入任何事件', () => {
    let synthetic = 0;
    const leases = new ComputerUseLeaseManager();
    const executor = new ComputerInputExecutor({
      leases,
      onSyntheticInput: () => {
        synthetic += 1;
      },
    });
    const result = executor.execute(null, { kind: 'click', x: 1, y: 2, detail: '打开菜单' });
    expect(result).toMatchObject({ ok: true, executed: false, mode: 'dry_run', code: 'feature_disabled' });
    expect(result.detail).toContain('打开菜单');
    expect(executor.status()).toMatchObject({ enabled: false, mode: 'disabled', dryRunCount: 1 });
    expect(synthetic).toBe(0);
  });

  it('开启后缺少租约/权限/注入器时分别如实拒绝，绝不假装执行成功', () => {
    let clock = 1_000;
    const leases = new ComputerUseLeaseManager({ now: () => clock });
    const executor = new ComputerInputExecutor({ leases, enabled: true, permissionProbe: () => 'granted' });
    expect(executor.execute(null, { kind: 'move', x: 10, y: 10 })).toMatchObject({ ok: false, code: 'lease_required' });

    const lease = leases.acquireLease({ holderId: 'agent', characterId: 'char_xiaojing', purpose: 'dry-run', ttlMs: 5_000 });
    expect(executor.execute(lease.lease!.leaseId, { kind: 'move', x: 10, y: 10 })).toMatchObject({
      ok: false,
      executed: false,
      code: 'not_implemented',
    });
    expect(executor.status()).toMatchObject({ enabled: true, mode: 'dry_run', permission: 'granted', dryRunCount: 1 });

    const denied = new ComputerInputExecutor({ leases, enabled: true, permissionProbe: () => 'denied', nativeInjector: () => undefined });
    expect(denied.execute(lease.lease!.leaseId, { kind: 'click' })).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(denied.execute(lease.lease!.leaseId, { kind: 'click' }).detail).toContain('辅助功能');
    const unknown = new ComputerInputExecutor({ leases, enabled: true, permissionProbe: () => 'unknown', nativeInjector: () => undefined });
    expect(unknown.execute(lease.lease!.leaseId, { kind: 'click' })).toMatchObject({ ok: false, code: 'permission_denied' });

    clock += 6_000;
    expect(executor.execute(lease.lease!.leaseId, { kind: 'key', key: 'Return' })).toMatchObject({ ok: false, code: 'lease_required' });
  });

  it('注入成功会登记合成事件时间戳；注入抛错则如实失败', () => {
    let clock = 2_000;
    const leases = new ComputerUseLeaseManager({ now: () => clock });
    const injected: string[] = [];
    const syntheticAt: number[] = [];
    const executor = new ComputerInputExecutor({
      leases,
      enabled: true,
      permissionProbe: () => 'granted',
      nativeInjector: (step) => injected.push(step.kind),
      onSyntheticInput: (at) => syntheticAt.push(at),
      now: () => clock,
    });
    const lease = leases.acquireLease({ holderId: 'agent', characterId: 'char_xiaojing', purpose: 'live' });
    const ok = executor.execute(lease.lease!.leaseId, { kind: 'type_text', text: 'hello' });
    expect(ok).toMatchObject({ ok: true, executed: true, mode: 'live', code: 'executed' });
    expect(injected).toEqual(['type_text']);
    expect(syntheticAt).toEqual([clock]);
    expect(executor.status()).toMatchObject({ executedCount: 1, mode: 'live', lastIntentAt: clock });

    const failing = new ComputerInputExecutor({
      leases,
      enabled: true,
      permissionProbe: () => 'granted',
      nativeInjector: () => {
        throw new Error('CGEvent 注入失败');
      },
    });
    expect(failing.execute(lease.lease!.leaseId, { kind: 'move', x: 1, y: 1 })).toMatchObject({ ok: false, code: 'not_implemented' });
    expect(failing.status().rejectedCount).toBe(1);

    leases.emergencyHalt('F8');
    expect(executor.execute(lease.lease!.leaseId, { kind: 'click' })).toMatchObject({ ok: false, code: 'lease_required' });
    expect(executor.execute(lease.lease!.leaseId, { kind: 'click' }).detail).toContain('EMERGENCY_HALT_ACTIVE');
    executor.setEnabled(false);
    expect(executor.isEnabled()).toBe(false);
  });
});

describe('[SIMULATION] V2-P3-03b 确定性执行器的失败路径与默认配置分支', () => {
  const baseReq = {
    taskId: 't', characterId: 'c', profileId: 'p', url: 'https://example.com/',
    action: 'read' as const, riskLevel: 'P1' as const, preferDeterministic: true,
    hasExplicitUserConfirm: false, hasP4Approval: false, pageHints: [], deviceId: 'host-primary',
  };
  const profile = {
    profileId: 'p', characterId: 'c', accountId: 'a', profileDir: '/tmp/not-used',
    isolatedFromUserDaily: true, loggedInOrigins: [], cookieCount: 0, status: 'ready' as const, updatedAt: 0,
  };

  it('未注入引擎时如实返回 runner_unavailable', async () => {
    const runner = new DeterministicBrowserRunner();
    expect(runner.hasEngine()).toBe(false);
    const result = await runner.run(baseReq, { profile, guard: () => ({ ok: true }) });
    expect(result.status).toBe('runner_unavailable');
    expect(result.engine).toBe('none');
  });

  it('执行前 guard 拒绝、执行中撤销、引擎抛错与 dispose 抛错都安全收敛', async () => {
    const preflight = new DeterministicBrowserRunner({
      engineFactory: () => ({
        kind: 'playwright',
        load: async () => ({ url: 'https://example.com/', title: 't', text: 'ok' }),
        click: async () => undefined,
        fill: async () => undefined,
        extract: async () => ({ title: 't', text: 'ok' }),
        dispose: async () => undefined,
      }),
    });
    const blocked = await preflight.run(baseReq, { profile, guard: () => ({ ok: false, reason: 'DEVICE_HELD_BY_HUMAN' }) });
    expect(blocked).toMatchObject({ status: 'blocked', pauseReason: 'lease_revoked', stepCount: 0 });

    // 执行中租约被撤销：load 回调里翻转 guard
    let allowed = true;
    const midRun = new DeterministicBrowserRunner({
      engineFactory: () => ({
        kind: 'electron',
        load: async () => {
          allowed = false;
          return { url: 'https://example.com/', title: 't', text: 'ok' };
        },
        click: async () => undefined,
        fill: async () => undefined,
        extract: async () => ({ title: 't', text: 'ok' }),
        dispose: async () => undefined,
      }),
    });
    const revoked = await midRun.run(
      { ...baseReq, action: 'extract_dom' },
      { profile, guard: () => (allowed ? { ok: true } : { ok: false, reason: 'EMERGENCY_HALT_ACTIVE' }) },
    );
    expect(revoked).toMatchObject({ status: 'blocked', pauseReason: 'emergency_halt' });

    const throwing = new DeterministicBrowserRunner({
      engineFactory: () => ({
        kind: 'electron',
        load: async () => {
          throw '非 Error 抛出';
        },
        click: async () => undefined,
        fill: async () => undefined,
        extract: async () => ({ title: 't', text: 'ok' }),
        dispose: async () => {
          throw new Error('dispose 失败');
        },
      }),
    });
    const failed = await throwing.run(baseReq, { profile, guard: () => ({ ok: true }) });
    expect(failed.status).toBe('blocked');
    expect(failed.detail).toContain('非 Error 抛出');
  });

  it('默认构造的 monitor 使用真实定时器，executor 默认权限未知时 fail-closed', async () => {
    const monitor = new HumanInputMonitor({ readIdleSeconds: () => 60, onHumanInput: () => undefined, pollIntervalMs: 50 });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    monitor.stop();
    expect(monitor.status().polls).toBeGreaterThanOrEqual(1);

    const leases = new ComputerUseLeaseManager();
    const lease = leases.acquireLease({ holderId: 'a', characterId: 'c', purpose: 'default' });
    const executor = new ComputerInputExecutor({ leases, enabled: true, nativeInjector: () => undefined });
    expect(executor.status()).toMatchObject({ permission: 'unknown', mode: 'dry_run' });
    expect(executor.execute(lease.lease!.leaseId, { kind: 'click' })).toMatchObject({ ok: false, code: 'permission_denied' });
  });
});

describe('[SIMULATION] V2-P3-03 计划器与执行器的缺省/异常分支', () => {
  const baseReq = {
    taskId: 't', characterId: 'c', profileId: 'p', url: 'https://example.com/',
    action: 'read' as const, riskLevel: 'P1' as const, preferDeterministic: true,
    hasExplicitUserConfirm: false, hasP4Approval: false, pageHints: [], deviceId: 'host-primary',
  };

  it('缺少 selector 时计划器只导航；填写计划缺省输入文本为空串', () => {
    expect(planDeterministicBrowserTask({ ...baseReq, action: 'click_selector' }).map((s) => s.kind)).toEqual(['navigate']);
    expect(planDeterministicBrowserTask({ ...baseReq, action: 'fill_form' }).map((s) => s.kind)).toEqual(['navigate']);
    expect(planDeterministicBrowserTask({ ...baseReq, action: 'delete' }).map((s) => s.kind)).toEqual(['navigate']);
    expect(planDeterministicBrowserTask({ ...baseReq, action: 'fill_form', selector: '#q' })[1]).toMatchObject({ kind: 'fill', value: '' });
  });

  it('执行器对缺省 detail、无 reason 的租约、无 lease 对象与非 Error 注入异常都保持 fail-closed', () => {
    const disabled = new ComputerInputExecutor({ leases: new ComputerUseLeaseManager() });
    expect(disabled.execute(null, { kind: 'click' }).detail).toContain('click');

    const noReason = new ComputerInputExecutor({
      leases: { validateLease: () => ({ ok: false }) },
      enabled: true,
      permissionProbe: () => 'granted',
      nativeInjector: () => undefined,
    });
    expect(noReason.execute('lease-x', { kind: 'click' })).toMatchObject({ ok: false, code: 'lease_required' });
    expect(noReason.execute('lease-x', { kind: 'click' }).detail).toContain('未持有有效 ComputerUseLease');

    const noLease = new ComputerInputExecutor({
      leases: { validateLease: () => ({ ok: true }) },
      enabled: true,
      permissionProbe: () => 'granted',
      nativeInjector: () => undefined,
    });
    const ok = noLease.execute('lease-x', { kind: 'click' });
    expect(ok).toMatchObject({ ok: true, executed: true, code: 'executed' });
    expect(ok.detail).toContain('unknown');

    const leases = new ComputerUseLeaseManager();
    const lease = leases.acquireLease({ holderId: 'a', characterId: 'c', purpose: 'string-throw' });
    const throwsString = new ComputerInputExecutor({
      leases,
      enabled: true,
      permissionProbe: () => 'granted',
      nativeInjector: () => {
        throw '原生注入器异常';
      },
    });
    const failed = throwsString.execute(lease.lease!.leaseId, { kind: 'move', x: 1, y: 1 });
    expect(failed).toMatchObject({ ok: false, code: 'not_implemented' });
    expect(failed.detail).toContain('原生注入器异常');
  });

  it('monitor 在定时器句柄为空时停止不调用 clearTimer', () => {
    let cleared = 0;
    const monitor = new HumanInputMonitor({
      readIdleSeconds: () => 60,
      onHumanInput: () => undefined,
      setTimer: () => null as unknown as ReturnType<typeof setInterval>,
      clearTimer: () => {
        cleared += 1;
      },
    });
    monitor.start();
    monitor.stop();
    expect(cleared).toBe(0);
    expect(monitor.isRunning()).toBe(false);
  });
});
