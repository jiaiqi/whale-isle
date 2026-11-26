import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ObsConfigPaths } from './config-probe.js';
import {
  PROBE_EXIT,
  RED_PAGE,
  formatPreconditionReport,
  formatServeBanner,
  parseMode,
  passwordFromArgs,
  runProbe,
  startRedPageServer,
} from './cli.js';
import type { ObsWebsocketClient } from './obs-websocket-client.js';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造 OBS 截图用的纯色 PNG（data URI 形态，与 GetSourceScreenshot 返回一致） */
function colorPngDataUri(rgb: [number, number, number], size = 4): string {
  const raw = Buffer.alloc(size * (1 + size * 3));
  let pos = 0;
  for (let y = 0; y < size; y += 1) {
    raw[pos] = 0;
    pos += 1;
    for (let x = 0; x < size; x += 1) {
      raw[pos] = rgb[0];
      raw[pos + 1] = rgb[1];
      raw[pos + 2] = rgb[2];
      pos += 3;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** 假 obs-websocket 客户端：记录请求并按需返回截图或抛错 */
class FakeClient {
  readonly requests: Array<{ requestType: string; requestData?: Record<string, unknown> }> = [];
  receivedPassword: string | undefined;
  closed = false;
  constructor(
    private readonly behavior: {
      connectError?: Error;
      screenshot?: string;
      requestError?: { requestType: string; error: Error };
    } = {},
  ) {}

  async connect(password?: string): Promise<void> {
    this.receivedPassword = password;
    if (this.behavior.connectError !== undefined) throw this.behavior.connectError;
  }

  async request(options: { requestType: string; requestData?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    this.requests.push(options);
    if (this.behavior.requestError?.requestType === options.requestType) {
      throw this.behavior.requestError.error;
    }
    if (options.requestType === 'GetVersion') {
      return { obsVersion: '33.0.3', obsWebSocketVersion: '5.7.6' };
    }
    if (options.requestType === 'GetSourceScreenshot') {
      return { imageData: this.behavior.screenshot ?? colorPngDataUri([204, 0, 0]) };
    }
    return {};
  }

  close(): void {
    this.closed = true;
  }

  asClient(): ObsWebsocketClient {
    return this as unknown as ObsWebsocketClient;
  }

  types(): string[] {
    return this.requests.map((r) => r.requestType);
  }
}

const fakeRedPage = {
  url: 'http://127.0.0.1:12345/red',
  close: async (): Promise<void> => undefined,
};

function enabledConfigPaths(): ObsConfigPaths {
  return { globalIni: '/nonexistent/global.ini', websocketConfig: '/nonexistent/ws.json' };
}

/** 写一组临时 OBS 配置，返回路径 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function writeConfigs(globalIni: string, ws: Record<string, unknown>): ObsConfigPaths {
  const base = join(mkdtempSync(join(tmpdir(), 'obs-cli-')), 'obs-studio');
  mkdirSync(join(base, 'plugin_config', 'obs-websocket'), { recursive: true });
  writeFileSync(join(base, 'global.ini'), globalIni);
  writeFileSync(join(base, 'plugin_config', 'obs-websocket', 'config.json'), JSON.stringify(ws));
  return {
    globalIni: join(base, 'global.ini'),
    websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
  };
}

describe('passwordFromArgs', () => {
  it('优先取 --password 的值，其次取环境变量，都没有则 undefined', () => {
    expect(passwordFromArgs(['--probe', '--password', 'p1'], { OBS_WEBSOCKET_PASSWORD: 'env-pw' })).toBe('p1');
    expect(passwordFromArgs(['--probe'], { OBS_WEBSOCKET_PASSWORD: 'env-pw' })).toBe('env-pw');
    expect(passwordFromArgs(['--probe'], {})).toBeUndefined();
    // --password 后面没跟值 → 回落到环境变量，不把 undefined 当密码
    expect(passwordFromArgs(['--password'], { OBS_WEBSOCKET_PASSWORD: 'env-pw' })).toBe('env-pw');
    expect(passwordFromArgs(['--password'], {})).toBeUndefined();
  });
});

describe('parseMode', () => {  it('识别 probe / serve / 默认只读报告', () => {
    expect(parseMode(['--probe'])).toBe('probe');
    expect(parseMode(['--serve'])).toBe('serve');
    expect(parseMode(['--probe', '--serve'])).toBe('probe');
    expect(parseMode([])).toBe('report');
  });
});

describe('formatPreconditionReport', () => {
  it('硬件加速开启 + ws 未开 → 报前置不满足并提示 probe 不可用', () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=true\n', { server_enabled: false, server_port: 4455 });
    const text = formatPreconditionReport(paths);
    expect(text).toContain('BrowserHWAccel = true');
    expect(text).toContain('前置不满足');
    expect(text).toContain('--probe` 自动探针将无法运行');
  });

  it('配置缺失与未显式配置时如实标注', () => {
    const paths = writeConfigs('[General]\nMaxLogs=10\n', { server_enabled: true, server_port: 4455, auth_required: true });
    const text = formatPreconditionReport(paths);
    expect(text).toContain('未显式配置 BrowserHWAccel');
    expect(text).toContain('server_enabled=true');
  });

  it('完全缺失的配置目录 → 两处都标注未找到', () => {
    const text = formatPreconditionReport(enabledConfigPaths());
    expect(text).toContain('未找到 global.ini');
    expect(text).toContain('未找到 obs-websocket 配置');
  });

  it('硬件加速已关闭 → 报「已关闭硬件加速」而不是缺陷状态', () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: false });
    const text = formatPreconditionReport(paths);
    expect(text).toContain('已关闭硬件加速');
    expect(text).not.toContain('已知「浏览器源全黑」缺陷状态');
  });

  it('obs-websocket 配置损坏 → 如实标注解析失败，不猜默认值', () => {
    const base = join(mkdtempSync(join(tmpdir(), 'obs-cli-bad-')), 'obs-studio');
    mkdirSync(join(base, 'plugin_config', 'obs-websocket'), { recursive: true });
    writeFileSync(join(base, 'global.ini'), '[General]\nBrowserHWAccel=false\n');
    writeFileSync(join(base, 'plugin_config', 'obs-websocket', 'config.json'), '{ 不是 JSON');
    const text = formatPreconditionReport({
      globalIni: join(base, 'global.ini'),
      websocketConfig: join(base, 'plugin_config', 'obs-websocket', 'config.json'),
    });
    expect(text).toContain('obs-websocket 配置解析失败');
  });
});

describe('formatServeBanner', () => {
  it('提示红页地址与当前硬件加速状态', () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=true\n', { server_enabled: false });
    const banner = formatServeBanner(54321, paths);
    expect(banner).toContain('http://127.0.0.1:54321/red');
    expect(banner).toContain('BrowserHWAccel=true');
    expect(banner).toContain('需先关闭硬件加速');
  });

  it('前置已满足时不再提示需先关闭', () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: false });
    const banner = formatServeBanner(1111, paths);
    expect(banner).not.toContain('需先关闭硬件加速');
  });
});

describe('startRedPageServer', () => {
  it('起服务并返回红页 URL，可关闭', async () => {
    const server = await startRedPageServer();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/red$/);
    await server.close();
  });

  it('真实请求返回纯红静态页（#c00），且禁止缓存', async () => {
    const server = await startRedPageServer();
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toBe(RED_PAGE);
    expect(html).toContain('background:#c00');
    await server.close();
  });
});

describe('runProbe', () => {
  it('ws 未开启 → 退出码 2，不创建任何连接', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: false });
    const lines: string[] = [];
    const code = await runProbe({ configPaths: paths, log: (l) => lines.push(l) });
    expect(code).toBe(PROBE_EXIT.UNAVAILABLE);
    expect(lines.join('\n')).toContain('obs-websocket 未开启');
  });

  it('连接失败 → 退出码 2 并关闭红页服务', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 4455 });
    let redClosed = false;
    const lines: string[] = [];
    const code = await runProbe({
      configPaths: paths,
      log: (l) => lines.push(l),
      startRedPage: async () => ({ url: 'http://127.0.0.1:1/red', close: async () => { redClosed = true; } }),
      createClient: () => new FakeClient({ connectError: new Error('连接被拒绝') }).asClient(),
    });
    expect(code).toBe(PROBE_EXIT.UNAVAILABLE);
    expect(redClosed).toBe(true);
    expect(lines.join('\n')).toContain('连接被拒绝');
  });

  it('渲染全黑 → 退出码 1，且临时场景与临时输入都被删除', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=true\n', { server_enabled: true, server_port: 4455 });
    const client = new FakeClient({ screenshot: colorPngDataUri([0, 0, 0]) });
    const lines: string[] = [];
    const code = await runProbe({
      configPaths: paths,
      log: (l) => lines.push(l),
      startRedPage: async () => fakeRedPage,
      createClient: () => client.asClient(),
      settleMs: 0,
    });
    expect(code).toBe(PROBE_EXIT.BLACK);
    expect(lines.join('\n')).toContain('渲染全黑');
    expect(client.types()).toContain('RemoveInput');
    expect(client.types()).toContain('RemoveScene');
    expect(client.closed).toBe(true);
  });

  it('渲染出红页 → 退出码 0', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 4455 });
    const client = new FakeClient({ screenshot: colorPngDataUri([204, 0, 0]) });
    const lines: string[] = [];
    const code = await runProbe({
      configPaths: paths,
      log: (l) => lines.push(l),
      startRedPage: async () => fakeRedPage,
      createClient: () => client.asClient(),
      settleMs: 0,
    });
    expect(code).toBe(PROBE_EXIT.OK);
    expect(lines.join('\n')).toContain('正常渲染静态红页');
  });

  it('有内容但不是红页 → 退出码 3（不谎报成功）', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 4455 });
    const client = new FakeClient({ screenshot: colorPngDataUri([200, 200, 200]) });
    const lines: string[] = [];
    const code = await runProbe({
      configPaths: paths,
      log: (l) => lines.push(l),
      startRedPage: async () => fakeRedPage,
      createClient: () => client.asClient(),
      settleMs: 0,
    });
    expect(code).toBe(PROBE_EXIT.NOT_RED);
    expect(lines.join('\n')).toContain('请人工目视核对');
  });

  it('请求异常 → 退出码 4，仍执行清理', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 4455 });
    const client = new FakeClient({
      requestError: { requestType: 'GetSourceScreenshot', error: new Error('截图失败') },
    });
    const lines: string[] = [];
    const code = await runProbe({
      configPaths: paths,
      log: (l) => lines.push(l),
      startRedPage: async () => fakeRedPage,
      createClient: () => client.asClient(),
      settleMs: 0,
    });
    expect(code).toBe(PROBE_EXIT.ERROR);
    expect(lines.join('\n')).toContain('截图失败');
    expect(client.types()).toContain('RemoveInput');
  });

  it('清理请求本身失败也不影响返回码，且不抛错', async () => {    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 4455 });
    const client = new FakeClient({
      screenshot: colorPngDataUri([204, 0, 0]),
      requestError: { requestType: 'RemoveInput', error: new Error('删除失败') },
    });
    const code = await runProbe({
      configPaths: paths,
      log: () => undefined,
      startRedPage: async () => fakeRedPage,
      createClient: () => client.asClient(),
      settleMs: 0,
    });
    // RemoveInput 抛错会被 catch 吞掉，截图本身成功 → 退出码 0
    expect(code).toBe(PROBE_EXIT.OK);
  });

  it('密码透传给客户端；截图非 data URI（裸 base64）也能解出颜色', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 4455 });
    const bareBase64 = colorPngDataUri([204, 0, 0]).slice('data:image/png;base64,'.length);
    const client = new FakeClient({ screenshot: bareBase64 });
    const code = await runProbe({
      configPaths: paths,
      password: 'pw-abc',
      log: () => undefined,
      startRedPage: async () => fakeRedPage,
      createClient: () => client.asClient(),
      settleMs: 0,
    });
    expect(code).toBe(PROBE_EXIT.OK);
    expect(client.receivedPassword).toBe('pw-abc');
  });

  it('默认日志与默认客户端工厂可用：无人监听时如实报连接失败（退出码 2）', async () => {
    const paths = writeConfigs('[General]\nBrowserHWAccel=false\n', { server_enabled: true, server_port: 1 });
    const code = await runProbe({
      configPaths: paths,
      startRedPage: async () => fakeRedPage,
      settleMs: 1,
    });
    expect(code).toBe(PROBE_EXIT.UNAVAILABLE);
  });
});
