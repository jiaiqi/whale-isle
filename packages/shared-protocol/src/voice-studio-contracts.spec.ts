/**
 * T-M5-17 契约门禁：PauseConfig / TtsEmotionTuningParams / SvcSingingTuningParams / VoiceDesignRequest。
 * 与 pytest test_voice_studio.py 双侧对齐（同一组参数语义）。
 */
import { describe, expect, it } from 'vitest';
import {
  PauseConfigSchema,
  SvcSingingTuningParamsSchema,
  TtsEmotionTuningParamsSchema,
  TtsVoicePackMatrixSchema,
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
    for (const tag of ['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']) {
      expect(() =>
        TtsEmotionTuningParamsSchema.parse({ emotionTag: tag, refText: '参考台词' }),
      ).not.toThrow();
    }
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: '' })).toThrow();
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'ghost_tag', refText: 'x' })).toThrow();
  });

  it('clumsy_panic 是桌宠动作状态而非 TTS 情绪锚点（枚举漂移回归门禁）', () => {
    // clumsy_panic 属于 PetActionState（心虚冒汗动作），不得混入 TTS 情绪锚点枚举
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'clumsy_panic', refText: 'x' })).toThrow();
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'happy_rice', refText: '米饭！' })).not.toThrow();
  });

  it('refAssetKind 如实标注参考素材性质（real_voice / stub_sine / missing）', () => {
    const ok = TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: 'x' });
    expect(ok.refAssetKind).toBe('real_voice');
    const stub = TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: 'x', refAssetKind: 'stub_sine' });
    expect(stub.refAssetKind).toBe('stub_sine');
    expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: 'sweet_normal', refText: 'x', refAssetKind: 'fake' })).toThrow();
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
      refAssetKind: 'missing' as const,
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

describe('TtsVoicePackMatrix 契约（voice_matrix.json 落盘产物）', () => {
  const baseProfile = {
    emotionTag: 'sweet_normal',
    refAudioPath: 'voices/design_sweet_normal.wav',
    refText: '哼，本鱼才没有偷懒呢！',
    refAssetKind: 'stub_sine',
  };

  it('合法包通过；情绪锚点集合与 TtsEmotionTuningParams 一致', () => {
    const matrix = TtsVoicePackMatrixSchema.parse({
      schemaVersion: '1.0',
      petId: 'blue-whale-maid',
      voicePackId: 'blue-whale-maid-v2',
      licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
      tts: { voicePackId: 'blue-whale-maid-v2', defaultEmotionTag: 'sweet_normal', profiles: [baseProfile] },
    });
    expect(matrix.tts.profiles[0]?.refAssetKind).toBe('stub_sine');
    // 落盘包里出现 clumsy_panic 必须被拦下（这正是实测到的漂移）
    expect(() =>
      TtsVoicePackMatrixSchema.parse({
        schemaVersion: '1.0',
        petId: 'blue-whale-maid',
        voicePackId: 'blue-whale-maid-v2',
        licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
        tts: {
          voicePackId: 'blue-whale-maid-v2',
          defaultEmotionTag: 'sweet_normal',
          profiles: [{ ...baseProfile, emotionTag: 'clumsy_panic' }],
        },
      }),
    ).toThrow();
  });

  it('licenseScope 越界拒绝；refText 为空拒绝', () => {
    expect(() =>
      TtsVoicePackMatrixSchema.parse({
        schemaVersion: '1.0',
        petId: 'p',
        voicePackId: 'v',
        licenseScope: 'TOTALLY_FREE',
        tts: { voicePackId: 'v', defaultEmotionTag: 'sweet_normal', profiles: [baseProfile] },
      }),
    ).toThrow();
    expect(() =>
      TtsVoicePackMatrixSchema.parse({
        schemaVersion: '1.0',
        petId: 'p',
        voicePackId: 'v',
        licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
        tts: { voicePackId: 'v', defaultEmotionTag: 'sweet_normal', profiles: [{ ...baseProfile, refText: '' }] },
      }),
    ).toThrow();
  });
});

describe('跨语言一致性：Python audio-ai-worker 的情绪锚点集合', () => {
  it('voice_studio.EMOTION_TAGS 与契约枚举严格同集合（防止两侧再次漂移）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const pyPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'services',
      'audio-ai-worker',
      'voice_studio.py',
    );
    const src = readFileSync(pyPath, 'utf8');
    const block = src.match(/EMOTION_TAGS: tuple\[str, \.\.\.\] = \(([\s\S]*?)\)/);
    expect(block, '未在 voice_studio.py 中找到 EMOTION_TAGS 定义').not.toBeNull();
    const pyTags = [...(block?.[1] ?? '').matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]);
    expect(pyTags).toEqual(['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'happy_rice']);
    // 契约侧枚举：五个锚点全部可解析
    for (const tag of pyTags) {
      expect(() => TtsEmotionTuningParamsSchema.parse({ emotionTag: tag, refText: 'x' })).not.toThrow();
    }
  });
});
