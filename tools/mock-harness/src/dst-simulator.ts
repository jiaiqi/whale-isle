/**
 * [SIMULATION] dst-simulator —— 《饥荒联机版》(DST) 桥接面的确定性 HTTP 仿真服务端（T-M7-D1）。
 *
 * 对齐 shared-protocol 的统一桥接协议（sidecar 宿主面同协议）：
 *   GET  /state                       → DstStateSnapshot
 *   POST /act       {actionId,tool,args} → GameBridgeActionAccepted
 *   GET  /action_status?id=<uuid>     → GameBridgeActionStatus
 *   POST /cancel                      → { cancelled: boolean }
 *   GET  /health                      → GameBridgeHealth
 * 游戏面 POST /v1/tick 由 sidecar 实现（本仿真只模拟宿主面）。
 *
 * 5 个确定性剧本（全部出站回执过 DstActionReceiptSchema.parse）：
 *   ① normal_gather      正常采集：gather/pickup/eat/move_to 全部 COMPLETED，背包/饥饿变化
 *   ② night_hound_crisis 夜幕猎犬：attack 清威胁；sleep/gather 被威胁拒绝；move_to 撤退
 *   ③ stuck_sentinel     卡死哨兵：时钟冻结 + work UNCERTAIN×2→FAILED；move_to 永久在飞（超时≠失败）
 *   ④ console_takeover   控制台接管：在飞动作同步中止 <100ms，后续动作拒绝，交还后恢复
 *   ⑤ dusk_refuel        黄昏回火堆：火堆燃料低，add_fuel/place_campfire 补燃料恢复 sanity
 *
 * 外部参考视为数据：机制思想来自 fruitstarzero/Don-t-Starve-Together-AI-Companion（MIT）
 * 与 Klei 官方 653007 localhost QueryServer 通道；本文件为原创实现，不复制任何仓库源码。
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DstActionReceiptSchema,
  DstStateSnapshotSchema,
  GameBridgeActionAcceptedSchema,
  GameBridgeActionStatusSchema,
  GameBridgeHealthSchema,
  GameBridgeActionRequestSchema,
  type DstActionReceipt,
  type DstStateSnapshot,
  type GameBridgeActionRequest,
  type GameBridgeActionStatus,
  type GameBridgeReceiptStatus,
} from '@workbench/shared-protocol';

export type DstScenarioId =
  | 'normal_gather'
  | 'night_hound_crisis'
  | 'stuck_sentinel'
  | 'console_takeover'
  | 'dusk_refuel';

export interface DstSimulatorOptions {
  /** 普通动作结算延迟（ms，默认 5）；接管剧本建议 200 以确定性命中"在飞中止" */
  actionDelayMs?: number;
}

interface InFlight {
  actionId: string;
  tool: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const SUPPORTED_TOOLS = new Set([
  'move_to', 'gather', 'pickup', 'work', 'attack', 'eat', 'craft', 'cook',
  'place_campfire', 'add_fuel', 'equip', 'sleep', 'follow', 'cancel_action',
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeSnapshot(patch: {
  cycle: number;
  phase: 'day' | 'dusk' | 'night';
  phaseProgress: number;
  season?: 'spring' | 'summer' | 'autumn' | 'winter';
  health?: number;
  hunger?: number;
  sanity?: number;
  inventory?: DstStateSnapshot['player']['inventory'];
  entities?: DstStateSnapshot['nearby']['entities'];
  campfires?: DstStateSnapshot['nearby']['campfires'];
  threats?: DstStateSnapshot['threats'];
}): DstStateSnapshot {
  return DstStateSnapshotSchema.parse({
    schemaVersion: 1,
    capturedAt: 1_700_000_000_000,
    clock: {
      cycle: patch.cycle,
      phase: patch.phase,
      phaseProgress: patch.phaseProgress,
      season: patch.season ?? 'autumn',
      isRaining: false,
    },
    player: {
      character: 'wilson',
      health: { current: patch.health ?? 150, max: 150 },
      hunger: { current: patch.hunger ?? 100, max: 100 },
      sanity: { current: patch.sanity ?? 150, max: 150 },
      temperature: 18,
      moisture: 0,
      position: { x: 12, z: -8 },
      inventory: patch.inventory ?? [],
    },
    nearby: { entities: patch.entities ?? [], campfires: patch.campfires ?? [] },
    threats: patch.threats ?? [],
    control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
  });
}

function preset(scenario: DstScenarioId): DstStateSnapshot {
  switch (scenario) {
    case 'normal_gather':
      return makeSnapshot({
        cycle: 3, phase: 'day', phaseProgress: 0.2, hunger: 60,
        entities: [
          { prefab: 'berrybush', displayName: '浆果丛', position: { x: 14, z: -8 }, distance: 2, isHostile: false, isResource: true },
          { prefab: 'tree', displayName: '树', position: { x: 18, z: -6 }, distance: 6, isHostile: false, isResource: true },
        ],
      });
    case 'night_hound_crisis':
      return makeSnapshot({
        cycle: 5, phase: 'night', phaseProgress: 0.7, hunger: 40, sanity: 35,
        threats: [{ kind: 'hound', count: 3, directionText: '西北' }],
        entities: [{ prefab: 'hound', displayName: '猎犬', position: { x: 6, z: -4 }, distance: 7, isHostile: true, isResource: false }],
      });
    case 'stuck_sentinel':
      return makeSnapshot({
        cycle: 7, phase: 'dusk', phaseProgress: 0.42,
        entities: [{ prefab: 'rock', displayName: '岩石', position: { x: 13, z: -7 }, distance: 1, isHostile: false, isResource: true }],
      });
    case 'console_takeover':
      return makeSnapshot({ cycle: 4, phase: 'day', phaseProgress: 0.3 });
    case 'dusk_refuel':
      return makeSnapshot({
        cycle: 6, phase: 'dusk', phaseProgress: 0.8, sanity: 30,
        campfires: [{ position: { x: 11, z: -9 }, fuelPercent: 0.12 }],
        entities: [{ prefab: 'flower', displayName: '花', position: { x: 15, z: -8 }, distance: 3, isHostile: false, isResource: true }],
      });
  }
}

interface Effect {
  status: GameBridgeReceiptStatus;
  reason?: string;
}

export class DstSimulator {
  private readonly server: Server;
  private readonly scenario: DstScenarioId;
  private readonly actionDelayMs: number;
  private state: DstStateSnapshot;
  private inFlight: InFlight | null = null;
  private readonly receipts = new Map<string, DstActionReceipt>();
  private uncertainStreak = 0;
  private takeover = false;

  constructor(scenario: DstScenarioId, options: DstSimulatorOptions = {}) {
    this.scenario = scenario;
    this.actionDelayMs = options.actionDelayMs ?? 5;
    this.state = preset(scenario);
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((error: unknown) => {
        this.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  /** 启动 ephemeral 端口（只监听 127.0.0.1），返回宿主面 base URL */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (address && typeof address === 'object') resolve(`http://127.0.0.1:${address.port}`);
        else reject(new Error('无法获取 DST 模拟器监听地址'));
      });
    });
  }

  close(): void {
    if (this.inFlight?.timer) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.server.close();
  }

  /** 剧本 ④：控制台接管开关。active=true 时同步中止在飞动作（不经过事件循环延迟） */
  setConsoleTakeover(active: boolean): void {
    this.takeover = active;
    if (active && this.inFlight) this.finish('ABORTED_BY_HUMAN_TAKEOVER', 'CONSOLE_TAKEOVER_DETECTED');
  }

  /** 剧本 ③：推进游戏时钟（卡死哨兵观察到变化即解除 stale） */
  advanceClock(): void {
    this.state = clone(this.state);
    this.state.clock.phaseProgress = 0.9;
    this.state.clock.cycle += 1;
  }

  private authority(): DstStateSnapshot['control']['authority'] {
    return this.takeover ? 'HUMAN_TAKEOVER_ACTIVE' : 'AI_AUTOPILOT';
  }

  private currentSnapshot(): DstStateSnapshot {
    const snapshot = clone(this.state);
    snapshot.capturedAt = Date.now();
    snapshot.control.authority = this.authority();
    snapshot.control.isPlayerMovingPhysically = this.takeover;
    return DstStateSnapshotSchema.parse(snapshot);
  }

  private buildReceipt(
    actionId: string,
    tool: string,
    status: GameBridgeReceiptStatus,
    reason?: string,
    startedAt = Date.now(),
  ): DstActionReceipt {
    return DstActionReceiptSchema.parse({
      actionId,
      tool,
      gameId: 'dst',
      status,
      reason,
      startedAt,
      completedAt: Date.now(),
      snapshot: this.currentSnapshot(),
    });
  }

  /** 结束在飞动作：清 timer、落回执（唯一事实源），同步返回给 status 轮询 */
  private finish(status: GameBridgeReceiptStatus, reason?: string, effect?: () => void): void {
    const active = this.inFlight;
    if (!active) return;
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    this.inFlight = null;
    effect?.();
    this.receipts.set(active.actionId, this.buildReceipt(active.actionId, active.tool, status, reason, active.startedAt));
  }

  private shouldStall(tool: string, args: Record<string, unknown>): boolean {
    // ③ move_to 到卡死点永久在飞：客户端超时也不能把它当 FAILED（唯一事实源仍是 /action_status）
    return this.scenario === 'stuck_sentinel' && tool === 'move_to' && args.target === 'stuck-point';
  }

  private effectFor(tool: string, args: Record<string, unknown>): Effect {
    const state = this.state;
    switch (this.scenario) {
      case 'normal_gather': {
        if (tool === 'eat') {
          state.player.hunger.current = Math.min(state.player.hunger.max, state.player.hunger.current + 25);
          return { status: 'COMPLETED', reason: 'ATE_FOOD' };
        }
        if (tool === 'gather' || tool === 'pickup' || tool === 'work') {
          const name = String(args.item ?? (tool === 'gather' ? 'berries' : 'log'));
          const existing = state.player.inventory.find((it) => it.itemName === name);
          if (existing) existing.count += 1;
          else state.player.inventory.push({ itemName: name, count: 1, equipped: false });
          return { status: 'COMPLETED', reason: 'GATHERED' };
        }
        if (tool === 'move_to') {
          state.player.position = { x: Number(args.x ?? 12), z: Number(args.z ?? -8) };
          return { status: 'COMPLETED', reason: 'ARRIVED' };
        }
        return { status: 'COMPLETED' };
      }
      case 'night_hound_crisis': {
        if (tool === 'attack') return { status: 'COMPLETED', reason: 'HOUNDS_DEFEATED' };
        if (tool === 'move_to' && args.awayFrom === 'hound') return { status: 'COMPLETED', reason: 'ESCAPED_HOUNDS' };
        if (tool === 'sleep' || tool === 'gather' || tool === 'work') {
          return { status: 'FAILED', reason: 'HOUND_THREAT_ACTIVE' };
        }
        return { status: 'COMPLETED' };
      }
      case 'stuck_sentinel': {
        if (tool === 'work') {
          this.uncertainStreak += 1;
          return this.uncertainStreak >= 3
            ? { status: 'FAILED', reason: 'PATH_BLOCKED_PERSISTENT' }
            : { status: 'UNCERTAIN', reason: 'PATH_BLOCKED_BY_ROCK' };
        }
        if (tool === 'gather') {
          state.player.inventory.push({ itemName: 'berries', count: 1, equipped: false });
          return { status: 'COMPLETED', reason: 'GATHERED' };
        }
        return { status: 'COMPLETED' };
      }
      case 'console_takeover':
        return { status: 'COMPLETED', reason: 'TAKEOVER_RELEASED' };
      case 'dusk_refuel': {
        if (tool === 'add_fuel' || tool === 'place_campfire') {
          if (state.nearby.campfires.length === 0) {
            state.nearby.campfires.push({ position: { x: 11, z: -9 }, fuelPercent: 1 });
          } else {
            for (const fire of state.nearby.campfires) fire.fuelPercent = 1;
          }
          state.player.sanity.current = Math.min(state.player.sanity.max, state.player.sanity.current + 10);
          return { status: 'COMPLETED', reason: 'FIRE_REFUELED' };
        }
        if (tool === 'gather' && args.item === 'flower') {
          state.player.sanity.current = Math.min(state.player.sanity.max, state.player.sanity.current + 8);
          return { status: 'COMPLETED', reason: 'FLOWER_GATHERED' };
        }
        return { status: 'FAILED', reason: 'DUSK_FIRE_CRITICAL' };
      }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/state') {
      this.sendJson(res, 200, this.currentSnapshot());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      this.sendJson(res, 200, GameBridgeHealthSchema.parse({
        ok: true,
        gameId: 'dst',
        bridgeVersion: 'dst-sim-1.0',
        gameVersion: 'DST-SIMULATION',
        control: this.authority(),
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/action_status') {
      const actionId = url.searchParams.get('id') ?? '';
      const receipt = this.receipts.get(actionId);
      const running = this.inFlight?.actionId === actionId;
      // 通用 GameBridgeActionStatusSchema.parse 会把 gameId/snapshot 剥掉；
      // 这里对 receipt 用 DST 子类型校验后再组装，保证宿主收到完整回执。
      const status: GameBridgeActionStatus = {
        actionId,
        running,
        ...(receipt ? { receipt: DstActionReceiptSchema.parse(receipt) } : {}),
      };
      this.sendJson(res, 200, status);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/act') {
      const body = await this.readJson(req);
      const parsed = GameBridgeActionRequestSchema.safeParse(body);
      if (!parsed.success) {
        this.sendJson(res, 400, { error: 'INVALID_REQUEST', detail: parsed.error.message });
        return;
      }
      this.handleAct(parsed.data, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      const wasActive = this.inFlight !== null;
      this.finish('ABORTED_BY_HUMAN_TAKEOVER', 'CANCEL_REQUESTED');
      this.sendJson(res, 200, { cancelled: wasActive });
      return;
    }
    this.sendJson(res, 404, { error: 'NOT_FOUND', path: url.pathname });
  }

  private handleAct(request: GameBridgeActionRequest, res: ServerResponse): void {
    const { actionId, tool, args } = request;
    // 互斥：单飞动作未结算时拒绝（宿主面协议以 accepted=false + reason 表达，不抛 HTTP 错误）
    if (this.inFlight) {
      this.sendJson(res, 200, GameBridgeActionAcceptedSchema.parse({ accepted: false, actionId, reason: 'ACTION_IN_FLIGHT' }));
      return;
    }
    this.sendJson(res, 200, GameBridgeActionAcceptedSchema.parse({ accepted: true, actionId }));

    if (this.takeover) {
      this.receipts.set(actionId, this.buildReceipt(actionId, tool, 'ABORTED_BY_HUMAN_TAKEOVER', 'CONSOLE_TAKEOVER_ACTIVE'));
      return;
    }
    if (!SUPPORTED_TOOLS.has(tool)) {
      this.receipts.set(actionId, this.buildReceipt(actionId, tool, 'FAILED', 'UNKNOWN_TOOL'));
      return;
    }
    if (tool === 'cancel_action') {
      this.receipts.set(actionId, this.buildReceipt(actionId, tool, 'COMPLETED', 'NO_ACTION_TO_CANCEL'));
      return;
    }

    const active: InFlight = { actionId, tool, startedAt: Date.now(), timer: null };
    this.inFlight = active;
    if (this.shouldStall(tool, args)) return; // 永久在飞：模拟"超时≠失败"

    active.timer = setTimeout(() => {
      const effect = this.effectFor(tool, clone(args));
      // 威胁清除/时钟推进等副作用必须在生成快照前生效
      if (effect.status === 'COMPLETED' && tool === 'attack' && this.scenario === 'night_hound_crisis') {
        this.state = clone(this.state);
        this.state.threats = [];
        this.state.nearby.entities = this.state.nearby.entities.filter((e) => !e.isHostile);
      }
      this.finish(effect.status, effect.reason);
    }, this.actionDelayMs);
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new Error('JSON 解析失败'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }
}

export interface DstSimulatorClient {
  state(): Promise<DstStateSnapshot>;
  act(actionId: string, tool: string, args?: Record<string, unknown>): Promise<{ accepted: boolean; actionId?: string; reason?: string }>;
  status(actionId: string): Promise<{ actionId: string; running: boolean; receipt?: DstActionReceipt }>;
  cancel(): Promise<{ cancelled: boolean }>;
  health(): Promise<{ ok: boolean; gameId: string; control: string }>;
}

/** 测试客户端：所有回执/状态出站前经 shared-protocol Schema 校验（契约漂移立即 fail-fast） */
export function createDstSimulatorClient(baseUrl: string, fetchImpl: typeof fetch = fetch): DstSimulatorClient {
  const json = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
    return res.json() as Promise<unknown>;
  };
  return {
    async state() {
      return DstStateSnapshotSchema.parse(await json('/state'));
    },
    async act(actionId, tool, args = {}) {
      const res = await json('/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, tool, args }),
      });
      return GameBridgeActionAcceptedSchema.parse(res);
    },
    async status(actionId) {
      const raw = await json(`/action_status?id=${encodeURIComponent(actionId)}`) as {
        actionId: string; running: boolean; receipt?: unknown;
      };
      const status = GameBridgeActionStatusSchema.parse(raw);
      return {
        actionId: status.actionId,
        running: status.running,
        ...(raw.receipt === undefined ? {} : { receipt: DstActionReceiptSchema.parse(raw.receipt) }),
      };
    },
    async cancel() {
      const res = await json('/cancel', { method: 'POST' }) as { cancelled: boolean };
      return { cancelled: res.cancelled === true };
    },
    async health() {
      return GameBridgeHealthSchema.parse(await json('/health'));
    },
  };
}

/** 便捷：生成 UUID（测试与桥接客户端共用同一动作 id 形状） */
export function newActionId(): string {
  return randomUUID();
}
