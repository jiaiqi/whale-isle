/**
 * Whale Isle V2 — CharacterCore 12 域与 LifeRuntime 共享契约（V2-P1-01）
 * - 12 域分权：Identity / Personality / Preferences / Emotion / Motivation / Goals /
 *   Commitments / Relationships(ref) / Memory(ref) / VoiceIdentity / Embodiment / ActivityState
 * - 零外部依赖（仅 zod），供 runtime-core / character-core / desktop-host 共用
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 域 1：Identity（唯一数字身份，贯穿桌宠 / 游戏 / 直播 / 声音 / 社区）
// ---------------------------------------------------------------------------
export const CharacterRoleModeSchema = z.enum(['primary', 'passive']);
export type CharacterRoleMode = z.infer<typeof CharacterRoleModeSchema>;

export const CharacterLifecycleSchema = z.enum(['active', 'archived']);
export type CharacterLifecycle = z.infer<typeof CharacterLifecycleSchema>;

export const CharacterIdentityDomainSchema = z.object({
  characterId: z.string().min(1),
  displayName: z.string().min(1),
  roleMode: CharacterRoleModeSchema.default('primary'),
  description: z.string().default(''),
  personaProfileId: z.string().min(1),
  voiceProfileId: z.string().min(1),
  assetSetId: z.string().min(1),
  lifecycle: CharacterLifecycleSchema.default('active'),
  createdAt: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type CharacterIdentityDomain = z.output<typeof CharacterIdentityDomainSchema>;
export type CharacterIdentityDomainInput = z.input<typeof CharacterIdentityDomainSchema>;

// ---------------------------------------------------------------------------
// 域 2：Personality（稳定特质、行为红线与经历驱动的缓慢演化历史）
// ---------------------------------------------------------------------------
export const PersonalityTraitHistoryEntrySchema = z.object({
  trait: z.string().min(1),
  prev: z.number().min(0).max(1),
  next: z.number().min(0).max(1),
  delta: z.number(),
  reason: z.string().min(1),
  sourceEventId: z.string().min(1).optional(),
  timestamp: z.number().int().nonnegative(),
});
export type PersonalityTraitHistoryEntry = z.infer<typeof PersonalityTraitHistoryEntrySchema>;

export const PersonalityDomainSchema = z.object({
  personaProfileId: z.string().min(1),
  characterId: z.string().min(1),
  basePrompt: z.string().min(1),
  stableTraits: z.record(z.string(), z.number().min(0).max(1)).default({}),
  values: z.array(z.string()).default([]),
  behaviorRules: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  evolutionHistory: z.array(PersonalityTraitHistoryEntrySchema).default([]),
  version: z.number().int().positive().default(1),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type PersonalityDomain = z.output<typeof PersonalityDomainSchema>;
export type PersonalityDomainInput = z.input<typeof PersonalityDomainSchema>;

// ---------------------------------------------------------------------------
// 域 3：Preferences（由真实经历塑造的长期偏好及溯源）
// ---------------------------------------------------------------------------
export const PreferenceCategorySchema = z.enum([
  'games',
  'music',
  'topics',
  'activities',
  'communicationStyle',
]);
export type PreferenceCategory = z.infer<typeof PreferenceCategorySchema>;

export const PreferenceItemSchema = z.object({
  category: PreferenceCategorySchema,
  key: z.string().min(1),
  score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1).default(0.5),
  source: z.string().min(1),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type PreferenceItem = z.output<typeof PreferenceItemSchema>;

export const PreferenceHistoryEntrySchema = z.object({
  category: PreferenceCategorySchema,
  key: z.string().min(1),
  prevScore: z.number().min(-1).max(1),
  nextScore: z.number().min(-1).max(1),
  source: z.string().min(1),
  reason: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
});
export type PreferenceHistoryEntry = z.infer<typeof PreferenceHistoryEntrySchema>;

export const PreferencesDomainSchema = z.object({
  characterId: z.string().min(1),
  items: z.array(PreferenceItemSchema).default([]),
  history: z.array(PreferenceHistoryEntrySchema).default([]),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type PreferencesDomain = z.output<typeof PreferencesDomainSchema>;
export type PreferencesDomainInput = z.input<typeof PreferencesDomainSchema>;

// ---------------------------------------------------------------------------
// 域 4：Emotion（短期情绪态；严禁提升工具或权限等级）
// ---------------------------------------------------------------------------
export const EmotionDomainSchema = z.object({
  characterId: z.string().min(1),
  valence: z.number().min(-1).max(1).default(0.25),
  arousal: z.number().min(0).max(1).default(0.35),
  confidence: z.number().min(0).max(1).default(0.7),
  socialEnergy: z.number().min(0).max(1).default(0.75),
  label: z.string().min(1).default('平静'),
  currentLabels: z.array(z.string()).default(['平静']),
  updatedAt: z.number().int().nonnegative().default(0),
  expiresAt: z.number().int().nonnegative().optional(),
});
export type EmotionDomain = z.output<typeof EmotionDomainSchema>;
export type EmotionDomainInput = z.input<typeof EmotionDomainSchema>;

// ---------------------------------------------------------------------------
// 域 5：Motivation（当前核心驱动力）
// ---------------------------------------------------------------------------
export const MotivationDriveSchema = z.enum([
  'explore',
  'companion',
  'achieve_goal',
  'create',
  'rest',
  'socialize',
  'perform',
]);
export type MotivationDrive = z.infer<typeof MotivationDriveSchema>;

export const MotivationDomainSchema = z.object({
  characterId: z.string().min(1),
  primaryDrive: MotivationDriveSchema.default('companion'),
  intensity: z.number().min(0).max(1).default(0.6),
  reason: z.string().default('桌面日常陪伴'),
  secondaryDrives: z.array(MotivationDriveSchema).default([]),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type MotivationDomain = z.output<typeof MotivationDomainSchema>;
export type MotivationDomainInput = z.input<typeof MotivationDomainSchema>;

// ---------------------------------------------------------------------------
// 域 6：Goals（多时间尺度目标栈）
// ---------------------------------------------------------------------------
export const GoalHorizonSchema = z.enum([
  'action',
  'short_term',
  'milestone',
  'long_term',
  'shared',
]);
export type GoalHorizon = z.infer<typeof GoalHorizonSchema>;

export const GoalOriginSchema = z.enum(['autonomous', 'user', 'shared']);
export type GoalOrigin = z.infer<typeof GoalOriginSchema>;

export const GoalStatusSchema = z.enum(['active', 'paused', 'completed', 'abandoned']);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const LifeActivityKindSchema = z.enum([
  'companion',
  'gaming',
  'streaming',
  'creative',
  'social',
  'resting',
  'halted',
]);
export type LifeActivityKind = z.infer<typeof LifeActivityKindSchema>;

export const CharacterGoalSchema = z.object({
  goalId: z.string().min(1),
  characterId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  horizon: GoalHorizonSchema.default('short_term'),
  origin: GoalOriginSchema.default('autonomous'),
  status: GoalStatusSchema.default('active'),
  priority: z.number().int().min(0).max(100).default(50),
  progress: z.number().min(0).max(1).default(0),
  relatedActivity: LifeActivityKindSchema.default('companion'),
  parentGoalId: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative().default(0),
  completedAt: z.number().int().nonnegative().optional(),
});
export type CharacterGoal = z.output<typeof CharacterGoalSchema>;
export type CharacterGoalInput = z.input<typeof CharacterGoalSchema>;

// ---------------------------------------------------------------------------
// 域 7：Commitments（与主人/伙伴达成的约定账本）
// ---------------------------------------------------------------------------
export const CommitmentStatusSchema = z.enum([
  'active',
  'fulfilled',
  'renegotiated',
  'cancelled',
]);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export const CharacterCommitmentSchema = z.object({
  commitmentId: z.string().min(1),
  characterId: z.string().min(1),
  partnerId: z.string().min(1),
  partnerName: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  detail: z.string().max(1000).default(''),
  status: CommitmentStatusSchema.default('active'),
  dueAt: z.number().int().nonnegative().optional(),
  note: z.string().max(500).optional(),
  createdAt: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type CharacterCommitment = z.output<typeof CharacterCommitmentSchema>;
export type CharacterCommitmentInput = z.input<typeof CharacterCommitmentSchema>;

// ---------------------------------------------------------------------------
// 域 8 & 域 9：Relationships 与 Memory 轻量权威引用（底层事实仍归 local-store / memory-graph）
// ---------------------------------------------------------------------------
export const RelationshipRoleSchema = z.enum(['owner', 'npc', 'viewer', 'character']);
export type RelationshipRole = z.infer<typeof RelationshipRoleSchema>;

export const RelationshipRefSchema = z.object({
  partnerId: z.string().min(1),
  role: RelationshipRoleSchema,
  displayName: z.string().min(1),
  affinity: z.number().min(-100).max(100).default(50),
  trust: z.number().min(0).max(1).default(0.7),
  boundaries: z.array(z.string()).default([]),
  lastInteractionAt: z.number().int().nonnegative().default(0),
  authorityStore: z.enum(['local-store', 'memory-graph']).default('local-store'),
});
export type RelationshipRef = z.output<typeof RelationshipRefSchema>;
export type RelationshipRefInput = z.input<typeof RelationshipRefSchema>;

export const MemoryIndexRefSchema = z.object({
  memoryNamespace: z.string().min(1),
  lastConsolidatedAt: z.number().int().nonnegative().optional(),
  pinnedCount: z.number().int().nonnegative().default(0),
  recentHighlights: z.array(z.string()).default([]),
  authorityStore: z.literal('memory-graph').default('memory-graph'),
});
export type MemoryIndexRef = z.output<typeof MemoryIndexRefSchema>;
export type MemoryIndexRefInput = z.input<typeof MemoryIndexRefSchema>;

// ---------------------------------------------------------------------------
// 域 10：Voice Identity（与具体 TTS / SVS / SVC Provider 解耦的角色声线身份）
// ---------------------------------------------------------------------------
export const VoiceIdentityDomainSchema = z.object({
  voiceProfileId: z.string().min(1),
  characterId: z.string().min(1),
  voiceDescription: z.string().min(1),
  languageVariants: z.array(z.string().min(1)).min(1).default(['zh-CN']),
  speechStyle: z.object({
    pace: z.string().default('medium'),
    prosody: z.string().default('lively-tsundere'),
    articulation: z.string().default('crisp'),
    breathiness: z.string().optional(),
    expressiveness: z.string().default('high'),
  }).default({
    pace: 'medium',
    prosody: 'lively-tsundere',
    articulation: 'crisp',
    expressiveness: 'high',
  }),
  singingStyle: z.object({
    preferredRange: z.string().optional(),
    timbre: z.string().default('bright-clear'),
    phrasing: z.string().default('expressive'),
    vibrato: z.string().optional(),
    genres: z.array(z.string()).default(['pop', 'anime']),
  }).optional(),
  preferredProviderId: z.string().min(1).optional(),
  providerVoiceRef: z.string().min(1).optional(),
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']).default('DEV_ONLY_NON_COMMERCIAL'),
  version: z.number().int().positive().default(1),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type VoiceIdentityDomain = z.output<typeof VoiceIdentityDomainSchema>;
export type VoiceIdentityDomainInput = z.input<typeof VoiceIdentityDomainSchema>;

// ---------------------------------------------------------------------------
// 域 11：Embodiment（跨桌面 2D / Live2D / VRM 3D / 游戏化身 / 舞台映射）
// ---------------------------------------------------------------------------
export const EmbodimentKindSchema = z.enum([
  'desktop-2d',
  'live2d',
  'vrm-3d',
  'game',
  'stage',
]);
export type EmbodimentKind = z.infer<typeof EmbodimentKindSchema>;

export const EmbodimentBindingSchema = z.object({
  embodimentId: z.string().min(1),
  characterId: z.string().min(1),
  kind: EmbodimentKindSchema,
  targetId: z.string().min(1),
  assetId: z.string().min(1),
  assetVersionId: z.string().min(1).default('v1'),
  manifestPath: z.string().optional(),
  anchorRatio: z.number().min(0).max(1).optional(),
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']).default('DEV_ONLY_NON_COMMERCIAL'),
  enabled: z.boolean().default(true),
  active: z.boolean().default(false),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type EmbodimentBinding = z.output<typeof EmbodimentBindingSchema>;
export type EmbodimentBindingInput = z.input<typeof EmbodimentBindingSchema>;

// ---------------------------------------------------------------------------
// 域 12：Activity State & LifeRuntime（活动仲裁、中断恢复、日程与资源预算）
// ---------------------------------------------------------------------------
export const CharacterExpressionSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'singing',
  'dancing',
  'gaming',
  'reacting',
  'resting',
]);
export type CharacterExpression = z.infer<typeof CharacterExpressionSchema>;

export const CharacterControlModeSchema = z.enum([
  'autonomous',
  'coop',
  'command',
  'manual_takeover',
]);
export type CharacterControlMode = z.infer<typeof CharacterControlModeSchema>;

export const LifeScheduleSlotSchema = z.object({
  slotId: z.string().min(1),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  preferredActivity: LifeActivityKindSchema,
  quietMode: z.boolean().default(false),
  label: z.string().min(1),
});
export type LifeScheduleSlot = z.output<typeof LifeScheduleSlotSchema>;

export const LifeBudgetSnapshotSchema = z.object({
  dailyTokenBudget: z.number().int().nonnegative().default(100_000),
  tokensConsumedToday: z.number().int().nonnegative().default(0),
  activeSessionMinutes: z.number().nonnegative().default(0),
  maxSessionMinutes: z.number().positive().default(180),
  exhausted: z.boolean().default(false),
});
export type LifeBudgetSnapshot = z.output<typeof LifeBudgetSnapshotSchema>;

export const InterruptedActivitySchema = z.object({
  activity: LifeActivityKindSchema,
  expression: CharacterExpressionSchema,
  reason: z.string().min(1),
  goalId: z.string().min(1).optional(),
  interruptedAt: z.number().int().nonnegative(),
});
export type InterruptedActivity = z.infer<typeof InterruptedActivitySchema>;

export const ActivityAuthoritySourceSchema = z.enum([
  'life_runtime',
  'user_command',
  'emergency_halt',
  'manual_takeover',
]);
export type ActivityAuthoritySource = z.infer<typeof ActivityAuthoritySourceSchema>;

export const ActivityStateDomainSchema = z.object({
  characterId: z.string().min(1),
  mode: LifeActivityKindSchema.default('companion'),
  expression: CharacterExpressionSchema.default('idle'),
  controlMode: CharacterControlModeSchema.default('autonomous'),
  halted: z.boolean().default(false),
  haltReason: z.string().nullable().default(null),
  activeGoalId: z.string().nullable().default(null),
  activeCommitmentId: z.string().nullable().default(null),
  activeModelRef: z.string().nullable().default(null),
  authoritySource: ActivityAuthoritySourceSchema.default('life_runtime'),
  interruptedStack: z.array(InterruptedActivitySchema).default([]),
  schedule: z.array(LifeScheduleSlotSchema).default([]),
  budget: LifeBudgetSnapshotSchema.default({
    dailyTokenBudget: 100_000,
    tokensConsumedToday: 0,
    activeSessionMinutes: 0,
    maxSessionMinutes: 180,
    exhausted: false,
  }),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type ActivityStateDomain = z.output<typeof ActivityStateDomainSchema>;
export type ActivityStateDomainInput = z.input<typeof ActivityStateDomainSchema>;

// ---------------------------------------------------------------------------
// CharacterCore 12 域联合持久快照
// ---------------------------------------------------------------------------
export const CharacterCoreSnapshotSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  identity: CharacterIdentityDomainSchema,
  personality: PersonalityDomainSchema,
  preferences: PreferencesDomainSchema,
  emotion: EmotionDomainSchema,
  motivation: MotivationDomainSchema,
  goals: z.array(CharacterGoalSchema).default([]),
  commitments: z.array(CharacterCommitmentSchema).default([]),
  relationships: z.array(RelationshipRefSchema).default([]),
  memory: MemoryIndexRefSchema,
  voiceIdentity: VoiceIdentityDomainSchema,
  embodiments: z.array(EmbodimentBindingSchema).default([]),
  activityState: ActivityStateDomainSchema,
});
export type CharacterCoreSnapshot = z.output<typeof CharacterCoreSnapshotSchema>;
export type CharacterCoreSnapshotInput = z.input<typeof CharacterCoreSnapshotSchema>;
