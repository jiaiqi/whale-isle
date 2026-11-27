/**
 * [E2E-HOST] V2-P2-10：启动期 `pet:sleep-status` 注册竞态。
 *
 * 历史缺陷：`index.ts` 先 `createDirectorWindow()`，再在 `await petWindowManager.open(...)`
 * 之后才注册 `ipcMain.handle('pet:sleep-status')`；中控台 renderer 首挂即调用
 * `petSleepStatus()`（`director/App.tsx`），冷启动会跑赢 boot，主进程打印
 * `Error occurred in handler for 'pet:sleep-status': ... No handler registered`。
 *
 * 断言：
 *   ① 真实 Electron 冷启动后，renderer 调用 `pet:sleep-status` 拿到 `{ ok: true, asleep: false, count: 0 }`
 *      （冷启动无睡眠持久化，`asleep:false` 本就是正确答案）；
 *   ② 启动期主进程 `console.error` 留档中不出现该「No handler registered」错误
 *      （`PET_STAGE_E2E=1` 下由 `installBootErrorRecorder()` 原样转发并留档）。
 *
 * 口径：这是真实 Electron 冷启动（`[E2E-HOST]`），但不是真机长时运行的时序证明；竞态本身是概率事件，
 * 本用例证明「当前构建冷启动未复现 + 早期注册已就位」，不冒充 `[REAL-DEVICE]` 验收。
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

interface BootProbe {
  directorBridge?: {
    petSleepStatus?: () => Promise<{ ok: boolean; asleep: boolean; count: number }>;
  };
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

describe('[E2E-HOST] V2-P2-10 启动期 pet:sleep-status 注册竞态', () => {
  it('冷启动调用命中真实 handler，且启动期 stderr 不再出现 No handler registered', { timeout: 120_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const director = await waitForWindow(app, 'director');
      await director.waitForFunction(
        () => Boolean((window as unknown as BootProbe).directorBridge?.petSleepStatus),
        { timeout: 20_000 },
      );

      const status = await director.evaluate(async () =>
        (window as unknown as BootProbe).directorBridge!.petSleepStatus!());
      expect(status).toEqual({ ok: true, asleep: false, count: 0 });

      // 启动期留档必须已安装（空数组也算已安装）；否则说明 recorder 没跑，断言会变成假绿。
      const bootErrors = await app.evaluate(
        () => (globalThis as { __whaleBootErrors?: string[] }).__whaleBootErrors ?? null,
      );
      expect(Array.isArray(bootErrors)).toBe(true);
      const sleepStatusErrors = (bootErrors as string[]).filter(
        (line) => line.includes('No handler registered') && line.includes('pet:sleep-status'),
      );
      expect(sleepStatusErrors).toEqual([]);

      mkdirSync(artifactsDir, { recursive: true });
      await director.screenshot({ path: join(artifactsDir, 'p2-10-boot-ipc-director.png') });
    } finally {
      await app.close();
    }
  });
});
