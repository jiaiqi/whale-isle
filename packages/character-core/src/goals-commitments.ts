/**
 * CharacterCore 域 6 & 域 7（V2-P1-01）：
 * - GoalManager：多时间尺度目标栈（action / short_term / milestone / long_term / shared）
 * - CommitmentLedger：与主人或联机伙伴的约定账本（active / fulfilled / renegotiated / cancelled）
 */
import { randomUUID } from 'node:crypto';
import {
  CharacterCommitmentSchema,
  CharacterGoalSchema,
  type CharacterCommitment,
  type CharacterGoal,
  type GoalHorizon,
  type GoalOrigin,
  type GoalStatus,
  type LifeActivityKind,
} from '@workbench/shared-protocol';
import { WhaleError } from '@workbench/runtime-core';

const HORIZON_URGENCY: Record<GoalHorizon, number> = {
  action: 5,
  shared: 4,
  short_term: 3,
  milestone: 2,
  long_term: 1,
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export class GoalManager {
  private goals: CharacterGoal[];
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(
    private readonly characterId: string,
    initial: CharacterGoal[],
    options: { now?: () => number; onMutate?: () => void } = {},
  ) {
    this.goals = initial.map((g) => CharacterGoalSchema.parse(g));
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  addGoal(input: {
    goalId?: string;
    title: string;
    description?: string;
    horizon?: GoalHorizon;
    origin?: GoalOrigin;
    priority?: number;
    relatedActivity?: LifeActivityKind;
    parentGoalId?: string;
  }): CharacterGoal {
    const t = this.now();
    const goal = CharacterGoalSchema.parse({
      goalId: input.goalId ?? `goal-${randomUUID().slice(0, 8)}`,
      characterId: this.characterId,
      title: input.title.trim(),
      ...(input.description === undefined ? {} : { description: input.description }),
      horizon: input.horizon ?? 'short_term',
      origin: input.origin ?? 'autonomous',
      status: 'active',
      priority: input.priority ?? 50,
      progress: 0,
      relatedActivity: input.relatedActivity ?? 'companion',
      ...(input.parentGoalId === undefined ? {} : { parentGoalId: input.parentGoalId }),
      createdAt: t,
      updatedAt: t,
    });
    this.goals.push(goal);
    this.onMutate?.();
    return structuredClone(goal);
  }

  updateGoal(
    goalId: string,
    patch: Partial<Pick<CharacterGoal, 'title' | 'description' | 'status' | 'priority' | 'progress' | 'relatedActivity'>>,
  ): CharacterGoal {
    const idx = this.goals.findIndex((g) => g.goalId === goalId);
    if (idx < 0) {
      throw new WhaleError('CONFIG_INVALID', `未找到目标：${goalId}`, {
        recoverable: true,
        context: { reason: 'GOAL_NOT_FOUND', goalId },
      });
    }
    const prev = this.goals[idx]!;
    const t = this.now();
    const nextStatus = patch.status ?? prev.status;
    const nextProgress = patch.progress === undefined ? (nextStatus === 'completed' ? 1 : prev.progress) : clamp01(patch.progress);
    const updated = CharacterGoalSchema.parse({
      ...prev,
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.relatedActivity === undefined ? {} : { relatedActivity: patch.relatedActivity }),
      status: nextStatus,
      progress: nextProgress,
      updatedAt: t,
      ...(nextStatus === 'completed' ? { completedAt: prev.completedAt ?? t } : {}),
    });
    this.goals[idx] = updated;
    this.onMutate?.();
    return structuredClone(updated);
  }

  list(filter?: { status?: GoalStatus; horizon?: GoalHorizon }): CharacterGoal[] {
    return this.goals
      .filter((g) => (filter?.status === undefined ? true : g.status === filter.status))
      .filter((g) => (filter?.horizon === undefined ? true : g.horizon === filter.horizon))
      .map((g) => structuredClone(g));
  }

  activePrimaryGoal(): CharacterGoal | null {
    const active = this.goals.filter((g) => g.status === 'active');
    if (active.length === 0) return null;
    const sorted = [...active].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return HORIZON_URGENCY[b.horizon] - HORIZON_URGENCY[a.horizon];
    });
    return structuredClone(sorted[0] ?? null);
  }

  pauseActiveGoals(): CharacterGoal[] {
    const t = this.now();
    const paused: CharacterGoal[] = [];
    this.goals = this.goals.map((goal) => {
      if (goal.status !== 'active') return goal;
      const next = CharacterGoalSchema.parse({ ...goal, status: 'paused', updatedAt: t });
      paused.push(next);
      return next;
    });
    if (paused.length > 0) this.onMutate?.();
    return structuredClone(paused);
  }

  resumePausedGoals(): CharacterGoal[] {
    const t = this.now();
    const resumed: CharacterGoal[] = [];
    this.goals = this.goals.map((goal) => {
      if (goal.status !== 'paused') return goal;
      const next = CharacterGoalSchema.parse({ ...goal, status: 'active', updatedAt: t });
      resumed.push(next);
      return next;
    });
    if (resumed.length > 0) this.onMutate?.();
    return structuredClone(resumed);
  }
}

export class CommitmentLedger {
  private items: CharacterCommitment[];
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(
    private readonly characterId: string,
    initial: CharacterCommitment[],
    options: { now?: () => number; onMutate?: () => void } = {},
  ) {
    this.items = initial.map((c) => CharacterCommitmentSchema.parse(c));
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  create(input: {
    commitmentId?: string;
    partnerId: string;
    partnerName?: string;
    title: string;
    detail?: string;
    dueAt?: number;
  }): CharacterCommitment {
    const t = this.now();
    const commitment = CharacterCommitmentSchema.parse({
      commitmentId: input.commitmentId ?? `cmt-${randomUUID().slice(0, 8)}`,
      characterId: this.characterId,
      partnerId: input.partnerId.trim(),
      ...(input.partnerName === undefined ? {} : { partnerName: input.partnerName }),
      title: input.title.trim(),
      detail: input.detail ?? '',
      status: 'active',
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      createdAt: t,
      updatedAt: t,
    });
    this.items.push(commitment);
    this.onMutate?.();
    return structuredClone(commitment);
  }

  fulfill(commitmentId: string, note?: string): CharacterCommitment {
    return this.transition(commitmentId, 'fulfilled', { note });
  }

  renegotiate(
    commitmentId: string,
    patch: { title?: string; detail?: string; dueAt?: number; note?: string },
  ): CharacterCommitment {
    return this.transition(commitmentId, 'renegotiated', patch);
  }

  cancel(commitmentId: string, note?: string): CharacterCommitment {
    return this.transition(commitmentId, 'cancelled', { note });
  }

  listActive(): CharacterCommitment[] {
    return this.items
      .filter((c) => c.status === 'active' || c.status === 'renegotiated')
      .map((c) => structuredClone(c));
  }

  listAll(): CharacterCommitment[] {
    return structuredClone(this.items);
  }

  private transition(
    commitmentId: string,
    status: CharacterCommitment['status'],
    patch: { title?: string; detail?: string; dueAt?: number; note?: string | undefined },
  ): CharacterCommitment {
    const idx = this.items.findIndex((c) => c.commitmentId === commitmentId);
    if (idx < 0) {
      throw new WhaleError('CONFIG_INVALID', `未找到约定：${commitmentId}`, {
        recoverable: true,
        context: { reason: 'COMMITMENT_NOT_FOUND', commitmentId },
      });
    }
    const prev = this.items[idx]!;
    const updated = CharacterCommitmentSchema.parse({
      ...prev,
      status,
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
      ...(patch.detail === undefined ? {} : { detail: patch.detail }),
      ...(patch.dueAt === undefined ? {} : { dueAt: patch.dueAt }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      updatedAt: this.now(),
    });
    this.items[idx] = updated;
    this.onMutate?.();
    return structuredClone(updated);
  }
}
