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
