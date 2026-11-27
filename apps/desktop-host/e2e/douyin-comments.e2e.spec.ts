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
interface Harness {
  engine: ElectronBrowserEngine;
  ledger: SocialCommentLedger;
  posts: string[];
  setCaptcha(): void;
  runMissingPort(): Promise<{ status: string; failureKind: string; reason: string; statuses: string[] }>;
  runPausePolicy(kind: 'structure' | 'captcha'): Promise<{
    status: string; failureKind: string; paused: boolean; enabled: boolean; reasons: string[];
  }>;
}

describe('[E2E-HOST] 受限评论与每日账本', () => {
  it('真实 DOM 发布与重载回读、取消、验证码停止（磁盘重启由 SQLite 单测覆盖）', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-comment-e2e-'));
    const entry = join(dir, 'main.cjs');
    await build({
      stdin: { resolveDir: appRoot, sourcefile: 'comment-harness.ts', loader: 'ts', contents: `
        import { app, session } from 'electron';
        import { DouyinCommentExecutor } from '@workbench/character-core';
        import { ElectronBrowserEngine } from './src/main/electron-browser-engine';
        import { SocialCommentLedger } from './src/main/social-comment-ledger';
        import { applyCommentPausePolicy } from './src/main/social-comment-pause';
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
              '<a data-e2e="user-avatar" href="/user/MS4wLjSELF" title="小鲸"><img src="https://p3.test/aweme/100x100/self.jpeg"></a>' +
              '<textarea data-e2e="comment-input"></textarea><button data-e2e="comment-publish">发送</button><div id="list"></div>' +
              '<script>const seed=' + JSON.stringify(posts).replaceAll('<', '\\u003c') + ';' +
              'function add(text,id,sec,alias){ const row=document.createElement("div"); row.dataset.e2e="comment-item";row.setAttribute("data-comment-id",id);' +
              'const who=document.createElement("a");who.href="/user/"+sec;who.textContent=alias;const av=document.createElement("img");av.src="https://p3.test/aweme/100x100/"+sec+".jpeg";who.append(av);' +
              'const body=document.createElement("span");body.dataset.e2e="comment-content";body.textContent=text;row.append(who,body);document.getElementById("list").append(row); }' +
              'seed.forEach((text,i)=>add(text,String(800000+i),"MS4wLjSELF","小鲸"));' +
              'document.querySelector("button").onclick=async()=>{const input=document.querySelector("textarea");const text=input.value;await fetch("/sim-comment",{method:"POST",body:text});add(text,String(800000+seed.length),"MS4wLjSELF","小鲸");input.value="";};</script>';
            return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
          });
          const engine = new ElectronBrowserEngine({ profile: { characterId:'test', accountId:'comment', profileDir:${JSON.stringify(dir)}, profileId:'test', status:'ready', createdAt:0, updatedAt:0, isolatedFromUserDaily:true, cookieCount:0 } });
          const ledger = new SocialCommentLedger(${JSON.stringify(join(dir, 'actions.db'))}, 'test');
          const url = 'https://www.douyin.com/video/7703599797286223291';
          const settings = { enabled:true, maxPerDay:10, maxPerHour:3, minIntervalMs:180000, minChars:8, maxChars:80, sameVideoCooldownMs:86400000, quietHoursStart:0, quietHoursEnd:0 };
          const candidate = { candidateId:url, platform:'douyin', url, title:'仿真科普', previewText:'@作者', contentKind:'video', sourceKind:'manual' };
          const composer = { compose: async () => ({ shouldComment:true, text:'这个解释让我理解了光的折射原理', reason:'', modelId:'simulation-only' }) };
          const runtime = { assertCapability: () => ({}) };
          const openLedger = (name) => new SocialCommentLedger(${JSON.stringify(join(dir, 'policy'))} + '-' + name + '.db', 'test');
          // 4a：驱动缺端口 → failed、账本无 sent、页面 0 次点击（不打开页面、不点按钮）
          const runMissingPort = async () => {
            const l = openLedger('missing');
            const executor = new DouyinCommentExecutor({ web: {}, ledger: l, composer, runtime });
            const action = await executor.execute({ sessionId:'sim-missing', candidate, itemText:'', settings });
            const statuses = l.list(0, Number.MAX_SAFE_INTEGER).map(a => a.status);
            l.close();
            return { status: action.status, failureKind: action.failureKind, reason: action.reason, statuses };
          };
          // 4b：结构性错误（页面变化）不触发暂停；验证码才触发
          const runPausePolicy = async (kind) => {
            const l = openLedger(kind);
            const base = { url, title:'', text:'', comments:[], inputAvailable:true,
              self:{ secUid:'MS4wLjSELF', nickname:'小鲸', avatarUrl:'https://p3.test/aweme/100x100/self.jpeg' } };
            const web = kind === 'captcha'
              ? { readComments: async () => ({ ...base, title:'验证码中间页' }), postComment: async () => ({ ok:false, detail:'验证码', blocked:'captcha' }) }
              : { readComments: async () => base, postComment: async () => ({ ok:false, uncertain:true, detail:'点击发送后页面变化，结果不确定' }) };
            const executor = new DouyinCommentExecutor({ web, ledger: l, composer, runtime });
            const action = await executor.execute({ sessionId:'sim-policy', candidate, itemText:'', settings });
            let enabled = true; const reasons = [];
            const paused = applyCommentPausePolicy(action, (reason) => { enabled = false; reasons.push(reason); });
            l.close();
            return { status: action.status, failureKind: action.failureKind, paused, enabled, reasons };
          };
          globalThis.commentHarness = { engine, ledger, posts, setCaptcha: () => { captcha = true; }, runMissingPort, runPausePolicy };
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
        const postsBeforeMissingPort = harness.posts.length;
        const missingPort = await harness.runMissingPort();
        const postsAfterMissingPort = harness.posts.length;
        const structuralPolicy = await harness.runPausePolicy('structure');
        const captchaPolicy = await harness.runPausePolicy('captcha');
        const posts = [...harness.posts];
        await harness.engine.dispose(); harness.ledger.close();
        return { available:thread.inputAvailable, cancelled, postsAfterCancel, receipt, actions, posts, blockedThread, blockedReceipt,
          postsBeforeMissingPort, postsAfterMissingPort, missingPort, structuralPolicy, captchaPolicy };
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
      // 4a：驱动缺端口 → failed + 账本无 sent + 页面 0 次点击（提交数不增加）
      expect(result.missingPort.status).toBe('failed');
      expect(result.missingPort.failureKind).toBe('page_error');
      expect(result.missingPort.reason).toContain('未提供评论区读写端口');
      expect(result.missingPort.statuses).not.toContain('sent');
      expect(result.postsAfterMissingPort).toBe(result.postsBeforeMissingPort);
      // 4b：结构性错误不暂停（开关保持开启）；验证码才暂停
      expect(result.structuralPolicy.status).toBe('uncertain');
      expect(result.structuralPolicy.failureKind).toBe('receipt_failed');
      expect(result.structuralPolicy.paused).toBe(false);
      expect(result.structuralPolicy.enabled).toBe(true);
      expect(result.captchaPolicy.status).toBe('failed');
      expect(result.captchaPolicy.failureKind).toBe('captcha');
      expect(result.captchaPolicy.paused).toBe(true);
      expect(result.captchaPolicy.enabled).toBe(false);
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
