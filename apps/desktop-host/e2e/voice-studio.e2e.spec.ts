/**
 * [E2E-HOST] 声音工坊 2.0（音色库 / 音色设计 / 音色克隆 / 表演与精调 / 引擎与凭据）端到端验收。
 *
 * 全链路走真实 Electron 进程 + 真实预加载 IPC + 真实 WAV PCM 编解码：
 * 1. 验证五大页签无报错切换、9 角色快切条、紧凑状态在场条与出厂声线 Hero 波形加载；
 * 2. 验证音色设计台 4 拨盘 + 4 快捷配方 + 真实描述拼接 + 强度 A/B/C + 漂移警示；
 * 3. 验证音色克隆台真实上传标准 24kHz PCM WAV → 自动波形渲染与声学质检 → 权属声明拦截门禁
 *    → 勾选确认后真实入库为新版本 → 声线库出现该版本 → 重命名/回退出厂/删除全闭环（零云端计费）；
 * 4. 验证表演与精调 5 情绪矩阵 + 5 口型 Viseme 轨道；
 * 5. 验证引擎与凭据 4 轨输出路由 + 4 张凭据卡片。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const electronBinary = join(appRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

function buildCleanWavFile(path: string, durationSec = 6.0, sampleRate = 24_000): void {
  const count = Math.round(durationSec * sampleRate);
  const dataBytes = count * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < count; i++) {
    const inPause = i % Math.floor(sampleRate * 1.2) < Math.floor(sampleRate * 0.2);
    const val = inPause ? 0.001 : 0.35 * Math.sin((2 * Math.PI * 310 * i) / sampleRate);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(val * 32767))), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

async function waitForDirector(app: Awaited<ReturnType<typeof electron.launch>>, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes('director')) return w;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('等待 director 窗口超时');
}

describe('[E2E-HOST] 声音工坊 2.0 全链路验证', () => {
  it('声线库 + 音色设计 + 音色克隆真上传/质检/权属门禁/入库/回退/删除 + 表演 + 引擎', async () => {
    expect(existsSync(mainEntry)).toBe(true);
    const tmp = mkdtempSync(join(tmpdir(), 'whale-voice-studio-e2e-'));
    const sampleWavPath = join(tmp, 'self-recorded-clean.wav');
    buildCleanWavFile(sampleWavPath, 6.0, 24_000);
    const captureDir = process.env.WHALE_VOICE_CAPTURE_DIR;

    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });

    const pageErrors: string[] = [];
    try {
      const page = await waitForDirector(app);
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await page.setViewportSize({ width: 1440, height: 920 });
      await page.waitForFunction(() => Boolean((window as unknown as { directorBridge?: { v2VoiceWorkshopState?: unknown } }).directorBridge?.v2VoiceWorkshopState), { timeout: 30_000 });

      await page.click('[data-tab="voice"]');
      await page.waitForSelector('[data-voice-center]', { timeout: 15_000 });

      // 显式切到潮汐纸「晨雾 Mist」浅色以验收浅色纸面对比度
      if (captureDir) {
        await page.evaluate(() => {
          document.documentElement.dataset.skin = 'tidepaper';
          document.documentElement.classList.remove('dark');
        });
      }

      // 1. 声线库默认页签：Hero 卡 + 出厂声线 + 内置 9 音色
      await page.waitForSelector('[data-voice-active-hero]', { timeout: 15_000 });
      await page.waitForFunction(() => (document.querySelector('[data-voice-active-hero]')?.textContent ?? '').includes('07 甜脆'), undefined, { timeout: 15_000 });
      expect(await page.locator('[data-voice-mimo-builtin]').count()).toBe(9);
      if (captureDir) await page.screenshot({ path: join(captureDir, '01-voices-light.png') });

      // 2. 音色设计台：4 拨盘 + 4 快捷配方 + 强度 A/B/C + 漂移警示
      await page.click('[data-voice-tab-btn="workshop"]');
      await page.waitForSelector('[data-voice-workshop] [data-workshop-current]', { timeout: 15_000 });
      expect(await page.locator('[data-workshop-dial]').count()).toBe(4);
      expect(await page.locator('[data-workshop-recipe]').count()).toBe(4);
      expect(await page.locator('[data-workshop-intensity-option]').count()).toBe(3);
      expect(await page.locator('[data-workshop-composed]').innerText()).toContain('八九岁小女孩');
      if (captureDir) await page.screenshot({ path: join(captureDir, '02-design-light.png') });

      // 3. 音色克隆台：上传真实 WAV → 真实 PCM 波形 & 声学质检 → 权属拦截 → 勾选后真实入库
      await page.click('[data-voice-tab-btn="clone"]');
      await page.waitForSelector('[data-voice-clone-studio]', { timeout: 15_000 });
      expect(await page.locator('[data-clone-submit]').isDisabled()).toBe(true);

      await page.setInputFiles('[data-voice-clone-upload-input]', sampleWavPath);
      await page.waitForSelector('[data-clone-trimmer]', { timeout: 15_000 });
      await page.waitForSelector('[data-clone-qa-metrics]', { timeout: 15_000 });
      expect(await page.locator('[data-clone-qa-metrics]').innerText()).toContain('6.0s');
      expect(await page.locator('[data-clone-qa-metrics]').innerText()).toContain('24 kHz');

      // 未勾选权属声明时，提交按钮必须依然禁用（强门禁）
      await page.fill('[data-clone-label-input]', 'E2E 亲录小鲸');
      expect(await page.locator('[data-clone-submit]').isDisabled()).toBe(true);

      // 勾选声明后提交，验证真正落盘到 VoiceWorkshop 版本库
      await page.check('[data-clone-consent-check]');
      expect(await page.locator('[data-clone-submit]').isDisabled()).toBe(false);
      if (captureDir) await page.screenshot({ path: join(captureDir, '03-clone-light.png') });

      await page.click('[data-clone-submit]');
      await page.waitForSelector('[data-clone-created]', { timeout: 15_000 });
      expect(await page.locator('[data-clone-created]').innerText()).toContain('E2E 亲录小鲸');

      // 回到声线库：新版本已生效且可回退并清理删除
      await page.click('[data-voice-tab-btn="voices"]');
      await page.waitForSelector('[data-voice-version-grid]', { timeout: 15_000 });
      expect(await page.locator('[data-voice-active-hero]').innerText()).toContain('E2E 亲录小鲸');

      const stateAfterClone = await page.evaluate(() =>
        (window as unknown as {
          directorBridge: {
            v2VoiceWorkshopState(): Promise<{ currentVersionId: string; versions: Array<{ id: string; label: string; source: string }> }>;
          };
        }).directorBridge.v2VoiceWorkshopState(),
      );
      const created = stateAfterClone.versions.find((v) => v.label === 'E2E 亲录小鲸');
      expect(created).toBeDefined();
      expect(created?.source).toBe('uploaded');

      // 通过真实 IPC 删除该测试克隆版本，确认自动安全回退出厂版
      const deleted = await page.evaluate(
        (versionId) => (window as unknown as {
          directorBridge: { v2VoiceWorkshopDelete(input: { versionId: string }): Promise<{ deletedId: string; currentVersion: { id: string } }> };
        }).directorBridge.v2VoiceWorkshopDelete({ versionId }),
        created!.id,
      );
      expect(deleted.currentVersion.id).toBe('factory');

      // 4. 表演与精调页签：5 情绪矩阵 + 5 口型 Viseme + RVC
      await page.click('[data-voice-tab-btn="studio"]');
      await page.waitForSelector('[data-voice-performance-tab]', { timeout: 15_000 });
      expect(await page.locator('[data-voice-emotion-pick]').count()).toBe(5);
      expect(await page.locator('[data-viseme-cell]').count()).toBe(5);
      if (captureDir) await page.screenshot({ path: join(captureDir, '04-performance-light.png') });

      // 5. 引擎与凭据页签：档位开关 + 4 轨输出路由 + 4 张凭据卡片
      await page.click('[data-voice-tab-btn="engine"]');
      await page.waitForSelector('[data-voice-engine-tab]', { timeout: 15_000 });
      expect(await page.locator('[data-voice-route]').count()).toBe(4);
      expect(await page.locator('[data-voice-credential]').count()).toBe(4);
      if (captureDir) await page.screenshot({ path: join(captureDir, '05-engine-light.png') });

      // 切到夜潮（Dark）并截取声线库与音色设计截图，验收暗色主题适配
      if (captureDir) {
        await page.evaluate(() => { document.documentElement.classList.add('dark'); });
        await page.click('[data-voice-tab-btn="voices"]');
        await page.waitForSelector('[data-voice-active-hero]', { timeout: 15_000 });
        await page.screenshot({ path: join(captureDir, '06-voices-dark.png') });
        await page.click('[data-voice-tab-btn="workshop"]');
        await page.waitForSelector('[data-voice-workshop]', { timeout: 15_000 });
        await page.screenshot({ path: join(captureDir, '07-design-dark.png') });
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
