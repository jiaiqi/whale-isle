/**
 * live-stream-hub 单测（T-M5-05）
 * 覆盖：三级分档边界 / e^(-age/τ) 衰减 / 同观众合并 / 礼物连击 / 进场聚拢 /
 *       护栏三态 / 频控 / emoji 代理对 / 截断 / 中枢去重 LRU / 订阅 / 非法事件 / 150ms 批量。
 * 所有时间走注入时钟，测试完全确定性。
 */
import { describe, expect, it, vi } from 'vitest';
import { NormalizedLiveEventSchema, type NormalizedLiveEvent } from '@workbench/shared-protocol';
import {
  AttentionScheduler,
  DEFAULT_ATTENTION_CONFIG,
  decayScore,
  type AttentionOptions,
} from './attention';
import { Guard, stripLoneSurrogates, truncateUtf16Safe } from './guard';
import { LiveEventHub } from './hub';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

let eventSeq = 0;

function nextEventId(): string {
  eventSeq += 1;
  return `00000000-0000-4000-8000-${String(eventSeq).padStart(12, '0')}`;
}

interface EventOptions {
  id?: string;
  uid?: string;
  nickname?: string;
  type?: NormalizedLiveEvent['eventType'];
  text?: string;
  sanitizedText?: string;
  giftName?: string;
  at?: number;
  priority?: NormalizedLiveEvent['assignedPriority'];
}

function ev(options: EventOptions = {}): NormalizedLiveEvent {
  return NormalizedLiveEventSchema.parse({
    eventId: options.id ?? nextEventId(),
    platform: 'douyin',
    eventType: options.type ?? 'DANMAKU',
    sender: { uid: options.uid ?? 'u-1', nickname: options.nickname ?? '观众甲' },
    payload: { rawText: options.text, sanitizedText: options.sanitizedText, giftName: options.giftName },
    assignedPriority: options.priority ?? 'P1_CADENCE',
    timestamp: options.at ?? 0,
  });
}

function makeClock(start = 0): { value: number } {
  return { value: start };
}

/** 用 n 个不同 uid 各发一条弹幕，制造「说话人数」 */
function withSpeakers(count: number, extra: AttentionOptions = {}): { scheduler: AttentionScheduler; clock: { value: number } } {
  const clock = makeClock(0);
  const scheduler = new AttentionScheduler({ now: () => clock.value, ...extra });
  for (let index = 0; index < count; index += 1) {
    scheduler.ingest(ev({ uid: `speaker-${index}`, text: `hi-${index}`, at: 0 }));
  }
  return { scheduler, clock };
}

// ---------------------------------------------------------------------------
// 注意力：分档边界
// ---------------------------------------------------------------------------

describe('AttentionScheduler 三级分档（按说话人数）', () => {
  it('7 人 → quiet；8 人 → normal（quiet 边界不越界）', () => {
    const seven = withSpeakers(7);
    expect(seven.scheduler.currentTier()).toBe('quiet');
    expect(seven.scheduler.stats().speakerCount).toBe(7);

    const eight = withSpeakers(8);
    expect(eight.scheduler.currentTier()).toBe('normal');
  });

  it('29 人 → normal；30 人 → busy（normal/busy 边界）', () => {
    const twentyNine = withSpeakers(29);
    expect(twentyNine.scheduler.currentTier()).toBe('normal');

    const thirty = withSpeakers(30);
    expect(thirty.scheduler.currentTier()).toBe('busy');
  });

  it('说话人数统计窗口过期后自动回落 quiet', () => {
    const { scheduler, clock } = withSpeakers(8, { speakerWindowMs: 1_000 });
    expect(scheduler.currentTier()).toBe('normal');
    clock.value = 1_001;
    expect(scheduler.currentTier()).toBe('quiet');
    expect(scheduler.speakerCount()).toBe(0);
  });

  it('分档按人数不按条数：同一人刷 50 条仍是 quiet', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    for (let index = 0; index < 50; index += 1) {
      scheduler.ingest(ev({ uid: 'spammer', text: `刷屏-${index}`, at: 0 }));
    }
    expect(scheduler.currentTier()).toBe('quiet');
    expect(scheduler.stats().speakerCount).toBe(1);
  });

  it('阈值 / 名额 / τ 均可配置', () => {
    const { scheduler } = withSpeakers(2, {
      quietMaxSpeakers: 2,
      busyMinSpeakers: 5,
      slots: { quiet: 3 },
      tauSec: { busy: 10 },
    });
    expect(scheduler.currentTier()).toBe('normal'); // 2 人已达到 normal 下界
    expect(scheduler.tauForTier('busy')).toBe(10);
    expect(scheduler.tauForTier('quiet')).toBe(DEFAULT_ATTENTION_CONFIG.tauSec.quiet);
  });

  it('非法调参在构造期直接抛错（防线前移）', () => {
    expect(() => new AttentionScheduler({ quietMaxSpeakers: 0 })).toThrow();
    expect(() => new AttentionScheduler({ quietMaxSpeakers: 10, busyMinSpeakers: 10 })).toThrow();
    expect(() => new AttentionScheduler({ slots: { quiet: 0 } })).toThrow();
    expect(() => new AttentionScheduler({ tauSec: { normal: 0 } })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 注意力：时间衰减
// ---------------------------------------------------------------------------

describe('AttentionScheduler 时间衰减 e^(-age/τ)', () => {
  it('老弹幕让位新弹幕：pick 按得分降序返回', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    const old = ev({ uid: 'a', text: '早来的', at: 0 });
    const fresh = ev({ uid: 'b', text: '刚来的', at: 30_000 });
    scheduler.ingest(old);
    clock.value = 30_000;
    scheduler.ingest(fresh);

    const { picks, tier } = scheduler.pick(30_000);
    expect(tier).toBe('quiet');
    expect(picks.map((item) => item.eventId)).toEqual([fresh.eventId, old.eventId]);
    expect(scheduler.scoreOf(fresh, 30_000)).toBeGreaterThan(scheduler.scoreOf(old, 30_000));
  });

  it('busy 档衰减更快：同年龄分数与 τ 均更低', () => {
    // 纯函数层：同样 20s 年龄，τ=20 的得分低于 τ=90
    const quietScore = decayScore(20_000, DEFAULT_ATTENTION_CONFIG.tauSec.quiet);
    const busyScore = decayScore(20_000, DEFAULT_ATTENTION_CONFIG.tauSec.busy);
    expect(quietScore).toBeGreaterThan(busyScore);
    expect(quietScore).toBeCloseTo(Math.exp(-20 / 90), 6);
    expect(busyScore).toBeCloseTo(Math.exp(-1), 6);

    // 调度器层：同一事件在 30 人直播间里的得分低于 1 人直播间
    const common = ev({ uid: 'u-common', text: '同一句话', at: 0 });
    const clock = makeClock(0);
    const quiet = new AttentionScheduler({ now: () => clock.value });
    quiet.ingest(common);

    const busyClock = makeClock(0);
    const busy = new AttentionScheduler({ now: () => busyClock.value });
    busy.ingest(common);
    for (let index = 0; index < 29; index += 1) {
      busy.ingest(ev({ uid: `busy-${index}`, text: `刷-${index}`, at: 0 }));
    }

    clock.value = 20_000;
    busyClock.value = 20_000;
    expect(busy.currentTier()).toBe('busy');
    expect(busy.scoreOf(common, 20_000)).toBeLessThan(quiet.scoreOf(common, 20_000));
  });

  it('负年龄夹紧为 0（时钟回拨不会产生 >1 的分数）', () => {
    expect(decayScore(-5_000, 20)).toBe(1);
    expect(decayScore(0, 20)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 注意力：名额
// ---------------------------------------------------------------------------

describe('AttentionScheduler 每档名额', () => {
  it('quiet 档最多 4 条', () => {
    const { scheduler } = withSpeakers(5);
    const result = scheduler.pick(0);
    expect(result.tier).toBe('quiet');
    expect(result.picks).toHaveLength(4);
    expect(scheduler.stats().queueSize).toBe(1);
  });

  it('normal 档最多 2 条', () => {
    const { scheduler } = withSpeakers(8);
    const result = scheduler.pick(0);
    expect(result.tier).toBe('normal');
    expect(result.picks).toHaveLength(2);
  });

  it('busy 档最多 1 条', () => {
    const { scheduler } = withSpeakers(30);
    const result = scheduler.pick(0);
    expect(result.tier).toBe('busy');
    expect(result.picks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 注意力：合并
// ---------------------------------------------------------------------------

describe('AttentionScheduler 同观众合并', () => {
  it('同 uid 15s 内连续弹幕合并为一条，文本用「 / 」连接', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'same', text: '第一句', at: 0 }));
    clock.value = 5_000;
    scheduler.ingest(ev({ uid: 'same', text: '第二句', at: 5_000 }));

    expect(scheduler.stats().queueSize).toBe(1);
    expect(scheduler.stats().merged).toBe(1);
    const { picks } = scheduler.pick(5_000);
    expect(picks).toHaveLength(1);
    expect(picks[0]?.payload.rawText).toBe('第一句 / 第二句');
    expect(picks[0]?.payload.mergedCount).toBe(2);
  });

  it('超过 15s 窗口不再合并（同 uid 出现两条独立弹幕）', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'same', text: '早', at: 0 }));
    clock.value = 15_001;
    scheduler.ingest(ev({ uid: 'same', text: '晚', at: 15_001 }));

    expect(scheduler.stats().queueSize).toBe(2);
    const { picks } = scheduler.pick(15_001);
    expect(picks).toHaveLength(2);
  });

  it('合并文本最多 5 段，超出的只累计 mergedCount', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    for (let index = 0; index < 6; index += 1) {
      clock.value = index * 1_000;
      scheduler.ingest(ev({ uid: 'burst', text: `m${index}`, at: clock.value }));
    }
    const { picks } = scheduler.pick(5_000);
    expect(picks).toHaveLength(1);
    expect(picks[0]?.payload.rawText).toBe('m0 / m1 / m2 / m3 / m4');
    expect(picks[0]?.payload.mergedCount).toBe(6);
  });

  it('不同观众不合并；合并后再次被 pick 消费', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'a', text: 'A', at: 0 }));
    scheduler.ingest(ev({ uid: 'b', text: 'B', at: 0 }));
    expect(scheduler.pick(0).picks).toHaveLength(2);
    expect(scheduler.pick(0).picks).toHaveLength(0);
  });

  it('合并同时维护 rawText / sanitizedText 两条文本轨', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'same', text: '你', sanitizedText: '你', at: 0 }));
    clock.value = 1_000;
    scheduler.ingest(ev({ uid: 'same', text: '好', sanitizedText: '好', at: 1_000 }));
    const picked = scheduler.pick(1_000).picks[0];
    expect(picked?.payload.rawText).toBe('你 / 好');
    expect(picked?.payload.sanitizedText).toBe('你 / 好');
  });

  it('点赞（LIKE）入队但不计入说话人数', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'liker', type: 'LIKE', at: 0 }));
    expect(scheduler.stats().speakerCount).toBe(0);
    expect(scheduler.stats().tier).toBe('quiet');
    expect(scheduler.pick(0).picks).toHaveLength(1);
  });
});

describe('AttentionScheduler 礼物连击与进场聚拢', () => {
  it('3s 内同 uid + 同礼物连击合并计次', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'rich', type: 'GIFT', giftName: '火箭', at: 0 }));
    clock.value = 1_000;
    scheduler.ingest(ev({ uid: 'rich', type: 'GIFT', giftName: '火箭', at: 1_000 }));
    clock.value = 2_500;
    scheduler.ingest(ev({ uid: 'rich', type: 'GIFT', giftName: '火箭', at: 2_500 }));
    clock.value = 2_600;
    scheduler.ingest(ev({ uid: 'rich', type: 'GIFT', giftName: '小花', at: 2_600 }));

    const { picks } = scheduler.pick(2_600);
    expect(picks).toHaveLength(2);
    const rocket = picks.find((item) => item.payload.giftName === '火箭');
    expect(rocket?.payload.mergedCount).toBe(3);
    expect(scheduler.stats().giftCombos).toBe(2);
  });

  it('礼物连击超过 3s 不合并', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'rich', type: 'GIFT', giftName: '火箭', at: 0 }));
    clock.value = 3_001;
    scheduler.ingest(ev({ uid: 'rich', type: 'GIFT', giftName: '火箭', at: 3_001 }));
    expect(scheduler.stats().queueSize).toBe(2);
  });

  it('2.5s 内进场聚拢为一条「欢迎 A、B、C」', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'e1', nickname: '甲', type: 'ENTER_ROOM', at: 0 }));
    scheduler.ingest(ev({ uid: 'e2', nickname: '乙', type: 'ENTER_ROOM', at: 800 }));
    clock.value = 2_000;
    scheduler.ingest(ev({ uid: 'e3', nickname: '丙', type: 'ENTER_ROOM', at: 2_000 }));

    expect(scheduler.stats().queueSize).toBe(1);
    expect(scheduler.stats().enterClusters).toBe(2);
    const { picks } = scheduler.pick(2_000);
    expect(picks).toHaveLength(1);
    expect(picks[0]?.eventType).toBe('ENTER_ROOM');
    expect(picks[0]?.payload.rawText).toBe('欢迎 甲、乙、丙');
    expect(picks[0]?.payload.mergedCount).toBe(3);
  });

  it('进场超过 2.5s 另起一批（不把半小时后的新人塞进旧欢迎）', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    scheduler.ingest(ev({ uid: 'e1', nickname: '甲', type: 'ENTER_ROOM', at: 0 }));
    clock.value = 3_000;
    scheduler.ingest(ev({ uid: 'e2', nickname: '乙', type: 'ENTER_ROOM', at: 3_000 }));

    expect(scheduler.stats().queueSize).toBe(2);
    const { picks } = scheduler.pick(3_000);
    expect(picks.map((item) => item.payload.rawText).sort()).toEqual(['欢迎 乙', '欢迎 甲']);
  });

  it('进场聚拢最多展示 20 个昵称，其余折成「等 N 人」', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value });
    for (let index = 0; index < 21; index += 1) {
      scheduler.ingest(ev({ uid: `e-${index}`, nickname: `客${index}`, type: 'ENTER_ROOM', at: 0 }));
    }
    const text = scheduler.pick(0).picks[0]?.payload.rawText ?? '';
    expect(text).toContain('客19');
    expect(text).not.toContain('客20');
    expect(text).toContain('等21人');
  });
});

describe('AttentionScheduler 队列治理', () => {
  it('超龄弹幕在 pick 时被清理并计数', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value, maxQueueAgeMs: 1_000 });
    scheduler.ingest(ev({ uid: 'a', text: '过期了', at: 0 }));
    clock.value = 1_001;
    const { picks } = scheduler.pick(1_001);
    expect(picks).toHaveLength(0);
    expect(scheduler.stats().expired).toBe(1);
  });

  it('队列超硬上限时淘汰最老的一条', () => {
    const clock = makeClock(0);
    const scheduler = new AttentionScheduler({ now: () => clock.value, maxQueueSize: 3 });
    for (let index = 0; index < 5; index += 1) {
      clock.value = index * 1_000;
      scheduler.ingest(ev({ uid: `u-${index}`, text: `t-${index}`, at: clock.value }));
    }
    const stats = scheduler.stats(4_000);
    expect(stats.queueSize).toBe(3);
    expect(stats.evicted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 护栏
// ---------------------------------------------------------------------------

describe('Guard 违规词三态', () => {
  it('block 命中直接丢弃', () => {
    const guard = new Guard({ now: () => 0 });
    const result = guard.filter(ev({ text: '想了解就加微信找我' }));
    expect(result.action).toBe('drop');
    expect(result.reason).toBe('block:加微信');
    expect(guard.stats().blocked).toBe(1);
    expect(guard.stats().dropped).toBe(1);
  });

  it('mask 命中就地掩码为 ***', () => {
    const guard = new Guard({ now: () => 0 });
    const result = guard.filter(ev({ text: '你个傻逼' }));
    expect(result.action).toBe('mask');
    expect(result.event.payload.sanitizedText).toBe('你个***');
    expect(result.reason).toBe('mask:傻逼');
    expect(guard.stats().masked).toBe(1);
  });

  it('warn 命中保留但标记（reason 透出，不私改契约字段）', () => {
    const guard = new Guard({ now: () => 0 });
    const result = guard.filter(ev({ text: '滚开啦' }));
    expect(result.action).toBe('pass');
    expect(result.event.payload.sanitizedText).toBe('滚开啦');
    expect(result.reason).toBe('warn:滚');
    expect(guard.stats().warned).toBe(1);
  });

  it('词表可整体替换；无文本事件直接放行', () => {
    const guard = new Guard({ now: () => 0, rules: { block: ['BAD'], mask: ['UGLY'], warn: ['MEH'] } });
    expect(guard.filter(ev({ text: '加微信' })).action).toBe('pass'); // 默认词表已被替换
    expect(guard.filter(ev({ text: 'BAD' })).action).toBe('drop');
    expect(guard.filter(ev({ text: 'UGLY' })).action).toBe('mask');
    expect(guard.filter(ev({ text: 'MEH' })).action).toBe('pass');
    const gift = guard.filter(ev({ type: 'GIFT', giftName: '火箭' }));
    expect(gift.action).toBe('pass');
    expect(gift.event.payload.sanitizedText).toBeUndefined();
  });

  it('只有 sanitizedText 的事件也走护栏；空词表项被跳过', () => {
    const guard = new Guard({ now: () => 0, rules: { block: ['', '禁词'], mask: ['', '脏'], warn: [''] } });
    expect(guard.filter(ev({ sanitizedText: '这里有禁词' })).action).toBe('drop');
    const masked = guard.filter(ev({ sanitizedText: '这里脏' }));
    expect(masked.action).toBe('mask');
    expect(masked.event.payload.sanitizedText).toBe('这里***');
  });

  it('mask 与 warn 同时命中：动作取 mask，warn 仍计数', () => {
    const guard = new Guard({ now: () => 0, rules: { mask: ['脏'], warn: ['滚'] } });
    const result = guard.filter(ev({ text: '脏东西滚' }));
    expect(result.action).toBe('mask');
    expect(result.reason).toBe('mask:脏');
    expect(guard.stats().warned).toBe(1);
  });
});

describe('Guard 频控与文本清洗', () => {
  it('同 uid 每分钟 21 条被丢弃并计数', () => {
    const clock = makeClock(0);
    const guard = new Guard({ now: () => clock.value });
    for (let index = 0; index < 21; index += 1) {
      const result = guard.filter(ev({ uid: 'spam', text: `第${index}条` }));
      expect(result.action).toBe(index < 20 ? 'pass' : 'drop');
    }
    const stats = guard.stats();
    expect(stats.frequencyDropped).toBe(1);
    expect(stats.dropped).toBe(1);
  });

  it('频控窗口滑过后恢复；不同 uid 互不影响', () => {
    const clock = makeClock(0);
    const guard = new Guard({ now: () => clock.value });
    for (let index = 0; index < 20; index += 1) guard.filter(ev({ uid: 'spam', text: `a${index}` }));
    clock.value = 60_001;
    expect(guard.filter(ev({ uid: 'spam', text: '恢复' })).action).toBe('pass');
    expect(guard.filter(ev({ uid: 'other', text: '别人' })).action).toBe('pass');
  });

  it('清洗孤立代理对，合法 emoji 原样保留', () => {
    expect(stripLoneSurrogates('A\uD83DB')).toBe('AB');
    expect(stripLoneSurrogates('A\uDC1FB')).toBe('AB');
    expect(stripLoneSurrogates('🐟好')).toBe('🐟好');

    const guard = new Guard({ now: () => 0 });
    const result = guard.filter(ev({ text: '🐟\uD800好' }));
    expect(result.action).toBe('pass');
    expect(result.event.payload.sanitizedText).toBe('🐟好');
    expect(guard.stats().loneSurrogateCleaned).toBe(1);
  });

  it('按 UTF-16 码元安全截断：不砍开 emoji，默认 200 字符', () => {
    expect(truncateUtf16Safe('🐟🐟', 3)).toEqual({ text: '🐟', truncated: true });
    expect(truncateUtf16Safe('abc', 5)).toEqual({ text: 'abc', truncated: false });
    expect(truncateUtf16Safe('abc', 0)).toEqual({ text: '', truncated: true });

    const guard = new Guard({ now: () => 0 });
    const long = guard.filter(ev({ text: 'a'.repeat(300) }));
    expect(long.event.payload.sanitizedText?.length).toBe(200);
    expect(guard.stats().truncated).toBe(1);

    const emojiGuard = new Guard({ now: () => 0, maxTextLength: 3 });
    const emoji = emojiGuard.filter(ev({ text: '🐟🐟' }));
    const out = emoji.event.payload.sanitizedText ?? '';
    expect(out).toBe('🐟');
    expect(out.length).toBe(2);
    // 高位代理后面必须紧跟低位代理
    expect(out.charCodeAt(1)).toBeGreaterThanOrEqual(0xdc00);
  });
});

// ---------------------------------------------------------------------------
// 事件中枢
// ---------------------------------------------------------------------------

describe('LiveEventHub 入站管线', () => {
  it('同 eventId 二次 ingest 被去重；非法事件拒绝并计数', () => {
    const clock = makeClock(0);
    const hub = new LiveEventHub({ now: () => clock.value });
    const event = ev({ text: '只收一次' });
    expect(hub.ingest(event).status).toBe('accepted');
    expect(hub.ingest(event).status).toBe('duplicate');
    expect(hub.snapshot().duplicates).toBe(1);

    expect(hub.ingest({ hello: 'world' }).status).toBe('rejected');
    expect(hub.ingest(null).status).toBe('rejected');
    const snapshot = hub.snapshot();
    expect(snapshot.invalid).toBe(2);
    expect(snapshot.received).toBe(4);
    hub.dispose();
  });

  it('护栏丢弃不进入队列也不占 seen 容量', () => {
    const clock = makeClock(0);
    const hub = new LiveEventHub({ now: () => clock.value });
    const outcome = hub.ingest(ev({ text: '加微信领福利' }));
    expect(outcome.status).toBe('dropped');
    expect(outcome.reason).toBe('block:加微信');
    const snapshot = hub.snapshot();
    expect(snapshot.droppedByGuard).toBe(1);
    expect(snapshot.accepted).toBe(0);
    expect(snapshot.seen).toBe(0);
    expect(snapshot.queueSize).toBe(0);
    hub.dispose();
  });

  it('seen 容量 4000：第 4001 条淘汰最旧 id，旧事件可重新入站', () => {
    const clock = makeClock(0);
    const hub = new LiveEventHub({ now: () => clock.value });
    const first = ev({ uid: 'u-0', text: '最早' });
    expect(hub.ingest(first).status).toBe('accepted');
    for (let index = 0; index < 4_000; index += 1) {
      hub.ingest(ev({ uid: `uid-${index}`, text: `批量-${index}` }));
    }
    expect(hub.snapshot().seen).toBe(4_000);
    // 最旧的 first 已被 LRU 淘汰 → 可重新接收
    expect(hub.ingest(first).status).toBe('accepted');
    hub.dispose();
  });

  it('进场环境事件先进 150ms 批次；手动 flush 聚拢为一条欢迎', () => {
    const clock = makeClock(0);
    const hub = new LiveEventHub({ now: () => clock.value });
    hub.ingest(ev({ uid: 'a', nickname: '甲', type: 'ENTER_ROOM' }));
    hub.ingest(ev({ uid: 'b', nickname: '乙', type: 'ENTER_ROOM' }));

    const before = hub.snapshot();
    expect(before.queuedBatch).toBe(2);
    expect(before.queueSize).toBe(0);

    const batch = hub.flush(0);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.payload.rawText).toBe('欢迎 甲、乙');
    expect(hub.snapshot().queuedBatch).toBe(0);
    hub.dispose();
  });

  it('150ms 定时器自动 flush（假时钟驱动）', () => {
    vi.useFakeTimers();
    try {
      const clock = makeClock(0);
      const hub = new LiveEventHub({ now: () => clock.value });
      const received: string[][] = [];
      hub.subscribe((batch) => received.push(batch.events.map((item) => item.payload.sanitizedText ?? '')));
      hub.ingest(ev({ text: '定时器来了' }));
      expect(received).toHaveLength(0);
      vi.advanceTimersByTime(149);
      expect(received).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(['定时器来了']);
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('空 hub 直接 flush 返回空批次且不广播', () => {
    const hub = new LiveEventHub({ now: () => 0 });
    const batches: number[] = [];
    hub.subscribe((batch) => batches.push(batch.events.length));
    const batch = hub.flush(0);
    expect(batch.events).toHaveLength(0);
    expect(batches).toHaveLength(0);
    expect(hub.snapshot().flushes).toBe(1);
    expect(hub.snapshot().emittedBatches).toBe(0);
    hub.dispose();
  });
});

describe('LiveEventHub 订阅与统计', () => {  it('subscribe 收到 pick 批次，dispose 后不再收到', () => {
    const clock = makeClock(0);
    const hub = new LiveEventHub({ now: () => clock.value });
    const batches: number[] = [];
    const dispose = hub.subscribe((batch) => batches.push(batch.events.length));

    hub.ingest(ev({ uid: 'a', text: '一' }));
    hub.ingest(ev({ uid: 'b', text: '二' }));
    hub.flush(0);
    expect(batches).toEqual([2]);

    dispose();
    hub.ingest(ev({ uid: 'c', text: '三' }));
    hub.flush(0);
    expect(batches).toEqual([2]);
    expect(hub.snapshot().subscribers).toBe(0);
    hub.dispose();
  });

  it('单个订阅者抛错不拖垮其他订阅者，错误被计数', () => {
    const clock = makeClock(0);
    const hub = new LiveEventHub({ now: () => clock.value });
    const good: number[] = [];
    hub.subscribe(() => {
      throw new Error('boom');
    });
    hub.subscribe((batch) => good.push(batch.events.length));
    hub.ingest(ev({ text: '分发' }));
    hub.flush(0);
    expect(good).toEqual([1]);
    expect(hub.snapshot().handlerErrors).toBe(1);
    hub.dispose();
  });

  it('flush 逐轮消费队列：5 条弹幕在 quiet 档分两轮拿完', () => {
    const clock = makeClock(0);
    const hub = new LiveEventHub({ now: () => clock.value });
    for (let index = 0; index < 5; index += 1) {
      hub.ingest(ev({ uid: `u-${index}`, text: `第${index}条` }));
    }
    expect(hub.flush(0).events).toHaveLength(4);
    expect(hub.flush(0).events).toHaveLength(1);
    expect(hub.snapshot().emittedBatches).toBe(2);
    expect(hub.snapshot().emittedEvents).toBe(5);
    hub.dispose();
  });

  it('端到端：违规丢弃 → 掩码入队 → flush 拿到 sanitizedText 与统计', () => {
    const clock = makeClock(1_000);
    const hub = new LiveEventHub({ now: () => clock.value });
    expect(hub.ingest(ev({ uid: 'bad', text: '代开发票找我' })).status).toBe('dropped');
    expect(hub.ingest(ev({ uid: 'rude', text: '你个傻逼' })).status).toBe('accepted');
    expect(hub.ingest(ev({ uid: 'nice', text: '今天玩什么' })).status).toBe('accepted');

    const batch = hub.flush(1_000);
    expect(batch.tier).toBe('quiet');
    expect(batch.events).toHaveLength(2);
    const texts = batch.events.map((item) => item.payload.sanitizedText);
    expect(texts).toContain('你个***');
    expect(texts).toContain('今天玩什么');

    const snapshot = hub.snapshot();
    expect(snapshot.received).toBe(3);
    expect(snapshot.accepted).toBe(2);
    expect(snapshot.droppedByGuard).toBe(1);
    expect(snapshot.guard.masked).toBe(1);
    expect(snapshot.tier).toBe('quiet');
    hub.dispose();
  });
});

describe('时间注入简写', () => {
  it('三个类都可直接接收 now 函数而非 options 对象', () => {
    const clock = makeClock(5_000);

    const scheduler = new AttentionScheduler(() => clock.value);
    scheduler.ingest(ev({ text: '简写时钟', at: 5_000 }));
    expect(scheduler.pick().picks).toHaveLength(1);

    const guard = new Guard(() => clock.value);
    expect(guard.filter(ev({ text: '正常发言' })).action).toBe('pass');

    const hub = new LiveEventHub(() => clock.value);
    expect(hub.ingest(ev({ text: '中枢简写' })).status).toBe('accepted');
    expect(hub.flush().events).toHaveLength(1);
    hub.dispose();
  });
});
