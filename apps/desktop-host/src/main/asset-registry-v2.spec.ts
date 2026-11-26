import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssetRegistryV2,
  createProceduralStageScenePng,
  inspectAudioAsset,
  inspectStageSceneAsset,
  synthesizeSfxWav,
} from './asset-registry-v2';

function makeTempDir(prefix = 'asset-registry-v2-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('AssetRegistryV2（V2-P2-07：舞台/场景/声音创作、十态治理、商业清源与一键回滚）', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('StageSceneStudio：生成三主题原创舞台图并执行分辨率/宽高比/异常文件质检', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);

    expect(inspectStageSceneAsset(join(dir, 'missing.png')).valid).toBe(false);
    const badPng = join(dir, 'bad.png');
    writeFileSync(badPng, Buffer.from('not-an-image'));
    expect(inspectStageSceneAsset(badPng).valid).toBe(false);

    // WebP 魔数合法但不解析 PNG 宽高，应返回提醒
    const fakeWebp = join(dir, 'scene.webp');
    const webpBuf = Buffer.alloc(16);
    webpBuf.write('RIFF', 0, 'ascii');
    webpBuf.writeUInt32LE(8, 4);
    webpBuf.write('WEBP', 8, 'ascii');
    writeFileSync(fakeWebp, webpBuf);
    const webpQa = inspectStageSceneAsset(fakeWebp);
    expect(webpQa.valid).toBe(true);
    expect(webpQa.warnings.some((w) => w.includes('非 PNG'))).toBe(true);

    // 三主题原生 PNG 创作
    const smallMist = createProceduralStageScenePng({
      outputPath: join(dir, 'mist.png'),
      theme: 'tidepaper_mist',
      width: 320,
      height: 180,
    });
    expect(smallMist.inspection.valid).toBe(true);
    expect(smallMist.inspection.aspectRatio).toBe('16:9');
    expect(smallMist.inspection.isHdOrAbove).toBe(false);

    const hdNight = createProceduralStageScenePng({
      outputPath: join(dir, 'night.png'),
      theme: 'night_tide',
      width: 1280,
      height: 720,
    });
    expect(hdNight.inspection.valid).toBe(true);
    expect(hdNight.inspection.isHdOrAbove).toBe(true);

    const obsidian = createProceduralStageScenePng({
      outputPath: join(dir, 'obsidian.png'),
      theme: 'obsidian_stage',
      width: 640,
      height: 360,
    });
    expect(obsidian.inspection.valid).toBe(true);
  });

  it('SoundSfxStudio：合成 5 档无削波 WAV 音效并解析真实采样率/声道/时长/削波与 OGG/MP3/M4A 魔数', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);

    expect(inspectAudioAsset(join(dir, 'missing.wav')).valid).toBe(false);
    const tiny = join(dir, 'tiny.bin');
    writeFileSync(tiny, Buffer.from('abc'));
    expect(inspectAudioAsset(tiny).valid).toBe(false);

    const unknown = join(dir, 'unknown.bin');
    writeFileSync(unknown, Buffer.from('RANDOM_NON_AUDIO_HEADER'));
    expect(inspectAudioAsset(unknown).valid).toBe(false);

    const brokenWav = join(dir, 'broken.wav');
    writeFileSync(brokenWav, Buffer.from('RIFF\x24\x00\x00\x00WAVEJUNK\x04\x00\x00\x00test'));
    const brokenWavQa = inspectAudioAsset(brokenWav);
    expect(brokenWavQa.valid).toBe(false);
    expect(brokenWavQa.format).toBe('wav');

    for (const preset of ['chime', 'pop', 'alert', 'sparkle', 'splash'] as const) {
      const res = synthesizeSfxWav({
        outputPath: join(dir, `${preset}.wav`),
        preset,
        durationMs: 180,
        sampleRate: 22050,
      });
      expect(res.inspection.valid).toBe(true);
      expect(res.inspection.format).toBe('wav');
      expect(res.inspection.channels).toBe(1);
      expect(res.inspection.sampleRate).toBe(22050);
      expect(res.inspection.durationMs).toBeGreaterThanOrEqual(170);
      expect(res.inspection.clippingDetected).toBe(false);
    }

    // 验证削波检测分支
    const clippedPath = join(dir, 'clipped.wav');
    const clippedBuf = readFileSync(join(dir, 'chime.wav'));
    clippedBuf.writeInt16LE(32767, 44);
    writeFileSync(clippedPath, clippedBuf);
    expect(inspectAudioAsset(clippedPath).clippingDetected).toBe(true);

    // 验证 OGG / MP3 / M4A 容器头嗅探
    const ogg = join(dir, 'a.ogg');
    writeFileSync(ogg, Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00'));
    expect(inspectAudioAsset(ogg).format).toBe('ogg');

    const mp3 = join(dir, 'a.mp3');
    writeFileSync(mp3, Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x10frame'));
    expect(inspectAudioAsset(mp3).format).toBe('mp3');

    const m4a = join(dir, 'a.m4a');
    writeFileSync(m4a, Buffer.from('\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00'));
    expect(inspectAudioAsset(m4a).format).toBe('m4a');
  });

  it('AssetRegistryV2：十态状态机流转、防篡改 SHA-256、一键回滚与非商用清源导出拦截', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const registry = new AssetRegistryV2({ userDataDir: dir });

    const stageV1 = createProceduralStageScenePng({ outputPath: join(dir, 'src-stage-v1.png'), theme: 'tidepaper_mist' });
    const stageV2 = createProceduralStageScenePng({ outputPath: join(dir, 'src-stage-v2.png'), theme: 'night_tide' });
    const sfxV1 = synthesizeSfxWav({ outputPath: join(dir, 'src-sfx.wav'), preset: 'sparkle' });

    const commercialProvenance = {
      sourceType: 'user-upload' as const,
      author: 'WhaleIsle Original',
      license: 'SELF_OWNED_COMMERCIAL',
      allowCommercial: true,
      allowLivestream: true,
      allowRedistribution: true,
      inputRefPaths: [],
      reviewNotes: [],
    };

    // 异常参数与路径穿越拦截
    expect(() =>
      registry.registerVersion({
        assetId: '../bad',
        characterId: 'char_xiaojing',
        displayName: 'Bad',
        category: 'stage_background',
        sourceFilePath: stageV1.outputPath,
        provenance: commercialProvenance,
      }),
    ).toThrow('非法');
    expect(() =>
      registry.registerVersion({
        assetId: 'stage-main',
        characterId: 'char_xiaojing',
        displayName: 'Missing',
        category: 'stage_background',
        sourceFilePath: join(dir, 'none.png'),
        provenance: commercialProvenance,
      }),
    ).toThrow('不存在');

    // 坏资产自动进入 validation_failed，禁止批准或发布
    const badAudio = join(dir, 'bad-sfx.wav');
    writeFileSync(badAudio, Buffer.from('not-audio'));
    const badReg = registry.registerVersion({
      assetId: 'bad-sfx-asset',
      characterId: 'char_xiaojing',
      displayName: '坏音效',
      category: 'sound_sfx',
      sourceFilePath: badAudio,
      provenance: commercialProvenance,
    });
    expect(badReg.version.status).toBe('validation_failed');
    expect(registry.transitionStatus({ assetId: 'bad-sfx-asset', versionId: 'v1', nextStatus: 'approved' }).ok).toBe(false);

    // 舞台背景 v1 发布 → v2 发布 → 一键回滚至 v1
    const reg1 = registry.registerVersion({
      assetId: 'stage-main',
      characterId: 'char_xiaojing',
      displayName: '主舞台背景',
      category: 'stage_background',
      sourceFilePath: stageV1.outputPath,
      provenance: commercialProvenance,
      note: '初版白昼雾海',
    });
    expect(reg1.version.status).toBe('review_required');
    // 未批准禁止直接发布
    expect(registry.transitionStatus({ assetId: 'stage-main', versionId: 'v1', nextStatus: 'published' }).ok).toBe(false);
    expect(registry.transitionStatus({ assetId: 'stage-main', versionId: 'v1', nextStatus: 'approved', note: '色彩通过' }).ok).toBe(true);
    expect(registry.transitionStatus({ assetId: 'stage-main', versionId: 'v1', nextStatus: 'published' }).ok).toBe(true);

    const reg2 = registry.registerVersion({
      assetId: 'stage-main',
      characterId: 'char_xiaojing',
      displayName: '主舞台背景',
      category: 'stage_background',
      sourceFilePath: stageV2.outputPath,
      provenance: commercialProvenance,
      note: '夜潮皮肤',
    });
    expect(reg2.version.versionId).toBe('v2');
    registry.transitionStatus({ assetId: 'stage-main', versionId: 'v2', nextStatus: 'approved' });
    registry.transitionStatus({ assetId: 'stage-main', versionId: 'v2', nextStatus: 'published' });
    expect(registry.getAsset('stage-main')?.activeVersionId).toBe('v2');
    expect(registry.getAsset('stage-main')?.previousActiveVersionId).toBe('v1');

    // 回滚无历史或同版本校验
    expect(registry.rollbackAsset({ assetId: 'non-exist' }).ok).toBe(false);
    expect(registry.rollbackAsset({ assetId: 'stage-main', targetVersionId: 'v2' }).ok).toBe(false);

    // 一键回滚：v2 标为 deprecated（并在审计笔记记录 rolled_back），v1 恢复 published 激活
    const rolled = registry.rollbackAsset({ assetId: 'stage-main', note: '切回日间背景' });
    expect(rolled.ok).toBe(true);
    expect(rolled.entry?.activeVersionId).toBe('v1');
    expect(rolled.entry?.versions.find((v) => v.versionId === 'v2')?.status).toBe('deprecated');
    expect(rolled.entry?.versions.find((v) => v.versionId === 'v2')?.provenance.reviewNotes.some((n) => n.includes('rolled_back'))).toBe(true);
    expect(rolled.entry?.versions.find((v) => v.versionId === 'v1')?.status).toBe('published');
    expect(registry.verifyIntegrity('stage-main').ok).toBe(true);

    // 篡改快照文件导致 SHA-256 校验失败，回滚与发布均阻断
    const v2Snap = rolled.entry!.versions.find((v) => v.versionId === 'v2')!.snapshotPath;
    writeFileSync(v2Snap, Buffer.from('TAMPERED'));
    const badCheck = registry.verifyIntegrity('stage-main', 'v2');
    expect(badCheck.ok).toBe(false);
    expect(badCheck.reason).toContain('不匹配');
    expect(registry.rollbackAsset({ assetId: 'stage-main', targetVersionId: 'v2' }).ok).toBe(false);

    // 注册商用 SFX 与非商用 CC BY-NC-SA 4.0 CrossPet 资产并测试清源导出
    registry.registerVersion({
      assetId: 'sfx-sparkle',
      characterId: 'char_xiaojing',
      displayName: '闪烁音效',
      category: 'sound_sfx',
      sourceFilePath: sfxV1.outputPath,
      provenance: commercialProvenance,
    });
    registry.transitionStatus({ assetId: 'sfx-sparkle', versionId: 'v1', nextStatus: 'approved' });
    registry.transitionStatus({ assetId: 'sfx-sparkle', versionId: 'v1', nextStatus: 'published' });

    registry.registerVersion({
      assetId: 'crosspet-nc-bg',
      characterId: 'custom-cp-deepseek',
      displayName: 'CrossPet 非商用配图',
      category: 'avatar_2d',
      sourceFilePath: stageV1.outputPath,
      provenance: {
        sourceType: 'third-party-import',
        author: 'CrossPet',
        license: 'CC BY-NC-SA 4.0',
        allowCommercial: false,
        allowLivestream: false,
        allowRedistribution: false,
        inputRefPaths: [],
        reviewNotes: [],
      },
    });
    registry.transitionStatus({ assetId: 'crosspet-nc-bg', versionId: 'v1', nextStatus: 'approved' });
    registry.transitionStatus({ assetId: 'crosspet-nc-bg', versionId: 'v1', nextStatus: 'published' });

    const cleanDir = join(dir, 'clean-commercial-bundle');
    const cleanRes = registry.exportCleanBundle({
      outputDir: cleanDir,
      channel: 'commercial_distribution',
    });
    expect(cleanRes.ok).toBe(false); // 因存在被拦截资产，ok=false 诚实指示未全量通过
    expect(cleanRes.exportedCount).toBe(2); // stage-main + sfx-sparkle
    expect(cleanRes.blockedCount).toBe(2); // bad-sfx-asset (unpublished) + crosspet-nc-bg (CC BY-NC-SA)
    expect(cleanRes.blockedAssets.some((b) => b.assetId === 'crosspet-nc-bg' && b.reason.includes('CC BY-NC-SA 4.0'))).toBe(true);
    expect(existsSync(join(cleanDir, 'assets', 'crosspet-nc-bg-v1-src-stage-v1.png'))).toBe(false);
    expect(existsSync(join(cleanDir, 'assets', 'stage-main-v1-src-stage-v1.png'))).toBe(true);
    expect(existsSync(cleanRes.manifestPath)).toBe(true);

    // 持久化重载与过滤查询验证
    const reloaded = new AssetRegistryV2({ userDataDir: dir });
    expect(reloaded.listAssets({ characterId: 'char_xiaojing' })).toHaveLength(3);
    expect(reloaded.listAssets({ category: 'sound_sfx' })).toHaveLength(2);
    expect(reloaded.getAsset('stage-main')?.activeVersionId).toBe('v1');
  });
});
