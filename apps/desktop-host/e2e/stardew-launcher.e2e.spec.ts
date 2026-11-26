/**
 * [E2E-HOST] V2-P3-05 / V2-P3-07E 星露谷一键启动、从 0 建档/联机房主与存储隔离偏好：
 *   ① 共玩页离线横幅显示「启动星露谷」，点击后走主进程状态机（PET_STAGE_E2E 下为假启动器）
 *   ② 进度真实推进 launching → waiting_mcp → ready，且 ready 只来自主进程确认
 *   ③ ⌘K 有「启动星露谷」与两条「从 0 …开玩星露谷」命令
 *   ④ 顶栏「启动」在游戏未运行时弹出「先启动游戏」提示（含持久化勾选项与两个从 0 新建入口）
 *   ⑤ 一键「从 0 单机开玩」走 always_new + singleplayer + isolated + zh 到 ready
 *   ⑥ 展开配置调整小屋数为 2 后点击「从 0 联机房主开玩」展示 LAN 24642 与 2/2 小屋状态
 *   ⑦ 切换存储模式（isolated ↔ standard）刷新 reload 后仍保持持久化，测完恢复 isolated
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

describe('[E2E-HOST] V2-P3-05 & V2-P3-07E 星露谷一键启动与从 0 建档', () => {
  it('横幅启动 / 从0单机 / 从0联机房主 / 存储模式持久化 / ⌘K / 顶栏弹窗', { timeout: 180_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_E2E_GAME_OFFLINE: '1' },
    });
    try {
      const director = await waitForWindow(app, 'director');
      await director.waitForFunction(
        () => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot),
        { timeout: 20_000 },
      );
      await director.evaluate(async () => {
        localStorage.setItem('wb-tab', 'stardew');
        localStorage.setItem('wb-game', 'stardew');
        localStorage.setItem('wb-game-subtab', 'monitor');
        localStorage.removeItem('wb-stardew-auto-launch');
        const bridge = (window as unknown as {
          directorBridge?: { stardewLaunchPrefsSet?: (p: Record<string, unknown>) => Promise<unknown> };
        }).directorBridge;
        await bridge?.stardewLaunchPrefsSet?.({
          storageMode: 'isolated',
          language: 'zh',
          farmName: '鲸屿',
          favoriteThing: '白米饭',
          farmType: 'standard',
          startingCabins: 1,
          cabinLayout: 'nearby',
          skipIntro: true,
          syncPixelAvatar: true,
        });
      });
      await director.reload();
      await director.waitForFunction(
        () => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot),
        { timeout: 20_000 },
      );
      await director.waitForSelector('[data-game-panel][data-active-game="stardew"]', { timeout: 10_000 });

      // ① 离线横幅出现「启动星露谷」按钮与默认隔离+中文微标
      const panel = director.locator('[data-stardew-launch-panel]');
      await panel.waitFor({ timeout: 15_000 });
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 }).toBe('idle');
      expect(await director.locator('[data-stardew-launch]').count()).toBe(1);
      expect(await director.locator('[data-stardew-storage-badge]').getAttribute('data-stardew-storage-badge')).toBe('isolated');

      // ② 点击启动：launching/waiting_mcp → ready（全部来自主进程状态机）
      await director.click('[data-stardew-launch]');
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 })
        .toMatch(/^(launching|waiting_mcp|ready)$/);
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 }).toBe('ready');
      const progress = await director.locator('[data-stardew-launch-progress]').innerText();
      expect(progress).toContain('已就绪');
      expect(progress).toContain('BWF MCP 已就绪');

      // ③ ⌘K 命令面板包含「启动星露谷」与两条从 0 开玩命令
      await director.keyboard.press('Meta+k');
      await director.waitForSelector('[cmdk-item]', { timeout: 10_000 });
      expect(await director.locator('text=启动星露谷').count()).toBeGreaterThan(0);
      expect(await director.locator('text=从 0 单机开玩星露谷').count()).toBeGreaterThan(0);
      expect(await director.locator('text=从 0 联机房主开玩星露谷').count()).toBeGreaterThan(0);
      await director.keyboard.press('Escape');

      // ④ 游戏未运行时点顶栏「启动」→ 弹出「先启动游戏」提示，含持久化勾选项与两个从 0 新建入口
      await director.click('[data-autodrive-toggle]');
      await director.waitForSelector('[data-stardew-launch-prompt]', { timeout: 20_000 });
      expect(await director.locator('[data-stardew-auto-launch]').count()).toBe(1);
      expect(await director.locator('[data-stardew-launch-confirm]').count()).toBe(1);
      expect(await director.locator('[data-stardew-prompt-new-singleplayer]').count()).toBe(1);
      expect(await director.locator('[data-stardew-prompt-new-coop-host]').count()).toBe(1);
      await director.click('[data-stardew-launch-cancel-prompt]');
      await expect.poll(async () => director.locator('[data-stardew-launch-prompt]').count(), { timeout: 5_000 }).toBe(0);

      // ⑤ 一键「从 0 单机开玩」→ always_new + singleplayer + isolated + zh 到 ready
      await director.click('[data-stardew-new-singleplayer]');
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 }).toBe('ready');
      const spProgress = await director.locator('[data-stardew-launch-progress]').innerText();
      expect(spProgress).toContain('隔离 · zh');
      expect(spProgress).toContain('鲸屿_999000111');

      // ⑥ 展开建档与存储设置：调小屋数为 2 → 一键「从 0 联机房主开玩」→ 展示 LAN 24642 与 2/2 小屋
      await director.click('[data-stardew-config-toggle]');
      await director.waitForSelector('[data-stardew-new-save-form]', { timeout: 10_000 });
      await director.fill('[data-stardew-starting-cabins]', '2');
      await director.click('[data-stardew-new-coop-host]');
      await expect.poll(async () => panel.getAttribute('data-stardew-launch-state'), { timeout: 15_000 }).toBe('ready');
      const lanCard = await director.locator('[data-stardew-lan-status]').innerText();
      expect(lanCard).toContain('24642');
      expect(lanCard).toContain('2/2');

      // ⑦ 切换存储模式为常规目录并 reload 校验持久化，测完恢复默认隔离目录
      await director.click('[data-stardew-storage-standard]');
      await expect.poll(async () => director.locator('[data-stardew-storage-mode]').getAttribute('data-stardew-storage-mode')).toBe('standard');
      await director.reload();
      await director.waitForSelector('[data-stardew-config-toggle]', { timeout: 15_000 });
      await director.click('[data-stardew-config-toggle]');
      await expect.poll(async () => director.locator('[data-stardew-storage-mode]').getAttribute('data-stardew-storage-mode')).toBe('standard');
      await director.click('[data-stardew-storage-isolated]');
      await expect.poll(async () => director.locator('[data-stardew-storage-mode]').getAttribute('data-stardew-storage-mode')).toBe('isolated');

      mkdirSync(artifactsDir, { recursive: true });
      await director.screenshot({ path: join(artifactsDir, 'stardew-launcher-e2e.png') });
    } finally {
      await app.close();
    }
  });
});
