/**
 * T-M6-06 星露谷 Mod 安装 —— 从解压目录复制到 Mods。
 *
 * 设计来源（SMAPI / Nexus 压缩包惯例）：
 * - Mod 压缩包通常有两种结构：根目录直接是 Mod（含 manifest.json），或外面多包一层
 *   同名文件夹（Nexus 的 `<ModName>-<version>/` 结构）。因此先定位真正的 Mod 根。
 * - 一个压缩包内含多个 Mod 时无法替用户决定装哪个（SMAPI 也不支持批量），
 *   直接拒绝并列出前三个候选，提示分别安装。
 * - 目标目录沿用源目录名；同名已存在时追加 `-2`、`-3`…（不覆盖现有 Mod，
 *   避免用户丢文件）；名字先清洗非法字符再落盘。
 * - 复制失败不抛错：返回中文错误并清理本次创建的半成品目录，不碰其它 Mod。
 */
import type { Dirent } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { StardewModsOpResult } from '@workbench/shared-protocol';
import { MOD_MANIFEST_FILE } from './constants';
import { errorMessage, pathExists } from './fs-util';
import { sanitizeModFolderName } from './paths';
import { scanModsDir } from './scan';

/** 同名副本上限（base、base-2 … base-99） */
const MAX_FOLDER_SUFFIX = 99;

type ModRootLocation = { root: string } | { error: string };

/**
 * 定位压缩包内的 Mod 根：源目录本身有 manifest.json 就用它；否则只认恰好一个
 * 一级子目录（含 manifest.json）的情况。找不到 / 多个候选都返回中文错误。
 */
const locateModRoot = async (sourceDir: string): Promise<ModRootLocation> => {
  if (await pathExists(join(sourceDir, MOD_MANIFEST_FILE))) {
    return { root: sourceDir };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    return { error: `读取源目录失败: ${errorMessage(error)}` };
  }
  const candidates: string[] = [];
  let onlyCandidate = '';
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!(await pathExists(join(sourceDir, entry.name, MOD_MANIFEST_FILE)))) continue;
    if (candidates.length === 0) onlyCandidate = entry.name;
    candidates.push(entry.name);
  }
  if (candidates.length === 0) {
    return { error: '源目录中未找到 manifest.json' };
  }
  if (candidates.length > 1) {
    candidates.sort();
    return {
      error: `压缩包内包含多个 Mod，请解压后分别安装（候选：${candidates.slice(0, 3).join('、')}）`,
    };
  }
  return { root: join(sourceDir, onlyCandidate) };
};

/** 在 modsDir 下挑一个不冲突的文件夹名：base → base-2 → base-3 …（重名不覆盖） */
const pickAvailableFolderName = async (modsDir: string, base: string): Promise<string> => {
  if (!(await pathExists(join(modsDir, base)))) return base;
  for (let suffix = 2; suffix <= MAX_FOLDER_SUFFIX; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await pathExists(join(modsDir, candidate)))) return candidate;
  }
  throw new Error(`目标目录 ${base} 已存在 ${MAX_FOLDER_SUFFIX} 个同名副本，请先清理`);
};

/**
 * 从本地解压目录安装一个 Mod 到 modsDir。
 * 成功返回新文件夹名 + 安装后的目录快照；任何失败都折叠为 `{ ok:false, error }`。
 */
export async function installModFromDirectory(
  sourceDir: string,
  modsDir: string,
): Promise<StardewModsOpResult & { folderName?: string }> {
  const located = await locateModRoot(sourceDir);
  if ('error' in located) {
    return { ok: false, error: located.error };
  }
  const baseName = sanitizeModFolderName(basename(located.root));
  let destination = '';
  try {
    // 允许在尚未创建 Mods 的机器上安装（游戏未启动时目录可能不存在）
    await mkdir(modsDir, { recursive: true });
    const folderName = await pickAvailableFolderName(modsDir, baseName);
    destination = join(modsDir, folderName);
    await cp(located.root, destination, { recursive: true, force: false, errorOnExist: true });
    return { ok: true, folderName, snapshot: await scanModsDir(modsDir) };
  } catch (error) {
    // 只清理本次复制出来的半成品目录，绝不触碰同目录下已有 Mod
    if (destination !== '') {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    }
    return { ok: false, error: `安装 Mod 失败: ${errorMessage(error)}` };
  }
}
