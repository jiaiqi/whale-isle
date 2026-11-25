import { describe, expect, it } from 'vitest';
import {
  FuzzyImpressionSchema,
  MemoryCategorySchema,
  MemoryCorrectionEntrySchema,
  MemoryDeletionAuditSchema,
  MemoryRetentionPolicySchema,
  MemoryUncertaintyLevelSchema,
} from './memory';

describe('Five-category human-like memory schemas (V2-P1-04)', () => {
  it('parses categories, retention policies, uncertainty levels, audits, and fuzzy impressions', () => {
    expect(MemoryCategorySchema.options).toEqual([
      'working',
      'episodic',
      'semantic',
      'relational',
      'self',
    ]);
    expect(MemoryRetentionPolicySchema.parse('protected_self')).toBe('protected_self');
    expect(MemoryUncertaintyLevelSchema.parse('fuzzy')).toBe('fuzzy');

    const correction = MemoryCorrectionEntrySchema.parse({
      prevText: '鱼干喜欢晴天钓鱼',
      nextText: '烤鱼干喜欢雨天海滩钓鱼',
      reason: '用户手动纠正',
      correctedAt: 1_764_000_000_000,
    });
    expect(correction.nextText).toContain('烤鱼干');

    const audit = MemoryDeletionAuditSchema.parse({
      auditId: 'del-1',
      targetNodeId: 'n00000001',
      targetCategory: 'episodic',
      reason: '用户请求删除',
      deletedNodeIds: ['n00000001'],
      deletedDerivedIds: ['n00000002'],
      clearedLedgerRefs: ['u-42'],
      deletedAt: 1_764_000_000_000,
    });
    expect(audit.deletedDerivedIds).toHaveLength(1);

    const impression = FuzzyImpressionSchema.parse({
      nodeId: 'n00000010',
      entityKey: 'viewer:u-42',
      displayName: '烤鱼干',
      interactionCount: 4,
      summary: '对「烤鱼干」的模糊印象：近期常来互动',
      confidence: 0.75,
      lastSeenAt: 1_764_000_000_000,
      sourceNodeIds: ['n00000001', 'n00000003'],
    });
    expect(impression.interactionCount).toBe(4);
  });

  it('rejects invalid categories and out-of-range confidence', () => {
    expect(MemoryCategorySchema.safeParse('other').success).toBe(false);
    expect(FuzzyImpressionSchema.safeParse({
      nodeId: 'n1',
      entityKey: 'k',
      displayName: 'd',
      interactionCount: 0,
      summary: 's',
      confidence: 1.5,
      lastSeenAt: 1,
      sourceNodeIds: [],
    }).success).toBe(false);
  });
});
