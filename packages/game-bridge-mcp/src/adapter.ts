/**
 * 多游戏桥接适配器（T-M7-02）：把 AutodriveRunner/ActionLock 与「星露谷 BWF」解耦。
 * 星露谷实现为 StardewAdapter 原样包装 BwfMcpClient（18080 HTTP MCP）——真机链路零行为变化；
 * 泰拉瑞亚/DST 泳道各自注册 GameAdapter 实现，复用同一编排循环、互斥锁、饭碗与事件流。
 */
import { RulePlanner, type GameStateSnapshot, type Planner } from './planner';
import type { McpCallOptions, McpCallResult } from './mcp-client';
import { actionTimeoutMs, BwfMcpClient } from './mcp-client';

export type GameId = 'stardew' | 'terraria' | 'dst';

/** 桥接传输最小面（BwfMcpClient 与未来的 <Game>BridgeClient 都满足） */
export interface GameBridgeTransport {
  callTool(tool: string, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<McpCallResult>;
}

export type GameReceiptStatus = 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR';

export interface ReceiptClassification {
  status: GameReceiptStatus;
  summary: string;
}

/** 一个游戏接入编排器所需的全部钩子（新泳道只需实现本接口，无需改 runner） */
export interface GameAdapter {
  readonly gameId: GameId;
  readonly displayName: string;
  readonly transport: GameBridgeTransport;
  /** 探活（runner.start() 前调用） */
  ping(): Promise<boolean>;
  /** 不可达时的用户可读提示（含端点与排查指引） */
  readonly unreachableMessage: string;
  /** 从 get_state 原文解析编排器状态（默认走星露谷文本解析；新游戏传结构化快照映射） */
  parseState?(raw: string): GameStateSnapshot;
  /** 从状态原文提取游戏时钟摘要（卡死哨兵用；返回 null 表示无时钟） */
  extractClock(stateText: string): string | null;
  /** 长动作判定（分层超时表按游戏） */
  isLongAction(tool: string): boolean;
  /** 回执分类（BWF 文本三前缀 vs 新游戏结构化 JSON） */
  classifyReceipt(input: {
    text: string;
    kind: McpCallResult['kind'];
    isError: boolean;
    tool: string;
    errorMessage?: string;
  }): ReceiptClassification;
  /** LLM 工具白名单（可选：新游戏 adapter 提供；星露谷仍由 llm-planner 持有） */
  readonly toolWhitelist?: readonly string[];
  /** 游戏专属攻略主题；省略时宿主使用默认星露谷主题 */
  readonly guideTopics?: readonly string[];
  /** 规则模式/LLM 离线回退规划器；省略时使用星露谷 RulePlanner */
  createRulePlanner?(): Planner;
}

/** BWF 回执里的英文工具名 → 中文（英文留在括号里，方便对照日志） */
const BWF_TOOL_LABELS: Array<[RegExp, string]> = [
  [/(?<!（)[ \t]*craft Chest(?!）)[ \t]*/g, '制作宝箱（craft Chest）'],
  [/(?<!（)[ \t]*tidy_backpack(?!）)[ \t]*/g, '整理背包（tidy_backpack）'],
  [/(?<!（)[ \t]*store_items(?!）)[ \t]*/g, '存入箱子（store_items）'],
  [/(?<!（)[ \t]*take_items(?!）)[ \t]*/g, '取回物品（take_items）'],
  [/(?<!（)[ \t]*place_item(?!）)[ \t]*/g, '摆放物品（place_item）'],
  [/(?<!（)[ \t]*clear_area(?!）)[ \t]*/g, '清理（clear_area）'],
  [/(?<!（)[ \t]*bundle_info(?!）)[ \t]*/g, '查看收集包（bundle_info）'],
  [/(?<!（)[ \t]*donate_bundles(?!）)[ \t]*/g, '捐赠收集包（donate_bundles）'],
  [/(?<!（)[ \t]*travel_to(?!）)[ \t]*/g, '前往（travel_to）'],
  [/(?<!（)[ \t]*use_tool(?!）)[ \t]*/g, '使用工具（use_tool）'],
];

/**
 * BWF 回执人话化（2026-11-23 用户反馈）：
 *   - `\u6E7F...` 这类 JSON 转义还原成中文（BWF 会把收到的参数原样回显）；
 *   - 中文引号里的 JSON 数组/对象转成「a、b、c」；
 *   - 英文工具名后面补中文，英文保留在括号里（例：制作宝箱（craft Chest））。
 * 只做展示层清洗，不改回执状态与工具名；幂等（已带中文括号的不会套娃）。
 */
export function humanizeBwfReceipt(text: string): string {
  let out = text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  out = out.replace(/“(\[[\s\S]*?\]|\{[\s\S]*?\})”/g, (whole, json: string) => {
    try {
      // 某些回执会把引号再转义一层（[\\"湿透的报纸\\"]），先还原再 parse
      const parsed = JSON.parse(json.replace(/\\"/g, '"')) as unknown;
      if (Array.isArray(parsed)) return `“${parsed.map((item) => String(item)).join('、')}”`;
      // 正则保证这里只可能是对象（数组已提前返回）
      return `“${Object.keys(parsed as Record<string, unknown>).join('、')}”`;
    } catch {
      // 不是合法 JSON：保持原样，绝不猜
    }
    return whole;
  });
  for (const [pattern, label] of BWF_TOOL_LABELS) out = out.replace(pattern, label);
  return out;
}

/** 星露谷 BWF 文本回执分类（从 autodrive.ts 原样迁移，行为零变化） */
export function classifyStardewReceipt(input: {
  text: string;
  kind: McpCallResult['kind'];
  isError: boolean;
  tool: string;
  errorMessage?: string;
}): ReceiptClassification {
  const { text, kind, isError, tool, errorMessage } = input;
  if (kind === 'timeout') {
    return { status: 'TIMEOUT', summary: `超时（${tool} 仍在游戏侧执行的风险——下次 get_state 复核，不重发）` };
  }
  if (kind === 'error') {
    return { status: 'ERROR', summary: humanizeBwfReceipt((errorMessage ?? '') + (text.slice(0, 200) || '客户端错误')) };
  }
  if (isError) {
    const status = /UNCERTAIN|不确定|可能|unknown/i.test(text) ? 'UNCERTAIN' : 'FAILED';
    return { status, summary: humanizeBwfReceipt(text).slice(0, 300) };
  }
  return { status: 'COMPLETED', summary: humanizeBwfReceipt(text).slice(0, 300) };
}

const STARDEW_CLOCK_RE = /时间：第\d+年[春夏秋冬]\d+日 \d{2}:\d{2}/;
const DEFAULT_STARDEW_ENDPOINT = 'http://127.0.0.1:18080/mcp';

/** 星露谷适配器：原样包装 BwfMcpClient（真机链路行为不变，18760 WS 设计稿搁置） */
export class StardewAdapter implements GameAdapter {
  readonly gameId = 'stardew' as const;
  readonly displayName = '星露谷物语';
  readonly transport: BwfMcpClient;
  readonly unreachableMessage: string;
  readonly guideTopics = ['钓鱼', '采矿', '节日', '结婚', '沙漠', '姜岛', '农场类型'];

  constructor(endpoint: string = DEFAULT_STARDEW_ENDPOINT, fetchImpl: typeof fetch = fetch) {
    this.transport = new BwfMcpClient(endpoint, fetchImpl);
    this.unreachableMessage = endpoint === DEFAULT_STARDEW_ENDPOINT
      ? 'BWF MCP 不可达（18080）——确认游戏已启动且 Mod MCP 服务器就绪'
      : `BWF MCP 不可达（${endpoint}）——确认游戏已启动且 Mod MCP 服务器就绪`;
  }

  ping(): Promise<boolean> {
    return this.transport.ping();
  }

  extractClock(stateText: string): string | null {
    return STARDEW_CLOCK_RE.exec(stateText)?.[0] ?? null;
  }

  isLongAction(tool: string): boolean {
    return actionTimeoutMs(tool) > 30_000;
  }

  createRulePlanner(): Planner {
    return new RulePlanner();
  }

  classifyReceipt(input: Parameters<typeof classifyStardewReceipt>[0]): ReceiptClassification {
    return classifyStardewReceipt(input);
  }
}

/** 适配器工厂（每次 start 独立实例，避免 fetchImpl 注入互相污染） */
export type GameAdapterFactory = (options: { endpoint?: string; fetchImpl?: typeof fetch }) => GameAdapter;

export class GameAdapterRegistry {
  private readonly factories = new Map<GameId, GameAdapterFactory>();

  register(gameId: GameId, factory: GameAdapterFactory): void {
    this.factories.set(gameId, factory);
  }

  create(gameId: GameId, options: { endpoint?: string; fetchImpl?: typeof fetch } = {}): GameAdapter {
    const factory = this.factories.get(gameId);
    if (!factory) throw new Error(`未注册的游戏适配器：${gameId}（已注册：${this.list().join(', ') || '无'}）`);
    return factory(options);
  }

  list(): GameId[] {
    return [...this.factories.keys()];
  }

  has(gameId: GameId): boolean {
    return this.factories.has(gameId);
  }
}

/** 全局注册表：星露谷默认在册；泰拉瑞亚/DST 泳道在各自 adapter 模块加载时 register。 */
export const gameAdapters = new GameAdapterRegistry();
gameAdapters.register('stardew', ({ endpoint, fetchImpl }) => new StardewAdapter(endpoint, fetchImpl));
