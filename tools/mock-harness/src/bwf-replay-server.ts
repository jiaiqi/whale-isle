/**
 * [SIMULATION] BWF 同构 HTTP 回放服务（T-M6-68，RUNBOOK-M8-STARDEW §2.1）。
 *
 * 现有 `stardew-simulator.ts` 是 WebSocket JSON-RPC、工具名也是 `move_to_tile / water_crops_batch`
 * 那一套，和真实 BWF（HTTP JSON-RPC `tools/call` → `result.content[{type:'text',text}]` + `isError`）
 * 不同构，不能回放真机现场。本文件按 T-M6-67 现场包转出的剧本 JSON 提供**只读回放**：
 *
 *   - `tools/call` 响应同时支持纯 JSON 与 SSE（`: ` 注释 + `data:` 行）两种形态——BWF 1.1.27 在两者
 *     之间摇摆（mcp-client.spec / 真机 2026-11-21 实证）；
 *   - `get_state` 返回剧本 initialState，其中时钟行按规则推进量改写
 *     （锚点 `/时间：第\d+年[春夏秋冬]\d+日 \d{2}:\d{2}/`）；
 *   - 选择题界面（`选项 / 选择题`）缺少 `choice` 参数时按 BWF 语义直接拒绝——这是 S03 剧本要
 *     咬住的真机行为；带合法 choice 推进后界面关闭；
 *   - `freezeUntilMutation` 模拟 BWF「MCP 客户端 120 秒没有动作 → 已暂停游戏」：时钟冻结，直到收到
 *     变更类工具；冻结期间状态文本追加一条 BWF 提示段；
 *   - 未覆盖的工具返回 `isError: true`，让剧本漏配立刻显性失败，而不是静默放过。
 *
 * 只做确定性回放：不改背包、不改位置、不联网。业务断言由 stuck-regressions.spec.ts 负责。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StuckScenario, StuckScenarioRule } from './stuck-scenario';

/** 星露谷时钟锚点（与 StardewAdapter.extractClock / soak-real 的 parseGameClock 同口径） */
const CLOCK_RE = /时间：第(\d+)年([春夏秋冬])(\d+)日 (\d{2}):(\d{2})/;
const MENU_RE = /## 当前界面\n([\s\S]*?)(?=\n## |\s*$)/;
const SEASONS = ['春', '夏', '秋', '冬'] as const;

/** 只读工具：不产生游戏动作，不会解除 BWF 自暂停，也不推进时钟 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'get_state', 'list_chests', 'map_info', 'bundle_info', 'gift_info', 'get_guide', 'quest_board',
  'special_orders', 'perfection', 'monster_goals', 'mastery', 'cancel_action',
]);

export interface GameClock {
  year: number;
  season: string;
  day: number;
  /** 当日分钟数（06:00 = 360） */
  minutes: number;
}

export interface ReplayCall {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  /** 调用时刻（注入的 now） */
  at: number;
}

export interface ReplayServerOptions {
  /** 纯 JSON（默认）或 SSE；两者客户端都要能解析 */
  responseMode?: 'json' | 'sse';
  /** 注入时钟（默认 Date.now），只用于 calls 的 at 字段 */
  now?: () => number;
}

export interface ReplayServerHandle {
  endpoint: string;
  /** 按调用顺序记录的全部工具调用（含 get_state） */
  calls: ReplayCall[];
  /** 当前游戏时钟（剧本没写时钟行时为 null） */
  clock(): GameClock | null;
  /** 当前 get_state 文本（含冻结提示） */
  stateText(): string;
  close(): Promise<void>;
}

/** 解析 get_state 原文里的时钟行；没有则 null（不猜） */
export function parseScenarioClock(text: string): GameClock | null {
  const match = CLOCK_RE.exec(text);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined
    || match[4] === undefined || match[5] === undefined) return null;
  return {
    year: Number(match[1]),
    season: match[2],
    day: Number(match[3]),
    minutes: Number(match[4]) * 60 + Number(match[5]),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 时钟 → 状态文本里的时钟行原文 */
export function formatClock(clock: GameClock): string {
  return `时间：第${clock.year}年${clock.season}${clock.day}日 ${pad(Math.floor(clock.minutes / 60))}:${pad(clock.minutes % 60)}`;
}

/** 把状态文本里的时钟行改写成 clock（没有时钟行时原样返回） */
export function rewriteClock(text: string, clock: GameClock): string {
  return CLOCK_RE.test(text) ? text.replace(CLOCK_RE, formatClock(clock)) : text;
}

/** 推进游戏分钟；跨 24:00 换日，跨 28 日换季（仅时钟行，不做节日/天气推算） */
export function advanceClock(clock: GameClock, minutes: number): GameClock {
  let year = clock.year;
  let season = clock.season;
  let day = clock.day;
  let total = clock.minutes + Math.max(0, Math.round(minutes));
  while (total >= 24 * 60) {
    total -= 24 * 60;
    day += 1;
  }
  while (day > 28) {
    day -= 28;
    const index = SEASONS.indexOf(season as (typeof SEASONS)[number]);
    if (index < 0 || index === SEASONS.length - 1) {
      season = SEASONS[0];
      year += 1;
    } else {
      season = SEASONS[index + 1] ?? SEASONS[0];
    }
  }
  return { year, season, day, minutes: total };
}

function matchRule(scenario: StuckScenario, tool: string): StuckScenarioRule | undefined {
  return scenario.rules.find((rule) => rule.tool === tool)
    ?? scenario.rules.find((rule) => rule.tool === '*');
}

/** 参数子集匹配（剧本里没写的键不参与比较） */
function argsInclude(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const got = actual[key];
    if (got === value) return true;
    return typeof got === 'object' && got !== null && JSON.stringify(got) === JSON.stringify(value);
  });
}

/** 供测试/剧本调试用：判断一次调用是否满足参数子集 */
export function callMatchesArgs(call: ReplayCall, expected: { tool: string; args: Record<string, unknown> }): boolean {
  return call.tool === expected.tool && argsInclude(call.args, expected.args);
}

class ReplayState {
  clock: GameClock | null;
  frozen: boolean;
  menuCleared = false;
  private stateText: string;

  constructor(private readonly scenario: StuckScenario) {
    this.stateText = scenario.initialState;
    this.clock = parseScenarioClock(scenario.initialState);
    this.frozen = scenario.freezeUntilMutation === true;
  }

  /** 当前状态文本：改写时钟 + 选择题关闭 + 冻结提示 */
  text(): string {
    let text = this.stateText;
    if (this.clock !== null) text = rewriteClock(text, this.clock);
    if (this.menuCleared) {
      text = text.replace(/(## 当前界面\n)[\s\S]*?(?=\n## |\s*$)/, '$1无（可以自由行动）\n');
    }
    if (this.frozen) {
      text += '\n## BWF 提示\n（MCP 客户端 120 秒没有动作，已暂停游戏；任意变更动作后恢复）\n';
    }
    return text;
  }

  menuText(): string {
    return MENU_RE.exec(this.text())?.[1] ?? '';
  }

  isChoiceMenu(): boolean {
    return /选项|选择题/.test(this.menuText());
  }

  /** 变更类工具是否解除冻结；返回解除后是否已解冻 */
  unfreezeFor(tool: string): void {
    if (this.frozen && !READ_ONLY_TOOLS.has(tool)) this.frozen = false;
  }

  advance(minutes: number | undefined): void {
    if (this.frozen || this.clock === null || minutes === undefined) return;
    this.clock = advanceClock(this.clock, minutes);
  }
}

function respond(
  res: import('node:http').ServerResponse,
  id: unknown,
  text: string,
  isError: boolean,
  mode: 'json' | 'sse',
): void {
  const payload = {
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text' as const, text }], isError },
  };
  if (mode === 'sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** 一次 tools/call 的请求面（回放服务与农场仿真共用同一 HTTP 层） */
export interface BwfToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface BwfHttpServerOptions {
  /** 纯 JSON（默认）或 SSE；两种客户端都要能解析 */
  responseMode?: 'json' | 'sse';
  /** 每次调用后回调（回放服务用它记 calls 做剧本断言） */
  onCall?: (call: ReplayCall) => void;
  /** 注入时钟（默认 Date.now），只用于 ReplayCall.at */
  now?: () => number;
}

export interface BwfHttpServerHandle {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * 通用 BWF 同构 HTTP JSON-RPC 服务（T-M6-69 抽出，回放服务与 bwf-farm-sim 复用）。
 * `handler` 只负责「工具 + 参数 → 回执文本 / isError」，协议层（JSON/SSE 双形态、
 * 坏请求体、端口分配）都在这里统一。
 */
export async function startBwfHttpServer(
  handler: (request: BwfToolRequest) => { text: string; isError?: boolean },
  options: BwfHttpServerOptions = {},
): Promise<BwfHttpServerHandle> {
  const mode = options.responseMode ?? 'json';
  const now = options.now ?? Date.now;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      let rpc: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        rpc = JSON.parse(body) as typeof rpc;
      } catch {
        respond(res, null, '回放服务：请求体不是合法 JSON', true, mode);
        return;
      }
      const tool = rpc.params?.name ?? 'get_state';
      const args = rpc.params?.arguments ?? {};
      let text: string;
      let isError = false;
      try {
        const receipt = handler({ tool, args });
        text = receipt.text;
        isError = receipt.isError === true;
      } catch (error) {
        text = `仿真服务内部错误：${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      options.onCall?.({ tool, args, text, isError, at: now() });
      respond(res, rpc.id, text, isError, mode);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('回放服务启动失败：没有拿到监听端口');

  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/**
 * 启动回放服务。返回的 endpoint 可直接喂给 `new StardewAdapter(endpoint)`。
 */
export async function startBwfReplayServer(
  scenario: StuckScenario,
  options: ReplayServerOptions = {},
): Promise<ReplayServerHandle> {
  const state = new ReplayState(scenario);
  const calls: ReplayCall[] = [];

  const server = await startBwfHttpServer(({ tool, args }) => {
    if (tool === 'get_state') return { text: state.text() };
    const choiceGate = state.isChoiceMenu() && tool === 'dialogue';
    if (choiceGate && typeof args.choice !== 'number') {
      // BWF 语义：选择题必须带 choice（0 基），否则拒绝——S03 回归要咬住的行为
      return { text: '失败：这是选择题，需要用 dialogue 传 choice 序号（0 基）回答', isError: true };
    }
    state.unfreezeFor(tool);
    const rule = matchRule(scenario, tool);
    if (rule === undefined) {
      return { text: `失败：剧本仍未覆盖工具 ${tool}（请在 rules 里补规则）`, isError: true };
    }
    state.advance(rule.advanceMinutes);
    // 合法选项推进成功 → 界面关闭（BWF 选完选项即结束对话）
    if (choiceGate) state.menuCleared = true;
    return { text: rule.receipt.text, isError: rule.receipt.isError };
  }, {
    responseMode: options.responseMode,
    now: options.now,
    onCall: (call) => calls.push(call),
  });

  return {
    endpoint: server.endpoint,
    calls,
    clock: () => state.clock,
    stateText: () => state.text(),
    close: server.close,
  };
}
