/**
 * obs-websocket v5 最小客户端（item 4 / `V2-P3-02`）。
 *
 * 只实现自检探针需要的部分：握手（含认证 challenge/salt）、Request/RequestResponse。
 * 任何异常都**如实抛出**，绝不吞掉并伪装成成功——探针结论必须可信。
 *
 * 协议参考：obs-websocket v5（op 0=Hello, 1=Identify, 2=Identified, 6=Request, 9=RequestResponse）。
 */
import { createHash } from 'node:crypto';

export interface ObsRequestOptions {
  requestType: string;
  requestData?: Record<string, unknown>;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ObsWebsocketClient {
  private readonly socket: WebSocket;
  private readonly nextId: number[] = [1];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly helloWaiters: Array<(data: Record<string, unknown>) => void> = [];
  private readonly identifiedWaiters: Array<(data: Record<string, unknown>) => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(password?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        this.socket.removeEventListener('error', onError);
        resolve();
      };
      const onError = (): void => {
        this.socket.removeEventListener('open', onOpen);
        reject(new Error('无法连接 obs-websocket（OBS 未运行或 WebSocket 服务器未开启）'));
      };
      this.socket.addEventListener('open', onOpen, { once: true });
      this.socket.addEventListener('error', onError, { once: true });
    });

    this.socket.addEventListener('message', (event: MessageEvent) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let payload: {
        op?: number;
        d?: Record<string, unknown>;
      };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        return;
      }
      if (payload.op === 0) {
        this.helloWaiters.shift()?.(payload.d ?? {});
        return;
      }
      if (payload.op === 2) {
        this.identifiedWaiters.shift()?.(payload.d ?? {});
        return;
      }
      if (payload.op === 9) {
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

    const hello = await this.waitHello();
    const auth: Record<string, unknown> = { rpcVersion: 1 };
    const authentication = hello.authentication as { salt?: string; challenge?: string } | null | undefined;
    if (authentication != null) {
      if (password === undefined || password === '') {
        throw new Error('OBS WebSocket 开启了认证：需要通过 --password 或环境变量 OBS_WEBSOCKET_PASSWORD 提供密码');
      }
      const secretHash = createHash('sha256').update(password).digest('base64');
      const saltHash = createHash('sha256').update(`${authentication.salt ?? ''}${secretHash}`).digest('base64');
      auth.authentication = createHash('sha256')
        .update(`${authentication.challenge ?? ''}${saltHash}`)
        .digest('base64');
    }
    this.socket.send(JSON.stringify({ op: 1, d: auth }));
    await this.waitIdentified();
  }

  private waitHello(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.helloWaiters.push(resolve);
    });
  }

  private waitIdentified(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.identifiedWaiters.push(resolve);
    });
  }

  request(options: ObsRequestOptions): Promise<Record<string, unknown>> {
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
        op: 6,
        d: {
          requestType: options.requestType,
          requestId,
          requestData: options.requestData ?? {},
        },
      }));
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* 已关闭 */
    }
  }
}
