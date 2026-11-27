/** [E2E-HOST]+[SIMULATION] 真 Electron、真 DOM、真 SQLite；https 在隔离 partition 内全部拦为本地页面，不访问抖音。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { ElectronBrowserEngine } from '../src/main/electron-browser-engine';
import type { SocialCommentLedger } from '../src/main/social-comment-ledger';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
interface Harness { engine: ElectronBrowserEngine; ledger: SocialCommentLedger; posts: string[]; setCaptcha(): void; }

describe('[E2E-HOST] 受限评论与每日账本', () => {
  it('真实 DOM 发布与重载回读、取消、验证码停止（磁盘重启由 SQLite 单测覆盖）', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-comment-e2e-'));
    const entry = join(dir, 'main.cjs');
    await build({
      stdin: { resolveDir: appRoot, sourcefile: 'comment-harness.ts', loader: 'ts', contents: `
        import { app, session } from 'electron';
        import { ElectronBrowserEngine } from './src/main/electron-browser-engine';
        import { SocialCommentLedger } from './src/main/social-comment-ledger';
        app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
        app.disableHardwareAcceleration();
        app.whenReady().then(() => {
          const posts = []; let captcha = false;
          const partition = session.fromPartition('persist:whale-test-comment');
          partition.protocol.handle('https', async request => {
            const url = new URL(request.url);
            if (url.hostname !== 'www.douyin.com') return new Response('', { status: 403 });
            if (url.pathname === '/sim-comment' && request.method === 'POST') {
              posts.push(await request.text()); return new Response('ok');
            }
            if (captcha) return new Response('<title>验证码中间页</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
            const html = '<!doctype html><meta charset="utf-8"><title>本地仿真</title><h1>仿真科普</h1>' +
              '<textarea data-e2e="comment-input"></textarea><button data-e2e="comment-publish">发送</button><div id="list"></div>' +
              '<script>const seed=' + JSON.stringify(posts).replaceAll('<', '\\u003c') + ';' +
              'function add(text,id){ const row=document.createElement("div"); row.dataset.e2e="comment-item";row.setAttribute("data-comment-id",id); const body=document.createElement("span");body.dataset.e2e="comment-content";body.textContent=text;row.append(body);document.getElementById("list").append(row); }' +
              'seed.forEach((text,i)=>add(text,String(800000+i)));' +
              'document.querySelector("button").onclick=async()=>{const input=document.querySelector("textarea");const text=input.value;await fetch("/sim-comment",{method:"POST",body:text});add(text,String(800000+seed.length));input.value="";};</script>';
            return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
          });
          const engine = new ElectronBrowserEngine({ profile: { characterId:'test', accountId:'comment', profileDir:${JSON.stringify(dir)}, profileId:'test', status:'ready', createdAt:0, updatedAt:0, isolatedFromUserDaily:true, cookieCount:0 } });
          const ledger = new SocialCommentLedger(${JSON.stringify(join(dir, 'actions.db'))}, 'test');
          globalThis.commentHarness = { engine, ledger, posts, setCaptcha: () => { captcha = true; } };
        });
      ` },
      outfile: entry, platform: 'node', format: 'cjs', bundle: true, external: ['electron'], logLevel: 'silent',
    });
    const app = await electron.launch({ executablePath: require('electron') as string, args: [entry] });
    try {
      const result = await app.evaluate(async () => {
        const harness = (globalThis as unknown as { commentHarness: Harness }).commentHarness;
        const url = 'https://www.douyin.com/video/7703599797286223291';
        const text = '这个解释让我理解了光的折射原理';
        const thread = await harness.engine.readComments(url);
        const cancelled = await harness.engine.postComment({ url, text }, () => false);
        const postsAfterCancel = harness.posts.length;
        const receipt = await harness.engine.postComment({ url, text }, () => true);
        // 测试明确种入仿真 journal，不代表真实平台发送证据。
        harness.ledger.append({ actionId:'test-a', platform:'douyin', sessionId:'sim', targetUrl:url,
          targetTitle:'仿真科普', targetAuthor:'', videoId:'7703599797286223291', text, status:'sent', failureKind:'',
          reason:receipt.detail, modelId:'simulation-only', createdAt:Date.now(), completedAt:Date.now(), attemptedAt:Date.now() });
        const actions = harness.ledger.list(0, Number.MAX_SAFE_INTEGER);
        harness.setCaptcha();
        const blockedThread = await harness.engine.readComments(url);
        const blockedReceipt = await harness.engine.postComment({ url, text }, () => true);
        const posts = [...harness.posts];
        await harness.engine.dispose(); harness.ledger.close();
        return { available:thread.inputAvailable, cancelled, postsAfterCancel, receipt, actions, posts, blockedThread, blockedReceipt };
      });
      expect(result.available).toBe(true);
      expect(result.cancelled.ok).toBe(false);
      expect(result.postsAfterCancel).toBe(0);
      expect(result.receipt.ok).toBe(true);
      expect(result.receipt.commentId).toBe('800000');
      expect(result.posts).toHaveLength(1);
      expect(result.actions[0]?.text).toBe(result.posts[0]);
      expect(result.blockedThread.title).toBe('验证码中间页');
      expect(result.blockedReceipt.blocked).toBe('captcha');
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
