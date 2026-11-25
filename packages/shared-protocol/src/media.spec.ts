import { describe, expect, it } from 'vitest';
import {
  AssetPipelineStatusSchema,
  AssetProvenanceSchema,
  CharacterBibleSchema,
  MediaCandidateItemSchema,
  MediaJobSnapshotSchema,
  MediaJobSubmitRequestSchema,
  MediaProviderCapabilitySchema,
  BlenderToolchainStatusSchema,
  Pipeline3dJobSnapshotSchema,
  Pipeline3dRequestSchema,
  VrmInspectionReportSchema,
} from './media';

describe('shared-protocol V2-P2-03 media & provenance contracts', () => {
  it('validates 10 pipeline statuses, provider capability, and character bible defaults', () => {
    for (const s of [
      'draft', 'generating', 'candidate', 'processing', 'validation_failed',
      'review_required', 'approved', 'published', 'deprecated', 'restricted',
    ]) {
      expect(AssetPipelineStatusSchema.safeParse(s).success).toBe(true);
    }

    const cap = MediaProviderCapabilitySchema.parse({
      providerId: 'codex-cli',
      label: 'Codex CLI',
      kind: 'local-coding-agent',
      protocol: 'codex-cli',
      supportsImageGen: true,
      available: true,
      requiresOnlineBilling: true,
    });
    expect(cap.requiresOnlineBilling).toBe(true);

    const bible = CharacterBibleSchema.parse({
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      traits: { hairstyle: '蓝白渐变双马尾', eyes: '海蓝色' },
      forbiddenChanges: ['不可更改蓝鲸尾饰'],
      updatedAt: '2026-11-26T00:00:00.000Z',
    });
    expect(bible.version).toBe(1);
    expect(bible.traits.proportions).toBe('2.5头身 Q 版');
  });

  it('validates provenance, candidate item, job snapshot, and submit request', () => {
    const prov = AssetProvenanceSchema.parse({
      sourceType: 'ai-generated',
      license: 'AI_GENERATED_REVIEW_REQUIRED',
      allowCommercial: false,
      allowLivestream: false,
      allowRedistribution: false,
      generatedAt: '2026-11-26T00:00:00.000Z',
      sha256: 'abc123',
    });
    const cand = MediaCandidateItemSchema.parse({
      candidateId: 'cand-1',
      jobId: 'job-1',
      characterId: 'char_xiaojing',
      poseOrSlot: 'idle',
      filePath: '/tmp/cand.png',
      mimeType: 'image/png',
      sha256: 'abc123',
      status: 'review_required',
      provenance: prov,
      createdAt: '2026-11-26T00:00:00.000Z',
    });
    const snap = MediaJobSnapshotSchema.parse({
      jobId: 'job-1',
      characterId: 'char_xiaojing',
      providerId: 'openai-img',
      modelId: 'gpt-image-1',
      status: 'review_required',
      total: 1,
      completed: 1,
      failed: 0,
      candidates: [cand],
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    });
    expect(snap.candidates).toHaveLength(1);

    const req = MediaJobSubmitRequestSchema.parse({
      characterId: 'char_xiaojing',
      providerId: 'openai',
      protocol: 'openai',
      modelId: 'gpt-image-1',
      poses: ['idle'],
    });
    expect(req.size).toBe('1024x1024');

    const tc = BlenderToolchainStatusSchema.parse({
      available: false,
      binary: null,
      installHint: '安装 Blender',
    });
    expect(tc.vrmAddonDetected).toBe(false);
    const vrm = VrmInspectionReportSchema.parse({
      valid: true,
      format: 'vrm-1.0',
      meshCount: 1,
      materialCount: 1,
      skinCount: 1,
      hasHumanoidRig: true,
      hasLipSyncVisemes: true,
      sha256: 'abc',
    });
    expect(vrm.hasHumanoidRig).toBe(true);
    const p3d = Pipeline3dRequestSchema.parse({
      characterId: 'char_xiaojing',
      providerId: 'hunyuan',
      protocol: 'hunyuan3d-http',
      endpoint: 'https://3d.example/gen',
      inputImagePaths: ['/tmp/front.png'],
    });
    expect(p3d.targetPolycount).toBe(25000);
    const snap3d = Pipeline3dJobSnapshotSchema.parse({
      jobId: 'job3d-1',
      characterId: 'char_xiaojing',
      providerId: 'hunyuan',
      stage: 'review_required',
      createdAt: '2026-11-26',
      updatedAt: '2026-11-26',
    });
    expect(snap3d.stage).toBe('review_required');
  });
});
