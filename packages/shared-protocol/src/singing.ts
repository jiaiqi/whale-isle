/**
 * 歌声链路契约（ADR-005 · `V2-P3-07A` 契约先行）—— Voice Identity / Singing Profile / 素材与引擎就绪。
 *
 * 为什么单独一份而不是塞进 `voice.ts`：
 *  - 「音色」与「演唱风格」是两件事：`VoiceIdentity` 只描述**谁的声音**（含授权与权重许可），
 *    `SingingProfile` 才描述**怎么唱**（音域、颤音、气声、起音、情绪参考）。换音色 ≠ 换演唱风格。
 *  - 五个情绪参考音与 SVC 训练干声是 owner 提供的**素材**，必须能逐文件校验（采样率/位深/时长/峰值/授权），
 *    不能靠"听一下觉得行"。
 *
 * 诚实口径：
 *  - 本文件只定义结构与常量，不做任何推理；
 *  - 许可与授权的**硬判定**放在 `@workbench/voice-runtime` 的 `resolveSingingReadiness()`，
 *    任何商用渠道 + 非商用权重/未授权声源一律进 blockers，不返回 `ready: true`。
 */
import { z } from 'zod';

/** 演唱路线：SVC 只换音色，SVS 自己唱，`svs_svc` 先生成演唱再统一音色。 */
export const SingingRouteSchema = z.enum(['svc', 'svs', 'svs_svc']);
export type SingingRoute = z.infer<typeof SingingRouteSchema>;

/**
 * 情绪分组键（与语音侧五档对齐）。
 * `clumsy_panic` 与 `happy_rice` 并存：工单口径是前者，item 5 旧清单是后者；
 * 必录清单见 `SINGING_REQUIRED_EMOTION_KEYS`，owner 拍板后只改那一个常量。
 */
export const SingingEmotionKeySchema = z.enum([
  'sweet_normal',
  'tsundere_refuse',
  'rage_spray',
  'lazy_yawn',
  'clumsy_panic',
  'happy_rice',
]);
export type SingingEmotionKey = z.infer<typeof SingingEmotionKeySchema>;

/** 当前必须齐的五组（工单口径）。owner 若改选 `happy_rice`，只改这里。 */
export const SINGING_REQUIRED_EMOTION_KEYS = [
  'sweet_normal',
  'tsundere_refuse',
  'rage_spray',
  'lazy_yawn',
  'clumsy_panic',
] as const satisfies readonly SingingEmotionKey[];

/** 声音来源（决定能不能商用） */
export const VoiceIdentitySourceSchema = z.enum([
  'builtin_reference', // 随包参考音频（自产，DEV_ONLY_NON_COMMERCIAL）
  'owner_authorized_recording', // owner 自录或已授权的第三方录音
  'licensed_model', // 有明确商用许可的现成模型
  'dev_baseline', // 仅开发期（如 GPT-SoVITS / NC 权重）
]);
export type VoiceIdentitySource = z.infer<typeof VoiceIdentitySourceSchema>;

/** 授权范围（与授权声明模板的勾选项一一对应） */
export const VoiceConsentScopeSchema = z.enum([
  'training', // 用于训练/微调
  'synthesis', // 用于生成合成语音
  'commercial_livestream', // 允许商用（含直播）
  'redistribution', // 允许随产品再分发训练产物
  'internal_eval_only', // 仅内部评估
]);
export type VoiceConsentScope = z.infer<typeof VoiceConsentScopeSchema>;

/** 权重许可层级：只有 `commercial_ok` 允许进商用渠道。 */
export const SingingWeightLicenseSchema = z.enum([
  'commercial_ok',
  'dev_only_non_commercial',
  'unlicensed',
  'unknown',
]);
export type SingingWeightLicense = z.infer<typeof SingingWeightLicenseSchema>;

/**
 * 声音身份：谁的声音 + 凭什么能用。
 *
 * `consentEvidenceRef` 是授权声明文件的编号/相对路径（**不存正文、不存个人信息**），
 * 为空即视为未授权；儿童声音必须 `minorVoice=true` 且 `guardianConsent=true`。
 */
export const VoiceIdentitySchema = z.object({
  identityId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().min(1),
  source: VoiceIdentitySourceSchema,
  consentScopes: z.array(VoiceConsentScopeSchema).default([]),
  consentEvidenceRef: z.string().default(''),
  minorVoice: z.boolean().default(false),
  guardianConsent: z.boolean().default(false),
  weightLicense: SingingWeightLicenseSchema.default('unknown'),
  /** SVC 声线模型（`.pth`）路径；来源必须可追溯，空则不可唱 */
  svcModelPath: z.string().default(''),
  /** SVC 检索索引（`.index`）路径，可选 */
  svcIndexPath: z.string().default(''),
  /** SVS 声库路径，可选 */
  svsVoicebankPath: z.string().default(''),
  notes: z.string().default(''),
});
export type VoiceIdentity = z.output<typeof VoiceIdentitySchema>;
export type VoiceIdentityInput = z.input<typeof VoiceIdentitySchema>;

/** 音域（科学音高记号，如 `C4` / `F#5`） */
export const SingingRangeSchema = z.object({
  lowestNote: z.string().regex(/^[A-G]#?\d$/),
  highestNote: z.string().regex(/^[A-G]#?\d$/),
  comfortableLow: z.string().regex(/^[A-G]#?\d$/),
  comfortableHigh: z.string().regex(/^[A-G]#?\d$/),
});
export type SingingRange = z.output<typeof SingingRangeSchema>;

/** 演唱风格（与音色分开描述） */
export const SingingStyleSchema = z.object({
  vibrato: z.enum(['none', 'light', 'medium', 'strong']).default('light'),
  breathiness: z.number().min(0).max(1).default(0.3),
  attack: z.enum(['soft', 'natural', 'sharp']).default('natural'),
  /** 自由描述（如「尾音带一点笑」「高音偏假声」），只作提示词素材，不参与机器判定 */
  timbreNotes: z.array(z.string()).default([]),
});
export type SingingStyle = z.output<typeof SingingStyleSchema>;
export type SingingStyleInput = z.input<typeof SingingStyleSchema>;

/** 演唱档案：一个角色 + 一个声音身份 + 一套演唱风格。 */
export const SingingProfileSchema = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  characterId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  route: SingingRouteSchema.default('svc'),
  voice: VoiceIdentitySchema,
  range: SingingRangeSchema,
  style: SingingStyleSchema,
  /** 情绪 → 参考素材 id（不内联音频路径，避免档案里藏绝对路径） */
  emotionReferenceIds: z.partialRecord(SingingEmotionKeySchema, z.string().min(1)).default({}),
  notes: z.string().default(''),
});
export type SingingProfile = z.output<typeof SingingProfileSchema>;
export type SingingProfileInput = z.input<typeof SingingProfileSchema>;

// ---------------------------------------------------------------------------
// 素材规格（写死的工程建议值；owner 拍板改这里，不改校验逻辑）
// ---------------------------------------------------------------------------

/** 五组情绪参考音的录制规格（与 `V2-P3-07-svc-svs-selection.md` §2.1 一致） */
export const SINGING_EMOTION_MATERIAL_SPEC = {
  sampleRate: 24_000,
  bitDepth: 16,
  channels: 1,
  durationMs: 5_000,
  durationToleranceMs: 300,
  peakDbfs: -3,
  peakToleranceDb: 3,
  edgeSilenceMs: 200,
} as const;

/** SVC 训练干声的最低要求（≥10 分钟可试，30 分钟以上更稳） */
export const SINGING_TRAINING_MATERIAL_SPEC = {
  minimumTotalMs: 10 * 60 * 1000,
  recommendedTotalMs: 30 * 60 * 1000,
  minSliceMs: 3_000,
  maxSliceMs: 10_000,
} as const;

export const SingingMaterialKindSchema = z.enum(['emotion_reference', 'svc_training_dry_vocal']);
export type SingingMaterialKind = z.infer<typeof SingingMaterialKindSchema>;

/**
 * 单个素材文件的**事实**（由扫描器读 WAV 头得出，或由人填）。
 * 这里不存音频本体，只存可校验的元数据与指纹。
 */
export const SingingMaterialFileSchema = z.object({
  materialId: z.string().min(1),
  kind: SingingMaterialKindSchema,
  /** 仅 `emotion_reference` 必填 */
  emotion: SingingEmotionKeySchema.optional(),
  filePath: z.string().min(1),
  /** 小写 hex SHA-256，防止"同名文件换了内容" */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sampleRate: z.number().int().positive(),
  bitDepth: z.number().int().positive(),
  channels: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  /** 峰值电平（dBFS，≤ 0） */
  peakDbfs: z.number().max(0),
  headSilenceMs: z.number().nonnegative().default(0),
  tailSilenceMs: z.number().nonnegative().default(0),
  source: VoiceIdentitySourceSchema,
  consentEvidenceRef: z.string().default(''),
  recordedAt: z.string().optional(),
});
export type SingingMaterialFile = z.output<typeof SingingMaterialFileSchema>;
export type SingingMaterialFileInput = z.input<typeof SingingMaterialFileSchema>;

/** 素材问题码：UI 与验收文档按码引用，不靠文案匹配。 */
export const SingingMaterialIssueCodeSchema = z.enum([
  'sample_rate_mismatch',
  'bit_depth_mismatch',
  'channels_mismatch',
  'duration_out_of_range',
  'clipping',
  'silence_padding_missing',
  'emotion_missing',
  'emotion_duplicate',
  'consent_missing',
  'minor_without_guardian_consent',
  'source_not_commercial',
  'total_duration_short',
  'slice_duration_out_of_range',
]);
export type SingingMaterialIssueCode = z.infer<typeof SingingMaterialIssueCodeSchema>;

export const SingingMaterialIssueSchema = z.object({
  code: SingingMaterialIssueCodeSchema,
  severity: z.enum(['blocker', 'warning']),
  message: z.string().min(1),
  materialId: z.string().optional(),
});
export type SingingMaterialIssue = z.output<typeof SingingMaterialIssueSchema>;

export const SingingMaterialCheckSchema = z.object({
  /** `fail` 表示存在 blocker；`warn` 只有 warning；`pass` 无问题 */
  verdict: z.enum(['pass', 'warn', 'fail']),
  issues: z.array(SingingMaterialIssueSchema).default([]),
});
export type SingingMaterialCheck = z.output<typeof SingingMaterialCheckSchema>;

/** 素材清单（落 `<userData>/singing/materials.json`，不进 git） */
export const SingingMaterialManifestSchema = z.object({
  version: z.string().min(1),
  characterId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  files: z.array(SingingMaterialFileSchema).default([]),
  updatedAt: z.number().int().nonnegative(),
});
export type SingingMaterialManifest = z.output<typeof SingingMaterialManifestSchema>;
export type SingingMaterialManifestInput = z.input<typeof SingingMaterialManifestSchema>;

// ---------------------------------------------------------------------------
// 引擎探测与就绪判定
// ---------------------------------------------------------------------------

export const SingingEngineKindSchema = z.enum(['rvc', 'diffsinger', 'openutau']);
export type SingingEngineKind = z.infer<typeof SingingEngineKindSchema>;

/**
 * 引擎探测结果：**只描述事实**。
 * `weightLicense` 描述随引擎一起用的权重许可，不是代码许可；
 * RVC 代码 MIT 但官方底模「仅供研究使用」，所以这里必须单独标，不能被"开源=可商用"误读。
 */
export const SingingEngineProbeSchema = z.object({
  engine: SingingEngineKindSchema,
  installed: z.boolean(),
  weightLicense: SingingWeightLicenseSchema.default('unknown'),
  /** 引擎/权重来源说明（如「RVC MIT 分支 + 自训底模」） */
  detail: z.string().min(1),
  /** 未安装时的可执行补救建议 */
  hint: z.string().default(''),
});
export type SingingEngineProbe = z.output<typeof SingingEngineProbeSchema>;
export type SingingEngineProbeInput = z.input<typeof SingingEngineProbeSchema>;

/**
 * 演唱就绪判定（宿主 / UI / 验收共用）。
 * `ready` 只在**零 blocker** 时为真；`commercialReady` 按最严渠道（商用分发）再判一次。
 */
export const SingingReadinessSchema = z.object({
  ready: z.boolean(),
  commercialReady: z.boolean(),
  blockers: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  missingEmotionKeys: z.array(SingingEmotionKeySchema).default([]),
});
export type SingingReadiness = z.output<typeof SingingReadinessSchema>;
