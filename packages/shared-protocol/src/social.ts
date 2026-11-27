/**
 * Whale Isle V2 — 社区数字生活契约
 * （V2-P3-04 · REQ-SOC-01 / REQ-LIFE-01，蓝图 08 对齐）
 * L1 浏览的 interactionMode 恒为 readonly，契约层钉死。
 * V2-P3-04K 起新增 L3 受限自主的「评论互动」契约（owner 2026-11-27 授权）：
 * 默认关闭、有限额度、只走 owner 自己的账号会话，所有发送/失败/拦截都落本地账本供 owner 查看。
 * 平台能力按矩阵逐项声明（渠道 / 授权 / 最近验证日期 / 风险级别），
 * 严禁以「第三方项目能做」作为平台允许的证据（蓝图 08 §4）。
 */
import { z } from 'zod';
import { PermissionRiskLevelSchema } from './browser-computer';

// ---------------------------------------------------------------------------
// 平台与自治等级
// ---------------------------------------------------------------------------

export const SocialPlatformIdSchema = z.enum([
  'douyin',
  'bilibili',
  'xiaohongshu',
  'weibo',
  'generic_web',
]);
export type SocialPlatformId = z.infer<typeof SocialPlatformIdSchema>;

export const SocialAutonomyLevelSchema = z.enum([
  'l1_readonly',
  'l2_draft_review',
  'l3_bounded',
]);
export type SocialAutonomyLevel = z.infer<typeof SocialAutonomyLevelSchema>;

// ---------------------------------------------------------------------------
// 平台能力矩阵（逐项声明，诚实记录验证状态）
// ---------------------------------------------------------------------------

export const SocialCapabilityKindSchema = z.enum([
  'search_content',
  'read_public',
  'read_authorized',
  'read_comments',
  'like_favorite',
  'follow',
  'comment_reply',
  'publish_image_text',
  'publish_video',
  'live_events',
]);
export type SocialCapabilityKind = z.infer<typeof SocialCapabilityKindSchema>;

export const SocialCapabilityChannelSchema = z.enum([
  'official_api',
  'browser_ui',
  'third_party_adapter',
]);
export type SocialCapabilityChannel = z.infer<typeof SocialCapabilityChannelSchema>;

export const SocialPlatformCapabilityEntrySchema = z.object({
  platform: SocialPlatformIdSchema,
  capability: SocialCapabilityKindSchema,
  channel: SocialCapabilityChannelSchema,
  /** 授权结论；true 必须配合 lastVerifiedAt > 0 的实测记录，由运行时策略强制执行 */
  allowed: z.boolean(),
  riskLevel: PermissionRiskLevelSchema.default('P2'),
  accountType: z.string().max(50).default(''),
  rateLimitNote: z.string().max(200).default(''),
  region: z.string().max(20).default(''),
  /** 最近一次逐项实测时间戳；0 = 从未实测（REQ-SOC-01：官方能力必须逐项实测） */
  lastVerifiedAt: z.number().int().nonnegative().default(0),
  notes: z.string().max(300).default(''),
});
export type SocialPlatformCapabilityEntry = z.output<typeof SocialPlatformCapabilityEntrySchema>;

// ---------------------------------------------------------------------------
// 浏览候选与会话（L1 只读）
// ---------------------------------------------------------------------------

export const SocialContentKindSchema = z.enum(['text', 'image', 'video', 'mixed']);
export type SocialContentKind = z.infer<typeof SocialContentKindSchema>;

export const BrowseCandidateSourceKindSchema = z.enum([
  'subscription',
  'search',
  'recommendation',
  'manual',
]);
export type BrowseCandidateSourceKind = z.infer<typeof BrowseCandidateSourceKindSchema>;

/** 喂给模型自主选择的候选内容（AI-First：程序只供给候选与护栏，选择由模型做） */
export const BrowseCandidateSchema = z.object({
  candidateId: z.string().min(1),
  platform: SocialPlatformIdSchema,
  url: z.string().url().max(2048),
  title: z.string().max(200).default(''),
  previewText: z.string().max(500).default(''),
  contentKind: SocialContentKindSchema,
  sourceKind: BrowseCandidateSourceKindSchema,
  publishedAt: z.number().int().nonnegative().optional(),
});
export type BrowseCandidate = z.output<typeof BrowseCandidateSchema>;

export const BrowseSessionStatusSchema = z.enum([
  'planned',
  'active',
  'awaiting_human',
  'paused',
  'completed',
  'aborted',
]);
export type BrowseSessionStatus = z.infer<typeof BrowseSessionStatusSchema>;

export const BrowseSessionStopReasonSchema = z.enum([
  'objective_met',
  'budget_exhausted',
  'user_stopped',
  'handoff_timeout',
  'quiet_hours',
  'error',
]);
export type BrowseSessionStopReason = z.infer<typeof BrowseSessionStopReasonSchema>;

/** 一次 L1 只读浏览会话：必须有目标、预算、停止条件（蓝图 08 §1/§10） */
export const BrowseSessionSchema = z.object({
  sessionId: z.string().min(1),
  characterId: z.string().min(1),
  /** 引用 P3-03 BrowserProfile（按角色隔离），不重复定义 */
  profileId: z.string().min(1),
  platform: SocialPlatformIdSchema,
  /** L1 硬护栏：契约层只允许 readonly */
  interactionMode: z.literal('readonly'),
  /** 关联 LifeRuntime 目标（可选） */
  goalId: z.string().min(1).optional(),
  objective: z.string().min(1).max(300),
  /** 预算：本次最多浏览条目数 */
  maxItems: z.number().int().min(1).max(50).default(10),
  /** 预算：本次最长时长（毫秒） */
  maxDurationMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
  status: BrowseSessionStatusSchema,
  stopReason: BrowseSessionStopReasonSchema.optional(),
  itemsViewed: z.number().int().nonnegative().default(0),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
});
export type BrowseSession = z.output<typeof BrowseSessionSchema>;

// ---------------------------------------------------------------------------
// 内容理解（蓝图 08 §6：来源与时间必须记录，模型路由必须诚实）
// ---------------------------------------------------------------------------

export const ContentItemRefSchema = z.object({
  platform: SocialPlatformIdSchema,
  url: z.string().url().max(2048),
  title: z.string().max(200).default(''),
  contentKind: SocialContentKindSchema,
  /** 公开展示昵称；不记录账号 ID 等敏感标识（蓝图 08 §9：只保存必要信息） */
  authorAlias: z.string().max(100).default(''),
  publishedAt: z.number().int().nonnegative().optional(),
});
export type ContentItemRef = z.output<typeof ContentItemRefSchema>;

export const ContentSentimentSchema = z.enum(['positive', 'neutral', 'negative', 'mixed']);
export type ContentSentiment = z.infer<typeof ContentSentimentSchema>;

export const ContentUnderstandingSchema = z.object({
  understandingId: z.string().min(1),
  sessionId: z.string().min(1),
  characterId: z.string().min(1),
  item: ContentItemRefSchema,
  summary: z.string().min(1).max(1000),
  topics: z.array(z.string().min(1).max(50)).max(10).default([]),
  sentiment: ContentSentimentSchema.default('neutral'),
  /** 模型判定的「与当前兴趣相关度」，供兴趣沉淀排序 */
  interestRelevance: z.number().min(0).max(1),
  usedMultimodal: z.boolean().default(false),
  /** 诚实记录执行理解的模型（provider/model），严禁编造 */
  modelId: z.string().min(1),
  understoodAt: z.number().int().nonnegative(),
});
export type ContentUnderstanding = z.output<typeof ContentUnderstandingSchema>;

// ---------------------------------------------------------------------------
// 兴趣信号（→ PreferenceStore(topics) / memory-graph 沉淀）
// ---------------------------------------------------------------------------

export const InterestSignalSchema = z.object({
  signalId: z.string().min(1),
  characterId: z.string().min(1),
  understandingId: z.string().min(1).optional(),
  /** 对应 PreferenceItem.key（category = topics） */
  topicKey: z.string().min(1).max(50),
  /** 单次信号幅度上限 ±0.5，防止一次浏览剧烈改写偏好 */
  delta: z.number().min(-0.5).max(0.5),
  confidence: z.number().min(0).max(1).default(0.5),
  /** 来源标识，如 `social:bilibili`（PreferenceItem.source 口径） */
  source: z.string().min(1).max(100),
  evidenceSummary: z.string().max(300).default(''),
  createdAt: z.number().int().nonnegative(),
});
export type InterestSignal = z.output<typeof InterestSignalSchema>;

// ---------------------------------------------------------------------------
// 自主发起策略（V2-P3-04E 补：scheduler tick 自动发起社交会话）
// owner 口径（2026-11-26）：默认关闭 / 每日 ≤2 次且累计 ≤30 分钟 / 间隔 90–150 分钟 ±20% 抖动 /
// 收官或失败后冷却 ≥60 分钟 / 本地 00:00–08:00 完全禁发 / 连续 2 次失败当日停发（不做 3 小时后重试）。
// 单次预算：maxItems 20 / maxDurationMs 10 分钟 / 内容理解最多 8 次模型调用。
// 程序只决定「何时可以开始」，不决定「看什么」——后者仍归模型（ADR-002 AI-First 红线）。
// ---------------------------------------------------------------------------

export const SocialAutostartSettingsSchema = z.object({
  /** 默认关闭：owner 在生活页显式打开才生效，一键关立即回退到手动/事件驱动 */
  enabled: z.boolean().default(false),
  maxSessionsPerDay: z.number().int().min(1).max(6).default(2),
  dailyBudgetMs: z.number().int().min(60_000).max(6 * 3_600_000).default(30 * 60_000),
  minIntervalMs: z.number().int().min(60_000).max(12 * 3_600_000).default(90 * 60_000),
  maxIntervalMs: z.number().int().min(60_000).max(12 * 3_600_000).default(150 * 60_000),
  /** 间隔抖动比例（±20%），避免整点机械感 */
  jitterRatio: z.number().min(0).max(0.5).default(0.2),
  cooldownMs: z.number().int().min(60_000).max(6 * 3_600_000).default(60 * 60_000),
  /** 禁发时段（本地时间，左闭右开；start > end 表示跨午夜） */
  quietHoursStart: z.number().int().min(0).max(23).default(0),
  quietHoursEnd: z.number().int().min(0).max(23).default(8),
  maxConsecutiveFailures: z.number().int().min(1).max(5).default(2),
  /** 单次预算（沿用 BrowseSession 既有字段，不新增语义） */
  sessionMaxItems: z.number().int().min(1).max(50).default(20),
  sessionMaxDurationMs: z.number().int().min(60_000).max(3_600_000).default(10 * 60_000),
  /** 单会话内容理解最多几次模型调用（超额只记浏览事实，不再理解） */
  maxUnderstandingCalls: z.number().int().min(0).max(20).default(8),
});
export type SocialAutostartSettings = z.output<typeof SocialAutostartSettingsSchema>;

/** 拦截原因：生活页必须显示「被谁拦住」，不允许只显示「未到时间」 */
export const SocialAutostartBlockReasonSchema = z.enum([
  'autostart_off',
  'life_halted',
  'session_active',
  'quiet_hours',
  'consecutive_failures',
  'daily_sessions_exhausted',
  'daily_budget_exhausted',
  'cooldown',
  'interval_wait',
  'platform_unverified',
  'executor_not_ready',
  'user_busy',
  'model_unavailable',
]);
export type SocialAutostartBlockReason = z.infer<typeof SocialAutostartBlockReasonSchema>;

export const SocialAutostartOutcomeSchema = z.enum(['ok', 'failed', 'aborted']);
export type SocialAutostartOutcome = z.infer<typeof SocialAutostartOutcomeSchema>;

/** 最近 5 次自主发起的收官记录（只记事实，不记内容摘要） */
export const SocialAutostartRecordSchema = z.object({
  sessionId: z.string().min(1),
  platform: SocialPlatformIdSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  itemsViewed: z.number().int().nonnegative(),
  stopReason: BrowseSessionStopReasonSchema,
  outcome: SocialAutostartOutcomeSchema,
  detail: z.string().max(200).default(''),
});
export type SocialAutostartRecord = z.output<typeof SocialAutostartRecordSchema>;

/** 一次「能否发起」的判定结果：宿主据此决定发起或如实显示拦截原因 */
export const SocialAutostartDecisionSchema = z.object({
  canStart: z.boolean(),
  blockReason: SocialAutostartBlockReasonSchema.nullable().default(null),
  detail: z.string().max(200).default(''),
  nextEligibleAt: z.number().int().nonnegative().nullable().default(null),
  /** 实际生效的单次预算（会被当日剩余预算钳制，绝不超发） */
  maxItems: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
  maxUnderstandingCalls: z.number().int().nonnegative(),
});
export type SocialAutostartDecision = z.output<typeof SocialAutostartDecisionSchema>;

// ---------------------------------------------------------------------------
// L1 浏览执行器（V2-P3-04G 续：执行器骨架 + 候选来源抽象 + 逐条读取 + 理解配额）
// 真实平台浏览在 owner 逐项声明能力矩阵并实测前一律不接；本地夹具源只用于开发/测试，
// 且必须显式放行才可运行——任何文档或 UI 都不得把「能浏览网页」写成已具备的能力。
// ---------------------------------------------------------------------------

export const SocialBrowseSourceKindSchema = z.enum(['local_fixture', 'platform']);
export type SocialBrowseSourceKind = z.infer<typeof SocialBrowseSourceKindSchema>;

/** 候选来源自报家门：来源种类、平台、是否逐项实测过（verdict 由运行时再校一遍） */
export const SocialBrowseSourceDescriptorSchema = z.object({
  sourceId: z.string().min(1).max(100),
  platform: SocialPlatformIdSchema,
  kind: SocialBrowseSourceKindSchema,
  /** 真实平台源必须 allowed=true 且 lastVerifiedAt>0 才允许置真；local_fixture 恒 false */
  verified: z.boolean().default(false),
  note: z.string().max(200).default(''),
});
export type SocialBrowseSourceDescriptor = z.output<typeof SocialBrowseSourceDescriptorSchema>;

/** 执行器对外自述（生活页直接展示，防止把夹具链路说成「已能浏览」） */
export const SocialBrowseExecutorStatusSchema = z.object({
  wired: z.boolean().default(false),
  sources: z.array(SocialBrowseSourceDescriptorSchema).default([]),
  /** 是否存在「已实测的真实平台候选源」；false 表示绝不会真发起 */
  runnable: z.boolean().default(false),
});
export type SocialBrowseExecutorStatus = z.output<typeof SocialBrowseExecutorStatusSchema>;

/** 单次执行的诚实回执：看了几条、理解用了几次配额、为什么停 */
export const SocialBrowseRunSummarySchema = z.object({
  sessionId: z.string().min(1),
  platform: SocialPlatformIdSchema,
  sourceId: z.string().min(1).max(100),
  sourceKind: SocialBrowseSourceKindSchema,
  candidatesConsidered: z.number().int().nonnegative().default(0),
  itemsViewed: z.number().int().nonnegative().default(0),
  /** 逐条读取失败次数（失败不计入已浏览条目） */
  readFailures: z.number().int().nonnegative().default(0),
  understandingCalls: z.number().int().nonnegative().default(0),
  /** 因理解配额耗尽而只记浏览事实、未理解条数 */
  understandingSkipped: z.number().int().nonnegative().default(0),
  understandingFailures: z.number().int().nonnegative().default(0),
  stopReason: BrowseSessionStopReasonSchema,
  status: BrowseSessionStatusSchema,
  detail: z.string().max(300).default(''),
});
export type SocialBrowseRunSummary = z.output<typeof SocialBrowseRunSummarySchema>;

/** 生活页四块的数据源：下次可发起/当前会话/今日用量/最近 5 次 */
export const SocialAutostartSnapshotSchema = z.object({
  settings: SocialAutostartSettingsSchema,
  decision: SocialAutostartDecisionSchema,
  dayKey: z.string().min(1),
  today: z.object({
    sessions: z.number().int().nonnegative(),
    usedMs: z.number().int().nonnegative(),
    remainingSessions: z.number().int().nonnegative(),
    remainingMs: z.number().int().nonnegative(),
  }),
  activeSession: BrowseSessionSchema.nullable().default(null),
  recent: z.array(SocialAutostartRecordSchema).max(5).default([]),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  executorReady: z.boolean().default(false),
  /** L1 浏览执行器状态：必须如实显示「有没有接真实平台」，没接就不许写「能浏览」 */
  executor: SocialBrowseExecutorStatusSchema.default({ wired: false, sources: [], runnable: false }),
});
export type SocialAutostartSnapshot = z.output<typeof SocialAutostartSnapshotSchema>;

// ---------------------------------------------------------------------------
// L3 受限自主：评论互动（V2-P3-04K，owner 2026-11-27 授权）
// 边界：默认关闭；只使用 owner 自己的账号会话；不绕过验证码/风控/登录墙；
// 有限额度 + 同视频长冷却 + 内容护栏；每一条发送/失败/拦截都落本地 SQLite 账本。
// ---------------------------------------------------------------------------

export const SocialCommentSettingsSchema = z.object({
  /** 默认关闭：owner 在生活页显式打开才生效，一键关立即停止后续发送 */
  enabled: z.boolean().default(false),
  /** 每日最多发送尝试；pending / uncertain 同样占额度，防止结果不明后重复发送 */
  maxPerDay: z.number().int().min(1).max(50).default(10),
  /** 每小时最多发送条数 */
  maxPerHour: z.number().int().min(1).max(20).default(3),
  /** 两条评论之间的最小间隔（默认 3 分钟，避免机械刷屏） */
  minIntervalMs: z.number().int().min(30_000).max(3_600_000).default(180_000),
  /** 评论文本长度（按 Unicode 码点计） */
  minChars: z.number().int().min(2).max(100).default(8),
  maxChars: z.number().int().min(10).max(300).default(80),
  /** 同一视频的冷却期（默认 30 天，避免反复骚扰同一条内容） */
  sameVideoCooldownMs: z
    .number()
    .int()
    .min(3_600_000)
    .max(365 * 24 * 3_600_000)
    .default(30 * 24 * 3_600_000),
  /** 禁发时段（本地时间，左闭右开；start > end 表示跨午夜） */
  quietHoursStart: z.number().int().min(0).max(23).default(0),
  quietHoursEnd: z.number().int().min(0).max(23).default(8),
});
export type SocialCommentSettings = z.output<typeof SocialCommentSettingsSchema>;
export const SocialCommentStateSchema = z.object({
  settings: SocialCommentSettingsSchema.default(() => SocialCommentSettingsSchema.parse({})),
  blockedReason: z.string().max(300).default(''),
});

export const SocialCommentActionStatusSchema = z.enum(['pending', 'sent', 'failed', 'skipped', 'uncertain']);
export type SocialCommentActionStatus = z.infer<typeof SocialCommentActionStatusSchema>;

/** 失败/拦截归因：生活页必须显示「为什么没发」，不允许只显示「失败了」 */
export const SocialCommentFailureKindSchema = z.enum([
  '',
  'disabled',
  'capability_unverified',
  'quota',
  'quiet_hours',
  'interrupted',
  'model_declined',
  'model_unavailable',
  'guard_rejected',
  'captcha',
  'login_required',
  'receipt_failed',
  'page_error',
  'ledger_error',
  'busy',
]);
export type SocialCommentFailureKind = z.infer<typeof SocialCommentFailureKindSchema>;

/** 一条评论动作的本地审计记录（owner 在生活页可直接查看 AI 今天做了什么） */
export const SocialCommentActionSchema = z.object({
  actionId: z.string().min(1),
  platform: SocialPlatformIdSchema,
  sessionId: z.string().max(100).default(''),
  targetUrl: z.string().url().max(2048),
  targetTitle: z.string().max(200).default(''),
  targetAuthor: z.string().max(100).default(''),
  videoId: z.string().max(50).default(''),
  text: z.string().max(300).default(''),
  status: SocialCommentActionStatusSchema,
  failureKind: SocialCommentFailureKindSchema.default(''),
  reason: z.string().max(300).default(''),
  /** 诚实记录生成该评论的模型（provider/model 由网关回报）；空 = 未走到模型 */
  modelId: z.string().max(200).default(''),
  createdAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().default(0),
  attemptedAt: z.number().int().nonnegative().default(0),
});
export type SocialCommentAction = z.output<typeof SocialCommentActionSchema>;

/** 生活页「AI 今日做了什么」快照 */
export const SocialCommentSnapshotSchema = z.object({
  settings: SocialCommentSettingsSchema,
  blockedReason: z.string().max(300).default(''),
  busy: z.boolean().default(false),
  ledgerReady: z.boolean().default(false),
  /** comment_reply 能力是否已授权且已实测；未实测时执行器绝不发送 */
  capability: z.object({
    allowed: z.boolean().default(false),
    verified: z.boolean().default(false),
    lastVerifiedAt: z.number().int().nonnegative().default(0),
    note: z.string().max(300).default(''),
  }),
  dayKey: z.string().min(1),
  today: z.object({
    sent: z.number().int().nonnegative().default(0),
    failed: z.number().int().nonnegative().default(0),
    skipped: z.number().int().nonnegative().default(0),
    uncertain: z.number().int().nonnegative().default(0),
    pending: z.number().int().nonnegative().default(0),
  }),
  thisHour: z.object({
    sent: z.number().int().nonnegative().default(0),
  }),
  remainingToday: z.number().int().nonnegative().default(0),
  remainingThisHour: z.number().int().nonnegative().default(0),
  nextEligibleAt: z.number().int().nonnegative().nullable().default(null),
  recent: z.array(SocialCommentActionSchema).max(100).default([]),
});
export type SocialCommentSnapshot = z.output<typeof SocialCommentSnapshotSchema>;

/** IPC 与模型输出均先校验；时间查询使用本地自然日，历史记录分页，不截断持久账本。 */
export const SocialCommentQuerySchema = z.object({
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});
export type SocialCommentQuery = z.input<typeof SocialCommentQuerySchema>;
export const SocialCommentHistorySchema = z.object({
  dayKey: z.string(), total: z.number().int().nonnegative(),
  actions: z.array(SocialCommentActionSchema).max(100),
});
export type SocialCommentHistory = z.output<typeof SocialCommentHistorySchema>;
export const SocialCommentVerifyInputSchema = z.object({
  url: z.string().url().max(2048).regex(/^https:\/\/www\.douyin\.com\/video\/\d{6,}\/?$/u),
});
export type SocialCommentVerifyInput = z.infer<typeof SocialCommentVerifyInputSchema>;
export const SocialCommentCompositionSchema = z.object({
  shouldComment: z.boolean(), text: z.string().max(300), reason: z.string().max(300),
});
export const SocialCommentResultSchema = z.object({
  ok: z.boolean(), error: z.string().optional(), action: SocialCommentActionSchema.optional(),
});
export type SocialCommentResult = z.output<typeof SocialCommentResultSchema>;
