/**
 * 自定义角色 IPC 宿主（T-M6-53）：列表/详情/保存/改名/克隆/热重载。
 * 只暴露角色协议与姿态名，不把 userData 绝对路径回传渲染层。
 */
import { ipcMain } from 'electron';
import {
  cloneBuiltinCharacter,
  invalidateCustomCharacters,
  readCustomCharacters,
  renameCustomCharacter,
  saveCustomCharacter,
  type CustomCharacterEntry,
} from './custom-character';
import { claimFirstMeeting, fileGreetingStore, resolveGreeting, ymd, type GreetingLog, type GreetingResolution } from './greeting-schedule';
import { readCrossPetPoseProfile, type CrossPetPoseProfile } from './pet-packs';

/**
 * 统一姿态角色档案（T-M6-63）：userData 自定义角色与随包 CrossPet 角色共用同一读取口径。
 * 只返回真实存在的字段；任何缺图/缺字段都保持 undefined，由渲染层如实回退。
 */
export interface ResolvedPoseCharacterProfile {
  characterId: string;
  name: string;
  source: 'custom' | 'crosspet';
  poses: string[];
  greeting: string;
  lines: Record<string, string[]>;
  correctedPose?: string;
  longThink?: { after: number; pose: string };
  pokePose?: string;
  fx?: Record<string, string>;
  egg?: boolean;
  idleActions?: string[];
  glyph?: { fill?: string; stroke?: string; text?: string };
  apps?: string[];
  host?: string;
  hostSkin?: string;
  aura?: string;
  accent?: string;
  outfit?: string;
}

/** 首见问候判定（放纯函数便于确定性单测）：解析姿态 → 按角色+日期+键去重。 */
export function resolveProfileGreeting(
  profile: ResolvedPoseCharacterProfile,
  store: { read: () => GreetingLog; write: (log: GreetingLog) => void },
  now: Date,
): GreetingResolution | null {
  const resolved = resolveGreeting({
    date: now,
    availablePoses: profile.poses,
    lines: profile.lines,
  });
  if (resolved === null) return null;
  const first = claimFirstMeeting(store, profile.characterId, ymd(now), resolved.key, now);
  return first ? resolved : null;
}

/**
 * 解析某个 characterId 的完整姿态档案（T-M6-63 单点读取助手）：
 *   1. 先匹配 userData 下 `custom-*` 自定义角色；
 *   2. 否则 `crosspet-*` 读取随包 crosspet/characters/<dir>/character.json 与姿态图；
 *   3. 都没有返回 null（调用方保留原有回退，不造假）。
 */
export function resolvePoseCharacterProfile(options: {
  userDataDir: string;
  packsRoot: string;
  characterId: string;
}): ResolvedPoseCharacterProfile | null {
  const id = String(options.characterId);
  const dirId = id.startsWith('custom-') ? id.slice('custom-'.length) : id;
  const entry = readCustomCharacters(options.userDataDir).entries.find(
    (item) => item.id === dirId || item.character.id === id,
  );
  if (entry !== undefined) return profileFromCustom(entry);
  const crossPet = readCrossPetPoseProfile(options.packsRoot, id);
  if (crossPet !== null) return profileFromCrossPet(crossPet);
  return null;
}

function profileFromCustom(entry: CustomCharacterEntry): ResolvedPoseCharacterProfile {
  const data = entry.data;
  return {
    characterId: entry.character.id,
    name: entry.character.displayName,
    source: 'custom',
    poses: entry.poses,
    greeting: data.greeting,
    lines: data.lines,
    correctedPose: data.correctedPose,
    longThink: data.longThink,
    pokePose: data.pokePose,
    fx: data.fx,
    egg: data.egg,
    idleActions: data.idleActions,
    glyph: data.glyph,
    apps: data.apps,
    host: data.host,
    hostSkin: data.hostSkin,
    aura: data.aura,
    accent: data.accent,
    outfit: data.outfit,
  };
}

function profileFromCrossPet(profile: CrossPetPoseProfile): ResolvedPoseCharacterProfile {
  return {
    characterId: profile.characterId,
    name: profile.name,
    source: 'crosspet',
    poses: profile.poses,
    greeting: profile.greeting,
    lines: profile.lines,
    ...(profile.correctedPose === undefined ? {} : { correctedPose: profile.correctedPose }),
    ...(profile.longThink === undefined ? {} : { longThink: profile.longThink }),
    ...(profile.pokePose === undefined ? {} : { pokePose: profile.pokePose }),
    ...(profile.fx === undefined ? {} : { fx: profile.fx }),
    ...(profile.egg === undefined ? {} : { egg: profile.egg }),
    ...(profile.idleActions === undefined ? {} : { idleActions: profile.idleActions }),
    ...(profile.glyph === undefined ? {} : { glyph: profile.glyph }),
    ...(profile.apps === undefined ? {} : { apps: profile.apps }),
    ...(profile.host === undefined ? {} : { host: profile.host }),
    ...(profile.hostSkin === undefined ? {} : { hostSkin: profile.hostSkin }),
    ...(profile.aura === undefined ? {} : { aura: profile.aura }),
    ...(profile.accent === undefined ? {} : { accent: profile.accent }),
    ...(profile.outfit === undefined ? {} : { outfit: profile.outfit }),
  };
}

export interface CustomCharacterSummary {
  id: string;
  characterId: string;
  name: string;
  poses: string[];
  reactTo: string | string[];
  outfit: string;
  actionCount: number;
  errors: string[];
}

function toSummary(entry: CustomCharacterEntry): CustomCharacterSummary {
  return {
    id: entry.id,
    characterId: entry.character.id,
    name: entry.character.displayName,
    poses: entry.poses,
    reactTo: entry.data.reactTo,
    outfit: entry.data.outfit,
    actionCount: entry.character.actionCount,
    errors: [],
  };
}

export function createCustomCharacterHost(options: {
  userDataDir: string;
  packsRoot: string;
  /** 热重载后广播（index 负责刷新角色列表并让桌宠窗重载 manifest） */
  onReload: () => void;
}): { registerIpc(): void } {
  const registerIpc = (): void => {
    ipcMain.handle('custom:list', () => {
      const result = readCustomCharacters(options.userDataDir);
      return { entries: result.entries.map(toSummary), errors: result.errors };
    });
    ipcMain.handle('custom:get', (_event, id: string) => {
      const entry = readCustomCharacters(options.userDataDir).entries.find((item) => item.id === String(id));
      if (entry === undefined) return { ok: false, error: `自定义角色不存在：${id}` };
      return { ok: true, id: entry.id, name: entry.character.displayName, poses: entry.poses, data: entry.data, character: entry.character };
    });
    ipcMain.handle('custom:save', (_event, id: string, input: unknown) => {
      try {
        return { ...saveCustomCharacter(options.userDataDir, String(id), input), ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('custom:rename', (_event, id: string, name: string) => {
      try {
        return { ...renameCustomCharacter(options.userDataDir, String(id), String(name)), ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('custom:clone', (_event, input: { builtinId: string; newId: string; displayName?: string }) => {
      try {
        const result = cloneBuiltinCharacter({
          packsRoot: options.packsRoot,
          userDataDir: options.userDataDir,
          builtinId: String(input?.builtinId ?? ''),
          newId: String(input?.newId ?? ''),
          ...(input?.displayName === undefined ? {} : { displayName: input.displayName }),
        });
        options.onReload();
        return { ...result, ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    /**
     * 姿态扩展配置（T-M6-63）：自定义角色与随包 `crosspet-*` 共用统一读取助手。
     * 返回字段均来自真实 character.json；缺省字段不下发，渲染层不会误播不存在的姿态。
     */
    ipcMain.handle('custom:pose-config', (_event, characterId: string) => {
      const profile = resolvePoseCharacterProfile({
        userDataDir: options.userDataDir,
        packsRoot: options.packsRoot,
        characterId: String(characterId),
      });
      if (profile === null) return { ok: false };
      return {
        ok: true,
        source: profile.source,
        name: profile.name,
        poses: profile.poses,
        greeting: profile.greeting,
        lines: profile.lines,
        ...(profile.correctedPose === undefined ? {} : { correctedPose: profile.correctedPose }),
        ...(profile.longThink === undefined ? {} : { longThink: profile.longThink }),
        ...(profile.pokePose === undefined ? {} : { pokePose: profile.pokePose }),
        ...(profile.fx === undefined ? {} : { fx: profile.fx }),
        ...(profile.egg === undefined ? {} : { egg: profile.egg }),
        ...(profile.idleActions === undefined ? {} : { idleActions: profile.idleActions }),
        ...(profile.glyph === undefined ? {} : { glyph: profile.glyph }),
        ...(profile.apps === undefined ? {} : { apps: profile.apps }),
        ...(profile.host === undefined ? {} : { host: profile.host }),
        ...(profile.hostSkin === undefined ? {} : { hostSkin: profile.hostSkin }),
        ...(profile.aura === undefined ? {} : { aura: profile.aura }),
        ...(profile.accent === undefined ? {} : { accent: profile.accent }),
        ...(profile.outfit === undefined ? {} : { outfit: profile.outfit }),
      };
    });
    /**
     * 首见登场（T-M6-55 / T-M6-63）：节日姿态优先 → 时段姿态 → 缺图返回 null（渲染层回退每日问候）。
     * 自定义与随包 CrossPet 角色共用同一套 `resolveGreeting` + `claimFirstMeeting`，
     * 按「角色 id + 日期 + 键」落盘去重，同一角色同一天同一场景只触发一次。
     */
    ipcMain.handle('custom:greeting', (_event, characterId: string) => {
      const profile = resolvePoseCharacterProfile({
        userDataDir: options.userDataDir,
        packsRoot: options.packsRoot,
        characterId: String(characterId),
      });
      if (profile === null) return { ok: true, greeting: null };
      const now = new Date();
      const resolved = resolveProfileGreeting(profile, fileGreetingStore(options.userDataDir), now);
      if (resolved === null) return { ok: true, greeting: null };
      return { ok: true, greeting: resolved };
    });
    ipcMain.handle('custom:reload', () => {
      invalidateCustomCharacters();
      options.onReload();
      return { ok: true };
    });
  };
  return { registerIpc };
}
