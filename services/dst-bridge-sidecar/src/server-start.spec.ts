/** [M7] sidecar start() 异常路径：监听地址不可读时明确拒绝（覆盖率收口）。 */
import { EventEmitter } from 'node:events';
import { vi, describe, expect, it, beforeEach, afterEach } from 'vitest';

const listen = vi.fn();
const close = vi.fn();
let addressResult: unknown = null;

vi.mock('node:http', () => ({
  createServer: () => {
    const srv = new EventEmitter() as EventEmitter & {
      listen: typeof listen;
      address: () => unknown;
      close: (cb: () => void) => void;
      off: EventEmitter['off'];
    };
    srv.listen = listen;
    srv.address = () => addressResult;
    srv.close = (cb) => cb();
    return srv;
  },
}));

import { createDstSidecar } from './server';

beforeEach(() => {
  listen.mockImplementation((_port: number, _host: string, cb: () => void) => cb());
  close.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe('start() 监听地址异常', () => {
  it('address() 返回字符串 → 明确拒绝', async () => {
    addressResult = 'pipe-or-string';
    const sidecar = createDstSidecar({ pairToken: 'token', port: 0 });
    await expect(sidecar.start()).rejects.toThrow('sidecar 监听地址不可用');
    expect(listen).toHaveBeenCalled();
    expect(sidecar.port()).toBe(-1); // address 非对象 → -1（未监听语义）
  });

  it('address() 返回 null → 明确拒绝', async () => {
    addressResult = null;
    const sidecar = createDstSidecar({ pairToken: 'token', port: 0 });
    await expect(sidecar.start()).rejects.toThrow('sidecar 监听地址不可用');
  });

  it('未指定 port/host → 默认 18100 / 127.0.0.1；enableFileFallback() 默认路径可启用', async () => {
    addressResult = { port: 18100, address: '127.0.0.1' };
    const sidecar = createDstSidecar({ pairToken: 'token' });
    const port = await sidecar.start();
    expect(port).toBe(18100);
    expect(listen).toHaveBeenCalledWith(18100, '127.0.0.1', expect.any(Function));
    sidecar.enableFileFallback(); // 默认 snapshot/plan 路径 + 默认 interval
    sidecar.enableFileFallback(); // 重复启用 → 清理旧 timer 分支
    expect(sidecar.stats().mode).toBe('both');
    await sidecar.close();
    expect(sidecar.stats().mode).toBe('http');
  });
});
