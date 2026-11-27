/**
 * V2-P4-04A — 外部知识源证据化契约（材料 / Evidence Pack / 适用性评估 / 实玩回执 / 知识源状态）
 *
 * 设计真源：`docs/v2/evidence/EXTERNAL-FUSION-C-incremental-design.md` §3、§4；
 * 切片验收：`docs/v2/evidence/EXTERNAL-FUSION-E-first-vertical-slice.md` §3–§4。
 *
 * 边界（AGENTS §2.2 / §5.3 ADR-002 D-103）：
 * - 材料正文是权威，Evidence Pack 是**派生数据**；本契约只描述「可复核」所需的字段，不做摘要式事实；
 * - 回执只承认游戏侧真实三态（COMPLETED | FAILED | UNCERTAIN），模型台词不是回执；
 * - 外部知识源（Envoy）只读：状态里写死 `readOnly: true`，不存在写/评论/发布字段。
 */
import { z } from 'zod';
import {
  EvidenceExtractionSchema,
  EvidenceLevelSchema,
  EvidenceLocatorSchema,
  GameKnowledgeItemSchema,
  GameKnowledgeSourceTypeSchema,
} from './knowledge';

/** 材料许可范围：`unknown` 一律按「禁止商用/直播引用」处理（设计书 §6） */
export const MaterialLicenseScopeSchema = z.enum([
  'owner-authorized',
  'cc-by-nc-sa',
  'cc-by-4.0',
  'apache-2.0',
  'mit',
  'unknown',
]);
export type MaterialLicenseScope = z.infer<typeof MaterialLicenseScopeSchema>;

/** 许可徽章的人话标签（UI 与日志共用，避免各写一份） */
export const MATERIAL_LICENSE_LABELS_ZH: Record<MaterialLicenseScope, string> = {
  'owner-authorized': 'owner 授权',
  'cc-by-nc-sa': 'CC BY-NC-SA（仅开发自用，禁止商用）',
  'cc-by-4.0': 'CC BY 4.0',
  'apache-2.0': 'Apache-2.0',
  mit: 'MIT',
  unknown: '未知许可（禁止商用/直播引用）',
};

/** 材料记录：来源、版本、摘要与许可字段齐全（切片判据 1 与 2 的落库形态） */
export const KnowledgeMaterialSchema = z.object({
  materialId: z.string().min(1).max(128),
  /** file:///… 或 https://…；只作溯源展示，不主动联网 */
  originUri: z.string().min(1),
  title: z.string().min(1).max(200),
  /** 材料字节的 SHA-256（64 位小写十六进制） */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** 文件 mtime / 网页 etag 等；变化时证据降级 partial，不直接 rejected */
  sourceRevision: z.string().min(1).max(200),
  bytes: z.number().int().nonnegative().optional(),
  licenseScope: MaterialLicenseScopeSchema.default('unknown'),
  licenseNote: z.string().min(1).max(300).optional(),
  readAt: z.string().min(1),
});
export type KnowledgeMaterial = z.infer<typeof KnowledgeMaterialSchema>;

/** 材料切片来源：`source` = 材料原文；其余为模型产物，绝不能当原话展示 */
export const MaterialChunkOriginSchema = z.enum(['source', 'asr', 'ocr', 'vision', 'derived']);
export type MaterialChunkOrigin = z.infer<typeof MaterialChunkOriginSchema>;

export const MaterialChunkSchema = z.object({
  chunkId: z.string().min(1).max(160),
  locator: EvidenceLocatorSchema,
  text: z.string().min(1),
  origin: MaterialChunkOriginSchema.default('source'),
});
export type MaterialChunk = z.infer<typeof MaterialChunkSchema>;

/**
 * Evidence Pack：同一材料 + 同一参数 → 同一 digest（逐字节稳定，无墙钟/pid/绝对路径参与）。
 * `digest` 覆盖 materialId + sha256 + sourceRevision + extraction + 每个 chunk 的 locator/text/origin。
 */
export const EvidencePackSchema = z.object({
  packId: z.string().min(1).max(128),
  materialId: z.string().min(1).max(128),
  materialSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().min(1).max(200),
  extraction: EvidenceExtractionSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  chunks: z.array(MaterialChunkSchema).max(500),
  capturedAt: z.string().min(1),
  source: z.object({
    title: z.string().min(1),
    originUri: z.string().min(1),
    licenseScope: MaterialLicenseScopeSchema,
    licenseNote: z.string().optional(),
    readerVersion: z.string().min(1),
  }),
  parameters: z.object({
    topic: z.string().min(1), sourceType: GameKnowledgeSourceTypeSchema,
    gameVersion: z.string().min(1).optional(),
    modContext: z.array(z.string().min(1)).optional(),
    applicability: z.array(z.string().min(1)).optional(),
  }),
});
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

/** 外部知识源可用性（宿主把真实探测结果投影给 UI；不可用时回退本地攻略，不显示假证据） */
export const KnowledgeSourceStateSchema = z.enum(['available', 'unavailable', 'starting', 'error']);
export type KnowledgeSourceState = z.infer<typeof KnowledgeSourceStateSchema>;

export const KnowledgeSourceStatusSchema = z.object({
  sourceId: z.string().min(1).default('envoy'),
  state: KnowledgeSourceStateSchema,
  /** 人话原因（缺 envoy / 缺 uv / 材料目录不存在 / 启动超时…），UI 直接显示 */
  reason: z.string().min(1).max(400).optional(),
  /** 探测到的可执行文件（不回传完整环境变量） */
  command: z.string().min(1).max(300).optional(),
  version: z.string().min(1).max(100).optional(),
  /** owner 授权材料目录（真实路径，供「打开文件夹」） */
  materialsRoot: z.string().min(1).max(500).optional(),
  /** 已登记材料数（只统计真实落库的） */
  materialCount: z.number().int().nonnegative().default(0),
  readOnly: z.literal(true).default(true),
  checkedAt: z.string().min(1),
});
export type KnowledgeSourceStatus = z.infer<typeof KnowledgeSourceStatusSchema>;

/** 只允许关闭知识源；配置不能扩大外部工具/路径/命令权限。 */
export const KnowledgeSourceConfigSchema = z.object({
  envoy: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
});

/** 适用性判定结论：`not-applicable` = 明确不满足适用条件（不执行），`uncertain` = 判不了（不猜） */
export const KnowledgeApplicabilityStatusSchema = z.enum([
  'compatible',
  'uncertain',
  'outdated',
  'mod-mismatch',
  'not-applicable',
]);
export type KnowledgeApplicabilityStatus = z.infer<typeof KnowledgeApplicabilityStatusSchema>;

export const KnowledgeVersionMatchSchema = z.enum(['match', 'mismatch', 'not-declared', 'unreadable']);
export const KnowledgeModMatchSchema = z.enum([
  'match',
  'missing-mods',
  'not-declared',
  'unreadable',
]);

/**
 * 适用性评估：必须由真实 `get_state` 参与（切片判据 4）。
 * `stateDigest` 是评估所依据的游戏状态快照摘要，回执据此证明「同一状态」。
 */
export const KnowledgeApplicabilitySchema = z.object({
  knowledgeId: z.string().min(1),
  status: KnowledgeApplicabilityStatusSchema,
  executable: z.boolean(),
  versionMatch: KnowledgeVersionMatchSchema,
  modMatch: KnowledgeModMatchSchema,
  /** 从状态里确实核对通过的适用条件 */
  matchedConditions: z.array(z.string().min(1)).default([]),
  /** 未能核对/明确不满足的适用条件 */
  unsatisfiedConditions: z.array(z.string().min(1)).default([]),
  /** 无法从真实状态判定的适用条件（交 owner 决定，不猜） */
  unverifiableConditions: z.array(z.string().min(1)).default([]),
  reasons: z.array(z.string().min(1)).default([]),
  missingMods: z.array(z.string().min(1)).default([]),
  /** 评估时读到的真实运行时上下文（读不到就缺失，不猜） */
  runtimeGameVersion: z.string().min(1).optional(),
  runtimeSeason: z.string().min(1).optional(),
  runtimeDay: z.number().int().positive().optional(),
  runtimeLocation: z.string().min(1).optional(),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  assessedAt: z.string().min(1),
});
export type KnowledgeApplicability = z.infer<typeof KnowledgeApplicabilitySchema>;

/** 实玩回执的三态（AGENTS §2.2：只认游戏侧真实回执；UNCERTAIN 不是成功） */
export const PlayReceiptStatusSchema = z.enum(['COMPLETED', 'FAILED', 'UNCERTAIN']);
export type PlayReceiptStatus = z.infer<typeof PlayReceiptStatusSchema>;

export const PlayReceiptSchema = z.object({
  receiptId: z.string().min(1).max(128),
  knowledgeId: z.string().min(1),
  actionId: z.string().min(1).max(128),
  tool: z.string().min(1).max(120),
  receiptStatus: PlayReceiptStatusSchema,
  /** 游戏侧回执原文的人话摘要（≤300 字） */
  summary: z.string().min(1).max(300),
  /** 执行前后 get_state 的真实结构化差异；空对象 = 无可观测变化 */
  observedStateDelta: z.record(z.string(), z.string()).default({}),
  stateChanged: z.boolean(),
  /** 无变化的 COMPLETED 标可疑，不升 evidenceLevel（设计书 §6） */
  suspicious: z.boolean().default(false),
  evidenceLevel: EvidenceLevelSchema,
  /** 原始状态与游戏侧回执持久化，供重启后复查，绝不从模型台词生成 */
  beforeState: z.string(),
  afterState: z.string().optional(),
  rawReceipt: z.string(),
  /** 是否发生在宿主仿真模式，由宿主配置决定，调用者不可覆盖 */
  simulation: z.boolean(),
  beforeStateDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  afterStateDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  capturedAt: z.string().min(1),
});
export type PlayReceipt = z.infer<typeof PlayReceiptSchema>;

/** 导入材料（只接受 owner 授权目录内的本地文件；不接受任意 URL） */
export const KnowledgeImportMaterialInputSchema = z.object({
  filePath: z.string().min(1).max(1000),
  topic: z.string().min(1).max(120),
  licenseScope: MaterialLicenseScopeSchema.default('unknown'),
  licenseNote: z.string().min(1).max(300).optional(),
  sourceType: GameKnowledgeSourceTypeSchema.default('wiki'),
  /** 只导入前 N 个切片（默认全部；用于小步验证） */
  maxChunks: z.number().int().min(1).max(200).optional(),
  /** owner 显式声明的适用前提；不由模型补全。未填时只采用材料 frontmatter。 */
  gameVersion: z.string().min(1).optional(),
  modContext: z.array(z.string().min(1)).optional(),
  applicability: z.array(z.string().min(1)).default([]),
});
export type KnowledgeImportMaterialInput = z.infer<typeof KnowledgeImportMaterialInputSchema>;

/** 执行一条知识（必须先通过适用性判定） */
export const KnowledgeExecuteInputSchema = z.object({
  knowledgeId: z.string().min(1),
  tool: z.string().min(1).max(120),
  args: z.record(z.string(), z.unknown()).default({}),
  /** 第一切片不提供绕过适用性判定的开关；uncertain 时停止执行 */
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});
export type KnowledgeExecuteInput = z.infer<typeof KnowledgeExecuteInputSchema>;

/** 导入结果（宿主 → UI）：材料、证据包与入库候选知识一起返回，便于一次看清「读到了什么」 */
export const KnowledgeImportResultSchema = z.object({
  ok: z.boolean(),
  material: KnowledgeMaterialSchema.optional(),
  pack: EvidencePackSchema.optional(),
  units: z.array(GameKnowledgeItemSchema).default([]),
  error: z.string().min(1).optional(),
  /** 不可用时的降级说明（如 Envoy 缺失），UI 直接显示 */
  degradedReason: z.string().min(1).optional(),
});
export type KnowledgeImportResult = z.infer<typeof KnowledgeImportResultSchema>;

/** Envoy 外部协议的最小只读投影；只消费已验证字段，外部 Prompt/工具描述不作为指令。 */
export const EnvoyReadResponseSchema = z.object({
  material_id: z.string().min(1).nullish(),
  source_revision: z.string().min(1).nullish(),
  result: z.enum(['ready', 'partial', 'needs_host', 'blocked', 'empty']),
  blocks: z.array(z.object({
    id: z.string().min(1),
    origin: z.string(),
    content: z.object({ type: z.string(), text: z.string().optional() }),
    locator: z.object({ type: z.string(), page_number: z.number().int().positive().nullish(), locator_valid: z.boolean().optional() }).nullish(),
  })).default([]),
  coverage: z.object({
    modalities: z.record(z.string(), z.object({ extraction: EvidenceExtractionSchema.default('unknown') })).default({}),
    unresolved: z.array(z.string()).default([]),
  }).default({ modalities: {}, unresolved: [] }),
  errors: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
});
export type EnvoyReadResponse = z.infer<typeof EnvoyReadResponseSchema>;
export const EnvoyToolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: EnvoyReadResponseSchema.optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});

export const KnowledgeExecutionResultSchema = z.object({
  ok: z.boolean(),
  availability: z.enum(['available', 'unavailable', 'blocked']),
  reason: z.string().optional(),
  applicability: KnowledgeApplicabilitySchema.optional(),
  receipt: PlayReceiptSchema.optional(),
});
export type KnowledgeExecutionResult = z.infer<typeof KnowledgeExecutionResultSchema>;

export const KnowledgeIdSchema = z.string().min(1).max(200);
export const KnowledgeSnapshotSchema = z.object({
  units: z.array(GameKnowledgeItemSchema), materials: z.array(KnowledgeMaterialSchema), localTopics: z.array(z.string()),
});
