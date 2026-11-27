/**
 * V2-P3-03c native-input-helper 单元测试（[SIMULATION]：不触碰真实 OS 输入，
 * 编译与 spawn 均以注入的替身验证路径解析、缓存命中、参数映射与错误回报）。
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureNativeInputHelper,
  locateHelperSource,
  stepToHelperArgs,
} from './native-input-helper';

let workDir = '';

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'whale-input-helper-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('native-input-helper（V2-P3-03c）', () => {
  it('locateHelperSource 从 appPath 向上找到仓库内 helper 源码', () => {
    mkdirSync(join(workDir, 'apps', 'desktop-host'), { recursive: true });
    mkdirSync(join(workDir, 'tools', 'native'), { recursive: true });
    writeFileSync(join(workDir, 'tools', 'native', 'macos-input-helper.swift'), '// src\n');
    const found = locateHelperSource(join(workDir, 'apps', 'desktop-host'));
    expect(found).toBe(join(workDir, 'tools', 'native', 'macos-input-helper.swift'));
    expect(locateHelperSource('/System/Library/CoreServices')).toBeNull();
  });

  it('ensureNativeInputHelper 编译成功后按源码哈希缓存复用', () => {
    mkdirSync(join(workDir, 'apps', 'desktop-host'), { recursive: true });
    mkdirSync(join(workDir, 'tools', 'native'), { recursive: true });
    writeFileSync(join(workDir, 'tools', 'native', 'macos-input-helper.swift'), '// src v1\n');
    let compileCalls = 0;
    const compile = (_source: string, out: string) => {
      compileCalls += 1;
      writeFileSync(out, 'fake-binary');
      return { ok: true };
    };
    const cacheDir = join(workDir, 'cache');
    const first = ensureNativeInputHelper({
      appPath: join(workDir, 'apps', 'desktop-host'),
      cacheDir,
      compile,
    });
    // 非 darwin 平台会直接不可用（CI/Linux）；本机 darwin 走编译路径
    if (process.platform !== 'darwin') {
      expect(first.ok).toBe(false);
      expect(first.reason).toBe('unsupported_platform');
      return;
    }
    expect(first.ok).toBe(true);
    expect(first.compileMs).toBeTypeOf('number');
    expect(compileCalls).toBe(1);

    const second = ensureNativeInputHelper({
      appPath: join(workDir, 'apps', 'desktop-host'),
      cacheDir,
      compile,
    });
    expect(second.ok).toBe(true);
    expect(second.helperPath).toBe(first.helperPath);
    expect(compileCalls).toBe(1); // 缓存命中，未重复编译
  });

  it('编译失败如实回报 compile_failed，不伪造可用', () => {
    mkdirSync(join(workDir, 'apps', 'desktop-host'), { recursive: true });
    mkdirSync(join(workDir, 'tools', 'native'), { recursive: true });
    writeFileSync(join(workDir, 'tools', 'native', 'macos-input-helper.swift'), '// src\n');
    const result = ensureNativeInputHelper({
      appPath: join(workDir, 'apps', 'desktop-host'),
      cacheDir: join(workDir, 'cache'),
      compile: () => ({ ok: false, stderr: 'swiftc exploded' }),
    });
    if (process.platform !== 'darwin') {
      expect(result.ok).toBe(false);
      return;
    }
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('compile_failed');
    expect(result.reason).toContain('swiftc exploded');
  });

  it('随包预编译二进制优先于源码编译；哈希不符时 fail-closed 不回退', () => {
    const resourcesPath = join(workDir, 'Resources');
    const bundleDir = join(resourcesPath, 'native', 'darwin-arm64');
    mkdirSync(bundleDir, { recursive: true });
    const helperPath = join(bundleDir, 'whale-input-helper');
    const binary = 'fake-prebuilt-input-helper';
    writeFileSync(helperPath, binary);
    chmodSync(helperPath, 0o755);
    const sha256 = createHash('sha256').update(binary).digest('hex');
    writeFileSync(join(bundleDir, 'sha256.json'), JSON.stringify({ 'whale-input-helper': sha256 }));

    let compileCalls = 0;
    const compile = (_source: string, out: string) => {
      compileCalls += 1;
      writeFileSync(out, 'compiled');
      return { ok: true };
    };
    const prebuilt = ensureNativeInputHelper({
      appPath: join(workDir, 'apps', 'desktop-host'),
      cacheDir: join(workDir, 'cache'),
      compile,
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath,
    });
    expect(prebuilt).toMatchObject({ ok: true, helperPath, origin: 'prebuilt' });
    expect(compileCalls).toBe(0);

    writeFileSync(join(bundleDir, 'sha256.json'), JSON.stringify({ 'whale-input-helper': '0'.repeat(64) }));
    const tampered = ensureNativeInputHelper({
      appPath: join(workDir, 'apps', 'desktop-host'),
      cacheDir: join(workDir, 'cache'),
      compile,
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath,
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.reason).toContain('prebuilt_integrity_mismatch');
    expect(compileCalls).toBe(0); // 不得静默回退源码编译
  });

  it('stepToHelperArgs 白名单映射与非法输入拒绝', () => {
    expect(stepToHelperArgs({ kind: 'click', x: 100, y: 200 })).toEqual(['click', '100', '200']);
    expect(stepToHelperArgs({ kind: 'move', x: 1.5, y: 2.5 })).toEqual(['move', '1.5', '2.5']);
    expect(stepToHelperArgs({ kind: 'type_text', text: '你好，小鲸' })).toEqual(['type', '你好，小鲸']);
    expect(stepToHelperArgs({ kind: 'key', key: 'enter' })).toEqual(['key', 'enter']);
    expect(stepToHelperArgs({ kind: 'scroll', deltaY: -120.7 })).toEqual(['scroll', '-120']);

    // 缺坐标 / 空文本 / 超长文本 / 非法键名 / screenshot 一律拒绝
    expect(stepToHelperArgs({ kind: 'click', x: 1 })).toBeNull();
    expect(stepToHelperArgs({ kind: 'type_text', text: '' })).toBeNull();
    expect(stepToHelperArgs({ kind: 'type_text', text: 'x'.repeat(201) })).toBeNull();
    expect(stepToHelperArgs({ kind: 'key', key: 'enter; rm -rf /' })).toBeNull();
    expect(stepToHelperArgs({ kind: 'screenshot' })).toBeNull();
  });
});
