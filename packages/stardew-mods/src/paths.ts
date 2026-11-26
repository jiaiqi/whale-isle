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

/** 星露谷游戏根目录候选（按优先级排序；调用方负责探测哪一个存在） */
export function guessGameRootDirs(platform: NodeJS.Platform, homedir: string): string[] {
  if (platform === 'darwin') {
    return [
      join(homedir, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Stardew Valley'),
    ];
  }
  if (platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stardew Valley',
      'C:\\Program Files\\Steam\\steamapps\\common\\Stardew Valley',
    ];
  }
  if (platform === 'linux') {
    return [
      join(homedir, '.steam', 'steam', 'steamapps', 'common', 'Stardew Valley'),
      join(homedir, '.local', 'share', 'Steam', 'steamapps', 'common', 'Stardew Valley'),
    ];
  }
  return [];
}

/**
 * 游戏可执行文件所在目录。
 * macOS 的 Steam 版没有外层 `.app`：真正的游戏运行目录在 `Stardew Valley/Contents/MacOS`，
 * SMAPI、Mods 与存档入口都在这一层；Windows/Linux 则是游戏根目录本身。
 */
export function gameExecutableDir(platform: NodeJS.Platform, gameRoot: string): string {
  return platform === 'darwin' ? join(gameRoot, 'Contents', 'MacOS') : gameRoot;
}

/** SMAPI 可执行文件候选（macOS 无扩展名，Windows 为 .exe） */
export function guessSmapiBinaries(platform: NodeJS.Platform, gameRoot: string): string[] {
  if (platform === 'win32') return [`${gameRoot}\\StardewModdingAPI.exe`];
  return [join(gameExecutableDir(platform, gameRoot), 'StardewModdingAPI')];
}

/** 星露谷 Mods 目录候选（按优先级排序；调用方负责探测哪一个存在） */
export function guessModsDirs(platform: NodeJS.Platform, homedir: string): string[] {
  const dirs: string[] = [];
  for (const gameRoot of guessGameRootDirs(platform, homedir)) {
    // Windows 用反斜杠拼接，保证在任意宿主上跑单测时输出稳定（与游戏真实路径一致）
    if (platform === 'win32') {
      dirs.push(`${gameRoot}\\Mods`);
      continue;
    }
    // macOS：SMAPI 把 Mods 放进 Contents/MacOS 下，其次才是游戏根目录；Linux 只有根目录
    dirs.push(join(gameExecutableDir(platform, gameRoot), 'Mods'));
    if (platform === 'darwin') dirs.push(join(gameRoot, 'Mods'));
  }
  return dirs;
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

/**
 * 联机隔离实例的 XDG 环境变量（`V2-P2-09B`）。
 *
 * 依据（本机 `System.Private.CoreLib.dll` 反编译）：macOS/Linux 上 .NET 的
 * `SpecialFolder.ApplicationData` 等于 `XDG_CONFIG_HOME`（**必须是绝对路径**），
 * 否则回退 `$HOME/.config`；`LocalApplicationData` 同理走 `XDG_DATA_HOME`。
 * 因此只改这两个变量就能把存档/设置/SMAPI mod-data 搬进隔离目录，而**不动 `HOME`**——
 * 不动 HOME 才不会影响 Steam 客户端与游戏许可校验。
 *
 * 非绝对路径返回 null：调用方必须如实拒绝（否则 .NET 会静默回退到 owner 的存档目录）。
 */
export function isolateDataEnv(isolateDataDir: string): { XDG_CONFIG_HOME: string; XDG_DATA_HOME: string } | null {
  if (!isAbsoluteDataDir(isolateDataDir)) return null;
  const root = isolateDataDir.replace(/[\\/]+$/u, '');
  if (root === '') return null;
  return { XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data') };
}

/** 绝对路径判定（POSIX `/…` 或 Windows `C:\…` / `C:/…`） */
export function isAbsoluteDataDir(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
}
