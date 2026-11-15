/**
 * 主进程 SQLite 单点事实源（T-M0-03）。
 *
 * 表：grudge_ledger（常客记仇/好感账本）、token_ledger（Token 消耗流水，1 粒米 = 1 Token）、
 *     song_cache_index（点歌缓存索引）、meta（契约/Schema 版本）。
 * 隐私合规：观众侧数据提供一键擦除（wipeAllViewers）；开发期重置用 wipeAllData。
 *
 * 边界：只允许被 apps/desktop-host 主进程组装；渲染进程严禁 import 本文件
 * （dependency-cruiser: renderer-no-sqlite），渲染侧一律走 './dexie' 子路径 + IPC 网关。
 */
import Database from 'better-sqlite3';

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
  private db: Database.Database;

  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    // WAL 只对文件库有意义（内存库开启无效且产生噪音）
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  // ---- meta ----
  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare<string, { value: string }>('SELECT value FROM meta WHERE key = ?').get(key);
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
      .prepare<[string, string], Record<string, unknown>>(
        'SELECT * FROM grudge_ledger WHERE platform = ? AND uid = ?',
      )
      .get(platform, uid);
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
    return info.changes > 0;
  }

  /** 隐私合规：一键擦除全部观众记忆（下播后可选执行） */
  wipeAllViewers(): number {
    return this.db.prepare('DELETE FROM grudge_ledger').run().changes;
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
    return this.db.prepare('DELETE FROM token_ledger').run().changes;
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
  hitSongCache(cacheKey: string): SongCacheEntry & { hitCount: number } | null {
    const row = this.db
      .prepare<string, Record<string, unknown>>('SELECT * FROM song_cache_index WHERE cache_key = ?')
      .get(cacheKey);
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
    return this.db.prepare('DELETE FROM song_cache_index WHERE cache_key = ?').run(cacheKey).changes > 0;
  }

  wipeSongCache(): number {
    return this.db.prepare('DELETE FROM song_cache_index').run().changes;
  }

  // ---- 全量重置（开发期隐私合规总开关） ----
  wipeAllData(): void {
    this.db.exec('DELETE FROM grudge_ledger; DELETE FROM token_ledger; DELETE FROM song_cache_index;');
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
