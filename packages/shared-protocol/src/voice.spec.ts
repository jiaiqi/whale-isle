import { describe, expect, it } from 'vitest';
import {
  AudioMixerSnapshotSchema,
  LipSyncFrameSchema,
  VoiceAudioQualitySchema,
  VoiceCloneConsentSchema,
  VoiceProviderStatusSchema,
  VoiceSynthesisOutputSchema,
  VoiceSynthesisRequestSchema,
  VoiceWorkshopCloneCreateInputSchema,
  VoiceWorkshopDeleteInputSchema,
  VoiceWorkshopRenameInputSchema,
} from './voice';

describe('VoiceProvider, LipSync & AudioMixer schemas (V2-P1-02)', () => {
  it('parses valid voice synthesis requests, outputs, lip frames, and mixer snapshots', () => {
    const req = VoiceSynthesisRequestSchema.parse({
      requestId: 'req-1',
      characterId: 'char_xiaojing',
      voiceRef: 'qiaopi_mengmei',
      text: '主人，早上好呀！',
    });
    expect(req.emotion).toBe('neutral');
    expect(req.speed).toBe(1.0);
    expect(req.timeoutMs).toBe(15_000);

    const frame = LipSyncFrameSchema.parse({
      timestampMs: 50,
      durationMs: 50,
      viseme: 'open',
      amplitude: 0.72,
      rmsDb: -12,
    });
    expect(frame.viseme).toBe('open');

    const output = VoiceSynthesisOutputSchema.parse({
      requestId: 'req-1',
      providerKind: 'minimax-tts',
      quality: 'character_tts',
      format: 'mp3',
      durationMs: 1200,
      audioBase64: 'AAAA',
      lipFrames: [frame],
    });
    expect(output.degraded).toBe(false);
    expect(output.sampleRate).toBe(24_000);

    const status = VoiceProviderStatusSchema.parse({
      kind: 'macos-say',
      quality: 'system_fallback',
      available: true,
      degraded: true,
      platform: 'darwin',
      detail: 'macOS 系统语音兜底',
    });
    expect(status.supportsStreaming).toBe(false);

    const mixer = AudioMixerSnapshotSchema.parse({
      speechFloorHolder: null,
      speechQueueLength: 0,
      duckingActive: false,
      duckingGainMultiplier: 0.25,
      tracks: [
        {
          trackId: 'bgm-1',
          kind: 'bgm',
          label: '农场日常曲',
          playing: true,
        },
      ],
      outputRoutes: {
        speech: 'default',
        bgm: 'obs-virtual',
        sfx: 'default',
        singing: 'default',
      },
    });
    expect(mixer.tracks[0]?.effectiveGain).toBe(1);
    expect(mixer.outputRoutes.bgm).toBe('obs-virtual');
  });

  it('rejects invalid ranges and empty fields', () => {
    expect(VoiceSynthesisRequestSchema.safeParse({
      requestId: 'req-bad',
      characterId: 'char_xiaojing',
      voiceRef: 'v1',
      text: '',
    }).success).toBe(false);

    expect(VoiceSynthesisRequestSchema.safeParse({
      requestId: 'req-bad-speed',
      characterId: 'char_xiaojing',
      voiceRef: 'v1',
      text: 'hi',
      speed: 3.5,
    }).success).toBe(false);

    expect(LipSyncFrameSchema.safeParse({
      timestampMs: 0,
      durationMs: 50,
      viseme: 'open',
      amplitude: 1.5,
      rmsDb: -10,
    }).success).toBe(false);

    expect(AudioMixerSnapshotSchema.safeParse({
      speechFloorHolder: null,
      speechQueueLength: -1,
      duckingActive: false,
      duckingGainMultiplier: 2,
      tracks: [],
      outputRoutes: {},
    }).success).toBe(false);
  });

  it('enforces voice cloning consent attestation, xor audio source, and audio quality contracts', () => {
    // 未勾选声音权属声明在契约层直接拒绝
    expect(VoiceCloneConsentSchema.safeParse({
      kind: 'self_recorded',
      source: '本人亲录',
      attested: false,
      attestedAt: '2026-11-27T10:00:00.000Z',
    }).success).toBe(false);

    const validConsent = VoiceCloneConsentSchema.parse({
      kind: 'authorized_third_party',
      source: '原创配音演员书面授权（桌面+直播）',
      attested: true,
      attestedAt: '2026-11-27T10:00:00.000Z',
    });
    expect(validConsent.attested).toBe(true);

    // wavBase64 与 filePath 必须且只能提供其一
    expect(VoiceWorkshopCloneCreateInputSchema.safeParse({
      label: '测试克隆',
      consent: validConsent,
    }).success).toBe(false);

    expect(VoiceWorkshopCloneCreateInputSchema.safeParse({
      wavBase64: 'UklGRg==',
      filePath: '/tmp/a.wav',
      label: '测试克隆',
      consent: validConsent,
    }).success).toBe(false);

    const parsedClone = VoiceWorkshopCloneCreateInputSchema.parse({
      wavBase64: 'UklGRg==',
      label: '小鲸亲录 v1',
      consent: validConsent,
    });
    expect(parsedClone.activate).toBe(true);

    expect(VoiceWorkshopRenameInputSchema.safeParse({ versionId: 'v1', label: '   ' }).success).toBe(false);
    expect(VoiceWorkshopDeleteInputSchema.parse({ versionId: 'v1' }).versionId).toBe('v1');

    const qa = VoiceAudioQualitySchema.parse({
      durationMs: 7500,
      sampleRate: 24_000,
      channels: 1,
      bitDepth: 16,
      rmsDb: -16.4,
      peakDb: -3.0,
      clipping: false,
      estimatedSnrDb: 28.5,
      grade: 'good',
      hints: ['处于推荐区间'],
    });
    expect(qa.grade).toBe('good');
  });
});
