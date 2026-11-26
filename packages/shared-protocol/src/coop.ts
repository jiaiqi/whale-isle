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

export const CoopParticipantSchema = z.object({
  participantId: z.string().min(1),
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
});
export type CoopParticipant = z.infer<typeof CoopParticipantSchema>;

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
  updatedAt: z.number().int().nonnegative(),
});
export type CoopRuntimeSnapshot = z.infer<typeof CoopRuntimeSnapshotSchema>;
