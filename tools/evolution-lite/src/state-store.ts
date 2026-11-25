/**
 * 跨会话进度与唯一工单状态存储（V2-P0-05）：
 * - 强制全队列最多只有一个 NEXT 或 DOING 激活工单
 * - 支持依赖解析、IMPLEMENTED_UNVERIFIED / BLOCKED / REOPENED 完整 7 态流转
 * - 原子写盘 + 坏文件安全回退，保证跨会话可恢复
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EvolutionStateSchema,
  EvolutionTaskSchema,
  type EvolutionState,
  type EvolutionTask,
  type EvolutionTaskInput,
  type TicketStatus,
} from './types';

export class EvolutionStateStore {
  private state: EvolutionState;

  constructor(
    private readonly filePath: string,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {
    this.state = this.load();
  }

  private load(): EvolutionState {
    if (!existsSync(this.filePath)) return EvolutionStateSchema.parse({});
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      const result = EvolutionStateSchema.safeParse(parsed);
      return result.success ? result.data : EvolutionStateSchema.parse({});
    } catch {
      return EvolutionStateSchema.parse({});
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  snapshot(): EvolutionState {
    return structuredClone(this.state);
  }

  listTasks(): EvolutionTask[] {
    return this.state.tasks.map((t) => ({ ...t }));
  }

  getTask(taskId: string): EvolutionTask | null {
    const found = this.state.tasks.find((t) => t.id === taskId);
    return found ? { ...found } : null;
  }

  addTask(input: Omit<EvolutionTaskInput, 'createdAt' | 'updatedAt'>): EvolutionTask {
    if (this.state.tasks.some((t) => t.id === input.id)) {
      throw new Error(`工单已存在：${input.id}`);
    }
    const ts = this.nowIso();
    const task = EvolutionTaskSchema.parse({
      ...input,
      createdAt: ts,
      updatedAt: ts,
    });
    if ((task.status === 'NEXT' || task.status === 'DOING') && this.activeTask() !== null) {
      throw new Error(`违反唯一激活工单约束：已有激活工单 ${this.activeTask()!.id}`);
    }
    this.state.tasks.push(task);
    if (task.status === 'NEXT' || task.status === 'DOING') {
      this.state.activeTaskId = task.id;
    }
    this.persist();
    return { ...task };
  }

  activeTask(): EvolutionTask | null {
    const active = this.state.tasks.find((t) => t.status === 'NEXT' || t.status === 'DOING');
    return active ? { ...active } : null;
  }

  areDependenciesSatisfied(task: EvolutionTask): boolean {
    const doneIds = new Set(this.state.tasks.filter((t) => t.status === 'DONE').map((t) => t.id));
    return task.dependsOn.every((dep) => doneIds.has(dep));
  }

  /** 查找或恢复当前可运行工单（优先恢复 DOING/NEXT，其次选出依赖满足的首个 PENDING/REOPENED） */
  resumeOrPickNext(): EvolutionTask | null {
    const current = this.activeTask();
    if (current) return current;
    const runnable = this.state.tasks.find(
      (t) => (t.status === 'PENDING' || t.status === 'REOPENED') && this.areDependenciesSatisfied(t),
    );
    if (!runnable) return null;
    return this.transition(runnable.id, 'NEXT', '依赖满足，自动激活为唯一 NEXT 工单');
  }

  startTask(taskId: string): EvolutionTask {
    const task = this.mustFind(taskId);
    if (!this.areDependenciesSatisfied(task)) {
      throw new Error(`工单 ${taskId} 依赖未满足：${task.dependsOn.join(', ')}`);
    }
    const otherActive = this.state.tasks.find(
      (t) => t.id !== taskId && (t.status === 'NEXT' || t.status === 'DOING'),
    );
    if (otherActive) {
      throw new Error(`违反唯一激活工单约束：${otherActive.id} 处于 ${otherActive.status}`);
    }
    task.attempts += 1;
    return this.transition(taskId, 'DOING', `开始执行（第 ${task.attempts} 次尝试）`);
  }

  markImplementedUnverified(taskId: string, reason: string): EvolutionTask {
    return this.transition(taskId, 'IMPLEMENTED_UNVERIFIED', reason);
  }

  markBlocked(taskId: string, errorMessage: string): EvolutionTask {
    const task = this.mustFind(taskId);
    task.lastError = errorMessage;
    return this.transition(taskId, 'BLOCKED', errorMessage);
  }

  reopen(taskId: string, reason: string): EvolutionTask {
    return this.transition(taskId, 'REOPENED', reason);
  }

  markDone(taskId: string, reason = '门禁与审查全部通过'): EvolutionTask {
    const task = this.mustFind(taskId);
    task.lastError = null;
    return this.transition(taskId, 'DONE', reason);
  }

  renderProgressMarkdown(): string {
    const lines = [
      '# Evolution Engine Lite Progress',
      '',
      `- Active Task: \`${this.state.activeTaskId ?? 'none'}\``,
      `- Total Tasks: ${this.state.tasks.length}`,
      '',
      '| Task | Status | Attempts | Branch | Last Error |',
      '| --- | --- | --- | --- | --- |',
      ...this.state.tasks.map((t) =>
        `| ${t.id} | \`${t.status}\` | ${t.attempts} | \`${t.branchName}\` | ${t.lastError ?? '—'} |`,
      ),
    ];
    return `${lines.join('\n')}\n`;
  }

  private transition(taskId: string, toStatus: TicketStatus, reason: string): EvolutionTask {
    const task = this.mustFind(taskId);
    const fromStatus = task.status;
    const ts = this.nowIso();
    task.status = toStatus;
    task.updatedAt = ts;
    if (toStatus === 'NEXT' || toStatus === 'DOING') {
      this.state.activeTaskId = task.id;
    } else if (this.state.activeTaskId === task.id) {
      this.state.activeTaskId = null;
    }
    this.state.history.push({ at: ts, taskId, fromStatus, toStatus, reason });
    if (this.state.history.length > 200) {
      this.state.history.splice(0, this.state.history.length - 200);
    }
    this.persist();
    return { ...task };
  }

  private mustFind(taskId: string): EvolutionTask {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`未找到工单：${taskId}`);
    return task;
  }
}
