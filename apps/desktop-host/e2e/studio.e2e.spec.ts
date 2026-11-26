import { join as joinPath } from 'node:path';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] 桌宠工坊 / 语音中心 / 跨 AI 跟随（T-M6-46/48/49）。
 * 素材目录存在时断言真实动作数量与卡片渲染；干净 checkout（无 assets/pet-packs）时只断言结构与空态，
 * 绝不伪造「已有 1,040 动作」。
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

async function waitForWindow(app: import('playwright-core').ElectronApplication, urlPart: string, timeoutMs = 40_000): Promise<import('playwright-core').Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未找到包含 ${urlPart} 的窗口`);
}

async function waitFor(win: import('playwright-core').Page, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未满足`);
}

describe('[E2E-HOST] 桌宠工坊与语音中心', () => {
  it('侧栏精简 + 四页签 + 素材目录 + 声线绑定 + 本机驱动口', { timeout: 150_000 }, async () => {
    const app = await electron.launch({ args: ['--use-mock-keychain', mainEntry], executablePath: electronBinary, env: { ...process.env, PET_STAGE_E2E: '1' } });
    let page: import('playwright-core').Page | undefined;
    try {
      page = await waitForWindow(app, 'director');
      await page.waitForFunction(() => Boolean((window as unknown as { directorBridge?: { petStudioCatalog?: unknown } }).directorBridge?.petStudioCatalog), { timeout: 30_000 });

      // 侧栏：Tidepaper v3.1 后的分组导航（无旧「声音工坊与音色库」）
      const navText = await page.locator('aside').first().innerText();
      expect(navText).toContain('桌宠工坊');
      expect(navText).toContain('声音与表演');
      expect(navText).toContain('直播与 OBS');
      expect(navText).toContain('Harness');
      expect(navText).not.toContain('声音工坊与音色库');

      // 素材目录 IPC：9 包元数据恒定；有素材时动作数 ≥ 1000
      const catalog = await page.evaluate(() => (window as unknown as {
        directorBridge: { petStudioCatalog(): Promise<{ packs: unknown[]; actions: unknown[]; slots: unknown[]; skins: unknown[]; fonts: unknown[]; errors: string[] }> };
      }).directorBridge.petStudioCatalog());
      expect(catalog.packs).toHaveLength(9);
      expect(catalog.errors).toEqual([]);
      if (catalog.actions.length > 0) {
        expect(catalog.actions.length).toBeGreaterThanOrEqual(1_000);
        expect(catalog.slots.length).toBeGreaterThanOrEqual(9 * 11);
        expect(catalog.skins.length).toBeGreaterThanOrEqual(30);
        expect(catalog.fonts.length).toBeGreaterThanOrEqual(8);
      }

      // 桌宠工坊：4 页签 + 素材库播放器
      await page.click('[data-tab="pet"]');
      await page.waitForSelector('[data-pet-studio]', { timeout: 15_000 });
      for (const tab of ['stage', 'library', 'social', 'work']) {
        await page.waitForSelector(`[data-pet-studio-tab="${tab}"]`, { timeout: 10_000 });
      }
      await page.click('[data-pet-studio-tab="library"]');
      await page.waitForSelector('[data-pet-library]', { timeout: 15_000 });
      await page.waitForSelector('[data-preview-canvas]', { timeout: 15_000 });
      if (catalog.actions.length > 0) {
        await page.waitForSelector('[data-action-item]', { timeout: 15_000 });
        expect(await page.locator('[data-action-item]').count()).toBeGreaterThan(5);

        // 上游 preview.json 语义：动作库按角色分库，切角色 = 换整套动作 + 自动播该角色 idle
        const claudeCount = catalog.packs.find((pack) => pack.slug === 'claude')?.actionCount ?? 0;
        const dshCount = catalog.packs.find((pack) => pack.slug === 'dsh')?.actionCount ?? 0;
        expect(claudeCount).toBe(166);
        expect(dshCount).toBe(101);
        await page.click('[data-character-chip="aboutme-claude"]');
        await page.waitForFunction((expected) => {
          const node = document.querySelector('[data-action-count]');
          return node?.getAttribute('data-action-count') === String(expected)
            && document.querySelector('[data-pet-library]')?.getAttribute('data-action-scope') === 'character';
        }, claudeCount, { timeout: 20_000 });
        expect(await page.locator('[data-action-item]').count()).toBe(claudeCount);
        const packsInView = await page.locator('[data-action-item]').evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute('data-action-pack')))]);
        expect(packsInView).toEqual(['claude']);
        expect(await page.locator('[data-action-category]').count()).toBeGreaterThanOrEqual(15);
        expect(await page.locator('[data-frame-label]').innerText()).toContain('/');
        // 只允许把「当前角色自己的动作」推给桌面（桌面主宠显示全局选中角色）
        expect(await page.locator('[data-push-preview]').getAttribute('data-push-enabled')).toBe('true');

        await page.click('[data-character-chip="aboutme-dsh"]');
        await page.waitForFunction((expected) => document.querySelector('[data-action-count]')?.getAttribute('data-action-count') === String(expected), dshCount, { timeout: 20_000 });
        expect(await page.locator('[data-action-item]').count()).toBe(dshCount);
        // 全部 9 包仍然可切回（但不在默认视图里混角色动作）
        await page.click('[data-action-scope-btn="all"]');
        await page.waitForFunction(() => document.querySelector('[data-pet-library]')?.getAttribute('data-action-scope') === 'all', undefined, { timeout: 15_000 });
        expect(await page.locator('[data-push-preview]').getAttribute('data-push-enabled')).toBe('false');
        await page.click('[data-character-chip="blue-whale-maid"]');
      }

      // 小本子：真实 SQLite 视图（空态也是真实空态）
      await page.click('[data-pet-studio-tab="social"]');
      await page.waitForSelector('[data-notebook-panel]', { timeout: 15_000 });
      await page.fill('[data-notebook-input]', 'E2E 留言：今天也要一起加油');
      const noteResult = await page.evaluate(() => (window as unknown as {
        directorBridge: { friendNoteAdd(id: string, text: string): Promise<{ ok: boolean }>; friendNotebook(id: string): Promise<{ notes: Array<{ text: string }> }> };
      }).directorBridge.friendNoteAdd('blue-whale-maid', 'E2E 留言：今天也要一起加油'));
      expect(noteResult.ok).toBe(true);
      const notebook = await page.evaluate(() => (window as unknown as {
        directorBridge: { friendNotebook(id: string): Promise<{ notes: Array<{ text: string }> }> };
      }).directorBridge.friendNotebook('blue-whale-maid'));
      expect(notebook.notes[0]?.text).toContain('E2E 留言');

      // 跨 AI 跟随：注入演示会话 → 8 次工具 → 皇冠
      await page.click('[data-pet-studio-tab="work"]');
      await page.waitForSelector('[data-work-follow-panel]', { timeout: 15_000 });
      await page.click('[data-follow-demo]');
      await waitFor(page, async () => {
        const text = await page!.locator('[data-follow-sessions]').innerText();
        return text.includes('Claude Code') && text.includes('8 次工具');
      }, 15_000);
      expect(await page.locator('[data-follow-sessions]').innerText()).toContain('Claude Code');

      // 对外本机驱动口：真实 GET state（token 来自 webui:info）
      const apiState = await page.evaluate(async () => {
        const bridge = (window as unknown as { directorBridge: { webuiInfo(): Promise<{ ok: boolean; port: number; token: string }> } }).directorBridge;
        const info = await bridge.webuiInfo();
        const response = await fetch(`http://127.0.0.1:${info.port}/api/pet/default/state`, { headers: { Authorization: `Bearer ${info.token}` } });
        return { status: response.status, body: await response.json() as { ok: boolean; state?: { characterId: string } } };
      });
      expect(apiState.status).toBe(200);
      expect(apiState.body.state?.characterId).toBeTruthy();
      const unauthorized = await page.evaluate(async () => {
        const bridge = (window as unknown as { directorBridge: { webuiInfo(): Promise<{ port: number }> } }).directorBridge;
        const info = await bridge.webuiInfo();
        const response = await fetch(`http://127.0.0.1:${info.port}/api/pet/default/state`);
        return response.status;
      });
      expect(unauthorized).toBe(401);

      // 创作中心：三页签 + 实时提示词编译器（不伪造出图）
      await page.locator('[data-open-creator]').first().click();
      await page.waitForSelector('[data-creator-center]', { timeout: 15_000 });
      await page.waitForFunction(() => (document.querySelector('[data-char-prompt]')?.textContent ?? '').includes('[FORMAT RULES]'), undefined, { timeout: 15_000 });
      const charPrompt = await page.locator('[data-char-prompt]').innerText();
      expect(charPrompt).toContain('[POSES (A+MEME)]');
      expect(charPrompt).toContain('idle-blink');
      await page.click('[data-creator-tab="egg"]');
      await page.waitForFunction(() => (document.querySelector('[data-egg-prompt]')?.textContent ?? '').includes('[EGG MODE'), undefined, { timeout: 15_000 });
      expect(await page.locator('[data-egg-prompt]').innerText()).toContain('- caught:');
      await page.locator('[data-creator-center] button[aria-label="关闭创作中心"]').click();

      // 验收台：12 场景 + 单个演练 + 脱敏报告
      await page.locator('[data-open-bench]').first().click();
      await page.waitForSelector('[data-acceptance-bench]', { timeout: 15_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-bench-scenario]').length === 12, undefined, { timeout: 15_000 });
      await page.click('[data-bench-scenario="compact"]');
      await page.waitForFunction(() => (document.querySelector('[data-bench-grid]')?.textContent ?? '').includes('压缩上下文 compact') && (document.querySelector('[data-bench-grid]')?.textContent ?? '').includes('通过'), undefined, { timeout: 20_000 });
      const report = await page.evaluate(() => (window as unknown as { directorBridge: { acceptanceReport(): Promise<{ ok: boolean; markdown?: string }> } }).directorBridge.acceptanceReport());
      expect(report.ok).toBe(true);
      expect(report.markdown).toContain('姿态与场景验收报告');
      expect(report.markdown).not.toContain('/Users/');
      expect(report.markdown).not.toContain('sk-');
      await page.locator('[data-acceptance-bench] button[aria-label="关闭验收台"]').click();

      // 桌宠 Option/Alt + 右键直达验收台
      const petWindow = await waitForWindow(app, 'pet-stage', 20_000);
      await petWindow.waitForFunction(() => Boolean((window as unknown as { __petStageReady?: boolean }).__petStageReady), { timeout: 20_000 });
      await petWindow.evaluate(() => {
        document.getElementById('stage')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, altKey: true, clientX: 100, clientY: 100 }));
      });
      await page.waitForSelector('[data-acceptance-bench]', { timeout: 15_000 });
      await page.locator('[data-acceptance-bench] button[aria-label="关闭验收台"]').click();

      // 语音中心：9 角色声线绑定条 + 两张状态卡 + 高阶精调页签
      await page.click('[data-tab="voice"]');
      await page.waitForSelector('[data-voice-center]', { timeout: 15_000 });
      expect(await page.locator('[data-voice-char]').count()).toBeGreaterThanOrEqual(10);
      await page.waitForSelector('[data-voice-center] [data-voice-backend]', { timeout: 15_000 });
      const backend = await page.locator('[data-voice-center] [data-voice-backend]').first().getAttribute('data-voice-backend');
      expect(['mcode', 'say', 'unsupported', 'unknown']).toContain(backend);
      await page.click('[data-voice-tab-btn="studio"]');
      await page.waitForSelector('[data-voice-studio-character]', { timeout: 15_000 });
      expect(await page.locator('[data-voice-studio-character]').innerText()).toContain('小鲸');

      // 语音绑定：把「蓝蓝」改绑到嗲嗲学妹并读回（落 userData/voice-bindings.json）
      const bind = await page.evaluate(() => (window as unknown as {
        directorBridge: { voiceCharacterBind(id: string, voiceId: string): Promise<{ ok: boolean }>; voiceCharacterBindings(): Promise<Array<{ characterId: string; voiceId: string; overridden: boolean }>> };
      }).directorBridge.voiceCharacterBind('aboutme-dsh', 'diadia_xuemei'));
      expect(bind.ok).toBe(true);
      const bindings = await page.evaluate(() => (window as unknown as { directorBridge: { voiceCharacterBindings(): Promise<Array<{ characterId: string; voiceId: string; overridden: boolean }>> } }).directorBridge.voiceCharacterBindings());
      expect(bindings.find((item) => item.characterId === 'aboutme-dsh')).toMatchObject({ voiceId: 'diadia_xuemei', overridden: true });
    } finally {
      await page?.evaluate(() => (window as unknown as { directorBridge: { voiceCharacterBind(id: string, voiceId: string): Promise<unknown> } }).directorBridge.voiceCharacterBind('aboutme-dsh', 'qiaopi_mengmei')).catch(() => undefined);
      await app.close();
    }
  });
});
