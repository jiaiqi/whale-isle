/**
 * 饥荒联机版（DST）GameAdapter + 零 token 规则规划器（M7 / T-M7-D5）。
 *
 * transport 把统一桥接面（sidecar 18100）映射成编排器熟悉的 callTool：
 *   get_state    → GET  /state（契约校验后转 JSON 文本）
 *   动作工具     → POST /act → GET /action_status 轮询（四态回执为唯一事实源）
 *   cancel_action→ POST /cancel
 * 超时返回 kind='timeout'（超时≠失败，绝不重发）；busy 返回 ACTION_IN_FLIGHT 错误。
 * 机制思想参考 fruitstarzero/Don-t-Starve-Together-AI-Companion（MIT），代码原创。
 */
import { randomUUID } from 'node:crypto';
import {
  DstStateSnapshotSchema,
  DstActionReceiptSchema,
  GameBridgeActionAcceptedSchema,
  GameBridgeHealthSchema,
  type DstStateSnapshot,
} from '@workbench/shared-protocol';
import { gameAdapters, type GameAdapter, type GameBridgeTransport, type ReceiptClassification } from './adapter';
import type { McpCallOptions, McpCallResult } from './mcp-client';
import type { GameStateSnapshot, Planner, PlannerDecision } from './planner';

const DEFAULT_DST_ENDPOINT = 'http://127.0.0.1:18100';

/** DST 工具白名单（~30）：全部由 mod 内 vanilla API 执行，禁止任意 Lua。 */
export const DST_TOOL_WHITELIST = [
  'get_state', 'move_to', 'goto', 'gather', 'pickup', 'harvest', 'chop', 'mine', 'work',
  'attack', 'fight', 'eat', 'heal', 'craft', 'cook', 'place_campfire', 'add_fuel', 'refuel',
  'equip', 'unequip', 'sleep', 'rest', 'follow', 'cancel_action', 'stop', 'build', 'plant',
  'fish', 'examine', 'wait',
] as const;

/** 长动作（可能 >30s）：分层超时表由 ActionLock 注入 10min；短动作 30s。 */
const DST_LONG_ACTIONS = new Set([
  'move_to', 'goto', 'gather', 'pickup', 'harvest', 'chop', 'mine', 'work',
  'attack', 'fight', 'cook', 'place_campfire', 'sleep', 'rest', 'follow', 'fish', 'build',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DstBridgeTransport implements GameBridgeTransport {
  constructor(
    private readonly endpoint: string = DEFAULT_DST_ENDPOINT,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pollIntervalMs = 100,
  ) {}

  async callTool(tool: string, args: Record<string, unknown> = {}, opts: McpCallOptions = {}): Promise<McpCallResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (tool === 'get_state') {
        const res = await this.fetchImpl(`${this.endpoint}/state`, { signal: controller.signal });
        if (!res.ok) return { kind: 'error', message: `GET /state HTTP ${res.status}` };
        const raw = await res.text();
        let parsed: unknown;
        try { parsed = JSON.parse(raw) as unknown; } catch { return { kind: 'error', message: 'GET /state 非 JSON 响应' }; }
        const snapshot = DstStateSnapshotSchema.safeParse(parsed);
        if (!snapshot.success) return { kind: 'error', message: `快照契约违规：${snapshot.error.message.slice(0, 200)}` };
        return { kind: 'ok', text: JSON.stringify(snapshot.data), isError: false };
      }

      if (tool === 'cancel_action') {
        const res = await this.fetchImpl(`${this.endpoint}/cancel`, { method: 'POST', signal: controller.signal });
        if (!res.ok) return { kind: 'error', message: `POST /cancel HTTP ${res.status}` };
        const body = await res.json() as { cancelled?: boolean };
        return { kind: 'ok', text: JSON.stringify(body), isError: false };
      }

      const actionId = randomUUID();
      const res = await this.fetchImpl(`${this.endpoint}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, tool, args }),
        signal: controller.signal,
      });
      if (!res.ok) return { kind: 'error', message: `POST /act HTTP ${res.status}` };
      const accepted = GameBridgeActionAcceptedSchema.parse(await res.json() as unknown);
      if (!accepted.accepted) {
        return { kind: 'error', message: accepted.reason ?? 'ACTION_REJECTED' };
      }

      // 长动作轮询：running=true 期间严禁重发；超时只记 timeout，回执仍由 /action_status 决定。
      while (Date.now() < deadline) {
        const statusRes = await this.fetchImpl(`${this.endpoint}/action_status?id=${encodeURIComponent(actionId)}`, {
          signal: controller.signal,
        });
        if (!statusRes.ok) return { kind: 'error', message: `GET /action_status HTTP ${statusRes.status}` };
        const status = await statusRes.json() as { receipt?: unknown };
        if (status.receipt !== undefined && isRecord(status.receipt)) {
          const receipt = DstActionReceiptSchema.parse(status.receipt);
          return {
            kind: 'ok',
            text: JSON.stringify(receipt),
            isError: receipt.status === 'FAILED' || receipt.status === 'ABORTED_BY_HUMAN_TAKEOVER',
          };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, remaining)));
      }
      return { kind: 'timeout', timeoutMs };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { kind: 'timeout', timeoutMs };
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return false;
      const health = GameBridgeHealthSchema.safeParse(await res.json() as unknown);
      return health.success && health.data.ok && health.data.gameId === 'dst';
    } catch {
      return false;
    }
  }
}

const PHASE_TEXT: Record<DstStateSnapshot['clock']['phase'], string> = {
  day: '白天', dusk: '黄昏', night: '夜晚',
};
const SEASON_TEXT: Record<DstStateSnapshot['clock']['season'], string> = {
  spring: '春', summer: '夏', autumn: '秋', winter: '冬',
};

/** 结构化 DST 快照 → 编排器通用 GameStateSnapshot（无 capturedAt，避免卡死哨兵失效）。 */
export function parseDstState(raw: string): GameStateSnapshot {
  const state = DstStateSnapshotSchema.parse(JSON.parse(raw) as unknown);
  const { clock, player, control } = state;
  const progress = clock.phaseProgress;
  const clockMinutes = clock.phase === 'day'
    ? 6 * 60 + Math.round(progress * 12 * 60)
    : clock.phase === 'dusk'
      ? 18 * 60 + Math.round(progress * 2 * 60)
      : 20 * 60 + Math.round(progress * 4 * 60);
  const gold = player.inventory
    .filter((item) => /gold|金币/.test(item.itemName))
    .reduce((sum, item) => sum + item.count, 0);
  return {
    raw,
    gameClock: `第${clock.cycle}轮 ${PHASE_TEXT[clock.phase]} ${Math.round(progress * 100)}% ${SEASON_TEXT[clock.season]}`,
    clockMinutes,
    stamina: player.health.current,
    staminaMax: player.health.max,
    money: gold,
    location: `X${player.position.x} Z${player.position.z}`,
    menu: control.authority === 'HUMAN_TAKEOVER_ACTIVE' ? '玩家接管中' : '',
    season: SEASON_TEXT[clock.season],
    day: clock.cycle,
    freeSlots: Math.max(0, 16 - player.inventory.length),
    posX: player.position.x,
    posY: player.position.z,
    weather: clock.isRaining ? '下雨' : '晴',
    health: player.health.current,
    healthMax: player.health.max,
    birthday: null,
    festival: null,
  };
}

/** 卡死哨兵时钟摘要：只取游戏内时钟，绝不取 capturedAt（否则永远不 stale）。 */
export function extractDstClock(stateText: string): string | null {
  try {
    const state = DstStateSnapshotSchema.parse(JSON.parse(stateText) as unknown);
    return `${state.clock.cycle}|${state.clock.phase}|${state.clock.phaseProgress.toFixed(2)}|${state.clock.season}`;
  } catch {
    return null;
  }
}

export function classifyDstReceipt(input: {
  text: string;
  kind: McpCallResult['kind'];
  isError: boolean;
  tool: string;
  errorMessage?: string;
}): ReceiptClassification {
  const { text, kind, isError, tool, errorMessage } = input;
  if (kind === 'timeout') {
    return { status: 'TIMEOUT', summary: `${tool} 超时≠失败：游戏侧可能仍在执行，以 /action_status 复核，禁止重发` };
  }
  if (kind === 'error') {
    return { status: 'ERROR', summary: `${errorMessage ?? ''}${text ? ` ${text}` : '客户端错误'}`.trim() };
  }
  try {
    const receipt = DstActionReceiptSchema.parse(JSON.parse(text) as unknown);
    const reason = receipt.reason ?? '';
    switch (receipt.status) {
      case 'COMPLETED':
        return { status: 'COMPLETED', summary: `${tool} 完成${reason ? `：${reason}` : ''}` };
      case 'FAILED':
        return { status: 'FAILED', summary: `${tool} 失败：${reason || '无原因'}` };
      case 'UNCERTAIN':
        return { status: 'UNCERTAIN', summary: `${tool} 结果不确定：${reason || '需复核状态'}` };
      case 'ABORTED_BY_HUMAN_TAKEOVER':
        return { status: 'FAILED', summary: `${tool} 已被玩家接管中止（不重发）：${reason}` };
    }
  } catch {
    // 非结构化回执（老版本 mod / 文件降级手工注入）→ 退回文本启发式
  }
  if (isError) {
    return { status: /UNCERTAIN|不确定|unknown/i.test(text) ? 'UNCERTAIN' : 'FAILED', summary: text.slice(0, 300) };
  }
  return { status: 'COMPLETED', summary: text.slice(0, 300) };
}

/**
 * 零 token 兜底规划器：无 LLM key 时也能安全玩 DST。
 * 优先级：玩家接管 > 猎犬/理智危机 > 血线 > 饥饿 > 黄昏回火堆 > 安全待机。
 */
export class DstRulePlanner implements Planner {
  readonly name = 'dst-rule-zero-token';
  private lastSnapshot: DstStateSnapshot | null = null;

  /** adapter.parseState 每次调用时注入最新结构化快照，无需重新 JSON 解析。 */
  observe(snapshot: DstStateSnapshot): void {
    this.lastSnapshot = snapshot;
  }

  private snapshot(state: GameStateSnapshot): DstStateSnapshot | null {
    if (this.lastSnapshot !== null) return this.lastSnapshot;
    try {
      return DstStateSnapshotSchema.parse(JSON.parse(state.raw) as unknown);
    } catch {
      return null;
    }
  }

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    const snap = this.snapshot(state);
    if (snap === null) {
      return { kind: 'wait', seconds: 5, reason: 'DST 快照不可解析——安全待机，等待 mod 重新上报' };
    }
    if (snap.control.authority === 'HUMAN_TAKEOVER_ACTIVE' || snap.control.isPlayerMovingPhysically) {
      return { kind: 'wait', seconds: 5, reason: '玩家已接管键鼠——AI 挂起动作锁，场边观察' };
    }

    const player = snap.player;
    const healthRatio = player.health.max > 0 ? player.health.current / player.health.max : 1;
    const hungerRatio = player.hunger.max > 0 ? player.hunger.current / player.hunger.max : 1;
    const sanityRatio = player.sanity.max > 0 ? player.sanity.current / player.sanity.max : 1;
    const hasFood = player.inventory.some((item) => /berry|berries|meat|food|carrot|pierogi|水果|肉|食物/.test(item.itemName));
    const hasFuel = player.inventory.some((item) => /log|twig|grass|fuel|木头|树枝|草/.test(item.itemName));

    // 猎犬/蜘蛛/BOSS：血线危险先撤，否则迎战（不做"站在原地掉血"的无意义重复动作）
    const threat = snap.threats.find((t) => /hound|spider|boss/.test(t.kind));
    if (threat && healthRatio < 0.35) {
      return { kind: 'act', tool: 'move_to', args: { awayFrom: 'hound' }, intent: `猎犬危机且血量仅 ${Math.round(healthRatio * 100)}%——先撤` };
    }
    if (threat) {
      return { kind: 'act', tool: 'attack', args: { target: threat.kind }, intent: `${threat.kind}×${threat.count} 来袭——迎战` };
    }

    if (healthRatio < 0.3) {
      return hasFood
        ? { kind: 'act', tool: 'eat', args: {}, intent: '血量见底——先吃东西回血' }
        : { kind: 'act', tool: 'move_to', args: { awayFrom: 'threat' }, intent: '血量见底且无食物——脱离危险区' };
    }
    if (hungerRatio < 0.3) {
      return hasFood
        ? { kind: 'act', tool: 'eat', args: {}, intent: '饥饿告急——进食' }
        : { kind: 'act', tool: 'gather', args: { item: 'berries' }, intent: '饥饿告急且无食物——采浆果' };
    }

    const fireLow = snap.nearby.campfires.length === 0
      || snap.nearby.campfires.every((fire) => fire.fuelPercent < 0.3);
    if ((snap.clock.phase === 'dusk' || snap.clock.phase === 'night') && fireLow) {
      return hasFuel || snap.nearby.campfires.length > 0
        ? { kind: 'act', tool: 'add_fuel', args: {}, intent: '黄昏/夜晚火堆将熄——回火堆添柴' }
        : { kind: 'act', tool: 'place_campfire', args: {}, intent: '黄昏/夜晚无火堆且无燃料——建营火' };
    }

    if (sanityRatio < 0.3) {
      return { kind: 'act', tool: 'gather', args: { item: 'flower' }, intent: '理智偏低——采花稳定精神' };
    }
    return { kind: 'wait', seconds: 5, reason: '三维平稳、无威胁——安全待机观察' };
  }
}

export class DstAdapter implements GameAdapter {
  readonly gameId = 'dst' as const;
  readonly displayName = '饥荒联机版（DST）';
  readonly transport: DstBridgeTransport;
  readonly rulePlanner = new DstRulePlanner();
  readonly toolWhitelist: readonly string[] = DST_TOOL_WHITELIST;
  readonly guideTopics: readonly string[] = [];

  constructor(
    private readonly endpoint: string = DEFAULT_DST_ENDPOINT,
    fetchImpl: typeof fetch = fetch,
    pollIntervalMs = 100,
  ) {
    this.transport = new DstBridgeTransport(endpoint, fetchImpl, pollIntervalMs);
  }

  get unreachableMessage(): string {
    return `DST 桥不可达（${this.endpoint}）——确认 sidecar 已启动、mod 已安装且 pair_token 一致、已完成 /v1/tick 首次快照上报；cluster_token.txt 需人类用 Klei 账号配置`;
  }

  ping(): Promise<boolean> {
    return this.transport.ping();
  }

  parseState(raw: string): GameStateSnapshot {
    const snapshot = DstStateSnapshotSchema.parse(JSON.parse(raw) as unknown);
    this.rulePlanner.observe(snapshot);
    return parseDstState(raw);
  }

  extractClock(stateText: string): string | null {
    return extractDstClock(stateText);
  }

  isLongAction(tool: string): boolean {
    return DST_LONG_ACTIONS.has(tool);
  }

  createRulePlanner(): Planner {
    return this.rulePlanner;
  }

  classifyReceipt(input: Parameters<typeof classifyDstReceipt>[0]): ReceiptClassification {
    return classifyDstReceipt(input);
  }
}

/** 模块加载即注册（同 terraria 泳道约定）；AutodriveRunner 通过 gameAdapters.create('dst') 取用。 */
gameAdapters.register('dst', ({ endpoint, fetchImpl }) => new DstAdapter(endpoint, fetchImpl));
