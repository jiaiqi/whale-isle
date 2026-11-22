/**
 * T-M6-06 星露谷 SMAPI Mod 管理 —— Mods 目录扫描。
 *
 * 设计来源（SMAPI 目录约定）：
 * - SMAPI 只遍历 Mods 目录的一层子目录，且只装载含 manifest.json 的目录；
 *   没有 manifest 的目录（如玩家自建的分类文件夹）会被静默跳过，这里保持一致。
 * - 禁用态是 `manifest.json.disabled`：扫描时应把它当作「存在但已禁用」，
 *   解析内容照常展示，方便中控台列出可重新启用的 Mod。
 * - 两个文件同时存在时 SMAPI 会装载 manifest.json，但这是手工改名留下的半状态，
 *   这里仍列出并标注 parseError，让用户看到异常（同时 enabled 置 false）。
 * - manifest 损坏时 SMAPI 会拒绝装载，但用户需要看到这个 Mod 才能修，
 *   所以仍以目录名兜底列出，并把 enabled 置 false + parseError 说明原因。
 * - SMAPI 本体也是一个 Mod（UniqueID = Pathoschild.SMAPI），其 Version 即运行时版本。
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StardewModInfo, StardewModsSnapshot } from '@workbench/shared-protocol';
import {
  DISABLED_MANIFEST_FILE,
  MANIFEST_CONFLICT_ERROR,
  MOD_MANIFEST_FILE,
  SMAPI_UNIQUE_ID,
} from './constants';
import { readTextIfPresent } from './fs-util';
import { parseSmapiManifest } from './manifest';

/** 稳定排序：先 name，再 folderName（逐码点比较，避免 locale 影响跨平台一致性） */
const compareMods = (a: StardewModInfo, b: StardewModInfo): number => {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.folderName !== b.folderName) return a.folderName < b.folderName ? -1 : 1;
  return 0;
};

/** 读取单个 Mod 目录；没有 manifest 两种形态时返回 null（等价于 SMAPI 跳过该目录） */
const readModFolder = async (folderPath: string, folderName: string): Promise<StardewModInfo | null> => {
  const [enabledText, disabledText] = await Promise.all([
    readTextIfPresent(join(folderPath, MOD_MANIFEST_FILE)),
    readTextIfPresent(join(folderPath, DISABLED_MANIFEST_FILE)),
  ]);
  if (enabledText === null && disabledText === null) return null;

  const conflict = enabledText !== null && disabledText !== null;
  // 两者并存时优先展示 enabled 的 manifest.json 内容（与 SMAPI 装载行为一致）
  const parsed = parseSmapiManifest(enabledText ?? disabledText ?? '');
  const errors: string[] = [];
  if (parsed.error !== '') errors.push(parsed.error);
  if (conflict) errors.push(MANIFEST_CONFLICT_ERROR);
  const parseError = errors.join('；');

  return {
    folderName,
    uniqueId: parsed.manifest?.uniqueId ?? '',
    name: parsed.manifest?.name ?? folderName,
    author: parsed.manifest?.author ?? '',
    version: parsed.manifest?.version ?? '',
    description: parsed.manifest?.description ?? '',
    // SMAPI 会拒绝装载损坏 manifest，也会跳过 .disabled
    enabled: enabledText !== null && parseError === '',
    contentType: parsed.manifest?.contentType ?? '',
    minimumApiVersion: parsed.manifest?.minimumApiVersion ?? '',
    parseError,
  };
};

/** 从扫描结果提取 SMAPI 本体版本（UniqueID 优先，忠实还原 name 标记的旧版安装） */
const findSmapiVersion = (mods: readonly StardewModInfo[]): string => {
  const smapi = mods.find(
    (mod) =>
      mod.version !== '' &&
      (mod.uniqueId === SMAPI_UNIQUE_ID || mod.name.toLowerCase() === 'smapi'),
  );
  return smapi?.version ?? '';
};

/**
 * 扫描 Mods 目录并生成快照。
 * 目录不存在（游戏未安装 / 未配置）时返回 exists:false 的空快照，不抛错。
 */
export async function scanModsDir(modsDir: string): Promise<StardewModsSnapshot> {
  const scannedAt = Date.now();
  let entries: Dirent[];
  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch {
    return { modsDir, exists: false, mods: [], smapiVersion: '', scannedAt };
  }

  const mods: StardewModInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 隐藏目录（含 .git/.DS_Store 类）与 node_modules 不是 SMAPI Mod
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const mod = await readModFolder(join(modsDir, entry.name), entry.name);
    if (mod !== null) mods.push(mod);
  }
  mods.sort(compareMods);
  return { modsDir, exists: true, mods, smapiVersion: findSmapiVersion(mods), scannedAt };
}
