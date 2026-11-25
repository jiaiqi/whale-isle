/**
 * Whale Isle V2 微内核（WhaleKernel）：
 * - 统一管理生命周期（created → starting → running → stopping → stopped）
 * - 组合 RuntimeEventBus、StructuredLogger、ConfigStore、SecretVaultPort、CharacterRegistryCore 与 PluginHost
 * - 执行插件权限硬门控（vault://* / shell://* 在插件注册即阻断，遵循运行时安全锁）
 */
import type { z } from 'zod';
import {
  PluginHost,
  PluginManifestSchema,
  type Disposable,
  type DisposableLike,
  type PluginError,
  type PluginManifest,
  type PluginManifestInput,
  type ToolResult,
  type ToolSpec,
} from '@workbench/plugin-kit';
import {
  CharacterRegistryCore,
  type CharacterIdentityInput,
  type CharacterRuntimeState,
} from './character-state';
import {
  createDefaultRuntimeConfig,
  MemoryConfigStore,
  MemorySecretVault,
  RuntimeConfigSchema,
  type ConfigStore,
  type RuntimeConfig,
  type SecretVaultPort,
  type VaultBackendKind,
} from './config-secrets';
import { normalizeError, WhaleError } from './errors';
import { RuntimeEventBus, type RuntimeEventHandler } from './event-bus';
import { StructuredLogger, type LogSink } from './logger';

export type KernelLifecycleState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface ScopedPluginApi {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly logger: StructuredLogger;
  configSnapshot(): RuntimeConfig;
  primaryCharacter(): CharacterRuntimeState;
  publish<T>(eventType: string, payload: T): void;
  subscribe<T = unknown>(pattern: string, handler: RuntimeEventHandler<T>): Disposable;
  defineTool<TSchema extends z.ZodTypeAny, TResult>(
    spec: Omit<ToolSpec<TSchema, TResult>, 'pluginId'>,
  ): void;
  effect(callback: () => DisposableLike | void): Disposable;
}

export interface KernelPluginDefinition {
  manifest: PluginManifestInput;
  setup: (api: ScopedPluginApi) => DisposableLike | DisposableLike[] | void;
}

export interface KernelHealthSnapshot {
  lifecycle: KernelLifecycleState;
  startedAt: number | null;
  uptimeMs: number;
  activeCharacter: {
    characterId: string;
    displayName: string;
    expression: string;
    controlMode: string;
    halted: boolean;
  };
  plugins: {
    total: number;
    enabled: number;
    errors: number;
  };
  vaultBackend: VaultBackendKind;
  recentLogs: number;
}

export interface WhaleKernelOptions {
  configStore?: ConfigStore<RuntimeConfig>;
  secrets?: SecretVaultPort;
  primaryCharacter?: Partial<CharacterIdentityInput>;
  logSink?: LogSink;
  now?: () => number;
}

const FORBIDDEN_RESOURCE_PREFIXES = ['vault://', 'shell://'] as const;

export class WhaleKernel {
  readonly logger: StructuredLogger;
  readonly events: RuntimeEventBus;
  readonly config: ConfigStore<RuntimeConfig>;
  readonly secrets: SecretVaultPort;
  readonly characters: CharacterRegistryCore;

  private readonly pluginHost = new PluginHost();
  private readonly now: () => number;
  private lifecycleState: KernelLifecycleState = 'created';
  private startedAt: number | null = null;

  constructor(options: WhaleKernelOptions = {}) {
    this.now = options.now ?? Date.now;
    this.config = options.configStore ?? new MemoryConfigStore(
      RuntimeConfigSchema,
      createDefaultRuntimeConfig(),
    );
    const initialConfig = this.config.get();
    this.logger = new StructuredLogger('kernel', {
      minLevel: initialConfig.logLevel,
      now: this.now,
      ...(options.logSink === undefined ? {} : { sink: options.logSink }),
    });
    this.events = new RuntimeEventBus({
      now: this.now,
      onListenerError: (type, err) => {
        const normalized = normalizeError(err);
        this.logger.error('事件监听器执行异常', { eventType: type, error: normalized.toSafeJSON() });
      },
    });
    this.secrets = options.secrets ?? new MemorySecretVault();
    this.characters = new CharacterRegistryCore(this.events, {
      ...(options.primaryCharacter === undefined ? {} : { primaryIdentity: options.primaryCharacter }),
      now: this.now,
    });
    this.config.onChange((next) => {
      this.logger.setMinLevel(next.logLevel);
      this.events.publish('config:updated', { theme: next.theme, logLevel: next.logLevel }, { source: 'config' });
    });
  }

  get lifecycle(): KernelLifecycleState {
    return this.lifecycleState;
  }

  async start(): Promise<void> {
    if (this.lifecycleState === 'running') return;
    if (this.lifecycleState === 'starting' || this.lifecycleState === 'stopping') {
      throw new WhaleError('LIFECYCLE_INVALID', `内核正处于过渡状态：${this.lifecycleState}`);
    }
    this.lifecycleState = 'starting';
    this.startedAt = this.now();
    this.logger.info('WhaleKernel 启动中', {
      activeCharacterId: this.config.get().activeCharacterId,
      vaultBackend: this.secrets.backend(),
    });
    for (const entry of this.pluginHost.list()) {
      if (!entry.enabled) {
        this.pluginHost.enable(entry.id);
      }
    }
    this.lifecycleState = 'running';
    this.events.publish('kernel:started', { startedAt: this.startedAt }, { source: 'kernel' });
    this.logger.info('WhaleKernel 已就绪', { plugins: this.pluginHost.list().length });
  }

  async stop(): Promise<void> {
    if (this.lifecycleState === 'stopped' || this.lifecycleState === 'created') {
      this.lifecycleState = 'stopped';
      return;
    }
    this.lifecycleState = 'stopping';
    this.logger.info('WhaleKernel 正在停止');
    for (const entry of [...this.pluginHost.list()].reverse()) {
      if (entry.enabled) {
        this.pluginHost.disable(entry.id);
      }
    }
    this.lifecycleState = 'stopped';
    this.events.publish('kernel:stopped', { stoppedAt: this.now() }, { source: 'kernel' });
  }

  registerPlugin(definition: KernelPluginDefinition): PluginManifest {
    const manifest = PluginManifestSchema.parse(definition.manifest);
    const forbidden = manifest.permissions.filter((perm) =>
      FORBIDDEN_RESOURCE_PREFIXES.some((prefix) => perm.resource.startsWith(prefix)),
    );
    if (forbidden.length > 0) {
      const resources = forbidden.map((p) => p.resource).join(', ');
      this.logger.warn('拒绝注册越权插件', { pluginId: manifest.id, resources });
      throw new WhaleError('PERMISSION_DENIED', `插件声明了禁止的资源前缀：${resources}`, {
        recoverable: false,
        context: { pluginId: manifest.id, resources },
      });
    }

    const pluginLogger = this.logger.child(`plugin:${manifest.id}`);
    this.pluginHost.register(manifest, (ctx) => {
      const subs: Disposable[] = [];
      const api: ScopedPluginApi = {
        id: ctx.id,
        manifest: ctx.manifest,
        logger: pluginLogger,
        configSnapshot: () => this.config.get(),
        primaryCharacter: () => this.characters.primaryState(),
        publish: (eventType, payload) => {
          this.events.publish(eventType, payload, { source: `plugin:${manifest.id}` });
        },
        subscribe: (pattern, handler) => {
          const disposable = this.events.subscribe(pattern, handler);
          subs.push(disposable);
          return disposable;
        },
        defineTool: (spec) => {
          ctx.defineTool(spec);
        },
        effect: (cb) => ctx.effect(cb),
      };
      const returned = definition.setup(api);
      const list = returned === undefined ? [] : Array.isArray(returned) ? returned : [returned];
      return [...subs, ...list];
    });

    if (!this.pluginHost.isEnabled(manifest.id)) {
      pluginLogger.error('插件启用失败并已隔离回滚', { pluginId: manifest.id });
    } else {
      this.events.publish('plugin:enabled', { pluginId: manifest.id }, { source: 'kernel' });
    }
    return manifest;
  }

  enablePlugin(id: string): boolean {
    this.pluginHost.enable(id);
    const enabled = this.pluginHost.isEnabled(id);
    if (enabled) this.events.publish('plugin:enabled', { pluginId: id }, { source: 'kernel' });
    return enabled;
  }

  disablePlugin(id: string): void {
    this.pluginHost.disable(id);
    this.events.publish('plugin:disabled', { pluginId: id }, { source: 'kernel' });
  }

  listPlugins(): Array<{ id: string; name: string; version: string; enabled: boolean; tools: string[] }> {
    return this.pluginHost.list().map((item) => ({
      id: item.id,
      name: item.manifest.name,
      version: item.manifest.version,
      enabled: item.enabled,
      tools: this.pluginHost.tools.list(item.id).map((tool) => tool.name),
    }));
  }

  pluginErrors(): readonly PluginError[] {
    return this.pluginHost.errors;
  }

  async invokeTool(name: string, rawArgs: unknown = {}): Promise<ToolResult> {
    if (name.startsWith('vault:') || name.includes('vault://')) {
      return { ok: false, error: 'PERMISSION_DENIED: 禁止直接调用密钥通道' };
    }
    const tool = this.pluginHost.tools.get(name);
    if (tool && tool.policy === 'deny') {
      return { ok: false, error: `PERMISSION_DENIED: 工具 ${name} 已被策略拒绝` };
    }
    return this.pluginHost.invokeTool(name, rawArgs);
  }

  health(): KernelHealthSnapshot {
    const primary = this.characters.primaryState();
    const plugins = this.pluginHost.list();
    return {
      lifecycle: this.lifecycleState,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt),
      activeCharacter: {
        characterId: primary.identity.characterId,
        displayName: primary.identity.displayName,
        expression: primary.expression,
        controlMode: primary.controlMode,
        halted: primary.halted,
      },
      plugins: {
        total: plugins.length,
        enabled: plugins.filter((p) => p.enabled).length,
        errors: this.pluginHost.errors.length,
      },
      vaultBackend: this.secrets.backend(),
      recentLogs: this.logger.recent(500).length,
    };
  }
}
