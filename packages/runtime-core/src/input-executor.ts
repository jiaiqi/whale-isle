/**
 * V2-P3-03c 真实 OS 输入执行器骨架（feature flag 默认关闭，先做 dry-run）：
 * - `WHALE_ENABLE_OS_INPUT` 未开启时只记录意图，绝不注入任何键鼠事件。
 * - 即使开启：缺少原生注入器时如实返回 `not_implemented`；缺少辅助功能权限时返回 `permission_denied`。
 * - 每个原子动作执行前重新校验 ComputerUseLease；急停或人类抢占后立即拒绝。
 * - 真正的 CGEvent / SendInput 注入在本轮标记 PENDING，最高只到 IMPLEMENTED_UNVERIFIED。
 */
import type { ComputerInputExecutorStatus, ComputerUseLease } from '@workbench/shared-protocol';

/** 只依赖租约校验端口，避免与 automation-security 形成循环依赖 */
export interface ComputerLeasePort {
  validateLease(leaseId: string): {
    ok: boolean;
    reason?: string;
    lease?: ComputerUseLease;
  };
}

export type InputPermissionState = 'granted' | 'denied' | 'unknown';

export type ComputerInputStepKind = 'click' | 'move' | 'type_text' | 'key' | 'scroll' | 'screenshot';

export interface ComputerInputStep {
  kind: ComputerInputStepKind;
  /** 点击/移动坐标（屏幕坐标系） */
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
  detail?: string;
}

export type ComputerInputResultCode =
  | 'executed'
  | 'dry_run'
  | 'feature_disabled'
  | 'lease_required'
  | 'permission_denied'
  | 'not_implemented';

export interface ComputerInputResult {
  ok: boolean;
  executed: boolean;
  mode: 'dry_run' | 'live';
  code: ComputerInputResultCode;
  detail: string;
  intentAt: number;
  leaseId: string | null;
}

export interface ComputerInputExecutorOptions {
  leases: ComputerLeasePort;
  /** 默认 false：只 dry-run，不触碰真实 OS 输入 */
  enabled?: boolean;
  permissionProbe?: () => InputPermissionState;
  /** 原生注入器由后续 3c 真机实现注入；缺失时绝不伪造执行成功 */
  nativeInjector?: (step: ComputerInputStep, at: number) => void;
  /** 每次真实注入后通知检测器排除合成事件 */
  onSyntheticInput?: (at: number) => void;
  now?: () => number;
}

export class ComputerInputExecutor {
  private readonly leases: ComputerLeasePort;
  private enabled: boolean;
  private readonly permissionProbe: () => InputPermissionState;
  private readonly nativeInjector: ((step: ComputerInputStep, at: number) => void) | undefined;
  private readonly onSyntheticInput: ((at: number) => void) | undefined;
  private readonly now: () => number;

  private dryRunCount = 0;
  private executedCount = 0;
  private rejectedCount = 0;
  private lastIntentAt: number | null = null;

  constructor(options: ComputerInputExecutorOptions) {
    this.leases = options.leases;
    this.enabled = options.enabled ?? false;
    this.permissionProbe = options.permissionProbe ?? (() => 'unknown');
    this.nativeInjector = options.nativeInjector;
    this.onSyntheticInput = options.onSyntheticInput;
    this.now = options.now ?? Date.now;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  execute(leaseId: string | null, step: ComputerInputStep): ComputerInputResult {
    const at = this.now();
    this.lastIntentAt = at;
    const base = { intentAt: at, leaseId };

    if (!this.enabled) {
      this.dryRunCount += 1;
      return {
        ...base,
        ok: true,
        executed: false,
        mode: 'dry_run',
        code: 'feature_disabled',
        detail: `OS 输入执行器未启用，仅记录意图：${step.kind}${step.detail ? `（${step.detail}）` : ''}`,
      };
    }

    const lease = this.requireLease(leaseId);
    if (!lease.ok) {
      this.rejectedCount += 1;
      return {
        ...base,
        ok: false,
        executed: false,
        mode: 'dry_run',
        code: 'lease_required',
        detail: `拒绝执行：${lease.reason ?? '未持有有效 ComputerUseLease'}`,
      };
    }

    if (!this.nativeInjector) {
      this.dryRunCount += 1;
      return {
        ...base,
        ok: false,
        executed: false,
        mode: 'dry_run',
        code: 'not_implemented',
        detail: '已开启 OS 输入开关，但原生 CGEvent/SendInput 注入器尚未接线（3c PENDING），未执行真实输入',
      };
    }

    const permission = this.permissionProbe();
    if (permission !== 'granted') {
      this.rejectedCount += 1;
      return {
        ...base,
        ok: false,
        executed: false,
        mode: 'dry_run',
        code: 'permission_denied',
        detail:
          permission === 'denied'
            ? '缺少辅助功能（Accessibility）权限，拒绝静默降级；请在系统设置中授权后重试'
            : '无法确认辅助功能权限状态，按 fail-closed 拒绝真实输入',
      };
    }

    try {
      this.nativeInjector(step, at);
      this.onSyntheticInput?.(at);
      this.executedCount += 1;
      return {
        ...base,
        ok: true,
        executed: true,
        mode: 'live',
        code: 'executed',
        detail: `已注入 ${step.kind}（租约 ${lease.lease?.leaseId ?? 'unknown'}）`,
      };
    } catch (err) {
      this.rejectedCount += 1;
      return {
        ...base,
        ok: false,
        executed: false,
        mode: 'live',
        code: 'not_implemented',
        detail: `原生注入失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  status(): ComputerInputExecutorStatus {
    const permission = this.enabled ? this.permissionProbe() : 'unknown';
    const mode: ComputerInputExecutorStatus['mode'] = !this.enabled
      ? 'disabled'
      : this.nativeInjector && permission === 'granted'
        ? 'live'
        : 'dry_run';
    return {
      enabled: this.enabled,
      mode,
      permission,
      dryRunCount: this.dryRunCount,
      executedCount: this.executedCount,
      rejectedCount: this.rejectedCount,
      lastIntentAt: this.lastIntentAt,
    };
  }

  private requireLease(leaseId: string | null): { ok: boolean; reason?: string; lease?: ComputerUseLease } {
    if (!leaseId) return { ok: false, reason: '缺少 leaseId' };
    return this.leases.validateLease(leaseId);
  }
}
