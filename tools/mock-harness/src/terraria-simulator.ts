/**
 * [SIMULATION] terraria-simulator —— tModLoader 模组「terraria-bridge」的确定性 HTTP 仿真服务端（M7 / T-M7-T1）。
 *
 * 统一桥接协议（与真模组同协议、同契约）：
 *   GET  /state                      → TerrariaStateSnapshot JSON
 *   POST /act      {actionId,tool,args} → GameBridgeActionAccepted（busy: accepted=false, reason=ACTION_IN_FLIGHT）
 *   GET  /action_status?id=<uuid>    → GameBridgeActionStatus（running + 可选 receipt）
 *   POST /cancel                     → { cancelled: boolean }
 *   GET  /health                     → GameBridgeHealth
 *
 * 5 个确定性剧本（复用 BWF 离线测试纪律，标记 [SIMULATION]，严禁冒充真机）：
 *   ① normal_mining    正常挖矿 + 走位 → COMPLETED
 *   ② cave_stuck       洞穴卡死 UNCERTAIN×3 → FAILED(PATH_BLOCKED_PERSISTENT)
 *   ③ lava_survival    岩浆生存反射中断在飞动作 → UNCERTAIN(LAVA_ESCAPE_TRIGGERED)，逃生动作 COMPLETED
 *   ④ player_takeover  F8 玩家接管 <100ms → ABORTED_BY_HUMAN_TAKEOVER
 *   ⑤ boss_low_hp      Boss 低血撤退：非撤退动作 FAILED(BOSS_LOW_HP_RETREAT)，喝药/撤退 COMPLETED
 *
 * 铁律对齐 AGENTS.md §2.2：
 *   - 所有回执出站前过 TerrariaActionReceiptSchema.parse（契约漂移 fail-fast）；
 *   - 回执时间注入式确定性（默认假时钟每次调用 +1ms），测试可复现；
 *   - 超时 ≠ 失败：动作在服务端独立结算，客户端轮询/超时不改写回执状态；
 *   - 互斥：单飞行动作，重复 POST /act 返回 ACTION_IN_FLIGHT。
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  GameBridgeActionAcceptedSchema,
  GameBridgeActionRequestSchema,
  GameBridgeActionStatusSchema,
  GameBridgeHealthSchema,
  GameBridgeReceiptStatusSchema,
  TerrariaActionReceiptSchema,
  TerrariaStateSnapshotSchema,
  type GameBridgeActionAccepted,
  type GameBridgeActionStatus,
  type GameBridgeHealth,
  type GameBridgeReceiptStatus,
  type TerrariaActionReceipt,
  type TerrariaStateSnapshot,
} from '@workbench/shared-protocol';

export type TerrariaScenarioId =
  | 'normal_mining'
  | 'cave_stuck'
  | 'lava_survival'
  | 'player_takeover'
  | 'boss_low_hp';

/** 撤退/逃生类动作：Boss 低血与岩浆反射下允许执行 */
const RETREAT_TOOLS = new Set(['flee', 'jump', 'drink_potion', 'eat', 'grapple', 'cancel_action', 'get_state']);
/** 洞穴卡死判定的动作 */
const DIG_MOVE_TOOLS = new Set(['mine', 'move_to']);

export interface TerrariaSimulatorOptions {
  /** 回执时间源（注入式确定性）；默认假时钟每次调用 +1ms */
  now?: () => number;
  /** 正常动作模拟结算延迟（ms），默认 5ms；接管剧本可拉大以命中在飞中止路径 */
  actionDelayMs?: number;
}

interface InFlightAction {
  actionId: string;
  tool: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

function makeDeterministicClock(): () => number {
  let t = 1_760_000_000_000; // 固定纪元，保证每次运行回执时间完全一致
  return () => (t += 1);
}

function buildPresetState(scenario: TerrariaScenarioId, now: () => number): TerrariaStateSnapshot {
  const rowsByScenario: Record<TerrariaScenarioId, string[]> = {
    normal_mining: [
      '###########', '#.........#', '#..T..O...#', '#.........#', '###########',
    ],
    cave_stuck: [
      '###########', '#..#......#', '#..#.O....#', '#.........#', '###########',
    ],
    lava_survival: [
      '###########', '#....~....#', '#..T..O...#', '#.........#', '###########',
    ],
    player_takeover: [
      '###########', '#.........#', '#..T..O...#', '#.........#', '###########',
    ],
    boss_low_hp: [
      '###########', '#.........#', '#..T..O...#', '#.........#', '###########',
    ],
  };

  // 出站前过状态契约（LLM 感知与真模组 StateExporter 共用同一形状）
  let state = TerrariaStateSnapshotSchema.parse({
    schemaVersion: 1,
    capturedAt: now(),
    clock: {
      dayCount: 3,
      isDay: true,
      dayPhase: 'day',
      timeText: '07:30 AM',
      hardMode: false,
    },
    player: {
      hp: 200,
      hpMax: 200,
      mana: 100,
      manaMax: 100,
      position: { x: 120, y: 80 },
      facing: 'right',
      buffs: [],
      inventory: [
        { slot: 0, itemName: 'Iron Pickaxe', stack: 1 },
        { slot: 1, itemName: 'Torch', stack: 99 },
        { slot: 2, itemName: 'Healing Potion', stack: 5 },
      ],
      selectedSlot: 0,
    },
    world: { biome: 'Forest', events: [], downedBosses: [] },
    nearby: {
      tiles: {
        originX: 115,
        originY: 75,
        width: 11,
        height: 5,
        legend: { '#': 'solid', '.': 'air', '~': 'lava', 'T': 'tree', 'O': 'ore' },
        rows: rowsByScenario[scenario],
      },
      npcs: [],
      items: [],
    },
    danger: { lavaNearby: false, fallingDanger: false, threatLevel: 'safe' },
    control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
  });

  switch (scenario) {
    case 'cave_stuck':
      state = TerrariaStateSnapshotSchema.parse({
        ...state,
        world: { ...state.world, biome: 'Underground' },
        player: { ...state.player, position: { x: 120, y: 200 } },
      });
      break;
    case 'lava_survival':
      state = TerrariaStateSnapshotSchema.parse({
        ...state,
        world: { ...state.world, biome: 'Underground' },
        danger: { lavaNearby: true, fallingDanger: false, threatLevel: 'critical' },
      });
      break;
    case 'boss_low_hp':
      state = TerrariaStateSnapshotSchema.parse({
        ...state,
        clock: { ...state.clock, dayPhase: 'dusk', timeText: '06:45 PM' },
        world: { ...state.world, events: ['EyeOfCthulhu'] },
        player: { ...state.player, hp: 45 },
        nearby: {
          ...state.nearby,
          npcs: [
            { name: 'Eye of Cthulhu', hp: 1400, hpMax: 1400, position: { x: 126, y: 78 }, isHostile: true, isBoss: true },
          ],
        },
        danger: { lavaNearby: false, fallingDanger: false, threatLevel: 'critical' },
      });
      break;
    default:
      break;
  }
  return state;
}

export class TerrariaSimulator {
  private server: Server | null = null;
  private state: TerrariaStateSnapshot;
  private inFlight: InFlightAction | null = null;
  private readonly receipts = new Map<string, TerrariaActionReceipt>();
  private readonly scenario: TerrariaScenarioId;
  private readonly now: () => number;
  private readonly actionDelayMs: number;
  private uncertainStreak = 0;

  constructor(scenario: TerrariaScenarioId, options: TerrariaSimulatorOptions = {}) {
    this.scenario = scenario;
    this.now = options.now ?? makeDeterministicClock();
    this.actionDelayMs = options.actionDelayMs ?? 5;
    this.state = buildPresetState(scenario, this.now);
  }

  /** 启动 HTTP 服务端（ephemeral 端口 0，只监听本机） */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res).catch((error: unknown) => {
          this.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          this.server = server;
          resolve(`http://127.0.0.1:${address.port}`);
        } else {
          /* v8 ignore next —— port=0 listen 成功后 address 必为对象（防御式兜底） */
          reject(new Error('无法获取模拟器监听地址'));
        }
      });
    });
  }

  close(): void {
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  /** 剧本 ④：F8/物理键鼠接管开关。true 且存在在飞动作 → 立即 ABORTED（<100ms） */
  setPhysicalInput(moving: boolean): void {
    this.state = TerrariaStateSnapshotSchema.parse({
      ...this.state,
      capturedAt: this.now(),
      control: {
        authority: moving ? 'HUMAN_TAKEOVER_ACTIVE' : 'AI_AUTOPILOT',
        isPlayerMovingPhysically: moving,
      },
    });
    if (moving && this.inFlight) {
      this.interruptInFlight('ABORTED_BY_HUMAN_TAKEOVER', 'PLAYER_PHYSICAL_INPUT_DETECTED');
    }
  }

  /** 剧本 ③：岩浆生存反射触发——在飞动作被打断，原动作结果不可判定 → UNCERTAIN */
  triggerSurvivalReflex(): void {
    this.state = TerrariaStateSnapshotSchema.parse({
      ...this.state,
      capturedAt: this.now(),
      danger: { ...this.state.danger, lavaNearby: true, threatLevel: 'critical' },
    });
    if (this.inFlight) {
      this.interruptInFlight('UNCERTAIN', 'LAVA_ESCAPE_TRIGGERED');
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw === '') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
    return parsed as Record<string, unknown>;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/state') {
      this.sendJson(res, 200, TerrariaStateSnapshotSchema.parse(this.state));
      return;
    }
    if (method === 'GET' && path === '/health') {
      const health = GameBridgeHealthSchema.parse({
        ok: true,
        gameId: 'terraria',
        bridgeVersion: '0.1.0-sim',
        gameVersion: '1.4.4.9',
        control: this.state.control.authority,
      });
      this.sendJson(res, 200, health);
      return;
    }
    if (method === 'GET' && path === '/action_status') {
      const id = url.searchParams.get('id');
      if (!id) {
        this.sendJson(res, 400, { error: '缺少 id 查询参数' });
        return;
      }
      const receipt = this.receipts.get(id);
      const status: GameBridgeActionStatus = GameBridgeActionStatusSchema.parse({
        actionId: id,
        running: this.inFlight?.actionId === id,
        ...(receipt ? { receipt } : {}),
      });
      this.sendJson(res, 200, status);
      return;
    }
    if (method === 'POST' && path === '/act') {
      const parsed = GameBridgeActionRequestSchema.safeParse(await this.readBody(req));
      if (!parsed.success) {
        this.sendJson(res, 400, GameBridgeActionAcceptedSchema.parse({ accepted: false, reason: 'INVALID_REQUEST' }));
        return;
      }
      const { actionId, tool, args } = parsed.data;
      this.sendJson(res, 200, this.acceptAction(actionId, tool, args));
      return;
    }
    if (method === 'POST' && path === '/cancel') {
      this.sendJson(res, 200, { cancelled: this.cancelInFlight() });
      return;
    }
    this.sendJson(res, 404, { error: `未知接口：${method} ${path}` });
  }

  private acceptAction(actionId: string, tool: string, args: Record<string, unknown>): GameBridgeActionAccepted {
    // 单飞互斥锁：在飞期间拒绝新动作（真模组 ActionController 同语义）
    if (this.inFlight) {
      return GameBridgeActionAcceptedSchema.parse({ accepted: false, reason: 'ACTION_IN_FLIGHT' });
    }
    // 玩家接管期间：受理但立即产出 ABORTED 回执（与真模组一致，不假装执行）
    if (this.state.control.isPlayerMovingPhysically) {
      this.storeReceipt(actionId, tool, this.now(), 'ABORTED_BY_HUMAN_TAKEOVER', 'PLAYER_PHYSICAL_INPUT_DETECTED');
      return GameBridgeActionAcceptedSchema.parse({ accepted: true, actionId });
    }
    const startedAt = this.now();
    const timer = setTimeout(() => {
      if (this.inFlight?.actionId !== actionId) return; // 已被中断/取消（超时≠失败：不覆盖既有回执）
      this.inFlight = null;
      const verdict = this.classify(tool, args);
      this.storeReceipt(actionId, tool, startedAt, verdict.status, verdict.reason);
    }, this.actionDelayMs);
    this.inFlight = { actionId, tool, startedAt, timer };
    return GameBridgeActionAcceptedSchema.parse({ accepted: true, actionId });
  }

  private cancelInFlight(): boolean {
    if (!this.inFlight) return false;
    clearTimeout(this.inFlight.timer);
    const { actionId, tool, startedAt } = this.inFlight;
    this.inFlight = null;
    // 取消后原动作是否部分执行不可判定 → UNCERTAIN（绝不静默记 FAILED）
    this.storeReceipt(actionId, tool, startedAt, 'UNCERTAIN', 'CANCELLED_BY_HOST');
    return true;
  }

  private interruptInFlight(status: GameBridgeReceiptStatus, reason: string): void {
    if (!this.inFlight) return;
    clearTimeout(this.inFlight.timer);
    const { actionId, tool, startedAt } = this.inFlight;
    this.inFlight = null;
    this.storeReceipt(actionId, tool, startedAt, status, reason);
  }

  private classify(tool: string, args: Record<string, unknown>): { status: GameBridgeReceiptStatus; reason?: string } {
    // ② 洞穴卡死：UNCERTAIN ×2 后转 FAILED（防死循环铁律）
    if (this.scenario === 'cave_stuck' && DIG_MOVE_TOOLS.has(tool)) {
      this.uncertainStreak += 1;
      if (this.uncertainStreak >= 3) {
        this.uncertainStreak = 0;
        return { status: 'FAILED', reason: 'PATH_BLOCKED_PERSISTENT' };
      }
      return { status: 'UNCERTAIN', reason: 'PATH_BLOCKED_BY_STONE' };
    }
    // ⑤ Boss 低血：只允许撤退/喝药
    if (this.scenario === 'boss_low_hp' && !RETREAT_TOOLS.has(tool)) {
      return { status: 'FAILED', reason: 'BOSS_LOW_HP_RETREAT' };
    }
    // ③ 岩浆：非逃生动作被生存反射打断（也可由 triggerSurvivalReflex 主动触发）
    if (this.scenario === 'lava_survival' && !RETREAT_TOOLS.has(tool)) {
      return { status: 'UNCERTAIN', reason: 'LAVA_ESCAPE_TRIGGERED' };
    }
    this.applyEffects(tool, args);
    return { status: 'COMPLETED' };
  }

  private applyEffects(tool: string, args: Record<string, unknown>): void {
    const p = this.state.player;
    const dx = typeof args.dx === 'number' ? args.dx : 0;
    const dy = typeof args.dy === 'number' ? args.dy : 0;
    let position = p.position;
    let hp = p.hp;
    if (tool === 'move_to' || tool === 'walk' || tool === 'flee') {
      const step = tool === 'flee' ? -3 : 1;
      position = { x: p.position.x + (dx || step), y: p.position.y + dy };
    } else if (tool === 'jump' || tool === 'grapple') {
      position = { x: p.position.x, y: p.position.y - 2 };
    } else if (tool === 'drink_potion' || tool === 'eat') {
      hp = Math.min(p.hpMax, p.hp + 85);
    }
    this.state = TerrariaStateSnapshotSchema.parse({
      ...this.state,
      capturedAt: this.now(),
      player: { ...p, hp, position },
      danger: tool === 'flee' || tool === 'jump'
        ? { ...this.state.danger, threatLevel: 'caution' }
        : this.state.danger,
    });
  }

  private storeReceipt(
    actionId: string,
    tool: string,
    startedAt: number,
    status: GameBridgeReceiptStatus,
    reason?: string,
  ): void {
    // 出站前必过契约（fail-fast 暴露契约漂移）
    const receipt: TerrariaActionReceipt = TerrariaActionReceiptSchema.parse({
      actionId,
      tool,
      gameId: 'terraria',
      status: GameBridgeReceiptStatusSchema.parse(status),
      ...(reason ? { reason } : {}),
      startedAt,
      completedAt: this.now(),
      snapshot: TerrariaStateSnapshotSchema.parse(this.state),
    });
    this.receipts.set(actionId, receipt);
  }
}

/** 测试客户端：所有响应过契约 Schema 校验后返回（fail-fast 暴露契约漂移） */
export interface TerrariaSimClient {
  state(): Promise<TerrariaStateSnapshot>;
  act(tool: string, args?: Record<string, unknown>, actionId?: string): Promise<GameBridgeActionAccepted>;
  status(actionId: string): Promise<GameBridgeActionStatus>;
  cancel(): Promise<{ cancelled: boolean }>;
  health(): Promise<GameBridgeHealth>;
}

export function createTerrariaSimClient(baseUrl: string, fetchImpl: typeof fetch = fetch): TerrariaSimClient {
  const json = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    return res.json() as Promise<unknown>;
  };
  const post = (path: string, body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    async state() {
      return TerrariaStateSnapshotSchema.parse(await json('/state'));
    },
    async act(tool, args = {}, actionId = randomUUID()) {
      return GameBridgeActionAcceptedSchema.parse(await json('/act', post('/act', { actionId, tool, args })));
    },
    async status(actionId) {
      return GameBridgeActionStatusSchema.parse(await json(`/action_status?id=${encodeURIComponent(actionId)}`));
    },
    async cancel() {
      const body = await json('/cancel', { method: 'POST' });
      if (body === null || typeof body !== 'object' || !('cancelled' in body)) throw new Error('cancel 响应缺少 cancelled 字段');
      return { cancelled: (body as { cancelled: boolean }).cancelled };
    },
    async health() {
      return GameBridgeHealthSchema.parse(await json('/health'));
    },
  };
}
