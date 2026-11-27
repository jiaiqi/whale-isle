/**
 * electron-builder beforePack 钩子：macOS 包必须带预编译原生 helper（预览构建 V2-P4-05）。
 *
 * 为什么在打包前再校验一次：`package` 脚本虽然会先跑 build-native-helpers，
 * 但任何人直接执行 `electron-builder` 时也不能静默产出一个「装完 OS 输入不可用、
 * 音频退回 afplay」的包。这里 fail-closed，直接中断打包并给出人话原因。
 */
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
const HELPERS = ['whale-input-helper', 'whale-audio-helper'];

module.exports = async function beforePackNativeHelpers(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const archName = ARCH_NAMES[context.arch] ?? process.arch;
  const projectDir = context.packager.projectDir;
  const bundleDir = join(projectDir, 'build', 'native', `darwin-${archName}`);
  const hint =
    `请先运行 pnpm --filter @workbench/desktop-host build:native-helpers`
    + `（需要 swiftc / Xcode Command Line Tools），再重新打包。`;

  if (!existsSync(bundleDir)) {
    throw new Error(`[native-helpers] 打包中止：未找到随包原生 helper 目录 ${bundleDir}。${hint}`);
  }

  const manifestPath = join(bundleDir, 'sha256.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`[native-helpers] 打包中止：缺少 sha256 清单 ${manifestPath}。${hint}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`[native-helpers] 打包中止：sha256 清单无法解析（${String(error)}）。${hint}`);
  }

  for (const name of HELPERS) {
    const helperPath = join(bundleDir, name);
    if (!existsSync(helperPath)) {
      throw new Error(`[native-helpers] 打包中止：缺少 ${helperPath}。${hint}`);
    }
    const expected = manifest[name];
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
      throw new Error(`[native-helpers] 打包中止：sha256 清单缺少 ${name} 的有效条目。${hint}`);
    }
    const actual = createHash('sha256').update(readFileSync(helperPath)).digest('hex');
    if (actual !== expected.toLowerCase()) {
      throw new Error(
        `[native-helpers] 打包中止：${name} 哈希不符（清单 ${expected.toLowerCase()} / 实际 ${actual}）。${hint}`,
      );
    }
    if ((statSync(helperPath).mode & 0o111) === 0) {
      throw new Error(`[native-helpers] 打包中止：${helperPath} 不可执行（缺少 0755 权限）。${hint}`);
    }
  }

  console.log(`[native-helpers] 打包前校验通过：${bundleDir}`);
};
