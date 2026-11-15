import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] T-M1-05 门禁：
 *   ① Playwright 截图 + 几何断言——pet-stage 双轨气泡同时显示且不重叠
 *   ② 套餐胶囊一键切换 → Dexie 状态同步（键值断言 + 刷新后持久恢复）
 * 视觉观感（气泡美观度）属真机抽检，不在此冒充。
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const artifactsDir = join(repoRoot, 'artifacts');

interface PetStageWindow {
  __petStageReady: boolean;
  __petStageTest?: {
    showBubbles(input: { thought: string; dialog: string }): void;
    bubbleElements(): { thought: DOMRectJSON | null; dialog: DOMRectJSON | null };
    setRiceRatio(ratio: number): void;
    riceRatio(): number;
  };
  petStage: { appMeta(): Promise<Record<string, unknown>> };
}

interface DOMRectJSON {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlap(a: DOMRectJSON, b: DOMRectJSON): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
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


/** 轮询工具：透明置顶窗 rAF 被节流时 waitForFunction 会假超时——统一 evaluate 轮询 */
async function waitFor(win: import('playwright-core').Page, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未满足`);
}

describe('[E2E-HOST] T-M1-05 舞台挂件与中控台', () => {
  it('双轨气泡不重叠（截图留证）+ 套餐胶囊切换 Dexie 同步与刷新恢复', { timeout: 120_000 }, async () => {
    const app = await electron.launch({
      args: [mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      // ---- ① pet-stage：双轨气泡 + 饭碗挂件 ----
      const stageWin = await waitForWindow(app, 'pet-stage');
      await waitFor(
        stageWin,
        () => stageWin.evaluate(() => Boolean((window as unknown as PetStageWindow).__petStageReady)),
        20_000,
      );
      // 透明后台窗 rAF 节流：一律 evaluate 轮询（见 T-M1-02 踩坑记录）
      await stageWin.evaluate(() => {
        (window as unknown as PetStageWindow).__petStageTest?.showBubbles({
          thought: '<think>今晚吃几碗白米饭配红烧肉……</think>',
          dialog: '哼，本鱼才没有偷懒！鱼片你再乱叫今晚不给你浇菜了！',
        });
        (window as unknown as PetStageWindow).__petStageTest?.setRiceRatio(0.06); // 饿瘪态
      });
      const rects = await stageWin.evaluate(() => (window as unknown as PetStageWindow).__petStageTest?.bubbleElements()) as {
        thought: DOMRectJSON | null;
        dialog: DOMRectJSON | null;
      };
      expect(rects.thought).not.toBeNull();
      expect(rects.dialog).not.toBeNull();
      expect(overlap(rects.thought as DOMRectJSON, rects.dialog as DOMRectJSON)).toBe(false); // 几何不重叠
      const riceRatio = await stageWin.evaluate(() => (window as unknown as PetStageWindow).__petStageTest?.riceRatio());
      expect(riceRatio).toBeCloseTo(0.06, 5); // 饿瘪态（<15% 阈值）

      // 截图留证（artifacts/ 本地不入库）
      mkdirSync(artifactsDir, { recursive: true });
      const shotPath = join(artifactsDir, 'pet-stage-bubbles.png');
      await stageWin.screenshot({ path: shotPath });

      // ---- ② director：套餐胶囊一键切换 → Dexie 同步 + 刷新恢复 ----
      const directorWin = app.windows().find((candidate) => candidate.url().includes('director'));
      expect(directorWin).toBeDefined();
      const director = directorWin!;
      await director.waitForFunction(() => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot), { timeout: 20_000 });

      // 一键切换序列（Dexie 跨运行持久，不假设初始态）：🍚 省饭档 → 🛡️ 断网档
      const snapshot = async () => (await director.evaluate(() => (window as unknown as { __directorSnapshot: () => Promise<Record<string, unknown>> }).__directorSnapshot())) as Record<string, unknown>;
      await director.click('[data-profile="BUDGET_SLACKING"]');
      await director.waitForFunction(
        () => document.querySelector('[data-profile="BUDGET_SLACKING"]')?.getAttribute('data-active') === 'true',
        { timeout: 5_000 },
      );
      expect((await snapshot()).activeDiningProfile).toBe('BUDGET_SLACKING'); // Dexie 状态同步①

      await director.click('[data-profile="OFFLINE_SURVIVAL"]');
      await director.waitForFunction(
        () => document.querySelector('[data-profile="OFFLINE_SURVIVAL"]')?.getAttribute('data-active') === 'true',
        { timeout: 5_000 },
      );
      expect((await snapshot()).activeDiningProfile).toBe('OFFLINE_SURVIVAL'); // Dexie 状态同步②

      // 刷新后持久恢复（IndexedDB 真持久化，非内存态）
      await director.reload();
      await director.waitForFunction(
        () => document.querySelector('[data-profile="OFFLINE_SURVIVAL"]')?.getAttribute('data-active') === 'true',
        { timeout: 10_000 },
      );
      const restored = (await director.evaluate(() => (window as unknown as { __directorSnapshot: () => Promise<Record<string, unknown>> }).__directorSnapshot())) as Record<string, unknown>;
      expect(restored.activeDiningProfile).toBe('OFFLINE_SURVIVAL');
      // 六槽位绑定随套餐切换
      const binding = await director.evaluate(() => document.querySelector('[data-binding="MAIN_PERSONA_BRAIN"]')?.textContent);
      expect(binding).toContain('local-ollama/qwen2.5:14b');
    } finally {
      await app.close();
    }
  }, 120_000);
});
