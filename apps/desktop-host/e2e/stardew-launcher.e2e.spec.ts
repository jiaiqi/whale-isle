/**
 * [E2E-HOST] V2-P3-05 星露谷一键启动：
 *   ① 共玩页离线横幅显示「启动星露谷」，点击后走主进程状态机（PET_STAGE_E2E 下为假启动器）
 *   ② 进度真实推进 launching → waiting_mcp → ready，且 ready 只来自主进程确认
 *   ③ ⌘K 有「启动星露谷」命令
 *   ④ 顶栏「启动」在游戏未运行时弹出「先启动游戏」提示（可勾选以后自动启动）
 *
 * 本 spec 不启动真实游戏：主进程在 PET_STAGE_E2E=1 时装配 createFakeStardewLauncher。
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const artifactsDir = join(repoRoot, 'artifacts');

async function waitForWindow(
  app: import('playwright-core').ElectronApplication,
  urlPart: string,
  timeoutMs = 20_000,
): Promise<import('playwright-core').Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未找到包含 ${urlPart} 的窗口`);
}

describe('[E2E-HOST] V2-P3-05 星露谷一键启动', () => {
  it('横幅启动按钮 / 状态机 / ⌘K 命令 / 自动驾驶前置提示', { timeout: 180_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const director = await waitForWindow(app, 'director');
      await director.waitForFunction(
        () => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot),
        { timeout: 20_000 },
      );
      await director.evaluate(() => {
        localStorage.setItem('wb-tab', 'stardew');
        localStorage.setItem('wb-game', 'stardew');
        localStorage.setItem('wb-game-subtab', 'monitor');
        localStorage.removeItem('wb-stardew-auto-launch');
      });
      await director.reload();
      await director.waitForFunction(
        () => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot),
        { timeout: 20_000 },
      );
      await director.waitForSelector('[data-game-panel][data-active-game="stardew"]', { timeout: 10_000 });

      // ① 离线横幅出现「启动星露谷」按钮（假启动器初始 idle）
      const panel = director.locator('[data-stardew-launch-panel]');
      await panel.waitFor({ timeout: 15_000 });
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 }).toBe('idle');
      expect(await director.locator('[data-stardew-launch]').count()).toBe(1);

      // ② 点击启动：launching/waiting_mcp → ready（全部来自主进程状态机）
      await director.click('[data-stardew-launch]');
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 })
        .toMatch(/^(launching|waiting_mcp|ready)$/);
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 }).toBe('ready');
      const progress = await director.locator('[data-stardew-launch-progress]').innerText();
      expect(progress).toContain('已就绪');
      expect(progress).toContain('BWF MCP 已就绪');

      // ③ ⌘K 命令面板包含「启动星露谷」
      await director.keyboard.press('Meta+k');
      await director.waitForSelector('[cmdk-item]', { timeout: 10_000 });
      expect(await director.locator('text=启动星露谷').count()).toBeGreaterThan(0);
      await director.keyboard.press('Escape');

      // ④ 游戏未运行时点顶栏「启动」→ 弹出「先启动游戏」提示，含持久化勾选项
      await director.click('[data-autodrive-toggle]');
      await director.waitForSelector('[data-stardew-launch-prompt]', { timeout: 20_000 });
      expect(await director.locator('[data-stardew-auto-launch]').count()).toBe(1);
      expect(await director.locator('[data-stardew-launch-confirm]').count()).toBe(1);
      await director.click('[data-stardew-launch-cancel-prompt]');
      await expect.poll(async () => director.locator('[data-stardew-launch-prompt]').count(), { timeout: 5_000 }).toBe(0);

      mkdirSync(artifactsDir, { recursive: true });
      await director.screenshot({ path: join(artifactsDir, 'stardew-launcher-e2e.png') });
    } finally {
      await app.close();
    }
  });
});
