/**
 * T-M6-06 星露谷 Mod 目录定位与目录名清洗（纯函数，不访问 fs）。
 *
 * 设计来源（Steam / SMAPI 安装目录约定）：
 * - Steam 版《星露谷物语》的 Mods 位于 `<SteamLibrary>/steamapps/common/Stardew Valley/Mods`。
 * - macOS 上 SMAPI 实际安装在 `Stardew Valley/Contents/MacOS/Mods`，但不少教程让用户
 *   在游戏根目录自建 `Mods`，所以两个候选都返回，由调用方用 exists 探测真实目录。
 * - Windows 默认库在 `Program Files (x86)`，部分 64 位机器只有 `Program Files`。
 * - Linux 同时存在 `~/.steam/steam` 与 `~/.local/share/Steam` 两套 Steam 布局。
 * - 安装压缩包时目录名可能带空格、盘符非法字符等，需要清洗成安全的单段目录名。
 */
import { join } from 'node:path';

/** 星露谷 Mods 目录候选（按优先级排序；调用方负责探测哪一个存在） */
export function guessModsDirs(platform: NodeJS.Platform, homedir: string): string[] {
  if (platform === 'darwin') {
    const gameRoot = join(
      homedir,
      'Library',
      'Application Support',
      'Steam',
      'steamapps',
      'common',
      'Stardew Valley',
    );
    // SMAPI on macOS 把 Mods 放进 app bundle 的 Contents/MacOS 下，其次才是游戏根目录
    return [join(gameRoot, 'Contents', 'MacOS', 'Mods'), join(gameRoot, 'Mods')];
  }
  if (platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stardew Valley\\Mods',
      'C:\\Program Files\\Steam\\steamapps\\common\\Stardew Valley\\Mods',
    ];
  }
  if (platform === 'linux') {
    return [
      join(homedir, '.steam', 'steam', 'steamapps', 'common', 'Stardew Valley', 'Mods'),
      join(homedir, '.local', 'share', 'Steam', 'steamapps', 'common', 'Stardew Valley', 'Mods'),
    ];
  }
  return [];
}

/**
 * 是否为安全的单段目录名（防路径穿越）。
 * 拒绝空串、`.`、`..`，以及含路径分隔符（`/` `\`）或 NUL 的输入。
 */
export function isSafeModFolderName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  return !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

/** 文件系统 / Windows 目录名非法字符（含控制字符），统一替换为下划线 */
const ILLEGAL_FOLDER_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * 把源目录名清洗成可安装的目标文件夹名：
 * 非法字符 → `_`；去掉首尾的点与空格（避免隐藏目录 / Windows 尾点问题）；空结果兜底 `mod`。
 */
export function sanitizeModFolderName(raw: string): string {
  const cleaned = raw.replace(ILLEGAL_FOLDER_CHARS, '_').replace(/^[. ]+|[. ]+$/g, '');
  return cleaned === '' ? 'mod' : cleaned;
}
