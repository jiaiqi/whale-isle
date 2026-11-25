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

interface DirectorV2Window {
  directorBridge: {
    v2KernelHealth(): Promise<{
      lifecycle: string;
      activeCharacter: { characterId: string; displayName: string; halted: boolean; controlMode: string };
      plugins: { total: number; enabled: number; errors: number };
      vaultBackend: string;
    }>;
    v2CharacterState(): Promise<{ identity: { characterId: string; displayName: string }; halted: boolean }>;
    v2EmergencyHalt(reason?: string): Promise<{ halted: boolean; controlMode: string; expression: string }>;
    v2Resume(mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover'): Promise<{ halted: boolean; controlMode: string }>;
  };
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as Partial<DirectorV2Window>).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

describe('[E2E-HOST] V2 WhaleKernel Electron 宿主集成', () => {
  it('启动后 WhaleKernel 进入 running，支持角色状态读取、紧急停止与恢复', { timeout: 60_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const director = await waitForDirector(app);
      const health = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2KernelHealth(),
      );
      expect(health.lifecycle).toBe('running');
      expect(health.activeCharacter.characterId).toBe('char_xiaojing');
      expect(health.activeCharacter.displayName).toBe('小鲸');
      expect(health.plugins.total).toBeGreaterThanOrEqual(1);
      expect(health.plugins.enabled).toBeGreaterThanOrEqual(1);
      expect(health.plugins.errors).toBe(0);

      const state = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2CharacterState(),
      );
      expect(state.identity.characterId).toBe('char_xiaojing');
      expect(state.halted).toBe(false);

      const halted = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2EmergencyHalt('E2E 急停测试'),
      );
      expect(halted.halted).toBe(true);
      expect(halted.controlMode).toBe('manual_takeover');
      expect(halted.expression).toBe('idle');

      const resumed = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2Resume('autonomous'),
      );
      expect(resumed.halted).toBe(false);
      expect(resumed.controlMode).toBe('autonomous');
    } finally {
      await app.close();
    }
  });
});
