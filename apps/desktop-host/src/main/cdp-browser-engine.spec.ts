/**
 * V2-P3-04K 真浏览器 CDP 驱动单测。
 *
 * 全部用 fake CDP / fake browser 跑，不要求本机安装 Chrome/Edge，CI 不会因为缺浏览器而失败。
 * 真实浏览器路径不在这里证明——它由 `docs/v2/evidence/P3-04K-*` 的真机只读 probe 与冒烟证据负责。
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DouyinPageSnapshot } from '@workbench/character-core';
import {
  CdpBrowserHost,
  CdpConnection,
  CdpPageDriver,
  RealBrowserDouyinSession,
  buildLaunchArgs,
  describeMissingBrowser,
  discoverInstalledBrowser,
  probeCdpEndpoint,
  readProfileLockPid,
  type BrowserChildLike,
  type BrowserHostLike,
  type BrowserInstance,
  type CdpBrowserAttachment,
  type CdpEndpoint,
  type DiscoveredBrowser,
  type DouyinCdpDriver,
  type WebSocketLike,
} from './cdp-browser-engine';
import { DOUYIN_CAPTCHA_VISIBILITY_SCRIPT, DOUYIN_PAGE_READER_SCRIPT, DOUYIN_RECOMMEND_TAB_CLICK_SCRIPT } from './douyin-page-reader';

const CHROME: DiscoveredBrowser = {
  name: 'Google Chrome',
  appPath: '/Applications/Google Chrome.app',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whale-cdp-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fake WebSocket / fake CDP browser
// ---------------------------------------------------------------------------

interface SentMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly sent: SentMessage[] = [];
  closed = false;
  constructor(private readonly handler: (message: SentMessage, socket: FakeSocket) => void) {}

  send(data: string): void {
    const message = JSON.parse(data) as SentMessage;
    this.sent.push(message);
    this.handler(message, this);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  open(): void {
    this.onopen?.({});
  }
}

function respond(socket: FakeSocket, message: SentMessage, result: unknown): void {
  socket.receive({ id: message.id, result });
}

function fail(socket: FakeSocket, message: SentMessage, code: number, text: string): void {
  socket.receive({ id: message.id, error: { code, message: text } });
}

interface FakeBrowserState {
  url: string;
  readyState: string;
  snapshot: DouyinPageSnapshot;
  clickResult: boolean;
  recommendations: DouyinPageSnapshot;
  exceptionExpression: string | null;
  cookies: Array<{ name: string; value: string }>;
  broughtToFront: number;
  navigations: string[];
  /** >0 时模拟 Page.navigate 静默失败：请求发出但页面不跳转 */
  navigateFailures: number;
}

function emptySnapshot(overrides: Partial<DouyinPageSnapshot> = {}): DouyinPageSnapshot {
  return {
    url: 'about:blank',
    title: '',
    text: '',
    cards: [],
    ...overrides,
  };
}

function createFakeBrowserState(): FakeBrowserState {
  return {
    url: 'about:blank',
    readyState: 'complete',
    snapshot: emptySnapshot(),
    clickResult: true,
    recommendations: emptySnapshot({
      url: 'https://www.douyin.com/?recommend=1',
      title: '抖音推荐',
      text: '推荐',
      cards: [{ videoId: '76814179753662743', text: '公开视频 #科普\n@公开作者' }],
    }),
    exceptionExpression: null,
    cookies: [],
    broughtToFront: 0,
    navigations: [],
    navigateFailures: 0,
  };
}

function fakeBrowserHandler(state: FakeBrowserState) {
  return (message: SentMessage, socket: FakeSocket): void => {
    switch (message.method) {
      case 'Target.getTargets':
        respond(socket, message, {
          targetInfos: [{ targetId: 'T1', type: 'page', url: state.url }],
        });
        return;
      case 'Target.attachToTarget':
        respond(socket, message, { sessionId: 'S1' });
        return;
      case 'Page.enable':
      case 'Runtime.enable':
      case 'Network.enable':
        respond(socket, message, {});
        return;
      case 'Page.bringToFront':
        state.broughtToFront += 1;
        respond(socket, message, {});
        return;
      case 'Page.navigate':
        state.navigations.push(String(message.params.url ?? ''));
        if (state.navigateFailures > 0) state.navigateFailures -= 1;
        else state.url = String(message.params.url ?? '');
        respond(socket, message, { frameId: 'F1' });
        return;
      case 'Runtime.evaluate': {
        const expression = String(message.params.expression ?? '');
        if (state.exceptionExpression !== null && expression === state.exceptionExpression) {
          respond(socket, message, {
            result: { type: 'undefined' },
            exceptionDetails: { text: 'boom', exception: { description: 'Error: boom' } },
          });
          return;
        }
        if (expression === 'document.readyState') {
          respond(socket, message, { result: { value: state.readyState } });
          return;
        }
        if (expression === 'location.href') {
          respond(socket, message, { result: { value: state.url } });
          return;
        }
        if (expression === DOUYIN_RECOMMEND_TAB_CLICK_SCRIPT) {
          respond(socket, message, { result: { value: state.clickResult } });
          if (state.clickResult) state.snapshot = state.recommendations;
          return;
        }
        if (expression === DOUYIN_PAGE_READER_SCRIPT) {
          respond(socket, message, { result: { value: state.snapshot } });
          return;
        }
        respond(socket, message, { result: { value: null } });
        return;
      }
      case 'Network.getCookies':
        respond(socket, message, { cookies: state.cookies });
        return;
      default:
        fail(socket, message, -32601, `未实现：${message.method}`);
    }
  };
}

async function connectFake(
  state: FakeBrowserState,
  sleep: (ms: number) => Promise<void> = async () => undefined,
  now: () => number = Date.now,
): Promise<{ connection: CdpConnection; socket: FakeSocket; driver: CdpPageDriver }> {
  const socket = new FakeSocket(fakeBrowserHandler(state));
  const pending = CdpConnection.connect('ws://127.0.0.1:9333/devtools/browser/fake', () => socket);
  socket.open();
  const connection = await pending;
  return { connection, socket, driver: new CdpPageDriver(connection, sleep, now) };
}

// ---------------------------------------------------------------------------
// CDP 连接
// ---------------------------------------------------------------------------

describe('CdpConnection', () => {
  it('按 id 匹配响应，失败响应转成异常，事件按 method 派发', async () => {
    const socket = new FakeSocket((message, self) => {
      if (message.method === 'Ok.method') respond(self, message, { value: 42 });
      else fail(self, message, -32000, '坏了');
    });
    const pending = CdpConnection.connect('ws://127.0.0.1:9333/x', () => socket);
    socket.open();
    const connection = await pending;

    const events: string[] = [];
    const off = connection.onEvent((event) => events.push(event.method));
    socket.receive({ method: 'Page.loadEventFired', params: {} });

    await expect(connection.request('Ok.method')).resolves.toEqual({ value: 42 });
    await expect(connection.request('Bad.method')).rejects.toThrow('坏了');
    expect(events).toEqual(['Page.loadEventFired']);
    off();
    connection.close();
    await expect(connection.request('Ok.method')).rejects.toThrow('CDP 连接已关闭');
  });

  it('CDP 请求无响应时按超时报错，不会永久挂住整轮冒烟', async () => {
    const socket = new FakeSocket(() => undefined);
    const pending = CdpConnection.connect('ws://127.0.0.1:9333/x', () => socket);
    socket.open();
    const connection = await pending;

    await expect(connection.request('Page.navigate', {}, undefined, 10)).rejects.toThrow('超时');
    connection.close();
  });
});

// ---------------------------------------------------------------------------
// 页面驱动
// ---------------------------------------------------------------------------

describe('CdpPageDriver', () => {
  it('绑定 page target、执行只读表达式、只返回 Cookie 名称', async () => {
    const state = createFakeBrowserState();
    state.url = 'https://www.douyin.com/jingxuan';
    state.snapshot = emptySnapshot({ url: state.url, title: '抖音精选', text: '精选 推荐' });
    state.cookies = [
      { name: 'sessionid', value: 'SECRET-VALUE' },
      { name: 'ttwid', value: 'ANOTHER-SECRET' },
    ];
    const { driver } = await connectFake(state);

    await driver.ensurePage();
    await expect(driver.currentUrl()).resolves.toBe('https://www.douyin.com/jingxuan');
    await expect(driver.evaluate<DouyinPageSnapshot>(DOUYIN_PAGE_READER_SCRIPT)).resolves.toMatchObject({
      title: '抖音精选',
    });
    const names = await driver.cookieNames(['https://www.douyin.com']);
    expect(names).toEqual(['sessionid', 'ttwid']);
    expect(names).not.toContain('SECRET-VALUE');
    await driver.bringToFront();
    expect(state.broughtToFront).toBe(1);
  });

  it('页面脚本异常如实抛出，不伪造空结果', async () => {
    const state = createFakeBrowserState();
    state.snapshot = emptySnapshot({ url: 'https://www.douyin.com/jingxuan' });
    state.exceptionExpression = DOUYIN_PAGE_READER_SCRIPT;
    const { driver } = await connectFake(state);
    await driver.ensurePage();
    await expect(driver.evaluate(DOUYIN_PAGE_READER_SCRIPT)).rejects.toThrow('页面读取失败');
  });

  it('导航后轮询 readyState；一直不 complete 则如实超时', async () => {
    const state = createFakeBrowserState();
    state.readyState = 'loading';
    let clock = 0;
    const { driver } = await connectFake(state, async () => undefined, () => (clock += 5_000));
    await expect(driver.navigate('https://www.douyin.com/follow', 12_000)).rejects.toThrow('页面加载超时');
  });

  it('Page.navigate 静默失败（停在 about:blank）：校验 location.href 后重试一次再报错', async () => {
    const state = createFakeBrowserState();
    state.url = 'about:blank';
    state.navigateFailures = 2; // 两次都不跳
    let clock = 0;
    const { driver } = await connectFake(state, async () => undefined, () => (clock += 1_000));
    await expect(driver.navigate('https://www.douyin.com/jingxuan', 3_000)).rejects.toThrow('页面导航失败');
    expect(state.navigations).toEqual([
      'https://www.douyin.com/jingxuan',
      'https://www.douyin.com/jingxuan',
    ]);
  });

  it('第一次静默失败、重试生效时导航成功（只重试一次）', async () => {
    const state = createFakeBrowserState();
    state.url = 'about:blank';
    state.navigateFailures = 1;
    let clock = 0;
    const { driver } = await connectFake(state, async () => undefined, () => (clock += 1_000));
    await expect(driver.navigate('https://www.douyin.com/jingxuan', 3_000)).resolves.toBeUndefined();
    expect(state.url).toBe('https://www.douyin.com/jingxuan');
    expect(state.navigations).toHaveLength(2);
  });

  it('两次都没离开原来的真实页面：不误判为失败（可能是平台重定向），继续交给读取逻辑', async () => {
    const state = createFakeBrowserState();
    state.url = 'https://www.douyin.com/jingxuan';
    state.navigateFailures = 2;
    let clock = 0;
    const { driver } = await connectFake(state, async () => undefined, () => (clock += 1_000));
    await expect(driver.navigate('https://www.douyin.com/video/76814179753662743', 3_000)).resolves.toBeUndefined();
    // 仍重试了一次，但不会把「重定向回同一列表页」误判成导航失败
    expect(state.navigations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 验证码候选元素的可见性过滤（隐藏 verify iframe 误报）
// ---------------------------------------------------------------------------

describe('验证码可见性过滤', () => {
  interface FakeElement {
    getBoundingClientRect: () => { width: number; height: number };
    style: Record<string, string>;
  }

  function visible(width: number, height: number, style: Record<string, string> = {}): boolean {
    const elements: FakeElement[] = [
      {
        getBoundingClientRect: () => ({ width, height }),
        style: { display: 'block', visibility: 'visible', opacity: '1', ...style },
      },
    ];
    const doc = { querySelectorAll: () => elements };
    const getStyle = (el: FakeElement): Record<string, string> => el.style;
    const run = new Function('document', 'getComputedStyle', `return ${DOUYIN_CAPTCHA_VISIBILITY_SCRIPT}`) as unknown as (
      document: unknown,
      getComputedStyle: (el: FakeElement) => Record<string, string>,
    ) => boolean;
    return run(doc, getStyle);
  }

  it('没有候选元素、隐藏、过小、透明的都不算验证码', () => {
    expect(visible(300, 200, { display: 'none' })).toBe(false);
    expect(visible(300, 200, { visibility: 'hidden' })).toBe(false);
    expect(visible(300, 200, { opacity: '0' })).toBe(false);
    expect(visible(120, 200)).toBe(false); // 必须严格 >120×120
    expect(visible(300, 120)).toBe(false);
    expect(visible(0, 0)).toBe(false);
  });

  it('可见且尺寸 >120×120 的候选元素才算真验证码', () => {
    expect(visible(300, 200)).toBe(true);
    expect(visible(121, 121)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 浏览器发现与启动参数（红线检查）
// ---------------------------------------------------------------------------

describe('浏览器发现与启动参数', () => {
  it('macOS 上 Chrome 优先，其次 Edge，都没有返回 null', () => {
    const onlyChrome = (path: string): boolean => path.includes('Google Chrome');
    expect(discoverInstalledBrowser('darwin', onlyChrome)?.name).toBe('Google Chrome');

    const onlyEdge = (path: string): boolean => path.includes('Microsoft Edge');
    expect(discoverInstalledBrowser('darwin', onlyEdge)?.name).toBe('Microsoft Edge');

    expect(discoverInstalledBrowser('darwin', () => false)).toBeNull();
    expect(discoverInstalledBrowser('win32', () => true)).toBeNull();
    expect(describeMissingBrowser()).toContain('不会自行下载或安装浏览器');
  });

  it('启动参数只开回环调试端口与专用 profile，不含 stealth/UA/headless', () => {
    const args = buildLaunchArgs('/tmp/whale-profile', 9333);
    expect(args).toContain('--user-data-dir=/tmp/whale-profile');
    expect(args).toContain('--remote-debugging-port=9333');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    // 防后台节流三参数：窗口被遮挡/后台化后仍继续绘制与跑计时器
    expect(args).toContain('--disable-backgrounding-occluded-windows');
    expect(args).toContain('--disable-renderer-backgrounding');
    expect(args).toContain('--disable-background-timer-throttling');
    const joined = args.join(' ');
    expect(joined).not.toContain('0.0.0.0');
    expect(joined).not.toContain('--disable-blink-features=AutomationControlled');
    expect(joined).not.toContain('--user-agent');
    expect(joined).not.toContain('--headless');
  });

  it('解析 SingletonLock 指向的 PID；非标准格式返回 null', () => {
    const dir = tempDir();
    expect(readProfileLockPid(dir)).toBeNull();
    symlinkSync('Mac-mini.local-4321', join(dir, 'SingletonLock'));
    expect(readProfileLockPid(dir)).toBe(4321);
    rmSync(join(dir, 'SingletonLock'));
    symlinkSync('garbage', join(dir, 'SingletonLock'));
    expect(readProfileLockPid(dir)).toBeNull();
  });

  it('probeCdpEndpoint 拒绝非回环/无效端点', async () => {
    // 无人监听的端口：如实返回 null，而不是抛错
    await expect(probeCdpEndpoint(1, 100)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 单实例与生命周期
// ---------------------------------------------------------------------------

interface HostHarness {
  host: CdpBrowserHost;
  dir: string;
  spawns: string[][];
  endpoint: { value: CdpEndpoint | null };
  alive: Set<number>;
  killed: number[];
}

function makeHost(
  dir: string,
  overrides: {
    probe?: (port: number) => Promise<CdpEndpoint | null>;
    discover?: () => DiscoveredBrowser | null;
    canBindPort?: (port: number) => Promise<boolean>;
    alive?: Set<number>;
    now?: () => number;
  } = {},
): HostHarness {
  const spawns: string[][] = [];
  const killed: number[] = [];
  const alive = overrides.alive ?? new Set<number>();
  const endpoint = {
    value: { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/fake', browser: 'Chrome/158' },
  };
  let clock = 0;
  const host = new CdpBrowserHost({
    profileDir: dir,
    port: 9333,
    now: overrides.now ?? (() => (clock += 1)),
    sleep: async () => undefined,
    discover: overrides.discover ?? (() => CHROME),
    probe: overrides.probe ?? (async () => endpoint.value),
    canBindPort: overrides.canBindPort ?? (async () => true),
    launch: (_browser, args): BrowserChildLike => {
      spawns.push(args);
      alive.add(9001);
      return {
        pid: 9001,
        kill: () => true,
        on: () => undefined,
      };
    },
    isPidAlive: (pid) => alive.has(pid),
    killPid: (pid) => {
      killed.push(pid);
      alive.delete(pid);
    },
    connectTimeoutMs: 2_000,
  });
  return { host, dir, spawns, endpoint, alive, killed };
}

function writeInstanceMarker(dir: string, marker: { pid: number; port?: number }): void {
  writeFileSync(
    join(dir, 'whale-cdp-instance.json'),
    JSON.stringify({
      schemaVersion: 1,
      pid: marker.pid,
      port: marker.port ?? 9333,
      browser: 'Google Chrome',
      startedAt: 1,
    }),
    'utf8',
  );
}

describe('CdpBrowserHost 单实例与生命周期', () => {
  it('launchIfMissing=false 时只复用、不启动浏览器', async () => {
    const dir = tempDir();
    const h = makeHost(dir, { probe: async () => null });
    await expect(h.host.ensure(false)).resolves.toBeNull();
    expect(h.spawns).toHaveLength(0);
  });

  it('已有实例（标记 + CDP 有响应）直接复用；清理只删锁不删 profile', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'keep-me.txt'), 'login-state-placeholder', 'utf8');
    writeInstanceMarker(dir, { pid: 4321 });
    symlinkSync('Mac-mini.local-4321', join(dir, 'SingletonLock'));
    const h = makeHost(dir, { alive: new Set([4321]) });

    const first = await h.host.ensure(true);
    expect(first?.port).toBe(9333);
    expect(first?.pid).toBe(4321);
    expect(h.spawns).toHaveLength(0);
    expect(h.host.isRunning()).toBe(true);

    await h.host.cleanup();
    expect(existsSync(join(dir, 'keep-me.txt'))).toBe(true); // 登录态/profile 目录必须保住
    expect(existsSync(join(dir, 'whale-cdp-instance.json'))).toBe(false);
    expect(existsSync(join(dir, 'SingletonLock'))).toBe(false);
    expect(h.killed).toEqual([4321]);
  });

  it('无实例时启动一次并写标记；第二次 ensure 复用同一实例，绝不起第二个', async () => {
    const dir = tempDir();
    const spawns: string[][] = [];
    const alive = new Set<number>();
    let up = false;
    const host = new CdpBrowserHost({
      profileDir: dir,
      port: 9333,
      now: (() => {
        let clock = 0;
        return () => (clock += 1);
      })(),
      sleep: async () => undefined,
      discover: () => CHROME,
      probe: async () =>
        up ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/fake', browser: 'Chrome/158' } : null,
      canBindPort: async () => true,
      launch: (_b, args) => {
        spawns.push(args);
        up = true;
        alive.add(9001);
        return { pid: 9001, kill: () => true, on: () => undefined };
      },
      isPidAlive: (pid) => alive.has(pid),
      killPid: () => undefined,
      connectTimeoutMs: 2_000,
    });

    const first = await host.ensure(true);
    expect(first?.pid).toBe(9001);
    expect(spawns).toHaveLength(1);
    expect(existsSync(join(dir, 'whale-cdp-instance.json'))).toBe(true);

    const second = await host.ensure(true);
    expect(second?.pid).toBe(9001);
    expect(spawns).toHaveLength(1);
  });

  it('标记进程还活着但 CDP 无响应：明确报错，绝不起第二个', async () => {
    const dir = tempDir();
    writeInstanceMarker(dir, { pid: 7777 });
    const h = makeHost(dir, { probe: async () => null, alive: new Set([7777]) });
    await expect(h.host.ensure(true)).rejects.toThrow('CDP 调试端口无响应');
    expect(h.spawns).toHaveLength(0);
  });

  it('僵死标记（进程已死）只清理锁与标记，然后正常启动', async () => {
    const dir = tempDir();
    writeInstanceMarker(dir, { pid: 6666 });
    symlinkSync('Mac-mini.local-6666', join(dir, 'SingletonLock'));
    writeFileSync(join(dir, 'keep-me.txt'), 'login-state-placeholder', 'utf8');
    const spawns: string[][] = [];
    const alive = new Set<number>();
    let up = false;
    const host = new CdpBrowserHost({
      profileDir: dir,
      port: 9333,
      now: (() => {
        let clock = 0;
        return () => (clock += 1);
      })(),
      sleep: async () => undefined,
      discover: () => CHROME,
      probe: async () => (up ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/x', browser: 'Chrome' } : null),
      canBindPort: async () => true,
      launch: (_b, args) => {
        spawns.push(args);
        up = true;
        alive.add(9002);
        return { pid: 9002, kill: () => true, on: () => undefined };
      },
      isPidAlive: (pid) => alive.has(pid),
      killPid: () => undefined,
      connectTimeoutMs: 2_000,
    });

    const instance = await host.ensure(true);
    expect(instance?.pid).toBe(9002);
    expect(spawns).toHaveLength(1);
    expect(existsSync(join(dir, 'keep-me.txt'))).toBe(true); // 清锁不碰 profile 内容
    const marker = JSON.parse(readFileSync(join(dir, 'whale-cdp-instance.json'), 'utf8')) as { pid: number };
    expect(marker.pid).toBe(9002);
  });

  it('profile 被非本程序实例占用（SingletonLock 指向活进程）：如实报错', async () => {
    const dir = tempDir();
    symlinkSync('Mac-mini.local-5555', join(dir, 'SingletonLock'));
    const h = makeHost(dir, { alive: new Set([5555]) });
    await expect(h.host.ensure(true)).rejects.toThrow('已被另一个浏览器实例占用');
    expect(h.spawns).toHaveLength(0);
  });

  it('没有真实浏览器时如实 BLOCKED，不自行下载安装', async () => {
    const dir = tempDir();
    const h = makeHost(dir, { discover: () => null, probe: async () => null });
    await expect(h.host.ensure(true)).rejects.toThrow('未找到 Google Chrome 或 Microsoft Edge');
    expect(h.spawns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DouyinWebSession 契约
// ---------------------------------------------------------------------------

class FakeDriver implements DouyinCdpDriver {
  readonly navigations: string[] = [];
  readonly evaluateCalls: string[] = [];
  url = 'about:blank';
  snapshot: DouyinPageSnapshot = emptySnapshot();
  /** 依次返回的页面快照；用来模拟「视频数据加载中 → 详情字段填充」 */
  snapshotQueue: DouyinPageSnapshot[] | null = null;
  clickResult = true;
  afterClickSnapshot: DouyinPageSnapshot | null = null;
  cookieList: string[] = [];
  broughtToFront = 0;

  async ensurePage(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    this.url = url;
  }
  async evaluate<T>(expression: string): Promise<T> {
    this.evaluateCalls.push(expression);
    if (expression === DOUYIN_RECOMMEND_TAB_CLICK_SCRIPT) {
      if (this.clickResult && this.afterClickSnapshot !== null) this.snapshot = this.afterClickSnapshot;
      this.url = 'https://www.douyin.com/?recommend=1';
      return this.clickResult as T;
    }
    if (expression === 'location.href') return this.url as T;
    if (this.snapshotQueue !== null) {
      const next = this.snapshotQueue.length > 1 ? this.snapshotQueue.shift() : this.snapshotQueue[0];
      if (next !== undefined) return next as T;
    }
    return this.snapshot as T;
  }
  async cookieNames(): Promise<string[]> {
    return this.cookieList;
  }
  async currentUrl(): Promise<string> {
    return this.url;
  }
  async bringToFront(): Promise<void> {
    this.broughtToFront += 1;
  }
}

class FakeHost implements BrowserHostLike {
  running = false;
  instance: BrowserInstance | null = {
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/fake',
    port: 9333,
    pid: 9001,
    browser: CHROME,
  };
  ensureCalls: boolean[] = [];
  cleaned = 0;

  async ensure(launchIfMissing: boolean): Promise<BrowserInstance | null> {
    this.ensureCalls.push(launchIfMissing);
    if (this.instance !== null) this.running = true;
    return this.instance;
  }
  isRunning(): boolean {
    return this.running;
  }
  async cleanup(): Promise<void> {
    this.cleaned += 1;
    this.running = false;
  }
}

function makeSession(
  driver: FakeDriver,
  host = new FakeHost(),
  options: { renderTimeoutMs?: number; itemRenderTimeoutMs?: number } = {},
): { session: RealBrowserDouyinSession; host: FakeHost; closed: () => number } {
  let closes = 0;
  const attachment: CdpBrowserAttachment = {
    browser: CHROME,
    driver,
    async closeBrowser(): Promise<void> {
      closes += 1;
    },
  };
  const session = new RealBrowserDouyinSession({
    profileDir: '/tmp/whale-cdp-fake-profile',
    host,
    attach: async () => attachment,
    sleep: async () => undefined,
    renderTimeoutMs: options.renderTimeoutMs ?? 5_000,
    itemRenderTimeoutMs: options.itemRenderTimeoutMs ?? 5_000,
    // 每次读时间前进 1s：只读等待循环在 fake 下快速收敛，不真实 sleep
    now: (() => {
      let clock = 0;
      return () => (clock += 1_000);
    })(),
  });
  return { session, host, closed: () => closes };
}

describe('RealBrowserDouyinSession 契约', () => {
  it('load 只做导航 + 只读快照；验证码标题原样返回给上层判断', async () => {
    const driver = new FakeDriver();
    driver.snapshot = { url: 'https://www.douyin.com/jingxuan', title: '验证码中间页', text: '', cards: [] };
    const { session } = makeSession(driver);

    const snapshot = await session.load('https://www.douyin.com/jingxuan');
    expect(driver.navigations).toEqual(['https://www.douyin.com/jingxuan']);
    expect(snapshot.title).toBe('验证码中间页');
    expect(snapshot.cards).toHaveLength(0);
  });

  it('视频页「加载中」壳先空后有：load 用更长的单条等待，不把还在渲染误判成没有公开字段', async () => {
    const driver = new FakeDriver();
    driver.snapshotQueue = [
      // 刚导航到的壳：标题空、正文只有导航/页脚，h1 与 detail 都还没填充
      emptySnapshot({ url: 'https://www.douyin.com/video/7682712994194722091', title: '', text: '视频数据加载中' }),
      // 详情字段到位
      emptySnapshot({
        url: 'https://www.douyin.com/video/7682712994194722091',
        title: '示例视频 - 抖音',
        text: '正文',
        heading: '示例视频标题',
        author: '示例作者',
        detailText: '示例视频标题\n1.2万\n发布时间：2026-11-01',
      }),
    ];
    // feed 等待 1s，单条等待 5s：只有 load 用了 itemRenderTimeoutMs 才能读到第二条
    const { session } = makeSession(driver, new FakeHost(), {
      renderTimeoutMs: 1_000,
      itemRenderTimeoutMs: 5_000,
    });

    const snapshot = await session.load('https://www.douyin.com/video/7682712994194722091');
    expect(snapshot.heading).toBe('示例视频标题');
    expect(snapshot.detailText).toContain('发布时间');
  });

  it('SPA 过渡期的「旧标题 + 空正文」不算验证码，继续等到详情字段真正渲染', async () => {
    const driver = new FakeDriver();
    driver.snapshotQueue = [
      // 真机回归样本：导航到视频页的瞬间，document.title 还是上一页的标题，正文尚未挂载
      emptySnapshot({ url: 'https://www.douyin.com/video/7711592121379065115', title: '抖音-记录美好生活', text: '' }),
      emptySnapshot({
        url: 'https://www.douyin.com/video/7711592121379065115',
        title: '示例视频 - 抖音',
        text: '正文',
        heading: '示例视频标题',
        author: '示例作者',
        detailText: '示例视频标题\n发布时间：2026-11-01',
      }),
    ];
    const { session } = makeSession(driver, new FakeHost(), {
      renderTimeoutMs: 1_000,
      itemRenderTimeoutMs: 5_000,
    });

    const snapshot = await session.load('https://www.douyin.com/video/7711592121379065115');
    expect(driver.evaluateCalls.filter((call) => call === DOUYIN_PAGE_READER_SCRIPT).length).toBeGreaterThan(1);
    expect(snapshot.heading).toBe('示例视频标题');
  });

  it('直跳 /video/<id> 被重定向回精选页：降级用 ?modal_id=<id> 再读一次', async () => {
    const driver = new FakeDriver();
    const awemeId = '7682712994194722091';
    driver.snapshotQueue = [
      emptySnapshot({
        url: 'https://www.douyin.com/jingxuan',
        title: '抖音精选',
        text: '精选 推荐',
        cards: [{ videoId: awemeId, text: '公开视频' }],
      }),
      emptySnapshot({
        url: `https://www.douyin.com/?modal_id=${awemeId}`,
        title: '示例视频 - 抖音',
        text: '正文',
        heading: '示例视频标题',
        detailText: '示例视频标题\n发布时间：2026-11-01',
      }),
    ];
    const { session } = makeSession(driver, new FakeHost(), {
      renderTimeoutMs: 1_000,
      itemRenderTimeoutMs: 5_000,
    });

    const snapshot = await session.load(`https://www.douyin.com/video/${awemeId}`);
    expect(driver.navigations).toEqual([
      `https://www.douyin.com/video/${awemeId}`,
      `https://www.douyin.com/?modal_id=${awemeId}`,
    ]);
    expect(snapshot.heading).toBe('示例视频标题');
  });

  it('modal_id 备用路径是「列表 + 弹层」：不会因卡片存在就提前结束等待', async () => {
    const driver = new FakeDriver();
    const awemeId = '7682712994194722091';
    driver.snapshotQueue = [
      emptySnapshot({
        url: 'https://www.douyin.com/jingxuan',
        title: '抖音精选',
        text: '精选',
        cards: [{ videoId: awemeId, text: '公开视频' }],
      }),
      emptySnapshot({
        url: `https://www.douyin.com/?modal_id=${awemeId}`,
        title: '抖音精选',
        text: '精选',
        cards: [{ videoId: awemeId, text: '公开视频' }],
      }),
      emptySnapshot({
        url: `https://www.douyin.com/?modal_id=${awemeId}`,
        title: '示例视频 - 抖音',
        text: '正文',
        heading: '示例视频标题',
        detailText: '示例视频标题\n发布时间：2026-11-01',
      }),
    ];
    const { session } = makeSession(driver, new FakeHost(), {
      renderTimeoutMs: 1_000,
      itemRenderTimeoutMs: 5_000,
    });

    const snapshot = await session.load(`https://www.douyin.com/video/${awemeId}`);
    expect(snapshot.heading).toBe('示例视频标题');
  });

  it('直跳视频页撞验证码：立即返回真实快照，绝不借 modal_id 降级再导航', async () => {
    const driver = new FakeDriver();
    const awemeId = '7682712994194722091';
    driver.snapshot = emptySnapshot({
      url: 'https://www.douyin.com/verify/captcha',
      title: '安全验证',
      text: '请完成下方验证',
    });
    const { session } = makeSession(driver, new FakeHost(), {
      renderTimeoutMs: 1_000,
      itemRenderTimeoutMs: 5_000,
    });
    const snapshot = await session.load(`https://www.douyin.com/video/${awemeId}`);
    expect(snapshot.title).toBe('安全验证');
    expect(driver.navigations).toEqual([`https://www.douyin.com/video/${awemeId}`]);
  });

  it('直跳视频页本身可读时不做 modal_id 降级；非详情地址也不走备用路径', async () => {
    const driver = new FakeDriver();
    const awemeId = '7682712994194722091';
    driver.snapshot = emptySnapshot({
      url: `https://www.douyin.com/video/${awemeId}`,
      title: '示例视频 - 抖音',
      text: '正文',
      heading: '示例视频标题',
      detailText: '示例视频标题\n发布时间：2026-11-01',
    });
    const { session } = makeSession(driver);
    await session.load(`https://www.douyin.com/video/${awemeId}`);
    expect(driver.navigations).toEqual([`https://www.douyin.com/video/${awemeId}`]);

    const feedDriver = new FakeDriver();
    feedDriver.snapshot = emptySnapshot({
      url: 'https://www.douyin.com/jingxuan',
      title: '抖音精选',
      text: '精选',
      cards: [{ videoId: awemeId, text: '公开视频' }],
    });
    const feedSession = makeSession(feedDriver).session;
    await feedSession.load('https://www.douyin.com/jingxuan');
    expect(feedDriver.navigations).toEqual(['https://www.douyin.com/jingxuan']);
  });

  it('openFeed(recommended) 走精选页 + 页内点「推荐」标签；openFeed(following) 直接打开 /follow', async () => {
    const driver = new FakeDriver();
    driver.afterClickSnapshot = emptySnapshot({
      url: 'https://www.douyin.com/?recommend=1',
      title: '抖音推荐',
      text: '推荐',
      cards: [{ videoId: '76814179753662743', text: '公开视频' }],
    });
    const { session } = makeSession(driver);

    const recommended = await session.openFeed('recommended');
    expect(driver.navigations).toContain('https://www.douyin.com/jingxuan');
    expect(driver.evaluateCalls).toContain(DOUYIN_RECOMMEND_TAB_CLICK_SCRIPT);
    expect(recommended.url).toContain('recommend=1');
    expect(recommended.cards).toHaveLength(1);

    await session.openFeed('following');
    expect(driver.navigations).toContain('https://www.douyin.com/follow');
  });

  it('loginState 只认 Cookie 名称；未启动浏览器时不启动也不假装已登录', async () => {
    const driver = new FakeDriver();
    const host = new FakeHost();
    host.instance = null;
    const { session } = makeSession(driver, host);
    await expect(session.loginState()).resolves.toEqual({ loggedIn: false });
    expect(host.ensureCalls).toEqual([false]);

    host.instance = {
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/x',
      port: 9333,
      pid: 9001,
      browser: CHROME,
    };
    driver.cookieList = ['ttwid', 'sessionid_ss'];
    await expect(session.loginState()).resolves.toEqual({ loggedIn: true });
  });

  it('openLoginWindow 只把窗口留给 owner：切前台，必要时打开抖音首页，不点登录', async () => {
    const driver = new FakeDriver();
    const { session } = makeSession(driver);
    await session.openLoginWindow();
    expect(driver.broughtToFront).toBeGreaterThanOrEqual(1);
    expect(driver.navigations).toEqual(['https://www.douyin.com/']);

    // 已经在抖音页面（含验证码页）时不重新导航，避免把「停下」变成「重试」
    driver.url = 'https://www.douyin.com/jingxuan';
    await session.openLoginWindow();
    expect(driver.navigations).toEqual(['https://www.douyin.com/']);
  });

  it('dispose 关闭浏览器并清理实例标记/锁（不删 profile 目录）', async () => {
    const driver = new FakeDriver();
    const { session, host, closed } = makeSession(driver);
    await session.load('https://www.douyin.com/jingxuan');
    await session.dispose();
    expect(closed()).toBe(1);
    expect(host.cleaned).toBe(1);
  });

  it('拒绝非 http/https 导航', async () => {
    const { session } = makeSession(new FakeDriver());
    await expect(session.load('file:///etc/passwd')).rejects.toThrow('只允许 http/https');
  });

  it('实例拿不到时给出可操作指引（先点扫码登录）', async () => {
    const host = new FakeHost();
    host.instance = null;
    const { session } = makeSession(new FakeDriver(), host);
    await expect(session.load('https://www.douyin.com/jingxuan')).rejects.toThrow('扫码登录');
  });
});
