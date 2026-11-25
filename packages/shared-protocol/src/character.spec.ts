import { describe, expect, it } from 'vitest';
import {
  ActivityStateDomainSchema,
  CharacterCommitmentSchema,
  CharacterCoreSnapshotSchema,
  CharacterGoalSchema,
  CharacterIdentityDomainSchema,
  EmbodimentBindingSchema,
  EmotionDomainSchema,
  MemoryIndexRefSchema,
  MotivationDomainSchema,
  PersonalityDomainSchema,
  PreferencesDomainSchema,
  RelationshipRefSchema,
  VoiceIdentityDomainSchema,
} from './character';

describe('CharacterCore 12-domain shared-protocol schemas (V2-P1-01)', () => {
  it('parses a complete 12-domain CharacterCoreSnapshot with defaults', () => {
    const snapshot = CharacterCoreSnapshotSchema.parse({
      identity: {
        characterId: 'char_xiaojing',
        displayName: '小鲸',
        personaProfileId: 'persona_xiaojing',
        voiceProfileId: 'voice_xiaojing',
        assetSetId: 'blue-whale-maid',
      },
      personality: {
        personaProfileId: 'persona_xiaojing',
        characterId: 'char_xiaojing',
        basePrompt: '你是小鲸',
        stableTraits: { curiosity: 0.8, patience: 0.65 },
      },
      preferences: {
        characterId: 'char_xiaojing',
      },
      emotion: {
        characterId: 'char_xiaojing',
      },
      motivation: {
        characterId: 'char_xiaojing',
      },
      goals: [
        {
          goalId: 'goal-1',
          characterId: 'char_xiaojing',
          title: '陪主人调试星露谷',
        },
      ],
      commitments: [
        {
          commitmentId: 'com-1',
          characterId: 'char_xiaojing',
          partnerId: 'owner',
          title: '先清理背包再下矿',
        },
      ],
      relationships: [
        {
          partnerId: 'owner',
          role: 'owner',
          displayName: '主人',
        },
      ],
      memory: {
        memoryNamespace: 'char_xiaojing',
      },
      voiceIdentity: {
        voiceProfileId: 'voice_xiaojing',
        characterId: 'char_xiaojing',
        voiceDescription: '俏皮傲娇蓝鲸女仆少女声线',
      },
      embodiments: [
        {
          embodimentId: 'emb-desktop',
          characterId: 'char_xiaojing',
          kind: 'desktop-2d',
          targetId: 'default',
          assetId: 'blue-whale-maid',
          active: true,
        },
      ],
      activityState: {
        characterId: 'char_xiaojing',
      },
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.identity.roleMode).toBe('primary');
    expect(snapshot.emotion.label).toBe('平静');
    expect(snapshot.motivation.primaryDrive).toBe('companion');
    expect(snapshot.goals[0]?.status).toBe('active');
    expect(snapshot.commitments[0]?.status).toBe('active');
    expect(snapshot.relationships[0]?.authorityStore).toBe('local-store');
    expect(snapshot.memory.authorityStore).toBe('memory-graph');
    expect(snapshot.voiceIdentity.licenseScope).toBe('DEV_ONLY_NON_COMMERCIAL');
    expect(snapshot.embodiments[0]?.kind).toBe('desktop-2d');
    expect(snapshot.activityState.mode).toBe('companion');
    expect(snapshot.activityState.budget.dailyTokenBudget).toBe(100_000);
  });

  it('rejects out-of-range numeric bounds and invalid enums across domains', () => {
    expect(CharacterIdentityDomainSchema.safeParse({
      characterId: '',
      displayName: 'x',
      personaProfileId: 'p',
      voiceProfileId: 'v',
      assetSetId: 'a',
    }).success).toBe(false);

    expect(PersonalityDomainSchema.safeParse({
      personaProfileId: 'p',
      characterId: 'c',
      basePrompt: 'prompt',
      stableTraits: { curiosity: 1.5 },
    }).success).toBe(false);

    expect(PreferencesDomainSchema.safeParse({
      characterId: 'c',
      items: [{ category: 'games', key: 'stardew', score: 2, source: 'play' }],
    }).success).toBe(false);

    expect(EmotionDomainSchema.safeParse({
      characterId: 'c',
      valence: -2,
    }).success).toBe(false);

    expect(MotivationDomainSchema.safeParse({
      characterId: 'c',
      primaryDrive: 'invalid_drive',
    }).success).toBe(false);

    expect(CharacterGoalSchema.safeParse({
      goalId: 'g1',
      characterId: 'c',
      title: 'test',
      priority: 101,
    }).success).toBe(false);

    expect(CharacterCommitmentSchema.safeParse({
      commitmentId: 'c1',
      characterId: 'c',
      partnerId: 'owner',
      title: '',
    }).success).toBe(false);

    expect(RelationshipRefSchema.safeParse({
      partnerId: 'u1',
      role: 'stranger',
      displayName: 'x',
    }).success).toBe(false);

    expect(MemoryIndexRefSchema.safeParse({
      memoryNamespace: 'c',
      authorityStore: 'unknown',
    }).success).toBe(false);

    expect(VoiceIdentityDomainSchema.safeParse({
      voiceProfileId: 'v1',
      characterId: 'c',
      voiceDescription: 'desc',
      languageVariants: [],
    }).success).toBe(false);

    expect(EmbodimentBindingSchema.safeParse({
      embodimentId: 'e1',
      characterId: 'c',
      kind: 'hologram',
      targetId: 't1',
      assetId: 'a1',
    }).success).toBe(false);

    expect(ActivityStateDomainSchema.safeParse({
      characterId: 'c',
      schedule: [{ slotId: 's1', startMinute: 0, endMinute: 2000, preferredActivity: 'resting', label: 'bad' }],
    }).success).toBe(false);
  });
});
