/**
 * 渲染进程 Dexie 配置库（T-M0-03）——中控台「配置即时响应」引擎。
 *
 * 边界：只允许 apps/desktop-host 渲染进程经 './dexie' 子路径导入；
 * 本文件严禁 import better-sqlite3（跨进程数据一律走主进程 IPC 网关）。
 */
import Dexie, { type Table } from 'dexie';

export interface DirectorConfigRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface UiStateRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class DirectorDexie extends Dexie {
  directorConfigs!: Table<DirectorConfigRow, string>;
  uiStates!: Table<UiStateRow, string>;

  constructor(databaseName = 'ai-vtuber-director') {
    super(databaseName);
    this.version(1).stores({
      directorConfigs: 'key',
      uiStates: 'key',
    });
  }
}

export interface DirectorStore {
  setConfig(key: string, value: unknown): Promise<void>;
  getConfig<T = unknown>(key: string): Promise<T | undefined>;
  deleteConfig(key: string): Promise<void>;
  /** 全量快照（供启动时一次性 hydrate） */
  snapshotConfigs(): Promise<Record<string, unknown>>;
  setUiState(key: string, value: unknown): Promise<void>;
  getUiState<T = unknown>(key: string): Promise<T | undefined>;
}

export function createDirectorStore(db: DirectorDexie = new DirectorDexie()): DirectorStore {
  const stamp = () => Date.now();
  return {
    async setConfig(key, value) {
      await db.directorConfigs.put({ key, value, updatedAt: stamp() });
    },
    async getConfig<T>(key: string) {
      const row = await db.directorConfigs.get(key);
      return row?.value as T | undefined;
    },
    async deleteConfig(key) {
      await db.directorConfigs.delete(key);
    },
    async snapshotConfigs() {
      const rows = await db.directorConfigs.toArray();
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
    async setUiState(key, value) {
      await db.uiStates.put({ key, value, updatedAt: stamp() });
    },
    async getUiState<T>(key: string) {
      const row = await db.uiStates.get(key);
      return row?.value as T | undefined;
    },
  };
}
