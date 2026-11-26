/**
 * Whale Isle V2 — 人机/多 AI 游戏联机协作（CoopRuntime v1）契约
 * 严格遵循 Blueprint 07 §§7–8：房间成员、独立控制权租约、任务板、重要资源防误卖预留、Mod 兼容预检与断线恢复。
 */
import { z } from 'zod';

export const CoopRoomStatusSchema = z.enum([
  'idle',
  'preparing',
  'active',
  'paused',
  'reconnecting',
  'ended',
]);
export type CoopRoomStatus = z.infer<typeof CoopRoomStatusSchema>;

export const CoopConnectionStateSchema = z.enum(['connected', 'reconnecting', 'offline']);
export type CoopConnectionState = z.infer<typeof CoopConnectionStateSchema>;

/**
 * 分屏/联机实例与游戏内身体的绑定（`V2-P2-09A` / `V2-P2-09C`）。
 *
 * `screenId` 对应 SMAPI `Context.ScreenId`（0 为主屏）；`uniqueMultiplayerID` 是
 * `Farmer.UniqueMultiplayerID`，用十进制字符串避免 JS number 精度丢失。
 *
 * 为什么必须有它：同机分屏下同一个游戏进程里跑着多个 `Game1` 实例，
 * 「哪个 AI 对应屏幕上的哪个身体」如果只靠 participantId 猜，就会控制错人。
 * 绑定是**唯一事实源**，动作路由与接管判定都必须以它为准。
 */
export const StardewScreenBindingSchema = z.object({
  /** 分屏屏号：0 为主屏；单客户端联机时恒为 0 */
  screenId: z.number().int().nonnegative(),
  /** 游戏内唯一多人 ID（Farmer.UniqueMultiplayerID，十进制字符串，避免 JS number 精度丢失） */
  uniqueMultiplayerID: z.string().regex(/^[0-9]+$/u),
  /** 该屏身份：房主或农场工人 */
  role: z.enum(['host', 'farmhand']),
});
export type StardewScreenBinding = z.infer<typeof StardewScreenBindingSchema>;

export const CoopParticipantSchema = z.object({  participantId: z.string().min(1),
  kind: z.enum(['human', 'ai']),
  characterId: z.string().min(1),
  displayName: z.string().min(1),
  endpointId: z.string().min(1),
  mcpPort: z.number().int().min(1024).max(65535).optional(),
  controlOwner: z.enum(['ai', 'human', 'paused', 'halted']),
  connectionState: CoopConnectionStateSchema,
  lastHeartbeatAt: z.number().int().nonnegative(),
  reconnectDeadlineAt: z.number().int().nonnegative().nullable().default(null),
  reconnectAttempts: z.number().int().nonnegative().default(0),
  /**
   * 该成员绑定的游戏内身体；`null` 表示**尚未绑定**。
   *
   * 未绑定时该成员**不得**收到任何控制动作（避免误控他人角色），
   * 这也是「同屏不打架」不能替代「按身体路由」的契约级理由。
   */
  bodyBinding: StardewScreenBindingSchema.nullable().default(null),
});
export type CoopParticipant = z.infer<typeof CoopParticipantSchema>;

/**
 * 按身体（`uniqueMultiplayerID`）索引的租约视图（`V2-P2-09C`）。
 *
 * host 与 farmhand 各持一份独立租约：人类在 host 身体的操作**不会**夺走
 * farmhand 身体的 AI 租约，反之亦然。这与「同屏不打架」是两件事：
 * 后者只保证不同时写两个身体，前者保证**各自身体的控制权归属互不串扰**。
 */
export const CoopBodyLeaseViewSchema = z.object({
  uniqueMultiplayerID: z.string().min(1),
  screenId: z.number().int().nonnegative(),
  role: z.enum(['host', 'farmhand']),
  participantId: z.string().min(1),
  controlOwner: z.enum(['ai', 'human', 'paused', 'halted']),
});
export type CoopBodyLeaseView = z.infer<typeof CoopBodyLeaseViewSchema>;

export const CoopTaskStatusSchema = z.enum([
  'proposed',
  'accepted',
  'running',
  'blocked',
  'completed',
  'failed',
]);
export type CoopTaskStatus = z.infer<typeof CoopTaskStatusSchema>;

export const CoopTaskItemSchema = z.object({
  taskId: z.string().min(1),
  roomId: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  ownerId: z.string().min(1),
  preconditions: z.array(z.string()).default([]),
  resourceLocks: z.array(z.string()).default([]),
  status: CoopTaskStatusSchema,
  priority: z.number().int().min(1).max(5).default(3),
  handoffNote: z.string().optional(),
  result: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type CoopTaskItem = z.infer<typeof CoopTaskItemSchema>;

export const CoopResourceIntentSchema = z.enum([
  'reserve',
  'keep',
  'harvest',
  'sell_forbidden',
]);
export type CoopResourceIntent = z.infer<typeof CoopResourceIntentSchema>;

export const CoopResourceReservationSchema = z.object({
  resourceKey: z.string().min(1),
  ownerId: z.string().min(1),
  intent: CoopResourceIntentSchema,
  reason: z.string().default(''),
  expiresAt: z.number().int().nonnegative(),
});
export type CoopResourceReservation = z.infer<typeof CoopResourceReservationSchema>;

export const CoopModSummarySchema = z.object({
  uniqueId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default('0.0.0'),
  enabled: z.boolean().default(true),
  contentType: z.string().default(''),
});
export type CoopModSummary = z.infer<typeof CoopModSummarySchema>;

export const CoopModMismatchSchema = z.object({
  uniqueId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['missing_on_peer', 'missing_on_host', 'version_mismatch', 'disabled_mismatch']),
  hostVersion: z.string().optional(),
  peerVersion: z.string().optional(),
  blocking: z.boolean(),
  detail: z.string(),
});
export type CoopModMismatch = z.infer<typeof CoopModMismatchSchema>;

export const CoopModCompatibilityReportSchema = z.object({
  compatible: z.boolean(),
  canStartCoop: z.boolean(),
  hostModsDir: z.string().optional(),
  peerModsDir: z.string().optional(),
  hostModCount: z.number().int().nonnegative(),
  peerModCount: z.number().int().nonnegative(),
  bwfReady: z.boolean(),
  avatarSyncReady: z.boolean(),
  mismatches: z.array(CoopModMismatchSchema),
  warnings: z.array(z.string()),
});
export type CoopModCompatibilityReport = z.infer<typeof CoopModCompatibilityReportSchema>;

export const CoopRuntimeSnapshotSchema = z.object({
  roomId: z.string().min(1),
  gameId: z.enum(['stardew', 'terraria', 'dst']),
  status: CoopRoomStatusSchema,
  epoch: z.number().int().nonnegative(),
  sharedGoal: z.string(),
  participants: z.array(CoopParticipantSchema),
  tasks: z.array(CoopTaskItemSchema),
  reservations: z.array(CoopResourceReservationSchema),
  lastCompatReport: CoopModCompatibilityReportSchema.nullable().default(null),
  /** 按身体索引的租约视图（`V2-P2-09C`）：host/farmhand 各持一份，互不抢占 */
  bodyLeases: z.array(CoopBodyLeaseViewSchema).default([]),
  updatedAt: z.number().int().nonnegative(),
});
export type CoopRuntimeSnapshot = z.infer<typeof CoopRuntimeSnapshotSchema>;
