/** 生图客户端（T-M6-56）：OpenAI b64/url、Gemini inlineData、参考图 edits、超时与脱敏。 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  geminiGenerateEndpoint,
  generateImage,
  openAiImagesEndpoints,
  parseGeminiImageResponse,
  parseOpenAiImageResponse,
  redactSecrets,
  type ImageFetch,
  type ImageFetchResponse,
} from './image-gen-client';

function jsonResponse(body: unknown, status = 200): ImageFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  };
}

function bytesResponse(buffer: Buffer, mime = 'image/png', status = 200): ImageFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
    json: async () => ({}),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? mime : null) },
  };
}

const KEY = 'sk-test-secret-1234567890';

describe('端点拼接', () => {
  it('OpenAI base 补 /images/generations；已是完整端点则复用并推导 edits', () => {
    expect(openAiImagesEndpoints('https://api.openai.com/v1')).toEqual({
      generations: 'https://api.openai.com/v1/images/generations',
      edits: 'https://api.openai.com/v1/images/edits',
    });
    expect(openAiImagesEndpoints('https://relay.example.com/v1/images/generations').edits)
      .toBe('https://relay.example.com/v1/images/edits');
  });

  it('Gemini 缺版本段补 /v1beta；已带版本段保留', () => {
    expect(geminiGenerateEndpoint('https://generativelanguage.googleapis.com', 'gemini-2.5-flash-image-preview'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent');
    expect(geminiGenerateEndpoint('https://proxy.example.com/v1beta/', 'gemini-2.5-flash-image-preview'))
      .toBe('https://proxy.example.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent');
  });
});

describe('响应解析', () => {
  it('OpenAI b64_json 直接解码；url 走第二跳下载且不带 Authorization', async () => {
    const buffer = Buffer.from('fake-png');
    await expect(parseOpenAiImageResponse({ data: [{ b64_json: buffer.toString('base64') }] }, async () => { throw new Error('不该下载'); }))
      .resolves.toEqual({ buffer, mimeType: 'image/png' });

    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetch: ImageFetch = async (url, init) => {
      calls.push({ url, ...(init.headers === undefined ? {} : { headers: init.headers }) });
      return bytesResponse(buffer, 'image/webp');
    };
    const result = await parseOpenAiImageResponse({ data: [{ url: 'https://cdn.example.com/tmp.png' }] }, async (url) => {
      const res = await fetch(url, { method: 'GET' });
      return { buffer: Buffer.from(await res.arrayBuffer!()), mimeType: res.headers!.get('content-type') ?? 'image/png' };
    });
    expect(result).toEqual({ buffer, mimeType: 'image/webp' });
    expect(calls[0]?.headers).toBeUndefined();
  });

  it('OpenAI 缺字段/坏 data 抛错', async () => {
    await expect(parseOpenAiImageResponse({}, async () => { throw new Error('x'); })).rejects.toThrow('data[0]');
    await expect(parseOpenAiImageResponse({ data: [{}] }, async () => { throw new Error('x'); })).rejects.toThrow('b64_json');
  });

  it('Gemini 解析 inlineData 与 inline_data 两种命名', () => {
    const buffer = Buffer.from('gemini-img');
    expect(parseGeminiImageResponse({ candidates: [{ content: { parts: [{ text: '...' }, { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } }] } }] }))
      .toEqual({ buffer, mimeType: 'image/jpeg' });
    expect(parseGeminiImageResponse({ candidates: [{ content: { parts: [{ inline_data: { data: buffer.toString('base64') } }] } }] }))
      .toEqual({ buffer, mimeType: 'image/png' });
    expect(() => parseGeminiImageResponse({ candidates: [{ content: { parts: [{ text: '无图' }] } }] })).toThrow('inlineData');
  });
});

describe('generateImage', () => {
  it('OpenAI 文本出图：POST /images/generations，带 Bearer 与 b64 解析', async () => {
    const buffer = Buffer.from('openai-image');
    const calls: Array<{ url: string; init: Parameters<ImageFetch>[1] }> = [];
    const fetch: ImageFetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ data: [{ b64_json: buffer.toString('base64') }] });
    };
    const result = await generateImage({
      protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY, modelId: 'gpt-image-1', prompt: '画一只海豹', fetch,
    });
    expect(result.buffer).toEqual(buffer);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-image-1', prompt: '画一只海豹', n: 1, size: '1024x1024', background: 'transparent' });
    expect(body.response_format).toBeUndefined(); // gpt-image-1 不传 response_format
  });

  it('dall-e-3 显式请求 b64_json；参考图走 /images/edits multipart', async () => {
    const buffer = Buffer.from('edited');
    const calls: Array<{ url: string; init: Parameters<ImageFetch>[1] }> = [];
    const fetch: ImageFetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ data: [{ b64_json: buffer.toString('base64') }] });
    };
    await generateImage({
      protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY, modelId: 'dall-e-3', prompt: '改一下',
      referenceImagePath: '/tmp/ref.png', fetch, readFile: () => Buffer.from('ref'),
    });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/images/edits');
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    const form = calls[0]?.init.body as FormData;
    expect(form.get('model')).toBe('dall-e-3');
    expect(form.get('response_format')).toBe('b64_json');
    expect(form.get('image')).not.toBeNull();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined(); // 让 fetch 自动带 multipart boundary
  });

  it('Gemini 原生：x-goog-api-key + responseModalities IMAGE + 参考图 inline_data', async () => {
    const buffer = Buffer.from('gemini-image');
    const calls: Array<{ url: string; init: Parameters<ImageFetch>[1] }> = [];
    const fetch: ImageFetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { data: buffer.toString('base64'), mimeType: 'image/png' } }] } }] });
    };
    const result = await generateImage({
      protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: KEY,
      modelId: 'gemini-2.5-flash-image-preview', prompt: '画一只鲸鱼',
      referenceImagePath: '/tmp/ref.webp', fetch, readFile: () => Buffer.from('ref-webp'),
    });
    expect(result.buffer).toEqual(buffer);
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig: { responseModalities: string[] };
    };
    expect(body.generationConfig.responseModalities).toEqual(['IMAGE']);
    expect(body.contents[0]?.parts[1]).toMatchObject({ inline_data: { mime_type: 'image/webp' } });
  });

  it('HTTP 错误脱敏：报错不含 Key / Bearer', async () => {
    const fetch: ImageFetch = async () => ({
      ok: false, status: 401,
      text: async () => `invalid key ${KEY} Authorization: Bearer ${KEY}`,
      json: async () => ({}),
    });
    const error = await generateImage({
      protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY, modelId: 'gpt-image-1', prompt: 'x', fetch,
    }).catch((reason: unknown) => reason);
    if (!(error instanceof Error)) throw new Error('预期 generateImage 抛错');
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('Bearer sk-');
  });

  it('单张超时：abort 后报「生图超时」，不泄露 Key', async () => {
    const fetch: ImageFetch = (url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error(`aborted ${url}`)));
    });
    const error = await generateImage({
      protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY, modelId: 'gpt-image-1', prompt: 'x', timeoutMs: 1_000, fetch,
    }).catch((reason: unknown) => reason);
    if (!(error instanceof Error)) throw new Error('预期 generateImage 超时抛错');
    expect(error.message).toContain('生图超时');
    expect(error.message).not.toContain(KEY);
  }, 5_000);

  it('缺 Key / 缺 baseUrl / 缺模型直接拒绝，不发请求', async () => {
    const fetch = vi.fn() as unknown as ImageFetch;
    await expect(generateImage({ protocol: 'openai', baseUrl: 'https://x.example', apiKey: ' ', modelId: 'm', prompt: 'p', fetch })).rejects.toThrow('未配置 Key');
    await expect(generateImage({ protocol: 'openai', baseUrl: ' ', apiKey: KEY, modelId: 'm', prompt: 'p', fetch })).rejects.toThrow('baseUrl');
    await expect(generateImage({ protocol: 'openai', baseUrl: 'https://x.example', apiKey: KEY, modelId: ' ', prompt: 'p', fetch })).rejects.toThrow('模型');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('redactSecrets', () => {
  it('替换显式 Key、Bearer、查询参数与 goog 头', () => {
    const out = redactSecrets(`key ${KEY} Bearer ${KEY} ?key=${KEY}&x=1 x-goog-api-key: ${KEY}`, KEY);
    expect(out).not.toContain(KEY);
    expect(out).toContain('••••');
    expect(out).toContain('&x=1');
  });
});

describe('codex-cli 协议（T-M6-61）', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  const detection = {
    available: true,
    backend: 'codex-imagegen' as const,
    binary: '/usr/local/bin/codex-imagegen',
    loggedIn: true,
    codexHome: '/home/u/.codex',
    installHint: 'npm install -g codex-imagegen-cli',
    loginHint: 'codex login',
  };

  it('无需 API Key：execFile 参数数组出图并返回标准 GeneratedImage', async () => {
    const calls: string[][] = [];
    const result = await generateImage({
      protocol: 'codex-cli',
      baseUrl: 'https://codex.local/',
      apiKey: '',
      modelId: 'codex-imagegen',
      prompt: '画一只像素鲸鱼',
      size: '1024x1024',
      codex: {
        detection,
        execFileImpl: (_file, args, _opts, callback) => {
          calls.push(args);
          const out = args[args.indexOf('--out') + 1]!;
          writeFileSync(out, PNG);
          callback(null, 'ok', '');
        },
      },
    });
    expect(result.mimeType).toBe('image/png');
    expect(result.buffer.subarray(0, 4)).toEqual(PNG.subarray(0, 4));
    expect(calls[0]!.slice(0, 8)).toEqual(['generate', '--prompt', '画一只像素鲸鱼', '--size', '1024x1024', '--background', 'opaque', '--out']);
    expect(calls[0]![8]).toMatch(/whale-codex-.+\.png$/);
  });

  it('未注入探测结果 / CLI 失败：如实报错且不含 token', async () => {
    await expect(generateImage({ protocol: 'codex-cli', baseUrl: 'https://codex.local/', apiKey: '', modelId: 'm', prompt: 'p' }))
      .rejects.toThrow('未注入探测结果');
    await expect(generateImage({
      protocol: 'codex-cli', baseUrl: 'https://codex.local/', apiKey: '', modelId: 'm', prompt: 'p',
      codex: {
        detection: { ...detection, loggedIn: false },
        execFileImpl: () => { throw new Error('不应执行'); },
      },
    })).rejects.toThrow('codex login');
  });
});
