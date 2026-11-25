import { describe, expect, it } from 'vitest';
import {
  GameKnowledgeItemSchema,
  GameKnowledgeSourceTypeSchema,
  GameKnowledgeStatusSchema,
  GameRuntimeContextSchema,
  GuideCompatibilityReportSchema,
  GuideCompatibilityStatusSchema,
  GuideProvenanceSchema,
} from './knowledge';

describe('shared-protocol V2-P2-01 knowledge contracts', () => {
  it('applies defaults and validates provenance & runtime context', () => {
    const prov = GuideProvenanceSchema.parse({});
    expect(prov).toEqual({
      gameId: 'stardew',
      sourceType: 'wiki',
      modContext: [],
    });

    const ctx = GameRuntimeContextSchema.parse({ gameVersion: '1.6.15', installedMods: ['Automate'] });
    expect(ctx.gameId).toBe('stardew');
    expect(ctx.installedMods).toEqual(['Automate']);

    const compat = GuideCompatibilityReportSchema.parse({
      status: 'mod-mismatch',
      versionMatch: 'match',
      modMatch: 'missing-mods',
      missingMods: ['SVE'],
      warnings: ['缺少 Mod：SVE'],
    });
    expect(compat.status).toBe('mod-mismatch');
  });

  it('validates GameKnowledgeItem aligned with Blueprint 17 §7.3', () => {
    for (const sourceType of ['official', 'wiki', 'community', 'video', 'user', 'experience']) {
      expect(GameKnowledgeSourceTypeSchema.safeParse(sourceType).success).toBe(true);
    }
    for (const status of ['unverified', 'partially-verified', 'verified', 'outdated', 'rejected']) {
      expect(GameKnowledgeStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const compatStatus of ['compatible', 'uncertain', 'outdated', 'mod-mismatch']) {
      expect(GuideCompatibilityStatusSchema.safeParse(compatStatus).success).toBe(true);
    }

    const item = GameKnowledgeItemSchema.parse({
      knowledgeId: 'ins-1',
      gameId: 'stardew',
      gameVersion: '1.6',
      modContext: ['SMAPI'],
      topic: '四季作物收益#Strawberry',
      claim: '春13蛋节买草莓种子收益较高',
      sourceType: 'wiki',
      sourceUri: 'https://stardewvalleywiki.com/wiki/Crops',
      sourceTitle: 'Crops',
      retrievedAt: '2026-11-26T00:00:00.000Z',
      evidenceSummary: '春13 购买 12 颗后按时收获盈利',
      confidence: 0.85,
      applicability: ['春季13日之前', '金钱 >= 1000g'],
      knownLimitations: ['仅第一年春季适合长线复种'],
      contradictoryEvidence: [],
      status: 'verified',
    });
    expect(item.confidence).toBe(0.85);
    expect(item.status).toBe('verified');

    expect(
      GameKnowledgeItemSchema.safeParse({
        knowledgeId: 'ins-bad',
        topic: 't',
        claim: 'c',
        sourceType: 'wiki',
        retrievedAt: '2026-11-26',
        confidence: 1.5,
        status: 'verified',
      }).success,
    ).toBe(false);
  });
});
