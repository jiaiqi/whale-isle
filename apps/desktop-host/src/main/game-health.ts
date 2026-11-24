/**
 * 三游戏桥接探活与启动引导（T-M6-25）。
 *
 * 只读探测，不触发任何游戏动作、不修改任何游戏状态：
 *   · stardew  → POST http://127.0.0.1:18080/mcp（MCP tools/call get_state）
 *   · terraria → GET  http://127.0.0.1:18090/health
 *   · dst      → GET  http://127.0.0.1:18100/health
 *
 * 三态语义（绝不伪造「已连接」）：
 *   online    —— 桥接在线且游戏侧就绪（stardew: get_state 正常返回；新桥: /health.ok 且 gameId 匹配）
 *   reachable —— 进程/端口能连上，但游戏侧未就绪（游戏在跑但没载入存档、/health 报 not ok、契约不匹配）
 *   offline   —— 连不上（游戏没开 / 模组没装 / 端口没监听）
 *
 * 探测结果只用于界面提示与排查指引；动作是否成功一律以游戏侧真实回执为准（AGENTS.md 真实执行回执铁律）。
 */
import { DstStateSnapshotSchema, GameBridgeHealthSchema, type DstStateSnapshot } from '@workbench/shared-protocol';
import { gameAdapters, type GameId } from '@workbench/game-bridge-mcp';
import { bwfMcpEndpoint } from './bwf-settings';

export type GameHealthStatus = 'online' | 'reachable' | 'offline';

export interface GameHealthReport {
  gameId: GameId;
  endpoint: string;
  status: GameHealthStatus;
  /** 桥接是否完全就绪（status === 'online'） */
  ok: boolean;
  latencyMs: number;
  /** 一行人类可读摘要（连接后显示版本与控制权等真实信息） */
  detail: string;
  error?: string;
  /** 未连通时给人类的启动指引（每步可独立执行；不提供任何绕过路径） */
  guidance: string[];
  checkedAt: number;
}

export const DEFAULT_GAME_ENDPOINTS: Record<GameId, string> = {
  stardew: bwfMcpEndpoint(),
  terraria: 'http://127.0.0.1:18090',
  dst: 'http://127.0.0.1:18100',
};

/** 未连通时的启动指引（人类可执行步骤；与各泳道复评档案一致，不含绕过/伪造路径） */
export const GAME_CONNECT_GUIDANCE: Record<GameId, string[]> = {
  stardew: [
    '启动《星露谷物语》并载入存档（未进存档时 Mod 不会应答）',
    '确认 SMAPI 控制台出现 BWF Mod 载入日志，且监听端口与当前配置一致（默认 18088）',
    '在「游戏共玩 → Mod 管理」确认 BWF 处于启用状态；刚改过端口需重启一次游戏',
    '回到本页点击「重新探测」',
  ],
  terraria: [
    '安装 tModLoader 1.4.4.9，把 terraria-bridge 模组放进 Mods 目录',
    '启动游戏并进入存档（模组只在存档内开 HTTP 服务，端口 18090）',
    '确认 tModLoader 日志显示 BridgeServer 已监听 18090',
    '回到本页点击「重新探测」',
  ],
  dst: [
    '启动本地集群专用服并安装 dst-bridge 模组（all-clients）',
    '配置 cluster_token.txt（Klei 账号生成）与 sidecar 配对 token',
    '启动 dst-bridge-sidecar（宿主面端口 18100）',
    '回到本页点击「重新探测」',
  ],
};

const CONTROL_TEXT: Record<string, string> = {
  AI_AUTOPILOT: 'AI 托管中',
  HUMAN_TAKEOVER_ACTIVE: '玩家接管中',
  PAUSED_BY_PROGRAM: '程序暂停中',
};

/** MCP 响应解析：纯 JSON 或 SSE（data: 行）都吃，容忍尾部杂散数据 */
function parseRpcPayload(raw: string): { result?: unknown; error?: unknown } | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
    } catch {
      /* 继续走 SSE / 前缀扫描 */
    }
  }
  const lines = raw.split('\n').filter((line) => line.trimStart().startsWith('data:'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse((lines[i] ?? '').trimStart().slice(5).trim()) as { result?: unknown; error?: unknown };
    } catch {
      /* 试上一行 */
    }
  }
  // 兜底：从首个 '{' 起做括号平衡扫描（与 MCP 客户端同思路）
  const start = raw.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1)) as { result?: unknown; error?: unknown };
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function rpcErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message: unknown }).message);
  if (typeof error === 'string') return error;
  return 'MCP 返回错误但无消息';
}

export interface ProbeOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 星露谷：BWF MCP（18080/mcp）——get_state 能应答即视为就绪 */
async function probeStardew(endpoint: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<Omit<GameHealthReport, 'gameId' | 'endpoint' | 'guidance' | 'checkedAt'>> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_state', arguments: {} } }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const raw = await res.text();
    if (!res.ok) {
      return { status: 'reachable', ok: false, latencyMs, detail: `MCP 应答 HTTP ${res.status}`, error: raw.slice(0, 200) };
    }
    const rpc = parseRpcPayload(raw);
    if (!rpc) return { status: 'reachable', ok: false, latencyMs, detail: 'MCP 响应无法解析' };
    if (rpc.error != null) {
      return { status: 'reachable', ok: false, latencyMs, detail: 'Mod 在运行但未就绪', error: rpcErrorText(rpc.error) };
    }
    if (rpc.result == null) return { status: 'reachable', ok: false, latencyMs, detail: 'MCP 返回空结果' };
    return { status: 'online', ok: true, latencyMs, detail: 'BWF MCP 在线 · get_state 正常应答' };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      status: 'offline',
      ok: false,
      latencyMs,
      detail: aborted ? `连接超时（${timeoutMs}ms）` : '无法连接 BWF MCP',
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 泰拉瑞亚 / DST：统一桥接面 /health（契约 GameBridgeHealth） */
async function probeHttpHealth(
  gameId: GameId,
  endpoint: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Omit<GameHealthReport, 'gameId' | 'endpoint' | 'guidance' | 'checkedAt'>> {
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - startedAt;
    const raw = await res.text();
    if (!res.ok) {
      return { status: 'reachable', ok: false, latencyMs, detail: `健康端点 HTTP ${res.status}`, error: raw.slice(0, 200) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { status: 'reachable', ok: false, latencyMs, detail: '健康响应非 JSON' };
    }
    const health = GameBridgeHealthSchema.safeParse(parsed);
    if (!health.success) {
      return { status: 'reachable', ok: false, latencyMs, detail: '健康响应不符合契约', error: health.error.message.slice(0, 200) };
    }
    const data = health.data;
    if (!data.ok) return { status: 'reachable', ok: false, latencyMs, detail: `桥接已应答但未就绪（${data.gameId}）` };
    if (data.gameId !== gameId) {
      return { status: 'reachable', ok: false, latencyMs, detail: `端点属于 ${data.gameId}，与当前游戏不符` };
    }
    const version = [data.bridgeVersion && `桥接 ${data.bridgeVersion}`, data.gameVersion && `游戏 ${data.gameVersion}`]
      .filter(Boolean)
      .join(' · ');
    const control = CONTROL_TEXT[data.control] ?? data.control;
    return { status: 'online', ok: true, latencyMs, detail: `${version || '桥接在线'} · ${control}` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      status: 'offline',
      ok: false,
      latencyMs,
      detail: aborted ? `连接超时（${timeoutMs}ms）` : '无法连接桥接端口',
      error: message,
    };
  }
}

/** 探测单个游戏的桥接健康度（只读；结果如实反映连通性） */
export async function probeGameHealth(
  gameId: GameId,
  options: ProbeOptions = {},
): Promise<GameHealthReport> {
  const endpoint = options.endpoint ?? DEFAULT_GAME_ENDPOINTS[gameId];
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = gameId === 'stardew'
    ? await probeStardew(endpoint, timeoutMs, fetchImpl)
    : await probeHttpHealth(gameId, endpoint, timeoutMs, fetchImpl);
  return {
    gameId,
    endpoint,
    ...base,
    guidance: base.status === 'online' ? [] : GAME_CONNECT_GUIDANCE[gameId],
    checkedAt: Date.now(),
  };
}

/** 一次探测三游戏（面板顶部总览用；互不阻塞） */
export async function probeAllGames(options: ProbeOptions = {}): Promise<GameHealthReport[]> {
  return Promise.all((['stardew', 'terraria', 'dst'] as const).map((gameId) => probeGameHealth(gameId, options)));
}

/**
 * DST 状态快照（补齐 T-M7-D5 面板缺失的 /state IPC）。
 * 复用 DstAdapter 的 transport（GET /state → DstStateSnapshotSchema 校验），过契约才返回。
 */
export async function fetchDstSnapshot(
  options: { endpoint?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; snapshot?: DstStateSnapshot; error?: string }> {
  const endpoint = options.endpoint ?? DEFAULT_GAME_ENDPOINTS.dst;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const adapter = gameAdapters.create('dst', {
      endpoint,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    const result = await adapter.transport.callTool('get_state', {}, { timeoutMs });
    if (result.kind !== 'ok') {
      return { ok: false, error: result.kind === 'timeout' ? `GET /state 超时（${timeoutMs}ms）` : result.message };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text) as unknown;
    } catch {
      return { ok: false, error: 'GET /state 响应非 JSON' };
    }
    const snapshot = DstStateSnapshotSchema.safeParse(parsed);
    if (!snapshot.success) return { ok: false, error: `快照契约违规：${snapshot.error.message.slice(0, 200)}` };
    return { ok: true, snapshot: snapshot.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
