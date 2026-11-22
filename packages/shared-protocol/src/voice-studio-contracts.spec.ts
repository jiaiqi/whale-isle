/**
 * T-M5-17 契约门禁：PauseConfig / TtsEmotionTuningParams / SvcSingingTuningParams / VoiceDesignRequest。
 * 与 pytest test_voice_studio.py 双侧对齐（同一组参数语义）。
 */
import { describe, expect, it } from 'vitest';
import {
  PauseConfigSchema,
  SvcSingingTuningParamsSchema,
  TtsEmotionTuningParamsSchema,
  VoiceDesignRequestSchema,
} from '@workbench/shared-protocol';

describe('PauseConfig 契约', () => {
  it('默认值（340/150/460 三档 dsh-gpt-sovits 停顿）', () => {
    const p = PauseConfigSchema.parse({});
    expect(p).toMatchObject({ periodMs: 340, commaMs: 150, ellipsisMs: 460 });
  });
  it('越界拒绝', () => {
    expect(() => PauseConfigSchema.parse({ periodMs: 10 })).toThrow();
    expect(() => PauseConfigSchema.parse({ commaMs: 99999 })).toThrow();
  });
});

describe('TtsEmotionTuningParams 契约', () => {
  it('五情绪锚点合法 + refText 必填（空值拒绝——防内部 ASR 卡顿）', () => {
    for (const tag of ['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'clumsy_panic']) {
      expect(() =>
        TtsEmotionTuningParamsSchema.parse({ emotionTag: tag, refText: '参考台词' }),
      ).not.toThrow();
    }
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: '' })).toThrow();
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'ghost_tag', refText: 'x' })).toThrow();
  });

  it('参数范围钳制：speed [0.7,1.4] / topK [1,50] / sfxVolume [0,1]', () => {
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: 'x', speed: 1.5 })).toThrow();
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: 'x', speed: 0.5 })).toThrow();
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: 'x', topK: 0 })).toThrow();
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: 'x', sfxVolume: 1.1 })).toThrow();
    const ok = TtsEmotionTuningParamsSchema.parse({ emotionTag: 'rage_spray', refText: '喷水！' });
    expect(ok.speed).toBe(1.0);
    expect(ok.pauseConfig.periodMs).toBe(340);
  });

  it('pytest 对齐：调参往返 100% 一致', () => {
    const params = {
      emotionTag: 'tsundere_refuse' as const,
      refAudioPath: 'ref/tsundere.wav',
      refText: '哼、哼！才不是因为担心主人呢！',
      speed: 1.25,
      temperature: 0.55,
      topP: 0.9,
      topK: 20,
      pauseConfig: { periodMs: 400, commaMs: 200, ellipsisMs: 500 },
      prependSfxPath: 'sfx/pop.wav',
      sfxVolume: 0.3,
    };
    expect(TtsEmotionTuningParamsSchema.parse(params)).toEqual(params);
  });
});

describe('SvcSingingTuningParams 契约', () => {
  it('默认值（indexRate 0.75 / protect 0.33——dsh-voice-studio 实测起点）', () => {
    const s = SvcSingingTuningParamsSchema.parse({});
    expect(s).toMatchObject({ pitchShiftSemitones: 0, indexRate: 0.75, protectVoiceless: 0.33, accompanimentGainDb: -3 });
  });
  it('升降调 [-12,+12] 整数；快捷预设 +2/+12 合法', () => {
    expect(SvcSingingTuningParamsSchema.parse({ pitchShiftSemitones: 2 }).pitchShiftSemitones).toBe(2);
    expect(SvcSingingTuningParamsSchema.parse({ pitchShiftSemitones: 12 }).pitchShiftSemitones).toBe(12);
    expect(() => SvcSingingTuningParamsSchema.parse({ pitchShiftSemitones: 13 })).toThrow();
    expect(() => SvcSingingTuningParamsSchema.parse({ pitchShiftSemitones: 1.5 })).toThrow();
  });
});

describe('VoiceDesignRequest 契约', () => {
  it('三路径合法；权重导入强制 licenseScope', () => {
    expect(VoiceDesignRequestSchema.parse({ mode: 'cloud_voice_design' }).mode).toBe('cloud_voice_design');
    expect(VoiceDesignRequestSchema.parse({ mode: 'local_audio_slice' }).petId).toBe('blue-whale-maid');
    const w = VoiceDesignRequestSchema.parse({ mode: 'local_weight_import', weightPath: 'x.pth' });
    expect(w.licenseScope).toBe('DEV_ONLY_NON_COMMERCIAL');
    expect(VoiceDesignRequestSchema.parse({ mode: 'local_weight_import', licenseScope: 'COMMERCIAL_READY' }).licenseScope).toBe('COMMERCIAL_READY');
    expect(() => VoiceDesignRequestSchema.parse({ mode: 'invalid_mode' })).toThrow();
  });
});
