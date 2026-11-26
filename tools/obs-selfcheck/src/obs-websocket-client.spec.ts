/**
 * `ObsWebsocketClient` 的真协议测试（item 4 / `V2-P3-02`）。
 *
 * 用真实 WebSocket 服务端（`ws`）把 obs-websocket 5.x 的 op 0/1/2/6/7 走一遍，
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
        // 假服务端按 obs-websocket 5.x 协议公式**独立实现**（不引用客户端的 computeAuthentication）：
        //   secret = b64(sha256(password + salt))；authentication = b64(sha256(secret + challenge))
        // 照抄被测实现的公式只会验证「自洽」——上一版就是这么把错的算法一路放过真机验收的。
        const expected = options.auth === undefined
          ? undefined
          : createHash('sha256')
            .update(
              `${createHash('sha256').update(`${options.auth.password}${options.auth.salt}`).digest('base64')}${options.auth.challenge}`,
            )
            .digest('base64');
        if (expected !== undefined && message.d.authentication !== expected) {
          socket.close(4009, 'Authentication failed.');
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
          op: 7,
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
          op: 7,
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
        socket.send(JSON.stringify({ op: 7, d: { requestId: request.requestId, requestStatus: { result: false } } }));
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
          socket.send(JSON.stringify({ op: 7, d: { requestId: 'whale-selfcheck-999', requestStatus: { result: true } } }));
        }
        socket.send(JSON.stringify({
          op: 7,
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
    // 处置建议必须跟着错误一起来：owner 在密码上卡了两轮，下一步提示比错误码有用
    await expect(connecting).rejects.toThrow(/OBS → 设置 → WebSocket 服务器设置里重设服务器密码/);
    await expect(connecting).rejects.toThrow(/别丢首字符/);
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
    expect(describeClose(4009, 'Authentication failed.')).toContain('别丢首字符');
    expect(describeClose(1006, '')).toContain('连接已断开');
  });
});

/**
 * 认证算法回归（owner 2026-11-26 定点修复）。
 *
 * 之前实现是三步且拼接顺序反了，假服务端又照抄了同一套公式，于是「实现错 + 测试错 + 两边自洽」，
 * 单测全绿、真机永远 4009。这两条测试专门防退化。
 */
describe('obs-websocket 认证算法（协议两步）', () => {
  it('固定向量：password/salt/challenge 三个字面量 → 精确等于手算常量', async () => {
    const { computeAuthentication } = await import('./obs-websocket-client.js');
    // 常量由 obs-websocket 5.x 协议公式独立算出（node -e 与 python 双向交叉核对），不从被测实现里取
    const expected = 'XZoiWAVck3AYkCEZPmxkUuT7YWggKQwaNrmOAkjCqdw=';
    expect(computeAuthentication('pw-123', 'salt-abc', 'chal-xyz')).toBe(expected);
    // 反例：旧的三步错误写法算出来是另一个值，永远不该再出现
    const { createHash } = await import('node:crypto');
    const legacy = createHash('sha256')
      .update(`chal-xyz${createHash('sha256')
        .update(`salt-abc${createHash('sha256').update('pw-123').digest('base64')}`)
        .digest('base64')}`)
      .digest('base64');
    expect(legacy).not.toBe(expected);
  });

  it('假服务端按协议独立校验：密码错就回 4009，对才回 Identified', async () => {
    const server = await startFakeObs({ auth: { salt: 'salt-abc', challenge: 'chal-xyz', password: 'pw-123' } });

    const wrong = new ObsWebsocketClient(server.url);
    await expect(wrong.connect('pw-124')).rejects.toThrow(/认证失败：密码不正确/);
    wrong.close();

    const right = new ObsWebsocketClient(server.url);
    await expect(right.connect('pw-123')).resolves.toBeUndefined();
    right.close();
  });
});

/**
 * opcode 表回归（owner 2026-11-26 第二次定点修复）。
 *
 * 同一类病已经出现两次：实现读错协议 → 假服务端照抄实现 → 测试只验证「自己和自己一致」。
 * 这里把协议 opcode 表按 `Protocol.md` 写成字面量断言，并把「op=9 不能当 RequestResponse」钉死。
 */
describe('obs-websocket opcode 表（Protocol.md）', () => {
  it('opcode 常量与协议表逐条相等', async () => {
    const { OBS_OP } = await import('./obs-websocket-client.js');
    expect(OBS_OP).toEqual({
      HELLO: 0,
      IDENTIFY: 1,
      IDENTIFIED: 2,
      REIDENTIFY: 3,
      EVENT: 5,
      REQUEST: 6,
      REQUEST_RESPONSE: 7,
      REQUEST_BATCH: 8,
      REQUEST_BATCH_RESPONSE: 9,
    });
    // 单独再钉一遍最容易错的那个：7 才是 RequestResponse，9 是 RequestBatchResponse
    expect(OBS_OP.REQUEST_RESPONSE).toBe(7);
    expect(OBS_OP.REQUEST_RESPONSE).not.toBe(OBS_OP.REQUEST_BATCH_RESPONSE);
  });

  it('服务端回 op=7 才结算请求；回 op=9（批量应答）绝不能被当成单条应答', async () => {
    const { OBS_OP } = await import('./obs-websocket-client.js');
    const server = await startFakeObs({
      onRequest: (socket, request) => {
        // 先发一条 op=9，旧实现会误当 RequestResponse；正确实现必须忽略它，继续等 op=7
        socket.send(JSON.stringify({ op: OBS_OP.REQUEST_BATCH_RESPONSE, d: { requestId: request.requestId, requestStatus: { result: true } } }));
        socket.send(JSON.stringify({
          op: OBS_OP.REQUEST_RESPONSE,
          d: { requestId: request.requestId, requestStatus: { result: true }, responseData: { via: 'op7' } },
        }));
      },
    });
    const client = new ObsWebsocketClient(server.url);
    await client.connect();
    await expect(client.request({ requestType: 'GetVersion', timeoutMs: 500 })).resolves.toEqual({ via: 'op7' });
    client.close();
  });
});
