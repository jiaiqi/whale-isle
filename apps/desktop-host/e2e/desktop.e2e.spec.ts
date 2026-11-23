import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] T-M1-02 门禁：Playwright Electron。
 *   ① 窗口属性：transparent/frameless/alwaysOnTop/skipTaskbar（创建配置 + 真实 alwaysOnTop API 双证）
 *   ② alpha 穿透状态机：force(255/65)→interactive；force(0/64/63)→passthrough（阈值 64，软边不拦操作）
 *   ③ 拖拽：dragTo 越界值被主进程夹紧在某块屏幕的可达 workArea 内
 * OS 级真实点击穿透属 [REAL-DEVICE]（VERIFY.md 真机抽检栏），此处不冒充。
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface PetStageWindow {
  petStage: {
    ready: boolean;
    getState(): Promise<'passthrough' | 'interactive'>;
    dragTo(x: number, y: number): Promise<[number, number] | null>;
    winPosition(): Promise<[number, number] | null>;
    prefsSet(update: { position: { x: number; y: number; displayId: string } }): Promise<unknown>;
    screenBounds(): Promise<{
      displayId: string;
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      windowBounds: { minX: number; minY: number; maxX: number; maxY: number };
    }>;
    forceAlpha?(alpha: number): Promise<boolean>;
    appMeta(): Promise<Record<string, unknown>>;
  };
  __petStageReady: boolean;
}

/** 轮询工具：透明置顶窗在后台时 rAF 被 Chromium 节流，waitForFunction(raf) 会假超时——统一用 evaluate 轮询 */
async function waitFor(win: import('playwright-core').Page, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未满足（透明窗 rAF 节流？请用 evaluate 轮询）`);
}


/** 轮询等待指定 URL 片段的窗口（双窗口启动顺序不保证） */
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

describe('[E2E-HOST] desktop-host 透明穿透宿主', () => {
  it('窗口属性 + alpha 阈值状态机 + 拖拽边界夹紧', { timeout: 90_000 }, async () => {
    let app = await electron.launch({
      args: [mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const win = await waitForWindow(app, 'pet-stage');
      await waitFor(
        win,
        () => win.evaluate(() => Boolean((window as unknown as PetStageWindow).__petStageReady)),
        20_000,
      );

      // ① 窗口属性：主进程 API 真值 + meta 自报双证
      const browserWindow = await app.browserWindow(win);
      const alwaysOnTop = await browserWindow.evaluate((w) => w.isAlwaysOnTop());
      expect(alwaysOnTop).toBe(true);
      const meta = (await win.evaluate(() => (window as unknown as PetStageWindow).petStage.appMeta())) as {
        transparent: boolean;
        frame: boolean;
        testMode: boolean;
      };
      expect(meta).toMatchObject({ transparent: true, frame: false, testMode: true });

      // ② alpha 状态机（阈值 64：>64 交互，<=64 穿透——半透明软边不拦桌面操作）
      const forceAlpha = (alpha: number) => win.evaluate((value) => (window as unknown as PetStageWindow).petStage.forceAlpha?.(value) ?? false, alpha);
      const stateIs = (expected: 'passthrough' | 'interactive') =>
        win.evaluate(() => (window as unknown as PetStageWindow).petStage.getState()).then((state) => state === expected);
      await forceAlpha(255);
      await waitFor(win, () => stateIs('interactive'));
      await forceAlpha(65);
      await waitFor(win, () => stateIs('interactive'));
      await forceAlpha(64);
      await waitFor(win, () => stateIs('passthrough'));
      await forceAlpha(63); // 软边光晕必须穿透
      await waitFor(win, () => stateIs('passthrough'));
      await forceAlpha(0);
      await waitFor(win, () => stateIs('passthrough'));
      await forceAlpha(255);
      await waitFor(win, () => stateIs('interactive'));
      await expect(stateIs('interactive')).resolves.toBe(true);

      // ③ 拖拽：越界目标被夹紧在合并 workArea 内
      const clamped = (await win.evaluate(() => (window as unknown as PetStageWindow).petStage.dragTo(999_999, 999_999))) as [
        number,
        number,
      ];
      const bounds = await win.evaluate(() => (window as unknown as PetStageWindow).petStage.screenBounds());
      expect(bounds.displayId).not.toBe('');
      expect(clamped[0]).toBeLessThanOrEqual(bounds.windowBounds.maxX);
      expect(clamped[1]).toBeLessThanOrEqual(bounds.windowBounds.maxY);
      expect(clamped[0]).toBeGreaterThanOrEqual(bounds.windowBounds.minX);
      expect(clamped[1]).toBeGreaterThanOrEqual(bounds.windowBounds.minY);
      const targetX = Math.min(bounds.windowBounds.maxX, bounds.windowBounds.minX + 40);
      const targetY = Math.min(bounds.windowBounds.maxY, bounds.windowBounds.minY + 40);
      const moved = (await win.evaluate(([x, y]) =>
        (window as unknown as PetStageWindow).petStage.dragTo(x, y), [targetX, targetY],
      )) as [number, number];
      expect(moved).toEqual([targetX, targetY]);
      const restoredScreen = await win.evaluate(() => (window as unknown as PetStageWindow).petStage.screenBounds());
      expect(restoredScreen.displayId).toBe(bounds.displayId);

      // Persist a point beyond the work area, restart, and verify restoration clamps on that display.
      await win.evaluate(({ x, y, displayId }) =>
        (window as unknown as PetStageWindow).petStage.prefsSet({ position: { x, y, displayId } }),
      {
        x: restoredScreen.windowBounds.maxX + 500,
        y: restoredScreen.windowBounds.maxY + 500,
        displayId: restoredScreen.displayId,
      });
      await app.close();
      app = await electron.launch({
        args: [mainEntry],
        executablePath: electronBinary,
        env: { ...process.env, PET_STAGE_E2E: '1' },
      });
      const restoredWin = await waitForWindow(app, 'pet-stage');
      await waitFor(
        restoredWin,
        () => restoredWin.evaluate(() => Boolean((window as unknown as PetStageWindow).__petStageReady)),
        20_000,
      );
      const finalBounds = await restoredWin.evaluate(() => (window as unknown as PetStageWindow).petStage.screenBounds());
      const finalPosition = await restoredWin.evaluate(() => (window as unknown as PetStageWindow).petStage.winPosition());
      expect(finalBounds.displayId).toBe(restoredScreen.displayId);
      expect(finalPosition).toEqual([finalBounds.windowBounds.maxX, finalBounds.windowBounds.maxY]);
    } finally {
      await app.close();
    }
  }, 90_000);
});
