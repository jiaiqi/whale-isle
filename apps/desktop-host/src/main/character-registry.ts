/**
 * 桌宠角色注册表（T-M6-21）：内置角色 + userData/pet-characters/*.json 自定义角色元数据。
 * 只下发元数据（无密钥/大资产），manifest 由独立 IPC 读回并经契约校验；角色切换写
 * PetDesktopPrefs.characterId（单点事实源），聊天人设/饭碗锚点/音色联动消费同一份注册表。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import {
  PetAvatarManifestSchema,
  PetCharacterSchema,
  type PetAvatarManifest,
  type PetCharacter,
  type PetDesktopPrefs,
} from '@workbench/shared-protocol';

/** 小鲸：当前默认且唯一内置角色（114 官方 webm，CC BY-NC-SA 4.0 → 仅开发测试） */
export const BUILTIN_CHARACTERS: PetCharacter[] = [
  PetCharacterSchema.parse({
    id: 'blue-whale-maid',
    displayName: '小鲸（蓝鲸女仆）',
    manifestPath: './assets/blue-whale-maid/manifest.json',
    personaPrompt:
      '你是「小鲸」——一条傲娇干饭蓝鲸女仆，住在主人 Mac 桌面上，正在替主人自动游玩《星露谷物语》。口吻：嘴硬心软的傲娇女仆；回复短小精悍（≤80字）；偶尔提到饭碗/米粒；不解释自己是 AI；用中文。',
    voiceId: 'qiaopi_mengmei',
    anchorRatio: 0.687,
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    builtin: true,
  }),
];

export interface CharacterRegistry {
  list(): PetCharacter[];
  selected(): PetCharacter;
  manifestOf(character: PetCharacter): { ok: true; manifest: PetAvatarManifest } | { ok: false; error: string };
}

export function createCharacterRegistry(options: {
  userDataDir: string;
  getPrefs: () => PetDesktopPrefs;
  setCharacter: (id: string) => void;
  /** 内置角色 manifest 根目录（dist/renderer/pet-stage） */
  builtinAssetsDir: string;
  /**
   * 随包角色（T-M6-45：assets/pet-packs/aboutme-pets 直读）。
   * manifest 由提供方直接给出，不再从 userData 读盘；与同名 userData 导入包相比随包版本优先。
   */
  bundled?: () => Array<{ character: PetCharacter; manifest: PetAvatarManifest }>;
}): CharacterRegistry {
  const customDir = join(options.userDataDir, 'pet-characters');
  const custom = (): PetCharacter[] => {
    if (!existsSync(customDir)) return [];
    const out: PetCharacter[] = [];
    for (const file of readdirSync(customDir).filter((f) => f.endsWith('.json'))) {
      try {
        const parsed = PetCharacterSchema.safeParse(JSON.parse(readFileSync(join(customDir, file), 'utf8')));
        if (parsed.success && parsed.data.builtin === false) out.push(parsed.data);
      } catch {
        /* 坏文件忽略，绝不崩主进程 */
      }
    }
    return out;
  };
  const bundledPairs = (): Array<{ character: PetCharacter; manifest: PetAvatarManifest }> => {
    try {
      return options.bundled?.() ?? [];
    } catch {
      return []; // 素材包损坏只降级，不影响内置角色
    }
  };
  const all = (): PetCharacter[] => {
    const bundled = bundledPairs().map((pair) => pair.character);
    const ids = new Set(bundled.map((character) => character.id));
    return [...BUILTIN_CHARACTERS, ...bundled, ...custom().filter((character) => !ids.has(character.id))];
  };
  const selected = (): PetCharacter =>
    all().find((c) => c.id === options.getPrefs().characterId) ?? (BUILTIN_CHARACTERS[0] as PetCharacter);

  ipcMain.handle('pet:character-list', () => all());
  ipcMain.handle('pet:character-select', (_e, id: string) => {
    const found = all().find((c) => c.id === id);
    if (!found) return { ok: false, error: `未知角色：${id}` };
    options.setCharacter(id);
    return { ok: true, character: found };
  });
  ipcMain.handle('pet:character-manifest', (_e, id: string) => {
    const character = all().find((c) => c.id === id) ?? selected();
    return registry.manifestOf(character);
  });

  const registry: CharacterRegistry = {
    list: all,
    selected,
    manifestOf(character) {
      try {
        const bundled = bundledPairs().find((pair) => pair.character.id === character.id);
        if (bundled !== undefined) return { ok: true, manifest: bundled.manifest };
        // 内置 manifestPath 可写渲染层相对 HTML 的 "./assets/..."；builtinAssetsDir 已指向 .../pet-stage/assets，
        // 需剥掉 assets/ 前缀，避免拼成双重 assets（真机 E2E 抓到）
        const rel = character.manifestPath.replace(/^\.\//, '').replace(/^assets\//, '');
        const path = character.builtin ? join(options.builtinAssetsDir, rel) : character.manifestPath;
        if (!existsSync(path)) return { ok: false, error: `角色 manifest 不存在：${path}` };
        const parsed = PetAvatarManifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (!parsed.success) return { ok: false, error: `角色 manifest 校验失败：${character.id}` };
        return { ok: true, manifest: parsed.data };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  return registry;
}
