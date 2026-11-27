/** V2-P2-10：启动早期 IPC 的纯计算与注册（确定性单测，不启动 Electron）。 */
import { describe, expect, it, vi } from 'vitest';
import {
  BOOT_ERRORS_GLOBAL,
  computeSleepStatus,
  installBootErrorRecorder,
  registerEarlyIpc,
  type EarlyIpcHost,
  type PetSleepStatus,
} from './boot-ipc';

describe('computeSleepStatus', () => {
  it('冷启动无睡眠：空在场 + 空睡眠集合 → { ok: true, asleep: false, count: 0 }', () => {
    expect(computeSleepStatus({ agentIds: [], asleepAgents: new Set() }))
      .toEqual({ ok: true, asleep: false, count: 0 });
  });

  it('有睡眠 agent 时只统计「在场且睡眠」的数量', () => {
    expect(computeSleepStatus({
      agentIds: ['default', 'crosspet-claude', 'egg-fox-1'],
      asleepAgents: new Set(['default', 'egg-fox-1']),
    })).toEqual({ ok: true, asleep: true, count: 2 });
  });

  it('睡眠集合里残留的离场 agent 不计入（不以集合大小冒充计数）', () => {
    expect(computeSleepStatus({
      agentIds: ['default'],
      asleepAgents: new Set(['default', 'already-closed']),
    })).toEqual({ ok: true, asleep: true, count: 1 });
    expect(computeSleepStatus({
      agentIds: [],
      asleepAgents: new Set(['already-closed']),
    })).toEqual({ ok: true, asleep: false, count: 0 });
  });
});

function fakeIpcMain(): { ipcMain: EarlyIpcHost; handlers: Map<string, (event: unknown) => unknown> } {
  const handlers = new Map<string, (event: unknown) => unknown>();
  return {
    handlers,
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
  };
}

describe('registerEarlyIpc', () => {
  it('只注册 pet:sleep-status，且 handler 惰性读取当前在场列表与睡眠集合', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    let agentIds: string[] = [];
    const asleepAgents = new Set<string>();
    registerEarlyIpc({ ipcMain, asleepAgents, listAgentIds: () => agentIds });

    expect([...handlers.keys()]).toEqual(['pet:sleep-status']);
    const invoke = (): PetSleepStatus => handlers.get('pet:sleep-status')!({}) as PetSleepStatus;

    // 注册时 petWindowManager 尚未初始化：空列表也必须给出正确答案，而不是抛错或 undefined。
    expect(invoke()).toEqual({ ok: true, asleep: false, count: 0 });

    agentIds = ['default'];
    asleepAgents.add('default');
    expect(invoke()).toEqual({ ok: true, asleep: true, count: 1 });
  });
});

describe('installBootErrorRecorder', () => {
  it('原样转发 console.error，并留档到 globalThis，供 E2E 断言启动竞态', () => {
    const original = vi.fn();
    const target = { error: original };
    const recorded = installBootErrorRecorder(target);

    target.error('Error occurred in handler for \'pet:sleep-status\':', new Error('No handler registered for \'pet:sleep-status\''));
    target.error('其它启动日志');

    expect(original).toHaveBeenCalledTimes(2);
    expect(recorded).toEqual([
      "Error occurred in handler for 'pet:sleep-status': Error: No handler registered for 'pet:sleep-status'",
      '其它启动日志',
    ]);
    expect((globalThis as Record<string, unknown>)[BOOT_ERRORS_GLOBAL]).toBe(recorded);
  });
});
