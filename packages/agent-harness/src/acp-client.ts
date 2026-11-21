/**
 * ACP v1 客户端（T-M6-02）：JSON-RPC over stdio（行分隔），真机实测协议形状
 * 来自 gemini --acp 冒烟（2026-11-21）：initialize→result{protocolVersion,authMethods}；
 * session/new 未登录→error -32000。ADR-4：v1 先行、v2 特性渐进。
 */

export interface AcpAgentCapability {
  loadSession?: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
  agentCapabilities?: AcpAgentCapability;
  authenticated?: boolean;
}

/** 会话内容块（ACP v1 规范子集：text 为主，工具调用以 tool_call/tool_call_update 块承载） */
export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type AcpAgentEvent =
  | { type: 'initialized'; result: AcpInitializeResult }
  | { type: 'session-started'; sessionId: string }
  | { type: 'update'; sessionId: string; block: AcpContentBlock; stopReason?: string }
  | { type: 'permission'; requestId: number; toolName: string; input: Record<string, unknown> }
  | { type: 'turn-complete'; sessionId: string; stopReason: string }
  | { type: 'auth-required'; message: string }
  | { type: 'error'; code: number; message: string }
  | { type: 'exit'; code: number | null };

export interface AcpAgentOptions {
  /** 供显示的 provider 名 */
  label: string;
  command: string;
  args?: string[];
  cwd?: string;
  /** 行协议默认 30s 请求超时 */
  requestTimeoutMs?: number;
  /** 注入 spawn（单测） */
  spawnImpl?: typeof import('node:child_process').spawn;
  /** 注入时钟/等待（单测） */
  now?: () => number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AcpAgent {
  private proc: import('node:child_process').ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuf = '';
  private stderrTail = '';
  private started = false;

  constructor(
    private readonly options: AcpAgentOptions,
    private readonly onEvent: (event: AcpAgentEvent) => void,
  ) {}

  get label(): string {
    return this.options.label;
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /** 启动并完成 ACP v1 initialize 握手 */
  async start(): Promise<AcpInitializeResult> {
    if (this.started && this.isRunning()) throw new Error(`${this.label} 已在运行`);
    const spawn = this.options.spawnImpl ?? (await import('node:child_process')).spawn;
    this.proc = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.started = true;
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.consume(chunk));
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-500);
    });
    this.proc.on('exit', (code) => {
      this.rejectAll(new Error(`agent 退出（code=${code}）`));
      this.onEvent({ type: 'exit', code });
    });
    this.proc.on('error', (err) => {
      this.rejectAll(err);
      this.onEvent({ type: 'error', code: -1, message: err.message });
    });
    this.proc.stdin?.on('error', () => undefined); // EPIPE 不炸进程

    const result = (await this.request<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })) as AcpInitializeResult;
    this.onEvent({ type: 'initialized', result });
    return result;
  }

  /** 创建新会话（登录态下成功；未登录将收到 auth-required 事件 + reject） */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.request<{ sessionId: string }>('session/new', {
      cwd,
      mcpServers: [],
    })) as { sessionId: string };
    this.onEvent({ type: 'session-started', sessionId: result.sessionId });
    return result.sessionId;
  }

  /** 发送一轮提示；流式 update/permission 经 onEvent 推送，resolve 于 turn-complete */
  async prompt(sessionId: string, text: string): Promise<void> {
    await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  }

  /** 审批回填：mode=「一次允许/总是允许/拒绝」 */
  async resolvePermission(requestId: number, outcome: { outcome: 'selected'; optionId: string }): Promise<void> {
    // ACP 规范：以 notification 形式回填（无 id）
    this.notify('session/permission_response', { requestId, outcome });
  }

  /** 会话负载取消（尽力而为：多数实现按 notification 处理） */
  cancelSession(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    this.proc = null;
  }

  /** ---------- 内部：行协议 ---------- */

  private send(payload: unknown): void {
    if (!this.proc?.stdin?.writable) throw new Error(`${this.label} stdin 不可写（未启动/已退出）`);
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = this.options.requestTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时 ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private rejectAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private consume(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line === '') continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // 非协议行（banner 等）忽略
    }
    // 请求响应
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          const e = new Error(msg.error.message);
          pending.reject(e);
          // 鉴权类错误单独广播（Shell 提示去登录）
          if (/key|auth|login|登录/i.test(msg.error.message)) {
            this.onEvent({ type: 'auth-required', message: msg.error.message });
          } else {
            this.onEvent({ type: 'error', code: msg.error.code, message: msg.error.message });
          }
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    // 通知/服务器请求
    if (msg.method) {
      this.handleNotification(msg.method, msg.params ?? {});
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'session/update': {
        const block = (params.update ?? params.contentBlock ?? {}) as AcpContentBlock;
        const sessionId = String(params.sessionId ?? '');
        this.onEvent({ type: 'update', sessionId, block, stopReason: params.stopReason ? String(params.stopReason) : undefined });
        return;
      }
      case 'session/request_permission': {
        const requestId = Number(params.requestId ?? params.id ?? -1);
        const toolName = String((params.toolCall as { toolName?: string } | undefined)?.toolName ?? params.toolName ?? 'unknown-tool');
        const input = ((params.toolCall as { input?: Record<string, unknown> } | undefined)?.input ?? params.input ?? {}) as Record<string, unknown>;
        this.onEvent({ type: 'permission', requestId, toolName, input });
        return;
      }
      default:
        // 未知通知安全忽略（v2 特性渐进：usage/compaction 等后续接）
    }
  }
}
