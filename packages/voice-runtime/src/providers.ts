/**
 * 真实 VoiceProvider 与路由降级引擎（V2-P1-02）：
 * - VoiceIdentity 与具体 Provider 解耦，换服务不丢角色音色偏好
 * - 支持 OpenAI-Compatible TTS、MiniMax T2A v2、Local Audio Worker、系统诚实降级（macOS say / Windows SAPI）
 * - 支持分句预取（bounded prefetch）、LRU 合成缓存、AbortSignal 取消与诚实降级追踪
 */
import {
  LocalAudioWorkerHealthSchema,
  VoiceProviderStatusSchema,
  VoiceSynthesisOutputSchema,
  VoiceSynthesisRequestSchema,
  type VoiceIdentityDomain,
  type VoiceProviderKind,
  type VoiceProviderStatus,
  type VoiceSynthesisOutput,
  type VoiceSynthesisRequest,
  type VoiceSynthesisRequestInput,
} from '@workbench/shared-protocol';
import { WhaleError } from '@workbench/runtime-core';
import {
  extractWavLipSyncFrames,
  splitSpeechSentences,
  synthesizeTextLipSyncFrames,
} from './lip-sync';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VoiceProvider {
  readonly kind: VoiceProviderKind;
  probe(): Promise<VoiceProviderStatus> | VoiceProviderStatus;
  synthesize(request: VoiceSynthesisRequest, signal?: AbortSignal): Promise<VoiceSynthesisOutput>;
}

function estimateSpeechMs(text: string, speed: number): number {
  const chars = [...text.trim()].filter((c) => !/\s/u.test(c)).length;
  return Math.max(300, Math.round((chars * 210) / Math.max(0.5, speed)));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
}

function withTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`TTS 请求超时 (${timeoutMs}ms)`)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 构造安全的 Windows PowerShell SAPI 命令：文本通过环境变量 WHALE_TTS_TEXT 注入，绝不拼接进脚本 */
export function buildWindowsSapiCommand(ratePercent: number, volume01: number): {
  command: string;
  args: string[];
  rate: number;
  volume: number;
} {
  const sapiRate = Math.max(-10, Math.min(10, Math.round(((ratePercent - 100) / 100) * 10)));
  const sapiVol = Math.max(0, Math.min(100, Math.round(volume01 * 100)));
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$s.Rate = ${sapiRate};`,
    `$s.Volume = ${sapiVol};`,
    '$s.Speak($env:WHALE_TTS_TEXT);',
  ].join(' ');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    rate: sapiRate,
    volume: sapiVol,
  };
}

export interface CloudOpenAiTtsOptions {
  baseUrl?: string;
  model?: string;
  responseFormat?: 'wav' | 'mp3';
  resolveApiKey: () => string | null;
  fetchImpl?: FetchLike;
}

/** OpenAI 兼容 /audio/speech 真实 TTS 供应商 */
export class CloudOpenAiTtsProvider implements VoiceProvider {
  readonly kind = 'openai-compatible-tts' as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly responseFormat: 'wav' | 'mp3';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: CloudOpenAiTtsOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model ?? 'gpt-4o-mini-tts';
    this.responseFormat = options.responseFormat ?? 'wav';
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  probe(): VoiceProviderStatus {
    const hasKey = Boolean(this.options.resolveApiKey()?.trim());
    return VoiceProviderStatusSchema.parse({
      kind: this.kind,
      quality: 'character_tts',
      available: hasKey,
      degraded: false,
      platform: process.platform,
      detail: hasKey
        ? `OpenAI 兼容 TTS 已配置 (${this.model})`
        : '未配置 OpenAI 兼容 TTS 凭据',
      supportsStreaming: true,
      supportsEmotion: true,
    });
  }

  async synthesize(request: VoiceSynthesisRequest, externalSignal?: AbortSignal): Promise<VoiceSynthesisOutput> {
    const key = this.options.resolveApiKey()?.trim();
    if (!key) {
      throw new WhaleError('SECRET_UNAVAILABLE', 'OpenAI 兼容 TTS 缺少 API Key', { recoverable: true });
    }
    const { signal, cleanup } = withTimeoutSignal(request.timeoutMs, externalSignal);
    const started = Date.now();
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: this.model,
          voice: request.voiceRef,
          input: request.text,
          speed: request.speed,
          response_format: this.responseFormat,
          instructions: `emotion=${request.emotion}; style=${request.styleMode}`,
        }),
        signal,
      });
      if (!resp.ok) {
        throw new WhaleError('INTERNAL_ERROR', `OpenAI TTS HTTP ${resp.status}`, { recoverable: true });
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const durationMs = estimateSpeechMs(request.text, request.speed);
      const wavFrames = this.responseFormat === 'wav' ? extractWavLipSyncFrames(bytes) : [];
      const lipFrames = wavFrames.length > 0 ? wavFrames : synthesizeTextLipSyncFrames(request.text, durationMs);
      const actualDuration = wavFrames.length > 0
        ? (wavFrames[wavFrames.length - 1]!.timestampMs + wavFrames[wavFrames.length - 1]!.durationMs)
        : durationMs;
      return VoiceSynthesisOutputSchema.parse({
        requestId: request.requestId,
        providerKind: this.kind,
        quality: 'character_tts',
        degraded: false,
        format: this.responseFormat,
        sampleRate: 24_000,
        durationMs: actualDuration,
        audioBase64: Buffer.from(bytes).toString('base64'),
        lipFrames,
        cached: false,
        latencyMs: Math.max(0, Date.now() - started),
      });
    } finally {
      cleanup();
    }
  }
}

export interface MiniMaxTtsOptions {
  baseUrl?: string;
  model?: string;
  resolveApiKey: () => string | null;
  fetchImpl?: FetchLike;
}

/** MiniMax T2A v2 真实云端情绪 TTS 供应商 */
export class MiniMaxTtsProvider implements VoiceProvider {
  readonly kind = 'minimax-tts' as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: MiniMaxTtsOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.minimax.chat').replace(/\/+$/, '');
    this.model = options.model ?? 'speech-02-turbo';
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  probe(): VoiceProviderStatus {
    const hasKey = Boolean(this.options.resolveApiKey()?.trim());
    return VoiceProviderStatusSchema.parse({
      kind: this.kind,
      quality: 'character_tts',
      available: hasKey,
      degraded: false,
      platform: process.platform,
      detail: hasKey ? `MiniMax T2A v2 已配置 (${this.model})` : '未配置 MiniMax API Key',
      supportsStreaming: true,
      supportsEmotion: true,
    });
  }

  async synthesize(request: VoiceSynthesisRequest, externalSignal?: AbortSignal): Promise<VoiceSynthesisOutput> {
    const key = this.options.resolveApiKey()?.trim();
    if (!key) {
      throw new WhaleError('SECRET_UNAVAILABLE', 'MiniMax TTS 缺少 API Key', { recoverable: true });
    }
    const { signal, cleanup } = withTimeoutSignal(request.timeoutMs, externalSignal);
    const started = Date.now();
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/v1/t2a_v2`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: this.model,
          text: request.text,
          stream: false,
          voice_setting: {
            voice_id: request.voiceRef,
            speed: request.speed,
            vol: request.volume,
            pitch: Math.round(request.pitchShiftSemitones),
            emotion: request.emotion,
          },
          audio_setting: {
            sample_rate: 24_000,
            format: 'mp3',
          },
        }),
        signal,
      });
      if (!resp.ok) {
        throw new WhaleError('INTERNAL_ERROR', `MiniMax TTS HTTP ${resp.status}`, { recoverable: true });
      }
      const json = (await resp.json()) as {
        base_resp?: { status_code?: number; status_msg?: string };
        data?: { audio?: string };
        extra_info?: { audio_length?: number; audio_sample_rate?: number };
      };
      if (json.base_resp?.status_code !== undefined && json.base_resp.status_code !== 0) {
        throw new WhaleError('INTERNAL_ERROR', `MiniMax TTS 错误: ${json.base_resp.status_msg ?? 'unknown'}`, {
          recoverable: true,
        });
      }
      const hexAudio = json.data?.audio ?? '';
      if (hexAudio === '') {
        throw new WhaleError('INTERNAL_ERROR', 'MiniMax TTS 返回空音频', { recoverable: true });
      }
      const bytes = Buffer.from(hexAudio, 'hex');
      const durationMs = json.extra_info?.audio_length ?? estimateSpeechMs(request.text, request.speed);
      return VoiceSynthesisOutputSchema.parse({
        requestId: request.requestId,
        providerKind: this.kind,
        quality: 'character_tts',
        degraded: false,
        format: 'mp3',
        sampleRate: json.extra_info?.audio_sample_rate ?? 24_000,
        durationMs,
        audioBase64: bytes.toString('base64'),
        lipFrames: synthesizeTextLipSyncFrames(request.text, durationMs),
        cached: false,
        latencyMs: Math.max(0, Date.now() - started),
      });
    } finally {
      cleanup();
    }
  }
}

export interface LocalAudioWorkerOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** 本地 Python audio-ai-worker HTTP 客户端 */
export class LocalAudioWorkerProvider implements VoiceProvider {
  readonly kind = 'local-audio-worker' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: LocalAudioWorkerOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:18770').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  /**
   * 探针实测：能力一律来自 Worker 的 `/health` 自报，**不许硬编码**。
   *
   * 历史坑：这里曾对成功与失败两个分支都写死 `supportsEmotion: true`，
   * 于是连「正弦波占位后端」也被宿主当成情绪 TTS 展示。
   */
  async probe(): Promise<VoiceProviderStatus> {
    const { signal, cleanup } = withTimeoutSignal(1200);
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/health`, { method: 'GET', signal });
      if (!resp.ok) {
        return VoiceProviderStatusSchema.parse({
          kind: this.kind,
          quality: 'local_worker',
          available: false,
          degraded: false,
          platform: process.platform,
          detail: `Audio Worker 返回 ${resp.status}`,
          supportsStreaming: false,
          supportsEmotion: false,
        });
      }
      let body: unknown = null;
      try {
        body = await resp.json();
      } catch {
        body = null;
      }
      const health = LocalAudioWorkerHealthSchema.safeParse(body);
      const tts = health.success ? health.data.tts : undefined;
      if (tts === undefined) {
        // 旧版 Worker 只回 {status:'ok'}：没上报就不许猜，按「不支持情绪」处理
        return VoiceProviderStatusSchema.parse({
          kind: this.kind,
          quality: 'local_worker',
          available: true,
          degraded: true,
          platform: process.platform,
          detail: `本地 Audio Worker 在线 (${this.baseUrl})，但未上报 TTS 能力（旧版 Worker），按「不支持情绪」处理`,
          supportsStreaming: false,
          supportsEmotion: false,
        });
      }
      const placeholder = tts.mode !== 'real';
      return VoiceProviderStatusSchema.parse({
        kind: this.kind,
        quality: 'local_worker',
        available: true,
        // 占位波形不是角色音色，必须按降级展示
        degraded: placeholder,
        platform: process.platform,
        detail: `本地 Audio Worker 在线 (${this.baseUrl}) · ${tts.engine} · ${tts.detail}`,
        supportsStreaming: false,
        // 占位后端无论自报什么都按不支持情绪：正弦变基频不叫人声表情
        supportsEmotion: tts.mode === 'real' && tts.supportsEmotion,
      });
    } catch {
      return VoiceProviderStatusSchema.parse({
        kind: this.kind,
        quality: 'local_worker',
        available: false,
        degraded: false,
        platform: process.platform,
        detail: `本地 Audio Worker 未启动 (${this.baseUrl})`,
        supportsStreaming: false,
        supportsEmotion: false,
      });
    } finally {
      cleanup();
    }
  }

  async synthesize(request: VoiceSynthesisRequest, externalSignal?: AbortSignal): Promise<VoiceSynthesisOutput> {
    const { signal, cleanup } = withTimeoutSignal(request.timeoutMs, externalSignal);
    const started = Date.now();
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/tts/emotion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: request.text,
          emotionTag: request.emotion,
          voiceRef: request.voiceRef,
        }),
        signal,
      });
      if (!resp.ok) {
        throw new WhaleError('INTERNAL_ERROR', `LocalAudioWorker HTTP ${resp.status}`, { recoverable: true });
      }
      const data = (await resp.json()) as {
        format?: 'wav' | 'mp3' | 'ogg';
        durationMs?: number;
        audioBase64?: string;
        degraded?: boolean;
        /** Worker 自报：这段音频是占位波形而非真实 TTS 人声 */
        placeholder?: boolean;
        placeholderReason?: string;
        lipEnvelope?: {
          visemes?: Array<{ viseme: 'closed' | 'wide' | 'round' | 'open' | 'teeth'; startMs: number; durationMs: number; amplitude?: number }>;
        };
      };
      const durationMs = data.durationMs ?? estimateSpeechMs(request.text, request.speed);
      const lipFrames = (data.lipEnvelope?.visemes ?? []).map((v) => ({
        timestampMs: v.startMs,
        durationMs: v.durationMs,
        viseme: v.viseme,
        amplitude: v.amplitude ?? 0.6,
        rmsDb: -12,
      }));
      const placeholder = data.placeholder === true;
      return VoiceSynthesisOutputSchema.parse({
        requestId: request.requestId,
        providerKind: this.kind,
        quality: 'local_worker',
        // 占位波形同样属于降级：不能让调用方以为这是角色真实音色
        degraded: Boolean(data.degraded) || placeholder,
        format: data.format ?? 'wav',
        sampleRate: 24_000,
        durationMs,
        ...(data.audioBase64 === undefined ? {} : { audioBase64: data.audioBase64 }),
        lipFrames: lipFrames.length > 0 ? lipFrames : synthesizeTextLipSyncFrames(request.text, durationMs),
        cached: false,
        latencyMs: Math.max(0, Date.now() - started),
        placeholder,
        ...(data.placeholderReason === undefined ? {} : { placeholderReason: data.placeholderReason }),
      });
    } finally {
      cleanup();
    }
  }
}

/** 跨平台系统 TTS 诚实降级后端：macOS say / Windows SAPI / 其他平台 unsupported */
export class SystemFallbackVoiceProvider implements VoiceProvider {
  readonly kind: VoiceProviderKind;

  constructor(private readonly platform: string = process.platform) {
    this.kind = platform === 'darwin'
      ? 'macos-say'
      : platform === 'win32'
        ? 'windows-sapi'
        : 'unsupported';
  }

  probe(): VoiceProviderStatus {
    if (this.kind === 'macos-say') {
      return VoiceProviderStatusSchema.parse({
        kind: 'macos-say',
        quality: 'system_fallback',
        available: true,
        degraded: true,
        platform: this.platform,
        detail: 'macOS 系统语音 say（诚实降级兜底，非专属角色 TTS）',
        supportsStreaming: false,
        supportsEmotion: false,
      });
    }
    if (this.kind === 'windows-sapi') {
      return VoiceProviderStatusSchema.parse({
        kind: 'windows-sapi',
        quality: 'system_fallback',
        available: true,
        degraded: true,
        platform: this.platform,
        detail: 'Windows System.Speech SAPI（诚实降级兜底，非专属角色 TTS）',
        supportsStreaming: false,
        supportsEmotion: false,
      });
    }
    return VoiceProviderStatusSchema.parse({
      kind: 'unsupported',
      quality: 'unsupported',
      available: false,
      degraded: true,
      platform: this.platform,
      detail: `平台 ${this.platform} 暂无系统语音降级后端`,
      supportsStreaming: false,
      supportsEmotion: false,
    });
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisOutput> {
    if (this.kind === 'unsupported') {
      throw new WhaleError('INTERNAL_ERROR', `平台 ${this.platform} 不支持系统语音降级`, { recoverable: true });
    }
    const durationMs = estimateSpeechMs(request.text, request.speed);
    return VoiceSynthesisOutputSchema.parse({
      requestId: request.requestId,
      providerKind: this.kind,
      quality: 'system_fallback',
      degraded: true,
      format: 'system-direct',
      sampleRate: 22_050,
      durationMs,
      lipFrames: synthesizeTextLipSyncFrames(request.text, durationMs),
      cached: false,
      latencyMs: 0,
    });
  }
}

export interface VoiceProviderRouterOptions {
  providers: VoiceProvider[];
  maxCacheEntries?: number;
}

/** 语音路由与缓存编排器：支持与 VoiceIdentity 解耦的后端切换、降级标注与流式分句预取 */
export class VoiceProviderRouter {
  private readonly cache = new Map<string, VoiceSynthesisOutput>();
  private readonly maxCacheEntries: number;

  constructor(private readonly options: VoiceProviderRouterOptions) {
    this.maxCacheEntries = Math.max(4, options.maxCacheEntries ?? 64);
  }

  /** 从独立 VoiceIdentity 解析生效声线标识，避免换 Provider 丢失音色设定 */
  resolveVoiceRef(identity: VoiceIdentityDomain, fallbackVoiceRef?: string): string {
    return identity.providerVoiceRef ?? identity.voiceProfileId ?? fallbackVoiceRef ?? 'default';
  }

  async listStatuses(): Promise<VoiceProviderStatus[]> {
    return Promise.all(this.options.providers.map((p) => Promise.resolve(p.probe())));
  }

  async synthesize(
    rawInput: VoiceSynthesisRequestInput,
    opts: { preferredProvider?: VoiceProviderKind; signal?: AbortSignal } = {},
  ): Promise<VoiceSynthesisOutput> {
    const request = VoiceSynthesisRequestSchema.parse(rawInput);
    const cacheKey = `${opts.preferredProvider ?? 'auto'}|${request.voiceRef}|${request.emotion}|${request.styleMode}|${request.speed}|${request.text}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // 刷新 LRU 顺序
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return { ...cached, requestId: request.requestId, cached: true };
    }

    const statuses = await this.listStatuses();
    const statusMap = new Map<VoiceProviderKind, VoiceProviderStatus>(statuses.map((s) => [s.kind, s]));

    const ordered = [...this.options.providers].sort((a, b) => {
      if (a.kind === opts.preferredProvider) return -1;
      if (b.kind === opts.preferredProvider) return 1;
      return 0;
    });

    let degradedFrom: VoiceProviderKind | undefined;
    const failures: string[] = [];

    for (const provider of ordered) {
      if (opts.signal?.aborted) {
        throw new WhaleError('RUNTIME_HALTED', '语音合成已取消', { recoverable: true });
      }
      const status = statusMap.get(provider.kind);
      if (!status?.available) {
        if (opts.preferredProvider === provider.kind) degradedFrom = provider.kind;
        continue;
      }
      try {
        const result = await provider.synthesize(request, opts.signal);
        const normalized: VoiceSynthesisOutput = {
          ...result,
          ...(degradedFrom === undefined ? {} : { degraded: true, degradedFrom }),
        };
        this.rememberCache(cacheKey, normalized);
        return normalized;
      } catch (err) {
        if (isAbortError(err) && opts.signal?.aborted) {
          throw new WhaleError('RUNTIME_HALTED', '语音合成被调用方中止', { recoverable: true, cause: err });
        }
        degradedFrom ??= provider.kind;
        failures.push(`${provider.kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new WhaleError('INTERNAL_ERROR', `所有语音后端均不可用：${failures.join('；') || '无可用后端'}`, {
      recoverable: true,
    });
  }

  /** 分句流式合成：按句预取下一段（lookahead=1），外部信号中止时立即停止后续请求 */
  async synthesizeChunked(
    rawInput: VoiceSynthesisRequestInput,
    opts: { preferredProvider?: VoiceProviderKind; maxChunkChars?: number; signal?: AbortSignal } = {},
  ): Promise<VoiceSynthesisOutput[]> {
    const base = VoiceSynthesisRequestSchema.parse(rawInput);
    const chunks = splitSpeechSentences(base.text, opts.maxChunkChars);
    const results: VoiceSynthesisOutput[] = [];
    let prefetched: Promise<VoiceSynthesisOutput> | null = null;

    for (let i = 0; i < chunks.length; i++) {
      if (opts.signal?.aborted) {
        throw new WhaleError('RUNTIME_HALTED', '分句语音合成已取消', { recoverable: true });
      }
      const currentPromise = prefetched ?? this.synthesize(
        { ...base, requestId: `${base.requestId}#${i}`, text: chunks[i]! },
        { ...(opts.preferredProvider === undefined ? {} : { preferredProvider: opts.preferredProvider }), ...(opts.signal === undefined ? {} : { signal: opts.signal }) },
      );
      if (i + 1 < chunks.length) {
        prefetched = this.synthesize(
          { ...base, requestId: `${base.requestId}#${i + 1}`, text: chunks[i + 1]! },
          { ...(opts.preferredProvider === undefined ? {} : { preferredProvider: opts.preferredProvider }), ...(opts.signal === undefined ? {} : { signal: opts.signal }) },
        );
      } else {
        prefetched = null;
      }
      results.push(await currentPromise);
    }
    return results;
  }

  private rememberCache(key: string, output: VoiceSynthesisOutput): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, output);
  }
}
