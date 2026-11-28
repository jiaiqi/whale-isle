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
import type { BrainMode } from './brain-switch';
import { GameCharacterControlLease, type GameCharacterControlLeaseState } from './control-lease';
import type { DayPlanItem } from './day-plan';
import type { ChatStanceEmission, PlanEmission } from './llm-planner';
import { parseGameState, RulePlanner, type Planner, type PlannerDecision } from './planner';
import { BwfStateSectionCache } from './state-cache';

interface AutonomousPlannerHooks {
  bindCallbacks?(callbacks: {
    onPlan?: (event: PlanEmission) => void;
    onBrainChange?: (mode: BrainMode, reason: string) => void;
    onChatStance?: (event: ChatStanceEmission) => void;
  }): void;
  submitSuggestion?(text: string): void;
  submitCommand?(command: string): void;
  cancelCommand?(): string | null;
  setHandoverSummary?(summary: string | null): void;
}

export type AutodriveEvent =
  | { type: 'state'; clock: string; stamina: number; staminaMax: number; money: number; location: string; health?: number; healthMax?: number; freeSlots?: number }
  | { type: 'decision'; planner: string; tool: string; args: Record<string, unknown>; intent: string }
  | { type: 'receipt'; tool: string; status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR'; summary: string }
  | { type: 'watchdog'; kind: 'stuck' | 'heartbeat'; detail: string }
  /** 多步目标生命周期（T-M6-57）：set/replaced/cancel/done，供 UI 目标条与徽标使用 */
  | { type: 'objective'; objective: string | null; reason: 'set' | 'replaced' | 'cancel' | 'done' }
  /** 当日自拟计划与步中修订（T-M6-70） */
  | { type: 'plan'; dayKey: string; plan: DayPlanItem[]; mood?: string; updateWhy?: string; history?: PlanEmission['history']; reason: 'morning' | 'update' }
  /** 大脑开/关/临时代驾状态切换（T-M6-70） */
  | { type: 'brain'; mode: BrainMode; reason: string }
  /** 主人建议/强制命令的 AI 表态（T-M6-70：用于聊天气泡与采纳率统计） */
  | { type: 'chat-stance'; kind: 'suggestion' | 'command'; text: string; stance: ChatStanceEmission['stance']; reply: string; reason?: string; alternative?: string }
  /** 主人临时接管（T-M6-73）：active=true 进入静默只读态；false 交还并带回归摘要 */
  | { type: 'human-control'; active: boolean; reason: 'switch' | 'in-game' | 'resume'; summary?: string }
  | { type: 'cycle-end'; delayMs: number };

/** 接管期间用于对比的游戏状态快照（只读） */
export interface HumanSessionSnapshot {
  clock: string;
  money: number;
  location: string;
  stamina: number;
  staminaMax: number;
}

/**
 * 交还时的人话摘要（T-M6-73）：主人接管这段时间游戏发生了什么，交给宿主写进聊天流。
 * 纯函数，便于单测；任一快照缺失时如实说明「没有可比对的状态」，不编造变化。
 */
export function describeHumanSession(
  start: HumanSessionSnapshot | null,
  end: HumanSessionSnapshot | null,
  durationMs: number,
): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const span = seconds >= 90 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
  if (start === null || end === null) return `主人接管了 ${span}：期间没有拿到可比对的游戏状态，按当前状态重新开始。`;
  const parts: string[] = [];
  const delta = end.money - start.money;
  if (delta !== 0) parts.push(`金币 ${start.money}→${end.money}（${delta > 0 ? '+' : ''}${delta}）`);
  if (start.clock !== end.clock) parts.push(`时钟 ${start.clock}→${end.clock}`);
  if (start.location !== end.location) parts.push(`位置 ${start.location}→${end.location}`);
  if (start.stamina !== end.stamina) parts.push(`体力 ${start.stamina}/${start.staminaMax}→${end.stamina}/${end.staminaMax}`);
  return `主人接管了 ${span}：${parts.length === 0 ? '游戏状态没有可见变化' : parts.join('，')}。`;
}

export interface AutodriveOptions {
  endpoint?: string;
  /** 宿主会话代次（T-M6-27 / V2-P1-06：隔离旧会话在途指令） */
  generation?: number;
  /** 关联主角色身份标识 */
  characterId?: string;
  /** 关联游戏 ID */
  gameId?: string;
  /** 死循环防护：单次 start() 内最大循环数（0/undefined = 无限——生产默认无限，测试设上限） */
  maxCycles?: number;
  /** 步间延迟（真实游戏节奏：BWF 动作耗时按游戏时间推进，间步不用太久） */
  stepDelayMs?: number;
  /** 出错重试延迟 */
  errorDelayMs?: number;
  /** 状态轮询间隔（get_state 保守 8s） */
  pollDelayMs?: number;
  /**
   * 启动就绪等待上限（P3-06 遗留缺陷①：启动竞态）。
   * 默认 0 = 保持旧行为（单次 ping 失败即抛错）；生产宿主应传正值——
   * 游戏启动 + 读档 + Mod MCP 起服务要几十秒，单次 ping 必在竞态窗口内失败。
   */
  readyTimeoutMs?: number;
  /** 就绪重探间隔（默认 2s） */
  readyPollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** BWF 补丁在玩家接管键鼠后附加到 get_state 文本里的标记（T-M6-73） */
export const PLAYER_IN_CONTROL_MARKER = '【玩家接管中】';

export class AutodriveRunner {
  /** 会话标识：宿主事件出站与 P0 指令入站都以它为归属键（T-M6-27） */
  readonly sessionId: string = randomUUID();
  readonly generation: number;
  readonly controlLease: GameCharacterControlLease;
  private running = false;
  /** start() 重入锁：并发的两次 start（双击/外部+UI）只能启动一个循环 */
  private starting = false;
  /** 就绪等待期间收到 stop()：安静退出，不把用户取消伪装成「游戏不可达」 */
  private startAborted = false;
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
  /** T-M6-73：主人临时接管中（true 时循环只读状态，不发任何动作/keepalive） */
  private humanControl = false;
  /** 接管的触发来源：宿主开关 or 游戏内键鼠（BWF 上报【玩家接管中】） */
  private humanSource: 'switch' | 'in-game' | null = null;
  private humanSince: number | null = null;
  private humanStartSnapshot: HumanSessionSnapshot | null = null;
  /** 最近一次成功的 get_state 快照：接管结束的事件流就差 */
  private lastStateSnapshot: HumanSessionSnapshot | null = null;
  private readonly stateCache = new BwfStateSectionCache();
  /** BWF 自动确认结算/普通升级界面期间的短暂轮询计数（避开竞态点击与多余 LLM 调用） */
  private transientMenuPolls = 0;

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
    this.generation = options.generation ?? 0;
    this.controlLease = new GameCharacterControlLease({
      characterId: options.characterId ?? 'char_xiaojing',
      gameId: options.gameId ?? 'stardew',
      sessionId: this.sessionId,
      generation: this.generation,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.lastMutationAt = (options.now ?? Date.now)();
  }

  setPlanner(planner: Planner): void {
    this.planner = planner;
    (planner as Planner & AutonomousPlannerHooks).bindCallbacks?.({
      onPlan: (ev) => this.onEvent({ type: 'plan', ...ev }),
      onBrainChange: (mode, reason) => this.onEvent({ type: 'brain', mode, reason }),
      onChatStance: (ev) => this.onEvent({ type: 'chat-stance', ...ev }),
    });
  }

  /** P0 带作用域与控制权租约校验的插队指令（V2-P1-06：拒绝过期世代/跨会话/急停/接管期写入） */
  submitScopedDirective(
    tool: string,
    args: Record<string, unknown>,
    intent: string,
    scope?: { sessionId?: string; generation?: number },
  ): { ok: boolean; error?: string } {
    const check = this.controlLease.validateDirective(scope);
    if (!check.ok) {
      return { ok: false, ...(check.error === undefined ? {} : { error: check.error }) };
    }
    this.pendingDirective = { tool, args, intent };
    return { ok: true };
  }

  /** P0 紧急停止：立即停循环、锁租约并向游戏侧发送 cancel_action 中止在飞动作 */
  async emergencyStop(reason = '用户触发紧急停止 Stop'): Promise<boolean> {
    this.running = false;
    this.pendingDirective = null;
    this.controlLease.emergencyStop(reason);
    this.onEvent({ type: 'watchdog', kind: 'stuck', detail: `紧急停止已触发：${reason}` });
    return this.lock.cancel(reason).catch(() => false);
  }

  /** 安全暂停 AI 高级自主决策，保留宿主观测与快速恢复能力 */
  async pauseAi(reason = 'AI 安全暂停，等待主人确认或恢复'): Promise<void> {
    this.controlLease.pauseAi(reason);
    this.pendingDirective = null;
    await this.lock.cancel('pause-ai').catch(() => false);
    this.onEvent({ type: 'watchdog', kind: 'heartbeat', detail: reason });
  }

  /** 从安全暂停或急停恢复到 AI 协同自主 */
  resumeAi(reason = '主人恢复 AI 协同控制'): boolean {
    return this.controlLease.resumeAi(reason);
  }

  /** 当前完整观测与控制状态快照（响应 What Are You Doing? / Show Plan） */
  inspectStatus(): {
    sessionId: string;
    generation: number;
    running: boolean;
    humanControl: boolean;
    lease: GameCharacterControlLeaseState;
    objective: string | null;
    planner: string;
    lastState: HumanSessionSnapshot | null;
    plannerDebug: Record<string, unknown> | null;
  } {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      running: this.running,
      humanControl: this.humanControl,
      lease: this.controlLease.snapshot(),
      objective: this.pendingObjective,
      planner: this.planner.name,
      lastState: this.lastStateSnapshot,
      plannerDebug: this.planner.debugSnapshot?.() ?? null,
    };
  }

  /** 人工/远程 P0 插队：下一次循环优先执行（不重发语义——插队的是新动作） */
  submitDirective(tool: string, args: Record<string, unknown>, intent: string): void {
    this.pendingDirective = { tool, args, intent };
  }

  /** 普通聊天建议（T-M6-70）：进入「主人说」上下文，下一轮由 LLM 输出 stance + reply */
  submitSuggestion(text: string): void {
    (this.planner as Planner & AutonomousPlannerHooks).submitSuggestion?.(text);
  }

  /** `/自然语言` 强制命令（T-M6-70）：优先于当日计划，只允许 execute / infeasible */
  submitCommand(command: string): void {
    const clean = command.replace(/^\/+/, '').trim().slice(0, 300);
    if (clean === '') return;
    const had = this.pendingObjective !== null || (this.planner.hasObjective?.() ?? false);
    this.pendingObjective = null;
    (this.planner as Planner & AutonomousPlannerHooks).submitCommand?.(clean);
    this.onEvent({ type: 'objective', objective: `/${clean}`, reason: had ? 'replaced' : 'set' });
  }

  /** `/cancel` 结束当前强制命令 */
  cancelCommand(): string | null {
    const cancelled = (this.planner as Planner & AutonomousPlannerHooks).cancelCommand?.() ?? null;
    if (cancelled !== null) {
      this.onEvent({ type: 'objective', objective: null, reason: 'cancel' });
    }
    return cancelled;
  }

  /** 团队目标：不锁死具体工具，由当前 planner 在安全护栏内决定动作。 */
  submitObjective(objective: string, intent = objective): void {
    this.pendingObjective = objective.trim().slice(0, 300);
    this.onEvent({ type: 'objective', objective: this.pendingObjective, reason: 'set' });
    this.onEvent({ type: 'decision', planner: 'team-objective', tool: 'wait', args: {}, intent: intent.trim().slice(0, 160) });
  }

  /**
   * 清空多步目标：新单步原子指令 / 用户「算了」/ 切换游戏时立即生效。
   * 同时清 pending（还没被循环消费的）与 planner 已生效的 objective，避免旧目标继续驱动。
   */
  clearObjective(): boolean {
    const cancelledCmd = (this.planner as Planner & AutonomousPlannerHooks).cancelCommand?.() ?? null;
    const had = cancelledCmd !== null || this.pendingObjective !== null || (this.planner.hasObjective?.() ?? false);
    this.pendingObjective = null;
    this.planner.setObjective?.(null);
    return had;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** T-M6-73：当前是否处于主人临时接管态（UI 三处开关与状态栏共用） */
  isHumanControl(): boolean {
    return this.humanControl;
  }

  /**
   * T-M6-73 临时接管开关：进入时尽力中止在飞动作并停止一切决策/keepalive，
   * 只保留 get_state 只读轮询（供交还时给出差异摘要）；退出时返回摘要字符串。
   *
   * 降级说明：真正让游戏内 AI 松手靠 BWF 的 `playerInControl`（补丁未安装时不生效），
   * 但宿主侧仍然会立刻停止发动作——所以缺补丁时是「AI 停手、游戏内仍可自由操作」，
   * 而不是彻底不可用。
   */
  async setHumanControl(active: boolean, reason: 'switch' | 'in-game' = 'switch'): Promise<string | null> {
    const clock = this.options.now ?? Date.now;
    if (active) {
      if (this.humanControl) return null;
      this.humanControl = true;
      this.humanSource = reason;
      this.humanSince = clock();
      this.humanStartSnapshot = this.lastStateSnapshot;
      this.controlLease.takeOverByHuman(reason === 'in-game' ? '游戏内键鼠接管' : '控制台接管');
      // 接管期间旧的卡死/熔断计数不再有意义
      this.sentinel.reset();
      this.stallCount = 0;
      this.stallSignature = null;
      this.stallClock = '';
      this.pendingDirective = null;
      this.lastWaitReason = null;
      this.onEvent({ type: 'human-control', active: true, reason });
      // 尽力中止在飞动作：cancel 失败不影响接管状态本身
      try {
        await this.lock.cancel('human-control');
      } catch {
        /* 接管优先，取消失败只记在上游日志 */
      }
      return null;
    }
    if (!this.humanControl) return null;
    const startedAt = this.humanSince ?? clock();
    const summary = describeHumanSession(this.humanStartSnapshot, this.lastStateSnapshot, clock() - startedAt);
    this.humanControl = false;
    this.humanSource = null;
    this.humanSince = null;
    this.humanStartSnapshot = null;
    this.controlLease.releaseHumanControl('主人交还控制权给 AI');
    // 交还后从「现在」重新计 keepalive，避免刚松手就补一条无谓 keepalive；同时把介入差异摘要交给 planner
    this.lastMutationAt = clock();
    this.sentinel.reset();
    (this.planner as Planner & AutonomousPlannerHooks).setHandoverSummary?.(summary);
    this.onEvent({ type: 'human-control', active: false, reason: 'resume', summary });
    return summary;
  }

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    this.startAborted = false;
    try {
      // P3-06 遗留缺陷①：游戏刚启动时 BWF MCP 要几十秒才就绪，单次 ping 必在竞态窗口内
      // 报「MCP 不可达」。`readyTimeoutMs > 0` 时按 `readyPollMs` 重探直到就绪或超时，
      // 期间每轮发 watchdog 事件让 UI 如实显示「等待游戏就绪」，而不是装死或装成功。
      const clock = this.options.now ?? Date.now;
      const sleep = this.options.sleep ?? defaultSleep;
      const timeoutMs = this.options.readyTimeoutMs ?? 0;
      const pollMs = this.options.readyPollMs ?? 2_000;
      const deadline = clock() + timeoutMs;
      let alive = await this.adapter.ping();
      let attempt = 0;
      while (!alive && !this.startAborted && clock() < deadline) {
        attempt += 1;
        this.onEvent({
          type: 'watchdog',
          kind: 'heartbeat',
          detail: `游戏/Mod 尚未就绪（启动竞态）：第 ${attempt} 次重探，${Math.round(pollMs / 1000)}s 后再试，最长等 ${Math.round(timeoutMs / 1000)}s`,
        });
        await sleep(pollMs);
        if (this.startAborted) break;
        alive = await this.adapter.ping();
      }
      if (!alive) {
        if (this.startAborted) return;
        throw new Error(this.adapter.unreachableMessage);
      }
      if (this.running) return; // ping 期间可能被另一路 start 抢先
      if (this.controlLease.owner === 'halted' || this.controlLease.owner === 'paused') {
        this.controlLease.resumeAi('重新启动自动驾驶');
      }
      this.stateCache.clear();
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
    // 就绪等待中的 start() 也要能被取消（见 startAborted 字段注释）
    this.startAborted = true;
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
    const pollDelay = this.options.pollDelayMs ?? 8_000;
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
        let rawStateText = this.stateCache.hydrate(stateRes.text);
        if (this.stateCache.needsFullWarmup(stateRes.text)) {
          const fullRes = await this.client.callTool('get_state', { full: true }, { timeoutMs: 25_000 });
          if (fullRes.kind === 'ok' && !fullRes.isError) {
            rawStateText = this.stateCache.hydrate(fullRes.text);
          }
        }
        const state = this.adapter.parseState ? this.adapter.parseState(rawStateText) : parseGameState(rawStateText);
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
        this.lastStateSnapshot = {
          clock: state.gameClock,
          money: state.money,
          location: state.location,
          stamina: state.stamina,
          staminaMax: state.staminaMax,
        };

        // 1.2 主人临时接管（T-M6-73）：只读状态，不发动作、不发 keepalive、不做卡死恢复。
        // 游戏侧上报【玩家接管中】说明键鼠仍由主人控制；该标记消失即视为游戏内已交还。
        const playerInControl = stateRes.text.includes(PLAYER_IN_CONTROL_MARKER);
        if (this.humanControl) {
          if (this.humanSource === 'in-game' && !playerInControl) {
            await this.setHumanControl(false);
          } else {
            await sleep(pollDelay);
            continue;
          }
        } else if (playerInControl) {
          // 主人在游戏里动了键鼠（BWF 补丁上报）→ 与宿主开关双向同步
          await this.setHumanControl(true, 'in-game');
          await sleep(pollDelay);
          continue;
        }

        // 1.3 夜间结算/普通升级等 BWF 自动确认界面短暂让路（参考 BWF Agent.CanAct()，避免竞态与多余 LLM 请求）
        const isAutoConfirmMenu = /^(?:每日出货结算界面（会自动确认|升级提示界面（会自动确认)|SaveGameMenu/.test(state.menu);
        if (isAutoConfirmMenu && !this.pendingDirective && this.transientMenuPolls < 4) {
          this.transientMenuPolls += 1;
          this.sentinel.reset();
          await sleep(1_500);
          continue;
        }
        this.transientMenuPolls = 0;

        // 节日/剧情期间游戏时钟故意冻结：免发无效 keepalive(wait) 与误报警卡死恢复
        const clockFrozenEvent = /你正在节日里：时间不走|节日主活动进行中|节日主活动已经开始了|正在播放剧情/.test(rawStateText);
        if (clockFrozenEvent) {
          this.lastMutationAt = clock();
          this.sentinel.reset();
        }

        // 1.5 BWF 防自暂停心跳：连续 90s 只有 get_state（或 planner 一直 wait）会被 BWF 判为
        // “120 秒没有动作”并暂停游戏；发一次游戏原生安全 wait，保持时钟推进。
        if (!clockFrozenEvent && !this.lock.isBusy() && this.adapter.keepaliveAction !== undefined && clock() - this.lastMutationAt >= 90_000) {
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

        // 2. 卡死哨兵：仅在自由行动时段检测游戏时间是否停滞
        const stuck = clockFrozenEvent
          ? { stale: false, staleMs: 0 }
          : this.sentinel.observe(rawStateText);
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

        // 3. 决策（P0 插队 > Planner）；租约未授权（暂停/急停/接管）期间严禁调用 Planner 或发游戏写入
        if (!this.controlLease.canAiAct()) {
          await sleep(pollDelay);
          continue;
        }
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

        if (!this.running || !this.controlLease.canAiAct()) {
          continue;
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
        // T-M6-57 objectiveDone 闭环：模型声明完成但动作失败 → 撤回声明继续推进；
        // 动作真实成功 → 目标结束并广播「目标已完成」给聊天流/桌宠气泡。
        if (receipt.status === 'COMPLETED') {
          const completed = this.planner.consumeObjectiveDone?.() ?? null;
          if (completed !== null) {
            this.onEvent({ type: 'objective', objective: null, reason: 'done' });
            this.onEvent({ type: 'receipt', tool: 'chat_order', status: 'COMPLETED', summary: `目标已完成：${completed}` });
          }
        } else {
          this.planner.restoreObjectiveDone?.();
        }
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
