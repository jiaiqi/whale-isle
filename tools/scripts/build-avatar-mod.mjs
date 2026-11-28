#!/usr/bin/env node
/**
 * 构建 WhaleIsleAvatar SMAPI Mod 并暂存到 publish/（T-M6-62）。
 * dotnet 不可用或编译失败时如实告警并退出 0：安装器会把「DLL 未编译」如实展示给用户，
 * 绝不因为打包机缺 dotnet 就伪装 Mod 可用。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const modDir = join(repoRoot, 'mods', 'stardew-avatar-sync');
const publishDir = join(modDir, 'publish');
const dllSource = join(modDir, 'bin', 'Release', 'net6.0', 'WhaleIsleAvatar.dll');
const dllTarget = join(publishDir, 'WhaleIsleAvatar.dll');

mkdirSync(publishDir, { recursive: true });
copyFileSync(join(modDir, 'manifest.json'), join(publishDir, 'manifest.json'));

const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
if (dotnet.error !== undefined || dotnet.status !== 0) {
  console.warn('[avatar-mod] 未检测到 dotnet SDK：跳过编译，publish 中无 DLL（安装器会如实提示未编译）');
  process.exit(0);
}
const build = spawnSync('dotnet', ['build', '-c', 'Release'], { cwd: modDir, encoding: 'utf8' });
if (build.status !== 0) {
  console.warn(`[avatar-mod] dotnet build 失败（退出码 ${build.status}）：\n${(build.stdout ?? '').slice(-800)}\n${(build.stderr ?? '').slice(-800)}`);
  console.warn('[avatar-mod] 继续打包，但 publish 中无 DLL（安装器会如实提示未编译）');
  process.exit(0);
}
if (!existsSync(dllSource)) {
  console.warn('[avatar-mod] 编译成功但未找到 WhaleIsleAvatar.dll，安装器会如实提示未编译');
  process.exit(0);
}
copyFileSync(dllSource, dllTarget);
console.log(`[avatar-mod] WhaleIsleAvatar.dll 已暂存到 ${dllTarget}`);
