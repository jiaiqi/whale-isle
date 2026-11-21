/**
 * BWF MCP Streamable HTTP 客户端（T-M5-02）。
 * 真机实测结论（2026-11-21）：BWF 1.1.27 @ http://127.0.0.1:18080/mcp
 *  - 无状态单请求（无 session header）；响应在 纯JSON / SSE(: start 注释 + data:) 间摇摆 → 双解析
 *  - 长动作（钓鱼/下矿/浇水等）>45s 先回「还在执行」；HTTP 超时 ≠ 失败（动作可能仍在游戏侧执行）→
 *    绝不盲目重发，用 confirmState() 走 get_state 复核
 */
export interface McpCallOptions {
  /** 普通动作 30s；长动作（fish/explore_mine/water_crops 等）给到 10min */
  timeoutMs?: number;
}

export type McpCallResult =
  | { kind: 'ok'; text: string; isError: boolean }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'error'; message: string };

/** JSON 前缀解析：从 pos 开始找第一个括号平衡点（跳过字符串字面量），容忍尾部杂散数据。 */
function parseJsonPrefix(raw: string, pos: number): unknown | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = pos; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(pos, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function extractRpc(raw: string): { result?: unknown; error?: unknown } | null {
  // 1) 纯 JSON（容忍尾部 SSE 注释/杂散数据——前缀解析）
  const start = raw.indexOf('{');
  if (start >= 0) {
    const parsed = parseJsonPrefix(raw, start) as { result?: unknown; error?: unknown } | undefined;
    if (parsed) return parsed;
  }
  // 2) SSE：取最后一个 data: 行
  const lines = raw.split('\n').filter((l) => l.trimStart().startsWith('data:'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!.trimStart().slice(5).trim()) as { result?: unknown; error?: unknown };
    } catch {
      /* 尝试上一行 */
    }
  }
  return null;
}

export class BwfMcpClient {
  constructor(
    private readonly endpoint: string = 'http://127.0.0.1:18080/mcp',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async callTool(tool: string, args: Record<string, unknown> = {}, opts: McpCallOptions = {}): Promise<McpCallResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const payload = JSON.stringify({
      jsonrpc: '2.0', id: Date.now() % 1e6, method: 'tools/call',
      params: { name: tool, arguments: args },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: payload,
        signal: controller.signal,
      });
      const raw = await res.text();
      const rpc = extractRpc(raw);
      if (!rpc) return { kind: 'error', message: `不可解析响应（前 200 字）：${raw.slice(0, 200)}` };
      if (rpc.error != null) {
        const msg = typeof rpc.error === 'object' && rpc.error !== null && 'message' in rpc.error
          ? String((rpc.error as { message: unknown }).message)
          : JSON.stringify(rpc.error);
        return { kind: 'error', message: msg };
      }
      const r = rpc.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
      const text = (r?.content ?? []).map((c) => c.text ?? '').join('');
      return { kind: 'ok', text, isError: r?.isError === true };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { kind: 'timeout', timeoutMs };
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 快速连通性探测 */
  async ping(): Promise<boolean> {
    const res = await this.callTool('get_state', {}, { timeoutMs: 15_000 });
    return res.kind === 'ok';
  }
}

/** 长动作判定（BWF 语义：>45s 先回「还在执行」） */
export function isLongAction(tool: string): boolean {
  return ['fish', 'explore_mine', 'water_crops', 'harvest_crops', 'donate_bundles', 'crack_geodes',
    'quest_board', 'ship_items', 'sleep', 'care_animals', 'festival', 'leave_festival', 'fight',
    'check_crab_pots', 'upgrade_house', 'build', 'read_mail', 'repair_boat', 'mermaid_show', 'wait'].includes(tool);
}

export function actionTimeoutMs(tool: string): number {
  return isLongAction(tool) ? 10 * 60_000 : 30_000;
}
