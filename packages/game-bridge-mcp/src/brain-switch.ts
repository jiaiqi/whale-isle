/**
 * 大脑模式与临时代驾状态机（T-M6-70 §4.1 / §4.7）：
 *   - 'llm'          大脑开启且可用，完全由 LLM 自主决策（RulePlanner.decide 0 调用）
 *   - 'rule'         用户显式关闭大脑（纯规则日程）
 *   - 'rule-standin' 大脑开启但 LLM 不可用（无 Key / 单次超时或网关异常 / 连续 3 次输出无法解析 /
 *                    强制命令连续 2 次不合规），临时切 RulePlanner 代驾；
 *                    每现实 2 分钟探测一次 LLM（无 Key 恢复时立即交回），成功即切回 'llm'。
 */

export type BrainMode = 'llm' | 'rule' | 'rule-standin';

export type StandinTrigger = 'missing-key' | 'timeout' | 'parse-failure' | 'command-noncompliant';

export interface BrainSwitchOptions {
  /** 初始用户模式（默认 'llm'） */
  initialMode?: 'llm' | 'rule';
  /** 连续无法解析/越权输出上限（默认 3） */
  maxParseFailures?: number;
  /** 强制命令连续不合规输出上限（默认 2） */
  maxCommandNonCompliance?: number;
  /** 规则代驾期间探测 LLM 恢复的现实时间间隔（默认 2 分钟 = 120_000ms） */
  probeIntervalMs?: number;
  /** 动态探测当前是否有可用供应商 Key */
  isKeyAvailable?: () => boolean;
  /** 时钟注入（便于确定性单测） */
  now?: () => number;
  /** 状态切换通知（发射 AutodriveEvent { type: 'brain', mode, reason }） */
  onModeChange?: (mode: BrainMode, reason: string) => void;
}

export class BrainSwitch {
  private desiredMode: 'llm' | 'rule';
  private currentMode: BrainMode;
  private standinTrigger: StandinTrigger | null = null;
  private standinReason = '';
  private lastProbeAt = 0;
  private consecutiveParseFailures = 0;
  private consecutiveCommandNonCompliance = 0;

  private readonly maxParseFailures: number;
  private readonly maxCommandNonCompliance: number;
  private readonly probeIntervalMs: number;
  private readonly isKeyAvailable: () => boolean;
  private readonly now: () => number;
  private onModeChange?: (mode: BrainMode, reason: string) => void;

  constructor(options: BrainSwitchOptions = {}) {
    this.desiredMode = options.initialMode ?? 'llm';
    this.maxParseFailures = options.maxParseFailures ?? 3;
    this.maxCommandNonCompliance = options.maxCommandNonCompliance ?? 2;
    this.probeIntervalMs = options.probeIntervalMs ?? 2 * 60_000;
    this.isKeyAvailable = options.isKeyAvailable ?? (() => true);
    this.now = options.now ?? Date.now;
    if (options.onModeChange !== undefined) this.onModeChange = options.onModeChange;
    this.currentMode = this.desiredMode === 'rule' ? 'rule' : 'llm';
  }

  setModeChangeListener(listener: ((mode: BrainMode, reason: string) => void) | undefined): void {
    this.onModeChange = listener;
  }

  get mode(): BrainMode {
    return this.currentMode;
  }

  get userMode(): 'llm' | 'rule' {
    return this.desiredMode;
  }

  get reason(): string {
    return this.standinReason;
  }

  isStandin(): boolean {
    return this.currentMode === 'rule-standin';
  }

  /** 用户手动切换「大脑开 / 大脑关」 */
  setUserMode(next: 'llm' | 'rule', reason?: string): void {
    this.desiredMode = next;
    this.consecutiveParseFailures = 0;
    this.consecutiveCommandNonCompliance = 0;
    if (next === 'rule') {
      this.standinTrigger = null;
      this.standinReason = reason ?? '手动切换为规则日程';
      this.transition('rule', this.standinReason);
      return;
    }
    if (!this.isKeyAvailable()) {
      this.enterStandin('missing-key', reason ?? '未配置可用供应商 Key，切换规则代驾');
      return;
    }
    this.standinTrigger = null;
    this.standinReason = '';
    this.transition('llm', reason ?? '切换为 LLM 自主大脑');
  }

  /**
   * 决定本轮应该尝试调 LLM（返回 true）还是直接走规则（返回 false）。
   * - 'rule' 模式：恒 false
   * - 缺 Key：进入/保持 'rule-standin'，返回 false
   * - 'llm' 模式且有 Key：true
   * - 'rule-standin' 模式且有 Key：
   *   - 若之前是因为缺 Key 进入代驾，Key 一就绪立即尝试恢复（true）
   *   - 否则每经过 probeIntervalMs（2 分钟）尝试探测一次（true）
   */
  shouldTryLlm(): boolean {
    if (this.desiredMode === 'rule') return false;
    const keyReady = this.isKeyAvailable();
    if (!keyReady) {
      if (this.currentMode !== 'rule-standin' || this.standinTrigger !== 'missing-key') {
        this.enterStandin('missing-key', '未配置可用供应商 Key，切换规则代驾');
      }
      return false;
    }
    if (this.currentMode === 'llm') return true;
    // 当前在 rule-standin，但 Key 已可用
    if (this.standinTrigger === 'missing-key') {
      this.lastProbeAt = this.now();
      return true;
    }
    const elapsed = this.now() - this.lastProbeAt;
    if (elapsed >= this.probeIntervalMs) {
      this.lastProbeAt = this.now();
      return true;
    }
    return false;
  }

  /** LLM 成功产出一个合规决策（或成功完成恢复探测）：清零计数并在代驾态立即交回 */
  recordSuccess(): void {
    this.consecutiveParseFailures = 0;
    this.consecutiveCommandNonCompliance = 0;
    if (this.desiredMode === 'llm' && this.currentMode !== 'llm') {
      this.standinTrigger = null;
      this.standinReason = '';
      this.transition('llm', 'LLM 探测恢复正常，交回自主决策');
    }
  }

  /** 单次网关超时或网络异常：立即进入规则代驾 */
  recordGatewayFailure(detail: string): void {
    if (this.desiredMode === 'rule') return;
    this.enterStandin('timeout', `LLM 调用异常或超时（${detail.slice(0, 80)}），切换规则代驾`);
  }

  /**
   * 记录一次无法解析或不在白名单的输出。
   * 返回 true 表示已达到连续阈值（默认 3 次）并已切入规则代驾。
   */
  recordParseFailure(detail: string): boolean {
    this.consecutiveParseFailures += 1;
    if (this.currentMode === 'rule-standin') {
      // 恢复探测失败：刷新探测时间戳，继续保持代驾
      this.lastProbeAt = this.now();
      return true;
    }
    if (this.consecutiveParseFailures >= this.maxParseFailures) {
      this.enterStandin('parse-failure', `连续 ${this.consecutiveParseFailures} 次输出无法解析或越权（${detail.slice(0, 60)}），切换规则代驾`);
      return true;
    }
    return false;
  }

  /**
   * 记录一次强制命令（/自然语言）不合规输出（如 decline/modify、缺表态、infeasible 缺原因）。
   * 连续达到阈值（默认 2 次）视为无法解析并切入规则代驾。
   */
  recordCommandNonCompliance(detail: string): boolean {
    this.consecutiveCommandNonCompliance += 1;
    if (this.currentMode === 'rule-standin') {
      this.lastProbeAt = this.now();
      return true;
    }
    if (this.consecutiveCommandNonCompliance >= this.maxCommandNonCompliance) {
      this.enterStandin('command-noncompliant', `强制命令连续 ${this.consecutiveCommandNonCompliance} 次输出不合规（${detail.slice(0, 60)}），切换规则代驾`);
      return true;
    }
    return false;
  }

  enterStandin(trigger: StandinTrigger, reason: string): void {
    this.standinTrigger = trigger;
    this.standinReason = reason;
    this.lastProbeAt = this.now();
    this.transition('rule-standin', reason);
  }

  snapshot(): {
    mode: BrainMode;
    userMode: 'llm' | 'rule';
    standinTrigger: StandinTrigger | null;
    standinReason: string;
    consecutiveParseFailures: number;
    consecutiveCommandNonCompliance: number;
  } {
    return {
      mode: this.currentMode,
      userMode: this.desiredMode,
      standinTrigger: this.standinTrigger,
      standinReason: this.standinReason,
      consecutiveParseFailures: this.consecutiveParseFailures,
      consecutiveCommandNonCompliance: this.consecutiveCommandNonCompliance,
    };
  }

  private transition(next: BrainMode, reason: string): void {
    if (this.currentMode === next) return;
    this.currentMode = next;
    this.onModeChange?.(next, reason);
  }
}
