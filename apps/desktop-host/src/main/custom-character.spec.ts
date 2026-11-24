/** 自定义角色深度协议（T-M6-53）：目录加载、立绘过滤、改名、克隆、reactTo、保存校验。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { isPackaged: false } }));

import {
  cloneBuiltinCharacter,
  customCharactersRoot,
  invalidateCustomCharacters,
  linesForPose,
  matchesReactTo,
  readCustomCharacters,
  renameCustomCharacter,
  saveCustomCharacter,
} from './custom-character';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); invalidateCustomCharacters(); });

const CHARACTER = {
  name: '小海豹', accent: '#3b82f6', reactTo: ['claude', 'gemini'],
  greeting: '我来了～', lines: { idle: ['嗯？'], pat: ['嘿嘿'], compact: ['塞不下啦'] },
  glyph: { fill: '#3b82f6' }, idleActions: ['idle'], pokePose: 'pout', correctedPose: 'sorry',
  longThink: { after: 20, pose: 'deepthink' }, fx: { thinking: 'bubbles', proud: 'victory' },
  milestones: [{ id: 'first', at: 1, text: '第一次干活' }], notebook: { title: '海豹本子', entries: ['今天很乖'] },
  outfit: '围裙', skinOf: 'deepseek',
};

function makeUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'custom-character-'));
  dirs.push(dir);
  return dir;
}

function writeCharacter(userDataDir: string, id: string, data: unknown = CHARACTER): string {
  const dir = join(customCharactersRoot(userDataDir), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'character.json'), JSON.stringify(data));
  for (const pose of ['idle', 'pat', 'compact']) writeFileSync(join(dir, `${pose}.webp`), 'webp');
  for (const file of ['avatar.webp', 'portrait.webp', 'portrait-card.webp']) writeFileSync(join(dir, file), 'webp');
  return dir;
}

describe('自定义角色加载', () => {
  it('按目录读取并生成 pose-skin manifest；立绘不进入姿态；扩展字段保留', () => {
    const root = makeUserData();
    writeCharacter(root, 'seal');
    const result = readCustomCharacters(root);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.id).toBe('seal');
    expect(entry.character).toMatchObject({ id: 'custom-seal', displayName: '小海豹', builtin: false, packId: 'custom' });
    expect(entry.poses.sort()).toEqual(['compact', 'idle', 'pat']);
    expect(entry.manifest.renderer).toBe('pose-skin');
    expect(entry.manifest.actions.find((action) => action.actionState === 'idle')?.clips[0]?.clipId).toBe('idle');
    expect(entry.manifest.ambientPool.map((clip) => clip.clipId)).not.toContain('avatar');
    expect(entry.data.longThink).toMatchObject({ after: 20, pose: 'deepthink' });
    expect(entry.data.fx.proud).toBe('victory');
    expect(entry.data.milestones[0]?.text).toBe('第一次干活');
    expect(linesForPose(entry.data, 'pat')).toEqual(['嘿嘿']);
    expect(linesForPose(entry.data, 'missing')).toEqual(['嗯？']);
  });

  it('改名落盘 settings 且热重载后显示新名字；坏 JSON 只记错误', () => {
    const root = makeUserData();
    writeCharacter(root, 'seal');
    expect(renameCustomCharacter(root, 'seal', '阿豹').displayName).toBe('阿豹');
    expect(readCustomCharacters(root).entries[0]?.character.displayName).toBe('阿豹');
    expect(JSON.parse(readFileSync(join(customCharactersRoot(root), 'character-settings.json'), 'utf8'))).toEqual({ seal: { displayName: '阿豹' } });
    // character.json 原 name 未被改写
    expect(JSON.parse(readFileSync(join(customCharactersRoot(root), 'seal', 'character.json'), 'utf8')).name).toBe('小海豹');

    mkdirSync(join(customCharactersRoot(root), 'broken'), { recursive: true });
    writeFileSync(join(customCharactersRoot(root), 'broken', 'character.json'), '{bad');
    invalidateCustomCharacters();
    const result = readCustomCharacters(root);
    expect(result.entries).toHaveLength(1);
    expect(result.errors[0]).toContain('broken');
  });

  it('reactTo 匹配来源/modelName，通配与大小写/子串', () => {
    const data = { ...CHARACTER, reactTo: ['claude', 'GPT-4'] };
    expect(matchesReactTo(data as never, 'claude', '')).toBe(true);
    expect(matchesReactTo(data as never, 'acp', 'gpt-4o')).toBe(true);
    expect(matchesReactTo(data as never, 'qwen', 'qwen3')).toBe(false);
    expect(matchesReactTo({ ...CHARACTER, reactTo: '*' } as never, 'anything', '')).toBe(true);
  });
});

describe('CrossPet character.json 兼容', () => {
  it('真实 CrossPet 字段（lines 内含 greet_*/fest_*、fx 映射、glyph、aura/host/skin）经 Schema 校验并保留', async () => {
    const { PetCustomCharacterSchema } = await import('@workbench/shared-protocol');
    const parsed = PetCustomCharacterSchema.parse({
      name: 'DeepSeek', outfit: '女仆装', accent: '#3b5bb5', apps: ['com.deepseek.dsh'],
      greeting: 'DeepSeek 来啦！', lowBalance: 5, aura: '#2b4a8f', caption: '鲸鱼娘',
      glyph: { fill: '#3b6fd8' }, idleActions: ['idle', 'idle-blink'], pokePose: 'pout',
      correctedPose: 'sorry', longThink: { after: 20, pose: 'deepthink' },
      fx: { thinking: 'bubbles', eat: 'steam', feast: 'celebrate', proud: 'victory', priceDown: 'steam', priceUp: 'celebrate' },
      lines: {
        idle: ['……'], compact: ['塞不下啦'], asking: ['可以吗？'],
        greet_dawn: ['天亮了'], greet_morning: ['早上好'], greet_noon: ['中午啦'], greet_afternoon: ['下午好'], greet_evening: ['晚上好'], greet_night: ['该睡了'],
        fest_spring: ['新年好'], fest_lantern: ['元宵'], fest_dragonboat: ['端午'], fest_midautumn: ['中秋'], fest_national: ['国庆'], fest_christmas: ['圣诞'], fest_newyear: ['跨年'], fest_halloween: ['万圣'],
      },
      host: 'deepseek', hostSkin: 'deepseek-hoodie', skinName: '卫衣', skinOf: 'deepseek', egg: false,
    });
    expect(Object.keys(parsed.lines)).toHaveLength(17);
    expect(parsed.fx.priceDown).toBe('steam');
    expect(parsed.greeting).toBe('DeepSeek 来啦！');
  });
});

describe('保存与克隆', () => {
  it('保存经 Zod 校验：缺 name 拒绝；合法配置落盘并可加载', () => {
    const root = makeUserData();
    writeCharacter(root, 'seal');
    expect(() => saveCustomCharacter(root, 'seal', { name: '' })).toThrow();
    expect(() => saveCustomCharacter(root, 'Bad Id', CHARACTER)).toThrow(/小写字母/);
    const saved = saveCustomCharacter(root, 'seal', { ...CHARACTER, name: '小海豹二号' });
    expect(saved.character.displayName).toBe('小海豹二号');
    expect(readCustomCharacters(root).entries[0]?.data.name).toBe('小海豹二号');
  });

  it('克隆内置 CrossPet 角色：只拷贝图片/配置、不覆盖已有目录', () => {
    const root = makeUserData();
    const packsRoot = join(root, 'packs');
    const source = join(packsRoot, 'crosspet', 'characters', 'deepseek');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'character.json'), JSON.stringify({ name: 'DeepSeek', outfit: '女仆装', lines: { idle: ['在'] }, fx: {} }));
    for (const file of ['idle.webp', 'portrait.webp', 'avatar.webp']) writeFileSync(join(source, file), 'webp');
    writeFileSync(join(source, 'notes.txt'), '不应复制');

    const cloned = cloneBuiltinCharacter({ packsRoot, userDataDir: root, builtinId: 'crosspet-deepseek', newId: 'deepseek-mine', displayName: '小鲸定制' });
    expect(cloned.characterId).toBe('custom-deepseek-mine');
    expect(readCustomCharacters(root).entries[0]?.character.displayName).toBe('小鲸定制');
    const entry = readCustomCharacters(root).entries[0]!;
    expect(entry.poses).toEqual(['idle']);
    expect(JSON.parse(readFileSync(join(entry.dir, 'character.json'), 'utf8')).name).toBe('小鲸定制');
    expect(() => cloneBuiltinCharacter({ packsRoot, userDataDir: root, builtinId: 'crosspet-deepseek', newId: 'deepseek-mine' })).toThrow(/已存在/);
    expect(() => cloneBuiltinCharacter({ packsRoot, userDataDir: root, builtinId: 'blue-whale-maid', newId: 'x1' })).toThrow(/只能克隆/);
  });
});
