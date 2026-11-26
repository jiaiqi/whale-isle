import { describe, expect, it } from 'vitest';
import type { SocialPlatformCapabilityEntry } from '@workbench/shared-protocol';
import { RuntimeEventBus } from '@workbench/runtime-core';
import { SocialRuntime } from './social-runtime';

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
