import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PetAvatarManifestSchema, PetCharacterSchema } from '@workbench/shared-protocol';
import { ABOUTME_PACKS, buildAboutmePackArtifacts, importAboutmePets, readPackCatalog } from './aboutme-pets';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function response(body: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: true, status: 200,
    json: async () => body,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}
function binResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer } as unknown as Response;
}

function fixtureFetch(spriteCalls: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/pets.json')) return response({ schemaVersion: 1, pets: [{ id: 'dsh-pet', name: '蓝毛小女仆', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] });
    if (url.endsWith('/pets/dsh/manifest.json')) return response({ schemaVersion: 1, canvasWidth: 640, canvasHeight: 360, animations: [] });
    if (url.endsWith('/pets/dsh/actions.json')) return response({ schemaVersion: 1, animations: [
      { id: '待机呼吸', name: '待机呼吸', category: '待机', sources: { webp: 'spritesheet/待机呼吸.webp' }, spritesheet: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, fps: 12 } },
      { id: '吃月饼', name: '吃月饼', category: '吃', sources: { webp: 'spritesheet/吃月饼.webp' }, audio: 'audio/吃月饼.m4a', spritesheet: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, fps: 12 } },
      { id: '散步', name: '散步', category: '移动', sources: { webp: 'spritesheet/散步.webp' }, spritesheet: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, fps: 12 } },
    ] });
    if (url.includes('/spritesheet/') || url.includes('/audio/')) {
      spriteCalls.push(url);
      return binResponse('asset-bytes');
    }
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
  }) as typeof fetch;
}

describe('aboutme-pets importer', () => {
  it('9 角色目录、11 槽位、动作/音轨/角色 JSON 落盘与断点跳过', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aboutme-pets-'));
    dirs.push(dir);
    const calls: string[] = [];
    const progress = vi.fn();
    const first = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl: fixtureFetch(calls), onProgress: progress });
    expect(first.imported).toEqual(['dsh']);
    const manifest = PetAvatarManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'pet-characters', 'dsh', 'manifest.json'), 'utf8')));
    expect(manifest.renderer).toBe('sprite-sheet');
    expect(manifest.actions).toHaveLength(11);
    expect(manifest.actions.every((entry) => entry.clips.length > 0)).toBe(true);
    const eat = manifest.actions.find((entry) => entry.actionState === 'eat_rice');
    expect(eat, JSON.stringify(manifest.actions.map((entry) => [entry.actionState, entry.clips.map((clip) => [clip.clipId, clip.audioPath])]))).toBeDefined();
    expect(eat?.clips[0]?.audioPath).toContain('audio/');
    expect(manifest.licenseScope).toBe('DEV_ONLY_NON_COMMERCIAL');
    const character = PetCharacterSchema.parse(JSON.parse(readFileSync(join(dir, 'pet-characters', 'dsh.json'), 'utf8')));
    expect(character).toMatchObject({ packId: 'dsh-pet', actionCount: 3, audioClipCount: 1, builtin: false, voiceId: 'qiaopi_mengmei' });
    expect(readPackCatalog(dir).find((item) => item.slug === 'dsh')).toMatchObject({ installed: true, actionCount: 3, audioClipCount: 1 });
    expect(progress).toHaveBeenCalled();

    const before = calls.length;
    const second = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl: fixtureFetch(calls) });
    expect(second.imported).toEqual(['dsh']);
    expect(calls.length).toBe(before);
  });

  it('未选择包直接拒绝；all 对缺失 catalog 包记失败；空动画/坏元数据明确失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aboutme-pets-')); dirs.push(dir);
    await expect(importAboutmePets({ userDataDir: dir, fetchImpl: fixtureFetch() })).rejects.toThrow(/未选择/);
    const all = await importAboutmePets({ userDataDir: dir, all: true, fetchImpl: fixtureFetch() });
    expect(all.imported).toEqual(['dsh']);
    expect(all.failed).toHaveLength(8);
    const empty = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/pets.json')) return response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] });
      return response({ animations: [] });
    }) as typeof fetch;
    const noAnim = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl: empty });
    expect(noAnim.failed[0]?.error).toContain('没有动画');
    expect(readPackCatalog(join(dir, 'missing')).every((item) => !item.installed)).toBe(true);
  });

  it('拒绝对路径与 .. 穿越，坏包记入 failed 不中断其它包', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aboutme-pets-'));
    dirs.push(dir);
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/pets.json')) return response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] });
      if (url.endsWith('/manifest.json')) return response({ id: 'x', animations: [] });
      return response({ animations: [{ id: 'escape', sources: { webp: '../secret.webp' }, spritesheet: { frameWidth: 1, frameHeight: 1, columns: 1, frameCount: 1, fps: 12 } }] });
    }) as typeof fetch;
    const result = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl });
    expect(result.failed[0]?.error).toContain('非法素材路径');
    expect(existsSync(join(dir, 'pet-characters', 'dsh', 'manifest.json'))).toBe(false);
  });
});

describe('aboutme-pets importer 边界', () => {
  it('actions 为空时回退 manifest animations；缺元数据/非法 audio/HTTP404/空文件均明确失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aboutme-pets-')); dirs.push(dir);
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/pets.json')) return response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] });
      if (url.endsWith('/pets/dsh/actions.json')) return response({ animations: [] });
      if (url.endsWith('/pets/dsh/manifest.json')) return response({ canvasWidth: 640, animations: [{ id: '待机', sources: { webp: 'spritesheet/待机.webp' }, spritesheet: { frameWidth: 1, frameHeight: 1, columns: 1, frameCount: 1 } }] });
      if (url.endsWith('/pets.json.extra')) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as Response;
      return binResponse('');
    }) as typeof fetch;
    const result = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain('空文件');
  });

  it('坏目录 JSON 被忽略；缺 spritesheet 元数据与非法 audio 路径明确报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aboutme-pets-')); dirs.push(dir);
    mkdirSync(join(dir, 'pet-characters'), { recursive: true });
    writeFileSync(join(dir, 'pet-characters', 'broken.json'), '{bad');
    expect(readPackCatalog(dir).every((item) => !item.installed)).toBe(true);
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/pets.json')) return response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] });
      if (url.endsWith('/actions.json')) return response({ animations: [{ id: '无元数据', sources: { webp: 'spritesheet/x.webp' } }] });
      return response({ animations: [] });
    }) as typeof fetch;
    const missing = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl });
    expect(missing.failed[0]?.error).toContain('缺少 spritesheet');
    const badAudio = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/pets.json')) return response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] });
      if (url.endsWith('/actions.json')) return response({ animations: [{ id: '坏音轨', sources: { webp: 'spritesheet/x.webp' }, audio: 'other/x.m4a', spritesheet: { frameWidth: 1, frameHeight: 1, columns: 1, frameCount: 1 } }] });
      return response({ animations: [] });
    }) as typeof fetch;
    const audio = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl: badAudio });
    expect(audio.failed[0]?.error).toContain('非 audio 路径');
  });
});

describe('aboutme-pets 默认字段', () => {
  it('缺 id/webp/fps/canvas/idle 时使用安全回退，同动作超过 6 个进入 ambient', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aboutme-pets-')); dirs.push(dir);
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/pets.json')) return response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] });
      if (url.endsWith('/actions.json')) return response({ animations: Array.from({ length: 8 }, (_, i) => ({ name: i === 0 ? '待机' : `待机${i}`, sources: {}, spritesheet: { frameWidth: 1, frameHeight: 1, columns: 1, frameCount: 1 } })) });
      return response({});
    }) as typeof fetch;
    const result = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl });
    expect(result.imported).toEqual(['dsh']);
    const manifest = JSON.parse(readFileSync(join(dir, 'pet-characters', 'dsh', 'manifest.json'), 'utf8'));
    expect(manifest.ambientPool.length).toBeGreaterThan(0);
    expect(manifest.actions.every((a: { clips: unknown[] }) => a.clips.length > 0)).toBe(true);
  });
});

describe('aboutme-pets 扩展元数据（T-M6-63）', () => {
  const sprite = { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 16, fps: 12 };
  const animation = (id: string, extra: Record<string, unknown>) => ({
    id,
    sources: { webp: `spritesheet/${id}.webp` },
    spritesheet: sprite,
    ...extra,
  });
  const build = (animations: unknown[]) => buildAboutmePackArtifacts({
    pack: ABOUTME_PACKS[0]!,
    sourceManifest: { canvasWidth: 640, canvasHeight: 360, idleAnimationId: '待机' },
    animations: animations as never,
    manifestPath: 'manifest.json',
    urlFor: (rel) => `whale-pet://${rel}`,
  });

  it('保留 category/facing/moving，并写进动作片段与 ambientPool', () => {
    const built = build([
      animation('待机', { category: '待机', facing: 'left', moving: [[18, 56, 2.5]] }),
      animation('螃蟹走路', { category: '移动', facing: 'right', moving: [[14, 96, 1.5], [100, 120, 0.5]] }),
      // 填满 idle 槽（最多 6 条），让第 8 条真正落入 ambientPool
      ...Array.from({ length: 6 }, (_, index) => animation(`待机${index + 1}`, { category: '待机' })),
      animation('余额-钱袋满溢', { category: '余额', facing: 'left', moving: [[5, 9, 1]] }),
    ]);
    const all = [...built.manifest.actions.flatMap((action) => action.clips), ...built.manifest.ambientPool];
    const idle = all.find((clip) => clip.clipId === '待机')!;
    expect(idle.facing).toBe('left');
    expect(idle.moving).toEqual([[18, 56, 2.5]]);
    expect(idle.category).toBe('待机');
    const walk = all.find((clip) => clip.clipId === '螃蟹走路');
    expect(walk).toMatchObject({ facing: 'right', moving: [[14, 96, 1.5], [100, 120, 0.5]], category: '移动' });
    const ambient = built.manifest.ambientPool.find((clip) => clip.clipId === '余额-钱袋满溢');
    expect(ambient).toMatchObject({ facing: 'left', moving: [[5, 9, 1]], category: '余额' });
  });

  it('非法 facing/moving 不猜、不写入；空数组视为无 moving', () => {
    const built = build([
      animation('待机', {}),
      animation('a', { facing: 'up', moving: [] }),
      animation('b', { facing: 'left', moving: [[1, 2]] }),
      animation('c', { moving: [[-1, 2, 1]] }),
      animation('d', { moving: [[1, 2.5, 1]] }),
      animation('e', { moving: [[1, 2, 0]] }),
      animation('f', { moving: 'nope' }),
    ]);
    const all = [...built.manifest.actions.flatMap((action) => action.clips), ...built.manifest.ambientPool];
    for (const id of ['待机', 'a', 'b', 'c', 'd', 'e', 'f']) {
      const clip = all.find((entry) => entry.clipId === id);
      expect(clip?.moving, id).toBeUndefined();
    }
    expect(all.find((entry) => entry.clipId === 'a')?.facing).toBeUndefined();
    expect(all.find((entry) => entry.clipId === 'b')?.facing).toBe('left');
  });
});

describe('aboutme-pets 错误路径', () => {
  it('HTTP 失败/字符串异常/非 spritesheet 路径均转 failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aboutme-pets-')); dirs.push(dir);
    const base = (handler: (url: string) => Response | Promise<Response>) => (async (input: string | URL) => handler(String(input))) as typeof fetch;
    const http = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl: base((url) => url.endsWith('/pets.json')
      ? response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] })
      : ({ ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as Response)) });
    expect(http.failed[0]?.error).toContain('HTTP 500');
    const thrown = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl: base((url) => { if (url.endsWith('/pets.json')) return response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] }); throw 'network down'; }) });
    expect(thrown.failed[0]?.error).toContain('network down');
    const wrong = await importAboutmePets({ userDataDir: dir, packSlugs: ['dsh'], fetchImpl: base((url) => url.endsWith('/pets.json')
      ? response({ pets: [{ id: 'dsh-pet', manifest: 'pets/dsh/manifest.json', actions: 'pets/dsh/actions.json' }] })
      : url.endsWith('/actions.json') ? response({ animations: [{ id: '..', sources: { webp: 'other/x.webp' }, spritesheet: { frameWidth: 1, frameHeight: 1, columns: 1, frameCount: 1 } }] }) : response({})) });
    expect(wrong.failed[0]?.error).toContain('非 spritesheet 路径');
  });
});
