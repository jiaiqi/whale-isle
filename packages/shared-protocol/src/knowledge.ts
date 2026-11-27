/**
 * Whale Isle V2 — 游戏攻略知识、来源溯源、版本/Mod 兼容与实玩验证闭环契约（V2-P2-01 / Blueprint 17 §7.3）
 *
 * V2-P4-04A（外部参考融合第一切片，`docs/v2/evidence/EXTERNAL-FUSION-C-incremental-design.md` §3.1–3.2）：
 * - 追加「可复核证据引用」：`EvidenceLocator` 指向材料里的真实位置（行号 / 网页 / 时间码 / 页码 / 图区），
 *   `EvidenceRef` 绑定 materialId + locator + 来源修订 + 材料 SHA-256 + 抽取状态；
 * - 追加知识生命周期 `unitState`（candidate / verified / promoted / archived）与证据级别 `evidenceLevel`；
 * - 全部为可选字段或带默认值的新字段，**不新增必填、不重命名既有字段**：旧记录与 P2-01 的 64 例夹具原样可解析。
 *
 * 命名口径（设计书 §3.1）：鲸屿字段名优先，外部来源（Envoy 的 `source_block_id` / `source_revision` /
 * `read_v1.py` 的 locator 类型）一律由适配器翻译，契约里不出现外部进程的命名。
 */
import { z } from 'zod';

export const GameKnowledgeSourceTypeSchema = z.enum([
  'official',
  'wiki',
  'community',
  'video',
  'user',
  'experience',
]);
export type GameKnowledgeSourceType = z.infer<typeof GameKnowledgeSourceTypeSchema>;

export const GameKnowledgeStatusSchema = z.enum([
  'unverified',
  'partially-verified',
  'verified',
  'outdated',
  'rejected',
]);
export type GameKnowledgeStatus = z.infer<typeof GameKnowledgeStatusSchema>;

export const GuideCompatibilityStatusSchema = z.enum([
  'compatible',
  'uncertain',
  'outdated',
  'mod-mismatch',
]);
export type GuideCompatibilityStatus = z.infer<typeof GuideCompatibilityStatusSchema>;

export const GuideProvenanceSchema = z.object({
  gameId: z.string().min(1).default('stardew'),
  sourceType: GameKnowledgeSourceTypeSchema.default('wiki'),
  sourceTitle: z.string().min(1).optional(),
  sourceUri: z.string().min(1).optional(),
  gameVersion: z.string().min(1).optional(),
  modContext: z.array(z.string().min(1)).default([]),
  retrievedAt: z.string().min(1).optional(),
});
export type GuideProvenance = z.infer<typeof GuideProvenanceSchema>;

export const GameRuntimeContextSchema = z.object({
  gameId: z.string().min(1).default('stardew'),
  gameVersion: z.string().min(1).optional(),
  installedMods: z.array(z.string().min(1)).default([]),
});
export type GameRuntimeContext = z.infer<typeof GameRuntimeContextSchema>;

export const GuideCompatibilityReportSchema = z.object({
  status: GuideCompatibilityStatusSchema,
  versionMatch: z.enum(['match', 'mismatch', 'unknown']),
  modMatch: z.enum(['match', 'missing-mods', 'unknown']),
  missingMods: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string().min(1)).default([]),
});
export type GuideCompatibilityReport = z.infer<typeof GuideCompatibilityReportSchema>;

/** 证据定位（V2-P4-04A）：指向材料里可被人类复核的一个真实位置；禁止指向不存在的位置 */
export const EvidenceLocatorSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('text'),
      /** 材料原文行号（1 基，含首尾） */
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('web'),
      url: z.string().min(1),
      selector: z.string().min(1).optional(),
      quote: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal('video'),
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
    }),
    z.object({ kind: z.literal('pdf'), page: z.number().int().positive() }),
    z.object({
      kind: z.literal('image-region'),
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      w: z.number().positive(),
      h: z.number().positive(),
    }),
  ])
  .refine(
    (locator) => {
      if (locator.kind === 'text') return locator.endLine >= locator.startLine;
      if (locator.kind === 'video') return locator.endMs > locator.startMs;
      return true;
    },
    { message: '定位区间非法（结束位置必须不早于起始位置）' },
  );
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

/** 材料抽取状态：`failed` 时证据不得用于把知识升为 verified */
export const EvidenceExtractionSchema = z.enum(['complete', 'partial', 'failed', 'unknown']);
export type EvidenceExtraction = z.infer<typeof EvidenceExtractionSchema>;

/**
 * 一条可复核证据引用。
 * `materialId` 指向材料（权威），`evidenceId` 指向「材料里的一个位置」——两者分开，
 * 才能表达「同一材料多处引用」与「材料重抓后旧证据失效」。
 */
export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1),
  materialId: z.string().min(1),
  locator: EvidenceLocatorSchema,
  /** 网页 etag / 文件 mtime / 视频页版本；与材料 SHA-256 互补 */
  sourceRevision: z.string().min(1).optional(),
  /** 64 位小写十六进制；大写或短哈希一律拒绝 */
  materialSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  extraction: EvidenceExtractionSchema.default('unknown'),
  capturedAt: z.string().min(1),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** 知识生命周期（与「事实可信度」`status` 正交，见设计书 §3.2） */
export const KnowledgeUnitStateSchema = z.enum(['candidate', 'verified', 'promoted', 'archived']);
export type KnowledgeUnitState = z.infer<typeof KnowledgeUnitStateSchema>;

/** 证据级别：沿用 `docs/v2/` 的证据分级词汇；严禁把 simulation 标成 real-device（AGENTS §2.4） */
export const EvidenceLevelSchema = z.enum([
  'real-device',
  'real-platform',
  'e2e-host',
  'simulation',
  'unverified',
]);
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>;

/** 对齐 Blueprint 17 §7.3 `GameKnowledgeItem` */
export const GameKnowledgeItemSchema = z.object({
  knowledgeId: z.string().min(1),
  gameId: z.string().min(1).default('stardew'),
  gameVersion: z.string().min(1).optional(),
  modContext: z.array(z.string().min(1)).default([]),
  topic: z.string().min(1),
  claim: z.string().min(1),
  sourceType: GameKnowledgeSourceTypeSchema,
  sourceUri: z.string().min(1).optional(),
  sourceTitle: z.string().min(1).optional(),
  retrievedAt: z.string().min(1),
  evidenceSummary: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  applicability: z.array(z.string().min(1)).default([]),
  knownLimitations: z.array(z.string().min(1)).default([]),
  contradictoryEvidence: z.array(z.string().min(1)).default([]),
  status: GameKnowledgeStatusSchema,
  // ---- V2-P4-04A 追补（全部可选/带默认值，旧数据零影响） ----
  /** 可复核证据引用；空数组表示「尚未证据化」，此时不得升 verified */
  evidenceRefs: z.array(EvidenceRefSchema).default([]),
  unitState: KnowledgeUnitStateSchema.default('candidate'),
  evidenceLevel: EvidenceLevelSchema.default('unverified'),
  supersedes: z.array(z.string().min(1)).default([]),
  supersededBy: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
});
export type GameKnowledgeItem = z.infer<typeof GameKnowledgeItemSchema>;
