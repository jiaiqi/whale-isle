/**
 * 歌声链路契约门禁（`V2-P3-07A`）：VoiceIdentity / SingingProfile / 素材与就绪结构。
 *
 * 只测契约层语义：默认值、枚举、必填约束、跨字段不变量由 voice-runtime 的纯函数负责。
 */
import { describe, expect, it } from 'vitest';
import {
  SINGING_EMOTION_MATERIAL_SPEC,
  SINGING_REQUIRED_EMOTION_KEYS,
  SingingEngineProbeSchema,
  SingingMaterialFileSchema,
  SingingProfileSchema,
  VoiceIdentitySchema,
} from '@workbench/shared-protocol';

const SHA = 'a'.repeat(64);

function identity(overrides: Record<string, unknown> = {}) {
  return {
    identityId: 'xiaojing-07',
    displayName: '小鲸 07 甜脆元气',
    source: 'owner_authorized_recording',
    consentScopes: ['training', 'synthesis'],
    consentEvidenceRef: 'CONSENT-2026-001',
    weightLicense: 'commercial_ok',
    svcModelPath: 'models/rvc/xiaojing.pth',
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    profileId: 'xiaojing-singing',
    characterId: 'xiaojing',
    voice: identity(),
    style: {},
    range: { lowestNote: 'C4', highestNote: 'F5', comfortableLow: 'E4', comfortableHigh: 'D5' },
    ...overrides,
  };
}

describe('VoiceIdentity 契约', () => {
  it('默认值：非儿童、无监护人授权、权重许可 unknown、路径为空', () => {
    const parsed = VoiceIdentitySchema.parse({
      identityId: 'x',
      displayName: 'x',
      source: 'dev_baseline',
    });
    expect(parsed).toMatchObject({
      consentScopes: [],
      consentEvidenceRef: '',
      minorVoice: false,
      guardianConsent: false,
      weightLicense: 'unknown',
      svcModelPath: '',
      svcIndexPath: '',
      svsVoicebankPath: '',
    });
  });

  it('拒绝非法 identityId 与未知来源', () => {
    expect(() => VoiceIdentitySchema.parse({ identityId: '有中文', displayName: 'x', source: 'dev_baseline' })).toThrow();
    expect(() => VoiceIdentitySchema.parse({ identityId: 'x', displayName: 'x', source: 'somewhere' })).toThrow();
  });

  it('拒绝未知授权范围（防止拼错字段静默丢授权）', () => {
    expect(() => VoiceIdentitySchema.parse({
      identityId: 'x', displayName: 'x', source: 'dev_baseline', consentScopes: ['commercial'],
    })).toThrow();
  });
});

describe('SingingProfile 契约', () => {
  it('默认路线 svc、默认风格 light/0.3/natural、情绪表为空', () => {
    const parsed = SingingProfileSchema.parse(profile());
    expect(parsed.route).toBe('svc');
    expect(parsed.style).toEqual({ vibrato: 'light', breathiness: 0.3, attack: 'natural', timbreNotes: [] });
    expect(parsed.emotionReferenceIds).toEqual({});
  });

  it('三条路线都接受，未知路线拒绝', () => {
    for (const route of ['svc', 'svs', 'svs_svc']) {
      expect(SingingProfileSchema.parse(profile({ route })).route).toBe(route);
    }
    expect(() => SingingProfileSchema.parse(profile({ route: 'tts' }))).toThrow();
  });

  it('情绪参考 id 只接受合法情绪键', () => {
    const ok = SingingProfileSchema.parse(profile({
      emotionReferenceIds: { sweet_normal: 'm1', clumsy_panic: 'm2' },
    }));
    expect(ok.emotionReferenceIds.sweet_normal).toBe('m1');
    expect(() => SingingProfileSchema.parse(profile({
      emotionReferenceIds: { angry: 'm1' },
    }))).toThrow();
  });

  it('音域必须是科学音高记号', () => {
    expect(() => SingingProfileSchema.parse(profile({
      range: { lowestNote: 'C4', highestNote: 'H5', comfortableLow: 'E4', comfortableHigh: 'D5' },
    }))).toThrow();
  });

  it('气声强度越界拒绝', () => {
    expect(() => SingingProfileSchema.parse(profile({ style: { breathiness: 1.2 } }))).toThrow();
  });
});

describe('SingingMaterial 契约', () => {
  const file = {
    materialId: 'emo-1',
    kind: 'emotion_reference',
    emotion: 'sweet_normal',
    filePath: 'materials/sweet_normal-01.wav',
    sha256: SHA,
    sampleRate: SINGING_EMOTION_MATERIAL_SPEC.sampleRate,
    bitDepth: 16,
    channels: 1,
    durationMs: 5000,
    peakDbfs: -3,
    source: 'owner_authorized_recording',
    consentEvidenceRef: 'CONSENT-2026-001',
  };

  it('规格常量与选型文档一致（24kHz/16bit/mono/5s/−3dBFS）', () => {
    expect(SINGING_EMOTION_MATERIAL_SPEC).toMatchObject({
      sampleRate: 24_000, bitDepth: 16, channels: 1, durationMs: 5_000, peakDbfs: -3,
    });
  });

  it('合法素材通过；头部静音默认 0', () => {
    const parsed = SingingMaterialFileSchema.parse(file);
    expect(parsed.headSilenceMs).toBe(0);
    expect(parsed.tailSilenceMs).toBe(0);
  });

  it('sha256 必须是 64 位小写 hex', () => {
    expect(() => SingingMaterialFileSchema.parse({ ...file, sha256: 'abc' })).toThrow();
    expect(() => SingingMaterialFileSchema.parse({ ...file, sha256: SHA.toUpperCase() })).toThrow();
  });

  it('峰值不得为正（dBFS ≤ 0）', () => {
    expect(() => SingingMaterialFileSchema.parse({ ...file, peakDbfs: 1.5 })).toThrow();
  });

  it('必录五组情绪键写死为工单口径', () => {
    expect([...SINGING_REQUIRED_EMOTION_KEYS]).toEqual([
      'sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'clumsy_panic',
    ]);
  });
});

describe('SingingEngineProbe 契约', () => {
  it('默认权重许可 unknown、hint 为空', () => {
    const probe = SingingEngineProbeSchema.parse({
      engine: 'rvc', installed: true, detail: 'RVC MIT 分支',
    });
    expect(probe).toMatchObject({ weightLicense: 'unknown', hint: '' });
  });

  it('拒绝未知引擎', () => {
    expect(() => SingingEngineProbeSchema.parse({
      engine: 'sovits', installed: true, detail: 'x',
    })).toThrow();
  });
});
