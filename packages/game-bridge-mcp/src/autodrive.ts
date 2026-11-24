/**
 * autodrive 编排器（T-M5-02）：桌宠全自动自主玩游戏的主循环。
 * 流程：get_state → 卡死哨兵 → Planner 决策 → ActionLock 执行 → 回执事件 → 间步延迟。
 * 事件回调由宿主注入（总线广播 → Shell 聊天流/桌宠气泡/监控面板/OBS 同源多播，ADR）。
 *
 * T-M6-27（多游戏/多端点隔离）：Runner 持有单调递增的 sessionId；宿主在事件出站与
 * P0 指令入站时强制打上/校验 sessionId —— 渲染层只消费当前会话，迟到与异会话事件被忽略。
 * 指令在「在飞动作尚未结束时」到达属正常流程：cancel 是发向游戏侧的尽力中止请求，
 * execute 的 finally 清锁是兜底；指令绝不因锁忙而被丢弃。
 */
import { randomUUID } from 'node:crypto';
import { ActionLock, StuckSentinel } from './action-lock';
import { StardewAdapter, type GameAdapter, type GameBridgeTransport } from './adapter';
import { parseGameState, RulePlanner, type Planner, type PlannerDecision } from './planner';

export type AutodriveEvent =
  | { type: 'state'; clock: string; stamina: number; staminaMax: number; money: number; location: string; health?: number; healthMax?: number; freeSlots?: number }
  | { type: 'decision'; planner: string; tool: string; args: Record<string, unknown>; intent: string }
  | { type: 'receipt'; tool: string; status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR'; summary: string }
  | { type: 'watchdog'; kind: 'stuck' | 'heartbeat'; detail: string }
  | { type: 'cycle-end'; delayMs: number };

export interface AutodriveOptions {
  endpoint?: string;
  /** 死循环防护：单次 start() 内最大循环数（0/undefined = 无限——生产默认无限，测试设上限） */
  maxCycles?: number;
  /** 步间延迟（真实游戏节奏：BWF 动作耗时按游戏时间推进，间步不用太久） */
  stepDelayMs?: number;
  /** 出错重试延迟 */
  errorDelayMs?: number;
  /** 状态轮询间隔（get_state 保守 8s） */
  pollDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AutodriveRunner {
  /** 会话标识：宿主事件出站与 P0 指令入站都以它为归属键（T-M6-27） */
  readonly sessionId: string = randomUUID();
  private running = false;
  /** start() 重入锁：并发的两次 start（双击/外部+UI）只能启动一个循环 */
  private starting = false;
  private cycle = 0;
  private loopTask: Promise<void> | null = null;
  readonly client: GameBridgeTransport;
  readonly lock: ActionLock;
  readonly sentinel: StuckSentinel;
  readonly adapter: GameAdapter;
  private planner: Planner;
  private pendingDirective: { tool: string; args: Record<string, unknown>; intent: string } | null = null;
  private pendingObjective: string | null = null;
  /** 上一次 wait 的原因：相同原因的重复 wait 不再刷 watchdog/cycle-end（求助态防噪声） */
  private lastWaitReason: string | null = null;
  /** 上一次真正发往游戏的变更动作时间：BWF 120s 无动作会自暂停，需 keepalive。 */
  private lastMutationAt: number;
  /** 最近一次 watchdog/恢复尝试时间，防止冻结时每 2 秒重复调用 */
  private lastStaleRecoveryAt = 0;
  /** 全局防刷屏熔断：相同 (tool + FAILED summary) 且游戏时钟未推进的连续次数 */
  private stallSignature: string | null = null;
  private stallClock = '';
  private stallCount = 0;

  constructor(
    private readonly onEvent: (event: AutodriveEvent) => void,
    private readonly options: AutodriveOptions = {},
    /** 多游戏注入点：默认星露谷原样包装；泰拉瑞亚/DST 泳道传入自己的 GameAdapter */
    adapter?: GameAdapter,
  ) {
    this.adapter = adapter ?? new StardewAdapter(options.endpoint);
    this.client = this.adapter.transport;
    this.lock = new ActionLock(
      this.client,
      (tool) => this.adapter.isLongAction(tool) ? 10 * 60_000 : 30_000,
    );
    this.sentinel = new StuckSentinel(
      4 * 60_000,
      options.now ?? Date.now,
      (text) => this.adapter.extractClock(text),
    );
    this.planner = new RulePlanner();
    this.lastMutationAt = (options.now ?? Date.now)();
  }

  setPlanner(planner: Planner): void {
    this.planner = planner;
  }

  /** 人工/远程 P0 插队：下一次循环优先执行（不重发语义——插队的是新动作） */
  submitDirective(tool: string, args: Record<string, unknown>, intent: string): void {
    this.pendingDirective = { tool, args, intent };
  }

  /** 团队目标：不锁死具体工具，由当前 planner 在安全护栏内决定动作。 */
  submitObjective(objective: string, intent = objective): void {
    this.pendingObjective = objective.trim().slice(0, 300);
    this.onEvent({ type: 'decision', planner: 'team-objective', tool: 'wait', args: {}, intent: intent.trim().slice(0, 160) });
  }

  /**
   * 清空多步目标：新单步原子指令 / 用户「算了」/ 切换游戏时立即生效。
   * 同时清 pending（还没被循环消费的）与 planner 已生效的 objective，避免旧目标继续驱动。
   */
  clearObjective(): boolean {
    const had = this.pendingObjective !== null || (this.planner.hasObjective?.() ?? false);
    this.pendingObjective = null;
    this.planner.setObjective?.(null);
    return had;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      const alive = await this.adapter.ping();
      if (!alive) throw new Error(this.adapter.unreachableMessage);
      if (this.running) return; // ping 期间可能被另一路 start 抢先
      this.running = true;
      const task = this.loop();
      this.loopTask = task;
      void task.then(
        () => { if (this.loopTask === task) this.loopTask = null; },
        () => { if (this.loopTask === task) this.loopTask = null; },
      );
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.running = false;
  }

  /** 平滑停机：让当前动作回执闭合后退出循环，供游戏热切换串行化 */
  async stopAndWait(): Promise<void> {
    this.stop();
    await this.loopTask;
  }

  private async loop(): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    const clock = this.options.now ?? Date.now;
    const stepDelay = this.options.stepDelayMs ?? 3_000;
    const errorDelay = this.options.errorDelayMs ?? 8_000;
    while (this.running) {
      this.cycle++;
      if (this.options.maxCycles && this.cycle > this.options.maxCycles) {
        this.onEvent({ type: 'receipt', tool: 'autodrive', status: 'COMPLETED', summary: `达到 maxCycles=${this.options.maxCycles}，编排器自动停止（死循环防护）` });
        this.running = false;
        return;
      }
      try {
        // 1. get_state（状态唯一事实源）
        const stateRes = await this.client.callTool('get_state', {}, { timeoutMs: 25_000 });
        if (stateRes.kind !== 'ok') {
          // 错误详情必须透出（『没反应查原因』——不能只说没响应，要说为什么）
          const why = stateRes.kind === 'error' ? stateRes.message : `超时 ${Math.round(stateRes.timeoutMs / 1000)}s`;
          this.onEvent({ type: 'watchdog', kind: 'heartbeat', detail: `get_state ${stateRes.kind}：${why}` });
          await sleep(errorDelay);
          continue;
        }
        const state = this.adapter.parseState ? this.adapter.parseState(stateRes.text) : parseGameState(stateRes.text);
        if (state.gameClock === '未知') {
          // 状态文本不可解析（游戏未就绪/Mod 异常/版本漂移）——按 watchdog 处理而非盲跑
          this.onEvent({ type: 'watchdog', kind: 'heartbeat', detail: 'get_state 文本不可解析——游戏未就绪或 Mod 异常，稍后重查' });
          await sleep(errorDelay);
          continue;
        }
        this.onEvent({
          type: 'state',
          clock: state.gameClock,
          stamina: state.stamina,
          staminaMax: state.staminaMax,
          money: state.money,
          location: state.location,
          health: state.health,
          healthMax: state.healthMax,
          freeSlots: state.freeSlots,
        });

        // 1.5 BWF 防自暂停心跳：连续 90s 只有 get_state（或 planner 一直 wait）会被 BWF 判为
        // “120 秒没有动作”并暂停游戏；发一次游戏原生安全 wait，保持时钟推进。
        if (!this.lock.isBusy() && this.adapter.keepaliveAction !== undefined && clock() - this.lastMutationAt >= 90_000) {
          this.lastMutationAt = clock();
          const keepalive = this.adapter.keepaliveAction;
          this.onEvent({ type: 'watchdog', kind: 'heartbeat', detail: '90s 无变更动作 → 发送游戏 keepalive，防止 BWF 120s 自暂停' });
          const keepaliveResult = await this.lock.execute(keepalive.tool, keepalive.args, 60_000);
          const keepaliveReceipt = this.adapter.classifyReceipt({
            text: keepaliveResult.kind === 'ok' ? keepaliveResult.text : '',
            kind: keepaliveResult.kind,
            isError: keepaliveResult.kind === 'ok' && keepaliveResult.isError,
            tool: keepalive.tool,
            errorMessage: keepaliveResult.kind === 'error' ? keepaliveResult.message : undefined,
          });
          this.onEvent({ type: 'receipt', tool: keepalive.tool, status: keepaliveReceipt.status, summary: keepaliveReceipt.summary });
          this.sentinel.reset();
          continue;
        }

        // 2. 卡死哨兵：时钟冻结多因 BWF 自暂停/菜单；先发真实 cancel（无在途也发），
        // 再用最小游戏动作唤醒；只有恢复动作也失败才交回 planner，绝不再空喊 watchdog。
        const stuck = this.sentinel.observe(stateRes.text);
        if (stuck.stale) {
          const elapsed = clock() - this.lastStaleRecoveryAt;
          if (elapsed < 30_000) {
            await sleep(3_000);
            continue;
          }
          this.lastStaleRecoveryAt = clock();
          this.onEvent({ type: 'watchdog', kind: 'stuck', detail: `游戏时间 ${Math.round(stuck.staleMs / 1000)}s 无变化 → 尝试 cancel + 游戏动作唤醒` });
          await this.lock.cancel('stuck-sentinel');
          const recovery = this.adapter.staleRecoveryAction ?? this.adapter.keepaliveAction;
          let recovered = false;
          if (recovery !== undefined) {
            const result = await this.lock.execute(recovery.tool, recovery.args, 60_000);
            const receipt = this.adapter.classifyReceipt({
              text: result.kind === 'ok' ? result.text : '',
              kind: result.kind,
              isError: result.kind === 'ok' && result.isError,
              tool: recovery.tool,
              errorMessage: result.kind === 'error' ? result.message : undefined,
            });
            recovered = receipt.status === 'COMPLETED';
            this.onEvent({ type: 'receipt', tool: recovery.tool, status: receipt.status, summary: `卡死恢复（${recovery.tool}）：${receipt.summary}` });
          }
          this.lastMutationAt = clock();
          this.sentinel.reset();
          if (recovered) {
            await sleep(1_000);
            continue;
          }
          this.onEvent({ type: 'watchdog', kind: 'stuck', detail: '游戏动作恢复失败 → 交还 planner 决策，30s 后再重试恢复' });
          // 不 continue：让 planner 尝试其他能解除暂停的动作（如 travel_to/节日）。
        }

        // 3. 决策（P0 插队 > Planner）；团队目标只注入 planner 上下文，不直接变成工具调用
        if (this.pendingObjective !== null) {
          this.planner.setObjective?.(this.pendingObjective);
          this.pendingObjective = null;
        }
        let decision: PlannerDecision;
        let fromDirective = false;
        if (this.pendingDirective) {
          const d = this.pendingDirective;
          this.pendingDirective = null;
          decision = { kind: 'act', ...d };
          fromDirective = true;
        } else {
          decision = await this.planner.decide(state);
        }

        // 4. 执行
        if (decision.kind === 'wait') {
          // wait 必须可见，但相同原因的求助态只报一次：避免每 10s 刷一条 watchdog
          if (decision.reason !== this.lastWaitReason) {
            this.onEvent({ type: 'watchdog', kind: 'stuck', detail: decision.reason });
            this.onEvent({ type: 'cycle-end', delayMs: decision.seconds * 1000 });
            this.lastWaitReason = decision.reason;
          }
          await sleep(Math.min(decision.seconds, 10) * 1000);
          continue;
        }
        this.lastWaitReason = null;
        if (decision.kind === 'stop') {
          this.onEvent({ type: 'receipt', tool: 'autodrive', status: 'COMPLETED', summary: decision.reason });
          this.running = false;
          return;
        }

        this.onEvent({ type: 'decision', planner: fromDirective ? 'remote' : this.planner.name, tool: decision.tool, args: decision.args, intent: decision.intent });
        const result = await this.lock.execute(decision.tool, decision.args);
        this.lastMutationAt = clock();
        const receipt = this.adapter.classifyReceipt({
          text: result.kind === 'ok' ? result.text : '',
          kind: result.kind,
          isError: result.kind === 'ok' && result.isError,
          tool: decision.tool,
          errorMessage: result.kind === 'error' ? result.message : undefined,
        });
        // 回执反馈给规划器（规则兜底据此升级救援阶梯，避免满包死循环）
        this.planner.observeReceipt?.(decision.tool, receipt.status, receipt.summary);
        this.onEvent({ type: 'receipt', tool: decision.tool, status: receipt.status, summary: receipt.summary });

        // 全局防刷屏熔断（2026-11-24 真机）：同一 (tool + FAILED summary) 连续 ≥3 次且游戏时钟
        // 未推进 → 暂停 30s 并告警。这是任何规划器/兜底都失效时的最后一道网，绝不让事件流无限刷屏。
        if (receipt.status === 'FAILED') {
          const signature = `${decision.tool}|${receipt.summary}`;
          if (signature === this.stallSignature && state.gameClock === this.stallClock) {
            this.stallCount++;
          } else {
            this.stallSignature = signature;
            this.stallClock = state.gameClock;
            this.stallCount = 1;
          }
          if (this.stallCount >= 3) {
            this.onEvent({
              type: 'watchdog',
              kind: 'stuck',
              detail: `同一动作连续失败 ${this.stallCount} 次且游戏时间未推进：${decision.tool}（${receipt.summary.slice(0, 80)}）→ 暂停 30s，请主人检查是否缺工具/卡菜单`,
            });
            this.onEvent({ type: 'cycle-end', delayMs: 30_000 });
            this.stallCount = 0;
            this.stallSignature = null;
            await sleep(30_000);
            continue;
          }
        } else {
          this.stallCount = 0;
          this.stallSignature = null;
        }

        // 5. 间步延迟（长动作回执后稍等游戏结算）
        await sleep(receipt.status === 'TIMEOUT' ? 15_000 : stepDelay);
      } catch (error) {
        this.onEvent({ type: 'receipt', tool: 'autodrive', status: 'ERROR', summary: error instanceof Error ? error.message : String(error) });
        await sleep(errorDelay);
      }
    }
  }
}
