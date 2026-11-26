/**
 * 主进程全局串行抢麦租约单测（2026-11-26 补，此前零覆盖）：
 *   cancel 在播租约必须如实标 CANCELLED，不得误标 INTERRUPTED_BY_P0（P0 抢占专属）。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GlobalAudioLeaseManager, type GlobalAudioLeaseRequest } from './audio-lease';
import type { AudioPlaybackReceipt } from '@workbench/shared-protocol';

type Receipt = AudioPlaybackReceipt & { agentId: string; speakerName: string };

function makeRequest(overrides: Partial<GlobalAudioLeaseRequest> = {}): GlobalAudioLeaseRequest & { leaseId: string } {
  return {
    leaseId: randomUUID(),
    agentId: 'default',
    speakerName: '小鲸',
    priority: 'P1_CADENCE',
    ttlMs: 5_000,
    start: () => new Promise<void>(() => undefined), // 永不 resolve = 一直在播
    abort: () => undefined,
    ...overrides,
  };
}

describe('GlobalAudioLeaseManager：cancel 语义（批次B 低危修复）', () => {
  it('取消在播租约标 CANCELLED 而非 INTERRUPTED_BY_P0', () => {
    const receipts: Receipt[] = [];
    const mgr = new GlobalAudioLeaseManager({ onReceipt: (r) => receipts.push(r) });
    const req = makeRequest();
    expect(mgr.acquire(req)).toBe('granted');

    expect(mgr.cancel(req.leaseId)).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe('CANCELLED');
  });

  it('取消排队中的租约无回执（未开播无终态）', () => {
    const receipts: Receipt[] = [];
    const mgr = new GlobalAudioLeaseManager({ onReceipt: (r) => receipts.push(r) });
    void mgr.acquire(makeRequest());
    const queued = makeRequest({ priority: 'P2_IDLE' });
    expect(mgr.acquire(queued)).toBe('queued');

    expect(mgr.cancel(queued.leaseId)).toBe(true);
    expect(receipts).toHaveLength(0); // 只清队列，不发回执
  });

  it('P0 抢占仍标 INTERRUPTED_BY_P0，且 preempted 三态不变', () => {
    const receipts: Receipt[] = [];
    const mgr = new GlobalAudioLeaseManager({ onReceipt: (r) => receipts.push(r) });
    void mgr.acquire(makeRequest());

    expect(mgr.acquire(makeRequest({ priority: 'P0_INTERRUPT' }))).toBe('preempted');
    expect(receipts[0]?.status).toBe('INTERRUPTED_BY_P0');
  });

  it('stopAll 应用关闭标 CANCELLED 并清空排队', () => {
    const receipts: Receipt[] = [];
    const mgr = new GlobalAudioLeaseManager({ onReceipt: (r) => receipts.push(r) });
    void mgr.acquire(makeRequest());
    void mgr.acquire(makeRequest({ priority: 'P2_IDLE' }));

    mgr.stopAll();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe('CANCELLED');
    expect(mgr.activeCount()).toBe(0);
  });

  it('取消不存在的租约返回 false 且无副作用', () => {
    const mgr = new GlobalAudioLeaseManager();
    expect(mgr.cancel('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('取消在播后队列下一条被拉起', async () => {
    vi.useFakeTimers();
    try {
      const mgr = new GlobalAudioLeaseManager();
      const first = makeRequest();
      void mgr.acquire(first);
      const secondStart = vi.fn(() => new Promise<void>(() => undefined));
      void mgr.acquire(makeRequest({ priority: 'P2_IDLE', start: secondStart }));

      mgr.cancel(first.leaseId);
      await vi.advanceTimersByTimeAsync(0);
      expect(secondStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
