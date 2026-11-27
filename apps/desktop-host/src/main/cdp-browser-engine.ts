/**
 * V2-P3-04K 抖音只读「真浏览器 + 专用持久 profile + CDP」驱动。
 *
 * 背景（P3-04J §4.3 方案 A）：此前用 Electron 隔离 partition 的嵌入式 Chromium 读取抖音，
 * 2026-11-27 真实冒烟撞上「验证码中间页」。本驱动把「用什么浏览器看」换成本机真实
 * Google Chrome / Microsoft Edge，以专用持久 profile 启动，通过 127.0.0.1 的 CDP 只读驱动。
 *
 * 这不是「保证不撞验证码」——只把浏览上下文从「全新隔离 partition」换成「像正常浏览」。
 * 撞到验证码仍然立即停止、保留窗口、交给 owner 亲手处理，绝不识别/绕过/重试/改 UA/stealth。
 *
 * 硬约束（owner 拍板，逐条写死）：
 * - R1 严格只读：本文件不暴露任何点赞/关注/评论/私信/发布入口，只做导航与 DOM 文本读取。
 * - R2 不绕过验证码/风控/登录墙：只把页面真相返回给上层，由 `social-douyin.ts` 立即停下。
 * - R3 不逆向签名接口、不伪造请求：只通过浏览器页面本身加载公开页面。
 * - R4 不改 UA / 不做 stealth / 不加 `--disable-blink-features=AutomationControlled`。
 * - R5 只用 owner 本人会话：登录窗口留给 owner 亲手扫码；只检查 Cookie 名称，不导出/不落盘 Cookie 值。
 * - 单实例：同一份 profile 只允许一个浏览器实例；已有实例时复用或明确报错，绝不硬起第二个。
 * - 生命周期：退出时优先 `Browser.close`，再兜底 kill；只删锁文件/实例标记，绝不删 profile 目录。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  DouyinFeedKind,
  DouyinLoginState,
  DouyinPageSnapshot,
  DouyinWebSession,
} from '@workbench/character-core';
import { DOUYIN_FEED_URLS, detectDouyinBlock } from '@workbench/character-core';
import { DOUYIN_PAGE_READER_SCRIPT, DOUYIN_RECOMMEND_TAB_CLICK_SCRIPT } from './douyin-page-reader';

/** 驱动选择：真浏览器 CDP（默认）或保留的 Electron 隔离 partition 引擎 */
export const DOUYIN_BROWSER_DRIVER_KINDS = ['cdp-real', 'electron'] as const;
export type DouyinBrowserDriverKind = (typeof DOUYIN_BROWSER_DRIVER_KINDS)[number];
export const DouyinBrowserDriverKindSchema = z.enum(DOUYIN_BROWSER_DRIVER_KINDS);

/** 宿主内部配置（不是跨进程契约，故不进 shared-protocol） */
export const DouyinBrowserConfigSchema = z.object({
  driver: DouyinBrowserDriverKindSchema.default('cdp-real'),
  /** CDP 调试端口；只绑定 127.0.0.1。被占用时会在邻近端口里另选，并写进实例标记 */
  remoteDebuggingPort: z.number().int().min(1024).max(65535).default(9333),
});
export type DouyinBrowserConfig = z.output<typeof DouyinBrowserConfigSchema>;

/** 登录态只看这几个 Cookie 名称；值永不读取、永不返回、永不落盘 */
export const DOUYIN_LOGIN_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_guard'] as const;

const DEFAULT_DEBUG_PORT = 9333;
const PORT_SCAN_LIMIT = 20;
const CONNECT_TIMEOUT_MS = 20_000;
const NAVIGATE_TIMEOUT_MS = 20_000;
const CDP_REQUEST_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 8_000;
/**
 * 单个视频页的公开字段渲染等待：真浏览器冷启动直达 `/video/<id>` 时，
 * 抖音会先显示「视频数据加载中」壳（标题为空、正文只有导航与页脚），
 * 详情字段通常要十几秒才填充。这里给足 25s，避免把「还在加载」误判成「没有公开字段」。
 * 验证码中间页一旦被 `detectDouyinBlock` 判定为 captcha，readRich 会立即早退，
 * 不把「撞风控」拖成 25s 的干等。
 */
const ITEM_RENDER_TIMEOUT_MS = 25_000;
const PROBE_TIMEOUT_MS = 900;
const MARKER_FILE = 'whale-cdp-instance.json';
const PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;

// ---------------------------------------------------------------------------
// 浏览器探测（macOS：Chrome 优先，其次 Edge；都没有如实报 BLOCKED）
// ---------------------------------------------------------------------------

export interface DiscoveredBrowser {
  /** 用于 `open -a` / 错误文案的可读名 */
  readonly name: 'Google Chrome' | 'Microsoft Edge';
  readonly appPath: string;
  readonly executablePath: string;
}

const MAC_BROWSERS: readonly DiscoveredBrowser[] = [
  {
    name: 'Google Chrome',
    appPath: '/Applications/Google Chrome.app',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  {
    name: 'Microsoft Edge',
    appPath: '/Applications/Microsoft Edge.app',
    executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  },
];

/**
 * 探测本机已安装的真实浏览器。只认系统标准安装位置，不去下载/安装任何浏览器。
 * 非 macOS 返回 null（本工单只对 macOS 真机验证；Windows 继续用 Electron 驱动）。
 */
export function discoverInstalledBrowser(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): DiscoveredBrowser | null {
  if (platform !== 'darwin') return null;
  for (const browser of MAC_BROWSERS) {
    if (exists(browser.appPath) && exists(browser.executablePath)) return browser;
  }
  return null;
}

export function describeMissingBrowser(): string {
  return [
    'BLOCKED：本机未找到 Google Chrome 或 Microsoft Edge，无法启动真浏览器读取抖音。',
    '请先安装 Chrome/Edge，或把 v2-douyin-browser.json 的 driver 改为 electron 使用保留的 Electron 引擎；',
    '鲸屿不会自行下载或安装浏览器。',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// 实例标记 / profile 锁（只删锁文件，绝不删 profile 目录）
// ---------------------------------------------------------------------------

export interface InstanceMarker {
  schemaVersion: 1;
  pid: number;
  port: number;
  browser: string;
  startedAt: number;
}

const InstanceMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1024).max(65535),
  browser: z.string().max(100).default(''),
  startedAt: z.number().int().nonnegative().default(0),
});

function markerPath(profileDir: string): string {
  return join(profileDir, MARKER_FILE);
}

function readMarker(profileDir: string): InstanceMarker | null {
  const file = markerPath(profileDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = InstanceMarkerSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeMarker(profileDir: string, marker: InstanceMarker): void {
  const file = markerPath(profileDir);
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(marker, null, 1)}\n`;
  writeFileSync(tmp, body, 'utf8');
  try {
    renameSync(tmp, file);
  } catch {
    // 极少数文件系统不支持同目录 rename：退回直接写，仍然只动标记文件
    writeFileSync(file, body, 'utf8');
    rmSync(tmp, { force: true });
  }
}

/** 解析 SingletonLock 指向的 PID（格式 `<hostname>-<pid>`）；解析不出返回 null */
export function readProfileLockPid(profileDir: string): number | null {
  const lock = join(profileDir, 'SingletonLock');
  try {
    // 注意：Chromium 的 SingletonLock 是指向不存在目标的悬空软链接，
    // 不能用 existsSync（会跟随链接返回 false），必须直接 readlink。
    const target = readlinkSync(lock);
    const match = /-(\d+)$/u.exec(target);
    if (!match || match[1] === undefined) return null;
    const pid = Number.parseInt(match[1], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 只删除实例标记与 Chromium 的 Singleton* 锁文件；绝不递归删除 profile 目录 */
function removeStaleLockFiles(profileDir: string): void {
  for (const name of PROFILE_LOCK_FILES) {
    rmSync(join(profileDir, name), { force: true });
  }
  rmSync(markerPath(profileDir), { force: true });
}

// ---------------------------------------------------------------------------
// CDP 连接（零新增依赖：Node 22.12+/Electron 内置全局 WebSocket）
// ---------------------------------------------------------------------------

/** 只声明本驱动用到的 WebSocket 子集，便于单测注入假 socket */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** 当前运行时应带全局 WebSocket（Node ≥22.12 / Electron 45）；缺失时给出明确错误 */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!ctor) {
    throw new Error('当前运行时没有全局 WebSocket（需要 Node ≥22.12 / Electron 45），无法连接 CDP');
  }
  return new ctor(url) as WebSocketLike;
};

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

export type CdpEventListener = (event: {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}) => void;

/** 最小 CDP 客户端：按 id 匹配响应，按 method 派发事件 */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<CdpEventListener>();
  private closed = false;

  private constructor(private readonly socket: WebSocketLike) {}

  static connect(url: string, factory: WebSocketFactory = defaultWebSocketFactory): Promise<CdpConnection> {
    const socket = factory(url);
    const connection = new CdpConnection(socket);
    return new Promise<CdpConnection>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10_000);
      socket.onopen = () => {
        clearTimeout(timer);
        connection.attach();
        resolve(connection);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败'));
      };
      socket.onclose = () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 在连接完成前关闭'));
      };
    });
  }

  private attach(): void {
    this.socket.onmessage = (event) => {
      this.handle(typeof event.data === 'string' ? event.data : String(event.data));
    };
    this.socket.onclose = () => {
      this.closed = true;
      this.rejectAll(new Error('CDP 连接已关闭'));
    };
    this.socket.onerror = () => {
      this.rejectAll(new Error('CDP 连接错误'));
    };
  }

  private rejectAll(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private handle(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error(`CDP ${message.error.code}：${message.error.message}`));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      const event = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
      };
      for (const listener of [...this.listeners]) listener(event);
    }
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      // 页面在请求途中跳走/target 脱离时，CDP 可能永远不回包：必须自己兜底超时，
      // 否则冒烟会像死机一样挂住，既不报错也不结束。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms 无响应）`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('CDP 连接已关闭'));
    try {
      this.socket.close();
    } catch {
      // 已断开：忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 页面级只读驱动
// ---------------------------------------------------------------------------

export interface DouyinCdpDriver {
  /** 绑定/复用浏览器里的一个 page target，并 attach 出 sessionId */
  ensurePage(): Promise<void>;
  navigate(url: string, timeoutMs: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** 只返回 Cookie 名称；值在驱动内部即丢弃，不返回、不落盘、不打印 */
  cookieNames(urls: string[]): Promise<string[]>;
  currentUrl(): Promise<string>;
  bringToFront(): Promise<void>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export class CdpPageDriver implements DouyinCdpDriver {
  private sessionId: string | null = null;

  constructor(
    private readonly connection: CdpConnection,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  async ensurePage(): Promise<void> {
    if (this.sessionId !== null) return;
    const targets = await this.connection.request<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const pages = targets.targetInfos.filter((target) => target.type === 'page');
    const page =
      pages.find((target) => target.url.includes('douyin.com')) ??
      pages.find((target) => target.url === 'about:blank') ??
      pages[0];
    let targetId = page?.targetId;
    if (targetId === undefined) {
      const created = await this.connection.request<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      targetId = created.targetId;
    }
    const attached = await this.connection.request<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.connection.request('Page.enable', {}, this.sessionId);
    await this.connection.request('Runtime.enable', {}, this.sessionId);
  }

  async navigate(url: string, timeoutMs: number): Promise<void> {
    await this.ensurePage();
    const result = await this.connection.request<{ errorText?: string } | undefined>(
      'Page.navigate',
      { url },
      this.requireSession(),
    );
    if (result?.errorText !== undefined && result.errorText !== '') {
      throw new Error(`页面导航失败：${result.errorText}`);
    }
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const state = await this.evaluate<string>('document.readyState');
      if (state === 'complete') return;
      await this.sleep(200);
    }
    throw new Error(`页面加载超时（${Math.round(timeoutMs / 1000)}s）：${url}`);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.connection.request<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.requireSession(),
    );
    if (response.exceptionDetails !== undefined) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        '页面脚本执行异常';
      throw new Error(`页面读取失败：${detail}`);
    }
    return response.result?.value as T;
  }

  async cookieNames(urls: string[]): Promise<string[]> {
    await this.ensurePage();
    const response = await this.connection.request<{ cookies: Array<{ name: string }> }>(
      'Network.getCookies',
      { urls },
      this.requireSession(),
    );
    // 只取 name：value 在本方法内即丢弃，永不返回/打印/落盘（R5）
    return response.cookies.map((cookie) => cookie.name);
  }

  async currentUrl(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async bringToFront(): Promise<void> {
    await this.ensurePage();
    await this.connection.request('Page.bringToFront', {}, this.requireSession());
  }

  private requireSession(): string {
    if (this.sessionId === null) throw new Error('CDP page 尚未绑定');
    return this.sessionId;
  }
}

// ---------------------------------------------------------------------------
// 浏览器实例管理（发现 / 单实例 / 启动 / 复用 / 清理）
// ---------------------------------------------------------------------------

export interface CdpEndpoint {
  webSocketDebuggerUrl: string;
  browser: string;
}

export interface BrowserChildLike {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
}

export interface BrowserInstance {
  webSocketDebuggerUrl: string;
  port: number;
  pid: number;
  browser: DiscoveredBrowser;
}

export interface CdpBrowserHostOptions {
  profileDir: string;
  port?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  exists?: (path: string) => boolean;
  discover?: () => DiscoveredBrowser | null;
  probe?: (port: number) => Promise<CdpEndpoint | null>;
  canBindPort?: (port: number) => Promise<boolean>;
  launch?: (browser: DiscoveredBrowser, args: string[]) => BrowserChildLike;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  connectTimeoutMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(url: string, timeoutMs: number): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = httpRequest(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64_000) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(body) as unknown);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** 探测 127.0.0.1 上的 CDP 端点；只接受回环地址 */
export async function probeCdpEndpoint(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<CdpEndpoint | null> {
  const raw = await httpGetJson(`http://127.0.0.1:${port}/json/version`, timeoutMs);
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const wsUrl = typeof record.webSocketDebuggerUrl === 'string' ? record.webSocketDebuggerUrl : '';
  if (wsUrl === '') return null;
  try {
    const url = new URL(wsUrl);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
  } catch {
    return null;
  }
  return {
    webSocketDebuggerUrl: wsUrl,
    browser: typeof record.Browser === 'string' ? record.Browser : '',
  };
}

/** 端口是否能在 127.0.0.1 上独占绑定（避免抢别的进程正在用的端口） */
export function canBindLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/**
 * 真浏览器宿主：同一份专用 profile 只允许一个实例。
 * - 有实例（标记 + CDP 有响应）→ 复用；
 * - 有进程但 CDP 无响应 → 明确报错，绝不硬起第二个；
 * - 锁文件是僵死进程留下的 → 只删锁文件与标记，绝不删 profile 目录。
 */
export class CdpBrowserHost {
  private readonly profileDir: string;
  private readonly preferredPort: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly exists: (path: string) => boolean;
  private readonly discover: () => DiscoveredBrowser | null;
  private readonly probe: (port: number) => Promise<CdpEndpoint | null>;
  private readonly canBindPort: (port: number) => Promise<boolean>;
  private readonly launch: (browser: DiscoveredBrowser, args: string[]) => BrowserChildLike;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
  private readonly connectTimeoutMs: number;

  constructor(options: CdpBrowserHostOptions) {
    this.profileDir = options.profileDir;
    this.preferredPort = options.port ?? DEFAULT_DEBUG_PORT;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.exists = options.exists ?? existsSync;
    this.discover = options.discover ?? (() => discoverInstalledBrowser(options.platform ?? process.platform, this.exists));
    this.probe = options.probe ?? ((port) => probeCdpEndpoint(port));
    this.canBindPort = options.canBindPort ?? canBindLoopbackPort;
    this.launch = options.launch ?? defaultLaunchBrowser;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.killPid = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  /** 当前是否有本驱动启动、且进程仍存活的实例（同步、不发网络请求） */
  isRunning(): boolean {
    const marker = readMarker(this.profileDir);
    return marker !== null && this.isPidAlive(marker.pid);
  }

  /**
   * 取得一个可用的 CDP 实例。
   * @param launchIfMissing false 时只复用已运行实例，不启动新浏览器（用于登录态探测）。
   */
  async ensure(launchIfMissing: boolean): Promise<BrowserInstance | null> {
    mkdirSync(this.profileDir, { recursive: true });

    const marker = readMarker(this.profileDir);
    if (marker !== null) {
      const endpoint = await this.probe(marker.port);
      if (endpoint !== null) {
        return this.toInstance(marker, endpoint);
      }
      if (this.isPidAlive(marker.pid)) {
        throw new Error(
          '检测到抖音专用浏览器进程仍在运行，但 CDP 调试端口无响应。为避免第二个实例抢同一份 profile、破坏登录态，已停止；请关闭该浏览器窗口后重试。',
        );
      }
      // 僵死实例：只删标记与锁文件，profile 目录原样保留
      removeStaleLockFiles(this.profileDir);
    } else {
      const lockPid = readProfileLockPid(this.profileDir);
      if (lockPid !== null && this.isPidAlive(lockPid)) {
        throw new Error(
          '该抖音专用 profile 已被另一个浏览器实例占用（不是鲸屿启动的）。请先关闭那个浏览器窗口；鲸屿绝不会硬起第二个实例抢同一份 profile。',
        );
      }
      if (lockPid !== null) removeStaleLockFiles(this.profileDir);
    }

    if (!launchIfMissing) return null;

    const browser = this.discover();
    if (browser === null) throw new Error(describeMissingBrowser());

    const port = await this.pickPort();
    const args = buildLaunchArgs(this.profileDir, port);
    const child = this.launch(browser, args);
    let exitCode: number | null | undefined;
    child.on('exit', (code) => {
      exitCode = code;
    });
    const pid = child.pid ?? 0;
    if (pid <= 0) {
      child.kill('SIGTERM');
      removeStaleLockFiles(this.profileDir);
      throw new Error('浏览器进程启动失败：没有拿到 PID');
    }
    const instanceMarker: InstanceMarker = {
      schemaVersion: 1,
      pid,
      port,
      browser: browser.name,
      startedAt: this.now(),
    };
    writeMarker(this.profileDir, instanceMarker);

    const deadline = this.now() + this.connectTimeoutMs;
    while (this.now() < deadline) {
      if (exitCode !== undefined) {
        removeStaleLockFiles(this.profileDir);
        throw new Error(
          `浏览器进程启动后退出（exit=${String(exitCode)}）。可能是 profile 被占用或安装损坏；未删除 profile 目录。`,
        );
      }
      const endpoint = await this.probe(port);
      if (endpoint !== null) return this.toInstance(instanceMarker, endpoint);
      await this.sleep(250);
    }
    // 端口没起来但进程还活着：保留窗口与标记，如实报错，不偷偷杀掉 owner 可能正在看的窗口
    throw new Error(
      `浏览器已启动（pid=${pid}），但 ${Math.round(this.connectTimeoutMs / 1000)}s 内 CDP 调试端口 ${port} 无响应；窗口已保留，请稍后重试或手动关闭。`,
    );
  }

  /** 关闭浏览器并清理本进程持有的标记/锁；绝不删除 profile 目录（登录态必须保住） */
  async cleanup(): Promise<void> {
    const marker = readMarker(this.profileDir);
    if (marker !== null && this.isPidAlive(marker.pid)) {
      try {
        this.killPid(marker.pid, 'SIGTERM');
      } catch {
        // 已退出
      }
      const deadline = this.now() + 2_000;
      while (this.now() < deadline && this.isPidAlive(marker.pid)) {
        await this.sleep(100);
      }
      if (this.isPidAlive(marker.pid)) {
        try {
          this.killPid(marker.pid, 'SIGKILL');
        } catch {
          // 已退出
        }
        await this.sleep(100);
      }
      if (this.isPidAlive(marker.pid)) {
        // 进程仍未退出：保留标记（下次可复用/明确报错），不删锁文件
        return;
      }
    }
    removeStaleLockFiles(this.profileDir);
  }

  private toInstance(marker: InstanceMarker, endpoint: CdpEndpoint): BrowserInstance {
    const browser =
      this.discover() ??
      ({
        name: marker.browser === 'Microsoft Edge' ? 'Microsoft Edge' : 'Google Chrome',
        appPath: '',
        executablePath: '',
      } satisfies DiscoveredBrowser);
    return {
      webSocketDebuggerUrl: endpoint.webSocketDebuggerUrl,
      port: marker.port,
      pid: marker.pid,
      browser,
    };
  }

  private async pickPort(): Promise<number> {
    for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
      const port = this.preferredPort + offset;
      if (port > 65535) break;
      if (await this.canBindPort(port)) return port;
    }
    throw new Error(`127.0.0.1 上找不到可用的 CDP 调试端口（从 ${this.preferredPort} 起扫了 ${PORT_SCAN_LIMIT} 个）`);
  }
}

/** 启动参数：只开回环调试端口，不加任何 UA 覆盖 / stealth / 反检测参数（R4） */
export function buildLaunchArgs(profileDir: string, port: number): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    'about:blank',
  ];
}

function defaultLaunchBrowser(browser: DiscoveredBrowser, args: string[]): ChildProcess {
  const child = spawn(browser.executablePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  // 子进程独立于本进程存活：应用退出后浏览器窗口（含登录态）留在屏幕上，等 owner 处理
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// CDP 附件（浏览器级连接 + 页面驱动 + Browser.close）
// ---------------------------------------------------------------------------

export interface CdpBrowserAttachment {
  readonly browser: DiscoveredBrowser;
  readonly driver: DouyinCdpDriver;
  closeBrowser(): Promise<void>;
}

export type CdpConnector = (url: string) => Promise<CdpConnection>;

export const defaultCdpConnector: CdpConnector = (url) => CdpConnection.connect(url);

export async function attachToCdpBrowser(
  instance: BrowserInstance,
  connect: CdpConnector = defaultCdpConnector,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<CdpBrowserAttachment> {
  const connection = await connect(instance.webSocketDebuggerUrl);
  const driver = new CdpPageDriver(connection, sleep, now);
  return {
    browser: instance.browser,
    driver,
    async closeBrowser(): Promise<void> {
      try {
        await connection.request('Browser.close');
      } catch {
        // 连接可能已被 owner 关窗断开；忽略
      }
      connection.close();
    },
  };
}

// ---------------------------------------------------------------------------
// DouyinWebSession 实现（与 ElectronDouyinSession 同契约）
// ---------------------------------------------------------------------------

export interface BrowserHostLike {
  ensure(launchIfMissing: boolean): Promise<BrowserInstance | null>;
  isRunning(): boolean;
  cleanup(): Promise<void>;
}

export interface RealBrowserDouyinOptions {
  /** 专用持久 profile 目录：鲸屿应用数据目录下，绝不是 owner 日常 Chrome 的默认 user-data-dir */
  profileDir: string;
  port?: number;
  /** 测试注入点 */
  host?: BrowserHostLike;
  attach?: (instance: BrowserInstance) => Promise<CdpBrowserAttachment>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  renderTimeoutMs?: number;
  /** 单个视频页公开字段的渲染等待；默认 25s（feed 列表仍用 renderTimeoutMs） */
  itemRenderTimeoutMs?: number;
  navigateTimeoutMs?: number;
}

function assertHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http/https 导航，拒绝 ${url.protocol}`);
  }
  return url;
}

function isDouyinUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

/**
 * 真浏览器抖音只读会话：与 `ElectronDouyinSession` 同一组只读方法。
 * 不提供任何写操作入口；验证码识别在上层 `social-douyin.ts`，本类只如实返回页面快照。
 */
export class RealBrowserDouyinSession implements DouyinWebSession {
  readonly driverKind = 'cdp-real' as const;
  private readonly host: BrowserHostLike;
  private readonly attach: (instance: BrowserInstance) => Promise<CdpBrowserAttachment>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly renderTimeoutMs: number;
  private readonly itemRenderTimeoutMs: number;
  private readonly navigateTimeoutMs: number;
  private attachment: CdpBrowserAttachment | null = null;

  constructor(options: RealBrowserDouyinOptions) {
    const host = options.host ?? new CdpBrowserHost({ profileDir: options.profileDir, port: options.port });
    this.host = host;
    this.attach =
      options.attach ??
      ((instance) => attachToCdpBrowser(instance, defaultCdpConnector, this.sleep, this.now));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.renderTimeoutMs = options.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
    this.itemRenderTimeoutMs = options.itemRenderTimeoutMs ?? ITEM_RENDER_TIMEOUT_MS;
    this.navigateTimeoutMs = options.navigateTimeoutMs ?? NAVIGATE_TIMEOUT_MS;
  }

  async load(rawUrl: string): Promise<DouyinPageSnapshot> {
    const url = assertHttpUrl(rawUrl);
    const driver = await this.requireDriver(true);
    await driver.navigate(url.toString(), this.navigateTimeoutMs);
    // 视频详情页的判据是 h1/detail 字段，不是侧栏推荐卡片：
    // 用 cards 当「已就绪」会让还在加载的视频页被误判成读完了。
    return isDouyinDetailUrl(url.toString())
      ? this.readRich(driver, this.itemRenderTimeoutMs, hasDetailContent)
      : this.readRich(driver, this.renderTimeoutMs, hasFeedContent);
  }

  async openFeed(feed: DouyinFeedKind): Promise<DouyinPageSnapshot> {
    if (feed !== 'recommended') return this.load(DOUYIN_FEED_URLS[feed]);
    const driver = await this.requireDriver(true);
    await driver.navigate(DOUYIN_FEED_URLS.public, this.navigateTimeoutMs);

    const clickDeadline = this.now() + this.renderTimeoutMs;
    let clicked = false;
    while (this.now() < clickDeadline) {
      clicked = await driver.evaluate<boolean>(DOUYIN_RECOMMEND_TAB_CLICK_SCRIPT);
      if (clicked) break;
      await this.sleep(400);
    }

    const deadline = this.now() + this.renderTimeoutMs;
    let snapshot = await driver.evaluate<DouyinPageSnapshot>(DOUYIN_PAGE_READER_SCRIPT);
    while (
      this.now() < deadline &&
      (!clicked || !snapshot.url.includes('recommend=1') || snapshot.cards.length === 0)
    ) {
      await this.sleep(400);
      snapshot = await driver.evaluate<DouyinPageSnapshot>(DOUYIN_PAGE_READER_SCRIPT);
    }
    return snapshot;
  }

  /** 登录态只检查 Cookie 名称；不启动浏览器，也不读取/导出值 */
  async loginState(): Promise<DouyinLoginState> {
    const driver = await this.ensureDriver(false);
    if (driver === null) return { loggedIn: false };
    const names = await driver.cookieNames(['https://www.douyin.com/', 'https://www.douyin.com']);
    return {
      loggedIn: DOUYIN_LOGIN_COOKIE_NAMES.some((name) => names.includes(name)),
    };
  }

  /**
   * 把可见的真浏览器窗口留给 owner 亲手扫码：
   * 只切到前台（必要时打开抖音首页），不代填密码、不点登录、不碰凭据。
   */
  async openLoginWindow(): Promise<void> {
    const driver = await this.requireDriver(true);
    await driver.bringToFront();
    const current = await driver.currentUrl();
    if (!isDouyinUrl(current)) {
      await driver.navigate('https://www.douyin.com/', this.navigateTimeoutMs);
    }
    await driver.bringToFront();
  }

  isLoginWindowOpen(): boolean {
    return this.host.isRunning();
  }

  async dispose(): Promise<void> {
    if (this.attachment !== null) {
      await this.attachment.closeBrowser().catch(() => undefined);
      this.attachment = null;
    }
    await this.host.cleanup();
  }

  private async requireDriver(launchIfMissing: boolean): Promise<DouyinCdpDriver> {
    const driver = await this.ensureDriver(launchIfMissing);
    if (driver === null) {
      throw new Error(
        '抖音专用浏览器尚未启动。请先在生活页点「扫码登录」打开专用 Chrome/Edge 窗口，由 owner 亲手扫码后再重试。',
      );
    }
    return driver;
  }

  private async ensureDriver(launchIfMissing: boolean): Promise<DouyinCdpDriver | null> {
    if (this.attachment !== null) return this.attachment.driver;
    const instance = await this.host.ensure(launchIfMissing);
    if (instance === null) return null;
    this.attachment = await this.attach(instance);
    return this.attachment.driver;
  }

  private async readRich(
    driver: DouyinCdpDriver,
    timeoutMs = this.renderTimeoutMs,
    ready: (snapshot: DouyinPageSnapshot) => boolean = hasRichContent,
  ): Promise<DouyinPageSnapshot> {
    const startedAt = this.now();
    const deadline = startedAt + timeoutMs;
    let snapshot = await driver.evaluate<DouyinPageSnapshot>(DOUYIN_PAGE_READER_SCRIPT);
    while (this.now() < deadline && !ready(snapshot)) {
      // 只对「已确认是验证码」的页面早退：抖音视频详情页在 SPA 过渡期会短暂呈现
      // 「旧标题 + 空正文」，用形状猜验证码会把正在加载的正常页面误判为风控页。
      if (detectDouyinBlock(snapshot)?.kind === 'captcha') break;
      // 已被重定向回列表页（视频被删/不可见）：不再空等详情字段
      if (!isDouyinDetailUrl(snapshot.url) && snapshot.cards.length > 0) break;
      await this.sleep(400);
      snapshot = await driver.evaluate<DouyinPageSnapshot>(DOUYIN_PAGE_READER_SCRIPT);
    }
    return snapshot;
  }
}

function isDouyinDetailUrl(raw: string): boolean {
  try {
    const path = new URL(raw).pathname;
    return path.startsWith('/video/') || path.startsWith('/note/');
  } catch {
    return false;
  }
}

function hasFeedContent(snapshot: DouyinPageSnapshot): boolean {
  return snapshot.cards.length > 0;
}

function hasDetailContent(snapshot: DouyinPageSnapshot): boolean {
  return (snapshot.heading ?? '').trim() !== '' || (snapshot.detailText ?? '').trim() !== '';
}

function hasRichContent(snapshot: DouyinPageSnapshot): boolean {
  return hasFeedContent(snapshot) || hasDetailContent(snapshot);
}
