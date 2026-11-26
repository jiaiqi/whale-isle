/**
 * Whale Isle V2 — VoiceProvider / 口型同步 / 多轨 AudioMixer 共享契约（V2-P1-02）
 * - 零外部依赖（仅 zod），避免循环导入 index.ts
 * - 区分真实角色 TTS / 本地 Worker / 系统降级 / 未适配，禁止将系统 TTS 冒充角色音色
 */
import { z } from 'zod';

export const VoiceProviderKindSchema = z.enum([
  'openai-compatible-tts',
  'minimax-tts',
  'openrouter-tts',
  'mimo-tts',
  'mimo-tts-voiceclone',
  'mimo-tts-voicedesign',
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

/**
 * 语音引擎档位（item 10 实测结论的落地形态）。
 *
 * 默认 `commercial_default`：商业 API 优先，本地引擎只作为**用户主动选择**的离线档。
 * 严禁用「本地引擎装没装」隐式决定优先级——装了就自动优先本地，会让用户莫名等 17–43 秒。
 */
export const VoiceEngineTierSchema = z.enum(['commercial_default', 'offline_preferred']);
export type VoiceEngineTier = z.infer<typeof VoiceEngineTierSchema>;

/**
 * 离线档的体感代价（item 10 本机实测，Apple Silicon / CosyVoice2-0.5B，n=150）。
 * 证据：`docs/v2/evidence/TTS-local-engine-benchmark-verification.md`。
 *
 * UI 必须直接引用 `OFFLINE_TIER_COST_TEXT`，不许各处自己另写一套数字。
 */
export const OFFLINE_TIER_COST = {
  /** 一句话（约 7 秒音频）从提交到整句出声 */
  perSentenceMs: { min: 16_000, max: 43_000 },
  /** 首包（第一段音频到手；对话级交互看这个数） */
  firstPacketMs: { min: 10_000, max: 35_000 },
  /** 冷启动首句：进程启动 + 权重加载 + 首个 chunk */
  coldStartFirstSentenceMs: 30_000,
} as const;

/** UI 与文档共用的离线档代价文案（原文固定，禁止改写数字） */
export const OFFLINE_TIER_COST_TEXT = '一句话等 16–43 秒 / 首包 10–35 秒 / 冷启动首句 30 秒';

/**
 * 默认档（商业 API）用哪一家：**用户显式选择**，不许靠「有没有配置 Key」隐式决定。
 * 选中的那家不可用时要如实报告「没兑现」，而不是静悄悄换成另一家。
 *
 * 前两家是长期可依赖的稳定档；`openrouter-tts` 与 `mimo-*` 三个是**候选**（见 `MIMO_TTS_CANDIDATE_NOTICE`），
 * 选得中、听得着，但绝不进自动兜底链，也绝不设为默认。
 * `mimo-tts` 对应 `mimo-v2.5-tts`（内置 9 个音色、支持唱歌前缀、唯一支持流式的那个），
 * `mimo-tts-voiceclone` / `mimo-tts-voicedesign` 分别对应同名模型。
 */
export const CommercialTtsProviderSchema = z.enum([
  'minimax-tts',
  'openai-compatible-tts',
  'openrouter-tts',
  'mimo-tts',
  'mimo-tts-voiceclone',
  'mimo-tts-voicedesign',
]);
export type CommercialTtsProvider = z.infer<typeof CommercialTtsProviderSchema>;

/**
 * MiMo TTS 候选供应商的如实口径（UI 与文档共用同一份原文，禁止各处另写）。
 *
 * 事实来源（2026-11-27 官方模型页 + 编排方转述）：标价「限时免费」，页面**没有任何商用条款**；
 * 同一站点顶部横幅写明 MiMo-V2.5-Pro / V2.5 文本系列已于 2026-10-21 下线，TTS 是否同命运未明说。
 * 因此：可以接、可以试听对拍，但不得锁死为默认档，必须随时能切走。
 */
export const MIMO_TTS_CANDIDATE_NOTICE =
  '候选：限时免费、无商用条款、V2.5 文本系列已下线；不得作为默认档长期依赖';

/**
 * 本地 Audio Worker 的 `/health` 自报（宿主探针的唯一数据来源）。
 *
 * `tts` 缺省 = 旧版 Worker 没上报能力，宿主必须按「不支持情绪」处理，不许猜成 true。
 */
export const LocalAudioWorkerHealthSchema = z.object({
  status: z.string().min(1),
  service: z.string().optional(),
  version: z.string().optional(),
  backend: z.string().optional(),
  platform: z.string().optional(),
  tts: z
    .object({
      /** real=真实人声推理；placeholder=确定性占位波形，不是 TTS */
      mode: z.enum(['real', 'placeholder']),
      /** 实际在跑的引擎标识（占位后端必须自报 stub-*，不许冒名任何真实模型） */
      engine: z.string().min(1),
      /** 后端实测：同一文本换情绪是否真的产生不同音频 */
      supportsEmotion: z.boolean(),
      detail: z.string().min(1),
    })
    .optional(),
});
export type LocalAudioWorkerHealth = z.output<typeof LocalAudioWorkerHealthSchema>;

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
  /** 该音频是否为占位波形（stub）而非真实 TTS 人声；true 时 UI 必须如实标注，不许当角色音色播放展示 */
  placeholder: z.boolean().default(false),
  placeholderReason: z.string().optional(),
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

/**
 * 神经推理证据（`realNeuralInferenceVerified` 的唯一依据）。
 *
 * 为什么需要它：后端返回一段音频字节**不能**证明「这是目标模型真的做了神经推理」——
 * 它可能是占位波形、可能是别的模型、也可能只是转发了一段录音。只有拿到可核实的
 * 模型标识 + 权重指纹，并且与宿主注册的期望值比对通过，才算「已核实」。
 */
export const NeuralInferenceEvidenceSchema = z.object({
  /** 推理模型标识（如 `diffsinger:xiaojing-v1` / `rvc:xiaojing`） */
  modelId: z.string().min(1),
  /** 权重文件 SHA-256（小写 hex，64 位） */
  weightSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** 推理后端名（如 `onnxruntime-cpu` / `torch-mps`） */
  backend: z.string().min(1),
  /** 证据来源：只有 `weight_fingerprint` 可被自动核实 */
  verifiedBy: z.enum(['weight_fingerprint', 'self_reported']).default('self_reported'),
});
export type NeuralInferenceEvidence = z.output<typeof NeuralInferenceEvidenceSchema>;

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
  /** 仅在拿到可核实证据（模型标识 + 权重指纹匹配）时为 true */
  realNeuralInferenceVerified: z.boolean().default(false),
  /** 推理证据；未核实或缺失时缺省 */
  neuralEvidence: NeuralInferenceEvidenceSchema.optional(),
  /** 未核实原因（`realNeuralInferenceVerified=false` 且曾有音频返回时给出） */
  neuralEvidenceNote: z.string().optional(),
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

/**
 * 声线库（owner 2026-11-27 决赛圈勾选的四条，两轮一致）。
 *
 * - 默认声线 = `07-nianhu-piqi`（黏糊·调皮）：对应鲸鱼娘「贱兮兮可爱 + 傲娇嘴硬 + 外冷内软 + 黏人」；
 * - 其余三条是可切换的备选声线，描述即 MiMo VoiceDesign 的自然语言音色描述（不是关键词列表）；
 * - **这四条是「描述」，不是锁死的声线**：VoiceDesign 同描述 ×10 的说话人余弦最小 0.4145，漂移是实的，
 *   所以产品路径是「用描述生成一条参考音频 → 走 VoiceClone 锁死」（见 `docs/v2/VOICE-PERSONA-xiaojing.md`）。
 */
export const MIMO_TIMBRE_PRESETS = [
  {
    id: '07-nianhu-piqi',
    label: '07 黏糊·调皮',
    description: '软糯黏糊但带笑意的女声，撒娇里藏着坏主意，尾音轻轻上翘',
    isDefault: true,
  },
  {
    id: '02-yujie-leng',
    label: '02 御姐冷·年轻',
    description: '二十岁左右的年轻女声，音调中低，语气平静克制，尾音干脆，像不太爱解释的人',
    isDefault: false,
  },
  {
    id: '08-nianhu-banshui',
    label: '08 黏糊·半睡',
    description: '黏糊的迷糊女声，气声多，像半睡半醒时撒娇，字尾含混',
    isDefault: false,
  },
  {
    id: '12-hanhan-difa',
    label: '12 憨憨·偏低发呆',
    description: '偏低的中性软声，呆呆的，语气没什么起伏，像在发呆',
    isDefault: false,
  },
] as const;

/** 默认声线 id（声线库里 owner 勾中的那一条） */
export const MIMO_DEFAULT_TIMBRE_ID = '07-nianhu-piqi';

/**
 * 随包分发的克隆参考音频（自产文本 + MiMo VoiceDesign 生成，MiMo 限时免费且无商用条款 → 仅开发/内部用）。
 * 路径相对 `assets/voice/`；打包后落在 `resources/voice/`。
 */
export const MIMO_BUNDLED_REFERENCE_ASSET = 'xiaojing-07-nianhu-piqi.wav';
