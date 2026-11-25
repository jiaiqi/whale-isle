/**
 * LifeRuntime（V2-P1-01）：
 * - 负责域 5 Motivation 与域 12 ActivityState / 日程 / 资源预算 / 注意力中断恢复
 * - 单一协调器仲裁桌面陪伴 / 游戏 / 直播 / 创作 / 社交 / 休息与急停控制权
 * - 游戏与桌宠均从同一 ActivityState 投影消费状态，绝不分裂为多个互殴大脑
 */
import {
  ActivityStateDomainSchema,
  MotivationDomainSchema,
  type ActivityAuthoritySource,
  type ActivityStateDomain,
  type CharacterControlMode,
  type CharacterExpression,
  type LifeActivityKind,
  type LifeBudgetSnapshot,
  type MotivationDomain,
} from '@workbench/shared-protocol';
import type { CharacterRegistryCore, RuntimeEventBus } from '@workbench/runtime-core';
import type { CommitmentLedger, GoalManager } from './goals-commitments';

const MAX_INTERRUPT_STACK = 8;

const DEFAULT_EXPRESSION_BY_ACTIVITY: Record<LifeActivityKind, CharacterExpression> = {
  companion: 'idle',
  gaming: 'gaming',
  streaming: 'speaking',
  creative: 'thinking',
  social: 'listening',
  resting: 'resting',
  halted: 'idle',
};

export interface SelectActivityInput {
  mode: LifeActivityKind;
  expression?: CharacterExpression;
  reason: string;
  source?: ActivityAuthoritySource;
  goalId?: string | null;
  commitmentId?: string | null;
  force?: boolean;
}

export type SelectActivityResult =
  | { accepted: true; state: ActivityStateDomain }
  | { accepted: false; reason: 'CHARACTER_HALTED' | 'MANUAL_TAKEOVER_ACTIVE' | 'BUDGET_EXHAUSTED'; state: ActivityStateDomain };

export interface ScheduleEvaluation {
  recommendedActivity: LifeActivityKind;
  quietMode: boolean;
  slotLabel: string | null;
  canAutoSwitch: boolean;
}

export interface LifeRuntimeOptions {
  characterId: string;
  initialMotivation: MotivationDomain;
  initialActivity: ActivityStateDomain;
  events: RuntimeEventBus;
  registryCore?: CharacterRegistryCore;
  goalManager: GoalManager;
  commitmentLedger: CommitmentLedger;
  now?: () => number;
  onMutate?: () => void;
}

export class LifeRuntime {
  private motivationState: MotivationDomain;
  private activity: ActivityStateDomain;
  private readonly characterId: string;
  private readonly events: RuntimeEventBus;
  private readonly registryCore: CharacterRegistryCore | undefined;
  private readonly goalManager: GoalManager;
  private readonly commitmentLedger: CommitmentLedger;
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(options: LifeRuntimeOptions) {
    this.characterId = options.characterId;
    this.motivationState = MotivationDomainSchema.parse(options.initialMotivation);
    this.activity = ActivityStateDomainSchema.parse(options.initialActivity);
    this.events = options.events;
    this.registryCore = options.registryCore;
    this.goalManager = options.goalManager;
    this.commitmentLedger = options.commitmentLedger;
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  motivation(): MotivationDomain {
    return structuredClone(this.motivationState);
  }

  setMotivation(
    patch: Partial<Pick<MotivationDomain, 'primaryDrive' | 'intensity' | 'reason' | 'secondaryDrives'>>,
  ): MotivationDomain {
    this.motivationState = MotivationDomainSchema.parse({
      ...this.motivationState,
      ...(patch.primaryDrive === undefined ? {} : { primaryDrive: patch.primaryDrive }),
      ...(patch.intensity === undefined ? {} : { intensity: Math.min(1, Math.max(0, patch.intensity)) }),
      ...(patch.reason === undefined ? {} : { reason: patch.reason }),
      ...(patch.secondaryDrives === undefined ? {} : { secondaryDrives: patch.secondaryDrives }),
      updatedAt: this.now(),
    });
    this.events.publish('life:motivation-changed', { motivation: this.motivationState }, {
      source: 'life-runtime',
      characterId: this.characterId,
    });
    this.onMutate?.();
    return structuredClone(this.motivationState);
  }

  activityState(): ActivityStateDomain {
    return structuredClone(this.activity);
  }

  /** 仲裁活动切换：受急停、手动接管与预算约束 */
  selectActivity(input: SelectActivityInput): SelectActivityResult {
    const source = input.source ?? 'life_runtime';
    if (this.activity.halted && !input.force) {
      return { accepted: false, reason: 'CHARACTER_HALTED', state: this.activityState() };
    }
    if (
      this.activity.controlMode === 'manual_takeover'
      && source === 'life_runtime'
      && input.mode === 'gaming'
      && !input.force
    ) {
      return { accepted: false, reason: 'MANUAL_TAKEOVER_ACTIVE', state: this.activityState() };
    }
    const isResourceHeavy = input.mode === 'gaming' || input.mode === 'streaming' || input.mode === 'creative';
    if (this.activity.budget.exhausted && source === 'life_runtime' && isResourceHeavy && !input.force) {
      return { accepted: false, reason: 'BUDGET_EXHAUSTED', state: this.activityState() };
    }

    const prevMode = this.activity.mode;
    const expression = input.expression ?? DEFAULT_EXPRESSION_BY_ACTIVITY[input.mode];
    const resolvedGoalId = input.goalId !== undefined
      ? input.goalId
      : (this.activity.activeGoalId ?? this.goalManager.activePrimaryGoal()?.goalId ?? null);
    const resolvedCommitmentId = input.commitmentId !== undefined
      ? input.commitmentId
      : (this.activity.activeCommitmentId ?? this.commitmentLedger.listActive()[0]?.commitmentId ?? null);

    this.activity = ActivityStateDomainSchema.parse({
      ...this.activity,
      mode: input.mode,
      expression,
      authoritySource: source,
      activeGoalId: resolvedGoalId,
      activeCommitmentId: resolvedCommitmentId,
      updatedAt: this.now(),
    });

    this.syncRegistryExpressionAndGoal(input.reason);
    this.events.publish('life:activity-changed', {
      prevMode,
      nextMode: this.activity.mode,
      expression: this.activity.expression,
      source,
      reason: input.reason,
    }, {
      source: 'life-runtime',
      characterId: this.characterId,
    });
    this.onMutate?.();
    return { accepted: true, state: this.activityState() };
  }

  /** 临时打断当前活动（如从游戏切去回应重要消息），保留现场以便恢复 */
  interruptFor(input: SelectActivityInput): SelectActivityResult {
    if (this.activity.mode !== 'halted') {
      const pushed = {
        activity: this.activity.mode,
        expression: this.activity.expression,
        reason: input.reason,
        ...(this.activity.activeGoalId === null ? {} : { goalId: this.activity.activeGoalId }),
        interruptedAt: this.now(),
      };
      this.activity = ActivityStateDomainSchema.parse({
        ...this.activity,
        interruptedStack: [...this.activity.interruptedStack, pushed].slice(-MAX_INTERRUPT_STACK),
      });
    }
    return this.selectActivity(input);
  }

  /** 恢复最近一次被中断的活动 */
  resumeInterrupted(reason = '中断处理完成，恢复原活动'): { resumed: boolean; state: ActivityStateDomain } {
    if (this.activity.halted || this.activity.interruptedStack.length === 0) {
      return { resumed: false, state: this.activityState() };
    }
    const stack = [...this.activity.interruptedStack];
    const top = stack.pop()!;
    this.activity = ActivityStateDomainSchema.parse({
      ...this.activity,
      interruptedStack: stack,
    });
    const result = this.selectActivity({
      mode: top.activity,
      expression: top.expression,
      reason,
      source: 'life_runtime',
      goalId: top.goalId ?? null,
    });
    return { resumed: result.accepted, state: result.state };
  }

  /** 评估当前时间所在日程槽位（不做硬编码游戏行为，仅提供生活节律参考） */
  evaluateSchedule(date = new Date(this.now())): ScheduleEvaluation {
    const minuteOfDay = date.getHours() * 60 + date.getMinutes();
    const slot = this.activity.schedule.find((s) =>
      s.startMinute <= s.endMinute
        ? minuteOfDay >= s.startMinute && minuteOfDay < s.endMinute
        : minuteOfDay >= s.startMinute || minuteOfDay < s.endMinute,
    );
    const canAutoSwitch =
      !this.activity.halted
      && this.activity.controlMode !== 'manual_takeover'
      && this.activity.authoritySource !== 'user_command';
    if (!slot) {
      return {
        recommendedActivity: 'companion',
        quietMode: false,
        slotLabel: null,
        canAutoSwitch,
      };
    }
    return {
      recommendedActivity: slot.preferredActivity,
      quietMode: slot.quietMode,
      slotLabel: slot.label,
      canAutoSwitch,
    };
  }

  /** 更新资源与时长预算；耗尽时标记 exhausted=true 阻止高耗自主任务 */
  updateBudget(
    patch: Partial<Pick<LifeBudgetSnapshot, 'dailyTokenBudget' | 'tokensConsumedToday' | 'activeSessionMinutes' | 'maxSessionMinutes'>>,
  ): ActivityStateDomain {
    const nextBudget = {
      ...this.activity.budget,
      ...(patch.dailyTokenBudget === undefined ? {} : { dailyTokenBudget: patch.dailyTokenBudget }),
      ...(patch.tokensConsumedToday === undefined ? {} : { tokensConsumedToday: patch.tokensConsumedToday }),
      ...(patch.activeSessionMinutes === undefined ? {} : { activeSessionMinutes: patch.activeSessionMinutes }),
      ...(patch.maxSessionMinutes === undefined ? {} : { maxSessionMinutes: patch.maxSessionMinutes }),
    };
    const exhausted =
      nextBudget.tokensConsumedToday >= nextBudget.dailyTokenBudget
      || nextBudget.activeSessionMinutes >= nextBudget.maxSessionMinutes;
    this.activity = ActivityStateDomainSchema.parse({
      ...this.activity,
      budget: { ...nextBudget, exhausted },
      updatedAt: this.now(),
    });
    this.events.publish('life:budget-updated', { budget: this.activity.budget }, {
      source: 'life-runtime',
      characterId: this.characterId,
    });
    this.onMutate?.();
    return this.activityState();
  }

  /** 绑定/切换运行期 LLM 模型引用，绝不丢失角色身份、目标与约定 */
  bindModel(modelRef: string | null): ActivityStateDomain {
    const normalized = modelRef === null || modelRef.trim() === '' ? null : modelRef.trim();
    this.activity = ActivityStateDomainSchema.parse({
      ...this.activity,
      activeModelRef: normalized,
      updatedAt: this.now(),
    });
    this.events.publish('life:model-bound', { activeModelRef: normalized }, {
      source: 'life-runtime',
      characterId: this.characterId,
    });
    this.onMutate?.();
    return this.activityState();
  }

  setControlMode(mode: CharacterControlMode, reason: string): ActivityStateDomain {
    const authoritySource: ActivityAuthoritySource =
      mode === 'manual_takeover'
        ? 'manual_takeover'
        : mode === 'command'
          ? 'user_command'
          : 'life_runtime';
    this.activity = ActivityStateDomainSchema.parse({
      ...this.activity,
      controlMode: mode,
      authoritySource,
      updatedAt: this.now(),
    });
    this.registryCore?.setControlMode(this.characterId, mode, reason);
    this.onMutate?.();
    return this.activityState();
  }

  emergencyHalt(reason = '用户触发紧急停止'): ActivityStateDomain {
    this.goalManager.pauseActiveGoals();
    this.activity = ActivityStateDomainSchema.parse({
      ...this.activity,
      mode: 'halted',
      expression: 'idle',
      controlMode: 'manual_takeover',
      halted: true,
      haltReason: reason,
      authoritySource: 'emergency_halt',
      updatedAt: this.now(),
    });
    this.registryCore?.emergencyHalt(reason, this.characterId);
    this.events.publish('life:halted', { reason }, {
      source: 'life-runtime',
      characterId: this.characterId,
    });
    this.onMutate?.();
    return this.activityState();
  }

  resume(mode: CharacterControlMode = 'autonomous'): ActivityStateDomain {
    this.goalManager.resumePausedGoals();
    const primaryGoal = this.goalManager.activePrimaryGoal();
    this.activity = ActivityStateDomainSchema.parse({
      ...this.activity,
      mode: 'companion',
      expression: 'idle',
      controlMode: mode,
      halted: false,
      haltReason: null,
      activeGoalId: primaryGoal?.goalId ?? this.activity.activeGoalId,
      authoritySource: mode === 'manual_takeover' ? 'manual_takeover' : 'life_runtime',
      updatedAt: this.now(),
    });
    this.registryCore?.resume(mode, this.characterId);
    this.syncRegistryExpressionAndGoal('恢复运行');
    this.events.publish('life:resumed', { controlMode: mode }, {
      source: 'life-runtime',
      characterId: this.characterId,
    });
    this.onMutate?.();
    return this.activityState();
  }

  private syncRegistryExpressionAndGoal(reason: string): void {
    if (!this.registryCore) return;
    this.registryCore.setExpression(this.characterId, this.activity.expression, reason);
    const goal = this.activity.activeGoalId
      ? this.goalManager.list().find((g) => g.goalId === this.activity.activeGoalId)
      : this.goalManager.activePrimaryGoal();
    this.registryCore.setActiveGoal(this.characterId, goal?.title ?? null);
  }
}
