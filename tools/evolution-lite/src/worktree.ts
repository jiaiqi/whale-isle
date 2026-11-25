/**
 * 隔离 Git Worktree 管理器（V2-P0-05）：
 * - 强制校验 worktreePath 严格位于生产仓库根目录之外（防生产代码热修改）
 * - 严禁直接对 main/master 创建工作分支写回
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type GitRunner = (args: string[], cwd: string) => string;

const INHERITED_GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_SUPER_PREFIX',
  'GIT_QUARANTINE_PATH',
] as const;

export function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_GIT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function defaultGitRunner(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: sanitizedGitEnv() }).trim();
}

function canonicalPath(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  let cursor = dirname(abs);
  while (cursor !== dirname(cursor) && !existsSync(cursor)) {
    cursor = dirname(cursor);
  }
  if (existsSync(cursor)) {
    const tail = relative(cursor, abs);
    return tail === '' ? realpathSync(cursor) : join(realpathSync(cursor), tail);
  }
  return abs;
}

export function assertIsolatedWorktreePath(repoRoot: string, worktreePath: string): string {
  const realRepo = canonicalPath(repoRoot);
  const realWorktree = canonicalPath(worktreePath);
  if (realWorktree === realRepo || realWorktree.startsWith(realRepo + sep)) {
    throw new Error(`安全拒绝：Worktree 路径 (${realWorktree}) 必须严格位于生产仓库 (${realRepo}) 之外`);
  }
  return realWorktree;
}

export interface CreateWorktreeOptions {
  taskId: string;
  branchName: string;
  baseBranch: string;
  worktreeRoot: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export class GitWorktreeManager {
  constructor(
    private readonly repoRoot: string,
    private readonly git: GitRunner = defaultGitRunner,
  ) {}

  createWorktree(options: CreateWorktreeOptions): WorktreeInfo {
    const branch = options.branchName.trim();
    if (branch === '' || branch === 'main' || branch === 'master' || branch === options.baseBranch) {
      throw new Error(`非法的目标研发分支：${branch}`);
    }
    const safeSlug = options.taskId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const candidatePath = join(options.worktreeRoot, `wt-${safeSlug}`);
    const isolatedPath = assertIsolatedWorktreePath(this.repoRoot, candidatePath);
    mkdirSync(dirname(isolatedPath), { recursive: true });

    if (existsSync(isolatedPath)) {
      return { path: isolatedPath, branch };
    }

    const existingBranch = this.git(['branch', '--list', branch], this.repoRoot);
    if (existingBranch.trim() !== '') {
      this.git(['worktree', 'add', isolatedPath, branch], this.repoRoot);
    } else {
      this.git(['worktree', 'add', '-b', branch, isolatedPath, options.baseBranch], this.repoRoot);
    }
    return { path: isolatedPath, branch };
  }

  changedFiles(worktreePath: string, baseBranch: string): string[] {
    const tracked = this.git(['diff', '--name-only', `${baseBranch}..HEAD`], worktreePath)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const unstaged = this.git(['status', '--porcelain'], worktreePath)
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return [...new Set([...tracked, ...unstaged])];
  }

  diffText(worktreePath: string, baseBranch: string): string {
    const committedDiff = this.git(['diff', `${baseBranch}..HEAD`], worktreePath);
    const workingDiff = this.git(['diff'], worktreePath);
    return [committedDiff, workingDiff].filter(Boolean).join('\n');
  }

  listWorktrees(): string[] {
    const raw = this.git(['worktree', 'list', '--porcelain'], this.repoRoot);
    return raw
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim());
  }

  removeWorktree(worktreePath: string, force = true): void {
    const isolated = assertIsolatedWorktreePath(this.repoRoot, worktreePath);
    const args = force ? ['worktree', 'remove', '--force', isolated] : ['worktree', 'remove', isolated];
    this.git(args, this.repoRoot);
  }
}
