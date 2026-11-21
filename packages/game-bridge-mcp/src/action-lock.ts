/**
 * 动作互斥锁 + 看门狗（T-M5-02）：同一时刻仅一个游戏动作在途。
 * 「没反应查原因」三律：
 *   1. 超时 ≠ 失败 —— 记录为 timeout，由编排器用 get_state 复核，绝不自动重发
 *   2. 卡死哨兵 —— 游戏内时间（get_state 文本）超过 staleLimit 无变化 → 触发 cancel_action 兜底
 *   3. 回执唯一事实 —— COMPLETED/FAILED/UNCERTAIN 以 BWF 文本回执为准
 */
import { actionTimeoutMs, BwfMcpClient, type McpCallResult } from './mcp-client';

export interface InFlightAction {
  tool: string;
  args: Record<string, unknown>;
  startedAt: number;
}

export interface LockStats {
  taken: number;
  released: number;
  timeouts: number;
  errors: number;
}

export class ActionLock {
  private current: InFlightAction | null = null;
  readonly stats: LockStats = { taken: 0, released: 0, timeouts: 0, errors: 0 };

  constructor(private readonly client: BwfMcpClient) {}

  get inFlight(): InFlightAction | null {
    return this.current;
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  /** 抢锁执行（含互斥与分层超时）。busy 时直接拒绝（P0 抢占语义由编排器显式 cancel 处理）。 */
  async execute(tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<McpCallResult & { tool: string }> {
    if (this.current) {
      return { kind: 'error', message: `动作互斥：${this.current.tool} 在途（${Math.round((Date.now() - this.current.startedAt) / 1000)}s）` , tool };
    }
    this.current = { tool, args, startedAt: Date.now() };
    this.stats.taken++;
    const effective = timeoutMs ?? actionTimeoutMs(tool);
    try {
      const result = await this.client.callTool(tool, args, { timeoutMs: effective });
      if (result.kind === 'timeout') this.stats.timeouts++;
      if (result.kind === 'error') this.stats.errors++;
      return { ...result, tool };
    } finally {
      this.current = null;
      this.stats.released++;
    }
  }

  /** 显式中止（P0 插队 / 看门狗兜底）：cancel_action 后清锁（execute 的 finally 也会清，双保险幂等）。
   *  返回值只表示「cancel_action 工具调用本身是否成功」——锁一定被清（callTool 失败/超时也算清）。 */
  async cancel(reason: string, timeoutMs = 15_000): Promise<boolean> {
    if (!this.current) return false;
    const res = await this.client.callTool('cancel_action', {}, { timeoutMs });
    this.current = null;
    this.stats.released++;
    void reason;
    return res.kind === 'ok' && !res.isError;
  }
}

/** 卡死哨兵：比较两次 get_state 摘要中的游戏时间，超过 staleLimitMs 未变化视为卡死。 */
export class StuckSentinel {
  private lastGameTime: string | null = null;
  private lastChangeAt = Date.now();

  constructor(
    private readonly staleLimitMs: number = 4 * 60_000, // ARCHITECTURE：4min 游戏时间不动
    private readonly now: () => number = Date.now,
  ) {}

  /** 从 get_state 文本提取「时间：第x年春x日 HH:MM」摘要；变化则刷新计时 */
  observe(stateText: string): { stale: boolean; staleMs: number } {
    const m = /时间：第\d+年[春夏秋冬]\d+日 \d{2}:\d{2}/.exec(stateText);
    const time = m?.[0] ?? null;
    if (time !== null && time !== this.lastGameTime) {
      this.lastGameTime = time;
      this.lastChangeAt = this.now();
    }
    const staleMs = this.now() - this.lastChangeAt;
    return { stale: staleMs > this.staleLimitMs, staleMs };
  }
}
