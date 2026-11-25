/**
 * Whale Isle V2 — 3D 大模型生成与 Blender 自动化后处理、GLB/VRM 二进制质检管线（V2-P2-04）
 *
 * 原则（Blueprint 06 §3 & §7）：
 *   - 3D 生成大模型负责产出初始网格（Hunyuan3D 等 HTTP 服务），Blender 负责无头自动化后处理与绑骨；
 *   - 「生成一个漂亮模型不代表它已经具备可动画能力」：`inspectGlbOrVrm` 真实解析 glTF 2.0/VRM 0.x/1.0
 *     二进制块，校验网格、材质、Humanoid 核心骨骼、BlendShapes 与口型 Viseme，缺骨或裸 GLB 在要求 VRM 时判失败；
 *   - 所有外部命令行调用（Blender）一律走参数数组 `execFile`，严禁 shell 字符串拼接。
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  BlenderToolchainStatusSchema,
  Pipeline3dJobSnapshotSchema,
  Pipeline3dRequestSchema,
  VrmInspectionReportSchema,
  type BlenderToolchainStatus,
  type Pipeline3dJobSnapshot,
  type Pipeline3dRequest,
  type VrmInspectionReport,
} from '@workbench/shared-protocol';
import { redactCodexError } from './codex-image-backend';
import { readVaultKey } from './provider-vault';

const CANDIDATES_3D_DIR = 'media-3d-candidates';
const GLTF_MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK_TYPE = 0x4e4f534a; // 'JSON'

const CORE_HUMANOID_BONES = [
  'hips',
  'spine',
  'head',
  'leftUpperArm',
  'rightUpperArm',
  'leftUpperLeg',
  'rightUpperLeg',
] as const;

const LIP_VISEME_SET = new Set(['aa', 'ih', 'ou', 'ee', 'oh', 'a', 'i', 'u', 'e', 'o']);

/** 真实解析 GLB / VRM 0.x / VRM 1.0 二进制块并执行可动画化 QA */
export function inspectGlbOrVrm(buffer: Buffer, requireVrmRig = true): VrmInspectionReport {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const fail = (errors: string[]): VrmInspectionReport => VrmInspectionReportSchema.parse({
    valid: false,
    format: 'invalid',
    meshCount: 0,
    materialCount: 0,
    skinCount: 0,
    hasHumanoidRig: false,
    missingCoreBones: [...CORE_HUMANOID_BONES],
    blendShapeNames: [],
    hasLipSyncVisemes: false,
    sha256,
    errors,
    warnings: [],
  });

  if (buffer.length < 28) return fail(['文件过小，不是合法 glTF/GLB/VRM 二进制容器']);
  const magic = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  if (magic !== GLTF_MAGIC || version !== 2) return fail([`非法 glTF 文件头（magic=0x${magic.toString(16)}, version=${version}）`]);

  const chunkLength = buffer.readUInt32LE(12);
  const chunkType = buffer.readUInt32LE(16);
  if (chunkType !== JSON_CHUNK_TYPE || 20 + chunkLength > buffer.length) {
    return fail(['GLB 缺少完整 JSON 块（JSON chunk 截断或类型错误）']);
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(buffer.subarray(20, 20 + chunkLength).toString('utf8')) as Record<string, unknown>;
  } catch {
    return fail(['GLB JSON 块解析失败']);
  }

  const meshes = Array.isArray(doc['meshes']) ? doc['meshes'] : [];
  const materials = Array.isArray(doc['materials']) ? doc['materials'] : [];
  const skins = Array.isArray(doc['skins']) ? doc['skins'] : [];
  const exts = (typeof doc['extensions'] === 'object' && doc['extensions'] !== null ? doc['extensions'] : {}) as Record<string, unknown>;

  let format: VrmInspectionReport['format'] = 'glb';
  let vrmVersion: string | undefined;
  let licenseNote: string | undefined;
  const presentBones = new Set<string>();
  const blendShapeNames: string[] = [];

  if (typeof exts['VRMC_vrm'] === 'object' && exts['VRMC_vrm'] !== null) {
    format = 'vrm-1.0';
    const vrm1 = exts['VRMC_vrm'] as Record<string, unknown>;
    vrmVersion = typeof vrm1['specVersion'] === 'string' ? vrm1['specVersion'] : '1.0';
    const meta = vrm1['meta'] as Record<string, unknown> | undefined;
    if (typeof meta?.['licenseUrl'] === 'string') licenseNote = meta['licenseUrl'];
    else if (typeof meta?.['commercialUsage'] === 'string') licenseNote = meta['commercialUsage'];

    const humanBones = (vrm1['humanoid'] as { humanBones?: Record<string, unknown> } | undefined)?.humanBones ?? {};
    for (const [bone, val] of Object.entries(humanBones)) {
      if (typeof val === 'object' && val !== null && typeof (val as { node?: unknown }).node === 'number') {
        presentBones.add(bone);
      }
    }
    const preset = (vrm1['expressions'] as { preset?: Record<string, unknown>; custom?: Record<string, unknown> } | undefined)?.preset ?? {};
    const custom = (vrm1['expressions'] as { custom?: Record<string, unknown> } | undefined)?.custom ?? {};
    for (const k of [...Object.keys(preset), ...Object.keys(custom)]) blendShapeNames.push(k);
  } else if (typeof exts['VRM'] === 'object' && exts['VRM'] !== null) {
    format = 'vrm-0.x';
    const vrm0 = exts['VRM'] as Record<string, unknown>;
    vrmVersion = typeof vrm0['specVersion'] === 'string' ? vrm0['specVersion'] : '0.0';
    const meta = vrm0['meta'] as Record<string, unknown> | undefined;
    if (typeof meta?.['licenseName'] === 'string') licenseNote = meta['licenseName'];

    const bones = (vrm0['humanoid'] as { humanBones?: Array<{ bone?: unknown; node?: unknown }> } | undefined)?.humanBones ?? [];
    if (Array.isArray(bones)) {
      for (const b of bones) {
        if (typeof b?.bone === 'string' && typeof b?.node === 'number') presentBones.add(b.bone);
      }
    }
    const groups = (vrm0['blendShapeMaster'] as { blendShapeGroups?: Array<{ name?: unknown; presetName?: unknown }> } | undefined)?.blendShapeGroups ?? [];
    if (Array.isArray(groups)) {
      for (const g of groups) {
        const n = typeof g?.presetName === 'string' && g.presetName !== '' ? g.presetName : (typeof g?.name === 'string' ? g.name : '');
        if (n !== '') blendShapeNames.push(n);
      }
    }
  }

  const missingCoreBones = CORE_HUMANOID_BONES.filter((b) => !presentBones.has(b));
  const hasHumanoidRig = format !== 'glb' && missingCoreBones.length === 0 && skins.length > 0;
  const visemeHits = blendShapeNames.filter((n) => LIP_VISEME_SET.has(n.trim().toLowerCase())).length;
  const hasLipSyncVisemes = visemeHits >= 3;

  const errors: string[] = [];
  const warnings: string[] = [];
  if (meshes.length === 0) errors.push('模型不包含任何网格（meshes=0）');
  if (requireVrmRig) {
    if (format === 'glb') errors.push('仅包含裸 GLB 网格，缺少 VRM 扩展与 Humanoid 骨骼绑定，尚不具备可动画能力');
    else {
      if (skins.length === 0) errors.push('VRM 缺少蒙皮数据（skins=0）');
      if (missingCoreBones.length > 0) errors.push(`缺少核心 Humanoid 骨骼：${missingCoreBones.join(', ')}`);
      if (!hasLipSyncVisemes) warnings.push('未检测到完整 5 态口型 Viseme（aa/ih/ou/ee/oh），后续舞台嘴型同步将降级');
    }
  }

  return VrmInspectionReportSchema.parse({
    valid: errors.length === 0,
    format,
    meshCount: meshes.length,
    materialCount: materials.length,
    skinCount: skins.length,
    hasHumanoidRig,
    missingCoreBones,
    blendShapeNames,
    hasLipSyncVisemes,
    ...(vrmVersion === undefined ? {} : { vrmVersion }),
    ...(licenseNote === undefined ? {} : { licenseNote }),
    sha256,
    errors,
    warnings,
  });
}

export interface ExecFile3dLike {
  (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
}

/** 跨平台探测本机 Blender CLI 与 VRM Add-on 可用性 */
export async function detectBlenderToolchain(deps: {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  execFileImpl?: ExecFile3dLike;
} = {}): Promise<BlenderToolchainStatus> {
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const pathDirs = (deps.pathEnv ?? process.env['PATH'] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const binName = platform === 'win32' ? 'blender.exe' : 'blender';
  const candidates = [
    ...pathDirs.map((d) => join(d, binName)),
    ...(platform === 'darwin'
      ? ['/Applications/Blender.app/Contents/MacOS/Blender', '/opt/homebrew/bin/blender', '/usr/local/bin/blender']
      : []),
    ...(platform === 'win32'
      ? ['C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe', 'C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe']
      : ['/usr/bin/blender', '/usr/local/bin/blender']),
  ];

  const binary = candidates.find((c) => exists(c)) ?? null;
  if (binary === null) {
    return BlenderToolchainStatusSchema.parse({
      available: false,
      binary: null,
      vrmAddonDetected: false,
      installHint: '本机未安装 Blender；请安装 Blender 4.x 与 VRM Add-on for Blender 后再启用 3D 自动绑骨与 VRM 导出',
    });
  }

  const execImpl = deps.execFileImpl ?? (nodeExecFile as unknown as ExecFile3dLike);
  const versionRes = await new Promise<{ version?: string; vrmAddonDetected: boolean }>((resolveProbe) => {
    try {
      execImpl(binary, ['--version'], { timeout: 5_000 }, (err, stdout) => {
        if (err !== null) {
          resolveProbe({ vrmAddonDetected: false });
          return;
        }
        const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/i.exec(stdout);
        resolveProbe({
          ...(m?.[1] === undefined ? {} : { version: m[1] }),
          vrmAddonDetected: /vrm/i.test(stdout),
        });
      });
    } catch {
      resolveProbe({ vrmAddonDetected: false });
    }
  });

  return BlenderToolchainStatusSchema.parse({
    available: true,
    binary,
    ...(versionRes.version === undefined ? {} : { version: versionRes.version }),
    vrmAddonDetected: versionRes.vrmAddonDetected,
    installHint: versionRes.vrmAddonDetected ? 'Blender 与 VRM 插件就绪' : '已检测到 Blender，导出 VRM 需确认启用 VRM Add-on for Blender',
  });
}

/** 生成无头 Blender Python 后处理脚本：重算法线、Smart UV、减面优化与 VRM/GLB 导出 */
export function generateBlenderPostprocessScript(opts: { targetPolycount: number; exportVrm: boolean }): string {
  return `# Auto-generated by Whale Isle V2 Pipeline3d
import sys, bpy
argv = sys.argv[sys.argv.index("--") + 1:]
in_path, out_path = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=in_path)
target_faces = ${Math.max(1000, Math.floor(opts.targetPolycount))}
for obj in bpy.context.scene.objects:
    if obj.type != 'MESH':
        continue
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    if not obj.data.uv_layers:
        bpy.ops.uv.smart_project(angle_limit=1.15192)
    bpy.ops.object.mode_set(mode='OBJECT')
    faces = len(obj.data.polygons)
    if faces > target_faces:
        mod = obj.modifiers.new(name='WhaleDecimate', type='DECIMATE')
        mod.ratio = max(0.05, float(target_faces) / float(faces))
        bpy.ops.object.modifier_apply(modifier=mod.name)
if ${opts.exportVrm ? 'True' : 'False'} and hasattr(bpy.ops.export_scene, 'vrm'):
    bpy.ops.export_scene.vrm(filepath=out_path)
else:
    bpy.ops.export_scene.gltf(filepath=out_path, export_format='GLB')
`;
}

export interface Pipeline3dManagerOptions {
  userDataDir: string;
  vaultPath?: string;
  readVaultKeyImpl?: (vaultPath: string, providerId: string) => string | null;
  detectBlenderImpl?: () => Promise<BlenderToolchainStatus>;
  generateMeshImpl?: (req: Pipeline3dRequest, apiKey: string | null) => Promise<Buffer>;
  execFileImpl?: ExecFile3dLike;
}

export class Pipeline3dManager {
  private readonly rootDir: string;
  private readonly jobs = new Map<string, Pipeline3dJobSnapshot>();

  constructor(private readonly options: Pipeline3dManagerOptions) {
    this.rootDir = resolve(join(options.userDataDir, CANDIDATES_3D_DIR));
    mkdirSync(this.rootDir, { recursive: true });
    this.loadPersisted();
  }

  private loadPersisted(): void {
    try {
      for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const jobPath = join(this.rootDir, entry.name, 'job.json');
        if (!existsSync(jobPath)) continue;
        try {
          const parsed = Pipeline3dJobSnapshotSchema.safeParse(JSON.parse(readFileSync(jobPath, 'utf8')) as unknown);
          if (parsed.success) this.jobs.set(parsed.data.jobId, parsed.data);
        } catch { /* 损坏快照忽略 */ }
      }
    } catch { /* 目录读取异常不阻断初始化 */ }
  }

  private saveJob(job: Pipeline3dJobSnapshot): void {
    const dir = resolve(join(this.rootDir, job.jobId));
    if (dir !== this.rootDir && !dir.startsWith(`${this.rootDir}${sep}`)) throw new Error('3D 候选目录越界');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'job.json');
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  async detectToolchain(): Promise<BlenderToolchainStatus> {
    return this.options.detectBlenderImpl ? this.options.detectBlenderImpl() : detectBlenderToolchain();
  }

  listJobs(characterId?: string): Pipeline3dJobSnapshot[] {
    return [...this.jobs.values()]
      .filter((j) => characterId === undefined || j.characterId === characterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getJob(jobId: string): Pipeline3dJobSnapshot | null {
    return this.jobs.get(jobId) ?? null;
  }

  private async defaultGenerateMesh(req: Pipeline3dRequest, apiKey: string | null): Promise<Buffer> {
    const firstImg = readFileSync(req.inputImagePaths[0]!).toString('base64');
    const res = await fetch(req.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey !== null ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.modelId,
        prompt: req.prompt,
        imageBase64: firstImg,
        targetPolycount: req.targetPolycount,
      }),
    });
    if (!res.ok) throw new Error(`3D 服务 HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as { meshBase64?: string };
      if (typeof json.meshBase64 === 'string' && json.meshBase64 !== '') {
        return Buffer.from(json.meshBase64, 'base64');
      }
      throw new Error('3D 服务 JSON 响应缺少 meshBase64');
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async runJob(rawInput: unknown): Promise<Pipeline3dJobSnapshot> {
    const req = Pipeline3dRequestSchema.parse(rawInput);
    const now = new Date().toISOString();
    const jobId = `job3d-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const jobDir = join(this.rootDir, jobId);
    mkdirSync(jobDir, { recursive: true });

    const job: Pipeline3dJobSnapshot = {
      jobId,
      characterId: req.characterId,
      providerId: req.providerId,
      stage: 'generating_mesh',
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, job);
    this.saveJob(job);

    const missingImg = req.inputImagePaths.find((p) => !existsSync(p));
    if (missingImg !== undefined) {
      job.stage = 'failed';
      job.error = `输入参考图不存在：${missingImg}`;
      job.updatedAt = new Date().toISOString();
      this.saveJob(job);
      return job;
    }

    const readKey = this.options.readVaultKeyImpl ?? readVaultKey;
    const apiKey = this.options.vaultPath !== undefined ? readKey(this.options.vaultPath, req.providerId) : null;

    let rawMesh: Buffer;
    try {
      rawMesh = await (this.options.generateMeshImpl ?? ((r, k) => this.defaultGenerateMesh(r, k)))(req, apiKey);
    } catch (err) {
      job.stage = 'failed';
      job.error = redactCodexError(err instanceof Error ? err.message : String(err));
      job.updatedAt = new Date().toISOString();
      this.saveJob(job);
      return job;
    }

    const rawPath = join(jobDir, 'raw-mesh.glb');
    writeFileSync(rawPath, rawMesh);
    job.rawMeshPath = rawPath;

    let finalPath = rawPath;
    if (req.runBlenderPostprocess) {
      job.stage = 'blender_postprocess';
      const toolchain = await this.detectToolchain();
      if (!toolchain.available || toolchain.binary === null) {
        job.blenderLog = toolchain.installHint;
      } else {
        const scriptPath = join(jobDir, 'postprocess.py');
        const outPath = join(jobDir, req.exportVrm ? 'processed.vrm' : 'processed.glb');
        writeFileSync(scriptPath, generateBlenderPostprocessScript({ targetPolycount: req.targetPolycount, exportVrm: req.exportVrm }), 'utf8');
        const execImpl = this.options.execFileImpl ?? (nodeExecFile as unknown as ExecFile3dLike);
        const execRes = await new Promise<{ ok: boolean; log: string }>((resolveRun) => {
          execImpl(
            toolchain.binary!,
            ['--background', '--python', scriptPath, '--', rawPath, outPath],
            { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const log = redactCodexError(`${stdout}\n${stderr}`.trim());
              resolveRun({ ok: err === null && existsSync(outPath), log: err === null ? log : `${err.message}: ${log}` });
            },
          );
        });
        job.blenderLog = execRes.log || 'blender postprocess completed';
        if (execRes.ok) {
          finalPath = outPath;
          job.processedVrmPath = outPath;
        }
      }
    }

    job.stage = 'qa_inspecting';
    const inspectBuf = readFileSync(finalPath);
    const inspection = inspectGlbOrVrm(inspectBuf, req.exportVrm);
    job.inspection = inspection;
    job.provenance = {
      sourceType: 'ai-generated',
      license: inspection.licenseNote ?? 'AI_3D_REVIEW_REQUIRED',
      allowCommercial: false,
      allowLivestream: false,
      allowRedistribution: false,
      modelProvider: req.providerId,
      modelId: req.modelId,
      inputRefPaths: [...req.inputImagePaths],
      generatedAt: new Date().toISOString(),
      sha256: inspection.sha256,
      reviewNotes: [],
    };
    job.stage = inspection.valid ? 'review_required' : 'validation_failed';
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
    return job;
  }

  reviewJob(params: { jobId: string; decision: 'approve' | 'reject'; note?: string }): { ok: boolean; error?: string; job?: Pipeline3dJobSnapshot } {
    const job = this.jobs.get(params.jobId);
    if (job === undefined) return { ok: false, error: `3D 任务不存在：${params.jobId}` };
    if (params.decision === 'approve' && job.stage === 'validation_failed') {
      return { ok: false, error: 'GLB/VRM 质检未通过（validation_failed），严禁批准导出' };
    }
    job.stage = params.decision === 'approve' ? 'approved' : 'failed';
    if (params.note !== undefined && params.note.trim() !== '') {
      job.provenance?.reviewNotes.push(`${params.decision}: ${params.note.trim()}`);
    }
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
    return { ok: true, job };
  }
}
