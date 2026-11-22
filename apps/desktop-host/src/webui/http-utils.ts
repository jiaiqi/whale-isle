/**
 * WebUI HTTP 工具（T-M6-04）：请求 URL 解析、静态路径防穿越、设备 token 鉴权、
 * 统一 JSON 响应与请求体读取。
 *
 * 这里只放「可脱离 Electron 单测」的纯逻辑（server 侧复用，浏览器侧不引用本文件），
 * 便于 vitest 在 node 环境下直接覆盖——webui-server.ts 位于 main/ 下，coverage 已排除。
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

/** stop 附近的最长解码轮次：超过仍不稳定视为可疑双重编码，直接拒绝 */
const MAX_DECODE_ROUNDS = 3;

/** 请求体默认上限（WebUI 只收短指令/审批，不允许大文件） */
export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;

export interface ParsedRequestUrl {
  /** 未解码的路径部分（保留 `..`、`%2e%2e` 等原始形态供 isPathSafe 审查） */
  pathname: string;
  query: URLSearchParams;
}

/**
 * 解析 request-target：只切 `?` / `#`，不做 URL 规范化。
 * 注意不能用 `new URL(path).pathname`——它会把 `/a/../b` 归一化成 `/b`，
 * 从而掩盖路径穿越意图（防穿越需要看到原始形态）。
 * 代理式 absolute-form（`http://host/path`）才退化为 URL 解析。
 */
export function parseRequestUrl(rawUrl: string): ParsedRequestUrl {
  const input = rawUrl === '' ? '/' : rawUrl;
  const hashIndex = input.indexOf('#');
  const withoutHash = hashIndex >= 0 ? input.slice(0, hashIndex) : input;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(withoutHash)) {
    try {
      const url = new URL(withoutHash);
      // WHATWG URL：absolute-form 的 pathname 至少为 '/'，无需再兜底
      return { pathname: url.pathname, query: url.searchParams };
    } catch {
      // 畸形 absolute-form：按普通路径处理，交给 isPathSafe 拒绝
      return { pathname: withoutHash, query: new URLSearchParams() };
    }
  }

  const queryIndex = withoutHash.indexOf('?');
  const rawPath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const rawQuery = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  return {
    pathname: rawPath === '' ? '/' : rawPath,
    query: new URLSearchParams(rawQuery),
  };
}

/** 单层路径审查：空字节、反斜杠（Windows 分隔符）与 `.` / `..` 段全部拒绝 */
function isSegmentSafe(value: string): boolean {
  if (value.includes('\0') || value.includes('\\')) return false;
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') return false;
  }
  return true;
}

/**
 * 静态路径防穿越：反复解码（最多 4 轮）后逐轮审查，
 * 覆盖 `../`、`%2e%2e%2f`、`%252e%252e%252f`（双重编码）、`..\\`、`%00` 等变体。
 * 畸形百分号编码（decodeURIComponent 抛 URIError）一律拒绝。
 */
export function isPathSafe(pathname: string): boolean {
  let current = pathname;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    if (!isSegmentSafe(current)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false;
    }
    if (decoded === current) return true;
    current = decoded;
  }
  return false; // 解码轮次耗尽仍在变化 → 可疑，拒绝
}

/** 长度一致的常量时间比较（token 非空时才会进入） */
function safeEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 设备 token 鉴权：查询参数 `?token=` 或 `Authorization: Bearer <token>` 任一命中即通过。
 * `expected` 为空字符串时一律拒绝（server 启动必生成 token，空值属配置错误）。
 */
export function authorize(expected: string, headers: IncomingHttpHeaders, url: string): boolean {
  if (expected === '') return false;

  const fromQuery = parseRequestUrl(url).query.get('token');
  if (fromQuery !== null && safeEqual(fromQuery, expected)) return true;

  const rawAuthorization = headers.authorization;
  const header = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const fromHeader = match?.[1]?.trim();
  if (fromHeader === undefined || fromHeader === '') return false;
  return safeEqual(fromHeader, expected);
}

/** H5 内联外壳的属性转义（token 等外部字符串绝不裸拼进 HTML） */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 统一 JSON 响应：序列化失败降级为 500 JSON，绝不向调用方抛异常 */
export function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  let body: string;
  let finalStatus = status;
  try {
    const serialized = JSON.stringify(payload ?? null);
    body = serialized === undefined ? 'null' : serialized;
  } catch {
    finalStatus = status >= 500 ? status : 500;
    body = JSON.stringify({ ok: false, error: '响应序列化失败' });
  }
  res.statusCode = finalStatus;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
}

/** 读请求体并 JSON.parse；空体返回 undefined（由路由决定是否算错误） */
export function readJsonBody(req: IncomingMessage, limitBytes = DEFAULT_BODY_LIMIT_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settle(() => {
          reject(new Error(`请求体超过上限（${limitBytes} 字节）`));
          // 不 destroy：让响应仍能写回（413/400 由路由决定），剩余数据丢弃
          req.resume();
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      settle(() => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw === '') {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
    });
    req.on('error', (error) => settle(() => reject(error)));
  });
}

/** JSON 对象收窄（不用 any；数组/ null 都不算 record） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
