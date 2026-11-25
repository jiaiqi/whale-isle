import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCliAgentArgs,
  CliCodingAgentAdapter,
  defaultGateRunner,
  EvolutionLiteOrchestrator,
  EvolutionStateStore,
  GitWorktreeManager,
  sanitizedGitEnv,
  type CodingAgentAdapter,
} from './index';

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: sanitizedGitEnv() }).trim();
}

function initTempRepo(root: string): string {
  const repoDir = join(root, 'repo');
  execFileSync('mkdir', ['-p', repoDir]);
  runGit(['init', '-b', 'feat/whale-isle-v2'], repoDir);
  runGit(['config', 'user.email', 'evo@whaleisle.local'], repoDir);
  runGit(['config', 'user.name', 'Whale Evo'], repoDir);
  writeFileSync(join(repoDir, 'index.ts'), 'export const v = 1;\n', 'utf8');
  runGit(['add', 'index.ts'], repoDir);
  runGit(['commit', '-m', 'init'], repoDir);
  return repoDir;
}

describe('EvolutionLiteOrchestrator & CliCodingAgentAdapter', () => {
  it('completes isolated worktree → agent → gate → reviewer → PR draft without touching prod repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evo-pipe-ok-'));
    try {
      const repoDir = initTempRepo(root);
      const worktreeRoot = join(root, 'worktrees');
      const reportsDir = join(root, 'reports');
      const store = new EvolutionStateStore(join(root, 'state.json'));

      store.addTask({
        id: 'EVO-1',
        title: '新增工具函数',
        goal: '在隔离目录添加 helper.ts',
        branchName: 'evo/evo-1',
        acceptanceCriteria: ['导出的 helper 返回 42'],
      });
      store.addTask({
        id: 'EVO-2',
        title: '真机待验任务',
        goal: '验证 IMPLEMENTED_UNVERIFIED 语义',
        branchName: 'evo/evo-2',
        requiresRealDeviceVerification: true,
        dependsOn: ['EVO-1'],
      });

      const fakeAdapter: CodingAgentAdapter = {
        name: 'fake-agent',
        isAvailable: () => true,
        execute: async ({ worktreePath, task }) => {
          const target = join(worktreePath, `${task.id}.ts`);
          writeFileSync(target, `export const id = "${task.id}";\n`, 'utf8');
          runGit(['add', `${task.id}.ts`], worktreePath);
          runGit(['commit', '-m', `implement ${task.id}`], worktreePath);
          return {
            ok: true,
            summary: `已生成 ${task.id}.ts`,
            changedFiles: [`${task.id}.ts`],
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
            timedOut: false,
          };
        },
      };

      const orchestrator = new EvolutionLiteOrchestrator({
        store,
        worktrees: new GitWorktreeManager(repoDir),
        adapter: fakeAdapter,
        worktreeRoot,
        reportsDir,
        gateRunner: () => ({ ok: true, summary: '7/7 PASS', stdout: '', stderr: '', durationMs: 12 }),
      });

      const r1 = await orchestrator.runNext();
      expect(r1?.outcome).toBe('READY_FOR_REVIEW');
      expect(r1?.prDraft?.title).toContain('EVO-1');
      expect(existsSync(join(repoDir, 'EVO-1.ts'))).toBe(false);
      expect(existsSync(join(reportsDir, 'EVO-1.json'))).toBe(true);
      expect(store.getTask('EVO-1')?.status).toBe('DONE');

      // 第二个任务 requiresRealDeviceVerification=true → 标为 IMPLEMENTED_UNVERIFIED（诚实口径）
      const r2 = await orchestrator.runNext();
      expect(r2?.outcome).toBe('IMPLEMENTED_UNVERIFIED');
      expect(store.getTask('EVO-2')?.status).toBe('IMPLEMENTED_UNVERIFIED');

      // 无更多任务
      expect(await orchestrator.runNext()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('halts cleanly and writes BLOCKED report when adapter, gate, or review fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evo-pipe-fail-'));
    try {
      const repoDir = initTempRepo(root);
      const worktreeRoot = join(root, 'worktrees');
      const reportsDir = join(root, 'reports');
      const store = new EvolutionStateStore(join(root, 'state.json'));

      store.addTask({ id: 'F-UNAVAIL', title: '无 Agent', goal: 'g', branchName: 'evo/f1' });
      store.addTask({ id: 'F-GATE', title: '门禁失败', goal: 'g', branchName: 'evo/f2' });
      store.addTask({ id: 'F-REVIEW', title: '审查失败', goal: 'g', branchName: 'evo/f3' });
      store.addTask({ id: 'F-CRASH', title: 'Agent失败', goal: 'g', branchName: 'evo/f4' });

      const unavail = new EvolutionLiteOrchestrator({
        store,
        worktrees: new GitWorktreeManager(repoDir),
        adapter: {
          name: 'offline',
          isAvailable: () => false,
          execute: async () => { throw new Error('should not run'); },
        },
        worktreeRoot,
        reportsDir,
        cleanupOnFailure: true,
      });
      const rUnavail = await unavail.runNext('F-UNAVAIL');
      expect(rUnavail?.outcome).toBe('BLOCKED');
      expect(rUnavail?.prDraft).toBeUndefined();
      expect(store.getTask('F-UNAVAIL')?.status).toBe('BLOCKED');

      const gateFail = new EvolutionLiteOrchestrator({
        store,
        worktrees: new GitWorktreeManager(repoDir),
        adapter: {
          name: 'ok-agent',
          isAvailable: () => true,
          execute: async () => ({
            ok: true, summary: 'done', changedFiles: ['a.ts'], stdout: '', stderr: '', exitCode: 0, timedOut: false,
          }),
        },
        worktreeRoot,
        reportsDir,
        gateRunner: () => ({ ok: false, summary: 'typecheck error', stdout: '', stderr: 'err', durationMs: 5 }),
      });
      const rGate = await gateFail.runNext('F-GATE');
      expect(rGate?.outcome).toBe('BLOCKED');
      expect(rGate?.failureReason).toContain('门禁未通过');

      const reviewFail = new EvolutionLiteOrchestrator({
        store,
        worktrees: new GitWorktreeManager(repoDir),
        adapter: {
          name: 'empty-agent',
          isAvailable: () => true,
          execute: async () => ({
            ok: true, summary: 'nothing changed', changedFiles: [], stdout: '', stderr: '', exitCode: 0, timedOut: false,
          }),
        },
        worktreeRoot,
        reportsDir,
        gateRunner: () => ({ ok: true, summary: 'ok', stdout: '', stderr: '', durationMs: 1 }),
      });
      const rRev = await reviewFail.runNext('F-REVIEW');
      expect(rRev?.outcome).toBe('BLOCKED');
      expect(rRev?.failureReason).toContain('独立审查未通过');

      const crashFail = new EvolutionLiteOrchestrator({
        store,
        worktrees: new GitWorktreeManager(repoDir),
        adapter: {
          name: 'fail-agent',
          isAvailable: () => true,
          execute: async () => ({
            ok: false, summary: 'exit 2', changedFiles: [], stdout: '', stderr: 'boom', exitCode: 2, timedOut: false,
          }),
        },
        worktreeRoot,
        reportsDir,
      });
      const rCrash = await crashFail.runNext('F-CRASH');
      expect(rCrash?.outcome).toBe('BLOCKED');
      const savedReport = JSON.parse(readFileSync(join(reportsDir, 'F-CRASH.json'), 'utf8')) as { outcome: string };
      expect(savedReport.outcome).toBe('BLOCKED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds CLI args cleanly for supported harnesses and handles spawn/timeout/abort/gate', async () => {
    expect(buildCliAgentArgs('codex', 'hi')).toEqual({ command: 'codex', args: ['exec', 'hi'] });
    expect(buildCliAgentArgs('claude', 'hi')).toEqual({ command: 'claude', args: ['-p', 'hi'] });
    expect(buildCliAgentArgs('gemini', 'hi')).toEqual({ command: 'gemini', args: ['-p', 'hi'] });
    expect(buildCliAgentArgs('dsh', 'hi')).toEqual({ command: 'dsh', args: ['run', 'hi'] });

    const adapter = new CliCodingAgentAdapter('codex');
    expect(typeof adapter.isAvailable()).toBe('boolean');

    const root = mkdtempSync(join(tmpdir(), 'evo-cli-exec-'));
    try {
      const dummyTask = {
        id: 'CLI-1',
        title: 't',
        goal: 'g',
        branchName: 'evo/c1',
        baseBranch: 'feat/whale-isle-v2',
        status: 'DOING' as const,
        dependsOn: [],
        acceptanceCriteria: ['ok'],
        requiresRealDeviceVerification: false,
        maxFiles: 8,
        attempts: 1,
        lastError: null,
        createdAt: '2026-11-25T00:00:00Z',
        updatedAt: '2026-11-25T00:00:00Z',
      };

      // 不存在的命令 isAvailable() 为 false；spawn error 事件安全返回 ok=false
      const missing = new CliCodingAgentAdapter('nonexistent-cli-xyz' as never);
      expect(missing.isAvailable()).toBe(false);

      // 注入 fake spawn 验证 error / 正常退出 / stdout+stderr 收集 / abort / 超时
      const makeFakeSpawn = (behavior: 'ok' | 'timeout' | 'abort' | 'error') => {
        return (() => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            kill: (sig?: string) => void;
          };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {
            setTimeout(() => child.emit('close', null), 5);
          };
          if (behavior === 'error') {
            setTimeout(() => child.emit('error', new Error('ENOENT')), 5);
          } else if (behavior === 'ok') {
            setTimeout(() => {
              child.stdout.emit('data', Buffer.from('done'));
              child.stderr.emit('data', Buffer.from('warn'));
              child.emit('close', 0);
            }, 5);
          }
          return child as never;
        }) as unknown as typeof import('node:child_process').spawn;
      };

      const errAdapter = new CliCodingAgentAdapter('codex', { spawnImpl: makeFakeSpawn('error') });
      const errRes = await errAdapter.execute({ task: dummyTask, worktreePath: root, contextMarkdown: '' });
      expect(errRes.ok).toBe(false);
      expect(errRes.exitCode).toBeNull();

      const okAdapter = new CliCodingAgentAdapter('codex', { spawnImpl: makeFakeSpawn('ok') });
      const okRes = await okAdapter.execute({ task: dummyTask, worktreePath: root, contextMarkdown: 'ctx' });
      expect(okRes.ok).toBe(true);
      expect(okRes.stdout).toBe('done');
      expect(okRes.stderr).toBe('warn');

      const timeoutAdapter = new CliCodingAgentAdapter('codex', { spawnImpl: makeFakeSpawn('timeout') });
      const timeoutRes = await timeoutAdapter.execute(
        { task: dummyTask, worktreePath: root, contextMarkdown: '' },
        { timeoutMs: 15 },
      );
      expect(timeoutRes.ok).toBe(false);
      expect(timeoutRes.timedOut).toBe(true);

      const controller = new AbortController();
      const abortAdapter = new CliCodingAgentAdapter('codex', { spawnImpl: makeFakeSpawn('abort') });
      setTimeout(() => controller.abort(), 5);
      const abortRes = await abortAdapter.execute(
        { task: dummyTask, worktreePath: root, contextMarkdown: '' },
        { signal: controller.signal },
      );
      expect(abortRes.ok).toBe(false);

      // defaultGateRunner 在无门禁脚本的空目录中明确失败且不抛异常
      const gateRes = defaultGateRunner(root);
      expect(gateRes.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
