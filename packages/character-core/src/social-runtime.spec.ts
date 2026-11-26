import { describe, expect, it } from 'vitest';
import type { SocialPlatformCapabilityEntry } from '@workbench/shared-protocol';
import { RuntimeEventBus } from '@workbench/runtime-core';
import { SocialRuntime, SocialAutostartScheduler, localDayKey, type SocialAutostartFacts } from './social-runtime';

const VERIFIED_READ: SocialPlatformCapabilityEntry = {
  platform: 'bilibili',
  capability: 'read_public',
  channel: 'official_api',
  allowed: true,
  riskLevel: 'P2',
  accountType: '',
  rateLimitNote: '',
  region: 'CN',
  lastVerifiedAt: 1_764_000_000_000,
  notes: '',
};

function makeRuntime(capabilities: SocialPlatformCapabilityEntry[] = [VERIFIED_READ], now: () => number = () => 1_764_000_000_000) {
  const events = new RuntimeEventBus({ now });
  const runtime = new SocialRuntime({
    characterId: 'char_xiaojing',
    profileId: 'prof-1',
    events,
    capabilities,
    now,
  });
  return { runtime, events };
}

describe('SocialRuntime L1 只读浏览内核（V2-P3-04C）', () => {
  it('规划→启动→浏览计数→达预算自动收官，全链路事件广播', () => {
    const { runtime, events } = makeRuntime();
    const session = runtime.planSession({ platform: 'bilibili', objective: '看看独立游戏', maxItems: 2 });
    expect(session.status).toBe('planned');
    expect(session.interactionMode).toBe('readonly');

    runtime.startSession(session.sessionId);
    runtime.recordViewed(session.sessionId, {
      candidateId: 'c1',
      platform: 'bilibili',
      url: 'https://www.bilibili.com/video/BV1',
      contentKind: 'video',
      sourceKind: 'recommendation',
    });
    const done = runtime.recordViewed(session.sessionId, {
      candidateId: 'c2',
      platform: 'bilibili',
      url: 'https://www.bilibili.com/video/BV2',
      contentKind: 'video',
      sourceKind: 'recommendation',
    });
    expect(done.status).toBe('completed');
    expect(done.stopReason).toBe('budget_exhausted');
    expect(done.itemsViewed).toBe(2);
    expect(done.endedAt).toBeGreaterThan(0);

    const types = events.history(50, 'social.session.*').map((e) => e.type);
    expect(types).toEqual([
      'social.session.planned',
      'social.session.started',
      'social.session.viewed',
      'social.session.viewed',
      'social.session.completed',
    ]);
  });

  it('能力矩阵门禁：未授权 / 未实测 / L1 互动能力一律拒绝', () => {
    const { runtime } = makeRuntime();
    // 未声明能力的平台
    expect(() => runtime.planSession({ platform: 'douyin', objective: 'x' })).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    // 已授权但未实测（lastVerifiedAt=0）
    const unverified = makeRuntime([{ ...VERIFIED_READ, lastVerifiedAt: 0 }]);
    expect(() => unverified.runtime.planSession({ platform: 'bilibili', objective: 'x' })).toThrowError(/未实测/);
    // L1 互动能力直接拒绝
    expect(() => runtime.assertCapability('bilibili', 'comment_reply')).toThrowError(/L1 只读/);
    // L1 只读能力正常放行
    expect(runtime.assertCapability('bilibili', 'read_public').allowed).toBe(true);
  });

  it('时钟推进超过 maxDurationMs 自动按 budget_exhausted 收官', () => {
    let tick = 1_000_000;
    const { runtime } = makeRuntime([VERIFIED_READ], () => tick);
    const session = runtime.planSession({ platform: 'bilibili', objective: 'x', maxDurationMs: 60_000 });
    runtime.startSession(session.sessionId);
    tick += 30_000;
    expect(runtime.tick(session.sessionId).status).toBe('active');
    tick += 31_000;
    const done = runtime.tick(session.sessionId);
    expect(done.status).toBe('completed');
    expect(done.stopReason).toBe('budget_exhausted');
    // 已收官再 tick 不变
    expect(runtime.tick(session.sessionId).status).toBe('completed');
  });

  it('暂停 / 人工交接 / 恢复 / 主动收官与中止的状态机', () => {
    const { runtime } = makeRuntime();
    const session = runtime.planSession({ platform: 'bilibili', objective: 'x' });
    // planned 不能 pause / recordViewed
    expect(() => runtime.pause(session.sessionId)).toThrowError(expect.objectContaining({ code: 'LIFECYCLE_INVALID' }));
    runtime.startSession(session.sessionId);
    expect(runtime.pause(session.sessionId).status).toBe('paused');
    // paused 可恢复
    expect(runtime.startSession(session.sessionId).status).toBe('active');
    // CAPTCHA 人工交接
    expect(runtime.requestHumanHandoff(session.sessionId).status).toBe('awaiting_human');
    expect(runtime.startSession(session.sessionId).status).toBe('active');
    // 目标达成
    expect(runtime.complete(session.sessionId).stopReason).toBe('objective_met');
    // 幂等：重复 complete 不报错
    expect(runtime.complete(session.sessionId).status).toBe('completed');

    const s2 = runtime.planSession({ platform: 'bilibili', objective: 'y' });
    runtime.startSession(s2.sessionId);
    expect(runtime.abort(s2.sessionId, 'user_stopped').status).toBe('aborted');
    // 已收官后再 abort 幂等
    expect(runtime.abort(s2.sessionId, 'error').stopReason).toBe('user_stopped');
  });

  it('会话不存在抛 CHARACTER_NOT_FOUND；listSessions 返回全量', () => {
    const { runtime } = makeRuntime();
    expect(runtime.getSession('nope')).toBeUndefined();
    expect(() => runtime.startSession('nope')).toThrowError(expect.objectContaining({ code: 'CHARACTER_NOT_FOUND' }));
    runtime.planSession({ platform: 'bilibili', objective: 'a' });
    runtime.planSession({ platform: 'bilibili', objective: 'b' });
    expect(runtime.listSessions()).toHaveLength(2);
  });
});

describe('SocialRuntime 能力热更新（V2-P3-04E）', () => {
  it('updateCapabilities 后新矩阵立即生效', () => {
    const { runtime } = makeRuntime([]);
    expect(() => runtime.planSession({ platform: 'bilibili', objective: 'x' })).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    runtime.updateCapabilities([VERIFIED_READ]);
    const session = runtime.planSession({ platform: 'bilibili', objective: 'x' });
    expect(session.status).toBe('planned');
  });
});

const MIN = 60_000;

/** 本地时间构造（禁发时段按本地时区判定，测试必须用本地构造避免时区漂移） */
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute, 0, 0).getTime();

const facts = (patch: Partial<SocialAutostartFacts> = {}): SocialAutostartFacts => ({
  halted: false,
  userBusy: false,
  platformReady: true,
  executorReady: true,
  modelReady: true,
  activeSessionId: null,
  ...patch,
});

/** 固定随机序列：用于把间隔抖动变成确定值 */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

describe('SocialAutostartScheduler（V2-P3-04E 补·owner 口径）', () => {
  it('默认关闭：即使其它条件全满足也不发起', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 10) });
    const decision = scheduler.evaluate(facts());
    expect(decision.canStart).toBe(false);
    expect(decision.blockReason).toBe('autostart_off');
    expect(scheduler.settings().enabled).toBe(false);
  });

  it('默认参数与 owner 口径一致：每日 2 次 / 30 分钟 / 90–150 分钟 ±20% / 冷却 60 分钟 / 00–08 禁发 / 连续 2 次失败停发 / 单次 20 条 10 分钟 8 次理解', () => {
    const scheduler = new SocialAutostartScheduler();
    const s = scheduler.settings();
    expect(s.maxSessionsPerDay).toBe(2);
    expect(s.dailyBudgetMs).toBe(30 * MIN);
    expect(s.minIntervalMs).toBe(90 * MIN);
    expect(s.maxIntervalMs).toBe(150 * MIN);
    expect(s.jitterRatio).toBe(0.2);
    expect(s.cooldownMs).toBe(60 * MIN);
    expect(s.quietHoursStart).toBe(0);
    expect(s.quietHoursEnd).toBe(8);
    expect(s.maxConsecutiveFailures).toBe(2);
    expect(s.sessionMaxItems).toBe(20);
    expect(s.sessionMaxDurationMs).toBe(10 * MIN);
    expect(s.maxUnderstandingCalls).toBe(8);
  });

  it('夜间 00:00–08:00 完全禁发，08:00 整点放行', () => {
    let now = at(26, 0, 0);
    const scheduler = new SocialAutostartScheduler({ now: () => now });
    scheduler.updateSettings({ enabled: true });
    expect(scheduler.evaluate(facts()).blockReason).toBe('quiet_hours');

    now = at(26, 7, 59);
    expect(scheduler.evaluate(facts()).blockReason).toBe('quiet_hours');

    now = at(26, 8, 0);
    expect(scheduler.evaluate(facts()).canStart).toBe(true);
  });

  it('正在跑的会话跨过 00:00 要按 quiet_hours 收官', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 23, 50) });
    expect(scheduler.shouldAbortActive(at(26, 23, 59))).toBe(false);
    expect(scheduler.shouldAbortActive(at(27, 0, 0))).toBe(true);
    expect(scheduler.shouldAbortActive(at(27, 9, 0))).toBe(false);
  });

  it('禁发时段起止相同 = 不设禁发时段（避免整日禁发）', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 3) });
    scheduler.updateSettings({ enabled: true, quietHoursStart: 8, quietHoursEnd: 8 });
    expect(scheduler.evaluate(facts()).canStart).toBe(true);
  });

  it('跨午夜禁发（22:00–06:00）两侧都拦', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 23) });
    scheduler.updateSettings({ enabled: true, quietHoursStart: 22, quietHoursEnd: 6 });
    expect(scheduler.evaluate(facts()).blockReason).toBe('quiet_hours');
    const early = new SocialAutostartScheduler({ now: () => at(27, 5) });
    early.updateSettings({ enabled: true, quietHoursStart: 22, quietHoursEnd: 6 });
    expect(early.evaluate(facts()).blockReason).toBe('quiet_hours');
    const noon = new SocialAutostartScheduler({ now: () => at(27, 12) });
    noon.updateSettings({ enabled: true, quietHoursStart: 22, quietHoursEnd: 6 });
    expect(noon.evaluate(facts()).canStart).toBe(true);
  });

  it('暂停/急停 → life_halted，直接不触发', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 10) });
    scheduler.updateSettings({ enabled: true });
    expect(scheduler.evaluate(facts({ halted: true })).blockReason).toBe('life_halted');
  });

  it('已有会话在跑 → session_active', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 10) });
    scheduler.updateSettings({ enabled: true });
    expect(scheduler.evaluate(facts({ activeSessionId: 'bs-1' })).blockReason).toBe('session_active');
  });

  it('平台未实测 / 执行器未接入 / 模型不可用 / 用户忙 逐项拦截且原因各不相同', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 10) });
    scheduler.updateSettings({ enabled: true });
    expect(scheduler.evaluate(facts({ platformReady: false })).blockReason).toBe('platform_unverified');
    expect(scheduler.evaluate(facts({ executorReady: false })).blockReason).toBe('executor_not_ready');
    expect(scheduler.evaluate(facts({ modelReady: false })).blockReason).toBe('model_unavailable');
    expect(scheduler.evaluate(facts({ userBusy: true })).blockReason).toBe('user_busy');
    expect(scheduler.evaluate(facts()).canStart).toBe(true);
  });

  it('拦截原因带人话 detail，生活页可直接显示', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 3) });
    scheduler.updateSettings({ enabled: true });
    const decision = scheduler.evaluate(facts());
    expect(decision.detail).toContain('00:00');
    expect(decision.detail).toContain('08:00');
  });

  it('失败后冷却 60 分钟：冷却内拦、冷却后放行', () => {
    let now = at(26, 10);
    const scheduler = new SocialAutostartScheduler({ now: () => now });
    scheduler.updateSettings({ enabled: true });
    scheduler.noteStarted();
    scheduler.noteEnded({
      sessionId: 'bs-1',
      platform: 'bilibili',
      startedAt: now,
      endedAt: now + 5 * MIN,
      itemsViewed: 0,
      status: 'completed',
      stopReason: 'error',
    });
    expect(scheduler.evaluate(facts()).blockReason).toBe('cooldown');

    now = at(26, 11, 4);
    expect(scheduler.evaluate(facts()).blockReason).toBe('cooldown');

    now = at(26, 11, 6);
    expect(scheduler.evaluate(facts()).canStart).toBe(true);
  });

  it('连续 2 次失败当日停发，次日自动重置', () => {
    let now = at(26, 10);
    const scheduler = new SocialAutostartScheduler({ now: () => now });
    scheduler.updateSettings({ enabled: true });
    const fail = (id: string): void => {
      scheduler.noteStarted();
      scheduler.noteEnded({
        sessionId: id,
        platform: 'bilibili',
        startedAt: now,
        endedAt: now + MIN,
        itemsViewed: 0,
        status: 'completed',
        stopReason: 'error',
      });
      now += 61 * MIN;
    };
    fail('bs-1');
    expect(scheduler.evaluate(facts()).canStart).toBe(true);
    fail('bs-2');
    const blocked = scheduler.evaluate(facts());
    expect(blocked.blockReason).toBe('consecutive_failures');
    expect(blocked.detail).toContain('当日停发');

    const nextDay = new SocialAutostartScheduler({ now: () => at(27, 9) });
    // 同一个实例跨日重置
    now = at(27, 9);
    expect(scheduler.evaluate(facts()).canStart).toBe(true);
    expect(nextDay.evaluate(facts()).canStart).toBe(false); // 新实例仍默认关闭
  });

  it('中止（用户急停）走冷却但不计入连续失败', () => {
    let now = at(26, 10);
    const scheduler = new SocialAutostartScheduler({ now: () => now });
    scheduler.updateSettings({ enabled: true });
    scheduler.noteStarted();
    now += 2 * MIN;
    scheduler.noteEnded({
      sessionId: 'bs-1',
      platform: 'bilibili',
      startedAt: now - 2 * MIN,
      endedAt: now,
      itemsViewed: 3,
      status: 'aborted',
      stopReason: 'user_stopped',
    });
    expect(scheduler.snapshot(facts(), null).consecutiveFailures).toBe(0);
    expect(scheduler.evaluate(facts()).blockReason).toBe('cooldown');
  });

  it('成功会话后按 90–150 分钟 ±20% 抖动排下一次（固定随机序列可复算）', () => {
    const start = at(26, 10);
    let now = start;
    const scheduler = new SocialAutostartScheduler({ now: () => now, random: seq(0.5, 0.5) });
    scheduler.updateSettings({ enabled: true });
    scheduler.noteStarted();
    now = start + 5 * MIN;
    scheduler.noteEnded({
      sessionId: 'bs-1',
      platform: 'bilibili',
      startedAt: start,
      endedAt: now,
      itemsViewed: 4,
      status: 'completed',
      stopReason: 'budget_exhausted',
    });
    // base = 90 + 60*0.5 = 120 分钟；jitter = 120*0.2*(0.5*2-1) = 0 → 下次 = 收官 + 120 分钟
    const decision = scheduler.evaluate(facts());
    expect(decision.blockReason).toBe('interval_wait');
    expect(decision.nextEligibleAt).toBe(now + 120 * MIN);
  });

  it('抖动到下限时仍不短于冷却（72 分钟 > 60 分钟）', () => {
    const start = at(26, 10);
    let now = start;
    const scheduler = new SocialAutostartScheduler({ now: () => now, random: seq(0, 0) });
    scheduler.updateSettings({ enabled: true });
    scheduler.noteStarted();
    now = start + 5 * MIN;
    scheduler.noteEnded({
      sessionId: 'bs-1',
      platform: 'bilibili',
      startedAt: start,
      endedAt: now,
      itemsViewed: 2,
      status: 'completed',
      stopReason: 'objective_met',
    });
    expect(scheduler.evaluate(facts()).nextEligibleAt).toBe(now + 72 * MIN);
  });

  it('每日 ≤2 次：第 3 次直接拦', () => {
    let now = at(26, 9);
    const scheduler = new SocialAutostartScheduler({ now: () => now, random: seq(0.5, 0.5) });
    scheduler.updateSettings({ enabled: true });
    const run = (id: string): void => {
      scheduler.noteStarted();
      now += 2 * MIN;
      scheduler.noteEnded({
        sessionId: id,
        platform: 'bilibili',
        startedAt: now - 2 * MIN,
        endedAt: now,
        itemsViewed: 5,
        status: 'completed',
        stopReason: 'objective_met',
      });
      now += 121 * MIN;
    };
    run('bs-1');
    run('bs-2');
    const decision = scheduler.evaluate(facts());
    expect(decision.blockReason).toBe('daily_sessions_exhausted');
    expect(decision.detail).toContain('2 次');
  });

  it('每日累计 ≤30 分钟：用满后拦，剩余不足时把单次预算钳到剩余', () => {
    let now = at(26, 9);
    const scheduler = new SocialAutostartScheduler({ now: () => now, random: seq(0.5, 0.5) });
    scheduler.updateSettings({ enabled: true, maxSessionsPerDay: 6 });
    scheduler.noteStarted();
    now += 25 * MIN;
    scheduler.noteEnded({
      sessionId: 'bs-1',
      platform: 'bilibili',
      startedAt: now - 25 * MIN,
      endedAt: now,
      itemsViewed: 5,
      status: 'completed',
      stopReason: 'budget_exhausted',
    });
    now += 121 * MIN;
    const decision = scheduler.evaluate(facts());
    expect(decision.canStart).toBe(true);
    expect(decision.maxDurationMs).toBe(5 * MIN); // 30 - 25 = 5 分钟

    scheduler.noteStarted();
    now += 5 * MIN;
    scheduler.noteEnded({
      sessionId: 'bs-2',
      platform: 'bilibili',
      startedAt: now - 5 * MIN,
      endedAt: now,
      itemsViewed: 1,
      status: 'completed',
      stopReason: 'budget_exhausted',
    });
    now += 121 * MIN;
    expect(scheduler.evaluate(facts()).blockReason).toBe('daily_budget_exhausted');
  });

  it('跨日重置次数与用量，但昨夜的冷却不被绕过', () => {
    let now = at(26, 23);
    const scheduler = new SocialAutostartScheduler({ now: () => now });
    scheduler.updateSettings({ enabled: true, quietHoursStart: 2, quietHoursEnd: 3 });
    scheduler.noteStarted();
    now = at(26, 23, 30);
    scheduler.noteEnded({
      sessionId: 'bs-1',
      platform: 'bilibili',
      startedAt: at(26, 23),
      endedAt: now,
      itemsViewed: 0,
      status: 'completed',
      stopReason: 'error',
    });
    // 冷却到 00:30（次日），00:10 仍是冷却而不是「跨日就放行」
    now = at(27, 0, 10);
    expect(scheduler.evaluate(facts()).blockReason).toBe('cooldown');
    expect(scheduler.snapshot(facts(), null).today.sessions).toBe(0);
  });

  it('内容理解预算与单次预算透传给宿主', () => {
    const scheduler = new SocialAutostartScheduler({ now: () => at(26, 10) });
    scheduler.updateSettings({ enabled: true, sessionMaxItems: 12, maxUnderstandingCalls: 3 });
    const decision = scheduler.evaluate(facts());
    expect(decision.maxItems).toBe(12);
    expect(decision.maxUnderstandingCalls).toBe(3);
  });

  it('snapshot 给生活页四块真实数据（下次可发起 / 今日用量 / 最近 5 次 / 执行器状态）', () => {
    let now = at(26, 9);
    const scheduler = new SocialAutostartScheduler({ now: () => now, random: seq(0.5, 0.5) });
    scheduler.updateSettings({ enabled: true, maxSessionsPerDay: 6 });
    for (let i = 0; i < 6; i += 1) {
      scheduler.noteStarted();
      now += MIN;
      scheduler.noteEnded({
        sessionId: `bs-${i}`,
        platform: 'bilibili',
        startedAt: now - MIN,
        endedAt: now,
        itemsViewed: 1,
        status: 'completed',
        stopReason: 'objective_met',
        detail: `第 ${i} 次`,
      });
      now += 121 * MIN;
    }
    const snapshot = scheduler.snapshot(facts(), null);
    expect(snapshot.recent).toHaveLength(5);
    expect(snapshot.recent[4]?.sessionId).toBe('bs-5');
    expect(snapshot.today.sessions).toBe(6);
    expect(snapshot.today.usedMs).toBe(6 * MIN);
    expect(snapshot.executorReady).toBe(true);
    expect(snapshot.decision.nextEligibleAt).toBeGreaterThan(0);
  });

  it('设置非法值直接抛错（不做悄悄夹紧）', () => {
    const scheduler = new SocialAutostartScheduler();
    expect(() => scheduler.updateSettings({ maxSessionsPerDay: 0 })).toThrow();
    expect(() => scheduler.updateSettings({ jitterRatio: 0.9 })).toThrow();
  });

  it('minInterval > maxInterval 时归一化交换，不产生负区间', () => {
    const scheduler = new SocialAutostartScheduler();
    const next = scheduler.updateSettings({ minIntervalMs: 200 * MIN, maxIntervalMs: 100 * MIN });
    expect(next.minIntervalMs).toBe(100 * MIN);
    expect(next.maxIntervalMs).toBe(200 * MIN);
  });

  it('localDayKey 用本地日期而非 UTC', () => {
    expect(localDayKey(at(26, 0, 30))).toBe('2026-11-26');
    expect(localDayKey(at(26, 23, 30))).toBe('2026-11-26');
    expect(localDayKey(at(27, 0, 30))).toBe('2026-11-27');
  });
});
