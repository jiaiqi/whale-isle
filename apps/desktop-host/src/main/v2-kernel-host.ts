/**
 * Whale Isle V2 内核宿主接线（V2-P0-02 → V2-P1-01）：
 * - 在 Electron 主进程启动并维护 WhaleKernel 单例与 12 域 CharacterCore / LifeRuntime
 * - 复用 provider-vault.ts 的 safeStorage 凭据库作为 SecretVaultPort，绝不重复造钥匙串逻辑
 * - 注册内置诊断插件 core-diagnostics，并将 V1 autodrive/voice 关键状态事件同步到 CharacterCore & LifeRuntime
 */
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
  GoalHorizonSchema,
  GoalOriginSchema,
  LifeActivityKindSchema,
  PreferenceCategorySchema,
  type CharacterCoreSnapshot,
} from '@workbench/shared-protocol';
import { openSqliteStoreWithRecovery } from '@workbench/local-store';
import type { AutodriveHost } from './autodrive-host';
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
  attachV1Bridges(deps: { autodrive: AutodriveHost; voice: VoiceHost }): void;
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

  let stopFn: (() => void) | null = null;
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
    characterCore.life.emergencyHalt(
      typeof reason === 'string' && reason.trim() !== '' ? reason : '用户在工作台触发紧急停止',
    );
    return kernel.characters.primaryState();
  });
  ipcMain.handle('v2:resume', (_e, mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover') => {
    characterCore.life.resume(mode ?? 'autonomous');
    return kernel.characters.primaryState();
  });
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
    attachV1Bridges({ autodrive, voice }) {
      stopFn = () => {
        if (autodrive.runner.isRunning()) autodrive.runner.stop();
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
      characterCore.save();
      await kernel.stop();
    },
  };
}
