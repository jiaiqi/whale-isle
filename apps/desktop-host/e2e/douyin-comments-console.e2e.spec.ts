/**
 * [E2E-HOST] 主应用中控台「抖音 · 有限自动评论」面板。
 * 用测试专用 bootstrap 把 appData 指到临时目录，再加载真实构建产物 dist/main/index.js；
 * 不读写真实 e2e-profile，也不访问抖音。记录数据是显式种入的 [SIMULATION] 数据。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainEntry = join(here, '..', 'dist', 'main', 'index.js');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;

interface DirectorBridge {
  v2SocialSnapshot(): Promise<{
    douyin: { comments: {
      settings: { enabled: boolean };
      blockedReason: string;
      ledgerReady: boolean;
      capability: { verified: boolean; lastVerifiedAt: number };
      remainingToday: number;
    } };
  }>;
  v2SocialCommentHistory(input?: { dayKey?: string }): Promise<{
    dayKey: string;
    total: number;
    actions: Array<{ status: string; text: string }>;
  }>;
}

async function waitForDirector(app: import('playwright-core').ElectronApplication): Promise<import('playwright-core').Page> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const found = app.windows().find(candidate => candidate.url().includes('/renderer/director/'));
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('未找到中控台窗口');
}

function findWorkbenchDb(appData: string): string {
  for (const entry of readdirSync(appData)) {
    const candidate = join(appData, entry, 'e2e-profile', 'workbench.db');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`临时 appData 下未找到 workbench.db：${appData}`);
}

function localDayKey(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('[E2E-HOST] 主应用评论面板', () => {
  it('默认关闭、开关不伪造实测、种入记录可按日查看', { timeout: 150_000 }, async () => {
    const appData = mkdtempSync(join(tmpdir(), 'whale-comment-console-'));
    writeFileSync(join(appData, 'bootstrap.mjs'),
      `import { app } from 'electron';\napp.setPath('appData', ${JSON.stringify(appData)});\nawait import(${JSON.stringify(mainEntry)});\n`);
    const app = await electron.launch({
      executablePath: electronBinary,
      args: ['--use-mock-keychain', join(appData, 'bootstrap.mjs')],
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_DISABLE_INPUT_MONITOR: '1' },
    });
    try {
      const director = await waitForDirector(app);
      await director.waitForLoadState('domcontentloaded');
      await director.waitForTimeout(2000);
      await director.evaluate(() => {
        [...document.querySelectorAll('button, [role="button"], a')]
          .find(element => (element.textContent ?? '').includes('V2 生命中枢'))?.click();
      });
      await director.waitForSelector('[data-v2-social-comments]', { timeout: 20_000 });

      const read = () => director.evaluate(async () => {
        const bridge = (window as unknown as { directorBridge: DirectorBridge }).directorBridge;
        const snapshot = await bridge.v2SocialSnapshot();
        const panel = document.querySelector('[data-v2-social-comments]');
        const toggle = panel?.querySelector('[data-v2-comment-toggle]');
        const status = panel?.querySelector('[data-v2-comment-status]');
        return {
          enabled: snapshot.douyin.comments.settings.enabled,
          verified: snapshot.douyin.comments.capability.verified,
          lastVerifiedAt: snapshot.douyin.comments.capability.lastVerifiedAt,
          ledgerReady: snapshot.douyin.comments.ledgerReady,
          remainingToday: snapshot.douyin.comments.remainingToday,
          pressed: toggle?.getAttribute('aria-pressed') ?? '',
          statusText: status?.textContent?.trim() ?? '',
        };
      });

      const initial = await read();
      expect(initial.enabled).toBe(false);
      expect(initial.verified).toBe(false);
      expect(initial.lastVerifiedAt).toBe(0);
      expect(initial.ledgerReady).toBe(true);
      expect(initial.pressed).toBe('false');
      expect(initial.statusText).toContain('真实发送尚未验证，自动评论不会执行');

      await director.evaluate(() => {
        document.querySelector('[data-v2-social-comments] [data-v2-comment-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await director.waitForFunction(() => {
        const status = document.querySelector('[data-v2-comment-status]');
        return status?.textContent?.includes('开关已开启') ?? false;
      }, undefined, { timeout: 10_000 });
      const enabled = await read();
      expect(enabled.enabled).toBe(true);
      expect(enabled.verified).toBe(false);
      expect(enabled.lastVerifiedAt).toBe(0);
      expect(enabled.statusText).toContain('真实发送尚未验证，自动评论不会执行');

      // 显式种入两条 simulation-only 记录；不代表任何真实抖音发送。
      const db = new DatabaseSync(findWorkbenchDb(appData));
      try {
        const now = Date.now();
        const rows = [
          { id: 'e2e-sent', status: 'sent', text: '【E2E-种入】这段讲解让我理解了潮汐锁定的原理', title: 'E2E 仿真科普', attempted: now },
          { id: 'e2e-skipped', status: 'skipped', text: '', title: 'E2E 仿真生活', attempted: 0 },
        ];
        for (const row of rows) {
          const payload = {
            actionId: row.id, platform: 'douyin', sessionId: 'e2e-console',
            targetUrl: 'https://www.douyin.com/video/7703599797286223291',
            targetTitle: row.title, targetAuthor: 'E2E 仿真作者', videoId: '7703599797286223291',
            text: row.text, status: row.status, failureKind: '', reason: 'E2E 种入记录，非真实平台发送',
            modelId: 'simulation-only', createdAt: now, completedAt: now, attemptedAt: row.attempted,
          };
          db.prepare('INSERT OR REPLACE INTO social_comment_actions VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run('char_xiaojing:douyin-owner', row.id, now, row.attempted, '7703599797286223291', row.status, JSON.stringify(payload));
        }
      } finally { db.close(); }

      // 生活页每 5 秒刷新一次本机记录，等它自然刷新。
      await director.waitForTimeout(6500);
      const history = await director.evaluate(async () => {
        const bridge = (window as unknown as { directorBridge: DirectorBridge }).directorBridge;
        const result = await bridge.v2SocialCommentHistory();
        const items = [...document.querySelectorAll('[data-v2-comment-history] li')].map(li => (li as HTMLElement).innerText);
        return { total: result.total, statuses: result.actions.map(action => action.status), items };
      });
      expect(history.total).toBe(2);
      expect(history.statuses).toEqual(['sent', 'skipped']);
      const rendered = history.items.join('\n');
      expect(rendered).toContain('已确认发送');
      expect(rendered).toContain('已跳过');
      expect(rendered).toContain('【E2E-种入】这段讲解让我理解了潮汐锁定的原理');
      expect(rendered).toContain('E2E 种入记录，非真实平台发送');

      const afterSeed = await read();
      expect(afterSeed.remainingToday).toBe(9);

      // 切到前一天：应显示空态而非把今天的记录留在屏幕上。
      await director.evaluate((day) => {
        const input = document.querySelector('[data-v2-comment-history-day]') as HTMLInputElement | null;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, day);
        input?.dispatchEvent(new Event('change', { bubbles: true }));
      }, localDayKey(-1));
      await director.waitForTimeout(1500);
      const yesterday = await director.evaluate(async (day) => {
        const bridge = (window as unknown as { directorBridge: DirectorBridge }).directorBridge;
        const result = await bridge.v2SocialCommentHistory({ dayKey: day });
        return { total: result.total, hasEmpty: Boolean(document.querySelector('[data-v2-comment-empty]')) };
      }, localDayKey(-1));
      expect(yesterday.total).toBe(0);
      expect(yesterday.hasEmpty).toBe(true);

      await director.evaluate(() => {
        document.querySelector('[data-v2-social-comments] [data-v2-comment-toggle]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await director.waitForTimeout(1000);
      expect((await read()).enabled).toBe(false);
    } finally {
      await app.close();
      rmSync(appData, { recursive: true, force: true });
    }
  });
});
