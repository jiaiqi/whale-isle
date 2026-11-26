/**
 * 统一表演系统（V2-P3-01 · REQ-VOX-02 / REQ-PERF-01）：
 * - evaluateSongRights：曲目 / 伴奏 / 歌词 / 角色声线授权四重门禁（拦截未授权或 NC 素材进入公开直播/商业分发）
 * - parseBilingualLrc & LyricsClockSync：严格按音频真实播放时钟（positionMs）驱动双语/罗马音歌词时间轴
 * - SingEngine：严格区分说话 TTS 与歌声合成 SVS / 音色转换 SVC，诚实探测外部推理 Worker；无后端时可显式标为 preview_guide_tone 或拒绝
 * - PerformanceDirector：6 层优先级冲突仲裁 + 自然沉默权（decideSpeechSilence）+ 唱歌/伴奏/跳舞/口型/歌词时钟统一协调
 */
import { randomUUID } from 'node:crypto';
import type { RuntimeEventBus } from '@workbench/runtime-core';
import {
  BilingualLyricLineSchema,
  DanceRoutineSchema,
  LyricsClockFrameSchema,
  LyricsDisplayPolicySchema,
  PerformanceSnapshotSchema,
  SilenceDecisionSchema,
  SingRenderResultSchema,
  SingRequestSchema,
  SongRightsCheckSchema,
  SongRightsSchema,
  SpeechPerformancePlanSchema,
  type AudioMixerSnapshot,
  type BilingualLyricLine,
  type DanceCue,
  type DanceRoutine,
  type DanceRoutineInput,
  type LipSyncFrame,
  type LyricsClockFrame,
  type LyricsDisplayPolicy,
  type LyricsDisplayPolicyInput,
  type PerformanceActivityMode,
  type PerformanceChannel,
  type PerformancePriorityLayer,
  type PerformanceSnapshot,
  type SilenceDecision,
  type SingBackendMode,
  type SingMode,
  type SingProviderStatus,
  type SingRenderResult,
  type SingRequestInput,
  type SongLicenseScope,
  type SongRightsCheck,
  type SongRightsInput,
  type SpeechPerformancePlan,
  type SpeechPerformancePlanInput,
} from '@workbench/shared-protocol';
import type { AudioMixer } from './audio-mixer';
import { extractWavLipSyncFrames, synthesizeTextLipSyncFrames } from './lip-sync';

const LAYER_RANK: Readonly<Record<PerformancePriorityLayer, number>> = {
  safety_system: 100,
  interactive_game: 80,
  vocal_lipsync: 60,
  performance_choreo: 50,
  emotion_gesture: 30,
  idle_ambient: 10,
};

const CLOSED_LIP_FRAME: LipSyncFrame = {
  timestampMs: 0,
  durationMs: 0,
  viseme: 'closed',
  amplitude: 0,
  rmsDb: -80,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(4))));
}

function isLicenseAllowedForChannel(scope: SongLicenseScope, channel: PerformanceChannel): boolean {
  if (scope === 'unlicensed') return false;
  if (channel === 'private_desktop') {
    return true;
  }
  if (channel === 'livestream_public') {
    return scope === 'original_owned' || scope === 'licensed_livestream' || scope === 'licensed_commercial';
  }
  return scope === 'original_owned' || scope === 'licensed_commercial';
}

/** 曲目、伴奏、歌词与声音模型授权门禁（绝不默认任意歌曲都能公开直播或商用） */
export function evaluateSongRights(rawRights: SongRightsInput, channel: PerformanceChannel): SongRightsCheck {
  const rights = SongRightsSchema.parse(rawRights);
  const reasons: string[] = [];

  if (!rights.voiceModelAuthorized) {
    reasons.push('角色声音模型未经授权，禁止歌声合成或音色转换');
  }
  if (!isLicenseAllowedForChannel(rights.songLicense, channel)) {
    reasons.push(`歌曲主版权（${rights.songLicense}）不允许在 ${channel} 渠道使用`);
  }
  if (!isLicenseAllowedForChannel(rights.accompanimentLicense, channel)) {
    reasons.push(`伴奏权（${rights.accompanimentLicense}）不允许在 ${channel} 渠道使用`);
  }
  if (!isLicenseAllowedForChannel(rights.lyricsLicense, channel)) {
    reasons.push(`歌词展示权（${rights.lyricsLicense}）不允许在 ${channel} 渠道使用`);
  }

  return SongRightsCheckSchema.parse({
    allowed: reasons.length === 0,
    channel,
    reasons,
    requiresAttribution: rights.attribution.trim() !== '',
  });
}

/** 解析 LRC 双语歌词（支持 `[mm:ss.xx] 原文 || 译文` 或同时间戳多行叠加原文/译文/罗马音） */
export function parseBilingualLrc(lrcText: string, totalDurationMs?: number): BilingualLyricLine[] {
  const entries: Array<{ startMs: number; lines: string[] }> = [];
  const lines = lrcText.split(/\r?\n/u);
  const tagRe = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/u;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    const match = tagRe.exec(trimmed);
    if (!match) continue;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fracRaw = match[3] ?? '0';
    const fracMs = fracRaw.length === 3 ? Number(fracRaw) : Number(fracRaw.padEnd(2, '0').slice(0, 2)) * 10;
    const startMs = minutes * 60_000 + seconds * 1000 + fracMs;
    const content = (match[4] ?? '').trim();
    if (content === '') continue;

    const existing = entries.find((entry) => entry.startMs === startMs);
    if (existing) {
      existing.lines.push(content);
    } else {
      entries.push({ startMs, lines: [content] });
    }
  }

  entries.sort((a, b) => a.startMs - b.startMs);
  const out: BilingualLyricLine[] = [];

  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    if (!cur) continue;
    const next = entries[i + 1];
    const first = cur.lines[0] ?? '';
    let primaryText = first;
    let secondaryText = cur.lines[1];
    const romaji = cur.lines[2];
    if (first.includes('||')) {
      const splitParts = first.split('||').map((s) => s.trim());
      primaryText = splitParts[0] || first;
      if (splitParts[1]) {
        secondaryText = splitParts[1];
      }
    }

    const fallbackEnd = totalDurationMs && totalDurationMs > cur.startMs
      ? totalDurationMs
      : cur.startMs + 4000;
    const endMs = next ? Math.max(cur.startMs + 100, next.startMs) : fallbackEnd;
    out.push(BilingualLyricLineSchema.parse({
      index: i,
      startMs: cur.startMs,
      endMs,
      primaryText,
      ...(secondaryText ? { secondaryText } : {}),
      ...(romaji ? { romaji } : {}),
    }));
  }

  return out;
}

/** 严格绑定音频播放时钟的双语歌词同步器（绝不使用 LLM 生成耗时推算） */
export class LyricsClockSync {
  private songId: string | null = null;
  private lines: BilingualLyricLine[] = [];
  private durationMs = 0;
  private positionMs = 0;
  private policy: LyricsDisplayPolicy = LyricsDisplayPolicySchema.parse({});

  load(songId: string, lines: BilingualLyricLine[], durationMs: number): LyricsClockFrame {
    this.songId = songId;
    this.lines = lines
      .map((line, index) => BilingualLyricLineSchema.parse({ ...line, index }))
      .sort((a, b) => a.startMs - b.startMs);
    this.durationMs = Math.max(1, Math.round(durationMs));
    this.positionMs = 0;
    return this.snapshot();
  }

  setPolicy(patch: LyricsDisplayPolicyInput): LyricsDisplayPolicy {
    this.policy = LyricsDisplayPolicySchema.parse({
      ...this.policy,
      ...patch,
    });
    return { ...this.policy };
  }

  seek(positionMs: number): LyricsClockFrame {
    this.positionMs = Math.max(0, Math.min(this.durationMs || Number.MAX_SAFE_INTEGER, Math.round(positionMs)));
    return this.snapshot();
  }

  advance(deltaMs: number): LyricsClockFrame {
    return this.seek(this.positionMs + Math.max(0, Math.round(deltaMs)));
  }

  reset(): LyricsClockFrame {
    this.songId = null;
    this.lines = [];
    this.durationMs = 0;
    this.positionMs = 0;
    return this.snapshot();
  }

  snapshot(): LyricsClockFrame {
    if (!this.policy.enabled || this.songId === null || this.lines.length === 0) {
      return LyricsClockFrameSchema.parse({
        enabled: this.policy.enabled,
        songId: this.songId,
        positionMs: this.positionMs,
        durationMs: this.durationMs,
        activeIndex: -1,
        activeLine: null,
        nextLine: this.lines[0] ?? null,
        lineProgress: 0,
        policy: this.policy,
      });
    }

    let activeIdx = -1;
    let nextLine: BilingualLyricLine | null = null;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (!line) continue;
      if (this.positionMs >= line.startMs && this.positionMs < line.endMs) {
        activeIdx = i;
        nextLine = this.lines[i + 1] ?? null;
        break;
      }
      if (this.positionMs < line.startMs && nextLine === null) {
        nextLine = line;
        break;
      }
    }

    const activeLine = activeIdx >= 0 ? (this.lines[activeIdx] ?? null) : null;
    const span = activeLine ? Math.max(1, activeLine.endMs - activeLine.startMs) : 1;
    const lineProgress = activeLine
      ? clamp01((this.positionMs - activeLine.startMs) / span)
      : 0;

    return LyricsClockFrameSchema.parse({
      enabled: this.policy.enabled,
      songId: this.songId,
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      activeIndex: activeIdx,
      activeLine,
      nextLine,
      lineProgress,
      policy: this.policy,
    });
  }
}

/** 确定性 RIFF/PCM16 WAV 导唱合成器：仅供无神经 SVS/SVC 后端时的预览练声与真实波形口型提取 */
export function buildGuideToneWav(durationMs: number, bpm = 120, sampleRate = 24_000): Uint8Array {
  const safeDurationMs = Math.max(240, Math.min(10_000, Math.round(durationMs)));
  const totalSamples = Math.max(1, Math.floor((sampleRate * safeDurationMs) / 1000));
  const dataSize = totalSamples * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeTag = (offset: number, tag: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };

  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);

  const scaleHz = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
  const samplesPerBeat = Math.max(1, Math.floor((sampleRate * 60) / Math.max(40, bpm)));

  for (let i = 0; i < totalSamples; i++) {
    const beatIndex = Math.floor(i / samplesPerBeat);
    const freq = scaleHz[beatIndex % scaleHz.length] ?? 440.0;
    const beatPhase = (i % samplesPerBeat) / samplesPerBeat;
    const env = beatPhase < 0.72 ? 0.52 * (0.65 + 0.35 * Math.sin(Math.PI * (beatPhase / 0.72))) : 0.08;
    const sample = Math.round(Math.sin(2 * Math.PI * freq * (i / sampleRate)) * env * 22_000);
    view.setInt16(44 + i * 2, Math.max(-32_768, Math.min(32_767, sample)), true);
  }
  return bytes;
}

export interface SingEngineOptions {
  workerEndpoint?: string;
  fetchImpl?: typeof fetch;
}

interface WorkerSingPayload {
  audioBase64?: string;
  durationMs?: number;
  sampleRate?: number;
  lipFrames?: LipSyncFrame[];
  /**
   * Worker 回执：本次输出确实来自真实神经推理。
   * **单凭这个布尔值不置真** —— 必须同时给出可核实的模型证据（见下）。
   */
  neuralVerified?: boolean;
  /** 推理证据：模型标识 + 权重指纹 + 后端 + 证据来源 */
  modelEvidence?: {
    modelId?: string;
    weightSha256?: string;
    backend?: string;
    verifiedBy?: string;
  };
  /** Worker 未能给出证据时的原因 */
  evidenceMissing?: string;
}

/** 证据是否可核实：字段齐全 + 权重指纹格式合法 + 来源必须是权重指纹比对 */
function isEvidenceVerifiable(evidence: WorkerSingPayload['modelEvidence']): boolean {
  if (!evidence) return false;
  const { modelId, weightSha256, backend, verifiedBy } = evidence;
  if (!modelId || !backend) return false;
  if (verifiedBy !== 'weight_fingerprint') return false;
  return typeof weightSha256 === 'string' && /^[0-9a-f]{64}$/.test(weightSha256);
}

/** Worker /sing/health 的能力明细（可选字段，缺失时不影响既有解析） */
interface WorkerHealthBackends {
  backends?: Array<{ name?: string; kind?: string; ready?: boolean; detail?: string }>;
  ttsClone?: { ready?: boolean; detail?: string };
}

/** 歌声引擎（SVS / SVC）：严格与普通 TTS 说话管线分离，绝不用 TTS 冒充唱歌 */
export class SingEngine {
  private readonly workerEndpoint: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SingEngineOptions = {}) {
    this.workerEndpoint = options.workerEndpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async probeBackends(): Promise<SingProviderStatus[]> {
    if (!this.workerEndpoint) {
      return [
        {
          mode: 'svs',
          backend: 'unavailable',
          available: false,
          detail: '未配置外部神经 SVS 推理 Worker；仅可显式生成 preview_guide_tone 预览或等待实机 Worker',
        },
        {
          mode: 'svc',
          backend: 'unavailable',
          available: false,
          detail: '未配置外部神经 SVC 音色转换 Worker；仅可显式生成 preview_guide_tone 预览或等待实机 Worker',
        },
      ];
    }

    try {
      const res = await this.fetchImpl(`${this.workerEndpoint.replace(/\/+$/u, '')}/sing/health`, {
        method: 'GET',
      });
      if (!res.ok) {
        return [
          {
            mode: 'svs',
            backend: 'unavailable',
            available: false,
            endpoint: this.workerEndpoint,
            detail: `唱歌 Worker 健康检查失败（HTTP ${res.status}）`,
          },
          {
            mode: 'svc',
            backend: 'unavailable',
            available: false,
            endpoint: this.workerEndpoint,
            detail: `唱歌 Worker 健康检查失败（HTTP ${res.status}）`,
          },
        ];
      }
      const data = await res.json() as { svs?: boolean; svc?: boolean } & WorkerHealthBackends;
      const detailOf = (name: string, fallback: string): string => {
        const hit = data.backends?.find((b) => b.name === name);
        return hit?.detail && hit.detail.trim() !== '' ? hit.detail : fallback;
      };
      const ttsNote = data.ttsClone?.ready
        ? '（Worker 另报普通 TTS 可用，但普通 TTS 不得当作 SVS/SVC 使用）'
        : '';
      return [
        {
          mode: 'svs',
          backend: data.svs ? 'worker_svs' : 'unavailable',
          available: Boolean(data.svs),
          endpoint: this.workerEndpoint,
          detail: data.svs ? 'SVS 歌声合成后端在线' : `Worker 在线但 SVS 能力未就绪：${detailOf('svs', '未启用 SVS 能力')}${ttsNote}`,
        },
        {
          mode: 'svc',
          backend: data.svc ? 'worker_svc' : 'unavailable',
          available: Boolean(data.svc),
          endpoint: this.workerEndpoint,
          detail: data.svc ? 'SVC 音色转换后端在线' : `Worker 在线但 SVC 能力未就绪：${detailOf('svc', '未启用 SVC 能力')}${ttsNote}`,
        },
      ];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [
        {
          mode: 'svs',
          backend: 'unavailable',
          available: false,
          endpoint: this.workerEndpoint,
          detail: `SVS Worker 不可达：${msg}`,
        },
        {
          mode: 'svc',
          backend: 'unavailable',
          available: false,
          endpoint: this.workerEndpoint,
          detail: `SVC Worker 不可达：${msg}`,
        },
      ];
    }
  }

  async synthesize(rawRequest: SingRequestInput): Promise<SingRenderResult> {
    const req = SingRequestSchema.parse(rawRequest);
    const rightsCheck = evaluateSongRights(req.song.rights, req.channel);
    if (!rightsCheck.allowed) {
      return SingRenderResultSchema.parse({
        ok: false,
        requestId: req.requestId,
        mode: req.mode,
        backendMode: 'unavailable',
        rightsCheck,
        durationMs: 0,
        error: rightsCheck.reasons.join('；'),
        realNeuralInferenceVerified: false,
      });
    }

    if (req.mode === 'svc' && !req.song.referenceVocalPath && !req.allowPreviewGuide) {
      return SingRenderResultSchema.parse({
        ok: false,
        requestId: req.requestId,
        mode: req.mode,
        backendMode: 'unavailable',
        rightsCheck,
        durationMs: 0,
        error: 'SVC 模式需要 referenceVocalPath 原唱干声输入',
        realNeuralInferenceVerified: false,
      });
    }

    if (this.workerEndpoint) {
      try {
        const path = req.mode === 'svs' ? '/sing/svs' : '/sing/svc';
        const res = await this.fetchImpl(`${this.workerEndpoint.replace(/\/+$/u, '')}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (res.ok) {
          const body = await res.json() as WorkerSingPayload;
          const rawAudio = body.audioBase64 ? Buffer.from(body.audioBase64, 'base64') : new Uint8Array(0);
          const lipFrames = body.lipFrames && body.lipFrames.length > 0
            ? body.lipFrames
            : (rawAudio.byteLength > 44 ? extractWavLipSyncFrames(rawAudio) : []);
          const backendMode: SingBackendMode = req.mode === 'svs' ? 'worker_svs' : 'worker_svc';
          return SingRenderResultSchema.parse({
            ok: true,
            requestId: req.requestId,
            mode: req.mode,
            backendMode,
            rightsCheck,
            durationMs: body.durationMs ?? req.song.durationMs,
            sampleRate: body.sampleRate ?? 24_000,
            ...(body.audioBase64 ? { audioBase64: body.audioBase64 } : {}),
            lipFrames,
            // 音频字节本身不构成证据：必须有可核实的模型标识 + 权重指纹才置真
            realNeuralInferenceVerified: body.neuralVerified === true && isEvidenceVerifiable(body.modelEvidence),
            ...(isEvidenceVerifiable(body.modelEvidence) && body.modelEvidence
              ? {
                  neuralEvidence: {
                    modelId: body.modelEvidence.modelId as string,
                    weightSha256: body.modelEvidence.weightSha256 as string,
                    backend: body.modelEvidence.backend as string,
                    verifiedBy: 'weight_fingerprint' as const,
                  },
                }
              : {}),
            ...(body.neuralVerified === true && !isEvidenceVerifiable(body.modelEvidence)
              ? {
                  neuralEvidenceNote:
                    body.evidenceMissing
                    ?? 'Worker 声称神经推理但未提供可核实的模型证据（模型标识 + 权重指纹），不予置真',
                }
              : {}),
          });
        }
      } catch {
        /* 交由下方明确降级策略处理 */
      }
    }

    if (!req.allowPreviewGuide) {
      return SingRenderResultSchema.parse({
        ok: false,
        requestId: req.requestId,
        mode: req.mode,
        backendMode: 'unavailable',
        rightsCheck,
        durationMs: 0,
        error: '未检测到可用的 SVS/SVC 唱歌推理后端（绝不使用普通 TTS 冒充唱歌）',
        realNeuralInferenceVerified: false,
      });
    }

    const rehearsalMs = Math.min(req.song.durationMs, 8_000);
    const wav = buildGuideToneWav(rehearsalMs, req.song.bpm);
    const lipFrames = extractWavLipSyncFrames(wav, 50);
    return SingRenderResultSchema.parse({
      ok: true,
      requestId: req.requestId,
      mode: req.mode,
      backendMode: 'preview_guide_tone',
      rightsCheck,
      durationMs: req.song.durationMs,
      sampleRate: 24_000,
      audioBase64: Buffer.from(wav).toString('base64'),
      lipFrames,
      realNeuralInferenceVerified: false,
    });
  }
}

export interface SilenceContextInput {
  priority?: 'P0_INTERRUPT' | 'P1_CADENCE' | 'P2_IDLE';
  quietCompanionMode?: boolean;
  socialEnergy?: number;
  msSinceLastSpeech?: number;
  minCooldownMs?: number;
  isUserDirectAddress?: boolean;
}

export interface PerformanceDirectorOptions {
  characterId: string;
  audioMixer: AudioMixer;
  singEngine?: SingEngine;
  events?: RuntimeEventBus;
  now?: () => number;
}

/** 统一表演总控：整合发言沉默策略、多轨混音、SVS/SVC 演唱、舞蹈编排与歌词同步时钟 */
export class PerformanceDirector {
  private readonly characterId: string;
  private readonly audioMixer: AudioMixer;
  private readonly singEngine: SingEngine;
  private readonly events: RuntimeEventBus | undefined;
  private readonly now: () => number;
  readonly lyricsClock = new LyricsClockSync();

  private mode: PerformanceActivityMode = 'idle';
  private channel: PerformanceChannel = 'private_desktop';
  private positionMs = 0;
  private activeSongId: string | null = null;
  private activeSingMode: SingMode | null = null;
  private activeDanceRoutine: DanceRoutine | null = null;
  private activeLipFrames: LipSyncFrame[] = [];
  private activeLipFrame: LipSyncFrame = CLOSED_LIP_FRAME;
  private quietCompanionMode = false;
  private halted = false;
  private haltReason: string | null = null;
  private lastSpeechAt = 0;
  private activeTrackIds: string[] = [];

  private readonly activeLayers: Record<PerformancePriorityLayer, string | null> = {
    safety_system: null,
    interactive_game: null,
    vocal_lipsync: null,
    performance_choreo: null,
    emotion_gesture: null,
    idle_ambient: null,
  };

  constructor(options: PerformanceDirectorOptions) {
    this.characterId = options.characterId;
    this.audioMixer = options.audioMixer;
    this.singEngine = options.singEngine ?? new SingEngine();
    this.events = options.events;
    this.now = options.now ?? Date.now;
  }

  setQuietCompanionMode(enabled: boolean): PerformanceSnapshot {
    this.quietCompanionMode = enabled;
    return this.snapshot();
  }

  /** 6 层动作冲突仲裁：safety > game > vocal_lipsync ~ choreo > emotion > idle */
  requestLayer(layer: PerformancePriorityLayer, actionId: string): { granted: boolean; blockedBy?: PerformancePriorityLayer } {
    if (this.activeLayers.safety_system !== null && layer !== 'safety_system') {
      return { granted: false, blockedBy: 'safety_system' };
    }
    if (layer !== 'vocal_lipsync') {
      const reqRank = LAYER_RANK[layer];
      const bodyLayers: PerformancePriorityLayer[] = [
        'safety_system',
        'interactive_game',
        'performance_choreo',
        'emotion_gesture',
        'idle_ambient',
      ];
      for (const existing of bodyLayers) {
        if (this.activeLayers[existing] !== null && LAYER_RANK[existing] > reqRank) {
          return { granted: false, blockedBy: existing };
        }
      }
    }
    this.activeLayers[layer] = actionId;
    return { granted: true };
  }

  releaseLayer(layer: PerformancePriorityLayer): void {
    this.activeLayers[layer] = null;
  }

  /** 自然沉默权决策（安静陪伴模式/疲惫低社交能量时不机械抢话） */
  decideSpeechSilence(input: SilenceContextInput = {}): SilenceDecision {
    const priority = input.priority ?? 'P1_CADENCE';
    const quiet = input.quietCompanionMode ?? this.quietCompanionMode;
    const socialEnergy = input.socialEnergy ?? 0.75;
    const minCooldownMs = input.minCooldownMs ?? 4_000;
    const elapsed = input.msSinceLastSpeech ?? (this.lastSpeechAt === 0 ? minCooldownMs : Math.max(0, this.now() - this.lastSpeechAt));

    if (this.halted) {
      return SilenceDecisionSchema.parse({
        shouldSpeak: false,
        reason: '系统处于急停状态，保持静默',
      });
    }
    if (priority === 'P0_INTERRUPT' || input.isUserDirectAddress === true) {
      return SilenceDecisionSchema.parse({
        shouldSpeak: true,
        reason: priority === 'P0_INTERRUPT' ? '高优 P0 中断事件，立即发言' : '主人直接点名互动，立即回应',
      });
    }
    if (quiet) {
      return SilenceDecisionSchema.parse({
        shouldSpeak: false,
        reason: '安静陪伴模式生效，保留自然沉默',
      });
    }
    if (priority === 'P2_IDLE' && socialEnergy < 0.25) {
      return SilenceDecisionSchema.parse({
        shouldSpeak: false,
        reason: '角色社交能量偏低，选择安静休息',
      });
    }
    if (priority === 'P2_IDLE' && elapsed < minCooldownMs) {
      return SilenceDecisionSchema.parse({
        shouldSpeak: false,
        reason: '距上次闲聊间隔过短，保持自然留白',
        cooldownRemainingMs: minCooldownMs - elapsed,
      });
    }
    return SilenceDecisionSchema.parse({
      shouldSpeak: true,
      reason: '允许自然发言',
    });
  }

  planSpeech(
    rawPlan: SpeechPerformancePlanInput,
    silenceContext: SilenceContextInput = {},
  ): {
    speaking: boolean;
    plan: SpeechPerformancePlan;
    silence: SilenceDecision;
    lipFrames: LipSyncFrame[];
    snapshot: PerformanceSnapshot;
  } {
    const plan = SpeechPerformancePlanSchema.parse(rawPlan);
    const silence = this.decideSpeechSilence({
      priority: plan.priority,
      ...silenceContext,
    });
    if (!silence.shouldSpeak) {
      return {
        speaking: false,
        plan,
        silence,
        lipFrames: [],
        snapshot: this.snapshot(),
      };
    }

    this.lastSpeechAt = this.now();
    this.requestLayer('vocal_lipsync', `speech:${plan.planId}`);
    if (plan.expressionId || plan.gestureIds.length > 0) {
      this.requestLayer('emotion_gesture', `expr:${plan.expressionId ?? plan.gestureIds[0]}`);
    }
    this.mode = 'speaking';
    const estDurationMs = Math.max(500, Math.round(plan.text.length * (plan.pace === 'fast' ? 140 : plan.pace === 'slow' ? 260 : 190)));
    const lipFrames = synthesizeTextLipSyncFrames(plan.text, estDurationMs, 60);
    this.activeLipFrames = lipFrames;
    this.activeLipFrame = lipFrames[0] ?? CLOSED_LIP_FRAME;

    this.events?.publish('performance:speech-planned', {
      characterId: this.characterId,
      planId: plan.planId,
      emotion: plan.emotion,
      frameCount: lipFrames.length,
    }, { source: 'performance-director', characterId: this.characterId });

    return {
      speaking: true,
      plan,
      silence,
      lipFrames,
      snapshot: this.snapshot(),
    };
  }

  async startSinging(
    rawRequest: SingRequestInput,
    rawDance?: DanceRoutineInput,
  ): Promise<{
    ok: boolean;
    result: SingRenderResult;
    snapshot: PerformanceSnapshot;
  }> {
    const req = SingRequestSchema.parse(rawRequest);
    if (this.halted) {
      const blocked = SingRenderResultSchema.parse({
        ok: false,
        requestId: req.requestId,
        mode: req.mode,
        backendMode: 'unavailable',
        rightsCheck: evaluateSongRights(req.song.rights, req.channel),
        durationMs: 0,
        error: `系统处于急停状态：${this.haltReason ?? 'emergency_halt'}`,
        realNeuralInferenceVerified: false,
      });
      return { ok: false, result: blocked, snapshot: this.snapshot() };
    }

    const dance = rawDance ? DanceRoutineSchema.parse(rawDance) : null;
    const result = await this.singEngine.synthesize(req);
    if (!result.ok) {
      return { ok: false, result, snapshot: this.snapshot() };
    }

    this.stopActiveTracks();
    this.channel = req.channel;
    this.activeSongId = req.song.songId;
    this.activeSingMode = req.mode;
    this.activeDanceRoutine = dance;
    this.positionMs = 0;

    const singTrackId = `sing:${req.requestId}`;
    this.audioMixer.startTrack({
      trackId: singTrackId,
      kind: 'singing',
      label: `${req.song.title} (${req.mode.toUpperCase()})`,
      gain: req.vocalGain,
      ...(req.outputDeviceId ? { outputDeviceId: req.outputDeviceId } : {}),
    });
    this.activeTrackIds.push(singTrackId);

    if (req.song.accompanimentTrackPath) {
      const bgmTrackId = `accomp:${req.requestId}`;
      this.audioMixer.startTrack({
        trackId: bgmTrackId,
        kind: 'bgm',
        label: `${req.song.title} 伴奏`,
        gain: req.accompanimentGain,
        ...(req.obsOutputDeviceId ? { outputDeviceId: req.obsOutputDeviceId } : {}),
      });
      this.activeTrackIds.push(bgmTrackId);
    }

    this.lyricsClock.load(req.song.songId, req.song.lyrics, req.song.durationMs);
    this.requestLayer('vocal_lipsync', `sing:${req.song.songId}`);
    if (dance) {
      this.requestLayer('performance_choreo', `dance:${dance.routineId}`);
    } else {
      this.releaseLayer('performance_choreo');
    }

    this.mode = dance ? 'singing_and_dancing' : 'singing';
    this.activeLipFrames = result.lipFrames;
    this.activeLipFrame = this.findLipFrameAt(0);

    this.events?.publish('performance:singing-started', {
      characterId: this.characterId,
      songId: req.song.songId,
      mode: req.mode,
      backendMode: result.backendMode,
      withDance: Boolean(dance),
    }, { source: 'performance-director', characterId: this.characterId });

    return {
      ok: true,
      result,
      snapshot: this.snapshot(),
    };
  }

  /** 启动独立舞蹈编排（可在仅跳舞或搭配直播氛围时使用） */
  startDance(rawDance: DanceRoutineInput): { ok: boolean; reason?: string; snapshot: PerformanceSnapshot } {
    if (this.halted) {
      return { ok: false, reason: '系统处于急停状态', snapshot: this.snapshot() };
    }
    const dance = DanceRoutineSchema.parse(rawDance);
    const lease = this.requestLayer('performance_choreo', `dance:${dance.routineId}`);
    if (!lease.granted) {
      return { ok: false, reason: `被更高优先级层占用：${lease.blockedBy}`, snapshot: this.snapshot() };
    }
    this.activeDanceRoutine = dance;
    this.positionMs = 0;
    this.mode = this.activeSongId ? 'singing_and_dancing' : 'dancing';
    return { ok: true, snapshot: this.snapshot() };
  }

  /** 按音频播放时钟推进歌词高亮、舞蹈动作与口型帧 */
  tickClock(positionMs: number): PerformanceSnapshot {
    this.positionMs = Math.max(0, Math.round(positionMs));
    this.lyricsClock.seek(this.positionMs);
    this.activeLipFrame = this.findLipFrameAt(this.positionMs);
    const snap = this.snapshot();
    this.events?.publish('performance:clock-tick', {
      characterId: this.characterId,
      positionMs: snap.positionMs,
      activeIndex: snap.lyrics.activeIndex,
      cueId: snap.activeDanceCue?.cueId ?? null,
      viseme: snap.lipSync.viseme,
    }, { source: 'performance-director', characterId: this.characterId });
    return snap;
  }

  stopPerformance(reason = 'stopped'): PerformanceSnapshot {
    this.stopActiveTracks();
    this.activeSongId = null;
    this.activeSingMode = null;
    this.activeDanceRoutine = null;
    this.activeLipFrames = [];
    this.activeLipFrame = CLOSED_LIP_FRAME;
    this.positionMs = 0;
    this.lyricsClock.reset();
    this.releaseLayer('vocal_lipsync');
    this.releaseLayer('performance_choreo');
    this.releaseLayer('emotion_gesture');
    if (!this.halted) {
      this.mode = 'idle';
    }
    this.events?.publish('performance:stopped', {
      characterId: this.characterId,
      reason,
    }, { source: 'performance-director', characterId: this.characterId });
    return this.snapshot();
  }

  emergencyHalt(reason = 'emergency_halt'): PerformanceSnapshot {
    this.halted = true;
    this.haltReason = reason;
    this.requestLayer('safety_system', reason);
    this.audioMixer.stopAll();
    this.stopPerformance(reason);
    this.mode = 'halted';
    return this.snapshot();
  }

  resumeFromHalt(): PerformanceSnapshot {
    this.halted = false;
    this.haltReason = null;
    this.releaseLayer('safety_system');
    this.mode = 'idle';
    return this.snapshot();
  }

  snapshot(): PerformanceSnapshot {
    const activeDanceCue = this.findDanceCueAt(this.positionMs);
    return PerformanceSnapshotSchema.parse({
      characterId: this.characterId,
      mode: this.mode,
      channel: this.channel,
      positionMs: this.positionMs,
      activeSongId: this.activeSongId,
      activeSingMode: this.activeSingMode,
      activeDanceRoutineId: this.activeDanceRoutine?.routineId ?? null,
      activeDanceCue,
      activeLayers: { ...this.activeLayers },
      lyrics: this.lyricsClock.snapshot(),
      lipSync: this.activeLipFrame,
      quietCompanionMode: this.quietCompanionMode,
      halted: this.halted,
      haltReason: this.haltReason,
      mixer: this.audioMixer.snapshot(),
    });
  }

  private findDanceCueAt(positionMs: number): DanceCue | null {
    if (!this.activeDanceRoutine) return null;
    for (const cue of this.activeDanceRoutine.cues) {
      if (positionMs >= cue.atMs && positionMs < cue.atMs + cue.durationMs) {
        return cue;
      }
    }
    return null;
  }

  private findLipFrameAt(positionMs: number): LipSyncFrame {
    for (const frame of this.activeLipFrames) {
      if (positionMs >= frame.timestampMs && positionMs < frame.timestampMs + Math.max(1, frame.durationMs)) {
        return frame;
      }
    }
    return CLOSED_LIP_FRAME;
  }

  private stopActiveTracks(): void {
    for (const trackId of this.activeTrackIds) {
      this.audioMixer.stopTrack(trackId);
    }
    this.activeTrackIds = [];
  }
}

export function createPerformanceDirectorPreview(): string {
  return `director:${randomUUID()}`;
}
