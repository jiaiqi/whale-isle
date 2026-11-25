/**
 * 大脑模式与 AI-First 安全暂停状态机（T-M6-70 → V2-P1-06 / ADR-002 D-103）：
 *   - 'llm'          大脑开启且可用，完全由 LLM 自主决策（RulePlanner.decide 0 调用）
 *   - 'paused'       默认故障安全态：LLM 不可用（缺 Key / 异常 / 连续失范）且未显式开启规则代驾时，
 *                    暂停高级自主决策并通知用户（0 次 RulePlanner 调用）
 *   - 'rule'         用户显式选择切至 RulePlanner 离线/测试模式
 *   - 'rule-standin' 仅当显式传入 allowRuleStandin=true（兼容或测试模式）时才启用的规则临时代驾
 */

export type BrainMode = 'llm' | 'paused' | 'rule' | 'rule-standin';

export type StandinTrigger = 'missing-key' | 'timeout' | 'parse-failure' | 'command-noncompliant';

export interface BrainSwitchOptions {
  /** 初始用户模式（默认 'llm'） */
  initialMode?: 'llm' | 'rule';
  /** 是否允许在 LLM 异常时自动切入 RulePlanner 代驾（默认 false：遵循 ADR-002 D-103 安全暂停） */
  allowRuleStandin?: boolean;
  /** 连续无法解析/越权输出上限（默认 3） */
  maxParseFailures?: number;
  /** 强制命令连续不合规输出上限（默认 2） */
  maxCommandNonCompliance?: number;
  /** 暂停/代驾期间探测 LLM 恢复的现实时间间隔（默认 2 分钟 = 120_000ms） */
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

  private readonly allowRuleStandin: boolean;
  private readonly maxParseFailures: number;
  private readonly maxCommandNonCompliance: number;
  private readonly probeIntervalMs: number;
  private readonly isKeyAvailable: () => boolean;
  private readonly now: () => number;
  private onModeChange?: (mode: BrainMode, reason: string) => void;

  constructor(options: BrainSwitchOptions = {}) {
    this.desiredMode = options.initialMode ?? 'llm';
    this.allowRuleStandin = options.allowRuleStandin ?? false;
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

  isPaused(): boolean {
    return this.currentMode === 'paused';
  }

  isStandin(): boolean {
    return this.currentMode === 'rule-standin';
  }

  isUnavailable(): boolean {
    return this.currentMode === 'paused' || this.currentMode === 'rule-standin';
  }

  private unavailableMode(): 'paused' | 'rule-standin' {
    return this.allowRuleStandin ? 'rule-standin' : 'paused';
  }

  private actionSuffix(): string {
    return this.allowRuleStandin ? '切换规则代驾' : '已安全暂停高级自主决策';
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
      this.enterStandin('missing-key', reason ?? `未配置可用供应商 Key，${this.actionSuffix()}`);
      return;
    }
    this.standinTrigger = null;
    this.standinReason = '';
    this.transition('llm', reason ?? '切换为 LLM 自主大脑');
  }

  /**
   * 决定本轮应该尝试调 LLM（返回 true）还是跳过 LLM（返回 false）：
   * - 'rule' 模式：恒 false
   * - 缺 Key：进入/保持 'paused'（或 'rule-standin'），返回 false
   * - 'llm' 模式且有 Key：true
   * - 'paused' / 'rule-standin' 模式且有 Key：缺 Key 恢复时立即重试，其余每 probeIntervalMs 探测一次
   */
  shouldTryLlm(): boolean {
    if (this.desiredMode === 'rule') return false;
    const keyReady = this.isKeyAvailable();
    if (!keyReady) {
      const target = this.unavailableMode();
      if (this.currentMode !== target || this.standinTrigger !== 'missing-key') {
        this.enterStandin('missing-key', `未配置可用供应商 Key，${this.actionSuffix()}`);
      }
      return false;
    }
    if (this.currentMode === 'llm') return true;
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

  /** LLM 成功产出一个合规决策（或成功完成恢复探测）：清零计数并立即交回 'llm' */
  recordSuccess(): void {
    this.consecutiveParseFailures = 0;
    this.consecutiveCommandNonCompliance = 0;
    if (this.desiredMode === 'llm' && this.currentMode !== 'llm') {
      this.standinTrigger = null;
      this.standinReason = '';
      this.transition('llm', 'LLM 探测恢复正常，交回自主决策');
    }
  }

  /** 单次网关超时或网络异常：默认进入安全暂停（或显式启用时规则代驾） */
  recordGatewayFailure(detail: string): void {
    if (this.desiredMode === 'rule') return;
    this.enterStandin('timeout', `LLM 调用异常或超时（${detail.slice(0, 80)}），${this.actionSuffix()}`);
  }

  /** 记录一次无法解析或不在白名单的输出 */
  recordParseFailure(detail: string): boolean {
    this.consecutiveParseFailures += 1;
    if (this.isUnavailable()) {
      this.lastProbeAt = this.now();
      return true;
    }
    if (this.consecutiveParseFailures >= this.maxParseFailures) {
      this.enterStandin(
        'parse-failure',
        `连续 ${this.consecutiveParseFailures} 次输出无法解析或越权（${detail.slice(0, 60)}），${this.actionSuffix()}`,
      );
      return true;
    }
    return false;
  }

  /** 记录一次强制命令（/自然语言）不合规输出 */
  recordCommandNonCompliance(detail: string): boolean {
    this.consecutiveCommandNonCompliance += 1;
    if (this.isUnavailable()) {
      this.lastProbeAt = this.now();
      return true;
    }
    if (this.consecutiveCommandNonCompliance >= this.maxCommandNonCompliance) {
      this.enterStandin(
        'command-noncompliant',
        `强制命令连续 ${this.consecutiveCommandNonCompliance} 次输出不合规（${detail.slice(0, 60)}），${this.actionSuffix()}`,
      );
      return true;
    }
    return false;
  }

  enterStandin(trigger: StandinTrigger, reason: string): void {
    this.standinTrigger = trigger;
    this.standinReason = reason;
    this.lastProbeAt = this.now();
    this.transition(this.unavailableMode(), reason);
  }

  snapshot(): {
    mode: BrainMode;
    userMode: 'llm' | 'rule';
    allowRuleStandin: boolean;
    standinTrigger: StandinTrigger | null;
    standinReason: string;
    consecutiveParseFailures: number;
    consecutiveCommandNonCompliance: number;
  } {
    return {
      mode: this.currentMode,
      userMode: this.desiredMode,
      allowRuleStandin: this.allowRuleStandin,
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
