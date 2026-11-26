/**
 * V2-P3-03 用户物理输入检测（ADR-004）：
 * - 优先使用 Electron `powerMonitor.getSystemIdleTime()` 轮询，不引入原生全局 hook。
 * - 精度约 1 秒，因此验收口径是「≤ 1 s 撤销 ComputerUseLease」，不写「瞬间」。
 * - 执行器自己注入的合成事件同样会让 idle time 归零，必须用 `noteSyntheticInput()`
 *   在排除窗口内忽略，避免把自己的操作误判为用户输入。
 * - 本模块只负责检测与回调，不依赖 Electron，便于纯逻辑仿真测试。
 */
import type { HumanInputMonitorStatus } from '@workbench/shared-protocol';

export type HumanInputPollReason =
  | 'idle_active'
  | 'no_recent_activity'
  | 'synthetic_excluded'
  | 'read_failed';

export interface HumanInputDetectedInfo {
  idleSeconds: number;
  at: number;
}

export interface HumanInputMonitorOptions {
  readIdleSeconds: () => number;
  onHumanInput: (info: HumanInputDetectedInfo) => void;
  pollIntervalMs?: number;
  /** idle ≤ 该值视为“刚刚有物理输入”，默认 1 秒 */
  userInputThresholdSeconds?: number;
  /** 排除执行器自身合成事件的时间窗，默认 2000ms */
  syntheticExclusionMs?: number;
  /** 同一串连续输入的最小重复通知间隔，默认 1000ms */
  minSignalIntervalMs?: number;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class HumanInputMonitor {
  private readonly readIdleSeconds: () => number;
  private readonly onHumanInput: (info: HumanInputDetectedInfo) => void;
  private readonly pollIntervalMs: number;
  private readonly userInputThresholdSeconds: number;
  private readonly syntheticExclusionMs: number;
  private readonly minSignalIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private handle: unknown = null;
  private running = false;
  private polls = 0;
  private detected = 0;
  private syntheticExcluded = 0;
  private lastIdleSeconds: number | null = null;
  private lastHumanInputAt: number | null = null;
  private lastSyntheticAt: number | null = null;

  constructor(options: HumanInputMonitorOptions) {
    this.readIdleSeconds = options.readIdleSeconds;
    this.onHumanInput = options.onHumanInput;
    this.pollIntervalMs = Math.max(50, Math.round(options.pollIntervalMs ?? 250));
    this.userInputThresholdSeconds = Math.max(0, options.userInputThresholdSeconds ?? 1);
    this.syntheticExclusionMs = Math.max(0, Math.round(options.syntheticExclusionMs ?? 2_000));
    this.minSignalIntervalMs = Math.max(0, Math.round(options.minSignalIntervalMs ?? 1_000));
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ?? ((handler, ms) => setInterval(handler, ms) as unknown);
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.handle = this.setTimer(() => {
      this.pollOnce();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 执行器在注入合成键鼠后立即登记，排除窗口内不触发人类抢占 */
  noteSyntheticInput(at = this.now()): void {
    this.lastSyntheticAt = at;
  }

  pollOnce(): { humanInput: boolean; reason: HumanInputPollReason; idleSeconds: number | null } {
    this.polls += 1;
    const at = this.now();
    let idle: number;
    try {
      idle = this.readIdleSeconds();
    } catch {
      return { humanInput: false, reason: 'read_failed', idleSeconds: null };
    }
    if (!Number.isFinite(idle) || idle < 0) {
      return { humanInput: false, reason: 'read_failed', idleSeconds: null };
    }
    this.lastIdleSeconds = idle;

    if (idle > this.userInputThresholdSeconds) {
      return { humanInput: false, reason: 'no_recent_activity', idleSeconds: idle };
    }
    if (this.lastSyntheticAt !== null && at - this.lastSyntheticAt <= this.syntheticExclusionMs) {
      this.syntheticExcluded += 1;
      return { humanInput: false, reason: 'synthetic_excluded', idleSeconds: idle };
    }
    if (this.lastHumanInputAt !== null && at - this.lastHumanInputAt < this.minSignalIntervalMs) {
      return { humanInput: false, reason: 'idle_active', idleSeconds: idle };
    }

    this.detected += 1;
    this.lastHumanInputAt = at;
    this.onHumanInput({ idleSeconds: idle, at });
    return { humanInput: true, reason: 'idle_active', idleSeconds: idle };
  }

  status(): HumanInputMonitorStatus {
    return {
      running: this.running,
      polls: this.polls,
      detected: this.detected,
      syntheticExcluded: this.syntheticExcluded,
      lastIdleSeconds: this.lastIdleSeconds,
      lastHumanInputAt: this.lastHumanInputAt,
      lastSyntheticAt: this.lastSyntheticAt,
      pollIntervalMs: this.pollIntervalMs,
      userInputThresholdSeconds: this.userInputThresholdSeconds,
      syntheticExclusionMs: this.syntheticExclusionMs,
    };
  }
}
