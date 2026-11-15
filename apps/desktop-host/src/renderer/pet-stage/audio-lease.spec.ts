import { describe, expect, it } from 'vitest';
import type { LeaseAudioAdapter, PlaybackPriority } from './audio-lease';
import { AudioLeaseManager } from './audio-lease';

/** T-M2-01 门禁：并发注入 5 条语音请求——严格串行或 P0 抢占，绝不双音轨重叠 */

interface ControlledPlayback {
  resolve: () => void;
  reject: (error: Error) => void;
  onElapsed?: (ms: number) => void;
  durationMs?: number;
}

/** 受控音频适配器：play 挂起直到测试放行；记录在播集合（双音轨不变式哨兵） */
function makeAdapter(options: { failLeaseIds?: string[] } = {}) {
  const playing = new Set<string>();
  const pending = new Map<string, ControlledPlayback>();
  const elapsedMap = new Map<string, number>();
  const adapter: LeaseAudioAdapter = {
    play(leaseId, durationMs, onElapsed) {
      if (options.failLeaseIds?.includes(leaseId)) return Promise.reject(new Error('AUDIO_DEVICE_ERROR'));
      playing.add(leaseId);
      return new Promise<void>((resolve, reject) => {
        pending.set(leaseId, {
          durationMs,
          onElapsed,
          resolve: () => {
            playing.delete(leaseId);
            onElapsed?.(durationMs ?? 0); // 模拟真实播放期间回调（actualPlayedMs 来源）
            elapsedMap.set(leaseId, durationMs ?? 0);
            resolve();
          },
          reject: (error) => {
            playing.delete(leaseId);
            reject(error);
          },
        });
      });
    },
    abort(leaseId) {
      playing.delete(leaseId);
      pending.get(leaseId)?.reject(new Error('aborted'));
      pending.delete(leaseId);
    },
  };
  return {
    adapter,
    playing,
    elapsedMap,
    finish(leaseId: string) {
      pending.get(leaseId)?.resolve();
      pending.delete(leaseId);
    },
  };
}

type Receipt = { leaseId: string; status: string; actualPlayedMs: number };

/** 串行收发助手：flush 一个宏任务，让拒绝/结算链跑完 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// 回执契约要求 leaseId 为 UUID——测试用可读别名映射到合法 UUID
const IDS = {
  a1: '11111111-1111-4111-8111-111111111111',
  a2: '22222222-2222-4222-8222-222222222222',
  p0: '33333333-3333-4333-8333-333333333333',
  a3: '44444444-4444-4444-8444-444444444444',
  a4: '55555555-5555-4555-8555-555555555555',
  stuck: '66666666-6666-4666-8666-666666666666',
  next: '77777777-7777-4777-8777-777777777777',
  broken: '88888888-8888-4888-8888-888888888888',
  recovery: '99999999-9999-4999-8999-999999999999',
  first: 'aaaaaaa1-1111-4111-8111-111111111111',
  cancelled: 'bbbbbbb2-2222-4222-8222-222222222222',
} as const;

function lease(id: keyof typeof IDS, priority: PlaybackPriority, ttlMs = 30_000, durationMs = 1_000) {
  return { leaseId: IDS[id], priority, ttlMs, durationMs };
}

describe('AudioLeaseManager（单端语音播放锁）', () => {
  it('门禁：并发注入 5 条混合优先级请求——串行 + P0 抢占，全程 active ≤ 1，绝不双音轨', async () => {
    const adapter = makeAdapter();
    const activeCounts: number[] = [];
    const receipts: Receipt[] = [];
    const manager = new AudioLeaseManager({
      adapter: adapter.adapter,
      onReceipt: (receipt) => receipts.push({ leaseId: receipt.leaseId, status: receipt.status, actualPlayedMs: receipt.actualPlayedMs }),
      onActiveChange: (count) => activeCounts.push(count),
    });

    // 并发注入 5 条：P1, P1, P0, P1, P1
    manager.acquire(lease('a1', 'P1_CADENCE'));
    manager.acquire(lease('a2', 'P1_CADENCE'));
    manager.acquire(lease('p0', 'P0_INTERRUPT'));
    manager.acquire(lease('a3', 'P1_CADENCE'));
    manager.acquire(lease('a4', 'P1_CADENCE'));
    await flush();

    // 全程不变式：任意时刻至多 1 条音轨在播
    expect(activeCounts.every((count) => count <= 1)).toBe(true);
    expect(adapter.playing.size).toBeLessThanOrEqual(1);

    // P0 抢占首条 P1（回执 INTERRUPTED_BY_P0）
    expect(receipts.find((receipt) => receipt.leaseId === IDS.a1)?.status).toBe('INTERRUPTED_BY_P0');
    expect(adapter.playing.has(IDS.p0)).toBe(true);

    // 依次放行：p0 → 队列 FIFO a2/a3/a4
    adapter.finish(IDS.p0);
    await flush();
    expect(adapter.playing.has(IDS.a2)).toBe(true);
    adapter.finish(IDS.a2);
    await flush();
    expect(adapter.playing.has(IDS.a3)).toBe(true);
    adapter.finish(IDS.a3);
    await flush();
    expect(adapter.playing.has(IDS.a4)).toBe(true);
    adapter.finish(IDS.a4);
    await flush();

    // 回执结算：1 条被打断 + 4 条完整播放
    const statuses = Object.fromEntries(receipts.map((receipt) => [receipt.leaseId, receipt.status]));
    expect(statuses).toEqual({
      [IDS.a1]: 'INTERRUPTED_BY_P0',
      [IDS.p0]: 'COMPLETED',
      [IDS.a2]: 'COMPLETED',
      [IDS.a3]: 'COMPLETED',
      [IDS.a4]: 'COMPLETED',
    });
    expect(activeCounts.every((count) => count <= 1)).toBe(true);
  });

  it('TTL 到期强制释放（TTL_EXPIRED），队列继续推进', async () => {
    const adapter = makeAdapter();
    const receipts: Receipt[] = [];
    const manager = new AudioLeaseManager({
      adapter: adapter.adapter,
      onReceipt: (receipt) => receipts.push({ leaseId: receipt.leaseId, status: receipt.status, actualPlayedMs: receipt.actualPlayedMs }),
    });
    manager.acquire(lease('stuck', 'P1_CADENCE', 30)); // 播放永不 resolve → 30ms 后 TTL 强制释放
    manager.acquire(lease('next', 'P1_CADENCE'));
    await flush();
    expect(adapter.playing.has(IDS.stuck)).toBe(true);
    // 等待 TTL 定时器触发（真实时钟 30ms + 余量）→ abort → play 以拒绝结算 → 按预标记 TTL_EXPIRED 结算
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flush();
    expect(receipts.find((receipt) => receipt.leaseId === IDS.stuck)?.status).toBe('TTL_EXPIRED');
    expect(adapter.playing.has(IDS.next)).toBe(true); // 队列继续（不打断对话）
  });

  it('设备错误 → AUDIO_DEVICE_ERROR 回执，队列继续（不打断对话）', async () => {
    const adapter = makeAdapter({ failLeaseIds: [IDS.broken] });
    const receipts: Receipt[] = [];
    const manager = new AudioLeaseManager({
      adapter: adapter.adapter,
      onReceipt: (receipt) => receipts.push({ leaseId: receipt.leaseId, status: receipt.status, actualPlayedMs: receipt.actualPlayedMs }),
    });
    manager.acquire(lease('broken', 'P1_CADENCE'));
    manager.acquire(lease('recovery', 'P1_CADENCE'));
    await flush();
    await flush();
    expect(receipts.find((receipt) => receipt.leaseId === IDS.broken)?.status).toBe('AUDIO_DEVICE_ERROR');
    expect(adapter.playing.has(IDS.recovery)).toBe(true);
  });

  it('cancel 丢弃排队租约；正常完成 → COMPLETED 且 actualPlayedMs 如实', async () => {
    const adapter = makeAdapter();
    const receipts: Receipt[] = [];
    const manager = new AudioLeaseManager({
      adapter: adapter.adapter,
      onReceipt: (receipt) => receipts.push({ leaseId: receipt.leaseId, status: receipt.status, actualPlayedMs: receipt.actualPlayedMs }),
    });
    manager.acquire(lease('first', 'P1_CADENCE', 30_000, 700));
    manager.acquire(lease('cancelled', 'P1_CADENCE'));
    manager.cancel(IDS.cancelled);
    adapter.finish(IDS.first);
    await flush();
    const firstReceipt = receipts.find((receipt) => receipt.leaseId === IDS.first);
    expect(firstReceipt?.status).toBe('COMPLETED');
    expect(firstReceipt?.actualPlayedMs).toBe(700);
    await flush();
    expect(adapter.playing.has(IDS.cancelled)).toBe(false); // 已被丢弃，不再播放
    expect(receipts.find((receipt) => receipt.leaseId === IDS.cancelled)).toBeUndefined();
  });

  it('P0 到达即抢占在飞；释放后队列 FIFO 推进（不排队）', async () => {
    const adapter = makeAdapter();
    const manager = new AudioLeaseManager({ adapter: adapter.adapter });
    manager.acquire(lease('a1', 'P1_CADENCE'));
    manager.acquire(lease('a2', 'P1_CADENCE'));
    // P0 到达：抢占在飞的 a1，立即开播（而非排队）
    manager.acquire(lease('p0', 'P0_INTERRUPT'));
    await flush();
    expect(adapter.playing.has(IDS.p0)).toBe(true);
    expect(adapter.playing.has(IDS.a1)).toBe(false); // a1 被中止
    expect(adapter.playing.has(IDS.a2)).toBe(false); // a2 仍在队列
    // p0 完成后：队列 FIFO 推进 a2 → a3
    manager.acquire(lease('a3', 'P1_CADENCE'));
    adapter.finish(IDS.p0);
    await flush();
    expect(adapter.playing.has(IDS.a2)).toBe(true);
    adapter.finish(IDS.a2);
    await flush();
    expect(adapter.playing.has(IDS.a3)).toBe(true);
  });
});
