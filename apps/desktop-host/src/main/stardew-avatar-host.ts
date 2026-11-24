/**
 * 星露谷桌宠像素外观同步宿主（T-M6-62）。
 *
 * 职责：
 *   - 内置 9 角色 + 默认小鲸的高还原原版外观 preset（发色/发型/衣裤/肤色/帽子，真机可再微调）；
 *   - 「WhaleIsleAvatar」SMAPI Mod 一键安装/卸载（打包态取 Resources/mods/WhaleIsleAvatar，
 *     开发态取 mods/stardew-avatar-sync/publish；DLL 未编译时如实报 compiled:false）；
 *   - 开关开启后，切桌宠/换肤时原子写入 Mods/WhaleIsleAvatar/active-avatar.json
 *     （Zod 校验 + tmp+rename，Mod 侧 FileSystemWatcher 热重载）；
 *   - 联机：为每个 AI 队友的隔离 Mods 目录写各自 characterId 的 active-avatar.json。
 *
 * 安全：active-avatar.json 只含外观字段；路径严格限制在 Mods/WhaleIsleAvatar 内；
 * 绝不读取/写入任何存档数据或凭据。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  StardewAvatarSyncSchema,
  type StardewAvatarPreset,
  type StardewAvatarSync,
} from '@workbench/shared-protocol';
import { guessModsDirs } from '@workbench/stardew-mods';

export const MOD_FOLDER = 'WhaleIsleAvatar';
export const SPRITE_FILE = 'stardew-sprite.png';
const SETTINGS_FILE = 'stardew-avatar-sync.json';

/** 内置角色 → 原版外观预设（高还原近似值；发型/服装编号以原版 1.6 为准，真机可微调）。 */
export const BUILTIN_AVATAR_PRESETS: Readonly<Record<string, StardewAvatarPreset>> = {
  'blue-whale-maid': { hair: 10, hairColor: '#3b82f6', shirt: 0, pantsColor: '#1d4ed8', skin: 0, hatId: -1 },
  'aboutme-dsh': { hair: 10, hairColor: '#4a90d9', shirt: 0, pantsColor: '#2b4c7e', skin: 0, hatId: -1 },
  'aboutme-dsh1': { hair: 11, hairColor: '#4a90d9', shirt: 1, pantsColor: '#2b4c7e', skin: 0, hatId: -1 },
  'aboutme-claude': { hair: 5, hairColor: '#c96a2c', shirt: 2, pantsColor: '#7c4a1e', skin: 0, hatId: -1 },
  'aboutme-gemini': { hair: 7, hairColor: '#5b6ee1', shirt: 3, pantsColor: '#3730a3', skin: 0, hatId: -1 },
  'aboutme-glm': { hair: 2, hairColor: '#2f2f38', shirt: 4, pantsColor: '#1f2937', skin: 0, hatId: -1 },
  'aboutme-gpt': { hair: 6, hairColor: '#2ea043', shirt: 5, pantsColor: '#14532d', skin: 0, hatId: -1 },
  'aboutme-grok': { hair: 1, hairColor: '#1f2430', shirt: 6, pantsColor: '#111827', skin: 0, hatId: -1 },
  'aboutme-kimi': { hair: 8, hairColor: '#8b5cf6', shirt: 7, pantsColor: '#4c1d95', skin: 0, hatId: -1 },
  'aboutme-qwen': { hair: 9, hairColor: '#6d5bd0', shirt: 8, pantsColor: '#312e81', skin: 0, hatId: -1 },
};

/** 自定义/未知角色的中性默认预设（不臆造角色特征）。 */
export const NEUTRAL_AVATAR_PRESET: StardewAvatarPreset = {
  hair: 0, hairColor: '#8a5a2b', shirt: 0, pantsColor: '#3b5bdb', skin: 0, hatId: -1,
};

export function presetForCharacter(characterId: string): StardewAvatarPreset {
  return BUILTIN_AVATAR_PRESETS[characterId] ?? NEUTRAL_AVATAR_PRESET;
}

export interface StardewAvatarState {
  enabled: boolean;
  modsDir: string | null;
  modInstalled: boolean;
  /** WhaleIsleAvatar.dll 存在（dotnet 编译产物）；false 时安装器如实提示 */
  modCompiled: boolean;
}

export interface StardewAvatarHost {
  state(): StardewAvatarState;
  setEnabled(next: boolean): StardewAvatarState;
  installMod(): { ok: boolean; error?: string; compiled?: boolean };
  uninstallMod(): { ok: boolean; error?: string };
  /** 开关开启时把某角色写入主 Mods 目录（切桌宠/换肤自动调用） */
  syncCharacter(input: { characterId: string; displayName: string }): { ok: boolean; error?: string; sprite?: boolean };
  /** 联机：为某个隔离 profile 的 Mods 目录写专属 active-avatar.json（不受全局开关限制） */
  writeForProfile(input: { profileModsDir: string; characterId: string; displayName: string }): { ok: boolean; error?: string };
  /** 该角色是否已有生成好的像素表（自定义角色目录或 stardew-avatars 目录） */
  spriteReady(characterId: string): boolean;
  spritePathFor(characterId: string): string | null;
}

function assertInside(base: string, target: string): string {
  const root = resolve(base);
  const path = resolve(target);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('路径越界');
  return path;
}

export function createStardewAvatarHost(options: {
  userDataDir: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  resourcesPath?: string;
  /** 开发态仓库根（定位 mods/stardew-avatar-sync/publish） */
  repoRoot?: string;
  /** 测试注入：直接指定 Mods 目录 */
  modsDirOverride?: string;
}): StardewAvatarHost {
  const homeDir = options.homeDir ?? process.env.HOME ?? '';
  const platform = options.platform ?? process.platform;
  const settingsPath = join(options.userDataDir, SETTINGS_FILE);
  let enabled = false;
  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { enabled?: unknown };
      enabled = parsed.enabled === true;
    }
  } catch { enabled = false; }

  const persist = (): void => {
    mkdirSync(options.userDataDir, { recursive: true });
    const temp = `${settingsPath}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8');
    renameSync(temp, settingsPath);
  };

  const modsDir = (): string | null => {
    if (options.modsDirOverride !== undefined) return options.modsDirOverride;
    return guessModsDirs(platform, homeDir).find((dir) => existsSync(dir)) ?? null;
  };

  const modSourceDir = (): string | null => {
    const candidates = options.isPackaged === true && options.resourcesPath !== undefined
      ? [join(options.resourcesPath, 'mods', MOD_FOLDER)]
      : [
        ...(options.repoRoot !== undefined ? [join(options.repoRoot, 'mods', 'stardew-avatar-sync', 'publish')] : []),
        ...(options.resourcesPath !== undefined ? [join(options.resourcesPath, 'mods', MOD_FOLDER)] : []),
      ];
    return candidates.find((dir) => existsSync(join(dir, 'manifest.json'))) ?? null;
  };

  const spritePathFor = (characterId: string): string | null => {
    const candidates: string[] = [];
    if (characterId.startsWith('custom-')) {
      candidates.push(join(options.userDataDir, 'pet-characters', characterId.slice('custom-'.length), SPRITE_FILE));
    }
    candidates.push(join(options.userDataDir, 'stardew-avatars', characterId, SPRITE_FILE));
    return candidates.find((path) => existsSync(path)) ?? null;
  };

  /** 组装 + Zod 校验 + 原子写入 active-avatar.json（含像素表复制）。 */
  const writeActiveAvatar = (modDir: string, input: { characterId: string; displayName: string }): { ok: boolean; error?: string; sprite?: boolean } => {
    try {
      const safeModDir = assertInside(resolve(modDir, '..'), modDir);
      mkdirSync(safeModDir, { recursive: true });
      const spriteSource = spritePathFor(input.characterId);
      let spriteSheetPath: string | undefined;
      if (spriteSource !== null) {
        copyFileSync(spriteSource, join(safeModDir, SPRITE_FILE));
        spriteSheetPath = SPRITE_FILE;
      }
      const payload: StardewAvatarSync = StardewAvatarSyncSchema.parse({
        version: 1,
        characterId: input.characterId,
        displayName: input.displayName.trim() === '' ? input.characterId : input.displayName.trim().slice(0, 40),
        preset: presetForCharacter(input.characterId),
        ...(spriteSheetPath === undefined ? {} : { spriteSheetPath }),
      });
      const target = join(safeModDir, 'active-avatar.json');
      const temp = `${target}.tmp`;
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(temp, target);
      return { ok: true, sprite: spriteSheetPath !== undefined };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const state = (): StardewAvatarState => {
    const dir = modsDir();
    const modDir = dir === null ? null : join(dir, MOD_FOLDER);
    return {
      enabled,
      modsDir: dir,
      modInstalled: modDir !== null && existsSync(join(modDir, 'manifest.json')),
      modCompiled: modDir !== null && existsSync(join(modDir, 'WhaleIsleAvatar.dll')),
    };
  };

  return {
    state,
    setEnabled(next) {
      enabled = next === true;
      persist();
      return state();
    },
    installMod() {
      const dir = modsDir();
      if (dir === null) return { ok: false, error: '未找到星露谷 Mods 目录（请确认游戏已安装并至少启动过一次）' };
      const source = modSourceDir();
      if (source === null) return { ok: false, error: 'Mod 源目录缺失（打包资源不完整或仓库 publish 未生成）' };
      const target = join(dir, MOD_FOLDER);
      try {
        cpSync(source, target, { recursive: true, force: true });
        const compiled = existsSync(join(target, 'WhaleIsleAvatar.dll'));
        return {
          ok: true,
          compiled,
          ...(compiled ? {} : { error: '已复制 Mod 文件，但 WhaleIsleAvatar.dll 未编译（请先在仓库运行 dotnet build）' }),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    uninstallMod() {
      const dir = modsDir();
      if (dir === null) return { ok: false, error: '未找到星露谷 Mods 目录' };
      const target = join(dir, MOD_FOLDER);
      try {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    syncCharacter(input) {
      if (!enabled) return { ok: false, error: '「同步桌宠形象进游戏」开关未开启' };
      const dir = modsDir();
      if (dir === null) return { ok: false, error: '未找到星露谷 Mods 目录' };
      const modDir = join(dir, MOD_FOLDER);
      if (!existsSync(join(modDir, 'manifest.json'))) {
        return { ok: false, error: 'WhaleIsleAvatar Mod 未安装：请先在游戏共玩页点「安装 Mod」' };
      }
      return writeActiveAvatar(modDir, input);
    },
    writeForProfile(input) {
      const modDir = join(input.profileModsDir, MOD_FOLDER);
      if (!existsSync(join(modDir, 'manifest.json'))) {
        return { ok: false, error: '隔离 profile 中没有 WhaleIsleAvatar Mod（主 Mods 目录未安装）' };
      }
      return writeActiveAvatar(modDir, input);
    },
    spriteReady: (characterId) => spritePathFor(characterId) !== null,
    spritePathFor,
  };
}
