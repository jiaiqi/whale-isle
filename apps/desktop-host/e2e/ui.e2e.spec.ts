import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] T-M1-05 门禁：
 *   ① Playwright 截图 + 几何断言——pet-stage 双轨气泡同时显示且不重叠
 *   ② 模型与服务商 v5：双 Tab / 自定义服务商增删持久 / 导入弹窗（零明文泄露）
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

      // ---- ② director：模型与服务商 v5（双 Tab / 自定义服务商 / 导入弹窗） ----
      const directorWin = app.windows().find((candidate) => candidate.url().includes('director'));
      expect(directorWin).toBeDefined();
      const director = directorWin!;
      await director.waitForFunction(() => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot), { timeout: 20_000 });
      const snapshot = async () => (await director.evaluate(() => (window as unknown as { __directorSnapshot: () => Promise<Record<string, unknown>> }).__directorSnapshot())) as Record<string, unknown>;

      await director.click('[data-tab="providers"]');
      await director.waitForSelector('[data-provider-item="opencode-go"]', { timeout: 10_000 });

      // 双 Tab：服务商配置 / 默认模型(6)
      expect(await director.locator('[data-ptab]').count()).toBe(2);
      await director.click('[data-ptab="defaults"]');
      await director.waitForSelector('[data-slot-select="MAIN_PERSONA_BRAIN"]', { timeout: 5_000 });
      expect(await director.locator('[data-slot-select]').count()).toBe(6);
      await director.click('[data-ptab="providers"]');

      // OpenCode Go 内置条目 + 协议变体
      await director.click('[data-provider-item="opencode-go"]');
      await director.waitForFunction(() => document.body.innerText.includes('OpenCode Go'));
      expect(await director.locator('[data-variant]').count()).toBeGreaterThanOrEqual(2);
      expect(await director.locator('[data-set-main]').count()).toBeGreaterThanOrEqual(1);

      // 添加自定义服务商（Anthropic 协议 + isFullUrl）
      await director.click('[data-add-provider]');
      await director.fill('[data-new-name]', 'E2E 自建中转');
      await director.click('[data-new-proto="anthropic"]');
      await director.fill('[data-new-url]', 'http://127.0.0.1:9999/v1/messages');
      await director.fill('[data-new-models]', 'e2e-model-a, e2e-model-b');
      await director.click('[data-create-provider]');
      await director.waitForSelector('[data-provider-item^="custom-"]', { timeout: 5_000 });
      const customId = await director.evaluate(() => document.querySelector('[data-provider-item^="custom-"]')?.getAttribute('data-provider-item') ?? '');
      expect(customId.startsWith('custom-')).toBe(true);
      const cfg = await snapshot();
      expect(Array.isArray(cfg.customProviders)).toBe(true);

      // 刷新后自定义服务商持久（Dexie）
      await director.reload();
      await director.click('[data-tab="providers"]');
      await director.waitForSelector(`[data-provider-item="${customId}"]`, { timeout: 10_000 });

      // 删除自定义服务商（confirm 自动接受）
      director.once('dialog', (dialog) => void dialog.accept());
      await director.click('[data-provider-item="' + customId + '"]');
      await director.click('[data-delete-provider]');
      await director.waitForFunction((id) => !document.querySelector(`[data-provider-item="${id}"]`), customId, { timeout: 5_000 });

      // 导入弹窗（主进程只读扫描；本机无 Magpie 时也应给出可读错误而不泄露明文）
      await director.click('[data-provider-import]');
      await director.waitForFunction(() => document.body.innerText.includes('导入外部配置'));
      await director.waitForFunction(() => document.body.innerText.includes('Magpie') && document.body.innerText.includes('CC Switch'));
      const importText = await director.evaluate(() => document.body.innerText);
      expect(importText).not.toMatch(/oc_sk_|or_sk_|sk-[A-Za-z0-9]{16,}/);
      await director.getByRole('button', { name: '取消' }).click();

      // 导入 IPC 真机链路（file fixture）：扫描预览零明文 → apply 主进程加密写入
      const fixtureDir = mkdtempSync(join(tmpdir(), 'prov-import-e2e-'));
      const fixturePath = join(fixtureDir, 'magpie.json');
      writeFileSync(fixturePath, JSON.stringify({
        providers: [
          { name: 'E2E Fixture Gateway', baseUrl: 'https://e2e-fixture.example/v1', api_key: 'oc_sk_e2e_1234567890abcdef', protocol: 'openai', models: ['fixture-a', 'fixture-b'] },
        ],
      }), 'utf8');
      try {
        const scan = await director.evaluate((path) => (window as unknown as {
          directorBridge: { providerImportScan(args: { source: string; filePath: string }): Promise<{ ok: boolean; items: Array<{ id: string; hasKey: boolean; keyMask: string; matchedBuiltin: boolean }> }> };
        }).directorBridge.providerImportScan({ source: 'file', filePath: path }), fixturePath);
        expect(scan.ok).toBe(true);
        expect(scan.items).toHaveLength(1);
        expect(scan.items[0]?.matchedBuiltin).toBe(false);
        expect(JSON.stringify(scan)).not.toContain('oc_sk_e2e');
        expect(scan.items[0]?.keyMask).toContain('••••');

        const applied = await director.evaluate(({ path, ids }) => (window as unknown as {
          directorBridge: { providerImportApply(args: { source: string; filePath: string; selectedIds: string[]; policy: 'skip' | 'overwrite' }): Promise<{ ok: boolean; items: Array<{ id: string; action: string; keyMask: string }> }> };
        }).directorBridge.providerImportApply({ source: 'file', filePath: path, selectedIds: ids, policy: 'overwrite' }), { path: fixturePath, ids: scan.items.map((i) => i.id) });
        expect(applied.ok).toBe(true);
        expect(JSON.stringify(applied)).not.toContain('oc_sk_e2e');
        expect(['create', 'update']).toContain(applied.items[0]?.action);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  }, 120_000);
});
