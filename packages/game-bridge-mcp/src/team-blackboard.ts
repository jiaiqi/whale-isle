/**
 * TeamBlackboard（T-M6-39）：多 AI 协作的单一共享状态。
 *
 * 只保存“可执行事实”：共同目标、成员分工、区域软互斥租约、商量状态与最近群聊。
 * 不保存大模型自由文本推理；每一步 mutation 递增 version，供 UI / Agent 丢弃旧快照。
 * formatCompactPromptSummary 有 300 字符硬上限，控制每 tick 注入成本。
 */
import {
  TeamAssignmentSchema,
  TeamBlackboardSnapshotSchema,
  TeamCommsMessageSchema,
  TeamGoalSchema,
  type TeamAssignment,
  type TeamBlackboardSnapshot,
  type TeamCommsMessage,
  type TeamGoal,
  type TeamHuddleState,
  type TeamZoneLock,
} from '@workbench/shared-protocol';

export interface TeamBlackboardOptions {
  now?: () => number;
  initialGoal?: TeamGoal;
  /** 群聊环形缓冲上限（默认 50，只用于 UI 历史与最近 @ 摘要） */
  maxMessages?: number;
}

export interface ZoneAcquireResult {
  ok: boolean;
  lock?: TeamZoneLock;
  reason?: string;
}

const DEFAULT_GOAL: TeamGoal = {
  id: 'team-goal',
  title: '暂无共同目标',
  gameId: 'stardew',
  metrics: [],
  deadline: '',
  status: 'paused',
};

const TEAM_MENTIONS = new Set(['@全队', '全队', 'all', '@all', '*']);

function normalizeZone(zone: string): string {
  return zone.trim().replace(/\s+/g, ' ');
}

function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class TeamBlackboard {
  private goal: TeamGoal;
  private assignments = new Map<string, TeamAssignment>();
  private locks = new Map<string, TeamZoneLock>();
  private messages: TeamCommsMessage[] = [];
  private huddle: TeamHuddleState = { active: false, round: 0, maxRounds: 3, cooldownUntil: 0 };
  private version = 0;
  private readonly listeners = new Set<(snapshot: TeamBlackboardSnapshot) => void>();
  private readonly now: () => number;
  private readonly maxMessages: number;

  constructor(options: TeamBlackboardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxMessages = Math.max(10, options.maxMessages ?? 50);
    this.goal = options.initialGoal === undefined
      ? { ...DEFAULT_GOAL, metrics: [] }
      : TeamGoalSchema.parse(options.initialGoal);
  }

  snapshot(): TeamBlackboardSnapshot {
    this.purgeExpiredLocks(false);
    const snapshot = TeamBlackboardSnapshotSchema.parse({
      goal: this.goal,
      assignments: [...this.assignments.values()],
      zoneLocks: [...this.locks.values()],
      huddleState: this.huddle,
      version: this.version,
    });
    return snapshot;
  }

  onSnapshot(listener: (snapshot: TeamBlackboardSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setGoal(goal: TeamGoal): TeamBlackboardSnapshot {
    this.goal = TeamGoalSchema.parse(goal);
    return this.commit();
  }

  patchGoal(update: Partial<TeamGoal>): TeamBlackboardSnapshot {
    this.goal = TeamGoalSchema.parse({ ...this.goal, ...update });
    return this.commit();
  }

  upsertAssignment(assignment: TeamAssignment): TeamBlackboardSnapshot {
    const parsed = TeamAssignmentSchema.parse(assignment);
    this.assignments.set(parsed.agentId, parsed);
    return this.commit();
  }

  setAssignmentStatus(agentId: string, status: TeamAssignment['status'], progressNote?: string): TeamBlackboardSnapshot {
    const current = this.assignments.get(agentId);
    if (current === undefined) return this.snapshot();
    return this.upsertAssignment({
      ...current,
      status,
      ...(progressNote === undefined ? {} : { progressNote }),
      updatedAt: this.now(),
    });
  }

  removeAssignment(agentId: string): TeamBlackboardSnapshot {
    if (this.assignments.delete(agentId)) return this.commit();
    return this.snapshot();
  }

  applyPlan(planId: string, assignments: Array<{ agentId: string; displayName?: string; task: string; zone?: string }>): TeamBlackboardSnapshot {
    const updatedAt = this.now();
    for (const task of assignments) {
      const previous = this.assignments.get(task.agentId);
      this.assignments.set(task.agentId, TeamAssignmentSchema.parse({
        agentId: task.agentId,
        displayName: task.displayName ?? previous?.displayName ?? task.agentId,
        role: previous?.role ?? 'ai',
        task: task.task,
        zone: task.zone ?? previous?.zone ?? '',
        status: 'idle',
        progressNote: `计划 ${planId} 已写入，等待执行`,
        updatedAt,
      }));
    }
    return this.commit();
  }

  setHuddleState(update: Partial<TeamHuddleState>): TeamBlackboardSnapshot {
    this.huddle = {
      active: update.active ?? this.huddle.active,
      round: update.round ?? this.huddle.round,
      maxRounds: update.maxRounds ?? this.huddle.maxRounds,
      cooldownUntil: update.cooldownUntil ?? this.huddle.cooldownUntil,
    };
    return this.commit();
  }

  appendMessage(message: TeamCommsMessage): TeamBlackboardSnapshot {
    const parsed = TeamCommsMessageSchema.parse(message);
    this.messages.push(parsed);
    if (this.messages.length > this.maxMessages) this.messages.splice(0, this.messages.length - this.maxMessages);
    return this.commit();
  }

  recentMessages(): TeamCommsMessage[] {
    return [...this.messages];
  }

  /**
   * 区域软互斥：同一区域只允许一个 owner。
   * 同 owner 再次申请 = 续租；其他 owner 未过期 → 拒绝并返回持有者，不做排队（由 Huddle 决策）。
   */
  tryAcquireZone(agentId: string, zone: string, ttlMs: number): ZoneAcquireResult {
    const key = normalizeZone(zone);
    if (key === '') return { ok: false, reason: '区域为空' };
    if (agentId.trim() === '') return { ok: false, reason: 'agentId 为空' };
    this.purgeExpiredLocks(true);
    const previous = this.locks.get(key);
    if (previous !== undefined && previous.ownerAgentId !== agentId) {
      return { ok: false, reason: `${key} 已被 ${previous.ownerAgentId} 占用`, lock: { ...previous } };
    }
    const lock: TeamZoneLock = {
      zone: key,
      ownerAgentId: agentId,
      expiresAt: this.now() + Math.max(1_000, Math.round(ttlMs)),
    };
    this.locks.set(key, lock);
    this.commit();
    return { ok: true, lock: { ...lock } };
  }

  releaseZone(agentId: string, zone: string): boolean {
    const key = normalizeZone(zone);
    const current = this.locks.get(key);
    if (current === undefined || current.ownerAgentId !== agentId) return false;
    this.locks.delete(key);
    this.commit();
    return true;
  }

  releaseAgentZones(agentId: string): number {
    let released = 0;
    for (const [zone, lock] of this.locks) {
      if (lock.ownerAgentId !== agentId) continue;
      this.locks.delete(zone);
      released++;
    }
    if (released > 0) this.commit();
    return released;
  }

  /** 只注入目标 + 各成员任务/区域 + 最近两条点名消息；硬截断 300 字符。 */
  formatCompactPromptSummary(selfAgentId: string): string {
    const goalText = this.goal.status === 'paused' && this.goal.title === DEFAULT_GOAL.title
      ? '目标：暂无'
      : `目标：${oneLine(this.goal.title)}${this.goal.metrics.length === 0 ? '' : `（${this.goal.metrics.slice(0, 3).map((m) => `${oneLine(m.label)}${m.current}/${m.target}${m.unit}`).join('，')}）`}`;
    const assignments = [...this.assignments.values()].slice(0, 6)
      .map((item) => `${oneLine(item.displayName)}=${oneLine(item.task)}${item.zone === '' ? '' : `[${oneLine(item.zone)}]`}`);
    const relevant = this.messages
      .filter((message) => message.fromAgentId !== selfAgentId)
      .filter((message) => message.mentions.includes(selfAgentId) || message.mentions.some((mention) => TEAM_MENTIONS.has(mention)))
      .slice(-2)
      .map((message) => `@${oneLine(message.fromName)}：${oneLine(message.text)}`);
    const parts = [
      goalText,
      assignments.length === 0 ? '分工：暂无' : `分工：${assignments.join('；')}`,
      ...(relevant.length === 0 ? [] : [`最近：${relevant.join(' ｜ ')}`]),
    ];
    return clip(parts.join('\n'), 300);
  }

  private purgeExpiredLocks(commit: boolean): void {
    const now = this.now();
    let changed = false;
    for (const [zone, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(zone);
        changed = true;
      }
    }
    if (changed && commit) this.commit(false);
  }

  private commit(notify = true): TeamBlackboardSnapshot {
    this.version += 1;
    const snapshot = this.snapshot();
    if (notify) {
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch {
          /* 订阅方异常隔离，黑板仍保持一致 */
        }
      }
    }
    return snapshot;
  }
}
