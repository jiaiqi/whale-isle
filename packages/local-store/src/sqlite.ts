/**
 * 主进程 SQLite 单点事实源（T-M0-03 → V2-P0-03 统一迁移至内置 node:sqlite）：
 *
 * 表：grudge_ledger（常客记仇/好感账本）、token_ledger（Token 消耗流水，1 粒米 = 1 Token）、
 *     song_cache_index（点歌缓存索引）、meta（契约/Schema 版本）。
 * 隐私合规：观众侧数据提供一键擦除（wipeAllViewers）；开发期重置用 wipeAllData。
 * V2-P0-03 增强：
 *   - 零原生依赖 ABI 冲突（Electron 45 / Node 24 内置 node:sqlite DatabaseSync）；
 *   - 旧版库检测与自动备份迁移（schema_version 1 → 2，事务性升级）；
 *   - 显式事务与嵌套 Savepoint（runInTransaction）；
 *   - 完整性检查（checkIntegrity）与损坏库隔离重建（openSqliteStoreWithRecovery）及回滚（rollbackDatabaseFile）。
 *
 * 边界：只允许被 apps/desktop-host 主进程组装；渲染进程严禁 import 本文件
 * （dependency-cruiser: renderer-no-sqlite），渲染侧一律走 './dexie' 子路径 + IPC 网关。
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export const CURRENT_SQLITE_SCHEMA_VERSION = 2;

export type Platform = 'douyin' | 'bilibili' | 'local-host-input';

export interface GrudgeEntry {
  platform: Platform;
  uid: string;
  nickname?: string;
  intimacyScore?: number;
  grudgeTags?: string[];
  notes?: string;
}

export interface GrudgeView {
  platform: Platform;
  uid: string;
  nickname: string;
  intimacyScore: number;
  grudgeTags: string[];
  notes: string;
  updatedAt: number;
}

export interface TokenUsageEntry {
  ts?: number;
  /** WorkbenchRoleSlot（MAIN_PERSONA_BRAIN 等 6 槽位） */
  slot: string;
  providerId: string;
  modelId: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  purpose?: string;
}

export interface TokenUsageSummary {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** 1 粒米 = 1 Token（input + output 合计） */
  riceGrains: number;
}

export interface SongCacheEntry {
  cacheKey: string;
  songTitle: string;
  filePath: string;
  sizeBytes?: number;
}

export interface SqliteMigrationInfo {
  migratedFromLegacy: boolean;
  fromVersion: number;
  toVersion: number;
  backupPath?: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grudge_ledger (
  platform       TEXT    NOT NULL,
  uid            TEXT    NOT NULL,
  nickname       TEXT    NOT NULL DEFAULT '',
  intimacy_score INTEGER NOT NULL DEFAULT 0,
  grudge_tags    TEXT    NOT NULL DEFAULT '[]',
  notes          TEXT    NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (platform, uid)
);
CREATE TABLE IF NOT EXISTS token_ledger (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  INTEGER NOT NULL,
  slot                TEXT    NOT NULL,
  provider_id         TEXT    NOT NULL,
  model_id            TEXT    NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  rice_grains         INTEGER NOT NULL DEFAULT 0,
  purpose             TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS song_cache_index (
  cache_key   TEXT PRIMARY KEY,
  song_title  TEXT    NOT NULL,
  file_path   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_hit_at INTEGER NOT NULL,
  hit_count   INTEGER NOT NULL DEFAULT 0
);
`;

export class SqliteStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private txDepth = 0;
  private readonly _migrationInfo: SqliteMigrationInfo;

  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    const existedBeforeOpen = dbPath !== ':memory:' && existsSync(dbPath);
    this.db = new DatabaseSync(dbPath);
    this._migrationInfo = this.initializeAndMigrate(existedBeforeOpen);
  }

  get migrationInfo(): SqliteMigrationInfo {
    return { ...this._migrationInfo };
  }

  private initializeAndMigrate(existedBeforeOpen: boolean): SqliteMigrationInfo {
    const existingTables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const hasLegacyTables =
      existedBeforeOpen
      && (existingTables.has('grudge_ledger') || existingTables.has('token_ledger') || existingTables.has('song_cache_index'));

    const hasMeta = existingTables.has('meta');
    const versionRow = hasMeta
      ? (this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined)
      : undefined;
    const parsedVersion = versionRow ? Number.parseInt(versionRow.value, 10) : Number.NaN;
    const currentVersion = Number.isFinite(parsedVersion) ? parsedVersion : (hasLegacyTables ? 1 : 0);

    let backupPath: string | undefined;
    if (currentVersion < CURRENT_SQLITE_SCHEMA_VERSION && hasLegacyTables && this.dbPath !== ':memory:') {
      // 在任何写操作与 WAL 切换之前先对旧版库落盘物理快照，保证可字节级回滚
      backupPath = `${this.dbPath}.v${currentVersion}-backup.${Date.now()}.bak`;
      copyFileSync(this.dbPath, backupPath);
    }

    if (this.dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);

    if (currentVersion >= CURRENT_SQLITE_SCHEMA_VERSION) {
      return {
        migratedFromLegacy: false,
        fromVersion: currentVersion,
        toVersion: currentVersion,
      };
    }

    this.runInTransaction(() => {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_token_ledger_slot_ts ON token_ledger(slot, ts)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_grudge_ledger_score ON grudge_ledger(intimacy_score DESC, updated_at DESC)');
      this.setMeta('schema_version', String(CURRENT_SQLITE_SCHEMA_VERSION));
      if (hasLegacyTables) {
        this.setMeta('migrated_from_version', String(currentVersion));
        this.setMeta('migrated_at', new Date().toISOString());
      }
      this.db.exec(`PRAGMA user_version = ${CURRENT_SQLITE_SCHEMA_VERSION}`);
    });

    return {
      migratedFromLegacy: hasLegacyTables,
      fromVersion: currentVersion,
      toVersion: CURRENT_SQLITE_SCHEMA_VERSION,
      ...(backupPath === undefined ? {} : { backupPath }),
    };
  }

  /** 显式原子事务（支持嵌套 Savepoint）：异常自动回滚 */
  runInTransaction<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      this.db.exec('BEGIN IMMEDIATE');
    } else {
      this.db.exec(`SAVEPOINT sp_${this.txDepth}`);
    }
    const level = this.txDepth;
    this.txDepth += 1;
    try {
      const result = fn();
      if (level === 0) {
        this.db.exec('COMMIT');
      } else {
        this.db.exec(`RELEASE SAVEPOINT sp_${level}`);
      }
      return result;
    } catch (error) {
      if (level === 0) {
        this.db.exec('ROLLBACK');
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT sp_${level}`);
        this.db.exec(`RELEASE SAVEPOINT sp_${level}`);
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** 数据库物理完整性校验 */
  checkIntegrity(): { ok: boolean; detail: string } {
    const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    const detail = row?.integrity_check ?? 'unknown';
    return { ok: detail.toLowerCase() === 'ok', detail };
  }

  // ---- meta ----
  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  // ---- 常客记仇/好感账本 ----
  upsertViewer(entry: GrudgeEntry): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO grudge_ledger (platform, uid, nickname, intimacy_score, grudge_tags, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, uid) DO UPDATE SET
           nickname = CASE WHEN excluded.nickname != '' THEN excluded.nickname ELSE grudge_ledger.nickname END,
           updated_at = excluded.updated_at`,
      )
      .run(entry.platform, entry.uid, entry.nickname ?? '', entry.intimacyScore ?? 0, '[]', entry.notes ?? '', now);
  }

  addGrudgeTag(platform: Platform, uid: string, tag: string): GrudgeView | null {
    const viewer = this.getViewer(platform, uid);
    if (!viewer) return null;
    const tags = viewer.grudgeTags.includes(tag) ? viewer.grudgeTags : [...viewer.grudgeTags, tag];
    return this.writeViewer(platform, uid, { nickname: viewer.nickname, tags, intimacyDelta: 0 });
  }

  bumpIntimacy(platform: Platform, uid: string, delta: number): GrudgeView | null {
    const viewer = this.getViewer(platform, uid);
    if (!viewer) return null;
    return this.writeViewer(platform, uid, {
      nickname: viewer.nickname,
      tags: viewer.grudgeTags,
      intimacyDelta: delta,
    });
  }

  setViewerNotes(platform: Platform, uid: string, notes: string): GrudgeView | null {
    const viewer = this.getViewer(platform, uid);
    if (!viewer) return null;
    this.db
      .prepare('UPDATE grudge_ledger SET notes = ?, updated_at = ? WHERE platform = ? AND uid = ?')
      .run(notes, Date.now(), platform, uid);
    return this.getViewer(platform, uid);
  }

  getViewer(platform: Platform, uid: string): GrudgeView | null {
    const row = this.db
      .prepare('SELECT * FROM grudge_ledger WHERE platform = ? AND uid = ?')
      .get(platform, uid) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToViewer(row);
  }

  listViewers(limit = 100): GrudgeView[] {
    const rows = this.db.prepare('SELECT * FROM grudge_ledger ORDER BY intimacy_score DESC, updated_at DESC LIMIT ?').all(limit);
    return rows.map((row) => this.rowToViewer(row as Record<string, unknown>));
  }

  /** 隐私合规：擦除单个观众的全部记忆 */
  deleteViewer(platform: Platform, uid: string): boolean {
    const info = this.db.prepare('DELETE FROM grudge_ledger WHERE platform = ? AND uid = ?').run(platform, uid);
    return Number(info.changes) > 0;
  }

  /** 隐私合规：一键擦除全部观众记忆（下播后可选执行） */
  wipeAllViewers(): number {
    return Number(this.db.prepare('DELETE FROM grudge_ledger').run().changes);
  }

  // ---- Token 消耗流水（赛博饭碗） ----
  recordTokenUsage(entry: TokenUsageEntry): TokenUsageSummary {
    const input = entry.inputTokens ?? 0;
    const cached = entry.cachedInputTokens ?? 0;
    const output = entry.outputTokens ?? 0;
    const rice = input + output;
    this.db
      .prepare(
        `INSERT INTO token_ledger (ts, slot, provider_id, model_id, input_tokens, cached_input_tokens, output_tokens, rice_grains, purpose)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.ts ?? Date.now(), entry.slot, entry.providerId, entry.modelId, input, cached, output, rice, entry.purpose ?? '');
    return this.getTokenSummary(entry.slot);
  }

  getTokenSummary(slot?: string): TokenUsageSummary {
    const where = slot ? 'WHERE slot = ?' : '';
    const stmt = this.db.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(rice_grains), 0) AS riceGrains,
              COUNT(*) AS calls
       FROM token_ledger ${where}`,
    );
    const row = (slot ? stmt.get(slot) : stmt.get()) as Record<string, number>;
    return {
      calls: Number(row.calls),
      inputTokens: Number(row.inputTokens),
      cachedInputTokens: Number(row.cachedInputTokens),
      outputTokens: Number(row.outputTokens),
      riceGrains: Number(row.riceGrains),
    };
  }

  wipeTokenLedger(): number {
    return Number(this.db.prepare('DELETE FROM token_ledger').run().changes);
  }

  // ---- 点歌缓存索引 ----
  putSongCache(entry: SongCacheEntry): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO song_cache_index (cache_key, song_title, file_path, size_bytes, created_at, last_hit_at, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(cache_key) DO UPDATE SET
           song_title = excluded.song_title,
           file_path = excluded.file_path,
           size_bytes = excluded.size_bytes`,
      )
      .run(entry.cacheKey, entry.songTitle, entry.filePath, entry.sizeBytes ?? 0, now, now);
  }

  /** 命中即计时（二次点歌 <50ms 命中的统计口径，见 T-M2-03） */
  hitSongCache(cacheKey: string): (SongCacheEntry & { hitCount: number }) | null {
    const row = this.db
      .prepare('SELECT * FROM song_cache_index WHERE cache_key = ?')
      .get(cacheKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db
      .prepare('UPDATE song_cache_index SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?')
      .run(Date.now(), cacheKey);
    return {
      cacheKey: String(row.cache_key),
      songTitle: String(row.song_title),
      filePath: String(row.file_path),
      sizeBytes: Number(row.size_bytes),
      hitCount: Number(row.hit_count) + 1,
    };
  }

  deleteSongCache(cacheKey: string): boolean {
    return Number(this.db.prepare('DELETE FROM song_cache_index WHERE cache_key = ?').run(cacheKey).changes) > 0;
  }

  wipeSongCache(): number {
    return Number(this.db.prepare('DELETE FROM song_cache_index').run().changes);
  }

  // ---- 全量重置（开发期隐私合规总开关） ----
  wipeAllData(): void {
    this.runInTransaction(() => {
      this.db.exec('DELETE FROM grudge_ledger; DELETE FROM token_ledger; DELETE FROM song_cache_index;');
    });
  }

  close(): void {
    this.db.close();
  }

  private writeViewer(
    platform: Platform,
    uid: string,
    opts: { nickname: string; tags: string[]; intimacyDelta: number },
  ): GrudgeView | null {
    this.db
      .prepare(
        `UPDATE grudge_ledger
         SET nickname = ?, grudge_tags = ?, intimacy_score = intimacy_score + ?, updated_at = ?
         WHERE platform = ? AND uid = ?`,
      )
      .run(opts.nickname, JSON.stringify(opts.tags), opts.intimacyDelta, Date.now(), platform, uid);
    return this.getViewer(platform, uid);
  }

  private rowToViewer(row: Record<string, unknown>): GrudgeView {
    let tags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.grudge_tags));
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = []; // 历史脏数据容错
    }
    return {
      platform: String(row.platform) as Platform,
      uid: String(row.uid),
      nickname: String(row.nickname),
      intimacyScore: Number(row.intimacy_score),
      grudgeTags: tags,
      notes: String(row.notes),
      updatedAt: Number(row.updated_at),
    };
  }
}

export interface OpenedSqliteStoreResult {
  store: SqliteStore;
  recovered: boolean;
  backupPath?: string;
  migration: SqliteMigrationInfo;
}

/**
 * 异常恢复式打开数据库：
 * - 若文件损坏（无法打开或 PRAGMA integrity_check 失败），自动隔离旧文件（含 -wal/-shm）到 .corrupt.<ts>.bak
 * - 再创建干净健康的 SqliteStore，绝不静默丢弃而不留证
 */
export function openSqliteStoreWithRecovery(dbPath: string): OpenedSqliteStoreResult {
  if (dbPath === ':memory:') {
    const store = new SqliteStore(':memory:');
    return { store, recovered: false, migration: store.migrationInfo };
  }
  try {
    const store = new SqliteStore(dbPath);
    const integrity = store.checkIntegrity();
    if (integrity.ok) {
      return { store, recovered: false, migration: store.migrationInfo };
    }
    store.close();
    throw new Error(`SQLite integrity check failed: ${integrity.detail}`);
  } catch {
    const ts = Date.now();
    const backupPath = `${dbPath}.corrupt.${ts}.bak`;
    if (existsSync(dbPath)) renameSync(dbPath, backupPath);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
    }
    const fresh = new SqliteStore(dbPath);
    return {
      store: fresh,
      recovered: true,
      backupPath,
      migration: fresh.migrationInfo,
    };
  }
}

/** 从迁移前备份恢复数据库文件（回滚操作），同时清理残留 WAL/SHM 旁路文件 */
export function rollbackDatabaseFile(dbPath: string, backupPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`回滚备份文件不存在：${backupPath}`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
  }
  const tmpRestore = `${dbPath}.rollback.tmp`;
  copyFileSync(backupPath, tmpRestore);
  renameSync(tmpRestore, dbPath);
}
