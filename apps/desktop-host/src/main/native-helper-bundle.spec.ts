/**
 * V2-P4-05 native-helper-bundle 单元测试（[SIMULATION]）：
 * 只验证随包布局、sha256 清单与 fail-closed 判定，不执行任何真实 helper。
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locatePrebuiltHelper } from './native-helper-bundle';

let workDir = '';
let resourcesPath = '';
let bundleDir = '';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeBundle(options: {
  binary?: string;
  manifest?: unknown;
  executable?: boolean;
} = {}): void {
  mkdirSync(bundleDir, { recursive: true });
  const binary = options.binary ?? 'fake-helper-binary';
  const helperPath = join(bundleDir, 'whale-audio-helper');
  writeFileSync(helperPath, binary);
  chmodSync(helperPath, options.executable === false ? 0o644 : 0o755);
  const manifest = options.manifest ?? { 'whale-audio-helper': sha256(binary) };
  writeFileSync(join(bundleDir, 'sha256.json'), JSON.stringify(manifest));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'whale-helper-bundle-'));
  resourcesPath = join(workDir, 'Resources');
  bundleDir = join(resourcesPath, 'native', 'darwin-arm64');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('locatePrebuiltHelper（V2-P4-05）', () => {
  it('非 darwin 或开发态（resourcesPath=null）返回 not_found，不误报', () => {
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'linux', resourcesPath }).reason)
      .toBe('unsupported_platform');
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath: null }).reason)
      .toBe('prebuilt_not_found');
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath }).reason)
      .toBe('prebuilt_not_found');
  });

  it('随包二进制哈希与清单一致且可执行时返回可用路径', () => {
    writeBundle();
    const result = locatePrebuiltHelper({
      name: 'whale-audio-helper',
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath,
    });
    expect(result.ok).toBe(true);
    expect(result.helperPath).toBe(join(bundleDir, 'whale-audio-helper'));
  });

  it('目录存在但二进制/清单缺失时 fail-closed', () => {
    mkdirSync(bundleDir, { recursive: true });
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath }))
      .toMatchObject({ ok: false, fatal: true });
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath }).reason)
      .toContain('prebuilt_helper_missing');

    writeFileSync(join(bundleDir, 'whale-audio-helper'), 'bin');
    const missingManifest = locatePrebuiltHelper({
      name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath,
    });
    expect(missingManifest.fatal).toBe(true);
    expect(missingManifest.reason).toContain('prebuilt_manifest_missing');
  });

  it('清单损坏、缺条目、哈希不符、不可执行一律 fail-closed', () => {
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'whale-audio-helper'), 'bin');
    writeFileSync(join(bundleDir, 'sha256.json'), 'not json');
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath }).reason)
      .toContain('prebuilt_manifest_invalid');

    writeFileSync(join(bundleDir, 'sha256.json'), JSON.stringify({ other: sha256('bin') }));
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath }).reason)
      .toContain('prebuilt_manifest_entry_missing');

    writeFileSync(join(bundleDir, 'sha256.json'), JSON.stringify({ 'whale-audio-helper': sha256('other') }));
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath }).reason)
      .toContain('prebuilt_integrity_mismatch');

    writeBundle({ executable: false });
    expect(locatePrebuiltHelper({ name: 'whale-audio-helper', platform: 'darwin', arch: 'arm64', resourcesPath }).reason)
      .toContain('prebuilt_not_executable');
  });
});
