/**
 * 创作中心直连生图客户端（T-M6-56 / T-M6-61）。
 *
 * 纯封装：OpenAI/Gemini 只接收**主进程 provider-vault 解密后的 Key**（绝不经 IPC 回传渲染层）；
 * `codex-cli` 走本机 Codex CLI 订阅额度（不需要 Key，凭据留在 ~/.codex，由 CLI 自己读取）。
 * 三类真实协议：
 *   ① OpenAI 兼容 Images API：POST {base}/images/generations（参考图走 /images/edits），
 *      解析 `data[0].b64_json` 或拉取临时 `url` 转 Buffer；
 *   ② Gemini Native：POST {base}/models/{model}:generateContent + responseModalities:["IMAGE"]，
 *      解析 `candidates[0].content.parts[].inlineData.data`；
 *   ③ Codex CLI：execFile 参数数组调用本机 codex-imagegen / codex exec，校验产出 PNG/WebP/JPEG。
 * 单张 60s 超时（codex-cli 90s）；所有异常文本经脱敏（绝不把 Authorization / API Key / token 写进报错）。
 * fetch / 文件读取 / execFile 可注入，单测零外网。
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { codexTempOutPath, removeQuietly, runCodexImage, type CodexCliDetection, type ExecFileLike } from './codex-image-backend';

export interface ImageFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}

export type ImageFetch = (
  url: string,
  init: {
    method: 'POST' | 'GET';
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
  },
) => Promise<ImageFetchResponse>;

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
}

export interface GenerateImageArgs {
  protocol: 'openai' | 'gemini' | 'codex-cli';
  baseUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  size?: string;
  referenceImagePath?: string;
  timeoutMs?: number;
  fetch?: ImageFetch;
  readFile?: (path: string) => Buffer;
  /** codex-cli 协议必填：主进程探测结果与可注入的 execFile（测试零外网） */
  codex?: { detection: CodexCliDetection; execFileImpl?: ExecFileLike };
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 400;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** 凭据脱敏：显式 Key、Bearer 头、查询参数 key、x-goog-api-key 一律替换。 */
export function redactSecrets(text: string, secret?: string): string {
  let out = text;
  const trimmed = (secret ?? '').trim();
  if (trimmed !== '') out = out.split(trimmed).join('••••');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ••••');
  out = out.replace(/([?&](?:key|api_key|api-key)=)[^&\s"']+/gi, '$1••••');
  out = out.replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]+/gi, '$1••••');
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS)}…` : out;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** OpenAI 兼容端点：命中 /images/generations 则原样使用；否则按 /v1 惯例追加。 */
export function openAiImagesEndpoints(baseUrl: string): { generations: string; edits: string } {
  const clean = trimBase(baseUrl);
  if (/\/images\/generations$/.test(clean)) {
    return { generations: clean, edits: clean.replace(/\/generations$/, '/edits') };
  }
  if (/\/images\/edits$/.test(clean)) {
    return { generations: clean.replace(/\/edits$/, '/generations'), edits: clean };
  }
  return { generations: `${clean}/images/generations`, edits: `${clean}/images/edits` };
}

/** Gemini Native 端点：已带版本段则保留，否则补 /v1beta。 */
export function geminiGenerateEndpoint(baseUrl: string, modelId: string): string {
  const clean = trimBase(baseUrl);
  const base = /\/v\d+(?:beta|alpha)?$/.test(clean) ? clean : `${clean}/v1beta`;
  return `${base}/models/${encodeURIComponent(modelId)}:generateContent`;
}

/** OpenAI 响应解析：b64_json 直接解码；url 由调用方拉取（第二跳不带 Authorization）。 */
export async function parseOpenAiImageResponse(
  body: unknown,
  fetchBytes: (url: string) => Promise<GeneratedImage>,
): Promise<GeneratedImage> {
  const data = (body as { data?: unknown })?.data;
  const first = Array.isArray(data) ? data[0] as { b64_json?: unknown; url?: unknown } | undefined : undefined;
  if (first === undefined) throw new Error('OpenAI 生图响应缺少 data[0]');
  if (typeof first.b64_json === 'string' && first.b64_json.trim() !== '') {
    return { buffer: Buffer.from(first.b64_json, 'base64'), mimeType: 'image/png' };
  }
  if (typeof first.url === 'string' && /^https?:\/\//i.test(first.url)) {
    return fetchBytes(first.url);
  }
  throw new Error('OpenAI 生图响应缺少 b64_json / url');
}

/** Gemini 响应解析：candidates[0].content.parts[].inlineData（兼容 snake_case）。 */
export function parseGeminiImageResponse(body: unknown): GeneratedImage {
  const candidates = (body as { candidates?: unknown })?.candidates;
  const first = Array.isArray(candidates) ? candidates[0] as { content?: { parts?: unknown } } | undefined : undefined;
  const parts = first?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const record = part as {
        inlineData?: { data?: unknown; mimeType?: unknown };
        inline_data?: { data?: unknown; mime_type?: unknown };
      };
      const inline = record.inlineData ?? record.inline_data;
      const data = inline?.data;
      if (typeof data === 'string' && data.trim() !== '') {
        const mime = (record.inlineData?.mimeType ?? record.inline_data?.mime_type);
        return { buffer: Buffer.from(data, 'base64'), mimeType: typeof mime === 'string' && mime !== '' ? mime : 'image/png' };
      }
    }
  }
  throw new Error('Gemini 生图响应缺少 inlineData 图像');
}

function readErrorText(response: ImageFetchResponse): Promise<string> {
  return response.text().catch(() => '');
}

async function defaultFetch(url: string, init: Parameters<ImageFetch>[1]): Promise<ImageFetchResponse> {
  const response = await globalThis.fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer(),
    headers: { get: (name: string) => response.headers.get(name) },
  };
}

export async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  // T-M6-61：本机 Codex CLI 不需要 API Key（订阅额度在 CLI 自己的 auth.json 里）
  if (args.protocol === 'codex-cli') {
    if (args.codex === undefined) throw new Error('Codex CLI 后端未注入探测结果');
    if (args.prompt.trim() === '') throw new Error('生图提示词为空');
    const outPng = codexTempOutPath();
    try {
      const result = await runCodexImage({
        detection: args.codex.detection,
        prompt: args.prompt,
        size: args.size ?? '1024x1024',
        outPng,
        ...(args.referenceImagePath === undefined || args.referenceImagePath.trim() === '' ? {} : { refPath: args.referenceImagePath }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.codex.execFileImpl === undefined ? {} : { execFileImpl: args.codex.execFileImpl }),
        ...(args.readFile === undefined ? {} : { readFile: args.readFile }),
      });
      if (!result.ok || result.buffer === undefined || result.mimeType === undefined) {
        throw new Error(result.error ?? 'Codex CLI 未产出图片');
      }
      return { buffer: result.buffer, mimeType: result.mimeType };
    } finally {
      removeQuietly(outPng);
    }
  }
  if (args.apiKey.trim() === '') throw new Error('生图供应商未配置 Key');
  if (args.baseUrl.trim() === '') throw new Error('生图供应商缺少 baseUrl');
  if (args.modelId.trim() === '') throw new Error('生图模型未选择');
  const fetchImpl = args.fetch ?? defaultFetch;
  const readFile = args.readFile ?? ((path: string) => readFileSync(path));
  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reference = args.referenceImagePath === undefined || args.referenceImagePath.trim() === ''
      ? null
      : (() => {
        const bytes = readFile(args.referenceImagePath);
        const ext = extname(args.referenceImagePath).toLowerCase();
        return {
          bytes,
          mimeType: IMAGE_MIME_BY_EXT[ext] ?? 'image/png',
          filename: basename(args.referenceImagePath),
        };
      })();
    if (args.protocol === 'gemini') {
      return await generateGemini({ ...args, fetch: fetchImpl, reference, signal: controller.signal });
    }
    return await generateOpenAi({ ...args, fetch: fetchImpl, reference, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(redactSecrets(`生图超时（${timeoutMs}ms 未返回）`, args.apiKey));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, args.apiKey));
  } finally {
    clearTimeout(timer);
  }
}

async function generateOpenAi(args: GenerateImageArgs & {
  fetch: ImageFetch;
  signal: AbortSignal;
  reference: { bytes: Buffer; mimeType: string; filename: string } | null;
}): Promise<GeneratedImage> {
  const endpoints = openAiImagesEndpoints(args.baseUrl);
  const size = args.size ?? '1024x1024';
  const isDallE = /^dall-e/i.test(args.modelId);
  const isGptImage = /^gpt-image/i.test(args.modelId);
  let body: string | FormData;
  let headers: Record<string, string>;
  if (args.reference === null) {
    headers = { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' };
    body = JSON.stringify({
      model: args.modelId,
      prompt: args.prompt,
      n: 1,
      size,
      ...(isDallE ? { response_format: 'b64_json' } : {}),
      ...(isGptImage ? { background: 'transparent' } : {}),
    });
  } else {
    const form = new FormData();
    form.append('model', args.modelId);
    form.append('prompt', args.prompt);
    form.append('n', '1');
    form.append('size', size);
    if (isDallE) form.append('response_format', 'b64_json');
    if (isGptImage) form.append('background', 'transparent');
    form.append('image', new Blob([new Uint8Array(args.reference.bytes)], { type: args.reference.mimeType }), args.reference.filename);
    body = form;
    headers = { Authorization: `Bearer ${args.apiKey}` };
  }
  const response = await args.fetch(args.reference === null ? endpoints.generations : endpoints.edits, {
    method: 'POST',
    headers,
    body,
    signal: args.signal,
  });
  if (!response.ok) {
    const text = await readErrorText(response);
    throw new Error(`OpenAI 生图失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  const json = await response.json();
  return parseOpenAiImageResponse(json, async (url) => {
    const download = await args.fetch(url, { method: 'GET', signal: args.signal });
    if (!download.ok) throw new Error(`生图临时图片下载失败（HTTP ${download.status}）`);
    if (download.arrayBuffer === undefined) throw new Error('生图临时图片下载失败（响应不可读）');
    const buffer = Buffer.from(await download.arrayBuffer());
    const mime = download.headers?.get('content-type')?.split(';')[0]?.trim() ?? '';
    return { buffer, mimeType: mime.startsWith('image/') ? mime : 'image/png' };
  });
}

async function generateGemini(args: GenerateImageArgs & {
  fetch: ImageFetch;
  signal: AbortSignal;
  reference: { bytes: Buffer; mimeType: string; filename: string } | null;
}): Promise<GeneratedImage> {
  const parts: Array<Record<string, unknown>> = [{ text: args.prompt }];
  if (args.reference !== null) {
    parts.push({ inline_data: { mime_type: args.reference.mimeType, data: args.reference.bytes.toString('base64') } });
  }
  const response = await args.fetch(geminiGenerateEndpoint(args.baseUrl, args.modelId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': args.apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
    signal: args.signal,
  });
  if (!response.ok) {
    const text = await readErrorText(response);
    throw new Error(`Gemini 生图失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  return parseGeminiImageResponse(await response.json());
}
