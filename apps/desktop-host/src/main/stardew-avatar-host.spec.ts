/** 星露谷外观同步宿主（T-M6-62）：预设覆盖、原子写入、开关门控、安装/卸载、联机隔离目录（全 tmpdir 沙箱）。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StardewAvatarSyncSchema } from '@workbench/shared-protocol';
import { BUILTIN_AVATAR_PRESETS, createStardewAvatarHost, NEUTRAL_AVATAR_PRESET, presetForCharacter } from './stardew-avatar-host';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(options: { withMod?: boolean; withDll?: boolean; enabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'avatar-host-'));
  dirs.push(root);
  const userData = join(root, 'userData');
  const modsDir = join(root, 'Mods');
  mkdirSync(userData, { recursive: true });
  mkdirSync(modsDir, { recursive: true });
  if (options.withMod !== false) {
    const modDir = join(modsDir, 'WhaleIsleAvatar');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, 'manifest.json'), '{"Name":"Whale Isle Avatar Sync"}', 'utf8');
    if (options.withDll !== false) writeFileSync(join(modDir, 'WhaleIsleAvatar.dll'), 'dll', 'utf8');
  }
  // 开发态 Mod 源目录：repoRoot/mods/stardew-avatar-sync/publish
  const sourceDir = join(root, 'mods', 'stardew-avatar-sync', 'publish');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'manifest.json'), '{"Name":"Whale Isle Avatar Sync"}', 'utf8');
  writeFileSync(join(sourceDir, 'WhaleIsleAvatar.dll'), 'dll', 'utf8');
  const host = createStardewAvatarHost({
    userDataDir: userData,
    homeDir: root,
    platform: 'darwin',
    repoRoot: root,
    modsDirOverride: modsDir,
  });
  if (options.enabled === true) host.setEnabled(true);
  return { root, userData, modsDir, host };
}

describe('presetForCharacter', () => {
  it('内置 9 角色 + 默认小鲸都有专属预设；未知角色回落中性默认', () => {
    const ids = ['blue-whale-maid', 'aboutme-dsh', 'aboutme-dsh1', 'aboutme-claude', 'aboutme-gemini', 'aboutme-glm', 'aboutme-gpt', 'aboutme-grok', 'aboutme-kimi', 'aboutme-qwen'];
    for (const id of ids) {
      expect(BUILTIN_AVATAR_PRESETS[id], id).toBeDefined();
      expect(presetForCharacter(id)).not.toEqual(NEUTRAL_AVATAR_PRESET);
    }
    expect(presetForCharacter('custom-seal')).toEqual(NEUTRAL_AVATAR_PRESET);
    expect(presetForCharacter('crosspet-claude')).toEqual(NEUTRAL_AVATAR_PRESET);
  });
});

describe('syncCharacter', () => {
  it('开关关闭时拒绝写入（不碰 Mods 目录）', () => {
    const { modsDir, host } = sandbox();
    const result = host.syncCharacter({ characterId: 'aboutme-dsh', displayName: '蓝蓝' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('开关未开启');
    expect(existsSync(join(modsDir, 'WhaleIsleAvatar', 'active-avatar.json'))).toBe(false);
  });

  it('开启后原子写入 active-avatar.json（过 Zod 契约），无像素表时不带 spriteSheetPath', () => {
    const { modsDir, host } = sandbox({ enabled: true });
    const result = host.syncCharacter({ characterId: 'aboutme-dsh', displayName: '蓝蓝' });
    expect(result).toMatchObject({ ok: true, sprite: false });
    const raw = JSON.parse(readFileSync(join(modsDir, 'WhaleIsleAvatar', 'active-avatar.json'), 'utf8')) as unknown;
    const parsed = StardewAvatarSyncSchema.parse(raw);
    expect(parsed).toMatchObject({ version: 1, characterId: 'aboutme-dsh', displayName: '蓝蓝' });
    expect(parsed.spriteSheetPath).toBeUndefined();
    expect(parsed.preset.hairColor).toBe('#4a90d9');
    // 原子写：目录里没有残留 .tmp
    expect(existsSync(join(modsDir, 'WhaleIsleAvatar', 'active-avatar.json.tmp'))).toBe(false);
  });

  it('有像素表时复制进 Mod 目录并写 spriteSheetPath；自定义角色读 pet-characters 目录', () => {
    const { userData, modsDir, host } = sandbox({ enabled: true });
    const spriteDir = join(userData, 'pet-characters', 'seal');
    mkdirSync(spriteDir, { recursive: true });
    writeFileSync(join(spriteDir, 'stardew-sprite.png'), 'png-bytes', 'utf8');
    const result = host.syncCharacter({ characterId: 'custom-seal', displayName: '小海豹' });
    expect(result).toMatchObject({ ok: true, sprite: true });
    expect(readFileSync(join(modsDir, 'WhaleIsleAvatar', 'stardew-sprite.png'), 'utf8')).toBe('png-bytes');
    const parsed = StardewAvatarSyncSchema.parse(JSON.parse(readFileSync(join(modsDir, 'WhaleIsleAvatar', 'active-avatar.json'), 'utf8')));
    expect(parsed.spriteSheetPath).toBe('stardew-sprite.png');
    expect(parsed.preset).toEqual(NEUTRAL_AVATAR_PRESET);
    expect(host.spriteReady('custom-seal')).toBe(true);
    expect(host.spriteReady('aboutme-dsh')).toBe(false);
  });

  it('内置角色像素表读 stardew-avatars 目录；Mod 未安装时如实报错', () => {
    const { userData, host } = sandbox({ enabled: true, withMod: false });
    const spriteDir = join(userData, 'stardew-avatars', 'aboutme-kimi');
    mkdirSync(spriteDir, { recursive: true });
    writeFileSync(join(spriteDir, 'stardew-sprite.png'), 'png', 'utf8');
    expect(host.spriteReady('aboutme-kimi')).toBe(true);
    const result = host.syncCharacter({ characterId: 'aboutme-kimi', displayName: 'Kimi' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未安装');
  });
});

describe('installMod / uninstallMod / state', () => {
  it('安装复制 manifest+DLL 并报告 compiled；卸载删除目录', () => {
    const { modsDir, host } = sandbox({ withMod: false });
    expect(host.state()).toMatchObject({ enabled: false, modInstalled: false, modCompiled: false });
    const installed = host.installMod();
    expect(installed).toMatchObject({ ok: true, compiled: true });
    expect(existsSync(join(modsDir, 'WhaleIsleAvatar', 'manifest.json'))).toBe(true);
    expect(existsSync(join(modsDir, 'WhaleIsleAvatar', 'WhaleIsleAvatar.dll'))).toBe(true);
    expect(host.state().modInstalled).toBe(true);
    expect(host.uninstallMod().ok).toBe(true);
    expect(existsSync(join(modsDir, 'WhaleIsleAvatar'))).toBe(false);
  });

  it('DLL 缺失时安装仍复制文件但如实报 compiled:false', () => {
    const { root, modsDir, host } = sandbox({ withMod: false });
    rmSync(join(root, 'mods', 'stardew-avatar-sync', 'publish', 'WhaleIsleAvatar.dll'));
    const installed = host.installMod();
    expect(installed.ok).toBe(true);
    expect(installed.compiled).toBe(false);
    expect(installed.error).toContain('未编译');
    expect(existsSync(join(modsDir, 'WhaleIsleAvatar', 'manifest.json'))).toBe(true);
  });

  it('开关状态持久化到 userData（重启后仍在）', () => {
    const { userData, modsDir, host } = sandbox();
    host.setEnabled(true);
    const again = createStardewAvatarHost({ userDataDir: userData, homeDir: userData, platform: 'darwin', modsDirOverride: modsDir });
    expect(again.state().enabled).toBe(true);
    again.setEnabled(false);
    expect(JSON.parse(readFileSync(join(userData, 'stardew-avatar-sync.json'), 'utf8'))).toEqual({ enabled: false });
  });
});

describe('writeForProfile（联机隔离目录）', () => {
  it('为每个队友 profile 写各自 characterId；不受全局开关限制', () => {
    const { root, host } = sandbox();
    const profileA = join(root, 'profiles', 'agent-a', 'Mods');
    const profileB = join(root, 'profiles', 'agent-b', 'Mods');
    for (const profile of [profileA, profileB]) {
      mkdirSync(join(profile, 'WhaleIsleAvatar'), { recursive: true });
      writeFileSync(join(profile, 'WhaleIsleAvatar', 'manifest.json'), '{}', 'utf8');
    }
    expect(host.writeForProfile({ profileModsDir: profileA, characterId: 'aboutme-gpt', displayName: 'GPT' }).ok).toBe(true);
    expect(host.writeForProfile({ profileModsDir: profileB, characterId: 'aboutme-grok', displayName: 'Grok' }).ok).toBe(true);
    const a = StardewAvatarSyncSchema.parse(JSON.parse(readFileSync(join(profileA, 'WhaleIsleAvatar', 'active-avatar.json'), 'utf8')));
    const b = StardewAvatarSyncSchema.parse(JSON.parse(readFileSync(join(profileB, 'WhaleIsleAvatar', 'active-avatar.json'), 'utf8')));
    expect(a.characterId).toBe('aboutme-gpt');
    expect(b.characterId).toBe('aboutme-grok');
    expect(a.preset.hairColor).not.toBe(b.preset.hairColor);
  });

  it('profile 中没有 Mod 时如实报错，不创建目录冒充成功', () => {
    const { root, host } = sandbox();
    const profile = join(root, 'profiles', 'agent-c', 'Mods');
    mkdirSync(profile, { recursive: true });
    const result = host.writeForProfile({ profileModsDir: profile, characterId: 'aboutme-gpt', displayName: 'GPT' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有 WhaleIsleAvatar Mod');
    expect(existsSync(join(profile, 'WhaleIsleAvatar'))).toBe(false);
  });
});
