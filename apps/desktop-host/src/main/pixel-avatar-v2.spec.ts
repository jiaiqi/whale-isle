import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterBibleStore } from './character-studio-v2';
import type { RawImage } from './image-pipeline';
import {
  decodeRgbaPng,
  encodeRgbaPng,
  PixelAvatarPipelineV2,
  toStardewCharacterId,
  verifyStardewAvatarExport,
} from './pixel-avatar-v2';
import { MOD_FOLDER } from './stardew-avatar-host';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const publishDir = join(repoRoot, 'mods', 'stardew-avatar-sync', 'publish');

// publish/WhaleIsleAvatar.dll 是编译产物且不入库；CI 在单测前执行 `node tools/scripts/build-avatar-mod.mjs` 构建。
// 无 dotnet 的开发机上相关用例如实跳过（或按「未比对」断言 undefined），不伪造通过。
const publishDllPresent = existsSync(join(publishDir, 'WhaleIsleAvatar.dll'));

function makeTempDir(prefix = 'pixel-avatar-v2-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function make4x6CharacterSheet(cellW = 32, cellH = 64, whiteBg = true): RawImage {
  const width = cellW * 6;
  const height = cellH * 4;
  const data = new Uint8ClampedArray(width * height * 4);
  if (whiteBg) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  const palette: Array<[number, number, number]> = [
    [59, 130, 246], // 蓝发
    [255, 224, 189], // 肤色
    [29, 78, 216], // 深蓝裙
    [15, 23, 42], // 深色描边
  ];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const [r, g, b] = palette[(row + col) % palette.length]!;
      const x0 = col * cellW + 4;
      const x1 = (col + 1) * cellW - 4;
      const y0 = row * cellH + 4;
      const y1 = (row + 1) * cellH - 2;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const idx = (y * width + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;
        }
      }
    }
  }
  return { width, height, data };
}

function buildFilteredPng(
  width: number,
  height: number,
  colorType: 2 | 6,
  filterTypes: number[],
): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const makeChunk = (type: string, body: Buffer): Buffer => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    // verify-free test chunk (decodeRgbaPng inspects chunk lengths & payloads cleanly)
    const crc = Buffer.alloc(4);
    return Buffer.concat([len, typeBuf, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const f = filterTypes[y % filterTypes.length]!;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x += 1) {
      raw[y * (stride + 1) + 1 + x] = (x + y * 3) & 0xff;
    }
  }
  return Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', deflateSync(raw)), makeChunk('IEND', Buffer.alloc(0))]);
}

describe('PixelAvatarPipelineV2（V2-P2-06：11 步像素流水线与 Stardew Avatar Mod 导出核验）', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('encodeRgbaPng / decodeRgbaPng：支持 RGBA/RGB、PNG 滤波器 0-4 与畸形 PNG 拒收', () => {
    const src = make4x6CharacterSheet(16, 32, true);
    const encoded = encodeRgbaPng(src);
    const decoded = decodeRgbaPng(encoded);
    expect(decoded.width).toBe(src.width);
    expect(decoded.height).toBe(src.height);
    expect(Buffer.from(decoded.data).equals(Buffer.from(src.data))).toBe(true);

    // 覆盖 PNG Filter 0..4（含 Paeth 各分支）与 8-bit RGB 解码
    const multiFilterRgb = buildFilteredPng(8, 6, 2, [0, 1, 2, 3, 4]);
    const rgbDecoded = decodeRgbaPng(multiFilterRgb);
    expect(rgbDecoded.width).toBe(8);
    expect(rgbDecoded.height).toBe(6);
    expect(rgbDecoded.data[3]).toBe(255);

    const multiFilterRgba = buildFilteredPng(8, 6, 6, [4, 3, 2, 1, 0]);
    expect(decodeRgbaPng(multiFilterRgba).data.length).toBe(8 * 6 * 4);

    // 异常入参校验
    expect(() => encodeRgbaPng({ width: 0, height: 10, data: new Uint8ClampedArray(0) })).toThrow('无效 RawImage');
    expect(() => decodeRgbaPng(Buffer.from('not-png'))).toThrow('签名无效');
    const badFilter = buildFilteredPng(2, 1, 6, [9]);
    expect(() => decodeRgbaPng(badFilter)).toThrow('滤波器类型');
    const truncatedChunk = Buffer.concat([encoded.subarray(0, 8), Buffer.from([0x00, 0x10, 0x00, 0x00]), Buffer.alloc(32)]);
    expect(() => decodeRgbaPng(truncatedChunk)).toThrow('越界');
  });

  it('toStardewCharacterId 与 verifyStardewAvatarExport 异常路径校验', () => {
    expect(toStardewCharacterId('char_xiaojing')).toBe('char-xiaojing');
    expect(() => toStardewCharacterId('___')).toThrow('无法映射');

    const root = makeTempDir('verify-mod-');
    cleanupDirs.push(root);

    // 目录不存在
    expect(verifyStardewAvatarExport(join(root, 'none')).ok).toBe(false);

    // 缺少全部关键文件
    const modDir = join(root, MOD_FOLDER);
    mkdirSync(modDir, { recursive: true });
    const missingFiles = verifyStardewAvatarExport(modDir, publishDir);
    expect(missingFiles.ok).toBe(false);
    expect(missingFiles.issues.length).toBeGreaterThanOrEqual(3);
    expect(missingFiles.realDeviceInGameVisualVerified).toBe(false);

    // 损坏 JSON / 空 DLL / 路径穿越 / 尺寸不匹配
    writeFileSync(join(modDir, 'manifest.json'), '{bad');
    writeFileSync(join(modDir, 'WhaleIsleAvatar.dll'), Buffer.alloc(0));
    writeFileSync(join(modDir, 'active-avatar.json'), '{bad');
    expect(verifyStardewAvatarExport(modDir).issues.length).toBeGreaterThanOrEqual(3);

    writeFileSync(join(modDir, 'manifest.json'), JSON.stringify({ UniqueID: 'Other.Id', Version: '' }));
    writeFileSync(join(modDir, 'WhaleIsleAvatar.dll'), Buffer.from('FAKE_DLL'));
    writeFileSync(
      join(modDir, 'active-avatar.json'),
      JSON.stringify({
        version: 1,
        characterId: 'char-xiaojing',
        displayName: '小鲸',
        preset: { hair: 0, hairColor: '#000000', shirt: 0, pantsColor: '#000000', skin: 0, hatId: -1 },
        spriteSheetPath: '../escape.png',
        liveliness: true,
      }),
    );
    const badExport = verifyStardewAvatarExport(modDir, publishDir);
    expect(badExport.ok).toBe(false);
    // publish/ 无 DLL 时实现如实返回 undefined（未比对），有 DLL 时必然与 FAKE_DLL 不匹配
    expect(badExport.dllMatchesPublish).toBe(publishDllPresent ? false : undefined);
    expect(badExport.issues.some((i) => i.includes('穿越'))).toBe(true);

    // 非法精灵图尺寸 + tier 不一致
    writeFileSync(join(modDir, 'bad-size.png'), encodeRgbaPng({ width: 10, height: 10, data: new Uint8ClampedArray(400) }));
    writeFileSync(
      join(modDir, 'active-avatar.json'),
      JSON.stringify({
        version: 1,
        characterId: 'char-xiaojing',
        displayName: '小鲸',
        preset: { hair: 0, hairColor: '#000000', shirt: 0, pantsColor: '#000000', skin: 0, hatId: -1 },
        spriteSheetPath: 'bad-size.png',
        spriteTier: '2x',
        liveliness: true,
      }),
    );
    expect(verifyStardewAvatarExport(modDir).issues.some((i) => i.includes('网格规范'))).toBe(true);
  });

  it.skipIf(!publishDllPresent)('PixelAvatarPipelineV2：完整 11 步流水线（1x/2x/4x）、审查门禁与 Stardew Avatar Mod 原子导出核验', () => {
    const userData = makeTempDir('pixel-v2-user-');
    const modsRoot = makeTempDir('pixel-v2-mods-');
    const coopModsRoot = makeTempDir('pixel-v2-coop-');
    cleanupDirs.push(userData, modsRoot, coopModsRoot);

    const bibles = new CharacterBibleStore(userData);
    bibles.upsert({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      traits: {
        hairstyle: '海蓝双马尾',
        eyes: '碧蓝大眼',
        palette: ['#3b82f6'],
        outfit: '深海女仆装',
        signatureAccessories: ['迷你鲸鱼发夹'],
      },
    });

    const pipeline = new PixelAvatarPipelineV2({
      userDataDir: userData,
      repoRoot,
      bibles,
      defaultModsDirOverride: modsRoot,
    });

    const rawPngPath = join(userData, 'raw-4x6.png');
    writeFileSync(rawPngPath, encodeRgbaPng(make4x6CharacterSheet(32, 64, true)));

    // 2x 完整流水线 + Bible 锁定
    const job2x = pipeline.run11StepPipeline({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      sourcePngPath: rawPngPath,
      tier: '2x',
      license: 'SELF_OWNED_COMMERCIAL',
      allowCommercial: true,
      allowLivestream: true,
    });
    expect(job2x.status).toBe('review_required');
    expect(job2x.steps).toHaveLength(11);
    expect(job2x.compiledPrompt).toContain('海蓝双马尾');
    expect(job2x.qa?.valid).toBe(true);
    expect(job2x.qa?.width).toBe(384);
    expect(job2x.qa?.height).toBe(256);
    expect(job2x.steps[10]?.status).toBe('skipped');

    // 未批准禁止直接导出
    const blockedExport = pipeline.exportToStardew({ jobId: job2x.jobId });
    expect(blockedExport.ok).toBe(false);
    expect(blockedExport.error).toContain('approved');

    // 批准并一键安装 Mod + 原子导出 + 核验
    const reviewed = pipeline.reviewJob({ jobId: job2x.jobId, decision: 'approve', note: '2x 像素轮廓清晰' });
    expect(reviewed.ok).toBe(true);
    const exported = pipeline.exportToStardew({ jobId: job2x.jobId });
    expect(exported.ok).toBe(true);
    expect(exported.job?.status).toBe('published');
    expect(exported.job?.steps[10]?.status).toBe('ok');
    expect(exported.verification?.ok).toBe(true);
    expect(exported.verification?.dllCompiled).toBe(true);
    expect(exported.verification?.dllMatchesPublish).toBe(true);
    expect(exported.verification?.spriteTier).toBe('2x');
    expect(exported.verification?.spriteWidth).toBe(384);
    expect(exported.verification?.spriteHeight).toBe(256);
    expect(exported.verification?.realDeviceInGameVisualVerified).toBe(false);

    // 联机隔离 profile 导出
    mkdirSync(join(coopModsRoot, MOD_FOLDER), { recursive: true });
    writeFileSync(join(coopModsRoot, MOD_FOLDER, 'manifest.json'), readFileSync(join(publishDir, 'manifest.json')));
    writeFileSync(join(coopModsRoot, MOD_FOLDER, 'WhaleIsleAvatar.dll'), readFileSync(join(publishDir, 'WhaleIsleAvatar.dll')));
    const coopExport = pipeline.exportToStardew({
      jobId: job2x.jobId,
      profileModsDir: coopModsRoot,
      installModIfMissing: false,
    });
    expect(coopExport.ok).toBe(true);
    expect(coopExport.verification?.syncedCharacterId).toBe('char-xiaojing');

    // 4x 无 Bible 流程 + CC BY-NC-SA 直播隔离告警记录 + 重载持久化
    const job4x = pipeline.run11StepPipeline({
      characterId: 'custom-guest',
      displayName: '访客小鱼',
      sourcePngPath: rawPngPath,
      tier: '4x',
      sourceType: 'third-party-import',
      license: 'CC BY-NC-SA 4.0',
      allowCommercial: false,
      allowLivestream: false,
    });
    expect(job4x.status).toBe('review_required');
    expect(job4x.qa?.width).toBe(768);
    expect(job4x.qa?.height).toBe(512);
    expect(job4x.steps[1]?.status).toBe('warn');
    expect(job4x.steps[9]?.status).toBe('warn');
    expect(pipeline.verifyExport(modsRoot).ok).toBe(true);

    // 写入损坏候选并测试磁盘重建恢复
    mkdirSync(join(userData, 'pixel-candidates', 'corrupt-job'), { recursive: true });
    writeFileSync(join(userData, 'pixel-candidates', 'corrupt-job', 'job.json'), '{bad');
    const reloaded = new PixelAvatarPipelineV2({
      userDataDir: userData,
      repoRoot,
      defaultModsDirOverride: modsRoot,
    });
    expect(reloaded.listJobs('char_xiaojing')).toHaveLength(1);
    expect(reloaded.listJobs()).toHaveLength(2);
  });

  it('PixelAvatarPipelineV2：异常输入、全白图、空帧超限与 QA 失败禁止批准门禁', () => {
    const userData = makeTempDir('pixel-v2-err-');
    cleanupDirs.push(userData);
    const pipeline = new PixelAvatarPipelineV2({ userDataDir: userData, repoRoot });

    const missing = pipeline.run11StepPipeline({
      characterId: 'char-test',
      displayName: 'Missing',
      sourcePngPath: join(userData, 'none.png'),
    });
    expect(missing.status).toBe('validation_failed');
    expect(pipeline.reviewJob({ jobId: missing.jobId, decision: 'approve' }).ok).toBe(false);

    const badPng = join(userData, 'bad.png');
    writeFileSync(badPng, Buffer.from('corrupt'));
    expect(pipeline.run11StepPipeline({ characterId: 'char-test', displayName: 'Bad', sourcePngPath: badPng }).status).toBe('validation_failed');

    const blankPng = join(userData, 'blank.png');
    const blankImg = { width: 96, height: 128, data: new Uint8ClampedArray(96 * 128 * 4).fill(255) };
    writeFileSync(blankPng, encodeRgbaPng(blankImg));
    expect(pipeline.run11StepPipeline({ characterId: 'char-test', displayName: 'Blank', sourcePngPath: blankPng }).status).toBe('validation_failed');

    // reject 之后禁止导出
    const okPng = join(userData, 'ok.png');
    writeFileSync(okPng, encodeRgbaPng(make4x6CharacterSheet(16, 32, false)));
    const okJob = pipeline.run11StepPipeline({
      characterId: 'char-reject',
      displayName: 'RejectMe',
      sourcePngPath: okPng,
      tier: '1x',
    });
    expect(pipeline.reviewJob({ jobId: okJob.jobId, decision: 'reject', note: '色偏太大' }).job?.status).toBe('restricted');
    expect(pipeline.exportToStardew({ jobId: okJob.jobId }).ok).toBe(false);
    expect(pipeline.exportToStardew({ jobId: 'missing-id' }).ok).toBe(false);
    expect(pipeline.reviewJob({ jobId: 'missing-id', decision: 'approve' }).ok).toBe(false);
  });
});
