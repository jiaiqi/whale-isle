import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeEventBus, WhaleError } from '@workbench/runtime-core';
import { VoiceIdentityDomainSchema } from '@workbench/shared-protocol';
import {
  AudioMixer,
  buildWindowsSapiCommand,
  CloudOpenAiTtsProvider,
  extractWavLipSyncFrames,
  LipSyncTimelinePlayer,
  LocalAudioWorkerProvider,
  MiniMaxTtsProvider,
  resolveCommercialTtsProvider,
  splitSpeechSentences,
  synthesizeTextLipSyncFrames,
  SystemFallbackVoiceProvider,
  VoiceProviderRouter,
} from './index';

function makePcm16Wav(samples: number[], sampleRate = 8000): Uint8Array {
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeTag = (offset: number, text: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, samples[i]!)), true);
  }
  return new Uint8Array(buf);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('lip-sync extraction, sentence chunking, and timeline player (V2-P1-02)', () => {
  it('splits long Chinese/English speech into bounded chunks', () => {
    expect(splitSpeechSentences('   ')).toEqual([]);
    const chunks = splitSpeechSentences(
      '第一句话很短。第二句话特别特别特别长，包含很多逗号细节，需要进一步按长度切分成小片段，确保首包延迟足够低！',
      24,
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.length <= 24)).toBe(true);

    const noPunct = splitSpeechSentences('a'.repeat(30), 12);
    expect(noPunct).toEqual(['a'.repeat(12), 'a'.repeat(12), 'a'.repeat(6)]);
  });

  it('extracts visemes from real PCM16 WAV bytes and safely ignores non-WAV data', () => {
    expect(extractWavLipSyncFrames(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(extractWavLipSyncFrames(new Uint8Array(44))).toEqual([]);

    // 400 samples @ 8kHz = 50ms silence + 400 samples loud low-freq + 400 samples high-ZCR teeth
    const samples: number[] = [];
    for (let i = 0; i < 400; i++) samples.push(0);
    for (let i = 0; i < 400; i++) samples.push(Math.round(25000 * Math.sin((2 * Math.PI * 200 * i) / 8000)));
    for (let i = 0; i < 400; i++) samples.push(i % 2 === 0 ? 12000 : -12000);
    for (let i = 0; i < 400; i++) samples.push(Math.round(7000 * Math.sin((2 * Math.PI * 100 * i) / 8000)));

    const frames = extractWavLipSyncFrames(makePcm16Wav(samples, 8000), 50);
    expect(frames).toHaveLength(4);
    expect(frames[0]?.viseme).toBe('closed');
    expect(frames[1]?.viseme).toBe('open');
    expect(frames[2]?.viseme).toBe('teeth');
    expect(frames[3]?.viseme).toBe('round');
  });

  it('generates text lip-sync frames and plays timeline with immediate closed reset on stop', () => {
    vi.useFakeTimers();
    const emptyFrames = synthesizeTextLipSyncFrames('', 100);
    expect(emptyFrames[0]?.viseme).toBe('closed');

    const frames = synthesizeTextLipSyncFrames('你好世界，今天去钓鱼！', 240, 60);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames[frames.length - 1]?.viseme).toBe('closed');

    const emitted: string[] = [];
    const onComplete = vi.fn();
    const player = new LipSyncTimelinePlayer({
      frames,
      onFrame: (f) => emitted.push(f.viseme),
      onComplete,
    });
    player.start();
    vi.advanceTimersByTime(65);
    expect(emitted.length).toBeGreaterThanOrEqual(2);

    player.stop();
    expect(emitted[emitted.length - 1]).toBe('closed');

    const emptyPlayer = new LipSyncTimelinePlayer({
      frames: [],
      onFrame: (f) => emitted.push(f.viseme),
      onComplete,
    });
    emptyPlayer.start();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceProvider implementations & VoiceProviderRouter (V2-P1-02)', () => {
  it('calls real CloudOpenAiTtsProvider, MiniMaxTtsProvider, LocalAudioWorkerProvider and handles failures', async () => {
    const wavBytes = makePcm16Wav(new Array(800).fill(0).map((_, i) => (i % 2 === 0 ? 15000 : -15000)), 8000);
    const openai = new CloudOpenAiTtsProvider({
      resolveApiKey: () => 'test-openai-token',
      fetchImpl: async () => new Response(wavBytes, { status: 200 }),
    });
    expect(openai.probe().available).toBe(true);
    const out1 = await openai.synthesize({
      requestId: 'r1',
      characterId: 'char_xiaojing',
      voiceRef: 'qiaopi_mengmei',
      text: '测试 WAV 口型提取',
      emotion: 'happy',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 5000,
    });
    expect(out1.providerKind).toBe('openai-compatible-tts');
    expect(out1.lipFrames.length).toBeGreaterThan(0);

    const minimax = new MiniMaxTtsProvider({
      resolveApiKey: () => 'test-mm-token',
      fetchImpl: async () =>
        new Response(JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'ok' },
          data: { audio: Buffer.from('mp3bytes').toString('hex') },
          extra_info: { audio_length: 900, audio_sample_rate: 24000 },
        }), { status: 200 }),
    });
    expect(minimax.probe().available).toBe(true);
    const out2 = await minimax.synthesize({
      requestId: 'r2',
      characterId: 'char_xiaojing',
      voiceRef: 'qiaopi_mengmei',
      text: 'MiniMax 合成测试',
      emotion: 'tsundere',
      styleMode: 'p0',
      speed: 1.1,
      pitchShiftSemitones: 2,
      volume: 0.9,
      timeoutMs: 5000,
    });
    expect(out2.providerKind).toBe('minimax-tts');
    expect(out2.durationMs).toBe(900);

    const worker = new LocalAudioWorkerProvider({
      fetchImpl: async (url) => {
        if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        return new Response(JSON.stringify({
          format: 'wav',
          durationMs: 700,
          audioBase64: 'UklGRg==',
          lipEnvelope: {
            visemes: [{ viseme: 'open', startMs: 0, durationMs: 300, amplitude: 0.8 }],
          },
        }), { status: 200 });
      },
    });
    expect((await worker.probe()).available).toBe(true);
    const out3 = await worker.synthesize({
      requestId: 'r3',
      characterId: 'char_xiaojing',
      voiceRef: 'qiaopi_mengmei',
      text: '本地 Worker 合成',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 5000,
    });
    expect(out3.quality).toBe('local_worker');
    expect(out3.lipFrames[0]?.viseme).toBe('open');
  });

  it('reports honest platform fallback & builds injection-safe Windows SAPI command', async () => {
    const sapiCmd = buildWindowsSapiCommand(120, 0.8);
    expect(sapiCmd.command).toBe('powershell.exe');
    expect(sapiCmd.args.join(' ')).toContain('$env:WHALE_TTS_TEXT');
    expect(sapiCmd.rate).toBe(2);
    expect(sapiCmd.volume).toBe(80);

    const macFallback = new SystemFallbackVoiceProvider('darwin');
    expect(macFallback.probe()).toMatchObject({ kind: 'macos-say', quality: 'system_fallback', available: true, degraded: true });

    const winFallback = new SystemFallbackVoiceProvider('win32');
    expect(winFallback.probe()).toMatchObject({ kind: 'windows-sapi', quality: 'system_fallback', available: true, degraded: true });
    const winOut = await winFallback.synthesize({
      requestId: 'r-win',
      characterId: 'char_xiaojing',
      voiceRef: 'default',
      text: '你好呀',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 5000,
    });
    expect(winOut.format).toBe('system-direct');
    expect(winOut.degraded).toBe(true);

    const linuxFallback = new SystemFallbackVoiceProvider('linux');
    expect(linuxFallback.probe()).toMatchObject({ kind: 'unsupported', quality: 'unsupported', available: false });
    await expect(linuxFallback.synthesize({
      requestId: 'r-lin',
      characterId: 'char_xiaojing',
      voiceRef: 'default',
      text: 'test',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 5000,
    })).rejects.toThrow(WhaleError);
  });

  it('routes by decoupled VoiceIdentity, degrades transparently, caches LRU, and supports chunked prefetch/abort', async () => {
    const identity = VoiceIdentityDomainSchema.parse({
      voiceProfileId: 'qiaopi_mengmei',
      characterId: 'char_xiaojing',
      voiceDescription: '俏皮傲娇少女',
      providerVoiceRef: 'xiaojing_ref_01',
    });

    const failingCloud = new CloudOpenAiTtsProvider({
      resolveApiKey: () => 'fake-key',
      fetchImpl: async () => new Response('boom', { status: 503 }),
    });
    const offlineWorker = new LocalAudioWorkerProvider({
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    const fallback = new SystemFallbackVoiceProvider('darwin');

    const router = new VoiceProviderRouter({
      providers: [failingCloud, offlineWorker, fallback],
      maxCacheEntries: 4,
    });

    expect(router.resolveVoiceRef(identity)).toBe('xiaojing_ref_01');
    const statuses = await router.listStatuses();
    expect(statuses.map((s) => s.kind)).toEqual(['openai-compatible-tts', 'local-audio-worker', 'macos-say']);

    // 首选云端 503 → 自动降级到 macos-say 并诚实标明 degradedFrom
    const res1 = await router.synthesize({
      requestId: 'req-a',
      characterId: 'char_xiaojing',
      voiceRef: router.resolveVoiceRef(identity),
      text: '第一句测试。第二句测试。',
    }, { preferredProvider: 'openai-compatible-tts' });
    expect(res1.providerKind).toBe('macos-say');
    expect(res1.degraded).toBe(true);
    expect(res1.degradedFrom).toBe('openai-compatible-tts');

    // LRU 缓存命中
    const resCached = await router.synthesize({
      requestId: 'req-b',
      characterId: 'char_xiaojing',
      voiceRef: router.resolveVoiceRef(identity),
      text: '第一句测试。第二句测试。',
    }, { preferredProvider: 'openai-compatible-tts' });
    expect(resCached.cached).toBe(true);
    expect(resCached.requestId).toBe('req-b');

    // 分句预取
    const chunked = await router.synthesizeChunked({
      requestId: 'req-chunk',
      characterId: 'char_xiaojing',
      voiceRef: 'qiaopi_mengmei',
      text: '今天去海滩钓鱼。然后再去矿洞！',
    });
    expect(chunked).toHaveLength(2);

    // 外部信号取消
    const ac = new AbortController();
    ac.abort();
    await expect(router.synthesize({
      requestId: 'req-abort',
      characterId: 'char_xiaojing',
      voiceRef: 'v',
      text: '被取消',
    }, { signal: ac.signal })).rejects.toThrow(WhaleError);

    // 全部不可用时抛出明确错误
    const deadRouter = new VoiceProviderRouter({
      providers: [
        new CloudOpenAiTtsProvider({ resolveApiKey: () => null }),
        new MiniMaxTtsProvider({ resolveApiKey: () => null }),
        new SystemFallbackVoiceProvider('linux'),
      ],
    });
    await expect(deadRouter.synthesize({
      requestId: 'req-dead',
      characterId: 'char_xiaojing',
      voiceRef: 'v',
      text: '无后端',
    })).rejects.toThrow(WhaleError);
  });

  it('handles MiniMax API error status and missing keys cleanly', async () => {
    const noKeyOpenAi = new CloudOpenAiTtsProvider({ resolveApiKey: () => null });
    expect(noKeyOpenAi.probe().available).toBe(false);
    await expect(noKeyOpenAi.synthesize({
      requestId: 'r-nk',
      characterId: 'c',
      voiceRef: 'v',
      text: 'hi',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 2000,
    })).rejects.toThrow(WhaleError);

    const badMiniMax = new MiniMaxTtsProvider({
      resolveApiKey: () => 'k',
      fetchImpl: async () => new Response(JSON.stringify({
        base_resp: { status_code: 1004, status_msg: 'invalid auth' },
      }), { status: 200 }),
    });
    await expect(badMiniMax.synthesize({
      requestId: 'r-mm-err',
      characterId: 'c',
      voiceRef: 'v',
      text: 'hi',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 2000,
    })).rejects.toThrow(WhaleError);
  });
});

describe('SpeechFloorArbiter & multi-track AudioMixer (V2-P1-02)', () => {
  it('runs concurrent BGM/SFX tracks without speech lock blocking, ducks BGM during speech, and preempts P0', async () => {
    let tick = 1000;
    const bus = new RuntimeEventBus({ now: () => ++tick });
    const receipts: string[] = [];
    const mixer = new AudioMixer({
      events: bus,
      duckingGainMultiplier: 0.2,
      now: () => ++tick,
      onReceipt: (r) => receipts.push(`${r.leaseId}:${r.status}`),
    });

    const bgmStopped = vi.fn();
    const bgm = mixer.startTrack({
      trackId: 'bgm-stardew',
      kind: 'bgm',
      label: '星露谷春季配乐',
      gain: 1.0,
      onStop: bgmStopped,
    });
    const sfx = mixer.startTrack({
      trackId: 'sfx-water',
      kind: 'sfx',
      label: '浇水音效',
      gain: 0.8,
    });
    expect(bgm.playing).toBe(true);
    expect(bgm.ducked).toBe(false);
    expect(sfx.effectiveGain).toBe(0.8);

    // 独立输出设备路由
    mixer.setOutputRoute('bgm', 'obs-audio-bus');
    expect(mixer.snapshot().outputRoutes.bgm).toBe('obs-audio-bus');

    // 启动 P1 语音，验证并发 BGM 不阻塞且自动压低增益
    let resolveP1!: () => void;
    const abortP1 = vi.fn();
    const p1Res = mixer.acquireSpeech({
      leaseId: 'lease-p1',
      agentId: 'default',
      characterId: 'char_xiaojing',
      speakerName: '小鲸',
      voiceRef: 'qiaopi_mengmei',
      priority: 'P1_CADENCE',
      ttlMs: 5000,
      start: () => new Promise<void>((r) => { resolveP1 = r; }),
      abort: abortP1,
    });
    expect(p1Res).toBe('granted');
    const snapDuringSpeech = mixer.snapshot();
    expect(snapDuringSpeech.duckingActive).toBe(true);
    expect(snapDuringSpeech.tracks.find((t) => t.trackId === 'bgm-stardew')?.effectiveGain).toBe(0.2);
    expect(snapDuringSpeech.tracks.find((t) => t.trackId === 'sfx-water')?.effectiveGain).toBe(0.8);

    // P0 抢占正在说话的 P1，而 BGM 持续播放不受影响
    let resolveP0!: () => void;
    const p0Res = mixer.acquireSpeech({
      leaseId: 'lease-p0',
      agentId: 'default',
      characterId: 'char_xiaojing',
      speakerName: '小鲸',
      voiceRef: 'qiaopi_mengmei',
      priority: 'P0_INTERRUPT',
      ttlMs: 5000,
      start: () => new Promise<void>((r) => { resolveP0 = r; }),
      abort: () => undefined,
    });
    expect(p0Res).toBe('preempted');
    expect(abortP1).toHaveBeenCalledTimes(1);
    expect(receipts).toContain('lease-p1:INTERRUPTED_BY_P0');
    expect(bgmStopped).not.toHaveBeenCalled();

    // P0 播放完成后自动取消 BGM 压低
    await Promise.resolve();
    resolveP0();
    resolveP1();
    await new Promise((r) => setTimeout(r, 10));

    const snapAfter = mixer.snapshot();
    expect(snapAfter.speechFloorHolder).toBeNull();
    expect(snapAfter.duckingActive).toBe(false);
    expect(snapAfter.tracks.find((t) => t.trackId === 'bgm-stardew')?.effectiveGain).toBe(1.0);

    // 增益调整、静音、停轨与急停全部清理
    mixer.setTrackGain('bgm-stardew', 0.5);
    mixer.setTrackMuted('bgm-stardew', true);
    expect(mixer.snapshot().tracks.find((t) => t.trackId === 'bgm-stardew')?.effectiveGain).toBe(0);
    mixer.setTrackMuted('bgm-stardew', false);
    mixer.setSpeechDucking(true);
    expect(mixer.snapshot().duckingActive).toBe(true);
    mixer.stopAll();
    expect(bgmStopped).toHaveBeenCalledTimes(1);
    expect(mixer.snapshot().tracks).toHaveLength(0);
  });

  it('enforces TTL expiration and queued speech cancellation', async () => {
    vi.useFakeTimers();
    const receipts: string[] = [];
    const mixer = new AudioMixer({
      onReceipt: (r) => receipts.push(`${r.leaseId}:${r.status}`),
    });

    const abortSlow = vi.fn();
    mixer.acquireSpeech({
      leaseId: 'slow-1',
      agentId: 'default',
      characterId: 'char_xiaojing',
      speakerName: '小鲸',
      voiceRef: 'v1',
      priority: 'P1_CADENCE',
      ttlMs: 500,
      start: () => new Promise<void>(() => undefined),
      abort: abortSlow,
    });
    const queued = mixer.acquireSpeech({
      leaseId: 'queued-2',
      agentId: 'default',
      characterId: 'char_xiaojing',
      speakerName: '小鲸',
      voiceRef: 'v1',
      priority: 'P2_IDLE',
      ttlMs: 1000,
      start: async () => undefined,
      abort: () => undefined,
    });
    expect(queued).toBe('queued');
    expect(mixer.speechFloor.cancel('queued-2')).toBe(true);
    expect(mixer.speechFloor.cancel('nonexistent')).toBe(false);

    vi.advanceTimersByTime(550);
    expect(abortSlow).toHaveBeenCalledTimes(1);
    expect(receipts).toContain('slow-1:TTL_EXPIRED');
  });

  it('covers active lease cancellation, device errors, missing tracks, WAV chunk edge cases, and LRU cache eviction', async () => {
    vi.useFakeTimers();
    const receipts: string[] = [];
    const mixer = new AudioMixer({
      onReceipt: (r) => receipts.push(`${r.leaseId}:${r.status}`),
    });

    // 取消正在播放的租约 & queued P0 优先出队 & 播放抛错 AUDIO_DEVICE_ERROR
    mixer.acquireSpeech({
      leaseId: 'active-1',
      agentId: 'default',
      characterId: 'char_xiaojing',
      speakerName: '小鲸',
      voiceRef: 'v1',
      priority: 'P1_CADENCE',
      ttlMs: 5000,
      start: () => new Promise<void>(() => undefined),
      abort: () => undefined,
    });
    mixer.acquireSpeech({
      leaseId: 'queued-normal',
      agentId: 'default',
      characterId: 'char_xiaojing',
      speakerName: '小鲸',
      voiceRef: 'v1',
      priority: 'P2_IDLE',
      ttlMs: 1000,
      start: async () => undefined,
      abort: () => undefined,
    });
    expect(mixer.speechFloor.cancel('active-1')).toBe(true);
    // 主动取消如实标 CANCELLED（此前误标 INTERRUPTED_BY_P0 并被本断言固化）
    expect(receipts).toContain('active-1:CANCELLED');

    await vi.advanceTimersByTimeAsync(10);
    expect(receipts).toContain('queued-normal:COMPLETED');

    mixer.acquireSpeech({
      leaseId: 'err-1',
      agentId: 'default',
      characterId: 'char_xiaojing',
      speakerName: '小鲸',
      voiceRef: 'v1',
      priority: 'P1_CADENCE',
      ttlMs: 1000,
      start: async () => { throw new Error('device busy'); },
      abort: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(receipts).toContain('err-1:AUDIO_DEVICE_ERROR');

    // 轨道缺失与默认路由分支
    expect(mixer.setTrackGain('missing', 0.5)).toBeNull();
    expect(mixer.setTrackMuted('missing', true)).toBeNull();
    expect(mixer.stopTrack('missing')).toBe(false);
    mixer.startTrack({ trackId: 't1', kind: 'bgm', label: 'bgm1' });
    expect(mixer.stopTrack('t1')).toBe(true);
    mixer.startTrack({ trackId: 't2', kind: 'sfx', label: 'sfx1', muted: true });
    mixer.setOutputRoute('sfx', '');
    expect(mixer.snapshot().outputRoutes.sfx).toBe('default');

    // WAV 非 PCM16 与非 16-bit 与未知前导 chunk 分支
    const badFormatWav = makePcm16Wav([100, -100], 8000);
    new DataView(badFormatWav.buffer).setUint16(20, 3, true); // IEEE float
    expect(extractWavLipSyncFrames(badFormatWav)).toEqual([]);

    const badBitsWav = makePcm16Wav([100, -100], 8000);
    new DataView(badBitsWav.buffer).setUint16(34, 8, true);
    expect(extractWavLipSyncFrames(badBitsWav)).toEqual([]);

    // 带前导 JUNK chunk 的 WAV 与逗号长句分句
    const junkChunk = new Uint8Array([0x4a, 0x55, 0x4e, 0x4b, 2, 0, 0, 0, 0, 0]);
    const validWav = makePcm16Wav(new Array(400).fill(8000), 8000);
    const withJunk = new Uint8Array(validWav.length + junkChunk.length);
    withJunk.set(validWav.slice(0, 12), 0);
    withJunk.set(junkChunk, 12);
    withJunk.set(validWav.slice(12), 12 + junkChunk.length);
    expect(extractWavLipSyncFrames(withJunk, 50).length).toBeGreaterThan(0);

    const commaChunks = splitSpeechSentences('第一段很短，第二段也很短，第三段继续拼接，第四段超出上限了，第五段结尾', 14);
    expect(commaChunks.length).toBeGreaterThanOrEqual(3);

    // TimelinePlayer 自然完成分支
    const doneFrames = synthesizeTextLipSyncFrames('你好', 120, 60);
    const onDone = vi.fn();
    const player = new LipSyncTimelinePlayer({
      frames: doneFrames,
      onFrame: () => undefined,
      onComplete: onDone,
    });
    player.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(onDone).toHaveBeenCalledTimes(1);

    // Provider 失败分支、MP3 格式、LRU 驱逐与 resolveVoiceRef 兜底
    const noKeyMiniMax = new MiniMaxTtsProvider({ resolveApiKey: () => null });
    expect(noKeyMiniMax.probe().available).toBe(false);
    await expect(noKeyMiniMax.synthesize({
      requestId: 'r-mm-nk',
      characterId: 'c',
      voiceRef: 'v',
      text: 'hi',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 2000,
    })).rejects.toThrow(WhaleError);

    const httpErrMiniMax = new MiniMaxTtsProvider({
      resolveApiKey: () => 'k',
      fetchImpl: async () => new Response('err', { status: 500 }),
    });
    await expect(httpErrMiniMax.synthesize({
      requestId: 'r-mm-500',
      characterId: 'c',
      voiceRef: 'v',
      text: 'hi',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 2000,
    })).rejects.toThrow(WhaleError);

    const emptyMiniMax = new MiniMaxTtsProvider({
      resolveApiKey: () => 'k',
      fetchImpl: async () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: {} }), { status: 200 }),
    });
    await expect(emptyMiniMax.synthesize({
      requestId: 'r-mm-empty',
      characterId: 'c',
      voiceRef: 'v',
      text: 'hi',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 2000,
    })).rejects.toThrow(WhaleError);

    const workerBad = new LocalAudioWorkerProvider({
      fetchImpl: async (url) => url.endsWith('/health')
        ? new Response('down', { status: 503 })
        : new Response('err', { status: 500 }),
    });
    expect((await workerBad.probe()).available).toBe(false);
    await expect(workerBad.synthesize({
      requestId: 'r-w-500',
      characterId: 'c',
      voiceRef: 'v',
      text: 'hi',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 2000,
    })).rejects.toThrow(WhaleError);

    const mp3OpenAi = new CloudOpenAiTtsProvider({
      responseFormat: 'mp3',
      resolveApiKey: () => 'k',
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });
    const lruRouter = new VoiceProviderRouter({
      providers: [mp3OpenAi, new SystemFallbackVoiceProvider('darwin')],
      maxCacheEntries: 4,
    });
    const idNoRef = VoiceIdentityDomainSchema.parse({
      voiceProfileId: 'vp-fallback',
      characterId: 'char_xiaojing',
      voiceDescription: 'desc',
    });
    expect(lruRouter.resolveVoiceRef(idNoRef)).toBe('vp-fallback');
    for (let i = 0; i < 6; i++) {
      const out = await lruRouter.synthesize({
        requestId: `lru-${i}`,
        characterId: 'char_xiaojing',
        voiceRef: 'vp-fallback',
        text: `短句 ${i}`,
      });
      expect(out.format).toBe('mp3');
    }

    // synthesizeChunked 中止测试
    const ac2 = new AbortController();
    ac2.abort();
    await expect(lruRouter.synthesizeChunked({
      requestId: 'chunk-abort',
      characterId: 'char_xiaojing',
      voiceRef: 'vp-fallback',
      text: '一句。两句。',
    }, { signal: ac2.signal })).rejects.toThrow(WhaleError);
  });
});

describe('本地 Audio Worker 探针实测（item 10：能力不许硬编码）', () => {
  const workerWithHealth = (health: unknown): LocalAudioWorkerProvider =>
    new LocalAudioWorkerProvider({ fetchImpl: async () => new Response(JSON.stringify(health), { status: 200 }) });

  it('Worker 自报 placeholder 时：supportsEmotion=false、degraded=true，detail 带上引擎名', async () => {
    const status = await workerWithHealth({
      status: 'ok',
      tts: {
        mode: 'placeholder',
        engine: 'stub-sine-placeholder',
        supportsEmotion: false,
        detail: '占位后端 stub-sine-placeholder：不是人声；不支持情绪 TTS',
      },
    }).probe();
    expect(status.available).toBe(true);
    expect(status.supportsEmotion).toBe(false);
    expect(status.degraded).toBe(true);
    expect(status.detail).toContain('stub-sine-placeholder');
  });

  it('占位后端即使自报 supportsEmotion=true 也不采信（正弦变基频不叫人声表情）', async () => {
    const status = await workerWithHealth({
      status: 'ok',
      tts: { mode: 'placeholder', engine: 'stub-sine-placeholder', supportsEmotion: true, detail: '自称支持' },
    }).probe();
    expect(status.supportsEmotion).toBe(false);
  });

  it('真实后端自报支持情绪时才置 true', async () => {
    const status = await workerWithHealth({
      status: 'ok',
      tts: { mode: 'real', engine: 'cosyvoice2', supportsEmotion: true, detail: '情绪探针通过' },
    }).probe();
    expect(status.supportsEmotion).toBe(true);
    expect(status.degraded).toBe(false);
  });

  it('旧版 Worker 只回 {status:ok}：没上报就按不支持情绪处理，不许猜 true', async () => {
    const status = await workerWithHealth({ status: 'ok' }).probe();
    expect(status.available).toBe(true);
    expect(status.supportsEmotion).toBe(false);
    expect(status.degraded).toBe(true);
    expect(status.detail).toContain('未上报');
  });

  it('HTTP 非 2xx / 连不上：available=false 且 supportsEmotion=false', async () => {
    const bad = new LocalAudioWorkerProvider({ fetchImpl: async () => new Response('nope', { status: 503 }) });
    expect(await bad.probe()).toMatchObject({ available: false, supportsEmotion: false });
    const dead = new LocalAudioWorkerProvider({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await dead.probe()).toMatchObject({ available: false, supportsEmotion: false });
  });

  it('合成回执带 placeholder=true 时：输出标占位并把 degraded 置真，不再冒充角色音色', async () => {
    const worker = new LocalAudioWorkerProvider({
      fetchImpl: async () => new Response(JSON.stringify({
        format: 'wav',
        durationMs: 700,
        audioBase64: 'UklGRg==',
        placeholder: true,
        placeholderReason: '确定性正弦占位波形',
      }), { status: 200 }),
    });
    const out = await worker.synthesize({
      requestId: 'ph-1',
      characterId: 'char_xiaojing',
      voiceRef: 'qiaopi_mengmei',
      text: '占位',
      emotion: 'neutral',
      styleMode: 'normal',
      speed: 1,
      pitchShiftSemitones: 0,
      volume: 1,
      timeoutMs: 5000,
    });
    expect(out.placeholder).toBe(true);
    expect(out.degraded).toBe(true);
    expect(out.placeholderReason).toContain('正弦');
  });
});

describe('默认档商业供应商选择（显式选择，不靠「有没有 Key」）', () => {
  it('用户选的那家可用：直接用它且 honored=true', () => {
    const choice = resolveCommercialTtsProvider({ preference: 'openai-compatible-tts', available: ['minimax-tts', 'openai-compatible-tts'] });
    expect(choice).toMatchObject({ provider: 'openai-compatible-tts', honored: true });
    expect(choice.reason).toContain('按你的选择');
  });

  it('两家都可用时也不会因为顺序而跑到另一家', () => {
    const choice = resolveCommercialTtsProvider({ preference: 'minimax-tts', available: ['openai-compatible-tts', 'minimax-tts'] });
    expect(choice.provider).toBe('minimax-tts');
    expect(choice.honored).toBe(true);
  });

  it('选的那家不可用：回落到另一家并如实标 honored=false', () => {
    const choice = resolveCommercialTtsProvider({ preference: 'openai-compatible-tts', available: ['minimax-tts'] });
    expect(choice).toMatchObject({ provider: 'minimax-tts', honored: false });
    expect(choice.reason).toContain('不可用');
  });

  it('两家都不可用：保留用户的选择并说明没有凭据，不假装成功', () => {
    const choice = resolveCommercialTtsProvider({ preference: 'minimax-tts', available: [] });
    expect(choice).toMatchObject({ provider: 'minimax-tts', honored: false });
    expect(choice.reason).toContain('都不可用');
  });

  it('本地 Worker / 系统语音不算商业供应商，不会被选中', () => {
    const choice = resolveCommercialTtsProvider({ preference: 'minimax-tts', available: ['local-audio-worker', 'macos-say'] });
    expect(choice.provider).toBe('minimax-tts');
    expect(choice.honored).toBe(false);
  });
});
