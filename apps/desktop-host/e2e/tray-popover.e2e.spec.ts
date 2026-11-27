/**
 * [E2E-HOST] T-M6-60 托盘快捷浮窗：
 *   ① PET_STAGE_E2E=1 不创建真实系统 Tray，但复用浮窗仍可打开；
 *   ② 三段 Tab（桌宠/自驾/饭碗）与真实 IPC 数据渲染；
 *   ③ 溢出区回退坐标不是 (0,0) 且大小固定 360×500；
 *   ④ 隐藏后 visible=false（blur/点击共用的防抖路径由纯函数单测覆盖；
 *      测试模式下不启用「失焦自动隐藏」，否则 CI 运行器的窗口焦点会让「打开后可见」变成环境抽奖）。
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const artifactsDir = join(repoRoot, 'artifacts');

interface TestBridge {
  trayPopoverTest?: (action: 'open' | 'hide' | 'bounds') => Promise<{
    ok: boolean;
    bounds?: { x: number; y: number; width: number; height: number } | null;
    visible?: boolean;
  }>;
}

async function waitForWindow(app: ElectronApplication, urlPart: string, timeoutMs = 20_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().includes(urlPart));
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未找到包含 ${urlPart} 的窗口`);
}

describe('[E2E-HOST] T-M6-60 托盘快捷浮窗', () => {
  it('浮窗三 Tab 真实渲染、坐标夹紧、隐藏不闪退', { timeout: 120_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const director = await waitForWindow(app, 'director');
      await director.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: TestBridge }).directorBridge?.trayPopoverTest),
        { timeout: 20_000 },
      );

      const opened = await director.evaluate(() =>
        (window as unknown as { directorBridge: TestBridge }).directorBridge.trayPopoverTest!('open'));
      expect(opened.ok).toBe(true);

      const popover = await waitForWindow(app, 'tray-popover');
      await popover.waitForSelector('[data-popover-ready="1"]', { timeout: 20_000 });

      const tabs = await popover.$$eval('[data-tab]', (nodes) => nodes.map((node) => node.getAttribute('data-tab')));
      expect(tabs).toEqual(['pets', 'drive', 'bowl']);

      await popover.waitForSelector('[data-panel="pets"]');
      const actions = await popover.$$eval('[data-action]', (nodes) => nodes.map((node) => node.getAttribute('data-action')));
      expect(actions).toEqual(['visibility', 'sleep', 'assemble', 'dismiss', 'egg', 'dock']);
      const characterChips = await popover.$$eval('[data-character-id]', (nodes) => nodes.length);
      expect(characterChips).toBeGreaterThan(0);

      mkdirSync(artifactsDir, { recursive: true });
      await popover.screenshot({ path: join(artifactsDir, 'tray-popover-pets.png') });

      await popover.click('[data-tab="drive"]');
      await popover.waitForSelector('[data-panel="drive"]');
      expect(await popover.textContent('[data-panel="drive"]')).toContain('自驾');
      expect(await popover.$$eval('[data-receipts] .list-row', (nodes) => nodes.length)).toBeLessThanOrEqual(3);
      await popover.screenshot({ path: join(artifactsDir, 'tray-popover-drive.png') });

      await popover.click('[data-tab="bowl"]');
      await popover.waitForSelector('[data-panel="bowl"]');
      const riceBalance = Number(await popover.getAttribute('[data-rice-balance]', 'data-rice-balance'));
      expect(riceBalance).toBeGreaterThan(0);

      const state = await director.evaluate(() =>
        (window as unknown as { directorBridge: TestBridge }).directorBridge.trayPopoverTest!('bounds'));
      expect(state.visible).toBe(true);
      expect(state.bounds).toMatchObject({ width: 360, height: 500 });
      expect(state.bounds!.x).toBeGreaterThan(0);
      expect(state.bounds!.y).toBeGreaterThan(0);

      await popover.screenshot({ path: join(artifactsDir, 'tray-popover-bowl-light.png') });
      await popover.emulateMedia({ colorScheme: 'dark' });
      await popover.waitForTimeout(400);
      await popover.screenshot({ path: join(artifactsDir, 'tray-popover-bowl-dark.png') });

      await director.evaluate(() =>
        (window as unknown as { directorBridge: TestBridge }).directorBridge.trayPopoverTest!('hide'));
      const hidden = await director.evaluate(() =>
        (window as unknown as { directorBridge: TestBridge }).directorBridge.trayPopoverTest!('bounds'));
      expect(hidden.visible).toBe(false);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
