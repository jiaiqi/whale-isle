/**
 * 泰拉瑞亚桥接适配器与零 token 规则规划器（M7 / T-M7-T3~T6）。
 *
 * - `TerrariaBridgeClient`：统一接口面的 HTTP 客户端（GET /state · POST /act ·
 *   GET /action_status · POST /cancel · GET /health），两段式受理 + 轮询回执，
 *   遵守「超时 ≠ 失败」铁律（超时只返回 kind=timeout，绝不自动重发）。
 * - `TerrariaAdapter`：实现 GameAdapter，结构化快照 → GameStateSnapshot 映射、
 *   JSON 时钟提取、分层长动作表、结构化四态回执分类、高层工具白名单。
 * - `TerrariaRulePlanner`：零 token 确定性兜底（砍树 → 掩体 → 火把 → 守夜；
 *   低血喝药/撤退、岩浆反射、Boss 撤退），含 UNCERTAIN 冷却与单日失败预算。
 *
 * 设计取舍见 docs/REFERENCE-terrariablind.md：移植 TerraBlind 的
 * 「accepted → status → outcome 三段式回执 + 世界事实终止判据」思想，
 * 但传输与契约以 shared-protocol 为准；不抄任何 GPL/无许可证项目源码。
 */
import { randomUUID } from 'node:crypto';
import {
  GameBridgeActionAcceptedSchema,
  GameBridgeActionStatusSchema,
  GameBridgeHealthSchema,
  GameBridgeReceiptSchema,
  TerrariaStateSnapshotSchema,
  type TerrariaStateSnapshot,
} from '@workbench/shared-protocol';
import type { GameStateSnapshot, Planner, PlannerDecision } from './planner';
import type { McpCallOptions, McpCallResult } from './mcp-client';
import {
  gameAdapters,
  type GameAdapter,
  type GameBridgeTransport,
  type ReceiptClassification,
} from './adapter';

/** 高层动作白名单（~30 个；屏蔽一切直写/越权原语，运行期安全锁） */
export const TERRARIA_TOOL_WHITELIST = Object.freeze([
  'get_state', 'move_to', 'jump', 'mine', 'place', 'attack', 'aim', 'use_item', 'craft', 'build_shelter',
  'torch', 'eat', 'drink_potion', 'grapple', 'say', 'set_mode', 'update_notes', 'cancel_action', 'wait', 'flee',
  'dig_tunnel', 'place_platform', 'place_wall', 'collect', 'interact', 'equip', 'unequip', 'light_torch',
  'retreat', 'heal', 'status', 'stop',
] as const);

export type TerrariaTool = (typeof TERRARIA_TOOL_WHITELIST)[number];

export function isTerrariaToolAllowed(tool: string): tool is TerrariaTool {
  return (TERRARIA_TOOL_WHITELIST as readonly string[]).includes(tool);
}

/** 长动作表（>30s 才按长动作处理；与 TerraBlind 的「世界事实终止判据」长任务对应） */
const LONG_ACTIONS = new Set([
  'move_to', 'mine', 'build_shelter', 'dig_tunnel', 'flee', 'grapple', 'craft', 'place_platform', 'wait',
]);

const DEFAULT_TERRARIA_ENDPOINT = 'http://127.0.0.1:18090';

export interface TerrariaClientOptions {
  /** 轮询间隔（默认 200ms；测试可注入 1ms 加速） */
  pollIntervalMs?: number;
  /** 单次动作最长等待（未提供 opts.timeoutMs 时使用；默认 120_000ms） */
  maxWaitMs?: number;
  /** 时钟源（测试注入式确定性） */
  now?: () => number;
  /** actionId 工厂（测试可注入固定 UUID） */
  idFactory?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 统一桥接协议 HTTP 客户端。
 * 注意：get_state 与 cancel_action 在协议层有专属端点，其余工具走 /act + /action_status。
 */
export class TerrariaBridgeClient implements GameBridgeTransport {
  constructor(
    private readonly endpoint: string = DEFAULT_TERRARIA_ENDPOINT,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: TerrariaClientOptions = {},
  ) {}

  async callTool(tool: string, args: Record<string, unknown> = {}, opts: McpCallOptions = {}): Promise<McpCallResult> {
    // 白名单越权拦截：连 HTTP 请求都不发（运行期安全锁，严禁直写工具绕过）
    if (!isTerrariaToolAllowed(tool)) {
      return { kind: 'error', message: `TOOL_NOT_IN_WHITELIST: ${tool}（泰拉瑞亚桥仅放行高层动作）` };
    }
    try {
      if (tool === 'get_state') {
        const res = await this.fetchImpl(`${this.endpoint}/state`, { method: 'GET' });
        if (!res.ok) return { kind: 'error', message: `GET /state HTTP ${res.status}` };
        return { kind: 'ok', text: await res.text(), isError: false };
      }
      if (tool === 'cancel_action') {
        const res = await this.fetchImpl(`${this.endpoint}/cancel`, { method: 'POST' });
        if (!res.ok) return { kind: 'error', message: `POST /cancel HTTP ${res.status}` };
        return { kind: 'ok', text: await res.text(), isError: false };
      }

      const actionId = (this.options.idFactory ?? randomUUID)();
      const acceptedRes = await this.fetchImpl(`${this.endpoint}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, tool, args }),
      });
      if (!acceptedRes.ok) return { kind: 'error', message: `POST /act HTTP ${acceptedRes.status}` };
      const accepted = GameBridgeActionAcceptedSchema.parse(await acceptedRes.json());
      if (!accepted.accepted) {
        // busy / 校验拒绝：作为客户端错误返回，编排器不会误当成「动作失败」重发
        return { kind: 'error', message: accepted.reason ?? 'ACTION_REJECTED' };
      }

      const now = this.options.now ?? Date.now;
      const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const deadline = now() + (opts.timeoutMs ?? this.options.maxWaitMs ?? 120_000);
      const pollMs = this.options.pollIntervalMs ?? 200;
      while (now() <= deadline) {
        const statusRes = await this.fetchImpl(`${this.endpoint}/action_status?id=${encodeURIComponent(actionId)}`, { method: 'GET' });
        if (!statusRes.ok) return { kind: 'error', message: `GET /action_status HTTP ${statusRes.status}` };
        const status = GameBridgeActionStatusSchema.parse(await statusRes.json());
        if (status.receipt) {
          // 结构化回执原样转 text，分类由 classifyReceipt 按 status 判定（不靠正则猜中文前缀）
          return { kind: 'ok', text: JSON.stringify(status.receipt), isError: status.receipt.status !== 'COMPLETED' };
        }
        if (!status.running) {
          // 服务端明确不在跑又没回执 → 协议异常，按错误处理（不伪造成功/失败）
          return { kind: 'error', message: `action_status 无回执且未运行：${actionId}` };
        }
        await sleep(pollMs);
      }
      // 超时：动作可能仍在模组侧执行——绝不写 FAILED，交由上层 get_state 复核
      return { kind: 'timeout', timeoutMs: opts.timeoutMs ?? this.options.maxWaitMs ?? 120_000 };
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 探活：GET /health（不启动任何动作） */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.endpoint}/health`, { method: 'GET' });
      if (!res.ok) return false;
      return GameBridgeHealthSchema.parse(await res.json()).ok;
    } catch {
      return false;
    }
  }
}

/** 把 timeText（如 "07:30 AM"）换算为当日分钟；解析失败给保守值（白天 07:30） */
function parseClockMinutes(text: string): number {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  if (!m) return 7 * 60 + 30;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const pm = /PM/i.test(m[3] ?? '');
  if (hour === 12) hour = 0;
  return (hour + (pm ? 12 : 0)) * 60 + minute;
}

/** 结构化快照 → 编排器状态（无视觉模型；mana 映射到 stamina 槽位，资产/血线仍来自真实字段） */
export function parseTerrariaState(raw: string): GameStateSnapshot {
  const s: TerrariaStateSnapshot = TerrariaStateSnapshotSchema.parse(JSON.parse(raw) as unknown);
  return {
    raw,
    gameClock: `第 ${s.clock.dayCount} 天 ${s.clock.dayPhase} ${s.clock.timeText}`,
    clockMinutes: parseClockMinutes(s.clock.timeText),
    stamina: s.player.mana,
    staminaMax: s.player.manaMax,
    money: 0,
    location: s.world.biome,
    menu: '',
    season: '',
    day: s.clock.dayCount,
    freeSlots: Math.max(0, 40 - s.player.inventory.length),
    posX: s.player.position.x,
    posY: s.player.position.y,
    weather: s.world.events.join(','),
    health: s.player.hp,
    healthMax: s.player.hpMax,
    birthday: null,
    festival: null,
  };
}

/** 从 JSON clock 提取卡死哨兵时钟（dayCount + 昼夜相位；返回 null 表示无时钟） */
export function extractTerrariaClock(stateText: string): string | null {
  try {
    const parsed = TerrariaStateSnapshotSchema.safeParse(JSON.parse(stateText) as unknown);
    if (!parsed.success) return null;
    const { dayCount, isDay, dayPhase } = parsed.data.clock;
    return `day-${dayCount}-${isDay ? 'day' : 'night'}-${dayPhase}`;
  } catch {
    return null;
  }
}

/** 结构化四态回执分类（超时单独成态；接管映射为 FAILED 但保留显式原因） */
export function classifyTerrariaReceipt(input: {
  text: string;
  kind: McpCallResult['kind'];
  isError: boolean;
  tool: string;
  errorMessage?: string;
}): ReceiptClassification {
  const { text, kind, isError, tool, errorMessage } = input;
  if (kind === 'timeout') {
    return { status: 'TIMEOUT', summary: `超时（${tool} 仍在模组侧执行——下次 get_state 复核世界事实，严禁重发）` };
  }
  if (kind === 'error') {
    return { status: 'ERROR', summary: errorMessage ?? text.slice(0, 200) };
  }
  // 优先按结构化 status 判定（ TerraBlind 三段式回执；不靠中文前缀猜）
  try {
    // 用基形契约解析（gameId/snapshot 为扩展字段，回执分类只需要 status/reason/tool）
    const receipt = GameBridgeReceiptSchema.safeParse(JSON.parse(text) as unknown);
    if (receipt.success) {
      const r = receipt.data;
      const status = r.status === 'ABORTED_BY_HUMAN_TAKEOVER' ? 'FAILED' : r.status;
      const reason = r.reason ? `(${r.reason})` : '';
      const prefix = r.status === 'ABORTED_BY_HUMAN_TAKEOVER' ? 'ABORTED_BY_HUMAN_TAKEOVER ' : '';
      return { status, summary: `${prefix}${tool}:${r.status}${reason}` };
    }
  } catch {
    /* 非 JSON：回落文本分类 */
  }
  if (isError) {
    const status = /UNCERTAIN|不确定|可能|unknown/i.test(text) ? 'UNCERTAIN' : 'FAILED';
    return { status, summary: text.slice(0, 300) };
  }
  return { status: 'COMPLETED', summary: text.slice(0, 300) };
}

export class TerrariaAdapter implements GameAdapter {
  readonly gameId = 'terraria' as const;
  readonly displayName = '泰拉瑞亚';
  readonly transport: TerrariaBridgeClient;
  readonly toolWhitelist = TERRARIA_TOOL_WHITELIST;
  readonly guideTopics: readonly string[] = [];
  readonly unreachableMessage: string;

  constructor(endpoint: string = DEFAULT_TERRARIA_ENDPOINT, fetchImpl: typeof fetch = fetch, options: TerrariaClientOptions = {}) {
    this.transport = new TerrariaBridgeClient(endpoint, fetchImpl, options);
    this.unreachableMessage = `泰拉瑞亚桥不可达（${endpoint}）——确认已安装 tModLoader 1.4.4.9 + terraria-bridge 模组且 18090 端口在监听`;
  }

  ping(): Promise<boolean> {
    return this.transport.ping();
  }

  parseState(raw: string): GameStateSnapshot {
    return parseTerrariaState(raw);
  }

  extractClock(stateText: string): string | null {
    return extractTerrariaClock(stateText);
  }

  isLongAction(tool: string): boolean {
    return LONG_ACTIONS.has(tool);
  }

  createRulePlanner(): Planner {
    return new TerrariaRulePlanner();
  }

  classifyReceipt(input: Parameters<typeof classifyTerrariaReceipt>[0]): ReceiptClassification {
    return classifyTerrariaReceipt(input);
  }
}

// 模块加载即在册（主代理装配时只需 import 本模块，不改 adapter.ts）
gameAdapters.register('terraria', ({ endpoint, fetchImpl }) => new TerrariaAdapter(endpoint, fetchImpl));

// ───────────────────────── 零 token 规则兜底规划器 ─────────────────────────

export interface TerrariaPlannerOptions {
  now?: () => number;
  /** 同一工具 UNCERTAIN 后冷却（默认 5000ms；避免连续撞墙死循环） */
  uncertainCooldownMs?: number;
  /** 单日同工具失败预算（默认 3；超出当日拉黑，呼应 LlmPlanner 单日失败预算） */
  maxFailuresPerDay?: number;
  /** F8 接管后挂起时长（默认 8000ms，对齐 TerrariaBridgeConfig.takeoverReacquireMs） */
  takeoverHoldMs?: number;
}

type ChainPhase = 'gather' | 'shelter' | 'torch' | 'watch' | 'work';

/**
 * 无 LLM 时的确定性兜底：白天砍树 → 搭掩体 → 插火把 → 夜里守夜；
 * 低血喝药/撤退、岩浆反射与 Boss 威胁走 P0 反射分支。
 */
export class TerrariaRulePlanner implements Planner {
  readonly name = 'terraria-rule-zero-token';
  private phase: ChainPhase = 'gather';
  private lastDay = -1;
  private uncertainUntil = new Map<string, number>();
  private readonly dailyFailures = new Map<string, number>();
  private takeoverUntil = 0;
  private readonly now: () => number;
  private readonly uncertainCooldownMs: number;
  private readonly maxFailuresPerDay: number;
  private readonly takeoverHoldMs: number;

  constructor(options: TerrariaPlannerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.uncertainCooldownMs = options.uncertainCooldownMs ?? 5_000;
    this.maxFailuresPerDay = options.maxFailuresPerDay ?? 3;
    this.takeoverHoldMs = options.takeoverHoldMs ?? 8_000;
  }

  /** 由编排器/测试喂入真实回执（无人调用时退化为纯状态驱动，仍可零 token 跑） */
  noteReceipt(tool: string, status: string, day?: number): void {
    const t = this.now();
    if (status === 'UNCERTAIN') {
      this.uncertainUntil.set(tool, t + this.uncertainCooldownMs);
      return;
    }
    if (status === 'ABORTED_BY_HUMAN_TAKEOVER' || status.includes('ABORTED_BY_HUMAN_TAKEOVER')) {
      this.takeoverUntil = t + this.takeoverHoldMs;
      return;
    }
    if (status === 'FAILED') {
      const d = day ?? this.lastDay;
      const key = `${d}:${tool}`;
      this.dailyFailures.set(key, (this.dailyFailures.get(key) ?? 0) + 1);
    }
  }

  /** 测试可查询：某工具今日失败次数 / 是否处于冷却 */
  failuresToday(tool: string, day: number): number {
    return this.dailyFailures.get(`${day}:${tool}`) ?? 0;
  }

  isCoolingDown(tool: string): boolean {
    return (this.uncertainUntil.get(tool) ?? 0) > this.now();
  }

  async decide(state: GameStateSnapshot): Promise<PlannerDecision> {
    if (this.lastDay !== state.day) {
      this.lastDay = state.day;
      this.phase = 'gather';
    }
    const snap = TerrariaStateSnapshotSchema.safeParse(JSON.parse(state.raw) as unknown);
    const danger = snap.success ? snap.data.danger : null;
    const night = /night|dusk/.test(snap.success ? snap.data.clock.dayPhase : '');

    // P0：玩家接管——AI 挂起，静默回托管（铁律：不抢键鼠）
    if (this.now() < this.takeoverUntil) {
      return { kind: 'wait', seconds: 2, reason: '玩家 F8 接管中，AI 挂起等待交还控制权' };
    }
    // P0：岩浆反射（SurvivalReflex 的规划侧镜像）
    if (danger?.lavaNearby && !this.isCoolingDown('jump')) {
      return { kind: 'act', tool: 'jump', args: {}, intent: '脚下有岩浆！先跳开再复核世界事实' };
    }
    // P0：低血喝药 / 撤退
    const hpRatio = state.healthMax > 0 ? state.health / state.healthMax : 1;
    if (hpRatio < 0.3) {
      if (!this.isCoolingDown('drink_potion') && this.failuresToday('drink_potion', state.day) < this.maxFailuresPerDay) {
        return { kind: 'act', tool: 'drink_potion', args: {}, intent: '血量危险，先喝药保命' };
      }
      return { kind: 'act', tool: 'flee', args: {}, intent: '没药可喝/喝药失败，先撤退再说' };
    }
    // P0：Boss 威胁 → 撤退（不贪刀，Boss 大师模式无伤由真模组反射保证）
    if (snap.success && snap.data.nearby.npcs.some((n) => n.isBoss && n.isHostile) && !this.isCoolingDown('flee')) {
      return { kind: 'act', tool: 'flee', args: {}, intent: '大师模式 Boss 在场，先撤到安全距离' };
    }
    // 单日失败预算：同一工具当日失败超限 → 转守夜等待，杜绝刷屏死循环
    const pick = (tool: string): boolean =>
      !this.isCoolingDown(tool) && this.failuresToday(tool, state.day) < this.maxFailuresPerDay;

    if (night || this.phase === 'watch') {
      this.phase = 'watch';
      if (pick('wait')) return { kind: 'act', tool: 'wait', args: { seconds: 10 }, intent: '天黑了，守夜（掩体+火把已就位）' };
      return { kind: 'wait', seconds: 10, reason: '夜间动作今日失败过多，原地守夜等天亮' };
    }
    // 白天建设链：砍树 → 掩体 → 火把 →（下一循环起）守夜/干活
    if (this.phase === 'gather' && pick('mine')) {
      this.phase = 'shelter';
      return { kind: 'act', tool: 'mine', args: { target: 'tree' }, intent: '先砍树攒木头' };
    }
    if (this.phase === 'shelter' && pick('build_shelter')) {
      this.phase = 'torch';
      return { kind: 'act', tool: 'build_shelter', args: {}, intent: '用木头搭个掩体，夜里不被怪堵门' };
    }
    if (this.phase === 'torch' && pick('torch')) {
      this.phase = 'work';
      return { kind: 'act', tool: 'torch', args: {}, intent: '掩体里插火把，照亮且抑制刷怪' };
    }
    if (pick('mine')) {
      return { kind: 'act', tool: 'mine', args: {}, intent: '天亮了，正常挖矿推进进度' };
    }
    return { kind: 'wait', seconds: 5, reason: '今日失败预算耗尽，暂停动作等待人工介入' };
  }
}
