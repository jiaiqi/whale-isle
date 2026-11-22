/**
 * T-M6-06 星露谷 Mod 启停 —— SMAPI 官方语义：改文件名即开关。
 *
 * 设计来源（SMAPI 目录约定）：SMAPI 只加载目录下名为 manifest.json 的文件，
 * 因此禁用 = 改名为 manifest.json.disabled，启用 = 改回来。官方与社区都用这种
 * 零配置手段，不需要改 manifest 内容、不需要额外状态文件；本包只做单次 rename，
 * 绝不重写 manifest。folderName 必须是单段目录名，先做路径穿越校验再拼路径。
 */
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { StardewModsOpResult } from '@workbench/shared-protocol';
import { DISABLED_MANIFEST_FILE, MANIFEST_CONFLICT_ERROR, MOD_MANIFEST_FILE } from './constants';
import { errorMessage, pathExists } from './fs-util';
import { isSafeModFolderName } from './paths';
import { scanModsDir } from './scan';

/** 未找到任何 manifest 形态（目录删了 / 不是 Mod 目录） */
const MISSING_MANIFEST_ERROR = '未找到 manifest.json 或 manifest.json.disabled';

/**
 * 单次改名；返回空串表示成功，否则返回中文错误短句（不抛）。
 * 单独导出便于对 rename 失败路径做确定性单测。
 */
export async function renameManifestFile(fromPath: string, toPath: string): Promise<string> {
  try {
    await rename(fromPath, toPath);
    return '';
  } catch (error) {
    return `切换启用状态失败: ${errorMessage(error)}`;
  }
}

/**
 * 启用 / 禁用指定 Mod 目录，成功后回写最新快照。
 * 已处于目标状态时幂等返回 ok（不重复 rename），两个 manifest 并存时拒绝操作，
 * 避免替用户猜测该保留哪一份。
 */
export async function setModEnabled(
  modsDir: string,
  folderName: string,
  enabled: boolean,
): Promise<StardewModsOpResult> {
  if (!isSafeModFolderName(folderName)) {
    return { ok: false, error: '非法目录名' };
  }
  const folderPath = join(modsDir, folderName);
  const enabledPath = join(folderPath, MOD_MANIFEST_FILE);
  const disabledPath = join(folderPath, DISABLED_MANIFEST_FILE);
  const [hasEnabled, hasDisabled] = await Promise.all([
    pathExists(enabledPath),
    pathExists(disabledPath),
  ]);

  if (hasEnabled && hasDisabled) {
    return { ok: false, error: MANIFEST_CONFLICT_ERROR };
  }
  if (!hasEnabled && !hasDisabled) {
    return { ok: false, error: MISSING_MANIFEST_ERROR };
  }
  // 幂等：启用时 manifest.json 已在，或禁用时 .disabled 已在
  if (enabled === hasEnabled) {
    return { ok: true, snapshot: await scanModsDir(modsDir) };
  }

  const failure = enabled
    ? await renameManifestFile(disabledPath, enabledPath)
    : await renameManifestFile(enabledPath, disabledPath);
  if (failure !== '') {
    return { ok: false, error: failure };
  }
  return { ok: true, snapshot: await scanModsDir(modsDir) };
}
