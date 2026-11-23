/**
 * HuddleOrchestrator（T-M6-39）：拟人化“开麦商量”状态机。
 *
 * 硬护栏：
 *   - 同一时刻仅一场商量；
 *   - 默认最多 3 轮（2 轮收敛即写入，不为了演满 3 轮烧钱）；
 *   - 自动触发默认 5 分钟冷却，真人手动可强制；
 *   - 单场 token 预算耗尽 / LLM 异常 → 本地规则分工，不阻塞游戏；
 *   - 回合结束必定落黑板（plan_commit）并向 Runner 下发 directive。
 *
 * 本类不直接依赖 Electron / 模型 SDK：LLM、语音、Runner 都以回调注入，便于确定性测试。
 */
import { randomUUID } from 'node:crypto';
import {
  TeamPlanSchema,
  type TeamBlackboardSnapshot,
  type TeamCommsMessage,
  type TeamGoal,
  type TeamPlan,
} from '@workbench/shared-protocol';
import type { TeamBlackboard } from './team-blackboard';

export interface HuddleParticipant {
  agentId: string;
  displayName: string;
  /** 角色人设 prompt（各角色口吻差异） */
  personaPrompt: string;
  /** 当前游戏状态摘要（体力/背包/位置），由宿主从最近 state 回执生成 */
  stateText: string;
  /** 较高优先级角色在 Round 3 拍板（数字大者优先） */
  priority?: number;
}

export interface HuddleTrigger {
  reason: string;
  goalTitle?: string;
  humanNote?: string;
  /** 真人点击 = true，跳过自动冷却 */
  manual?: boolean;
}

export interface HuddleProposalInput {
  round: 1 | 2 | 3;
  reason: string;
  goal: TeamGoal;
  participant: HuddleParticipant;
  blackboardSummary: string;
  priorProposals: string[];
  humanNote: string;
}

export interface HuddleProposal {
  text: string;
  tokensUsed?: number;
}

export interface HuddleConvergeInput {
  round: 2 | 3;
  goal: TeamGoal;
  reasoning: string;
  participants: HuddleParticipant[];
  proposals: string[];
  humanNote: string;
  /** Round 3 由最高优先级角色拍板 */
  chair?: HuddleParticipant;
}

export interface HuddleConvergence {
  text: string;
  plan?: TeamPlan;
  tokensUsed?: number;
}

export interface HuddleBrain {
  propose(input: HuddleProposalInput): Promise<HuddleProposal>;
  converge(input: HuddleConvergeInput): Promise<HuddleConvergence>;
}

export interface HuddleOrchestratorOptions {
  blackboard: TeamBlackboard;
  participants: () => HuddleParticipant[];
  brain: HuddleBrain;
  /** 每场商量的 token 上限（默认 12,000）；未给 budget 时只做本地估算记录 */
  tokenBudget?: number;
  /** 全局 token-meter 余量；返回 null/undefined 表示无可用信息 */
  remainingTokens?: () => number | null;
  autoCooldownMs?: number;
  maxRounds?: 2 | 3;
  now?: () => number;
  speak?: (participant: HuddleParticipant, text: string) => Promise<void>;
  onMessage?: (message: TeamCommsMessage) => void;
  /** 把计划分发到对应 runtime；失败不撤销黑板，但会在消息里明确“待执行” */
  dispatch?: (plan: TeamPlan) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface HuddleResult {
  ok: boolean;
  reason?: string;
  plan?: TeamPlan;
  fallback: boolean;
  rounds: number;
}

export class HuddleOrchestrator {
  private running = false;
  private readonly now: () => number;
  private readonly maxRounds: 2 | 3;
  private readonly autoCooldownMs: number;
  private readonly tokenBudget: number;
  private sequence = 0;

  constructor(private readonly options: HuddleOrchestratorOptions) {
    this.now = options.now ?? Date.now;
    this.maxRounds = options.maxRounds ?? 3;
    this.autoCooldownMs = options.autoCooldownMs ?? 5 * 60_000;
    this.tokenBudget = Math.max(500, options.tokenBudget ?? 12_000);
  }

  isRunning(): boolean {
    return this.running;
  }

  async trigger(trigger: HuddleTrigger): Promise<HuddleResult> {
    if (this.running) return { ok: false, reason: '已有协商进行中', fallback: false, rounds: 0 };
    const snapshot = this.options.blackboard.snapshot();
    if (trigger.manual !== true && this.now() < snapshot.huddleState.cooldownUntil) {
      return { ok: false, reason: '自动协商仍在 5 分钟冷却期', fallback: false, rounds: 0 };
    }
    const participants = this.options.participants();
    if (participants.length === 0) {
      return { ok: false, reason: '没有可参与协商的 AI 队友', fallback: false, rounds: 0 };
    }

    this.running = true;
    let usedTokens = 0;
    let fallback = false;
    let rounds = 0;
    try {
      if (trigger.goalTitle !== undefined && trigger.goalTitle.trim() !== '') {
        this.options.blackboard.patchGoal({ title: trigger.goalTitle.trim(), status: 'active' });
      }
      this.options.blackboard.setHuddleState({ active: true, round: 1, maxRounds: this.maxRounds });
      const proposals: string[] = [];
      for (const participant of participants) {
        if (this.budgetExhausted(usedTokens)) {
          fallback = true;
          break;
        }
        const result = await this.options.brain.propose({
          round: 1,
          reason: trigger.reason,
          goal: this.options.blackboard.snapshot().goal,
          participant,
          blackboardSummary: this.options.blackboard.formatCompactPromptSummary(participant.agentId),
          priorProposals: [...proposals],
          humanNote: trigger.humanNote ?? '',
        });
        usedTokens += result.tokensUsed ?? estimateTokens(result.text);
        proposals.push(`${participant.displayName}：${result.text}`);
        rounds = 1;
        await this.publish(participant.agentId, participant.displayName, 'proposal', result.text, '');
        await this.speak(participant, result.text);
        this.options.blackboard.setHuddleState({ round: 1 });
      }

      if (fallback) return this.fallbackPlan(participants, 'token 预算已用尽', 1);

      // Round 2：收敛为结构化 TeamPlan；收敛成功立即落地，不为凑满轮次继续烧钱。
      this.options.blackboard.setHuddleState({ round: 2 });
      rounds = 2;
      const convergence = await this.converge(participants, proposals, trigger, 2);
      usedTokens += convergence.tokensUsed ?? estimateTokens(convergence.text);
      if (convergence.plan !== undefined) {
        return await this.commit(convergence.plan, proposals, 2, false);
      }
      if (this.maxRounds === 2) return this.fallbackPlan(participants, 'Round 2 未收敛', 2);
      if (this.budgetExhausted(usedTokens)) return this.fallbackPlan(participants, 'token 预算已用尽', 2);

      // Round 3：最高优先级角色拍板；仍无结构化计划则本地规则兜底。
      this.options.blackboard.setHuddleState({ round: 3 });
      rounds = 3;
      const final = await this.converge(participants, proposals, trigger, 3);
      usedTokens += final.tokensUsed ?? estimateTokens(final.text);
      if (final.plan !== undefined) return await this.commit(final.plan, proposals, 3, false);
      return this.fallbackPlan(participants, 'Round 3 仍未收敛', 3);
    } catch (error) {
      this.options.onError?.(error);
      return this.fallbackPlan(participants, '协商调用失败，已降级本地分工', Math.max(1, rounds));
    } finally {
      this.running = false;
      void usedTokens;
    }
  }

  private async converge(
    participants: HuddleParticipant[],
    proposals: string[],
    trigger: HuddleTrigger,
    round: 2 | 3,
  ): Promise<HuddleConvergence> {
    const chair = round === 3
      ? [...participants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]
      : undefined;
    return this.options.brain.converge({
      round,
      goal: this.options.blackboard.snapshot().goal,
      reasoning: trigger.reason,
      participants,
      proposals,
      humanNote: trigger.humanNote ?? '',
      ...(chair === undefined ? {} : { chair }),
    });
  }

  private async commit(plan: TeamPlan, proposals: string[], rounds: number, fallback: boolean): Promise<HuddleResult> {
    const parsed = TeamPlanSchema.parse(plan);
    this.options.blackboard.applyPlan(parsed.id, parsed.assignments);
    this.options.blackboard.setHuddleState({
      active: false,
      round: rounds,
      maxRounds: this.maxRounds,
      cooldownUntil: this.now() + this.autoCooldownMs,
    });
    const chair = this.options.participants().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
    if (chair !== undefined) {
      await this.publish(chair.agentId, chair.displayName, 'plan_commit', parsed.summary || '分工已写入黑板', JSON.stringify(parsed), parsed);
      await this.speak(chair, parsed.summary || '好，就按这个分工来！');
    }
    if (this.options.dispatch !== undefined) {
      await this.options.dispatch(parsed).catch((error) => {
        this.options.onError?.(error);
        void this.publish('system', '系统', 'chat', '计划已写入黑板，但部分 Agent 指令下发失败，等待下轮重试', '');
      });
    }
    void proposals;
    return { ok: true, plan: parsed, fallback, rounds };
  }

  private async fallbackPlan(participants: HuddleParticipant[], reason: string, rounds: number): Promise<HuddleResult> {
    const snapshot = this.options.blackboard.snapshot();
    const plan: TeamPlan = {
      id: `fallback-${this.now()}-${this.sequence++}`,
      title: snapshot.goal.title,
      summary: `${reason}；按当前分工继续，绝不空转。`,
      assignments: participants.map((participant) => {
        const previous = snapshot.assignments.find((item) => item.agentId === participant.agentId);
        return {
          agentId: participant.agentId,
          displayName: participant.displayName,
          task: previous?.task || `围绕「${snapshot.goal.title}」继续当前可执行工作`,
          zone: previous?.zone ?? '',
        };
      }),
    };
    await this.publish('system', '系统', 'chat', plan.summary, '');
    return this.commit(plan, [], rounds, true);
  }

  private budgetExhausted(usedTokens: number): boolean {
    if (usedTokens >= this.tokenBudget) return true;
    const remaining = this.options.remainingTokens?.();
    return typeof remaining === 'number' && remaining <= 0;
  }

  private async publish(
    fromAgentId: string,
    fromName: string,
    kind: TeamCommsMessage['kind'],
    text: string,
    _rawPlan: string,
    planCard?: TeamPlan,
  ): Promise<void> {
    const message: TeamCommsMessage = {
      id: randomUUID(),
      ts: this.now(),
      fromAgentId,
      fromName,
      fromRole: fromAgentId === 'system' ? 'system' : 'ai',
      mentions: kind === 'proposal' || kind === 'plan_commit' ? ['@全队'] : [],
      kind,
      text,
      ...(planCard === undefined ? {} : { planCard }),
    };
    this.options.blackboard.appendMessage(message);
    this.options.onMessage?.(message);
  }

  private async speak(participant: HuddleParticipant, text: string): Promise<void> {
    if (text.trim() === '' || this.options.speak === undefined) return;
    await this.options.speak(participant, text).catch((error) => this.options.onError?.(error));
  }
}

function estimateTokens(text: string): number {
  // 与 token-meter 同样的保守思路：中文 1 字≈1 token，英文 4 字符≈1 token；只用于预算护栏。
  return Math.max(1, Math.ceil([...text].length * 0.8));
}

export function activeSnapshot(blackboard: TeamBlackboard): TeamBlackboardSnapshot {
  return blackboard.snapshot();
}
