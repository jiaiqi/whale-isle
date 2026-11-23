/**
 * 主进程全局串行抢麦租约（T-M6-38）。
 *
 * 为什么不在 pet-stage 渲染层各持一把：多桌宠后每窗一个 AudioLeaseManager 会各自发声，
 * 单端互斥失效。主进程是唯一音频输出方，因此把“谁在说话”的唯一租约放这里，
 * 所有桌宠窗只消费 coop:speaker 状态做动作。
 *
 * 不变式：active ≤ 1；P0 可抢占；TTL 强制释放；回执必须闭合后才启动下一条。
 */
import { randomUUID } from 'node:crypto';
import type { AudioPlaybackReceipt } from '@workbench/shared-protocol';

export type AudioLeaseStatus = AudioPlaybackReceipt['status'];
export type PlaybackPriority = 'P0_INTERRUPT' | 'P1_CADENCE' | 'P2_IDLE';

export interface GlobalAudioLeaseRequest {
  leaseId?: string;
  agentId: string;
  speakerName: string;
  voiceId?: string;
  priority: PlaybackPriority;
  ttlMs: number;
  /** 真正开始合成/播放；resolve = 播放完成（onended/afplay exit），reject = 设备/合成失败 */
  start(): Promise<void>;
  /** P0/TTL/取消时尽力停止当前播放；必须同步返回，不等待合成 */
  abort(): void;
}

export interface GlobalAudioLeaseEvent {
  activeAgentId: string | null;
  activeSpeakerName: string;
  activeVoiceId?: string;
  activeLeaseId: string | null;
}

interface NormalizedRequest extends GlobalAudioLeaseRequest {
  leaseId: string;
}

interface ActiveLease {
  request: NormalizedRequest;
  startedAt: number;
  verdict: AudioLeaseStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface GlobalAudioLeaseManagerOptions {
  now?: () => number;
  onActiveChange?: (event: GlobalAudioLeaseEvent) => void;
  onReceipt?: (receipt: AudioPlaybackReceipt & { agentId: string; speakerName: string }) => void;
}

export class GlobalAudioLeaseManager {
  private active: ActiveLease | null = null;
  private queue: NormalizedRequest[] = [];

  constructor(private readonly options: GlobalAudioLeaseManagerOptions = {}) {}

  activeCount(): number {
    return this.active === null ? 0 : 1;
  }

  current(): GlobalAudioLeaseEvent {
    if (this.active === null) return { activeAgentId: null, activeSpeakerName: '', activeLeaseId: null };
    return {
      activeAgentId: this.active.request.agentId,
      activeSpeakerName: this.active.request.speakerName,
      ...(this.active.request.voiceId === undefined ? {} : { activeVoiceId: this.active.request.voiceId }),
      activeLeaseId: this.active.request.leaseId ?? null,
    };
  }

  /** 申请租约；P0 抢占在播，其余排队。返回 granted/queued/preempted 三态。 */
  acquire(input: GlobalAudioLeaseRequest): 'granted' | 'queued' | 'preempted' {
    const request = this.normalize(input);
    if (this.active === null) {
      this.start(request);
      return 'granted';
    }
    if (request.priority === 'P0_INTERRUPT') {
      this.finishActive('INTERRUPTED_BY_P0');
      this.start(request);
      return 'preempted';
    }
    this.queue.push(request);
    return 'queued';
  }

  cancel(leaseId: string): boolean {
    const index = this.queue.findIndex((item) => item.leaseId === leaseId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      return true;
    }
    if (this.active?.request.leaseId === leaseId) {
      this.finishActive('INTERRUPTED_BY_P0');
      this.dequeue();
      return true;
    }
    return false;
  }

  /** 关闭应用时停止在播并丢弃排队。 */
  stopAll(): void {
    if (this.active !== null) this.finishActive('INTERRUPTED_BY_P0');
    this.queue = [];
  }

  private normalize(input: GlobalAudioLeaseRequest): NormalizedRequest {
    return {
      ...input,
      leaseId: input.leaseId ?? randomUUID(),
      ttlMs: Math.min(300_000, Math.max(500, Math.round(input.ttlMs))),
    };
  }

  private start(request: NormalizedRequest): void {
    const clock = this.options.now ?? Date.now;
    const active: ActiveLease = { request, startedAt: clock(), verdict: null, timer: null };
    this.active = active;
    this.emitActive();
    active.timer = setTimeout(() => {
      if (this.active !== active || active.verdict !== null) return;
      this.finishActive('TTL_EXPIRED');
      try { request.abort(); } catch { /* 已结束 */ }
      this.dequeue();
    }, request.ttlMs);

    void Promise.resolve()
      .then(() => request.start())
      .then(() => this.settle(active, active.verdict ?? 'COMPLETED', clock() - active.startedAt))
      .catch(() => this.settle(active, active.verdict ?? 'AUDIO_DEVICE_ERROR', clock() - active.startedAt));
  }

  private settle(active: ActiveLease, status: AudioLeaseStatus, playedMs: number): void {
    if (this.active !== active) return;
    if (active.timer !== null) clearTimeout(active.timer);
    this.active = null;
    this.options.onReceipt?.({
      leaseId: active.request.leaseId,
      status,
      actualPlayedMs: status === 'COMPLETED' ? Math.max(0, playedMs) : Math.min(Math.max(0, playedMs), active.request.ttlMs),
      timestamp: (this.options.now ?? Date.now)(),
      agentId: active.request.agentId,
      speakerName: active.request.speakerName,
    });
    this.emitActive();
    this.dequeue();
  }

  private finishActive(status: AudioLeaseStatus): void {
    const active = this.active;
    if (active === null) return;
    if (active.timer !== null) clearTimeout(active.timer);
    active.verdict = status;
    this.active = null;
    this.options.onReceipt?.({
      leaseId: active.request.leaseId,
      status,
      actualPlayedMs: Math.max(0, (this.options.now ?? Date.now)() - active.startedAt),
      timestamp: (this.options.now ?? Date.now)(),
      agentId: active.request.agentId,
      speakerName: active.request.speakerName,
    });
    this.emitActive();
  }

  private dequeue(): void {
    if (this.active !== null) return;
    let index = this.queue.findIndex((request) => request.priority === 'P0_INTERRUPT');
    if (index < 0) index = 0;
    const next = this.queue.splice(index, 1)[0];
    if (next !== undefined) this.start(next);
  }

  private emitActive(): void {
    this.options.onActiveChange?.(this.current());
  }
}
