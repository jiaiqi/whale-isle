import { describe, expect, it, vi } from 'vitest';
import type { BrowseCandidate, SocialPlatformCapabilityEntry } from '@workbench/shared-protocol';
import { RuntimeEventBus } from '@workbench/runtime-core';
import {
  DOUYIN_FEED_URLS,
  DOUYIN_PUBLIC_FEED_URL,
  DOUYIN_SMOKE_MIN_ITEMS,
  DouyinBrowseCandidateSource,
  DouyinBrowseEvidenceSchema,
  buildDouyinItemText,
  detectDouyinBlock,
  douyinFeedKindFromUrl,
  extractDouyinTopics,
  isDouyinEvidenceUsable,
  isDouyinRequestedFeedVerified,
  parseDouyinCardText,
  runDouyinSmoke,
  type DouyinPageSnapshot,
  type DouyinWebSession,
} from './social-douyin';
import { SocialBrowseExecutor } from './social-executor';
import { SocialRuntime } from './social-runtime';

const T0 = 1_764_000_000_000;
const VIDEO_BASE = '76814179753662743';

/** 测试专用合成能力：只声明「douyin/read_public 在单测里已授权+已实测」，不构成对真实平台的人工验收声明 */
const DOUYIN_CAPABILITY: SocialPlatformCapabilityEntry = {
  platform: 'douyin',
  capability: 'read_public',
  channel: 'browser_ui',
  allowed: true,
  riskLevel: 'P1',
  accountType: '',
  rateLimitNote: '只读公开页，单会话 ≤20 条/10 分钟',
  region: '',
  lastVerifiedAt: T0,
  notes: 'test-only',
};

class FakeDouyinWeb implements DouyinWebSession {
  readonly loads: string[] = [];
  readonly openFeedCalls: string[] = [];
  loginChecks = 0;
  loginWindowOpened = 0;

  constructor(
    private readonly pages: Record<string, DouyinPageSnapshot>,
    private readonly login = { loggedIn: false },
  ) {}

  async load(url: string): Promise<DouyinPageSnapshot> {
    this.loads.push(url);
    const page = this.pages[url];
    if (!page) throw new Error(`测试未提供页面：${url}`);
    return page;
  }

  /** 测试里等价于直接 load 对应 URL；真实宿主会为推荐流在页内点「推荐」标签 */
  async openFeed(feed: Parameters<NonNullable<DouyinWebSession['openFeed']>>[0]): Promise<DouyinPageSnapshot> {
    this.openFeedCalls.push(feed);
    return this.load(DOUYIN_FEED_URLS[feed]);
  }

  async loginState(): Promise<{ loggedIn: boolean }> {
    this.loginChecks += 1;
    return this.login;
  }

  async openLoginWindow(): Promise<void> {
    this.loginWindowOpened += 1;
  }
}

function videoPage(index: number): DouyinPageSnapshot {
  const id = `${VIDEO_BASE}${index}`;
  return {
    url: `https://www.douyin.com/video/${id}`,
    title: `第 ${index} 集：公开科普 #科普 - 抖音`,
    text: '精选\n推荐\n扫码登录\n第 1 集：公开科普 #科普\n2.9万\n发布时间：2026-09-04 18:00\n登录后即可参与互动讨论',
    cards: [],
    heading: `第 ${index} 集：公开科普 #科普`,
    author: `公开作者${index}`,
    publishTimeText: '发布时间：2026-09-04 18:00',
    detailText: `第 ${index} 集：公开科普 #科普\n2.9万\n811\n发布时间：2026-09-04 18:00`,
  };
}

function feedPage(count: number, options: { text?: string; url?: string } = {}): DouyinPageSnapshot {
  return {
    url: options.url ?? DOUYIN_PUBLIC_FEED_URL,
    title: '抖音精选电脑版',
    text: options.text ?? '精选\n推荐\n关注\n登录',
    cards: Array.from({ length: count }, (_, i) => ({
      videoId: `${VIDEO_BASE}${i}`,
      text: `07:47\n2.9万\n第 ${i} 条公开视频 #科普\n@公开作者${i}\n · 9月4日`,
    })),
  };
}

function buildWeb(count: number, extra: { feed?: Partial<DouyinPageSnapshot> } = {}): FakeDouyinWeb {
  const pages: Record<string, DouyinPageSnapshot> = {
    [DOUYIN_PUBLIC_FEED_URL]: { ...feedPage(count), ...extra.feed },
  };
  for (let i = 0; i < count; i += 1) {
    const page = videoPage(i);
    pages[page.url] = page;
  }
  return new FakeDouyinWeb(pages);
}

function makeSetup(options: {
  web: FakeDouyinWeb;
  verified?: boolean;
  maxItems?: number;
  maxUnderstandingCalls?: number;
  isInterrupted?: () => boolean;
  readIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = () => T0;
  const events = new RuntimeEventBus({ now });
  const runtime = new SocialRuntime({
    characterId: 'char_xiaojing',
    profileId: 'prof-douyin',
    events,
    capabilities: [DOUYIN_CAPABILITY],
    now,
  });
  const source = new DouyinBrowseCandidateSource(options.web, {
    verified: options.verified ?? true,
    readIntervalMs: options.readIntervalMs ?? 0,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    now,
  });
  const executor = new SocialBrowseExecutor({
    runtime,
    allowLocalFixture: false,
    maxUnderstandingCalls: options.maxUnderstandingCalls ?? 8,
    ...(options.isInterrupted === undefined ? {} : { isInterrupted: options.isInterrupted }),
  });
  executor.registerSource(source);
  const session = runtime.planSession({
    platform: 'douyin',
    objective: '只读看看公开内容',
    maxItems: options.maxItems ?? 10,
    maxDurationMs: 600_000,
  });
  runtime.startSession(session.sessionId);
  return { source, executor, runtime, session, events };
}

describe('抖音公开内容字段抽取', () => {
  it('卡片文本：忽略时长/播放量/日期，抽出标题与公开昵称', () => {
    const parsed = parseDouyinCardText('07:47\n2.9万\n第 22 集：假如海洋出现一只沧龙 #沧龙 #科普\n@未知编辑部\n · 9月4日');
    expect(parsed.title).toBe('第 22 集：假如海洋出现一只沧龙 #沧龙 #科普');
    expect(parsed.authorAlias).toBe('未知编辑部');
  });

  it('话题抽取去重且最多 10 个', () => {
    expect(extractDouyinTopics('#科普 #科普 #沧龙 正文', '#史前巨兽')).toEqual(['科普', '沧龙', '史前巨兽']);
    const many = Array.from({ length: 15 }, (_, i) => `#话题${i}`).join(' ');
    expect(extractDouyinTopics(many)).toHaveLength(10);
  });

  it('视频页文本只保留公开字段，并带标题/作者/发布时间/话题', () => {
    const text = buildDouyinItemText(videoPage(2));
    expect(text).toContain('标题：第 2 集：公开科普 #科普');
    expect(text).toContain('作者：公开作者2');
    expect(text).toContain('发布时间：2026-09-04 18:00');
    expect(text).toContain('话题：科普');
    expect(text).not.toContain('扫码登录');
  });

  it('只把验证码/风控页判为必须停下的门槛；可读页面上的登录入口不误判', () => {
    expect(detectDouyinBlock({ title: '安全验证', text: '请完成验证码' })?.kind).toBe('captcha');
    expect(detectDouyinBlock({ title: '验证码中间页', text: '    ' })?.kind).toBe('captcha');
    expect(detectDouyinBlock({ title: '抖音精选', text: '精选 推荐 登录' })).toBeNull();
    expect(detectDouyinBlock({ title: '视频', text: '登录后即可参与互动讨论' })?.kind).toBe('login');
  });

  it('验证码文案给 owner 可操作的恢复指引：停止、保留窗口、处理后重新发起', () => {
    const block = detectDouyinBlock({ title: '验证码中间页', text: '' });
    expect(block?.kind).toBe('captcha');
    expect(block?.detail).toContain('窗口已保留');
    expect(block?.detail).toContain('手动完成后重新发起');
    expect(block?.detail).toContain('未重试');
  });
});

describe('抖音候选来源', () => {
  it('从公开精选页产出候选：URL/标题/作者/来源类型正确，去重并遵守 limit', async () => {
    const web = buildWeb(4);
    const source = new DouyinBrowseCandidateSource(web, { verified: true });
    const candidates = await source.listCandidates({ objective: '看看', limit: 3 });
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({
      platform: 'douyin',
      contentKind: 'video',
      sourceKind: 'recommendation',
      title: '第 0 条公开视频 #科普',
    });
    expect(candidates[0]!.url).toBe(`https://www.douyin.com/video/${VIDEO_BASE}0`);
    expect(candidates[0]!.previewText).toContain('@公开作者0');
    expect(web.loads).toEqual([DOUYIN_PUBLIC_FEED_URL]);
  });

  it('零候选且页面是登录墙 → 动手前抛 PERMISSION_DENIED（LOGIN_REQUIRED），不伪造候选', async () => {
    const web = buildWeb(0, { feed: { text: '扫码登录\n登录后查看' } });
    const source = new DouyinBrowseCandidateSource(web, { verified: true });
    await expect(source.listCandidates({ objective: '看看', limit: 5 })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      context: { platform: 'douyin', reason: 'LOGIN_REQUIRED' },
    });
  });

  it('触发验证码 → 立即抛错，绝不继续读', async () => {
    const web = buildWeb(3, { feed: { title: '安全验证', text: '请完成人机验证' } });
    const source = new DouyinBrowseCandidateSource(web, { verified: true });
    await expect(source.listCandidates({ objective: '看看', limit: 3 })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      context: { platform: 'douyin', reason: 'CAPTCHA_REQUIRED' },
    });
    expect(web.loads).toHaveLength(1);
  });

  it('验证码中间页（正文为空、只有标题）也立即停下，不继续读候选', async () => {
    const web = buildWeb(3, { feed: { title: '验证码中间页', text: '    ', cards: [] } });
    const source = new DouyinBrowseCandidateSource(web, { verified: true, feed: 'recommended', readIntervalMs: 0 });
    await expect(source.listCandidates({ objective: '看看', limit: 3 })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      context: { platform: 'douyin', reason: 'CAPTCHA_REQUIRED' },
    });
    expect(web.loads).toHaveLength(1);
  });

  it('逐条读取按 readIntervalMs 限速（两次读取之间等待一次）', async () => {
    const sleeps: number[] = [];
    const web = buildWeb(3);
    const source = new DouyinBrowseCandidateSource(web, {
      verified: true,
      readIntervalMs: 2_500,
      now: () => T0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const candidates = await source.listCandidates({ objective: '看看', limit: 3 });
    await source.read(candidates[0]!);
    await source.read(candidates[1]!);
    expect(sleeps).toEqual([2_500]);
  });
});

describe('抖音源接入执行器（假 Web 会话，不联网）', () => {
  it('未实测来源：动手前 PERMISSION_DENIED，页面一次都不打开', async () => {
    const web = buildWeb(3);
    const { executor, session, runtime } = makeSetup({ web, verified: false });
    await expect(executor.run({ sessionId: session.sessionId })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(web.loads).toHaveLength(0);
    expect(runtime.getSession(session.sessionId)?.itemsViewed).toBe(0);
    expect(executor.status().runnable).toBe(false);
  });

  it('配额耗尽：maxItems=2 / 5 条候选 → 只读 2 条并按 budget_exhausted 收官', async () => {
    const web = buildWeb(5);
    const { source, executor, session } = makeSetup({ web, maxItems: 2 });
    const summary = await executor.run({ sessionId: session.sessionId, reader: source });
    expect(summary.itemsViewed).toBe(2);
    expect(summary.status).toBe('completed');
    expect(summary.stopReason).toBe('budget_exhausted');
  });

  it('理解超限：maxUnderstandingCalls=1 / 4 条 → 只理解 1 条、跳过 3 条', async () => {
    const web = buildWeb(4);
    const { source, executor, session } = makeSetup({ web, maxUnderstandingCalls: 1 });
    const integrate = vi.fn(async () => undefined);
    const summary = await executor.run({ sessionId: session.sessionId, reader: source, understander: { integrate } });
    expect(summary.itemsViewed).toBe(4);
    expect(summary.understandingCalls).toBe(1);
    expect(summary.understandingSkipped).toBe(3);
    expect(integrate).toHaveBeenCalledTimes(1);
  });

  it('用户中途打断：读完第 1 条后立即 abort(user_stopped)，不再读第 2 条', async () => {
    const web = buildWeb(4);
    let checks = 0;
    const { source, executor, session, runtime } = makeSetup({
      web,
      isInterrupted: () => {
        checks += 1;
        return checks > 1;
      },
    });
    const summary = await executor.run({ sessionId: session.sessionId, reader: source });
    expect(summary.itemsViewed).toBe(1);
    expect(summary.status).toBe('aborted');
    expect(summary.stopReason).toBe('user_stopped');
    expect(runtime.getSession(session.sessionId)?.status).toBe('aborted');
    expect(web.loads.filter((url) => url.includes('/video/'))).toHaveLength(1);
  });

  it('可恢复的逐条读取失败不计入已浏览条目，继续读下一条并如实记账', async () => {
    const patched = new FakeDouyinWeb({
      [DOUYIN_PUBLIC_FEED_URL]: feedPage(2),
      [videoPage(0).url]: videoPage(0),
      // videoPage(1) 故意缺失 → 读取抛通用错误（可恢复路径）
    });
    const { source, executor, session } = makeSetup({ web: patched, maxItems: 2 });
    const summary = await executor.run({ sessionId: session.sessionId, reader: source });
    expect(summary.itemsViewed).toBe(1);
    expect(summary.readFailures).toBe(1);
    expect(summary.detail).toContain('测试未提供页面');
    expect(patched.loads.filter((url) => url.includes('/video/'))).toHaveLength(2);
  });

  it('风控/验证码页：第一次读取即按 error 中止，不换下一条硬刷', async () => {
    const broken = videoPage(0);
    delete (broken as { detailText?: string }).detailText;
    delete (broken as { heading?: string }).heading;
    broken.text = '请完成安全验证';
    const patched = new FakeDouyinWeb({
      [DOUYIN_PUBLIC_FEED_URL]: feedPage(2),
      [broken.url]: broken,
      [videoPage(1).url]: videoPage(1),
    });
    const { source, executor, session } = makeSetup({ web: patched, maxItems: 2 });
    const summary = await executor.run({ sessionId: session.sessionId, reader: source });
    expect(summary.itemsViewed).toBe(0);
    expect(summary.readFailures).toBe(1);
    expect(summary.status).toBe('aborted');
    expect(summary.stopReason).toBe('error');
    expect(summary.detail).toContain('验证码');
    expect(patched.loads.filter((url) => url.includes('/video/'))).toHaveLength(1);
  });
});

describe('真实冒烟证据', () => {
  it('读到 ≥N 条公开内容 → ok=true 并落时间/条数/耗时/样例', async () => {
    const web = buildWeb(5);
    const source = new DouyinBrowseCandidateSource(web, { verified: false, readIntervalMs: 0, now: () => T0 });
    let tick = T0;
    const evidence = await runDouyinSmoke(source, { limit: 3, now: () => (tick += 1_500) });
    expect(evidence.ok).toBe(true);
    expect(evidence.itemsRead).toBe(DOUYIN_SMOKE_MIN_ITEMS);
    expect(evidence.candidates).toBeGreaterThanOrEqual(3);
    expect(evidence.readFailures).toBe(0);
    expect(evidence.durationMs).toBeGreaterThan(0);
    expect(evidence.samples[0]).toMatchObject({ authorAlias: '公开作者0' });
    expect(isDouyinEvidenceUsable(evidence, T0 + 1_000)).toBe(true);
    expect(isDouyinEvidenceUsable(evidence, T0 + 8 * 24 * 3_600_000)).toBe(false);
  });

  it('风控/零候选 → ok=false 且失败原因如实记录，不置真', async () => {
    const web = buildWeb(0, { feed: { title: '安全验证', text: '请完成验证码' } });
    const source = new DouyinBrowseCandidateSource(web, { verified: false, readIntervalMs: 0, now: () => T0 });
    const evidence = await runDouyinSmoke(source, { limit: 3, now: () => T0 + 800 });
    expect(evidence.ok).toBe(false);
    expect(evidence.itemsRead).toBe(0);
    expect(evidence.failureReason).toContain('验证码');
    expect(isDouyinEvidenceUsable(evidence, T0)).toBe(false);
  });

  it('证据有效时执行器 runnable=true，过期后回到未实测', async () => {
    const web = buildWeb(3);
    const source = new DouyinBrowseCandidateSource(web, { verified: true });
    const runtime = new SocialRuntime({
      characterId: 'char_xiaojing',
      profileId: 'prof',
      events: new RuntimeEventBus({ now: () => T0 }),
      capabilities: [DOUYIN_CAPABILITY],
      now: () => T0,
    });
    const executor = new SocialBrowseExecutor({ runtime });
    executor.registerSource(source);
    expect(executor.status().runnable).toBe(true);
    const expired = new DouyinBrowseCandidateSource(web, { verified: isDouyinEvidenceUsable(null) });
    executor.registerSource(expired);
    expect(executor.status().runnable).toBe(false);
  });
});

describe('个性化信息流与未登录回落', () => {
  const RECOMMENDED_URL = DOUYIN_FEED_URLS.recommended;
  const FOLLOWING_URL = DOUYIN_FEED_URLS.following;

  it('最终 URL 能判出流；站外或未知路径不臆断', () => {
    expect(douyinFeedKindFromUrl('https://www.douyin.com/?recommend=1')).toBe('recommended');
    expect(douyinFeedKindFromUrl('https://www.douyin.com/')).toBe('recommended');
    expect(douyinFeedKindFromUrl('https://www.douyin.com/follow')).toBe('following');
    expect(douyinFeedKindFromUrl('https://www.douyin.com/jingxuan')).toBe('public');
    expect(douyinFeedKindFromUrl('https://www.douyin.com/video/123456789')).toBeNull();
    expect(douyinFeedKindFromUrl('https://example.com/?recommend=1')).toBeNull();
  });

  it('已登录请求推荐流 → 实际读推荐流，不回落', async () => {
    const web = new FakeDouyinWeb(
      {
        [RECOMMENDED_URL]: feedPage(3, { url: RECOMMENDED_URL }),
        [DOUYIN_PUBLIC_FEED_URL]: feedPage(1),
      },
      { loggedIn: true },
    );
    const source = new DouyinBrowseCandidateSource(web, { verified: true, feed: 'recommended', readIntervalMs: 0 });
    const candidates = await source.listCandidates({ objective: '看看', limit: 3 });
    expect(candidates).toHaveLength(3);
    expect(web.loads).toEqual([RECOMMENDED_URL]);
    expect(web.openFeedCalls).toEqual(['recommended']);
    expect(source.lastSelection).toMatchObject({
      requested: 'recommended',
      used: 'recommended',
      loggedIn: true,
      fallbackReason: '',
    });
    expect(source.feedUrl).toBe(RECOMMENDED_URL);
  });

  it('未登录请求推荐流 → 不打开个性化页，直接回落公开精选并如实标记 not_logged_in', async () => {
    const web = new FakeDouyinWeb({
      [RECOMMENDED_URL]: feedPage(3, { url: RECOMMENDED_URL }),
      [DOUYIN_PUBLIC_FEED_URL]: feedPage(2),
    });
    const source = new DouyinBrowseCandidateSource(web, { verified: true, feed: 'recommended', readIntervalMs: 0 });
    const candidates = await source.listCandidates({ objective: '看看', limit: 2 });
    expect(candidates).toHaveLength(2);
    expect(web.loads).toEqual([DOUYIN_PUBLIC_FEED_URL]);
    expect(source.lastSelection).toMatchObject({
      requested: 'recommended',
      used: 'public',
      loggedIn: false,
      fallbackReason: 'not_logged_in',
      detail: '未登录，已回落公开精选',
    });
    expect(source.feedUrl).toBe(DOUYIN_PUBLIC_FEED_URL);
  });

  it('登录态读取失败也按未登录回落，不假装已登录', async () => {
    const web = new FakeDouyinWeb({ [DOUYIN_PUBLIC_FEED_URL]: feedPage(2) });
    vi.spyOn(web, 'loginState').mockRejectedValue(new Error('cookie store unavailable'));
    const source = new DouyinBrowseCandidateSource(web, { verified: true, feed: 'recommended', readIntervalMs: 0 });
    await source.listCandidates({ objective: '看看', limit: 2 });
    expect(source.lastSelection).toMatchObject({ used: 'public', loggedIn: false, fallbackReason: 'not_logged_in' });
  });

  it('推荐流被平台重定向到精选 → 以最终 URL 为准，reason=platform_redirected', async () => {
    const web = new FakeDouyinWeb(
      {
        [RECOMMENDED_URL]: feedPage(3, { url: DOUYIN_PUBLIC_FEED_URL }),
        [DOUYIN_PUBLIC_FEED_URL]: feedPage(3),
      },
      { loggedIn: true },
    );
    const source = new DouyinBrowseCandidateSource(web, { verified: true, feed: 'recommended', readIntervalMs: 0 });
    const candidates = await source.listCandidates({ objective: '看看', limit: 3 });
    expect(candidates).toHaveLength(3);
    expect(web.loads).toEqual([RECOMMENDED_URL]);
    expect(source.lastSelection).toMatchObject({
      requested: 'recommended',
      used: 'public',
      loggedIn: true,
      fallbackReason: 'platform_redirected',
    });
  });

  it('推荐流零候选且是登录墙 → 回落公开精选并标记 login_wall', async () => {
    const web = new FakeDouyinWeb(
      {
        [RECOMMENDED_URL]: feedPage(0, { url: RECOMMENDED_URL, text: '扫码登录\n登录后查看推荐' }),
        [DOUYIN_PUBLIC_FEED_URL]: feedPage(2),
      },
      { loggedIn: true },
    );
    const source = new DouyinBrowseCandidateSource(web, { verified: true, feed: 'recommended', readIntervalMs: 0 });
    const candidates = await source.listCandidates({ objective: '看看', limit: 2 });
    expect(candidates).toHaveLength(2);
    expect(web.loads).toEqual([RECOMMENDED_URL, DOUYIN_PUBLIC_FEED_URL]);
    expect(source.lastSelection).toMatchObject({ used: 'public', fallbackReason: 'login_wall' });
  });

  it('关注流零候选且不是登录墙 → 回落公开精选并标记 empty_preferred', async () => {
    const web = new FakeDouyinWeb(
      {
        [FOLLOWING_URL]: feedPage(0, { url: FOLLOWING_URL, text: '关注\n暂时没有新内容' }),
        [DOUYIN_PUBLIC_FEED_URL]: feedPage(2),
      },
      { loggedIn: true },
    );
    const source = new DouyinBrowseCandidateSource(web, { verified: true, feed: 'following', readIntervalMs: 0 });
    const candidates = await source.listCandidates({ objective: '看看', limit: 2 });
    expect(candidates).toHaveLength(2);
    expect(source.lastSelection).toMatchObject({ used: 'public', fallbackReason: 'empty_preferred' });
  });

  it('个性化流回落产生的冒烟证据：仍可用，但不等于请求的流已验证', async () => {
    const pages: Record<string, DouyinPageSnapshot> = { [DOUYIN_PUBLIC_FEED_URL]: feedPage(3) };
    for (let i = 0; i < 3; i += 1) {
      const page = videoPage(i);
      pages[page.url] = page;
    }
    const web = new FakeDouyinWeb(pages);
    const source = new DouyinBrowseCandidateSource(web, { verified: false, readIntervalMs: 0, now: () => T0 });
    let tick = T0;
    const evidence = await runDouyinSmoke(source, { feed: 'recommended', limit: 3, now: () => (tick += 1_000) });
    expect(evidence.ok).toBe(true);
    expect(evidence.requestedFeed).toBe('recommended');
    expect(evidence.usedFeed).toBe('public');
    expect(evidence.loggedIn).toBe(false);
    expect(evidence.fallbackReason).toBe('not_logged_in');
    expect(evidence.feedUrl).toBe(DOUYIN_PUBLIC_FEED_URL);
    expect(isDouyinEvidenceUsable(evidence, T0 + 1_000)).toBe(true);
    expect(isDouyinRequestedFeedVerified(evidence, T0 + 1_000)).toBe(false);
  });

  it('已登录推荐流冒烟 → requestedFeed=usedFeed=recommended，请求流验证通过', async () => {
    const pages: Record<string, DouyinPageSnapshot> = {
      [RECOMMENDED_URL]: feedPage(3, { url: RECOMMENDED_URL }),
    };
    for (let i = 0; i < 3; i += 1) {
      const page = videoPage(i);
      pages[page.url] = page;
    }
    const web = new FakeDouyinWeb(pages, { loggedIn: true });
    const source = new DouyinBrowseCandidateSource(web, { verified: false, readIntervalMs: 0, now: () => T0 });
    let tick = T0;
    const evidence = await runDouyinSmoke(source, { feed: 'recommended', limit: 3, now: () => (tick += 1_000) });
    expect(evidence.ok).toBe(true);
    expect(evidence.itemsRead).toBe(DOUYIN_SMOKE_MIN_ITEMS);
    expect(evidence.requestedFeed).toBe('recommended');
    expect(evidence.usedFeed).toBe('recommended');
    expect(evidence.loggedIn).toBe(true);
    expect(evidence.fallbackReason).toBe('');
    expect(evidence.feedUrl).toBe(RECOMMENDED_URL);
    expect(isDouyinRequestedFeedVerified(evidence, T0 + 1_000)).toBe(true);
    expect(isDouyinRequestedFeedVerified(evidence, T0 + 8 * 24 * 3_600_000)).toBe(false);
  });

  it('旧证据没有 feed 字段时按公开精选解析，不炸也不冒充个性化已验证', async () => {
    const legacy = {
      schemaVersion: 1 as const,
      sourceId: 'douyin-public-jingxuan',
      feedUrl: DOUYIN_PUBLIC_FEED_URL,
      verifiedAt: T0,
      durationMs: 1_000,
      candidates: 3,
      itemsRead: 3,
      readFailures: 0,
      ok: true,
      failureReason: '',
      samples: [],
    };
    const parsed = DouyinBrowseEvidenceSchema.parse(legacy);
    expect(parsed.requestedFeed).toBe('public');
    expect(parsed.usedFeed).toBe('public');
    expect(parsed.loggedIn).toBe(false);
    expect(isDouyinRequestedFeedVerified(parsed, T0 + 1_000)).toBe(true);
  });
});

describe('候选类型对齐', () => {
  it('来源产出的候选可直接交给 runtime.recordViewed（契约字段齐全）', async () => {
    const web = buildWeb(1);
    const source = new DouyinBrowseCandidateSource(web, { verified: true });
    const [candidate] = await source.listCandidates({ objective: '看看', limit: 1 });
    const runtime = new SocialRuntime({
      characterId: 'char_xiaojing',
      profileId: 'prof',
      events: new RuntimeEventBus({ now: () => T0 }),
      capabilities: [DOUYIN_CAPABILITY],
      now: () => T0,
    });
    const session = runtime.planSession({ platform: 'douyin', objective: '看看', maxItems: 1 });
    runtime.startSession(session.sessionId);
    const viewed = runtime.recordViewed(session.sessionId, candidate as BrowseCandidate);
    expect(viewed.itemsViewed).toBe(1);
  });
});
