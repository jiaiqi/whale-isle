/**
 * V2-P2-03 门禁测试：MediaGenerationGateway、Character Bible 一致性、候选区审查隔离与持久化恢复。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CharacterBible } from '@workbench/shared-protocol';
import {
  compileBiblePrompt,
  inspectImageAsset,
  MediaGenerationGateway,
  selectApprovedReferences,
} from './media-gateway';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const dirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const SAMPLE_BIBLE: CharacterBible = {
  characterId: 'char_xiaojing',
  displayName: '小鲸',
  version: 2,
  referenceImages: [
    { role: 'side', path: '/nonexistent/side.png', approved: true },
    { role: 'front', path: '/tmp/will-be-overridden.png', approved: true },
    { role: 'back', path: '/tmp/unapproved.png', approved: false },
  ],
  traits: {
    hairstyle: '海蓝双马尾',
    eyes: '深海蓝',
    palette: ['#38bdf8', '#f8fafc'],
    outfit: '鲸鱼围裙女仆装',
    proportions: '2.5头身 Q 版',
    signatureAccessories: ['迷你鲸尾发饰'],
  },
  expressionRules: ['开心时眼睛呈月牙形'],
  styleConstraints: ['清晰干净线稿', '柔和日系赛璐璐'],
  forbiddenChanges: ['不可去除鲸尾发饰', '不可变成紫发'],
  updatedAt: '2026-11-26T00:00:00.000Z',
};

describe('Character Bible 编译、参考图筛选与图像 QA 纯函数', () => {
  it('compileBiblePrompt 保留外观特征与严禁改动规则；selectApprovedReferences 优先用有效/已批准图', () => {
    const prompt = compileBiblePrompt(SAMPLE_BIBLE, 'idle', '站在码头微笑');
    expect(prompt).toContain('小鲸');
    expect(prompt).toContain('海蓝双马尾');
    expect(prompt).toContain('不可去除鲸尾发饰');
    expect(prompt).toContain('站在码头微笑');

    const dir = makeTempDir('whale-refs-');
    const frontFile = join(dir, 'front.png');
    const backFile = join(dir, 'back.png');
    writeFileSync(frontFile, VALID_PNG);
    writeFileSync(backFile, VALID_PNG);

    const bibleWithReal: CharacterBible = {
      ...SAMPLE_BIBLE,
      referenceImages: [
        { role: 'back', path: backFile, approved: false },
        { role: 'front', path: frontFile, approved: true },
      ],
    };
    expect(selectApprovedReferences(bibleWithReal)).toEqual([frontFile]);
    expect(selectApprovedReferences(bibleWithReal, [backFile])).toEqual([backFile]);
  });

  it('inspectImageAsset 识别合法 PNG 宽高、空文件与损坏文件', () => {
    const good = inspectImageAsset(VALID_PNG);
    expect(good).toMatchObject({ valid: true, mimeType: 'image/png', width: 1, height: 1 });
    expect(good.sha256.length).toBe(64);

    expect(inspectImageAsset(Buffer.alloc(0)).valid).toBe(false);
    expect(inspectImageAsset(Buffer.from('not-an-image')).valid).toBe(false);
  });
});

describe('MediaGenerationGateway 诚实探测、候选区审查隔离与持久化', () => {
  it('probeProviders 诚实区分 Codex CLI（含在线计费标注）、不支持生图的 Coding Agent 与在线 API', () => {
    const dir = makeTempDir('whale-probe-');
    const gw = new MediaGenerationGateway({
      userDataDir: dir,
      vaultPath: join(dir, 'vault.json'),
      detectCodexImpl: () => ({
        available: true,
        backend: 'codex-imagegen',
        binary: '/usr/local/bin/codex-imagegen',
        loggedIn: true,
        codexHome: '/tmp/.codex',
        installHint: 'npm i -g codex-imagegen-cli',
        loginHint: 'codex login',
      }),
      hasVaultKeyImpl: (_v, id) => id === 'openai-img',
    });

    const caps = gw.probeProviders([
      { id: 'codex-cli', name: 'Codex', baseUrl: 'https://codex.local/', protocol: 'codex-cli', candidateModels: [] },
      { id: 'openai-img', name: 'OpenAI Images', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', candidateModels: ['gpt-image-1'] },
      { id: 'gemini-img', name: 'Gemini Images', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini', candidateModels: [] },
    ]);

    const codexCap = caps.find((c) => c.providerId === 'codex-cli')!;
    expect(codexCap).toMatchObject({
      kind: 'local-coding-agent',
      supportsImageGen: true,
      supportsImageEdit: true,
      available: true,
      requiresOnlineBilling: true,
    });
    expect(codexCap.capabilityNote).toContain('在线订阅');

    expect(caps.find((c) => c.providerId === 'gemini-cli')?.supportsImageGen).toBe(false);
    expect(caps.find((c) => c.providerId === 'openai-img')?.available).toBe(true);
    expect(caps.find((c) => c.providerId === 'gemini-img')).toMatchObject({ available: false, supportsMultiRef: true });
  });

  it('submitImageJob 进候选区（review_required）+ 重启恢复 + 未审核禁止发布 + approve 后可发布并标 published', async () => {
    const dir = makeTempDir('whale-gw-');
    const refFile = join(dir, 'front.png');
    writeFileSync(refFile, VALID_PNG);
    const bible: CharacterBible = {
      ...SAMPLE_BIBLE,
      referenceImages: [{ role: 'front', path: refFile, approved: true }],
    };

    const gw = new MediaGenerationGateway({
      userDataDir: dir,
      vaultPath: join(dir, 'vault.json'),
      readVaultKeyImpl: () => 'sk-test-123',
      generateImageImpl: async ({ prompt }) => {
        expect(prompt).toContain('不可去除鲸尾发饰');
        if (prompt.includes('「broken」')) return { buffer: Buffer.from('bad-bytes'), mimeType: 'image/png' };
        return { buffer: VALID_PNG, mimeType: 'image/png' };
      },
    });

    const job = await gw.submitImageJob({
      characterId: 'char_xiaojing',
      providerId: 'openai-img',
      protocol: 'openai',
      modelId: 'gpt-image-1',
      poses: ['idle', 'broken'],
      prompt: '海岸清晨光线',
      bible,
    });

    expect(job.status).toBe('review_required');
    expect(job.completed).toBe(1);
    expect(job.failed).toBe(1);

    const validCand = job.candidates.find((c) => c.poseOrSlot === 'idle')!;
    const badCand = job.candidates.find((c) => c.poseOrSlot === 'broken')!;
    expect(validCand.status).toBe('review_required');
    expect(validCand.provenance).toMatchObject({
      sourceType: 'ai-generated',
      allowCommercial: false,
      allowLivestream: false,
      inputRefPaths: [refFile],
    });
    expect(readFileSync(validCand.filePath)).toEqual(VALID_PNG);
    expect(badCand.status).toBe('validation_failed');

    // 未审批前禁止发布；QA 失败候选禁止 approve
    await expect(gw.promoteApprovedCandidates(job.jobId, async () => {})).resolves.toMatchObject({ ok: false });
    expect(gw.reviewCandidate({ jobId: job.jobId, candidateId: badCand.candidateId, decision: 'approve' }).ok).toBe(false);

    // 模拟宿主重启重新从磁盘加载候选区快照，写入一条损坏目录测试容错
    mkdirSync(join(dir, 'media-candidates', 'corrupt-job'), { recursive: true });
    writeFileSync(join(dir, 'media-candidates', 'corrupt-job', 'job.json'), '{bad json', 'utf8');
    const reloaded = new MediaGenerationGateway({ userDataDir: dir });
    expect(reloaded.getJob(job.jobId)?.candidates).toHaveLength(2);

    const rev = reloaded.reviewCandidate({
      jobId: job.jobId,
      candidateId: validCand.candidateId,
      decision: 'approve',
      note: '头部特征一致',
      license: 'SELF_OWNED_AI_REVIEWED',
      allowLivestream: true,
    });
    expect(rev.ok).toBe(true);
    expect(rev.job?.status).toBe('approved');

    let publishedIds: string[] = [];
    const pubRes = await reloaded.promoteApprovedCandidates(job.jobId, async (items) => {
      publishedIds = items.map((i) => i.candidateId);
    });
    expect(pubRes.ok).toBe(true);
    expect(publishedIds).toEqual([validCand.candidateId]);
    expect(reloaded.getJob(job.jobId)?.candidates.find((c) => c.candidateId === validCand.candidateId)?.status).toBe('published');
  });

  it('覆盖缺 Key、Codex 未安装/未登录、生图抛错脱敏、reject 与 cancelJob 分支', async () => {
    const dir = makeTempDir('whale-gw-err-');
    const gwNoKey = new MediaGenerationGateway({
      userDataDir: dir,
      vaultPath: join(dir, 'vault.json'),
      readVaultKeyImpl: () => null,
      detectCodexImpl: () => ({
        available: false,
        backend: null,
        binary: null,
        loggedIn: false,
        codexHome: '/tmp/.codex',
        installHint: 'npm i -g codex-imagegen-cli',
        loginHint: 'codex login',
      }),
    });
    const noKeyJob = await gwNoKey.submitImageJob({
      characterId: 'char_xiaojing',
      providerId: 'openai-img',
      protocol: 'openai',
      modelId: 'gpt-image-1',
      poses: ['idle'],
    });
    expect(noKeyJob.status).toBe('failed');
    expect(noKeyJob.error).toContain('未配置可用 Vault Key');

    const noCodexJob = await gwNoKey.submitImageJob({
      characterId: 'char_xiaojing',
      providerId: 'codex-cli',
      protocol: 'codex-cli',
      modelId: 'codex-imagegen',
      poses: ['idle'],
    });
    expect(noCodexJob.status).toBe('failed');
    expect(noCodexJob.error).toContain('未检测到本机 Codex CLI');

    const gwThrow = new MediaGenerationGateway({
      userDataDir: dir,
      vaultPath: join(dir, 'vault.json'),
      readVaultKeyImpl: () => 'sk-123',
      generateImageImpl: async () => {
        throw new Error('HTTP 500 with sk-secret-abcdef12345');
      },
    });
    const errJob = await gwThrow.submitImageJob({
      characterId: 'char_xiaojing',
      providerId: 'gemini-img',
      protocol: 'gemini',
      modelId: 'gemini-2.5-flash-image-preview',
      poses: ['idle'],
      prompt: '沙滩',
    });
    expect(errJob.status).toBe('failed');
    expect(errJob.error).not.toContain('sk-secret-abcdef12345');

    // reject 与 cancel 分支
    const gwCancel = new MediaGenerationGateway({
      userDataDir: dir,
      vaultPath: join(dir, 'vault.json'),
      readVaultKeyImpl: () => 'sk-123',
      concurrency: 1,
      generateImageImpl: async () => ({ buffer: VALID_PNG, mimeType: 'image/png' }),
    });
    const goodJob = await gwCancel.submitImageJob({
      characterId: 'char_other',
      providerId: 'openai',
      protocol: 'openai',
      modelId: 'gpt-image-1',
      poses: ['idle'],
    });
    const rej = gwCancel.reviewCandidate({
      jobId: goodJob.jobId,
      candidateId: goodJob.candidates[0]!.candidateId,
      decision: 'reject',
      note: '画风偏移',
    });
    expect(rej.ok).toBe(true);
    expect(gwCancel.reviewCandidate({ jobId: 'missing', candidateId: 'x', decision: 'approve' }).ok).toBe(false);
    expect(gwCancel.reviewCandidate({ jobId: goodJob.jobId, candidateId: 'missing', decision: 'approve' }).ok).toBe(false);
    expect(gwCancel.cancelJob('missing').ok).toBe(false);
    expect(gwCancel.cancelJob(goodJob.jobId)).toEqual({ ok: true });
    expect(gwCancel.getJob(goodJob.jobId)?.status).toBe('cancelled');
    expect(gwCancel.listJobs('char_other')).toHaveLength(1);
    expect((await gwCancel.promoteApprovedCandidates('missing', async () => {})).ok).toBe(false);
  });
});
