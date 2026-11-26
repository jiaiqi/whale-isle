import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
    v2PixelJobs(characterId?: string): Promise<Array<{ jobId: string; status: string }>>;
    v2PixelVerifyStardew(modsDir?: string): Promise<{
      ok: boolean;
      modDir: string;
      realDeviceInGameVisualVerified: boolean;
      issues: string[];
    }>;
    v2StageSceneCreate(input?: { theme?: string; width?: number; height?: number }): Promise<{
      ok: boolean;
      outputPath?: string;
      inspection?: { valid: boolean; width?: number; height?: number; aspectRatio?: string };
    }>;
    v2SoundSfxCreate(input?: { preset?: string; durationMs?: number }): Promise<{
      ok: boolean;
      outputPath?: string;
      inspection?: { valid: boolean; format: string; durationMs?: number; clippingDetected: boolean };
    }>;
    v2AssetRegister(input: {
      assetId: string;
      characterId: string;
      displayName: string;
      category: string;
      sourceFilePath: string;
      provenance: {
        sourceType: string;
        license: string;
        allowCommercial: boolean;
        allowLivestream: boolean;
        allowRedistribution: boolean;
        inputRefPaths: string[];
        reviewNotes: string[];
      };
    }): Promise<{ ok: boolean; version?: { versionId: string; status: string } }>;
    v2AssetTransition(input: { assetId: string; versionId: string; nextStatus: string; note?: string }): Promise<{
      ok: boolean;
      entry?: { activeVersionId: string | null };
    }>;
    v2AssetVerify(input: { assetId: string; versionId?: string }): Promise<{
      ok: boolean;
      check?: { ok: boolean };
    }>;
    v2AssetRollback(input: { assetId: string; targetVersionId?: string }): Promise<{
      ok: boolean;
      entry?: { activeVersionId: string | null; versions: Array<{ versionId: string; status: string }> };
    }>;
    v2AssetExportClean(input?: { channel?: string; assetIds?: string[] }): Promise<{
      ok: boolean;
      result?: { exportedCount: number; blockedCount: number; exportedAssets: Array<{ assetId: string }>; blockedAssets: Array<{ assetId: string }> };
    }>;
    v2CoopRoomCreate(input: { roomId?: string; gameId?: string; sharedGoal: string }): Promise<{
      ok: boolean;
      snapshot?: { roomId: string; status: string };
    }>;
    v2CoopParticipantJoin(input: {
      participantId: string;
      kind: 'human' | 'ai';
      characterId: string;
      displayName: string;
    }): Promise<{ ok: boolean; participant?: { controlOwner: string }; snapshot?: { status: string } }>;
    v2CoopResourceReserve(input: { resourceKey: string; ownerId: string; intent: string; reason?: string }): Promise<{ ok: boolean }>;
    v2CoopResourceCheck(input: { participantId: string; resourceKey: string; action: 'use' | 'sell' | 'harvest' }): Promise<{ allowed: boolean; reason: string }>;
    v2CoopTaskAction(input: Record<string, unknown>): Promise<{ ok: boolean; task?: { taskId: string; status: string } }>;
    v2CoopRecovery(input: { action: string; participantId?: string; reason?: string }): Promise<{
      ok: boolean;
      snapshot?: { status: string; participants: Array<{ participantId: string; connectionState: string; reconnectAttempts: number }> };
    }>;
    v2CoopModCompat(): Promise<{ ok: boolean; report?: { compatible: boolean; canStartCoop: boolean; bwfReady: boolean; hostModCount: number } }>;
    v2PerfSnapshot(): Promise<{
      performance: { characterId: string; mode: string; halted: boolean };
      stage: { characterId: string; activeBackend: string; registeredBackends: string[]; devWatermarkActive: boolean };
      singBackends: Array<{ mode: string; backend: string; available: boolean }>;
    }>;
    v2PerfSilenceCheck(input?: Record<string, unknown>): Promise<{ shouldSpeak: boolean; reason: string }>;
    v2PerfSingStart(input: Record<string, unknown>): Promise<{
      ok: boolean;
      error?: string;
      result?: { ok: boolean; backendMode: string; rightsCheck: { allowed: boolean }; lipFrames: Array<{ viseme: string }> };
      snapshot?: { mode: string; mixer: { tracks: Array<{ kind: string }> } };
    }>;
    v2PerfTick(positionMs: number): Promise<{
      ok: boolean;
      performance: {
        lyrics: { activeIndex: number; activeLine: { primaryText: string; secondaryText?: string } | null };
        activeDanceCue: { cueId: string } | null;
      };
      stage: {
        lyrics: { activeIndex: number } | null;
      };
    }>;
    v2StageSwitchBackend(input: { backend: string }): Promise<{
      ok: boolean;
      stage?: {
        characterId: string;
        activeBackend: string;
        lyrics: { activeIndex: number } | null;
        adapterState: Record<string, unknown>;
      };
    }>;
    v2LiveSessionStart(input?: { platform?: string; roomId?: string }): Promise<{
      ok: boolean;
      snapshot?: { active: boolean; adapter: { connectionState: string; realPlatformVerified: boolean } };
    }>;
    v2LiveSongRequest(input: { title: string; autoPerform?: boolean }): Promise<{
      ok: boolean;
      item?: { status: string; rightsAllowed: boolean };
      singingStarted?: boolean;
    }>;
    v2LiveIngest(input: { event: unknown; flush?: boolean }): Promise<{ ok: boolean }>;
    v2LiveObsStage(): Promise<{
      liveActive: boolean;
      activeSongTitle: string | null;
      recentDanmaku: Array<{ text: string }>;
      recentGifts: Array<{ count: number }>;
    }>;
    v2LiveSessionEnd(reason?: string): Promise<{
      ok: boolean;
      summary?: { songBlockedCount: number; songAcceptedCount: number; danmakuCount: number; giftCount: number } | null;
    }>;
    v2AutoAccountRegister(input: { accountId?: string; characterId: string; platform: string; username: string; plainSecret: string }): Promise<{
      ok: boolean;
      entry?: { accountId: string; maskedSecret: string };
    }>;
    v2AutoProfileEnsure(input: { profileId?: string; characterId: string; accountId: string }): Promise<{
      ok: boolean;
      profile?: { profileId: string; profileDir: string; isolatedFromUserDaily: boolean };
    }>;
    v2AutoProfileCookies(input: { action: 'set' | 'read'; profileId: string; characterId: string; origin?: string; cookieKey?: string; cookieVal?: string }): Promise<{
      ok: boolean;
      error?: string;
    }>;
    v2AutoBrowserExec(input: { taskId: string; characterId: string; profileId: string; url: string; action: string; riskLevel?: string; confirmToken?: string }): Promise<{
      ok: boolean;
      pauseReason: string;
      requiresHumanHandoff: boolean;
      runner: { engine: string; status: string; pageTextChars: number; injectionSignals: string[] };
    }>;
    v2AutoLease(input: { action: string; deviceId?: string; holderId?: string; characterId?: string; purpose?: string; leaseId?: string }): Promise<{
      ok: boolean;
      reason?: string;
      lease?: { leaseId: string };
      preemptedLease?: { status: string } | null;
    }>;
    v2AutoAccountExport(): Promise<{ secretsRedacted: boolean; accounts: Array<{ maskedSecret: string }> }>;
    v2AutoHandoffs(): Promise<Array<{ handoffId: string; taskId: string; reason: string; status: string }>>;
    v2AutoHandoffComplete(handoffId: string, outcome?: 'completed' | 'cancelled'): Promise<{ ok: boolean; handoff?: { status: string } }>;
    v2AutoInputStatus(): Promise<{
      monitor: { running: boolean; detected: number };
      executor: { enabled: boolean; mode: string; permission: string };
      realOsInputEnabled: boolean;
    }>;
    v2AutoExecInput(input: { leaseId?: string | null; step?: { kind?: string; x?: number; y?: number } }): Promise<{ ok: boolean; code: string; executed: boolean; mode: string }>;
    v2AutoP5Confirm(input: { taskId: string; action: string; url: string }): Promise<{ ok: boolean; token?: string; expiresAt?: number }>;
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
  it('启动后 WhaleKernel 进入 running，支持角色状态读取、紧急停止与恢复', { timeout: 120_000 }, async () => {
    // P3-03 本地确定性浏览器页面（不访问公网）：普通页 / CAPTCHA 页
    const pageServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if ((req.url ?? '').includes('captcha')) {
        res.end('<html><head><title>Human check</title></head><body><p>Please complete the captcha to continue</p></body></html>');
        return;
      }
      res.end('<html><head><title>鲸屿本地测试页</title></head><body><h1>本地确定性页面</h1><p id="v">确定性读取成功</p><input id="q"></body></html>');
    });
    await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
    const localPort = (pageServer.address() as AddressInfo).port;
    const localUrl = `http://127.0.0.1:${localPort}/article`;
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

      // V2-P2-06：验证像素人物流水线任务查询与 Stardew Avatar Mod 导出核验 IPC
      const p206 = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        return {
          jobs: await bridge.v2PixelJobs(),
          verify: await bridge.v2PixelVerifyStardew(),
        };
      });
      expect(Array.isArray(p206.jobs)).toBe(true);
      expect(typeof p206.verify.modDir).toBe('string');
      expect(p206.verify.realDeviceInGameVisualVerified).toBe(false);

      // V2-P2-07：验证原创舞台图/SFX 合成、十态 AssetRegistry 发布、一键回滚、SHA-256 核验与商业清源过滤
      const p207 = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        const tag = Date.now().toString(36);
        const stageId = `e2e-stage-${tag}`;
        const ncId = `e2e-nc-${tag}`;
        const stage1 = await bridge.v2StageSceneCreate({ theme: 'tidepaper_mist', width: 320, height: 180 });
        const stage2 = await bridge.v2StageSceneCreate({ theme: 'night_tide', width: 320, height: 180 });
        const sfx = await bridge.v2SoundSfxCreate({ preset: 'chime', durationMs: 180 });

        const reg1 = await bridge.v2AssetRegister({
          assetId: stageId,
          characterId: 'char_xiaojing',
          displayName: 'E2E舞台v1',
          category: 'stage_background',
          sourceFilePath: stage1.outputPath!,
          provenance: {
            sourceType: 'user-upload',
            license: 'SELF_OWNED_COMMERCIAL',
            allowCommercial: true,
            allowLivestream: true,
            allowRedistribution: true,
            inputRefPaths: [],
            reviewNotes: [],
          },
        });
        await bridge.v2AssetTransition({ assetId: stageId, versionId: reg1.version!.versionId, nextStatus: 'approved' });
        await bridge.v2AssetTransition({ assetId: stageId, versionId: reg1.version!.versionId, nextStatus: 'published' });

        const reg2 = await bridge.v2AssetRegister({
          assetId: stageId,
          characterId: 'char_xiaojing',
          displayName: 'E2E舞台v2',
          category: 'stage_background',
          sourceFilePath: stage2.outputPath!,
          provenance: {
            sourceType: 'user-upload',
            license: 'SELF_OWNED_COMMERCIAL',
            allowCommercial: true,
            allowLivestream: true,
            allowRedistribution: true,
            inputRefPaths: [],
            reviewNotes: [],
          },
        });
        await bridge.v2AssetTransition({ assetId: stageId, versionId: reg2.version!.versionId, nextStatus: 'approved' });
        await bridge.v2AssetTransition({ assetId: stageId, versionId: reg2.version!.versionId, nextStatus: 'published' });

        const rollbackRes = await bridge.v2AssetRollback({ assetId: stageId });
        const verifyRes = await bridge.v2AssetVerify({ assetId: stageId });

        const ncReg = await bridge.v2AssetRegister({
          assetId: ncId,
          characterId: 'custom-cp-deepseek',
          displayName: 'E2E非商用测试',
          category: 'stage_background',
          sourceFilePath: stage1.outputPath!,
          provenance: {
            sourceType: 'third-party-import',
            license: 'CC BY-NC-SA 4.0',
            allowCommercial: false,
            allowLivestream: false,
            allowRedistribution: false,
            inputRefPaths: [],
            reviewNotes: [],
          },
        });
        await bridge.v2AssetTransition({ assetId: ncId, versionId: ncReg.version!.versionId, nextStatus: 'approved' });
        await bridge.v2AssetTransition({ assetId: ncId, versionId: ncReg.version!.versionId, nextStatus: 'published' });

        const cleanExport = await bridge.v2AssetExportClean({
          channel: 'commercial_distribution',
          assetIds: [stageId, ncId],
        });
        return { stage1, sfx, rollbackRes, verifyRes, cleanExport, stageId, ncId };
      });
      expect(p207.stage1.inspection?.valid).toBe(true);
      expect(p207.sfx.inspection?.valid).toBe(true);
      expect(p207.sfx.inspection?.format).toBe('wav');
      expect(p207.rollbackRes.ok).toBe(true);
      expect(p207.rollbackRes.entry?.activeVersionId).toBe('v1');
      expect(p207.verifyRes.check?.ok).toBe(true);
      expect(p207.cleanExport.result?.exportedCount).toBe(1);
      expect(p207.cleanExport.result?.blockedCount).toBe(1);
      expect(p207.cleanExport.result?.exportedAssets[0]?.assetId).toBe(p207.stageId);
      expect(p207.cleanExport.result?.blockedAssets[0]?.assetId).toBe(p207.ncId);

      // V2-P2-08：验证 CoopRuntime v1 人机分工、防误卖保护、任务板闭环、断线重连与真实 Mods 盘兼容扫描
      const p208 = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        const room = await bridge.v2CoopRoomCreate({ roomId: `e2e-coop-${Date.now().toString(36)}`, sharedGoal: 'E2E 人机分工种植' });
        const host = await bridge.v2CoopParticipantJoin({ participantId: 'human-host', kind: 'human', characterId: 'farmer', displayName: '人类玩家' });
        const ai = await bridge.v2CoopParticipantJoin({ participantId: 'ai-xiaojing', kind: 'ai', characterId: 'char_xiaojing', displayName: '小鲸' });
        await bridge.v2CoopResourceReserve({ resourceKey: 'crop:starfruit', ownerId: 'human-host', intent: 'sell_forbidden', reason: '人类留做种子' });
        const sellCheck = await bridge.v2CoopResourceCheck({ participantId: 'ai-xiaojing', resourceKey: 'crop:starfruit', action: 'sell' });
        const proposed = await bridge.v2CoopTaskAction({
          action: 'propose',
          taskId: 'e2e-task-1',
          title: '南区浇水',
          goal: '浇完 8 格防风草',
          ownerId: 'ai-xiaojing',
          resourceLocks: ['zone:south-farm'],
        });
        await bridge.v2CoopTaskAction({ action: 'accept', taskId: 'e2e-task-1' });
        const started = await bridge.v2CoopTaskAction({ action: 'start', taskId: 'e2e-task-1' });
        const outcome = await bridge.v2CoopTaskAction({
          action: 'outcome',
          taskId: 'e2e-task-1',
          receipt: 'COMPLETED',
          resultSummary: '8 格全部浇水完成',
        });
        const disconnected = await bridge.v2CoopRecovery({ action: 'disconnect', participantId: 'ai-xiaojing', reason: 'E2E 模拟掉线' });
        const reconnected = await bridge.v2CoopRecovery({ action: 'reconnect', participantId: 'ai-xiaojing' });
        const compat = await bridge.v2CoopModCompat();
        return { room, host, ai, sellCheck, proposed, started, outcome, disconnected, reconnected, compat };
      });
      expect(p208.room.ok).toBe(true);
      expect(p208.host.participant?.controlOwner).toBe('human');
      expect(p208.ai.snapshot?.status).toBe('active');
      expect(p208.sellCheck.allowed).toBe(false);
      expect(p208.started.task?.status).toBe('running');
      expect(p208.outcome.task?.status).toBe('completed');
      expect(p208.disconnected.snapshot?.status).toBe('reconnecting');
      expect(p208.reconnected.snapshot?.status).toBe('active');
      expect(p208.compat.ok).toBe(true);
      expect(p208.compat.report?.bwfReady).toBe(true);

      // V2-P3-01：验证统一表演系统（SingEngine 授权拦截 + 导唱 + 歌词/舞蹈时钟 + 2D/Live2D/VRM StageRuntime + 急停）
      const p301 = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        await bridge.v2Resume('autonomous');
        const initSnap = await bridge.v2PerfSnapshot();
        const blockedLive = await bridge.v2PerfSingStart({
          request: {
            requestId: 'e2e-sing-blocked',
            characterId: 'char_xiaojing',
            voiceProfileId: 'qiaopi_mengmei',
            mode: 'svs',
            channel: 'livestream_public',
            song: {
              songId: 'nc-song',
              title: 'NC 测试歌',
              durationMs: 4000,
              rights: {
                songLicense: 'dev_only_non_commercial',
                accompanimentLicense: 'original_owned',
                lyricsLicense: 'original_owned',
                voiceModelAuthorized: true,
                voiceConsentSource: 'test-consent',
              },
            },
          },
        });
        const quietSkip = await bridge.v2PerfSilenceCheck({ quietCompanionMode: true, priority: 'P2_IDLE' });
        const p0Speak = await bridge.v2PerfSilenceCheck({ quietCompanionMode: true, priority: 'P0_INTERRUPT' });
        await bridge.v2PerfSilenceCheck({ quietCompanionMode: false, priority: 'P1_CADENCE' });

        const singOk = await bridge.v2PerfSingStart({
          request: {
            requestId: 'e2e-sing-ok',
            characterId: 'char_xiaojing',
            voiceProfileId: 'qiaopi_mengmei',
            mode: 'svs',
            channel: 'livestream_public',
            song: {
              songId: 'e2e-tide-song',
              title: '鲸屿晨光',
              durationMs: 5000,
              accompanimentTrackPath: 'assets/audio/accomp.wav',
              lyrics: [
                { index: 0, startMs: 0, endMs: 2000, primaryText: '第一句潮汐', secondaryText: 'First tide line' },
                { index: 1, startMs: 2000, endMs: 5000, primaryText: '第二句星光', secondaryText: 'Second starlight' },
              ],
              rights: {
                songLicense: 'original_owned',
                accompanimentLicense: 'original_owned',
                lyricsLicense: 'original_owned',
                voiceModelAuthorized: true,
                voiceConsentSource: 'whale-isle-original',
              },
            },
          },
          danceRoutine: {
            routineId: 'e2e-dance',
            title: '鲸跃舞',
            durationMs: 5000,
            cues: [
              { cueId: 'e2e-cue-1', atMs: 0, durationMs: 2000, poseId: 'wave', vrmMotionTag: 'dance_wave' },
              { cueId: 'e2e-cue-2', atMs: 2000, durationMs: 3000, poseId: 'spin', vrmMotionTag: 'dance_spin', expressionId: 'happy' },
            ],
          },
        });
        const ticked = await bridge.v2PerfTick(2500);
        const live2dSwitch = await bridge.v2StageSwitchBackend({ backend: 'live2d' });
        const vrmSwitch = await bridge.v2StageSwitchBackend({ backend: 'vrm-3d' });
        await bridge.v2EmergencyHalt('E2E P3 急停验证');
        const afterHalt = await bridge.v2PerfSnapshot();
        await bridge.v2Resume('autonomous');
        return { initSnap, blockedLive, quietSkip, p0Speak, singOk, ticked, live2dSwitch, vrmSwitch, afterHalt };
      });
      expect(p301.initSnap.stage.characterId).toBe('char_xiaojing');
      expect(p301.initSnap.singBackends.length).toBe(2);
      expect(p301.blockedLive.ok).toBe(false);
      expect(p301.blockedLive.result?.rightsCheck.allowed).toBe(false);
      expect(p301.quietSkip.shouldSpeak).toBe(false);
      expect(p301.p0Speak.shouldSpeak).toBe(true);
      expect(p301.singOk.ok).toBe(true);
      expect(p301.singOk.result?.backendMode).toBe('preview_guide_tone');
      expect(p301.singOk.snapshot?.mode).toBe('singing_and_dancing');
      expect(p301.ticked.performance.lyrics.activeIndex).toBe(1);
      expect(p301.ticked.performance.lyrics.activeLine?.secondaryText).toBe('Second starlight');
      expect(p301.ticked.performance.activeDanceCue?.cueId).toBe('e2e-cue-2');
      expect(p301.live2dSwitch.stage?.activeBackend).toBe('live2d');
      expect(p301.live2dSwitch.stage?.characterId).toBe('char_xiaojing');
      expect(p301.vrmSwitch.stage?.activeBackend).toBe('vrm-3d');
      expect(p301.vrmSwitch.stage?.lyrics?.activeIndex).toBe(1);
      expect(p301.afterHalt.performance.halted).toBe(true);
      expect(p301.afterHalt.performance.mode).toBe('halted');

      // V2-P3-02：验证 LifeRuntime 直播中控（诚实降级探测 + 点歌版权门禁 + 弹幕/礼物批次 + OBS 舞台投影 + 下播摘要）
      const p302 = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        const startDegraded = await bridge.v2LiveSessionStart({ platform: 'douyin_dyhub', roomId: 'room-e2e' });
        const blockedSong = await bridge.v2LiveSongRequest({ title: '大肥鱼非商用曲', autoPerform: true });
        const okSong = await bridge.v2LiveSongRequest({ title: '鲸屿晨雾', autoPerform: true });
        await bridge.v2LiveIngest({
          event: {
            eventId: crypto.randomUUID(),
            platform: 'douyin',
            eventType: 'DANMAKU',
            sender: { uid: 'e2e-u1', nickname: '小潮', intimacyScore: 5, grudgeTags: [] },
            payload: { rawText: 'OBS 歌词同步不错', mergedCount: 1 },
            assignedPriority: 'P1_CADENCE',
            timestamp: Date.now(),
          },
        });
        await bridge.v2LiveIngest({
          event: {
            eventId: crypto.randomUUID(),
            platform: 'douyin',
            eventType: 'GIFT',
            sender: { uid: 'e2e-u2', nickname: '海风', intimacyScore: 8, grudgeTags: [] },
            payload: { giftName: '珊瑚玫瑰', giftDiamondValue: 19, mergedCount: 1 },
            assignedPriority: 'P1_CADENCE',
            timestamp: Date.now(),
          },
          flush: true,
        });
        const obs = await bridge.v2LiveObsStage();
        const ended = await bridge.v2LiveSessionEnd('e2e_done');
        return { startDegraded, blockedSong, okSong, obs, ended };
      });
      expect(p302.startDegraded.ok).toBe(true);
      expect(p302.startDegraded.snapshot?.adapter.connectionState).toBe('degraded');
      expect(p302.startDegraded.snapshot?.adapter.realPlatformVerified).toBe(false);
      expect(p302.blockedSong.ok).toBe(false);
      expect(p302.blockedSong.item?.status).toBe('blocked_rights');
      expect(p302.okSong.ok).toBe(true);
      expect(p302.okSong.singingStarted).toBe(true);
      expect(p302.obs.liveActive).toBe(true);
      expect(p302.obs.activeSongTitle).toBe('鲸屿晨雾');
      expect(p302.obs.recentDanmaku.some((d) => d.text.includes('OBS 歌词同步不错'))).toBe(true);
      expect(p302.obs.recentGifts.length).toBeGreaterThanOrEqual(1);
      expect(p302.ended.summary?.songBlockedCount).toBeGreaterThanOrEqual(1);
      expect(p302.ended.summary?.songAcceptedCount).toBeGreaterThanOrEqual(1);

      // V2-P3-03：验证 AccountVault / Per-Character BrowserProfile 隔离、CAPTCHA 人机交还与 ComputerUseLease 单主控
      const p303 = await director.evaluate(async () => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        const secretValue = 'e2e-plain-secret-token-should-never-leak';
        const acct = await bridge.v2AutoAccountRegister({
          accountId: 'e2e-acct-xj',
          characterId: 'char_xiaojing',
          platform: 'bilibili',
          username: 'xiaojing_e2e',
          plainSecret: secretValue,
        });
        const prof = await bridge.v2AutoProfileEnsure({
          profileId: 'e2e-prof-xj',
          characterId: 'char_xiaojing',
          accountId: 'e2e-acct-xj',
        });
        await bridge.v2AutoProfileCookies({
          action: 'set',
          profileId: 'e2e-prof-xj',
          characterId: 'char_xiaojing',
          origin: 'https://example.com',
          cookieKey: 'sid',
          cookieVal: 'xj-cookie',
        });
        const crossCharRead = await bridge.v2AutoProfileCookies({
          action: 'read',
          profileId: 'e2e-prof-xj',
          characterId: 'char_intruder',
        });
        const captchaExec = await bridge.v2AutoBrowserExec({
          taskId: 'e2e-cap',
          characterId: 'char_xiaojing',
          profileId: 'e2e-prof-xj',
          url: 'https://example.com/captcha-verify',
          action: 'click_selector',
        });
        const lease1 = await bridge.v2AutoLease({
          action: 'acquire',
          deviceId: 'host-primary',
          holderId: 'agent-xj',
          characterId: 'char_xiaojing',
          purpose: 'E2E 主控租约',
        });
        const lease2 = await bridge.v2AutoLease({
          action: 'acquire',
          deviceId: 'host-primary',
          holderId: 'agent-second',
          characterId: 'char_other',
          purpose: 'E2E 并发抢占',
        });
        const humanPreempt = await bridge.v2AutoLease({ action: 'human_input', deviceId: 'host-primary' });
        await bridge.v2AutoLease({ action: 'release_human', deviceId: 'host-primary' });
        const exported = await bridge.v2AutoAccountExport();
        return { acct, prof, crossCharRead, captchaExec, lease1, lease2, humanPreempt, exported, secretValue };
      });
      expect(p303.acct.ok).toBe(true);
      expect(p303.acct.entry?.maskedSecret).not.toContain(p303.secretValue);
      expect(JSON.stringify(p303.exported)).not.toContain(p303.secretValue);
      expect(p303.prof.profile?.isolatedFromUserDaily).toBe(true);
      expect(p303.crossCharRead.ok).toBe(false);
      expect(p303.crossCharRead.error).toContain('PROFILE_ISOLATION_VIOLATION');
      expect(p303.captchaExec.ok).toBe(false);
      expect(p303.captchaExec.pauseReason).toBe('captcha_required');
      expect(p303.captchaExec.requiresHumanHandoff).toBe(true);
      expect(p303.lease1.ok).toBe(true);
      expect(p303.lease2.ok).toBe(false);
      expect(p303.lease2.reason).toBe('DEVICE_LEASE_BUSY');
      expect(p303.humanPreempt.preemptedLease?.status).toBe('preempted_by_human');

      // V2-P3-03b：Electron 隐藏窗口确定性读取（本地页面）+ 页面 CAPTCHA 交接 + P5 一次性令牌 + dry-run 默认关闭
      const p303b = await director.evaluate(async (url) => {
        const bridge = (window as unknown as DirectorV2Window).directorBridge;
        await bridge.v2AutoProfileEnsure({ profileId: 'e2e-prof-read', characterId: 'char_xiaojing', accountId: 'e2e-acct-xj' });
        const read = await bridge.v2AutoBrowserExec({
          taskId: 'e2e-local-read',
          characterId: 'char_xiaojing',
          profileId: 'e2e-prof-read',
          url,
          action: 'read',
        });
        const captcha = await bridge.v2AutoBrowserExec({
          taskId: 'e2e-page-cap',
          characterId: 'char_xiaojing',
          profileId: 'e2e-prof-read',
          url: url.replace('/article', '/captcha'),
          action: 'read',
        });
        const handoffs = await bridge.v2AutoHandoffs();
        const handoffId = handoffs.find((h) => h.taskId === 'e2e-page-cap' && h.status === 'awaiting_human')?.handoffId;
        const completed = handoffId ? await bridge.v2AutoHandoffComplete(handoffId) : null;
        const inputStatus = await bridge.v2AutoInputStatus();
        const dryRun = await bridge.v2AutoExecInput({ leaseId: null, step: { kind: 'click', x: 1, y: 1 } });
        const token = await bridge.v2AutoP5Confirm({ taskId: 'e2e-p5', action: 'payment', url });
        const p5Blocked = await bridge.v2AutoBrowserExec({
          taskId: 'e2e-p5', characterId: 'char_xiaojing', profileId: 'e2e-prof-read', url, action: 'payment', riskLevel: 'P5',
        });
        const p5Ok = token.token
          ? await bridge.v2AutoBrowserExec({
              taskId: 'e2e-p5', characterId: 'char_xiaojing', profileId: 'e2e-prof-read', url, action: 'payment', riskLevel: 'P5', confirmToken: token.token,
            })
          : null;
        const p5Replay = token.token
          ? await bridge.v2AutoBrowserExec({
              taskId: 'e2e-p5', characterId: 'char_xiaojing', profileId: 'e2e-prof-read', url, action: 'payment', riskLevel: 'P5', confirmToken: token.token,
            })
          : null;
        return { read, captcha, handoffId, completed, inputStatus, dryRun, p5Blocked, p5Ok, p5Replay };
      }, localUrl);
      expect(p303b.read.ok).toBe(true);
      expect(p303b.read.runner.engine).toBe('electron');
      expect(p303b.read.runner.status).toBe('executed');
      expect(p303b.read.runner.pageTextChars).toBeGreaterThan(0);
      expect(p303b.read.runner.injectionSignals).toEqual([]);
      expect(p303b.captcha.ok).toBe(false);
      expect(p303b.captcha.pauseReason).toBe('captcha_required');
      expect(p303b.handoffId).toBeTruthy();
      expect(p303b.completed?.handoff?.status).toBe('completed');
      expect(p303b.inputStatus.executor.enabled).toBe(false);
      expect(p303b.inputStatus.executor.mode).toBe('disabled');
      expect(p303b.inputStatus.realOsInputEnabled).toBe(false);
      expect(p303b.dryRun).toMatchObject({ ok: true, executed: false, mode: 'dry_run', code: 'feature_disabled' });
      expect(p303b.p5Blocked.pauseReason).toBe('p5_explicit_confirm');
      expect(p303b.p5Ok?.ok).toBe(true);
      expect(p303b.p5Replay?.pauseReason).toBe('p5_explicit_confirm');
    } finally {
      await app.close();
      await new Promise<void>((resolve) => pageServer.close(() => resolve()));
    }
  });
});
