/**
 * autodrive 编排器（T-M5-02）：桌宠全自动自主玩游戏的主循环。
 * 流程：get_state → 卡死哨兵 → Planner 决策 → ActionLock 执行 → 回执事件 → 间步延迟。
 * 事件回调由宿主注入（总线广播 → Shell 聊天流/桌宠气泡/监控面板/OBS 同源多播，ADR）。
 */
import { ActionLock, StuckSentinel } from './action-lock';
import { BwfMcpClient } from './mcp-client';
import { parseGameState, RulePlanner, type Planner, type PlannerDecision } from './planner';

export type AutodriveEvent =
  | { type: 'state'; clock: string; stamina: number; staminaMax: number; money: number; location: string }
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

/** 从回执文本判定状态（BWF 文本语义：成功/失败/失败原因/「还在执行」） */
function classifyReceipt(text: string, kind: 'timeout' | 'error' | 'ok', isError: boolean, tool: string, errorMessage?: string):
  { status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR'; summary: string } {
  if (kind === 'timeout') return { status: 'TIMEOUT', summary: `超时（${tool} 仍在游戏侧执行的风险——下次 get_state 复核，不重发）` };
  if (kind === 'error') return { status: 'ERROR', summary: (errorMessage ?? '') + (text.slice(0, 200) || '客户端错误') };
  if (isError) {
    const status = /UNCERTAIN|不确定|可能|unknown/i.test(text) ? 'UNCERTAIN' : 'FAILED';
    return { status, summary: text.slice(0, 300) };
  }
  return { status: 'COMPLETED', summary: text.slice(0, 300) };
}

export class AutodriveRunner {
  private running = false;
  private cycle = 0;
  readonly client: BwfMcpClient;
  readonly lock: ActionLock;
  readonly sentinel: StuckSentinel;
  private planner: Planner;
  private pendingDirective: { tool: string; args: Record<string, unknown>; intent: string } | null = null;

  constructor(
    private readonly onEvent: (event: AutodriveEvent) => void,
    private readonly options: AutodriveOptions = {},
  ) {
    this.client = new BwfMcpClient(options.endpoint);
    this.lock = new ActionLock(this.client);
    this.sentinel = new StuckSentinel(4 * 60_000, options.now ?? Date.now);
    this.planner = new RulePlanner();
  }

  setPlanner(planner: Planner): void {
    this.planner = planner;
  }

  /** 人工/远程 P0 插队：下一次循环优先执行（不重发语义——插队的是新动作） */
  submitDirective(tool: string, args: Record<string, unknown>, intent: string): void {
    this.pendingDirective = { tool, args, intent };
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const alive = await this.client.ping();
    if (!alive) throw new Error('BWF MCP 不可达（18080）——确认游戏已启动且 Mod MCP 服务器就绪');
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
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
        const state = parseGameState(stateRes.text);
        if (state.gameClock === '未知') {
          // 状态文本不可解析（游戏未就绪/Mod 异常/版本漂移）——按 watchdog 处理而非盲跑
          this.onEvent({ type: 'watchdog', kind: 'heartbeat', detail: 'get_state 文本不可解析——游戏未就绪或 Mod 异常，稍后重查' });
          await sleep(errorDelay);
          continue;
        }
        this.onEvent({ type: 'state', clock: state.gameClock, stamina: state.stamina, staminaMax: state.staminaMax, money: state.money, location: state.location });

        // 2. 卡死哨兵
        const stuck = this.sentinel.observe(stateRes.text);
        if (stuck.stale) {
          this.onEvent({ type: 'watchdog', kind: 'stuck', detail: `游戏时间 ${Math.round(stuck.staleMs / 1000)}s 无变化 → cancel_action 兜底后重查` });
          await this.lock.cancel('stuck-sentinel');
          await sleep(2_000);
          continue;
        }

        // 3. 决策（P0 插队 > Planner）
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
          // wait 必须可见：把原因作为 stuck 事件亮到中控台/桌宠，避免「看起来没反应」
          this.onEvent({ type: 'watchdog', kind: 'stuck', detail: decision.reason });
          this.onEvent({ type: 'cycle-end', delayMs: decision.seconds * 1000 });
          await sleep(Math.min(decision.seconds, 10) * 1000);
          continue;
        }
        if (decision.kind === 'stop') {
          this.onEvent({ type: 'receipt', tool: 'autodrive', status: 'COMPLETED', summary: decision.reason });
          this.running = false;
          return;
        }

        this.onEvent({ type: 'decision', planner: fromDirective ? 'remote' : this.planner.name, tool: decision.tool, args: decision.args, intent: decision.intent });
        const result = await this.lock.execute(decision.tool, decision.args);
        const receipt = classifyReceipt(result.kind === 'ok' ? result.text : '', result.kind, result.kind === 'ok' && result.isError, decision.tool, result.kind === 'error' ? result.message : undefined);
        this.onEvent({ type: 'receipt', tool: decision.tool, status: receipt.status, summary: receipt.summary });

        // 5. 间步延迟（长动作回执后稍等游戏结算）
        await sleep(receipt.status === 'TIMEOUT' ? 15_000 : stepDelay);
      } catch (error) {
        this.onEvent({ type: 'receipt', tool: 'autodrive', status: 'ERROR', summary: error instanceof Error ? error.message : String(error) });
        await sleep(errorDelay);
      }
    }
  }
}
