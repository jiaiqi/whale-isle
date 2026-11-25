/**
 * 说话发言权（SpeechFloorArbiter）与多轨混音器（AudioMixer）（V2-P1-02 / ADR-002 D-106）：
 * - SpeechFloorArbiter：同一时刻仅 1 条角色说话占用发言权（P0 抢占、TTL 超时释放、串行排队）
 * - AudioMixer：将发言权与伴奏（bgm）/ 音效（sfx）/ 唱歌（singing）解耦为多轨混音：
 *   * 说话绝不阻塞 BGM/SFX 播放
 *   * 说话激活时自动对 BGM 执行压低（ducking），说话结束自动恢复
 *   * 支持按轨类型设置独立输出设备路由（例如桌面端 vs OBS 虚拟声卡）
 */
import { randomUUID } from 'node:crypto';
import {
  AudioMixerSnapshotSchema,
  AudioTrackKindSchema,
  AudioTrackStateSchema,
  type AudioMixerSnapshot,
  type AudioPlaybackReceipt,
  type AudioTrackKind,
  type AudioTrackState,
  type SpeechFloorHolder,
} from '@workbench/shared-protocol';
import type { RuntimeEventBus } from '@workbench/runtime-core';

export type SpeechPriority = 'P0_INTERRUPT' | 'P1_CADENCE' | 'P2_IDLE';
export type SpeechLeaseStatus = AudioPlaybackReceipt['status'];

export interface SpeechFloorRequest {
  leaseId?: string;
  agentId: string;
  characterId: string;
  speakerName: string;
  voiceRef: string;
  priority: SpeechPriority;
  ttlMs: number;
  start(): Promise<void>;
  abort(): void;
}

interface ActiveSpeech {
  request: SpeechFloorRequest & { leaseId: string };
  startedAt: number;
  verdict: SpeechLeaseStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SpeechFloorCallbacks {
  now?: () => number;
  onHolderChange?: (holder: SpeechFloorHolder | null) => void;
  onReceipt?: (receipt: AudioPlaybackReceipt & { agentId: string; characterId: string }) => void;
}

export class SpeechFloorArbiter {
  private active: ActiveSpeech | null = null;
  private queue: Array<SpeechFloorRequest & { leaseId: string }> = [];
  private readonly now: () => number;

  constructor(private readonly callbacks: SpeechFloorCallbacks = {}) {
    this.now = callbacks.now ?? Date.now;
  }

  holder(): SpeechFloorHolder | null {
    if (this.active === null) return null;
    const req = this.active.request;
    return {
      leaseId: req.leaseId,
      agentId: req.agentId,
      characterId: req.characterId,
      speakerName: req.speakerName,
      voiceRef: req.voiceRef,
    };
  }

  queueLength(): number {
    return this.queue.length;
  }

  acquire(input: SpeechFloorRequest): 'granted' | 'queued' | 'preempted' {
    const request = {
      ...input,
      leaseId: input.leaseId ?? randomUUID(),
      ttlMs: Math.min(300_000, Math.max(500, Math.round(input.ttlMs))),
    };
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
    const idx = this.queue.findIndex((item) => item.leaseId === leaseId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      return true;
    }
    if (this.active?.request.leaseId === leaseId) {
      this.finishActive('INTERRUPTED_BY_P0');
      this.dequeue();
      return true;
    }
    return false;
  }

  stopAll(): void {
    this.queue = [];
    if (this.active !== null) {
      this.finishActive('INTERRUPTED_BY_P0');
    }
  }

  private start(request: SpeechFloorRequest & { leaseId: string }): void {
    const active: ActiveSpeech = {
      request,
      startedAt: this.now(),
      verdict: null,
      timer: null,
    };
    this.active = active;
    this.callbacks.onHolderChange?.(this.holder());
    active.timer = setTimeout(() => {
      if (this.active !== active || active.verdict !== null) return;
      this.finishActive('TTL_EXPIRED');
      this.dequeue();
    }, request.ttlMs);

    void Promise.resolve()
      .then(() => request.start())
      .then(() => this.settle(active, active.verdict ?? 'COMPLETED', this.now() - active.startedAt))
      .catch(() => this.settle(active, active.verdict ?? 'AUDIO_DEVICE_ERROR', this.now() - active.startedAt));
  }

  private settle(active: ActiveSpeech, status: SpeechLeaseStatus, playedMs: number): void {
    if (this.active !== active) return;
    if (active.timer !== null) clearTimeout(active.timer);
    this.active = null;
    this.callbacks.onReceipt?.({
      leaseId: active.request.leaseId,
      status,
      actualPlayedMs: Math.max(0, Math.min(playedMs, active.request.ttlMs)),
      timestamp: this.now(),
      agentId: active.request.agentId,
      characterId: active.request.characterId,
    });
    this.callbacks.onHolderChange?.(null);
    this.dequeue();
  }

  private finishActive(status: SpeechLeaseStatus): void {
    const active = this.active;
    if (active === null) return;
    if (active.timer !== null) clearTimeout(active.timer);
    active.verdict = status;
    this.active = null;
    try {
      active.request.abort();
    } catch {
      /* 忽略中止异常 */
    }
    this.callbacks.onReceipt?.({
      leaseId: active.request.leaseId,
      status,
      actualPlayedMs: Math.max(0, this.now() - active.startedAt),
      timestamp: this.now(),
      agentId: active.request.agentId,
      characterId: active.request.characterId,
    });
    this.callbacks.onHolderChange?.(null);
  }

  private dequeue(): void {
    if (this.active !== null || this.queue.length === 0) return;
    let index = this.queue.findIndex((r) => r.priority === 'P0_INTERRUPT');
    if (index < 0) index = 0;
    const [next] = this.queue.splice(index, 1);
    if (next) this.start(next);
  }
}

interface InternalTrack {
  state: AudioTrackState;
  onStop?: () => void;
}

export interface AudioMixerOptions {
  events?: RuntimeEventBus;
  duckingGainMultiplier?: number;
  now?: () => number;
  onReceipt?: (receipt: AudioPlaybackReceipt & { agentId: string; characterId: string }) => void;
}

export class AudioMixer {
  readonly speechFloor: SpeechFloorArbiter;
  private readonly tracks = new Map<string, InternalTrack>();
  private readonly outputRoutes: Record<AudioTrackKind, string> = {
    speech: 'default',
    bgm: 'default',
    sfx: 'default',
    singing: 'default',
  };
  private duckingGainMultiplier: number;
  private externalSpeechDucking = false;
  private readonly now: () => number;
  private readonly events: RuntimeEventBus | undefined;

  constructor(options: AudioMixerOptions = {}) {
    this.events = options.events;
    this.now = options.now ?? Date.now;
    this.duckingGainMultiplier = Math.min(1, Math.max(0, options.duckingGainMultiplier ?? 0.25));
    this.speechFloor = new SpeechFloorArbiter({
      now: this.now,
      onHolderChange: () => {
        this.recomputeAllTracks();
        this.emitSnapshot();
      },
      ...(options.onReceipt === undefined ? {} : { onReceipt: options.onReceipt }),
    });
  }

  acquireSpeech(request: SpeechFloorRequest): 'granted' | 'queued' | 'preempted' {
    return this.speechFloor.acquire(request);
  }

  /** 允许外部语音链（如 V1 voice-host）触发同源 BGM 压低 */
  setSpeechDucking(active: boolean): AudioMixerSnapshot {
    this.externalSpeechDucking = active;
    this.recomputeAllTracks();
    this.emitSnapshot();
    return this.snapshot();
  }

  /** 启动非阻塞音轨（bgm / sfx / singing），绝不被 speechFloor 锁定 */
  startTrack(input: {
    trackId: string;
    kind: AudioTrackKind;
    label: string;
    gain?: number;
    muted?: boolean;
    outputDeviceId?: string;
    onStop?: () => void;
  }): AudioTrackState {
    const kind = AudioTrackKindSchema.parse(input.kind);
    const baseGain = Math.min(2, Math.max(0, input.gain ?? 1));
    const muted = Boolean(input.muted);
    const ducked = this.isDuckingActive() && kind === 'bgm';
    const effectiveGain = this.computeEffectiveGain(baseGain, muted, ducked);
    const state = AudioTrackStateSchema.parse({
      trackId: input.trackId,
      kind,
      label: input.label,
      playing: true,
      gain: baseGain,
      effectiveGain,
      muted,
      ducked,
      outputDeviceId: input.outputDeviceId ?? this.outputRoutes[kind],
      startedAt: this.now(),
    });
    this.tracks.set(state.trackId, {
      state,
      ...(input.onStop === undefined ? {} : { onStop: input.onStop }),
    });
    this.emitSnapshot();
    return structuredClone(state);
  }

  setTrackGain(trackId: string, gain: number): AudioTrackState | null {
    const entry = this.tracks.get(trackId);
    if (!entry) return null;
    const clamped = Math.min(2, Math.max(0, gain));
    entry.state = {
      ...entry.state,
      gain: clamped,
      effectiveGain: this.computeEffectiveGain(clamped, entry.state.muted, entry.state.ducked),
    };
    this.emitSnapshot();
    return structuredClone(entry.state);
  }

  setTrackMuted(trackId: string, muted: boolean): AudioTrackState | null {
    const entry = this.tracks.get(trackId);
    if (!entry) return null;
    entry.state = {
      ...entry.state,
      muted,
      effectiveGain: this.computeEffectiveGain(entry.state.gain, muted, entry.state.ducked),
    };
    this.emitSnapshot();
    return structuredClone(entry.state);
  }

  stopTrack(trackId: string): boolean {
    const entry = this.tracks.get(trackId);
    if (!entry) return false;
    this.tracks.delete(trackId);
    try {
      entry.onStop?.();
    } catch {
      /* 忽略轨道停播回调错误 */
    }
    this.emitSnapshot();
    return true;
  }

  setOutputRoute(kind: AudioTrackKind, deviceId: string): AudioMixerSnapshot {
    const validKind = AudioTrackKindSchema.parse(kind);
    const targetDevice = deviceId.trim() === '' ? 'default' : deviceId.trim();
    this.outputRoutes[validKind] = targetDevice;
    for (const [id, entry] of this.tracks.entries()) {
      if (entry.state.kind === validKind) {
        this.tracks.set(id, {
          ...entry,
          state: { ...entry.state, outputDeviceId: targetDevice },
        });
      }
    }
    this.emitSnapshot();
    return this.snapshot();
  }

  stopAll(): void {
    this.externalSpeechDucking = false;
    this.speechFloor.stopAll();
    for (const id of [...this.tracks.keys()]) {
      const entry = this.tracks.get(id);
      this.tracks.delete(id);
      try {
        entry?.onStop?.();
      } catch {
        /* 忽略 */
      }
    }
    this.emitSnapshot();
  }

  snapshot(): AudioMixerSnapshot {
    return AudioMixerSnapshotSchema.parse({
      speechFloorHolder: this.speechFloor.holder(),
      speechQueueLength: this.speechFloor.queueLength(),
      duckingActive: this.isDuckingActive(),
      duckingGainMultiplier: this.duckingGainMultiplier,
      tracks: [...this.tracks.values()].map((t) => structuredClone(t.state)),
      outputRoutes: { ...this.outputRoutes },
    });
  }

  private isDuckingActive(): boolean {
    return this.speechFloor.holder() !== null || this.externalSpeechDucking;
  }

  private computeEffectiveGain(gain: number, muted: boolean, ducked: boolean): number {
    if (muted) return 0;
    return Number((gain * (ducked ? this.duckingGainMultiplier : 1)).toFixed(4));
  }

  private recomputeAllTracks(): void {
    const ducking = this.isDuckingActive();
    for (const [id, entry] of this.tracks.entries()) {
      const ducked = ducking && entry.state.kind === 'bgm';
      this.tracks.set(id, {
        ...entry,
        state: {
          ...entry.state,
          ducked,
          effectiveGain: this.computeEffectiveGain(entry.state.gain, entry.state.muted, ducked),
        },
      });
    }
  }

  private emitSnapshot(): void {
    this.events?.publish('voice:mixer-updated', { snapshot: this.snapshot() }, { source: 'audio-mixer' });
  }
}
