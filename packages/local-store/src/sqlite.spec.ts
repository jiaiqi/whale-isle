import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  openSqliteStoreWithRecovery,
  rollbackDatabaseFile,
  SqliteStore,
} from './sqlite';

/** T-M0-03 & V2-P0-03 门禁断言：node:sqlite 账本读写、事务与 Savepoint、旧库迁移与回滚、损坏恢复 */

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('常客记仇/好感账本', () => {
  it('写入并读回记仇标签（去重合并）', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-1', nickname: '路过的鱼干' });
    expect(store.addGrudgeTag('douyin', 'u-1', '叫我大肥鱼的坏蛋')?.grudgeTags).toEqual([
      '叫我大肥鱼的坏蛋',
    ]);
    // 重复标签不重复入账
    store.addGrudgeTag('douyin', 'u-1', '叫我大肥鱼的坏蛋');
    expect(store.getViewer('douyin', 'u-1')?.grudgeTags).toHaveLength(1);
    // 多标签累计
    store.addGrudgeTag('douyin', 'u-1', '半夜点《学猫叫》');
    expect(store.getViewer('douyin', 'u-1')?.grudgeTags).toEqual(['叫我大肥鱼的坏蛋', '半夜点《学猫叫》']);
  });

  it('好感度 bump 与排序榜单', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-a' });
    store.upsertViewer({ platform: 'douyin', uid: 'u-b' });
    store.bumpIntimacy('douyin', 'u-a', 5);
    store.bumpIntimacy('douyin', 'u-a', 3);
    store.bumpIntimacy('douyin', 'u-b', 9);
    expect(store.getViewer('douyin', 'u-a')?.intimacyScore).toBe(8);
    const board = store.listViewers();
    expect(board[0]?.uid).toBe('u-b');
  });

  it('备注更新、未知观众返回 null', () => {
    expect(store.addGrudgeTag('douyin', 'nobody', 'x')).toBeNull();
    expect(store.bumpIntimacy('douyin', 'nobody', 1)).toBeNull();
    expect(store.getViewer('douyin', 'nobody')).toBeNull();
    store.upsertViewer({ platform: 'douyin', uid: 'u-n' });
    expect(store.setViewerNotes('douyin', 'u-n', '上次送过红烧肉')?.notes).toBe('上次送过红烧肉');
    expect(store.setViewerNotes('douyin', 'nobody', 'x')).toBeNull();
  });

  it('昵称保留策略：空昵称覆盖不冲掉旧昵称', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-2', nickname: '老粉' });
    store.upsertViewer({ platform: 'douyin', uid: 'u-2' });
    expect(store.getViewer('douyin', 'u-2')?.nickname).toBe('老粉');
  });

  it('隐私合规：单观众删除与一键擦除', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-3', grudgeTags: ['x'] });
    store.upsertViewer({ platform: 'douyin', uid: 'u-4' });
    expect(store.deleteViewer('douyin', 'u-3')).toBe(true);
    expect(store.deleteViewer('douyin', 'u-3')).toBe(false);
    expect(store.wipeAllViewers()).toBe(1);
    expect(store.listViewers()).toEqual([]);
  });

  it('grudge_tags 损坏 JSON / 非 JSON 数组的容错（返回空数组）', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-5' });
    const rawDb = (
      store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
    ).db;
    rawDb.prepare('UPDATE grudge_ledger SET grudge_tags = ? WHERE uid = ?').run('not-json', 'u-5');
    expect(store.getViewer('douyin', 'u-5')?.grudgeTags).toEqual([]);
    rawDb.prepare('UPDATE grudge_ledger SET grudge_tags = ? WHERE uid = ?').run('"str"', 'u-5');
    expect(store.getViewer('douyin', 'u-5')?.grudgeTags).toEqual([]);
    rawDb.prepare('UPDATE grudge_ledger SET grudge_tags = ? WHERE uid = ?').run('null', 'u-5');
    expect(store.getViewer('douyin', 'u-5')?.grudgeTags).toEqual([]);
  });

  it('初始好感度与备注随首次登记落库', () => {
    store.upsertViewer({
      platform: 'douyin',
      uid: 'u-init',
      nickname: '榜一',
      intimacyScore: 42,
      grudgeTags: ['初始标签'],
      notes: '投喂过豪华海鲜饭',
    });
    const viewer = store.getViewer('douyin', 'u-init');
    expect(viewer?.intimacyScore).toBe(42);
    expect(viewer?.notes).toBe('投喂过豪华海鲜饭');
  });
});

describe('Token 消耗流水（赛博饭碗）', () => {
  it('记录并按槽位汇总（1 粒米 = input + output）', () => {
    store.recordTokenUsage({
      slot: 'MAIN_PERSONA_BRAIN',
      providerId: 'deepseek-official',
      modelId: 'deepseek-reasoner',
      inputTokens: 12000,
      cachedInputTokens: 8000,
      outputTokens: 300,
      purpose: '内心戏',
    });
    const slotSummary = store.recordTokenUsage({
      slot: 'DANMAKU_FAST_ROUTER',
      providerId: 'siliconflow',
      modelId: 'qwen-turbo',
      inputTokens: 500,
      outputTokens: 100,
    });
    expect(slotSummary.riceGrains).toBe(600);
    const brain = store.getTokenSummary('MAIN_PERSONA_BRAIN');
    expect(brain.inputTokens).toBe(12000);
    expect(brain.cachedInputTokens).toBe(8000);
    expect(brain.riceGrains).toBe(12300);
    const total = store.getTokenSummary();
    expect(total.calls).toBe(2);
    expect(total.riceGrains).toBe(12900);
    expect(total.outputTokens).toBe(400);
  });

  it('饭碗流水擦除', () => {
    store.recordTokenUsage({ slot: 'VOICE_TTS_SPEECH', providerId: 'local', modelId: 'gpt-sovits-v2' });
    expect(store.wipeTokenLedger()).toBe(1);
    expect(store.getTokenSummary().calls).toBe(0);
  });
});

describe('点歌缓存索引', () => {
  it('upsert / 命中计数 / 未命中 / 删除', () => {
    const key = 'blue-whale-maid_<hash>';
    store.putSongCache({ cacheKey: key, songTitle: '晴天', filePath: 'cache/songs/a.ogg', sizeBytes: 3_200_000 });
    const first = store.hitSongCache(key);
    expect(first?.hitCount).toBe(1);
    expect(first?.songTitle).toBe('晴天');
    expect(store.hitSongCache(key)?.hitCount).toBe(2);
    expect(store.hitSongCache('missing')).toBeNull();
    store.putSongCache({ cacheKey: key, songTitle: '晴天 (Live)', filePath: 'cache/songs/b.ogg', sizeBytes: 4_000_000 });
    const updated = store.hitSongCache(key);
    expect(updated?.filePath).toBe('cache/songs/b.ogg');
    expect(updated?.hitCount).toBe(3);
    expect(store.deleteSongCache(key)).toBe(true);
    expect(store.hitSongCache(key)).toBeNull();
  });

  it('缓存擦除', () => {
    store.putSongCache({ cacheKey: 'k1', songTitle: 'a', filePath: 'p1' });
    store.putSongCache({ cacheKey: 'k2', songTitle: 'b', filePath: 'p2' });
    expect(store.wipeSongCache()).toBe(2);
  });
});

describe('隐私合规总开关与持久化', () => {
  it('wipeAllData 清空全部业务表；meta 读写正常', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-9' });
    store.recordTokenUsage({ slot: 'MAIN_PERSONA_BRAIN', providerId: 'p', modelId: 'm' });
    store.putSongCache({ cacheKey: 'k', songTitle: 's', filePath: 'f' });
    store.wipeAllData();
    expect(store.listViewers()).toEqual([]);
    expect(store.getTokenSummary().calls).toBe(0);
    expect(store.hitSongCache('k')).toBeNull();
    store.setMeta('schemaVersion', '2026-11-15');
    expect(store.getMeta('schemaVersion')).toBe('2026-11-15');
    expect(store.getMeta('absent')).toBeNull();
  });

  it('文件库 WAL 持久化：关库重开数据仍在且完整性检查通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-store-'));
    const dbPath = join(dir, 'workbench.db');
    try {
      const fileStore = new SqliteStore(dbPath);
      fileStore.upsertViewer({ platform: 'douyin', uid: 'persist-1', nickname: '常客' });
      fileStore.setMeta('lastBoot', '1');
      expect(fileStore.checkIntegrity()).toEqual({ ok: true, detail: 'ok' });
      fileStore.close();

      const reopened = new SqliteStore(dbPath);
      expect(reopened.getViewer('douyin', 'persist-1')?.nickname).toBe('常客');
      expect(reopened.getMeta('lastBoot')).toBe('1');
      expect(reopened.migrationInfo.migratedFromLegacy).toBe(false);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('V2-P0-03：事务、旧版迁移、回滚与异常恢复', () => {
  it('runInTransaction 支持提交、异常回滚与嵌套 Savepoint 回滚', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'tx-1', nickname: '初始' });

    expect(() =>
      store.runInTransaction(() => {
        store.bumpIntimacy('douyin', 'tx-1', 10);
        throw new Error('force rollback');
      }),
    ).toThrow('force rollback');
    expect(store.getViewer('douyin', 'tx-1')?.intimacyScore).toBe(0);

    store.runInTransaction(() => {
      store.bumpIntimacy('douyin', 'tx-1', 5);
      expect(() =>
        store.runInTransaction(() => {
          store.bumpIntimacy('douyin', 'tx-1', 99);
          throw new Error('inner rollback');
        }),
      ).toThrow('inner rollback');
    });
    expect(store.getViewer('douyin', 'tx-1')?.intimacyScore).toBe(5);
  });

  it('真实旧版 v1 数据库自动备份迁移、数据零丢失并支持回滚还原', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-store-mig-'));
    const dbPath = join(dir, 'legacy-workbench.db');
    try {
      // 构造真实的 V1 旧版库（无 schema_version=2）
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE grudge_ledger (
          platform TEXT NOT NULL, uid TEXT NOT NULL, nickname TEXT NOT NULL DEFAULT '',
          intimacy_score INTEGER NOT NULL DEFAULT 0, grudge_tags TEXT NOT NULL DEFAULT '[]',
          notes TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY (platform, uid)
        );
        CREATE TABLE token_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slot TEXT NOT NULL,
          provider_id TEXT NOT NULL, model_id TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
          rice_grains INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE song_cache_index (
          cache_key TEXT PRIMARY KEY, song_title TEXT NOT NULL, file_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          last_hit_at INTEGER NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0
        );
      `);
      legacyDb.prepare('INSERT INTO grudge_ledger VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'douyin', 'legacy-u1', '旧版常客', 33, '["旧标签"]', '来自 V1', 1700000000000,
      );
      legacyDb.prepare('INSERT INTO token_ledger (ts, slot, provider_id, model_id, input_tokens, cached_input_tokens, output_tokens, rice_grains, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        1700000000000, 'MAIN_PERSONA_BRAIN', 'deepseek', 'deepseek-chat', 100, 0, 50, 150, 'chat',
      );
      legacyDb.close();
      const legacyBytes = readFileSync(dbPath);

      // 用 V2 SqliteStore 打开并迁移
      const migrated = new SqliteStore(dbPath);
      expect(migrated.migrationInfo.migratedFromLegacy).toBe(true);
      expect(migrated.migrationInfo.fromVersion).toBe(1);
      expect(migrated.migrationInfo.toVersion).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
      expect(migrated.migrationInfo.backupPath).toBeTruthy();
      expect(existsSync(migrated.migrationInfo.backupPath!)).toBe(true);
      expect(migrated.getMeta('schema_version')).toBe(String(CURRENT_SQLITE_SCHEMA_VERSION));
      expect(migrated.getViewer('douyin', 'legacy-u1')?.nickname).toBe('旧版常客');
      expect(migrated.getTokenSummary().riceGrains).toBe(150);
      expect(migrated.checkIntegrity().ok).toBe(true);
      const backupPath = migrated.migrationInfo.backupPath!;
      migrated.close();

      // 验证回滚恢复与原字节完全一致
      rollbackDatabaseFile(dbPath, backupPath);
      expect(readFileSync(dbPath)).toEqual(legacyBytes);
      expect(() => rollbackDatabaseFile(dbPath, join(dir, 'nonexistent.bak'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏数据库文件自动隔离备份并重建可用实例', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-store-corrupt-'));
    const dbPath = join(dir, 'corrupt.db');
    try {
      const mem = openSqliteStoreWithRecovery(':memory:');
      expect(mem.recovered).toBe(false);
      mem.store.close();

      writeFileSync(dbPath, 'NOT A VALID SQLITE FILE 00000000000000', 'utf8');
      writeFileSync(`${dbPath}-wal`, 'stale wal', 'utf8');
      const result = openSqliteStoreWithRecovery(dbPath);
      expect(result.recovered).toBe(true);
      expect(result.backupPath).toBeTruthy();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.store.checkIntegrity().ok).toBe(true);
      result.store.upsertViewer({ platform: 'douyin', uid: 'after-recovery', nickname: '新生' });
      expect(result.store.getViewer('douyin', 'after-recovery')?.nickname).toBe('新生');
      result.store.close();

      // 健康库再次打开不应触发恢复
      const second = openSqliteStoreWithRecovery(dbPath);
      expect(second.recovered).toBe(false);
      expect(second.store.getViewer('douyin', 'after-recovery')?.nickname).toBe('新生');
      second.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteViewerByUid 按 uid 级联清理跨平台常客账本且不影响他人', () => {
    const store = openSqliteStoreWithRecovery(':memory:').store;
    try {
      store.upsertViewer({ platform: 'douyin', uid: 'u-del', nickname: '被删常客' });
      store.upsertViewer({ platform: 'bilibili', uid: 'u-del', nickname: '同ID跨平台' });
      store.upsertViewer({ platform: 'douyin', uid: 'u-keep', nickname: '保留常客' });

      expect(store.deleteViewerByUid('')).toBe(0);
      expect(store.deleteViewerByUid('u-del')).toBe(2);
      expect(store.getViewer('douyin', 'u-del')).toBeNull();
      expect(store.getViewer('bilibili', 'u-del')).toBeNull();
      expect(store.getViewer('douyin', 'u-keep')?.nickname).toBe('保留常客');
    } finally {
      store.close();
    }
  });
});
