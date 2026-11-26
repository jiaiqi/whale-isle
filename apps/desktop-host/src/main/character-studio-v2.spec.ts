import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CharacterBibleStore,
  CharacterStudioV2,
  CROSSPET_ATTRIBUTION,
  evaluateAssetDistributionPolicy,
  inspectLive2dOrLayered2d,
} from './character-studio-v2';
import { readCustomCharacters, invalidateCustomCharacters } from './custom-character';
import { MediaGenerationGateway } from './media-gateway';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const bundledCrossPetChars = join(repoRoot, 'assets', 'pet-packs', 'crosspet', 'characters');

// 随包 CrossPet 素材（约 2GB 二进制）按仓库约定不入库，由 `pnpm sync:pet-packs` 幂等拉取；
// CI 不拉取，因此依赖真实随包目录的用例在无素材环境如实跳过，不伪造通过。
const crossPetBundlePresent = existsSync(bundledCrossPetChars);

function makeMinimalPng(width = 64, height = 64): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  const crc = Buffer.alloc(4);
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc, iend]);
}

function makeTempDir(prefix = 'char-studio-v2-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('CharacterStudioV2（V2-P2-05：Character Bible / Live2D QA / 授权门禁 / CrossPet 全量导入）', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    invalidateCustomCharacters();
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CharacterBibleStore：持久化 CRUD、版本递增、参考图 QA、候选区晋升与提示词编译', async () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const store = new CharacterBibleStore(dir);

    expect(store.list()).toEqual([]);
    expect(store.get('char_xiaojing')).toBeNull();
    expect(() => store.get('../bad')).toThrow('非法');
    expect(() => store.compilePrompt('missing', 'idle')).toThrow('不存在');

    const created = store.upsert({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      traits: {
        hairstyle: '蓝白双马尾渐变长发',
        eyes: '深海青蓝瞳',
        palette: ['#3B82F6', '#F8FAFC'],
        outfit: '深海女仆装',
        proportions: '2.5头身 Q 版',
        signatureAccessories: ['迷你鲸鱼发饰'],
      },
      expressionRules: ['开心时眼睛呈弯月状'],
      styleConstraints: ['赛璐璐平涂'],
      forbiddenChanges: ['禁止删掉鲸鱼发饰'],
    });
    expect(created.version).toBe(1);

    const pngPath = join(dir, 'front.png');
    writeFileSync(pngPath, makeMinimalPng(512, 512));
    const badPath = join(dir, 'bad.png');
    writeFileSync(badPath, Buffer.from('not-an-image'));

    expect(() => store.attachReference({ characterId: 'missing', role: 'front', path: pngPath })).toThrow('不存在');
    expect(() => store.attachReference({ characterId: 'char_xiaojing', role: 'front', path: join(dir, 'none.png') })).toThrow('不存在');
    expect(() => store.attachReference({ characterId: 'char_xiaojing', role: 'front', path: badPath })).toThrow('校验失败');

    const withRef = store.attachReference({
      characterId: 'char_xiaojing',
      role: 'front',
      path: pngPath,
      approved: false,
    });
    expect(withRef.version).toBe(2);
    expect(withRef.referenceImages).toHaveLength(1);
    expect(withRef.referenceImages[0]?.approved).toBe(false);

    // 同一 path 去重并更新审批状态
    const approvedRef = store.approveReference('char_xiaojing', pngPath, true);
    expect(approvedRef.version).toBe(3);
    expect(approvedRef.referenceImages[0]?.approved).toBe(true);
    expect(() => store.approveReference('missing', pngPath, true)).toThrow('不存在');
    expect(() => store.approveReference('char_xiaojing', join(dir, 'other.png'), true)).toThrow('未绑定');

    // 重新更新主体设定时保留已绑定参考图
    const updatedMeta = store.upsert({
      characterId: 'char_xiaojing',
      displayName: '小鲸·极地',
      traits: { hairstyle: '蓝白双马尾', eyes: '冰蓝瞳', outfit: '冬装女仆' },
    });
    expect(updatedMeta.version).toBe(4);
    expect(updatedMeta.referenceImages).toHaveLength(1);

    const prompt = store.compilePrompt('char_xiaojing', 'singing', '轻柔挥手');
    expect(prompt).toContain('小鲸·极地');
    expect(prompt).toContain('singing');
    expect(prompt).toContain('轻柔挥手');

    // 与 MediaGenerationGateway 候选区审批闭环联动
    const gateway = new MediaGenerationGateway({
      userDataDir: dir,
      vaultPath: join(dir, 'vault.json'),
      hasVaultKeyImpl: () => true,
      readVaultKeyImpl: () => 'fake-key',
      generateImageImpl: async () => ({
        buffer: makeMinimalPng(256, 256),
        mimeType: 'image/png',
        model: 'gpt-image-1',
      }),
    });
    const job = await gateway.submitImageJob({
      characterId: 'char_xiaojing',
      providerId: 'openai-img',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-image-1',
      prompt: 'side view',
      poses: ['side'],
      bible: updatedMeta,
    });
    expect(job.candidates).toHaveLength(1);
    const candId = job.candidates[0]!.candidateId;
    // 未批准禁止晋升
    const blockedPromote = await store.promoteFromMediaJob('char_xiaojing', gateway, job.jobId, 'side');
    expect(blockedPromote.ok).toBe(false);
    expect((await store.promoteFromMediaJob('missing', gateway, job.jobId, 'side')).ok).toBe(false);

    gateway.reviewCandidate({
      jobId: job.jobId,
      candidateId: candId,
      decision: 'approve',
      note: '侧面一致',
      license: 'ORIGINAL_SELF_OWNED',
      allowCommercial: true,
      allowLivestream: true,
    });
    const promoted = await store.promoteFromMediaJob('char_xiaojing', gateway, job.jobId, 'side');
    expect(promoted.ok).toBe(true);
    expect(promoted.bible?.referenceImages).toHaveLength(2);

    // 重新实例化的 Store 从磁盘恢复完整记录
    writeFileSync(join(dir, 'character-bibles', 'corrupt.json'), '{broken', 'utf8');
    const reloaded = new CharacterBibleStore(dir);
    expect(reloaded.list().map((b) => b.characterId)).toEqual(['char_xiaojing']);
  });

  it('evaluateAssetDistributionPolicy：严格拦截 CC BY-NC-SA 4.0 / DEV_ONLY / 未审图进入直播或商用分发', () => {
    const ncProvenance = {
      sourceType: 'third-party-import' as const,
      author: CROSSPET_ATTRIBUTION,
      repoOrUrl: 'https://github.com/lokicorvus/crosspet',
      license: 'CC BY-NC-SA 4.0',
      allowCommercial: false,
      allowLivestream: false,
      allowRedistribution: false,
      inputRefPaths: [],
      generatedAt: new Date().toISOString(),
      sha256: 'abc123',
      reviewNotes: [],
    };
    const localCheck = evaluateAssetDistributionPolicy(ncProvenance, 'local_personal');
    expect(localCheck.allowed).toBe(true);
    expect(localCheck.licenseScope).toBe('DEV_ONLY_NON_COMMERCIAL');
    expect(localCheck.attributionRequired).toBe(true);
    expect(localCheck.attributionText).toContain('CC BY-NC-SA 4.0');

    expect(evaluateAssetDistributionPolicy(ncProvenance, 'livestream_public').allowed).toBe(false);
    expect(evaluateAssetDistributionPolicy(ncProvenance, 'commercial_distribution').allowed).toBe(false);
    expect(evaluateAssetDistributionPolicy(ncProvenance, 'redistribution').allowed).toBe(false);

    const commercialOk = {
      sourceType: 'user-upload' as const,
      license: 'SELF_OWNED_COMMERCIAL',
      allowCommercial: true,
      allowLivestream: true,
      allowRedistribution: true,
      inputRefPaths: [],
      generatedAt: new Date().toISOString(),
      sha256: 'def456',
      reviewNotes: [],
    };
    expect(evaluateAssetDistributionPolicy(commercialOk, 'commercial_distribution').allowed).toBe(true);
    expect(evaluateAssetDistributionPolicy(commercialOk, 'livestream_public').allowed).toBe(true);
    expect(evaluateAssetDistributionPolicy(commercialOk, 'redistribution').allowed).toBe(true);
    expect(evaluateAssetDistributionPolicy(commercialOk, 'commercial_distribution').licenseScope).toBe('COMMERCIAL_READY');

    const aiUnreviewed = {
      ...commercialOk,
      sourceType: 'ai-generated' as const,
      license: 'AI_GENERATED_REVIEW_REQUIRED',
      allowCommercial: false,
      allowLivestream: false,
    };
    expect(evaluateAssetDistributionPolicy(aiUnreviewed, 'livestream_public').licenseScope).toBe('REVIEW_REQUIRED');
    expect(evaluateAssetDistributionPolicy(aiUnreviewed, 'livestream_public').allowed).toBe(false);
  });

  it('inspectLive2dOrLayered2d：验证 Cubism model3.json、口型参数、路径防穿越及 2D 分层完整度', () => {
    const root = makeTempDir('live2d-qa-');
    cleanupDirs.push(root);

    // 路径不存在
    expect(inspectLive2dOrLayered2d(join(root, 'missing')).valid).toBe(false);

    // 合法 Live2D Cubism 模型（含 moc3 / 纹理 / physics / cdi3 / LipSync）
    const l2dValid = join(root, 'valid-l2d');
    mkdirSync(join(l2dValid, 'textures'), { recursive: true });
    writeFileSync(join(l2dValid, 'whale.moc3'), Buffer.from('MOC3'));
    writeFileSync(join(l2dValid, 'textures', 'tex0.png'), makeMinimalPng(1024, 1024));
    writeFileSync(join(l2dValid, 'whale.physics3.json'), '{}');
    writeFileSync(
      join(l2dValid, 'whale.cdi3.json'),
      JSON.stringify({
        Parameters: [
          { Id: 'ParamAngleX' },
          { Id: 'ParamEyeLOpen' },
          { Id: 'ParamMouthOpenY' },
        ],
      }),
    );
    const model3File = join(l2dValid, 'whale.model3.json');
    writeFileSync(
      model3File,
      JSON.stringify({
        FileReferences: {
          Moc: 'whale.moc3',
          Textures: ['textures/tex0.png'],
          Physics: 'whale.physics3.json',
          DisplayInfo: 'whale.cdi3.json',
          Expressions: [{ Name: 'happy', File: 'happy.exp3.json' }],
          Motions: { Idle: [{ File: 'idle.motion3.json' }] },
        },
        Groups: [
          { Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
          { Name: 'EyeBlink', Ids: ['ParamEyeLOpen'] },
        ],
      }),
    );

    const qaOk = inspectLive2dOrLayered2d(model3File);
    expect(qaOk.valid).toBe(true);
    expect(qaOk.format).toBe('cubism-model3');
    expect(qaOk.lipSyncReady).toBe(true);
    expect(qaOk.hasMouthOpenParam).toBe(true);
    expect(qaOk.hasEyeBlinkParams).toBe(true);
    expect(qaOk.hasHeadAngleParams).toBe(true);
    expect(qaOk.physicsPresent).toBe(true);
    expect(qaOk.expressions).toEqual(['happy']);
    expect(qaOk.motions).toEqual(['Idle']);

    // 路径穿越与损坏字段拦截
    const l2dBad = join(root, 'bad-l2d');
    mkdirSync(l2dBad, { recursive: true });
    writeFileSync(
      join(l2dBad, 'bad.model3.json'),
      JSON.stringify({
        FileReferences: {
          Moc: '../escape.moc3',
          Textures: ['../secret.png', 'missing.png'],
          Physics: 'missing.physics3.json',
          DisplayInfo: 'broken.cdi3.json',
        },
      }),
    );
    writeFileSync(join(l2dBad, 'broken.cdi3.json'), '{not-json');
    const qaBad = inspectLive2dOrLayered2d(l2dBad);
    expect(qaBad.valid).toBe(false);
    expect(qaBad.errors.some((e) => e.includes('越界'))).toBe(true);
    expect(qaBad.warnings.some((w) => w.includes('cdi3.json'))).toBe(true);

    const l2dCorrupt = join(root, 'corrupt-l2d');
    mkdirSync(l2dCorrupt, { recursive: true });
    writeFileSync(join(l2dCorrupt, 'corrupt.model3.json'), '{bad');
    expect(inspectLive2dOrLayered2d(l2dCorrupt).valid).toBe(false);

    // 2D 分层素材包（含 layers.json 完整分层 & 缺层目录）
    const layeredDir = join(root, 'layered-ok');
    mkdirSync(layeredDir, { recursive: true });
    const layers = ['hair_front.png', 'hair_back.png', 'eyes.png', 'brows.png', 'mouth.png', 'face.png', 'body.png', 'outfit.png', 'accessory_tail.png'];
    for (const f of layers) writeFileSync(join(layeredDir, f), makeMinimalPng(256, 256));
    writeFileSync(
      join(layeredDir, 'layers.json'),
      JSON.stringify({ layers: layers.map((f) => ({ name: f, file: f })) }),
    );
    const layeredQa = inspectLive2dOrLayered2d(layeredDir);
    expect(layeredQa.valid).toBe(true);
    expect(layeredQa.format).toBe('layered-2d-pack');
    expect(layeredQa.missingRecommendedLayers).toEqual([]);
    expect(layeredQa.lipSyncReady).toBe(true);

    const partialLayered = join(root, 'layered-partial');
    mkdirSync(partialLayered, { recursive: true });
    writeFileSync(join(partialLayered, 'other_bg.png'), makeMinimalPng(128, 128));
    const partialQa = inspectLive2dOrLayered2d(partialLayered);
    expect(partialQa.valid).toBe(true);
    expect(partialQa.missingRecommendedLayers).toEqual(['hair_front', 'eyes', 'mouth', 'body']);

    const emptyDir = join(root, 'empty-dir');
    mkdirSync(emptyDir, { recursive: true });
    expect(inspectLive2dOrLayered2d(emptyDir).valid).toBe(false);
  });

  it.skipIf(!crossPetBundlePresent)('importCrossPetPack：真实随包 30 角色全量合法导入、Character Bible 自动建档与商业/直播硬拦截', () => {
    const userData = makeTempDir('crosspet-real-');
    cleanupDirs.push(userData);
    const studio = new CharacterStudioV2({
      userDataDir: userData,
      packsRoot: join(repoRoot, 'assets', 'pet-packs'),
    });

    // 执行真实 30 角色全量导入（8 基础 + 7 皮肤 + 15 彩蛋）
    const res = studio.importCrossPetPack({});
    expect(res.ok).toBe(true);
    expect(res.sourceDir).toBe(bundledCrossPetChars);
    expect(res.licenseFileFound).toBe(true);
    expect(res.totalDiscovered).toBe(30);
    expect(res.importedCount).toBe(30);
    expect(res.skippedCount).toBe(0);
    expect(res.failedCount).toBe(0);
    expect(res.entries.every((e) => e.licenseScope === 'DEV_ONLY_NON_COMMERCIAL')).toBe(true);
    expect(res.entries.every((e) => !e.provenance.allowCommercial && !e.provenance.allowLivestream)).toBe(true);

    // 已落盘至 custom-characters，且 readCustomCharacters 立即全部可见
    const customLoaded = readCustomCharacters(userData);
    expect(customLoaded.entries).toHaveLength(30);
    expect(customLoaded.errors).toHaveLength(0);

    // 8 个基础角色自动绑定了 CharacterBible
    expect(studio.bibles.list()).toHaveLength(8);
    expect(studio.bibles.get('custom-cp-deepseek')?.referenceImages[0]?.approved).toBe(true);

    // 2D 注册表完整记录并执行商业/直播硬拦截
    const pkgs = studio.list2dPackages();
    expect(pkgs).toHaveLength(30);
    const localOk = studio.check2dDistribution('crosspet-import-cp-deepseek', 'local_personal');
    expect(localOk.allowed).toBe(true);
    expect(localOk.attributionRequired).toBe(true);
    const liveBlocked = studio.check2dDistribution('crosspet-import-cp-deepseek', 'livestream_public');
    expect(liveBlocked.allowed).toBe(false);
    expect(liveBlocked.reason).toContain('CC BY-NC-SA 4.0');
    const commercialBlocked = studio.check2dDistribution('crosspet-import-cp-deepseek', 'commercial_distribution');
    expect(commercialBlocked.allowed).toBe(false);

    // 重复导入默认 skip，开启 overwrite 后覆写更新
    const secondSkip = studio.importCrossPetPack({ characterIds: ['deepseek'], overwrite: false });
    expect(secondSkip.skippedCount).toBe(1);
    expect(secondSkip.importedCount).toBe(0);
    const secondOverwrite = studio.importCrossPetPack({ characterIds: ['deepseek'], overwrite: true });
    expect(secondOverwrite.importedCount).toBe(1);
    expect(existsSync(join(userData, 'pet-characters', 'cp-deepseek', '.provenance.json'))).toBe(true);
  });

  it.skipIf(!crossPetBundlePresent)('importCrossPetPack：过滤器与单角色目录形式导入（依赖真实随包素材）', () => {
    const userData = makeTempDir('crosspet-filter-');
    cleanupDirs.push(userData);
    const studio = new CharacterStudioV2({
      userDataDir: userData,
      packsRoot: join(repoRoot, 'assets', 'pet-packs'),
    });

    // 仅导入 base（过滤 skins & eggs）
    const baseOnly = studio.importCrossPetPack({ includeSkins: false, includeEggs: false });
    expect(baseOnly.importedCount).toBe(8);

    // 单角色目录形式导入
    const singleChar = studio.importCrossPetPack({
      sourceDir: join(bundledCrossPetChars, 'claude-saint'),
      overwrite: true,
    });
    expect(singleChar.importedCount).toBe(1);
    expect(singleChar.entries[0]?.category).toBe('skin');
  });

  it('importCrossPetPack & register2dPackage：坏包/缺源容错校验', () => {
    const userData = makeTempDir('crosspet-edge-');
    cleanupDirs.push(userData);
    const studio = new CharacterStudioV2({
      userDataDir: userData,
      packsRoot: join(repoRoot, 'assets', 'pet-packs'),
    });

    const syntheticRoot = makeTempDir('crosspet-broken-');
    cleanupDirs.push(syntheticRoot);
    mkdirSync(join(syntheticRoot, 'no-json'), { recursive: true });
    mkdirSync(join(syntheticRoot, 'bad-json'), { recursive: true });
    writeFileSync(join(syntheticRoot, 'bad-json', 'character.json'), '{bad');
    mkdirSync(join(syntheticRoot, 'corrupt-img'), { recursive: true });
    writeFileSync(join(syntheticRoot, 'corrupt-img', 'character.json'), JSON.stringify({ name: '坏图角色' }));
    writeFileSync(join(syntheticRoot, 'corrupt-img', 'idle.png'), Buffer.from('not-png'));
    const brokenRes = studio.importCrossPetPack({ sourceDir: syntheticRoot });
    expect(brokenRes.ok).toBe(false);
    expect(brokenRes.failedCount).toBe(3);
    expect(brokenRes.warnings.length).toBeGreaterThanOrEqual(1);

    expect(() => studio.importCrossPetPack({ sourceDir: join(syntheticRoot, 'missing-dir') })).toThrow('不存在');
    expect(() => studio.check2dDistribution('not-exist', 'local_personal')).toThrow('不存在');
    expect(() =>
      studio.register2dPackage({
        characterId: 'char_xiaojing',
        displayName: 'Missing',
        kind: 'live2d',
        rootDir: join(syntheticRoot, 'missing-dir'),
        provenance: {
          sourceType: 'user-upload',
          license: 'MIT',
          allowCommercial: true,
          allowLivestream: true,
          allowRedistribution: true,
          inputRefPaths: [],
          generatedAt: new Date().toISOString(),
          sha256: 'abc',
          reviewNotes: [],
        },
      }),
    ).toThrow('不存在');

    // 注册自定义商用 2D sprite 包验证 filter 与 COMMERCIAL_READY
    const customDir = join(syntheticRoot, 'custom-sprite');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'idle.png'), makeMinimalPng(64, 64));
    const registered = studio.register2dPackage({
      characterId: 'char_custom_ok',
      displayName: '自制商用精灵',
      kind: 'sprite-2d',
      rootDir: customDir,
      provenance: {
        sourceType: 'user-upload',
        license: 'SELF_OWNED_COMMERCIAL',
        allowCommercial: true,
        allowLivestream: true,
        allowRedistribution: true,
        inputRefPaths: [],
        generatedAt: new Date().toISOString(),
        sha256: '123',
        reviewNotes: [],
      },
    });
    expect(studio.list2dPackages('char_custom_ok')).toHaveLength(1);
    expect(studio.check2dDistribution(registered.packageId, 'commercial_distribution').allowed).toBe(true);
    expect(JSON.parse(readFileSync(join(userData, 'studio-2d-assets', 'registry.json'), 'utf8'))).toBeTruthy();
  });
});
