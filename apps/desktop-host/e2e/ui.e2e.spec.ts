import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
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
      // Electron 45 新二进制会让 macOS 弹「Safe Storage」钥匙串授权框并阻塞启动；
      // 测试用 mock keychain 隔离（CI 同理）。
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
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

      // 旧独立游戏路由迁移到聚合页，并保留原先选中的游戏。
      await director.evaluate(() => {
        localStorage.setItem('wb-tab', 'terraria');
        localStorage.removeItem('wb-game');
        localStorage.removeItem('wb-game-subtab');
      });
      await director.reload();
      await director.waitForFunction(() => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot), { timeout: 20_000 });
      await director.waitForFunction(() => document.querySelector('[data-game-panel]')?.getAttribute('data-active-game') === 'terraria', { timeout: 5_000 });
      expect(await director.locator('[data-tab="stardew"]').innerText()).toContain('游戏共玩');
      expect(await director.locator('[data-tab="terraria"]').count()).toBe(0);
      expect(await director.locator('[data-tab="dst"]').count()).toBe(0);
      expect(await director.locator('[data-tab="mods"]').count()).toBe(0);
      expect(await director.locator('[data-game-select]').count()).toBe(3);

      // 旧 Mod 管理路由迁移为聚合页子视图。
      await director.evaluate(() => {
        localStorage.setItem('wb-tab', 'mods');
        localStorage.removeItem('wb-game-subtab');
      });
      await director.reload();
      await director.waitForFunction(() => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot), { timeout: 20_000 });
      await director.waitForSelector('[data-mods-page]', { timeout: 5_000 });
      expect(await director.locator('[data-tab="stardew"]').getAttribute('data-active')).toBe('true');
      expect(await director.locator('[data-game-panel]').getAttribute('data-active-subtab')).toBe('mods');

      // 游戏页与顶栏互相同步，Mod 管理保留为星露谷子页。
      await director.click('[data-game-select="terraria"]');
      expect(await director.locator('[data-game-picker]').getAttribute('data-active-game')).toBe('terraria');
      await director.click('[data-game-picker]');
      await director.click('[data-game-option="dst"]');
      expect(await director.locator('[data-game-panel]').getAttribute('data-active-game')).toBe('dst');
      await director.click('[data-game-select="stardew"]');
      await director.click('[data-game-subtab="mods"]');
      expect(await director.locator('[data-mods-page]').count()).toBe(1);
      await director.click('[data-game-subtab="monitor"]');

      // 品牌区角色选择与舞台页共用同一份活动状态。先归位默认角色，隔离上一用例 profile。
      await director.evaluate(() => (window as unknown as { directorBridge: { characterSelect(id: string): Promise<unknown> } }).directorBridge.characterSelect('blue-whale-maid'));
      await director.waitForTimeout(150);
      await director.click('[data-character-switch]');
      await director.waitForSelector('[data-character-option]', { timeout: 5_000 });
      const characterIds = await director.locator('[data-character-option]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-character-option') ?? ''));
      expect(characterIds.length).toBeGreaterThan(0);
      const selectedCharacterId = await director.locator('[data-character-option][aria-checked="true"]').getAttribute('data-character-option');
      const nextCharacterId = characterIds.find((id) => id !== selectedCharacterId) ?? characterIds[0]!;
      const nextCharacterName = (await director.locator(`[data-character-option="${nextCharacterId}"] span`).first().innerText()).trim();
      await director.click(`[data-character-option="${nextCharacterId}"]`);
      await waitFor(director, async () => (await director.locator('[data-character-switch]').innerText()).includes(nextCharacterName), 8_000);
      await director.click('[data-tab="pet"]');
      await director.waitForSelector(`[data-character="${nextCharacterId}"]`, { timeout: 5_000 });
      await waitFor(director, async () => (await director.locator(`[data-character="${nextCharacterId}"]`).getAttribute('aria-pressed')) === 'true', 8_000);

      // 主脑回落提示使用琥珀色语义状态，并将用户带到服务商页。
      await director.evaluate(() => window.dispatchEvent(new CustomEvent('wb:brain', {
        detail: { mode: 'rule', llmReady: false, mainModelId: 'deepseek/deepseek-chat' },
      })));
      await director.waitForFunction(() => {
        const brain = document.querySelector('[data-brain-toggle]');
        return brain?.getAttribute('data-brain-fallback') === 'true'
          && brain.getAttribute('data-brain-model') === 'deepseek/deepseek-chat';
      }, { timeout: 5_000 });
      await director.click('[data-brain-toggle]');
      await director.waitForFunction(() => document.querySelector('[data-tab="providers"]')?.getAttribute('data-active') === 'true', { timeout: 5_000 });

      // 深浅主题的三级文字与绿色状态文字都达到 WCAG AA 小字对比度。
      const readThemeContrast = async () => director.evaluate(() => {
        const parse = (value: string): number[] => {
          const hex = /^#([\da-f]{6})$/i.exec(value.trim())?.[1];
          if (hex === undefined) return [0, 0, 0];
          return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
        };
        const luminance = (value: string): number => parse(value).map((channel) => channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
        const contrast = (foreground: string, background: string): number => {
          const a = luminance(foreground);
          const b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const css = getComputedStyle(document.documentElement);
        const surface = css.getPropertyValue('--surface-solid');
        return {
          isDark: document.documentElement.classList.contains('dark'),
          tertiary: contrast(css.getPropertyValue('--text-3'), surface),
          green: contrast(css.getPropertyValue('--green'), surface),
        };
      });

      // 急停横幅与「急停 F8」按钮：按实际计算色（含半透明叠层）校验 ≥4.5:1。
      const readHaltContrast = async () => director.evaluate(() => {
        const parseColor = (value: string): [number, number, number, number] => {
          const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
          if (match === null) return [0, 0, 0, 1];
          const parts = (match[1] ?? '').split(',').map((part) => Number.parseFloat(part.trim()));
          return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
        };
        const composite = (foreground: readonly number[], background: readonly number[]): number[] => {
          const alpha = foreground[3] ?? 1;
          return [0, 1, 2].map((index) => (foreground[index] ?? 0) * alpha + (background[index] ?? 0) * (1 - alpha));
        };
        const effectiveBackground = (element: Element): number[] => {
          const layers: number[][] = [];
          let node: Element | null = element;
          while (node !== null) {
            const color = parseColor(getComputedStyle(node).backgroundColor);
            if ((color[3] ?? 1) > 0) layers.push(color);
            if ((color[3] ?? 1) >= 1) break;
            node = node.parentElement;
          }
          let resolved = [255, 255, 255];
          for (let index = layers.length - 1; index >= 0; index -= 1) {
            const layer = layers[index];
            if (layer !== undefined) resolved = composite(layer, resolved);
          }
          return resolved;
        };
        const linear = (channel: number): number => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (color: readonly number[]): number =>
          0.2126 * linear(color[0] ?? 0) + 0.7152 * linear(color[1] ?? 0) + 0.0722 * linear(color[2] ?? 0);
        const contrast = (element: Element, backgroundElement: Element = element): number => {
          const foreground = parseColor(getComputedStyle(element).color);
          const background = effectiveBackground(backgroundElement);
          const first = luminance(foreground);
          const second = luminance(background);
          return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        };
        const stop = document.querySelector('.btn-stop');
        const halted = document.querySelector('.wb-hud.is-halted');
        const haltCopy = document.querySelector('.wb-halt-copy');
        const resume = document.querySelector('[data-v2-hud-resume]');
        const kbd = stop?.querySelector('.kbd');
        return {
          stop: stop === null ? 0 : contrast(stop),
          stopKbd: stop === null || kbd === null ? 0 : contrast(kbd, stop),
          halted: halted === null || haltCopy === null ? 0 : contrast(haltCopy, halted),
          resume: resume === null ? 0 : contrast(resume),
        };
      });
      const assertHaltContrast = async (): Promise<void> => {
        const normal = await readHaltContrast();
        expect(normal.stop).toBeGreaterThanOrEqual(4.5);
        expect(normal.stopKbd).toBeGreaterThanOrEqual(4.5);
        await director.click('[data-v2-hud-halt]');
        await director.waitForSelector('.wb-hud.is-halted', { timeout: 5_000 });
        const halted = await readHaltContrast();
        expect(halted.halted).toBeGreaterThanOrEqual(4.5);
        expect(halted.resume).toBeGreaterThanOrEqual(4.5);
        await director.click('[data-v2-hud-resume]');
        await director.waitForSelector('[data-v2-hud-halt]', { timeout: 5_000 });
      };

      const firstTheme = await readThemeContrast();
      expect(firstTheme.tertiary).toBeGreaterThanOrEqual(4.5);
      expect(firstTheme.green).toBeGreaterThanOrEqual(4.5);
      await assertHaltContrast();
      await director.click('[data-theme-toggle]');
      await director.waitForFunction((wasDark) => document.documentElement.classList.contains('dark') !== wasDark, firstTheme.isDark, { timeout: 5_000 });
      const secondTheme = await readThemeContrast();
      expect(secondTheme.tertiary).toBeGreaterThanOrEqual(4.5);
      expect(secondTheme.green).toBeGreaterThanOrEqual(4.5);
      await assertHaltContrast();
      await director.click('[data-theme-toggle]');
      await director.waitForFunction((wasDark) => document.documentElement.classList.contains('dark') === wasDark, firstTheme.isDark, { timeout: 5_000 });

      await director.click('[data-tab="providers"]');
      // 全量并行 47 workers 下 Electron 冷启动 + 渲染可达 ~11s（单跑实测），给足 30s 避免负载抖动
      await director.waitForSelector('[data-provider-item="opencode-go"]', { timeout: 30_000 });

      // 双 Tab：服务商配置 / 默认模型（M7 起 8 槽位：新增泰拉瑞亚/DST 两个规划器）
      expect(await director.locator('[data-ptab]').count()).toBe(2);
      await director.click('[data-ptab="defaults"]');
      await director.waitForSelector('[data-slot-select="MAIN_PERSONA_BRAIN"]', { timeout: 5_000 });
      expect(await director.locator('[data-slot-select]').count()).toBe(8);
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

  /**
   * [E2E-HOST] T-M6-25：三游戏共玩页统一与连接引导。
   *   ① 三游戏各自渲染连接引导条（连接状态取自主进程只读探活，未连通时给人类可执行的启动指引）
   *   ② 「重新探测」按钮真实往返主进程 IPC，结果如实刷新
   *   ③ 高级诊断默认折叠；三游戏共用当前动作/回执/快捷指令区块
   */
  it('三游戏连接引导 + 重新探测 + 折叠诊断', { timeout: 120_000 }, async () => {
    const app = await electron.launch({
      // Electron 45 新二进制会让 macOS 弹「Safe Storage」钥匙串授权框并阻塞启动；
      // 测试用 mock keychain 隔离（CI 同理）。
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const stageWin = await waitForWindow(app, 'pet-stage');
      await waitFor(
        stageWin,
        () => stageWin.evaluate(() => Boolean((window as unknown as PetStageWindow).__petStageReady)),
        20_000,
      );
      const director = app.windows().find((candidate) => candidate.url().includes('director'));
      expect(director).toBeDefined();
      const page = director!;
      await page.waitForFunction(() => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot), { timeout: 20_000 });

      await page.evaluate(() => {
        localStorage.setItem('wb-tab', 'stardew');
        localStorage.setItem('wb-game', 'stardew');
        localStorage.setItem('wb-game-subtab', 'monitor');
      });
      await page.reload();
      await page.waitForFunction(() => Boolean((window as unknown as { __directorSnapshot?: () => Promise<unknown> }).__directorSnapshot), { timeout: 20_000 });
      await page.waitForSelector('[data-game-panel][data-active-game="stardew"]', { timeout: 10_000 });

      // ① 星露谷：连接引导条（真机未开游戏 → offline；真开了则 online，断言不依赖具体态）
      const conn = page.locator('[data-game-conn-banner]');
      await conn.waitFor({ timeout: 15_000 });
      // 首次探测是异步的：等属性从 unknown 落到真实三态之一，避免读得太早导致偶发失败
      await expect.poll(async () => conn.getAttribute('data-game-conn'), { timeout: 15_000 })
        .toMatch(/^(online|reachable|offline)$/);
      const stardewConn = await conn.getAttribute('data-game-conn');
      expect(await page.locator('[data-game-reprobe]').count()).toBe(1);
      if (stardewConn !== 'online') {
        expect(await page.locator('[data-game-conn-banner] ol li').count()).toBeGreaterThan(0);
      }
      // 共用区块：当前动作 / 回执时间线 / 快捷指令
      expect(await page.locator('[data-game-quick="/fish 5"]').count()).toBe(1);
      expect(await page.locator('text=执行记录与回执').count()).toBe(1);
      // T-M6-35：自治质量卡由真实回执派生（空集显示 —，不伪造 0%/100%）
      expect(await page.locator('text=自治质量（本会话）').count()).toBeGreaterThan(0);

      // ② 高级诊断默认折叠，点击后展开
      const diag = page.locator('[data-game-diagnostics]');
      await diag.waitFor({ timeout: 10_000 });
      expect(await diag.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
      await diag.locator('summary').click();
      expect(await diag.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(true);

      // ③ 重新探测：真实走主进程 IPC，状态如实刷新（不伪造「已连接」）
      const probe = await page.evaluate(() => (window as unknown as {
        directorBridge: { gameHealth(gameId: string): Promise<{ status: string; ok: boolean; guidance: string[]; detail: string }> };
      }).directorBridge.gameHealth('stardew'));
      expect(['online', 'reachable', 'offline']).toContain(probe.status);
      expect(Array.isArray(probe.guidance)).toBe(true);
      await page.click('[data-game-reprobe]');
      await page.waitForTimeout(500);
      expect(['online', 'reachable', 'offline']).toContain(await page.locator('[data-game-conn-banner]').getAttribute('data-game-conn'));

      // ④ 泰拉瑞亚 / DST：同一套区块与引导条
      await page.click('[data-game-select="terraria"]');
      await page.waitForSelector('[data-game-panel][data-active-game="terraria"]', { timeout: 10_000 });
      await page.waitForSelector('[data-game-quick="mine"]', { timeout: 10_000 });
      expect(await page.locator('[data-game-conn-banner]').count()).toBe(1);
      expect(await page.locator('[data-game-diagnostics]').count()).toBe(1);

      await page.click('[data-game-select="dst"]');
      await page.waitForSelector('[data-game-panel][data-active-game="dst"]', { timeout: 10_000 });
      await page.waitForSelector('[data-game-quick="eat"]', { timeout: 10_000 });
      const dstText = await page.locator('[data-game-conn-banner]').innerText();
      expect(dstText).toContain('饥荒');
      // DST 状态快照 IPC：未开 sidecar 时如实失败，不返回假快照
      const dstState = await page.evaluate(() => (window as unknown as {
        directorBridge: { gameDstState(): Promise<{ ok: boolean; snapshot?: unknown; error?: string }> };
      }).directorBridge.gameDstState());
      expect(typeof dstState.ok).toBe('boolean');
      if (!dstState.ok) expect(dstState.error).toBeTruthy();

      // T-M6-33：顶栏如实展示实际语音后端（mcode / say / 未适配）
      const voiceBackend = await page.locator('[data-voice-toggle]').getAttribute('data-voice-backend');
      expect(['mcode', 'say', 'unsupported']).toContain(voiceBackend);

      mkdirSync(artifactsDir, { recursive: true });
      await page.screenshot({ path: join(artifactsDir, 'game-panel-connection.png') });
    } finally {
      await app.close();
    }
  }, 120_000);

  /**
   * [E2E-HOST] T-M6-27：会话归属。
   *   ① autodrive:status 必须带 sessionId + generation（渲染层据此过滤迟到/异会话事件）
   *   ② 携带过期 sessionId 的 P0 指令被主进程拒绝（不误发到新游戏）
   *   ③ 省略 sessionId 的旧调用保持兼容
   */
  it('会话归属：状态带会话标识 + 过期指令被拒绝', { timeout: 90_000 }, async () => {
    const app = await electron.launch({
      // Electron 45 新二进制会让 macOS 弹「Safe Storage」钥匙串授权框并阻塞启动；
      // 测试用 mock keychain 隔离（CI 同理）。
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      // 只依赖 preload 桥（不等 React/Dexie 启动），避免与并行 Electron 实例抢 e2e-profile
      const page = await waitForWindow(app, 'director', 40_000);
      await page.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: { autodriveStatus?: unknown } }).directorBridge?.autodriveStatus),
        { timeout: 30_000 },
      );

      const status = await page.evaluate(() => (window as unknown as {
        directorBridge: {
          autodriveStatus(): Promise<{ running: boolean; gameId?: string; sessionId?: string; generation?: number; events?: unknown[] }>;
        };
      }).directorBridge.autodriveStatus());
      expect(typeof status.sessionId).toBe('string');
      expect((status.sessionId ?? '').length).toBeGreaterThan(0);
      expect(typeof status.generation).toBe('number');

      // 过期会话：必须拒绝，且错误信息说明会话已切换
      const stale = await page.evaluate(() => (window as unknown as {
        directorBridge: { autodriveDirective(tool: string, args: Record<string, unknown>, intent: string, expectedSessionId?: string): Promise<{ ok: boolean; error?: string }> };
      }).directorBridge.autodriveDirective('fish', {}, 'stale directive', '00000000-0000-4000-8000-000000000000'));
      expect(stale.ok).toBe(false);
      expect(stale.error ?? '').toContain('会话已切换');

      // 兼容：不带 sessionId 的旧调用仍接受（入队等待自动驾驶循环消费）
      const compat = await page.evaluate(() => (window as unknown as {
        directorBridge: { autodriveDirective(tool: string, args: Record<string, unknown>, intent: string, expectedSessionId?: string): Promise<{ ok: boolean; error?: string }> };
      }).directorBridge.autodriveDirective('wait', { seconds: 1 }, 'compat directive'));
      expect(compat.ok).toBe(true);
    } finally {
      await app.close();
    }
  }, 90_000);

  /**
   * [E2E-HOST] T-M6-34：OBS 只读透明挂件 `/obs`。
   * 真实 Electron 内嵌 WebUI 上：无 token 401、有 token 200、声明 STAGE_PROTOCOL=1、
   * 页面不含任何写入口（只读）。
   */
  it('OBS /obs 只读挂件：鉴权 + STAGE_PROTOCOL', { timeout: 90_000 }, async () => {
    const app = await electron.launch({
      // Electron 45 新二进制会让 macOS 弹「Safe Storage」钥匙串授权框并阻塞启动；
      // 测试用 mock keychain 隔离（CI 同理）。
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const page = await waitForWindow(app, 'director', 40_000);
      await page.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: { webuiInfo?: unknown } }).directorBridge?.webuiInfo),
        { timeout: 30_000 },
      );
      const info = await page.evaluate(() => (window as unknown as {
        directorBridge: { webuiInfo(): Promise<{ ok: boolean; port: number; token: string }> };
      }).directorBridge.webuiInfo());
      expect(info.ok).toBe(true);

      const denied = await fetch(`http://127.0.0.1:${info.port}/obs`);
      expect(denied.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${info.port}/obs?token=${encodeURIComponent(info.token)}`);
      expect(ok.status).toBe(200);
      const html = await ok.text();
      expect(html).toContain('data-stage-protocol="1"');
      expect(html).toContain('name="obs-readonly" content="1"');
      expect(html).not.toContain('/api/command');
    } finally {
      await app.close();
    }
  }, 90_000);

  /**
   * [E2E-HOST] T-M6-31：外部插件生产链路（真实 Electron main 动态 import）。
   * 在 E2E userData 放一个 dsh 形态插件 → 中控台插件页发现/启用/调用工具。
   */
  it('外部插件：发现 → 启用 → 工具调用（ask 审批）', { timeout: 90_000 }, async () => {
    const appData = process.platform === 'darwin'
      ? joinPath(homedir(), 'Library', 'Application Support', 'Whale Isle', 'e2e-profile')
      : joinPath(process.env.APPDATA ?? homedir(), 'Whale Isle', 'e2e-profile');
    const id = `e2ehello${Date.now()}`;
    const pluginDir = joinPath(appData, 'plugins', id);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(joinPath(pluginDir, 'manifest.json'), JSON.stringify({
      id, name: 'E2E Hello Whale', version: '1.0.0', description: '插件生产链路验收', extensions: ['tool'],
    }), 'utf8');
    writeFileSync(joinPath(pluginDir, 'index.mjs'), `
export default {
  name: '${id}',
  apply(ctx) {
    ctx.tool('e2e_ping', (args) => ({ pong: true, who: args?.who ?? 'whale' }));
  },
};
`, 'utf8');

    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const page = await waitForWindow(app, 'director', 40_000);
      await page.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: { pluginList?: unknown } }).directorBridge?.pluginList),
        { timeout: 30_000 },
      );
      await page.click('[data-tab="plugins"]');
      await page.waitForSelector(`[data-external-plugin="${id}"]`, { timeout: 15_000 });

      const row = page.locator(`[data-external-plugin="${id}"]`);
      await row.locator('button[aria-pressed]').click();
      await page.waitForSelector('[data-plugin-tool="e2e_ping"]', { timeout: 15_000 });

      // 工具策略来自 dsh 适配默认 ask：UI 自动走 pluginApprove 后调用
      await page.click('[data-plugin-tool="e2e_ping"]');
      await page.waitForTimeout(800);
      const list = await page.evaluate(() => (window as unknown as {
        directorBridge: { pluginList(): Promise<Array<{ id: string; enabled: boolean; tools: string[] }>> };
      }).directorBridge.pluginList());
      const entry = list.find((p) => p.id === id);
      expect(entry?.enabled).toBe(true);
      expect(entry?.tools).toContain('e2e_ping');
    } finally {
      await app.close();
      rmSync(pluginDir, { recursive: true, force: true });
    }
  }, 90_000);

  /** [E2E-HOST] T-M6-37：直播最小链路（本地回放，经真实 hub 管线）→ OBS 页可见事件。 */
  it('直播回放：护栏/注意力后的事件流出现在 OBS 页', { timeout: 90_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const page = await waitForWindow(app, 'director', 40_000);
      await page.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: { liveReplay?: unknown } }).directorBridge?.liveReplay),
        { timeout: 30_000 },
      );
      await page.click('[data-tab="obs"]');
      await page.waitForSelector('[data-live-panel]', { timeout: 10_000 });
      await page.click('[data-live-replay]');
      await page.waitForSelector('[data-live-event]', { timeout: 15_000 });
      expect(await page.locator('[data-live-event]').count()).toBeGreaterThan(0);
      const snapshot = await page.evaluate(() => (window as unknown as {
        directorBridge: { liveSnapshot(): Promise<{ received: number; accepted: number }> };
      }).directorBridge.liveSnapshot());
      expect(snapshot.received).toBeGreaterThanOrEqual(4);
    } finally {
      await app.close();
    }
  }, 90_000);

  /** [E2E-HOST] T-M6-38/39：独立联机协作页 + agentId 多桌宠窗口开关。 */
  it('联机协作大厅可渲染，且多桌宠窗口按 agentId 独立打开/关闭', { timeout: 90_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const page = await waitForWindow(app, 'director', 40_000);
      await page.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: { coopBlackboardGet?: unknown } }).directorBridge?.coopBlackboardGet),
        { timeout: 30_000 },
      );
      await page.evaluate(() => localStorage.setItem('wb-tab', 'coop'));
      await page.reload();
      await page.waitForSelector('[data-coop-page]', { timeout: 20_000 });
      expect(await page.locator('[data-coop-member="human"]').count()).toBe(1);
      expect(await page.locator('[data-coop-send]').count()).toBe(1);
      await page.evaluate(() => (window as unknown as {
        directorBridge: { coopGoalSet(goal: unknown): Promise<{ ok: boolean }> };
      }).directorBridge.coopGoalSet({
        id: 'e2e-goal', title: 'E2E 建鸡舍', gameId: 'stardew', deadline: '', status: 'active',
        metrics: [{ label: '团队金币', current: 0, target: 4_000, unit: 'g', source: 'team_money' }],
      }));
      await page.waitForFunction(() => document.querySelector('[data-coop-page]')?.textContent?.includes('E2E 建鸡舍'), { timeout: 10_000 });
      expect((await page.locator('[data-coop-page]').innerText())).toContain('0 / 4,000g');
      await page.click('[data-coop-launch-wizard]');
      expect(await page.locator('[data-coop-page]').innerText()).toContain('联机一键启动向导');
      await page.click('[data-pet-pack-store]');
      await page.waitForSelector('[role="dialog"][aria-labelledby="pack-store-title"]', { timeout: 10_000 });
      expect(await page.locator('[role="dialog"]').innerText()).toContain('aboutme-pets 角色包商店');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes('蓝蓝（蓝毛小女仆）'), { timeout: 10_000 });
      await page.getByRole('button', { name: '关闭角色包商店' }).click();
      await page.getByRole('button', { name: '添加 AI 队友' }).click();
      await page.locator('[role="dialog"] select').nth(1).selectOption('terraria');
      expect(await page.locator('[data-coop-endpoint-input]').inputValue()).toBe('http://127.0.0.1:18090');
      await page.getByRole('button', { name: '关闭添加队友' }).click();

      const opened = await page.evaluate(() => (window as unknown as {
        directorBridge: { petWindowOpen(agentId: string, characterId?: string): Promise<{ ok: boolean; error?: string }> };
      }).directorBridge.petWindowOpen('agent-e2e', 'blue-whale-maid'));
      expect(opened, opened.error).toMatchObject({ ok: true });
      const extra = await waitForWindow(app, 'agentId=agent-e2e', 20_000);
      await extra.waitForFunction(() => Boolean((window as unknown as { __petStageReady?: boolean }).__petStageReady), { timeout: 20_000 });
      const list = await page.evaluate(() => (window as unknown as {
        directorBridge: { petWindowList(): Promise<Array<{ agentId: string; characterId: string }>> };
      }).directorBridge.petWindowList());
      expect(list.find((item) => item.agentId === 'agent-e2e')).toMatchObject({ characterId: 'blue-whale-maid' });

      await page.evaluate(() => (window as unknown as {
        directorBridge: { petWindowClose(agentId: string): Promise<{ ok: boolean }> };
      }).directorBridge.petWindowClose('agent-e2e'));
      await waitFor(page, async () => {
        const latest = await page.evaluate(() => (window as unknown as {
          directorBridge: { petWindowList(): Promise<Array<{ agentId: string }>> };
        }).directorBridge.petWindowList());
        return latest.every((item) => item.agentId !== 'agent-e2e');
      }, 10_000);
    } finally {
      await app.close();
    }
  }, 90_000);

  /** [E2E-HOST] T-M6-44/46：aboutme 角色切换后 manifest/舞台/语音中心按当前角色生效。 */
  it('aboutme 角色切换：pets:manifest 与语音中心徽章跟随角色', { timeout: 90_000 }, async () => {
    const charRoot = joinPath(homedir(), 'Library', 'Application Support', 'Whale Isle', 'e2e-profile', 'pet-characters');
    const manifestDir = joinPath(charRoot, 'e2e');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(joinPath(manifestDir, 'manifest.json'), JSON.stringify({
      petId: 'e2e-sprite', renderer: 'sprite-sheet', licenseScope: 'DEV_ONLY_NON_COMMERCIAL', attribution: 'e2e',
      width: 640, height: 360, defaultAction: 'idle',
      actions: [{ actionState: 'idle', clips: [{ clipId: 'idle', webmPath: 'file:///idle.webp', sprite: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, sampleFps: 12 } }] }],
      ambientPool: [],
    }));
    writeFileSync(joinPath(charRoot, 'aboutme-e2e.json'), JSON.stringify({
      id: 'aboutme-e2e', displayName: 'E2E小星', manifestPath: joinPath(manifestDir, 'manifest.json'),
      personaPrompt: '你是 E2E 小星。', voiceId: 'diadia_xuemei', voiceRatePercent: 95, voicePitchMul: 1.2,
      packId: 'e2e', actionCount: 1, audioClipCount: 0, anchorRatio: 0.5, licenseScope: 'DEV_ONLY_NON_COMMERCIAL', builtin: false,
    }));
    writeFileSync(joinPath(charRoot, 'aboutme-dsh.json'), JSON.stringify({
      id: 'aboutme-dsh', displayName: '蓝蓝（E2E副窗）', manifestPath: joinPath(manifestDir, 'manifest.json'),
      personaPrompt: '你是 E2E 蓝蓝。', voiceId: 'qiaopi_mengmei', voiceRatePercent: 100, voicePitchMul: 1.2,
      packId: 'dsh-pet', actionCount: 1, audioClipCount: 0, anchorRatio: 0.5, licenseScope: 'DEV_ONLY_NON_COMMERCIAL', builtin: false,
    }));
    const app = await electron.launch({ args: ['--use-mock-keychain', mainEntry], executablePath: electronBinary, env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' } });
    let page: import('playwright-core').Page | undefined;
    try {
      page = await waitForWindow(app, 'director', 40_000);
      await page.waitForFunction(() => Boolean((window as unknown as { directorBridge?: { characterSelect?: unknown } }).directorBridge?.characterSelect), { timeout: 30_000 });
      const selected = await page.evaluate(() => (window as unknown as { directorBridge: { characterSelect(id: string): Promise<{ ok: boolean }> } }).directorBridge.characterSelect('aboutme-e2e'));
      expect(selected.ok).toBe(true);
      const manifest = await page.evaluate(() => (window as unknown as { directorBridge: { petsManifest(): Promise<{ ok: boolean; manifest?: { renderer?: string; petId?: string } }> } }).directorBridge.petsManifest());
      expect(manifest.manifest).toMatchObject({ renderer: 'sprite-sheet', petId: 'e2e-sprite' });
      await page.click('[data-tab="pet"]');
      await page.waitForSelector('[data-stage-renderer="sprite-sheet"]', { timeout: 15_000 });
      await page.evaluate(() => localStorage.setItem('wb-tab', 'voice'));
      await page.reload();
      await page.waitForFunction(() => Boolean((window as unknown as { directorBridge?: { characterList?: unknown } }).directorBridge?.characterList), { timeout: 30_000 });
      await page.evaluate(() => (window as unknown as { directorBridge: { characterSelect(id: string): Promise<{ ok: boolean }> } }).directorBridge.characterSelect('aboutme-e2e'));
      await page.click('[data-voice-tab-btn="studio"]');
      await page.waitForSelector('[data-voice-studio-character]', { timeout: 15_000 });
      expect(await page.locator('[data-voice-studio-character]').getAttribute('data-voice-studio-character')).toBe('aboutme-e2e');
      expect(await page.locator('[data-voice-studio-character]').innerText()).toContain('E2E小星');

      // 副桌宠窗口身份隔离：poke 使用本窗角色，dock/undock 只操作本窗且平滑回位。
      const opened = await page.evaluate(() => (window as unknown as {
        directorBridge: { petWindowOpen(agentId: string, characterId?: string): Promise<{ ok: boolean; error?: string }> };
      }).directorBridge.petWindowOpen('agent-aboutme', 'aboutme-dsh'));
      expect(opened, opened.error).toMatchObject({ ok: true });
      const extra = await waitForWindow(app, 'agentId=agent-aboutme', 20_000);
      await extra.waitForFunction(() => Boolean((window as unknown as { __petStageReady?: boolean }).__petStageReady), { timeout: 20_000 });
      const poke = await extra.evaluate(() => (window as unknown as {
        petStage: { pokeLine(agentId: string): Promise<{ ok: boolean; characterId?: string; line?: string }> };
      }).petStage.pokeLine('agent-aboutme'));
      expect(poke).toMatchObject({ ok: true, characterId: 'aboutme-dsh' });
      expect(poke.line?.length).toBeGreaterThan(4);
      const beforeDock = (await page.evaluate(() => (window as unknown as {
        directorBridge: { petWindowList(): Promise<Array<{ agentId: string; bounds: { x: number } }>> };
      }).directorBridge.petWindowList())).find((item) => item.agentId === 'agent-aboutme')!.bounds;
      await extra.evaluate(() => (window as unknown as { petStage: { dockWindow(agentId: string, edge: 'left' | 'right' | null): Promise<unknown> } }).petStage.dockWindow('agent-aboutme', 'left'));
      await waitFor(page, async () => {
        const list = await page.evaluate(() => (window as unknown as { directorBridge: { petWindowList(): Promise<Array<{ agentId: string; bounds: { x: number } }>> } }).directorBridge.petWindowList());
        return (list.find((item) => item.agentId === 'agent-aboutme')?.bounds.x ?? 0) < beforeDock.x;
      }, 10_000);
      await extra.evaluate(() => (window as unknown as { petStage: { dockWindow(agentId: string, edge: 'left' | 'right' | null): Promise<unknown> } }).petStage.dockWindow('agent-aboutme', null));
      await waitFor(page, async () => {
        const list = await page.evaluate(() => (window as unknown as { directorBridge: { petWindowList(): Promise<Array<{ agentId: string; bounds: { x: number } }>> } }).directorBridge.petWindowList());
        return list.find((item) => item.agentId === 'agent-aboutme')?.bounds.x === beforeDock.x;
      }, 10_000);
    } finally {
      await page?.evaluate(() => (window as unknown as { directorBridge: { characterSelect(id: string): Promise<{ ok: boolean }> } }).directorBridge.characterSelect('blue-whale-maid')).catch(() => undefined);
      await app.close();
      rmSync(joinPath(charRoot, 'aboutme-e2e.json'), { force: true });
      rmSync(joinPath(charRoot, 'aboutme-dsh.json'), { force: true });
      rmSync(manifestDir, { recursive: true, force: true });
    }
  }, 90_000);

  /** [E2E-HOST] V2-P3-03：生命中枢的受控浏览器面板、双租约 HUD 与账号掩码注册。 */
  it('受控 Browser Use 面板：账号掩码注册、桌面租约抢占与 HUD 双租约分离显示', { timeout: 90_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const page = await waitForWindow(app, 'director', 40_000);
      await page.waitForFunction(
        () => Boolean((window as unknown as { directorBridge?: { v2AutoSnapshot?: unknown } }).directorBridge?.v2AutoSnapshot),
        { timeout: 30_000 },
      );
      await page.evaluate(() => localStorage.setItem('wb-tab', 'life'));
      await page.reload();
      await page.waitForSelector('[data-v2-life-console]', { timeout: 30_000 });
      await page.waitForSelector('[data-v2-browser-section]', { timeout: 20_000 });

      // ADR-004：HUD 必须分开展示游戏角色租约与桌面租约
      expect(await page.locator('[data-v2-game-lease]').count()).toBe(1);
      expect(await page.locator('[data-v2-computer-lease]').count()).toBe(1);

      // 账号注册：明文只上行，界面仅显示掩码
      const secret = 'ui-e2e-plain-secret-123456';
      await page.fill('[data-v2-auto-character-input]', 'char_xiaojing');
      await page.fill('[data-v2-auto-platform-input]', 'e2eui');
      await page.fill('[data-v2-auto-username-input]', 'ui-e2e-user');
      await page.fill('[data-v2-auto-secret-input]', secret);
      await page.click('[data-v2-auto-account-register]');
      await page.waitForFunction(
        () => document.querySelector('[data-v2-auto-accounts]')?.textContent?.includes('ui-e2e-user') ?? false,
        { timeout: 20_000 },
      );
      const accountsText = await page.locator('[data-v2-auto-accounts]').innerText();
      expect(accountsText).not.toContain(secret);
      expect(accountsText).toContain('••••');

      // 申请桌面租约 → HUD 显示 AI 独占；模拟用户输入 → 人类优先
      await page.click('[data-v2-auto-lease-acquire]');
      await page.waitForFunction(
        () => document.querySelector('[data-v2-computer-lease]')?.getAttribute('data-v2-computer-lease') === 'ai',
        { timeout: 15_000 },
      );
      await page.click('[data-v2-auto-human-simulate]');
      await page.waitForFunction(
        () => document.querySelector('[data-v2-computer-lease]')?.getAttribute('data-v2-computer-lease') === 'human',
        { timeout: 15_000 },
      );

      // OS 输入执行器默认关闭：dry-run 只记录意图
      await page.click('[data-v2-auto-dry-run]');
      const status = await page.evaluate(() => (window as unknown as {
        directorBridge: { v2AutoInputStatus(): Promise<{ executor: { enabled: boolean }; realOsInputEnabled: boolean }> };
      }).directorBridge.v2AutoInputStatus());
      expect(status.executor.enabled).toBe(false);
      expect(status.realOsInputEnabled).toBe(false);

      // P5 一次性确认令牌可签发
      await page.click('[data-v2-auto-p5-confirm]');
      await page.waitForFunction(
        () => document.querySelector('[data-v2-browser-section]')?.textContent?.includes('1 待用') ?? false,
        { timeout: 15_000 },
      ).catch(() => undefined);
      const after = await page.evaluate(() => (window as unknown as {
        directorBridge: { v2AutoSnapshot(): Promise<{ p5ConfirmationCount: number; accounts: Array<{ username: string; maskedSecret: string }> }> };
      }).directorBridge.v2AutoSnapshot());
      expect(after.p5ConfirmationCount).toBeGreaterThanOrEqual(1);
      expect(after.accounts.find((a) => a.username === 'ui-e2e-user')?.maskedSecret).not.toContain(secret);
    } finally {
      await app.close();
    }
  }, 90_000);
});
