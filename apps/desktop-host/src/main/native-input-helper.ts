/**
 * V2-P3-03c macOS 原生输入注入器接线：把编译好的 `whale-input-helper`（tools/native/macos-input-helper.swift）
 * 作为 `nativeInjector` 接入 ComputerInputExecutor。
 *
 * 安全与诚实口径：
 * - 安装态优先使用随包预编译二进制（Contents/Resources/native/darwin-<arch>/，含 sha256 清单）；
 *   开发态随包目录不存在时，才用系统 swiftc 把仓库内源码编译到 userData 缓存（按源码 SHA-256 版本化）。
 * - 随包二进制缺失/哈希不符/不可执行 → fail-closed 如实报不可用，绝不回退冒充成功。
 * - 调用一律 spawnSync 参数数组，不走 shell，杜绝命令注入；参数先经 ComputerInputStep 白名单映射。
 * - swiftc 缺失或编译失败时返回不可用（executor 如实回报 not_implemented），绝不伪造执行成功。
 * - 权限由调用方 permissionProbe（Electron systemPreferences.isTrustedAccessibilityClient）把关；
 *   helper 退出码 3（无权限）会映射为错误向上抛，由 executor 记 rejected。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ComputerInputStep } from '@workbench/runtime-core';
import { locatePrebuiltHelper } from './native-helper-bundle';

export interface NativeInputHelperInfo {
  ok: boolean;
  helperPath?: string;
  reason?: string;
  /** 编译耗时（仅当本次触发编译） */
  compileMs?: number;
  /** 二进制来源：随包预编译 / 本次源码编译 / 源码哈希缓存 */
  origin?: 'prebuilt' | 'compiled' | 'cache';
}

/** 从 appPath 向上查找仓库根的 tools/native/macos-input-helper.swift */
export function locateHelperSource(appPath: string): string | null {
  let dir = appPath;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'tools', 'native', 'macos-input-helper.swift');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 确保 helper 二进制可用：优先使用随包预编译二进制；开发态（随包目录不存在）才回退
 * 到「源码 SHA-256 缓存命中复用 / swiftc 编译」。
 * 随包目录存在但内容坏（缺文件/哈希不符/不可执行）时 fail-closed，不回退编译。
 * 纯函数式依赖注入（编译器与文件系统操作可替换）以便单测。
 */
export function ensureNativeInputHelper(options: {
  appPath: string;
  cacheDir: string;
  compile?: (source: string, out: string) => { ok: boolean; stderr?: string };
  /** 测试可注入；生产固定 process.platform */
  platform?: NodeJS.Platform;
  /** 测试可注入；生产固定 process.arch */
  arch?: string;
  /** 安装态传 process.resourcesPath；开发态传 null 跳过随包查找 */
  resourcesPath?: string | null;
}): NativeInputHelperInfo {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  const prebuilt = locatePrebuiltHelper({
    name: 'whale-input-helper',
    platform,
    arch: options.arch ?? process.arch,
    resourcesPath: options.resourcesPath,
  });
  if (prebuilt.ok && prebuilt.helperPath !== undefined) {
    return { ok: true, helperPath: prebuilt.helperPath, origin: 'prebuilt' };
  }
  if (prebuilt.fatal === true) {
    return { ok: false, reason: prebuilt.reason ?? 'prebuilt_invalid' };
  }

  const source = locateHelperSource(options.appPath);
  if (!source) return { ok: false, reason: 'source_not_found' };

  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const helperPath = join(options.cacheDir, `whale-input-helper-${sourceHash}`);
  if (existsSync(helperPath) && statSync(helperPath).size > 0) {
    return { ok: true, helperPath, origin: 'cache' };
  }

  mkdirSync(options.cacheDir, { recursive: true });
  const compile = options.compile ?? defaultCompile;
  const startedAt = Date.now();
  const result = compile(source, helperPath);
  if (!result.ok) {
    return { ok: false, reason: `compile_failed: ${result.stderr ?? 'unknown'}` };
  }
  return { ok: true, helperPath, compileMs: Date.now() - startedAt, origin: 'compiled' };
}

function defaultCompile(source: string, out: string): { ok: boolean; stderr?: string } {
  const r = spawnSync('swiftc', ['-O', '-o', out, source], { encoding: 'utf8', timeout: 120_000 });
  if (r.error) return { ok: false, stderr: String(r.error) };
  if (r.status !== 0) return { ok: false, stderr: (r.stderr ?? '').slice(0, 500) };
  return { ok: true };
}

/** 把 ComputerInputStep 映射为 helper 参数数组；不支持的动作返回 null（由 executor 走 not_implemented） */
export function stepToHelperArgs(step: ComputerInputStep): string[] | null {
  switch (step.kind) {
    case 'click':
      if (typeof step.x !== 'number' || typeof step.y !== 'number') return null;
      return ['click', String(step.x), String(step.y)];
    case 'move':
      if (typeof step.x !== 'number' || typeof step.y !== 'number') return null;
      return ['move', String(step.x), String(step.y)];
    case 'type_text':
      if (typeof step.text !== 'string' || step.text.length === 0 || step.text.length > 200) return null;
      return ['type', step.text];
    case 'key':
      if (typeof step.key !== 'string' || !/^[a-z0-9]{1,12}$/i.test(step.key)) return null;
      return ['key', step.key];
    case 'scroll':
      if (typeof step.deltaY !== 'number') return null;
      return ['scroll', String(Math.trunc(step.deltaY))];
    case 'screenshot':
      // 截图由主进程 desktopCapturer/screencapture 承担，不属于注入器职责
      return null;
    default:
      return null;
  }
}

/** 生成接入 ComputerInputExecutor 的 nativeInjector（同步调用，单动作延迟约 5–30ms） */
export function createNativeInjector(helperPath: string): (step: ComputerInputStep, at: number) => void {
  return (step) => {
    const args = stepToHelperArgs(step);
    if (!args) {
      throw new Error(`不支持或参数不完整的动作：${step.kind}`);
    }
    const r = spawnSync(helperPath, args, { encoding: 'utf8', timeout: 10_000 });
    if (r.error) throw new Error(`helper 调用失败：${String(r.error)}`);
    if (r.status === 3) throw new Error('辅助功能权限缺失（helper exit 3）');
    if (r.status !== 0) {
      throw new Error(`helper 退出码 ${String(r.status)}：${(r.stderr ?? '').slice(0, 200)}`);
    }
  };
}
