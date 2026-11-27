import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LiveEngagementConfigSchema, NormalizedLiveEventSchema, PetDesktopPrefsSchema, type LiveEngagementConfig } from '@workbench/shared-protocol';
import { LiveEngagement } from './engagement';
import { LiveRuntimeV2 } from './live-runtime';

function event(eventType: 'FOLLOW' | 'GIFT' | 'LIKE' | 'ENTER_ROOM' | 'DANMAKU', uid = 'u1', payload = {}) {
  return NormalizedLiveEventSchema.parse({
    eventId: randomUUID(), platform: 'douyin', eventType,
    sender: { uid, nickname: uid }, payload, assignedPriority: 'P2_IDLE', timestamp: 1000,
  });
}
function engine(patch: Partial<LiveEngagementConfig> = {}) {
  const engine = new LiveEngagement();
  engine.configure({ enabled: true, globalCooldownMs: 1000, ...patch });
  engine.reset(1000);
  return engine;
}

describe('[SIMULATION] 确定性互动编排', () => {
  it('默认关闭、旧 prefs 自动补齐、拒绝重复规则 id 和非法增量', () => {
    const prefs = PetDesktopPrefsSchema.parse({});
    expect(prefs.liveEngagement.enabled).toBe(false);
    const rules = prefs.liveEngagement.rules;
    expect(LiveEngagementConfigSchema.safeParse({ rules: [rules[0], rules[0]] }).success).toBe(false);
    expect(NormalizedLiveEventSchema.safeParse({ ...event('LIKE'), payload: { likeCount: 0 } }).success).toBe(false);
    const disabled = new LiveEngagement();
    expect(disabled.ingest(event('LIKE', 'a', { likeCount: 100 }), 1000)).toEqual([]);
    expect(disabled.snapshot(1000).likes).toBe(0);
  });

  it('只匹配真实关注，不把进房或普通弹幕当关注；每用户/每规则冷却且有全局节流', () => {
    const e = engine();
    expect(e.ingest(event('ENTER_ROOM'), 1000)).toEqual([]);
    expect(e.ingest(event('DANMAKU'), 1000)).toEqual([]);
    expect(e.ingest(event('FOLLOW'), 1000)).toHaveLength(1);
    expect(e.ingest(event('FOLLOW', 'u2'), 1500)).toEqual([]); // 全局节流
    expect(e.ingest(event('FOLLOW', 'u2'), 2000)).toHaveLength(1);
    expect(e.ingest(event('FOLLOW'), 3000)).toEqual([]); // 同人冷却
    expect(e.ingest(event('FOLLOW'), 121000)).toHaveLength(1);
  });

  it('同一事件重复不累计、不触发；数量为增量，币值是事件合计不再乘份数', () => {
    const e = engine();
    const gift = event('GIFT', 'a', { giftCount: 3, giftDiamondValue: 9 });
    expect(e.ingest(gift, 1000)).toHaveLength(1);
    expect(e.ingest(gift, 200000)).toEqual([]);
    expect(e.snapshot(200000).leaderboard[0]).toMatchObject({ count: 3, value: 9 });
    e.ingest(event('LIKE', 'a', { likeCount: 12 }), 200000);
    e.ingest(event('LIKE', 'a', { mergedCount: 5 }), 200000);
    expect(e.snapshot(200000).likes).toBe(17);
  });

  it('礼物下限边界、未启用规则与不同规则冷却隔离', () => {
    const config = LiveEngagementConfigSchema.parse({});
    const e = engine({ rules: config.rules.map((rule) => rule.trigger === 'gift' ? { ...rule, minGiftValue: 9 } : rule) });
    expect(e.ingest(event('GIFT'), 1000)).toEqual([]);
    expect(e.ingest(event('GIFT', 'a', { giftDiamondValue: 8.9 }), 1000)).toEqual([]);
    expect(e.ingest(event('GIFT', 'a', { giftDiamondValue: 9 }), 1000)).toHaveLength(1);
    expect(e.ingest(event('FOLLOW', 'a'), 2000)).toHaveLength(1);
    e.configure({ enabled: true, rules: config.rules.map((rule) => ({ ...rule, enabled: false })) });
    expect(e.ingest(event('GIFT', 'b', { giftDiamondValue: 100 }), 999999)).toEqual([]);
  });

  it('阈值恰好/跨越只触发一次，保存/关闭再打开不会绕过，新的场次允许重来', () => {
    const e = engine({ likeGoal: 10 });
    expect(e.ingest(event('LIKE', 'a', { likeCount: 9 }), 1000)).toEqual([]);
    expect(e.ingest(event('LIKE'), 2000)).toHaveLength(1);
    expect(e.snapshot(2000).goalReached).toBe(true);
    const config = e.snapshot(2000).config;
    e.configure({ ...config, enabled: false });
    e.configure(config);
    expect(e.ingest(event('LIKE', 'b', { likeCount: 100 }), 200000)).toEqual([]);
    expect(e.snapshot(200000).likes).toBe(110);
    e.reset(300000);
    expect(e.ingest(event('LIKE', 'b', { likeCount: 15 }), 300000)).toHaveLength(1);
  });

  it('阈值触发被全局节流时不会伪报已表演，后续点赞可补发；重置仅影响点赞不影响榜单', () => {
    const e = engine({ likeGoal: 2, resetAfterMs: 60_000 });
    e.ingest(event('GIFT'), 1000);
    expect(e.ingest(event('LIKE', 'b', { likeCount: 2 }), 1500)).toEqual([]);
    expect(e.snapshot(1500).latestAction?.ruleId).toBe('gift-thanks');
    expect(e.ingest(event('LIKE', 'b'), 2000)).toHaveLength(1);
    expect(e.snapshot(61000)).toMatchObject({ likes: 0, goalReached: false, cycleStartedAt: 61000, latestAction: null });
    expect(e.snapshot(61000).leaderboard).toHaveLength(1);
    // 同一人的规则冷却跨周期仍保留，另一用户可触发新周期。
    expect(e.ingest(event('LIKE', 'b', { likeCount: 2 }), 61000)).toEqual([]);
    expect(e.ingest(event('LIKE', 'c'), 62000)).toHaveLength(1);
    expect(e.snapshot(181000).cycleStartedAt).toBe(181000);
  });

  it('榜单按份数/币值排序，同分同名次，Top N 截断，改名仍按 uid 累计', () => {
    const e = engine({ topN: 3 });
    e.ingest(event('GIFT', 'b', { giftCount: 2, giftDiamondValue: 9 }), 1000);
    e.ingest(event('GIFT', 'a', { mergedCount: 2, giftDiamondValue: 1 }), 1000);
    e.ingest(event('GIFT', 'c', { giftDiamondValue: 20 }), 1000);
    e.ingest(event('GIFT', 'd'), 1000);
    expect(e.snapshot(1000).leaderboard.map((r) => [r.nickname, r.rank, r.count])).toEqual([['a', 1, 2], ['b', 1, 2], ['c', 3, 1]]);
    e.configure({ ...e.snapshot(1000).config, leaderboardMetric: 'value' });
    expect(e.snapshot(1000).leaderboard.map((r) => r.nickname)).toEqual(['c', 'b', 'a']);
    const renamed = event('GIFT', 'a'); renamed.sender.nickname = '新昵称';
    e.ingest(renamed, 2000);
    expect(e.snapshot(2000).leaderboard[2]).toMatchObject({ nickname: '新昵称', count: 3 });
    expect(e.thanksScore('douyin', 'c')).toBe(20);
    expect(e.thanksScore('douyin', 'missing')).toBe(0);
    e.configure({ ...e.snapshot(2000).config, leaderboardMetric: 'count' });
    expect(e.thanksScore('douyin', 'a')).toBe(3);
  });

  it('规则文案来自生效配置且只陈述确定条件；快照不泄漏可变配置引用', () => {
    const e = engine();
    const before = e.snapshot(1000);
    expect(before.ruleCards.map((r) => r.text).join(' ')).toContain('任意礼物');
    expect(before.ruleCards.map((r) => r.text).join(' ')).toContain('15,000');
    e.configure({ ...before.config, rules: [{ ...before.config.rules[1]!, minGiftValue: 9, action: { type: 'song_request', title: '原创' } }] });
    expect(e.snapshot(1000).ruleCards[0]?.text).toContain('单次礼物合计 ≥ 9 币 → 提交点歌「原创」（须授权）');
    before.config.enabled = false;
    expect(e.snapshot(1000).config.enabled).toBe(true);
  });

  it('人数/去重/冷却有界，容量耗尽不会驱逐有效冷却；过期冷却可回收', () => {
    const e = engine({ rules: [{ ...LiveEngagementConfigSchema.parse({}).rules[1]!, cooldownMs: 86_400_000 }] });
    for (let i = 0; i < 10001; i++) e.ingest(event('GIFT', `u${i}`), 1000 + i * 1000);
    expect(e.snapshot(10_002_000).leaderboardLimited).toBe(true);
    expect(e.ingest(event('GIFT', 'new'), 10_003_000)).toEqual([]);
    expect(e.ingest(event('GIFT', 'u0'), 10_004_000)).toEqual([]);
    expect(e.ingest(event('GIFT', 'new'), 100_000_000)).toHaveLength(1);
  });
});

describe('[SIMULATION] LiveRuntime 真实入口连接', () => {
  it('只有开播才能累计/触发；重复/拒绝/护栏丢弃不触发；点赞不再冒充关注感谢', async () => {
    let now = 1000;
    const runtime = new LiveRuntimeV2({ characterId: 'test', now: () => now });
    runtime.engagement.configure({ enabled: true, likeGoal: 2, globalCooldownMs: 1000 });
    const listener = vi.fn();
    const dispose = runtime.subscribeEngagement(listener);
    runtime.ingestEvent(event('LIKE'));
    expect(runtime.obsStageSnapshot().engagement?.likes).toBe(0);
    await runtime.startSession({ platform: 'local_replay' });
    const like = event('LIKE', 'a', { likeCount: 2 });
    runtime.ingestEvent(like);
    runtime.ingestEvent(like);
    expect(runtime.flushGiftThanks()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.ingestEvent({});
    runtime.ingestEvent(event('DANMAKU', 'spam', { rawText: '加微信领福利' }));
    expect(listener).toHaveBeenCalledTimes(1);
    const summary = runtime.endSession();
    expect(summary?.followCount).toBe(0);
    runtime.ingestEvent(event('LIKE', 'b', { likeCount: 100 }));
    expect(runtime.obsStageSnapshot().engagement?.likes).toBe(2);
    await runtime.startSession({ platform: 'local_replay' });
    now += 200000;
    expect(runtime.obsStageSnapshot().engagement?.likes).toBe(0);
    runtime.emergencyHalt();
    runtime.ingestEvent(event('LIKE', 'c', { likeCount: 100 }));
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    runtime.hub.dispose();
  });

  it('点歌触发复用四重版权门禁，未知/无授权拒绝，授权只排队不假装真唱', async () => {
    let now = 1000;
    const runtime = new LiveRuntimeV2({ characterId: 'test', now: () => now });
    runtime.engagement.configure({ enabled: true, globalCooldownMs: 1000, rules: [{ id: 'song', trigger: 'gift', action: { type: 'song_request', title: '原创' } }] });
    // 展示端抛错不应中断事件收取。
    runtime.subscribeEngagement(() => { throw new Error('offline-view'); });
    await runtime.startSession({ platform: 'local_replay' });
    runtime.ingestEvent(event('GIFT', 'missing'));
    expect(runtime.snapshot().blockedSongLog[0]?.status).toBe('blocked_rights');
    runtime.registerCatalogSong({ songId: 'original', title: '原创', durationMs: 1000, rights: { songLicense: 'original_owned', accompanimentLicense: 'original_owned', lyricsLicense: 'original_owned', voiceModelAuthorized: true, voiceConsentSource: 'test-owner' } });
    now += 2000;
    runtime.ingestEvent(event('GIFT', 'licensed', { giftDiamondValue: 9 }));
    expect(runtime.snapshot().songQueue[0]).toMatchObject({ status: 'queued', priorityBoost: 9 });
    expect(runtime.obsStageSnapshot().activeSongTitle).toBeNull();
    const snap = runtime.obsStageSnapshot().engagement!;
    snap.latestAction!.action = { type: 'bubble', text: '不能篡改' };
    expect(runtime.obsStageSnapshot().engagement?.latestAction?.action.type).toBe('song_request');
    runtime.hub.dispose();
  });

  it('榜单优先顺序用于合并感谢；按 uid 排名不把并列/同昵称重复算成同一人', async () => {
    const runtime = new LiveRuntimeV2({ characterId: 'test', giftBatchThreshold: 10 });
    runtime.engagement.configure({ enabled: true });
    await runtime.startSession({ platform: 'local_replay' });
    runtime.ingestEvent(event('FOLLOW', '关注者'));
    runtime.ingestEvent(event('GIFT', '少量', { giftCount: 1, giftDiamondValue: 9 }));
    runtime.ingestEvent(event('GIFT', '多份', { giftCount: 3, giftDiamondValue: 9 }));
    const batch = runtime.flushGiftThanks();
    expect(batch?.senders).toEqual(['多份', '少量', '关注者']);
    expect(batch?.count).toBe(5);
    expect(batch?.totalValue).toBe(18);
    runtime.hub.dispose();
  });
});
