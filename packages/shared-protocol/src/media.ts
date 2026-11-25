/**
 * Whale Isle V2 — MediaGenerationGateway、Character Bible、10 态资产管线与溯源契约（V2-P2-03 / Blueprint 06）
 */
import { z } from 'zod';

/** Blueprint 06 §8：统一十态资产管线 */
export const AssetPipelineStatusSchema = z.enum([
  'draft',
  'generating',
  'candidate',
  'processing',
  'validation_failed',
  'review_required',
  'approved',
  'published',
  'deprecated',
  'restricted',
]);
export type AssetPipelineStatus = z.infer<typeof AssetPipelineStatusSchema>;

export const MediaProviderKindSchema = z.enum([
  'local-coding-agent',
  'online-image-api',
  'online-3d-api',
  'local-3d-service',
]);
export type MediaProviderKind = z.infer<typeof MediaProviderKindSchema>;

export const MediaProviderCapabilitySchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1),
  kind: MediaProviderKindSchema,
  protocol: z.string().min(1),
  supportsImageGen: z.boolean(),
  supportsImageEdit: z.boolean().default(false),
  supportsMultiRef: z.boolean().default(false),
  supports3dGen: z.boolean().default(false),
  available: z.boolean(),
  requiresOnlineBilling: z.boolean(),
  capabilityNote: z.string().default(''),
  verifiedStatus: z.enum(['real-device-verified', 'adapter-only']).default('adapter-only'),
});
export type MediaProviderCapability = z.infer<typeof MediaProviderCapabilitySchema>;

export const CharacterBibleRefSchema = z.object({
  role: z.enum(['front', 'side', 'back', 'portrait', 'sheet']),
  path: z.string().min(1),
  sha256: z.string().optional(),
  approved: z.boolean().default(false),
});
export type CharacterBibleRef = z.infer<typeof CharacterBibleRefSchema>;

export const CharacterBibleSchema = z.object({
  characterId: z.string().min(1),
  displayName: z.string().min(1),
  version: z.number().int().positive().default(1),
  referenceImages: z.array(CharacterBibleRefSchema).default([]),
  traits: z.object({
    hairstyle: z.string().default(''),
    eyes: z.string().default(''),
    palette: z.array(z.string()).default([]),
    outfit: z.string().default(''),
    proportions: z.string().default('2.5头身 Q 版'),
    signatureAccessories: z.array(z.string()).default([]),
  }),
  expressionRules: z.array(z.string()).default([]),
  styleConstraints: z.array(z.string()).default([]),
  forbiddenChanges: z.array(z.string()).default([]),
  updatedAt: z.string().min(1),
});
export type CharacterBible = z.infer<typeof CharacterBibleSchema>;

/** Blueprint 06 §9：资产来源与授权矩阵 */
export const AssetProvenanceSchema = z.object({
  sourceType: z.enum(['ai-generated', 'user-upload', 'third-party-import']),
  author: z.string().optional(),
  repoOrUrl: z.string().optional(),
  license: z.string().min(1),
  allowCommercial: z.boolean(),
  allowLivestream: z.boolean(),
  allowRedistribution: z.boolean(),
  modelProvider: z.string().optional(),
  modelId: z.string().optional(),
  inputRefPaths: z.array(z.string()).default([]),
  generatedAt: z.string().min(1),
  sha256: z.string().min(1),
  reviewNotes: z.array(z.string()).default([]),
});
export type AssetProvenance = z.infer<typeof AssetProvenanceSchema>;

export const MediaCandidateItemSchema = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().min(1),
  characterId: z.string().min(1),
  poseOrSlot: z.string().min(1),
  filePath: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sha256: z.string().min(1),
  status: AssetPipelineStatusSchema,
  provenance: AssetProvenanceSchema,
  qaWarnings: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  reviewedAt: z.string().optional(),
  reviewerNote: z.string().optional(),
});
export type MediaCandidateItem = z.infer<typeof MediaCandidateItemSchema>;

export const MediaJobStatusSchema = z.enum([
  'queued',
  'generating',
  'review_required',
  'approved',
  'failed',
  'cancelled',
]);
export type MediaJobStatus = z.infer<typeof MediaJobStatusSchema>;

export const MediaJobSnapshotSchema = z.object({
  jobId: z.string().min(1),
  characterId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  status: MediaJobStatusSchema,
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  candidates: z.array(MediaCandidateItemSchema).default([]),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MediaJobSnapshot = z.infer<typeof MediaJobSnapshotSchema>;

export const MediaJobSubmitRequestSchema = z.object({
  characterId: z.string().min(1),
  providerId: z.string().min(1),
  protocol: z.enum(['openai', 'gemini', 'codex-cli']),
  baseUrl: z.string().url().optional(),
  modelId: z.string().min(1),
  poses: z.array(z.string().min(1)).min(1).max(24),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).default('1024x1024'),
  prompt: z.string().default(''),
  bible: CharacterBibleSchema.optional(),
  referenceImagePaths: z.array(z.string().min(1)).max(8).optional(),
});
export type MediaJobSubmitRequest = z.infer<typeof MediaJobSubmitRequestSchema>;

// ───────────────────────── 3D 生成与 Blender/VRM 管线（V2-P2-04 / Blueprint 06 §3 & §7） ─────────────────────────
export const Mesh3dProviderProtocolSchema = z.enum([
  'hunyuan3d-http',
  'tripo-http',
  'meshy-http',
  'custom-3d-http',
]);
export type Mesh3dProviderProtocol = z.infer<typeof Mesh3dProviderProtocolSchema>;

export const BlenderToolchainStatusSchema = z.object({
  available: z.boolean(),
  binary: z.string().nullable(),
  version: z.string().optional(),
  vrmAddonDetected: z.boolean().default(false),
  installHint: z.string(),
});
export type BlenderToolchainStatus = z.infer<typeof BlenderToolchainStatusSchema>;

export const VrmInspectionReportSchema = z.object({
  valid: z.boolean(),
  format: z.enum(['vrm-0.x', 'vrm-1.0', 'glb', 'invalid']),
  meshCount: z.number().int().nonnegative(),
  materialCount: z.number().int().nonnegative(),
  skinCount: z.number().int().nonnegative(),
  hasHumanoidRig: z.boolean(),
  missingCoreBones: z.array(z.string()).default([]),
  blendShapeNames: z.array(z.string()).default([]),
  hasLipSyncVisemes: z.boolean(),
  vrmVersion: z.string().optional(),
  licenseNote: z.string().optional(),
  sha256: z.string().min(1),
  errors: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type VrmInspectionReport = z.infer<typeof VrmInspectionReportSchema>;

export const Pipeline3dStageSchema = z.enum([
  'queued',
  'generating_mesh',
  'blender_postprocess',
  'qa_inspecting',
  'review_required',
  'approved',
  'published',
  'validation_failed',
  'failed',
]);
export type Pipeline3dStage = z.infer<typeof Pipeline3dStageSchema>;

export const Pipeline3dRequestSchema = z.object({
  characterId: z.string().min(1),
  providerId: z.string().min(1),
  protocol: Mesh3dProviderProtocolSchema,
  endpoint: z.string().url(),
  modelId: z.string().min(1).default('hunyuan3d-2'),
  inputImagePaths: z.array(z.string().min(1)).min(1).max(4),
  prompt: z.string().default(''),
  targetPolycount: z.number().int().min(1000).max(200000).default(25000),
  exportVrm: z.boolean().default(true),
  runBlenderPostprocess: z.boolean().default(true),
});
export type Pipeline3dRequest = z.infer<typeof Pipeline3dRequestSchema>;

export const Pipeline3dJobSnapshotSchema = z.object({
  jobId: z.string().min(1),
  characterId: z.string().min(1),
  providerId: z.string().min(1),
  stage: Pipeline3dStageSchema,
  rawMeshPath: z.string().optional(),
  processedVrmPath: z.string().optional(),
  inspection: VrmInspectionReportSchema.optional(),
  provenance: AssetProvenanceSchema.optional(),
  blenderLog: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Pipeline3dJobSnapshot = z.infer<typeof Pipeline3dJobSnapshotSchema>;
