import { describe, expect, it } from 'vitest';
import type { BrowseCandidate, SocialPlatformCapabilityEntry } from '@workbench/shared-protocol';
import { RuntimeEventBus, WhaleError } from '@workbench/runtime-core';
import { SocialRuntime } from './social-runtime';
import {
  LocalFixtureCandidateSource,
  SocialBrowseExecutor,
  describeSourceKind,
  type SocialBrowseCandidateSource,
} from './social-executor';

/**
 * 夹具环境自带的合成能力条目：只声明「generic_web 的 read_public 在测试里可用」，
 * 不构成对任何真实平台的授权声明（真实平台必须由 owner 逐项实测）。
 */
const FIXTURE_CAPABILITY: SocialPlatformCapabilityEntry = {
  platform: 'generic_web',
  capability: 'read_public',
  channel: 'browser_ui',
  allowed: true,
  riskLevel: 'P2',
  accountType: '',
  rateLimitNote: '',
  region: '',
  lastVerifiedAt: 1_764_000_000_000,
  notes: 'fixture-only',
};

const T0 = 1_764_000_000_000;

function candidate(i: number): BrowseCandidate {
  return {
    candidateId: `c${i}`,
    platform: 'generic_web',
    url: `https://example.test/post/${i}`,
    title: `第 ${i} 条`,
    previewText: '',
    contentKind: 'text',
    sourceKind: 'recommendation',
  };
}

function makeSetup(options: { maxItems?: number; maxDurationMs?: number; now?: () => number } = {}) {
  const now = options.now ?? (() => T0);
  const events = new RuntimeEventBus({ now });
  const runtime = new SocialRuntime({
    characterId: 'char_xiaojing',
    profileId: 'prof-1',
    events,
    capabilities: [FIXTURE_CAPABILITY],
    now,
  });
  const session = runtime.planSession({
    platform: 'generic_web',
    objective: '看看今天有什么值得留意的事',
    maxItems: options.maxItems ?? 10,
    maxDurationMs: options.maxDurationMs ?? 600_000,
  });
  runtime.startSession(session.sessionId);
  return { runtime, events, session };
}

function fixtureSource(count: number, platform: 'generic_web' | 'bilibili' = 'generic_web') {
  return new LocalFixtureCandidateSource(
    Array.from({ length: count }, (_, i) => candidate(i + 1)) as never,
    { platform },
  );
}

describe('SocialBrowseExecutor L1 执行器（候选来源 → 逐条读取 → 理解配额）', () => {
  it('默认拒绝运行本地夹具源：不允许把假数据链路当成已能浏览', async () => {
    const { runtime, session } = makeSetup();
    const executor = new SocialBrowseExecutor({ runtime });
    executor.registerSource(fixtureSource(2));
    await expect(executor.run({ sessionId: session.sessionId })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(runtime.getSession(session.sessionId)?.itemsViewed).toBe(0);
    expect(runtime.getSession(session.sessionId)?.status).toBe('active');
  });

  it('平台未授权/未实测一律拒绝：verified=false 的真实平台源在动手前抛错', async () => {
    const { runtime, session } = makeSetup();
    const source: SocialBrowseCandidateSource = {
      descriptor: { sourceId: 'bili-real', platform: 'generic_web', kind: 'platform', verified: false, note: '' },
      listCandidates: async () => [candidate(1)],
    };
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    executor.registerSource(source);
    await expect(executor.run({ sessionId: session.sessionId })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(runtime.getSession(session.sessionId)?.itemsViewed).toBe(0);
  });

  it('没有候选来源时拒绝发起，不伪造来源', async () => {
    const { runtime, session } = makeSetup();
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    await expect(executor.run({ sessionId: session.sessionId })).rejects.toBeInstanceOf(WhaleError);
    await expect(executor.run({ sessionId: session.sessionId })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('正常链路：逐条读取 → 计数 → 理解 → 目标达成收官，回执如实标夹具', async () => {
    const { runtime, session } = makeSetup({ maxItems: 5 });
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true, maxUnderstandingCalls: 8 });
    executor.registerSource(fixtureSource(3));
    const read: string[] = [];
    const understood: string[] = [];
    const summary = await executor.run({
      sessionId: session.sessionId,
      reader: {
        read: async (item) => {
          read.push(item.candidateId);
          return { textContent: `正文 ${item.candidateId}` };
        },
      },
      understander: {
        integrate: async ({ candidate: item, textContent }) => {
          understood.push(`${item.candidateId}:${textContent}`);
        },
      },
    });

    expect(summary).toMatchObject({
      sourceKind: 'local_fixture',
      candidatesConsidered: 3,
      itemsViewed: 3,
      understandingCalls: 3,
      understandingSkipped: 0,
      understandingFailures: 0,
      status: 'completed',
      stopReason: 'objective_met',
    });
    expect(read).toEqual(['c1', 'c2', 'c3']);
    expect(understood).toHaveLength(3);
    expect(summary.detail).toContain('本地夹具');
    expect(runtime.getSession(session.sessionId)?.itemsViewed).toBe(3);
  });

  it('条目配额耗尽：maxItems 用满即按 budget_exhausted 收官，多余候选不再读取', async () => {
    const { runtime, session } = makeSetup({ maxItems: 2 });
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    executor.registerSource(fixtureSource(5));
    const read: string[] = [];
    const summary = await executor.run({
      sessionId: session.sessionId,
      reader: {
        read: async (item) => {
          read.push(item.candidateId);
          return { textContent: 'x' };
        },
      },
    });
    expect(read).toEqual(['c1', 'c2']);
    expect(summary.itemsViewed).toBe(2);
    expect(summary.status).toBe('completed');
    expect(summary.stopReason).toBe('budget_exhausted');
  });

  it('理解调用超限：配额用尽后只记浏览事实，一次模型调用都不再发', async () => {
    const { runtime, session } = makeSetup({ maxItems: 10 });
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    executor.registerSource(fixtureSource(5));
    let modelCalls = 0;
    const summary = await executor.run({
      sessionId: session.sessionId,
      maxUnderstandingCalls: 2,
      reader: { read: async () => ({ textContent: '正文' }) },
      understander: {
        integrate: async () => {
          modelCalls += 1;
        },
      },
    });
    expect(modelCalls).toBe(2);
    expect(summary.understandingCalls).toBe(2);
    expect(summary.understandingSkipped).toBe(3);
    expect(summary.itemsViewed).toBe(5);
    expect(summary.stopReason).toBe('objective_met');
  });

  it('理解失败也计入配额，记为失败但不中止会话', async () => {
    const { runtime, session } = makeSetup({ maxItems: 10 });
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    executor.registerSource(fixtureSource(3));
    const summary = await executor.run({
      sessionId: session.sessionId,
      maxUnderstandingCalls: 1,
      reader: { read: async () => ({ textContent: '正文' }) },
      understander: {
        integrate: async () => {
          throw new Error('模型网关未就绪');
        },
      },
    });
    expect(summary.understandingCalls).toBe(1);
    expect(summary.understandingFailures).toBe(1);
    expect(summary.understandingSkipped).toBe(2);
    expect(summary.itemsViewed).toBe(3);
    expect(summary.status).toBe('completed');
    expect(summary.detail).toContain('模型网关未就绪');
  });

  it('用户中途打断：下一次循环前即按 user_stopped 中止，不再读下一条', async () => {
    const { runtime, events, session } = makeSetup({ maxItems: 10 });
    const executor = new SocialBrowseExecutor({
      runtime,
      allowLocalFixture: true,
      isInterrupted: () => runtime.getSession(session.sessionId)?.itemsViewed === 1,
    });
    executor.registerSource(fixtureSource(5));
    const read: string[] = [];
    const summary = await executor.run({
      sessionId: session.sessionId,
      reader: {
        read: async (item) => {
          read.push(item.candidateId);
          return { textContent: 'x' };
        },
      },
    });
    expect(read).toEqual(['c1']);
    expect(summary.itemsViewed).toBe(1);
    expect(summary.status).toBe('aborted');
    expect(summary.stopReason).toBe('user_stopped');
    expect(summary.detail).toContain('中途打断');
    expect(events.history(50, 'social.session.*').some((e) => e.type === 'social.session.aborted')).toBe(true);
  });

  it('逐条读取失败不计入已浏览条目，继续下一条', async () => {
    const { runtime, session } = makeSetup({ maxItems: 10 });
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    executor.registerSource(fixtureSource(3));
    const summary = await executor.run({
      sessionId: session.sessionId,
      reader: {
        read: async (item) => {
          if (item.candidateId === 'c2') throw new Error('页面打不开');
          return { textContent: 'x' };
        },
      },
    });
    expect(summary.itemsViewed).toBe(2);
    expect(summary.readFailures).toBe(1);
    expect(summary.detail).toContain('页面打不开');
  });

  it('时长预算到点即收官，不再继续读取', async () => {
    let now = T0;
    const { runtime, session } = makeSetup({ maxItems: 10, maxDurationMs: 10_000, now: () => now });
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    executor.registerSource(fixtureSource(5));
    const read: string[] = [];
    const summary = await executor.run({
      sessionId: session.sessionId,
      reader: {
        read: async (item) => {
          read.push(item.candidateId);
          now += 6_000;
          return { textContent: 'x' };
        },
      },
    });
    expect(read).toEqual(['c1', 'c2']);
    expect(summary.itemsViewed).toBe(2);
    expect(summary.stopReason).toBe('budget_exhausted');
  });

  it('执行器自述：只有「真实平台 + 已实测」才 runnable，夹具源永远不置真', () => {
    const { runtime } = makeSetup();
    const executor = new SocialBrowseExecutor({ runtime, allowLocalFixture: true });
    expect(executor.status()).toEqual({ wired: true, sources: [], runnable: false });

    executor.registerSource(fixtureSource(1));
    expect(executor.status().runnable).toBe(false);
    expect(executor.status().sources[0]).toMatchObject({ kind: 'local_fixture', verified: false });

    executor.registerSource({
      descriptor: { sourceId: 'bili-api', platform: 'bilibili', kind: 'platform', verified: true, note: '已实测' },
      listCandidates: async () => [],
    } as SocialBrowseCandidateSource);
    expect(executor.status().runnable).toBe(true);
    expect(executor.unregisterSource('bilibili')).toBe(true);
    expect(executor.status().runnable).toBe(false);
  });

  it('来源种类文案统一口径，不许出现「已能浏览网页」', () => {
    expect(describeSourceKind('local_fixture')).toBe('本地夹具（未接真实平台）');
    expect(describeSourceKind('platform')).toBe('真实平台');
  });
});
