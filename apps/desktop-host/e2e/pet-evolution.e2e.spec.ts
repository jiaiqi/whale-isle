import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] T-M6-63/64/65 桌宠深度体验：
 *   ① 随包 crosspet-claude 的真实 pose-config（无素材时诚实为空，不伪造）
 *   ② 气泡字体声明包含 ShangShouGummy
 *   ③ windowLayer / bubbleFontScale 持久化并真实作用到窗口与 CSS 变量
 *   ④ 小本子双页切换 + 8 套手写体注入
 *   ⑤ 彩蛋小剧场可打开、抓包收口且不留僵尸窗
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const hasPacks = existsSync(join(repoRoot, 'assets', 'pet-packs', 'crosspet', 'characters', 'claude', 'character.json'));

interface PetStageBridge {
  prefsGet(): Promise<{ windowLayer: string; bubbleFontScale: number | null; notebookFontId: string }>;
  prefsSet(update: Record<string, unknown>): Promise<unknown>;
  customPoseConfig(characterId: string): Promise<{ ok: boolean; correctedPose?: string; fx?: Record<string, string>; lines?: Record<string, string[]>; pokePose?: string }>;
  petEggTheater(): Promise<{ ok: boolean; agentId?: string; error?: string }>;
  eggCatch(): Promise<{ ok: boolean; caught?: boolean; error?: string }>;
}

async function waitFor(app: import('playwright-core').ElectronApplication, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未满足`);
}

async function waitForWindow(app: import('playwright-core').ElectronApplication, urlPart: string, timeoutMs = 25_000): Promise<import('playwright-core').Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未找到包含 ${urlPart} 的窗口`);
}

describe('[E2E-HOST] 桌宠深度体验三阶段', () => {
  it('随包姿态/气泡字体/显示层级/小本子双页/彩蛋小剧场', { timeout: 150_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      console.log('[pet-evolution-e2e] launched');
      const stage = await waitForWindow(app, 'pet-stage');
      console.log('[pet-evolution-e2e] stage window found');
      await waitFor(stage, () => stage.evaluate(() => Boolean((window as unknown as { __petStageReady?: boolean }).__petStageReady)), 20_000);
      console.log('[pet-evolution-e2e] stage ready');

      // ① 随包角色 pose-config：有素材时必须是真实扩展字段；干净 checkout 如实 ok:false
      const pose = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.customPoseConfig('crosspet-claude'));
      if (hasPacks) {
        expect(pose.ok).toBe(true);
        expect(pose.correctedPose).toBe('sorry');
        expect(pose.fx?.proud).toBe('victory');
        expect(Object.keys(pose.lines ?? {}).length).toBeGreaterThan(5);
      } else {
        expect(pose.ok).toBe(false);
      }
      console.log('[pet-evolution-e2e] pose config ok');

      // ② 气泡字体声明包含上首软糖体（字体未加载也必须有回退链）
      await stage.evaluate(() => {
        (window as unknown as { __petStageTest?: { showBubbles(input: { thought: string; dialog: string }): void } }).__petStageTest?.showBubbles({ thought: '在心里盘算', dialog: '气泡字体测试' });
      });
      const fontFamily = await stage.evaluate(() => {
        const node = document.querySelector('.pet-bubble--dialog');
        return node === null ? '' : getComputedStyle(node).fontFamily;
      });
      expect(fontFamily).toContain('ShangShouGummy');
      console.log('[pet-evolution-e2e] bubble font ok');

      // ③ 显示层级 / 气泡字号持久化并生效
      await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.prefsSet({ windowLayer: 'normal', bubbleFontScale: 1.4 }));
      await waitFor(stage, async () => {
        const prefs = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.prefsGet());
        const scale = await stage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pet-bubble-font-scale').trim());
        return prefs.windowLayer === 'normal' && prefs.bubbleFontScale === 1.4 && scale === '1.4';
      });
      await waitFor(app, async () => {
        const onTop = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle().includes('桌宠'));
          return win?.isAlwaysOnTop() ?? true;
        });
        return onTop === false;
      });
      await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.prefsSet({ windowLayer: 'always', bubbleFontScale: null }));
      await waitFor(app, async () => {
        const onTop = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle().includes('桌宠'));
          return win?.isAlwaysOnTop() ?? false;
        });
        return onTop === true;
      });
      console.log('[pet-evolution-e2e] layer/prefs ok');

      // ④ 小本子双页 + 8 套手写体注入
      const director = await waitForWindow(app, 'director');
      await director.waitForFunction(() => Boolean((window as unknown as { directorBridge?: unknown }).directorBridge), { timeout: 20_000 });
      await director.click('[data-tab="pet"]');
      await director.waitForSelector('[data-pet-studio]', { timeout: 15_000 });
      await director.click('[data-pet-studio-tab="social"]');
      await director.waitForSelector('[data-notebook-panel]', { timeout: 15_000 });
      const styleText = await director.evaluate(() => document.querySelector('[data-notebook-panel] style')?.textContent ?? '');
      expect(styleText).toContain('whale-hand-ma-shan-zheng');
      expect(styleText).toContain('whale-hand-notebook-kai');
      await director.click('[data-notebook-page-tab="friends"]');
      await director.waitForFunction(() => {
        const panel = document.querySelector('[data-notebook-page="friends"]') as HTMLElement | null;
        return panel !== null && panel.style.display !== 'none';
      }, { timeout: 10_000 });
      expect(await director.locator('[data-notebook-friend-notes]').count()).toBe(1);
      console.log('[pet-evolution-e2e] notebook ok');

      // ⑤ 彩蛋小剧场：有素材则打开→抓包→收口；无素材如实失败
      const egg = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.petEggTheater());
      if (egg.ok) {
        expect(egg.agentId).toBeTruthy();
        const eggUrlPart = `agentId=${encodeURIComponent(egg.agentId!)}`;
        const eggWindow = await waitForWindow(app, eggUrlPart, 20_000);
        await eggWindow.waitForLoadState('domcontentloaded').catch(() => undefined);
        const caught = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.eggCatch());
        expect(caught).toMatchObject({ ok: true, caught: true });
        // 仅断言本次打开的彩蛋窗自身收口关闭：共享 e2e-profile 下若开发机同时运行 AI CLI，
        // cliLogWatcher 会自动召唤跨 AI 工作跟随窗，按全部 pet-stage 窗口数 === 1 会误报。
        await waitFor(app, async () => app.windows().every((candidate) => !candidate.url().includes(eggUrlPart)), 15_000);
      } else {
        expect(egg.error ?? '').toContain('彩蛋');
      }
      console.log('[pet-evolution-e2e] egg theater done');
    } finally {
      // E2E profile 跨 spec 共享：恢复默认偏好，避免污染后续用例
      const stage = app.windows().find((candidate) => candidate.url().includes('pet-stage'));
      if (stage !== undefined) {
        await stage.evaluate(() => (window as unknown as { petStage?: PetStageBridge }).petStage?.prefsSet({ windowLayer: 'always', bubbleFontScale: null })).catch(() => undefined);
      }
      await app.close();
    }
  });
});
