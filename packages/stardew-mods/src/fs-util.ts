/**
 * T-M6-06 星露谷 Mod 管理 —— 不抛错的文件系统探测原语（零外部依赖）。
 *
 * 设计来源：SMAPI 的文件夹约定决定了管理逻辑要频繁回答「这个路径存不存在」
 * 「manifest 读得出来吗」这类问题；游戏未安装、目录被删、权限不足都应是
 * 正常业务分支而不是异常，所以统一在这里把 fs 错误折叠成 null / false，
 * 同时提供 unknown → 中文错误短句的转换，避免各处重复 try/catch。
 */
import { lstat, readFile } from 'node:fs/promises';

/** unknown 错误值 → 可读文本（fs 错误自带 message；非 Error 值退化为 String） */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 路径是否存在（lstat：悬空符号链接也视为存在，避免对坏链接做后续 rename/copy）。
 * 任何错误（ENOENT / ENOTDIR / EACCES）都返回 false，不抛。
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取 UTF-8 文本；文件不存在、是目录或不可读时返回 null。
 * 扫描阶段把「读不到」等同于「没有这个 manifest」，由上层决定跳过还是标注损坏。
 */
export async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
