/**
 * WebUI 形态服务（T-M6-04）：让同一套渲染层/状态也能被本机浏览器访问，
 * 并提供远程审批入口（桌面开线程、浏览器批审批）。
 *
 * 设计约束：
 *   - 只绑定回环地址（127.0.0.1 / ::1），端口默认 18780（ARCHITECTURE §2 约定；被占用自动回退随机端口）
 *   - 启动即生成随机 device token（crypto.randomUUID），
 *     `?token=` 或 `Authorization: Bearer` 任一命中才放行；无 token → 401
 *   - 只依赖 node:http / node:fs / ws，不 import electron —— 因此可在纯 node 环境单测
 *   - 所有路由 try/catch：异常统一 500 JSON，绝不让 WebUI 拖垮主进程
 *   - 静态资源仅映射 dist/renderer（拒绝 `..` 与编码变体路径穿越）
 *
 * 数据来源全部由 main 注入：getState / getBusEventSources / onCommand / onApprove。
 */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat as statFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket as WsSocket, WebSocketServer as WsServer } from 'ws';
import {
  PetApiActionRequestSchema,
  PetApiSayRequestSchema,
  WORKBENCH_STATUS_LABELS_ZH,
  WORKBENCH_TOOL_LABELS_ZH,
  type PetApiActionRequest,
  type PetApiSayRequest,
  type PetApiState,
} from '@workbench/shared-protocol';
import {
  authorize,
  escapeHtml,
  isPathSafe,
  jsonResponse,
  parseRequestUrl,
  readJsonBody,
  isRecord,
} from '../webui/http-utils';
import { APP_NAME, APP_NAME_EN, APP_TAGLINE, whaleMarkPaths } from '../shared/brand';

interface WsModule {
  WebSocket: typeof WsSocket;
  WebSocketServer: typeof WsServer;
}

/**
 * 运行时加载 ws（CJS）：ws 内部是 `require('events')`，若被 esbuild 打进 ESM bundle
 * 会触发 "Dynamic require of events is not supported"（T-M6-04 真机启动实测）。
 * createRequire 的非静态调用不参与打包，ws 保留为 dist 运行时依赖。
 * 挂载点延迟到 createWebUIServer：ws 缺失/损坏只会让 WebUI 起不来（main 已 try/catch），
 * 不会在模块 import 阶段拖垮 Electron 主进程。
 */
function loadWsModule(): WsModule {
  const requireFromHere = createRequire(import.meta.url);
  const moduleName = ['w', 's'].join('');
  return requireFromHere(moduleName) as WsModule;
}

/** 远程审批三态（与 harness / acp resolvePermission 对齐：Y / A / N） */
export type WebUIApproveOutcome = 'allow' | 'always' | 'reject';

export interface WebUIApprovePayload {
  providerId: string;
  requestId: number;
  outcome: WebUIApproveOutcome;
}

/** 由 main 注入的运行时快照（只取 WebUI 需要的字段，避免把 Electron 类型带进来） */
export interface WebUIRuntimeState {
  running?: boolean;
  brainMode?: string | null;
  /** 当前活跃桌宠角色名（T-M6-59：OBS 状态卡顶栏展示） */
  characterName?: string;
  memoryStats?: {
    nodes?: number;
    edges?: number;
    lastDay?: string | null;
  } | null;
  voice?: {
    enabled?: boolean;
    innerVoice?: boolean;
    volume?: number;
    ratePercent?: number;
    voice?: string;
    voiceId?: string;
    pitchMul?: number;
  } | null;
}

/** 总线事件源：subscribe 返回取消订阅函数（main 可把 autodrive/harness 事件桥接进来） */
export interface WebUIBusSource {
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface WebUIServerOptions {
  /** 监听端口，默认 18780（对齐 ARCHITECTURE）；传 0 时由系统分配。被占用会自动回退随机端口 */
  port?: number;
  /** 只接受回环地址，默认 127.0.0.1（localhost 会归一化为 127.0.0.1） */
  host?: string;
  /** 指定固定 token（测试/调试）；缺省启动时 randomUUID */
  authToken?: string;
  /** 运行时快照回调（抛异常时 /api/state 返回 500 JSON） */
  getState?: () => WebUIRuntimeState;
  /** 总线事件源回调（启动时订阅一次；退订在 close 时统一执行） */
  getBusEventSources?: () => WebUIBusSource[];
  /** /api/command 的转发实现；缺省时返回「待接线」 */
  onCommand?: (text: string) => unknown | Promise<unknown>;
  /** /api/approve 的转发实现（生产环境接 harness.manager.resolvePermission） */
  onApprove?: (payload: WebUIApprovePayload) => unknown | Promise<unknown>;
  /** 静态资源根，默认 dist/renderer（相对本文件 ../renderer） */
  rendererRoot?: string;
  /** 事件环形缓冲上限，默认 100 */
  eventBufferSize?: number;
  /**
   * T-M6-49 对外本机驱动口：`/api/pet/:agentId/{state,say,action}`。
   * 入参必须先过 shared-protocol 的 Zod Schema；缺省时三个端点返回 501「待接线」。
   */
  petApi?: {
    state(agentId: string): PetApiState | null;
    say(agentId: string, request: PetApiSayRequest): { ok: boolean; error?: string };
    action(agentId: string, request: PetApiActionRequest): { ok: boolean; error?: string };
  };
}

export interface WebUIServerHandle {
  /** 实际监听端口（listen 完成前为请求端口；用 ready 拿到最终值） */
  readonly port: number;
  /** 设备 token（main 负责打印带 token 的 URL；不要写日志到第三方） */
  readonly token: string;
  /** listen 完成（含 EADDRINUSE 回退随机端口）后 resolve 实际端口 */
  readonly ready: Promise<number>;
  /** 手动推送一条总线事件（无注入事件源时的备用入口） */
  publish(event: unknown): void;
  /** 关闭 WS 客户端、退订事件源并关停 HTTP server（幂等） */
  close(): Promise<void>;
}

const DEFAULT_PORT = 18_780;
const DEFAULT_EVENT_BUFFER = 100;
/** 静态资源路由前缀（固定映射 dist/renderer） */
const RENDERER_PREFIX = '/renderer/';

/** 默认静态根：dist/main/webui-server.js → ../renderer = dist/renderer */
const DEFAULT_RENDERER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeOf(extension: string): string {
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** 仅允许回环绑定（安全红线：WebUI 绝不对外网暴露） */
function normalizeBindHost(host: string | undefined): string {
  const candidate = (host ?? '127.0.0.1').trim();
  if (candidate === '127.0.0.1' || candidate === 'localhost') return '127.0.0.1';
  if (candidate === '::1') return '::1';
  throw new Error(`WebUI 仅允许绑定回环地址（收到 ${candidate}）`);
}

/**
 * 最小 HTML 外壳（内联，不依赖构建产物）：轮询 /api/state + WS 订阅事件，
 * 含指令输入与远程审批表单。token 通过 meta 注入（HTML 属性转义）。
 */
function renderShellHtml(token: string): string {
  const mark = whaleMarkPaths();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="webui-token" content="${escapeHtml(token)}">
<meta name="application-name" content="${APP_NAME} ${APP_NAME_EN}">
<meta name="description" content="${APP_TAGLINE}">
<title>${APP_NAME} WebUI · 远程中控</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: #020617; color: #e2e8f0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.logo { width: 42px; height: 42px; flex: 0 0 auto; filter: drop-shadow(0 8px 20px rgba(46,124,255,.32)); }
h1 { font-size: 20px; margin: 0; }
h1 small { font-size: 12px; color: #64748b; font-weight: 400; margin-left: 8px; }
.badge { margin-left: auto; padding: 4px 10px; border-radius: 999px; font-size: 12px; background: #334155; }
.badge.ok { background: #065f46; color: #a7f3d0; }
.badge.warn { background: #7c2d12; color: #fed7aa; }
main { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; }
.card h2 { font-size: 14px; margin: 0 0 12px; color: #94a3b8; }
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 12px; }
.cell { background: #111f36; border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.cell .k { font-size: 11px; color: #64748b; }
.cell .v { font-size: 13px; }
pre { margin: 0; padding: 10px; background: #020617; border-radius: 8px; font-size: 12px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
form { display: flex; gap: 8px; flex-wrap: wrap; }
input { flex: 1 1 160px; padding: 8px 10px; border-radius: 8px; border: 1px solid #334155; background: #020617; color: inherit; }
button { padding: 8px 12px; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: inherit; cursor: pointer; }
button:hover { background: #334155; }
ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
ol li { font-size: 12px; background: #020617; border-radius: 6px; padding: 6px 8px; word-break: break-all; }
</style>
</head>
<body>
<header>
  <svg class="logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="${mark.tail}" fill="#5BA9F7"/>
    <path d="${mark.body}" fill="#5BA9F7"/>
    <path d="${mark.band}" stroke="#F6FAFF" stroke-width="1.7" stroke-linecap="round"/>
    <circle cx="${mark.eye.cx}" cy="${mark.eye.cy}" r="${mark.eye.r}" fill="#06182E"/>
    <circle cx="${mark.glint.cx}" cy="${mark.glint.cy}" r="${mark.glint.r}" fill="#FFFFFF"/>
  </svg>
  <h1>${APP_NAME} WebUI <small>${APP_NAME_EN} · 远程中控 · 仅本机回环</small></h1>
  <span id="conn" class="badge">连接中…</span>
</header>
<main>
  <section class="card">
    <h2>运行时状态</h2>
    <div id="summary" class="grid"></div>
    <pre id="state">加载中…</pre>
  </section>
  <section class="card">
    <h2>指令（chat:say / directive 通道）</h2>
    <form id="cmd-form">
      <input id="cmd-input" placeholder="给桌宠说点什么…" autocomplete="off">
      <button type="submit">发送</button>
    </form>
    <pre id="cmd-result" style="margin-top:12px">（尚未发送）</pre>
  </section>
  <section class="card">
    <h2>远程审批</h2>
    <form id="approve-form">
      <input id="provider" placeholder="providerId（如 gemini）" autocomplete="off">
      <input id="request" placeholder="requestId" inputmode="numeric" autocomplete="off">
      <button type="submit" name="outcome" value="allow">允许一次</button>
      <button type="submit" name="outcome" value="always">总是允许</button>
      <button type="submit" name="outcome" value="reject">拒绝</button>
    </form>
    <pre id="approve-result" style="margin-top:12px">（尚未审批）</pre>
  </section>
  <section class="card">
    <h2>总线事件（最近 ${DEFAULT_EVENT_BUFFER} 条）</h2>
    <ol id="events"></ol>
  </section>
</main>
<script>
(function () {
  var tokenMeta = document.querySelector('meta[name="webui-token"]');
  var token = tokenMeta ? tokenMeta.getAttribute('content') || '' : '';
  var conn = document.getElementById('conn');
  var stateEl = document.getElementById('state');
  var summaryEl = document.getElementById('summary');
  var eventsEl = document.getElementById('events');
  var cmdForm = document.getElementById('cmd-form');
  var cmdInput = document.getElementById('cmd-input');
  var cmdResult = document.getElementById('cmd-result');
  var approveForm = document.getElementById('approve-form');
  var approveResult = document.getElementById('approve-result');

  function badge(text, tone) {
    if (!conn) return;
    conn.textContent = text;
    conn.className = 'badge ' + tone;
  }
  function api(path, init) {
    var opts = init || {};
    var headers = opts.headers || {};
    headers.Authorization = 'Bearer ' + token;
    headers['Content-Type'] = 'application/json';
    opts.headers = headers;
    return fetch(path, opts).then(function (res) {
      return res.json();
    });
  }
  function renderSummary(state) {
    if (!summaryEl) return;
    summaryEl.innerHTML = '';
    var mem = state.memoryStats;
    var voice = state.voice;
    var items = [
      ['运行中', state.running ? '是' : '否'],
      ['大脑', state.brainMode || '未知'],
      ['记忆节点', mem ? String(mem.nodes) + ' 节点 / ' + String(mem.edges) + ' 边' : '—'],
      ['语音', voice && voice.enabled ? (voice.voiceId || '已开启') : '关闭']
    ];
    items.forEach(function (pair) {
      var cell = document.createElement('div');
      cell.className = 'cell';
      var key = document.createElement('span');
      key.className = 'k';
      key.textContent = pair[0];
      var value = document.createElement('span');
      value.className = 'v';
      value.textContent = pair[1];
      cell.appendChild(key);
      cell.appendChild(value);
      summaryEl.appendChild(cell);
    });
  }
  function renderEvents(events) {
    if (!eventsEl) return;
    eventsEl.innerHTML = '';
    events.slice().reverse().forEach(function (event) {
      var li = document.createElement('li');
      li.textContent = JSON.stringify(event);
      eventsEl.appendChild(li);
    });
  }
  function refreshState() {
    api('/api/state', { method: 'GET' }).then(function (state) {
      if (!state || !state.ok) return;
      renderSummary(state);
      renderEvents(Array.isArray(state.events) ? state.events : []);
      if (stateEl) stateEl.textContent = JSON.stringify(state, null, 2);
    }).catch(function () {});
  }
  refreshState();
  setInterval(refreshState, 3000);

  if (cmdForm) {
    cmdForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = cmdInput ? cmdInput.value.trim() : '';
      if (!text) return;
      if (cmdResult) cmdResult.textContent = '发送中…';
      api('/api/command', { method: 'POST', body: JSON.stringify({ text: text }) }).then(function (body) {
        if (cmdResult) cmdResult.textContent = JSON.stringify(body, null, 2);
      }).catch(function (error) {
        if (cmdResult) cmdResult.textContent = '失败：' + String(error);
      });
    });
  }

  if (approveForm) {
    approveForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var providerInput = document.getElementById('provider');
      var requestInput = document.getElementById('request');
      var providerId = providerInput ? providerInput.value.trim() : '';
      var requestId = requestInput ? Number(requestInput.value) : NaN;
      var submitter = event.submitter;
      var outcome = submitter && submitter.value ? submitter.value : 'allow';
      if (!providerId || !Number.isInteger(requestId)) {
        if (approveResult) approveResult.textContent = '请填写 providerId 与整数 requestId';
        return;
      }
      api('/api/approve', {
        method: 'POST',
        body: JSON.stringify({ providerId: providerId, requestId: requestId, outcome: outcome })
      }).then(function (body) {
        if (approveResult) approveResult.textContent = JSON.stringify(body, null, 2);
      }).catch(function (error) {
        if (approveResult) approveResult.textContent = '失败：' + String(error);
      });
    });
  }

  function connect() {
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var socket = new WebSocket(scheme + location.host + '/ws?token=' + encodeURIComponent(token));
    socket.addEventListener('open', function () {
      badge('已连接', 'ok');
      refreshState();
    });
    socket.addEventListener('close', function () {
      badge('已断开（重连中…）', 'warn');
      setTimeout(connect, 2000);
    });
    socket.addEventListener('error', function () {
      badge('连接异常', 'warn');
    });
    socket.addEventListener('message', function (event) {
      var message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        return;
      }
      if (!message || message.type !== 'event' || !eventsEl) return;
      var li = document.createElement('li');
      li.textContent = JSON.stringify(message.data);
      eventsEl.prepend(li);
      while (eventsEl.children.length > ${DEFAULT_EVENT_BUFFER}) {
        if (eventsEl.lastChild) eventsEl.removeChild(eventsEl.lastChild);
      }
    });
  }
  connect();
})();
</script>
</body>
</html>`;
}

/**
 * OBS 透明挂件（T-M6-34，ADR-9 `/obs` 最小真实链路）。
 * - 只读：仅订阅 `/ws` 事件与 `/api/state` 快照，不包含任何指令/审批入口。
 * - 透明背景：OBS 浏览器源直接叠加；文本带阴影保证亮/暗场景可读。
 * - `data-stage-protocol="1"` 供 OBS/中控端做版本协商（STAGE_PROTOCOL）。
 */
function renderObsHtml(token: string): string {
  return `<!doctype html>
<html lang="zh-CN" data-stage-protocol="1" data-theme="dark" data-layout="card">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="stage-protocol" content="1">
<meta name="obs-readonly" content="1">
<meta name="webui-token" content="${escapeHtml(token)}">
<title>鲸屿 · OBS 挂件</title>
<style>
  :root {
    --obs-bg: rgba(10, 10, 14, 0.62); --obs-border: rgba(255, 255, 255, 0.16);
    --obs-text: #f5f5f7; --obs-sub: #b9b9c0; --obs-accent: #6fb7ff;
    --obs-shadow: 0 1px 3px rgba(0, 0, 0, 0.7); --obs-ok: #48d38d; --obs-warn: #f5b74a; --obs-fail: #ff7b7b;
  }
  html[data-theme="light"] {
    --obs-bg: rgba(255, 255, 255, 0.82); --obs-border: rgba(15, 23, 42, 0.16);
    --obs-text: #0f172a; --obs-sub: #475569; --obs-accent: #0a84ff;
    --obs-shadow: 0 1px 2px rgba(255, 255, 255, 0.7); --obs-ok: #15803d; --obs-warn: #b45309; --obs-fail: #b91c1c;
  }
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
  .stack { position: fixed; left: 28px; bottom: 28px; display: flex; flex-direction: column; gap: 8px; max-width: 620px; }
  .card {
    padding: 10px 14px; border-radius: 16px;
    background: var(--obs-bg); border: 1px solid var(--obs-border);
    color: var(--obs-text); text-shadow: var(--obs-shadow);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  }
  .row { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--obs-sub); }
  .who { margin-left: auto; font-weight: 600; color: var(--obs-accent); text-shadow: none; }
  .dot { width: 7px; height: 7px; border-radius: 99px; background: #8d8d93; }
  .dot.live { background: #30d158; box-shadow: 0 0 8px rgba(48, 209, 88, 0.8); }
  .action { margin-top: 4px; font-size: 20px; font-weight: 700; color: var(--obs-accent); }
  .intent { margin-top: 3px; font-size: 12.5px; line-height: 1.5; color: var(--obs-sub); }
  .receipt { font-size: 12px; line-height: 1.55; color: var(--obs-sub); }
  .receipt b { color: var(--obs-text); }
  .ok b { color: var(--obs-ok); } .warn b { color: var(--obs-warn); } .fail b { color: var(--obs-fail); }
  .hide { display: none; }
  html[data-layout="compact"] .stack { left: 18px; bottom: 18px; gap: 5px; max-width: 460px; }
  html[data-layout="compact"] .card { padding: 6px 10px; border-radius: 11px; }
  html[data-layout="compact"] .action { margin-top: 2px; font-size: 15px; }
  html[data-layout="compact"] .intent { display: none; }
  html[data-layout="compact"] .receipt { font-size: 11px; }
</style>
</head>
<body>
<div class="stack">
  <div class="card" id="action-card">
    <div class="row"><span class="dot" id="dot"></span><span id="status">待命</span><span class="who" id="character"></span></div>
    <div class="action" id="action">待命</div>
    <div class="intent" id="intent">等待自动驾驶启动…</div>
  </div>
  <div class="card receipt hide" id="receipt-card"><b id="receipt-status"></b> <span id="receipt-text"></span></div>
</div>
<script>
(function () {
  var TOOL_LABELS = ${JSON.stringify(WORKBENCH_TOOL_LABELS_ZH)};
  var STATUS_LABELS = ${JSON.stringify(WORKBENCH_STATUS_LABELS_ZH)};
  var params = new URLSearchParams(location.search);
  var layout = params.get('layout') === 'compact' ? 'compact' : 'card';
  var theme = params.get('theme') === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-layout', layout);
  document.documentElement.setAttribute('data-theme', theme);

  var meta = document.querySelector('meta[name="webui-token"]');
  var token = meta ? meta.getAttribute('content') || '' : '';
  var actionEl = document.getElementById('action');
  var intentEl = document.getElementById('intent');
  var statusEl = document.getElementById('status');
  var dotEl = document.getElementById('dot');
  var characterEl = document.getElementById('character');
  var receiptCard = document.getElementById('receipt-card');
  var receiptStatus = document.getElementById('receipt-status');
  var receiptText = document.getElementById('receipt-text');
  var hideTimer = 0;
  function toolLabel(tool) { return TOOL_LABELS[tool] || String(tool || '') || '待命'; }
  function statusLabel(status) { return STATUS_LABELS[status] || String(status || ''); }
  function setRunning(running) {
    statusEl.textContent = running ? '自动驾驶中' : '待命';
    dotEl.className = 'dot' + (running ? ' live' : '');
  }
  function setCharacter(name) {
    if (typeof name === 'string' && name !== '') characterEl.textContent = name;
  }
  function applyEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'state') { setRunning(true); return; }
    if (event.type === 'decision' && event.tool !== 'think') {
      actionEl.textContent = toolLabel(event.tool);
      intentEl.textContent = String(event.intent || '');
      setRunning(true);
      return;
    }
    if (event.type === 'receipt' && event.status) {
      var cls = event.status === 'COMPLETED' ? 'ok' : (event.status === 'UNCERTAIN' || event.status === 'TIMEOUT') ? 'warn' : 'fail';
      receiptCard.className = 'card receipt ' + cls;
      receiptStatus.textContent = statusLabel(event.status);
      receiptText.textContent = toolLabel(event.tool) + ' · ' + String(event.summary || '').slice(0, 120);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { receiptCard.className = 'card receipt hide'; }, 12000);
    }
  }
  function api(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
      return res.ok ? res.json() : null;
    }).catch(function () { return null; });
  }
  api('/api/state').then(function (state) {
    if (!state) return;
    setRunning(state.running === true);
    setCharacter(state.characterName);
    var events = Array.isArray(state.events) ? state.events : [];
    for (var i = events.length - 1; i >= 0 && i >= events.length - 20; i -= 1) applyEvent(events[i]);
  });
  function connect() {
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var socket = new WebSocket(scheme + location.host + '/ws?token=' + encodeURIComponent(token));
    socket.addEventListener('message', function (event) {
      var message;
      try { message = JSON.parse(String(event.data)); } catch (error) { return; }
      if (!message) return;
      if (message.type === 'event') applyEvent(message.data);
      else if (message.type === 'hello' && message.data && Array.isArray(message.data.events)) {
        message.data.events.slice(-20).forEach(applyEvent);
      }
    });
    socket.addEventListener('close', function () { setTimeout(connect, 2000); });
  }
  connect();
})();
</script>
</body>
</html>`;
}

/** 升级握手失败：直接写 HTTP 响应后销毁 socket（不能走 ServerResponse） */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ ok: false, error: message });
  const statusText = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Bad Request';
  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        body,
    );
  } catch {
    /* 握手期写失败：直接销毁即可 */
  }
  socket.destroy();
}

function methodNotAllowed(res: ServerResponse, allow: string[]): void {
  res.setHeader('Allow', allow.join(', '));
  jsonResponse(res, 405, { ok: false, error: `不支持的请求方法（允许 ${allow.join('/')}）` });
}

export function createWebUIServer(options: WebUIServerOptions = {}): WebUIServerHandle {
  // 延迟到调用时加载 ws：缺失/损坏时抛错由 main 的 try/catch 吞掉，Electron 主链路继续跑
  const { WebSocket: WsRuntimeWebSocket, WebSocketServer: WsRuntimeServer } = loadWsModule();
  const token = options.authToken ?? randomUUID();
  if (token.trim() === '') throw new Error('WebUI authToken 不能为空');
  const bindHost = normalizeBindHost(options.host);
  const portOption = options.port;
  const requestedPort =
    typeof portOption === 'number' && Number.isInteger(portOption) && portOption >= 0 ? portOption : DEFAULT_PORT;
  const rendererRoot = resolve(options.rendererRoot ?? DEFAULT_RENDERER_ROOT);
  const eventBufferSize = Math.max(1, Math.floor(options.eventBufferSize ?? DEFAULT_EVENT_BUFFER));

  let boundPort = requestedPort;
  let closed = false;

  /** 最近总线事件环形缓冲（/api/state 与 WS hello 共用） */
  const eventBuffer: unknown[] = [];
  /** 已连接的 WS 客户端（广播用；ws 自身也维护 clients，这里独立管理便于 try/catch） */
  const clients = new Set<WsSocket>();
  const unsubscribers: Array<() => void> = [];

  const wss = new WsRuntimeServer({ noServer: true, clientTracking: false });

  const safeSend = (client: WsSocket, payload: string): void => {
    if (client.readyState !== WsRuntimeWebSocket.OPEN) return;
    try {
      client.send(payload);
    } catch {
      clients.delete(client);
      try {
        client.terminate();
      } catch {
        /* 已断开 */
      }
    }
  };

  /** 推一条总线事件：先序列化（失败则丢弃），再入环形缓冲并广播 */
  const publish = (event: unknown): void => {
    let payload: string;
    try {
      payload = JSON.stringify({ type: 'event', data: event });
    } catch {
      console.warn('[webui] 事件无法序列化，已丢弃');
      return;
    }
    eventBuffer.push(event);
    while (eventBuffer.length > eventBufferSize) eventBuffer.shift();
    for (const client of clients) safeSend(client, payload);
  };

  // 启动时订阅注入的总线事件源（单个源失败不影响其它源/服务本身）
  if (options.getBusEventSources) {
    try {
      for (const source of options.getBusEventSources()) {
        try {
          const unsubscribe = source.subscribe(publish);
          if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
        } catch (error) {
          console.warn('[webui] 总线事件源订阅失败:', error);
        }
      }
    } catch (error) {
      console.warn('[webui] 总线事件源初始化失败:', error);
    }
  }

  const stateSnapshot = (): WebUIRuntimeState => {
    const state = options.getState?.() ?? {};
    return state;
  };

  /** 静态资源：/renderer/* → rendererRoot/*（双重防穿越 + 根目录包含校验） */
  const serveRenderer = async (res: ServerResponse, pathname: string): Promise<void> => {
    if (!isPathSafe(pathname)) {
      jsonResponse(res, 400, { ok: false, error: '非法静态路径' });
      return;
    }
    const relative = pathname.slice(RENDERER_PREFIX.length);
    let segments: string[];
    try {
      segments = relative.split('/').map((segment) => decodeURIComponent(segment));
    } catch {
      jsonResponse(res, 400, { ok: false, error: '静态路径编码非法' });
      return;
    }
    if (
      segments.length === 0 ||
      segments.some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          segment.startsWith('.') ||
          segment.includes('\0') ||
          segment.includes('\\'),
      )
    ) {
      jsonResponse(res, 400, { ok: false, error: '非法静态路径' });
      return;
    }
    // 防御层：即使上面漏了，resolve 后也必须仍落在 rendererRoot 内
    const filePath = resolve(rendererRoot, ...segments);
    if (filePath !== rendererRoot && !filePath.startsWith(rendererRoot + sep)) {
      jsonResponse(res, 403, { ok: false, error: '越界静态路径' });
      return;
    }
    let fileStat;
    try {
      fileStat = await statFile(filePath);
    } catch {
      jsonResponse(res, 404, { ok: false, error: '资源不存在' });
      return;
    }
    if (!fileStat.isFile()) {
      jsonResponse(res, 404, { ok: false, error: '资源不存在' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeOf(extname(filePath).toLowerCase()));
    res.setHeader('Content-Length', String(fileStat.size));
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      // 头已发出无法改成 JSON：直接断开该响应
      res.destroy();
    });
    stream.pipe(res);
  };

  /** 指令转发：body { text } → options.onCommand */
  const handleCommand = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : '请求体读取失败' });
      return;
    }
    if (!isRecord(body) || typeof body.text !== 'string') {
      jsonResponse(res, 400, { ok: false, error: '请求体需为 { text: string }' });
      return;
    }
    const text = body.text.trim();
    if (text === '') {
      jsonResponse(res, 400, { ok: false, error: 'text 不能为空' });
      return;
    }
    if (text.length > 4_000) {
      jsonResponse(res, 400, { ok: false, error: 'text 过长（上限 4000 字符）' });
      return;
    }
    if (!options.onCommand) {
      jsonResponse(res, 501, { ok: false, error: 'WebUI 指令通道待接线' });
      return;
    }
    const result = await options.onCommand(text);
    jsonResponse(res, 200, { ok: true, result: result ?? null });
  };

  /** 远程审批：body { providerId, requestId, outcome } → options.onApprove */
  const handleApprove = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : '请求体读取失败' });
      return;
    }
    if (!isRecord(body)) {
      jsonResponse(res, 400, { ok: false, error: '请求体需为 JSON 对象' });
      return;
    }
    const { providerId, requestId, outcome } = body;
    if (typeof providerId !== 'string' || providerId.trim() === '') {
      jsonResponse(res, 400, { ok: false, error: 'providerId 不能为空' });
      return;
    }
    if (typeof requestId !== 'number' || !Number.isInteger(requestId) || requestId < 0) {
      jsonResponse(res, 400, { ok: false, error: 'requestId 需为非负整数' });
      return;
    }
    if (outcome !== 'allow' && outcome !== 'always' && outcome !== 'reject') {
      jsonResponse(res, 400, { ok: false, error: 'outcome 需为 allow / always / reject' });
      return;
    }
    if (!options.onApprove) {
      jsonResponse(res, 501, { ok: false, error: '远程审批通道待接线' });
      return;
    }
    const payload: WebUIApprovePayload = { providerId: providerId.trim(), requestId, outcome };
    const result = await options.onApprove(payload);
    console.log(`[webui] 远程审批 provider=${payload.providerId} request=${payload.requestId} outcome=${payload.outcome}`);
    jsonResponse(res, 200, { ok: true, result: result ?? null });
  };

  /** 总路由：全部 try/catch 收口（调用方 catch 后统一 500 JSON） */
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    const rawUrl = req.url ?? '/';
    const { pathname } = parseRequestUrl(rawUrl);
    const method = (req.method ?? 'GET').toUpperCase();

    // 安全红线：所有路由（含静态与外壳）先过 token 校验
    if (!authorize(token, req.headers, rawUrl)) {
      jsonResponse(res, 401, { ok: false, error: '未授权：缺少或错误的设备 token' });
      return;
    }

    if (pathname === '/') {
      if (method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      const html = renderShellHtml(token);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', String(Buffer.byteLength(html, 'utf8')));
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; media-src 'self'",
      );
      res.end(html);
      return;
    }

    if (pathname === '/obs') {
      if (method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      const html = renderObsHtml(token);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', String(Buffer.byteLength(html, 'utf8')));
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; media-src 'self'",
      );
      res.end(html);
      return;
    }

    if (pathname === '/api/state') {
      if (method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      const state = stateSnapshot();
      jsonResponse(res, 200, {
        ok: true,
        events: [...eventBuffer],
        running: state.running === true,
        brainMode: state.brainMode ?? null,
        characterName: state.characterName ?? '',
        memoryStats: state.memoryStats ?? null,
        voice: state.voice ?? null,
      });
      return;
    }

    if (pathname === '/api/command') {
      if (method !== 'POST') {
        methodNotAllowed(res, ['POST']);
        return;
      }
      await handleCommand(req, res);
      return;
    }

    if (pathname === '/api/approve') {
      if (method !== 'POST') {
        methodNotAllowed(res, ['POST']);
        return;
      }
      await handleApprove(req, res);
      return;
    }

    if (pathname === '/ws') {
      jsonResponse(res, 400, { ok: false, error: 'WebSocket 端点需通过 upgrade 连接' });
      return;
    }

    // T-M6-49：对外本机驱动口（token 已在上方校验；入参一律过 Zod）
    const petRoute = /^\/api\/pet\/([^/]+)\/(state|say|action)$/.exec(pathname);
    if (petRoute !== null) {
      const agentId = decodeURIComponent(petRoute[1] ?? '');
      const action = petRoute[2];
      if (agentId === '' || !/^[A-Za-z0-9._-]{1,64}$/.test(agentId)) {
        jsonResponse(res, 400, { ok: false, error: 'agentId 非法' });
        return;
      }
      if (options.petApi === undefined) {
        jsonResponse(res, 501, { ok: false, error: '本机驱动口待接线' });
        return;
      }
      if (action === 'state') {
        if (method !== 'GET') { methodNotAllowed(res, ['GET']); return; }
        const state = options.petApi.state(agentId);
        if (state === null) { jsonResponse(res, 404, { ok: false, error: `桌宠不存在：${agentId}` }); return; }
        jsonResponse(res, 200, { ok: true, state });
        return;
      }
      if (method !== 'POST') { methodNotAllowed(res, ['POST']); return; }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : '请求体读取失败' });
        return;
      }
      if (action === 'say') {
        const parsed = PetApiSayRequestSchema.safeParse(body);
        if (!parsed.success) { jsonResponse(res, 400, { ok: false, error: parsed.error.issues[0]?.message ?? '非法请求' }); return; }
        const result = options.petApi.say(agentId, parsed.data);
        jsonResponse(res, result.ok ? 200 : 409, result);
        return;
      }
      const parsed = PetApiActionRequestSchema.safeParse(body);
      if (!parsed.success) { jsonResponse(res, 400, { ok: false, error: parsed.error.issues[0]?.message ?? '非法请求' }); return; }
      const result = options.petApi.action(agentId, parsed.data);
      jsonResponse(res, result.ok ? 200 : 409, result);
      return;
    }

    if (pathname.startsWith(RENDERER_PREFIX)) {
      if (method !== 'GET') {
        methodNotAllowed(res, ['GET']);
        return;
      }
      await serveRenderer(res, pathname);
      return;
    }

    jsonResponse(res, 404, { ok: false, error: '未找到路由' });
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '内部错误';
      console.error('[webui] 请求处理失败:', error);
      try {
        jsonResponse(res, 500, { ok: false, error: message });
      } catch {
        /* 响应已不可写（连接断开） */
      }
    });
  });

  // WS upgrade：先查路径与 token，再交给 ws 完成握手
  server.on('upgrade', (req, socket, head) => {
    try {
      const rawUrl = req.url ?? '/';
      const { pathname } = parseRequestUrl(rawUrl);
      if (pathname !== '/ws') {
        rejectUpgrade(socket, 404, '未找到 WebSocket 端点');
        return;
      }
      if (!authorize(token, req.headers, rawUrl)) {
        rejectUpgrade(socket, 401, '未授权：缺少或错误的设备 token');
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req);
      });
    } catch (error) {
      console.warn('[webui] upgrade 处理失败:', error);
      socket.destroy();
    }
  });

  wss.on('connection', (client: WsSocket) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => clients.delete(client));
    client.on('message', (data: Buffer) => {
      // 可选心跳：客户端发 ping 文本，服务端回 pong（不解析业务消息，防止注入面）
      if (data.toString('utf8') === 'ping') {
        safeSend(client, JSON.stringify({ type: 'pong', data: Date.now() }));
      }
    });
    // 握手即回放最近事件，Web 端无需等下一轮轮询
    safeSend(client, JSON.stringify({ type: 'hello', data: { ok: true, events: [...eventBuffer] } }));
  });

  const runtimeErrorHandler = (error: Error): void => {
    console.warn('[webui] HTTP server 运行期错误:', error.message);
  };

  /** listen：固定端口被占用（EADDRINUSE）时自动回退随机端口，保证 WebUI 可用 */
  const ready = new Promise<number>((resolveReady, rejectReady) => {
    const start = (attemptPort: number, allowFallback: boolean): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (allowFallback && error.code === 'EADDRINUSE' && attemptPort !== 0) {
          console.warn(`[webui] 端口 ${attemptPort} 被占用，回退随机端口`);
          start(0, false);
          return;
        }
        rejectReady(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        server.on('error', runtimeErrorHandler);
        const address = server.address();
        boundPort = typeof address === 'object' && address !== null ? address.port : attemptPort;
        resolveReady(boundPort);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(attemptPort, bindHost);
    };
    start(requestedPort, true);
  });
  // 避免调用方未挂 catch 时触发 unhandledRejection；await ready 仍能拿到 reject
  ready.catch(() => undefined);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* 退订失败不影响关停 */
      }
    }
    unsubscribers.length = 0;
    for (const client of clients) {
      try {
        client.close(1001, 'server closing');
      } catch {
        /* 已断开 */
      }
    }
    clients.clear();
    await new Promise<void>((resolveClose) => {
      try {
        wss.close(() => resolveClose());
      } catch {
        resolveClose();
      }
    });
    await new Promise<void>((resolveClose) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close(() => resolveClose());
      // 主动断开 keep-alive 连接，避免 close 回调长期悬挂
      server.closeAllConnections();
    });
  };

  return {
    get port() {
      return boundPort;
    },
    token,
    ready,
    publish,
    close,
  };
}
