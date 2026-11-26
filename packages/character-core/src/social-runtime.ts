/**
 * SocialRuntime L1 只读浏览内核（V2-P3-04C · REQ-SOC-01 / REQ-LIFE-01，蓝图 08 §5）：
 * - 会话状态机：planned → active ⇄ paused / awaiting_human → completed / aborted
 * - L1 硬护栏：契约层 interactionMode=readonly 之外，运行时再拦互动类能力调用
 * - 能力矩阵门禁：allowed=true 且 lastVerifiedAt>0（已实测）才放行——
 *   「第三方项目能做」不等于平台允许，未实测能力一律拒绝（REQ-SOC-01 铁律程序化）
 * - AI-First：候选选择由上层模型决策（chooseCandidate 注入），本类只做候选供给、
 *   预算（maxItems/maxDurationMs）、停止条件与事实事件广播，不写死内容规则树
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  BrowseCandidateSchema,
  BrowseSessionSchema,
  type BrowseSession,
  type BrowseSessionStopReason,
  type SocialAutonomyLevel,
  type SocialCapabilityKind,
  type SocialPlatformCapabilityEntry,
  type SocialPlatformId,
  SocialAutostartDecisionSchema,
  SocialAutostartRecordSchema,
  SocialAutostartSettingsSchema,
  SocialAutostartSnapshotSchema,
  type SocialAutostartBlockReason,
  type SocialAutostartDecision,
  type SocialAutostartOutcome,
  type SocialAutostartRecord,
  type SocialAutostartSettings,
  type SocialAutostartSnapshot,
} from '@workbench/shared-protocol';
import { WhaleError, type RuntimeEventBus } from '@workbench/runtime-core';

type BrowseCandidateInput = z.input<typeof BrowseCandidateSchema>;

/** L1 允许调用的只读能力 */
const L1_READ_CAPABILITIES: readonly SocialCapabilityKind[] = ['search_content', 'read_public', 'read_comments'];
/** L1 一律拒绝的互动能力 */
const L1_FORBIDDEN_CAPABILITIES: readonly SocialCapabilityKind[] = [
  'like_favorite',
  'follow',
  'comment_reply',
  'publish_image_text',
  'publish_video',
];

export interface SocialRuntimeOptions {
  characterId: string;
  profileId: string;
  events: RuntimeEventBus;
  /** 平台能力矩阵（运行期只读消费，须先经 Zod 校验） */
  capabilities?: SocialPlatformCapabilityEntry[];
  autonomyLevel?: SocialAutonomyLevel;
  now?: () => number;
  onMutate?: () => void;
}

export class SocialRuntime {
  private readonly sessions = new Map<string, BrowseSession>();
  private readonly capabilities: SocialPlatformCapabilityEntry[];
  private readonly autonomyLevel: SocialAutonomyLevel;
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(private readonly options: SocialRuntimeOptions) {
    this.capabilities = [...(options.capabilities ?? [])];
    this.autonomyLevel = options.autonomyLevel ?? 'l1_readonly';
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  /** 能力矩阵热更新（宿主持久化配置变更后调用，运行期只消费 Zod 校验过的条目） */
  updateCapabilities(entries: SocialPlatformCapabilityEntry[]): void {
    this.capabilities.length = 0;
    this.capabilities.push(...entries);
    this.onMutate?.();
  }

  /** 能力门禁：存在、授权、已实测三者齐备才放行 */
  assertCapability(platform: SocialPlatformId, capability: SocialCapabilityKind): SocialPlatformCapabilityEntry {
    if (this.autonomyLevel === 'l1_readonly' && L1_FORBIDDEN_CAPABILITIES.includes(capability)) {
      throw new WhaleError('PERMISSION_DENIED', `L1 只读阶段禁止互动能力：${capability}`, {
        recoverable: false,
        context: { platform, capability, autonomyLevel: this.autonomyLevel },
      });
    }
    const entry = this.capabilities.find((item) => item.platform === platform && item.capability === capability);
    if (!entry || !entry.allowed) {
      throw new WhaleError('PERMISSION_DENIED', `平台能力未授权：${platform}/${capability}`, {
        recoverable: false,
        context: { platform, capability },
      });
    }
    if (entry.lastVerifiedAt === 0) {
      throw new WhaleError('PERMISSION_DENIED', `平台能力未实测不得使用：${platform}/${capability}`, {
        recoverable: true,
        context: { platform, capability },
      });
    }
    return entry;
  }

  /** 规划一次 L1 只读浏览会话（校验目标平台读能力） */
  planSession(input: {
    platform: SocialPlatformId;
    objective: string;
    goalId?: string;
    maxItems?: number;
    maxDurationMs?: number;
  }): BrowseSession {
    this.assertCapability(input.platform, 'read_public');
    const session = BrowseSessionSchema.parse({
      sessionId: `bs-${randomUUID().slice(0, 8)}`,
      characterId: this.options.characterId,
      profileId: this.options.profileId,
      platform: input.platform,
      interactionMode: 'readonly',
      goalId: input.goalId,
      objective: input.objective,
      maxItems: input.maxItems,
      maxDurationMs: input.maxDurationMs,
      status: 'planned',
      startedAt: this.now(),
    });
    this.sessions.set(session.sessionId, session);
    this.onMutate?.();
    this.options.events.publish('social.session.planned', { session });
    return session;
  }

  startSession(sessionId: string): BrowseSession {
    const session = this.mustGet(sessionId);
    if (session.status !== 'planned' && session.status !== 'paused' && session.status !== 'awaiting_human') {
      throw new WhaleError('LIFECYCLE_INVALID', `会话状态不可启动：${session.status}`, {
        context: { sessionId, status: session.status },
      });
    }
    return this.mutate(sessionId, { ...session, status: 'active' }, 'social.session.started');
  }

  /**
   * 记录一条候选已被浏览（AI 选择结果由上层注入，本方法只做计数与预算检查）。
   * 达到 maxItems 自动按 budget_exhausted 收官。
   */
  recordViewed(sessionId: string, candidate: BrowseCandidateInput): BrowseSession {
    const session = this.requireActive(sessionId);
    const parsed = BrowseCandidateSchema.parse(candidate);
    const itemsViewed = session.itemsViewed + 1;
    this.options.events.publish('social.session.viewed', {
      sessionId,
      candidateId: parsed.candidateId,
      title: parsed.title,
      url: parsed.url,
      itemsViewed,
    });
    if (itemsViewed >= session.maxItems) {
      this.mutate(sessionId, { ...session, itemsViewed }, undefined);
      return this.finish(sessionId, 'completed', 'budget_exhausted');
    }
    return this.mutate(sessionId, { ...session, itemsViewed }, undefined);
  }

  /** 会话时钟推进：超过 maxDurationMs 自动收官（由调度层周期调用） */
  tick(sessionId: string): BrowseSession {
    const session = this.mustGet(sessionId);
    if (session.status !== 'active') return session;
    if (this.now() - session.startedAt >= session.maxDurationMs) {
      return this.finish(sessionId, 'completed', 'budget_exhausted');
    }
    return session;
  }

  pause(sessionId: string): BrowseSession {
    const session = this.requireActive(sessionId);
    return this.mutate(sessionId, { ...session, status: 'paused' }, 'social.session.paused');
  }

  /** CAPTCHA / 登录挑战等人工交接（复用 P3-03 awaiting_human 语义） */
  requestHumanHandoff(sessionId: string): BrowseSession {
    const session = this.requireActive(sessionId);
    return this.mutate(sessionId, { ...session, status: 'awaiting_human' }, 'social.session.awaiting_human');
  }

  /** 目标达成主动收官 */
  complete(sessionId: string): BrowseSession {
    const session = this.mustGet(sessionId);
    if (session.status === 'completed' || session.status === 'aborted') return session;
    return this.finish(sessionId, 'completed', 'objective_met');
  }

  abort(sessionId: string, reason: Extract<BrowseSessionStopReason, 'user_stopped' | 'handoff_timeout' | 'quiet_hours' | 'error'>): BrowseSession {
    const session = this.mustGet(sessionId);
    if (session.status === 'completed' || session.status === 'aborted') return session;
    return this.finish(sessionId, 'aborted', reason);
  }

  getSession(sessionId: string): BrowseSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): BrowseSession[] {
    return [...this.sessions.values()];
  }

  private mustGet(sessionId: string): BrowseSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new WhaleError('CHARACTER_NOT_FOUND', `浏览会话不存在：${sessionId}`, { context: { sessionId } });
    }
    return session;
  }

  private requireActive(sessionId: string): BrowseSession {
    const session = this.mustGet(sessionId);
    if (session.status !== 'active') {
      throw new WhaleError('LIFECYCLE_INVALID', `会话不在 active 状态：${session.status}`, {
        context: { sessionId, status: session.status },
      });
    }
    return session;
  }

  private finish(sessionId: string, status: 'completed' | 'aborted', stopReason: BrowseSessionStopReason): BrowseSession {
    const session = this.mustGet(sessionId);
    return this.mutate(
      sessionId,
      { ...session, status, stopReason, endedAt: this.now() },
      status === 'completed' ? 'social.session.completed' : 'social.session.aborted',
    );
  }

  private mutate(sessionId: string, next: BrowseSession, event: string | undefined): BrowseSession {
    const parsed = BrowseSessionSchema.parse(next);
    this.sessions.set(sessionId, parsed);
    this.onMutate?.();
    if (event) this.options.events.publish(event, { session: parsed });
    return parsed;
  }
}

/** 外部世界告诉策略层的事实（策略层不自己去问世界） */
export interface SocialAutostartFacts {
  /** 自主生活已暂停/急停（LifeRuntime.activityState().halted） */
  halted: boolean;
  /** 用户正在玩游戏 / 正在直播 / 正在用电脑 */
  userBusy: boolean;
  /** 平台能力矩阵里存在「已授权 + 已实测」的只读能力 */
  platformReady: boolean;
  /** L1 浏览执行器是否已接入（未接入不发起，避免空会话白吃预算） */
  executorReady: boolean;
  /** 模型网关是否就绪（未就绪按 ADR-002 安全暂停并提示，不静默退化） */
  modelReady: boolean;
  /** 当前是否有会话在跑 */
  activeSessionId?: string | null;
}

export interface SocialAutostartSessionEnd {
  sessionId: string;
  platform: SocialPlatformId;
  startedAt: number;
  endedAt: number;
  itemsViewed: number;
  status: BrowseSession['status'];
  stopReason?: BrowseSession['stopReason'];
  detail?: string;
}

const DAY_MS = 24 * 3_600_000;

/** 本地自然日键（YYYY-MM-DD）；跨日重置用，不做时区运算 */
export function localDayKey(at: number): string {
  const d = new Date(at);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export interface SocialAutostartSchedulerOptions {
  now?: () => number;
  /** 均匀随机 [0,1)；测试注入固定序列即可得到确定的间隔 */
  random?: () => number;
  settings?: Partial<SocialAutostartSettings>;
}

export class SocialAutostartScheduler {
  private settingsValue: SocialAutostartSettings;
  private readonly now: () => number;
  private readonly random: () => number;

  private dayKey: string;
  private sessionsToday = 0;
  private usedMsToday = 0;
  private consecutiveFailures = 0;
  private lastEndedAt: number | null = null;
  private lastOutcome: SocialAutostartOutcome | null = null;
  private nextEligibleAt: number | null = null;
  private records: SocialAutostartRecord[] = [];

  constructor(options: SocialAutostartSchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.settingsValue = normalizeSettings(SocialAutostartSettingsSchema.parse(options.settings ?? {}));
    this.dayKey = localDayKey(this.now());
  }

  settings(): SocialAutostartSettings {
    return { ...this.settingsValue };
  }

  /** 运行期只消费 Zod 校验过的配置；非法值直接抛错，不做「悄悄夹紧」的假宽容 */
  updateSettings(patch: Partial<SocialAutostartSettings>): SocialAutostartSettings {
    const parsed = SocialAutostartSettingsSchema.parse({ ...this.settingsValue, ...patch });
    this.settingsValue = normalizeSettings(parsed);
    return { ...this.settingsValue };
  }

  /** 判定现在能不能发起；reason/detail 直接喂给生活页，不许只说「未到时间」 */
  evaluate(facts: SocialAutostartFacts): SocialAutostartDecision {
    const now = this.now();
    this.rollDay(now);
    const s = this.settingsValue;
    const remainingMs = Math.max(0, s.dailyBudgetMs - this.usedMsToday);
    const maxDurationMs = Math.min(s.sessionMaxDurationMs, remainingMs);

    const block = (reason: SocialAutostartBlockReason, detail: string): SocialAutostartDecision =>
      SocialAutostartDecisionSchema.parse({
        canStart: false,
        blockReason: reason,
        detail,
        nextEligibleAt: this.nextEligibleAt,
        maxItems: s.sessionMaxItems,
        maxDurationMs: Math.max(1_000, maxDurationMs),
        maxUnderstandingCalls: s.maxUnderstandingCalls,
      });

    if (!s.enabled) return block('autostart_off', '自主发起已关闭（默认关闭，需在生活页显式打开）');
    if (facts.halted) return block('life_halted', '自主生活已暂停或已急停，直接不触发');
    if ((facts.activeSessionId ?? null) !== null) return block('session_active', '已有浏览会话进行中');
    if (this.inQuietHours(now)) {
      return block('quiet_hours', `夜间禁发时段 ${pad2(s.quietHoursStart)}:00–${pad2(s.quietHoursEnd)}:00`);
    }
    if (this.consecutiveFailures >= s.maxConsecutiveFailures) {
      return block('consecutive_failures', `连续 ${this.consecutiveFailures} 次失败，当日停发（次日重置）`);
    }
    if (this.sessionsToday >= s.maxSessionsPerDay) {
      return block('daily_sessions_exhausted', `今日已发起 ${this.sessionsToday} 次，达到每日上限 ${s.maxSessionsPerDay} 次`);
    }
    if (remainingMs < 60_000) {
      return block('daily_budget_exhausted', `今日累计时长已用 ${Math.round(this.usedMsToday / 60_000)} 分钟，达到上限 ${Math.round(s.dailyBudgetMs / 60_000)} 分钟`);
    }
    if (this.nextEligibleAt !== null && now < this.nextEligibleAt) {
      const reason: SocialAutostartBlockReason = this.lastOutcome === 'ok' ? 'interval_wait' : 'cooldown';
      const minutes = Math.ceil((this.nextEligibleAt - now) / 60_000);
      const detail =
        reason === 'cooldown'
          ? `上一次会话${this.lastOutcome === 'failed' ? '失败' : '中止'}，冷却中，还需 ${minutes} 分钟`
          : `距上次会话不足最小间隔，还需 ${minutes} 分钟`;
      return block(reason, detail);
    }
    if (!facts.platformReady) return block('platform_unverified', '没有「已授权且已实测」的平台只读能力，不发起');
    if (!facts.executorReady) return block('executor_not_ready', 'L1 浏览执行器未接入，发起也只会得到空会话，因此不发起');
    if (!facts.modelReady) return block('model_unavailable', '模型网关不可用，按 ADR-002 安全暂停自主决策');
    if (facts.userBusy) return block('user_busy', '用户正在玩游戏 / 直播 / 用电脑，让路不发起');

    return SocialAutostartDecisionSchema.parse({
      canStart: true,
      blockReason: null,
      detail: '可以发起',
      nextEligibleAt: this.nextEligibleAt,
      maxItems: s.sessionMaxItems,
      maxDurationMs: Math.max(1_000, maxDurationMs),
      maxUnderstandingCalls: s.maxUnderstandingCalls,
    });
  }

  /** 发起即计数（在开始时刻计数，避免崩溃循环把当日额度刷爆） */
  noteStarted(): void {
    const now = this.now();
    this.rollDay(now);
    this.sessionsToday += 1;
  }

  /** 收官结算：写当日用量、连续性失败、下一次可发起时间与最近 5 次记录 */
  noteEnded(end: SocialAutostartSessionEnd): SocialAutostartRecord {
    const settings = this.settingsValue;
    this.rollDay(end.endedAt);
    const durationMs = Math.max(0, end.endedAt - end.startedAt);
    this.usedMsToday += durationMs;
    const outcome = resolveOutcome(end);
    if (outcome === 'failed') this.consecutiveFailures += 1;
    if (outcome === 'ok') this.consecutiveFailures = 0;
    this.lastEndedAt = end.endedAt;
    this.lastOutcome = outcome;
    this.nextEligibleAt =
      outcome === 'ok'
        ? end.endedAt + this.nextIntervalMs()
        : end.endedAt + settings.cooldownMs;

    const record = SocialAutostartRecordSchema.parse({
      sessionId: end.sessionId,
      platform: end.platform,
      startedAt: end.startedAt,
      endedAt: end.endedAt,
      durationMs,
      itemsViewed: end.itemsViewed,
      stopReason: end.stopReason ?? (outcome === 'ok' ? 'objective_met' : 'error'),
      outcome,
      detail: end.detail ?? '',
    });
    this.records = [...this.records, record].slice(-5);
    return record;
  }

  /** 夜间跨点：正在跑的会话到 00:00 必须按 quiet_hours 收官，不许跨夜继续 */
  shouldAbortActive(at = this.now()): boolean {
    return this.inQuietHours(at);
  }

  snapshot(facts: SocialAutostartFacts, activeSession: BrowseSession | null): SocialAutostartSnapshot {
    const now = this.now();
    this.rollDay(now);
    const s = this.settingsValue;
    return SocialAutostartSnapshotSchema.parse({
      settings: s,
      decision: this.evaluate(facts),
      dayKey: this.dayKey,
      today: {
        sessions: this.sessionsToday,
        usedMs: this.usedMsToday,
        remainingSessions: Math.max(0, s.maxSessionsPerDay - this.sessionsToday),
        remainingMs: Math.max(0, s.dailyBudgetMs - this.usedMsToday),
      },
      activeSession,
      recent: this.records,
      consecutiveFailures: this.consecutiveFailures,
      executorReady: facts.executorReady,
    });
  }

  private nextIntervalMs(): number {
    const s = this.settingsValue;
    const span = Math.max(0, s.maxIntervalMs - s.minIntervalMs);
    const base = s.minIntervalMs + span * this.random();
    const jitter = base * s.jitterRatio * (this.random() * 2 - 1);
    return Math.max(s.cooldownMs, Math.round(base + jitter));
  }

  private inQuietHours(at: number): boolean {
    const s = this.settingsValue;
    if (s.quietHoursStart === s.quietHoursEnd) return false; // 起止相同 = 不设禁发时段
    const d = new Date(at);
    const minute = d.getHours() * 60 + d.getMinutes();
    const start = s.quietHoursStart * 60;
    const end = s.quietHoursEnd * 60;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }

  private rollDay(at: number): void {
    const key = localDayKey(at);
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.sessionsToday = 0;
    this.usedMsToday = 0;
    this.consecutiveFailures = 0;
    // nextEligibleAt 保留：昨日最后一次的冷却不该因为跨日就被绕过
    if (this.nextEligibleAt !== null && this.nextEligibleAt > at + DAY_MS) this.nextEligibleAt = null;
  }
}

function resolveOutcome(end: SocialAutostartSessionEnd): SocialAutostartOutcome {
  if (end.status === 'aborted') return 'aborted';
  if (end.status !== 'completed') return 'failed';
  if (end.stopReason === 'error') return 'failed';
  if (end.itemsViewed === 0) return 'failed';
  return 'ok';
}

function normalizeSettings(parsed: SocialAutostartSettings): SocialAutostartSettings {
  if (parsed.minIntervalMs <= parsed.maxIntervalMs) return parsed;
  return { ...parsed, minIntervalMs: parsed.maxIntervalMs, maxIntervalMs: parsed.minIntervalMs };
}

function pad2(value: number): string {
  return `${value}`.padStart(2, '0');
}
