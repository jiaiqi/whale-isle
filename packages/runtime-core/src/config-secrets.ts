/**
 * Whale Isle V2 基础配置与安全凭据接口：
 * - ConfigStore：强类型 Zod 校验 + 原子落盘（tmp → rename）+ 坏文件安全回退
 * - SecretVaultPort：明文仅在主进程内部 resolve() 获取，对外状态永远只暴露掩码
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { WhaleError } from './errors';
import type { LogLevel } from './logger';

export const RuntimeConfigSchema = z.object({
  version: z.literal(2).default(2),
  activeCharacterId: z.string().min(1).default('char_xiaojing'),
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  voiceEnabled: z.boolean().default(true),
  emergencyHaltHotkey: z.string().default('F8'),
  featureFlags: z.record(z.string(), z.boolean()).default({}),
});

export type RuntimeConfig = z.output<typeof RuntimeConfigSchema>;
export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;

export interface ConfigStore<T extends Record<string, unknown>> {
  get(): T;
  update(patch: Partial<T>): T;
  reset(): T;
  onChange(listener: (next: T, prev: T) => void): () => void;
}

export class MemoryConfigStore<T extends Record<string, unknown>> implements ConfigStore<T> {
  private current: T;
  private readonly listeners = new Set<(next: T, prev: T) => void>();

  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly defaults: T,
    initial?: Partial<T>,
  ) {
    this.current = this.schema.parse({ ...defaults, ...(initial ?? {}) });
  }

  get(): T {
    return structuredClone(this.current);
  }

  update(patch: Partial<T>): T {
    const prev = this.current;
    const candidate = { ...prev, ...patch };
    const parsed = this.schema.safeParse(candidate);
    if (!parsed.success) {
      throw new WhaleError('CONFIG_INVALID', `配置校验失败：${parsed.error.message}`, {
        recoverable: true,
        context: { issues: parsed.error.issues.length },
      });
    }
    this.current = parsed.data;
    for (const listener of [...this.listeners]) listener(this.get(), structuredClone(prev));
    return this.get();
  }

  reset(): T {
    return this.update(this.defaults);
  }

  onChange(listener: (next: T, prev: T) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export class JsonFileConfigStore<T extends Record<string, unknown>> implements ConfigStore<T> {
  private current: T;
  private readonly listeners = new Set<(next: T, prev: T) => void>();

  constructor(
    private readonly filePath: string,
    private readonly schema: z.ZodType<T>,
    private readonly defaults: T,
  ) {
    this.current = this.loadOrDefault();
  }

  private loadOrDefault(): T {
    if (!existsSync(this.filePath)) return structuredClone(this.defaults);
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      const parsed = this.schema.safeParse(raw);
      return parsed.success ? parsed.data : structuredClone(this.defaults);
    } catch {
      return structuredClone(this.defaults);
    }
  }

  private persist(data: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.filePath);
  }

  get(): T {
    return structuredClone(this.current);
  }

  update(patch: Partial<T>): T {
    const prev = this.current;
    const parsed = this.schema.safeParse({ ...prev, ...patch });
    if (!parsed.success) {
      throw new WhaleError('CONFIG_INVALID', `配置校验失败：${parsed.error.message}`, {
        recoverable: true,
        context: { issues: parsed.error.issues.length },
      });
    }
    this.current = parsed.data;
    this.persist(this.current);
    for (const listener of [...this.listeners]) listener(this.get(), structuredClone(prev));
    return this.get();
  }

  reset(): T {
    const prev = this.current;
    this.current = structuredClone(this.defaults);
    this.persist(this.current);
    for (const listener of [...this.listeners]) listener(this.get(), structuredClone(prev));
    return this.get();
  }

  onChange(listener: (next: T, prev: T) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export function createDefaultRuntimeConfig(overrides: RuntimeConfigInput = {}): RuntimeConfig {
  return RuntimeConfigSchema.parse(overrides);
}

export type VaultBackendKind = 'keychain' | 'mock-keychain' | 'memory' | 'unavailable';

export interface SecretVaultStatus {
  backend: VaultBackendKind;
  encryptionAvailable: boolean;
  storedIds: Array<{ id: string; mask: string }>;
}

/**
 * 安全凭据接口：
 * - getStatus/has/mask 可安全用于状态查询与日志
 * - resolve() 仅限主进程内核/网关内部使用，严禁向渲染进程暴露
 */
export interface SecretVaultPort {
  backend(): VaultBackendKind;
  getStatus(ids?: readonly string[]): SecretVaultStatus;
  has(id: string): boolean;
  mask(id: string): string | null;
  set(id: string, plainSecret: string): { ok: boolean; mask?: string; error?: string };
  delete(id: string): boolean;
  resolve(id: string): string | null;
}

export function maskSecret(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length < 12) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

/** 内存凭据库：供单元测试、仿真与离线沙盒使用 */
export class MemorySecretVault implements SecretVaultPort {
  private readonly store = new Map<string, string>();

  backend(): VaultBackendKind {
    return 'memory';
  }

  getStatus(ids?: readonly string[]): SecretVaultStatus {
    const targetIds = ids ?? [...this.store.keys()];
    const storedIds = targetIds
      .filter((id) => this.store.has(id))
      .map((id) => ({ id, mask: maskSecret(this.store.get(id)!) }));
    return { backend: 'memory', encryptionAvailable: true, storedIds };
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  mask(id: string): string | null {
    const v = this.store.get(id);
    return v === undefined ? null : maskSecret(v);
  }

  set(id: string, plainSecret: string): { ok: boolean; mask?: string; error?: string } {
    const key = id.trim();
    const val = plainSecret.trim();
    if (key === '' || val === '') return { ok: false, error: '凭据 ID 与密钥均不能为空' };
    this.store.set(key, val);
    return { ok: true, mask: maskSecret(val) };
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  resolve(id: string): string | null {
    return this.store.get(id) ?? null;
  }
}

export type RuntimeLogLevel = LogLevel;
