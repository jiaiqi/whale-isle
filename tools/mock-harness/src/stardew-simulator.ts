/**
 * [SIMULATION] stardew-mcp-simulator —— 《星露谷》SMAPI Mod 的确定性模拟服务端（T-M0-04）。
 *
 * 对齐 shared-protocol 的 StardewMcpActionReceipt 契约（所有回执出站前经 Schema 校验）。
 * 内置 5 个标准剧本（BWF 离线测试纪律）：
 *   ① normal_farming    正常种地浇水（体力结算）
 *   ② path_blocked      寻路卡石头 → UNCERTAIN，重复 ≥2 次 → FAILED（防死循环，呼应 dsh-douyin-agent「连续无效决策停止」）
 *   ③ stamina_exhausted 体力耗尽 → FAILED，go_to_sleep 过夜恢复
 *   ④ player_takeover   玩家物理输入 → 在飞动作立即 ABORTED_BY_HUMAN_TAKEOVER（<100ms）
 *   ⑤ mine_low_hp       矿洞丝血 → 撤退规则，进食回血
 * 互斥：同一时刻仅允许一个在飞动作（并发请求返回 JSON-RPC 错误）。
 */
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { z } from 'zod';
import { StardewMcpActionReceiptSchema } from '@workbench/shared-protocol';

export type StardewReceipt = z.infer<typeof StardewMcpActionReceiptSchema>;

export type ScenarioId =
  | 'normal_farming'
  | 'path_blocked'
  | 'stamina_exhausted'
  | 'player_takeover'
  | 'mine_low_hp';

interface GameState {
  dayOfMonth: number;
  season: 'spring' | 'summer' | 'fall' | 'winter';
  timeOfDay: number;
  staminaCurrent: number;
  staminaMax: number;
  healthCurrent: number;
  gold: number;
  locationName: string;
  isPlayerMovingPhysically: boolean;
}

interface ScenarioPreset {
  state: GameState;
  blockedTiles: Array<{ x: number; y: number }>;
}

const PRESETS: Record<ScenarioId, ScenarioPreset> = {
  normal_farming: {
    state: { dayOfMonth: 3, season: 'spring', timeOfDay: 800, staminaCurrent: 200, staminaMax: 270, healthCurrent: 100, gold: 500, locationName: 'Farm', isPlayerMovingPhysically: false },
    blockedTiles: [],
  },
  path_blocked: {
    state: { dayOfMonth: 3, season: 'spring', timeOfDay: 800, staminaCurrent: 200, staminaMax: 270, healthCurrent: 100, gold: 500, locationName: 'Farm', isPlayerMovingPhysically: false },
    blockedTiles: [{ x: 64, y: 15 }],
  },
  stamina_exhausted: {
    state: { dayOfMonth: 3, season: 'spring', timeOfDay: 2200, staminaCurrent: 0, staminaMax: 270, healthCurrent: 100, gold: 500, locationName: 'Farm', isPlayerMovingPhysically: false },
    blockedTiles: [],
  },
  player_takeover: {
    state: { dayOfMonth: 3, season: 'spring', timeOfDay: 800, staminaCurrent: 200, staminaMax: 270, healthCurrent: 100, gold: 500, locationName: 'Farm', isPlayerMovingPhysically: false },
    blockedTiles: [],
  },
  mine_low_hp: {
    state: { dayOfMonth: 3, season: 'spring', timeOfDay: 1300, staminaCurrent: 180, staminaMax: 270, healthCurrent: 15, gold: 500, locationName: 'Mines', isPlayerMovingPhysically: false },
    blockedTiles: [],
  },
};

/** 需要消耗体力的动作 → 结算表（与游戏原生体力消耗语义一致，见 BWF） */
const STAMINA_COST: Record<string, number> = {
  move_to_tile: 5,
  use_tool_on_tile: 10,
  water_crops_batch: 20,
  interact_with_npc: 0,
  check_trash_can: 0,
  eat_food_for_stamina: 0,
  go_to_sleep: 0,
};

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

export class StardewMcpSimulator {
  private wss: WebSocketServer | null = null;
  private state: GameState;
  private blockedTiles: Array<{ x: number; y: number }>;
  private readonly scenario: ScenarioId;
  private pendingResolve: ((receipt: StardewReceipt) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private uncertainStreak = 0;
  /** 正常动作的模拟结算延迟（ms）：默认 5ms；接管剧本可拉大以确定性命中"在飞中止"路径 */
  private readonly actionDelayMs: number;

  constructor(scenario: ScenarioId, options?: { actionDelayMs?: number }) {
    this.scenario = scenario;
    this.actionDelayMs = options?.actionDelayMs ?? 5;
    const preset = PRESETS[scenario];
    this.state = { ...preset.state };
    this.blockedTiles = preset.blockedTiles.map((tile) => ({ ...tile }));
  }

  /** 启动模拟服务端（ephemeral 端口，只监听本机） */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
        const address = this.wss?.address();
        if (address && typeof address === 'object') {
          resolve(`ws://127.0.0.1:${address.port}/mcp`);
        } else {
          // port=0 的 TCP server listen 成功后 address 必为对象（防御式兜底）
          /* v8 ignore next */
          reject(new Error('无法获取模拟器监听地址'));
        }
      });
      this.wss.on('connection', (socket) => this.handleConnection(socket));
      this.wss.on('error', reject);
    });
  }

  close(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.wss?.close();
    this.wss = null;
  }

  /** 玩家物理键鼠输入开关（剧本 ④ 的触发器；0.1s 接管铁律：立即中止在飞动作） */
  setPhysicalInput(moving: boolean): void {
    this.state.isPlayerMovingPhysically = moving;
    if (moving && this.pendingResolve) {
      // pendingTimer 与 pendingResolve 同生命周期，null 分支不可达（防御式 clearTimeout）
      /* v8 ignore next */
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(this.buildReceipt('move_to_tile', 'ABORTED_BY_HUMAN_TAKEOVER', 'PLAYER_PHYSICAL_INPUT_DETECTED'));
    }
  }

  private handleConnection(socket: WebSocket): void {
    socket.on('message', (data: unknown) => {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(String(data)) as JsonRpcRequest;
      } catch {
        socket.send(JSON.stringify(jsonRpcError(null, -32700, 'JSON 解析失败')));
        return;
      }
      if (req.method === 'stardew/act') {
        this.handleAct(req, socket);
        return;
      }
      if (req.method === 'stardew/state') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ...this.state } }));
        return;
      }
      socket.send(JSON.stringify(jsonRpcError(req.id, -32601, `未知方法：${req.method}`)));
    });
  }

  private handleAct(req: JsonRpcRequest, socket: WebSocket): void {
    const toolName = String(req.params?.toolName ?? '');
    if (!toolName) {
      socket.send(JSON.stringify(jsonRpcError(req.id, -32602, '缺少 toolName')));
      return;
    }
    // 动作互斥锁（真实 SMAPI Mod 同样只允许单动作在飞）
    if (this.pendingResolve) {
      socket.send(JSON.stringify(jsonRpcError(req.id, -32000, 'ACTION_IN_FLIGHT')));
      return;
    }

    // ④ 玩家接管：后续动作全部拒绝
    if (this.state.isPlayerMovingPhysically) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: this.buildReceipt(toolName as StardewReceipt['toolName'], 'ABORTED_BY_HUMAN_TAKEOVER', 'PLAYER_PHYSICAL_INPUT_DETECTED') }));
      return;
    }

    // ⑤ 矿洞丝血撤退规则（进食除外）
    if (this.state.locationName === 'Mines' && this.state.healthCurrent < 30 && toolName !== 'eat_food_for_stamina') {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: this.buildReceipt(toolName as StardewReceipt['toolName'], 'FAILED', 'HEALTH_CRITICAL_WITHDRAW') }));
      return;
    }
    if (toolName === 'eat_food_for_stamina') {
      this.state.healthCurrent = Math.min(100, this.state.healthCurrent + 85);
      this.state.staminaCurrent = Math.min(this.state.staminaMax, this.state.staminaCurrent + 80);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: this.buildReceipt('eat_food_for_stamina', 'COMPLETED') }));
      return;
    }

    // ③ 体力耗尽
    if (this.state.staminaCurrent <= 0 && (STAMINA_COST[toolName] ?? 0) > 0) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: this.buildReceipt(toolName as StardewReceipt['toolName'], 'FAILED', 'STAMINA_EXHAUSTED') }));
      return;
    }

    // ① 过夜：新一天 + 体力回满
    if (toolName === 'go_to_sleep') {
      this.state.dayOfMonth += 1;
      this.state.timeOfDay = 600;
      this.state.staminaCurrent = this.state.staminaMax;
      this.state.locationName = 'Farm';
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: this.buildReceipt('go_to_sleep', 'COMPLETED') }));
      return;
    }

    // ② 寻路卡石头：UNCERTAIN 两次后转 FAILED（防死循环）
    const blocked = this.blockedTiles.some(
      (tile) => toolName === 'move_to_tile' && tile.x === req.params?.x && tile.y === req.params?.y,
    );
    if (blocked) {
      this.uncertainStreak += 1;
      // 前两次返回 UNCERTAIN（上层重试），第三次直接 FAILED——防死循环铁律
      if (this.uncertainStreak >= 3) {
        this.uncertainStreak = 0;
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: this.buildReceipt('move_to_tile', 'FAILED', 'PATH_BLOCKED_PERSISTENT') }));
        return;
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: this.buildReceipt('move_to_tile', 'UNCERTAIN', 'PATH_BLOCKED_BY_STONE') }));
      return;
    }

    // ① 正常执行：模拟 SMAPI 异步结算，体力结算与游戏原生一致
    this.state.staminaCurrent = Math.max(0, this.state.staminaCurrent - (STAMINA_COST[toolName] ?? 0));
    const tool = toolName as StardewReceipt['toolName'];
    this.pendingResolve = (receipt) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: receipt }));
    };
    this.pendingTimer = setTimeout(() => {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingTimer = null;
      resolve?.(this.buildReceipt(tool, 'COMPLETED'));
    }, this.actionDelayMs);
  }

  private buildReceipt(toolName: StardewReceipt['toolName'], status: StardewReceipt['status'], reason?: string): StardewReceipt {
    // 出站前必须过契约（客户端拿到的就是被 Schema 验证过的形状）
    return StardewMcpActionReceiptSchema.parse({
      actionId: randomUUID(),
      toolName,
      status,
      failureOrUncertainReason: reason,
      gameStateSnapshot: { ...this.state },
    }) as StardewReceipt;
  }
}

export interface SimulatorClient {
  act(toolName: StardewReceipt['toolName'], args?: Record<string, unknown>): Promise<StardewReceipt>;
  raw(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** 测试客户端：所有回执经契约 Schema 校验后返回（fail-fast 暴露契约漂移） */
export function createSimulatorClient(url: string): SimulatorClient {
  const socket = new WebSocket(url);
  const ready = new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', (err: Error) => reject(err));
  });
  let nextId = 1;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  socket.on('message', (data: unknown) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>;
    const id = Number(msg.id);
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry(msg);
  });
  return {
    async act(toolName, args) {
      const id = nextId++;
      await ready;
      const response = await new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'stardew/act', params: { toolName, ...args } }));
      });
      if (response.error) {
        throw new Error(`JSON-RPC error: ${JSON.stringify(response.error)}`);
      }
      return StardewMcpActionReceiptSchema.parse(response.result) as StardewReceipt;
    },
    async raw(payload) {
      const id = nextId++;
      await ready;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ ...payload, id, jsonrpc: '2.0' }));
      });
    },
    close() {
      socket.close();
    },
  };
}
