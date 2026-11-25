/**
 * V2-P2-04 门禁测试：3D 生成管线、Blender 工具链探测、headless Python 脚本与二进制 GLB/VRM 质检。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectBlenderToolchain,
  generateBlenderPostprocessScript,
  inspectGlbOrVrm,
  Pipeline3dManager,
} from './pipeline-3d';

const dirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 构造合法 glTF 2.0 二进制 GLB/VRM 测试容器（JSON chunk 按 4 字节空格对齐） */
function buildGlbBuffer(gltfJson: Record<string, unknown>): Buffer {
  const raw = Buffer.from(JSON.stringify(gltfJson), 'utf8');
  const pad = (4 - (raw.length % 4)) % 4;
  const jsonBuf = Buffer.concat([raw, Buffer.alloc(pad, 0x20)]);
  const totalLen = 12 + 8 + jsonBuf.length;
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); // glTF
  header.writeUInt32LE(2, 4);          // version 2
  header.writeUInt32LE(totalLen, 8);
  header.writeUInt32LE(jsonBuf.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16); // JSON
  return Buffer.concat([header, jsonBuf]);
}

const VALID_VRM_1 = buildGlbBuffer({
  asset: { version: '2.0' },
  meshes: [{ primitives: [] }],
  materials: [{ name: 'skin' }],
  skins: [{ joints: [0, 1] }],
  extensions: {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: { commercialUsage: 'personalNonProfit' },
      humanoid: {
        humanBones: {
          hips: { node: 0 },
          spine: { node: 1 },
          head: { node: 2 },
          leftUpperArm: { node: 3 },
          rightUpperArm: { node: 4 },
          leftUpperLeg: { node: 5 },
          rightUpperLeg: { node: 6 },
        },
      },
      expressions: {
        preset: { aa: {}, ih: {}, ou: {}, ee: {}, oh: {} },
        custom: { wink: {} },
      },
    },
  },
});

const VALID_VRM_0 = buildGlbBuffer({
  asset: { version: '2.0' },
  meshes: [{}],
  materials: [{}],
  skins: [{}],
  extensions: {
    VRM: {
      specVersion: '0.0',
      meta: { licenseName: 'CC0' },
      humanoid: {
        humanBones: [
          { bone: 'hips', node: 0 },
          { bone: 'spine', node: 1 },
          { bone: 'head', node: 2 },
          { bone: 'leftUpperArm', node: 3 },
          { bone: 'rightUpperArm', node: 4 },
          { bone: 'leftUpperLeg', node: 5 },
          { bone: 'rightUpperLeg', node: 6 },
        ],
      },
      blendShapeMaster: {
        blendShapeGroups: [{ presetName: 'a' }, { presetName: 'i' }, { presetName: 'u' }],
      },
    },
  },
});

const PLAIN_GLB = buildGlbBuffer({
  asset: { version: '2.0' },
  meshes: [{}],
  materials: [{}],
});

describe('inspectGlbOrVrm 二进制校验、Humanoid 骨骼与 Viseme 检查', () => {
  it('识别合法 VRM 1.0 与 VRM 0.x，对缺骨/裸 GLB/损坏文件精确拦截', () => {
    const r1 = inspectGlbOrVrm(VALID_VRM_1, true);
    expect(r1).toMatchObject({
      valid: true,
      format: 'vrm-1.0',
      hasHumanoidRig: true,
      hasLipSyncVisemes: true,
      missingCoreBones: [],
      licenseNote: 'personalNonProfit',
    });

    const r0 = inspectGlbOrVrm(VALID_VRM_0, true);
    expect(r0).toMatchObject({ valid: true, format: 'vrm-0.x', hasHumanoidRig: true, hasLipSyncVisemes: true, licenseNote: 'CC0' });

    const rPlainNeedVrm = inspectGlbOrVrm(PLAIN_GLB, true);
    expect(rPlainNeedVrm.valid).toBe(false);
    expect(rPlainNeedVrm.errors[0]).toContain('缺少 VRM 扩展');
    expect(inspectGlbOrVrm(PLAIN_GLB, false).valid).toBe(true);

    const incompleteVrm = buildGlbBuffer({
      meshes: [],
      extensions: { VRMC_vrm: { humanoid: { humanBones: { hips: { node: 0 } } } } },
    });
    const rBadVrm = inspectGlbOrVrm(incompleteVrm, true);
    expect(rBadVrm.valid).toBe(false);
    expect(rBadVrm.warnings[0]).toContain('口型 Viseme');

    expect(inspectGlbOrVrm(Buffer.from('short')).format).toBe('invalid');
    expect(inspectGlbOrVrm(Buffer.alloc(32, 1)).format).toBe('invalid');
    const badChunk = Buffer.from(PLAIN_GLB);
    badChunk.writeUInt32LE(999999, 12);
    expect(inspectGlbOrVrm(badChunk).format).toBe('invalid');
    const badJsonHeader = Buffer.concat([PLAIN_GLB.subarray(0, 20), Buffer.from('{bad        ')]);
    badJsonHeader.writeUInt32LE(12, 12);
    expect(inspectGlbOrVrm(badJsonHeader).errors[0]).toContain('解析失败');
  });
});

describe('detectBlenderToolchain 与 Blender 脚本生成', () => {
  it('未安装返回 installHint；已安装解析版本号与无头 Python 脚本内容', async () => {
    const none = await detectBlenderToolchain({ pathEnv: '', exists: () => false, platform: 'linux' });
    expect(none).toMatchObject({ available: false, binary: null, vrmAddonDetected: false });

    const mac = await detectBlenderToolchain({
      pathEnv: '',
      platform: 'darwin',
      exists: (p) => p === '/Applications/Blender.app/Contents/MacOS/Blender',
      execFileImpl: (_f, _a, _o, cb) => cb(null, 'Blender 4.2.1 (vrm addon)', ''),
    });
    expect(mac).toMatchObject({ available: true, version: '4.2.1', vrmAddonDetected: true });

    const probeFail = await detectBlenderToolchain({
      pathEnv: '/bin',
      platform: 'win32',
      exists: (p) => p.endsWith('blender.exe'),
      execFileImpl: () => { throw new Error('boom'); },
    });
    expect(probeFail).toMatchObject({ available: true, vrmAddonDetected: false });

    const py = generateBlenderPostprocessScript({ targetPolycount: 15000, exportVrm: true });
    expect(py).toContain('target_faces = 15000');
    expect(py).toContain('normals_make_consistent');
    expect(py).toContain('bpy.ops.export_scene.vrm');
  });
});

describe('Pipeline3dManager 端到端 3D 生成 → Blender 后处理 → VRM QA → 审查', () => {
  it('有 Blender 时成功生成 VRM 1.0 → review_required → approve；支持磁盘恢复', async () => {
    const dir = makeTempDir('whale-3d-');
    const refImg = join(dir, 'front.png');
    writeFileSync(refImg, 'fake-png');

    const mgr = new Pipeline3dManager({
      userDataDir: dir,
      vaultPath: join(dir, 'vault.json'),
      readVaultKeyImpl: () => 'hy-secret-123',
      detectBlenderImpl: async () => ({
        available: true,
        binary: '/mock/blender',
        version: '4.2.0',
        vrmAddonDetected: true,
        installHint: 'ok',
      }),
      generateMeshImpl: async (_req, key) => {
        expect(key).toBe('hy-secret-123');
        return PLAIN_GLB;
      },
      execFileImpl: (_bin, args, _opts, cb) => {
        const outPath = args[args.length - 1]!;
        writeFileSync(outPath, VALID_VRM_1);
        cb(null, 'postprocess ok', '');
      },
    });

    const job = await mgr.runJob({
      characterId: 'char_xiaojing',
      providerId: 'hunyuan3d',
      protocol: 'hunyuan3d-http',
      endpoint: 'https://hunyuan.example/v1/3d',
      inputImagePaths: [refImg],
      prompt: '小鲸 3D 立绘转模型',
    });

    expect(job.stage).toBe('review_required');
    expect(job.inspection?.valid).toBe(true);
    expect(job.inspection?.format).toBe('vrm-1.0');

    // 写入损坏快照验证重启容错加载
    mkdirSync(join(dir, 'media-3d-candidates', 'corrupt'), { recursive: true });
    writeFileSync(join(dir, 'media-3d-candidates', 'corrupt', 'job.json'), '{bad', 'utf8');
    const reloaded = new Pipeline3dManager({ userDataDir: dir });
    expect(reloaded.listJobs('char_xiaojing')).toHaveLength(1);
    expect(reloaded.getJob(job.jobId)?.stage).toBe('review_required');

    const rev = reloaded.reviewJob({ jobId: job.jobId, decision: 'approve', note: '骨骼口型通过' });
    expect(rev).toMatchObject({ ok: true });
    expect(rev.job?.stage).toBe('approved');
  });

  it('无 Blender 时裸 GLB 被质检拒收（validation_failed）且禁止 approve；覆盖错误/拒绝分支', async () => {
    const dir = makeTempDir('whale-3d-fail-');
    const refImg = join(dir, 'front.png');
    writeFileSync(refImg, 'fake-png');

    const mgr = new Pipeline3dManager({
      userDataDir: dir,
      detectBlenderImpl: async () => ({
        available: false,
        binary: null,
        vrmAddonDetected: false,
        installHint: '请安装 Blender',
      }),
      generateMeshImpl: async () => PLAIN_GLB,
    });

    const failedQa = await mgr.runJob({
      characterId: 'char_xiaojing',
      providerId: 'hunyuan3d',
      protocol: 'hunyuan3d-http',
      endpoint: 'https://hunyuan.example/v1/3d',
      inputImagePaths: [refImg],
      exportVrm: true,
    });
    expect(failedQa.stage).toBe('validation_failed');
    expect(failedQa.blenderLog).toContain('请安装 Blender');
    expect(mgr.reviewJob({ jobId: failedQa.jobId, decision: 'approve' }).ok).toBe(false);
    expect(mgr.reviewJob({ jobId: failedQa.jobId, decision: 'reject', note: '缺骨骼' }).job?.stage).toBe('failed');
    expect(mgr.reviewJob({ jobId: 'missing', decision: 'approve' }).ok).toBe(false);

    const missingInput = await mgr.runJob({
      characterId: 'char_xiaojing',
      providerId: 'hunyuan3d',
      protocol: 'hunyuan3d-http',
      endpoint: 'https://hunyuan.example/v1/3d',
      inputImagePaths: ['/nonexistent/img.png'],
    });
    expect(missingInput.stage).toBe('failed');
    expect(missingInput.error).toContain('输入参考图不存在');

    const mgrThrow = new Pipeline3dManager({
      userDataDir: dir,
      generateMeshImpl: async () => { throw new Error('Bearer secret-token fail'); },
    });
    const errJob = await mgrThrow.runJob({
      characterId: 'char_xiaojing',
      providerId: 'hunyuan3d',
      protocol: 'hunyuan3d-http',
      endpoint: 'https://hunyuan.example/v1/3d',
      inputImagePaths: [refImg],
    });
    expect(errJob.stage).toBe('failed');
    expect(errJob.error).not.toContain('secret-token');
  });
});
