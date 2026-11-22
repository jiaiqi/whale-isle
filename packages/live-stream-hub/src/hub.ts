/**
 * 直播事件中枢（T-M5-05）：入站事件唯一收口。
 *
 *   ingest(raw) → NormalizedLiveEventSchema 校验 → Guard（违规/频控/截断）
 *              → 去重（seen LRU 4000）→ Scheduler（合并/衰减/分档）
 *              → 批量 flush（进场/点赞等环境事件 150ms 窗口）→ subscribe 回调
 *
 * 设计取舍：
 *  - 校验必须发生在最外层：C# Mod / dyhub / 彩排沙盒都可能送来脏结构，非法事件拒绝并计数，
 *    绝不把半成品塞进注意力队列；
 *  - 去重放在护栏之后（按工单约定），被护栏丢弃的重复事件不会浪费 seen 容量；
 *  - 只有被调度器 pick 出来的事件才会广播——订阅方拿到的是「该回应的」，不是全部原始噪声。
 */
import { NormalizedLiveEventSchema, type NormalizedLiveEvent } from '@workbench/shared-protocol';
import { AttentionScheduler, type AttentionStats, type AttentionTier } from './attention';
import { Guard, type GuardStats } from './guard';

/** 环境事件：先进 150ms 批次，避免「欢迎 xxx」刷屏逐条外发 */
const BATCHED_EVENT_TYPES: ReadonlySet<NormalizedLiveEvent['eventType']> = new Set([
  'ENTER_ROOM',
  'LIKE',
]);

export type IngestStatus = 'accepted' | 'duplicate' | 'dropped' | 'rejected';

export interface IngestOutcome {
  status: IngestStatus;
  /** accepted/duplicate 时为（清洗后的）事件；rejected/dropped 时为原始可解析对象（若存在） */
  event?: NormalizedLiveEvent;
  reason?: string;
}

/** 一次广播：当前档位 + 本轮应回应的弹幕（已消费） */
export interface HubBatch {
  tier: AttentionTier;
  events: NormalizedLiveEvent[];
  at: number;
}

export type HubHandler = (batch: HubBatch) => void;

export interface LiveEventHubOptions {
  guard?: Guard;
  scheduler?: AttentionScheduler;
  /** 时间注入（确定性测试） */
  now?: () => number;
  /** 去重 seen 容量（LRU 淘汰最旧） */
  seenCapacity?: number;
  /** 环境事件批量窗口 */
  batchWindowMs?: number;
}

export interface HubSnapshot {
  received: number;
  invalid: number;
  droppedByGuard: number;
  duplicates: number;
  accepted: number;
  /** 仍在 150ms 批次里等待 flush 的环境事件数 */
  queuedBatch: number;
  seen: number;
  subscribers: number;
  flushes: number;
  emittedBatches: number;
  emittedEvents: number;
  handlerErrors: number;
  tier: AttentionTier;
  queueSize: number;
  speakerCount: number;
  guard: GuardStats;
  attention: AttentionStats;
}

export class LiveEventHub {
  readonly guard: Guard;
  readonly scheduler: AttentionScheduler;

  private readonly now: () => number;
  private readonly seenCapacity: number;
  private readonly batchWindowMs: number;

  /** eventId → 占位（Map 天然保序：命中时删了重插实现 LRU） */
  private readonly seen = new Map<string, true>();
  /** 等待批量 flush 的环境事件（已过校验与护栏） */
  private batchBuffer: NormalizedLiveEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Set<HubHandler>();

  private readonly counters = {
    received: 0,
    invalid: 0,
    droppedByGuard: 0,
    duplicates: 0,
    accepted: 0,
    flushes: 0,
    emittedBatches: 0,
    emittedEvents: 0,
    handlerErrors: 0,
  };

  constructor(options: LiveEventHubOptions | (() => number) = {}) {
    // 允许直接传时钟函数（等价于 { now }），便于测试与宿主快速接线
    const opts: LiveEventHubOptions = typeof options === 'function' ? { now: options } : options;
    this.now = opts.now ?? Date.now;
    this.seenCapacity = opts.seenCapacity ?? 4000;
    this.batchWindowMs = opts.batchWindowMs ?? 150;
    this.guard = opts.guard ?? new Guard({ now: this.now });
    this.scheduler = opts.scheduler ?? new AttentionScheduler({ now: this.now });
  }

  /**
   * 入站唯一入口。raw 允许任意 unknown：校验失败一律拒绝并计数，绝不 throw 打断收流。
   */
  ingest(raw: unknown): IngestOutcome {
    this.counters.received += 1;

    const parsed = NormalizedLiveEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.counters.invalid += 1;
      const firstIssue = parsed.error.issues[0];
      return { status: 'rejected', reason: firstIssue === undefined ? 'invalid event' : firstIssue.message };
    }

    const event = parsed.data;
    const guarded = this.guard.filter(event);
    if (guarded.action === 'drop') {
      this.counters.droppedByGuard += 1;
      return { status: 'dropped', event, reason: guarded.reason };
    }

    if (this.seen.has(event.eventId)) {
      this.counters.duplicates += 1;
      return { status: 'duplicate', event: guarded.event };
    }
    this.touchSeen(event.eventId);

    this.counters.accepted += 1;
    if (BATCHED_EVENT_TYPES.has(event.eventType)) {
      this.batchBuffer.push(guarded.event);
    } else {
      this.scheduler.ingest(guarded.event);
    }
    this.scheduleFlush();
    return { status: 'accepted', event: guarded.event };
  }

  /** 订阅「该回应的」弹幕批次，返回 dispose */
  subscribe(handler: HubHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 立即结算批次并 pick：既清空 150ms 缓冲，也消费注意力队列 topN */
  flush(now: number = this.now()): HubBatch {
    this.cancelFlush();
    this.counters.flushes += 1;

    for (const event of this.batchBuffer) this.scheduler.ingest(event);
    this.batchBuffer = [];

    const picked = this.scheduler.pick(now);
    const batch: HubBatch = { tier: picked.tier, events: picked.picks, at: now };
    this.emit(batch);
    // 队列还有存量就继续下一轮窗口，避免冷场时弹幕永远压在队里
    if (this.scheduler.stats(now).queueSize > 0) this.scheduleFlush();
    return batch;
  }

  snapshot(): HubSnapshot {
    const now = this.now();
    const attention = this.scheduler.stats(now);
    return {
      ...this.counters,
      queuedBatch: this.batchBuffer.length,
      seen: this.seen.size,
      subscribers: this.handlers.size,
      tier: attention.tier,
      queueSize: attention.queueSize,
      speakerCount: attention.speakerCount,
      guard: this.guard.stats(),
      attention,
    };
  }

  /** 停表并清空订阅（宿主退出/工单测试收尾） */
  dispose(): void {
    this.cancelFlush();
    this.handlers.clear();
  }

  // --------------------------------------------------------------------------
  // 内部实现
  // --------------------------------------------------------------------------

  /** LRU：新 id 直接入尾；超容量淘汰最旧（Map 的插入顺序即最近使用顺序） */
  private touchSeen(eventId: string): void {
    // 调用点已保证 eventId 不在 seen 中（重复事件在更早一步就被拦下）
    this.seen.set(eventId, true);
    while (this.seen.size > this.seenCapacity) {
      const oldest = this.seen.keys().next();
      if (oldest.done === true) break;
      this.seen.delete(oldest.value);
    }
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.batchWindowMs);
    // Node 下别让一个待触发的批次把进程吊住
    const handle = this.timer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  private cancelFlush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(batch: HubBatch): void {
    if (batch.events.length === 0) return;
    this.counters.emittedBatches += 1;
    this.counters.emittedEvents += batch.events.length;
    for (const handler of [...this.handlers]) {
      try {
        handler(batch);
      } catch {
        // 单个订阅者崩溃不能拖垮收流总线：计数后继续分发
        this.counters.handlerErrors += 1;
      }
    }
  }
}
