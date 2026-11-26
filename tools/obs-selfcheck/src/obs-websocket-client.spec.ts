/**
 * `ObsWebsocketClient` 的真协议测试（item 4 / `V2-P3-02`）。
 *
 * 用真实 WebSocket 服务端（`ws`）把 obs-websocket v5 的 op 0/1/2/6/9 走一遍，
 * 而不是 mock 掉 socket——这样握手、认证哈希、请求超时、失败回执都必须真的对。
 * 依然是 `[SIMULATION]`：对端是本地假服务端，不是真实 OBS。
 */
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { ObsWebsocketClient } from './obs-websocket-client.js';

interface FakeObsServer {
  url: string;
  received: Array<{ op: number; d: Record<string, unknown> }>;
  close(): Promise<void>;
}

interface FakeObsOptions {
  /** 非空则在 Hello 里下发 authentication，并按此校验客户端的认证值 */
  auth?: { salt: string; challenge: string; password: string };
  /** 收到 op 6 请求后的应答方式；缺省成功返回 `{ok:true}` */
  onRequest?: (socket: WsSocket, request: { requestId: string; requestType: string }) => void;
}

const openServers: WebSocketServer[] = [];

async function startFakeObs(options: FakeObsOptions = {}): Promise<FakeObsServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  openServers.push(server);
  const received: FakeObsServer['received'] = [];
  server.on('connection', (socket) => {
    const hello: Record<string, unknown> = { obsWebSocketVersion: '5.7.6', rpcVersion: 1 };
    if (options.auth !== undefined) {
      hello.authentication = { challenge: options.auth.challenge, salt: options.auth.salt };
    }
    socket.send(JSON.stringify({ op: 0, d: hello }));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      received.push(message);
      if (message.op === 1) {
        const expected = options.auth === undefined
          ? undefined
          : createHash('sha256')
            .update(`${options.auth.challenge}${createHash('sha256')
              .update(`${options.auth.salt}${createHash('sha256').update(options.auth.password).digest('base64')}`)
              .digest('base64')}`)
            .digest('base64');
        if (expected !== undefined && message.d.authentication !== expected) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (message.op === 6) {
        const d = message.d;
        if (options.onRequest !== undefined) {
          options.onRequest(socket, {
            requestId: String(d.requestId),
            requestType: String(d.requestType),
          });
          return;
        }
        socket.send(JSON.stringify({
          op: 9,
          d: {
            requestType: d.requestType,
            requestId: d.requestId,
            requestStatus: { result: true, code: 100 },
            responseData: { echoed: d.requestType },
          },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('ObsWebsocketClient · obs-websocket v5 握手与请求', () => {
  it('无认证握手 → Identify(rpcVersion=1) → Identified，请求拿到 responseData', async () => {
    const server = await startFakeObs();
    const client = new ObsWebsocketClient(server.url);
    await client.connect();
    const data = await client.request({ requestType: 'GetVersion' });
    expect(data).toEqual({ echoed: 'GetVersion' });
    const identify = server.received.find((m) => m.op === 1);
    expect(identify?.d).toEqual({ rpcVersion: 1 });
    expect(server.received.find((m) => m.op === 6)?.d.requestType).toBe('GetVersion');
    client.close();
  });

  it('开启认证时按 salt+challenge 计算哈希，并能通过服务端校验', async () => {
    const server = await startFakeObs({ auth: { salt: 'salt-abc', challenge: 'chal-xyz', password: 'pw-123' } });
    const client = new ObsWebsocketClient(server.url);
    await client.connect('pw-123');
    await expect(client.request({ requestType: 'GetSceneList' })).resolves.toEqual({ echoed: 'GetSceneList' });
    client.close();
  });

  it('需要认证但没给密码 → 明确报错，不静默重试', async () => {
    const server = await startFakeObs({ auth: { salt: 's', challenge: 'c', password: 'pw' } });
    const noPassword = new ObsWebsocketClient(server.url);
    await expect(noPassword.connect()).rejects.toThrow(/开启了认证/);
    noPassword.close();
    const emptyPassword = new ObsWebsocketClient(server.url);
    await expect(emptyPassword.connect('')).rejects.toThrow(/开启了认证/);
    emptyPassword.close();
  });

  it('requestStatus.result=false → 以服务端 comment 拒绝', async () => {
    const server = await startFakeObs({
      onRequest: (socket, request) => {
        socket.send(JSON.stringify({
          op: 9,
          d: { requestId: request.requestId, requestStatus: { result: false, comment: '场景不存在' } },
        }));
      },
    });
    const client = new ObsWebsocketClient(server.url);
    await client.connect();
    await expect(client.request({ requestType: 'CreateScene' })).rejects.toThrow('场景不存在');
    client.close();
  });

  it('result=false 且无 comment → 报请求失败并带 requestId', async () => {
    const server = await startFakeObs({
      onRequest: (socket, request) => {
        socket.send(JSON.stringify({ op: 9, d: { requestId: request.requestId, requestStatus: { result: false } } }));
      },
    });
    const client = new ObsWebsocketClient(server.url);
    await client.connect();
    await expect(client.request({ requestType: 'RemoveScene' })).rejects.toThrow(/obs-websocket 请求失败：whale-selfcheck-1/);
    client.close();
  });

  it('对端不应答 → 按 timeoutMs 超时拒绝', async () => {
    const server = await startFakeObs({ onRequest: () => undefined });
    const client = new ObsWebsocketClient(server.url);
    await client.connect();
    await expect(client.request({ requestType: 'GetVersion', timeoutMs: 30 })).rejects.toThrow(/请求超时：GetVersion/);
    client.close();
  });

  it('忽略非 JSON 消息与未知 requestId，不影响后续正常请求', async () => {
    let first = true;
    const server = await startFakeObs({
      onRequest: (socket, request) => {
        if (first) {
          first = false;
          socket.send('这不是 JSON');
          socket.send(JSON.stringify({ op: 9, d: { requestId: 'whale-selfcheck-999', requestStatus: { result: true } } }));
        }
        socket.send(JSON.stringify({
          op: 9,
          d: { requestId: request.requestId, requestStatus: { result: true }, responseData: { ok: 1 } },
        }));
      },
    });
    const client = new ObsWebsocketClient(server.url);
    await client.connect();
    await expect(client.request({ requestType: 'GetVersion' })).resolves.toEqual({ ok: 1 });
    client.close();
  });

  it('端口无人监听 → connect 明确报「无法连接」，不是挂死', async () => {
    const server = await startFakeObs();
    const url = server.url;
    await server.close();
    const client = new ObsWebsocketClient(url);
    await expect(client.connect()).rejects.toThrow(/无法连接 obs-websocket/);
    client.close();
  });

  it('close 重复调用不抛错', async () => {
    const server = await startFakeObs();
    const client = new ObsWebsocketClient(server.url);
    await client.connect();
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});

/**
 * 连接阶段「不许无限挂起」的回归（owner 2026-11-26 定点修复）。
 * 用假 socket 直接制造 close(4009) / close(1006) / 永不响应，断言都抛错而不是挂死。
 */
class FakeSocket {
  readonly listeners = new Map<string, Array<{ handler: (event: unknown) => void; once: boolean }>>();
  readonly sent: string[] = [];
  closed = false;

  addEventListener(type: string, handler: (event: unknown) => void, options?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ handler, once: options?.once === true });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((entry) => entry.handler !== handler));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close', { code: 1000, reason: '' });
  }

  emit(type: string, event: unknown): void {
    const list = [...(this.listeners.get(type) ?? [])];
    for (const entry of list) {
      if (entry.once) this.removeEventListener(type, entry.handler);
      entry.handler(event);
    }
  }

  hello(authentication?: { salt: string; challenge: string }): void {
    this.emit('message', {
      data: JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.7.6', rpcVersion: 1, ...(authentication ? { authentication } : {}) } }),
    });
  }

  identified(): void {
    this.emit('message', { data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) });
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeFake(): { socket: FakeSocket; client: ObsWebsocketClient } {
  const socket = new FakeSocket();
  const client = new ObsWebsocketClient('ws://fake', { socketFactory: () => socket as unknown as WebSocket });
  return { socket, client };
}

describe('ObsWebsocketClient · 连接阶段失败必须立刻抛错（禁止无限挂起）', () => {
  it('密码错误（服务端 CLOSE 4009）→ 明确报「密码不正确」，不再等 op=2', async () => {
    const { socket, client } = makeFake();
    const connecting = client.connect('wrong-password');
    socket.emit('open', {});
    await flush();
    socket.hello({ salt: 'salt-abc', challenge: 'chal-xyz' });
    await flush();
    expect(socket.sent.some((raw) => JSON.parse(raw).op === 1)).toBe(true);
    socket.emit('close', { code: 4009, reason: 'Authentication failed.' });
    await expect(connecting).rejects.toThrow(/认证失败：密码不正确/);
    await expect(connecting).rejects.toThrow(/4009/);
  });

  it('对端异常断开（CLOSE 1006）→ 报「连接已断开」，退出路径同样落错', async () => {
    const { socket, client } = makeFake();
    const connecting = client.connect();
    socket.emit('open', {});
    await flush();
    socket.emit('close', { code: 1006, reason: '' });
    await expect(connecting).rejects.toThrow(/连接已断开（关闭码 1006）/);
  });

  it('连接阶段 error 事件 → 同一错误出口，报「无法连接 obs-websocket」', async () => {
    const { socket, client } = makeFake();
    const connecting = client.connect();
    socket.emit('error', new Error('ECONNREFUSED'));
    await expect(connecting).rejects.toThrow(/无法连接 obs-websocket/);
  });

  it('永不响应（连上但没有任何 Hello）→ 按 helloTimeoutMs 超时抛错，不挂起', async () => {
    const { socket, client } = makeFake();
    const connecting = client.connect(undefined, { helloTimeoutMs: 30 });
    socket.emit('open', {});
    await expect(connecting).rejects.toThrow(/等待 obs-websocket Hello 超时/);
  });

  it('回了 Hello 但不回 Identified（认证无响应）→ 按 identifiedTimeoutMs 超时抛错', async () => {
    const { socket, client } = makeFake();
    const connecting = client.connect(undefined, { identifiedTimeoutMs: 30 });
    socket.emit('open', {});
    await flush();
    socket.hello();
    await expect(connecting).rejects.toThrow(/Identified 超时/);
    await expect(connecting).rejects.toThrow(/密码不正确/);
  });

  it('已连接后在途请求遇到对端 close → 请求被拒绝而不是等满 15 秒', async () => {
    const { socket, client } = makeFake();
    const connecting = client.connect();
    socket.emit('open', {});
    await flush();
    socket.hello();
    await flush();
    socket.identified();
    await connecting;
    const pending = client.request({ requestType: 'GetVersion', timeoutMs: 5_000 });
    socket.emit('close', { code: 1006, reason: '' });
    await expect(pending).rejects.toThrow(/连接已断开/);
  });

  it('describeClose 文案：4009 与其它关闭码给出不同且可读的说明', async () => {
    const { describeClose } = await import('./obs-websocket-client.js');
    expect(describeClose(4009, 'Authentication failed.')).toContain('密码不正确');
    expect(describeClose(1006, '')).toContain('连接已断开');
  });
});
