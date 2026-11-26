/**
 * V2-P3-07D：星露谷启动偏好持久化 & 隔离目录语言双保险单测。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStardewLaunchPrefs,
  defaultIsolatedDataDir,
  ensureIsolatedStartupLanguage,
} from './stardew-launch-prefs';

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

describe('createStardewLaunchPrefs', () => {
  it('默认启用鲸屿隔离目录 + 中文 + 跳过片头 + 同步像素形象，且 patch 持久化落盘', () => {
    const userData = makeTempDir('wb-launch-prefs-');
    expect(defaultIsolatedDataDir(userData)).toBe(join(userData, 'stardew-isolated'));

    const store = createStardewLaunchPrefs(userData);
    expect(store.get()).toMatchObject({
      storageMode: 'isolated',
      language: 'zh',
      skipIntro: true,
      syncPixelAvatar: true,
      startingCabins: 1,
      cabinLayout: 'nearby',
    });

    const bad = store.patch({ farmName: 'bad/name' });
    expect(bad.ok).toBe(false);
    expect(store.get().farmName).toBe('鲸屿');

    const switched = store.patch({ storageMode: 'standard', language: 'en', farmName: '新星露谷' });
    expect(switched.ok).toBe(true);
    expect(switched.prefs.storageMode).toBe('standard');

    // 重新实例读取应保持持久化结果
    const reloaded = createStardewLaunchPrefs(userData);
    expect(reloaded.get()).toMatchObject({
      storageMode: 'standard',
      language: 'en',
      farmName: '新星露谷',
    });
  });

  it('配置文件损坏时安全回落默认值，不崩主进程', () => {
    const userData = makeTempDir('wb-launch-corrupt-');
    writeFileSync(join(userData, 'stardew-launch-prefs.json'), '{broken json', 'utf8');
    const store = createStardewLaunchPrefs(userData);
    expect(store.get().storageMode).toBe('isolated');
    expect(store.get().language).toBe('zh');
  });
});

describe('ensureIsolatedStartupLanguage', () => {
  it('全新隔离目录自动写入 zh startup_preferences；已是目标语言时幂等不重写', () => {
    const xdgConfig = makeTempDir('wb-xdg-cfg-');
    const first = ensureIsolatedStartupLanguage(xdgConfig, 'zh');
    expect(first.created).toBe(true);
    expect(first.updated).toBe(true);
    expect(existsSync(first.path)).toBe(true);
    const content = readFileSync(first.path, 'utf8');
    expect(content).toContain('<languageCode>zh</languageCode>');
    expect(content).toContain('<ipConnectionsEnabled>true</ipConnectionsEnabled>');
    expect(content).toContain('<enableServer>true</enableServer>');

    const second = ensureIsolatedStartupLanguage(xdgConfig, 'zh');
    expect(second.created).toBe(false);
    expect(second.updated).toBe(false);
  });

  it('已有英文 <languageCode>en</languageCode> → 原子替换为 zh；缺失标签时在 </StartupPreferences> 前插入', () => {
    const xdgConfig = makeTempDir('wb-xdg-replace-');
    const svDir = join(xdgConfig, 'StardewValley');
    mkdirSync(svDir, { recursive: true });
    const prefPath = join(svDir, 'startup_preferences');

    writeFileSync(prefPath, '<StartupPreferences>\n  <languageCode>en</languageCode>\n</StartupPreferences>\n', 'utf8');
    const replaced = ensureIsolatedStartupLanguage(xdgConfig, 'zh');
    expect(replaced.updated).toBe(true);
    expect(readFileSync(prefPath, 'utf8')).toContain('<languageCode>zh</languageCode>');

    writeFileSync(prefPath, '<StartupPreferences>\n  <windowMode>1</windowMode>\n</StartupPreferences>\n', 'utf8');
    const inserted = ensureIsolatedStartupLanguage(xdgConfig, 'ja');
    expect(inserted.updated).toBe(true);
    expect(readFileSync(prefPath, 'utf8')).toContain('<languageCode>ja</languageCode>');
  });
});
