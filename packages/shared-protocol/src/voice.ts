/**
 * Whale Isle V2 — VoiceProvider / 口型同步 / 多轨 AudioMixer 共享契约（V2-P1-02）
 * - 零外部依赖（仅 zod），避免循环导入 index.ts
 * - 区分真实角色 TTS / 本地 Worker / 系统降级 / 未适配，禁止将系统 TTS 冒充角色音色
 */
import { z } from 'zod';

export const VoiceProviderKindSchema = z.enum([
  'openai-compatible-tts',
  'minimax-tts',
  'local-audio-worker',
  'mcode-cli',
  'macos-say',
  'windows-sapi',
  'unsupported',
]);
export type VoiceProviderKind = z.infer<typeof VoiceProviderKindSchema>;

export const VoiceBackendQualitySchema = z.enum([
  'character_tts',
  'local_worker',
  'system_fallback',
  'unsupported',
]);
export type VoiceBackendQuality = z.infer<typeof VoiceBackendQualitySchema>;

export const VoiceProviderStatusSchema = z.object({
  kind: VoiceProviderKindSchema,
  quality: VoiceBackendQualitySchema,
  available: z.boolean(),
  degraded: z.boolean().default(false),
  platform: z.string().min(1),
  detail: z.string().min(1),
  supportsStreaming: z.boolean().default(false),
  supportsEmotion: z.boolean().default(false),
});
export type VoiceProviderStatus = z.output<typeof VoiceProviderStatusSchema>;

export const LipSyncVisemeSchema = z.enum(['closed', 'wide', 'round', 'open', 'teeth']);
export type LipSyncViseme = z.infer<typeof LipSyncVisemeSchema>;

export const LipSyncFrameSchema = z.object({
  timestampMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  viseme: LipSyncVisemeSchema,
  amplitude: z.number().min(0).max(1),
  rmsDb: z.number().min(-120).max(0),
});
export type LipSyncFrame = z.infer<typeof LipSyncFrameSchema>;

export const VoiceStyleModeSchema = z.enum(['normal', 'inner', 'p0', 'singing']);
export type VoiceStyleMode = z.infer<typeof VoiceStyleModeSchema>;

export const VoiceSynthesisRequestSchema = z.object({
  requestId: z.string().min(1),
  characterId: z.string().min(1),
  voiceRef: z.string().min(1),
  text: z.string().min(1).max(4000),
  emotion: z.string().min(1).default('neutral'),
  styleMode: VoiceStyleModeSchema.default('normal'),
  speed: z.number().min(0.5).max(2.0).default(1.0),
  pitchShiftSemitones: z.number().min(-12).max(12).default(0),
  volume: z.number().min(0).max(1).default(1.0),
  outputDeviceId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
});
export type VoiceSynthesisRequest = z.output<typeof VoiceSynthesisRequestSchema>;
export type VoiceSynthesisRequestInput = z.input<typeof VoiceSynthesisRequestSchema>;

export const VoiceSynthesisOutputSchema = z.object({
  requestId: z.string().min(1),
  providerKind: VoiceProviderKindSchema,
  quality: VoiceBackendQualitySchema,
  degraded: z.boolean().default(false),
  degradedFrom: VoiceProviderKindSchema.optional(),
  format: z.enum(['wav', 'mp3', 'ogg', 'pcm', 'system-direct']),
  sampleRate: z.number().int().positive().default(24_000),
  durationMs: z.number().nonnegative(),
  audioBase64: z.string().optional(),
  lipFrames: z.array(LipSyncFrameSchema).default([]),
  cached: z.boolean().default(false),
  latencyMs: z.number().nonnegative().default(0),
});
export type VoiceSynthesisOutput = z.output<typeof VoiceSynthesisOutputSchema>;

export const AudioTrackKindSchema = z.enum(['speech', 'bgm', 'sfx', 'singing']);
export type AudioTrackKind = z.infer<typeof AudioTrackKindSchema>;

export const AudioTrackStateSchema = z.object({
  trackId: z.string().min(1),
  kind: AudioTrackKindSchema,
  label: z.string().min(1),
  playing: z.boolean(),
  gain: z.number().min(0).max(2).default(1),
  effectiveGain: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  ducked: z.boolean().default(false),
  outputDeviceId: z.string().min(1).default('default'),
  startedAt: z.number().int().nonnegative().optional(),
});
export type AudioTrackState = z.output<typeof AudioTrackStateSchema>;

export const SpeechFloorHolderSchema = z.object({
  leaseId: z.string().min(1),
  agentId: z.string().min(1),
  characterId: z.string().min(1),
  speakerName: z.string().min(1),
  voiceRef: z.string().min(1),
});
export type SpeechFloorHolder = z.infer<typeof SpeechFloorHolderSchema>;

export const AudioMixerSnapshotSchema = z.object({
  speechFloorHolder: SpeechFloorHolderSchema.nullable(),
  speechQueueLength: z.number().int().nonnegative(),
  duckingActive: z.boolean(),
  duckingGainMultiplier: z.number().min(0).max(1),
  tracks: z.array(AudioTrackStateSchema),
  outputRoutes: z.record(AudioTrackKindSchema, z.string()),
});
export type AudioMixerSnapshot = z.output<typeof AudioMixerSnapshotSchema>;

// ============================================================================
// V2-P3-01：统一表演系统（Sing Engine SVS/SVC + 歌词时钟 + 舞蹈编排 + 2D/3D StageRuntime）
// ============================================================================

export const PerformanceChannelSchema = z.enum([
  'private_desktop',
  'livestream_public',
  'commercial_distribution',
]);
export type PerformanceChannel = z.infer<typeof PerformanceChannelSchema>;

export const SongLicenseScopeSchema = z.enum([
  'original_owned',
  'licensed_commercial',
  'licensed_livestream',
  'dev_only_non_commercial',
  'unlicensed',
]);
export type SongLicenseScope = z.infer<typeof SongLicenseScopeSchema>;

export const SongRightsSchema = z.object({
  songLicense: SongLicenseScopeSchema,
  accompanimentLicense: SongLicenseScopeSchema,
  lyricsLicense: SongLicenseScopeSchema,
  voiceModelAuthorized: z.boolean(),
  voiceConsentSource: z.string().min(1),
  attribution: z.string().default(''),
});
export type SongRights = z.output<typeof SongRightsSchema>;
export type SongRightsInput = z.input<typeof SongRightsSchema>;

export const SongRightsCheckSchema = z.object({
  allowed: z.boolean(),
  channel: PerformanceChannelSchema,
  reasons: z.array(z.string()),
  requiresAttribution: z.boolean(),
});
export type SongRightsCheck = z.output<typeof SongRightsCheckSchema>;

export const SingModeSchema = z.enum(['svs', 'svc']);
export type SingMode = z.infer<typeof SingModeSchema>;

export const SingBackendModeSchema = z.enum([
  'worker_svs',
  'worker_svc',
  'preview_guide_tone',
  'unavailable',
]);
export type SingBackendMode = z.infer<typeof SingBackendModeSchema>;

export const SingProviderStatusSchema = z.object({
  mode: SingModeSchema,
  backend: SingBackendModeSchema,
  available: z.boolean(),
  endpoint: z.string().optional(),
  detail: z.string().min(1),
});
export type SingProviderStatus = z.output<typeof SingProviderStatusSchema>;

export const BilingualLyricLineSchema = z.object({
  index: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  primaryText: z.string().min(1),
  secondaryText: z.string().optional(),
  romaji: z.string().optional(),
});
export type BilingualLyricLine = z.output<typeof BilingualLyricLineSchema>;

export const SongCatalogItemSchema = z.object({
  songId: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().default('Original'),
  bpm: z.number().positive().max(300).default(120),
  durationMs: z.number().int().positive(),
  keySignature: z.string().default('C major'),
  preferredRange: z.string().default('C4-F5'),
  accompanimentTrackPath: z.string().optional(),
  melodyMidiPath: z.string().optional(),
  referenceVocalPath: z.string().optional(),
  lyrics: z.array(BilingualLyricLineSchema).default([]),
  rights: SongRightsSchema,
});
export type SongCatalogItem = z.output<typeof SongCatalogItemSchema>;
export type SongCatalogItemInput = z.input<typeof SongCatalogItemSchema>;

export const SingRequestSchema = z.object({
  requestId: z.string().min(1),
  characterId: z.string().min(1),
  voiceProfileId: z.string().min(1),
  mode: SingModeSchema,
  channel: PerformanceChannelSchema.default('private_desktop'),
  song: SongCatalogItemSchema,
  pitchShiftSemitones: z.number().int().min(-12).max(12).default(0),
  indexRate: z.number().min(0).max(1).default(0.75),
  protectVoiceless: z.number().min(0).max(0.5).default(0.33),
  vocalGain: z.number().min(0).max(2).default(1),
  accompanimentGain: z.number().min(0).max(2).default(0.75),
  allowPreviewGuide: z.boolean().default(true),
  outputDeviceId: z.string().min(1).optional(),
  obsOutputDeviceId: z.string().min(1).optional(),
});
export type SingRequest = z.output<typeof SingRequestSchema>;
export type SingRequestInput = z.input<typeof SingRequestSchema>;

export const SingRenderResultSchema = z.object({
  ok: z.boolean(),
  requestId: z.string().min(1),
  mode: SingModeSchema,
  backendMode: SingBackendModeSchema,
  rightsCheck: SongRightsCheckSchema,
  durationMs: z.number().int().nonnegative(),
  sampleRate: z.number().int().positive().default(24_000),
  audioBase64: z.string().optional(),
  lipFrames: z.array(LipSyncFrameSchema).default([]),
  error: z.string().optional(),
  realNeuralInferenceVerified: z.boolean().default(false),
});
export type SingRenderResult = z.output<typeof SingRenderResultSchema>;

export const LyricsDisplayPolicySchema = z.object({
  enabled: z.boolean().default(true),
  showBilingual: z.boolean().default(true),
  showRomaji: z.boolean().default(false),
  desktopVisible: z.boolean().default(true),
  obsVisible: z.boolean().default(true),
  position: z.enum(['top', 'bottom', 'floating']).default('bottom'),
  fontScale: z.number().min(0.6).max(2.0).default(1.0),
});
export type LyricsDisplayPolicy = z.output<typeof LyricsDisplayPolicySchema>;
export type LyricsDisplayPolicyInput = z.input<typeof LyricsDisplayPolicySchema>;

export const LyricsClockFrameSchema = z.object({
  enabled: z.boolean(),
  songId: z.string().nullable(),
  positionMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  activeIndex: z.number().int().min(-1),
  activeLine: BilingualLyricLineSchema.nullable(),
  nextLine: BilingualLyricLineSchema.nullable(),
  lineProgress: z.number().min(0).max(1),
  policy: LyricsDisplayPolicySchema,
});
export type LyricsClockFrame = z.output<typeof LyricsClockFrameSchema>;

export const DanceCueSchema = z.object({
  cueId: z.string().min(1),
  atMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  poseId: z.string().min(1),
  expressionId: z.string().optional(),
  vrmMotionTag: z.string().optional(),
  live2dMotionGroup: z.string().optional(),
  energy: z.number().min(0).max(1).default(0.7),
});
export type DanceCue = z.output<typeof DanceCueSchema>;
export type DanceCueInput = z.input<typeof DanceCueSchema>;

export const DanceRoutineSchema = z.object({
  routineId: z.string().min(1),
  title: z.string().min(1),
  bpm: z.number().positive().max(300).default(120),
  durationMs: z.number().int().positive(),
  cues: z.array(DanceCueSchema).min(1),
});
export type DanceRoutine = z.output<typeof DanceRoutineSchema>;
export type DanceRoutineInput = z.input<typeof DanceRoutineSchema>;

export const SpeechPerformancePlanSchema = z.object({
  planId: z.string().min(1),
  characterId: z.string().min(1),
  text: z.string().min(1).max(4000),
  intent: z.string().min(1).default('chat'),
  emotion: z.string().min(1).default('neutral'),
  intensity: z.number().min(0).max(1).default(0.6),
  pace: z.enum(['slow', 'normal', 'fast']).default('normal'),
  prosodyHint: z.string().optional(),
  pauseHints: z.array(z.number().int().nonnegative()).default([]),
  gestureIds: z.array(z.string()).default([]),
  expressionId: z.string().optional(),
  interruptible: z.boolean().default(true),
  priority: z.enum(['P0_INTERRUPT', 'P1_CADENCE', 'P2_IDLE']).default('P1_CADENCE'),
});
export type SpeechPerformancePlan = z.output<typeof SpeechPerformancePlanSchema>;
export type SpeechPerformancePlanInput = z.input<typeof SpeechPerformancePlanSchema>;

export const SilenceDecisionSchema = z.object({
  shouldSpeak: z.boolean(),
  reason: z.string().min(1),
  cooldownRemainingMs: z.number().int().nonnegative().default(0),
});
export type SilenceDecision = z.output<typeof SilenceDecisionSchema>;

export const PerformancePriorityLayerSchema = z.enum([
  'safety_system',
  'interactive_game',
  'vocal_lipsync',
  'performance_choreo',
  'emotion_gesture',
  'idle_ambient',
]);
export type PerformancePriorityLayer = z.infer<typeof PerformancePriorityLayerSchema>;

export const PerformanceActivityModeSchema = z.enum([
  'idle',
  'speaking',
  'singing',
  'dancing',
  'singing_and_dancing',
  'halted',
]);
export type PerformanceActivityMode = z.infer<typeof PerformanceActivityModeSchema>;

export const PerformanceSnapshotSchema = z.object({
  characterId: z.string().min(1),
  mode: PerformanceActivityModeSchema,
  channel: PerformanceChannelSchema,
  positionMs: z.number().int().nonnegative(),
  activeSongId: z.string().nullable(),
  activeSingMode: SingModeSchema.nullable(),
  activeDanceRoutineId: z.string().nullable(),
  activeDanceCue: DanceCueSchema.nullable(),
  activeLayers: z.record(PerformancePriorityLayerSchema, z.string().nullable()),
  lyrics: LyricsClockFrameSchema,
  lipSync: LipSyncFrameSchema,
  quietCompanionMode: z.boolean(),
  halted: z.boolean(),
  haltReason: z.string().nullable(),
  mixer: AudioMixerSnapshotSchema,
});
export type PerformanceSnapshot = z.output<typeof PerformanceSnapshotSchema>;

export const StageBackendKindSchema = z.enum([
  'desktop-2d',
  'live2d',
  'vrm-3d',
  'obs-stage',
]);
export type StageBackendKind = z.infer<typeof StageBackendKindSchema>;

export const StageSceneSpecSchema = z.object({
  sceneId: z.string().min(1),
  title: z.string().min(1),
  backgroundPath: z.string().optional(),
  transparentBackground: z.boolean().default(false),
  lightingPreset: z.enum(['tidepaper_day', 'night_tide', 'concert_neon', 'neutral']).default('tidepaper_day'),
});
export type StageSceneSpec = z.output<typeof StageSceneSpecSchema>;
export type StageSceneSpecInput = z.input<typeof StageSceneSpecSchema>;

export const StageCharacterBindingSchema = z.object({
  characterId: z.string().min(1),
  displayName: z.string().min(1),
  backend: StageBackendKindSchema,
  assetPath: z.string().min(1),
  licenseScope: z.enum(['DEV_ONLY_NON_COMMERCIAL', 'COMMERCIAL_READY']).default('DEV_ONLY_NON_COMMERCIAL'),
  capabilities: z.array(z.string()).default([]),
});
export type StageCharacterBinding = z.output<typeof StageCharacterBindingSchema>;
export type StageCharacterBindingInput = z.input<typeof StageCharacterBindingSchema>;

export const StageRuntimeSnapshotSchema = z.object({
  characterId: z.string().nullable(),
  displayName: z.string().nullable(),
  activeBackend: StageBackendKindSchema,
  registeredBackends: z.array(StageBackendKindSchema),
  scene: StageSceneSpecSchema.nullable(),
  expression: z.string(),
  expressionIntensity: z.number().min(0).max(1),
  animationId: z.string(),
  performingMode: PerformanceActivityModeSchema,
  lipSync: LipSyncFrameSchema,
  lyrics: LyricsClockFrameSchema.nullable(),
  adapterState: z.record(z.string(), z.unknown()),
  realDeviceRenderVerified: z.boolean(),
  devWatermarkActive: z.boolean(),
});
export type StageRuntimeSnapshot = z.output<typeof StageRuntimeSnapshotSchema>;
