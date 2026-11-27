/**
 * 抖音 L1 只读公开内容源（V2-P3-04H · REQ-SOC-01 / REQ-LIFE-01，owner 2026-11-27 拍板首个真实平台）：
 * - 只做两件事：从「抖音精选」公开页供给候选，逐条打开视频页读取标题/作者/发布时间/话题等公开字段。
 * - 绝不点赞、关注、评论、私信、发布，也不修改任何账号状态；`interactionMode=readonly` 由契约钉死。
 * - 浏览器会话由宿主注入（独立自动化 Profile，不碰 owner 日常浏览窗口，不代填密码、不存凭据）。
 * - 公开精选页无需登录即可只读；遇到验证码/风控/登录墙一律停下抛错，绝不绕过。
 * - 页面文本永远按不可信数据处理：这里只做字段抽取，不执行页面里的任何指令。
 */
import { z } from 'zod';
import {
  BrowseCandidateSchema,
  SocialBrowseSourceDescriptorSchema,
  type BrowseCandidate,
  type SocialBrowseSourceDescriptor,
} from '@workbench/shared-protocol';
import { WhaleError } from '@workbench/runtime-core';
import type { SocialBrowseCandidateSource, SocialBrowseItemReader } from './social-executor';

/** 抖音精选公开页：匿名可读，不需要登录；未登录或个性化流不可用时永远回落到这里 */
export const DOUYIN_PUBLIC_FEED_URL = 'https://www.douyin.com/jingxuan';

/** 抖音 L1 可读的三种信息流：公开精选 / 个性化推荐 / 关注 */
export const DOUYIN_FEED_KINDS = ['public', 'recommended', 'following'] as const;
export type DouyinFeedKind = (typeof DOUYIN_FEED_KINDS)[number];
export const DouyinFeedKindSchema = z.enum(DOUYIN_FEED_KINDS);

export const DOUYIN_FEED_URLS: Record<DouyinFeedKind, string> = {
  public: DOUYIN_PUBLIC_FEED_URL,
  // 未登录时抖音会把这个地址重定向到 /jingxuan；登录后才留在推荐流
  recommended: 'https://www.douyin.com/?recommend=1',
  following: 'https://www.douyin.com/follow',
};

export const DOUYIN_FEED_LABELS: Record<DouyinFeedKind, string> = {
  public: '公开精选',
  recommended: '推荐',
  following: '关注',
};

export type DouyinFallbackReason =
  | ''
  | 'not_logged_in'
  | 'platform_redirected'
  | 'empty_preferred'
  | 'login_wall';

/** 一次候选抓取实际用了哪条流、为什么没用请求的那条（全部如实上报，不假装已登录） */
export interface DouyinFeedSelection {
  requested: DouyinFeedKind;
  used: DouyinFeedKind;
  loggedIn: boolean;
  fallbackReason: DouyinFallbackReason;
  detail: string;
}

export function douyinFallbackText(reason: DouyinFallbackReason): string {
  switch (reason) {
    case 'not_logged_in':
      return '未登录，已回落公开精选';
    case 'platform_redirected':
      return '抖音把个性化流重定向到公开精选（通常是登录态缺失）';
    case 'empty_preferred':
      return '所选流没有可读候选，已回落公开精选';
    case 'login_wall':
      return '所选流要求登录，已回落公开精选';
    default:
      return '';
  }
}

/** 从最终 URL 判实际落到了哪条流；判不出时返回 null（调用方保留请求值） */
export function douyinFeedKindFromUrl(raw: string): DouyinFeedKind | null {
  try {
    const url = new URL(raw);
    if (url.hostname !== 'douyin.com' && !url.hostname.endsWith('.douyin.com')) return null;
    if (url.pathname.startsWith('/follow')) return 'following';
    if (url.pathname.startsWith('/jingxuan')) return 'public';
    if (url.pathname === '/' || url.pathname === '') return 'recommended';
  } catch {
    return null;
  }
  return null;
}

/** 真实冒烟最低条数：低于此数不算通过，`runnable` 不置真 */
export const DOUYIN_SMOKE_MIN_ITEMS = 3;
/** 冒烟证据有效期：过期后来源回到「未实测」，必须重跑冒烟 */
export const DOUYIN_EVIDENCE_TTL_MS = 7 * 24 * 3_600_000;

export interface DouyinFeedCard {
  videoId: string;
  /** 卡片可见文本（时长/播放量/标题/作者/日期），只作数据 */
  text: string;
}

/** 宿主引擎返回的页面快照：全部字段只作数据处理 */
export interface DouyinPageSnapshot {
  url: string;
  title: string;
  text: string;
  cards: DouyinFeedCard[];
  /** 视频页 h1（通常是完整标题/简介） */
  heading?: string;
  /** 公开昵称（不记录账号 ID） */
  author?: string;
  /** 视频页「发布时间：…」原文 */
  publishTimeText?: string;
  /** 视频页公开信息块（标题/点赞/评论/收藏/发布时间） */
  detailText?: string;
}

export interface DouyinLoginState {
  loggedIn: boolean;
}

/** 抖音浏览器会话端口：宿主用独立 Electron Profile 实现，单测注入假会话 */
export interface DouyinWebSession {
  load(url: string): Promise<DouyinPageSnapshot>;
  /**
   * 打开指定信息流；推荐流在桌面 Web 上直接访问 `/?recommend=1` 会被重定向到精选，
   * 必须由宿主在精选页内点击「推荐」标签（只读导航）才能落到真实推荐流。
   * 未实现时调用方回落到 `load(DOUYIN_FEED_URLS[feed])`。
   */
  openFeed?(feed: DouyinFeedKind): Promise<DouyinPageSnapshot>;
  loginState(): Promise<DouyinLoginState>;
  /** 打开可见登录窗，由 owner 亲手扫码；本类绝不代填密码 */
  openLoginWindow?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface DouyinBrowseSourceOptions {
  /** 只有真实冒烟通过（证据未过期）才为 true；false 时执行器动手前直接拒绝 */
  verified: boolean;
  /** 首选信息流；默认公开精选。个性化流未登录/不可用时总是回落公开精选 */
  feed?: DouyinFeedKind;
  /** 兼容旧调用：显式 feedUrl 等价于选择 public（除非 URL 能判出流） */
  feedUrl?: string;
  /** 逐条读取之间的最小间隔，默认 2500ms（低频率、不硬刷） */
  readIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DouyinBrowseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.string().min(1).max(100),
  /** 实际用于读取的 feed URL */
  feedUrl: z.string().url().max(2048),
  /** 请求的流；旧证据没有这些字段时按公开精选处理 */
  requestedFeed: DouyinFeedKindSchema.default('public'),
  usedFeed: DouyinFeedKindSchema.default('public'),
  loggedIn: z.boolean().default(false),
  fallbackReason: z.string().max(100).default(''),
  /** 冒烟完成时间（证据时间） */
  verifiedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  itemsRead: z.number().int().nonnegative(),
  readFailures: z.number().int().nonnegative(),
  ok: z.boolean(),
  failureReason: z.string().max(300).default(''),
  samples: z
    .array(
      z.object({
        url: z.string().url().max(2048),
        title: z.string().max(200).default(''),
        authorAlias: z.string().max(100).default(''),
        topics: z.array(z.string().max(50)).max(10).default([]),
        textChars: z.number().int().nonnegative(),
      }),
    )
    .max(5)
    .default([]),
});
export type DouyinBrowseEvidence = z.output<typeof DouyinBrowseEvidenceSchema>;

/** 冒烟证据是否仍然可用（ok + 条数达标 + 未过 7 天有效期） */
export function isDouyinEvidenceUsable(
  evidence: DouyinBrowseEvidence | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    evidence &&
      evidence.ok &&
      evidence.itemsRead >= DOUYIN_SMOKE_MIN_ITEMS &&
      evidence.verifiedAt > 0 &&
      now - evidence.verifiedAt <= DOUYIN_EVIDENCE_TTL_MS,
  );
}

/** 请求的那条流本身是否被真实读到（个性化流回落公开精选时不算通过） */
export function isDouyinRequestedFeedVerified(
  evidence: DouyinBrowseEvidence | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    isDouyinEvidenceUsable(evidence, now) &&
      evidence &&
      evidence.usedFeed === evidence.requestedFeed,
  );
}

const DURATION_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/u;
const COUNT_RE = /^\d+(?:\.\d+)?(?:万|亿|w|k)?$/iu;
const DATE_RE =
  /^(?:·\s*)?(?:(?:\d{4}[-年])?\d{1,2}[-月]\d{1,2}日?|\d+\s*(?:秒|分钟|小时|天|周|个月)前|昨天|前天|今天)/u;
const AUTHOR_RE = /^@/u;
// 注意：不能把裸「验证码」当风控——抖音登录弹窗自带「验证码登录 / 获取验证码」。
// 只认真正的人机校验/风控页文案，避免把可读页面误判成验证码页。
const CAPTCHA_RE =
  /(人机验证|安全验证|验证码中间页|访问过于频繁|操作过于频繁|请完成验证|完成下方验证|拖动滑块|请输入验证码|captcha|turnstile|recaptcha|verify\s+you\s+are\s+human)/iu;
const LOGIN_RE = /(扫码登录|登录后|请先登录|密码登录|验证码登录|登录即代表同意)/u;

export type DouyinBlockKind = 'captcha' | 'login';

/** 只识别「必须停下」的门槛；可正常阅读的页面即使带登录入口也不拦 */
export function detectDouyinBlock(page: Pick<DouyinPageSnapshot, 'title' | 'text'>): {
  kind: DouyinBlockKind;
  detail: string;
} | null {
  const haystack = `${page.title}\n${page.text}`;
  if (CAPTCHA_RE.test(haystack)) {
    return {
      kind: 'captcha',
      detail: '抖音触发验证码/风控门槛，立即停止，绝不绕过；请 owner 亲手处理后再试',
    };
  }
  if (LOGIN_RE.test(haystack)) {
    return {
      kind: 'login',
      detail: '抖音要求登录后才能继续，已停下；请在独立自动化 Profile 里由 owner 亲手扫码',
    };
  }
  return null;
}

/** 从卡片可见文本里抽标题与公开昵称（时长/播放量/日期等元信息不当标题） */
export function parseDouyinCardText(raw: string): { title: string; authorAlias: string } {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const authorAlias =
    lines
      .find((line) => AUTHOR_RE.test(line))
      ?.replace(/^@/u, '')
      .trim() ?? '';
  const titleLines = lines.filter(
    (line) =>
      !DURATION_RE.test(line) &&
      !COUNT_RE.test(line) &&
      !AUTHOR_RE.test(line) &&
      !DATE_RE.test(line) &&
      !line.startsWith('·'),
  );
  const title = [...titleLines].sort((a, b) => b.length - a.length)[0] ?? '';
  return { title: title.slice(0, 200), authorAlias: authorAlias.slice(0, 100) };
}

/** 话题标签：只从公开文本里抽 #xxx，最多 10 个 */
export function extractDouyinTopics(...texts: string[]): string[] {
  const topics = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/#([^#\s@]{1,30})/gu)) {
      const topic = match[1]?.trim();
      if (topic) topics.add(topic);
      if (topics.size >= 10) return [...topics];
    }
  }
  return [...topics];
}

/** 视频页 → 给理解器的干净公开字段文本（不含评论区与页面指令） */
export function buildDouyinItemText(page: DouyinPageSnapshot): string {
  const heading = (page.heading ?? '').trim() || stripDouyinSuffix(page.title);
  const author = (page.author ?? '').trim();
  const publishTime = (page.publishTimeText ?? '').replace(/^发布时间[：:]\s*/u, '').trim();
  const topics = extractDouyinTopics(heading, page.detailText ?? '', page.text.slice(0, 2_000));
  const body = (page.detailText ?? '').trim() || page.text.trim();
  return [
    `标题：${heading || '（未提供）'}`,
    `作者：${author || '（未提供）'}`,
    `发布时间：${publishTime || '（页面未提供）'}`,
    `话题：${topics.length > 0 ? topics.join('、') : '（无）'}`,
    '公开页面信息：',
    body.slice(0, 4_000),
  ].join('\n');
}

function stripDouyinSuffix(title: string): string {
  return title.replace(/\s*[-–—]\s*抖音\s*$/u, '').trim();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function douyinPermissionError(message: string, reason: string): WhaleError {
  return new WhaleError('PERMISSION_DENIED', message, {
    // 登录墙需要 owner 亲手扫码，本轮无法自行恢复，直接停下
    recoverable: false,
    context: { platform: 'douyin', reason },
  });
}

/**
 * 抖音公开内容源：同时实现候选来源与逐条读取两个端口。
 * 只读、低频率；遇到风控/登录墙在动手前抛错，绝不尝试绕过或继续读。
 */
export class DouyinBrowseCandidateSource implements SocialBrowseCandidateSource, SocialBrowseItemReader {
  readonly descriptor: SocialBrowseSourceDescriptor;
  private currentFeed: DouyinFeedKind;
  private readonly customFeedUrl: string | null;
  private selection: DouyinFeedSelection | null = null;
  private readonly readIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastReadAt = 0;

  constructor(
    private readonly web: DouyinWebSession,
    options: DouyinBrowseSourceOptions,
  ) {
    const urlFeed = options.feedUrl ? douyinFeedKindFromUrl(options.feedUrl) : null;
    this.currentFeed = options.feed ?? urlFeed ?? 'public';
    this.customFeedUrl = options.feedUrl && urlFeed === null ? options.feedUrl : null;
    this.readIntervalMs = options.readIntervalMs ?? 2_500;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.descriptor = SocialBrowseSourceDescriptorSchema.parse({
      sourceId: 'douyin-public-jingxuan',
      platform: 'douyin',
      kind: 'platform',
      verified: options.verified,
      note: '抖音只读信息流（公开精选 / 推荐 / 关注，未登录时回落公开精选）；不点赞/不关注/不评论/不发私信',
    });
  }

  /** 当前首选流；个性化流不可用时会现实回落到公开精选，不会假装已登录 */
  get feed(): DouyinFeedKind {
    return this.currentFeed;
  }

  get requestedFeed(): DouyinFeedKind {
    return this.currentFeed;
  }

  /** 最近一次抓取实际使用的 feed URL（未抓取过则用首选流） */
  get feedUrl(): string {
    return this.urlFor(this.selection?.used ?? this.currentFeed);
  }

  get lastSelection(): DouyinFeedSelection | null {
    return this.selection;
  }

  /** 切换首选流；下一次抓取会重新判断登录态与回落 */
  selectFeed(feed: DouyinFeedKind): void {
    this.currentFeed = feed;
    this.selection = null;
  }

  async listCandidates(input: { objective: string; limit: number }): Promise<BrowseCandidate[]> {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return [];

    const requested = this.currentFeed;
    let loggedIn = false;
    try {
      loggedIn = (await this.web.loginState()).loggedIn;
    } catch {
      // 登录态读不到一律按未登录处理：宁可回落公开精选，也不假装个性化流可用
      loggedIn = false;
    }

    let feed: DouyinFeedKind = requested;
    let reason: DouyinFallbackReason = '';
    if (requested !== 'public' && !loggedIn) {
      feed = 'public';
      reason = 'not_logged_in';
    }

    let page = await this.openPage(feed);
    this.assertNoCaptcha(page);

    // 抖音自己可能把推荐流重定向到精选（未登录时常见）；以最终 URL 为准
    const landed = douyinFeedKindFromUrl(page.url);
    if (landed && landed !== feed) {
      feed = landed;
      if (feed !== requested && reason === '') reason = 'platform_redirected';
    }

    let cards = dedupeCards(page.cards);
    if (cards.length === 0 && feed !== 'public') {
      const block = detectDouyinBlock(page);
      reason = block?.kind === 'login' ? 'login_wall' : 'empty_preferred';
      feed = 'public';
      page = await this.openPage('public');
      this.assertNoCaptcha(page);
      cards = dedupeCards(page.cards);
    }

    this.selection = {
      requested,
      used: feed,
      loggedIn,
      fallbackReason: reason,
      detail: douyinFallbackText(reason),
    };

    if (cards.length === 0) {
      const block = detectDouyinBlock(page);
      if (block?.kind === 'login') {
        throw douyinPermissionError(
          '抖音公开页需要登录才能看到内容，已停下；请 owner 在独立自动化 Profile 里扫码登录',
          'LOGIN_REQUIRED',
        );
      }
      throw new WhaleError('INTERNAL_ERROR', '抖音公开页没有可读候选（页面结构可能已变化），不伪造候选', {
        recoverable: true,
        context: { platform: 'douyin', feedUrl: this.feedUrl },
      });
    }
    return cards.slice(0, limit).map((card) => this.toCandidate(card));
  }

  async read(candidate: BrowseCandidate): Promise<{ textContent: string; usedMultimodal?: boolean }> {
    await this.pace();
    const page = await this.web.load(candidate.url);
    this.assertNoCaptcha(page);
    const hasContent = (page.heading ?? '').trim() !== '' || (page.detailText ?? '').trim() !== '';
    if (!hasContent) {
      const block = detectDouyinBlock(page);
      if (block?.kind === 'login') {
        throw douyinPermissionError(
          `视频页要求登录才能读取：${candidate.url}；已停下，请 owner 扫码登录`,
          'LOGIN_REQUIRED',
        );
      }
      throw new WhaleError('INTERNAL_ERROR', `视频页没有可读公开字段：${candidate.url}`, {
        recoverable: true,
        context: { platform: 'douyin', url: candidate.url },
      });
    }
    const textContent = buildDouyinItemText(page);
    return { textContent, usedMultimodal: false };
  }

  private toCandidate(card: DouyinFeedCard): BrowseCandidate {
    const parsed = parseDouyinCardText(card.text);
    return BrowseCandidateSchema.parse({
      candidateId: `douyin-${card.videoId}`,
      platform: 'douyin',
      url: `https://www.douyin.com/video/${card.videoId}`,
      title: parsed.title,
      previewText: [parsed.authorAlias ? `@${parsed.authorAlias}` : '', parsed.title]
        .filter((part) => part !== '')
        .join(' · ')
        .slice(0, 500),
      contentKind: 'video',
      sourceKind: 'recommendation',
    });
  }

  private assertNoCaptcha(page: DouyinPageSnapshot): void {
    const block = detectDouyinBlock(page);
    if (block?.kind === 'captcha') {
      throw new WhaleError('PERMISSION_DENIED', block.detail, {
        // 风控一旦触发就结束本次运行，绝不在同一轮里换条硬刷
        recoverable: false,
        context: { platform: 'douyin', reason: 'CAPTCHA_REQUIRED' },
      });
    }
  }

  private urlFor(feed: DouyinFeedKind): string {
    if (feed === 'public' && this.customFeedUrl !== null) return this.customFeedUrl;
    return DOUYIN_FEED_URLS[feed];
  }

  /** 优先让宿主按信息流打开（推荐流需要页内点标签）；没有实现时退回直接 load */
  private async openPage(feed: DouyinFeedKind): Promise<DouyinPageSnapshot> {
    if (feed === 'public' && this.customFeedUrl !== null) return this.web.load(this.customFeedUrl);
    if (this.web.openFeed) return this.web.openFeed(feed);
    return this.web.load(this.urlFor(feed));
  }

  private async pace(): Promise<void> {
    const interval = this.readIntervalMs;
    if (interval <= 0) {
      this.lastReadAt = this.now();
      return;
    }
    const now = this.now();
    const wait = this.lastReadAt === 0 ? 0 : Math.max(0, interval - (now - this.lastReadAt));
    this.lastReadAt = now;
    if (wait > 0) await this.sleep(wait);
  }
}

function dedupeCards(cards: DouyinFeedCard[]): DouyinFeedCard[] {
  const seen = new Set<string>();
  const out: DouyinFeedCard[] = [];
  for (const card of cards) {
    const id = card.videoId.trim();
    if (!/^\d{6,}$/u.test(id) || seen.has(id)) continue;
    const text = card.text.trim();
    if (text === '') continue;
    seen.add(id);
    out.push({ videoId: id, text });
  }
  return out;
}

/**
 * 真实冒烟：候选来源 → 逐条读取 ≥N 条公开内容 → 生成证据。
 * 走的就是生产链路的两个端口，不含任何假数据；失败也如实写进证据。
 */
export async function runDouyinSmoke(
  source: DouyinBrowseCandidateSource,
  options: { limit?: number; now?: () => number; minItems?: number; feed?: DouyinFeedKind } = {},
): Promise<DouyinBrowseEvidence> {
  const now = options.now ?? Date.now;
  const minItems = options.minItems ?? DOUYIN_SMOKE_MIN_ITEMS;
  const limit = Math.max(minItems, Math.min(options.limit ?? 5, 20));
  if (options.feed !== undefined) source.selectFeed(options.feed);
  else source.selectFeed(source.requestedFeed);
  const requestedFeed = source.requestedFeed;
  const startedAt = now();
  let candidates = 0;
  let itemsRead = 0;
  let readFailures = 0;
  let failureReason = '';
  const samples: DouyinBrowseEvidence['samples'] = [];

  try {
    const list = await source.listCandidates({ objective: '真实冒烟：读取抖音公开内容', limit });
    candidates = list.length;
    for (const candidate of list) {
      try {
        const { textContent } = await source.read(candidate);
        if (textContent.trim().length < 20) throw new Error('公开正文过短');
        itemsRead += 1;
        const authorAlias = /^作者：(.+)$/mu.exec(textContent)?.[1]?.trim() ?? '';
        samples.push({
          url: candidate.url,
          title: candidate.title.slice(0, 200),
          authorAlias: authorAlias === '（未提供）' ? '' : authorAlias.slice(0, 100),
          topics: extractDouyinTopics(textContent),
          textChars: textContent.length,
        });
      } catch (error) {
        readFailures += 1;
        failureReason = `${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
        // 风控/登录墙：立即停止，不换下一条硬刷
        if (error instanceof WhaleError && !error.recoverable) break;
      }
      if (itemsRead >= minItems) break;
      if (samples.length >= 5) break;
    }
  } catch (error) {
    failureReason = `${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
  }

  const endedAt = now();
  const selection = source.lastSelection;
  return DouyinBrowseEvidenceSchema.parse({
    schemaVersion: 1,
    sourceId: source.descriptor.sourceId,
    feedUrl: source.feedUrl,
    requestedFeed,
    usedFeed: selection?.used ?? requestedFeed,
    loggedIn: selection?.loggedIn ?? false,
    fallbackReason: selection?.fallbackReason ?? '',
    verifiedAt: endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    candidates,
    itemsRead,
    readFailures,
    ok: itemsRead >= minItems,
    failureReason: itemsRead >= minItems ? '' : failureReason || `只读到 ${itemsRead} 条，低于冒烟门槛 ${minItems} 条`,
    samples: samples.slice(0, 5),
  });
}
