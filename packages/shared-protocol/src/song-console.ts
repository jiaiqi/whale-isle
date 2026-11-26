/**
 * 点歌台（Streaming SVC 点歌台）契约 —— SPEC §3.4。
 *
 * 处理流水线：点歌指令 → 四重授权门禁 → 违禁曲目黑名单 → 本地缓存池命中则秒播
 * → 未命中则 Demucs v4 分离人声/伴奏 → 前 25 秒人声切片 RVC v2 (RMVPE) 声线转换并混音
 * → 桌宠进入 sing 舞台开唱，后台异步完成剩余切片并无缝拼接落盘。
 *
 * 诚实口径：任何一个原子能力（Demucs / RVC / 声线模型 / 源音频）缺失时，
 * 整条管线如实进入 `unavailable` 并给出**具体缺口**，绝不用占位音频冒充真唱。
 */
import { z } from 'zod';
import {
  PerformanceChannelSchema,
  SongCatalogItemSchema,
  SongRightsCheckSchema,
} from './voice';

/** 管线阶段（状态机节点，按执行顺序排列） */
export const SongConsoleStageSchema = z.enum([
  'rights_check', // 四重授权门禁（曲目/伴奏/歌词/角色声线）
  'blacklist_check', // 违禁曲目黑名单
  'cache_lookup', // 本地缓存池查询
  'cache_hit', // 命中缓存，直接秒播
  'separating', // Demucs v4 分离人声与伴奏
  'slicing', // 人声切片（前 25 秒优先）
  'converting', // RVC v2 (RMVPE) 声线转换
  'mixing', // 与伴奏混音
  'prebuffer_ready', // 首切片就绪，可以开唱
  'streaming', // 边唱边在后台补齐
  'completing', // 后台完成剩余切片并拼接落盘
  'completed', // 全部完成
  'rejected', // 被门禁/黑名单拒绝（含明确原因）
  'unavailable', // 素材/能力缺失（含明确缺口）
]);
export type SongConsoleStage = z.infer<typeof SongConsoleStageSchema>;

/** 对外状态（粗粒度，供 UI 与节目状态机消费） */
export const SongConsoleStateSchema = z.enum([
  'idle',
  'preparing', // 分离/切片/转换/混音中，尚未可唱
  'streaming', // 首切片已就绪并可播，后台仍在补齐
  'completing',
  'completed',
  'rejected',
  'unavailable',
]);
export type SongConsoleState = z.infer<typeof SongConsoleStateSchema>;

/** 单个原子能力的真实就绪情况（只描述事实） */
export const SongConsoleCapabilitySchema = z.object({
  name: z.enum(['demucs', 'rvc', 'ffmpeg', 'rmvpe']),
  ready: z.boolean(),
  detail: z.string().min(1),
  /** 缺失时给出的可执行补救建议（例如"放置 rvc/xiaojing.pth"） */
  hint: z.string().default(''),
});
export type SongConsoleCapability = z.output<typeof SongConsoleCapabilitySchema>;

/** 点歌请求 */
export const SongConsoleRequestSchema = z.object({
  requestId: z.string().min(1),
  characterId: z.string().min(1),
  voiceProfileId: z.string().min(1),
  channel: PerformanceChannelSchema.default('private_desktop'),
  song: SongCatalogItemSchema,
  /** 本地源音频（原曲）。缺省则无法分离，管线如实报 unavailable */
  sourceAudioPath: z.string().default(''),
  /** 首切片时长（SPEC §3.4 为 25 秒） */
  firstSliceMs: z.number().int().min(5_000).max(120_000).default(25_000),
  /** 单切片时长（后续后台切片） */
  sliceMs: z.number().int().min(5_000).max(120_000).default(25_000),
});
export type SongConsoleRequest = z.output<typeof SongConsoleRequestSchema>;
export type SongConsoleRequestInput = z.input<typeof SongConsoleRequestSchema>;

/** 点歌状态快照（宿主 → UI / 节目状态机） */
export const SongConsoleStatusSchema = z.object({
  requestId: z.string().min(1),
  characterId: z.string().min(1),
  state: SongConsoleStateSchema,
  stage: SongConsoleStageSchema,
  songId: z.string().min(1),
  songTitle: z.string().min(1),
  channel: PerformanceChannelSchema,
  rightsCheck: SongRightsCheckSchema,
  /** 缓存键：`<characterId>_<sha256(sourceAudioPath + 声线参数)[:16]>` */
  cacheKey: z.string().min(1),
  cacheHit: z.boolean().default(false),
  cacheLookupMs: z.number().nonnegative().optional(),
  /** 被拒原因（state=rejected 时必有） */
  rejectionReason: z.string().optional(),
  /** 缺失原因（state=unavailable 时必有，逐项列出缺口） */
  unavailableReason: z.string().optional(),
  /** 缺失能力明细 */
  missingCapabilities: z.array(z.string()).default([]),
  /** 首切片产物（可开唱） */
  prebufferPath: z.string().optional(),
  prebufferDurationMs: z.number().int().nonnegative().optional(),
  /** 全部产物 */
  finalPath: z.string().optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  completedSlices: z.number().int().nonnegative().default(0),
  totalSlices: z.number().int().nonnegative().default(0),
  /** 后台补齐任务 id（无后台任务时缺省） */
  backgroundJobId: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type SongConsoleStatus = z.output<typeof SongConsoleStatusSchema>;
export type SongConsoleStatusInput = z.input<typeof SongConsoleStatusSchema>;

/** 违禁曲目黑名单条目（内容侧数据，与授权门禁互补） */
export const SongBlacklistEntrySchema = z.object({
  /** 匹配键：曲名或歌手名的小写归一形式（子串匹配） */
  keyword: z.string().min(1),
  reason: z.string().min(1),
  /** 适用范围：全渠道 / 仅公开渠道 */
  scope: z.enum(['all_channels', 'public_only']).default('all_channels'),
});
export type SongBlacklistEntry = z.output<typeof SongBlacklistEntrySchema>;

export const SongBlacklistFileSchema = z.object({
  version: z.string().min(1),
  updatedAt: z.string().min(1),
  entries: z.array(SongBlacklistEntrySchema),
});
export type SongBlacklistFile = z.output<typeof SongBlacklistFileSchema>;
