/**
 * 星露谷启动/建档偏好持久化与隔离目录中文双保险（V2-P3-07D）。
 *
 * 职责：
 *   1. 在 `userData/stardew-launch-prefs.json` 持久化默认存储模式（默认 `isolated` 鲸屿专属隔离目录，保护 owner 存档）、
 *      默认语言（默认跟随当前中控台 `zh`）、建档默认表单值与联机默认小屋设置；
 *   2. 在隔离目录首次启动或切换语言时，仅同步隔离目录下 `XDG_CONFIG_HOME/StardewValley/startup_preferences`
 *      的 `<languageCode>`（绝不读取或修改 owner 常规目录 `~/.config/StardewValley/startup_preferences`）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  StardewLaunchPrefsSchema,
  type StardewLanguageCode,
  type StardewLaunchPrefs,
} from '@workbench/shared-protocol';

export interface StardewLaunchPrefsStore {
  get(): StardewLaunchPrefs;
  patch(update: unknown): { ok: boolean; prefs: StardewLaunchPrefs; error?: string };
}

/** 鲸屿专属星露谷隔离根目录（放在 Electron userData 下，仅注入 XDG_CONFIG_HOME / XDG_DATA_HOME） */
export function defaultIsolatedDataDir(userDataDir: string): string {
  return join(userDataDir, 'stardew-isolated');
}

/** 创建星露谷启动偏好存储（坏文件安全回落默认值，原子落盘） */
export function createStardewLaunchPrefs(userDataDir: string): StardewLaunchPrefsStore {
  const filePath = join(userDataDir, 'stardew-launch-prefs.json');

  const read = (): StardewLaunchPrefs => {
    try {
      if (existsSync(filePath)) {
        const parsed = StardewLaunchPrefsSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
        if (parsed.success) return parsed.data;
      }
    } catch {
      /* 配置文件损坏时回落默认值 */
    }
    return StardewLaunchPrefsSchema.parse({});
  };

  let current = read();

  const save = (next: StardewLaunchPrefs): void => {
    current = next;
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
  };

  return {
    get: () => ({ ...current }),
    patch(update: unknown) {
      if (update === null || typeof update !== 'object' || Array.isArray(update)) {
        return { ok: false, prefs: { ...current }, error: '启动偏好更新参数必须是对象' };
      }
      const candidate = StardewLaunchPrefsSchema.safeParse({ ...current, ...(update as Record<string, unknown>) });
      if (!candidate.success) {
        const issue = candidate.error.issues[0];
        return {
          ok: false,
          prefs: { ...current },
          error: issue?.message ?? '启动偏好参数不合法',
        };
      }
      save(candidate.data);
      return { ok: true, prefs: { ...current } };
    },
  };
}

function buildInitialStartupPreferencesXml(language: StardewLanguageCode): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<StartupPreferences xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    '  <windowMode>1</windowMode>',
    `  <languageCode>${language}</languageCode>`,
    '  <clientOptions>',
    '    <ipConnectionsEnabled>true</ipConnectionsEnabled>',
    '    <enableServer>true</enableServer>',
    '  </clientOptions>',
    '</StartupPreferences>',
    '',
  ].join('\n');
}

/**
 * 隔离目录语言双保险第一重：仅在隔离 `xdgConfigHome` 内初始化或同步 `<languageCode>`。
 * 绝不碰用户常规 `~/.config/StardewValley/startup_preferences`。
 */
export function ensureIsolatedStartupLanguage(
  xdgConfigHome: string,
  language: StardewLanguageCode = 'zh',
): { path: string; updated: boolean; created: boolean } {
  const prefPath = join(xdgConfigHome, 'StardewValley', 'startup_preferences');
  mkdirSync(dirname(prefPath), { recursive: true });

  if (!existsSync(prefPath)) {
    const tmp = `${prefPath}.tmp`;
    writeFileSync(tmp, buildInitialStartupPreferencesXml(language), 'utf8');
    renameSync(tmp, prefPath);
    return { path: prefPath, updated: true, created: true };
  }

  const raw = readFileSync(prefPath, 'utf8');
  const tagRe = /<languageCode>([^<]*)<\/languageCode>/u;
  const matched = tagRe.exec(raw);
  if (matched) {
    if (matched[1]?.trim() === language) {
      return { path: prefPath, updated: false, created: false };
    }
    const next = raw.replace(tagRe, `<languageCode>${language}</languageCode>`);
    const tmp = `${prefPath}.tmp`;
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, prefPath);
    return { path: prefPath, updated: true, created: false };
  }

  const closeTag = '</StartupPreferences>';
  const next = raw.includes(closeTag)
    ? raw.replace(closeTag, `  <languageCode>${language}</languageCode>\n${closeTag}`)
    : buildInitialStartupPreferencesXml(language);
  const tmp = `${prefPath}.tmp`;
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, prefPath);
  return { path: prefPath, updated: true, created: false };
}
