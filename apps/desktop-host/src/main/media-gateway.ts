/**
 * Whale Isle V2 — 统一媒体生成网关与候选区审查流水线（V2-P2-03 / Blueprint 06）
 *
 * 设计约束：
 *   - 统一封装「本地 Coding Agent（逐项探测是否支持生图，不假设都会画图，诚实标注仍可能消耗在线费用）」
 *     与「在线 Image Provider API」两条入口；
 *   - 结合 Character Bible（正面/侧面/背面/立绘已批准参考图 + 外观锁定特征 + forbiddenChanges）生成一致性提示词；
 *   - 产物强制先写入 `<userData>/media-candidates/<jobId>/` 候选区并执行 QA（MIME 嗅探 / PNG 尺寸 / SHA-256），
 *     附带完整 AssetProvenance；绝不未经审批覆盖已发布角色资产。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  MediaCandidateItemSchema,
  MediaJobSnapshotSchema,
  MediaJobSubmitRequestSchema,
  MediaProviderCapabilitySchema,
  type CharacterBible,
  type ImageGenProviderDescriptor,
  type MediaCandidateItem,
  type MediaJobSnapshot,
  type MediaProviderCapability,
} from '@workbench/shared-protocol';
import {
  detectCodexCli,
  redactCodexError,
  sniffImageMime,
  type CodexCliDetection,
} from './codex-image-backend';
import { draftExtension, runWithConcurrency } from './image-gen-drafts';
import { generateImage, type GenerateImageArgs, type GeneratedImage } from './image-gen-client';
import { readPngDimensions } from './pixel-sprite-pipeline';
import { hasVaultKey, readVaultKey } from './provider-vault';

const CANDIDATES_DIR = 'media-candidates';

/** 按 Character Bible 编译生图提示词：锁定外观要素与禁止篡改特征 */
export function compileBiblePrompt(bible: CharacterBible, poseOrSlot: string, extraPrompt = ''): string {
  const parts: string[] = [
    `角色「${bible.displayName}」（${bible.characterId}），目标姿态/槽位：「${poseOrSlot}」`,
  ];
  const t = bible.traits;
  const traitItems = [
    t.hairstyle ? `发型：${t.hairstyle}` : '',
    t.eyes ? `瞳色/眼型：${t.eyes}` : '',
    t.palette.length > 0 ? `配色：${t.palette.join('、')}` : '',
    t.outfit ? `服装：${t.outfit}` : '',
    t.proportions ? `比例：${t.proportions}` : '',
    t.signatureAccessories.length > 0 ? `标志配件：${t.signatureAccessories.join('、')}` : '',
  ].filter((s) => s !== '');
  if (traitItems.length > 0) parts.push(`【角色设定】${traitItems.join('；')}`);
  if (bible.styleConstraints.length > 0) parts.push(`【风格约束】${bible.styleConstraints.join('；')}`);
  if (bible.expressionRules.length > 0) parts.push(`【表情规范】${bible.expressionRules.join('；')}`);
  if (bible.forbiddenChanges.length > 0) parts.push(`【严禁改动】${bible.forbiddenChanges.join('；')}`);
  if (extraPrompt.trim() !== '') parts.push(extraPrompt.trim());
  return parts.join('\n');
}

const REF_ROLE_PRIORITY: Record<CharacterBible['referenceImages'][number]['role'], number> = {
  front: 0,
  portrait: 1,
  side: 2,
  back: 3,
  sheet: 4,
};

/** 优先选用显式传入的参考图，否则按角色三视图权重挑选 Character Bible 已批准参考图 */
export function selectApprovedReferences(
  bible?: CharacterBible,
  explicitPaths?: readonly string[],
  existsImpl: (path: string) => boolean = existsSync,
): string[] {
  const out: string[] = [];
  if (explicitPaths !== undefined) {
    for (const p of explicitPaths) {
      if (p.trim() !== '' && existsImpl(p) && !out.includes(p)) out.push(p);
    }
  }
  if (out.length === 0 && bible !== undefined) {
    const approved = bible.referenceImages
      .filter((r) => r.approved && existsImpl(r.path))
      .sort((a, b) => REF_ROLE_PRIORITY[a.role] - REF_ROLE_PRIORITY[b.role]);
    for (const ref of approved) {
      if (!out.includes(ref.path)) out.push(ref.path);
    }
  }
  return out;
}

export interface ImageAssetInspection {
  valid: boolean;
  mimeType: string;
  width?: number;
  height?: number;
  sha256: string;
  warnings: string[];
}

/** 确定性图像资产 QA：校验魔数 MIME、尺寸与 SHA-256 摘要 */
export function inspectImageAsset(buffer: Buffer): ImageAssetInspection {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (buffer.length === 0) {
    return { valid: false, mimeType: 'application/octet-stream', sha256, warnings: ['图像文件为空（0 bytes）'] };
  }
  const mime = sniffImageMime(buffer);
  if (mime === null) {
    return { valid: false, mimeType: 'application/octet-stream', sha256, warnings: ['图像文件头校验失败（非合法 PNG/WebP/JPEG）'] };
  }
  const dims = mime === 'image/png' ? readPngDimensions(buffer) : null;
  return {
    valid: true,
    mimeType: mime,
    ...(dims === null ? {} : { width: dims.width, height: dims.height }),
    sha256,
    warnings: [],
  };
}

export interface MediaGenerationGatewayOptions {
  userDataDir: string;
  vaultPath?: string;
  homeDir?: string;
  concurrency?: number;
  detectCodexImpl?: (deps: { homeDir: string }) => CodexCliDetection;
  hasVaultKeyImpl?: (vaultPath: string, providerId: string) => boolean;
  readVaultKeyImpl?: (vaultPath: string, providerId: string) => string | null;
  generateImageImpl?: (args: GenerateImageArgs) => Promise<GeneratedImage>;
}

const NON_IMAGE_CODING_AGENTS: Array<{ providerId: string; label: string; protocol: string; note: string }> = [
  { providerId: 'gemini-cli', label: 'Gemini CLI', protocol: 'acp', note: 'Coding Agent 文本编程能力，当前 ACP 会话不提供直接出图接口' },
  { providerId: 'claude-acp', label: 'Claude Code', protocol: 'acp', note: 'Coding Agent 文本编程能力，原生不直接生成二值图片文件' },
  { providerId: 'opencode-cli', label: 'OpenCode CLI', protocol: 'cli-exec', note: 'Coding Agent 文本编程能力，未探测到内置生图工具' },
];

export class MediaGenerationGateway {
  private readonly candidatesRoot: string;
  private readonly jobs = new Map<string, MediaJobSnapshot>();
  private readonly cancelledJobs = new Set<string>();

  constructor(private readonly options: MediaGenerationGatewayOptions) {
    this.candidatesRoot = resolve(join(options.userDataDir, CANDIDATES_DIR));
    mkdirSync(this.candidatesRoot, { recursive: true });
    this.loadPersistedJobs();
  }

  private loadPersistedJobs(): void {
    try {
      for (const entry of readdirSync(this.candidatesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const jobPath = join(this.candidatesRoot, entry.name, 'job.json');
        if (!existsSync(jobPath)) continue;
        try {
          const parsed = MediaJobSnapshotSchema.safeParse(JSON.parse(readFileSync(jobPath, 'utf8')) as unknown);
          if (parsed.success) this.jobs.set(parsed.data.jobId, parsed.data);
        } catch { /* 损坏的候选任务快照安全跳过 */ }
      }
    } catch { /* 候选根目录读取异常不阻断启动 */ }
  }

  private saveJob(job: MediaJobSnapshot): void {
    const jobDir = resolve(join(this.candidatesRoot, job.jobId));
    if (jobDir !== this.candidatesRoot && !jobDir.startsWith(`${this.candidatesRoot}${sep}`)) {
      throw new Error('候选目录越界');
    }
    mkdirSync(jobDir, { recursive: true });
    const filePath = join(jobDir, 'job.json');
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
    renameSync(tmp, filePath);
  }

  /** 诚实探测媒体供应商能力：不假设每个 Coding Agent 都能生图，且明确标注在线费用 */
  probeProviders(onlineDescriptors: readonly ImageGenProviderDescriptor[] = []): MediaProviderCapability[] {
    const detectCodex = this.options.detectCodexImpl ?? ((deps) => detectCodexCli(deps));
    const hasKey = this.options.hasVaultKeyImpl ?? hasVaultKey;
    const codex = detectCodex({ homeDir: this.options.homeDir ?? '' });

    const out: MediaProviderCapability[] = [
      MediaProviderCapabilitySchema.parse({
        providerId: 'codex-cli',
        label: `Codex CLI（${codex.backend === 'codex-imagegen' ? 'codex-imagegen' : 'codex exec'}）`,
        kind: 'local-coding-agent',
        protocol: 'codex-cli',
        supportsImageGen: codex.available,
        supportsImageEdit: codex.backend === 'codex-imagegen',
        supportsMultiRef: false,
        supports3dGen: false,
        available: codex.available && codex.loggedIn,
        requiresOnlineBilling: true,
        capabilityNote: codex.available
          ? (codex.loggedIn
            ? '本地调度 Codex CLI 生图，注意仍依赖在线订阅并计入云端调用费用'
            : `已检测到 Codex CLI，请先运行 ${codex.loginHint}`)
          : `未检测到本机 Codex CLI（可选安装：${codex.installHint}）`,
        verifiedStatus: 'adapter-only',
      }),
      ...NON_IMAGE_CODING_AGENTS.map((a) => MediaProviderCapabilitySchema.parse({
        providerId: a.providerId,
        label: a.label,
        kind: 'local-coding-agent',
        protocol: a.protocol,
        supportsImageGen: false,
        supportsImageEdit: false,
        supportsMultiRef: false,
        supports3dGen: false,
        available: false,
        requiresOnlineBilling: true,
        capabilityNote: a.note,
        verifiedStatus: 'adapter-only',
      })),
    ];

    for (const desc of onlineDescriptors) {
      if (desc.protocol === 'codex-cli') continue;
      const keyOk = this.options.vaultPath !== undefined && hasKey(this.options.vaultPath, desc.id);
      out.push(MediaProviderCapabilitySchema.parse({
        providerId: desc.id,
        label: desc.name || desc.id,
        kind: 'online-image-api',
        protocol: desc.protocol,
        supportsImageGen: true,
        supportsImageEdit: true,
        supportsMultiRef: desc.protocol === 'gemini',
        supports3dGen: false,
        available: keyOk,
        requiresOnlineBilling: true,
        capabilityNote: keyOk ? '已配置 Vault Key，直接走在线 Images API' : '未配置 Vault Key',
        verifiedStatus: 'adapter-only',
      }));
    }

    return out;
  }

  listJobs(characterId?: string): MediaJobSnapshot[] {
    return [...this.jobs.values()]
      .filter((j) => characterId === undefined || j.characterId === characterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => ({ ...j, candidates: j.candidates.map((c) => ({ ...c, provenance: { ...c.provenance, inputRefPaths: [...c.provenance.inputRefPaths], reviewNotes: [...c.provenance.reviewNotes] }, qaWarnings: [...c.qaWarnings] })) }));
  }

  getJob(jobId: string): MediaJobSnapshot | null {
    return this.listJobs().find((j) => j.jobId === jobId) ?? null;
  }

  cancelJob(jobId: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (job === undefined) return { ok: false, error: `生图任务不存在：${jobId}` };
    this.cancelledJobs.add(jobId);
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
    return { ok: true };
  }

  /** 提交多姿态图片生成任务：产物严格落入独立候选区，绝不覆盖已发布资产 */
  async submitImageJob(rawInput: unknown): Promise<MediaJobSnapshot> {
    const req = MediaJobSubmitRequestSchema.parse(rawInput);
    const now = new Date().toISOString();
    const jobId = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const jobDir = join(this.candidatesRoot, jobId);
    mkdirSync(jobDir, { recursive: true });

    const job: MediaJobSnapshot = {
      jobId,
      characterId: req.characterId,
      providerId: req.providerId,
      modelId: req.modelId,
      status: 'generating',
      total: req.poses.length,
      completed: 0,
      failed: 0,
      candidates: [],
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, job);
    this.saveJob(job);

    const detectCodex = this.options.detectCodexImpl ?? ((deps) => detectCodexCli(deps));
    const readKey = this.options.readVaultKeyImpl ?? readVaultKey;
    const genImpl = this.options.generateImageImpl ?? generateImage;

    let apiKey = '';
    let codexDetection: CodexCliDetection | undefined;
    if (req.protocol === 'codex-cli') {
      codexDetection = detectCodex({ homeDir: this.options.homeDir ?? '' });
      if (!codexDetection.available || !codexDetection.loggedIn) {
        job.status = 'failed';
        job.error = !codexDetection.available
          ? `未检测到本机 Codex CLI（${codexDetection.installHint}）`
          : `本机 Codex CLI 未登录（请运行 ${codexDetection.loginHint}）`;
        job.updatedAt = new Date().toISOString();
        this.saveJob(job);
        return this.getJob(jobId)!;
      }
    } else {
      const key = this.options.vaultPath === undefined ? null : readKey(this.options.vaultPath, req.providerId);
      if (key === null) {
        job.status = 'failed';
        job.error = `供应商「${req.providerId}」未配置可用 Vault Key`;
        job.updatedAt = new Date().toISOString();
        this.saveJob(job);
        return this.getJob(jobId)!;
      }
      apiKey = key;
    }

    const refPaths = selectApprovedReferences(req.bible, req.referenceImagePaths);
    const primaryRef = refPaths[0];
    const baseUrl = req.baseUrl ?? (req.protocol === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1');

    await runWithConcurrency(req.poses, this.options.concurrency ?? 2, async (pose) => {
      if (this.cancelledJobs.has(jobId)) return;
      const compiledPrompt = req.bible !== undefined
        ? compileBiblePrompt(req.bible, pose, req.prompt)
        : `${req.prompt.trim()}\n姿态/槽位：${pose}`.trim();
      try {
        const img = await genImpl({
          protocol: req.protocol,
          baseUrl,
          apiKey,
          modelId: req.modelId,
          prompt: compiledPrompt,
          size: req.size,
          ...(primaryRef === undefined ? {} : { referenceImagePath: primaryRef }),
          ...(codexDetection === undefined ? {} : { codex: { detection: codexDetection } }),
        });
        if (this.cancelledJobs.has(jobId)) return;

        const inspection = inspectImageAsset(img.buffer);
        const safePose = pose.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '_') || 'pose';
        const ext = inspection.valid ? draftExtension(inspection.mimeType) : 'bin';
        const outFile = join(jobDir, `${safePose}-${randomUUID().slice(0, 4)}.${ext}`);
        writeFileSync(outFile, img.buffer);

        const candidate: MediaCandidateItem = MediaCandidateItemSchema.parse({
          candidateId: `cand-${randomUUID().slice(0, 8)}`,
          jobId,
          characterId: req.characterId,
          poseOrSlot: pose,
          filePath: outFile,
          mimeType: inspection.mimeType,
          ...(inspection.width === undefined ? {} : { width: inspection.width }),
          ...(inspection.height === undefined ? {} : { height: inspection.height }),
          sha256: inspection.sha256,
          status: inspection.valid ? 'review_required' : 'validation_failed',
          provenance: {
            sourceType: 'ai-generated',
            license: 'AI_GENERATED_REVIEW_REQUIRED',
            allowCommercial: false,
            allowLivestream: false,
            allowRedistribution: false,
            modelProvider: req.providerId,
            modelId: req.modelId,
            inputRefPaths: refPaths,
            generatedAt: new Date().toISOString(),
            sha256: inspection.sha256,
            reviewNotes: [],
          },
          qaWarnings: inspection.warnings,
          createdAt: new Date().toISOString(),
        });
        job.candidates.push(candidate);
        if (inspection.valid) job.completed += 1;
        else job.failed += 1;
      } catch (err) {
        job.failed += 1;
        job.error = redactCodexError(err instanceof Error ? err.message : String(err));
      }
      job.updatedAt = new Date().toISOString();
      this.saveJob(job);
    });

    if (this.cancelledJobs.has(jobId)) {
      job.status = 'cancelled';
    } else if (job.completed > 0) {
      job.status = 'review_required';
    } else {
      job.status = 'failed';
    }
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
    return this.getJob(jobId)!;
  }

  /** 候选区人工审查：approve / reject，写入审核人与授权元数据 */
  reviewCandidate(params: {
    jobId: string;
    candidateId: string;
    decision: 'approve' | 'reject';
    note?: string;
    license?: string;
    allowCommercial?: boolean;
    allowLivestream?: boolean;
  }): { ok: boolean; error?: string; job?: MediaJobSnapshot } {
    const job = this.jobs.get(params.jobId);
    if (job === undefined) return { ok: false, error: `任务不存在：${params.jobId}` };
    const cand = job.candidates.find((c) => c.candidateId === params.candidateId);
    if (cand === undefined) return { ok: false, error: `候选资产不存在：${params.candidateId}` };
    if (params.decision === 'approve' && cand.status === 'validation_failed') {
      return { ok: false, error: 'QA 校验失败的候选资产禁止批准（validation_failed）' };
    }

    const now = new Date().toISOString();
    cand.status = params.decision === 'approve' ? 'approved' : 'restricted';
    cand.reviewedAt = now;
    if (params.note !== undefined && params.note.trim() !== '') {
      cand.reviewerNote = params.note.trim();
      cand.provenance.reviewNotes.push(`${params.decision}: ${params.note.trim()}`);
    }
    if (params.license !== undefined && params.license.trim() !== '') cand.provenance.license = params.license.trim();
    if (params.allowCommercial !== undefined) cand.provenance.allowCommercial = params.allowCommercial;
    if (params.allowLivestream !== undefined) cand.provenance.allowLivestream = params.allowLivestream;

    const validCands = job.candidates.filter((c) => c.status !== 'validation_failed');
    if (validCands.length > 0 && validCands.every((c) => c.status === 'approved' || c.status === 'published')) {
      job.status = 'approved';
    } else if (validCands.some((c) => c.status === 'review_required')) {
      job.status = 'review_required';
    }
    job.updatedAt = now;
    this.saveJob(job);
    return { ok: true, job: this.getJob(job.jobId)! };
  }

  /** 仅允许发布状态为 `approved` 的候选图，绝不将未审或校验失败资产覆写至发布目录 */
  async promoteApprovedCandidates(
    jobId: string,
    onPublish: (approved: MediaCandidateItem[]) => Promise<void> | void,
  ): Promise<{ ok: boolean; error?: string; published?: string[]; job?: MediaJobSnapshot }> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return { ok: false, error: `任务不存在：${jobId}` };
    const approved = job.candidates.filter((c) => c.status === 'approved');
    if (approved.length === 0) {
      return { ok: false, error: '候选区暂无已批准（approved）资产，禁止未经审查覆盖已发布资产' };
    }
    await onPublish(approved.map((c) => ({ ...c, provenance: { ...c.provenance } })));
    for (const c of approved) c.status = 'published';
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
    return { ok: true, published: approved.map((c) => c.candidateId), job: this.getJob(jobId)! };
  }
}

export { MediaCandidateItemSchema };
