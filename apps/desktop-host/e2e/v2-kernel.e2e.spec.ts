import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface DirectorV2Window {
  directorBridge: {
    v2KernelHealth(): Promise<{
      lifecycle: string;
      activeCharacter: { characterId: string; displayName: string; halted: boolean; controlMode: string };
      plugins: { total: number; enabled: number; errors: number };
      vaultBackend: string;
    }>;
    v2CharacterState(): Promise<{ identity: { characterId: string; displayName: string }; expression: string; halted: boolean }>;
    v2CharacterSnapshot(): Promise<{
      schemaVersion: number;
      identity: { characterId: string; displayName: string };
      goals: Array<{ goalId: string; title: string }>;
      commitments: Array<{ commitmentId: string; title: string }>;
      activityState: { mode: string; expression: string; activeModelRef: string | null; halted: boolean };
    }>;
    v2AddGoal(input: { title: string; priority?: number; relatedActivity?: string }): Promise<{ goalId: string; title: string }>;
    v2AddCommitment(input: { partnerId: string; title: string }): Promise<{ commitmentId: string; title: string }>;
    v2BindModel(modelRef: string | null): Promise<{ activeModelRef: string | null }>;
    v2SelectActivity(input: { mode: string; reason: string; source?: string }): Promise<{
      accepted: boolean;
      reason?: string;
      state: { mode: string; expression: string };
    }>;
    v2EmergencyHalt(reason?: string): Promise<{ halted: boolean; controlMode: string; expression: string }>;
    v2Resume(mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover'): Promise<{ halted: boolean; controlMode: string }>;
    v2StorageCheck(): Promise<{ ok: boolean; engine: string; schemaVersion: string | null; recovered: boolean; integrity: string }>;
    v2VoiceProviders(): Promise<Array<{ kind: string; quality: string; available: boolean; degraded: boolean }>>;
    v2VoiceIdentity(): Promise<{ voiceProfileId: string; characterId: string }>;
    v2VoiceMixerState(): Promise<{ tracks: Array<{ trackId: string; kind: string; outputDeviceId: string }>; outputRoutes: Record<string, string> }>;
    v2VoiceTrackStart(input: { trackId: string; kind: string; label: string }): Promise<{ trackId: string; playing: boolean }>;
    v2VoiceOutputRoute(input: { kind: string; deviceId: string }): Promise<{ outputRoutes: Record<string, string> }>;
    v2VoiceSynthesizePreview(input: { text: string }): Promise<{ providerKind: string; lipFrames: Array<{ viseme: string }> }>;
    v2ProviderQuota(input: { providerId: string }): Promise<{
      providerId: string;
      queryable: boolean;
      source: string;
      authState: string;
      balance: unknown;
      windows: unknown[];
      summary: string;
    }>;
    v2ProviderQuotaMatrix(input?: { providerIds?: string[]; includeCli?: boolean }): Promise<{
      generatedAt: number;
      reports: Array<{ providerId: string; source: string; queryable: boolean }>;
    }>;
    v2MemoryAdd(input: { category: string; text: string; nodeType?: string; entityKey?: string; entityDisplayName?: string }): Promise<{ ok: boolean; node?: { id: string } }>;
    v2MemoryQuery(input: { query: string }): Promise<{ ok: boolean; hits: Array<{ id: string; text: string; certainty: string }> }>;
    v2MemoryConsolidate(input?: { entityKey?: string; minInteractions?: number }): Promise<{ ok: boolean; impressions: Array<{ nodeId: string; interactionCount: number }> }>;
    v2MemoryHardDelete(input: { nodeId: string; reason?: string }): Promise<{ deleted: boolean; blockedReason?: string }>;
    v2MemoryDeletionAudits(): Promise<Array<{ targetNodeId: string; targetCategory: string; deletedNodeIds: string[] }>>;
    v2MediaProviders(descriptors?: unknown[]): Promise<Array<{ providerId: string; kind: string; supportsImageGen: boolean; requiresOnlineBilling: boolean }>>;
    v2MediaJobs(characterId?: string): Promise<Array<{ jobId: string; status: string }>>;
    v23dToolchain(): Promise<{ available: boolean; binary: string | null; installHint: string }>;
    v23dJobs(characterId?: string): Promise<Array<{ jobId: string; stage: string }>>;
    v2BibleUpsert(input: { characterId: string; displayName: string; traits?: { outfit?: string } }): Promise<{ ok: boolean; bible?: { characterId: string; version: number } }>;
    v2BibleList(): Promise<Array<{ characterId: string; displayName: string }>>;
    v22dList(characterId?: string): Promise<Array<{ packageId: string; characterId: string; kind: string }>>;
    v22dCheckDistribution(input: { packageId: string; channel: string }): Promise<{ ok: boolean; check?: { allowed: boolean; licenseScope: string; reason: string } }>;
    v2CrossPetImport(input?: { characterIds?: string[]; overwrite?: boolean }): Promise<{
      ok: boolean;
      result?: { ok: boolean; importedCount: number; skippedCount: number; entries: Array<{ customId: string; licenseScope: string }> };
    }>;
    characterList(): Promise<Array<{ id: string }>>;
    characterSelect(id: string): Promise<{ ok: boolean }>;
  };
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as Partial<DirectorV2Window>).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

describe('[E2E-HOST] V2 WhaleKernel Electron 宿主集成', () => {
  it('启动后 WhaleKernel 进入 running，支持角色状态读取、紧急停止与恢复', { timeout: 60_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    try {
      const director = await waitForDirector(app);
      // 清理上次 E2E 持久化在 e2e-profile 中的急停状态
      await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2Resume('autonomous'),
      );
      const health = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2KernelHealth(),
      );
      expect(health.lifecycle).toBe('running');
      expect(health.activeCharacter.characterId).toBe('char_xiaojing');
      expect(health.activeCharacter.displayName).toBe('小鲸');
      expect(health.plugins.total).toBeGreaterThanOrEqual(1);
      expect(health.plugins.enabled).toBeGreaterThanOrEqual(1);
      expect(health.plugins.errors).toBe(0);

      const state = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2CharacterState(),
      );
      expect(state.identity.characterId).toBe('char_xiaojing');
      expect(state.halted).toBe(false);

      // V2-P1-01：验证 12 域快照、目标/约定、切换模型/外观后身份与状态不丢失、以及 LifeRuntime 活动同步
      await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        await bridge.v2AddGoal({ title: 'E2E 验证目标', priority: 90, relatedActivity: 'gaming' });
        await bridge.v2AddCommitment({ partnerId: 'owner', title: 'E2E 约定' });
        await bridge.v2BindModel('deepseek-chat');
        const list = await bridge.characterList();
        const alt = list.find((c) => c.id !== 'blue-whale-maid');
        if (alt) await bridge.characterSelect(alt.id);
      });

      const snapshotAfterSwitch = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2CharacterSnapshot(),
      );
      expect(snapshotAfterSwitch.schemaVersion).toBe(1);
      expect(snapshotAfterSwitch.identity.characterId).toBe('char_xiaojing');
      expect(snapshotAfterSwitch.goals.some((g) => g.title === 'E2E 验证目标')).toBe(true);
      expect(snapshotAfterSwitch.commitments.some((c) => c.title === 'E2E 约定')).toBe(true);
      expect(snapshotAfterSwitch.activityState.activeModelRef).toBe('deepseek-chat');

      const gamingRes = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2SelectActivity({
          mode: 'gaming',
          reason: 'E2E 活动联动',
          source: 'user_command',
        }),
      );
      expect(gamingRes.accepted).toBe(true);
      expect(gamingRes.state.mode).toBe('gaming');
      const stateAfterGaming = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2CharacterState(),
      );
      expect(stateAfterGaming.expression).toBe('gaming');

      const halted = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2EmergencyHalt('E2E 急停测试'),
      );
      expect(halted.halted).toBe(true);
      expect(halted.controlMode).toBe('manual_takeover');
      expect(halted.expression).toBe('idle');

      const blockedDuringHalt = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2SelectActivity({
          mode: 'gaming',
          reason: '急停中尝试切入',
          source: 'life_runtime',
        }),
      );
      expect(blockedDuringHalt.accepted).toBe(false);
      expect(blockedDuringHalt.reason).toBe('CHARACTER_HALTED');

      const resumed = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2Resume('autonomous'),
      );
      expect(resumed.halted).toBe(false);
      expect(resumed.controlMode).toBe('autonomous');

      const storage = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2StorageCheck(),
      );
      expect(storage.ok).toBe(true);
      expect(storage.engine).toBe('node:sqlite');
      expect(storage.schemaVersion).toBe('2');
      expect(storage.integrity).toBe('ok');

      // V2-P1-02：验证真实 VoiceProvider 探测、独立 VoiceIdentity、多轨 AudioMixer 与口型预览
      const voiceProviders = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceProviders(),
      );
      expect(voiceProviders.length).toBeGreaterThanOrEqual(4);
      expect(voiceProviders.some((p) => p.kind === 'macos-say' && p.quality === 'system_fallback')).toBe(true);

      const voiceIdentity = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceIdentity(),
      );
      expect(voiceIdentity.characterId).toBe('char_xiaojing');
      expect(voiceIdentity.voiceProfileId).toBe('qiaopi_mengmei');

      const mixerAfterTrack = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        await bridge.v2VoiceTrackStart({ trackId: 'bgm-e2e', kind: 'bgm', label: 'E2E BGM' });
        await bridge.v2VoiceOutputRoute({ kind: 'bgm', deviceId: 'obs-virtual' });
        return bridge.v2VoiceMixerState();
      });
      expect(mixerAfterTrack.tracks.some((t) => t.trackId === 'bgm-e2e')).toBe(true);
      expect(mixerAfterTrack.outputRoutes.bgm).toBe('obs-virtual');

      const preview = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceSynthesizePreview({
          text: '主人，测试语音口型包络！',
        }),
      );
      expect(preview.lipFrames.length).toBeGreaterThan(0);

      await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2EmergencyHalt('V2-P1-02 停播验证'),
      );
      const mixerAfterHalt = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2VoiceMixerState(),
      );
      expect(mixerAfterHalt.tracks).toHaveLength(0);

      // V2-P1-03：验证四级诚实额度矩阵（不编造未知余额、缺 Key 明确标 missing_key）
      const openaiQuota = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2ProviderQuota({ providerId: 'openai' }),
      );
      expect(openaiQuota.queryable).toBe(false);
      expect(openaiQuota.source).toBe('unknown');
      expect(openaiQuota.balance).toBeNull();
      expect(openaiQuota.windows).toEqual([]);
      expect(openaiQuota.summary).toContain('未知');

      const deepseekQuota = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2ProviderQuota({ providerId: 'deepseek-official' }),
      );
      expect(deepseekQuota.queryable).toBe(true);
      expect(deepseekQuota.authState).toBe('missing_key');
      expect(deepseekQuota.balance).toBeNull();

      const matrix = await director.evaluate(() =>
        (window as unknown as DirectorV2Window).directorBridge.v2ProviderQuotaMatrix({
          providerIds: ['deepseek-official', 'kimi-moonshot', 'minimax', 'opencode-go', 'openai'],
          includeCli: true,
        }),
      );
      expect(matrix.generatedAt).toBeGreaterThan(0);
      expect(matrix.reports.length).toBe(9);
      expect(matrix.reports.some((r) => r.providerId === 'codex-cli' && r.source === 'cli_status')).toBe(true);

      // V2-P1-04：验证五类记忆、Self 保护、模糊印象归纳与级联真删除
      const memFlow = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        const selfMem = await bridge.v2MemoryAdd({
          nodeType: 'concept',
          category: 'self',
          text: 'E2E_SELF_IDENTITY_CORE',
        });
        const selfDel = await bridge.v2MemoryHardDelete({ nodeId: selfMem.node!.id, reason: '尝试删 Self' });

        await bridge.v2MemoryAdd({
          nodeType: 'event',
          category: 'relational',
          text: 'E2E常客小明第一次来串门',
          entityKey: 'viewer:e2e-u1',
          entityDisplayName: '小明',
        });
        await bridge.v2MemoryAdd({
          nodeType: 'event',
          category: 'relational',
          text: 'E2E常客小明第二次送鱼干',
          entityKey: 'viewer:e2e-u1',
          entityDisplayName: '小明',
        });
        const consolidated = await bridge.v2MemoryConsolidate({ entityKey: 'viewer:e2e-u1', minInteractions: 2 });

        const ephemeral = await bridge.v2MemoryAdd({
          nodeType: 'event',
          category: 'episodic',
          text: 'E2E_SECRET_DELETE_TOKEN_9876',
        });
        const delRes = await bridge.v2MemoryHardDelete({ nodeId: ephemeral.node!.id, reason: 'E2E 真删除' });
        const afterQuery = await bridge.v2MemoryQuery({ query: 'E2E_SECRET_DELETE_TOKEN_9876' });
        const audits = await bridge.v2MemoryDeletionAudits();
        return { selfDel, consolidated, delRes, afterQuery, audits, deletedId: ephemeral.node!.id };
      });

      expect(memFlow.selfDel.deleted).toBe(false);
      expect(memFlow.selfDel.blockedReason).toBe('PROTECTED_SELF_MEMORY');
      expect(memFlow.consolidated.impressions.length).toBeGreaterThanOrEqual(1);
      expect(memFlow.delRes.deleted).toBe(true);
      expect(memFlow.afterQuery.hits).toHaveLength(0);
      expect(memFlow.audits.some((a) => a.targetNodeId === memFlow.deletedId)).toBe(true);

      // V2-P2-03：验证 MediaGenerationGateway 供应商能力探测与候选区查询
      const mediaCaps = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        const providers = await bridge.v2MediaProviders([
          { id: 'openai-e2e', name: 'OpenAI Images', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', candidateModels: ['gpt-image-1'] },
        ]);
        const jobs = await bridge.v2MediaJobs();
        return { providers, jobs };
      });
      expect(mediaCaps.providers.some((p) => p.providerId === 'codex-cli' && p.requiresOnlineBilling === true)).toBe(true);
      expect(mediaCaps.providers.some((p) => p.providerId === 'gemini-cli' && p.supportsImageGen === false)).toBe(true);
      expect(Array.isArray(mediaCaps.jobs)).toBe(true);

      // V2-P2-04：验证 Blender 工具链探测与 3D 候选任务列表
      const res3d = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        return { toolchain: await bridge.v23dToolchain(), jobs3d: await bridge.v23dJobs() };
      });
      expect(typeof res3d.toolchain.available).toBe('boolean');
      expect(typeof res3d.toolchain.installHint).toBe('string');
      expect(Array.isArray(res3d.jobs3d)).toBe(true);

      // V2-P2-05：验证 Character Bible、CrossPet 合法导入与商业/直播许可隔离门禁
      const p205 = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        const bibleUpsert = await bridge.v2BibleUpsert({
          characterId: 'char_xiaojing',
          displayName: '小鲸',
          traits: { outfit: '深海女仆装' },
        });
        const bibles = await bridge.v2BibleList();
        const imported = await bridge.v2CrossPetImport({
          characterIds: ['deepseek', 'deepseek-pajamas', 'egg-deepseek'],
          overwrite: true,
        });
        const pkgs = await bridge.v22dList('custom-cp-deepseek');
        const localCheck = await bridge.v22dCheckDistribution({
          packageId: 'crosspet-import-cp-deepseek',
          channel: 'local_personal',
        });
        const liveCheck = await bridge.v22dCheckDistribution({
          packageId: 'crosspet-import-cp-deepseek',
          channel: 'livestream_public',
        });
        const commercialCheck = await bridge.v22dCheckDistribution({
          packageId: 'crosspet-import-cp-deepseek',
          channel: 'commercial_distribution',
        });
        return { bibleUpsert, bibles, imported, pkgs, localCheck, liveCheck, commercialCheck };
      });
      expect(p205.bibleUpsert.ok).toBe(true);
      expect(p205.bibles.some((b) => b.characterId === 'char_xiaojing')).toBe(true);
      expect(p205.imported.ok).toBe(true);
      expect(p205.imported.result?.ok).toBe(true);
      expect(p205.imported.result?.importedCount).toBe(3);
      expect(p205.imported.result?.entries.every((e) => e.licenseScope === 'DEV_ONLY_NON_COMMERCIAL')).toBe(true);
      expect(p205.pkgs).toHaveLength(1);
      expect(p205.localCheck.check?.allowed).toBe(true);
      expect(p205.liveCheck.check?.allowed).toBe(false);
      expect(p205.commercialCheck.check?.allowed).toBe(false);
    } finally {
      await app.close();
    }
  });
});
