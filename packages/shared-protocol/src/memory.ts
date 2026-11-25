/**
 * Whale Isle V2 — 类人五类记忆、模糊印象与级联真删除共享契约（V2-P1-04 / ADR-002 D-108）
 * - 五类记忆：working / episodic / semantic / relational / self
 * - 区分自然衰变遗忘（naturalDecayed）与显式用户删除（MemoryDeletionAudit 无明文留痕）
 */
import { z } from 'zod';

export const MemoryCategorySchema = z.enum([
  'working',
  'episodic',
  'semantic',
  'relational',
  'self',
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

export const MemoryRetentionPolicySchema = z.enum([
  'ephemeral',
  'standard',
  'consolidated',
  'protected_self',
]);
export type MemoryRetentionPolicy = z.infer<typeof MemoryRetentionPolicySchema>;

export const MemoryUncertaintyLevelSchema = z.enum([
  'clear',
  'fuzzy',
  'uncertain',
]);
export type MemoryUncertaintyLevel = z.infer<typeof MemoryUncertaintyLevelSchema>;

export const MemoryCorrectionEntrySchema = z.object({
  prevText: z.string().min(1),
  nextText: z.string().min(1),
  reason: z.string().min(1),
  correctedAt: z.number().int().nonnegative(),
});
export type MemoryCorrectionEntry = z.infer<typeof MemoryCorrectionEntrySchema>;

/** 不可删除的删除审计条目：绝不保存被删除的正文，仅保留 ID、分类、原因与清理统计 */
export const MemoryDeletionAuditSchema = z.object({
  auditId: z.string().min(1),
  targetNodeId: z.string().min(1),
  targetCategory: MemoryCategorySchema,
  reason: z.string().min(1),
  deletedNodeIds: z.array(z.string().min(1)),
  deletedDerivedIds: z.array(z.string().min(1)),
  clearedLedgerRefs: z.array(z.string().min(1)),
  deletedAt: z.number().int().nonnegative(),
});
export type MemoryDeletionAudit = z.infer<typeof MemoryDeletionAuditSchema>;

export const FuzzyImpressionSchema = z.object({
  nodeId: z.string().min(1),
  entityKey: z.string().min(1),
  displayName: z.string().min(1),
  interactionCount: z.number().int().positive(),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  lastSeenAt: z.number().int().nonnegative(),
  sourceNodeIds: z.array(z.string().min(1)),
});
export type FuzzyImpression = z.infer<typeof FuzzyImpressionSchema>;
