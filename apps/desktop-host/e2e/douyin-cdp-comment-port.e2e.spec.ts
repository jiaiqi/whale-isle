/**
 * [E2E-HOST]+[SIMULATION] cdp-real 驱动下的受限评论端口注入。
 *
 * 用本机回环上的**仿真 CDP 端点**（node:http + ws，不启动真 Chrome、不访问抖音）
 * 走完整链路：`RealBrowserDouyinSession` → `CdpConnection` → `CdpPageDriver`
 * → 共用的评论端口实现（ADR-006）。
 *
 * 目的：证明 macOS 默认驱动 `cdp-real` 上评论端口真实被注入且能走通三态回执，
 * 而不是只在 Electron 驱动里存在。**不代表真实平台评论已验证**。
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import {
  RealBrowserDouyinSession,
  attachToCdpBrowser,
  type BrowserHostLike,
  type BrowserInstance,
  type DiscoveredBrowser,
} from '../src/main/cdp-browser-engine';

const VIDEO_URL = 'https://www.douyin.com/video/7703599797286223291';
const NEW_TEXT = '这个解释让我理解了光的折射原理';
const EXISTING = { commentId: '700001', authorAlias: '观众甲', text: '讲得真清楚' };
const SELF = { secUid: 'MS4wLjSELF', nickname: '小鲸', avatarUrl: 'https://p3.test/aweme/100x100/self.jpeg' };
const POSTED = { commentId: '700002', authorAlias: '小鲸', text: NEW_TEXT, authorSecUid: 'MS4wLjSELF' };

interface FakePageState {
  url: string;
  title: string;
  comments: Array<{ commentId: string; authorAlias: string; text: string; authorSecUid?: string }>;
  pendingText: string;
}

/** 逐条应答最小 CDP 子集；只服务于评论端口的读写路径 */
async function startFakeCdpEndpoint(): Promise<{
  port: number;
  state: FakePageState;
  close: () => Promise<void>;
}> {
  const state: FakePageState = { url: 'about:blank', title: '光的折射 - 抖音', comments: [EXISTING], pendingText: '' };
  const server = createServer((req, res) => {
    if (req.url === '/json/version') {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          Browser: 'FakeCDP/1.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });

  const evaluate = (expression: string): unknown => {
    if (expression === 'location.href') return state.url;
    if (expression === 'document.readyState') return 'complete';
    if (expression.includes('comment-item')) {
      return {
        url: state.url,
        title: state.title,
        text: state.title,
        comments: state.comments,
        inputAvailable: true,
        self: SELF,
      };
    }
    if (expression.includes('execCommand')) {
      // 填入脚本：记录待发送文本（真实 DOM 由 Electron E2E 覆盖）
      const match = /const text = ("(?:[^"\\]|\\.)*");/u.exec(expression);
      state.pendingText = match?.[1] === undefined ? '' : (JSON.parse(match[1]) as string);
      return true;
    }
    if (expression.includes('comment-publish')) {
      state.comments = [...state.comments, POSTED];
      return true;
    }
    return null;
  };

  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: { url?: string; expression?: string } };
      if (typeof message.id !== 'number') return;
      const reply = (result: unknown): void => {
        socket.send(JSON.stringify({ id: message.id, result }));
      };
      switch (message.method) {
        case 'Target.getTargets':
          reply({ targetInfos: [{ targetId: 'page-1', type: 'page', url: state.url }] });
          return;
        case 'Target.attachToTarget':
          reply({ sessionId: 'session-1' });
          return;
        case 'Page.enable':
        case 'Runtime.enable':
        case 'Page.bringToFront':
        case 'Browser.close':
          reply({});
          return;
        case 'Page.navigate':
          state.url = message.params?.url ?? state.url;
          reply({ frameId: 'frame-1' });
          return;
        case 'Runtime.evaluate':
          reply({ result: { value: evaluate(message.params?.expression ?? '') } });
          return;
        case 'Network.getCookies':
          reply({ cookies: [{ name: 'sessionid', value: 'never-read' }] });
          return;
        default:
          reply({});
      }
    });
  });

  await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    state,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const BROWSER: DiscoveredBrowser = {
  name: 'Google Chrome',
  appPath: '/Applications/Google Chrome.app',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};

describe('[E2E-HOST] cdp-real 评论端口注入（仿真 CDP 端点）', () => {
  it('会话在 cdp-real 驱动上提供 readComments/postComment，并走通 sent 回执与验证码停止', { timeout: 30_000 }, async () => {
    const endpoint = await startFakeCdpEndpoint();
    const instance: BrowserInstance = {
      webSocketDebuggerUrl: `ws://127.0.0.1:${endpoint.port}/devtools/browser/fake`,
      port: endpoint.port,
      pid: 4242,
      browser: BROWSER,
    };
    const host: BrowserHostLike = {
      ensure: async () => instance,
      isRunning: () => true,
      cleanup: async () => undefined,
    };
    const session = new RealBrowserDouyinSession({
      profileDir: '/tmp/whale-cdp-comment-e2e-profile',
      host,
      attach: (target) => attachToCdpBrowser(target),
    });

    try {
      // 1) 端口确实存在于 cdp-real 会话上（不是只有 Electron 驱动才有）
      expect(typeof session.readComments).toBe('function');
      expect(typeof session.postComment).toBe('function');

      // 2) 读评论区走真实 CDP 往返
      const thread = await session.readComments(VIDEO_URL);
      expect(thread.inputAvailable).toBe(true);
      expect(thread.comments[0]?.commentId).toBe('700001');

      // 3) 发送 + 稳定回执（新增数字 ID + 全文一致 + 重载仍在）
      const receipt = await session.postComment({ url: VIDEO_URL, text: NEW_TEXT }, () => true);
      expect(receipt).toMatchObject({ ok: true, commentId: '700002' });

      // 4) 验证码立即停手，不填不点
      endpoint.state.title = '验证码中间页';
      const blocked = await session.postComment({ url: VIDEO_URL, text: NEW_TEXT }, () => true);
      expect(blocked).toMatchObject({ ok: false, blocked: 'captcha' });
    } finally {
      await session.dispose();
      await endpoint.close();
    }
  });
});
