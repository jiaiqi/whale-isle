/**
 * Whale Isle V2 内核宿主接线（V2-P0-02 → V2-P1-01）：
 * - 在 Electron 主进程启动并维护 WhaleKernel 单例与 12 域 CharacterCore / LifeRuntime
 * - 复用 provider-vault.ts 的 safeStorage 凭据库作为 SecretVaultPort，绝不重复造钥匙串逻辑
 * - 注册内置诊断插件 core-diagnostics，并将 V1 autodrive/voice 关键状态事件同步到 CharacterCore & LifeRuntime
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, powerMonitor, systemPreferences } from 'electron';
import { z } from 'zod';
import {
  AccountVault,
  BrowserProfileMgr,
  BrowserRuntime,
  ComputerInputExecutor,
  ComputerUseLeaseManager,
  DeterministicBrowserRunner,
  HumanInputMonitor,
  createDefaultRuntimeConfig,
  JsonFileConfigStore,
  RuntimeConfigSchema,
  WhaleKernel,
  type InputPermissionState,
  type SecretVaultPort,
  type SecretVaultStatus,
} from '@workbench/runtime-core';
import { CharacterCore, ContentUnderstandingPipeline, InterestSink, SocialRuntime, type InterestMemoryPort, type SelectActivityInput } from '@workbench/character-core';
import {
  AudioTrackKindSchema,
  BrowseCandidateSchema,
  type BrowserTaskRequestInput,
  ChatImageMimeSchema,
  ContentItemRefSchema,
  GoalHorizonSchema,
  GoalOriginSchema,
  LifeActivityKindSchema,
  MemoryCategorySchema,
  PreferenceCategorySchema,
  SocialPlatformCapabilityEntrySchema,
  SocialPlatformIdSchema,
  StageBackendKindSchema,
  StageCharacterBindingSchema,
  StageSceneSpecSchema,
  VoiceProviderKindSchema,
  type CharacterCoreSnapshot,
  type DanceRoutineInput,
  type ImageGenProviderDescriptor,
  type LiveSessionStartInput,
  type LiveSongRequestInput,
  type LyricsDisplayPolicyInput,
  type SingRequestInput,
  type SpeechPerformancePlanInput,
  type StageBackendKind,
} from '@workbench/shared-protocol';
import { LiveRuntimeV2 } from '@workbench/live-stream-hub';
import { ElectronBrowserEngine } from './electron-browser-engine';
import { createNativeInjector, ensureNativeInputHelper } from './native-input-helper';
import { MediaGenerationGateway } from './media-gateway';
import { Pipeline3dManager } from './pipeline-3d';
import { CharacterStudioV2, inspectLive2dOrLayered2d } from './character-studio-v2';
import { PixelAvatarPipelineV2 } from './pixel-avatar-v2';
import {
  AssetRegistryV2,
  createProceduralStageScenePng,
  synthesizeSfxWav,
  type SfxPreset,
  type StageSceneTheme,
} from './asset-registry-v2';
import { resolvePetPacksDir } from './pet-packs';
import { CoopRuntimeV1, evaluateCoopModsCompatibility } from '@workbench/game-bridge-mcp';
import { guessModsDirs, scanModsDir } from '@workbench/stardew-mods';
import {
  formatMemoryContext,
  retrieve,
} from '@workbench/memory-graph';
import {
  AudioMixer,
  CloudOpenAiTtsProvider,
  LocalAudioWorkerProvider,
  MiniMaxTtsProvider,
  PerformanceDirector,
  SingEngine,
  SystemFallbackVoiceProvider,
  VoiceProviderRouter,
  type SilenceContextInput,
} from '@workbench/voice-runtime';
import { StageRuntime } from '@workbench/pet-renderer';
import {
  BUILTIN_PROVIDER_PRESETS,
  probeProviderQuota,
  probeQuotaMatrix,
  type ProbeQuotaInput,
} from '@workbench/model-gateway';
import { openSqliteStoreWithRecovery } from '@workbench/local-store';
import type { AutodriveHost } from './autodrive-host';
import type { MemoryHost } from './memory-host';
import type { VoiceHost } from './voice-host';
import {
  deleteVaultKey,
  hasVaultKey,
  inspectVault,
  readVaultKey,
  resolveProviderKey,
  vaultBackend,
  writeVaultKey,
} from './provider-vault';

/** 将现有 Electron safeStorage 凭据库适配为 V2 SecretVaultPort */
function createElectronVaultPort(vaultPath: string): SecretVaultPort {
  return {
    backend: () => vaultBackend(),
    getStatus: (ids?: readonly string[]): SecretVaultStatus => {
      const report = inspectVault(vaultPath, ids);
      return {
        backend: report.backend,
        encryptionAvailable: report.encryptionAvailable,
        storedIds: report.providers
          .filter((p) => p.mask !== undefined)
          .map((p) => ({ id: p.providerId, mask: p.mask! })),
      };
    },
    has: (id: string) => hasVaultKey(vaultPath, id),
    mask: (id: string) => resolveProviderKey(vaultPath, id).mask ?? null,
    set: (id: string, plainSecret: string) => writeVaultKey(vaultPath, id, plainSecret),
    delete: (id: string) => deleteVaultKey(vaultPath, id),
    resolve: (id: string) => readVaultKey(vaultPath, id),
  };
}

export interface V2KernelHost {
  readonly kernel: WhaleKernel;
  readonly characterCore: CharacterCore;
  readonly audioMixer: AudioMixer;
  readonly voiceRouter: VoiceProviderRouter;
  readonly performanceDirector: PerformanceDirector;
  readonly stageRuntime: StageRuntime;
  readonly liveRuntime: LiveRuntimeV2;
  readonly computerLeaseMgr: ComputerUseLeaseManager;
  readonly browserRuntime: BrowserRuntime;
  attachV1Bridges(deps: { autodrive: AutodriveHost; voice: VoiceHost; memory?: MemoryHost }): void;
  stop(): Promise<void>;
}

/** V2-P3-04E：规划 L1 浏览会话的 IPC 入参 */
const SocialPlanInputSchema = z.object({
  platform: SocialPlatformIdSchema,
  objective: z.string().min(1).max(300),
  goalId: z.string().min(1).optional(),
  maxItems: z.number().int().min(1).max(50).optional(),
  maxDurationMs: z.number().int().min(10_000).max(3_600_000).optional(),
});

/** V2-P3-04E：内容理解 IPC 入参（页面正文与截图为不可信数据） */
const SocialUnderstandInputSchema = z.object({
  sessionId: z.string().min(1),
  item: ContentItemRefSchema,
  textContent: z.string().max(64_000),
  screenshot: z.object({ mime: ChatImageMimeSchema, dataBase64: z.string().min(1) }).optional(),
  currentInterests: z.array(z.string().min(1).max(50)).max(20).optional(),
});

const AddGoalInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  horizon: GoalHorizonSchema.optional(),
  origin: GoalOriginSchema.optional(),
  priority: z.number().int().min(0).max(100).optional(),
  relatedActivity: LifeActivityKindSchema.optional(),
});

const AddCommitmentInputSchema = z.object({
  partnerId: z.string().min(1),
  partnerName: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  detail: z.string().max(1000).optional(),
  dueAt: z.number().int().nonnegative().optional(),
});

const RecordPreferenceInputSchema = z.object({
  category: PreferenceCategorySchema,
  key: z.string().min(1),
  delta: z.number(),
  source: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const SelectActivityInputSchema = z.object({
  mode: LifeActivityKindSchema,
  reason: z.string().min(1),
  source: z.enum(['life_runtime', 'user_command', 'emergency_halt', 'manual_takeover']).optional(),
  force: z.boolean().optional(),
});

const TrackStartInputSchema = z.object({
  trackId: z.string().min(1),
  kind: AudioTrackKindSchema,
  label: z.string().min(1),
  gain: z.number().min(0).max(2).optional(),
  muted: z.boolean().optional(),
  outputDeviceId: z.string().min(1).optional(),
});

const OutputRouteInputSchema = z.object({
  kind: AudioTrackKindSchema,
  deviceId: z.string(),
});

const VoiceSynthesizePreviewSchema = z.object({
  text: z.string().min(1).max(4000),
  emotion: z.string().min(1).optional(),
  styleMode: z.enum(['normal', 'inner', 'p0', 'singing']).optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
  preferredProvider: VoiceProviderKindSchema.optional(),
});

const VoiceIdentityPatchSchema = z.object({
  voiceProfileId: z.string().min(1).optional(),
  voiceDescription: z.string().min(1).optional(),
  preferredProviderId: z.string().min(1).optional(),
  providerVoiceRef: z.string().min(1).optional(),
});

const ProviderQuotaQuerySchema = z.object({
  providerId: z.string().min(1),
  planType: z.enum(['PAY_AS_YOU_GO', 'CODING_PLAN', 'LOCAL_GPU']).optional(),
  region: z.enum(['CN', 'GLOBAL', 'LOCAL']).optional(),
  baseUrl: z.string().optional(),
});

const ProviderQuotaMatrixQuerySchema = z.object({
  providerIds: z.array(z.string().min(1)).optional(),
  includeCli: z.boolean().default(true),
}).default({ includeCli: true });

const MemoryAddInputSchema = z.object({
  nodeType: z.enum(['event', 'entity', 'concept', 'summary']).default('event'),
  category: MemoryCategorySchema,
  text: z.string().min(1),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  emotionWeight: z.number().min(0).max(1).optional(),
  emotionValence: z.number().min(-1).max(1).optional(),
  entityKey: z.string().min(1).optional(),
  entityDisplayName: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
});

const MemoryQueryInputSchema = z.object({
  query: z.string().min(1),
  categories: z.array(MemoryCategorySchema).optional(),
  topN: z.number().int().min(1).max(30).default(8),
  recordRecall: z.boolean().default(true),
});

const MemoryConsolidateInputSchema = z.object({
  entityKey: z.string().min(1).optional(),
  minInteractions: z.number().int().min(1).max(20).optional(),
}).default({});

const MemoryCorrectInputSchema = z.object({
  nodeId: z.string().min(1),
  newText: z.string().min(1),
  reason: z.string().min(1).optional(),
});

const MemoryHardDeleteInputSchema = z.object({
  nodeId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

function hasCliBinary(binary: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [binary], {
      stdio: 'ignore',
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function createV2KernelHost(options: {
  userDataDir: string;
  vaultPath: string;
  packsRoot?: string;
}): Promise<V2KernelHost> {
  const configStore = new JsonFileConfigStore(
    join(options.userDataDir, 'v2-runtime-config.json'),
    RuntimeConfigSchema,
    createDefaultRuntimeConfig(),
  );
  const kernel = new WhaleKernel({
    configStore,
    secrets: createElectronVaultPort(options.vaultPath),
    primaryCharacter: {
      characterId: 'char_xiaojing',
      displayName: '小鲸',
      personaId: 'blue-whale-maid',
      voiceProfileId: 'qiaopi_mengmei',
    },
  });

  // 注册内置诊断插件：验证 V2 插件生命周期 + 工具定义 + 权限边界在生产主进程真实运行
  kernel.registerPlugin({
    manifest: {
      id: 'core-diagnostics',
      name: '核心运行诊断',
      version: '0.1.0',
      description: '提供 V2 内核健康快照与近期脱敏日志检索',
      extensions: ['tool'],
      permissions: [{ resource: 'runtime:diagnostics', policy: 'allow' }],
    },
    setup: (api) => {
      api.defineTool({
        name: 'core-diagnostics:health',
        description: '读取 WhaleKernel 当前健康与角色运行状态',
        schema: z.object({}).default({}),
        policy: 'allow',
        execute: () => kernel.health(),
      });
    },
  });

  await kernel.start();

  const characterCore = new CharacterCore({
    events: kernel.events,
    registryCore: kernel.characters,
    filePath: join(options.userDataDir, 'v2-character-core.json'),
  });

  const audioMixer = new AudioMixer({ events: kernel.events });
  const voiceRouter = new VoiceProviderRouter({
    providers: [
      new MiniMaxTtsProvider({ resolveApiKey: () => kernel.secrets.resolve('minimax') }),
      new CloudOpenAiTtsProvider({ resolveApiKey: () => kernel.secrets.resolve('openai-tts') }),
      new LocalAudioWorkerProvider(),
      new SystemFallbackVoiceProvider(process.platform),
    ],
  });

  let stopFn: (() => void) | null = null;
  let memoryHostRef: MemoryHost | null = null;
  let autodriveRef: AutodriveHost | null = null;
  const unsubscribers: Array<() => void> = [];

  ipcMain.handle('v2:kernel-health', () => kernel.health());
  ipcMain.handle('v2:kernel-logs', (_e, limit = 50) => kernel.logger.recent(typeof limit === 'number' ? limit : 50));
  ipcMain.handle('v2:character-state', () => kernel.characters.primaryState());
  ipcMain.handle('v2:character-snapshot', (): CharacterCoreSnapshot => characterCore.snapshot());
  ipcMain.handle('v2:character-goal-add', (_e, rawInput: unknown) => {
    const parsed = AddGoalInputSchema.parse(rawInput);
    return characterCore.goals.addGoal({
      title: parsed.title,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.horizon === undefined ? {} : { horizon: parsed.horizon }),
      ...(parsed.origin === undefined ? {} : { origin: parsed.origin }),
      ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
      ...(parsed.relatedActivity === undefined ? {} : { relatedActivity: parsed.relatedActivity }),
    });
  });
  ipcMain.handle('v2:character-commitment-add', (_e, rawInput: unknown) => {
    const parsed = AddCommitmentInputSchema.parse(rawInput);
    return characterCore.commitments.create({
      partnerId: parsed.partnerId,
      title: parsed.title,
      ...(parsed.partnerName === undefined ? {} : { partnerName: parsed.partnerName }),
      ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
      ...(parsed.dueAt === undefined ? {} : { dueAt: parsed.dueAt }),
    });
  });
  ipcMain.handle('v2:character-preference-record', (_e, rawInput: unknown) => {
    const parsed = RecordPreferenceInputSchema.parse(rawInput);
    return characterCore.preferences.recordExperience({
      category: parsed.category,
      key: parsed.key,
      delta: parsed.delta,
      source: parsed.source,
      reason: parsed.reason,
      ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
    });
  });
  ipcMain.handle('v2:character-model-bind', (_e, modelRef: string | null) =>
    characterCore.life.bindModel(typeof modelRef === 'string' ? modelRef : null),
  );
  ipcMain.handle('v2:life-activity-select', (_e, rawInput: unknown) => {
    const parsed = SelectActivityInputSchema.parse(rawInput);
    const input: SelectActivityInput = {
      mode: parsed.mode,
      reason: parsed.reason,
      ...(parsed.source === undefined ? {} : { source: parsed.source }),
      ...(parsed.force === undefined ? {} : { force: parsed.force }),
    };
    return characterCore.life.selectActivity(input);
  });
  const coopRuntime = new CoopRuntimeV1();
  const singEngine = new SingEngine();
  const performanceDirector = new PerformanceDirector({
    characterId: 'char_xiaojing',
    audioMixer,
    singEngine,
    events: kernel.events,
  });
  const stageRuntime = new StageRuntime();
  stageRuntime.registerBinding({
    characterId: 'char_xiaojing',
    displayName: '小鲸',
    backend: 'live2d',
    assetPath: 'assets/stage/live2d/char_xiaojing.model3.json',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    capabilities: ['ParamMouthOpenY', 'ParamMouthForm', 'MotionGroup'],
  });
  stageRuntime.registerBinding({
    characterId: 'char_xiaojing',
    displayName: '小鲸',
    backend: 'vrm-3d',
    assetPath: 'assets/stage/vrm/char_xiaojing.vrm',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    capabilities: ['humanoid', 'viseme-blendshapes', 'emotion-blendshapes'],
  });
  stageRuntime.registerBinding({
    characterId: 'char_xiaojing',
    displayName: '小鲸',
    backend: 'obs-stage',
    assetPath: 'assets/pet-packs/crosspet/characters/blue-whale-maid/manifest.json',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    capabilities: ['transparent-obs', 'lyrics-overlay'],
  });
  stageRuntime.loadCharacter({
    characterId: 'char_xiaojing',
    displayName: '小鲸',
    backend: 'desktop-2d',
    assetPath: 'assets/pet-packs/crosspet/characters/blue-whale-maid/manifest.json',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    capabilities: ['webm-alpha', 'spritesheet', 'footline-align'],
  });
  const liveRuntime = new LiveRuntimeV2({ characterId: 'char_xiaojing' });
  liveRuntime.registerCatalogSong({
    songId: 'tidepaper-morning-song',
    title: '鲸屿晨雾',
    durationMs: 6000,
    accompanimentTrackPath: 'assets/audio/tide-accomp.wav',
    lyrics: [
      { index: 0, startMs: 0, endMs: 2200, primaryText: '潮汐漫过晨雾里的石阶', secondaryText: 'Tide laps gently across misty stone steps' },
      { index: 1, startMs: 2200, endMs: 6000, primaryText: '小鲸为你点亮海图的星光', secondaryText: 'Xiaojing lights up starlight on the sea chart' },
    ],
    rights: {
      songLicense: 'original_owned',
      accompanimentLicense: 'original_owned',
      lyricsLicense: 'original_owned',
      voiceModelAuthorized: true,
      voiceConsentSource: 'whale-isle-original',
    },
  });
  liveRuntime.registerCatalogSong({
    songId: 'nc-demo-song',
    title: '大肥鱼非商用曲',
    durationMs: 4000,
    rights: {
      songLicense: 'dev_only_non_commercial',
      accompanimentLicense: 'original_owned',
      lyricsLicense: 'original_owned',
      voiceModelAuthorized: true,
      voiceConsentSource: 'test-consent',
    },
  });
  const accountVault = new AccountVault(kernel.secrets, {
    filePath: join(options.userDataDir, 'account-vault-index.json'),
  });
  const browserProfiles = new BrowserProfileMgr({
    rootDir: join(options.userDataDir, 'browser-profiles'),
  });
  const computerLeaseMgr = new ComputerUseLeaseManager({
    events: kernel.events,
    auditFilePath: join(options.userDataDir, 'lease-audit.jsonl'),
  });
  const inputMonitor = new HumanInputMonitor({
    readIdleSeconds: () => {
      // powerMonitor.getSystemIdleTime() 精度约 1s；只用来撤销桌面租约，不接游戏租约（ADR-004）
      return powerMonitor.getSystemIdleTime();
    },
    onHumanInput: ({ idleSeconds }) => {
      computerLeaseMgr.notifyHumanInput('host-primary', `检测到用户物理键鼠输入（idle=${idleSeconds}s，≤1s 抢占）`);
    },
  });
  const inputPermissionProbe = (): InputPermissionState => {
    if (process.platform !== 'darwin') return 'unknown';
    try {
      return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
    } catch {
      return 'unknown';
    }
  };
  // V2-P3-03c：真实 CGEvent 注入器——仅当 WHALE_ENABLE_OS_INPUT=1 时才用系统 swiftc 编译
  // tools/native/macos-input-helper.swift 到 userData 缓存（按源码 SHA-256 版本化，避免拖慢默认启动）；
  // 编译不可用则保持 not_implemented 诚实回报，绝不伪造成功。
  const osInputEnabled = process.env.WHALE_ENABLE_OS_INPUT === '1';
  const nativeHelper = osInputEnabled
    ? ensureNativeInputHelper({
        appPath: app.getAppPath(),
        cacheDir: join(options.userDataDir, 'native'),
      })
    : ({ ok: false, reason: 'feature_disabled' } as const);
  const inputExecutor = new ComputerInputExecutor({
    leases: computerLeaseMgr,
    enabled: osInputEnabled,
    permissionProbe: inputPermissionProbe,
    ...(nativeHelper.ok && nativeHelper.helperPath
      ? { nativeInjector: createNativeInjector(nativeHelper.helperPath) }
      : {}),
    onSyntheticInput: (at) => inputMonitor.noteSyntheticInput(at),
  });
  const browserRunner = new DeterministicBrowserRunner({
    engineFactory: (profile) => new ElectronBrowserEngine({ profile }),
  });
  const browserRuntime = new BrowserRuntime(browserProfiles, computerLeaseMgr, {
    runner: browserRunner,
    executor: inputExecutor,
    monitor: inputMonitor,
  });
  if (process.env.WHALE_DISABLE_INPUT_MONITOR !== '1') inputMonitor.start();

  // ---- V2-P3-04E：Digital Life L1（SocialRuntime + 内容理解管线 + 兴趣沉淀）----
  // 能力矩阵落盘 v2-social-capabilities.json（原子写）；默认空 = 任何平台都不可浏览，
  // 「授权 + 已实测」双条件由 SocialRuntime 门禁强制执行。
  const SocialCapabilitiesFileSchema = z.object({
    entries: z.array(SocialPlatformCapabilityEntrySchema).default([]),
  });
  const socialCapabilitiesStore = new JsonFileConfigStore(
    join(options.userDataDir, 'v2-social-capabilities.json'),
    SocialCapabilitiesFileSchema,
    { entries: [] },
  );
  const socialRuntime = new SocialRuntime({
    characterId: 'char_xiaojing',
    // profileId 是契约引用；真实抓取按角色 Browser Profile 隔离执行（P3-03 设施）
    profileId: browserProfiles.listProfiles('char_xiaojing')[0]?.profileId ?? 'char_xiaojing-default',
    events: kernel.events,
    capabilities: socialCapabilitiesStore.get().entries,
  });
  // 内容理解走 autodrive 的 Gateway（同一供应商配置与饭碗计量），网关未就绪 → 诚实报错安全暂停
  const understandingPipeline = new ContentUnderstandingPipeline({
    characterId: 'char_xiaojing',
    gateway: {
      chat: async (slot, messages, gatewayOpts) => {
        const host = autodriveRef;
        const result = host ? await host.chatViaGateway(slot, messages, gatewayOpts) : null;
        if (!result) throw new Error('模型网关未就绪（无可用供应商 Key，已安全暂停高级自主决策）');
        return result;
      },
    },
  });

  ipcMain.handle('v2:emergency-halt', (_e, reason?: string) => {
    const haltReason = typeof reason === 'string' && reason.trim() !== '' ? reason : '用户在工作台触发紧急停止';
    stopFn?.();
    audioMixer.stopAll();
    performanceDirector.emergencyHalt(haltReason);
    stageRuntime.stopPerformance(haltReason);
    liveRuntime.emergencyHalt(haltReason);
    computerLeaseMgr.emergencyHalt(haltReason);
    coopRuntime.emergencyHaltAll(haltReason);
    characterCore.life.emergencyHalt(haltReason);
    return kernel.characters.primaryState();
  });
  ipcMain.handle('v2:resume', (_e, mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover') => {
    performanceDirector.resumeFromHalt();
    liveRuntime.resumeFromHalt();
    computerLeaseMgr.resumeFromHalt();
    characterCore.life.resume(mode ?? 'autonomous');
    return kernel.characters.primaryState();
  });
  // V2-P1-02：VoiceProvider 探测、独立 VoiceIdentity、多轨 AudioMixer 与口型预览
  ipcMain.handle('v2:voice-providers', () => voiceRouter.listStatuses());
  ipcMain.handle('v2:voice-identity', () => characterCore.profile.voiceIdentity());
  ipcMain.handle('v2:voice-identity-update', (_e, rawPatch: unknown) => {
    const patch = VoiceIdentityPatchSchema.parse(rawPatch);
    return characterCore.profile.updateVoiceIdentity({
      ...(patch.voiceProfileId === undefined ? {} : { voiceProfileId: patch.voiceProfileId }),
      ...(patch.voiceDescription === undefined ? {} : { voiceDescription: patch.voiceDescription }),
      ...(patch.preferredProviderId === undefined ? {} : { preferredProviderId: patch.preferredProviderId }),
      ...(patch.providerVoiceRef === undefined ? {} : { providerVoiceRef: patch.providerVoiceRef }),
    });
  });
  ipcMain.handle('v2:voice-mixer-state', () => audioMixer.snapshot());
  ipcMain.handle('v2:voice-track-start', (_e, rawInput: unknown) => {
    const parsed = TrackStartInputSchema.parse(rawInput);
    return audioMixer.startTrack({
      trackId: parsed.trackId,
      kind: parsed.kind,
      label: parsed.label,
      ...(parsed.gain === undefined ? {} : { gain: parsed.gain }),
      ...(parsed.muted === undefined ? {} : { muted: parsed.muted }),
      ...(parsed.outputDeviceId === undefined ? {} : { outputDeviceId: parsed.outputDeviceId }),
    });
  });
  ipcMain.handle('v2:voice-track-stop', (_e, trackId: string) => audioMixer.stopTrack(String(trackId ?? '')));
  ipcMain.handle('v2:voice-output-route', (_e, rawInput: unknown) => {
    const parsed = OutputRouteInputSchema.parse(rawInput);
    return audioMixer.setOutputRoute(parsed.kind, parsed.deviceId);
  });
  ipcMain.handle('v2:voice-synthesize-preview', (_e, rawInput: unknown) => {
    const parsed = VoiceSynthesizePreviewSchema.parse(rawInput);
    const identity = characterCore.profile.voiceIdentity();
    return voiceRouter.synthesize(
      {
        requestId: randomUUID(),
        characterId: identity.characterId,
        voiceRef: voiceRouter.resolveVoiceRef(identity),
        text: parsed.text,
        ...(parsed.emotion === undefined ? {} : { emotion: parsed.emotion }),
        ...(parsed.styleMode === undefined ? {} : { styleMode: parsed.styleMode }),
        ...(parsed.speed === undefined ? {} : { speed: parsed.speed }),
      },
      parsed.preferredProvider === undefined ? {} : { preferredProvider: parsed.preferredProvider },
    );
  });
  // V2-P1-03：四级诚实额度矩阵探针（明文 Key 仅在主进程解析，绝不回传渲染层）
  ipcMain.handle('v2:provider-quota', (_e, rawInput: unknown) => {
    const parsed = ProviderQuotaQuerySchema.parse(rawInput);
    const preset = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === parsed.providerId);
    return probeProviderQuota({
      providerId: parsed.providerId,
      ...(preset === undefined ? {} : { providerName: preset.name }),
      apiKey: kernel.secrets.resolve(parsed.providerId),
      ...(parsed.planType === undefined ? {} : { planType: parsed.planType }),
      ...(parsed.region === undefined ? {} : { region: parsed.region }),
      ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
      probeCli: hasCliBinary,
    });
  });
  ipcMain.handle('v2:provider-quota-matrix', (_e, rawInput?: unknown) => {
    const parsed = ProviderQuotaMatrixQuerySchema.parse(rawInput ?? {});
    const defaultIds = BUILTIN_PROVIDER_PRESETS
      .filter((p) => p.id !== 'local-gpt-sovits')
      .map((p) => p.id);
    const cliIds = parsed.includeCli ? ['codex-cli', 'claude-cli', 'gemini-cli', 'opencode-cli'] : [];
    const targetIds = parsed.providerIds
      ? [...parsed.providerIds, ...cliIds.filter((c) => !parsed.providerIds!.includes(c))]
      : [...defaultIds, ...cliIds];
    const entries: ProbeQuotaInput[] = targetIds.map((providerId) => {
      const preset = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === providerId);
      return {
        providerId,
        ...(preset === undefined ? {} : { providerName: preset.name }),
        apiKey: kernel.secrets.resolve(providerId),
      };
    });
    return probeQuotaMatrix(entries, { probeCli: hasCliBinary, timeoutMs: 8_000 });
  });
  // V2-P1-04：类人五类记忆、模糊印象归纳、纠正与级联真删除
  ipcMain.handle('v2:memory-add', (_e, rawInput: unknown) => {
    if (!memoryHostRef) return { ok: false, error: '记忆宿主尚未就绪' };
    const parsed = MemoryAddInputSchema.parse(rawInput);
    const node = memoryHostRef.store.addNode({
      nodeType: parsed.nodeType,
      category: parsed.category,
      characterId: characterCore.profile.identity().characterId,
      text: parsed.text,
      ...(parsed.importance === undefined ? {} : { importance: parsed.importance }),
      ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
      ...(parsed.emotionWeight === undefined ? {} : { emotionWeight: parsed.emotionWeight }),
      ...(parsed.emotionValence === undefined ? {} : { emotionValence: parsed.emotionValence }),
      ...(parsed.entityKey === undefined ? {} : { entityKey: parsed.entityKey }),
      ...(parsed.entityDisplayName === undefined ? {} : { entityDisplayName: parsed.entityDisplayName }),
      ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned }),
    });
    characterCore.profile.updateMemoryRef({
      pinnedCount: memoryHostRef.store.allNodes().filter((n) => n.pinned).length,
    });
    return { ok: true, node };
  });
  ipcMain.handle('v2:memory-query', (_e, rawInput: unknown) => {
    if (!memoryHostRef) return { ok: false, error: '记忆宿主尚未就绪', hits: [], context: '' };
    const parsed = MemoryQueryInputSchema.parse(rawInput);
    const hits = retrieve(memoryHostRef.store, parsed.query, {
      topN: parsed.topN,
      currentEmotionValence: characterCore.emotion.current().valence,
      recordRecall: parsed.recordRecall,
      ...(parsed.categories === undefined ? {} : { categories: parsed.categories }),
    });
    return {
      ok: true,
      context: formatMemoryContext(hits),
      hits: hits.map((h) => ({
        id: h.node.id,
        category: h.node.category ?? 'episodic',
        text: h.node.text,
        certainty: h.certainty,
        score: Number(h.score.toFixed(3)),
        reasons: h.reasons,
      })),
    };
  });
  ipcMain.handle('v2:memory-consolidate', (_e, rawInput?: unknown) => {
    if (!memoryHostRef) return { ok: false, error: '记忆宿主尚未就绪', impressions: [] };
    const parsed = MemoryConsolidateInputSchema.parse(rawInput ?? {});
    const impressions = memoryHostRef.store.consolidateRelationalImpressions({
      ...(parsed.entityKey === undefined ? {} : { entityKey: parsed.entityKey }),
      ...(parsed.minInteractions === undefined ? {} : { minInteractions: parsed.minInteractions }),
    });
    characterCore.profile.updateMemoryRef({
      lastConsolidatedAt: Date.now(),
      recentHighlights: impressions.slice(0, 5).map((i) => i.summary),
    });
    return { ok: true, impressions };
  });
  ipcMain.handle('v2:memory-correct', (_e, rawInput: unknown) => {
    if (!memoryHostRef) return { ok: false, error: '记忆宿主尚未就绪' };
    const parsed = MemoryCorrectInputSchema.parse(rawInput);
    const node = memoryHostRef.store.correctNode(parsed.nodeId, parsed.newText, parsed.reason);
    return { ok: true, node };
  });
  ipcMain.handle('v2:memory-hard-delete', (_e, rawInput: unknown) => {
    if (!memoryHostRef) return { deleted: false, blockedReason: 'MEMORY_NOT_READY' };
    const parsed = MemoryHardDeleteInputSchema.parse(rawInput);
    const result = memoryHostRef.store.hardDelete(parsed.nodeId, {
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      onDeleteLedgerRef: (entityKey) => {
        const uid = entityKey.replace(/^(viewer|person|user):/, '');
        const dbPath = join(options.userDataDir, 'workbench.db');
        const opened = openSqliteStoreWithRecovery(dbPath);
        try {
          return opened.store.deleteViewerByUid(uid) > 0;
        } finally {
          opened.store.close();
        }
      },
    });
    return result;
  });
  ipcMain.handle('v2:memory-deletion-audits', () =>
    memoryHostRef ? memoryHostRef.store.deletionAudits() : [],
  );
  // V2-P2-03：MediaGenerationGateway 与候选区审查隔离 IPC
  const mediaGateway = new MediaGenerationGateway({
    userDataDir: options.userDataDir,
    vaultPath: options.vaultPath,
    homeDir: process.env['HOME'] ?? '',
  });
  ipcMain.handle('v2:media-providers', (_e, descriptors?: ImageGenProviderDescriptor[]) =>
    mediaGateway.probeProviders(Array.isArray(descriptors) ? descriptors : []),
  );
  ipcMain.handle('v2:media-jobs', (_e, characterId?: string) =>
    mediaGateway.listJobs(typeof characterId === 'string' && characterId !== '' ? characterId : undefined),
  );
  ipcMain.handle('v2:media-submit', async (_e, rawInput: unknown) => {
    try {
      const job = await mediaGateway.submitImageJob(rawInput);
      return { ok: true, job };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:media-review', (_e, rawInput: {
    jobId: string;
    candidateId: string;
    decision: 'approve' | 'reject';
    note?: string;
    license?: string;
    allowCommercial?: boolean;
    allowLivestream?: boolean;
  }) => mediaGateway.reviewCandidate(rawInput));
  ipcMain.handle('v2:media-cancel', (_e, jobId: string) => mediaGateway.cancelJob(String(jobId)));
  // V2-P2-04：3D 大模型生成与 Blender / VRM 质检管线 IPC
  const pipeline3d = new Pipeline3dManager({
    userDataDir: options.userDataDir,
    vaultPath: options.vaultPath,
  });
  ipcMain.handle('v2:3d-toolchain', () => pipeline3d.detectToolchain());
  ipcMain.handle('v2:3d-jobs', (_e, characterId?: string) =>
    pipeline3d.listJobs(typeof characterId === 'string' && characterId !== '' ? characterId : undefined),
  );
  ipcMain.handle('v2:3d-submit', async (_e, rawInput: unknown) => {
    try {
      const job = await pipeline3d.runJob(rawInput);
      return { ok: true, job };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:3d-review', (_e, rawInput: { jobId: string; decision: 'approve' | 'reject'; note?: string }) =>
    pipeline3d.reviewJob(rawInput),
  );
  // V2-P2-05：Character Bible、2D/Live2D 质检与 CrossPet 全量合法导入 IPC
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const packsRoot =
    options.packsRoot ??
    resolvePetPacksDir({
      isPackaged: typeof app?.isPackaged === 'boolean' ? app.isPackaged : false,
      resourcesPath: process.resourcesPath ?? '',
      repoRoot: resolve(hereDir, '../../../..'),
    });
  const studioV2 = new CharacterStudioV2({
    userDataDir: options.userDataDir,
    packsRoot,
  });
  ipcMain.handle('v2:bible-list', () => studioV2.bibles.list());
  ipcMain.handle('v2:bible-get', (_e, characterId: string) =>
    studioV2.bibles.get(String(characterId ?? '')),
  );
  ipcMain.handle('v2:bible-upsert', (_e, rawInput: unknown) => {
    try {
      return { ok: true, bible: studioV2.bibles.upsert(rawInput) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:bible-attach-ref', (_e, rawInput: unknown) => {
    try {
      return { ok: true, bible: studioV2.bibles.attachReference(rawInput) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:bible-promote-job', async (_e, rawInput: {
    characterId: string;
    jobId: string;
    role?: 'front' | 'side' | 'back' | 'portrait' | 'sheet';
  }) => {
    try {
      return await studioV2.bibles.promoteFromMediaJob(
        String(rawInput.characterId ?? ''),
        mediaGateway,
        String(rawInput.jobId ?? ''),
        rawInput.role ?? 'portrait',
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:2d-inspect', (_e, targetPath: string) =>
    inspectLive2dOrLayered2d(String(targetPath ?? '')),
  );
  ipcMain.handle('v2:2d-register', (_e, rawInput: {
    packageId?: string;
    characterId: string;
    displayName: string;
    kind: 'live2d' | 'layered-2d' | 'sprite-2d' | 'crosspet-import';
    rootDir: string;
    provenance: Parameters<CharacterStudioV2['register2dPackage']>[0]['provenance'];
    poseCount?: number;
  }) => {
    try {
      return { ok: true, pkg: studioV2.register2dPackage(rawInput) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:2d-list', (_e, characterId?: string) =>
    studioV2.list2dPackages(typeof characterId === 'string' && characterId !== '' ? characterId : undefined),
  );
  ipcMain.handle('v2:2d-check-distribution', (_e, rawInput: {
    packageId: string;
    channel: 'local_personal' | 'livestream_public' | 'commercial_distribution' | 'redistribution';
  }) => {
    try {
      return { ok: true, check: studioV2.check2dDistribution(String(rawInput.packageId ?? ''), rawInput.channel) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:crosspet-import', (_e, rawInput?: unknown) => {
    try {
      return { ok: true, result: studioV2.importCrossPetPack(rawInput ?? {}) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // V2-P2-06：11 步像素精灵流水线与 Stardew Avatar Mod 导出核验 IPC
  const pixelPipeline = new PixelAvatarPipelineV2({
    userDataDir: options.userDataDir,
    repoRoot: resolve(hereDir, '../../../..'),
    bibles: studioV2.bibles,
  });
  ipcMain.handle('v2:pixel-jobs', (_e, characterId?: string) =>
    pixelPipeline.listJobs(typeof characterId === 'string' && characterId !== '' ? characterId : undefined),
  );
  ipcMain.handle('v2:pixel-run', (_e, rawInput: unknown) => {
    try {
      return { ok: true, job: pixelPipeline.run11StepPipeline(rawInput) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:pixel-review', (_e, rawInput: { jobId: string; decision: 'approve' | 'reject'; note?: string }) =>
    pixelPipeline.reviewJob(rawInput),
  );
  ipcMain.handle('v2:pixel-export-stardew', (_e, rawInput: {
    jobId: string;
    modsDir?: string;
    profileModsDir?: string;
    installModIfMissing?: boolean;
  }) => {
    try {
      return pixelPipeline.exportToStardew(rawInput);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:pixel-verify-stardew', (_e, modsDir?: string) =>
    pixelPipeline.verifyExport(typeof modsDir === 'string' && modsDir !== '' ? modsDir : undefined),
  );
  // V2-P2-07：十态 AssetRegistry、舞台/场景/声音资产创作、商业清源与版本回滚 IPC
  const assetRegistry = new AssetRegistryV2({ userDataDir: options.userDataDir });
  ipcMain.handle('v2:asset-list', (_e, filter?: { characterId?: string; category?: Parameters<AssetRegistryV2['listAssets']>[0] extends infer T ? T extends { category?: infer C } ? C : never : never }) =>
    assetRegistry.listAssets(filter),
  );
  ipcMain.handle('v2:asset-get', (_e, assetId: string) =>
    assetRegistry.getAsset(String(assetId ?? '')),
  );
  ipcMain.handle('v2:asset-register', (_e, rawInput: Parameters<AssetRegistryV2['registerVersion']>[0]) => {
    try {
      return { ok: true, ...assetRegistry.registerVersion(rawInput) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:asset-transition', (_e, rawInput: Parameters<AssetRegistryV2['transitionStatus']>[0]) =>
    assetRegistry.transitionStatus(rawInput),
  );
  ipcMain.handle('v2:asset-verify', (_e, rawInput: { assetId: string; versionId?: string }) => {
    try {
      return { ok: true, check: assetRegistry.verifyIntegrity(String(rawInput.assetId ?? ''), rawInput.versionId) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:asset-rollback', (_e, rawInput: Parameters<AssetRegistryV2['rollbackAsset']>[0]) =>
    assetRegistry.rollbackAsset(rawInput),
  );
  ipcMain.handle('v2:asset-export-clean', (_e, rawInput: { outputDir?: string; channel?: Parameters<AssetRegistryV2['exportCleanBundle']>[0]['channel']; assetIds?: string[] }) => {
    try {
      const outputDir =
        rawInput?.outputDir && rawInput.outputDir.trim() !== ''
          ? rawInput.outputDir
          : join(options.userDataDir, 'clean-exports', `bundle-${Date.now().toString(36)}`);
      return {
        ok: true,
        result: assetRegistry.exportCleanBundle({
          outputDir,
          ...(rawInput?.channel ? { channel: rawInput.channel } : {}),
          ...(rawInput?.assetIds ? { assetIds: rawInput.assetIds } : {}),
        }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:stage-scene-create', (_e, rawInput: { outputPath?: string; theme?: StageSceneTheme; width?: number; height?: number }) => {
    try {
      const outputPath =
        rawInput?.outputPath && rawInput.outputPath.trim() !== ''
          ? rawInput.outputPath
          : join(options.userDataDir, 'studio-generated', `stage-${Date.now().toString(36)}.png`);
      return {
        ok: true,
        ...createProceduralStageScenePng({
          outputPath,
          ...(rawInput?.theme ? { theme: rawInput.theme } : {}),
          ...(rawInput?.width ? { width: rawInput.width } : {}),
          ...(rawInput?.height ? { height: rawInput.height } : {}),
        }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:sound-sfx-create', (_e, rawInput: { outputPath?: string; preset?: SfxPreset; durationMs?: number; sampleRate?: number }) => {
    try {
      const outputPath =
        rawInput?.outputPath && rawInput.outputPath.trim() !== ''
          ? rawInput.outputPath
          : join(options.userDataDir, 'studio-generated', `sfx-${Date.now().toString(36)}.wav`);
      return {
        ok: true,
        ...synthesizeSfxWav({
          outputPath,
          ...(rawInput?.preset ? { preset: rawInput.preset } : {}),
          ...(rawInput?.durationMs ? { durationMs: rawInput.durationMs } : {}),
          ...(rawInput?.sampleRate ? { sampleRate: rawInput.sampleRate } : {}),
        }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // V2-P2-08：星露谷人机联机协作 CoopRuntime v1 IPC
  ipcMain.handle('v2:coop-snapshot', () => coopRuntime.snapshot());
  ipcMain.handle('v2:coop-room-create', (_e, rawInput: {
    roomId?: string;
    gameId?: 'stardew' | 'terraria' | 'dst';
    sharedGoal: string;
  }) => {
    try {
      return { ok: true, snapshot: coopRuntime.createRoom(rawInput) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:coop-participant-join', (_e, rawInput: Parameters<CoopRuntimeV1['joinParticipant']>[0]) => {
    try {
      const participant = coopRuntime.joinParticipant(rawInput);
      return { ok: true, participant, snapshot: coopRuntime.snapshot() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:coop-task-action', (_e, rawInput: {
    action: 'propose' | 'accept' | 'start' | 'handoff' | 'outcome';
    taskId?: string;
    title?: string;
    goal?: string;
    ownerId?: string;
    toParticipantId?: string;
    preconditions?: string[];
    resourceLocks?: string[];
    priority?: number;
    note?: string;
    receipt?: 'COMPLETED' | 'FAILED' | 'UNCERTAIN';
    resultSummary?: string;
  }) => {
    try {
      if (rawInput.action === 'propose') {
        const task = coopRuntime.proposeTask({
          ...(rawInput.taskId ? { taskId: rawInput.taskId } : {}),
          title: String(rawInput.title ?? ''),
          goal: String(rawInput.goal ?? ''),
          ownerId: String(rawInput.ownerId ?? ''),
          ...(rawInput.preconditions ? { preconditions: rawInput.preconditions } : {}),
          ...(rawInput.resourceLocks ? { resourceLocks: rawInput.resourceLocks } : {}),
          ...(rawInput.priority ? { priority: rawInput.priority } : {}),
        });
        return { ok: true, task, snapshot: coopRuntime.snapshot() };
      }
      if (rawInput.action === 'accept') {
        const res = coopRuntime.acceptTask(String(rawInput.taskId ?? ''), rawInput.ownerId);
        return { ...res, snapshot: coopRuntime.snapshot() };
      }
      if (rawInput.action === 'start') {
        const res = coopRuntime.startTask(String(rawInput.taskId ?? ''));
        return { ...res, snapshot: coopRuntime.snapshot() };
      }
      if (rawInput.action === 'handoff') {
        const res = coopRuntime.handoffTask(
          String(rawInput.taskId ?? ''),
          String(rawInput.toParticipantId ?? ''),
          rawInput.note,
        );
        return { ...res, snapshot: coopRuntime.snapshot() };
      }
      const res = coopRuntime.reportTaskOutcome(
        String(rawInput.taskId ?? ''),
        rawInput.receipt ?? 'FAILED',
        String(rawInput.resultSummary ?? ''),
      );
      return { ...res, snapshot: coopRuntime.snapshot() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:coop-resource-reserve', (_e, rawInput: Parameters<CoopRuntimeV1['reserveResource']>[0]) =>
    coopRuntime.reserveResource(rawInput),
  );
  ipcMain.handle('v2:coop-resource-check', (_e, rawInput: {
    participantId: string;
    resourceKey: string;
    action: 'use' | 'sell' | 'harvest';
  }) => coopRuntime.checkResourceAccess(String(rawInput.participantId ?? ''), String(rawInput.resourceKey ?? ''), rawInput.action));
  ipcMain.handle('v2:coop-mod-compat', async (_e, rawInput?: { hostModsDir?: string; peerModsDir?: string }) => {
    try {
      const hostDir =
        rawInput?.hostModsDir && rawInput.hostModsDir.trim() !== ''
          ? rawInput.hostModsDir
          : guessModsDirs(process.platform, process.env.HOME ?? '').find((d) => existsSync(d));
      if (!hostDir) {
        return { ok: false, error: '未检测到本机星露谷 Mods 目录' };
      }
      const hostScan = await scanModsDir(hostDir);
      const peerDir = rawInput?.peerModsDir && rawInput.peerModsDir.trim() !== '' ? rawInput.peerModsDir : hostDir;
      const peerScan = peerDir === hostDir ? hostScan : await scanModsDir(peerDir);
      const toSummary = (mods: typeof hostScan.mods) =>
        mods.map((m) => ({
          uniqueId: m.uniqueId || m.folderName,
          name: m.name || m.folderName,
          version: m.version || '0.0.0',
          enabled: m.enabled,
          contentType: m.contentType,
        }));
      const report = evaluateCoopModsCompatibility({
        hostMods: toSummary(hostScan.mods),
        peerMods: toSummary(peerScan.mods),
        hostModsDir: hostDir,
        peerModsDir: peerDir,
      });
      coopRuntime.recordCompatReport(report);
      return { ok: true, report };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:coop-recovery', (_e, rawInput: {
    action: 'heartbeat' | 'disconnect' | 'tick' | 'reconnect';
    participantId?: string;
    reason?: string;
  }) => {
    if (rawInput.action === 'heartbeat') {
      const ok = coopRuntime.recordHeartbeat(String(rawInput.participantId ?? ''));
      return { ok, snapshot: coopRuntime.snapshot() };
    }
    if (rawInput.action === 'disconnect') {
      const p = coopRuntime.markDisconnected(String(rawInput.participantId ?? ''), rawInput.reason);
      return { ok: p !== null, snapshot: coopRuntime.snapshot(), detail: p };
    }
    if (rawInput.action === 'tick') {
      const detail = coopRuntime.tickRecovery();
      return { ok: true, snapshot: coopRuntime.snapshot(), detail };
    }
    const res = coopRuntime.reconnectParticipant(String(rawInput.participantId ?? ''));
    return { ...res, snapshot: coopRuntime.snapshot() };
  });
  // V2-P3-01：统一表演系统（SingEngine SVS/SVC + 歌词时钟 + 舞蹈 + StageRuntime）
  ipcMain.handle('v2:perf-snapshot', async () => ({
    performance: performanceDirector.snapshot(),
    stage: stageRuntime.snapshot(),
    singBackends: await singEngine.probeBackends(),
  }));
  ipcMain.handle('v2:perf-silence-check', (_e, rawInput?: SilenceContextInput & { quietCompanionMode?: boolean }) => {
    if (typeof rawInput?.quietCompanionMode === 'boolean') {
      performanceDirector.setQuietCompanionMode(rawInput.quietCompanionMode);
    }
    return performanceDirector.decideSpeechSilence(rawInput ?? {});
  });
  ipcMain.handle('v2:perf-speech-plan', (_e, rawInput: { plan: SpeechPerformancePlanInput; silenceContext?: SilenceContextInput }) => {
    try {
      const outcome = performanceDirector.planSpeech(rawInput.plan, rawInput.silenceContext ?? {});
      if (outcome.speaking) {
        stageRuntime.startSpeech(outcome.plan);
        if (outcome.lipFrames[0]) {
          stageRuntime.applyLipSync(outcome.lipFrames[0]);
        }
      }
      return {
        ok: true,
        ...outcome,
        stage: stageRuntime.snapshot(),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:perf-sing-start', async (_e, rawInput: { request: SingRequestInput; danceRoutine?: DanceRoutineInput }) => {
    try {
      const outcome = await performanceDirector.startSinging(rawInput.request, rawInput.danceRoutine);
      if (outcome.ok) {
        stageRuntime.startSinging(
          rawInput.request.song.songId,
          outcome.snapshot.lyrics,
          Boolean(rawInput.danceRoutine),
        );
        stageRuntime.applyLipSync(outcome.snapshot.lipSync);
      }
      return {
        ...outcome,
        stage: stageRuntime.snapshot(),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:perf-tick', (_e, positionMs: number) => {
    const perf = performanceDirector.tickClock(Number(positionMs) || 0);
    stageRuntime.applyLipSync(perf.lipSync);
    stageRuntime.showLyrics(perf.lyrics);
    if (perf.activeDanceCue) {
      stageRuntime.playAnimation(perf.activeDanceCue.vrmMotionTag ?? perf.activeDanceCue.live2dMotionGroup ?? perf.activeDanceCue.poseId);
      if (perf.activeDanceCue.expressionId) {
        stageRuntime.setExpression(perf.activeDanceCue.expressionId, perf.activeDanceCue.energy);
      }
    }
    return { ok: true, performance: perf, stage: stageRuntime.snapshot() };
  });
  ipcMain.handle('v2:perf-stop', (_e, reason?: string) => {
    const why = typeof reason === 'string' && reason.trim() !== '' ? reason : 'user_stop';
    const perf = performanceDirector.stopPerformance(why);
    const stage = stageRuntime.stopPerformance(why);
    return { ok: true, performance: perf, stage };
  });
  ipcMain.handle('v2:stage-switch-backend', (_e, rawInput: { backend: StageBackendKind; binding?: unknown }) => {
    try {
      const backend = StageBackendKindSchema.parse(rawInput.backend);
      if (rawInput.binding !== undefined) {
        const parsedBinding = StageCharacterBindingSchema.parse(rawInput.binding);
        stageRuntime.registerBinding(parsedBinding);
      }
      const stage = stageRuntime.switchBackend(backend);
      return { ok: true, stage };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('v2:stage-command', (_e, rawInput: {
    action: 'load_scene' | 'set_expression' | 'play_animation' | 'set_lyrics_policy';
    scene?: unknown;
    expression?: string;
    intensity?: number;
    animationId?: string;
    lyricsPolicy?: LyricsDisplayPolicyInput;
  }) => {
    try {
      if (rawInput.action === 'load_scene') {
        const scene = StageSceneSpecSchema.parse(rawInput.scene);
        return { ok: true, stage: stageRuntime.loadScene(scene) };
      }
      if (rawInput.action === 'set_expression') {
        return { ok: true, stage: stageRuntime.setExpression(String(rawInput.expression ?? 'idle'), rawInput.intensity) };
      }
      if (rawInput.action === 'play_animation') {
        return { ok: true, stage: stageRuntime.playAnimation(String(rawInput.animationId ?? 'idle')) };
      }
      const policy = performanceDirector.lyricsClock.setPolicy(rawInput.lyricsPolicy ?? {});
      const lyrics = performanceDirector.lyricsClock.snapshot();
      return { ok: true, policy, stage: stageRuntime.showLyrics(lyrics) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // V2-P3-02：LifeRuntime 驱动的直播中控与 OBS 舞台投影
  ipcMain.handle('v2:live-snapshot', () => liveRuntime.snapshot());
  ipcMain.handle('v2:live-session-start', async (_e, rawInput?: LiveSessionStartInput) => {
    const lifeRes = characterCore.life.selectActivity({
      mode: 'streaming',
      reason: '开启直播中控会话',
      source: 'user_command',
    });
    if (!lifeRes.accepted) {
      return { ok: false, error: `LifeRuntime 拒绝开播：${lifeRes.reason ?? 'unknown'}`, snapshot: liveRuntime.snapshot() };
    }
    const res = await liveRuntime.startSession(rawInput ?? {});
    if (res.ok) {
      stageRuntime.loadScene({
        sceneId: res.snapshot.obsStage.sceneId,
        title: 'OBS 透明直播舞台',
        transparentBackground: true,
        lightingPreset: 'concert_neon',
      });
    }
    return res;
  });
  ipcMain.handle('v2:live-session-end', (_e, reason?: string) => {
    performanceDirector.stopPerformance(reason ?? 'live_ended');
    stageRuntime.stopPerformance(reason ?? 'live_ended');
    const summary = liveRuntime.endSession(reason ?? 'live_ended');
    characterCore.life.selectActivity({
      mode: 'companion',
      reason: '下播恢复桌面陪伴',
      source: 'life_runtime',
    });
    return { ok: true, summary, snapshot: liveRuntime.snapshot() };
  });
  ipcMain.handle('v2:live-ingest', (_e, rawInput: { event: unknown; flush?: boolean }) => {
    const ingested = liveRuntime.ingestEvent(rawInput.event);
    const flushed = rawInput.flush === true ? (liveRuntime.flushGiftThanks() ?? ingested.flushedBatch) : ingested.flushedBatch;
    return {
      ok: ingested.outcome.status !== 'rejected',
      outcome: ingested.outcome,
      ...(ingested.songItem ? { songItem: ingested.songItem } : {}),
      ...(flushed ? { flushedBatch: flushed } : {}),
      snapshot: liveRuntime.snapshot(),
    };
  });
  ipcMain.handle('v2:live-song-request', async (_e, rawInput: LiveSongRequestInput & { autoPerform?: boolean }) => {
    try {
      const item = liveRuntime.requestSong(rawInput);
      let singingStarted = false;
      if (rawInput.autoPerform && item.rightsAllowed) {
        const next = liveRuntime.popNextAuthorizedSong();
        if (next) {
          const singRes = await performanceDirector.startSinging({
            requestId: `live-sing-${next.item.queueId}`,
            characterId: 'char_xiaojing',
            voiceProfileId: characterCore.profile.voiceIdentity().voiceProfileId,
            mode: 'svs',
            channel: 'livestream_public',
            song: next.song,
          });
          if (singRes.ok) {
            singingStarted = true;
            stageRuntime.startSinging(next.song.songId, singRes.snapshot.lyrics, false);
            liveRuntime.updateStageOverlay({
              expression: 'singing',
              activeSongTitle: next.song.title,
              lyrics: singRes.snapshot.lyrics,
            });
          }
        }
      }
      return { ok: item.rightsAllowed, item, singingStarted, snapshot: liveRuntime.snapshot() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), snapshot: liveRuntime.snapshot() };
    }
  });
  ipcMain.handle('v2:live-obs-stage', () => {
    const perf = performanceDirector.snapshot();
    const stage = stageRuntime.snapshot();
    return liveRuntime.updateStageOverlay({
      expression: stage.expression,
      lyrics: perf.lyrics.songId ? perf.lyrics : null,
      activeSongTitle: perf.activeSongId ? (liveRuntime.snapshot().obsStage.activeSongTitle ?? perf.activeSongId) : null,
    });
  });
  ipcMain.handle('v2:live-summaries', () => liveRuntime.listSummaries());
  // V2-P3-03：受控 Browser Use、ComputerUseLease 单主控与 Per-Character Profile/AccountVault 隔离
  ipcMain.handle('v2:auto-snapshot', () => browserRuntime.snapshot(accountVault));

  // ---- V2-P3-04E：Digital Life L1 IPC（只读浏览会话 + 能力矩阵 + 内容理解）----
  const socialError = (error: unknown): { ok: false; error: string } => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  ipcMain.handle('v2:social-snapshot', () => ({
    sessions: socialRuntime.listSessions(),
    capabilities: socialCapabilitiesStore.get().entries,
    autonomyLevel: 'l1_readonly' as const,
  }));
  ipcMain.handle('v2:social-capability-upsert', (_e, rawInput: unknown) => {
    const entry = SocialPlatformCapabilityEntrySchema.parse(rawInput);
    const entries = [...socialCapabilitiesStore.get().entries];
    const idx = entries.findIndex((item) => item.platform === entry.platform && item.capability === entry.capability);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    socialCapabilitiesStore.update({ entries });
    socialRuntime.updateCapabilities(entries);
    return { ok: true as const, entries };
  });
  ipcMain.handle('v2:social-plan', (_e, rawInput: unknown) => {
    const parsed = SocialPlanInputSchema.parse(rawInput);
    try {
      return { ok: true as const, session: socialRuntime.planSession(parsed) };
    } catch (error) {
      return socialError(error);
    }
  });
  ipcMain.handle('v2:social-start', (_e, sessionId: unknown) => {
    try {
      return { ok: true as const, session: socialRuntime.startSession(String(sessionId ?? '')) };
    } catch (error) {
      return socialError(error);
    }
  });
  ipcMain.handle('v2:social-pause', (_e, sessionId: unknown) => {
    try {
      return { ok: true as const, session: socialRuntime.pause(String(sessionId ?? '')) };
    } catch (error) {
      return socialError(error);
    }
  });
  ipcMain.handle('v2:social-complete', (_e, sessionId: unknown) => {
    try {
      return { ok: true as const, session: socialRuntime.complete(String(sessionId ?? '')) };
    } catch (error) {
      return socialError(error);
    }
  });
  ipcMain.handle('v2:social-abort', (_e, rawInput: unknown) => {
    const parsed = z.object({
      sessionId: z.string().min(1),
      reason: z.enum(['user_stopped', 'handoff_timeout', 'quiet_hours', 'error']).default('user_stopped'),
    }).parse(rawInput);
    try {
      return { ok: true as const, session: socialRuntime.abort(parsed.sessionId, parsed.reason) };
    } catch (error) {
      return socialError(error);
    }
  });
  ipcMain.handle('v2:social-record-viewed', (_e, rawInput: unknown) => {
    const parsed = z.object({ sessionId: z.string().min(1), candidate: BrowseCandidateSchema }).parse(rawInput);
    try {
      return { ok: true as const, session: socialRuntime.recordViewed(parsed.sessionId, parsed.candidate) };
    } catch (error) {
      return socialError(error);
    }
  });
  // 内容理解 + 兴趣沉淀：模型/网页文本一律按不可信数据处理；网关未就绪 → 诚实报错安全暂停
  ipcMain.handle('v2:social-understand', async (_e, rawInput: unknown) => {
    const parsed = SocialUnderstandInputSchema.parse(rawInput);
    try {
      const understanding = await understandingPipeline.understand(parsed);
      const memoryPort: InterestMemoryPort | undefined = memoryHostRef
        ? { addNode: (input) => memoryHostRef!.store.addNode(input) }
        : undefined;
      const sink = new InterestSink({
        characterId: 'char_xiaojing',
        preferences: characterCore.preferences,
        ...(memoryPort ? { memory: memoryPort } : {}),
      });
      const signals = sink.ingest(understanding);
      return { ok: true as const, understanding, signals };
    } catch (error) {
      return socialError(error);
    }
  });

  ipcMain.handle('v2:auto-account-register', (_e, rawInput: {
    accountId?: string;
    characterId: string;
    platform: string;
    username: string;
    plainSecret: string;
    expiresAt?: number | null;
  }) => accountVault.registerAccount(rawInput));
  ipcMain.handle('v2:auto-profile-ensure', (_e, rawInput: {
    profileId?: string;
    characterId: string;
    accountId: string;
  }) => browserProfiles.createOrGetProfile({ ...rawInput, accountVault }));
  ipcMain.handle('v2:auto-profile-cookies', (_e, rawInput: {
    action: 'set' | 'read';
    profileId: string;
    characterId: string;
    origin?: string;
    cookieKey?: string;
    cookieVal?: string;
  }) => {
    if (rawInput.action === 'set') {
      return browserProfiles.setOriginCookie(
        rawInput.profileId,
        rawInput.characterId,
        String(rawInput.origin ?? ''),
        String(rawInput.cookieKey ?? ''),
        String(rawInput.cookieVal ?? ''),
      );
    }
    return browserProfiles.readCookies(rawInput.profileId, rawInput.characterId);
  });
  ipcMain.handle('v2:auto-browser-exec', async (_e, rawReq: BrowserTaskRequestInput) => {
    try {
      return await browserRuntime.executeTask(rawReq);
    } catch (err) {
      return {
        ok: false,
        taskId: String((rawReq as { taskId?: string })?.taskId ?? 'invalid'),
        strategyUsed: 'deterministic_dom',
        pauseReason: 'runner_unavailable',
        requiresHumanHandoff: false,
        detail: err instanceof Error ? err.message : String(err),
        profileDir: '',
        runner: { engine: 'none', status: 'runner_unavailable', detail: '请求解析失败', stepCount: 0, pageTextChars: 0, injectionSignals: [] },
        handoff: null,
      };
    }
  });
  ipcMain.handle('v2:auto-lease', (_e, rawInput: {
    action: 'acquire' | 'heartbeat' | 'release' | 'human_input' | 'release_human';
    deviceId?: string;
    holderId?: string;
    characterId?: string;
    purpose?: string;
    leaseId?: string;
    ttlMs?: number;
    reason?: string;
  }) => {
    if (rawInput.action === 'acquire') {
      return computerLeaseMgr.acquireLease({
        ...(rawInput.deviceId ? { deviceId: rawInput.deviceId } : {}),
        holderId: String(rawInput.holderId ?? 'agent'),
        characterId: String(rawInput.characterId ?? 'char_xiaojing'),
        purpose: String(rawInput.purpose ?? 'automation'),
        ...(rawInput.ttlMs ? { ttlMs: rawInput.ttlMs } : {}),
      });
    }
    if (rawInput.action === 'heartbeat') {
      return computerLeaseMgr.heartbeat(String(rawInput.leaseId ?? ''), rawInput.ttlMs);
    }
    if (rawInput.action === 'release') {
      return { ok: computerLeaseMgr.releaseLease(String(rawInput.leaseId ?? ''), rawInput.holderId) };
    }
    if (rawInput.action === 'human_input') {
      return { ok: true, ...computerLeaseMgr.notifyHumanInput(rawInput.deviceId, rawInput.reason) };
    }
    computerLeaseMgr.releaseHumanOverride(rawInput.deviceId);
    return { ok: true };
  });
  ipcMain.handle('v2:auto-account-export', () => accountVault.exportPublicConfig());
  ipcMain.handle('v2:auto-p5-confirm', (_e, rawInput: { taskId: string; action: string; url: string }) =>
    browserRuntime.issueP5Confirmation({
      taskId: String(rawInput?.taskId ?? ''),
      action: String(rawInput?.action ?? ''),
      url: String(rawInput?.url ?? ''),
    }));
  ipcMain.handle('v2:auto-handoffs', () => browserRuntime.listHandoffs(true));
  ipcMain.handle('v2:auto-handoff-complete', (_e, handoffId: string, outcome?: 'completed' | 'cancelled') =>
    browserRuntime.completeHandoff(String(handoffId ?? ''), outcome === 'cancelled' ? 'cancelled' : 'completed'));
  ipcMain.handle('v2:auto-character-purge', (_e, characterId: string) =>
    browserRuntime.deleteCharacter(accountVault, String(characterId ?? '')));
  ipcMain.handle('v2:auto-input-status', () => ({
    monitor: inputMonitor.status(),
    executor: inputExecutor.status(),
    realOsInputEnabled: osInputEnabled,
    nativeHelper: nativeHelper.ok
      ? { ok: true, ...(nativeHelper.compileMs !== undefined ? { compileMs: nativeHelper.compileMs } : {}) }
      : { ok: false, reason: nativeHelper.reason ?? 'unknown' },
  }));
  ipcMain.handle('v2:auto-input-simulate', (_e, deviceId?: string) => ({
    ok: true,
    ...computerLeaseMgr.notifyHumanInput(deviceId, '测试注入：模拟用户物理输入'),
  }));
  ipcMain.handle('v2:auto-exec-input', (_e, rawInput: {
    leaseId?: string | null;
    step?: { kind?: string; x?: number; y?: number; text?: string; key?: string; deltaY?: number; detail?: string };
  }) => inputExecutor.execute(rawInput?.leaseId ?? null, {
    kind: (rawInput?.step?.kind ?? 'click') as 'click' | 'move' | 'type_text' | 'key' | 'scroll' | 'screenshot',
    ...(typeof rawInput?.step?.x === 'number' ? { x: rawInput.step.x } : {}),
    ...(typeof rawInput?.step?.y === 'number' ? { y: rawInput.step.y } : {}),
    ...(typeof rawInput?.step?.text === 'string' ? { text: rawInput.step.text } : {}),
    ...(typeof rawInput?.step?.key === 'string' ? { key: rawInput.step.key } : {}),
    ...(typeof rawInput?.step?.deltaY === 'number' ? { deltaY: rawInput.step.deltaY } : {}),
    ...(typeof rawInput?.step?.detail === 'string' ? { detail: rawInput.step.detail } : {}),
  }));
  // V2-P0-03：在真实 Electron 主进程内验证 node:sqlite 文件库读写、事务与完整性
  ipcMain.handle('v2:storage-check', () => {
    const dbPath = join(options.userDataDir, 'workbench.db');
    const opened = openSqliteStoreWithRecovery(dbPath);
    try {
      opened.store.runInTransaction(() => {
        opened.store.setMeta('v2_last_storage_check', new Date().toISOString());
      });
      const integrity = opened.store.checkIntegrity();
      return {
        ok: integrity.ok,
        engine: 'node:sqlite',
        schemaVersion: opened.store.getMeta('schema_version'),
        recovered: opened.recovered,
        integrity: integrity.detail,
      };
    } finally {
      opened.store.close();
    }
  });

  return {
    kernel,
    characterCore,
    audioMixer,
    voiceRouter,
    performanceDirector,
    stageRuntime,
    liveRuntime,
    computerLeaseMgr,
    browserRuntime,
    attachV1Bridges({ autodrive, voice, memory }) {
      memoryHostRef = memory ?? null;
      autodriveRef = autodrive;
      stopFn = () => {
        inputMonitor.stop();
        void autodrive.runner.emergencyStop('V2 紧急停止');
        voice.stopAll();
      };
      const unsub = autodrive.subscribe((event) => {
        const primaryId = kernel.characters.primaryState().identity.characterId;
        if (event.type === 'decision') {
          characterCore.life.selectActivity({
            mode: 'gaming',
            expression: 'gaming',
            reason: `游戏决策：${event.tool}`,
            source: 'life_runtime',
          });
        } else if (event.type === 'receipt') {
          characterCore.emotion.applyStimulus(
            event.status === 'FAILED'
              ? { deltaValence: -0.08, deltaArousal: 0.12, label: '懊恼', ttlMs: 120_000 }
              : { deltaValence: 0.05, deltaArousal: 0.02, label: '认真', ttlMs: 120_000 },
          );
          const nextExpr = event.status === 'FAILED' ? 'reacting' : 'idle';
          kernel.characters.setExpression(primaryId, nextExpr, `回执：${event.status}`);
        } else if (event.type === 'human-control') {
          characterCore.life.setControlMode(
            event.active ? 'manual_takeover' : 'autonomous',
            event.active ? '游戏内或用户接管' : '恢复托管',
          );
        }
      });
      unsubscribers.push(unsub);
    },
    async stop() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
      if (liveRuntime.snapshot().active) {
        liveRuntime.endSession('kernel_stop');
      }
      performanceDirector.stopPerformance('kernel_stop');
      stageRuntime.stopPerformance('kernel_stop');
      audioMixer.stopAll();
      characterCore.save();
      await kernel.stop();
    },
  };
}
