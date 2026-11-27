/**
 * 演唱素材扫描器单测（`V2-P3-07A` 宿主侧）。
 *
 * 重点：
 *  - 真正读 WAV 头与 PCM 样本（不是 mock 出来的元数据）；
 *  - 缺授权、坏文件、未分组文件必须如实报问题码；
 *  - readiness 走真实判定器，回执里不能出现"假装已授权/引擎已装"。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSingingMaterialsHost, readWavFacts } from './singing-materials';

let workDir: string;
let materialsDir: string;
let userDataDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'singing-materials-'));
  userDataDir = join(workDir, 'userData');
  materialsDir = join(userDataDir, 'singing', 'materials');
  mkdirSync(materialsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface WavOptions {
  sampleRate?: number;
  channels?: number;
  bits?: 16 | 24;
  seconds?: number;
  amplitude?: number;
  leadingSilenceSec?: number;
  trailingSilenceSec?: number;
}

/** 生成真实 PCM WAV（正弦 440Hz + 头尾静音），用来验证扫描器不是靠文件名猜 */
function writeWav(filePath: string, options: WavOptions = {}): void {
  const sampleRate = options.sampleRate ?? 24_000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const seconds = options.seconds ?? 5;
  const amplitude = options.amplitude ?? 0.5;
  const lead = Math.round((options.leadingSilenceSec ?? 0.2) * sampleRate);
  const tail = Math.round((options.trailingSilenceSec ?? 0.2) * sampleRate);
  const frames = Math.round(seconds * sampleRate);
  const bytesPerSample = bits / 8;
  const dataSize = frames * channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const data = Buffer.alloc(dataSize);
  let cursor = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const silent = frame < lead || frame >= frames - tail;
    const value = silent ? 0 : amplitude * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      if (bits === 16) {
        data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), cursor);
      } else {
        const int = Math.max(-8_388_608, Math.min(8_388_607, Math.round(value * 8_388_607)));
        const unsigned = int < 0 ? int + 0x100_0000 : int;
        data.writeUInt8(unsigned & 0xff, cursor);
        data.writeUInt8((unsigned >> 8) & 0xff, cursor + 1);
        data.writeUInt8((unsigned >> 16) & 0xff, cursor + 2);
      }
      cursor += bytesPerSample;
    }
  }
  writeFileSync(filePath, Buffer.concat([header, data]));
}

function writeConsent(overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(materialsDir, 'consent.json'), JSON.stringify({
    identityId: 'xiaojing-singing',
    displayName: '小鲸',
    source: 'owner_authorized_recording',
    consentScopes: ['training', 'synthesis', 'commercial_livestream'],
    consentEvidenceRef: 'CONSENT-2026-001',
    weightLicense: 'commercial_ok',
    svcModelPath: 'models/rvc/xiaojing.pth',
    ...overrides,
  }));
}

describe('readWavFacts', () => {
  it('16-bit 单声道：采样率/位深/声道/时长/峰值/头尾静音都来自真实样本', () => {
    const file = join(materialsDir, 'sweet_normal-01.wav');
    writeWav(file);
    const result = readWavFacts(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.sampleRate).toBe(24_000);
    expect(result.facts.bitDepth).toBe(16);
    expect(result.facts.channels).toBe(1);
    expect(result.facts.durationMs).toBe(5_000);
    // 振幅 0.5 ≈ −6.02 dBFS
    expect(result.facts.peakDbfs).toBeGreaterThan(-6.3);
    expect(result.facts.peakDbfs).toBeLessThan(-5.7);
    // 头 0.2s 静音（允许 1 帧误差）
    expect(Math.abs(result.facts.headSilenceMs - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.facts.tailSilenceMs - 200)).toBeLessThanOrEqual(2);
    expect(result.facts.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('24-bit 立体声也能解出正确事实', () => {
    const file = join(materialsDir, 'clumsy_panic-01.wav');
    writeWav(file, { bits: 24, channels: 2, seconds: 5 });
    const result = readWavFacts(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.bitDepth).toBe(24);
    expect(result.facts.channels).toBe(2);
    expect(result.facts.durationMs).toBe(5_000);
    expect(result.facts.peakDbfs).toBeGreaterThan(-6.3);
  });

  it('非 WAV 内容 → unsupported_format；过短/不存在 → unreadable_file', () => {
    const tooShort = join(materialsDir, 'broken.wav');
    writeFileSync(tooShort, 'not a wav at all');
    expect(readWavFacts(tooShort)).toMatchObject({ ok: false, code: 'unreadable_file' });

    const notRiff = join(materialsDir, 'text.wav');
    writeFileSync(notRiff, Buffer.alloc(128, 0x41));
    expect(readWavFacts(notRiff)).toMatchObject({ ok: false, code: 'unsupported_format' });

    expect(readWavFacts(join(materialsDir, 'missing.wav'))).toMatchObject({ ok: false, code: 'unreadable_file' });
  });
});

describe('createSingingMaterialsHost', () => {
  it('扫描真实文件：推断情绪组/训练类型，写入 manifest，就绪判定如实报缺口', async () => {
    writeConsent();
    writeWav(join(materialsDir, 'sweet_normal-01.wav'));
    mkdirSync(join(materialsDir, 'training'), { recursive: true });
    writeWav(join(materialsDir, 'training', 'take-01.wav'), { seconds: 10 });

    const host = createSingingMaterialsHost({ userDataDir });
    const result = await host.scan();

    expect(result.profileSource).toBe('unconfigured');
    expect(result.files).toHaveLength(2);
    const emotion = result.files.find((file) => file.kind === 'emotion_reference');
    const training = result.files.find((file) => file.kind === 'svc_training_dry_vocal');
    expect(emotion?.emotion).toBe('sweet_normal');
    expect(training?.durationMs).toBe(10_000);
    expect(result.summary.emotionReferenceCount).toBe(1);
    expect(result.summary.missingEmotionKeys).toContain('tsundere_refuse');

    // 默认引擎未装 + 其余四组缺 → 不能 ready
    expect(result.readiness.ready).toBe(false);
    expect(result.readiness.blockers.join(' ')).toContain('引擎未安装');

    // manifest 落盘只有事实
    const manifest = JSON.parse(readFileSync(join(userDataDir, 'singing', 'materials.json'), 'utf8'));
    expect(manifest.files).toHaveLength(2);
    expect(manifest.updatedAt).toBeGreaterThan(0);
  });

  it('没有 consent.json → 每个文件缺授权声明，readiness 直接阻断', async () => {
    writeWav(join(materialsDir, 'sweet_normal-01.wav'));
    const host = createSingingMaterialsHost({ userDataDir });
    const result = await host.scan();
    expect(result.summary.issues.filter((item) => item.code === 'consent_missing')).toHaveLength(1);
    expect(result.summary.verdict).toBe('fail');
    expect(result.readiness.blockers.join(' ')).toContain('授权声明');
  });

  it('坏文件进 blockers，不静默跳过', async () => {
    writeConsent();
    writeFileSync(join(materialsDir, 'oops.wav'), 'garbage');
    const host = createSingingMaterialsHost({ userDataDir });
    const result = await host.scan();
    expect(result.files).toHaveLength(0);
    expect(result.summary.issues).toContainEqual(expect.objectContaining({ code: 'unreadable_file', severity: 'blocker' }));
    expect(result.summary.verdict).toBe('fail');
  });

  it('未写情绪组的文件 → unclassified_material 警告，按未分组处理', async () => {
    writeConsent();
    writeWav(join(materialsDir, 'random-take.wav'));
    const host = createSingingMaterialsHost({ userDataDir });
    const result = await host.scan();
    expect(result.summary.issues).toContainEqual(expect.objectContaining({ code: 'unclassified_material' }));
    expect(result.summary.emotionReferenceCount).toBe(0);
  });

  it('profile.json 合法 → profileSource=file；损坏 → 退回 unconfigured 但不崩溃', async () => {
    writeConsent();
    const profilePath = join(userDataDir, 'singing', 'profile.json');
    mkdirSync(join(userDataDir, 'singing'), { recursive: true });
    writeFileSync(profilePath, JSON.stringify({
      profileId: 'xiaojing-singing',
      characterId: 'xiaojing',
      voice: {
        identityId: 'xiaojing-singing',
        displayName: '小鲸',
        source: 'owner_authorized_recording',
        consentScopes: ['training', 'synthesis', 'commercial_livestream'],
        consentEvidenceRef: 'CONSENT-2026-001',
        weightLicense: 'commercial_ok',
        svcModelPath: 'models/rvc/xiaojing.pth',
      },
      range: { lowestNote: 'C4', highestNote: 'F5', comfortableLow: 'E4', comfortableHigh: 'D5' },
      style: {},
    }));
    const okHost = createSingingMaterialsHost({ userDataDir });
    expect((await okHost.scan()).profileSource).toBe('file');

    writeFileSync(profilePath, '{ broken');
    const brokenHost = createSingingMaterialsHost({ userDataDir });
    const broken = await brokenHost.scan();
    expect(broken.profileSource).toBe('unconfigured');
  });

  it('注入引擎探测：RVC 已装 + 商用许可 + .pth 配好 + 五组齐 → ready 且 commercialReady', async () => {
    writeConsent();
    for (const key of ['sweet_normal', 'tsundere_refuse', 'rage_spray', 'lazy_yawn', 'clumsy_panic', 'happy_rice']) {
      writeWav(join(materialsDir, `${key}-01.wav`), { leadingSilenceSec: 0.2, trailingSilenceSec: 0.2 });
    }
    const host = createSingingMaterialsHost({
      userDataDir,
      probeEngines: async () => [
        { engine: 'rvc', installed: true, weightLicense: 'commercial_ok', detail: '自训底模', hint: '' },
      ],
    });
    const result = await host.scan();
    expect(result.summary.issues).toEqual([]);
    expect(result.readiness.ready).toBe(true);
    expect(result.readiness.commercialReady).toBe(true);
  });

  it('last() 返回最近一次扫描结果，directory() 指向素材目录', async () => {
    writeConsent();
    const host = createSingingMaterialsHost({ userDataDir });
    expect(host.directory()).toBe(materialsDir);
    expect(host.last()).toBeNull();
    const first = await host.scan();
    expect(host.last()).toEqual(first);
  });
});
