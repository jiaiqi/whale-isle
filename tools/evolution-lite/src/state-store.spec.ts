import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvolutionStateStore, runCli } from './index';

describe('EvolutionStateStore & CLI', () => {
  it('enforces unique active ticket invariant, resolves dependencies, and persists across sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-state-'));
    try {
      const statePath = join(dir, 'state.json');
      let seq = 0;
      const nowIso = () => `2026-11-25T15:00:0${++seq}.000Z`;
      const s1 = new EvolutionStateStore(statePath, nowIso);

      s1.addTask({
        id: 'T1',
        title: '基础任务',
        goal: '实现底座',
        branchName: 'evo/t1',
        status: 'NEXT',
      });
      s1.addTask({
        id: 'T2',
        title: '下游任务',
        goal: '依赖 T1',
        branchName: 'evo/t2',
        dependsOn: ['T1'],
      });

      expect(() =>
        s1.addTask({
          id: 'T3',
          title: '越权并发',
          goal: 'violate unique NEXT',
          branchName: 'evo/t3',
          status: 'NEXT',
        }),
      ).toThrow(/唯一激活工单/);
      expect(() =>
        s1.addTask({
          id: 'T1',
          title: '重复',
          goal: 'dup',
          branchName: 'evo/t1-dup',
        }),
      ).toThrow(/已存在/);
      expect(() => s1.startTask('T2')).toThrow(/依赖未满足/);

      const started = s1.startTask('T1');
      expect(started.status).toBe('DOING');
      expect(started.attempts).toBe(1);

      // 跨会话重建实例恢复状态
      const s2 = new EvolutionStateStore(statePath, nowIso);
      expect(s2.resumeOrPickNext()?.id).toBe('T1');
      s2.markBlocked('T1', '编译失败');
      expect(s2.getTask('T1')?.lastError).toBe('编译失败');

      s2.reopen('T1', '修复后重跑');
      expect(s2.resumeOrPickNext()?.id).toBe('T1');
      s2.startTask('T1');
      s2.markImplementedUnverified('T1', '待真机验证');
      s2.markDone('T1', '真机通过');

      const next = s2.resumeOrPickNext();
      expect(next?.id).toBe('T2');
      expect(s2.renderProgressMarkdown()).toContain('| T1 | `DONE` |');
      expect(s2.snapshot().history.length).toBeGreaterThanOrEqual(5);
      expect(s2.listTasks()).toHaveLength(2);
      expect(s2.getTask('MISSING')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers safely from corrupt state files and handles CLI subcommands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-cli-'));
    try {
      const evoDir = join(dir, '.evolution-lite');
      const statePath = join(evoDir, 'state.json');
      const store = new EvolutionStateStore(statePath);
      store.addTask({
        id: 'T-CLI',
        title: 'CLI 任务',
        goal: 'test cli',
        branchName: 'evo/cli',
      });
      expect(runCli(['next'], dir).output).toContain('T-CLI');
      expect(runCli(['status'], dir).exitCode).toBe(0);
      expect(runCli(['unknown'], dir).exitCode).toBe(1);

      writeFileSync(statePath, '{corrupt', 'utf8');
      const recovered = new EvolutionStateStore(statePath);
      expect(recovered.listTasks()).toEqual([]);
      expect(runCli(['next'], dir).output).toBe('无可执行工单');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
