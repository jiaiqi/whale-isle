import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mainEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main', 'index.js');

/** [E2E-HOST] 空白气泡壳：已读完或暂时放不下时都不能留下只有徽标的空心泡。 */
describe('[E2E-HOST] 气泡不得出现空心外壳', () => {
  it('读完后布局重算保留当前页正文，空间不足时不显示空壳', { timeout: 90_000 }, async () => {
    const app = await electron.launch({
      executablePath: require('electron') as string,
      args: ['--use-mock-keychain', mainEntry],
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      let stage = app.windows().find((page) => page.url().includes('pet-stage'));
      const deadline = Date.now() + 25_000;
      while (stage === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        stage = app.windows().find((page) => page.url().includes('pet-stage'));
      }
      if (stage === undefined) throw new Error('桌宠窗口未就绪');
      const page = stage;
      await page.waitForFunction(() => Boolean((window as unknown as { __petStageTest?: object }).__petStageTest));
      await page.evaluate(() => document.fonts.ready);
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      const long = '主人不在也照样把农场打理好，先把木材凑齐做箱子，再把矿洞里的铁矿和煤带回来，晚上准点回屋睡觉。';
      const finished = await page.evaluate(async (text) => {
        const hooks = (window as unknown as { __petStageTest: {
          hideBubbles(): void;
          showBubble(kind: string, text: string, options?: { ttlMs: number }): boolean;
          setBubbleContext(ctx: unknown): void;
        } }).__petStageTest;
        hooks.hideBubbles();
        hooks.setBubbleContext({ anchor: { xRatio: 0.5, headYRatio: 0.34, facing: 'center' }, edgeHint: null, occupied: [], fontScale: 1.4 });
        hooks.showBubble('dialog', text, { ttlMs: 90_000 });
        const node = () => document.querySelector('.pet-bubble--dialog') as HTMLElement | null;
        const started = performance.now();
        while (performance.now() - started < 30_000) {
          const el = node();
          const txt = el?.querySelector('.pet-bubble__text') as HTMLElement | null;
          if (el !== null && txt !== null && el.dataset.page === el.dataset.pageCount && txt.textContent === el.dataset.pageText && (txt.textContent ?? '') !== '') break;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        const el = node()!;
        const txt = el.querySelector('.pet-bubble__text') as HTMLElement;
        const before = { page: el.dataset.page, pageCount: el.dataset.pageCount, pageText: el.dataset.pageText ?? '', text: txt.textContent ?? '' };
        // 字体加载或窗口尺寸变化会再次 renderLayout；同一结果不得把正文抹成空串。
        hooks.setBubbleContext({ anchor: { xRatio: 0.5, headYRatio: 0.34, facing: 'center' }, edgeHint: null, occupied: [], fontScale: 1.4 });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const after = { text: txt.textContent ?? '', display: getComputedStyle(el).display, pageText: el.dataset.pageText ?? '' };
        return { before, after };
      }, long);
      expect(finished.before.text).not.toBe('');
      expect(finished.before.text).toBe(finished.before.pageText);
      expect(finished.after.text).not.toBe('');
      expect(finished.after.text).toBe(finished.after.pageText);
      expect(finished.after.display).not.toBe('none');

      const blocked = await page.evaluate(async () => {
        const hooks = (window as unknown as { __petStageTest: {
          hideBubbles(): void;
          showBubble(kind: string, text: string, options?: { ttlMs: number }): boolean;
          setBubbleStageBox(box: { width: number; height: number }): void;
        } }).__petStageTest;
        hooks.hideBubbles();
        hooks.setBubbleStageBox({ width: 26, height: 14 });
        hooks.showBubble('dialog', '太小了放不下', { ttlMs: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const el = document.querySelector('.pet-bubble--dialog') as HTMLElement | null;
        const narrow = el === null ? null : {
          display: getComputedStyle(el).display,
          text: (el.querySelector('.pet-bubble__text') as HTMLElement).textContent ?? '',
          pageText: el.dataset.pageText ?? '',
        };
        return { narrow };
      });
      // 极小舞台：气泡要么不显示，要么必须已有正文，不得只剩外壳和心情徽标。
      expect(blocked.narrow === null || blocked.narrow.display === 'none' || (blocked.narrow.text !== '' && blocked.narrow.text === blocked.narrow.pageText)).toBe(true);

      // 真机「空气泡」根因：LLM 台词混入零宽字符（U+200B 等），trim() 去不掉，
      // 于是外壳照画、心形徽标照画，正文却没有任何墨迹。此处必须整泡不出现。
      const zeroWidth = await page.evaluate(async () => {
        const hooks = (window as unknown as { __petStageTest: {
          hideBubbles(): void;
          showBubble(kind: string, text: string, options?: { ttlMs: number }): boolean;
          setBubbleStageBox(box: { width: number; height: number }): void;
        } }).__petStageTest;
        hooks.hideBubbles();
        hooks.setBubbleStageBox({ width: 400, height: 260 });
        const shown = hooks.showBubble('reaction', '\u200b\u200c\u200d\ufeff', { ttlMs: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const el = document.querySelector('.pet-bubble--reaction') as HTMLElement | null;
        return {
          shown,
          display: el === null ? 'missing' : getComputedStyle(el).display,
          text: el === null ? '' : ((el.querySelector('.pet-bubble__text') as HTMLElement).textContent ?? ''),
        };
      });
      expect(zeroWidth.shown).toBe(false);
      expect(zeroWidth.display).toBe('none');
      expect(zeroWidth.text).toBe('');
    } finally {
      await app.close();
    }
  });
});
