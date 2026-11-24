/**
 * 随包素材（T-M6-45 批次 1.1）：路径解析、whale-pet:// 穿越防护、9 包直读与工坊目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import {
  createPetPacksProtocolHandler,
  PET_PACKS_SCHEME,
  readBundledAboutmePacks,
  crossPetLinesOf,
  readCrossPetCharacters,
  readPetStudioCatalog,
  resolvePetPacksAsset,
  resolvePetPacksDir,
} from './pet-packs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pet-packs-'));
  dirs.push(dir);
  return dir;
}

function writeFixturePack(root: string): void {
  const base = join(root, 'aboutme-pets');
  mkdirSync(join(base, 'pets', 'dsh', 'spritesheet'), { recursive: true });
  mkdirSync(join(base, 'pets', 'dsh', 'audio'), { recursive: true });
  writeFileSync(join(base, 'pets.json'), JSON.stringify({
    pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }],
  }));
  writeFileSync(join(base, 'pets', 'dsh', 'manifest.json'), JSON.stringify({ canvasWidth: 640, canvasHeight: 360, idleAnimationId: '待机呼吸' }));
  writeFileSync(join(base, 'pets', 'dsh', 'actions.json'), JSON.stringify({
    animations: [
      { id: '待机呼吸', category: '待机', sources: { webp: 'spritesheet/待机呼吸.webp' }, spritesheet: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, fps: 12 } },
      { id: '吃月饼', category: '吃', sources: { webp: 'spritesheet/吃月饼.webp' }, audio: 'audio/吃月饼.m4a', spritesheet: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, fps: 12 } },
    ],
  }));
  writeFileSync(join(base, 'pets', 'dsh', 'spritesheet', '待机呼吸.webp'), 'webp');
  for (const file of ['avatar.webp', 'portrait.webp', 'portrait-card.webp']) {
    writeFileSync(join(base, 'pets', 'dsh', file), 'webp');
  }
}

describe('resolvePetPacksDir', () => {
  it('打包态取 resourcesPath/pet-packs；开发态取仓库 assets/pet-packs', () => {
    expect(resolvePetPacksDir({ isPackaged: true, resourcesPath: '/App/Resources', repoRoot: '/repo' })).toBe('/App/Resources/pet-packs');
    expect(resolvePetPacksDir({ isPackaged: false, resourcesPath: '/x', repoRoot: '/repo' })).toBe('/repo/assets/pet-packs');
  });
});

describe('whale-pet:// 只读协议与穿越校验', () => {
  it('白名单扩展名 + 真实存在的文件才放行；中文路径与百分号编码正确解码', () => {
    const root = tempRoot();
    writeFixturePack(root);
    const url = `${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/${encodeURIComponent('spritesheet')}/${encodeURIComponent('待机呼吸.webp')}`;
    const resolved = resolvePetPacksAsset(root, url);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.mime).toBe('image/webp');
      expect(resolved.path.endsWith('待机呼吸.webp')).toBe(true);
    }
  });

  it('拒绝 ..、编码穿越、绝对路径、反斜杠、非白名单类型与缺失文件', () => {
    const root = tempRoot();
    writeFixturePack(root);
    const cases: Array<[string, number]> = [
      // 裸 `..` 与 `%2e%2e` 都会被 URL 解析器规范化掉（结果仍锁在根内 → 404），
      // 真正的穿越以 %2f 编码抵达协议层，必须 403
      [`${PET_PACKS_SCHEME}://aboutme-pets/pets/%2e%2e/%2e%2e/secret.webp`, 404],
      [`${PET_PACKS_SCHEME}://aboutme-pets/pets/%2E%2E/%2E%2E/secret.webp`, 404],
      [`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/..%2f..%2fsecret.webp`, 403],
      [`${PET_PACKS_SCHEME}://aboutme-pets//etc/passwd`, 403],
      [`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/a%5Cb.webp`, 403],
      [`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/app.mjs`, 403],
      [`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/none.webp`, 404],
      [`${PET_PACKS_SCHEME}://`, 404],
      ['https://evil.example/a.webp', 400],
      ['http://[bad', 400],
    ];
    for (const [url, status] of cases) {
      const resolved = resolvePetPacksAsset(root, url);
      expect(resolved.ok, url).toBe(false);
      if (!resolved.ok) expect(resolved.status, url).toBe(status);
    }
  });

  it('协议处理器：非 GET 405，穿越 403 且完全不触达文件读取', async () => {
    const root = tempRoot();
    writeFixturePack(root);
    const fetchFile = vi.fn(async () => new Response('ok'));
    const handler = createPetPacksProtocolHandler({ packsRoot: root, fetchFile });
    expect((await handler(new Request(`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/待机呼吸.webp`, { method: 'POST' }))).status).toBe(405);
    expect((await handler(new Request(`${PET_PACKS_SCHEME}://aboutme-pets/pets/%2e%2e/%2e%2e/etc/passwd`))).status).toBe(403);
    expect(fetchFile).not.toHaveBeenCalled();
    expect((await handler(new Request(`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/none.webp`))).status).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('合法请求委托注入的 fetchFile，并为读盘异常回 404', async () => {
    const root = tempRoot();
    writeFixturePack(root);
    const ok = vi.fn(async () => new Response('bytes'));
    const good = createPetPacksProtocolHandler({ packsRoot: root, fetchFile: ok });
    const response = await good(new Request(`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/待机呼吸.webp`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(await response.text()).toBe('bytes');
    expect(ok).toHaveBeenCalledOnce();

    const broken = createPetPacksProtocolHandler({ packsRoot: root, fetchFile: async () => { throw new Error('EIO'); } });
    expect((await broken(new Request(`${PET_PACKS_SCHEME}://aboutme-pets/pets/dsh/spritesheet/待机呼吸.webp`))).status).toBe(404);
  });
});

describe('随包 9 包直读与工坊目录', () => {
  it('只装了一个包时只产出该角色；manifest 全部走 whale-pet://，槽位/音轨正确', () => {
    const root = tempRoot();
    writeFixturePack(root);
    const bundled = readBundledAboutmePacks(root);
    expect(bundled.characters).toHaveLength(1);
    const character = bundled.characters[0];
    expect(character).toMatchObject({ id: 'aboutme-dsh', packId: 'dsh-pet', builtin: true, actionCount: 2, audioClipCount: 1 });
    const manifest = bundled.manifests.get('aboutme-dsh');
    expect(manifest?.renderer).toBe('sprite-sheet');
    expect(manifest?.actions).toHaveLength(11);
    const eat = manifest?.actions.find((entry) => entry.actionState === 'eat_rice');
    expect(eat?.clips[0]?.audioPath).toMatch(/^whale-pet:\/\/aboutme-pets\/pets\/dsh\/audio\//);
    expect(eat?.clips[0]?.audioPath).toContain(encodeURIComponent('吃月饼.m4a'));
    expect(manifest?.ambientPool).toHaveLength(0);
  });

  it('素材缺失或损坏时只记错误，不抛异常；目录始终满足契约', () => {
    const empty = tempRoot();
    expect(readBundledAboutmePacks(empty).characters).toHaveLength(0);
    const catalog = readPetStudioCatalog(empty);
    expect(catalog.packs).toHaveLength(9);
    expect(catalog.packs.every((pack) => !pack.installed)).toBe(true);
    expect(catalog.actions).toHaveLength(0);
    expect(catalog.slots).toHaveLength(0);

    const broken = tempRoot();
    mkdirSync(join(broken, 'aboutme-pets'), { recursive: true });
    writeFileSync(join(broken, 'aboutme-pets', 'pets.json'), '{bad json');
    const parsed = readBundledAboutmePacks(broken);
    expect(parsed.characters).toHaveLength(0);
    expect(parsed.errors[0]).toContain('pets.json');
  });

  it('目录汇总动作/槽位/皮肤分类/字体', () => {
    const root = tempRoot();
    writeFixturePack(root);
    const fontDir = join(root, 'crosspet', 'app', 'web', 'fonts', 'notebook');
    mkdirSync(fontDir, { recursive: true });
    writeFileSync(join(fontDir, 'long-cang.woff2'), 'font');
    const skinDir = join(root, 'crosspet', 'characters', 'deepseek-hoodie');
    mkdirSync(skinDir, { recursive: true });
    writeFileSync(join(skinDir, 'character.json'), JSON.stringify({ name: 'DeepSeek', outfit: '连帽衫', accent: '#3b5bb5' }));
    writeFileSync(join(skinDir, 'avatar.webp'), 'webp');
    const eggDir = join(root, 'crosspet', 'characters', 'egg-deepseek');
    mkdirSync(eggDir, { recursive: true });
    writeFileSync(join(eggDir, 'character.json'), JSON.stringify({ name: '蛋蛋' }));
    writeFileSync(join(eggDir, 'pop.webp'), 'webp');
    mkdirSync(join(root, 'fonts'), { recursive: true });
    writeFileSync(join(root, 'fonts', '上首软糖体.ttf'), 'ttf');

    const catalog = readPetStudioCatalog(root);
    expect(catalog.actions).toHaveLength(2);
    expect(catalog.actions[1]).toMatchObject({
      clipId: '吃月饼', hasAudio: true, frameCount: 15, sampleFps: 12,
      frameWidth: 640, frameHeight: 360, columns: 8, rows: 2,
    });
    // 上游 preview.json 语义：每个角色自己的 idleAnimationId 与动作数
    expect(catalog.packs.find((pack) => pack.slug === 'dsh')).toMatchObject({ idleClipId: '待机呼吸', actionCount: 2 });
    expect(catalog.actions[1]?.spriteUrl).toContain('whale-pet://aboutme-pets/pets/dsh/spritesheet/');
    expect(catalog.slots.find((slot) => slot.slot === 'eat_rice')?.clipIds).toEqual(['吃月饼']);
    expect(catalog.skins.map((skin) => [skin.id, skin.kind])).toEqual([['deepseek-hoodie', 'skin'], ['egg-deepseek', 'egg']]);
    expect(catalog.skins[0]?.previewUrl).toContain('avatar.webp');
    expect(catalog.fonts.map((font) => font.id)).toEqual(['long-cang', 'shangshou-gummy']);
  });
});


describe('CrossPet pose-skin 角色（T-M6-48）', () => {
  function writeCrossPet(root: string): void {
    const dir = join(root, 'crosspet', 'characters', 'deepseek');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'character.json'), JSON.stringify({
      name: 'DeepSeek', outfit: '女仆装', accent: '#3b5bb5',
      lines: { idle: ['……', '咕噜咕噜'], pat: ['嘿嘿～'], sleeping: ['Zzz'] },
    }));
    for (const pose of ['idle', 'idle-blink', 'pat', 'happy', 'sleeping', 'fest_newyear']) {
      writeFileSync(join(dir, `${pose}.webp`), 'webp');
    }
    for (const file of ['avatar.webp', 'portrait.webp', 'portrait-card.webp']) {
      writeFileSync(join(dir, file), 'webp');
    }
    const egg = join(root, 'crosspet', 'characters', 'egg-deepseek');
    mkdirSync(egg, { recursive: true });
    writeFileSync(join(egg, 'character.json'), JSON.stringify({ name: '蛋蛋' }));
    for (const pose of ['pop', 'caught', 'pretend']) writeFileSync(join(egg, `${pose}.webp`), 'webp');
  }

  it('基础角色生成 pose-skin manifest、挂皮肤与台词；egg 标记为彩蛋', () => {
    const root = tempRoot();
    writeCrossPet(root);
    const result = readCrossPetCharacters(root);
    expect(result.errors).toEqual([]);
    const base = result.characters.find((character) => character.id === 'crosspet-deepseek');
    expect(base).toMatchObject({ displayName: 'DeepSeek', packId: 'crosspet-deepseek', builtin: true });
    const manifest = result.manifests.get('crosspet-deepseek');
    expect(manifest?.renderer).toBe('pose-skin');
    expect(manifest?.actions.find((action) => action.actionState === 'idle')?.clips[0]?.clipId).toBe('idle');
    expect(manifest?.actions.find((action) => action.actionState === 'happy_maid')?.clips[0]?.clipId).toBe('pat');
    expect(manifest?.actions.find((action) => action.actionState === 'sleep_mute')?.clips[0]?.clipId).toBe('sleeping');
    expect(manifest?.actions.flatMap((action) => action.clips)[0]?.spriteSheetPath).toMatch(/^whale-pet:\/\/crosspet\/characters\/deepseek\//);
    // 展示立绘不得进入动作槽/ambientPool
    const allPoseIds = [...(manifest?.actions.flatMap((action) => action.clips) ?? []), ...(manifest?.ambientPool ?? [])].map((clip) => clip.clipId);
    expect(allPoseIds).not.toContain('avatar');
    expect(allPoseIds).not.toContain('portrait');
    expect(allPoseIds).not.toContain('portrait-card');
    const egg = result.characters.find((character) => character.id === 'crosspet-egg-deepseek');
    expect(egg?.displayName).toContain('串门彩蛋');
    expect(result.lines.get('crosspet-deepseek')?.idle).toContain('……');
    expect(crossPetLinesOf(root, 'crosspet-egg-deepseek')).toEqual({});
  });

  it('皮肤归属：基础角色的 skins 只带自己家族的换装', () => {
    const root = tempRoot();
    // 复用 readCrossPetEntries 的目录扫描：另建两套皮肤目录
    for (const [dir, name] of [['deepseek-knit', 'DeepSeek 针织'], ['claude-saint', 'Claude 圣女']] as const) {
      const path = join(root, 'crosspet', 'characters', dir);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'character.json'), JSON.stringify({ name, outfit: '换装' }));
      writeFileSync(join(path, 'idle.webp'), 'webp');
    }
    writeCrossPet(root);
    const result = readCrossPetCharacters(root);
    const base = result.characters.find((character) => character.id === 'crosspet-deepseek');
    expect(base?.skins.map((skin) => skin.id)).toEqual(['deepseek-knit']);
  });
});
