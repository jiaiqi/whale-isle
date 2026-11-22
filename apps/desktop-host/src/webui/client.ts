/**
 * WebUI 传输层（T-M6-04，浏览器侧，零依赖）：
 * 同一套 React 渲染层可选接入本类，用 HTTP/WS 代替 Electron IPC：
 *   - connect(token)：建立 WS（事件推送），断线指数退避自动重连（最多 5 次）
 *   - getState()：GET /api/state（运行时快照 + 最近 100 条总线事件）
 *   - sendCommand(text)：POST /api/command（chat:say / directive 通道）
 *   - approve(...)：POST /api/approve（桌面开线程、浏览器远程审批）
 *   - close()：手动关闭（不再自动重连）
 *
 * 当前最小版只提供 API 与状态；React 接入时把 onEvent/getState 适配成
 * 现有 director bridge 的 CustomEvent 形状即可，无需改渲染层组件。
 *
 * 注意：本文件不 import 任何主进程/Node 模块，可直接被浏览器打包。
 */

/** 重连上限（需求：最多 5 次） */
export const MAX_RECONNECT_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
/** WebSocket.OPEN（避免依赖 DOM 常量，测试注入的假 socket 也用它） */
const WS_OPEN = 1;

/** 指数退避：attempt 从 1 开始，500 / 1000 / 2000 / 4000 / 8000…（封顶 30s） */
export function computeBackoff(attempt: number, baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : BACKOFF_BASE_MS;
  const safeCap = Number.isFinite(capMs) && capMs > 0 ? capMs : BACKOFF_CAP_MS;
  return Math.min(safeCap, safeBase * 2 ** (safeAttempt - 1));
}

/**
 * 构造 WS 地址：
 *   - baseUrl 为空 → 用当前页面 location（浏览器同源）
 *   - http → ws / https → wss；token 放 query（浏览器 WS API 不支持自定义 header）
 * 无 location 且无 baseUrl（Node/单测）→ 抛错，由调用方决定回退策略。
 */
export function buildWebSocketUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === '') {
    const locationLike = (globalThis as { location?: { protocol?: string; host?: string } }).location;
    if (!locationLike || typeof locationLike.host !== 'string' || locationLike.host === '') {
      throw new Error('WebUIClient 需要 baseUrl（当前环境没有 location）');
    }
    const scheme = locationLike.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${locationLike.host}/ws?token=${encodeURIComponent(token)}`;
  }
  const url = new URL(trimmed);
  const scheme = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss' : 'ws';
  return `${scheme}://${url.host}/ws?token=${encodeURIComponent(token)}`;
}

export interface WebUIMemoryStats {
  nodes?: number;
  edges?: number;
  lastDay?: string | null;
}

export interface WebUIVoiceState {
  enabled?: boolean;
  innerVoice?: boolean;
  volume?: number;
  ratePercent?: number;
  voice?: string;
  voiceId?: string;
  pitchMul?: number;
}

/** /api/state 响应（字段与 main/webui-server.ts 对齐） */
export interface WebUIStateResponse {
  ok: true;
  events: unknown[];
  running: boolean;
  brainMode: string | null;
  memoryStats: WebUIMemoryStats | null;
  voice: WebUIVoiceState | null;
}

/** /api/command 与 /api/approve 的公共响应形状 */
export interface WebUIJsonResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface WebUIApproveParams {
  providerId: string;
  requestId: number;
  outcome: 'allow' | 'always' | 'reject';
}

export type WebUIEventHandler = (event: unknown) => void;

/** 最小 WS 抽象：浏览器 WebSocket 与测试替身都满足（只声明收事件用到的子集） */
export interface WebSocketLike {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { data?: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebUIClientOptions {
  /** 服务地址（如 http://127.0.0.1:18766）；缺省用当前页面同源 */
  baseUrl?: string;
  /** 测试注入 fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入 WS 工厂 */
  webSocketFactory?: WebSocketFactory;
  /** 最大重连次数，默认 5 */
  maxReconnects?: number;
  /** 退避基数，默认 500ms */
  backoffBaseMs?: number;
}

/** 浏览器 WebSocket → WebSocketLike 适配（事件对象只暴露 data 字段） */
function createBrowserSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  return {
    get readyState() {
      return socket.readyState;
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    addEventListener(type, listener) {
      socket.addEventListener(type, (event: Event) => {
        listener(event as unknown as { data?: unknown });
      });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pickBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function toMemoryStats(value: unknown): WebUIMemoryStats | null {
  if (!isRecord(value)) return null;
  const stats: WebUIMemoryStats = {
    nodes: pickNumber(value, 'nodes'),
    edges: pickNumber(value, 'edges'),
    lastDay: typeof value.lastDay === 'string' ? value.lastDay : null,
  };
  return stats;
}

function toVoiceState(value: unknown): WebUIVoiceState | null {
  if (!isRecord(value)) return null;
  return {
    enabled: pickBoolean(value, 'enabled'),
    innerVoice: pickBoolean(value, 'innerVoice'),
    volume: pickNumber(value, 'volume'),
    ratePercent: pickNumber(value, 'ratePercent'),
    voice: pickString(value, 'voice'),
    voiceId: pickString(value, 'voiceId'),
    pitchMul: pickNumber(value, 'pitchMul'),
  };
}

/** 校验并收窄 /api/state（非法响应直接抛错，避免把脏数据喂给 React） */
function toStateResponse(payload: unknown): WebUIStateResponse {
  if (!isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'WebUI 状态响应无效';
    throw new Error(error);
  }
  return {
    ok: true,
    events: Array.isArray(payload.events) ? payload.events : [],
    running: payload.running === true,
    brainMode: typeof payload.brainMode === 'string' ? payload.brainMode : null,
    memoryStats: toMemoryStats(payload.memoryStats),
    voice: toVoiceState(payload.voice),
  };
}

export class WebUIClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly socketFactory: WebSocketFactory;
  private readonly maxReconnects: number;
  private readonly backoffBaseMs: number;
  private readonly eventHandlers = new Set<WebUIEventHandler>();
  private socket: WebSocketLike | null = null;
  private token = '';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;

  constructor(options: WebUIClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetchImpl;
    this.socketFactory = options.webSocketFactory ?? createBrowserSocket;
    this.maxReconnects = Math.max(0, Math.floor(options.maxReconnects ?? MAX_RECONNECT_ATTEMPTS));
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
  }

  /** 建立事件订阅（重复调用会先断开旧连接，并重置重连计数） */
  connect(token: string): void {
    if (token === '') throw new Error('WebUIClient token 不能为空');
    this.token = token;
    // 配置错误（缺 baseUrl / 非法 baseUrl）快速失败，避免无意义重连
    buildWebSocketUrl(this.baseUrl, token);
    this.manualClose = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.openSocket();
  }

  /** 订阅总线事件；返回取消订阅函数 */
  onEvent(handler: WebUIEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** 当前 WS 是否已连接 */
  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  /** 拉取运行时状态（网络/HTTP/校验失败都会 reject） */
  async getState(): Promise<WebUIStateResponse> {
    const response = await this.request('/api/state', { method: 'GET', headers: this.authHeaders(false) });
    const payload = await this.readJson(response);
    if (!response.ok) {
      throw new Error((isRecord(payload) && typeof payload.error === 'string' ? payload.error : '') || `HTTP ${response.status}`);
    }
    return toStateResponse(payload);
  }

  /** 发送指令（失败不抛异常，返回 { ok:false, error }） */
  async sendCommand(text: string): Promise<WebUIJsonResponse> {
    if (text.trim() === '') return { ok: false, error: '指令不能为空' };
    return this.postJson('/api/command', { text });
  }

  /** 远程审批（失败不抛异常，返回 { ok:false, error }） */
  async approve(params: WebUIApproveParams): Promise<WebUIJsonResponse> {
    return this.postJson('/api/approve', params);
  }

  /** 手动关闭：停止重连、关闭 socket、清空事件订阅（幂等） */
  close(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.eventHandlers.clear();
  }

  private authHeaders(includeJson: boolean): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (includeJson) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('当前环境没有 fetch（请注入 fetchImpl）'));
    }
    return fetchImpl(path, init);
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('WebUI 响应不是合法 JSON');
    }
  }

  private async postJson(path: string, body: unknown): Promise<WebUIJsonResponse> {
    try {
      const response = await this.request(path, {
        method: 'POST',
        headers: this.authHeaders(true),
        body: JSON.stringify(body),
      });
      const payload = await this.readJson(response);
      if (!isRecord(payload)) return { ok: false, error: `HTTP ${response.status}` };
      const result: WebUIJsonResponse = { ok: payload.ok === true };
      if ('result' in payload) result.result = payload.result;
      if (typeof payload.error === 'string') result.error = payload.error;
      if (!response.ok && result.error === undefined) result.error = `HTTP ${response.status}`;
      return result;
    } catch (error) {
      return { ok: false, error: errorMessageOf(error) };
    }
  }

  private openSocket(): void {
    /* v8 ignore next -- close() 会清空重连定时器，此守卫仅防御未来改动 */
    if (this.manualClose) return;
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(buildWebSocketUrl(this.baseUrl, this.token));
    } catch {
      // 地址/工厂异常按断线处理（connect 已做过地址快速失败；这里兜底重连）
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', this.handleOpen);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
    socket.addEventListener('error', this.handleError);
  }

  private readonly handleOpen = (): void => {
    this.reconnectAttempts = 0;
  };

  private readonly handleMessage = (event: { data?: unknown }): void => {
    if (typeof event.data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(event.data) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message) || message.type !== 'event') return;
    for (const handler of this.eventHandlers) {
      try {
        handler(message.data);
      } catch {
        /* 单个订阅者异常不拖垮其它订阅者 */
      }
    }
  };

  private readonly handleClose = (): void => {
    this.socket = null;
    if (this.manualClose) return;
    this.scheduleReconnect();
  };

  private readonly handleError = (): void => {
    /* 真实 WS 的错误后必跟 close；这里不重复调度重连，避免双倍退避 */
  };

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= this.maxReconnects) return;
    this.reconnectAttempts += 1;
    const delay = computeBackoff(this.reconnectAttempts, this.backoffBaseMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    try {
      socket.close(1000, 'client closing');
    } catch {
      /* 已断开 */
    }
  }
}
