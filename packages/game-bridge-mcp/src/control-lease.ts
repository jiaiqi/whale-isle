/**
 * Whale Isle V2 — 游戏角色控制权租约、安全暂停规划器与 13 项控制语义（V2-P1-06 / ADR-002 D-103·D-104）
 * - 严格实现三权分立中的 GameCharacterControlLease：
 *   - 人类接管或急停时立即拒绝 AI 动作写入
 *   - 校验 sessionId 与 generation，拒绝过期或跨会话迟到指令
 *   - 提供 PausedBrainPlanner：LLM 不可用时安全暂停，绝不静默调用 RulePlanner
 *   - 解析 Blueprint 17 §5.1 全部 13 项快捷控制语义
 */
import { randomUUID } from 'node:crypto';
import type { GameStateSnapshot, Planner, PlannerDecision } from './planner';

export type GameControlOwner = 'ai' | 'human' | 'paused' | 'halted';

export interface GameCharacterControlLeaseState {
  leaseId: string;
  characterId: string;
  gameId: string;
  sessionId: string;
  generation: number;
  owner: GameControlOwner;
  reason: string;
  updatedAt: number;
  expiresAt: number | null;
}

export interface DirectiveValidationResult {
  ok: boolean;
  code?: 'STALE_SESSION' | 'STALE_GENERATION' | 'CONTROL_BLOCKED';
  error?: string;
}

export class GameCharacterControlLease {
  private readonly leaseId: string = randomUUID();
  private readonly characterId: string;
  private readonly gameId: string;
  private readonly now: () => number;
  private sessionId: string;
  private generation: number;
  private ownerState: GameControlOwner = 'ai';
  private reasonState = '默认 AI 自主协同';
  private updatedAt: number;
  private expiresAt: number | null = null;

  constructor(options: {
    characterId?: string;
    gameId?: string;
    sessionId: string;
    generation?: number;
    now?: () => number;
  }) {
    this.characterId = options.characterId ?? 'char_xiaojing';
    this.gameId = options.gameId ?? 'stardew';
    this.sessionId = options.sessionId;
    this.generation = options.generation ?? 0;
    this.now = options.now ?? Date.now;
    this.updatedAt = this.now();
  }

  get owner(): GameControlOwner {
    return this.ownerState;
  }

  /** AI 是否持有有效且未过期的执行控制权 */
  canAiAct(): boolean {
    if (this.ownerState !== 'ai') return false;
    if (this.expiresAt !== null && this.now() >= this.expiresAt) {
      this.ownerState = 'paused';
      this.reasonState = 'AI 控制租约已到期，安全暂停等待续约';
      this.expiresAt = null;
      this.updatedAt = this.now();
      return false;
    }
    return true;
  }

  /** 申请或续期 AI 控制租约；人类接管或急停锁定期间拒绝抢权 */
  acquireAi(reason = 'AI 恢复自主游玩', ttlMs?: number): { ok: boolean; reason?: string } {
    if (this.ownerState === 'human') {
      return { ok: false, reason: '人类玩家正在接管角色控制权，AI 不得争抢' };
    }
    if (this.ownerState === 'halted') {
      return { ok: false, reason: '处于 P0 急停锁定态，需先显式恢复' };
    }
    const ts = this.now();
    this.ownerState = 'ai';
    this.reasonState = reason;
    this.updatedAt = ts;
    this.expiresAt = ttlMs !== undefined && ttlMs > 0 ? ts + ttlMs : null;
    return { ok: true };
  }

  /** 人类接管（UI 开关 / F9 / 游戏内键鼠触发）：无条件抢占 AI */
  takeOverByHuman(reason = '主人接管游戏控制权'): void {
    this.ownerState = 'human';
    this.reasonState = reason;
    this.expiresAt = null;
    this.updatedAt = this.now();
  }

  /** 人类交还控制权给 AI；仅在 human 态生效 */
  releaseHumanControl(reason = '主人交还控制权给 AI'): boolean {
    if (this.ownerState !== 'human') return false;
    this.ownerState = 'ai';
    this.reasonState = reason;
    this.expiresAt = null;
    this.updatedAt = this.now();
    return true;
  }

  /** 安全暂停 AI 高级自主决策（非急停、非人类键鼠接管） */
  pauseAi(reason: string): void {
    if (this.ownerState === 'halted' || this.ownerState === 'human') return;
    this.ownerState = 'paused';
    this.reasonState = reason;
    this.expiresAt = null;
    this.updatedAt = this.now();
  }

  /** 显式解除暂停或急停并交回 AI 自主态 */
  resumeAi(reason = '用户恢复 AI 自主运行'): boolean {
    if (this.ownerState !== 'paused' && this.ownerState !== 'halted') return false;
    this.ownerState = 'ai';
    this.reasonState = reason;
    this.expiresAt = null;
    this.updatedAt = this.now();
    return true;
  }

  /** P0 紧急停止：无条件锁定，阻止所有在飞与后续 AI 控制写入 */
  emergencyStop(reason = '用户触发紧急停止 Stop'): void {
    this.ownerState = 'halted';
    this.reasonState = reason;
    this.expiresAt = null;
    this.updatedAt = this.now();
  }

  /** 会话或游戏切换后推进世代，立即淘汰旧会话在途指令 */
  bumpSession(sessionId: string, generation: number): void {
    this.sessionId = sessionId;
    this.generation = generation;
    this.updatedAt = this.now();
  }

  /** 校验外部下发指令的会话归属、世代与当前租约许可 */
  validateDirective(scope?: { sessionId?: string; generation?: number }): DirectiveValidationResult {
    if (
      scope?.sessionId !== undefined &&
      scope.sessionId !== '' &&
      scope.sessionId !== this.sessionId
    ) {
      return {
        ok: false,
        code: 'STALE_SESSION',
        error: `会话已切换（期望 ${scope.sessionId.slice(0, 8)}，当前 ${this.sessionId.slice(0, 8)}），指令已拒绝`,
      };
    }
    if (scope?.generation !== undefined && scope.generation !== this.generation) {
      return {
        ok: false,
        code: 'STALE_GENERATION',
        error: `指令世代已过期（收到 gen=${scope.generation}，当前 gen=${this.generation}），已拒绝`,
      };
    }
    if (this.ownerState === 'human' || this.ownerState === 'halted') {
      return {
        ok: false,
        code: 'CONTROL_BLOCKED',
        error: this.ownerState === 'halted'
          ? 'P0 急停锁定中，拒绝写入游戏指令'
          : '人类玩家接管控制权中，AI 禁止写入控制指令',
      };
    }
    return { ok: true };
  }

  snapshot(): GameCharacterControlLeaseState {
    return {
      leaseId: this.leaseId,
      characterId: this.characterId,
      gameId: this.gameId,
      sessionId: this.sessionId,
      generation: this.generation,
      owner: this.ownerState,
      reason: this.reasonState,
      updatedAt: this.updatedAt,
      expiresAt: this.expiresAt,
    };
  }
}

/**
 * AI-First 安全暂停规划器（ADR-002 D-103）：
 * 当用户未显式启用 RulePlanner 且 LLM 不可用时挂载本规划器，
 * 绝不执行硬编码规则代玩，而是安全 wait 并通知用户。
 */
export class PausedBrainPlanner implements Planner {
  readonly name = 'ai-paused';

  constructor(private reason = 'AI 大脑暂不可用，已安全暂停游戏控制（未启用规则代驾）') {}

  setReason(reason: string): void {
    this.reason = reason;
  }

  async decide(_state: GameStateSnapshot): Promise<PlannerDecision> {
    return { kind: 'wait', seconds: 15, reason: this.reason };
  }

  debugSnapshot(): Record<string, unknown> {
    return { planner: this.name, paused: true, reason: this.reason };
  }
}

// ── Blueprint 17 §5.1 · 13 项快捷控制语义 ────────────────────────────────────

export type ControlSemanticKind =
  | 'stop'
  | 'pause_ai'
  | 'resume_ai'
  | 'take_over'
  | 'release_control'
  | 'follow_me'
  | 'stay_here'
  | 'do_this'
  | 'go_fish'
  | 'go_mine'
  | 'cancel_task'
  | 'what_are_you_doing'
  | 'show_plan';

export interface ParsedControlCommand {
  kind: ControlSemanticKind;
  argText?: string;
}

const CONTROL_RULES: ReadonlyArray<{
  kind: ControlSemanticKind;
  pattern: RegExp;
  withArg?: boolean;
}> = [
  { kind: 'stop', pattern: /^(?:\/?stop|急停|停下|立刻停手|紧急停止)$/i },
  { kind: 'pause_ai', pattern: /^(?:\/?pause(?:\s*ai)?|暂停(?:\s*ai)?)$/i },
  { kind: 'resume_ai', pattern: /^(?:\/?resume(?:\s*ai)?|恢复(?:\s*ai)?|继续玩)$/i },
  { kind: 'take_over', pattern: /^(?:\/?take\s*over|我来操作|人工接管|接管控制)$/i },
  { kind: 'release_control', pattern: /^(?:\/?release(?:\s*control)?|交还给\s*ai|交还控制)$/i },
  { kind: 'follow_me', pattern: /^(?:\/?follow(?:\s*me)?|跟我来|跟着我)$/i },
  { kind: 'stay_here', pattern: /^(?:\/?stay(?:\s*here)?|留在这里|原地待命)$/i },
  { kind: 'go_fish', pattern: /^(?:\/?go\s*fish|去钓鱼)$/i },
  { kind: 'go_mine', pattern: /^(?:\/?go\s*mine|去下矿|去矿洞)$/i },
  { kind: 'cancel_task', pattern: /^(?:\/?cancel(?:\s*task)?|取消任务|取消目标)$/i },
  { kind: 'what_are_you_doing', pattern: /^(?:what\s+are\s+you\s+doing\??|你在做什么[？?]?|当前在干嘛[？?]?)$/i },
  { kind: 'show_plan', pattern: /^(?:\/?show\s*plan|查看计划|今日计划)$/i },
  { kind: 'do_this', pattern: /^(?:\/?do\s*this|强制执行)\s+(.+)$/i, withArg: true },
];

export function parseControlCommand(input: string): ParsedControlCommand | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  for (const rule of CONTROL_RULES) {
    const match = rule.pattern.exec(trimmed);
    if (!match) continue;
    if (rule.withArg && match[1] !== undefined) {
      return { kind: rule.kind, argText: match[1].trim() };
    }
    return { kind: rule.kind };
  }
  return null;
}
