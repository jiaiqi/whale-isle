/**
 * 单端语音播放锁（T-M2-01，dsh-pet「语音」节机制工程化）。
 *
 * 已核实的 dsh-pet 机制（FEATURES.md「🔊 语音」）：
 *   - "哪一端出声：一次只在一端响" → 单端互斥：任意时刻最多一条音轨在播（active ≤ 1 不变式）；
 *   - "气泡会等语音：出声并播完再收" → 播放完成回执驱动生命周期（adapter play resolve = onended）；
 *   - "合成失败或超时……不打断对话" → TTL 强制释放 + 失败兜底，队列继续。
 *
 * 策略（SPEC §3.1 AudioLease(ttlMs)）：
 *   - 无在飞 → 直接授予；
 *   - P0_INTERRUPT 到达 → 抢占在飞（回执 INTERRUPTED_BY_P0）并立即授予；
 *   - 其余到达 → 入队（P0 优先、同级 FIFO），释放后按序串行授予；
 *   - TTL 到期 → 强制释放（回执 TTL_EXPIRED）；
 *   - 回执出站前经 AudioPlaybackReceiptSchema 校验（契约先行）。
 */
import { AudioPlaybackReceiptSchema, type AudioPlaybackReceipt } from '@workbench/shared-protocol';

export type PlaybackPriority = 'P0_INTERRUPT' | 'P1_CADENCE' | 'P2_IDLE';
export type PlaybackStatus = AudioPlaybackReceipt['status'];

export type { AudioPlaybackReceipt };

/** 音频适配器：真实实现 = WebAudio（onended resolve / error reject / abort 停止）；测试注入受控 Fake */
export interface LeaseAudioAdapter {
  /** 播放：resolve = 播完（onended 真实回执）；reject = 设备错误或被 abort */
  play(leaseId: string, durationMs: number | undefined, onElapsed?: (ms: number) => void): Promise<void>;
  abort(leaseId: string): void;
}

interface PendingLease {
  leaseId: string;
  priority: PlaybackPriority;
  ttlMs: number;
  durationMs?: number;
}

interface ActiveLease extends PendingLease {
  startedAt: number;
  elapsedMs: number;
  /** 终态裁定：由 TTL/抢占预标记；play 结算时按预标记优先 */
  verdict: PlaybackStatus | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

export interface AudioLeaseOptions {
  adapter: LeaseAudioAdapter;
  now?: () => number;
  /** 回执监听（宿主：渲染气泡收起 / 落库 / 转发主进程） */
  onReceipt?: (receipt: AudioPlaybackReceipt) => void;
  /** 不变式哨兵（测试断言 active ≤ 1 用） */
  onActiveChange?: (activeCount: number) => void;
}

export type AcquireResult = 'granted' | 'queued' | 'preempted-holder-replaced';

export class AudioLeaseManager {
  private active: ActiveLease | null = null;
  private queue: PendingLease[] = [];
  private readonly emitReceipt: (leaseId: string, status: PlaybackStatus, playedMs: number) => void;

  constructor(private readonly options: AudioLeaseOptions) {
    const clock = options.now ?? Date.now;
    this.emitReceipt = (leaseId, status, playedMs) => {
      const receipt = AudioPlaybackReceiptSchema.parse({
        leaseId,
        status,
        actualPlayedMs: Math.max(0, Math.round(playedMs)),
        timestamp: clock(),
      });
      options.onReceipt?.(receipt);
    };
  }

  /** 当前在飞数量（不变式哨兵：任何时刻 ≤ 1） */
  activeCount(): number {
    return this.active ? 1 : 0;
  }

  /** 申请语音租约：'granted' 立即开播；'queued' 等待串行授予 */
  acquire(request: PendingLease): AcquireResult {
    if (this.active === null) {
      this.start(request);
      return 'granted';
    }
    if (request.priority === 'P0_INTERRUPT') {
      // P0 抢占：在飞动作立刻裁定 INTERRUPTED_BY_P0 并中止
      this.finishActive('INTERRUPTED_BY_P0');
      this.start(request);
      return 'granted';
    }
    this.queue.push(request);
    return 'queued';
  }

  /** 显式放弃排队中的租约（气泡关闭等场景） */
  cancel(leaseId: string): void {
    this.queue = this.queue.filter((lease) => lease.leaseId !== leaseId);
  }

  private start(request: PendingLease): void {
    const clock = this.options.now ?? Date.now;
    const lease: ActiveLease = {
      ...request,
      startedAt: clock(),
      elapsedMs: 0,
      verdict: null,
      ttlTimer: null,
    };
    this.active = lease;
    this.options.onActiveChange?.(this.activeCount());

    // TTL 强制释放（dsh-pet："合成失败或超时……不打断对话"）
    lease.ttlTimer = setTimeout(() => {
      if (this.active !== lease || lease.verdict !== null) return;
      lease.verdict = 'TTL_EXPIRED';
      this.options.adapter.abort(lease.leaseId);
    }, lease.ttlMs);

    void this.options.adapter
      .play(lease.leaseId, lease.durationMs, (ms) => {
        lease.elapsedMs = ms;
      })
      .then(() => {
        // onended 真实回执（预标记优先：TTL/抢占已裁定则以预标记结算）
        const status = lease.verdict ?? 'COMPLETED';
        this.settle(lease, status);
      })
      .catch(() => {
        const status = lease.verdict ?? 'AUDIO_DEVICE_ERROR';
        this.settle(lease, status);
      });
  }

  private settle(lease: ActiveLease, status: PlaybackStatus): void {
    if (lease.ttlTimer !== null) clearTimeout(lease.ttlTimer);
    if (this.active !== lease) return;
    this.active = null;
    this.options.onActiveChange?.(this.activeCount());
    const played = status === 'COMPLETED' ? lease.elapsedMs : Math.min(lease.elapsedMs, lease.durationMs ?? lease.elapsedMs);
    this.emitReceipt(lease.leaseId, status, played);
    this.dequeue();
  }

  private finishActive(status: PlaybackStatus): void {
    const lease = this.active;
    if (!lease) return;
    lease.verdict = status;
    if (lease.ttlTimer !== null) clearTimeout(lease.ttlTimer);
    // 先结算旧租约（回执 + 释放），再由调用方 start 新租约——顺序保证抢占回执不丢
    this.active = null;
    this.options.onActiveChange?.(this.activeCount());
    const played = Math.min(lease.elapsedMs, lease.durationMs ?? lease.elapsedMs);
    this.emitReceipt(lease.leaseId, status, played);
    this.options.adapter.abort(lease.leaseId); // play promise 将以拒绝结算 → settle 的 active 守卫防止双回执
  }

  private dequeue(): void {
    if (this.active !== null || this.queue.length === 0) return;
    // P0 优先、同级 FIFO
    let index = this.queue.findIndex((lease) => lease.priority === 'P0_INTERRUPT');
    if (index < 0) index = 0;
    const [next] = this.queue.splice(index, 1);
    if (!next) return;
    this.start(next);
  }
}
