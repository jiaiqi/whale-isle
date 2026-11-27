#!/usr/bin/env node
/**
 * 预编译 macOS 原生 helper，写入随包资源目录（预览构建 V2-P4-05）。
 *
 * 为什么需要：
 *   安装态脱离仓库后找不到 `tools/native/*.swift`，也不能假设用户装了 Xcode CLT。
 *   因此把 helper 预编译成二进制，经 electron-builder `extraResources` 随包分发；
 *   运行时优先用随包二进制，源码编译只保留为开发态回退。
 *
 * 产物布局（gitignored）：
 *   apps/desktop-host/build/native/darwin-<arch>/whale-input-helper
 *   apps/desktop-host/build/native/darwin-<arch>/whale-audio-helper
 *   apps/desktop-host/build/native/darwin-<arch>/sha256.json
 *
 * fail-closed：swiftc 缺失、编译失败、产物无法启动时退出非 0，
 * 绝不静默打一个缺 helper 的包（before-pack-native.cjs 还会在打包前再校验一次）。
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const sourceDir = join(repoRoot, 'tools', 'native');

const platform = process.platform;
const arch = process.arch;

if (platform !== 'darwin') {
  console.log(`[native-helpers] 跳过：当前平台 ${platform}；macOS helper 只随 macOS 包分发`);
  process.exit(0);
}

const swiftTargetArch = arch === 'x64' ? 'x86_64' : arch;
const target = `${swiftTargetArch}-apple-macos12.0`;
const outDir = join(appRoot, 'build', 'native', `darwin-${arch}`);

const helpers = [
  { name: 'whale-input-helper', source: join(sourceDir, 'macos-input-helper.swift') },
  { name: 'whale-audio-helper', source: join(sourceDir, 'macos-audio-helper.swift') },
];

const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
if (swiftc.error !== undefined || swiftc.status !== 0) {
  console.error('[native-helpers] 失败：找不到可用的 swiftc。');
  console.error('[native-helpers] 这是 fail-closed 行为：不能把缺原生 helper 的包发出去。');
  console.error('[native-helpers] 处置：安装 Xcode Command Line Tools（xcode-select --install）后重跑打包。');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** @type {Record<string, string>} */
const manifest = {};
for (const helper of helpers) {
  if (!existsSync(helper.source)) {
    console.error(`[native-helpers] 失败：源码不存在 ${relative(repoRoot, helper.source)}`);
    process.exit(1);
  }
  const out = join(outDir, helper.name);
  const compile = spawnSync('swiftc', ['-O', '-target', target, '-o', out, helper.source], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (compile.error !== undefined || compile.status !== 0) {
    console.error(`[native-helpers] 失败：编译 ${helper.name} 出错（target ${target}）`);
    if (compile.error !== undefined) console.error(String(compile.error));
    if (compile.stderr !== '') console.error(compile.stderr.slice(0, 800));
    process.exit(1);
  }
  chmodSync(out, 0o755);

  // 冒烟：二进制必须能真正启动。helper 对未知子命令会返回非 0（参数错误/无权限），
  // 但只要不是 spawn 失败或被信号杀死，就说明产物可执行。
  const smoke = spawnSync(out, ['__whale_selfcheck__'], { encoding: 'utf8', timeout: 10_000 });
  if (smoke.error !== undefined || smoke.status === null) {
    console.error(`[native-helpers] 失败：${helper.name} 编译产物无法启动`);
    if (smoke.error !== undefined) console.error(String(smoke.error));
    process.exit(1);
  }

  const bytes = statSync(out).size;
  const sha256 = createHash('sha256').update(readFileSync(out)).digest('hex');
  manifest[helper.name] = sha256;
  console.log(`[native-helpers] ✓ ${helper.name} · ${bytes} bytes · sha256 ${sha256}`);
}

writeFileSync(join(outDir, 'sha256.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[native-helpers] 产物目录：${relative(repoRoot, outDir)}（target ${target}）`);
