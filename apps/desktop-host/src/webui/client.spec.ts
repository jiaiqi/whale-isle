/**
 * WebUI 浏览器侧传输层单测（T-M6-04）：
 * 指数退避序列、WS 地址构造、事件分发、自动重连上限、HTTP 状态/指令/审批。
 * 全部通过注入假 socket / 假 fetch 完成，不依赖真实网络与浏览器。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_BASE_MS,
  buildWebSocketUrl,
  computeBackoff,
  MAX_RECONNECT_ATTEMPTS,
  WebUIClient,
  type WebSocketLike,
} from './client';

class FakeSocket implements WebSocketLike {
  readonly url: string;
  readyState = 0;
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }

  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: 'open' | 'close' | 'error' | 'message', event: { data?: unknown } = {}): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface CreatedSockets {
  sockets: FakeSocket[];
  factory: (url: string) => WebSocketLike;
}

function createSocketRegistry(): CreatedSockets {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url: string): WebSocketLike => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function createFetch(payload: unknown, status = 200): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('computeBackoff', () => {
  it('500 / 1000 / 2000 / 4000 / 8000 指数序列', () => {
    expect(computeBackoff(1)).toBe(500);
    expect(computeBackoff(2)).toBe(1000);
    expect(computeBackoff(3)).toBe(2000);
    expect(computeBackoff(4)).toBe(4000);
    expect(computeBackoff(5)).toBe(8000);
  });

  it('封顶 30s，非法输入回退到安全值', () => {
    expect(computeBackoff(100)).toBe(30_000);
    expect(computeBackoff(0)).toBe(500);
    expect(computeBackoff(-3)).toBe(500);
    expect(computeBackoff(Number.NaN)).toBe(500);
    expect(computeBackoff(3, 0)).toBe(2000);
    expect(computeBackoff(3, 100, 150)).toBe(150);
    expect(computeBackoff(2, 100, Number.NaN)).toBe(200);
  });
});

describe('buildWebSocketUrl', () => {
  it('http → ws / https → wss，token 做 URL 编码', () => {
    expect(buildWebSocketUrl('http://127.0.0.1:18766', 'a b')).toBe('ws://127.0.0.1:18766/ws?token=a%20b');
    expect(buildWebSocketUrl('https://localhost:18766/', 't')).toBe('wss://localhost:18766/ws?token=t');
    expect(buildWebSocketUrl('ws://127.0.0.1:1/base', 't')).toBe('ws://127.0.0.1:1/ws?token=t');
  });

  it('无 baseUrl 时用页面 location；host 缺失/无 location 抛错', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: '127.0.0.1:18766' });
    expect(buildWebSocketUrl('', 't')).toBe('wss://127.0.0.1:18766/ws?token=t');

    vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:1' });
    expect(buildWebSocketUrl('', 't')).toBe('ws://127.0.0.1:1/ws?token=t');

    vi.stubGlobal('location', { protocol: 'http:', host: '' });
    expect(() => buildWebSocketUrl('', 't')).toThrow('需要 baseUrl');

    vi.stubGlobal('location', undefined);
    expect(() => buildWebSocketUrl('', 't')).toThrow('需要 baseUrl');
  });

  it('非法 baseUrl 抛错（由 connect 转为重连）', () => {
    expect(() => buildWebSocketUrl('not a url', 't')).toThrow();
  });
});

describe('WebUIClient WS 事件与重连', () => {
  it('connect 建立 socket 并分发 event；非 event/畸形消息忽略', () => {
    const registry = createSocketRegistry();
    const client = new WebUIClient({ baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    const received: unknown[] = [];
    client.onEvent((event) => received.push(event));

    client.connect('tok');
    expect(registry.sockets).toHaveLength(1);
    const socket = registry.sockets[0];
    expect(socket?.url).toBe('ws://127.0.0.1:18766/ws?token=tok');
    expect(client.isConnected()).toBe(false);

    socket?.emit('open');
    expect(client.isConnected()).toBe(true);
    socket?.emit('error'); // 错误由随后的 close 承载，不应抛异常
    socket?.emit('message', { data: JSON.stringify({ type: 'event', data: { ok: 1 } }) });
    socket?.emit('message', { data: JSON.stringify({ type: 'hello', data: {} }) });
    socket?.emit('message', { data: 'not json' });
    socket?.emit('message', { data: 42 });
    expect(received).toEqual([{ ok: 1 }]);
  });

  it('单个订阅者抛异常不影响其它订阅者；取消订阅后不再收到', () => {
    const registry = createSocketRegistry();
    const client = new WebUIClient({ baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    const received: unknown[] = [];
    client.onEvent(() => {
      throw new Error('bad subscriber');
    });
    const unsubscribe = client.onEvent((event) => received.push(event));
    client.connect('tok');
    const socket = registry.sockets[0];
    socket?.emit('open');
    socket?.emit('message', { data: JSON.stringify({ type: 'event', data: 'x' }) });
    expect(received).toEqual(['x']);
    unsubscribe();
    socket?.emit('message', { data: JSON.stringify({ type: 'event', data: 'y' }) });
    expect(received).toEqual(['x']);
  });

  it('断线按 500/1000/2000/4000/8000 重连，5 次后停止', () => {
    vi.useFakeTimers();
    const registry = createSocketRegistry();
    const client = new WebUIClient({
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
      backoffBaseMs: BACKOFF_BASE_MS,
    });
    client.connect('tok');
    expect(registry.sockets).toHaveLength(1);

    const delays = [500, 1000, 2000, 4000, 8000];
    for (const [index, delay] of delays.entries()) {
      registry.sockets[index]?.emit('close');
      // 未到点不重连
      vi.advanceTimersByTime(delay - 1);
      expect(registry.sockets).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(registry.sockets).toHaveLength(index + 2);
    }

    // 第 6 次 close：已达上限，不再调度
    registry.sockets[5]?.emit('close');
    vi.advanceTimersByTime(60_000);
    expect(registry.sockets).toHaveLength(6);
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
  });

  it('重新 open 后重连计数归零（再次断线仍从 500ms 起）', () => {
    vi.useFakeTimers();
    const registry = createSocketRegistry();
    const client = new WebUIClient({ baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client.connect('tok');

    registry.sockets[0]?.emit('close');
    vi.advanceTimersByTime(500);
    expect(registry.sockets).toHaveLength(2);

    registry.sockets[1]?.emit('open');
    registry.sockets[1]?.emit('close');
    vi.advanceTimersByTime(500);
    expect(registry.sockets).toHaveLength(3);
  });

  it('手动 close 不再重连，且清空事件订阅', () => {
    vi.useFakeTimers();
    const registry = createSocketRegistry();
    const client = new WebUIClient({ baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    const received: unknown[] = [];
    client.onEvent((event) => received.push(event));
    client.connect('tok');
    const socket = registry.sockets[0];
    socket?.emit('open');

    client.close();
    expect(socket?.closed[0]?.code).toBe(1000);
    expect(client.isConnected()).toBe(false);
    socket?.emit('close'); // 真实 WS 在 close() 后仍会回 close 事件：manualClose 守卫应拦住重连
    vi.advanceTimersByTime(60_000);
    expect(registry.sockets).toHaveLength(1);

    socket?.emit('message', { data: JSON.stringify({ type: 'event', data: 'late' }) });
    expect(received).toEqual([]);

    // 幂等
    client.close();
  });

  it('手动 close 会取消已排队的重连定时器；重复 close 事件不叠加定时器', () => {
    vi.useFakeTimers();
    const registry = createSocketRegistry();
    const client = new WebUIClient({ baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client.connect('tok');
    const socket = registry.sockets[0];
    socket?.emit('close'); // 排入 500ms 重连
    socket?.emit('close'); // 定时器已在 → 不叠加
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(registry.sockets).toHaveLength(1);
  });

  it('重复 connect 会先断旧连接；socket 工厂抛错会排入重连', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let failNext = false;
    const client = new WebUIClient({
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: (url) => {
        if (failNext) {
          failNext = false;
          throw new Error('factory boom');
        }
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    client.connect('tok');
    client.connect('tok2');
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed[0]?.code).toBe(1000);
    expect(sockets[1]?.url).toContain('token=tok2');

    failNext = true;
    sockets[1]?.emit('close');
    vi.advanceTimersByTime(500); // 第一次重连：工厂抛错 → 再排 1000ms
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
  });

  it('baseUrl 缺失且无 location / token 为空 → connect 抛错（快速失败）', () => {
    const client = new WebUIClient({ webSocketFactory: createSocketRegistry().factory });
    expect(() => client.connect('')).toThrow('token 不能为空');
    vi.stubGlobal('location', undefined);
    expect(() => client.connect('tok')).toThrow('需要 baseUrl');
  });

  it('默认浏览器 socket 工厂可创建连接、读 readyState 并关闭', () => {
    const instances: FakeSocket[] = [];
    class GlobalFakeSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
    vi.stubGlobal('WebSocket', GlobalFakeSocket);
    const client = new WebUIClient({ baseUrl: 'http://127.0.0.1:18766' });
    client.connect('tok');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe('ws://127.0.0.1:18766/ws?token=tok');
    expect(client.isConnected()).toBe(false);
    instances[0]?.emit('open');
    expect(client.isConnected()).toBe(true);
    client.close();
    expect(instances[0]?.closed[0]?.code).toBe(1000);
  });
});

describe('WebUIClient HTTP API', () => {
  it('getState 带 Bearer 并收窄响应', async () => {
    const { calls, fetchImpl } = createFetch({
      ok: true,
      events: [{ type: 'receipt' }],
      running: true,
      brainMode: 'llm',
      memoryStats: { nodes: 3, edges: 2, lastDay: '第1年春16日' },
      voice: { enabled: true, voiceId: 'qiaopi_mengmei', volume: 1 },
    });
    // token 需要先通过 connect 注入；用假 socket 避免真实网络
    const registry = createSocketRegistry();
    const client = new WebUIClient({ fetchImpl, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client.connect('tok');

    const state = await client.getState();
    expect(state).toEqual({
      ok: true,
      events: [{ type: 'receipt' }],
      running: true,
      brainMode: 'llm',
      memoryStats: { nodes: 3, edges: 2, lastDay: '第1年春16日' },
      voice: {
        enabled: true,
        innerVoice: undefined,
        volume: 1,
        ratePercent: undefined,
        voice: undefined,
        voiceId: 'qiaopi_mengmei',
        pitchMul: undefined,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/state');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('getState：HTTP 非 2xx / 非法 JSON / 逻辑失败都 reject', async () => {
    const registry = createSocketRegistry();
    const unauthorized = new WebUIClient({
      fetchImpl: createFetch({ ok: false, error: '未授权' }, 401).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    unauthorized.connect('bad');
    await expect(unauthorized.getState()).rejects.toThrow('未授权');

    const brokenJson: typeof fetch = async () => new Response('not json', { status: 200 });
    const broken = new WebUIClient({ fetchImpl: brokenJson, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    broken.connect('tok');
    await expect(broken.getState()).rejects.toThrow('不是合法 JSON');

    // 200 但 body.ok === false（异常路径也会带 error 文案；缺 error 时用兜底文案）
    const logicalError = new WebUIClient({
      fetchImpl: createFetch({ ok: false, error: '状态不可用' }).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    logicalError.connect('tok');
    await expect(logicalError.getState()).rejects.toThrow('状态不可用');

    const shapeless = new WebUIClient({
      fetchImpl: createFetch({ ok: false }).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    shapeless.connect('tok');
    await expect(shapeless.getState()).rejects.toThrow('状态响应无效');

    // 非 2xx 且 body 里没有 error 文案 → HTTP 状态码兜底
    const blankError = new WebUIClient({
      fetchImpl: createFetch({}, 500).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    blankError.connect('tok');
    await expect(blankError.getState()).rejects.toThrow('HTTP 500');

    // 空响应体 → readJson 返回 null → 状态校验失败
    const emptyBody: typeof fetch = async () => new Response('', { status: 200 });
    const emptyClient = new WebUIClient({ fetchImpl: emptyBody, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    emptyClient.connect('tok');
    await expect(emptyClient.getState()).rejects.toThrow('状态响应无效');
  });

  it('getState 对脏字段做收窄（数组/字符串/布尔缺失时退化）', async () => {
    const registry = createSocketRegistry();
    const client = new WebUIClient({
      fetchImpl: createFetch({
        ok: true,
        events: 'nope',
        running: false,
        brainMode: 5,
        memoryStats: { nodes: 'x', edges: null, lastDay: 5 },
        voice: { enabled: 'yes', innerVoice: 1, volume: 'loud', ratePercent: null, voice: 1, voiceId: 2, pitchMul: 'x' },
      }).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    client.connect('tok');
    const state = await client.getState();
    expect(state.events).toEqual([]);
    expect(state.running).toBe(false);
    expect(state.brainMode).toBeNull();
    expect(state.memoryStats).toEqual({ nodes: undefined, edges: undefined, lastDay: null });
    expect(state.voice).toEqual({
      enabled: undefined,
      innerVoice: undefined,
      volume: undefined,
      ratePercent: undefined,
      voice: undefined,
      voiceId: undefined,
      pitchMul: undefined,
    });

    // memoryStats / voice 不是对象 → 整体退化为 null
    const emptyNested = new WebUIClient({
      fetchImpl: createFetch({ ok: true, events: [], memoryStats: [], voice: [] }).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    emptyNested.connect('tok');
    const nested = await emptyNested.getState();
    expect(nested.memoryStats).toBeNull();
    expect(nested.voice).toBeNull();
  });

  it('sendCommand 校验空指令、POST body 与结果', async () => {
    const registry = createSocketRegistry();
    const { calls, fetchImpl } = createFetch({ ok: true, result: { reply: '哼' } });
    const client = new WebUIClient({ fetchImpl, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client.connect('tok');

    expect(await client.sendCommand('   ')).toEqual({ ok: false, error: '指令不能为空' });
    expect(calls).toHaveLength(0);

    expect(await client.sendCommand('你好')).toEqual({ ok: true, result: { reply: '哼' } });
    expect(calls[0]?.url).toBe('/api/command');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ text: '你好' }));
  });

  it('sendCommand：网络异常 / 非 JSON / 非对象响应都返回 ok:false', async () => {
    const registry = createSocketRegistry();
    const network: typeof fetch = async () => {
      throw new Error('boom');
    };
    const client = new WebUIClient({ fetchImpl: network, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client.connect('tok');
    expect(await client.sendCommand('hi')).toEqual({ ok: false, error: 'boom' });

    // 非 Error 抛出物 → String(error) 兜底
    const stringThrow: typeof fetch = async () => {
      throw 'plain string';
    };
    const client4 = new WebUIClient({ fetchImpl: stringThrow, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client4.connect('tok');
    expect(await client4.sendCommand('hi')).toEqual({ ok: false, error: 'plain string' });

    const notJson: typeof fetch = async () => new Response('<html>', { status: 200 });
    const client2 = new WebUIClient({ fetchImpl: notJson, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client2.connect('tok');
    expect(await client2.sendCommand('hi')).toEqual({ ok: false, error: 'WebUI 响应不是合法 JSON' });

    const arrayPayload: typeof fetch = async () => new Response('[]', { status: 200 });
    const client3 = new WebUIClient({ fetchImpl: arrayPayload, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client3.connect('tok');
    expect(await client3.sendCommand('hi')).toEqual({ ok: false, error: 'HTTP 200' });

    const httpError = new WebUIClient({
      fetchImpl: createFetch({ ok: false }, 500).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    httpError.connect('tok');
    expect(await httpError.sendCommand('hi')).toEqual({ ok: false, error: 'HTTP 500' });

    // 业务错误文案透传（ok:false + error）
    const businessError = new WebUIClient({
      fetchImpl: createFetch({ ok: false, error: '指令通道待接线' }).fetchImpl,
      baseUrl: 'http://127.0.0.1:18766',
      webSocketFactory: registry.factory,
    });
    businessError.connect('tok');
    expect(await businessError.sendCommand('hi')).toEqual({ ok: false, error: '指令通道待接线' });
  });

  it('approve 转发 providerId/requestId/outcome', async () => {
    const registry = createSocketRegistry();
    const { calls, fetchImpl } = createFetch({ ok: true });
    const client = new WebUIClient({ fetchImpl, baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client.connect('tok');

    expect(await client.approve({ providerId: 'gemini', requestId: 7, outcome: 'always' })).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('/api/approve');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ providerId: 'gemini', requestId: 7, outcome: 'always' }));
  });

  it('无 fetch 环境时请求失败而非崩溃', async () => {
    vi.stubGlobal('fetch', undefined);
    const registry = createSocketRegistry();
    const client = new WebUIClient({ baseUrl: 'http://127.0.0.1:18766', webSocketFactory: registry.factory });
    client.connect('tok');
    await expect(client.getState()).rejects.toThrow('没有 fetch');
  });
});
