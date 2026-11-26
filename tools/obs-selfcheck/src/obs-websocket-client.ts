/**
 * obs-websocket v5 最小客户端（item 4 / `V2-P3-02`）。
 *
 * 只实现自检探针需要的部分：握手（含认证 challenge/salt）、Request/RequestResponse。
 * 任何异常都**如实抛出**，绝不吞掉并伪装成成功——探针结论必须可信。
 *
 * 连接阶段的失败出口统一收口（`rejectAll`）：认证失败时服务端不发 op=2 而是直接
 * 发 CLOSE（code 4009），早期实现只等 op=2，导致 `connect()` 永远不 settle——
 * 现在 close / error / 超时三条路径都会让等待者立刻抛错，并给出能直接给 owner 看的文案。
 *
 * 协议参考：obs-websocket 5.x `Protocol.md` 的 opcode 表——
 * 0=Hello / 1=Identify / 2=Identified / 3=Reidentify / 5=Event / 6=Request / 7=RequestResponse /
 * 8=RequestBatch / 9=RequestBatchResponse。**RequestResponse 是 7，不是 9**（9 是批量应答）。
 */
import { createHash } from 'node:crypto';

export interface ObsRequestOptions {
  requestType: string;
  requestData?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ObsConnectOptions {
  /** 等 TCP/WebSocket 打开 */
  openTimeoutMs?: number;
  /** 等 op=0 Hello */
  helloTimeoutMs?: number;
  /** 等 op=2 Identified（认证失败时永远不会来） */
  identifiedTimeoutMs?: number;
  /** 测试注入：替换真实的全局 WebSocket */
  socketFactory?: (url: string) => WebSocket;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** obs-websocket 5.x opcode 表（`Protocol.md`）：名字对齐协议，别再写裸数字 */
export const OBS_OP = {
  HELLO: 0,
  IDENTIFY: 1,
  IDENTIFIED: 2,
  REIDENTIFY: 3,
  EVENT: 5,
  REQUEST: 6,
  REQUEST_RESPONSE: 7,
  REQUEST_BATCH: 8,
  REQUEST_BATCH_RESPONSE: 9,
} as const;

/** obs-websocket 认证失败关闭码（v5 规范 4009 Authentication failed） */
export const AUTH_FAILED_CLOSE_CODE = 4009;

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type SocketFactory = (url: string) => WebSocket;

/** 关闭码 → 能直接给 owner 看的文案（含处置建议，500 字符以内的行动指引比错误码有用） */export function describeClose(code: number, reason?: string): string {
  const suffix = reason !== undefined && reason !== '' ? `，${reason}` : '';
  if (code === AUTH_FAILED_CLOSE_CODE || /auth/i.test(reason ?? '')) {
    return `OBS WebSocket 认证失败：密码不正确（服务端关闭码 ${code}${suffix}）。`
      + '请在 OBS → 设置 → WebSocket 服务器设置里重设服务器密码，注意复制时别丢首字符。';
  }
  return `obs-websocket 连接已断开（关闭码 ${code}${suffix}）`;
}

/**
 * obs-websocket 5.x 认证串（协议 `Authentication` 节，两步）：
 *
 *   secret         = base64( sha256( password + salt ) )
 *   authentication = base64( sha256( secret + challenge ) )
 *
 * 历史坑：这里曾经写成三步（先把 password 单独哈希，再把 salt、challenge 的拼接顺序反过来），
 * 而假服务端照抄了同一套公式，于是实现错、测试也错、两边自洽，真机却永远回 4009。
 * 所以：**假服务端必须按协议公式独立实现，不能复用本函数**；向量断言里的常量也不能从实现里取。
 */
export function computeAuthentication(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(`${password}${salt}`).digest('base64');
  return createHash('sha256').update(`${secret}${challenge}`).digest('base64');
}

export class ObsWebsocketClient {
  private readonly socket: WebSocket;
  private readonly nextId: number[] = [1];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly helloWaiters: Array<(data: Record<string, unknown>) => void> = [];
  private readonly identifiedWaiters: Array<(data: Record<string, unknown>) => void> = [];
  /** 连接阶段所有等待者的统一失败出口 */
  private readonly failureRejecters = new Set<(error: Error) => void>();
  private connectFailure: Error | null = null;
  private closing = false;

  constructor(url: string, options: ObsConnectOptions = {}) {
    const factory: SocketFactory = options.socketFactory ?? ((target: string) => new WebSocket(target));
    this.socket = factory(url);
    this.attachLifecycleListeners();
  }

  async connect(password?: string, options: ObsConnectOptions = {}): Promise<void> {
    await this.waitOpen(options.openTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    await this.waitHello(options.helloTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    const auth: Record<string, unknown> = { rpcVersion: 1 };
    const hello = this.lastHello;
    const authentication = hello.authentication as { salt?: string; challenge?: string } | null | undefined;
    if (authentication != null) {
      if (password === undefined || password === '') {
        throw new Error('OBS WebSocket 开启了认证：需要通过 --password 或环境变量 OBS_WEBSOCKET_PASSWORD 提供密码');
      }
      auth.authentication = computeAuthentication(password, authentication.salt ?? '', authentication.challenge ?? '');
    }
    this.socket.send(JSON.stringify({ op: OBS_OP.IDENTIFY, d: auth }));
    await this.waitIdentified(options.identifiedTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  }

  private lastHello: Record<string, unknown> = {};

  /** close / error 都走同一个失败出口：不让任何一个等待者悬在半空 */
  private attachLifecycleListeners(): void {
    this.socket.addEventListener('close', (event: Event) => {
      const detail = event as unknown as { code?: number; reason?: string };
      if (this.closing) return;
      this.failEveryone(new Error(describeClose(detail.code ?? 0, detail.reason)));
    });
    this.socket.addEventListener('error', () => {
      if (this.closing) return;
      this.failEveryone(new Error('无法连接 obs-websocket（OBS 未运行或 WebSocket 服务器未开启）'));
    });
    this.socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let payload: { op?: number; d?: Record<string, unknown> };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        return;
      }
      if (payload.op === OBS_OP.HELLO) {
        this.lastHello = payload.d ?? {};
        this.helloWaiters.shift()?.(this.lastHello);
        return;
      }
      if (payload.op === OBS_OP.IDENTIFIED) {
        this.identifiedWaiters.shift()?.(payload.d ?? {});
        return;
      }
      if (payload.op === OBS_OP.REQUEST_RESPONSE) {
        const data = payload.d ?? {};
        const requestId = String(data.requestId ?? '');
        const entry = this.pending.get(requestId);
        if (entry === undefined) return;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        const status = data.requestStatus as { result?: boolean; comment?: string } | undefined;
        if (status?.result === true) {
          entry.resolve((data.responseData as Record<string, unknown>) ?? {});
        } else {
          entry.reject(new Error(status?.comment ?? `obs-websocket 请求失败：${requestId}`));
        }
      }
    });
  }

  /** 统一失败出口：连接阶段等待者 + 在途请求一起拒绝，且只记第一条原因 */
  private failEveryone(error: Error): void {
    if (this.connectFailure === null) this.connectFailure = error;
    for (const reject of [...this.failureRejecters]) reject(error);
    this.failureRejecters.clear();
    for (const [requestId, entry] of [...this.pending]) {
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /**
   * 等一个信号：要么被 resolve，要么被失败出口拒绝，要么超时——三者必有其一。
   * 这是「不许无限挂起」的唯一实现点。
   */
  private awaitSignal<T>(
    register: (resolve: (value: T) => void) => void,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      if (this.connectFailure !== null) {
        rejectPromise(this.connectFailure);
        return;
      }
      const onFailure = (error: Error): void => {
        clearTimeout(timer);
        rejectPromise(error);
      };
      const timer = setTimeout(() => {
        this.failureRejecters.delete(onFailure);
        rejectPromise(new Error(timeoutMessage));
      }, timeoutMs);
      timer.unref?.();
      this.failureRejecters.add(onFailure);
      register((value) => {
        clearTimeout(timer);
        this.failureRejecters.delete(onFailure);
        resolvePromise(value);
      });
    });
  }

  private waitOpen(timeoutMs: number): Promise<void> {
    return this.awaitSignal<void>(
      (resolve) => this.socket.addEventListener('open', () => resolve(), { once: true }),
      timeoutMs,
      '连接 obs-websocket 超时（OBS 未运行，或 WebSocket 服务器地址/端口不对）',
    );
  }

  private waitHello(timeoutMs: number): Promise<Record<string, unknown>> {
    return this.awaitSignal<Record<string, unknown>>(
      (resolve) => this.helloWaiters.push(resolve),
      timeoutMs,
      '等待 obs-websocket Hello 超时（服务端不是 obs-websocket v5，或 WebSocket 服务器未正常响应）',
    );
  }

  private waitIdentified(timeoutMs: number): Promise<Record<string, unknown>> {
    return this.awaitSignal<Record<string, unknown>>(
      (resolve) => this.identifiedWaiters.push(resolve),
      timeoutMs,
      '等待 obs-websocket Identified 超时（服务端没有确认认证，常见原因：密码不正确）',
    );
  }

  request(options: ObsRequestOptions): Promise<Record<string, unknown>> {
    if (this.connectFailure !== null) return Promise.reject(this.connectFailure);
    const requestId = `whale-selfcheck-${this.nextId[0]}`;
    this.nextId[0] = (this.nextId[0] ?? 1) + 1;
    const timeoutMs = options.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`obs-websocket 请求超时：${options.requestType}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({
        op: OBS_OP.REQUEST,
        d: {
          requestType: options.requestType,
          requestId,
          requestData: options.requestData ?? {},
        },
      }));
    });
  }

  close(): void {
    this.closing = true;
    try {
      this.socket.close();
    } catch {
      /* 已关闭 */
    }
  }
}
