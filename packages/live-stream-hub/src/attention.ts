/**
 * 三级注意力调度（T-M5-05）——参考 luckui/dsh-livestream「轻重缓急、逐件交付」的社区实践，
 * 公式与结构全部重写，不复制其源码：
 *
 *  1. 分档看「说话人数」而不是「弹幕条数」——单个刷屏机器无法把档位顶到 busy；
 *  2. 分数 = e^(-age/τ)，τ 按档位收紧（quiet 90s / normal 40s / busy 20s），越忙越只看新鲜弹幕；
 *  3. 先把噪声压成一根针再排队：同观众短时刷屏合并、礼物连击计次、进场聚拢成一条欢迎。
 *
 * 所有时间都走注入的 now()，单测可完全确定性回放；本模块零外部依赖（仅类型来自 shared-protocol）。
 */
import type { NormalizedLiveEvent } from '@workbench/shared-protocol';

export type AttentionTier = 'quiet' | 'normal' | 'busy';

/** 档位遍历顺序（构造期校验用） */
export const ATTENTION_TIERS: readonly AttentionTier[] = ['quiet', 'normal', 'busy'];

/**
 * 参与「说话人数」统计的事件类型：只有带文本的互动才算「说话」。
 * 进场 / 礼物 / 点赞属于环境事件，不能把档位顶起来（否则欢迎机器人就能制造假热闹）。
 */
const SPEAKING_EVENT_TYPES: ReadonlySet<NormalizedLiveEvent['eventType']> = new Set([
  'DANMAKU',
  'SONG_REQUEST',
  'VOTE_CHOICE',
]);

/** 默认调参（全部可在构造时覆盖） */
export const DEFAULT_ATTENTION_CONFIG = Object.freeze({
  /** 说话人数 < 8 → quiet */
  quietMaxSpeakers: 8,
  /** 说话人数 >= 30 → busy（8~29 为 normal） */
  busyMinSpeakers: 30,
  tauSec: Object.freeze<Record<AttentionTier, number>>({ quiet: 90, normal: 40, busy: 20 }),
  slots: Object.freeze<Record<AttentionTier, number>>({ quiet: 4, normal: 2, busy: 1 }),
  /** 说话人数统计窗口：只统计最近 60s 开过口的人 */
  speakerWindowMs: 60_000,
  /** 同观众连续弹幕合并窗口 */
  mergeWindowMs: 15_000,
  /** 合并后的文本最多展示几条（多出的只计 mergedCount，不再拼文本） */
  mergeMaxParts: 5,
  /** 礼物连击合并窗口（同 uid + 同礼物） */
  giftComboWindowMs: 3_000,
  /** 进场聚拢窗口（从聚合起点算） */
  enterClusterWindowMs: 2_500,
  /** 待回应队列硬上限，防异常直播流把内存撑爆 */
  maxQueueSize: 512,
  /** 超过该年龄的弹幕不再值得回应（pick 时清理） */
  maxQueueAgeMs: 300_000,
});

export interface AttentionOptions {
  quietMaxSpeakers?: number;
  busyMinSpeakers?: number;
  /** 逐档覆盖 τ（秒） */
  tauSec?: Partial<Record<AttentionTier, number>>;
  /** 逐档覆盖名额 */
  slots?: Partial<Record<AttentionTier, number>>;
  speakerWindowMs?: number;
  mergeWindowMs?: number;
  mergeMaxParts?: number;
  giftComboWindowMs?: number;
  enterClusterWindowMs?: number;
  maxQueueSize?: number;
  maxQueueAgeMs?: number;
  /** 时间注入（确定性测试） */
  now?: () => number;
}

interface ResolvedAttentionConfig {
  quietMaxSpeakers: number;
  busyMinSpeakers: number;
  tauSec: Record<AttentionTier, number>;
  slots: Record<AttentionTier, number>;
  speakerWindowMs: number;
  mergeWindowMs: number;
  mergeMaxParts: number;
  giftComboWindowMs: number;
  enterClusterWindowMs: number;
  maxQueueSize: number;
  maxQueueAgeMs: number;
}

export interface AttentionPick {
  tier: AttentionTier;
  picks: NormalizedLiveEvent[];
}

export interface AttentionStats {
  tier: AttentionTier;
  /** 当前时间窗内开过口的人数 */
  speakerCount: number;
  /** 尚未被 pick 消费的待回应事件数 */
  queueSize: number;
  ingested: number;
  /** 同观众弹幕合并发生的次数 */
  merged: number;
  /** 礼物连击合并发生的次数 */
  giftCombos: number;
  /** 进场聚拢吸收的次数 */
  enterClusters: number;
  picked: number;
  /** 队列超限 / 超龄被淘汰的次数 */
  evicted: number;
  expired: number;
}

/** 待回应队列中的一条（合并状态与事件本体放在一起） */
interface QueueEntry {
  event: NormalizedLiveEvent;
  /** 首次入队时间（时间衰减按它算，合并不会让老弹幕「返老还童」） */
  firstTs: number;
  /** 最近一次合并时间（合并窗口按它算） */
  lastTs: number;
  removed: boolean;
  /** 合并后的文本片段（最多 mergeMaxParts 段） */
  rawParts: string[];
  sanitizedParts: string[];
  /** 真实合并总数（可超过展示片段数） */
  totalMerged: number;
  /** 进场聚拢时收集的昵称（去重后用于「欢迎 A、B、C」） */
  names: string[];
}

/**
 * 时间衰减得分：e^(-age/τ)。
 * age 用毫秒、τ 用秒，负年龄（时钟回拨/乱序事件）夹紧为 0，避免得分 > 1。
 */
export function decayScore(ageMs: number, tauSec: number): number {
  const ageSec = Math.max(0, ageMs) / 1000;
  return Math.exp(-ageSec / Math.max(1e-6, tauSec));
}

/** 三级注意力调度器：ingest 入队（含合并）→ pick 消费 topN */
export class AttentionScheduler {
  private readonly config: ResolvedAttentionConfig;
  private readonly now: () => number;

  /** 待回应队列（按到达顺序，合并只改队内条目） */
  private queue: QueueEntry[] = [];
  /** uid → 最近一次「说话」时间戳 */
  private readonly speakers = new Map<string, number>();
  /** `${uid}\u0001${giftName}` → 连击中的礼物条目 */
  private readonly giftCombos = new Map<string, QueueEntry>();
  /** 当前进场聚拢批次 */
  private enterCluster: QueueEntry | null = null;

  private readonly counters = {
    ingested: 0,
    merged: 0,
    giftCombos: 0,
    enterClusters: 0,
    picked: 0,
    evicted: 0,
    expired: 0,
  };

  constructor(options: AttentionOptions | (() => number) = {}) {
    // 允许直接传时钟函数（等价于 { now }），便于测试与宿主快速接线
    const opts: AttentionOptions = typeof options === 'function' ? { now: options } : options;
    this.now = opts.now ?? Date.now;
    this.config = {
      quietMaxSpeakers: opts.quietMaxSpeakers ?? DEFAULT_ATTENTION_CONFIG.quietMaxSpeakers,
      busyMinSpeakers: opts.busyMinSpeakers ?? DEFAULT_ATTENTION_CONFIG.busyMinSpeakers,
      tauSec: { ...DEFAULT_ATTENTION_CONFIG.tauSec, ...opts.tauSec },
      slots: { ...DEFAULT_ATTENTION_CONFIG.slots, ...opts.slots },
      speakerWindowMs: opts.speakerWindowMs ?? DEFAULT_ATTENTION_CONFIG.speakerWindowMs,
      mergeWindowMs: opts.mergeWindowMs ?? DEFAULT_ATTENTION_CONFIG.mergeWindowMs,
      mergeMaxParts: opts.mergeMaxParts ?? DEFAULT_ATTENTION_CONFIG.mergeMaxParts,
      giftComboWindowMs: opts.giftComboWindowMs ?? DEFAULT_ATTENTION_CONFIG.giftComboWindowMs,
      enterClusterWindowMs: opts.enterClusterWindowMs ?? DEFAULT_ATTENTION_CONFIG.enterClusterWindowMs,
      maxQueueSize: opts.maxQueueSize ?? DEFAULT_ATTENTION_CONFIG.maxQueueSize,
      maxQueueAgeMs: opts.maxQueueAgeMs ?? DEFAULT_ATTENTION_CONFIG.maxQueueAgeMs,
    };
    if (this.config.quietMaxSpeakers < 1) {
      throw new Error('quietMaxSpeakers 必须 >= 1');
    }
    if (this.config.busyMinSpeakers <= this.config.quietMaxSpeakers) {
      throw new Error('busyMinSpeakers 必须大于 quietMaxSpeakers');
    }
    for (const tier of ATTENTION_TIERS) {
      if (this.config.slots[tier] < 1) throw new Error(`slots.${tier} 必须 >= 1`);
      if (this.config.tauSec[tier] <= 0) throw new Error(`tauSec.${tier} 必须 > 0`);
    }
  }

  /**
   * 入站事件：先尝试合并（弹幕/礼物/进场），合不上再单独排队。
   * 入参必须是已经过 NormalizedLiveEventSchema 校验的事件（Hub 负责校验）。
   */
  ingest(event: NormalizedLiveEvent): void {
    const now = this.now();
    this.counters.ingested += 1;
    this.pruneSpeakers(now);
    if (SPEAKING_EVENT_TYPES.has(event.eventType)) {
      this.speakers.set(event.sender.uid, event.timestamp);
    }

    switch (event.eventType) {
      case 'DANMAKU': {
        const existing = this.findLatest((entry) =>
          entry.event.eventType === 'DANMAKU' &&
          entry.event.sender.uid === event.sender.uid &&
          event.timestamp - entry.lastTs <= this.config.mergeWindowMs,
        );
        if (existing) {
          this.mergeDanmaku(existing, event);
          return;
        }
        this.enqueue(this.createTextEntry(event));
        return;
      }
      case 'GIFT': {
        const key = this.giftKey(event);
        const existing = this.giftCombos.get(key);
        if (existing && !existing.removed && event.timestamp - existing.lastTs <= this.config.giftComboWindowMs) {
          existing.totalMerged += event.payload.mergedCount;
          existing.lastTs = event.timestamp;
          existing.event = this.rebuildGift(existing);
          this.counters.giftCombos += 1;
          return;
        }
        const entry = this.createTextEntry(event);
        this.giftCombos.set(key, entry);
        this.enqueue(entry);
        return;
      }
      case 'ENTER_ROOM': {
        const cluster = this.enterCluster;
        if (cluster && !cluster.removed && event.timestamp - cluster.firstTs <= this.config.enterClusterWindowMs) {
          if (!cluster.names.includes(event.sender.nickname)) {
            cluster.names.push(event.sender.nickname);
          }
          cluster.totalMerged += event.payload.mergedCount;
          cluster.lastTs = event.timestamp;
          cluster.event = this.rebuildWelcome(cluster);
          this.counters.enterClusters += 1;
          return;
        }
        const entry = this.createTextEntry(event);
        entry.names.push(event.sender.nickname);
        entry.event = this.rebuildWelcome(entry);
        this.enterCluster = entry;
        this.enqueue(entry);
        return;
      }
      default: {
        this.enqueue(this.createTextEntry(event));
      }
    }
  }

  /**
   * 取当前档位的 topN 待回应事件（消费语义：被取走的事件不会再次返回）。
   * 排序：衰减得分降序 → 到达时间升序 → eventId 字典序（保证同分时确定性）。
   */
  pick(now: number = this.now()): AttentionPick {
    this.pruneSpeakers(now);
    this.pruneExpired(now);
    const tier = this.tierForSpeakers(this.speakers.size);
    const candidates: QueueEntry[] = [];
    for (const entry of this.queue) {
      if (!entry.removed) candidates.push(entry);
    }
    candidates.sort((a, b) => {
      const scoreA = decayScore(now - a.event.timestamp, this.config.tauSec[tier]);
      const scoreB = decayScore(now - b.event.timestamp, this.config.tauSec[tier]);
      if (scoreA !== scoreB) return scoreB - scoreA;
      if (a.event.timestamp !== b.event.timestamp) return a.event.timestamp - b.event.timestamp;
      return a.event.eventId.localeCompare(b.event.eventId);
    });

    const selected = candidates.slice(0, this.config.slots[tier]);
    for (const entry of selected) this.forget(entry);
    if (selected.length > 0) {
      this.queue = this.queue.filter((entry) => !entry.removed);
    }
    this.counters.picked += selected.length;
    return { tier, picks: selected.map((entry) => entry.event) };
  }

  /** 当前档位（按注入时钟） */
  currentTier(now: number = this.now()): AttentionTier {
    return this.tierForSpeakers(this.speakerCount(now));
  }

  /** 当前时间窗内开过口的人数（会顺手清理过期记录） */
  speakerCount(now: number = this.now()): number {
    this.pruneSpeakers(now);
    return this.speakers.size;
  }

  /** 按人数分档（8 / 30 边界：7→quiet，8/29→normal，30→busy） */
  tierForSpeakers(count: number): AttentionTier {
    if (count < this.config.quietMaxSpeakers) return 'quiet';
    if (count >= this.config.busyMinSpeakers) return 'busy';
    return 'normal';
  }

  /** 单个事件在当前档位下的衰减得分（供可观测/调试，不消费队列） */
  scoreOf(event: NormalizedLiveEvent, now: number = this.now()): number {
    const tier = this.currentTier(now);
    return decayScore(now - event.timestamp, this.config.tauSec[tier]);
  }

  /** 某档位的 τ（秒） */
  tauForTier(tier: AttentionTier): number {
    return this.config.tauSec[tier];
  }

  stats(now: number = this.now()): AttentionStats {
    this.pruneSpeakers(now);
    let queueSize = 0;
    for (const entry of this.queue) {
      if (!entry.removed) queueSize += 1;
    }
    return {
      tier: this.tierForSpeakers(this.speakers.size),
      speakerCount: this.speakers.size,
      queueSize,
      ...this.counters,
    };
  }

  // --------------------------------------------------------------------------
  // 内部实现
  // --------------------------------------------------------------------------

  private createTextEntry(event: NormalizedLiveEvent): QueueEntry {
    const raw = event.payload.rawText;
    const sanitized = event.payload.sanitizedText;
    return {
      event,
      firstTs: event.timestamp,
      lastTs: event.timestamp,
      removed: false,
      rawParts: raw === undefined ? [] : [raw],
      sanitizedParts: sanitized === undefined ? [] : [sanitized],
      totalMerged: event.payload.mergedCount,
      names: [],
    };
  }

  /** 同观众连续弹幕合并：文本以「 / 」连接，最多 mergeMaxParts 段，超出的只计次 */
  private mergeDanmaku(entry: QueueEntry, incoming: NormalizedLiveEvent): void {
    if (incoming.payload.rawText !== undefined && entry.rawParts.length < this.config.mergeMaxParts) {
      entry.rawParts.push(incoming.payload.rawText);
    }
    if (incoming.payload.sanitizedText !== undefined && entry.sanitizedParts.length < this.config.mergeMaxParts) {
      entry.sanitizedParts.push(incoming.payload.sanitizedText);
    }
    entry.totalMerged += incoming.payload.mergedCount;
    entry.lastTs = incoming.timestamp;
    entry.event = {
      ...entry.event,
      payload: {
        ...entry.event.payload,
        rawText: entry.rawParts.length > 0 ? entry.rawParts.join(' / ') : undefined,
        sanitizedText: entry.sanitizedParts.length > 0 ? entry.sanitizedParts.join(' / ') : undefined,
        mergedCount: entry.totalMerged,
      },
    };
    this.counters.merged += 1;
  }

  private rebuildGift(entry: QueueEntry): NormalizedLiveEvent {
    return {
      ...entry.event,
      payload: { ...entry.event.payload, mergedCount: entry.totalMerged },
    };
  }

  /** 「欢迎 A、B、C」：昵称去重、最多展示 20 个，其余折成「等 N 人」 */
  private rebuildWelcome(entry: QueueEntry): NormalizedLiveEvent {
    const shown = entry.names.slice(0, 20);
    const suffix = entry.names.length > shown.length ? ` 等${entry.names.length}人` : '';
    const welcome = `欢迎 ${shown.join('、')}${suffix}`;
    return {
      ...entry.event,
      payload: {
        ...entry.event.payload,
        rawText: welcome,
        sanitizedText: welcome,
        mergedCount: entry.totalMerged,
      },
    };
  }

  private giftKey(event: NormalizedLiveEvent): string {
    return `${event.sender.uid}\u0001${event.payload.giftName ?? ''}`;
  }

  /** 从队尾往前找最近一条满足条件的条目（同 uid 可能因超窗而存在多条） */
  private findLatest(predicate: (entry: QueueEntry) => boolean): QueueEntry | null {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (entry === undefined || entry.removed) continue;
      if (predicate(entry)) return entry;
    }
    return null;
  }

  private enqueue(entry: QueueEntry): void {
    this.queue.push(entry);
    const now = this.now();
    while (this.queue.length > this.config.maxQueueSize) {
      if (!this.evictOne(now)) break;
    }
  }

  /** 淘汰得分最低（= 最老）的一条：异常流量下优先保住新鲜弹幕 */
  private evictOne(now: number): boolean {
    const tier = this.tierForSpeakers(this.speakerCount(now));
    let victim: QueueEntry | null = null;
    let lowest = Number.POSITIVE_INFINITY;
    for (const entry of this.queue) {
      if (entry.removed) continue;
      const score = decayScore(now - entry.event.timestamp, this.config.tauSec[tier]);
      if (score < lowest) {
        lowest = score;
        victim = entry;
      }
    }
    if (!victim) return false;
    this.forget(victim);
    this.queue = this.queue.filter((entry) => !entry.removed);
    this.counters.evicted += 1;
    return true;
  }

  /** 清理超过 maxQueueAgeMs 的老弹幕（观众早就聊别的了，回应反而尴尬） */
  private pruneExpired(now: number): void {
    let changed = false;
    for (const entry of this.queue) {
      if (entry.removed) continue;
      if (now - entry.event.timestamp > this.config.maxQueueAgeMs) {
        this.forget(entry);
        this.counters.expired += 1;
        changed = true;
      }
    }
    if (changed) {
      this.queue = this.queue.filter((entry) => !entry.removed);
    }
  }

  /** 标记条目出队，并清掉指向它的连击/聚拢索引 */
  private forget(entry: QueueEntry): void {
    entry.removed = true;
    for (const [key, value] of this.giftCombos) {
      if (value === entry) this.giftCombos.delete(key);
    }
    if (this.enterCluster === entry) this.enterCluster = null;
  }

  private pruneSpeakers(now: number): void {
    for (const [uid, lastTs] of this.speakers) {
      if (now - lastTs > this.config.speakerWindowMs) this.speakers.delete(uid);
    }
  }
}
