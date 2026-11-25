import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertIsolatedWorktreePath,
  GitWorktreeManager,
  IndependentReviewer,
  sanitizedGitEnv,
} from './index';

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: sanitizedGitEnv() }).trim();
}

describe('GitWorktreeManager（真实临时 Git 仓库隔离验证）& IndependentReviewer', () => {
  it('enforces isolation outside repoRoot and manages real git worktree lifecycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'evo-git-'));
    try {
      const repoDir = join(root, 'prod-repo');
      const worktreeRoot = join(root, 'isolated-worktrees');
      execFileSync('mkdir', ['-p', repoDir]);
      runGit(['init', '-b', 'feat/whale-isle-v2'], repoDir);
      runGit(['config', 'user.email', 'evo@whaleisle.local'], repoDir);
      runGit(['config', 'user.name', 'Whale Evo'], repoDir);
      writeFileSync(join(repoDir, 'README.md'), 'hello v2\n', 'utf8');
      runGit(['add', 'README.md'], repoDir);
      runGit(['commit', '-m', 'init'], repoDir);

      // 安全边界：禁止在生产仓库内部建 worktree，禁止直接操作 main/baseBranch
      expect(() => assertIsolatedWorktreePath(repoDir, repoDir)).toThrow(/必须严格位于生产仓库/);
      expect(() => assertIsolatedWorktreePath(repoDir, join(repoDir, 'sub', 'wt'))).toThrow(/必须严格位于生产仓库/);

      const manager = new GitWorktreeManager(repoDir);
      expect(() =>
        manager.createWorktree({
          taskId: 'bad-main',
          branchName: 'main',
          baseBranch: 'feat/whale-isle-v2',
          worktreeRoot,
        }),
      ).toThrow(/非法的目标研发分支/);

      const wt = manager.createWorktree({
        taskId: 'V2-TEST-1',
        branchName: 'evo/test-1',
        baseBranch: 'feat/whale-isle-v2',
        worktreeRoot,
      });
      expect(existsSync(wt.path)).toBe(true);
      expect(manager.listWorktrees().length).toBeGreaterThanOrEqual(2);

      // 在隔离 worktree 内提交改动，验证主工作区完全不受影响
      writeFileSync(join(wt.path, 'feature.ts'), 'export const ok = true;\n', 'utf8');
      runGit(['add', 'feature.ts'], wt.path);
      runGit(['commit', '-m', 'add feature'], wt.path);

      expect(existsSync(join(repoDir, 'feature.ts'))).toBe(false);
      expect(readFileSync(join(wt.path, 'feature.ts'), 'utf8')).toContain('ok = true');
      expect(manager.changedFiles(wt.path, 'feat/whale-isle-v2')).toContain('feature.ts');
      expect(manager.diffText(wt.path, 'feat/whale-isle-v2')).toContain('export const ok = true');

      // 幂等重入同路径
      const wtAgain = manager.createWorktree({
        taskId: 'V2-TEST-1',
        branchName: 'evo/test-1',
        baseBranch: 'feat/whale-isle-v2',
        worktreeRoot,
      });
      expect(wtAgain.path).toBe(wt.path);

      manager.removeWorktree(wt.path, true);
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('approves clean diffs and blocks empty, secret, forbidden-path, and license violations', () => {
    const reviewer = new IndependentReviewer();

    const clean = reviewer.review({
      changedFiles: ['packages/runtime-core/src/kernel.ts'],
      diffText: '+export const version = 2;',
    });
    expect(clean.approved).toBe(true);

    const warnFiles = reviewer.review({
      changedFiles: Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`),
      diffText: '+ok',
      maxFiles: 8,
    });
    expect(warnFiles.approved).toBe(true);
    expect(warnFiles.findings[0]?.severity).toBe('warn');

    expect(reviewer.review({ changedFiles: [], diffText: '' }).approved).toBe(false);
    expect(
      reviewer.review({
        changedFiles: ['userData/provider-vault.json'],
        diffText: '+{}',
      }).approved,
    ).toBe(false);

    const fakeSecret = ['sk', '1234567890abcdef1234'].join('-');
    expect(
      reviewer.review({
        changedFiles: ['a.ts'],
        diffText: `+const k = "${fakeSecret}";`,
      }).approved,
    ).toBe(false);

    expect(
      reviewer.review({
        changedFiles: ['a.ts'],
        diffText: `+from ${'newbeejmc'}/${'Dsh_douyin'}`,
      }).approved,
    ).toBe(false);
  });
});
