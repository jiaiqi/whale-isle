/**
 * Evolution Engine Lite 编排器（V2-P0-05）：
 * 流程：跨会话选单 → 创建生产外独立 Worktree → 调用 Coding Agent → 自动门禁 → 独立审查 → 产出 PR 草案
 * 铁律：任意环节失败立刻停止并如实落盘 BLOCKED 失败报告，绝不伪造成功、绝不自动合并主线。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingAgentAdapter } from './agent-adapter';
import { IndependentReviewer } from './reviewer';
import type { EvolutionStateStore } from './state-store';
import type { ExecutionReport, GateRunResult, PrDraft } from './types';
import { GitWorktreeManager } from './worktree';

export type GateRunner = (worktreePath: string) => Promise<GateRunResult> | GateRunResult;

export function defaultGateRunner(worktreePath: string): GateRunResult {
  const started = Date.now();
  const res = spawnSync('pnpm', ['verify:gate'], {
    cwd: worktreePath,
    encoding: 'utf8',
    timeout: 300_000,
  });
  return {
    ok: res.status === 0,
    summary: res.status === 0 ? 'pnpm verify:gate 全绿' : `pnpm verify:gate 失败（exit=${String(res.status)}）`,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    durationMs: Date.now() - started,
  };
}

export function renderPrDraft(input: {
  taskId: string;
  title: string;
  goal: string;
  baseBranch: string;
  headBranch: string;
  changedFiles: string[];
  gateSummary: string;
  reviewSummary: string;
  agentSummary: string;
}): PrDraft {
  const bodyMarkdown = [
    '## Summary',
    `- [${input.taskId}] ${input.title}`,
    `- Goal: ${input.goal}`,
    '',
    '## Agent Execution',
    input.agentSummary,
    '',
    '## Files Changed',
    ...input.changedFiles.map((f) => `- \`${f}\``),
    '',
    '## Tests & Review Executed',
    `- Quality Gate: ${input.gateSummary}`,
    `- Independent Review: ${input.reviewSummary}`,
    '',
    '## Rollback',
    `Revert branch \`${input.headBranch}\` (PR target \`${input.baseBranch}\`); production runtime was isolated during development.`,
  ].join('\n');

  return {
    taskId: input.taskId,
    title: `feat(${input.taskId}): ${input.title}`,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    bodyMarkdown,
    ghCreateArgs: [
      'pr', 'create',
      '--base', input.baseBranch,
      '--head', input.headBranch,
      '--title', `feat(${input.taskId}): ${input.title}`,
      '--body', bodyMarkdown,
    ],
  };
}

export interface EvolutionLiteOptions {
  store: EvolutionStateStore;
  worktrees: GitWorktreeManager;
  adapter: CodingAgentAdapter;
  worktreeRoot: string;
  reportsDir: string;
  gateRunner?: GateRunner;
  reviewer?: IndependentReviewer;
  cleanupOnFailure?: boolean;
  nowIso?: () => string;
}

export class EvolutionLiteOrchestrator {
  private readonly gateRunner: GateRunner;
  private readonly reviewer: IndependentReviewer;
  private readonly nowIso: () => string;

  constructor(private readonly options: EvolutionLiteOptions) {
    this.gateRunner = options.gateRunner ?? defaultGateRunner;
    this.reviewer = options.reviewer ?? new IndependentReviewer();
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  async runNext(taskId?: string): Promise<ExecutionReport | null> {
    const task = taskId !== undefined
      ? this.options.store.getTask(taskId)
      : this.options.store.resumeOrPickNext();
    if (!task) return null;

    const startedAt = this.nowIso();
    const active = this.options.store.startTask(task.id);
    const worktree = this.options.worktrees.createWorktree({
      taskId: active.id,
      branchName: active.branchName,
      baseBranch: active.baseBranch,
      worktreeRoot: this.options.worktreeRoot,
    });

    const failAndReport = (reason: string, partial: Partial<ExecutionReport>): ExecutionReport => {
      this.options.store.markBlocked(active.id, reason);
      if (this.options.cleanupOnFailure) {
        try { this.options.worktrees.removeWorktree(worktree.path, true); } catch { /* ignore cleanup err */ }
      }
      const report: ExecutionReport = {
        taskId: active.id,
        outcome: 'BLOCKED',
        worktreePath: worktree.path,
        branchName: worktree.branch,
        agentName: this.options.adapter.name,
        changedFiles: partial.changedFiles ?? [],
        ...(partial.gateResult === undefined ? {} : { gateResult: partial.gateResult }),
        ...(partial.reviewResult === undefined ? {} : { reviewResult: partial.reviewResult }),
        failureReason: reason,
        startedAt,
        finishedAt: this.nowIso(),
      };
      this.writeReport(report);
      return report;
    };

    if (!this.options.adapter.isAvailable()) {
      return failAndReport(`Coding Agent 不可用：${this.options.adapter.name}`, {});
    }

    const agentRes = await this.options.adapter.execute({
      task: active,
      worktreePath: worktree.path,
      contextMarkdown: this.options.store.renderProgressMarkdown(),
    });
    const changedFiles = agentRes.changedFiles.length > 0
      ? agentRes.changedFiles
      : this.options.worktrees.changedFiles(worktree.path, active.baseBranch);

    if (!agentRes.ok) {
      return failAndReport(`Coding Agent 执行失败：${agentRes.summary}`, { changedFiles });
    }

    const gateResult = await this.gateRunner(worktree.path);
    if (!gateResult.ok) {
      return failAndReport(`门禁未通过：${gateResult.summary}`, { changedFiles, gateResult });
    }

    const diffText = this.options.worktrees.diffText(worktree.path, active.baseBranch);
    const reviewResult = this.reviewer.review({
      changedFiles,
      diffText,
      maxFiles: active.maxFiles,
    });
    if (!reviewResult.approved) {
      return failAndReport(`独立审查未通过：${reviewResult.summary}`, {
        changedFiles,
        gateResult,
        reviewResult,
      });
    }

    const prDraft = renderPrDraft({
      taskId: active.id,
      title: active.title,
      goal: active.goal,
      baseBranch: active.baseBranch,
      headBranch: worktree.branch,
      changedFiles,
      gateSummary: gateResult.summary,
      reviewSummary: reviewResult.summary,
      agentSummary: agentRes.summary,
    });

    if (active.requiresRealDeviceVerification) {
      this.options.store.markImplementedUnverified(active.id, 'PR 草案与门禁已过，待真机实测');
    } else {
      this.options.store.markDone(active.id, '门禁与独立审查通过，PR 草案已生成');
    }

    const report: ExecutionReport = {
      taskId: active.id,
      outcome: active.requiresRealDeviceVerification ? 'IMPLEMENTED_UNVERIFIED' : 'READY_FOR_REVIEW',
      worktreePath: worktree.path,
      branchName: worktree.branch,
      agentName: this.options.adapter.name,
      changedFiles,
      gateResult,
      reviewResult,
      prDraft,
      startedAt,
      finishedAt: this.nowIso(),
    };
    this.writeReport(report);
    return report;
  }

  private writeReport(report: ExecutionReport): void {
    mkdirSync(this.options.reportsDir, { recursive: true });
    const file = join(this.options.reportsDir, `${report.taskId}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}
