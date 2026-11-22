/**
 * 桌宠桌面偏好文件 KV（T-M6-19）：userData/pet-desktop-prefs.json。
 * 与 provider-vault 同模式（避免 better-sqlite3 ABI 冲突），原子写 + 契约安全解析；
 * 坏文件/非法字段一律回落 PetDesktopPrefsSchema 默认值，绝不崩主进程。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ipcMain } from 'electron';
import { PetDesktopPrefsSchema, type PetDesktopPrefs } from '@workbench/shared-protocol';

export interface PetPrefsStore {
  get(): PetDesktopPrefs;
  /** 局部更新（仅合并传入的一级字段；嵌套 position 整体替换） */
  patch(update: Partial<PetDesktopPrefs>): PetDesktopPrefs;
}

export function createPetPrefsStore(userDataDir: string): PetPrefsStore {
  const path = join(userDataDir, 'pet-desktop-prefs.json');
  let current = read();

  function read(): PetDesktopPrefs {
    try {
      if (existsSync(path)) {
        const parsed = PetDesktopPrefsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (parsed.success) return parsed.data;
      }
    } catch {
      /* 坏文件 → 默认值 */
    }
    return PetDesktopPrefsSchema.parse({});
  }

  function save(next: PetDesktopPrefs): void {
    current = next;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  }

  function patch(update: Partial<PetDesktopPrefs>): PetDesktopPrefs {
    const candidate = PetDesktopPrefsSchema.safeParse({ ...current, ...(update ?? {}) });
    const next = candidate.success ? candidate.data : current;
    save(next);
    return next;
  }

  ipcMain.handle('pet:prefs-get', () => current);
  ipcMain.handle('pet:prefs-set', (_event, update: Partial<PetDesktopPrefs>) => patch(update));

  return { get: () => current, patch };
}
