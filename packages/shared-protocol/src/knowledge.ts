/**
 * Whale Isle V2 — 游戏攻略知识、来源溯源、版本/Mod 兼容与实玩验证闭环契约（V2-P2-01 / Blueprint 17 §7.3）
 */
import { z } from 'zod';

export const GameKnowledgeSourceTypeSchema = z.enum([
  'official',
  'wiki',
  'community',
  'video',
  'user',
  'experience',
]);
export type GameKnowledgeSourceType = z.infer<typeof GameKnowledgeSourceTypeSchema>;

export const GameKnowledgeStatusSchema = z.enum([
  'unverified',
  'partially-verified',
  'verified',
  'outdated',
  'rejected',
]);
export type GameKnowledgeStatus = z.infer<typeof GameKnowledgeStatusSchema>;

export const GuideCompatibilityStatusSchema = z.enum([
  'compatible',
  'uncertain',
  'outdated',
  'mod-mismatch',
]);
export type GuideCompatibilityStatus = z.infer<typeof GuideCompatibilityStatusSchema>;

export const GuideProvenanceSchema = z.object({
  gameId: z.string().min(1).default('stardew'),
  sourceType: GameKnowledgeSourceTypeSchema.default('wiki'),
  sourceTitle: z.string().min(1).optional(),
  sourceUri: z.string().min(1).optional(),
  gameVersion: z.string().min(1).optional(),
  modContext: z.array(z.string().min(1)).default([]),
  retrievedAt: z.string().min(1).optional(),
});
export type GuideProvenance = z.infer<typeof GuideProvenanceSchema>;

export const GameRuntimeContextSchema = z.object({
  gameId: z.string().min(1).default('stardew'),
  gameVersion: z.string().min(1).optional(),
  installedMods: z.array(z.string().min(1)).default([]),
});
export type GameRuntimeContext = z.infer<typeof GameRuntimeContextSchema>;

export const GuideCompatibilityReportSchema = z.object({
  status: GuideCompatibilityStatusSchema,
  versionMatch: z.enum(['match', 'mismatch', 'unknown']),
  modMatch: z.enum(['match', 'missing-mods', 'unknown']),
  missingMods: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string().min(1)).default([]),
});
export type GuideCompatibilityReport = z.infer<typeof GuideCompatibilityReportSchema>;

/** 对齐 Blueprint 17 §7.3 `GameKnowledgeItem` */
export const GameKnowledgeItemSchema = z.object({
  knowledgeId: z.string().min(1),
  gameId: z.string().min(1).default('stardew'),
  gameVersion: z.string().min(1).optional(),
  modContext: z.array(z.string().min(1)).default([]),
  topic: z.string().min(1),
  claim: z.string().min(1),
  sourceType: GameKnowledgeSourceTypeSchema,
  sourceUri: z.string().min(1).optional(),
  sourceTitle: z.string().min(1).optional(),
  retrievedAt: z.string().min(1),
  evidenceSummary: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  applicability: z.array(z.string().min(1)).default([]),
  knownLimitations: z.array(z.string().min(1)).default([]),
  contradictoryEvidence: z.array(z.string().min(1)).default([]),
  status: GameKnowledgeStatusSchema,
});
export type GameKnowledgeItem = z.infer<typeof GameKnowledgeItemSchema>;
