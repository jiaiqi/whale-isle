/**
 * 原生 helper 随包解析（预览构建 V2-P4-05）：
 * 安装态不再从仓库 `tools/native/*.swift` 现编，而是优先使用随包分发的预编译二进制。
 *
 * 布局（electron-builder `extraResources` 写入 `Contents/Resources/native/<platform>-<arch>/`）：
 *   native/darwin-arm64/whale-input-helper
 *   native/darwin-arm64/whale-audio-helper
 *   native/darwin-arm64/sha256.json        # { "whale-input-helper": "<sha256>", ... }
 *
 * 诚实口径：
 * - 预编译目录存在但二进制缺失、清单缺失、哈希不符或不可执行 → **fail-closed**（fatal），
 *   绝不回退源码编译，更不冒充 helper 可用；
 * - 预编译目录不存在（开发态）→ 返回 not_found，调用方继续走原有的 swiftc 源码编译回退。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PrebuiltHelperLookup {
  ok: boolean;
  helperPath?: string;
  reason?: string;
  /** true = 找到了随包目录但内容不可信，调用方必须 fail-closed，不得静默回退编译 */
  fatal?: boolean;
}

export interface LocatePrebuiltHelperOptions {
  /** 二进制文件名，如 whale-audio-helper */
  name: string;
  /** 默认 process.platform */
  platform?: NodeJS.Platform;
  /** 默认 process.arch */
  arch?: string;
  /** 安装态为 process.resourcesPath；开发态显式传 null 跳过随包查找 */
  resourcesPath?: string | null;
  /** 测试可注入 */
  hashFile?: (filePath: string) => string;
  /** 测试可注入 */
  isExecutable?: (filePath: string) => boolean;
}

/** 从 Electron 的 process.resourcesPath 取默认值（vitest 里为 undefined，安全返回 null） */
export function defaultResourcesPath(): string | null {
  const value = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  return typeof value === 'string' && value !== '' ? value : null;
}

function defaultHashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function defaultIsExecutable(filePath: string): boolean {
  try {
    return (statSync(filePath).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * 查找并校验随包预编译 helper。
 * 返回 fatal 的三种情况（目录存在但内容坏）必须由调用方直接判定不可用。
 */
export function locatePrebuiltHelper(options: LocatePrebuiltHelperOptions): PrebuiltHelperLookup {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  const resourcesPath = options.resourcesPath === undefined ? defaultResourcesPath() : options.resourcesPath;
  if (resourcesPath === null || resourcesPath === '') {
    return { ok: false, reason: 'prebuilt_not_found' };
  }

  const arch = options.arch ?? process.arch;
  const bundleDir = join(resourcesPath, 'native', `darwin-${arch}`);
  const helperPath = join(bundleDir, options.name);
  const manifestPath = join(bundleDir, 'sha256.json');
  if (!existsSync(bundleDir)) return { ok: false, reason: 'prebuilt_not_found' };
  if (!existsSync(helperPath)) {
    return { ok: false, fatal: true, reason: `prebuilt_helper_missing: ${helperPath}` };
  }
  if (!existsSync(manifestPath)) {
    return { ok: false, fatal: true, reason: `prebuilt_manifest_missing: ${manifestPath}` };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, fatal: true, reason: `prebuilt_manifest_invalid: ${String(error)}` };
  }
  if (typeof manifest !== 'object' || manifest === null) {
    return { ok: false, fatal: true, reason: 'prebuilt_manifest_invalid: not an object' };
  }
  const expected = (manifest as Record<string, unknown>)[options.name];
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
    return { ok: false, fatal: true, reason: `prebuilt_manifest_entry_missing: ${options.name}` };
  }

  const hashFile = options.hashFile ?? defaultHashFile;
  let actual: string;
  try {
    actual = hashFile(helperPath).toLowerCase();
  } catch (error) {
    return { ok: false, fatal: true, reason: `prebuilt_unreadable: ${String(error)}` };
  }
  if (actual !== expected.toLowerCase()) {
    return {
      ok: false,
      fatal: true,
      reason: `prebuilt_integrity_mismatch: expected ${expected.toLowerCase()} actual ${actual}`,
    };
  }

  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  if (!isExecutable(helperPath)) {
    return { ok: false, fatal: true, reason: `prebuilt_not_executable: ${helperPath}` };
  }
  return { ok: true, helperPath };
}
