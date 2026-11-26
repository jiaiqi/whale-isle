#!/usr/bin/env node
/**
 * OBS 浏览器源「静态红页自检」CLI（item 4 / `V2-P3-02` OBS 本地闭环配套）。
 *
 * 背景：本机 OBS 33.0.3 + CEF 150 在 Darwin 27.2 上开启「浏览器源硬件加速」
 * （`global.ini` 的 `BrowserHWAccel=true`）时，`browser_source` **渲染全黑**——
 * 连纯色静态红页也是黑屏。这极易被误判成「我们 overlay 页面坏了」。
 * 本工具把「是否处于该缺陷状态」变成一条可复跑的判据。
 *
 * 用法：
 *   pnpm obs:selfcheck              # ① 只读前置自检（不改任何 OBS 配置）
 *   pnpm obs:selfcheck --serve      # ② 起本地静态红页，人工粘贴进 OBS 目视验证
 *   pnpm obs:selfcheck --probe      # ③ 自动探针：连 obs-websocket 建临时源并取中心像素
 *
 * 安全边界（代码层面保证）：
 * - ① 只读 `~/Library/Application Support/obs-studio/global.ini` 与 obs-websocket 配置；
 * - ② 只在本机回环地址起一个静态 HTTP 服务；
 * - ③ 只在 OBS 里创建**临时**场景与**临时** browser_source，截图后立即删除，
 *   不触碰 owner 已有场景/输入，也不推送、不录制；
 * - ③ 需要 OBS 正在运行且 WebSocket 服务器已开启（属 owner 开关，脚本只提示不代改）。
 *
 * 可测性：所有分支逻辑都接受注入（配置路径 / 客户端工厂 / 红页服务 / 延时），
 * CLI 入口只做参数解析与打印，见 `cli.spec.ts`。
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { defaultObsConfigPaths, evaluatePreconditions, type ObsConfigPaths } from './config-probe.js';
import { ObsWebsocketClient } from './obs-websocket-client.js';
import { decodePng, isAllBlack, isRedPage, pixelAt } from './png-decode.js';

export const RED_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>WhaleIsle OBS Red Self-Check</title>'
  + '<style>html,body{margin:0;height:100%;background:#c00;}</style></head><body></body></html>';

export interface RedPageServer {
  url: string;
  close(): Promise<void>;
}

/** 在本机回环地址起静态红页服务（端口 0 = 系统分配） */
export async function startRedPageServer(): Promise<RedPageServer> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(RED_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/red`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** ① 只读前置自检的纯文本输出（无副作用，便于单测） */
export function formatPreconditionReport(paths: ObsConfigPaths = defaultObsConfigPaths()): string {
  const report = evaluatePreconditions(paths);
  const lines: string[] = [];
  lines.push('══ OBS 浏览器源前置自检（只读） ══');
  lines.push(`global.ini: ${report.hwAccel.path}`);
  if (!report.hwAccel.present) {
    lines.push('  [?] 未找到 global.ini，无法确认 BrowserHWAccel 状态');
  } else if (report.hwAccel.value === null) {
    lines.push('  [?] 未显式配置 BrowserHWAccel，按 OBS 默认值（true）处理');
  } else {
    lines.push(`  BrowserHWAccel = ${report.hwAccel.value}`
      + (report.hwAccelEnabled ? '  ← 处于本机已知「浏览器源全黑」缺陷状态' : '  ← 已关闭硬件加速'));
  }
  const ws = report.websocket;
  lines.push('obs-websocket:');
  if (!ws.present) lines.push('  [?] 未找到 obs-websocket 配置');
  else if (ws.parseFailed) lines.push('  [?] obs-websocket 配置解析失败');
  else lines.push(`  server_enabled=${String(ws.enabled)} port=${String(ws.port)} auth_required=${String(ws.authRequired)}`);
  lines.push('');
  lines.push(`结论：${report.summary}`);
  lines.push(`处置：${report.remedy}`);
  if (ws.enabled !== true) {
    lines.push('');
    lines.push('注意：obs-websocket 当前未开启，`--probe` 自动探针将无法运行。');
    lines.push('  开启位置：OBS → 设置 → 控制台 → WebSocket 服务器（owner 决定是否开启，脚本不代改）。');
  }
  return lines.join('\n');
}

export interface ProbeOptions {
  configPaths?: ObsConfigPaths;
  /** 测试替身：返回一个已连接（或抛错）的客户端 */
  createClient?: (url: string) => ObsWebsocketClient;
  startRedPage?: () => Promise<RedPageServer>;
  /** 等待 CEF 加载本地页面的延时（测试里置 0） */
  settleMs?: number;
  password?: string;
  log?: (line: string) => void;
}

export const PROBE_EXIT = {
  OK: 0,
  BLACK: 1,
  UNAVAILABLE: 2,
  NOT_RED: 3,
  ERROR: 4,
} as const;

/**
 * ③ 自动探针：建临时场景 → 建临时 browser_source 指向红页 → 取中心像素 → 清理。
 *
 * 返回退出码（语义见 `PROBE_EXIT`）；**任何异常都如实返回非 0**，不伪装成功。
 */
export async function runProbe(options: ProbeOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const configPaths = options.configPaths ?? defaultObsConfigPaths();
  const report = evaluatePreconditions(configPaths);
  if (report.websocket.enabled !== true) {
    log('obs-websocket 未开启，无法自动探针。请由 owner 在 OBS 设置中开启后再试。');
    return PROBE_EXIT.UNAVAILABLE;
  }
  const port = report.websocket.port ?? 4455;

  const startRedPage = options.startRedPage ?? startRedPageServer;
  const redPage = await startRedPage();
  const createClient = options.createClient ?? ((url: string) => new ObsWebsocketClient(url));
  const client = createClient(`ws://127.0.0.1:${port}`);
  try {
    await client.connect(options.password);
  } catch (error) {
    await redPage.close();
    log(error instanceof Error ? error.message : String(error));
    return PROBE_EXIT.UNAVAILABLE;
  }

  const sceneName = `WhaleIsle-SelfCheck-${Date.now()}`;
  const inputName = `${sceneName}-red`;
  try {
    const version = await client.request({ requestType: 'GetVersion' });
    log(`已连接 OBS ${String(version.obsVersion ?? '?')}`
      + `（obs-websocket ${String(version.obsWebSocketVersion ?? '?')}）`);
    await client.request({ requestType: 'CreateScene', requestData: { sceneName } });
    await client.request({
      requestType: 'CreateInput',
      requestData: {
        sceneName,
        inputName,
        inputKind: 'browser_source',
        inputSettings: { url: redPage.url, width: 64, height: 64, shutdown_source_when_inactive: false },
      },
    });
    const settleMs = options.settleMs ?? 1500;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const shot = await client.request({
      requestType: 'GetSourceScreenshot',
      requestData: { sourceName: inputName, imgFormat: 'png', width: 64, height: 64 },
    });
    const dataUri = String(shot.imageData ?? '');
    const base64 = dataUri.includes(',') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
    const image = decodePng(Buffer.from(base64, 'base64'));
    const center = pixelAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2));
    log(`红页 URL：${redPage.url}`);
    log(`截图尺寸 ${image.width}x${image.height}，中心像素 rgb(${center.join(',')})`);
    if (isAllBlack(image)) {
      log('结论：browser_source 渲染全黑——命中本机已知缺陷（浏览器源硬件加速）。');
      log('处置：关闭 OBS 浏览器源硬件加速后重跑本探针。');
      return PROBE_EXIT.BLACK;
    }
    if (isRedPage(image)) {
      log('结论：browser_source 正常渲染静态红页，未命中全黑缺陷。');
      return PROBE_EXIT.OK;
    }
    log('结论：browser_source 有内容但不是红页，可能加载未完成或源地址被改写；请人工目视核对。');
    return PROBE_EXIT.NOT_RED;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return PROBE_EXIT.ERROR;
  } finally {
    // 只删自己建的临时输入与临时场景；失败也不影响 owner 已有场景
    await client.request({ requestType: 'RemoveInput', requestData: { inputName } }).catch(() => undefined);
    await client.request({ requestType: 'RemoveScene', requestData: { sceneName } }).catch(() => undefined);
    log(`已清理临时输入与临时场景（${sceneName}）。`);
    client.close();
    await redPage.close();
  }
}

/** ② 人机目视模式：打印红页地址并常驻，直到 Ctrl+C */
export function formatServeBanner(port: number, paths: ObsConfigPaths = defaultObsConfigPaths()): string {
  const report = evaluatePreconditions(paths);
  const lines = [
    `静态红页已启动：http://127.0.0.1:${port}/red`,
    '背景色 #c00（RGB 204,0,0）。在 OBS 里加「浏览器」源并粘贴上面的 URL：',
    '  · 画面为红色 → 浏览器源渲染正常；',
    '  · 画面全黑 → 本机浏览器源硬件加速缺陷（当前 BrowserHWAccel=' + String(report.hwAccel.value) + '）',
  ];
  if (!report.satisfied) {
    lines.push('提示：当前配置正处于已知会全黑的状态，红色结果需先关闭硬件加速才是有效对照。');
  }
  lines.push('按 Ctrl+C 结束服务。');
  return lines.join('\n');
}

async function runServe(): Promise<void> {
  const server = await startRedPageServer();
  const port = Number(new URL(server.url).port);
  console.log(formatServeBanner(port));
}

/** CLI 参数解析（纯函数，便于单测） */
export function parseMode(argv: string[]): 'probe' | 'serve' | 'report' {
  if (argv.includes('--probe')) return 'probe';
  if (argv.includes('--serve')) return 'serve';
  return 'report';
}

export function passwordFromArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const index = argv.indexOf('--password');
  if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
  return env.OBS_WEBSOCKET_PASSWORD;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

/* v8 ignore next 13 -- CLI 入口块：仅在 `tsx src/cli.ts` 直接执行时进入，单测按模块导入不经过 */
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const mode = parseMode(argv);
  if (mode === 'probe') {
    process.exitCode = await runProbe({
      ...(passwordFromArgs(argv) !== undefined ? { password: passwordFromArgs(argv) as string } : {}),
    });
  } else if (mode === 'serve') {
    await runServe();
  } else {
    console.log(formatPreconditionReport());
  }
}
