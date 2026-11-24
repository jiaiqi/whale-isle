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
      return { ok: true, correctedPose: entry.data.correctedPose, longThink: entry.data.longThink, pokePose: entry.data.pokePose, fx: entry.data.fx, egg: entry.data.egg };
    });
    ipcMain.handle('custom:reload', () => {
      invalidateCustomCharacters();
      options.onReload();
      return { ok: true };
    });
  };
  return { registerIpc };
}
