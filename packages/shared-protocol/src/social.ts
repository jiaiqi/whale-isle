/**
 * Whale Isle V2 — 社区数字生活 L1（只读学习与兴趣沉淀）契约
 * （V2-P3-04 · REQ-SOC-01 / REQ-LIFE-01，蓝图 08 对齐）
 * L1 硬边界：BrowseSession.interactionMode 恒为 readonly，契约层钉死；
 * L2 草稿审核与 L3 受限自主的字段不在本文件定义（后续工单单独立项）。
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
