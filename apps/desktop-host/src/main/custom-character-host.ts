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
import { claimFirstMeeting, fileGreetingStore, resolveGreeting, ymd, type GreetingResolution } from './greeting-schedule';

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
    ipcMain.handle('custom:pose-config', (_event, characterId: string) => {
      const id = String(characterId);
      const dirId = id.startsWith('custom-') ? id.slice('custom-'.length) : id;
      const entry = readCustomCharacters(options.userDataDir).entries.find((item) => item.id === dirId || item.character.id === id);
      if (entry === undefined) return { ok: false };
      return {
        ok: true,
        correctedPose: entry.data.correctedPose,
        longThink: entry.data.longThink,
        pokePose: entry.data.pokePose,
        fx: entry.data.fx,
        egg: entry.data.egg,
        idleActions: entry.data.idleActions,
        glyph: entry.data.glyph,
        apps: entry.data.apps,
      };
    });
    /**
     * 首见登场（T-M6-55）：节日姿态优先 → 时段姿态 → 缺图返回 null（渲染层回退每日问候）。
     * 按「角色 id + 日期 + 键」落盘去重，同一角色同一天同一场景只触发一次。
     */
    ipcMain.handle('custom:greeting', (_event, characterId: string) => {
      const id = String(characterId);
      const dirId = id.startsWith('custom-') ? id.slice('custom-'.length) : id;
      const entry = readCustomCharacters(options.userDataDir).entries.find((item) => item.id === dirId || item.character.id === id);
      if (entry === undefined) return { ok: true, greeting: null };
      const now = new Date();
      const resolved: GreetingResolution | null = resolveGreeting({
        date: now,
        availablePoses: entry.poses,
        lines: entry.data.lines,
      });
      if (resolved === null) return { ok: true, greeting: null };
      const first = claimFirstMeeting(
        fileGreetingStore(options.userDataDir),
        entry.character.id,
        ymd(now),
        resolved.key,
        now,
      );
      if (!first) return { ok: true, greeting: null };
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
