/**
 * 音色工坊（M1 + M2）单测：判据阈值、状态持久化、定格/回退、体检的三条出口。
 *
 * 零网络、零真实合成：合成器与说话人余弦全部注入假实现；被测的是「工坊自己的账」——
 * 版本时间线、会话计数、候选索引、体检结论与「工具缺失不给假数字」的诚实出口。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeVoiceWorkshopDescription, MIMO_WORKSHOP_AUDITION_LINES } from '@workbench/shared-protocol';
import {
  analyzeWavBuffer,
  CONSISTENCY_SAMPLES,
  CONSISTENCY_SENTENCE,
  VoiceWorkshop,
  verdictFor,
  type SpeakerCosineRunner,
  type WorkshopSynth,
  type WorkshopSynthInput,
} from './voice-workshop';

const BUNDLED_DESCRIPTION = '八九岁小女孩，声音甜而脆，元气满满，语速快，句尾翘起来，像随时要跳起来';
const FAKE_WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

interface Harness {
  root: string;
  userDataDir: string;
  bundledReferencePath: string;
  cloneSamplePath: string;
  calls: WorkshopSynthInput[];
  workshop: VoiceWorkshop;
}

function makeHarness(overrides: Partial<{ synth: WorkshopSynth; runSpeakerCosine: SpeakerCosineRunner }> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'voice-workshop-'));
  const userDataDir = join(root, 'userData');
  mkdirSync(userDataDir, { recursive: true });
  const bundledReferencePath = join(root, 'bundled.wav');
  writeFileSync(bundledReferencePath, FAKE_WAV);
  const calls: WorkshopSynthInput[] = [];
  const synth: WorkshopSynth = overrides.synth ?? (async (input) => {
    calls.push(input);
    return { bytes: FAKE_WAV, providerKind: 'mimo-tts-voicedesign' };
  });
  const workshop = new VoiceWorkshop({
    userDataDir,
    bundledReferencePath,
    bundledLabel: '07 甜脆·元气',
    bundledDescription: BUNDLED_DESCRIPTION,
    cloneSamplePath: join(userDataDir, 'voice-clone-sample.wav'),
    synth,
    ...(overrides.runSpeakerCosine === undefined ? {} : { runSpeakerCosine: overrides.runSpeakerCosine }),
    now: () => new Date('2026-11-27T10:00:00.000Z'),
  });
  return {
    root,
    userDataDir,
    bundledReferencePath,
    cloneSamplePath: join(userDataDir, 'voice-clone-sample.wav'),
    calls,
    workshop,
  };
}

describe('verdictFor（判据写死，不随 UI 调）', () => {
  it('mean ≥ 0.85 且 min ≥ 0.80 → 锁得稳（边界值按通过算）', () => {
    expect(verdictFor(0.9059, 0.8814).verdict).toBe('stable');
    expect(verdictFor(0.85, 0.8).verdict).toBe('stable');
  });

  it('mean 够但 min 掉到 0.80 以下、仍在 0.70 以上 → 偶尔飘（对标 02 的 0.8275 / 0.7189）', () => {
    expect(verdictFor(0.8275, 0.7189).verdict).toBe('drifty');
    expect(verdictFor(0.84, 0.8).verdict).toBe('drifty');
    expect(verdictFor(0.6, 0.7).verdict).toBe('drifty');
  });

  it('min < 0.70 → 会换人（对标 VoiceDesign 漂移最小 0.4145）', () => {
    expect(verdictFor(0.5, 0.4145).verdict).toBe('swapped');
    expect(verdictFor(0.99, 0.699).verdict).toBe('swapped');
  });
});

describe('VoiceWorkshop · 出厂与持久化', () => {
  let h: Harness;
  afterEach(() => { rmSync(h.root, { recursive: true, force: true }); });

  it('首次启动只有出厂版本，且当前指向它；来源/描述/字节数如实', () => {
    h = makeHarness();
    const snapshot = h.workshop.snapshot();
    expect(snapshot.currentVersionId).toBe('factory');
    expect(snapshot.versions).toHaveLength(1);
    expect(snapshot.versions[0]).toMatchObject({
      id: 'factory',
      source: 'factory',
      label: '07 甜脆·元气',
      description: BUNDLED_DESCRIPTION,
      referenceBytes: FAKE_WAV.byteLength,
      consistency: null,
    });
    expect(snapshot.sessionCalls).toBe(0);
  });

  it('状态文件损坏 / current 指向已不存在的版本 → 回到出厂，出厂永远排第一位', () => {
    h = makeHarness();
    const statePath = join(h.userDataDir, 'voice-workshop', 'state.json');
    const reopen = (): VoiceWorkshop => new VoiceWorkshop({
      userDataDir: h.userDataDir,
      bundledReferencePath: h.bundledReferencePath,
      bundledLabel: '07 甜脆·元气',
      bundledDescription: BUNDLED_DESCRIPTION,
      cloneSamplePath: h.cloneSamplePath,
      synth: async () => { throw new Error('不该被调用'); },
    });

    writeFileSync(statePath, '{ this is not json');
    expect(reopen().snapshot().currentVersionId).toBe('factory');

    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, currentVersionId: 'ghost', versions: [] }));
    const snapshot = reopen().snapshot();
    expect(snapshot.currentVersionId).toBe('factory');
    expect(snapshot.versions.map((item) => item.id)).toEqual(['factory']);
  });
});

describe('VoiceWorkshop · 生成候选', () => {
  let h: Harness;
  afterEach(() => { rmSync(h.root, { recursive: true, force: true }); });

  it('拨盘短语拼进实际描述；一次 count 条、每条一次合成、全部计入会话计数', async () => {
    h = makeHarness();
    const dial = { age: 'child', texture: 'sweet_crisp', pace: 'fast', ending: 'rising' } as const;
    const candidates = await h.workshop.generateCandidates({ description: '八九岁小女孩', dial, count: 4 });
    expect(candidates).toHaveLength(4);
    expect(h.calls).toHaveLength(4);
    const expected = composeVoiceWorkshopDescription('八九岁小女孩', dial);
    expect(candidates[0]?.description).toBe(expected);
    expect(candidates[0]?.description).toContain('八九岁小女孩');
    expect(h.calls.every((call) => call.mode === 'voicedesign' && call.description === expected)).toBe(true);
    expect(h.workshop.snapshot().sessionCalls).toBe(4);
    for (const candidate of candidates) expect(existsSync(candidate.file)).toBe(true);
  });

  it('中途失败：已出的候选仍会落索引（付过费的音频不因后一条报错而丢）', async () => {
    let n = 0;
    h = makeHarness({
      synth: async () => {
        n++;
        if (n === 3) throw new Error('quota exhausted');
        return { bytes: FAKE_WAV, providerKind: 'mimo-tts-voicedesign' };
      },
    });
    await expect(h.workshop.generateCandidates({ description: '测试', count: 4 })).rejects.toThrow('quota exhausted');
    const index = JSON.parse(readFileSync(join(h.userDataDir, 'voice-workshop', 'candidates', 'index.json'), 'utf8')) as unknown[];
    expect(index).toHaveLength(2);
  });

  it('候选索引跨实例可见（重启后仍能定格/试戴）', async () => {
    h = makeHarness();
    const [candidate] = await h.workshop.generateCandidates({ description: '测试', count: 1 });
    const reopened = new VoiceWorkshop({
      userDataDir: h.userDataDir,
      bundledReferencePath: h.bundledReferencePath,
      bundledLabel: '07 甜脆·元气',
      bundledDescription: BUNDLED_DESCRIPTION,
      cloneSamplePath: h.cloneSamplePath,
      synth: async () => ({ bytes: FAKE_WAV, providerKind: 'mimo-tts-voiceclone' }),
    });
    const rows = await reopened.audition({ candidateId: candidate!.id, intensity: 'B' });
    expect(rows).toHaveLength(MIMO_WORKSHOP_AUDITION_LINES.length);
  });
});

describe('VoiceWorkshop · 多句试戴', () => {
  let h: Harness;
  afterEach(() => { rmSync(h.root, { recursive: true, force: true }); });

  it('固定 4 句（中性/调皮/傲娇/撒娇），走 voiceclone、拿候选音频当参考、透传强度', async () => {
    h = makeHarness();
    const [candidate] = await h.workshop.generateCandidates({ description: '测试描述', count: 1 });
    h.calls.length = 0;
    const rows = await h.workshop.audition({ candidateId: candidate!.id, intensity: 'C' });
    expect(rows.map((row) => row.key)).toEqual(MIMO_WORKSHOP_AUDITION_LINES.map((line) => line.key));
    expect(rows[0]?.emotion).toBeNull();
    expect(rows.slice(1).map((row) => row.emotion)).toEqual(['bright', 'tsundere', 'daily']);
    expect(rows.every((row) => row.intensity === 'C')).toBe(true);
    expect(h.calls).toHaveLength(4);
    expect(h.calls.every((call) => call.mode === 'voiceclone' && call.referencePath === candidate!.file)).toBe(true);
    expect(rows[0]?.audioBase64).toBe(Buffer.from(FAKE_WAV).toString('base64'));
    expect(h.workshop.snapshot().sessionCalls).toBe(5);
  });

  it('候选不存在（或音频被清理）→ 明确报错，不静默返回空', async () => {
    h = makeHarness();
    await expect(h.workshop.audition({ candidateId: 'nope', intensity: 'B' })).rejects.toThrow('找不到这条候选');
  });
});

describe('VoiceWorkshop · 定格与回退', () => {
  let h: Harness;
  afterEach(() => { rmSync(h.root, { recursive: true, force: true }); });

  it('定格：写版本副本 + 写本地克隆参考 + 指向新版本；元数据存全（描述/台词/强度/来源）', async () => {
    h = makeHarness();
    const [candidate] = await h.workshop.generateCandidates({ description: '甜脆小孩', count: 1 });
    const version = h.workshop.freeze({ candidateId: candidate!.id, label: '我的小鲸' });
    expect(version).toMatchObject({
      label: '我的小鲸',
      source: 'ai-design',
      description: candidate!.description,
      referenceBytes: FAKE_WAV.byteLength,
      consistency: null,
    });
    expect(version.freeze).toMatchObject({
      text: candidate!.text,
      intensity: 'B',
      provider: 'mimo-tts-voiceclone',
      mode: 'voicedesign → voiceclone',
    });
    expect(existsSync(version.referencePath)).toBe(true);
    expect(readFileSync(h.cloneSamplePath)).toEqual(Buffer.from(FAKE_WAV));
    const snapshot = h.workshop.snapshot();
    expect(snapshot.currentVersionId).toBe(version.id);
    expect(snapshot.versions.map((item) => item.id)).toEqual(['factory', version.id]);
  });

  it('回退到出厂：删掉本地克隆参考，让主进程回落随包基准', () => {
    h = makeHarness();
    writeFileSync(h.cloneSamplePath, FAKE_WAV);
    const factory = h.workshop.rollback('factory');
    expect(factory.source).toBe('factory');
    expect(existsSync(h.cloneSamplePath)).toBe(false);
  });

  it('回退到不存在的版本 → 明确报错', () => {
    h = makeHarness();
    expect(() => h.workshop.rollback('ghost')).toThrow('没有这个声线版本');
  });

  it('自定版本的参考音频被删掉后再回退 → 明确报错，不改动当前参考', async () => {
    h = makeHarness();
    const [candidate] = await h.workshop.generateCandidates({ description: '甜脆小孩', count: 1 });
    const version = h.workshop.freeze({ candidateId: candidate!.id });
    rmSync(version.referencePath);
    expect(() => h.workshop.rollback(version.id)).toThrow('参考音频已经不在磁盘上');
  });

  it('回退到自定版本：参考音频被恢复成该版本的副本', async () => {
    h = makeHarness();
    const [candidate] = await h.workshop.generateCandidates({ description: '甜脆小孩', count: 1 });
    const version = h.workshop.freeze({ candidateId: candidate!.id, label: '定格 A' });
    h.workshop.rollback('factory');
    expect(existsSync(h.cloneSamplePath)).toBe(false);
    const back = h.workshop.rollback(version.id);
    expect(back.id).toBe(version.id);
    expect(readFileSync(h.cloneSamplePath)).toEqual(Buffer.from(FAKE_WAV));
    expect(h.workshop.snapshot().currentVersionId).toBe(version.id);
  });
});

describe('VoiceWorkshop · 一致性体检', () => {
  let h: Harness;
  afterEach(() => { rmSync(h.root, { recursive: true, force: true }); });

  it('同一句 ×10 真实克隆（对着出厂随包参考），结论与数字写回版本', async () => {
    h = makeHarness({ runSpeakerCosine: async (wavs) => {
      expect(wavs).toHaveLength(CONSISTENCY_SAMPLES);
      return { mean: 0.9059, min: 0.8814, std: 0.0148 };
    } });
    const result = await h.workshop.checkConsistency();
    expect(result.verdict).toBe('stable');
    expect(result).toMatchObject({ mean: 0.9059, min: 0.8814, std: 0.0148, samples: CONSISTENCY_SAMPLES });
    expect(h.calls).toHaveLength(CONSISTENCY_SAMPLES);
    expect(h.calls.every((call) => call.mode === 'voiceclone' && call.text === CONSISTENCY_SENTENCE)).toBe(true);
    expect(h.calls.every((call) => call.referencePath === h.bundledReferencePath)).toBe(true);
    expect(h.workshop.snapshot().versions[0]?.consistency?.verdict).toBe('stable');
  });

  it('工具缺失 → unavailable，明确写「不给假数字」，且不留下 mean/min/std', async () => {
    h = makeHarness({ runSpeakerCosine: async () => null });
    const result = await h.workshop.checkConsistency();
    expect(result.verdict).toBe('unavailable');
    expect(result.mean).toBeNull();
    expect(result.min).toBeNull();
    expect(result.std).toBeNull();
    expect(result.detail).toContain('不给假数字');
  });

  it('参考音频不存在 → 直接 unavailable，一次合成都不花', async () => {
    h = makeHarness();
    rmSync(h.bundledReferencePath);
    const result = await h.workshop.checkConsistency('factory');
    expect(result.verdict).toBe('unavailable');
    expect(result.samples).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it('体检结果持久化：新实例读回同一条结论（缓存可重跑）', async () => {
    h = makeHarness({ runSpeakerCosine: async () => ({ mean: 0.86, min: 0.72, std: 0.05 }) });
    await h.workshop.checkConsistency();
    const reopened = new VoiceWorkshop({
      userDataDir: h.userDataDir,
      bundledReferencePath: h.bundledReferencePath,
      bundledLabel: '07 甜脆·元气',
      bundledDescription: BUNDLED_DESCRIPTION,
      cloneSamplePath: h.cloneSamplePath,
      synth: async () => ({ bytes: FAKE_WAV, providerKind: 'mimo-tts-voiceclone' }),
    });
    expect(reopened.snapshot().versions[0]?.consistency).toMatchObject({ verdict: 'drifty', mean: 0.86, min: 0.72 });
  });
});

function buildPcmWav(durationSec: number, sampleRate = 24_000, amp = 0.4): Uint8Array {
  const count = Math.round(durationSec * sampleRate);
  const dataBytes = count * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  // 交替有声段与短静音，确保 SNR 与时长都被真实统计
  for (let i = 0; i < count; i++) {
    const inPause = i % Math.floor(sampleRate * 1.2) < Math.floor(sampleRate * 0.25);
    const val = inPause ? 0.001 : amp * Math.sin((2 * Math.PI * 300 * i) / sampleRate);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(val * 32767))), 44 + i * 2);
  }
  return new Uint8Array(buf);
}

describe('VoiceWorkshop 2.0 · 声学质检 / 音色克隆 / 版本管理 / 音频安全读取', () => {
  let h: Harness | undefined;
  afterEach(() => {
    if (h !== undefined) {
      rmSync(h.root, { recursive: true, force: true });
      h = undefined;
    }
  });

  it('analyzeWavBuffer 精确解析真实 PCM WAV 并识别正常样本与削波/过短告警', () => {
    const clean = buildPcmWav(6.0, 24_000, 0.35);
    const qaClean = analyzeWavBuffer(clean);
    expect(qaClean).not.toBeNull();
    expect(qaClean!.durationMs).toBe(6000);
    expect(qaClean!.sampleRate).toBe(24_000);
    expect(qaClean!.clipping).toBe(false);
    expect(qaClean!.grade).toBe('good');
    expect(qaClean!.estimatedSnrDb).toBeGreaterThan(20);

    const bad = buildPcmWav(1.5, 16_000, 0.99);
    const qaBad = analyzeWavBuffer(bad);
    expect(qaBad!.clipping).toBe(true);
    expect(qaBad!.grade).toBe('warn');

    expect(analyzeWavBuffer(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('createClonedVersion：校验 RIFF + 权属声明 + 写版本与 SHA-256 + 激活 cloneSamplePath', () => {
    const harness = makeHarness();
    h = harness;
    const wav = buildPcmWav(7.0, 24_000, 0.4);
    const version = harness.workshop.createClonedVersion({
      wavBase64: Buffer.from(wav).toString('base64'),
      label: '小鲸亲录 v1',
      description: '安静书房录制',
      consent: {
        kind: 'self_recorded',
        source: '本人亲录干声',
        attested: true,
        attestedAt: '2026-11-27T10:00:00.000Z',
      },
      activate: true,
    });
    expect(version.source).toBe('uploaded');
    expect(version.label).toBe('小鲸亲录 v1');
    expect(version.licenseScope).toBe('COMMERCIAL_READY');
    expect(version.referenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version.audioQuality?.durationMs).toBe(7000);
    expect(existsSync(version.referencePath)).toBe(true);
    expect(readFileSync(harness.cloneSamplePath).byteLength).toBe(wav.byteLength);
    expect(harness.workshop.snapshot().currentVersionId).toBe(version.id);

    // 非 WAV 头被拒绝
    expect(() => harness.workshop.createClonedVersion({
      wavBase64: Buffer.from('not-a-wav-file-at-all-00000000000000000000000000000000').toString('base64'),
      label: '坏文件',
      consent: { kind: 'self_recorded', source: '本人', attested: true, attestedAt: '2026-11-27T10:00:00.000Z' },
    })).toThrow('RIFF/WAVE');
  });

  it('renameVersion & deleteVersion：保护出厂版本，删除当前激活版本自动安全回退出厂', () => {
    const harness = makeHarness();
    h = harness;
    const wav = buildPcmWav(6.0, 24_000, 0.35);
    const v = harness.workshop.createClonedVersion({
      wavBase64: Buffer.from(wav).toString('base64'),
      label: '临时克隆',
      consent: { kind: 'self_recorded', source: '本人', attested: true, attestedAt: '2026-11-27T10:00:00.000Z' },
      activate: true,
    });
    const renamed = harness.workshop.renameVersion(v.id, '正式克隆 v2');
    expect(renamed.label).toBe('正式克隆 v2');
    expect(() => harness.workshop.renameVersion('factory', '篡改出厂')).toThrow('不可改名');
    expect(() => harness.workshop.deleteVersion('factory')).toThrow('不可删除');

    const deleted = harness.workshop.deleteVersion(v.id);
    expect(deleted.deletedId).toBe(v.id);
    expect(deleted.currentVersion.id).toBe('factory');
    expect(existsSync(v.referencePath)).toBe(false);
    expect(existsSync(harness.cloneSamplePath)).toBe(false);
  });

  it('auditionVersion 与 readAudio：支持自定义单句试戴（1 次）与白名单 WAV 安全读取', async () => {
    const harness = makeHarness();
    h = harness;
    const customRows = await harness.workshop.auditionVersion({
      versionId: 'factory',
      intensity: 'B',
      customText: '主人今天想吃什么呀？',
    });
    expect(customRows).toHaveLength(1);
    expect(customRows[0]?.key).toBe('custom');
    expect(harness.calls).toHaveLength(1);

    const audio = harness.workshop.readAudio({ kind: 'version', id: 'factory' });
    expect(audio.bytes).toBe(FAKE_WAV.byteLength);
    expect(audio.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => harness.workshop.readAudio({ kind: 'candidate', id: '../../etc/passwd' })).toThrow('找不到');
  });

  it('从 AI 设计候选直接选入克隆：保留血缘 originCandidateId、自动标记 DEV_ONLY、支持裁剪后音频', async () => {
    const cleanWav = buildPcmWav(6.0, 24_000, 0.35);
    let refChanged = 0;
    const harness = makeHarness({
      synth: async () => ({ bytes: cleanWav, providerKind: 'mimo-tts-voicedesign' }),
    });
    h = harness;
    const workshopWithHook = new VoiceWorkshop({
      userDataDir: harness.userDataDir,
      bundledReferencePath: harness.bundledReferencePath,
      bundledLabel: '07 甜脆·元气',
      bundledDescription: BUNDLED_DESCRIPTION,
      cloneSamplePath: harness.cloneSamplePath,
      synth: async () => ({ bytes: cleanWav, providerKind: 'mimo-tts-voicedesign' }),
      onReferenceChanged: () => { refChanged += 1; },
      now: () => new Date('2026-11-27T10:00:00.000Z'),
    });

    const [cand] = await workshopWithHook.generateCandidates({ description: '柔和少女', count: 1 });
    const trimmed = buildPcmWav(5.2, 24_000, 0.3);
    const cloned = workshopWithHook.createClonedVersion({
      sourceCandidateId: cand!.id,
      wavBase64: Buffer.from(trimmed).toString('base64'),
      rawWavBase64: Buffer.from(cleanWav).toString('base64'),
      label: '柔和少女 · 精修克隆',
      consent: {
        kind: 'ai_synthetic',
        source: '源自 AI 音色设计候选',
        attested: true,
        attestedAt: '2026-11-27T10:00:00.000Z',
      },
      characterId: 'blue-whale-maid',
      activate: true,
    });
    expect(cloned.originCandidateId).toBe(cand!.id);
    expect(cloned.licenseScope).toBe('DEV_ONLY_NON_COMMERCIAL');
    expect(cloned.rawReferencePath).toBeDefined();
    expect(existsSync(cloned.rawReferencePath!)).toBe(true);
    expect(workshopWithHook.readAudio({ kind: 'version-raw', id: cloned.id }).bytes).toBe(cleanWav.byteLength);
    expect(workshopWithHook.snapshot().characterBindings?.['blue-whale-maid']).toBe(cloned.id);
    expect(refChanged).toBeGreaterThanOrEqual(1);
  });

  it('多角色绑定锁定保护删除 + 收藏/软归档 + 撤销授权立即清理磁盘并阻止合成', () => {
    const harness = makeHarness();
    h = harness;
    const wav = buildPcmWav(6.0, 24_000, 0.35);
    const v = harness.workshop.createClonedVersion({
      wavBase64: Buffer.from(wav).toString('base64'),
      label: '角色专属克隆',
      consent: { kind: 'self_recorded', source: '本人亲录', attested: true, attestedAt: '2026-11-27T10:00:00.000Z' },
      characterId: 'char-a',
      activate: true,
    });

    // 收藏与软归档
    expect(harness.workshop.setFavorite(v.id, true).favorite).toBe(true);
    expect(harness.workshop.setArchived(v.id, true).archivedAt).toBeTruthy();
    expect(harness.workshop.setArchived(v.id, false).archivedAt).toBeNull();

    // 正被角色绑定时禁止永久删除
    expect(() => harness.workshop.deleteVersion(v.id)).toThrow('锁定绑定');

    // 解析角色参考命中绑定版本
    const resolved = harness.workshop.resolveReferenceForCharacter('char-a');
    expect(resolved.version.id).toBe(v.id);
    expect(resolved.revoked).toBe(false);

    // 撤销授权：清理磁盘文件、解绑角色、回退出厂、后续禁止试戴与回退
    const revoked = harness.workshop.revokeConsent(v.id, '用户撤权');
    expect(revoked.unboundCharacters).toEqual(['char-a']);
    expect(revoked.version.consent?.revokedAt).toBeTruthy();
    expect(existsSync(v.referencePath)).toBe(false);
    expect(harness.workshop.snapshot().currentVersionId).toBe('factory');
    expect(() => harness.workshop.rollback(v.id)).toThrow('撤销授权');
    expect(() => harness.workshop.bindCharacter('char-a', v.id)).toThrow('撤销授权');
  });

  it('MiMo Base64 > 10MB 参考音频在主进程硬拦截', () => {
    const harness = makeHarness();
    h = harness;
    // 构造 7.6 MB 的合法 RIFF/WAVE（Base64 编码后约 10.13 MB > 10,000,000）
    const oversized = Buffer.alloc(7_600_000);
    oversized.write('RIFF', 0, 'ascii');
    oversized.write('WAVE', 8, 'ascii');
    expect(() => harness.workshop.createClonedVersion({
      wavBase64: oversized.toString('base64'),
      label: '超大样本',
      consent: { kind: 'self_recorded', source: '本人', attested: true, attestedAt: '2026-11-27T10:00:00.000Z' },
    })).toThrow('MiMo 10 MB 上限');
  });

  it('cancelJob 可中途取消在飞候选生成任务', async () => {
    let seenSignal: AbortSignal | undefined;
    const harness = makeHarness({
      synth: async (input) => {
        seenSignal = input.signal;
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    });
    h = harness;
    const pending = harness.workshop.generateCandidates({ description: '可取消测试', count: 2, jobId: 'job-cancel-1' });
    expect(harness.workshop.cancelJob('job-cancel-1')).toBe(true);
    await expect(pending).rejects.toThrow();
    expect(seenSignal?.aborted).toBe(true);
  });
});
