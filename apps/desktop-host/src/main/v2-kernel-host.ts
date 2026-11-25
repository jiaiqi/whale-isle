/**
 * Whale Isle V2 内核宿主接线（V2-P0-02）：
 * - 在 Electron 主进程启动并维护 WhaleKernel 单例
 * - 复用 provider-vault.ts 的 safeStorage 凭据库作为 SecretVaultPort，绝不重复造钥匙串逻辑
 * - 注册内置诊断插件 core-diagnostics，并将 V1 autodrive/voice 关键状态事件同步到 CharacterCore
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
  attachV1Bridges(deps: { autodrive: AutodriveHost; voice: VoiceHost }): void;
  stop(): Promise<void>;
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

  let stopFn: (() => void) | null = null;
  const unsubscribers: Array<() => void> = [];

  ipcMain.handle('v2:kernel-health', () => kernel.health());
  ipcMain.handle('v2:kernel-logs', (_e, limit = 50) => kernel.logger.recent(typeof limit === 'number' ? limit : 50));
  ipcMain.handle('v2:character-state', () => kernel.characters.primaryState());
  ipcMain.handle('v2:emergency-halt', (_e, reason?: string) => {
    stopFn?.();
    return kernel.characters.emergencyHalt(
      typeof reason === 'string' && reason.trim() !== '' ? reason : '用户在工作台触发紧急停止',
    );
  });
  ipcMain.handle('v2:resume', (_e, mode?: 'autonomous' | 'coop' | 'command' | 'manual_takeover') =>
    kernel.characters.resume(mode ?? 'autonomous'),
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
    attachV1Bridges({ autodrive, voice }) {
      stopFn = () => {
        if (autodrive.runner.isRunning()) autodrive.runner.stop();
        voice.stopAll();
      };
      const unsub = autodrive.subscribe((event) => {
        const primaryId = kernel.characters.primaryState().identity.characterId;
        if (event.type === 'decision') {
          kernel.characters.setExpression(primaryId, 'gaming', `游戏决策：${event.tool}`);
        } else if (event.type === 'receipt') {
          const nextExpr = event.status === 'FAILED' ? 'reacting' : 'idle';
          kernel.characters.setExpression(primaryId, nextExpr, `回执：${event.status}`);
        } else if (event.type === 'human-control') {
          if (event.active) kernel.characters.setControlMode(primaryId, 'manual_takeover', '游戏内或用户接管');
          else kernel.characters.setControlMode(primaryId, 'autonomous', '恢复托管');
        }
      });
      unsubscribers.push(unsub);
    },
    async stop() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
      await kernel.stop();
    },
  };
}
