import { describe, expect, it } from 'vitest';
import {
  AudioMixerSnapshotSchema,
  LipSyncFrameSchema,
  VoiceProviderStatusSchema,
  VoiceSynthesisOutputSchema,
  VoiceSynthesisRequestSchema,
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
});
