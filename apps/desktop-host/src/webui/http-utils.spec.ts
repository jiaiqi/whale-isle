/**
 * WebUI HTTP 纯逻辑单测（T-M6-04）：
 * 路径防穿越（含编码变体）、token 鉴权（query/bearer/缺失/错误）、
 * JSON 响应（含循环引用降级）与请求体读取（空体/畸形/超限）。
 */
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  authorize,
  DEFAULT_BODY_LIMIT_BYTES,
  escapeHtml,
  isPathSafe,
  isRecord,
  jsonResponse,
  parseRequestUrl,
  readJsonBody,
} from './http-utils';

interface TestServer {
  port: number;
  close(): Promise<void>;
}

function startServer(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<TestServer> {
  return new Promise((resolveStart) => {
    const server: Server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolveStart({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** 发原始路径请求（fetch 会归一化 `..`，测穿越必须走 http.request 保留原始 request-target） */
function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
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

describe('parseRequestUrl', () => {
  it('拆分路径与查询参数，并保留未解码的 `..` 形态', () => {
    expect(parseRequestUrl('/api/state?token=abc&x=1')).toMatchObject({ pathname: '/api/state' });
    const parsed = parseRequestUrl('/api/state?token=abc&x=1');
    expect(parsed.query.get('token')).toBe('abc');
    expect(parsed.query.get('x')).toBe('1');

    expect(parseRequestUrl('').pathname).toBe('/');
    expect(parseRequestUrl('?a=1').pathname).toBe('/');
    expect(parseRequestUrl('?a=1').query.get('a')).toBe('1');
    expect(parseRequestUrl('/renderer/../package.json').pathname).toBe('/renderer/../package.json');
    expect(parseRequestUrl('/ws?token=a#frag').pathname).toBe('/ws');
    expect(parseRequestUrl('/ws?token=a#frag').query.get('token')).toBe('a');
  });

  it('absolute-form（代理式请求）退化为 URL 解析；畸形 absolute-form 不抛异常', () => {
    const parsed = parseRequestUrl('http://127.0.0.1:18766/api/state?token=t');
    expect(parsed.pathname).toBe('/api/state');
    expect(parsed.query.get('token')).toBe('t');

    const malformed = parseRequestUrl('http://[bad');
    expect(malformed.pathname).toBe('http://[bad');
    expect(malformed.query.size).toBe(0);
  });
});

describe('isPathSafe（静态路径防穿越）', () => {
  it('正常静态路径全部放行（含百分号编码的中文/空格）', () => {
    expect(isPathSafe('/renderer/pet-stage/main.js')).toBe(true);
    expect(isPathSafe('/renderer/assets/blue-whale-maid/idle.webm')).toBe(true);
    expect(isPathSafe('/renderer/%E7%B4%A0%E6%9D%90/a%20b.png')).toBe(true);
    expect(isPathSafe('/')).toBe(true);
  });

  it('拒绝明文 `.` / `..` 段、反斜杠与空字节', () => {
    expect(isPathSafe('/renderer/../package.json')).toBe(false);
    expect(isPathSafe('/renderer/a/../../etc/passwd')).toBe(false);
    expect(isPathSafe('/renderer/./main.js')).toBe(false);
    expect(isPathSafe('/renderer\\..\\package.json')).toBe(false);
    expect(isPathSafe('/renderer/a%00b.js')).toBe(false);
  });

  it('拒绝单层/双层/多层百分号编码的穿越变体', () => {
    expect(isPathSafe('/renderer/%2e%2e/package.json')).toBe(false);
    expect(isPathSafe('/renderer/%2E%2E%2Fpackage.json')).toBe(false);
    expect(isPathSafe('/renderer/%252e%252e%252fpackage.json')).toBe(false);
    expect(isPathSafe('/renderer/%25252e%25252e%25252fpackage.json')).toBe(false);
    // 5 层编码：解码轮次耗尽仍在变化 → 可疑，拒绝
    expect(isPathSafe('/renderer/%252525252e%252525252e%252525252fpackage.json')).toBe(false);
  });

  it('畸形百分号编码直接拒绝', () => {
    expect(isPathSafe('/renderer/%zz')).toBe(false);
    expect(isPathSafe('/renderer/%E0%A4%A')).toBe(false);
  });
});

describe('authorize（设备 token 鉴权）', () => {
  it('query token 命中', () => {
    expect(authorize('secret', {}, '/api/state?token=secret')).toBe(true);
    expect(authorize('secret', {}, '/api/state?x=1&token=secret')).toBe(true);
  });

  it('Authorization: Bearer 命中（scheme 大小写不敏感、允许空白）', () => {
    expect(authorize('secret', { authorization: 'Bearer secret' }, '/api/state')).toBe(true);
    expect(authorize('secret', { authorization: 'bearer   secret  ' }, '/api/state')).toBe(true);
  });

  it('缺失 / 错误 / 空配置一律拒绝', () => {
    expect(authorize('secret', {}, '/api/state')).toBe(false);
    expect(authorize('secret', { authorization: 'Bearer wrong' }, '/api/state')).toBe(false);
    expect(authorize('secret', { authorization: 'Basic secret' }, '/api/state')).toBe(false);
    expect(authorize('secret', { authorization: 'Bearer ' }, '/api/state')).toBe(false);
    expect(authorize('secret', {}, '/api/state?token=wrong')).toBe(false);
    expect(authorize('', {}, '/api/state?token=')).toBe(false);
    expect(authorize('', { authorization: 'Bearer x' }, '/api/state')).toBe(false);
  });

  it('防御：authorization 头被中间件拆成数组时取第一个', () => {
    const headers = { authorization: ['Bearer secret'] } as unknown as IncomingHttpHeaders;
    expect(authorize('secret', headers, '/api/state')).toBe(true);
  });
});

describe('escapeHtml / isRecord', () => {
  it('转义五个 HTML 危险字符', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('普通 token')).toBe('普通 token');
  });

  it('isRecord 只认普通对象', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe('jsonResponse', () => {
  it('输出 JSON + 状态码 + Content-Length', async () => {
    const server = await startServer((_req, res) => jsonResponse(res, 201, { ok: true, value: 1 }));
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(201);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await response.json()).toEqual({ ok: true, value: 1 });
    } finally {
      await server.close();
    }
  });

  it('循环引用序列化失败 → 降级为 500 JSON（不抛异常）', async () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    const server = await startServer((_req, res) => jsonResponse(res, 200, circular));
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: '响应序列化失败' });
    } finally {
      await server.close();
    }
  });

  it('payload 为 undefined 时输出 null', async () => {
    const server = await startServer((_req, res) => jsonResponse(res, 200, undefined));
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await response.json()).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('函数 payload（JSON.stringify → undefined）输出 null；重复响应安全', async () => {
    const server = await startServer((_req, res) => jsonResponse(res, 200, () => 'x'));
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    } finally {
      await server.close();
    }

    const repeated = await startServer((_req, res) => {
      jsonResponse(res, 200, { first: true });
      jsonResponse(res, 500, { second: true }); // writableEnded → 直接 return
    });
    try {
      const response = await fetch(`http://127.0.0.1:${repeated.port}/`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ first: true });
    } finally {
      await repeated.close();
    }
  });

  it('循环引用 + 5xx 状态码：保留原状态码并降级 JSON', async () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    const server = await startServer((_req, res) => jsonResponse(res, 503, circular));
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: '响应序列化失败' });
    } finally {
      await server.close();
    }
  });
});

describe('readJsonBody', () => {
  it('解析 JSON / 空体返回 undefined / 默认上限为 64KB', async () => {
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(64 * 1024);
    const server = await startServer((req, res) => {
      void readJsonBody(req)
        .then((body) => jsonResponse(res, 200, { body: body ?? null }))
        .catch((error: unknown) =>
          jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) }),
        );
    });
    try {
      const good = await rawRequest(server.port, '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      });
      expect(good.status).toBe(200);
      expect(JSON.parse(good.body)).toEqual({ body: { text: '你好' } });

      const empty = await rawRequest(server.port, '/', { method: 'POST' });
      expect(empty.status).toBe(200);
      expect(JSON.parse(empty.body)).toEqual({ body: null });
    } finally {
      await server.close();
    }
  });

  it('畸形 JSON 与超限请求体都 reject（HTTP 层可回 400）', async () => {
    const server = await startServer((req, res) => {
      void readJsonBody(req, 8)
        .then((body) => jsonResponse(res, 200, { body: body ?? null }))
        .catch((error: unknown) =>
          jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) }),
        );
    });
    try {
      const malformed = await rawRequest(server.port, '/', { method: 'POST', body: '{oops' });
      expect(malformed.status).toBe(400);
      expect(JSON.parse(malformed.body).error).toBe('请求体不是合法 JSON');

      const tooLarge = await rawRequest(server.port, '/', { method: 'POST', body: 'x'.repeat(64) });
      expect(tooLarge.status).toBe(400);
      expect(String(JSON.parse(tooLarge.body).error)).toContain('请求体超过上限');
    } finally {
      await server.close();
    }
  });

  it('流错误 reject；超限后剩余 chunk 被 settled 短路', async () => {
    const errored = new PassThrough();
    const errorPromise = readJsonBody(errored as unknown as IncomingMessage);
    errored.emit('error', new Error('stream boom'));
    await expect(errorPromise).rejects.toThrow('stream boom');

    const chunked = new PassThrough();
    const chunkPromise = readJsonBody(chunked as unknown as IncomingMessage, 4);
    chunked.write('abcdef'); // 首块即超限 → reject + resume
    chunked.write('gh'); // 后续 data 事件被 settled 短路
    chunked.end();
    await expect(chunkPromise).rejects.toThrow('请求体超过上限');
  });
});
