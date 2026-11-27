/** [E2E-HOST] 真 Electron + 本机 /obs；事件为 [SIMULATION]，不触碰 owner userData。 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { DirectorBridge } from '../src/renderer/director/bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = createRequire(import.meta.url)('electron') as string;
const main = join(root, 'dist/main/index.js');

declare global { interface Window { directorBridge: DirectorBridge } }

async function directorOf(app: ElectronApplication): Promise<Page> {
  let director: Page | undefined;
  await expect.poll(() => {
    director = app.windows().find((page) => page.url().includes('director'));
    return Boolean(director);
  }, { timeout: 25000 }).toBe(true);
  await director!.waitForFunction(() => Boolean(window.directorBridge));
  return director!;
}

it('[E2E-HOST][SIMULATION] 设置保存/重启恢复 → 事件去重 → OBS 规则、进度、榜单 → 停播隐藏', { timeout: 120000 }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'whale-engagement-e2e-profile-'));
  const screenshots = join(root, '../../artifacts/live-engagement');
  mkdirSync(screenshots, { recursive: true });
  let app: ElectronApplication | undefined;
  const launch = () => electron.launch({ executablePath: binary, args: ['--use-mock-keychain', main], env: { ...process.env, PET_STAGE_E2E: '1', WHALE_USER_DATA_DIR: profile } });
  try {
    app = await launch();
    let director = await directorOf(app);
    const errors: string[] = [];
    director.on('pageerror', (error) => errors.push(error.message));
    await director.click('[data-tab="life"]');
    await director.waitForSelector('[data-live-engagement-settings]');
    expect(await director.locator('[data-engagement-enabled]').isChecked()).toBe(false);
    await director.locator('[data-engagement-enabled]').check();
    await director.locator('[data-engagement-goal]').fill('10');
    await director.click('[data-engagement-save]');
    await expect.poll(() => director.locator('[data-live-engagement-settings]').innerText()).toContain('已保存');
    const persisted = JSON.parse(readFileSync(join(profile, 'pet-desktop-prefs.json'), 'utf8')) as { liveEngagement: { enabled: boolean; likeGoal: number } };
    expect(persisted.liveEngagement).toMatchObject({ enabled: true, likeGoal: 10 });
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    director = await directorOf(app);
    director.on('pageerror', (error) => errors.push(error.message));
    expect(await director.evaluate(() => window.directorBridge.v2LiveSnapshot().then((s) => s.obsStage.engagement?.config))).toMatchObject({ enabled: true, likeGoal: 10 });
    const started = await director.evaluate(() => window.directorBridge.v2LiveSessionStart({ platform: 'local_replay', roomId: 'engagement-test' }));
    expect(started.ok).toBe(true);
    await director.evaluate(async () => {
      const event = { eventId: crypto.randomUUID(), platform: 'douyin', eventType: 'LIKE', sender: { uid: 'like-user', nickname: '回放观众' }, payload: { likeCount: 12 }, assignedPriority: 'P2_IDLE', timestamp: Date.now() };
      await window.directorBridge.v2LiveIngest({ event });
      await window.directorBridge.v2LiveIngest({ event });
      for (const [uid, nickname, count] of [['a', '<img src=x onerror=alert(1)>', 3], ['b', '观众乙', 3], ['c', '观众丙', 1]] as const) {
        await window.directorBridge.v2LiveIngest({ event: { ...event, eventId: crypto.randomUUID(), eventType: 'GIFT', sender: { uid, nickname }, payload: { giftCount: count, giftDiamondValue: count * 9 } } });
      }
    });
    const info = await director.evaluate(() => window.directorBridge.webuiInfo());
    const url = `http://127.0.0.1:${info.port}/obs?token=${encodeURIComponent(info.token)}`;
    const overlayReady = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, overlayUrl) => {
      const window = new BrowserWindow({ show: false, width: 1280, height: 720 });
      void window.loadURL(overlayUrl);
    }, url);
    const overlay = await overlayReady;
    overlay.on('pageerror', (error) => errors.push(error.message));
    await overlay.waitForSelector('#engagement:not([hidden])');
    expect(await overlay.locator('#like-count').innerText()).toBe('12 / 10');
    expect(await overlay.locator('#like-progress').getAttribute('value')).toBe('10');
    expect(await overlay.locator('#rule-list').innerText()).toContain('关注 → 感谢气泡');
    expect(await overlay.locator('#engagement-source').innerText()).toContain('[SIMULATION]');
    expect(await overlay.locator('#like-status').innerText()).toContain('目标已达成');
    expect(await overlay.locator('#board-rows tr').count()).toBe(3);
    expect(await overlay.locator('#board-rows tr').nth(1).locator('td').first().innerText()).toBe('1');
    expect(await overlay.locator('#board-rows img').count()).toBe(0);
    await overlay.screenshot({ path: join(screenshots, 'obs-dark.png') });
    await overlay.goto(`${url}&theme=light&layout=compact`);
    await overlay.waitForSelector('#engagement:not([hidden])');
    await overlay.screenshot({ path: join(screenshots, 'obs-light-compact.png') });
    await overlay.setViewportSize({ width: 375, height: 812 });
    expect(await overlay.evaluate(() => document.getElementById('engagement')!.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await director.click('[data-tab="life"]');
    await director.waitForSelector('[data-engagement-preview]');
    await director.locator('[data-engagement-metric]').selectOption('value');
    await director.click('[data-engagement-save]');
    await expect.poll(() => overlay.locator('#board-unit').innerText(), { timeout: 5000 }).toBe('币（标价）');
    await director.locator('[data-engagement-enabled]').uncheck();
    await director.click('[data-engagement-save]');
    await expect.poll(() => overlay.locator('#engagement').isHidden(), { timeout: 5000 }).toBe(true);
    await director.locator('[data-engagement-enabled]').check();
    await director.click('[data-engagement-save]');
    await expect.poll(() => overlay.locator('#engagement').isVisible(), { timeout: 5000 }).toBe(true);
    expect(await overlay.locator('#like-count').innerText()).toBe('12 / 10');
    await director.evaluate(() => window.directorBridge.v2LiveSessionEnd('e2e_done'));
    await expect.poll(() => overlay.locator('#engagement').isHidden(), { timeout: 5000 }).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
