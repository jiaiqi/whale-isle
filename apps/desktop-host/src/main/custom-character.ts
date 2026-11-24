/**
 * 自定义角色深度协议与热重载（T-M6-53）。
 *
 * 目录协议：`userData/pet-characters/<id>/character.json` + 姿态图（webp/png）。
 * `character.json` 兼容 CrossPet 字段（name/accent/apps/greeting/lines/glyph/idleActions/
 * pokePose/correctedPose/longThink/fx/outfit…），并扩展 reactTo/milestones/notebook。
 * 渲染统一走 pose-skin manifest；展示立绘（avatar/portrait/portrait-card）不进入动作槽。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PetCharacterSchema,
  PetCustomCharacterSchema,
  type PetAvatarManifest,
  type PetCharacter,
  type PetCustomCharacter,
} from '@workbench/shared-protocol';
import { buildPoseSkinManifest, type PoseClipSource } from './pet-packs';
import { NON_POSE_FILES, sanitizePoseId } from './image-pipeline';

const SETTINGS_FILE = 'character-settings.json';
const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const IMAGE_EXT = /\.(webp|png)$/i;

export interface CustomCharacterEntry {
  /** 目录 id（同时作为存放目录名） */
  id: string;
  dir: string;
  data: PetCustomCharacter;
  poses: string[];
  character: PetCharacter;
  manifest: PetAvatarManifest;
}

export interface CustomCharactersResult {
  entries: CustomCharacterEntry[];
  errors: string[];
}

let reloadToken = 0;
const cache = new Map<string, { token: number; result: CustomCharactersResult }>();

/** 热重载：丢弃缓存，下一次 list 重新读盘（不重启进程）。 */
export function invalidateCustomCharacters(): void {
  reloadToken += 1;
}

export function customCharactersRoot(userDataDir: string): string {
  return join(userDataDir, 'pet-characters');
}

function settingsPath(userDataDir: string): string {
  return join(customCharactersRoot(userDataDir), SETTINGS_FILE);
}

function readSettings(userDataDir: string): Record<string, { displayName?: string }> {
  try {
    const path = settingsPath(userDataDir);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const out: Record<string, { displayName?: string }> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null && typeof (value as { displayName?: unknown }).displayName === 'string') {
        out[key] = { displayName: (value as { displayName: string }).displayName };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeSettings(userDataDir: string, next: Record<string, { displayName?: string }>): void {
  const path = settingsPath(userDataDir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

function safeDir(root: string, candidate: string): boolean {
  const target = resolve(candidate);
  return target === resolve(root) || target.startsWith(`${resolve(root)}${sep}`);
}

/** 读取全部自定义角色（按目录 mtime 变化自动失效缓存）。 */
export function readCustomCharacters(userDataDir: string): CustomCharactersResult {
  const root = customCharactersRoot(userDataDir);
  const cached = cache.get(root);
  if (cached !== undefined && cached.token === reloadToken) return cached.result;
  const result: CustomCharactersResult = { entries: [], errors: [] };
  if (!existsSync(root)) {
    cache.set(root, { token: reloadToken, result });
    return result;
  }
  const settings = readSettings(userDataDir);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (!safeDir(root, dir)) {
      result.errors.push(`${entry.name}：目录越界`);
      continue;
    }
    const characterPath = join(dir, 'character.json');
    if (!existsSync(characterPath)) continue;
    try {
      const parsed = PetCustomCharacterSchema.safeParse(JSON.parse(readFileSync(characterPath, 'utf8')));
      if (!parsed.success) {
        result.errors.push(`${entry.name}：character.json 校验失败（${parsed.error.issues[0]?.message ?? '未知'}）`);
        continue;
      }
      const files = readdirSync(dir).filter((file) => IMAGE_EXT.test(file));
      const clips: PoseClipSource[] = [];
      for (const file of files) {
        const pose = sanitizePoseId(file);
        if (NON_POSE_FILES.has(pose)) continue;
        clips.push({ pose, src: pathToFileURL(join(dir, file)).href });
      }
      const manifest = buildPoseSkinManifest({
        petId: `custom-${entry.name}`,
        clips,
        attribution: '本地自定义角色（D5 本机自用，DEV_ONLY_NON_COMMERCIAL）',
      });
      if (manifest === null) {
        result.errors.push(`${entry.name}：没有可用姿态图（avatar/portrait 不计入）`);
        continue;
      }
      const data = parsed.data;
      const displayName = settings[entry.name]?.displayName?.trim() || data.name;
      const character = PetCharacterSchema.parse({
        id: `custom-${entry.name}`,
        displayName,
        manifestPath: pathToFileURL(characterPath).href,
        personaPrompt: `你是「${displayName}」${data.outfit === '' ? '' : `，穿着${data.outfit}`}。${data.greeting} 口吻自然简短，不解释自己是 AI，用中文。`,
        voiceId: 'qiaopi_mengmei',
        voiceRatePercent: 100,
        voicePitchMul: 1.2,
        packId: 'custom',
        actionCount: manifest.actions.reduce((sum, action) => sum + action.clips.length, 0),
        audioClipCount: 0,
        anchorRatio: 0.5,
        licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
        builtin: false,
        skins: [],
      });
      result.entries.push({ id: entry.name, dir, data, poses: clips.map((clip) => clip.pose), character, manifest });
    } catch (error) {
      result.errors.push(`${entry.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cache.set(root, { token: reloadToken, result });
  return result;
}

/** registry 合并用：角色 + manifest 对。 */
export function customCharacterPairs(userDataDir: string): Array<{ character: PetCharacter; manifest: PetAvatarManifest }> {
  return readCustomCharacters(userDataDir).entries.map((entry) => ({ character: entry.character, manifest: entry.manifest }));
}

export function assertCustomId(id: string): string {
  if (!CUSTOM_ID_RE.test(id)) throw new Error(`自定义角色 id 必须是 2-41 位小写字母/数字/连字符：${id}`);
  return id;
}

/** 保存角色配置（已有目录则覆盖 character.json，不删姿态图）。 */
export function saveCustomCharacter(userDataDir: string, id: string, input: unknown): { ok: true; character: PetCharacter } {
  const safeId = assertCustomId(id);
  const root = customCharactersRoot(userDataDir);
  const dir = join(root, safeId);
  if (!safeDir(root, dir)) throw new Error('目录越界');
  const data = PetCustomCharacterSchema.parse(input);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'character.json');
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  invalidateCustomCharacters();
  const loaded = readCustomCharacters(userDataDir).entries.find((entry) => entry.id === safeId);
  if (loaded === undefined) throw new Error('保存成功但未找到可用姿态图，请先导入姿态图片');
  return { ok: true, character: loaded.character };
}

/** 改名：落盘本机设置（不覆盖 character.json，升级/重新导入不丢）。 */
export function renameCustomCharacter(userDataDir: string, id: string, displayName: string): { ok: true; displayName: string } {
  const safeId = assertCustomId(id);
  const name = displayName.trim();
  if (name === '' || name.length > 40) throw new Error('角色名需为 1-40 个字符');
  const settings = readSettings(userDataDir);
  settings[safeId] = { ...settings[safeId], displayName: name };
  writeSettings(userDataDir, settings);
  invalidateCustomCharacters();
  return { ok: true, displayName: name };
}

/** 克隆随包 CrossPet 角色到 userData（绝不覆盖内置目录）。 */
export function cloneBuiltinCharacter(options: {
  packsRoot: string;
  userDataDir: string;
  builtinId: string;
  newId: string;
  displayName?: string;
}): { ok: true; id: string; dir: string; characterId: string } {
  const newId = assertCustomId(options.newId);
  const source = (() => {
    const match = /^crosspet-(.+)$/.exec(options.builtinId);
    if (match === null) return null;
    const dir = join(options.packsRoot, 'crosspet', 'characters', match[1]!);
    return existsSync(join(dir, 'character.json')) ? dir : null;
  })();
  if (source === null) throw new Error(`只能克隆随包 CrossPet 角色：${options.builtinId}`);
  const root = customCharactersRoot(options.userDataDir);
  const dest = join(root, newId);
  if (existsSync(dest)) throw new Error(`目录已存在：${newId}`);
  if (!safeDir(root, dest)) throw new Error('目录越界');
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(source)) {
    if (!IMAGE_EXT.test(file) && file !== 'character.json') continue;
    cpSync(join(source, file), join(dest, file));
  }
  const data = PetCustomCharacterSchema.parse(JSON.parse(readFileSync(join(dest, 'character.json'), 'utf8')));
  const next: PetCustomCharacter = {
    ...data,
    name: (options.displayName ?? `${data.name}·定制`).trim() || data.name,
    skinOf: data.skinOf === '' ? options.builtinId.replace(/^crosspet-/, '') : data.skinOf,
  };
  writeFileSync(join(dest, 'character.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  if (options.displayName !== undefined && options.displayName.trim() !== '') renameCustomCharacter(options.userDataDir, newId, options.displayName);
  invalidateCustomCharacters();
  return { ok: true, id: newId, dir: dest, characterId: `custom-${newId}` };
}

/** reactTo 匹配：`"*"` 或列表里命中来源/modelName（大小写不敏感，允许子串）。 */
export function matchesReactTo(data: PetCustomCharacter, source: string, modelName: string): boolean {
  if (data.reactTo === '*') return true;
  const model = modelName.toLowerCase();
  const src = source.toLowerCase();
  return data.reactTo.some((raw) => {
    const token = raw.trim().toLowerCase();
    if (token === '') return false;
    return token === src || token === model || model.includes(token) || src.includes(token);
  });
}

/** 代演优先：自定义角色命中 reactTo 时优先于随包来源映射。 */
export function resolveProxyCharacter(userDataDir: string, source: string, modelName: string): CustomCharacterEntry | null {
  return readCustomCharacters(userDataDir).entries.find((entry) => matchesReactTo(entry.data, source, modelName)) ?? null;
}

/** 姿态台词：优先请求姿态，缺失回退 idle。 */
export function linesForPose(data: PetCustomCharacter, pose: string): string[] {
  return data.lines[pose] ?? data.lines.idle ?? [];
}

export function poseFileStat(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}
