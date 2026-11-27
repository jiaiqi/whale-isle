/**
 * 歌声链路纯逻辑单测（`V2-P3-07A`）：素材校验与演唱就绪判定。
 *
 * 重点不是「函数能跑」，而是**许可红线不能被绕过**：
 * 商用渠道 + 非商用权重/未授权声源/儿童无监护人授权，必须进 blockers。
 */
import { describe, expect, it } from 'vitest';
import {
  SINGING_EMOTION_MATERIAL_SPEC,
  SingingProfileSchema,
  type PerformanceChannel,
  type SingingEngineProbe,
  type SingingMaterialFile,
  type SingingProfile,
  type SingingProfileInput,
  type VoiceIdentityInput,
} from '@workbench/shared-protocol';
import {
  checkSingingMaterial,
  isCommercialChannel,
  resolveSingingReadiness,
  summarizeSingingMaterials,
} from './singing-profile';

const SHA = 'b'.repeat(64);

function identity(overrides: Partial<VoiceIdentityInput> = {}): VoiceIdentityInput {
  return {
    identityId: 'xiaojing-07',
    displayName: '小鲸 07',
    source: 'owner_authorized_recording',
    consentScopes: ['training', 'synthesis', 'commercial_livestream'],
    consentEvidenceRef: 'CONSENT-2026-001',
    weightLicense: 'commercial_ok',
    svcModelPath: 'models/rvc/xiaojing.pth',
    ...overrides,
  };
}

function profile(overrides: Partial<SingingProfileInput> = {}): SingingProfile {
  // 走一次真实契约解析（与线上同一条路径），默认值不手写
  return SingingProfileSchema.parse({
    profileId: 'xiaojing-singing',
    characterId: 'xiaojing',
    voice: identity(),
    style: {},
    range: { lowestNote: 'C4', highestNote: 'F5', comfortableLow: 'E4', comfortableHigh: 'D5' },
    ...overrides,
  });
}

function material(overrides: Partial<SingingMaterialFile> = {}): SingingMaterialFile {
  return {
    materialId: 'emo-sweet',
    kind: 'emotion_reference',
    emotion: 'sweet_normal',
    filePath: 'materials/sweet-01.wav',
    sha256: SHA,
    sampleRate: SINGING_EMOTION_MATERIAL_SPEC.sampleRate,
    bitDepth: SINGING_EMOTION_MATERIAL_SPEC.bitDepth,
    channels: SINGING_EMOTION_MATERIAL_SPEC.channels,
    durationMs: SINGING_EMOTION_MATERIAL_SPEC.durationMs,
    peakDbfs: SINGING_EMOTION_MATERIAL_SPEC.peakDbfs,
    headSilenceMs: SINGING_EMOTION_MATERIAL_SPEC.edgeSilenceMs,
    tailSilenceMs: SINGING_EMOTION_MATERIAL_SPEC.edgeSilenceMs,
    source: 'owner_authorized_recording',
    consentEvidenceRef: 'CONSENT-2026-001',
    ...overrides,
  };
}

function allEmotionMaterials(): SingingMaterialFile[] {
  return [
    material({ materialId: 'm1', emotion: 'sweet_normal' }),
    material({ materialId: 'm2', emotion: 'tsundere_refuse' }),
    material({ materialId: 'm3', emotion: 'rage_spray' }),
    material({ materialId: 'm4', emotion: 'lazy_yawn' }),
    material({ materialId: 'm5', emotion: 'clumsy_panic' }),
  ];
}

function engine(overrides: Partial<SingingEngineProbe> = {}): SingingEngineProbe {
  return {
    engine: 'rvc',
    installed: true,
    weightLicense: 'commercial_ok',
    detail: 'RVC MIT 分支 + 自训底模',
    hint: '',
    ...overrides,
  };
}

describe('isCommercialChannel', () => {
  it('公开直播与商用分发算商用，桌面私用不算', () => {
    expect(isCommercialChannel('private_desktop')).toBe(false);
    expect(isCommercialChannel('livestream_public')).toBe(true);
    expect(isCommercialChannel('commercial_distribution')).toBe(true);
  });
});

describe('checkSingingMaterial', () => {
  it('完全符合规格且有授权 → pass', () => {
    const result = checkSingingMaterial(material());
    expect(result.verdict).toBe('pass');
    expect(result.issues).toEqual([]);
  });

  it('采样率/位深/声道/时长/静音不合规 → 全为 warning，不阻断', () => {
    const result = checkSingingMaterial(material({
      sampleRate: 44_100, bitDepth: 24, channels: 2, durationMs: 7_000,
      headSilenceMs: 0, tailSilenceMs: 0,
    }));
    expect(result.verdict).toBe('warn');
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'sample_rate_mismatch', 'bit_depth_mismatch', 'channels_mismatch',
      'duration_out_of_range', 'silence_padding_missing',
    ]));
    expect(result.issues.every((item) => item.severity === 'warning')).toBe(true);
  });

  it('削波 → blocker（不可逆，必须重录）', () => {
    const result = checkSingingMaterial(material({ peakDbfs: -0.05 }));
    expect(result.verdict).toBe('fail');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'clipping', severity: 'blocker' }));
  });

  it('缺授权声明编号 → blocker', () => {
    const result = checkSingingMaterial(material({ consentEvidenceRef: '  ' }));
    expect(result.verdict).toBe('fail');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'consent_missing' }));
  });

  it('情绪参考音没写情绪组 → blocker', () => {
    const result = checkSingingMaterial(material({ emotion: undefined }));
    expect(result.verdict).toBe('fail');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'emotion_missing' }));
  });

  it('训练干声切片过短/过长 → warning，不按情绪规格要求', () => {
    const short = checkSingingMaterial(material({
      kind: 'svc_training_dry_vocal', emotion: undefined, durationMs: 1_000,
    }));
    expect(short.verdict).toBe('warn');
    expect(short.issues.map((item) => item.code)).toContain('slice_duration_out_of_range');
    expect(short.issues.map((item) => item.code)).not.toContain('sample_rate_mismatch');
  });
});

describe('summarizeSingingMaterials', () => {
  it('五组齐全 + 训练干声 ≥10 分钟 + 全部合规 → pass', () => {
    // 训练干声按 10s/切片（规格上限），90 条 = 15 分钟
    const training = Array.from({ length: 90 }, (_, index) => material({
      materialId: `train-${index}`,
      kind: 'svc_training_dry_vocal' as const,
      emotion: undefined,
      durationMs: 10_000,
      filePath: `materials/train-${index}.wav`,
    }));
    const summary = summarizeSingingMaterials([...allEmotionMaterials(), ...training]);
    expect(summary.verdict).toBe('pass');
    expect(summary.missingEmotionKeys).toEqual([]);
    expect(summary.trainingTotalMs).toBe(15 * 60 * 1000);
    expect(summary.trainingSliceCount).toBe(90);
  });

  it('缺组与重复组都能报出来', () => {
    const summary = summarizeSingingMaterials([
      material({ materialId: 'm1', emotion: 'sweet_normal' }),
      material({ materialId: 'm1b', emotion: 'sweet_normal' }),
      material({ materialId: 'm2', emotion: 'rage_spray' }),
    ]);
    expect(summary.missingEmotionKeys).toEqual(['tsundere_refuse', 'lazy_yawn', 'clumsy_panic']);
    expect(summary.duplicateEmotionKeys).toEqual(['sweet_normal']);
    expect(summary.emotionReferenceCount).toBe(3);
    expect(summary.issues).toContainEqual(expect.objectContaining({ code: 'emotion_duplicate' }));
  });

  it('训练干声总时长不足 → warning（最低 10 分钟）', () => {
    const summary = summarizeSingingMaterials([
      material({ kind: 'svc_training_dry_vocal', emotion: undefined, durationMs: 60_000 }),
    ]);
    expect(summary.issues).toContainEqual(expect.objectContaining({ code: 'total_duration_short' }));
  });

  it('任一文件有 blocker → 整份 fail', () => {
    const summary = summarizeSingingMaterials([material({ peakDbfs: 0 })]);
    expect(summary.verdict).toBe('fail');
  });
});

describe('resolveSingingReadiness', () => {
  const channel: PerformanceChannel = 'private_desktop';

  it('桌面私用：授权齐、引擎在、.pth 配好、五组情绪齐 → ready 且 commercialReady', () => {
    const readiness = resolveSingingReadiness({
      profile: profile(),
      materials: allEmotionMaterials(),
      engines: [engine()],
      channel,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.commercialReady).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.missingEmotionKeys).toEqual([]);
  });

  it('缺情绪参考音只警告，不影响 ready', () => {
    const readiness = resolveSingingReadiness({
      profile: profile(),
      materials: [],
      engines: [engine()],
      channel,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.missingEmotionKeys).toHaveLength(5);
    expect(readiness.warnings.join(' ')).toContain('情绪参考音缺 5 组');
  });

  it('引擎未安装 → blocker 带补救建议', () => {
    const readiness = resolveSingingReadiness({
      profile: profile(),
      materials: allEmotionMaterials(),
      engines: [engine({ installed: false, hint: '按需下载 RVC 权重' })],
      channel,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('引擎未安装：rvc');
    expect(readiness.blockers.join(' ')).toContain('按需下载 RVC 权重');
  });

  it('SVC 路线没配 .pth → blocker（来源必须可追溯）', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ svcModelPath: '' }) }),
      materials: allEmotionMaterials(),
      engines: [engine()],
      channel,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('SVC 声线模型（.pth）未配置');
  });

  it('公开直播缺商用授权 → blocker，且 commercialReady=false', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ consentScopes: ['training', 'synthesis'] }) }),
      materials: allEmotionMaterials(),
      engines: [engine()],
      channel: 'livestream_public',
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('commercial_livestream');
    expect(readiness.commercialReady).toBe(false);
  });

  it('权重非商用 + 商用渠道 → 明确写出「商用必须自训底模/声库」', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ weightLicense: 'dev_only_non_commercial' }) }),
      materials: allEmotionMaterials(),
      engines: [engine({ weightLicense: 'dev_only_non_commercial' })],
      channel: 'commercial_distribution',
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('商用必须自训底模/声库');
    expect(readiness.blockers.join(' ')).toContain('引擎 rvc 的权重许可为 dev_only_non_commercial');
  });

  it('桌面私用但权重许可只是 dev_only → 可以 ready，但永远不 commercialReady，且带警告', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ weightLicense: 'dev_only_non_commercial' }) }),
      materials: allEmotionMaterials(),
      engines: [engine({ weightLicense: 'dev_only_non_commercial' })],
      channel,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.commercialReady).toBe(false);
    expect(readiness.warnings.join(' ')).toContain('仅限开发非商用');
  });

  it('unlicensed 权重任何渠道都阻断', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ weightLicense: 'unlicensed' }) }),
      materials: allEmotionMaterials(),
      engines: [engine()],
      channel,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('unlicensed');
  });

  it('儿童声线无监护人授权 → blocker，即使其它都齐', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ minorVoice: true, guardianConsent: false }) }),
      materials: allEmotionMaterials(),
      engines: [engine()],
      channel,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('监护人授权');
  });

  it('商用渠道不接受随包参考音频作声源', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ source: 'builtin_reference' }) }),
      materials: allEmotionMaterials(),
      engines: [engine()],
      channel: 'livestream_public',
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('随包参考音频');
  });

  it('SVS 路线：DiffSinger 必需，OpenUtau 缺失只警告', () => {
    const withDiffsinger = resolveSingingReadiness({
      profile: profile({
        route: 'svs',
        voice: identity({ svcModelPath: '', svsVoicebankPath: 'models/diffsinger/xiaojing' }),
      }),
      materials: allEmotionMaterials(),
      engines: [engine({ engine: 'diffsinger', weightLicense: 'commercial_ok' })],
      channel,
    });
    expect(withDiffsinger.ready).toBe(true);
    expect(withDiffsinger.warnings.join(' ')).toContain('OpenUtau 未安装');

    const missingBoth = resolveSingingReadiness({
      profile: profile({ route: 'svs', voice: identity({ svcModelPath: '', svsVoicebankPath: 'x' }) }),
      materials: allEmotionMaterials(),
      engines: [],
      channel,
    });
    expect(missingBoth.ready).toBe(false);
    expect(missingBoth.blockers.join(' ')).toContain('diffsinger');
  });

  it('素材削波会直接把 ready 打掉', () => {
    const readiness = resolveSingingReadiness({
      profile: profile(),
      materials: [...allEmotionMaterials(), material({ materialId: 'bad', emotion: 'happy_rice', peakDbfs: 0 })],
      engines: [engine()],
      channel,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain('削波');
  });

  it('blockers 去重（同一问题不重复列）', () => {
    const readiness = resolveSingingReadiness({
      profile: profile({ voice: identity({ weightLicense: 'unlicensed' }) }),
      materials: [material({ peakDbfs: 0 }), material({ materialId: 'm2', peakDbfs: 0 })],
      engines: [engine()],
      channel,
    });
    const unique = new Set(readiness.blockers);
    expect(unique.size).toBe(readiness.blockers.length);
  });
});
