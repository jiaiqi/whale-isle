import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] V2-P3-01 中控台「点歌台」最小面板：
 *   ① 能力状态来自宿主真实探测（worker 不可达时如实 missing，不显示假 ready）
 *   ② 提交一次点歌后，管线如实进入 unavailable 并逐项列出缺口
 *   ③ 播放回执区保持空态——没有真实首切片就绝不写播放回执
 *
 * 诚实口径：本用例**不**验证真唱（无 Demucs/RVC 后端与授权声线权重），
 * 只验证「缺能力时如实报缺、不伪造成功」这条红线。
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface DirectorSongBridgeWindow {
  directorBridge: {
    v2SongCapabilities(): Promise<{ ok: boolean; capabilities: Array<{ name: string; ready: boolean; detail: string }> }>;
    v2SongSnapshot(): Promise<{ status: { state: string; stage: string } | null }>;
  };
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as Partial<DirectorSongBridgeWindow>).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

describe('[E2E-HOST] V2-P3-01 中控台点歌台面板', () => {
  it('能力状态如实报缺、未授权即拒绝、授权后无后端如实 unavailable、播放回执保持空态', { timeout: 120_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      // 指向一个必然不可达的端口：模拟「后端未启动」，验证面板如实报缺而不是假装就绪
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_AUDIO_WORKER: 'http://127.0.0.1:9' },
    });
    const pageErrors: string[] = [];
    let director: import('playwright-core').Page | undefined;
    try {
      director = await waitForDirector(app);
      director.on('pageerror', (err) => pageErrors.push(err.message));

      await director.click('[data-tab="song"]');
      await director.waitForSelector('[data-song-console]', { timeout: 10_000 });
      await director.waitForSelector('[data-song-capabilities]', { timeout: 10_000 });

      // ① 能力状态：宿主探测失败时必须显示 missing 与缺口说明
      await director.waitForFunction(
        () => (document.querySelector('[data-song-capabilities]')?.textContent ?? '').includes('audio-ai-worker'),
        undefined,
        { timeout: 15_000 },
      );
      const capText = await director.locator('[data-song-capabilities]').innerText();
      expect(capText).toContain('missing');
      expect(capText).not.toContain('全部就绪');

      // ② 未授权声线 → 授权门禁如实拒绝（不进任何音频处理）
      await director.fill('[data-song-title]', 'E2E 点歌台自检曲');
      await director.fill('[data-song-consent]', 'E2E 自检：无真实声线模型，仅验证缺能力如实报缺');
      await director.click('[data-song-submit]');
      await director.waitForFunction(
        () => (document.querySelector('[data-song-status]')?.textContent ?? '').includes('rejected'),
        undefined,
        { timeout: 20_000 },
      );
      const rejectedText = await director.locator('[data-song-status]').innerText();
      expect(rejectedText).toContain('角色声音模型未经授权');

      // ③ 勾选授权后再提交（仍无源音频与后端）→ 管线如实 unavailable 并逐项列出缺口
      await director.check('[data-song-voice-authorized]');
      await director.click('[data-song-submit]');
      await director.waitForFunction(
        () => (document.querySelector('[data-song-status]')?.textContent ?? '').includes('unavailable'),
        undefined,
        { timeout: 20_000 },
      );
      const statusText = await director.locator('[data-song-status]').innerText();
      expect(statusText).toContain('unavailable');
      expect(statusText).toContain('缺失能力');
      expect(statusText).not.toContain('completed');

      // ④ 播放回执：没有真实首切片 → 保持空态（不写假回执）
      const receiptText = await director.locator('[data-song-receipts]').innerText();
      expect(receiptText).toContain('还没有真实播放回执');

      // 宿主侧状态与 UI 一致
      const snapshot = await director.evaluate(() =>
        (window as unknown as DirectorSongBridgeWindow).directorBridge.v2SongSnapshot(),
      );
      expect(snapshot.status?.state).toBe('unavailable');

      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
