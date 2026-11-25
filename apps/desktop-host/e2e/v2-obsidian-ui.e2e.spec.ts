import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface DirectorUiBridgeWindow {
  directorBridge: {
    v2Resume(mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover'): Promise<{ halted: boolean; controlMode: string }>;
    v2CharacterState(): Promise<{ halted: boolean; controlMode: string }>;
    v2CharacterSnapshot(): Promise<{ goals: Array<{ title: string }> }>;
    v2VoiceMixerState(): Promise<{ tracks: Array<{ trackId: string }> }>;
  };
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as Partial<DirectorUiBridgeWindow>).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

describe('[E2E-HOST] V2-P1-05 Obsidian Tide 中控台全页遍历与控制权联动', () => {
  it('置顶控制权 HUD、F8/F9 快捷键、三态主题、全页零报错与 V2 生命中枢真实 IPC', { timeout: 120_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    const pageErrors: string[] = [];
    let director: import('playwright-core').Page | undefined;
    try {
      director = await waitForDirector(app);
      director.on('pageerror', (err) => pageErrors.push(err.message));

      // 清理上轮状态
      await director.evaluate(() =>
        (window as unknown as DirectorUiBridgeWindow).directorBridge.v2Resume('autonomous'),
      );

      // 1. 验证 ControlOwnershipHud 与 SonarRing 存在且锚定 char_xiaojing
      await director.waitForSelector('[data-v2-control-hud]', { timeout: 15_000 });
      await director.waitForSelector('[data-v2-sonar-ring]', { timeout: 5_000 });
      expect(await director.locator('[data-v2-control-hud]').innerText()).toContain('char_xiaojing');

      // 2. 点击 HUD 急停按钮 → 真实主进程 halted=true；点击恢复自主 → halted=false
      await director.click('[data-v2-hud-halt]');
      await expect.poll(
        () => director!.evaluate(() => (window as unknown as DirectorUiBridgeWindow).directorBridge.v2CharacterState().then((s) => s.halted)),
        { timeout: 10_000 },
      ).toBe(true);

      await director.waitForSelector('[data-v2-hud-resume]', { timeout: 5_000 });
      await director.click('[data-v2-hud-resume]');
      await expect.poll(
        () => director!.evaluate(() => (window as unknown as DirectorUiBridgeWindow).directorBridge.v2CharacterState().then((s) => s.halted)),
        { timeout: 10_000 },
      ).toBe(false);

      // 3. 快捷键 F8 真实急停，F9 切入人工接管
      await director.keyboard.press('F8');
      await expect.poll(
        () => director!.evaluate(() => (window as unknown as DirectorUiBridgeWindow).directorBridge.v2CharacterState().then((s) => s.halted)),
        { timeout: 10_000 },
      ).toBe(true);
      await director.waitForSelector('[data-v2-control-hud][data-halted="true"]', { timeout: 5_000 });
      await director.keyboard.press('F9');
      await expect.poll(
        () => director!.evaluate(() => (window as unknown as DirectorUiBridgeWindow).directorBridge.v2CharacterState().then((s) => s.controlMode)),
        { timeout: 10_000 },
      ).toBe('manual_takeover');
      await director.click('[data-v2-hud-resume]');

      // 4. 三态主题（system / dark / light）
      await director.click('[data-theme-system]');
      expect(await director.locator('.wb-shell').getAttribute('data-theme-mode')).toBe('system');
      await director.click('[data-theme-toggle]');
      expect(['dark', 'light']).toContain(await director.locator('.wb-shell').getAttribute('data-theme-mode'));

      // 5. 遍历全部可见侧栏页签，无未捕获异常
      const tabs = ['chat', 'memory', 'voice', 'pet', 'stardew', 'coop', 'obs', 'harness', 'providers', 'plugins', 'life'];
      for (const id of tabs) {
        await director.click(`[data-tab="${id}"]`);
        expect(await director.locator(`[data-tab="${id}"]`).getAttribute('data-active')).toBe('true');
      }

      // 6. V2 生命中枢真实交互验证
      await director.waitForSelector('[data-v2-life-console]', { timeout: 10_000 });
      expect(await director.locator('[data-v2-stage-badge="P3"]').count()).toBeGreaterThanOrEqual(1);
      expect(await director.locator('[data-v2-license-badge]').count()).toBeGreaterThanOrEqual(1);

      const goalTitle = `E2E_UI_Goal_${Date.now()}`;
      await director.fill('[data-v2-goal-input]', goalTitle);
      await director.click('[data-v2-goal-add]');
      await expect.poll(
        () => director!.evaluate(() => (window as unknown as DirectorUiBridgeWindow).directorBridge.v2CharacterSnapshot().then((s) => s.goals.map((g) => g.title))),
        { timeout: 10_000 },
      ).toContain(goalTitle);

      await director.click('[data-v2-mixer-start-bgm]');
      await expect.poll(
        () => director!.evaluate(() => (window as unknown as DirectorUiBridgeWindow).directorBridge.v2VoiceMixerState().then((m) => m.tracks.some((t) => t.trackId === 'bgm-console-preview'))),
        { timeout: 10_000 },
      ).toBe(true);
      await director.click('[data-v2-mixer-stop-bgm]');

      await director.click('[data-v2-quota-refresh]');
      await director.waitForSelector('[data-v2-quota-row="openai"]', { timeout: 20_000 });
      expect(await director.locator('[data-v2-quota-row="openai"]').getAttribute('data-quota-source')).toBe('unknown');
      expect(await director.locator('[data-v2-quota-row="openai"]').innerText()).toContain('未知');
      await director.waitForSelector('[data-v2-quota-row="codex-cli"]', { timeout: 5_000 });

      const secretMem = `E2E_UI_DEL_${Date.now()}`;
      await director.fill('[data-v2-memory-add-text]', secretMem);
      await director.click('[data-v2-memory-add-btn]');
      await director.waitForSelector('[data-v2-memory-delete]', { timeout: 10_000 });
      await director.locator('[data-v2-memory-hit]', { hasText: secretMem }).locator('[data-v2-memory-delete]').click();
      await director.waitForFunction(
        (txt) => !document.querySelector('[data-v2-memory-section]')?.textContent?.includes(txt),
        secretMem,
        { timeout: 10_000 },
      );
      expect(await director.locator('[data-v2-deletion-audits]').innerText()).toContain('episodic');

      expect(pageErrors).toEqual([]);
    } finally {
      await director?.evaluate(() =>
        (window as unknown as DirectorUiBridgeWindow).directorBridge.v2Resume('autonomous'),
      ).catch(() => undefined);
      await app.close();
    }
  });
});
