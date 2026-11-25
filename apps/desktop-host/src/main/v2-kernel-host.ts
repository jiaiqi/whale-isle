/**
 * Whale Isle V2 内核宿主接线（V2-P0-02 → V2-P1-01）：
 * - 在 Electron 主进程启动并维护 WhaleKernel 单例与 12 域 CharacterCore / LifeRuntime
 * - 复用 provider-vault.ts 的 safeStorage 凭据库作为 SecretVaultPort，绝不重复造钥匙串逻辑
 * - 注册内置诊断插件 core-diagnostics，并将 V1 autodrive/voice 关键状态事件同步到 CharacterCore & LifeRuntime
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { z } from 'zod';
import {
  createDefaultRuntimeConfig,
  JsonFileConfigStore,
  RuntimeConfigSchema,
  WhaleKernel,
  type SecretVaultPort,
  type SecretVaultStatus,
} from '@workbench/runtime-core';
import { CharacterCore, type SelectActivityInput } from '@workbench/character-core';
import {
  AudioTrackKindSchema,
  GoalHorizonSchema,
  GoalOriginSchema,
  LifeActivityKindSchema,
  MemoryCategorySchema,
  PreferenceCategorySchema,
  VoiceProviderKindSchema,
  type CharacterCoreSnapshot,
} from '@workbench/shared-protocol';
import {
  formatMemoryContext,
  retrieve,
} from '@workbench/memory-graph';
import {
  AudioMixer,
  CloudOpenAiTtsProvider,
  LocalAudioWorkerProvider,
  MiniMaxTtsProvider,
  SystemFallbackVoiceProvider,
  VoiceProviderRouter,
} from '@workbench/voice-runtime';
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
    delete: () => false, // 删除操作仍由 provider-vault IPC 统一管理
    resolve: (id: string) => readVaultKey(vaultPath, id),
  };
}

export interface V2KernelHost {
  readonly kernel: WhaleKernel;
  readonly characterCore: CharacterCore;
  readonly audioMixer: AudioMixer;
  readonly voiceRouter: VoiceProviderRouter;
  attachV1Bridges(deps: { autodrive: AutodriveHost; voice: VoiceHost; memory?: MemoryHost }): void;
  stop(): Promise<void>;
}

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
  ipcMain.handle('v2:emergency-halt', (_e, reason?: string) => {
    stopFn?.();
    audioMixer.stopAll();
    characterCore.life.emergencyHalt(
      typeof reason === 'string' && reason.trim() !== '' ? reason : '用户在工作台触发紧急停止',
    );
    return kernel.characters.primaryState();
  });
  ipcMain.handle('v2:resume', (_e, mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover') => {
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
    attachV1Bridges({ autodrive, voice, memory }) {
      memoryHostRef = memory ?? null;
      stopFn = () => {
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
      audioMixer.stopAll();
      characterCore.save();
      await kernel.stop();
    },
  };
}
