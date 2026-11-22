/**
 * `ws` 的最小类型垫片（T-M6-04）：
 * desktop-host 只声明了运行时依赖 `ws`（8.x），未安装 @types/ws；
 * 为了保持 strict + noImplicitAny 零错误，这里只声明 WebUI 实际用到的 API 子集。
 * 若后续把 `@types/ws` 加入 devDependencies，应删除本文件避免重复声明。
 */
declare module 'ws' {
  import type { ClientRequest, IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export class WebSocket {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;
    readonly readyState: number;
    constructor(address: string, options?: Record<string, unknown>);
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(
      event: 'unexpected-response',
      listener: (request: ClientRequest, response: IncomingMessage) => void,
    ): this;
    on(event: string, listener: (...args: never[]) => void): this;
  }

  export interface WebSocketServerOptions {
    noServer?: boolean;
    server?: import('node:http').Server;
    clientTracking?: boolean;
    perMessageDeflate?: boolean;
  }

  export class WebSocketServer {
    constructor(options?: WebSocketServerOptions);
    readonly clients: Set<WebSocket>;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
    emit(event: 'connection', socket: WebSocket, request: IncomingMessage): boolean;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket) => void,
    ): void;
    close(callback?: (error?: Error) => void): void;
  }
}
