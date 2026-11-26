import { describe, expect, it, vi } from 'vitest';
import { RuntimeEventBus } from '@workbench/runtime-core';
import {
  buildGuideToneWav,
  createPerformanceDirectorPreview,
  evaluateSongRights,
  LyricsClockSync,
  parseBilingualLrc,
  PerformanceDirector,
  SingEngine,
} from './performance';
import { AudioMixer } from './audio-mixer';

function makeSong(overrides?: Partial<{
  durationMs: number;
  songLicense: 'original_owned' | 'licensed_commercial' | 'licensed_livestream' | 'dev_only_non_commercial' | 'unlicensed';
  accompanimentLicense: 'original_owned' | 'licensed_commercial' | 'licensed_livestream' | 'dev_only_non_commercial' | 'unlicensed';
  lyricsLicense: 'original_owned' | 'licensed_commercial' | 'licensed_livestream' | 'dev_only_non_commercial' | 'unlicensed';
  voiceModelAuthorized: boolean;
  attribution: string;
  accompanimentTrackPath: string;
  referenceVocalPath: string;
}>) {
  return {
    songId: 'song-whale-tide',
    title: '潮汐告白',
    artist: 'Whale Isle',
    bpm: 120,
    durationMs: overrides?.durationMs ?? 8000,
    keySignature: 'C major',
    preferredRange: 'C4-F5',
    ...(overrides?.accompanimentTrackPath !== undefined ? { accompanimentTrackPath: overrides.accompanimentTrackPath } : { accompanimentTrackPath: 'assets/audio/tide-accomp.wav' }),
    ...(overrides?.referenceVocalPath !== undefined ? { referenceVocalPath: overrides.referenceVocalPath } : {}),
    lyrics: parseBilingualLrc([
      '[00:00.00] 浪花轻轻吻过码头 || Waves gently kiss the pier',
      '[00:02.50] 鲸屿的灯火为谁守候',
      '[00:02.50] Who are the lights of Whale Isle waiting for',
      '[00:02.50] kujira no akari ga matte iru',
    ].join('\n'), overrides?.durationMs ?? 8000),
    rights: {
      songLicense: overrides?.songLicense ?? 'original_owned',
      accompanimentLicense: overrides?.accompanimentLicense ?? 'original_owned',
      lyricsLicense: overrides?.lyricsLicense ?? 'original_owned',
      voiceModelAuthorized: overrides?.voiceModelAuthorized ?? true,
      voiceConsentSource: 'whale-isle-original-consent',
      attribution: overrides?.attribution ?? 'Whale Isle Original',
    },
  };
}

describe('[SIMULATION] V2-P3-01 SingEngine、歌词时钟与 PerformanceDirector', () => {
  it('严格执行曲目/伴奏/歌词/声线四重授权门禁，拦截非商用与未授权曲目进入公开直播或商业分发', () => {
    const devSongRights = makeSong({
      songLicense: 'dev_only_non_commercial',
      accompanimentLicense: 'licensed_livestream',
      lyricsLicense: 'unlicensed',
      voiceModelAuthorized: false,
      attribution: 'CC BY-NC-SA Demo',
    }).rights;

    const commercialDeny = evaluateSongRights(devSongRights, 'commercial_distribution');
    expect(commercialDeny.allowed).toBe(false);
    expect(commercialDeny.requiresAttribution).toBe(true);
    expect(commercialDeny.reasons.length).toBe(4);

    const desktopOk = evaluateSongRights(makeSong({ songLicense: 'dev_only_non_commercial' }).rights, 'private_desktop');
    expect(desktopOk.allowed).toBe(true);

    const liveDeny = evaluateSongRights(makeSong({ songLicense: 'dev_only_non_commercial' }).rights, 'livestream_public');
    expect(liveDeny.allowed).toBe(false);

    const liveOk = evaluateSongRights(makeSong({
      songLicense: 'licensed_livestream',
      accompanimentLicense: 'licensed_commercial',
      lyricsLicense: 'original_owned',
      attribution: '',
    }).rights, 'livestream_public');
    expect(liveOk.allowed).toBe(true);
    expect(liveOk.requiresAttribution).toBe(false);
  });

  it('精确解析双语 LRC 并按真实音频播放时钟推进 LyricsClockSync', () => {
    const lrcNoDuration = parseBilingualLrc('[00:01] 主歌词 ||  \n[00:02.0] 下一句');
    expect(lrcNoDuration[1]?.endMs).toBe(6000);
    const lrc = [
      'not-a-timestamp',
      '[00:00.50]   ',
      '[00:01.00] 第一句原词 || First line',
      '[00:03.000] 第二句原词',
      '[00:03.000] Second line',
      '[00:03.000] dainiku',
    ].join('\n');
    const lines = parseBilingualLrc(lrc);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ primaryText: '第一句原词', secondaryText: 'First line', startMs: 1000, endMs: 3000 });
    expect(lines[1]).toMatchObject({ primaryText: '第二句原词', secondaryText: 'Second line', romaji: 'dainiku', startMs: 3000, endMs: 7000 });

    const clock = new LyricsClockSync();
    clock.load('song-1', lines, 10_000);
    expect(clock.seek(500).activeIndex).toBe(-1);
    expect(clock.seek(9000).activeIndex).toBe(-1);
    expect(clock.seek(2000)).toMatchObject({ activeIndex: 0, lineProgress: 0.5 });
    expect(clock.advance(1500)).toMatchObject({ activeIndex: 1, nextLine: null });

    clock.setPolicy({ enabled: false, showBilingual: false });
    expect(clock.snapshot().activeIndex).toBe(-1);
    clock.setPolicy({ enabled: true });
    expect(clock.reset().songId).toBeNull();
  });

  it('SingEngine 严格区分 SVS/SVC 与普通 TTS：在线探测/失败兜底/SVC 干声校验与确定性导唱提取', async () => {
    const offlineEngine = new SingEngine();
    const offlineStatuses = await offlineEngine.probeBackends();
    expect(offlineStatuses.every((s) => !s.available && s.backend === 'unavailable')).toBe(true);

    // 显式关闭预览导唱时，绝不拿普通 TTS 冒充唱歌
    const strictReject = await offlineEngine.synthesize({
      requestId: 'sing-no-guide',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svs',
      channel: 'private_desktop',
      song: makeSong(),
      allowPreviewGuide: false,
    });
    expect(strictReject.ok).toBe(false);
    expect(strictReject.backendMode).toBe('unavailable');

    // SVC 缺 referenceVocalPath 且关掉预览时明确报错
    const svcMissingRef = await offlineEngine.synthesize({
      requestId: 'sing-svc-no-ref',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svc',
      channel: 'private_desktop',
      song: makeSong(),
      allowPreviewGuide: false,
    });
    expect(svcMissingRef.ok).toBe(false);
    expect(svcMissingRef.error).toContain('referenceVocalPath');

    // V2-P3-01：Worker 能力明细回传（未就绪时把后端原因如实带回，不笼统写「未启用」）
    const detailFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      svs: false,
      svc: false,
      backends: [
        { name: 'svs', kind: 'singing_voice_synthesis', ready: false, detail: '未配置 svs 后端（WHALE_SING_SVS_ENDPOINT 为空）' },
        { name: 'svc', kind: 'singing_voice_conversion', ready: false, detail: '未配置 svc 后端（WHALE_SING_SVC_ENDPOINT 为空）' },
      ],
      ttsClone: { ready: true, detail: 'tts 后端在线' },
    }), { status: 200 }));
    const detailEngine = new SingEngine({ workerEndpoint: 'http://127.0.0.1:19880', fetchImpl: detailFetch });
    const detailStatuses = await detailEngine.probeBackends();
    expect(detailStatuses[0]?.available).toBe(false);
    expect(detailStatuses[0]?.detail).toContain('WHALE_SING_SVS_ENDPOINT');
    expect(detailStatuses[0]?.detail).toContain('普通 TTS 不得当作 SVS/SVC 使用');
    expect(detailStatuses[1]?.detail).toContain('WHALE_SING_SVC_ENDPOINT');

    // V2-P3-01：只有 Worker 明确回执真实神经推理才置 realNeuralInferenceVerified
    const wavBytes = buildGuideToneWav(600, 120);
    const wavB64 = Buffer.from(wavBytes).toString('base64');
    const mockFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ svs: true, svc: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ audioBase64: wavB64, durationMs: 600, sampleRate: 24000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('network down'));

    const workerEngine = new SingEngine({ workerEndpoint: 'http://127.0.0.1:19800/', fetchImpl: mockFetch });
    const statuses = await workerEngine.probeBackends();
    expect(statuses[0]).toMatchObject({ mode: 'svs', available: true, backend: 'worker_svs' });
    expect(statuses[1]).toMatchObject({ mode: 'svc', available: false, backend: 'unavailable' });

    const svsOk = await workerEngine.synthesize({
      requestId: 'sing-worker-ok',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svs',
      channel: 'livestream_public',
      song: makeSong(),
    });
    expect(svsOk.ok).toBe(true);
    expect(svsOk.backendMode).toBe('worker_svs');
    expect(svsOk.lipFrames.length).toBeGreaterThan(0);
    // Worker 未回执 neuralVerified → 不得自我宣称真实神经推理
    expect(svsOk.realNeuralInferenceVerified).toBe(false);

    // probe HTTP 非 200（消费掉第 3 个 mock 500）与异常
    const probeFail500 = await workerEngine.probeBackends();
    expect(probeFail500[0]?.detail).toContain('HTTP 500');
    expect((await workerEngine.probeBackends())[0]?.available).toBe(false);
    expect((await workerEngine.probeBackends())[0]?.detail).toContain('network down');

    // 测试 worker SVC 返还自带 lipFrames 且无 audioBase64
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      lipFrames: [{ timestampMs: 0, durationMs: 60, viseme: 'open', amplitude: 0.9, rmsDb: -2 }],
    }), { status: 200 }));
    const svcWorkerCustomFrames = await workerEngine.synthesize({
      requestId: 'sing-svc-worker-frames',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svc',
      channel: 'private_desktop',
      song: makeSong({ referenceVocalPath: 'ref.wav' }),
      allowPreviewGuide: false,
    });
    expect(svcWorkerCustomFrames.ok).toBe(true);
    expect(svcWorkerCustomFrames.backendMode).toBe('worker_svc');

    // Worker 失败且 allowPreviewGuide=true 时降级为明确标记的 preview_guide_tone
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 502 }));
    const svcFallback = await workerEngine.synthesize({
      requestId: 'sing-svc-fallback',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svc',
      channel: 'private_desktop',
      song: makeSong({ referenceVocalPath: 'ref.wav' }),
      allowPreviewGuide: true,
    });
    expect(svcFallback.ok).toBe(true);
    expect(svcFallback.backendMode).toBe('preview_guide_tone');
    expect(svcFallback.realNeuralInferenceVerified).toBe(false);
  });

  it('PerformanceDirector 统筹唱跳+双语歌词+多轨混音、6层仲裁、自然沉默与急停清零', async () => {
    let clockMs = 10_000;
    const bus = new RuntimeEventBus();
    const mixer = new AudioMixer({ events: bus, now: () => clockMs });
    const director = new PerformanceDirector({
      characterId: 'char_xiaojing',
      audioMixer: mixer,
      events: bus,
      now: () => clockMs,
    });

    // 1. 静默策略：安静陪伴 / 低社交能量 / 冷却期内保持沉默；P0 与主人直接提问立即回应
    director.setQuietCompanionMode(true);
    const quietSkip = director.planSpeech({
      planId: 'sp-1',
      characterId: 'char_xiaojing',
      text: '今天天气不错呀',
      priority: 'P1_CADENCE',
    });
    expect(quietSkip.speaking).toBe(false);
    expect(quietSkip.silence.reason).toContain('安静陪伴');

    const directHit = director.planSpeech(
      {
        planId: 'sp-2',
        characterId: 'char_xiaojing',
        text: '主人找我什么事？',
        emotion: 'happy',
        expressionId: 'smile',
        gestureIds: ['wave'],
        pace: 'fast',
        priority: 'P1_CADENCE',
      },
      { isUserDirectAddress: true },
    );
    expect(directHit.speaking).toBe(true);
    expect(directHit.lipFrames.length).toBeGreaterThan(0);

    director.setQuietCompanionMode(false);
    expect(director.decideSpeechSilence().shouldSpeak).toBe(true);
    expect(director.decideSpeechSilence({ priority: 'P2_IDLE', socialEnergy: 0.1 }).shouldSpeak).toBe(false);
    expect(director.decideSpeechSilence({ priority: 'P2_IDLE', msSinceLastSpeech: 500, minCooldownMs: 4000 }).cooldownRemainingMs).toBe(3500);
    expect(director.decideSpeechSilence({ priority: 'P0_INTERRUPT' }).shouldSpeak).toBe(true);
    expect(createPerformanceDirectorPreview()).toMatch(/^director:/);

    // 授权拦截传播到 startSinging
    const deniedSing = await director.startSinging({
      requestId: 'perf-denied',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svs',
      channel: 'commercial_distribution',
      song: makeSong({ songLicense: 'dev_only_non_commercial' }),
    });
    expect(deniedSing.ok).toBe(false);
    expect(deniedSing.result.rightsCheck.allowed).toBe(false);

    // 无舞蹈纯唱歌 + stopPerformance 非急停停演路径
    const soloSing = await director.startSinging({
      requestId: 'perf-sing-solo',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svs',
      channel: 'private_desktop',
      song: makeSong({ durationMs: 3000, accompanimentTrackPath: '' }),
    });
    expect(soloSing.ok).toBe(true);
    expect(soloSing.snapshot.mode).toBe('singing');
    expect(director.stopPerformance('manual_stop').mode).toBe('idle');

    // 2. 启动唱跳演出：检验 AudioMixer 并发 singing + bgm + sfx 互不阻塞
    const singOutcome = await director.startSinging(
      {
        requestId: 'perf-sing-1',
        characterId: 'char_xiaojing',
        voiceProfileId: 'qiaopi_mengmei',
        mode: 'svs',
        channel: 'livestream_public',
        song: makeSong({ durationMs: 6000 }),
        outputDeviceId: 'desktop-speakers',
        obsOutputDeviceId: 'obs-virtual-cable',
      },
      {
        routineId: 'routine-tide',
        title: '浪花舞',
        bpm: 120,
        durationMs: 6000,
        cues: [
          { cueId: 'cue-1', atMs: 0, durationMs: 2500, poseId: 'wave_arms', vrmMotionTag: 'dance_wave', expressionId: 'happy', energy: 0.8 },
          { cueId: 'cue-2', atMs: 2500, durationMs: 3500, poseId: 'spin_jump', live2dMotionGroup: 'DanceSpin', expressionId: 'singing', energy: 0.95 },
        ],
      },
    );
    expect(singOutcome.ok).toBe(true);
    expect(singOutcome.snapshot.mode).toBe('singing_and_dancing');
    expect(singOutcome.snapshot.mixer.tracks.map((t) => t.kind).sort()).toEqual(['bgm', 'singing']);

    // 同时播放 SFX 不被说话锁阻断
    const sfx = mixer.startTrack({ trackId: 'sfx-sparkle', kind: 'sfx', label: '气泡音' });
    expect(sfx.playing).toBe(true);

    // 6 层冲突仲裁：演出舞蹈占用时，idle_ambient 不可覆盖
    expect(director.requestLayer('idle_ambient', 'blink')).toEqual({ granted: false, blockedBy: 'performance_choreo' });
    // vocal_lipsync 与 performance_choreo 可叠加共存
    expect(director.requestLayer('vocal_lipsync', 'chorus')).toEqual({ granted: true });

    // 时钟推进至 3000ms 与超越结尾 99999ms：同时切换双语第 2 行与 cue-2，并在超界时闭嘴且无 cue
    const ticked = director.tickClock(3000);
    expect(ticked.lyrics.activeIndex).toBe(1);
    expect(ticked.lyrics.activeLine?.secondaryText).toBe('Who are the lights of Whale Isle waiting for');
    expect(ticked.activeDanceCue?.cueId).toBe('cue-2');
    expect(ticked.lipSync.timestampMs).toBeGreaterThanOrEqual(2900);

    const pastEnd = director.tickClock(99_999);
    expect(pastEnd.activeDanceCue).toBeNull();
    expect(pastEnd.lipSync.viseme).toBe('closed');

    // 3. 急停：立即停止混音轨道与演出，拦截后续请求（含 safety_system 占用），恢复后正常待命
    const halted = director.emergencyHalt('测试急停');
    expect(halted.halted).toBe(true);
    expect(halted.mode).toBe('halted');
    expect(halted.mixer.tracks).toHaveLength(0);
    expect(halted.lipSync.viseme).toBe('closed');
    expect(director.requestLayer('vocal_lipsync', 'blocked')).toEqual({ granted: false, blockedBy: 'safety_system' });
    expect(director.decideSpeechSilence({ priority: 'P0_INTERRUPT' }).shouldSpeak).toBe(false);
    expect(director.startDance({
      routineId: 'r2',
      title: 'blocked',
      durationMs: 1000,
      cues: [{ cueId: 'c1', atMs: 0, durationMs: 1000, poseId: 'p1' }],
    }).ok).toBe(false);

    const singDuringHalt = await director.startSinging({
      requestId: 'blocked-sing',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svs',
      song: makeSong(),
    });
    expect(singDuringHalt.ok).toBe(false);

    const resumed = director.resumeFromHalt();
    expect(resumed.halted).toBe(false);
    expect(resumed.mode).toBe('idle');

    // 独立舞蹈冲突检查
    director.requestLayer('interactive_game', 'combat');
    const blockedDance = director.startDance({
      routineId: 'r-solo',
      title: 'solo',
      durationMs: 2000,
      cues: [{ cueId: 'c1', atMs: 0, durationMs: 2000, poseId: 'p1' }],
    });
    expect(blockedDance.ok).toBe(false);
    director.releaseLayer('interactive_game');
    const okDance = director.startDance({
      routineId: 'r-solo',
      title: 'solo',
      durationMs: 2000,
      cues: [{ cueId: 'c1', atMs: 0, durationMs: 2000, poseId: 'p1' }],
    });
    expect(okDance.ok).toBe(true);
    expect(okDance.snapshot.mode).toBe('dancing');
  });

  it('V2-P3-01：Worker 回执 neuralVerified=true 时才置真（真实神经推理）', async () => {
    const wavBytes = buildGuideToneWav(600, 120);
    const wavB64 = Buffer.from(wavBytes).toString('base64');
    const verifiedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      audioBase64: wavB64, durationMs: 600, sampleRate: 32000, neuralVerified: true,
    }), { status: 200 }));
    const engine = new SingEngine({ workerEndpoint: 'http://127.0.0.1:19880', fetchImpl: verifiedFetch });
    const result = await engine.synthesize({
      requestId: 'sing-neural-verified',
      characterId: 'char_xiaojing',
      voiceProfileId: 'qiaopi_mengmei',
      mode: 'svs',
      channel: 'livestream_public',
      song: makeSong(),
    });
    expect(result.ok).toBe(true);
    expect(result.realNeuralInferenceVerified).toBe(true);
  });
});