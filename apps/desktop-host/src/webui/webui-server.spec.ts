/**
 * WebUI server 集成单测（T-M6-04）：
 * 真实 node http + ws 起服务（不依赖 Electron）——401 无 token、/api/state 注入数据、
 * /api/command、远程审批 /api/approve、静态资源映射与路径穿越拒绝、WS 鉴权/回放/推送。
 * 该文件位于 src/webui（coverage 统计内），server 本体在 main/（已排除覆盖率），
 * 因此这里同时也作为「可脱离 Electron 运行」的证明。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { createWebUIServer, type WebUIServerHandle, type WebUIServerOptions } from '../main/webui-server';

const TEST_TOKEN = 'test-token';

interface RunningServer {
  handle: WebUIServerHandle;
  port: number;
}

const running: RunningServer[] = [];
const tempDirs: string[] = [];

async function startWebUI(options: WebUIServerOptions = {}): Promise<RunningServer> {
  const handle = createWebUIServer({ port: 0, authToken: TEST_TOKEN, ...options });
  const port = await handle.ready;
  const server = { handle, port };
  running.push(server);
  return server;
}

afterEach(async () => {
  for (const server of running.splice(0)) {
    try {
      await server.handle.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败忽略 */
    }
  }
});

function base(server: RunningServer): string {
  return `http://127.0.0.1:${server.port}`;
}

/** 原始 request-target 请求（fetch 会归一化 `..`，穿越用例必须保留原始路径） */
function rawRequest(
  server: RunningServer,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolveRequest({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }),
        );
      },
    );
    req.on('error', rejectRequest);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function postJson(server: RunningServer, path: string, body: unknown, token = TEST_TOKEN): Promise<Response> {
  return fetch(`${base(server)}${path}?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (condition()) {
        resolveWait();
        return;
      }
      if (Date.now() > deadline) {
        rejectWait(new Error(`条件在 ${timeoutMs}ms 内未满足`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 带状态的默认 getState 注入 */
function stateProvider(): () => {
  running: boolean;
  brainMode: string;
  memoryStats: { nodes: number; edges: number; lastDay: string | null };
  voice: { enabled: boolean; voiceId: string; volume: number };
} {
  return () => ({
    running: true,
    brainMode: 'llm',
    memoryStats: { nodes: 3, edges: 2, lastDay: null },
    voice: { enabled: true, voiceId: 'qiaopi_mengmei', volume: 1 },
  });
}

describe('[WebUI] 鉴权与状态', () => {
  it('无 token / 错误 token → 401 JSON（HBearer 正确则放行）', async () => {
    const server = await startWebUI({ getState: stateProvider() });

    const missing = await fetch(`${base(server)}/api/state`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ ok: false });

    const wrong = await fetch(`${base(server)}/api/state?token=wrong`);
    expect(wrong.status).toBe(401);

    const viaQuery = await fetch(`${base(server)}/api/state?token=${TEST_TOKEN}`);
    expect(viaQuery.status).toBe(200);

    const viaHeader = await fetch(`${base(server)}/api/state`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    expect(viaHeader.status).toBe(200);
  });

  it('/api/state 返回注入的运行时快照与最近事件', async () => {
    const server = await startWebUI({ getState: stateProvider() });
    server.handle.publish({ type: 'receipt', summary: '浇水完成' });

    const response = await fetch(`${base(server)}/api/state?token=${TEST_TOKEN}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      events: [{ type: 'receipt', summary: '浇水完成' }],
      running: true,
      brainMode: 'llm',
      memoryStats: { nodes: 3, edges: 2, lastDay: null },
      voice: { enabled: true, voiceId: 'qiaopi_mengmei', volume: 1 },
    });
  });

  it('事件环形缓冲按上限保留最近 N 条；无法序列化的事件被丢弃', async () => {
    const server = await startWebUI({ getState: stateProvider(), eventBufferSize: 2 });
    server.handle.publish({ n: 1 });
    server.handle.publish({ n: 2 });
    server.handle.publish({ n: 3 });
    server.handle.publish({ n: 4n }); // BigInt 不可 JSON 序列化 → 丢弃

    const body = (await (await fetch(`${base(server)}/api/state?token=${TEST_TOKEN}`)).json()) as { events: unknown[] };
    expect(body.events).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it('注入总线事件源：事件进入缓冲，close 时退订', async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const unsubscribed: string[] = [];
    const server = await startWebUI({
      getState: stateProvider(),
      getBusEventSources: () => [
        {
          subscribe: (listener) => {
            listeners.push(listener);
            return () => unsubscribed.push('first');
          },
        },
        {
          subscribe: () => {
            throw new Error('坏事件源');
          },
        },
      ],
    });

    listeners[0]?.({ type: 'from-source' });
    const body = (await (await fetch(`${base(server)}/api/state?token=${TEST_TOKEN}`)).json()) as { events: unknown[] };
    expect(body.events).toEqual([{ type: 'from-source' }]);

    await server.handle.close();
    expect(unsubscribed).toEqual(['first']);
  });

  it('getState 抛异常 → 500 JSON 而非崩溃', async () => {
    const server = await startWebUI({
      getState: () => {
        throw new Error('state boom');
      },
    });
    const response = await fetch(`${base(server)}/api/state?token=${TEST_TOKEN}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'state boom' });
  });

  it('HTML 外壳内联输出并注入 token；非 GET / 返回 405', async () => {
    const server = await startWebUI({ getState: stateProvider() });
    const response = await fetch(`${base(server)}/?token=${TEST_TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    const html = await response.text();
    expect(html).toContain('鲸屿 WebUI');
    expect(html).toContain(`name="webui-token" content="${TEST_TOKEN}"`);

    const post = await fetch(`${base(server)}/?token=${TEST_TOKEN}`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });
});

describe('[WebUI] OBS 透明挂件 /obs（T-M6-34）', () => {
  it('无 token → 401；有 token → 200 且声明 stage protocol / 只读', async () => {
    const server = await startWebUI();
    const denied = await fetch(`${base(server)}/obs`);
    expect(denied.status).toBe(401);

    const response = await fetch(`${base(server)}/obs?token=${TEST_TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    // 版本协商 + 只读声明（OBS 端可据此拒绝注入指令）
    expect(html).toContain('data-stage-protocol="1"');
    expect(html).toContain('name="stage-protocol" content="1"');
    expect(html).toContain('name="obs-readonly" content="1"');
    // 挂件只读：不得包含任何写操作入口
    expect(html).not.toContain('/api/command');
    expect(html).not.toContain('/api/approve');
    // WS 令牌通过 meta 注入，且已 HTML 转义
    expect(html).toContain(`name="webui-token" content="${TEST_TOKEN}"`);
  });

  it('/obs 非 GET → 405', async () => {
    const server = await startWebUI();
    const response = await fetch(`${base(server)}/obs?token=${TEST_TOKEN}`, { method: 'POST' });
    expect(response.status).toBe(405);
  });
});

describe('[WebUI] /api/command', () => {
  it('转发 text（trim 后）并返回 onCommand 结果', async () => {
    const onCommand = vi.fn(async (text: string) => ({ reply: `收到：${text}` }));
    const server = await startWebUI({ onCommand, getState: stateProvider() });

    const response = await postJson(server, '/api/command', { text: '  你好  ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { reply: '收到：你好' } });
    expect(onCommand).toHaveBeenCalledWith('你好');
  });

  it('缺 onCommand → 501 待接线；空/超长/畸形 body → 400', async () => {
    const unwired = await startWebUI({ getState: stateProvider() });
    const notWired = await postJson(unwired, '/api/command', { text: '你好' });
    expect(notWired.status).toBe(501);
    expect(await notWired.json()).toEqual({ ok: false, error: 'WebUI 指令通道待接线' });

    const wired = await startWebUI({ onCommand: () => ({ ok: true }), getState: stateProvider() });
    expect((await postJson(wired, '/api/command', { text: '   ' })).status).toBe(400);
    expect((await postJson(wired, '/api/command', { text: 'x'.repeat(4_001) })).status).toBe(400);
    expect((await postJson(wired, '/api/command', { nope: 1 })).status).toBe(400);

    const malformed = await rawRequest(wired, `/api/command?token=${TEST_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body).error).toBe('请求体不是合法 JSON');
  });

  it('onCommand 抛异常 → 500 JSON', async () => {
    const server = await startWebUI({
      onCommand: () => {
        throw new Error('command boom');
      },
      getState: stateProvider(),
    });
    const response = await postJson(server, '/api/command', { text: 'hi' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'command boom' });
  });

  it('非 POST → 405', async () => {
    const server = await startWebUI({ getState: stateProvider() });
    const response = await fetch(`${base(server)}/api/command?token=${TEST_TOKEN}`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('[WebUI] 远程审批 /api/approve', () => {
  it('转发 { providerId, requestId, outcome }', async () => {
    const onApprove = vi.fn((payload: { providerId: string; requestId: number; outcome: string }) => ({ ok: true, payload }));
    const server = await startWebUI({ onApprove, getState: stateProvider() });

    const response = await postJson(server, '/api/approve', { providerId: 'gemini', requestId: 7, outcome: 'always' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(onApprove).toHaveBeenCalledWith({ providerId: 'gemini', requestId: 7, outcome: 'always' });
  });

  it('参数校验：providerId / requestId / outcome 非法 → 400', async () => {
    const onApprove = vi.fn(() => ({ ok: true }));
    const server = await startWebUI({ onApprove, getState: stateProvider() });

    expect((await postJson(server, '/api/approve', { providerId: '', requestId: 1, outcome: 'allow' })).status).toBe(400);
    expect((await postJson(server, '/api/approve', { providerId: 'x', requestId: 1.5, outcome: 'allow' })).status).toBe(400);
    expect((await postJson(server, '/api/approve', { providerId: 'x', requestId: -1, outcome: 'allow' })).status).toBe(400);
    expect((await postJson(server, '/api/approve', { providerId: 'x', requestId: 1, outcome: 'maybe' })).status).toBe(400);
    expect((await postJson(server, '/api/approve', { providerId: 'x', requestId: 1 })).status).toBe(400);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('缺 onApprove → 501；onApprove 抛异常 → 500', async () => {
    const unwired = await startWebUI({ getState: stateProvider() });
    const notWired = await postJson(unwired, '/api/approve', { providerId: 'x', requestId: 1, outcome: 'reject' });
    expect(notWired.status).toBe(501);

    const throwing = await startWebUI({
      onApprove: () => {
        throw new Error('approve boom');
      },
      getState: stateProvider(),
    });
    const response = await postJson(throwing, '/api/approve', { providerId: 'x', requestId: 1, outcome: 'reject' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'approve boom' });
  });
});

describe('[WebUI] 静态资源 /renderer/*', () => {
  function makeRendererRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'webui-renderer-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'pet-stage'), { recursive: true });
    writeFileSync(join(dir, 'pet-stage', 'manifest.json'), JSON.stringify({ ok: true, asset: 'idle.webm' }), 'utf8');
    writeFileSync(join(dir, 'pet-stage', 'main.js'), 'console.log(1);', 'utf8');
    return dir;
  }

  it('映射 dist/renderer 下的文件（含 Content-Type）', async () => {
    const rendererRoot = makeRendererRoot();
    const server = await startWebUI({ rendererRoot, getState: stateProvider() });

    const json = await fetch(`${base(server)}/renderer/pet-stage/manifest.json?token=${TEST_TOKEN}`);
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await json.json()).toEqual({ ok: true, asset: 'idle.webm' });

    const js = await fetch(`${base(server)}/renderer/pet-stage/main.js?token=${TEST_TOKEN}`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('路径穿越（明文/单层编码/双重编码）→ 400；缺失文件 → 404', async () => {
    const rendererRoot = makeRendererRoot();
    const server = await startWebUI({ rendererRoot, getState: stateProvider() });

    const plain = await rawRequest(server, `/renderer/../package.json?token=${TEST_TOKEN}`);
    expect(plain.status).toBe(400);

    const encoded = await rawRequest(server, `/renderer/%2e%2e/package.json?token=${TEST_TOKEN}`);
    expect(encoded.status).toBe(400);

    const doubleEncoded = await rawRequest(server, `/renderer/%252e%252e%252fpackage.json?token=${TEST_TOKEN}`);
    expect(doubleEncoded.status).toBe(400);

    const hidden = await rawRequest(server, `/renderer/.env?token=${TEST_TOKEN}`);
    expect(hidden.status).toBe(400);

    const missing = await fetch(`${base(server)}/renderer/pet-stage/nope.js?token=${TEST_TOKEN}`);
    expect(missing.status).toBe(404);

    const directory = await fetch(`${base(server)}/renderer/pet-stage?token=${TEST_TOKEN}`);
    expect(directory.status).toBe(404);
  });

  it('未鉴权的静态资源同样 401', async () => {
    const rendererRoot = makeRendererRoot();
    const server = await startWebUI({ rendererRoot, getState: stateProvider() });
    const response = await fetch(`${base(server)}/renderer/pet-stage/main.js`);
    expect(response.status).toBe(401);
  });

  it('未知路由 → 404；/ws 普通 GET → 400', async () => {
    const server = await startWebUI({ getState: stateProvider() });
    expect((await fetch(`${base(server)}/nope?token=${TEST_TOKEN}`)).status).toBe(404);
    expect((await fetch(`${base(server)}/ws?token=${TEST_TOKEN}`)).status).toBe(400);
  });
});

describe('[WebUI] WebSocket /ws', () => {
  it('token 校验通过 → hello 回放、publish 推送、ping/pong；close 关闭连接', async () => {
    const server = await startWebUI({ getState: stateProvider() });
    const messages: Array<Record<string, unknown>> = [];
    const socket = new WsClient(`ws://127.0.0.1:${server.port}/ws?token=${TEST_TOKEN}`);
    socket.on('message', (data: Buffer) => {
      messages.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });

    await waitFor(() => messages.some((message) => message.type === 'hello'));
    const hello = messages.find((message) => message.type === 'hello');
    expect(hello?.data).toMatchObject({ ok: true, events: [] });

    server.handle.publish({ type: 'receipt', summary: '钓到鱼了' });
    await waitFor(() => messages.some((message) => message.type === 'event'));
    expect(messages.find((message) => message.type === 'event')?.data).toEqual({
      type: 'receipt',
      summary: '钓到鱼了',
    });

    socket.send('ping');
    await waitFor(() => messages.some((message) => message.type === 'pong'));

    const closed = new Promise<void>((resolveClose) => socket.on('close', () => resolveClose()));
    await server.handle.close();
    await closed;
    await server.handle.close(); // 幂等
  });

  it('无 token / 错误路径 → 握手 401 / 404', async () => {
    const server = await startWebUI({ getState: stateProvider() });

    const unauthorized = await new Promise<number>((resolveStatus) => {
      const socket = new WsClient(`ws://127.0.0.1:${server.port}/ws`);
      socket.on('unexpected-response', (_req, response) => {
        resolveStatus(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.on('error', () => undefined);
    });
    expect(unauthorized).toBe(401);

    const wrongPath = await new Promise<number>((resolveStatus) => {
      const socket = new WsClient(`ws://127.0.0.1:${server.port}/not-ws?token=${TEST_TOKEN}`);
      socket.on('unexpected-response', (_req, response) => {
        resolveStatus(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.on('error', () => undefined);
    });
    expect(wrongPath).toBe(404);
  });
});

describe('[WebUI] 配置红线', () => {
  it('拒绝非回环 host 与空 token', () => {
    expect(() => createWebUIServer({ host: '0.0.0.0', port: 0 })).toThrow('仅允许绑定回环地址');
    expect(() => createWebUIServer({ port: 0, authToken: '   ' })).toThrow('authToken 不能为空');
  });

  it('localhost 归一化为 127.0.0.1 并可正常服务', async () => {
    const handle = createWebUIServer({ port: 0, host: 'localhost', authToken: TEST_TOKEN, getState: stateProvider() });
    const port = await handle.ready;
    running.push({ handle, port });
    const response = await fetch(`http://127.0.0.1:${port}/api/state?token=${TEST_TOKEN}`);
    expect(response.status).toBe(200);
  });
});

describe('[WebUI] 对外本机驱动口 /api/pet/:agentId/*（T-M6-49）', () => {
  const petState = {
    agentId: 'default', characterId: 'blue-whale-maid', displayName: '小鲸', skinId: '',
    sleeping: true, speaking: false, visible: true, bounds: { x: 10, y: 20, width: 400, height: 284 },
  };

  function petApiFixture() {
    const calls: string[] = [];
    return {
      calls,
      api: {
        state: (agentId: string) => (agentId === 'default' ? petState : null),
        say: (agentId: string, request: { text: string; wake: boolean }) => {
          calls.push(`say:${agentId}:${request.text}:${request.wake}`);
          if (agentId !== 'default') return { ok: false, error: '桌宠不存在' };
          if (petState.sleeping && !request.wake) return { ok: false, error: '桌宠正在安静睡眠（wake=true 可叫醒）' };
          return { ok: true };
        },
        action: (agentId: string, request: { actionState: string; durationMs: number }) => {
          calls.push(`action:${agentId}:${request.actionState}:${request.durationMs}`);
          return agentId === 'default' ? { ok: true } : { ok: false, error: '桌宠不存在' };
        },
      },
    };
  }

  it('state：无 token 401、存在 200、未知 404', async () => {
    const fixture = petApiFixture();
    const server = await startWebUI({ petApi: fixture.api });
    expect((await fetch(`${base(server)}/api/pet/default/state`)).status).toBe(401);
    const ok = await fetch(`${base(server)}/api/pet/default/state?token=${TEST_TOKEN}`);
    expect(ok.status).toBe(200);
    expect((await ok.json() as { state: typeof petState }).state.characterId).toBe('blue-whale-maid');
    expect((await fetch(`${base(server)}/api/pet/ghost/state?token=${TEST_TOKEN}`)).status).toBe(404);
  });

  it('say：睡觉态 409；wake=true 放行；非法 body 400；非 POST 405', async () => {
    const fixture = petApiFixture();
    const server = await startWebUI({ petApi: fixture.api });
    expect((await postJson(server, '/api/pet/default/say', { text: '你好' })).status).toBe(409);
    expect((await postJson(server, '/api/pet/default/say', { text: '你好', wake: true })).status).toBe(200);
    expect(fixture.calls).toContain('say:default:你好:true');
    expect((await postJson(server, '/api/pet/default/say', { text: '' })).status).toBe(400);
    expect((await postJson(server, '/api/pet/default/say', { text: 'x'.repeat(600) })).status).toBe(400);
    expect((await rawRequest(server, `/api/pet/default/say?token=${TEST_TOKEN}`, { method: 'GET' })).status).toBe(405);
    expect((await postJson(server, '/api/pet/default/say', { text: '你好' }, 'wrong-token')).status).toBe(401);
  });

  it('action：合法动作 200 且透传 durationMs；非法动作 400；未知桌宠 409', async () => {
    const fixture = petApiFixture();
    const server = await startWebUI({ petApi: fixture.api });
    expect((await postJson(server, '/api/pet/default/action', { actionState: 'happy_maid', durationMs: 6000 })).status).toBe(200);
    expect(fixture.calls).toContain('action:default:happy_maid:6000');
    expect((await postJson(server, '/api/pet/default/action', { actionState: 'dance' })).status).toBe(400);
    expect((await postJson(server, '/api/pet/ghost/action', { actionState: 'idle' })).status).toBe(409);
  });

  it('未注入 petApi → 501；非法 agentId → 400', async () => {
    const server = await startWebUI();
    expect((await fetch(`${base(server)}/api/pet/default/state?token=${TEST_TOKEN}`)).status).toBe(501);
    expect((await fetch(`${base(server)}/api/pet/${encodeURIComponent('../x')}/state?token=${TEST_TOKEN}`)).status).toBe(400);
  });
});
