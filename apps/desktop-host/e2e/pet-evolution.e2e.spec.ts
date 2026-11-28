import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] T-M6-63/64/65 桌宠深度体验：
 *   ① 随包 crosspet-claude 的真实 pose-config（无素材时诚实为空，不伪造）
 *   ② 气泡字体声明包含 ShangShouGummy
 *   ③ windowLayer / bubbleFontScale 持久化并真实作用到窗口与 CSS 变量
 *   ④ 小本子双页切换 + 8 套手写体注入
 *   ⑤ 彩蛋小剧场可打开、抓包收口且不留僵尸窗
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const hasPacks = existsSync(join(repoRoot, 'assets', 'pet-packs', 'crosspet', 'characters', 'claude', 'character.json'));

interface PetStageBridge {
  prefsGet(): Promise<{ windowLayer: string; bubbleFontScale: number | null; notebookFontId: string }>;
  prefsSet(update: Record<string, unknown>): Promise<unknown>;
  customPoseConfig(characterId: string): Promise<{ ok: boolean; correctedPose?: string; fx?: Record<string, string>; lines?: Record<string, string[]>; pokePose?: string }>;
  petEggTheater(): Promise<{ ok: boolean; agentId?: string; error?: string }>;
  eggCatch(): Promise<{ ok: boolean; caught?: boolean; error?: string }>;
}

async function waitFor(app: unknown, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未满足`);
}

async function waitForWindow(app: import('playwright-core').ElectronApplication, urlPart: string, timeoutMs = 25_000): Promise<import('playwright-core').Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未找到包含 ${urlPart} 的窗口`);
}

describe('[E2E-HOST] 桌宠深度体验三阶段', () => {
  it('随包姿态/气泡字体/显示层级/小本子双页/彩蛋小剧场', { timeout: 150_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      console.log('[pet-evolution-e2e] launched');
      const stage = await waitForWindow(app, 'pet-stage');
      console.log('[pet-evolution-e2e] stage window found');
      await waitFor(stage, () => stage.evaluate(() => Boolean((window as unknown as { __petStageReady?: boolean }).__petStageReady)), 20_000);
      console.log('[pet-evolution-e2e] stage ready');

      // ① 随包角色 pose-config：有素材时必须是真实扩展字段；干净 checkout 如实 ok:false
      const pose = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.customPoseConfig('crosspet-claude'));
      if (hasPacks) {
        expect(pose.ok).toBe(true);
        expect(pose.correctedPose).toBe('sorry');
        expect(pose.fx?.proud).toBe('victory');
        expect(Object.keys(pose.lines ?? {}).length).toBeGreaterThan(5);
      } else {
        expect(pose.ok).toBe(false);
      }
      console.log('[pet-evolution-e2e] pose config ok');

      // ② 气泡字体声明包含上首软糖体（字体未加载也必须有回退链）
      await stage.evaluate(() => {
        (window as unknown as { __petStageTest?: { showBubbles(input: { thought: string; dialog: string }): void } }).__petStageTest?.showBubbles({ thought: '在心里盘算', dialog: '气泡字体测试' });
      });
      const fontFamily = await stage.evaluate(() => {
        const node = document.querySelector('.pet-bubble--dialog');
        return node === null ? '' : getComputedStyle(node).fontFamily;
      });
      expect(fontFamily).toContain('ShangShouGummy');
      console.log('[pet-evolution-e2e] bubble font ok');

      // 真实 Chromium 侧翼布局：单页逐字增长、外框稳定；这里只测侧翼尺寸，不声称宽度超过 240px。
      await stage.emulateMedia({ reducedMotion: 'no-preference' });
      const reveal = await stage.evaluate(async () => {
        const hooks = (window as unknown as { __petStageTest: {
          hideBubbles(): void;
          showBubble(kind: string, text: string, options?: { ttlMs: number }): void;
        } }).__petStageTest;
        hooks.hideBubbles();
        await document.fonts.ready;
        const full = '今天先整理背包，再去农场照料作物。';
        hooks.showBubble('dialog', full, { ttlMs: 10_000 });
        const node = document.querySelector('.pet-bubble--dialog') as HTMLElement;
        const text = node.querySelector('.pet-bubble__text') as HTMLElement;
        const samples: Array<{ length: number; width: number; height: number }> = [];
        const started = performance.now();
        while (performance.now() - started < 4_000) {
          samples.push({ length: Array.from(text.textContent ?? '').length, width: node.offsetWidth, height: node.offsetHeight });
          if (text.textContent === full) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return { fullLength: Array.from(full).length, text: text.textContent, full, samples };
      });
      expect(reveal.samples[0]!.length).toBeLessThan(reveal.fullLength);
      expect(reveal.text).toBe(reveal.full);
      expect(reveal.samples.some((sample) => sample.length > 1 && sample.length < reveal.fullLength)).toBe(true);
      expect(reveal.samples.every((sample, index) => index === 0 || sample.length >= reveal.samples[index - 1]!.length)).toBe(true);
      expect(new Set(reveal.samples.map((sample) => sample.width)).size).toBe(1);
      expect(new Set(reveal.samples.map((sample) => sample.height)).size).toBe(1);
      expect(reveal.samples[0]!.width).toBeGreaterThan(80);
      await stage.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await stage.evaluate(() => {
        const hooks = (window as unknown as { __petStageTest: { showBubble(kind: string, text: string): void } }).__petStageTest;
        const full = '减少动态效果时直接显示完整气泡文字。';
        hooks.showBubble('dialog', full);
        return { text: document.querySelector('.pet-bubble--dialog .pet-bubble__text')?.textContent, full };
      });
      expect(reduced.text).toBe(reduced.full);
      await stage.emulateMedia({ reducedMotion: 'no-preference' });
      console.log('[pet-evolution-e2e] typewriter and stable bubble geometry ok');

      // 多页以真实 DOM 整行容量为准，普通 TTL 和 reduced-motion 都不能漏掉后页。
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await stage.emulateMedia({ reducedMotion });
        const pagination = await stage.evaluate(async (fontScale) => {
          const hooks = (window as unknown as { __petStageTest: {
            hideBubbles(): void;
            showBubble(kind: string, text: string, options?: { ttlMs: number }): void;
            setBubbleContext(context: { fontScale: number }): void;
          } }).__petStageTest;
          hooks.hideBubbles();
          document.documentElement.style.setProperty('--pet-bubble-font-scale', String(fontScale));
          hooks.setBubbleContext({ fontScale });
          await document.fonts.ready;
          const full = '今天整理背包并确认作物状态，然后根据真实观察规划出门路线；遇到商店未营业就重新考虑安排，完成后记录收获与工具回执，回家前检查体力和剩余时间。🐳最后这一句也必须完整看见，不能被省略号吞掉。';
          hooks.showBubble('dialog', full, { ttlMs: 1_500 });
          const node = document.querySelector('.pet-bubble--dialog') as HTMLElement;
          const text = node.querySelector('.pet-bubble__text') as HTMLElement;
          const pages: string[] = [];
          const sizes: string[] = [];
          let fits = true;
          let wholeLines = true;
          const start = performance.now();
          while (performance.now() - start < 40_000) {
            sizes.push(`${node.offsetWidth}/${node.offsetHeight}`);
            if (text.textContent === node.dataset.pageText && text.textContent !== '') {
              const page = Number(node.dataset.page ?? '1');
              pages[page - 1] = text.textContent;
              fits &&= text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1;
              const range = document.createRange();
              range.selectNodeContents(text);
              const bounds = text.getBoundingClientRect();
              const bodyBounds = text.parentElement!.getBoundingClientRect();
              const rootBounds = node.getBoundingClientRect();
              const top = Math.max(bounds.top, bodyBounds.top, rootBounds.top);
              const bottom = Math.min(bounds.bottom, bodyBounds.bottom, rootBounds.bottom);
              wholeLines &&= [...range.getClientRects()].every((rect) => rect.top >= top - 1 && rect.bottom <= bottom + 1);
              if (page === Number(node.dataset.pageCount)) break;
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          const preserved = node.dataset.fullText;
          hooks.hideBubbles();
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const cancelled = node.style.display === 'none';
          hooks.showBubble('dialog', '新台词');
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const replacement = node.dataset.fullText;
          hooks.hideBubbles();
          document.documentElement.style.setProperty('--pet-bubble-font-scale', '1');
          hooks.setBubbleContext({ fontScale: 1 });
          return { full, pages, fits, wholeLines, preserved, sizes, cancelled, replacement };
        }, reducedMotion === 'reduce' ? 1.4 : 1);
        expect(pagination.pages.length).toBeGreaterThan(1);
        expect(pagination.pages.join('')).toBe(pagination.full);
        expect(pagination.preserved).toBe(pagination.full);
        expect(pagination.fits).toBe(true);
        expect(pagination.wholeLines).toBe(true);
        expect(new Set(pagination.sizes).size).toBe(1);
        expect(pagination.cancelled).toBe(true);
        expect(pagination.replacement).toBe('新台词');
      }
      await stage.emulateMedia({ reducedMotion: 'no-preference' });
      const recovered = await stage.evaluate(async () => {
        const hooks = (window as unknown as { __petStageTest: {
          hideBubbles(): void;
          showBubble(kind: string, text: string, options?: { ttlMs: number }): void;
          setBubbleContext(context: { fontScale: number }): void;
          setBubbleStageBox(box: { width: number; height: number }): void;
        } }).__petStageTest;
        hooks.hideBubbles();
        document.documentElement.style.setProperty('--pet-bubble-font-scale', '1.4');
        hooks.setBubbleContext({ fontScale: 1.4 });
        hooks.setBubbleStageBox({ width: 80, height: 48 });
        const full = '空间恢复以后继续完整阅读。';
        hooks.showBubble('dialog', full, { ttlMs: 1_500 });
        const node = document.querySelector('.pet-bubble--dialog') as HTMLElement;
        const blocked = node.dataset.readingBlocked === 'true';
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const retained = node.dataset.fullText === full;
        hooks.setBubbleStageBox({ width: window.innerWidth, height: window.innerHeight });
        document.documentElement.style.setProperty('--pet-bubble-font-scale', '1');
        hooks.setBubbleContext({ fontScale: 1 });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const resumed = node.dataset.readingBlocked === 'false'
          && (node.querySelector('.pet-bubble__text')?.textContent?.length ?? 0) > 0;
        hooks.hideBubbles();
        return { blocked, retained, resumed };
      });
      expect(recovered).toEqual({ blocked: true, retained: true, resumed: true });

      // ③ 显示层级 / 气泡字号持久化并生效
      await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.prefsSet({ windowLayer: 'normal', bubbleFontScale: 1.4 }));
      await waitFor(stage, async () => {
        const prefs = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.prefsGet());
        const scale = await stage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pet-bubble-font-scale').trim());
        return prefs.windowLayer === 'normal' && prefs.bubbleFontScale === 1.4 && scale === '1.4';
      });
      await waitFor(app, async () => {
        const onTop = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle().includes('桌宠'));
          return win?.isAlwaysOnTop() ?? true;
        });
        return onTop === false;
      });
      await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.prefsSet({ windowLayer: 'always', bubbleFontScale: null }));
      await waitFor(app, async () => {
        const onTop = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle().includes('桌宠'));
          return win?.isAlwaysOnTop() ?? false;
        });
        return onTop === true;
      });
      console.log('[pet-evolution-e2e] layer/prefs ok');

      // ④ 小本子双页 + 8 套手写体注入
      const director = await waitForWindow(app, 'director');
      await director.waitForFunction(() => Boolean((window as unknown as { directorBridge?: unknown }).directorBridge), { timeout: 20_000 });
      await director.click('[data-tab="pet"]');
      await director.waitForSelector('[data-pet-studio]', { timeout: 15_000 });
      await director.click('[data-pet-studio-tab="social"]');
      await director.waitForSelector('[data-notebook-panel]', { timeout: 15_000 });
      const styleText = await director.evaluate(() => document.querySelector('[data-notebook-panel] style')?.textContent ?? '');
      expect(styleText).toContain('whale-hand-ma-shan-zheng');
      expect(styleText).toContain('whale-hand-notebook-kai');
      await director.click('[data-notebook-page-tab="friends"]');
      await director.waitForFunction(() => {
        const panel = document.querySelector('[data-notebook-page="friends"]') as HTMLElement | null;
        return panel !== null && panel.style.display !== 'none';
      }, { timeout: 10_000 });
      expect(await director.locator('[data-notebook-friend-notes]').count()).toBe(1);
      console.log('[pet-evolution-e2e] notebook ok');

      // ⑤ 彩蛋小剧场：有素材则打开→抓包→收口；无素材如实失败
      const egg = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.petEggTheater());
      if (egg.ok) {
        expect(egg.agentId).toBeTruthy();
        const eggUrlPart = `agentId=${encodeURIComponent(egg.agentId!)}`;
        const eggWindow = await waitForWindow(app, eggUrlPart, 20_000);
        await eggWindow.waitForLoadState('domcontentloaded').catch(() => undefined);
        const caught = await stage.evaluate(() => (window as unknown as { petStage: PetStageBridge }).petStage.eggCatch());
        expect(caught).toMatchObject({ ok: true, caught: true });
        // 仅断言本次打开的彩蛋窗自身收口关闭：共享 e2e-profile 下若开发机同时运行 AI CLI，
        // cliLogWatcher 会自动召唤跨 AI 工作跟随窗，按全部 pet-stage 窗口数 === 1 会误报。
        await waitFor(app, async () => app.windows().every((candidate) => !candidate.url().includes(eggUrlPart)), 15_000);
      } else {
        expect(egg.error ?? '').toContain('彩蛋');
      }
      console.log('[pet-evolution-e2e] egg theater done');
    } finally {
      // E2E profile 跨 spec 共享：恢复默认偏好，避免污染后续用例
      const stage = app.windows().find((candidate) => candidate.url().includes('pet-stage'));
      if (stage !== undefined) {
        await stage.evaluate(() => (window as unknown as { petStage?: PetStageBridge }).petStage?.prefsSet({ windowLayer: 'always', bubbleFontScale: null })).catch(() => undefined);
      }
      await app.close();
    }
  });
});


describe('[E2E-HOST] 状态与对话、思考共存', () => {
  it('状态即时分页且三种气泡全文可读，默认与1.4字号不裁切、不遮脸', { timeout: 100_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry], executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const stage = await waitForWindow(app, 'pet-stage');
      await stage.waitForFunction(() => Boolean((window as unknown as { __petStageReady?: boolean }).__petStageReady));
      for (const fontScale of [1, 1.4]) {
        await stage.emulateMedia({ reducedMotion: fontScale === 1 ? 'no-preference' : 'reduce' });
        const result = await stage.evaluate(async (scale) => {
          type Kind = 'dialog' | 'thought' | 'status';
          const hooks = (window as unknown as { __petStageTest: {
            hideBubbles(): void;
            showBubble(kind: string, text: string, opts?: { ttlMs: number }): void;
            setBubbleStageBox(box: { width: number; height: number }): void;
            setBubbleContext(context: { fontScale: number; occupied: unknown[] }): void;
          } }).__petStageTest;
          hooks.hideBubbles();
          hooks.setBubbleStageBox({ width: 400, height: 260 });
          document.documentElement.style.setProperty('--pet-bubble-font-scale', String(scale));
          hooks.setBubbleContext({ fontScale: scale, occupied: [] });
          await document.fonts.load('13.5px ShangShouGummy', 'clear_area正在核对');
          await document.fonts.ready;
          const full: Record<Kind, string> = {
            dialog: '先整理背包，再按真实回执记录收获与剩余体力。',
            thought: '还要确认时间，不能把历史条件当作当前事实。',
            status: 'clear_area：正在核对本轮任务状态与执行回执，请等待真实结果。'.repeat(3),
          };
          hooks.showBubble('dialog', full.dialog, { ttlMs: 60_000 });
          hooks.showBubble('thought', full.thought, { ttlMs: 60_000 });
          hooks.showBubble('status', 'clear_area', { ttlMs: 60_000 });
          const shortNode = document.querySelector('.pet-bubble--status') as HTMLElement;
          const shortText = shortNode.querySelector('.pet-bubble__text') as HTMLElement;
          const short = { text: shortText.textContent, width: shortNode.offsetWidth, textWidth: shortText.clientWidth,
            fits: shortText.scrollHeight <= shortText.clientHeight + 1 && shortText.scrollWidth <= shortText.clientWidth + 1 };
          hooks.showBubble('status', full.status, { ttlMs: 60_000 });
          const pages: Record<Kind, string[]> = { dialog: [], thought: [], status: [] };
          const complete: Record<Kind, boolean> = { dialog: false, thought: false, status: false };
          let fits = true;
          let wholeLines = true;
          let noOverlap = true;
          let avoidsFace = true;
          let statusInstant = true;
          const started = performance.now();
          while (performance.now() - started < 32_000) {
            const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
            for (const kind of ['dialog', 'thought', 'status'] as const) {
              const node = document.querySelector(`.pet-bubble--${kind}`) as HTMLElement;
              const text = node.querySelector('.pet-bubble__text') as HTMLElement;
              const pageText = node.dataset.pageText ?? '';
              const content = text.textContent ?? '';
              if (kind === 'status') statusInstant &&= content === pageText;
              fits &&= text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1;
              if (content === pageText && content !== '') {
                const index = Number(node.dataset.page ?? '1') - 1;
                pages[kind][index] = content;
                complete[kind] = index + 1 === Number(node.dataset.pageCount);
                const range = document.createRange();
                range.selectNodeContents(text);
                const bounds = [text, text.parentElement!, node].map((el) => el.getBoundingClientRect());
                const top = Math.max(...bounds.map((r) => r.top));
                const bottom = Math.min(...bounds.map((r) => r.bottom));
                wholeLines &&= [...range.getClientRects()].every((r) => r.top >= top - 1 && r.bottom <= bottom + 1);
              }
              rects.push({ x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight });
            }
            const overlaps = (a: typeof rects[number], b: typeof rects[number]): boolean =>
              a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
            const face = { x: 144, y: 73, width: 112, height: 159 };
            avoidsFace &&= rects.every((rect) => !overlaps(rect, face));
            noOverlap &&= rects.every((rect, index) => rects.slice(index + 1).every((other) => !overlaps(rect, other)));
            if (Object.values(complete).every(Boolean)) break;
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          hooks.hideBubbles();
          document.documentElement.style.setProperty('--pet-bubble-font-scale', '1');
          hooks.setBubbleContext({ fontScale: 1, occupied: [] });
          return { full, pages, complete, fits, wholeLines, statusInstant, short, noOverlap, avoidsFace };
        }, fontScale);
        expect(result.short).toMatchObject({ text: 'clear_area', fits: true });
        expect(result.short.width).toBeGreaterThanOrEqual(120);
        expect(result.short.textWidth).toBeGreaterThanOrEqual(60);
        expect(result.statusInstant).toBe(true);
        expect(result.complete).toEqual({ dialog: true, thought: true, status: true });
        for (const kind of ['dialog', 'thought', 'status'] as const) expect(result.pages[kind].join('')).toBe(result.full[kind]);
        expect(result.pages.status.length).toBeGreaterThan(1);
        expect(result.fits).toBe(true);
        expect(result.wholeLines).toBe(true);
        expect(result.noOverlap).toBe(true);
        expect(result.avoidsFace).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});
