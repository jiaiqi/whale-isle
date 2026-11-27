import { describe, expect, it, vi } from 'vitest';
import type { BrowseCandidate, SocialCommentAction, SocialPlatformCapabilityEntry } from '@workbench/shared-protocol';
import { SocialCommentSettingsSchema } from '@workbench/shared-protocol';
import { RuntimeEventBus } from '@workbench/runtime-core';
import {
  DOUYIN_FEED_URLS,
  DOUYIN_PUBLIC_FEED_URL,
  DOUYIN_SMOKE_MIN_ITEMS,
  DouyinBrowseCandidateSource,
  DouyinBrowseEvidenceSchema,
  DouyinCommentExecutor,
  buildDouyinItemText,
  detectDouyinBlock,
  douyinFeedKindFromUrl,
  extractDouyinTopics,
  findNewDouyinComment,
  guardDouyinCommentText,
  isDouyinEvidenceUsable,
  isDouyinRequestedFeedVerified,
  isDouyinVideoUrl,
  isStableDouyinCommentId,
  normalizeDouyinUrl,
  parseDouyinCardText,
  runDouyinSmoke,
  type DouyinCommentComposer,
  type DouyinCommentLedgerPort,
  type DouyinCommentReceipt,
  type DouyinCommentThread,
  type DouyinPageSnapshot,
  type DouyinWebSession,
} from './social-douyin';
import { SocialBrowseExecutor } from './social-executor';
import { SocialRuntime } from './social-runtime';

const T0 = 1_764_000_000_000;
const NOON = new Date(2026, 10, 27, 12, 0, 0).getTime();
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

  it('隐藏 verify iframe 造成的正文验证码文案误报：DOM 无可见验证码元素时放行', async () => {
    const web = buildWeb(3, {
      feed: { title: '抖音精选电脑版', text: '精选 推荐 请完成验证', captchaVisible: false },
    });
    const source = new DouyinBrowseCandidateSource(web, { verified: true, readIntervalMs: 0 });
    const candidates = await source.listCandidates({ objective: '看看', limit: 3 });
    expect(candidates).toHaveLength(3);
  });

  it('真实「验证码中间页」（标题命中、正文为空）：即使没有可见元素也立即停，不当作误报', async () => {
    const web = buildWeb(3, { feed: { title: '验证码中间页', text: '', captchaVisible: false } });
    const source = new DouyinBrowseCandidateSource(web, { verified: true, readIntervalMs: 0 });
    await expect(source.listCandidates({ objective: '看看', limit: 3 })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      context: { platform: 'douyin', reason: 'CAPTCHA_REQUIRED' },
    });
    expect(web.loads).toHaveLength(1);
  });

  it('可见且够大的验证码元素：即使文案正常也立即停下', async () => {
    const web = buildWeb(3, { feed: { text: '精选 推荐 关注', captchaVisible: true } });
    const source = new DouyinBrowseCandidateSource(web, { verified: true, readIntervalMs: 0 });
    await expect(source.listCandidates({ objective: '看看', limit: 3 })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      context: { platform: 'douyin', reason: 'CAPTCHA_REQUIRED' },
    });
    expect(web.loads).toHaveLength(1);
  });

  it('限流文案不是误报：即使没有可见验证码元素也立即停下', async () => {
    const web = buildWeb(3, { feed: { title: '抖音', text: '访问过于频繁，请稍后再试', captchaVisible: false } });
    const source = new DouyinBrowseCandidateSource(web, { verified: true, readIntervalMs: 0 });
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

// ---------------------------------------------------------------------------
// V2-P3-04K：L3 受限自主评论互动
// ---------------------------------------------------------------------------

const COMMENT_CAPABILITY: SocialPlatformCapabilityEntry = {
  platform: 'douyin',
  capability: 'comment_reply',
  channel: 'browser_ui',
  allowed: true,
  riskLevel: 'P2',
  accountType: 'owner',
  rateLimitNote: 'test-only',
  region: '',
  lastVerifiedAt: T0,
  notes: 'test-only; 真实平台尚未验证',
};

function commentSettings(overrides: Record<string, unknown> = {}) {
  return SocialCommentSettingsSchema.parse({
    enabled: true,
    maxPerDay: 10,
    maxPerHour: 3,
    minIntervalMs: 180_000,
    minChars: 4,
    maxChars: 80,
    sameVideoCooldownMs: 30 * 24 * 3_600_000,
    quietHoursStart: 0,
    quietHoursEnd: 8,
    ...overrides,
  });
}

function commentCandidate(url = `https://www.douyin.com/video/${VIDEO_BASE}0`): BrowseCandidate {
  return {
    candidateId: 'douyin-comment-test',
    platform: 'douyin',
    url,
    title: '一条公开科普视频',
    previewText: '@公开作者0 · 一条公开科普视频',
    contentKind: 'video',
    sourceKind: 'recommendation',
  };
}

class MemoryCommentLedger implements DouyinCommentLedgerPort {
  readonly actions: SocialCommentAction[] = [];
  appendError: Error | null = null;

  countSentSince(ts: number): number {
    return this.actions.filter((a) => a.attemptedAt > 0 && a.attemptedAt >= ts).length;
  }

  lastSentAt(): number | null {
    const sent = this.actions.filter((a) => a.attemptedAt > 0);
    return sent.length === 0 ? null : Math.max(...sent.map((a) => a.attemptedAt));
  }

  hasCommentedVideo(videoId: string, since: number): boolean {
    return this.actions.some((a) => a.attemptedAt > 0 && a.videoId === videoId && a.attemptedAt >= since);
  }

  recentSentTexts(since: number): string[] {
    return this.actions.filter((a) => a.attemptedAt > 0 && a.attemptedAt >= since).map((a) => a.text);
  }

  append(action: SocialCommentAction): void {
    if (this.appendError) throw this.appendError;
    const idx = this.actions.findIndex(row => row.actionId === action.actionId);
    if (idx < 0) this.actions.push(action); else this.actions[idx] = action;
  }
}

class FakeCommentWeb {
  readonly readCalls: string[] = [];
  readonly postCalls: Array<{ url: string; text: string }> = [];
  thread: DouyinCommentThread = {
    url: `https://www.douyin.com/video/${VIDEO_BASE}0`,
    title: '公开科普视频 - 抖音',
    text: '评论区\n说点什么...',
    comments: [{ commentId: 'c1', authorAlias: '观众甲', text: '讲得真清楚' }],
    inputAvailable: true,
  };
  receipt: DouyinCommentReceipt = { ok: true, commentId: 'new-1', detail: '评论已发布' };
  readError: Error | null = null;
  postError: Error | null = null;

  async readComments(url: string): Promise<DouyinCommentThread> {
    this.readCalls.push(url);
    if (this.readError) throw this.readError;
    return { ...this.thread, url };
  }

  async postComment(input: { url: string; text: string }): Promise<DouyinCommentReceipt> {
    this.postCalls.push(input);
    if (this.postError) throw this.postError;
    return this.receipt;
  }
}

function commentRuntime(entries: SocialPlatformCapabilityEntry[] = [COMMENT_CAPABILITY]): SocialRuntime {
  return new SocialRuntime({
    characterId: 'char_xiaojing',
    profileId: 'prof',
    events: new RuntimeEventBus({ now: () => NOON }),
    capabilities: entries,
    autonomyLevel: 'l3_bounded',
    now: () => NOON,
  });
}

function buildCommentExecutor(options: {
  web?: FakeCommentWeb;
  ledger?: MemoryCommentLedger;
  compose?: DouyinCommentComposer['compose'];
  runtime?: SocialRuntime;
  now?: number;
  interrupted?: boolean;
  onError?: (message: string) => void;
} = {}) {
  const web = options.web ?? new FakeCommentWeb();
  const ledger = options.ledger ?? new MemoryCommentLedger();
  const executor = new DouyinCommentExecutor({
    web,
    ledger,
    runtime: options.runtime ?? commentRuntime(),
    composer: {
      compose:
        options.compose ??
        (async () => ({ shouldComment: true, text: '这个科普讲得很清楚，学到了', reason: '', modelId: 'test/model' })),
    },
    now: () => options.now ?? NOON,
    isInterrupted: () => options.interrupted ?? false,

  });
  return { executor, web, ledger };
}

describe('抖音评论本地护栏', () => {
  it('去掉链接与 @，保留正文', () => {
    const guard = guardDouyinCommentText('讲得好 @某人 见 https://x.test/a 学到了', commentSettings());
    expect(guard.ok).toBe(true);
    expect(guard.text).toBe('讲得好 见 学到了');
  });

  it('拒绝太短/太长/联系方式/手机号/重复', () => {
    expect(guardDouyinCommentText('好', commentSettings()).reason).toContain('太短');
    expect(guardDouyinCommentText('好'.repeat(81), commentSettings()).reason).toContain('太长');
    expect(guardDouyinCommentText('想聊的加微信一起玩', commentSettings()).reason).toContain('导流');
    expect(guardDouyinCommentText('联系我 13800138000', commentSettings()).reason).toContain('手机号');
    expect(guardDouyinCommentText('这个科普讲得很清楚', commentSettings(), ['这个科普讲得很清楚！']).reason).toContain('重复');
  });
});

describe('抖音评论执行器', () => {
  it('能力已实测且全部条件满足 → 真实发送并记账', async () => {
    const { executor, web, ledger } = buildCommentExecutor();
    const action = await executor.execute({
      sessionId: 's1',
      candidate: commentCandidate(),
      itemText: '标题：公开科普',
      settings: commentSettings(),
    });
    expect(action.status).toBe('sent');
    expect(action.text).toBe('这个科普讲得很清楚，学到了');
    expect(action.modelId).toBe('test/model');
    expect(web.postCalls).toHaveLength(1);
    expect(ledger.actions).toHaveLength(1);
  });

  it('默认关闭时直接跳过且不记账、不读页面', async () => {
    const { executor, web, ledger } = buildCommentExecutor();
    const action = await executor.execute({
      sessionId: 's1',
      candidate: commentCandidate(),
      itemText: '',
      settings: commentSettings({ enabled: false }),
    });
    expect(action.failureKind).toBe('disabled');
    expect(web.readCalls).toHaveLength(0);
    expect(ledger.actions).toHaveLength(1);
  });

  it('能力未实测 → 跳过，绝不发送', async () => {
    const { executor, web, ledger } = buildCommentExecutor({ runtime: commentRuntime([]) });
    const action = await executor.execute({
      sessionId: 's1',
      candidate: commentCandidate(),
      itemText: '',
      settings: commentSettings(),
    });
    expect(action.failureKind).toBe('capability_unverified');
    expect(web.postCalls).toHaveLength(0);
    expect(ledger.actions).toHaveLength(1);
  });

  it('禁发时段/急停/日额度/小时额度/间隔/同视频冷却都会拦下', async () => {
    const quiet = buildCommentExecutor({ now: new Date(2026, 10, 27, 3, 0, 0).getTime() });
    expect((await quiet.executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    })).failureKind).toBe('quiet_hours');

    const halted = buildCommentExecutor({ interrupted: true });
    expect((await halted.executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    })).failureKind).toBe('interrupted');

    const dailyLedger = new MemoryCommentLedger();
    dailyLedger.actions.push({ ...makeSentAction(NOON), actionId: 'a1' });
    const daily = buildCommentExecutor({ ledger: dailyLedger });
    expect((await daily.executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings({ maxPerDay: 1 }),
    })).failureKind).toBe('quota');

    const hourlyLedger = new MemoryCommentLedger();
    hourlyLedger.actions.push({ ...makeSentAction(NOON - 60_000), actionId: 'a2' });
    const hourly = buildCommentExecutor({ ledger: hourlyLedger });
    expect((await hourly.executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings({ maxPerHour: 1 }),
    })).failureKind).toBe('quota');

    const intervalLedger = new MemoryCommentLedger();
    intervalLedger.actions.push({ ...makeSentAction(NOON - 60_000), actionId: 'a3' });
    const interval = buildCommentExecutor({ ledger: intervalLedger });
    expect((await interval.executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    })).failureKind).toBe('quota');

    const videoLedger = new MemoryCommentLedger();
    videoLedger.actions.push({ ...makeSentAction(NOON - 86_400_000), actionId: 'a4' });
    const video = buildCommentExecutor({ ledger: videoLedger });
    expect((await video.executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    })).failureKind).toBe('quota');
  });

  it('验证码 / 未登录 / 页面异常 → failed，且不发送', async () => {
    const captchaWeb = new FakeCommentWeb();
    captchaWeb.thread = { ...captchaWeb.thread, title: '验证码中间页', text: '' };
    const captcha = await buildCommentExecutor({ web: captchaWeb }).executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(captcha.failureKind).toBe('captcha');
    expect(captchaWeb.postCalls).toHaveLength(0);

    const loginWeb = new FakeCommentWeb();
    loginWeb.thread = { ...loginWeb.thread, inputAvailable: false, text: '请先登录后发表评论' };
    const login = await buildCommentExecutor({ web: loginWeb }).executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(login.failureKind).toBe('login_required');

    const errorWeb = new FakeCommentWeb();
    errorWeb.readError = new Error('页面加载超时');
    const readError = await buildCommentExecutor({ web: errorWeb }).executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(readError.failureKind).toBe('page_error');
  });

  it('模型拒绝 / 模型异常 / 护栏拒绝', async () => {
    const declined = await buildCommentExecutor({
      compose: async () => ({ shouldComment: false, text: '', reason: '内容不适合评论' }),
    }).executor.execute({ sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings() });
    expect(declined.failureKind).toBe('model_declined');

    const unavailable = await buildCommentExecutor({
      compose: async () => { throw new Error('模型网关未就绪'); },
    }).executor.execute({ sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings() });
    expect(unavailable.failureKind).toBe('model_unavailable');

    const { executor, ledger } = buildCommentExecutor({
      compose: async () => ({ shouldComment: true, text: '加微信一起聊', reason: '', modelId: 'm' }),
    });
    const rejected = await executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(rejected.failureKind).toBe('guard_rejected');
    expect(ledger.actions).toHaveLength(1);
    expect(ledger.actions[0]!.status).toBe('skipped');
  });

  it('发送回执失败 / 发送撞验证码 / 发送抛错 → failed', async () => {
    const failWeb = new FakeCommentWeb();
    failWeb.receipt = { ok: false, detail: '发送按钮无响应' };
    const failed = await buildCommentExecutor({ web: failWeb }).executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(failed.failureKind).toBe('receipt_failed');

    const captchaWeb = new FakeCommentWeb();
    captchaWeb.receipt = { ok: false, detail: '发送后跳验证码', blocked: 'captcha' };
    const captcha = await buildCommentExecutor({ web: captchaWeb }).executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(captcha.failureKind).toBe('captcha');

    const throwWeb = new FakeCommentWeb();
    throwWeb.postError = new Error('按钮点击失败');
    const thrown = await buildCommentExecutor({ web: throwWeb }).executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(thrown.failureKind).toBe('receipt_failed');
    expect(thrown.status).toBe('uncertain');
  });

  it('账本写入失败必须停止，发送前无法落盘时绝不点击', async () => {
    const ledger = new MemoryCommentLedger();
    ledger.appendError = new Error('磁盘只读');
    const { executor, web } = buildCommentExecutor({ ledger });
    await expect(executor.execute({ sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings() }))
      .rejects.toThrow('磁盘只读');
    expect(web.postCalls).toHaveLength(0);
  });

  it('宿主未提供评论端口 → failed，不假装已发送', async () => {
    const ledger = new MemoryCommentLedger();
    const executor = new DouyinCommentExecutor({
      web: {},
      ledger,
      runtime: commentRuntime(),
      composer: { compose: async () => ({ shouldComment: true, text: '不错不错', reason: '' }) },
      now: () => NOON,
    });
    const action = await executor.execute({
      sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings(),
    });
    expect(action.failureKind).toBe('page_error');
  });
});

describe('评论撤销与回执持久化边界', () => {
  it('模型等待期间急停：取消旧结果；并发第二个执行请求不发送', async () => {
    let resolve!: (result: { shouldComment: boolean; text: string; reason: string }) => void;
    let composing!: () => void;
    const started = new Promise<void>(r => { composing = r; });
    const composition = new Promise<{ shouldComment: boolean; text: string; reason: string }>(r => { resolve = r; });
    let interrupted = false;
    const web = new FakeCommentWeb();
    const ledger = new MemoryCommentLedger();
    const executor = new DouyinCommentExecutor({ web, ledger, runtime: commentRuntime(), now: () => NOON,
      isInterrupted: () => interrupted, composer: { compose: async () => { composing(); return composition; } } });
    const input = { sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings() };
    const first = executor.execute(input);
    await started;
    expect((await executor.execute(input)).failureKind).toBe('busy');
    interrupted = true;
    resolve({ shouldComment: true, text: '这个解释很有帮助，学到了', reason: '' });
    expect((await first).failureKind).toBe('interrupted');
    expect(web.postCalls).toHaveLength(0);
  });
  it('点击之前 pending 已落盘；结果不明占用额度，下次不可重发', async () => {
    const web = new FakeCommentWeb();
    const ledger = new MemoryCommentLedger();
    web.postComment = async () => {
      expect(ledger.actions[0]?.status).toBe('pending');
      expect(ledger.countSentSince(NOON - 1)).toBe(1);
      return { ok: false, uncertain: true, detail: '没有真实回执' };
    };
    const { executor } = buildCommentExecutor({ web, ledger });
    const input = { sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings() };
    expect((await executor.execute(input)).status).toBe('uncertain');
    expect((await executor.execute(input)).failureKind).toBe('quota');
    expect(ledger.actions[0]?.status).toBe('uncertain');
  });
  it('发送前 journal 不可写时停发；发送后写入失败保留 pending 而非吞错', async () => {
    const web = new FakeCommentWeb(); const ledger = new MemoryCommentLedger();
    const { executor } = buildCommentExecutor({ web, ledger, compose: async () => {
      ledger.appendError = new Error('磁盘已满'); return { shouldComment: true, text: '这个解释很有帮助', reason: '' };
    } });
    const input = { sessionId: 's', candidate: commentCandidate(), itemText: '', settings: commentSettings() };
    await expect(executor.execute(input)).rejects.toThrow('磁盘已满');
    expect(web.postCalls).toHaveLength(0);
    ledger.appendError = null;
    web.postComment = async () => { ledger.appendError = new Error('磁盘已满'); return { ok: true, detail: '已确认' }; };
    const second = buildCommentExecutor({ web, ledger }).executor;
    await expect(second.execute(input)).rejects.toThrow('磁盘已满');
    expect(ledger.actions[0]?.status).toBe('pending');
  });
  it('非抖音域名与错误平台不读取页面、不发送', async () => {
    const { executor, web } = buildCommentExecutor();
    const action = await executor.execute({ sessionId: 's', candidate: commentCandidate('https://example.com/video/1234567'), itemText: '', settings: commentSettings() });
    expect(action.failureKind).toBe('page_error'); expect(web.readCalls).toEqual([]);
  });
});

describe('受限评论端口共用判定（ADR-006）', () => {
  it('只接受抖音视频详情页；列表页、外站、非 https 都拒绝', () => {
    expect(isDouyinVideoUrl(`https://www.douyin.com/video/${VIDEO_BASE}0`)).toBe(true);
    expect(isDouyinVideoUrl(`https://www.douyin.com/video/${VIDEO_BASE}0/`)).toBe(true);
    expect(isDouyinVideoUrl('https://www.douyin.com/jingxuan')).toBe(false);
    expect(isDouyinVideoUrl('https://www.douyin.com/video/123')).toBe(false);
    expect(isDouyinVideoUrl(`https://example.com/video/${VIDEO_BASE}0`)).toBe(false);
    expect(isDouyinVideoUrl(`http://www.douyin.com/video/${VIDEO_BASE}0`)).toBe(false);
  });

  it('比较页面地址忽略末尾斜杠', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com/video/1234567/')).toBe('https://www.douyin.com/video/1234567');
    expect(normalizeDouyinUrl('https://www.douyin.com/video/1234567')).toBe('https://www.douyin.com/video/1234567');
  });

  it('只有纯数字长 ID 才算稳定评论 ID', () => {
    expect(isStableDouyinCommentId('700001')).toBe(true);
    expect(isStableDouyinCommentId('temp-1')).toBe(false);
    expect(isStableDouyinCommentId('')).toBe(false);
    expect(isStableDouyinCommentId('12345')).toBe(false);
  });

  it('回执判定：新出现 + 稳定 ID + 全文一致；乐观插入与非数字 ID 都不算', () => {
    const before = [{ commentId: '700001', authorAlias: '甲', text: '旧评论' }];
    expect(
      findNewDouyinComment(before, [...before, { commentId: '700002', authorAlias: '', text: '新评论' }], '新评论'),
    ).toMatchObject({ commentId: '700002' });
    // 全文不一致
    expect(
      findNewDouyinComment(before, [...before, { commentId: '700002', authorAlias: '', text: '新评论' }], '别的文本'),
    ).toBeNull();
    // 非数字临时 ID（前端乐观插入）
    expect(
      findNewDouyinComment(before, [...before, { commentId: 'tmp-9', authorAlias: '', text: '新评论' }], '新评论'),
    ).toBeNull();
    // 发送前就存在的同文评论不是本次回执
    expect(findNewDouyinComment(before, before, '旧评论')).toBeNull();
  });
});

function makeSentAction(createdAt: number): SocialCommentAction {  return {
    actionId: `sent-${createdAt}`,
    platform: 'douyin',
    sessionId: 's',
    targetUrl: `https://www.douyin.com/video/${VIDEO_BASE}0`,
    targetTitle: '',
    targetAuthor: '',
    videoId: `${VIDEO_BASE}0`,
    text: '之前发过的评论',
    status: 'sent',
    failureKind: '',
    reason: '',
    modelId: 'm',
    createdAt,
    completedAt: createdAt,
    attemptedAt: createdAt,
  };
}
