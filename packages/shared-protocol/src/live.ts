/**
 * Whale Isle V2 — LifeRuntime 驱动直播中控、平台适配器与 OBS 舞台契约（V2-P3-02 · REQ-LIVE-01）
 * - 零外部依赖（仅 zod 与同级 voice.ts），绝不编造虚假观众数、码率或开播时长
 */
import { z } from 'zod';
import {
  LyricsClockFrameSchema,
  SongRightsSchema,
} from './voice';

export const LivePlatformIdSchema = z.enum([
  'douyin_dyhub',
  'bilibili_open',
  'youtube_live',
  'local_replay',
]);
export type LivePlatformId = z.infer<typeof LivePlatformIdSchema>;

export const LiveConnectionStateSchema = z.enum([
  'idle',
  'connecting',
  'connected',
  'degraded',
  'disconnected',
]);
export type LiveConnectionState = z.infer<typeof LiveConnectionStateSchema>;

export const LivePlatformApiModeSchema = z.enum([
  'dyhub_bridge',
  'official_open_api',
  'local_replay',
]);
export type LivePlatformApiMode = z.infer<typeof LivePlatformApiModeSchema>;

export const LivePlatformAdapterStatusSchema = z.object({
  platform: LivePlatformIdSchema,
  roomId: z.string(),
  endpoint: z.string().optional(),
  connectionState: LiveConnectionStateSchema,
  apiMode: LivePlatformApiModeSchema,
  detail: z.string().min(1),
  realPlatformVerified: z.boolean().default(false),
  reconnectAttempts: z.number().int().nonnegative().default(0),
  lastEventAt: z.number().int().nonnegative().nullable().default(null),
});
export type LivePlatformAdapterStatus = z.output<typeof LivePlatformAdapterStatusSchema>;

export const LiveSongQueueStatusSchema = z.enum([
  'queued',
  'performing',
  'completed',
  'blocked_rights',
  'cancelled',
]);
export type LiveSongQueueStatus = z.infer<typeof LiveSongQueueStatusSchema>;

export const LiveSongQueueItemSchema = z.object({
  queueId: z.string().min(1),
  songId: z.string().nullable(),
  title: z.string().min(1),
  requesterUid: z.string().min(1),
  requesterName: z.string().min(1),
  priorityBoost: z.number().nonnegative().default(0),
  rightsAllowed: z.boolean(),
  rightsReasons: z.array(z.string()).default([]),
  status: LiveSongQueueStatusSchema,
  requestedAt: z.number().int().nonnegative(),
});
export type LiveSongQueueItem = z.output<typeof LiveSongQueueItemSchema>;

export const LiveGiftThankBatchSchema = z.object({
  batchId: z.string().min(1),
  kind: z.enum(['gift', 'follow']),
  count: z.number().int().positive(),
  totalValue: z.number().nonnegative().default(0),
  senders: z.array(z.string()).min(1),
  mergedText: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type LiveGiftThankBatch = z.output<typeof LiveGiftThankBatchSchema>;

export const LiveObsDanmakuItemSchema = z.object({
  eventId: z.string().min(1),
  nickname: z.string().min(1),
  text: z.string(),
  priority: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type LiveObsDanmakuItem = z.output<typeof LiveObsDanmakuItemSchema>;

export const LiveObsStagePayloadSchema = z.object({
  liveActive: z.boolean(),
  sessionId: z.string().nullable(),
  characterId: z.string().min(1),
  platform: LivePlatformIdSchema,
  roomId: z.string(),
  connectionState: LiveConnectionStateSchema,
  sceneId: z.string().min(1),
  expression: z.string().min(1),
  activeSongTitle: z.string().nullable(),
  lyrics: LyricsClockFrameSchema.nullable(),
  recentDanmaku: z.array(LiveObsDanmakuItemSchema).default([]),
  recentGifts: z.array(LiveGiftThankBatchSchema).default([]),
  moderationAlerts: z.number().int().nonnegative().default(0),
  realPlatformVerified: z.boolean().default(false),
});
export type LiveObsStagePayload = z.output<typeof LiveObsStagePayloadSchema>;

export const LiveSessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  characterId: z.string().min(1),
  platform: LivePlatformIdSchema,
  roomId: z.string(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  totalEvents: z.number().int().nonnegative(),
  danmakuCount: z.number().int().nonnegative(),
  giftCount: z.number().int().nonnegative(),
  followCount: z.number().int().nonnegative(),
  songAcceptedCount: z.number().int().nonnegative(),
  songBlockedCount: z.number().int().nonnegative(),
  moderationAlerts: z.number().int().nonnegative(),
  disconnectCount: z.number().int().nonnegative(),
  highlights: z.array(z.string()).default([]),
  realPlatformVerified: z.boolean().default(false),
});
export type LiveSessionSummary = z.output<typeof LiveSessionSummarySchema>;

export const LiveRuntimeSnapshotSchema = z.object({
  active: z.boolean(),
  sessionId: z.string().nullable(),
  characterId: z.string().min(1),
  halted: z.boolean(),
  adapter: LivePlatformAdapterStatusSchema,
  songQueue: z.array(LiveSongQueueItemSchema),
  blockedSongLog: z.array(LiveSongQueueItemSchema),
  recentGiftThanks: z.array(LiveGiftThankBatchSchema),
  obsStage: LiveObsStagePayloadSchema,
  summaryCount: z.number().int().nonnegative(),
});
export type LiveRuntimeSnapshot = z.output<typeof LiveRuntimeSnapshotSchema>;

export const LiveSessionStartInputSchema = z.object({
  platform: LivePlatformIdSchema.default('douyin_dyhub'),
  roomId: z.string().min(1).default('room-local'),
  endpoint: z.string().optional(),
  sceneId: z.string().min(1).optional(),
});
export type LiveSessionStartInput = z.input<typeof LiveSessionStartInputSchema>;

export const LiveSongRequestInputSchema = z.object({
  songId: z.string().optional(),
  title: z.string().min(1),
  requesterUid: z.string().min(1).default('viewer-anon'),
  requesterName: z.string().min(1).default('观众'),
  priorityBoost: z.number().nonnegative().default(0),
});
export type LiveSongRequestInput = z.input<typeof LiveSongRequestInputSchema>;

export { SongRightsSchema };
