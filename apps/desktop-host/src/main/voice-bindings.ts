/**
 * 角色声线绑定（T-M6-46 语音中心）。
 *
 * 每个角色包自带默认音色（PetCharacter.voiceId）；用户可在「语音中心」为任意角色改绑，
 * 覆盖值落 `userData/voice-bindings.json`，主进程 `resolveVoiceId` 优先读取覆盖，
 * 于是多桌宠同屏时各说各的声线（T-M6-38 全局抢麦锁仍然 active≤1）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ipcMain } from 'electron';

interface BindingFile {
  version: 1;
  bindings: Record<string, string>;
}

export interface CharacterVoiceView {
  characterId: string;
  displayName: string;
  /** 当前生效音色（覆盖值优先，否则角色包默认） */
  voiceId: string;
  defaultVoiceId: string;
  overridden: boolean;
}

export interface VoiceBindingStore {
  /** 覆盖值（无覆盖返回 undefined） */
  get(characterId: string): string | undefined;
  /** 生效音色：覆盖值 → 角色默认 */
  resolve(characterId: string): string | undefined;
  set(characterId: string, voiceId: string): { ok: true } | { ok: false; error: string };
  all(): Record<string, string>;
}

function readFile(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BindingFile>;
    if (parsed.version !== 1 || typeof parsed.bindings !== 'object' || parsed.bindings === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.bindings)) {
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function createVoiceBindingStore(options: {
  filePath: string;
  /** 角色包默认音色（主进程注册表） */
  defaultVoiceOf: (characterId: string) => string | undefined;
}): VoiceBindingStore {
  let bindings = readFile(options.filePath);
  const persist = (): void => {
    mkdirSync(dirname(options.filePath), { recursive: true });
    const payload: BindingFile = { version: 1, bindings };
    const temp = `${options.filePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(temp, options.filePath);
  };
  return {
    get: (characterId) => bindings[characterId],
    resolve: (characterId) => bindings[characterId] ?? options.defaultVoiceOf(characterId),
    set(characterId, voiceId) {
      if (characterId.trim() === '') return { ok: false, error: '缺少角色 id' };
      const value = voiceId.trim();
      if (value === '' || value.length > 120) return { ok: false, error: '非法音色 id' };
      const fallback = options.defaultVoiceOf(characterId);
      if (fallback === undefined) return { ok: false, error: `未知角色：${characterId}` };
      if (value === fallback) delete bindings[characterId];
      else bindings[characterId] = value;
      try {
        persist();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
    all: () => ({ ...bindings }),
  };
}

/** 语音中心顶部的 9 角色声线绑定条数据。 */
export function characterVoiceViews(
  characters: Array<{ id: string; displayName: string; voiceId: string }>,
  store: VoiceBindingStore,
): CharacterVoiceView[] {
  return characters.map((character) => {
    const overridden = store.get(character.id);
    return {
      characterId: character.id,
      displayName: character.displayName,
      voiceId: overridden ?? character.voiceId,
      defaultVoiceId: character.voiceId,
      overridden: overridden !== undefined,
    };
  });
}

export function registerVoiceBindingIpc(options: {
  store: VoiceBindingStore;
  characters: () => Array<{ id: string; displayName: string; voiceId: string }>;
}): void {
  ipcMain.handle('voice:character-bindings', () => characterVoiceViews(options.characters(), options.store));
  ipcMain.handle('voice:character-bind', (_event, characterId: string, voiceId: string) =>
    options.store.set(String(characterId ?? ''), String(voiceId ?? '')));
}
