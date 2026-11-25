/**
 * CharacterCore 域存储拆分（V2-P1-01）：
 * - PersonaProfileStore：域 1 Identity / 域 2 Personality / 域 10 VoiceIdentity / 域 8·9 轻量索引引用
 * - PreferenceStore：域 3 Preferences（经历驱动的偏好演化与来源历史）
 * - EmbodimentRegistry：域 11 Embodiment（桌面 2D / Live2D / VRM / 游戏 / 舞台）
 * - EmotionStateEngine：域 4 Emotion（短期情绪衰减与严格禁权不变式）
 */
import {
  CharacterIdentityDomainSchema,
  EmbodimentBindingSchema,
  EmotionDomainSchema,
  MemoryIndexRefSchema,
  PersonalityDomainSchema,
  PreferenceCategorySchema,
  PreferencesDomainSchema,
  RelationshipRefSchema,
  VoiceIdentityDomainSchema,
  type CharacterIdentityDomain,
  type EmbodimentBinding,
  type EmbodimentBindingInput,
  type EmbodimentKind,
  type EmotionDomain,
  type MemoryIndexRef,
  type PersonalityDomain,
  type PreferenceCategory,
  type PreferenceItem,
  type PreferencesDomain,
  type RelationshipRef,
  type RelationshipRefInput,
  type VoiceIdentityDomain,
} from '@workbench/shared-protocol';
import { WhaleError } from '@workbench/runtime-core';

const MAX_HISTORY_ENTRIES = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface PersonaProfileStoreOptions {
  identity: CharacterIdentityDomain;
  personality: PersonalityDomain;
  voiceIdentity: VoiceIdentityDomain;
  relationships: RelationshipRef[];
  memory: MemoryIndexRef;
  now?: () => number;
  onMutate?: () => void;
}

/** 域 1 / 域 2 / 域 10 权威存储与域 8 / 域 9 轻量索引投影 */
export class PersonaProfileStore {
  private identityState: CharacterIdentityDomain;
  private personalityState: PersonalityDomain;
  private voiceState: VoiceIdentityDomain;
  private relationshipRefs: RelationshipRef[];
  private memoryRefState: MemoryIndexRef;
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(options: PersonaProfileStoreOptions) {
    this.identityState = CharacterIdentityDomainSchema.parse(options.identity);
    this.personalityState = PersonalityDomainSchema.parse(options.personality);
    this.voiceState = VoiceIdentityDomainSchema.parse(options.voiceIdentity);
    this.relationshipRefs = options.relationships.map((r) => RelationshipRefSchema.parse(r));
    this.memoryRefState = MemoryIndexRefSchema.parse(options.memory);
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  identity(): CharacterIdentityDomain {
    return structuredClone(this.identityState);
  }

  personality(): PersonalityDomain {
    return structuredClone(this.personalityState);
  }

  voiceIdentity(): VoiceIdentityDomain {
    return structuredClone(this.voiceState);
  }

  relationships(): RelationshipRef[] {
    return structuredClone(this.relationshipRefs);
  }

  memoryRef(): MemoryIndexRef {
    return structuredClone(this.memoryRefState);
  }

  /** 更新可展示字段，但绝不允许改写不可变的 characterId */
  updateIdentityDisplay(
    patch: Partial<Pick<CharacterIdentityDomain, 'displayName' | 'description' | 'assetSetId' | 'voiceProfileId'>>,
  ): CharacterIdentityDomain {
    const next = CharacterIdentityDomainSchema.parse({
      ...this.identityState,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.assetSetId === undefined ? {} : { assetSetId: patch.assetSetId }),
      ...(patch.voiceProfileId === undefined ? {} : { voiceProfileId: patch.voiceProfileId }),
      updatedAt: this.now(),
    });
    this.identityState = next;
    this.onMutate?.();
    return structuredClone(next);
  }

  /** 经历驱动的人格微调（范围钳制 [0, 1]，记录变化来源） */
  evolveTrait(trait: string, delta: number, reason: string, sourceEventId?: string): PersonalityDomain {
    const trimmedTrait = trait.trim();
    const trimmedReason = reason.trim();
    if (trimmedTrait === '' || trimmedReason === '') {
      throw new WhaleError('CONFIG_INVALID', '人格特质名称与变化原因不能为空', {
        recoverable: true,
        context: { reason: 'INVALID_TRAIT_EVOLUTION' },
      });
    }
    const prev = this.personalityState.stableTraits[trimmedTrait] ?? 0.5;
    const nextVal = Number(clamp(prev + delta, 0, 1).toFixed(4));
    const t = this.now();
    const entry = {
      trait: trimmedTrait,
      prev,
      next: nextVal,
      delta: Number((nextVal - prev).toFixed(4)),
      reason: trimmedReason,
      ...(sourceEventId === undefined ? {} : { sourceEventId }),
      timestamp: t,
    };
    const nextHistory = [...this.personalityState.evolutionHistory, entry].slice(-MAX_HISTORY_ENTRIES);
    this.personalityState = PersonalityDomainSchema.parse({
      ...this.personalityState,
      stableTraits: {
        ...this.personalityState.stableTraits,
        [trimmedTrait]: nextVal,
      },
      evolutionHistory: nextHistory,
      version: this.personalityState.version + 1,
      updatedAt: t,
    });
    this.onMutate?.();
    return structuredClone(this.personalityState);
  }

  updateBasePrompt(basePrompt: string): PersonalityDomain {
    const trimmed = basePrompt.trim();
    if (trimmed === '') {
      throw new WhaleError('CONFIG_INVALID', '基础人设描述不能为空', {
        recoverable: true,
        context: { reason: 'INVALID_PROMPT' },
      });
    }
    this.personalityState = PersonalityDomainSchema.parse({
      ...this.personalityState,
      basePrompt: trimmed,
      version: this.personalityState.version + 1,
      updatedAt: this.now(),
    });
    this.onMutate?.();
    return structuredClone(this.personalityState);
  }

  updateVoiceIdentity(
    patch: Partial<Pick<VoiceIdentityDomain, 'voiceProfileId' | 'voiceDescription' | 'preferredProviderId' | 'providerVoiceRef' | 'licenseScope' | 'speechStyle' | 'singingStyle'>>,
  ): VoiceIdentityDomain {
    const t = this.now();
    this.voiceState = VoiceIdentityDomainSchema.parse({
      ...this.voiceState,
      ...(patch.voiceProfileId === undefined ? {} : { voiceProfileId: patch.voiceProfileId }),
      ...(patch.voiceDescription === undefined ? {} : { voiceDescription: patch.voiceDescription }),
      ...(patch.preferredProviderId === undefined ? {} : { preferredProviderId: patch.preferredProviderId }),
      ...(patch.providerVoiceRef === undefined ? {} : { providerVoiceRef: patch.providerVoiceRef }),
      ...(patch.licenseScope === undefined ? {} : { licenseScope: patch.licenseScope }),
      ...(patch.speechStyle === undefined ? {} : { speechStyle: patch.speechStyle }),
      ...(patch.singingStyle === undefined ? {} : { singingStyle: patch.singingStyle }),
      version: this.voiceState.version + 1,
      updatedAt: t,
    });
    if (patch.voiceProfileId !== undefined) {
      this.identityState = CharacterIdentityDomainSchema.parse({
        ...this.identityState,
        voiceProfileId: this.voiceState.voiceProfileId,
        updatedAt: t,
      });
    }
    this.onMutate?.();
    return structuredClone(this.voiceState);
  }

  upsertRelationshipRef(input: RelationshipRefInput): RelationshipRef {
    const parsed = RelationshipRefSchema.parse({
      ...input,
      lastInteractionAt: input.lastInteractionAt ?? this.now(),
    });
    const idx = this.relationshipRefs.findIndex((r) => r.partnerId === parsed.partnerId);
    if (idx >= 0) {
      this.relationshipRefs[idx] = parsed;
    } else {
      this.relationshipRefs.push(parsed);
    }
    this.onMutate?.();
    return structuredClone(parsed);
  }

  updateMemoryRef(patch: Partial<Pick<MemoryIndexRef, 'lastConsolidatedAt' | 'pinnedCount' | 'recentHighlights'>>): MemoryIndexRef {
    this.memoryRefState = MemoryIndexRefSchema.parse({
      ...this.memoryRefState,
      ...(patch.lastConsolidatedAt === undefined ? {} : { lastConsolidatedAt: patch.lastConsolidatedAt }),
      ...(patch.pinnedCount === undefined ? {} : { pinnedCount: patch.pinnedCount }),
      ...(patch.recentHighlights === undefined ? {} : { recentHighlights: patch.recentHighlights }),
    });
    this.onMutate?.();
    return structuredClone(this.memoryRefState);
  }
}

/** 域 3：Preferences 长期偏好存储 */
export class PreferenceStore {
  private state: PreferencesDomain;
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(
    initial: PreferencesDomain,
    options: { now?: () => number; onMutate?: () => void } = {},
  ) {
    this.state = PreferencesDomainSchema.parse(initial);
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  snapshot(): PreferencesDomain {
    return structuredClone(this.state);
  }

  recordExperience(input: {
    category: PreferenceCategory;
    key: string;
    delta: number;
    source: string;
    reason: string;
    confidence?: number;
  }): PreferenceItem {
    const category = PreferenceCategorySchema.parse(input.category);
    const key = input.key.trim();
    const source = input.source.trim();
    const reason = input.reason.trim();
    if (key === '' || source === '' || reason === '') {
      throw new WhaleError('CONFIG_INVALID', '偏好键名、来源与原因不能为空', {
        recoverable: true,
        context: { reason: 'INVALID_PREFERENCE' },
      });
    }
    const t = this.now();
    const existingIdx = this.state.items.findIndex((item) => item.category === category && item.key === key);
    const existing = existingIdx >= 0 ? this.state.items[existingIdx] : undefined;
    const prevScore = existing?.score ?? 0;
    const nextScore = Number(clamp(prevScore + input.delta, -1, 1).toFixed(4));
    const nextConfidence = Number(
      clamp(input.confidence ?? (existing ? existing.confidence + 0.08 : 0.45), 0, 1).toFixed(4),
    );
    const updatedItem: PreferenceItem = {
      category,
      key,
      score: nextScore,
      confidence: nextConfidence,
      source,
      updatedAt: t,
    };
    const nextItems = [...this.state.items];
    if (existingIdx >= 0) {
      nextItems[existingIdx] = updatedItem;
    } else {
      nextItems.push(updatedItem);
    }
    const nextHistory = [
      ...this.state.history,
      {
        category,
        key,
        prevScore,
        nextScore,
        source,
        reason,
        timestamp: t,
      },
    ].slice(-MAX_HISTORY_ENTRIES);

    this.state = PreferencesDomainSchema.parse({
      characterId: this.state.characterId,
      items: nextItems,
      history: nextHistory,
      updatedAt: t,
    });
    this.onMutate?.();
    return structuredClone(updatedItem);
  }

  topPreferences(category?: PreferenceCategory, limit = 5): PreferenceItem[] {
    const filtered = category === undefined
      ? this.state.items
      : this.state.items.filter((item) => item.category === category);
    return [...filtered]
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, Math.max(1, limit))
      .map((item) => structuredClone(item));
  }
}

/** 域 11：Embodiment 跨维度身体映射注册表 */
export class EmbodimentRegistry {
  private bindings: EmbodimentBinding[];
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(
    private readonly characterId: string,
    initial: EmbodimentBinding[],
    options: { now?: () => number; onMutate?: () => void } = {},
  ) {
    this.bindings = initial.map((b) => EmbodimentBindingSchema.parse(b));
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  list(): EmbodimentBinding[] {
    return structuredClone(this.bindings);
  }

  getActive(kind: EmbodimentKind): EmbodimentBinding | null {
    const found = this.bindings.find((b) => b.kind === kind && b.active && b.enabled);
    return found ? structuredClone(found) : null;
  }

  upsert(input: EmbodimentBindingInput): EmbodimentBinding {
    const parsed = EmbodimentBindingSchema.parse({
      ...input,
      characterId: this.characterId,
      updatedAt: input.updatedAt ?? this.now(),
    });
    if (parsed.active) {
      this.bindings = this.bindings.map((b) => (b.kind === parsed.kind ? { ...b, active: false } : b));
    }
    const idx = this.bindings.findIndex((b) => b.embodimentId === parsed.embodimentId);
    if (idx >= 0) {
      this.bindings[idx] = parsed;
    } else {
      this.bindings.push(parsed);
    }
    this.onMutate?.();
    return structuredClone(parsed);
  }

  /** 仅切换桌面 2D 外观绑定，保留 characterId 与游戏/舞台等其他化身 */
  switchDesktopAppearance(input: {
    assetId: string;
    targetId?: string;
    manifestPath?: string;
    anchorRatio?: number;
    licenseScope?: 'DEV_ONLY_NON_COMMERCIAL' | 'COMMERCIAL_READY';
  }): EmbodimentBinding {
    const targetId = input.targetId ?? 'default';
    return this.upsert({
      embodimentId: `emb-desktop-${targetId}`,
      characterId: this.characterId,
      kind: 'desktop-2d',
      targetId,
      assetId: input.assetId,
      assetVersionId: 'v1',
      ...(input.manifestPath === undefined ? {} : { manifestPath: input.manifestPath }),
      ...(input.anchorRatio === undefined ? {} : { anchorRatio: input.anchorRatio }),
      licenseScope: input.licenseScope ?? 'DEV_ONLY_NON_COMMERCIAL',
      enabled: true,
      active: true,
      updatedAt: this.now(),
    });
  }
}

/** 域 4：Emotion 短期情绪引擎（严禁提升任何工具权限） */
export class EmotionStateEngine {
  private state: EmotionDomain;
  private readonly now: () => number;
  private readonly onMutate: (() => void) | undefined;

  constructor(
    initial: EmotionDomain,
    options: { now?: () => number; onMutate?: () => void } = {},
  ) {
    this.state = EmotionDomainSchema.parse(initial);
    this.now = options.now ?? Date.now;
    this.onMutate = options.onMutate;
  }

  /** 安全不变式：情绪只能影响语气与表达，永不提升工具或权限等级 */
  canElevateToolPermission(): false {
    return false;
  }

  current(): EmotionDomain {
    const t = this.now();
    if (this.state.expiresAt !== undefined && t >= this.state.expiresAt) {
      this.state = EmotionDomainSchema.parse({
        ...this.state,
        valence: 0.2,
        arousal: 0.3,
        label: '平静',
        currentLabels: ['平静'],
        expiresAt: undefined,
        updatedAt: t,
      });
      this.onMutate?.();
    }
    return structuredClone(this.state);
  }

  update(
    patch: Partial<Pick<EmotionDomain, 'valence' | 'arousal' | 'confidence' | 'socialEnergy' | 'label' | 'currentLabels' | 'expiresAt'>>,
  ): EmotionDomain {
    const t = this.now();
    const label = patch.label ?? this.state.label;
    const currentLabels = patch.currentLabels ?? (patch.label === undefined ? this.state.currentLabels : [patch.label]);
    this.state = EmotionDomainSchema.parse({
      characterId: this.state.characterId,
      valence: clamp(patch.valence ?? this.state.valence, -1, 1),
      arousal: clamp(patch.arousal ?? this.state.arousal, 0, 1),
      confidence: clamp(patch.confidence ?? this.state.confidence, 0, 1),
      socialEnergy: clamp(patch.socialEnergy ?? this.state.socialEnergy, 0, 1),
      label,
      currentLabels,
      updatedAt: t,
      ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
    });
    this.onMutate?.();
    return structuredClone(this.state);
  }

  applyStimulus(input: {
    deltaValence: number;
    deltaArousal: number;
    label: string;
    ttlMs?: number;
  }): EmotionDomain {
    const base = this.current();
    const t = this.now();
    return this.update({
      valence: base.valence + input.deltaValence,
      arousal: base.arousal + input.deltaArousal,
      label: input.label,
      currentLabels: [input.label],
      ...(input.ttlMs === undefined ? {} : { expiresAt: t + Math.max(1000, input.ttlMs) }),
    });
  }
}
